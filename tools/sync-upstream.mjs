#!/usr/bin/env node
/**
 * 上游合并：把 czm15053/write-notes-like-deepseek 的最新内容拉进本包内置副本。
 *
 * 需求（Owner 选项 A）：插件内置内容能拉上游并**展示 diff、确认后覆盖**。
 *
 * 设计：
 *   - 上游内容 vendored 在 skills/agent-notes/，本脚本是唯一写入者。
 *   - `--check` 只报告漂移、零写入（可直接进 CI）。
 *   - 默认模式：先算逐文件 SHA-256 差异 → 打印 diff 摘要 → 需要 `--yes` 才落盘。
 *   - 逐文件摘要写入 tools/upstream-manifest.json，并把 commit 记进 upstream.json，
 *     这样「哪次同步的、同步了什么」可核对，不靠记忆。
 *
 * 安全：只从固定的 HTTPS 源拉取固定路径清单；不执行上游任何脚本，只当字节流。
 * 上游脚本仅在我们自己的门禁里被 node 执行（那是既定设计，不是本脚本引入的）。
 *
 * 用法：
 *   node tools/sync-upstream.mjs            # 报告差异，需要 --yes 才写
 *   node tools/sync-upstream.mjs --check    # 只报告，零写入（CI 用）
 *   node tools/sync-upstream.mjs --yes      # 真的覆盖内置副本
 *   node tools/sync-upstream.mjs --ref <commit-or-branch>
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/* ── 写盘闸门（默认关闭）─────────────────────────────────────────────────
   2026-10-19 那篇同步笔记里留过一条**我自己写下的**上限：

     「`--check` 的「零写入」目前靠**分支顺序**与**新加的条件判断**共同保证，
      没有机制化的验证。若将来有人在 `--check` 路径里插入写盘，现有测试抓不到。」

   这是真的：`--check` 的早退分支在上面、写盘在下面，两者的一致性靠人的注意力
   维持。而它失效的症状最坏 ——「检查模式悄悄改了文件」，不报错、退出码还可能
   是 0；上游副本被改掉之后，下一次 `verify-plugin` 的哈希比对才会莫名变红。

   所以补一道**默认关闭**的闸门：写盘函数自己查闸门，只有被 `withWrites()`
   包住时才允许落盘。任何在零写入路径上新插入的写盘会**抛错**，而不是静默写完
   再说。这道属性在 `npm test` 里可验（见 tools/sync-write-interlock.test.mjs）。
   ──────────────────────────────────────────────────────────────────────── */
let writesAllowed = false;

/**
 * 断言当前处于允许写盘的窗口内。
 *
 * @param {string} what 正要做的事，用于报错定位。
 * @returns {void}
 */
function assertWritesAllowed(what) {
  if (writesAllowed) return;
  throw new Error(
    `✖ ${what}：当前处于零写入模式，却走到了写盘 —— 写盘必须发生在 withWrites() 打开的窗口内。`
  );
}

/**
 * 在「允许写盘」的窄窗口内执行一次副作用。
 *
 * 窗口只在 `fn` 执行期间打开，`finally` 里立刻关回去，所以「忘了关」这种
 * 状态不存在；而任何**不在**窗口内的写盘都会被 `assertWritesAllowed` 拦下。
 *
 * @template T
 * @param {string} what 这次写盘的用途（例如「记录同步 ref」）。
 * @param {() => T} fn 真正写盘的动作。
 * @returns {T} `fn` 的返回值。
 */
export function withWrites(what, fn) {
  /* 保存并恢复**进入窗口前**的状态，而不是无条件写成 false。
     嵌套调用时（外层窗口里再开一个内层窗口），内层的 finally 若把闸门
     直接置 false，外层剩下的代码就再也写不了盘 —— 实测过：
     `withWrites('a', () => { withWrites('b', () => {}); writeManifest(...) })`
     会抛「当前处于零写入模式」，而调用方明明还在自己的写盘窗口里。
     窗口是**可重入**的：只有最外层退出时才真正关回去。 */
  const previous = writesAllowed;
  writesAllowed = true;
  try {
    return fn();
  } finally {
    writesAllowed = previous;
  }
}

/**
 * 用 `git ls-remote` 查上游分支的真实 HEAD。
 *
 * 为什么不用 GitHub API：未认证请求 60 次/小时就 403，定时任务天天跑必撞墙。
 * `git ls-remote` 走 git 协议，无此限制，且给的就是分支当前指向的 commit。
 *
 * 拿到 commit 而不是分支名很重要：jsDelivr 对**分支名**的清单缓存会滞后，
 * 锚 commit 才拿到该次提交的真实树。
 *
 * @param {string} branch 分支名。
 * @returns {string | undefined} commit SHA；失败 undefined。
 */
function resolveRemoteHead(branch) {
  try {
    const result = spawnSync('git', ['ls-remote', UPSTREAM.repository, branch], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
    /* 输出形如 `<sha>\trefs/heads/main`；只取第一行的第一列。 */
    const first = result.stdout.trim().split(/\r?\n/)[0] ?? '';
    const sha = first.split(/\s+/)[0] ?? '';
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** 上游仓库与默认 ref。
 *
 * ref 默认钉在 commit 而不是分支：jsDelivr 对分支名（如 `main`）的清单缓存
 * 实测会滞后于仓库现状——锚 `@main` 会拿到重构前的旧目录结构，导致路径
 * 匹配失败；锚 commit 才拿到该次提交的真实树。要合并更新内容时，先用
 * `--ref <branch>` 显式覆盖。 */
const UPSTREAM = {
  repository: 'https://github.com/czm15053/write-notes-like-deepseek.git',
  /** GitHub API 用 owner/repo；与上面 URL 同源，改一处必须同步另一处。 */
  slug: 'czm15053/write-notes-like-deepseek',
  pathPrefix: 'skills/write-notes-like-deepseek',
  /**
   * 兜底 ref：仅在 `upstream.json` 不存在或读不出 `ref` 时使用。
   *
   * **正常情况下这个值不参与判断** —— `resolveDefaultRef()` 会优先读
   * `upstream.json` 里记录的 ref。原因（实测踩过）：`--auto` 合并后只更新
   * `upstream.json` 与 manifest，**不会回来改这个常量**；于是 `--check`
   * 拿旧常量去比对新清单，必然报「变更 6」的假漂移，两条门禁测试直接变红。
   * 把 ref 收进数据文件（upstream.json 本身就是「上次同步到哪」的记录），
   * 合并即自动同步，不必再记得手改常量。
   */
  fallbackRef: '72573a5b179de7798bbb7c4aeacdc0df6bf62439'
};

/**
 * 解析默认 ref：优先 `upstream.json` 的记录，读不到才用常量兜底。
 *
 * @returns {string} 上游 commit 或分支名。
 */
function resolveDefaultRef() {
  try {
    const file = join(PACKAGE_ROOT, 'upstream.json');
    if (existsSync(file)) {
      const recorded = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof recorded?.ref === 'string' && recorded.ref.trim() !== '') {
        return recorded.ref.trim();
      }
    }
  } catch {
    /* 读不出来就走兜底，不在这里报错 —— 调用方本来就有「取不到要明确失败」的处理。 */
  }
  return UPSTREAM.fallbackRef;
}

/**
 * 判断内置副本是否落后于上游默认分支。
 *
 * **为什么需要这个**：`--check` 只比对 `defaultRef` 钉住的那个 commit，
 * 它永远返回「一致」—— 哪怕上游已经发了 100 个新提交。那是假绿：
 * 检查存在、恒绿、不验证任何东西。
 *
 * **为什么不用 GitHub API 查 HEAD**：实测未认证请求 60 次/小时就 403
 * （rate limit exceeded），CI 里天天跑必然撞墙。查不到时又不能当成
 * 「已是最新」，那等于换个姿势假绿。
 *
 * **为什么不用 jsDelivr 清单 API**：它对分支名的缓存实测滞后——锚 `@main`
 * 会拿到重构前的旧目录结构。但它的**文件读取**是准的（已验证 @main 与
 * 钉住 commit 的同一文件逐字相同），所以这里走「按已知清单逐个取文件内容
 * 比对」：清单来自本地 manifest，不依赖远端枚举。
 *
 * 任一侧取不到就明确返回 undefined —— 由调用方报错，绝不静默放行。
 *
 * @param {string} branch 分支名。
 * @returns {Promise<{changed: string[], missing: string[], checked: number} | undefined>}
 *   changed=内容与本地不同的文件；missing=上游已删除的文件。
 */
async function compareWithBranch(branch = 'main') {
  const manifest = readManifest();
  if (manifest === undefined) return undefined;
  const rels = Object.keys(manifest.files ?? {});
  if (rels.length === 0) return undefined;

  const changed = [];
  const missing = [];
  let checked = 0;
  for (const rel of rels) {
    const remote = await fetchUpstream(branch, rel);
    if (remote === undefined) {
      missing.push(rel);
      continue;
    }
    checked += 1;
    if (digest(remote) !== manifest.files[rel]) changed.push(rel);
  }
  return { changed, missing, checked };
}

/* ── 失败分类：一处判据回答两个问题 ─────────────────────────────────────

   两个问题必须由**同一张表**回答，否则它们必然漂移：

     1. 这次失败算「无法进行」（exit 2）还是「检查失败 / 真差异」（exit 1）？
     2. 这个失败值不值得重试？

   2026-10-24 之前这里是两份独立词表（`isEnvironmentUnavailable` 与
   `isTransportError`），5xx 同时从两张表里漏出去：既不判环境（报假红 exit 1，
   说「上游有差异」），也不重试（一次 CDN 抖动就让整条门禁红）。
   同一族错误只能有一处判据 —— 收敛成下面的 `classifyFailure()`。

   **认类别，不认措辞**：本脚本自己抛的 HTTP 错误带结构化字段
   `{ kind: 'http-status', status, endpoint }`，分类函数读字段；
   undici / Node 的传输层失败读 `code`（`UND_ERR_` 前缀与 errno 码）。
   消息文本只在最后兜底，服务的是「别的来源抛来的错误对象」——
   拿消息里的数字当判据，正是那次假红的成因（`/\b(401|403|429)\b/` 罩不住 5xx）。

   ## 口径表

   | 情形 | 分类 | 重试 | 退出码 |
   |---|---|---|---|
   | 文件端点 404（`fetchUpstream` 返回 `undefined`） | 有效结果 `upstream-missing`，不是错误 | — | 见下面的「比对下限」 |
   | 清单端点 404（ref 不存在 / 路径不在那棵树上） | `http-status`(manifest, 404) → 契约 | 否 | **1**（真差异） |
   | 408 与 5xx（500/502/503/504…） | `http-status` → 环境 | **是**（3 次，250/500ms） | 2 |
   | 401/403/429 | `http-status` → 环境 | 否（立刻重试只会加深限流） | 2 |
   | 其余 4xx（400/405/451…） | `http-status` → 环境 | 否 | 2 |
   | 传输层（`UND_ERR_*` / `ECONNRESET` / `terminated` / `socket hang up`…） | `transport` → 环境 | 是（3 次） | 2 |
   | 上游目录结构变了（找不到目录 / `assets` 为空 / 只枚举到 <10 个文件） | `upstream-layout` → 契约 | 否 | 1 |
   | 同步路径没能比对完全部枚举文件；本地与清单的比对条目为空或少于记录数 | `incomplete-check` → 无法进行 | 否 | 2，**且零写入** |
   | 认不出来的错误 | 契约（默认拒绝方向，与改动前一致） | 否 | 1 |

   `must`：**只有清单端点的 404 让 HTTP 失败留在 exit 1**。其余 HTTP 失败一律
   「这次没做成校验」（exit 2）—— 全都改成 exit 2 会把「ref 不存在」这种真差异
   一起掩盖掉，而那正是本仓库最不该放过的一类。
   ──────────────────────────────────────────────────────────────────────── */

/** HTTP 状态类失败的类别标签：分类函数读它，不读消息里的数字。 */
const KIND_HTTP_STATUS = 'http-status';

/** 值得重试的 HTTP 状态码：5xx 是经典瞬态，408 是服务端说「再来一次」。 */
function isRetryableStatus(status) {
  return status === 408 || (status >= 500 && status <= 599);
}

/**
 * 造一条带结构化字段的 HTTP 失败。
 *
 * 字段就是判据：`status` 与 `endpoint` 让分类函数不必去消息里数数字。
 * 消息里照样写状态码 —— 那是给人看的，不是给判据看的。
 *
 * @param {number} status HTTP 状态码。
 * @param {'file' | 'manifest'} endpoint 请求的是哪一类端点（决定 404 的语义）。
 * @param {string} message 给人看的消息。
 * @returns {Error} 带 `kind` / `status` / `endpoint` 的错误。
 */
export function httpStatusError(status, endpoint, message) {
  return Object.assign(new Error(message), {
    kind: KIND_HTTP_STATUS,
    status,
    endpoint
  });
}

/**
 * 造一条「本次没能完成校验」的错误（exit 2）。
 *
 * 与「环境不可用」分开成两个类别，是因为要说的话不同：环境问题是
 * 「网络不行」，这一类是「一个文件都没读到 / 只读到一部分」——
 * 两者都不是「上游有差异」，也都不是「一致」。
 *
 * @param {string} message 说明缺口在哪。
 * @returns {Error} 带 `kind: 'incomplete-check'` 的错误。
 */
function incompleteCheckError(message) {
  return Object.assign(new Error(message), { kind: 'incomplete-check' });
}

/**
 * 造一条「上游结构变了」的错误（契约问题，exit 1）。
 *
 * @param {string} message 说明哪里对不上。
 * @returns {Error} 带 `kind: 'upstream-layout'` 的错误。
 */
function upstreamLayoutError(message) {
  return Object.assign(new Error(message), { kind: 'upstream-layout' });
}

/** 传输层 errno 码族：连接没建起来 / 读到一半被掐断 / 超时。 */
const TRANSPORT_CODES = new Set([
  'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED', 'ENOTFOUND', 'EPROTO'
]);

/**
 * 传输层失败的**兜底**词表：只用于「别的来源抛来的错误对象」。
 *
 * 本脚本自己的错误走结构化字段，不经过这里。这几条是给 undici / Node / 测试
 * 手搓的错误留的 —— 它们没有可读的类别字段，只能看形状。
 */
const TRANSPORT_MESSAGE = /(fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EPROTO|self-signed|certificate|(^|\W)(terminated|socket hang up|other side closed|ECONNRESET|EPIPE)(\W|$))/i;

/**
 * 一次失败属于哪一类（`area`）、值不值得重试（`retryable`）。
 *
 * 「算不算环境问题」与「要不要重试」都从这一个返回值里读 —— 一份判据，
 * 两个用途（口径表见文件顶部那段注释）。
 *
 * @param {unknown} error 捕获到的错误。
 * @returns {{area: 'environment' | 'contract' | 'incomplete', retryable: boolean, status?: number}}
 *   `environment` = 环境不可用（exit 2）；`contract` = 真差异（exit 1）；
 *   `incomplete` = 本次没能完成校验（exit 2）。
 */
export function classifyFailure(error) {
  const kind = typeof error?.kind === 'string' ? error.kind : '';
  const status = typeof error?.status === 'number' ? error.status : undefined;
  const endpoint = typeof error?.endpoint === 'string' ? error.endpoint : '';

  /* 1) 本脚本自己抛的类别：看字段，不看消息。 */
  if (kind === 'incomplete-check') return { area: 'incomplete', retryable: false };
  if (kind === 'upstream-layout') return { area: 'contract', retryable: false };
  if (kind === KIND_HTTP_STATUS) {
    /* 唯一的例外：清单端点的 404 说明 ref 不存在（或路径不在那棵树上），
       那是**真差异**。把它判成环境问题会掩盖真问题。 */
    if (status === 404 && endpoint === 'manifest') return { area: 'contract', retryable: false, status };
    return { area: 'environment', retryable: isRetryableStatus(status), status };
  }

  /* 2) 传输层错误码族：判据是前缀与 errno 码，不是措辞穷举。 */
  const code = String(error?.cause?.code ?? error?.code ?? '');
  if (/^UND_ERR_/.test(code)) return { area: 'environment', retryable: true };
  if (TRANSPORT_CODES.has(code)) return { area: 'environment', retryable: true };

  /* 3) 兜底：没有类别字段的错误只能看形状。 */
  const message = String(error?.message ?? error ?? '');
  if (TRANSPORT_MESSAGE.test(message)) return { area: 'environment', retryable: true };
  /* 认证与限流：是「暂时查不到」，但立刻重试只会加深限流，所以不重试。 */
  if (/\b(401|403|429)\b/.test(message)) return { area: 'environment', retryable: false };

  /* 默认站在「真差异」一侧：认不出来不等于没问题（与改动前的默认一致）。 */
  return { area: 'contract', retryable: false };
}

/**
 * 这个错误属于「本次没能完成校验」吗？（该用 exit 2）
 *
 * **环境不可用**：网络不行、被限流。（`incomplete` 也退 2，但原因不是环境，
 * 是「一个文件都没读到 / 只读到一部分」，所以它算在 `true` 里 ——
 * 两者对调用方的含义一样：这次没有完成校验，别去查差异。）
 *
 * @param {unknown} error 捕获到的错误。
 * @returns {boolean} true 表示该用 exit 2。
 */
export function isEnvironmentUnavailable(error) {
  const { area } = classifyFailure(error);
  return area === 'environment' || area === 'incomplete';
}

/**
 * 这个错误该用哪个退出码。
 *
 * 唯一一处把分类映射成退出码的地方（口径表见文件顶部）：
 * exit 1 = 检查失败（上游真有差异 / 上游结构变了）；exit 2 = 无法进行。
 *
 * @param {unknown} error 捕获到的错误。
 * @returns {1 | 2} 退出码。
 */
export function exitCodeFor(error) {
  return classifyFailure(error).area === 'contract' ? 1 : 2;
}

/**
 * 对传输层失败做有限次重试。
 *
 * **为什么需要**（2026-10-24 实测）：`--check` 要顺序取 21 个上游文件，
 * jsDelivr 在这串高频请求里会偶发掐断连接（`UND_ERR_SOCKET` /
 * `fetch failed`）。实测 5 轮完整序列里有 2 轮失败，直接跑 CLI 也约 2/3 失败。
 * 单次请求重试一下就过（同一文件单测 10/10 成功）—— 也就是说，
 * 不重试时这条同步校验会**经常性地红**，而红的原因是抖动不是差异。
 * 假绿要修，假红同样要修：一个会随机红的门禁，人很快就会学会忽略它。
 *
 * 重试范围由 {@link classifyFailure} 的 `retryable` 决定：传输层与 **5xx / 408**
 * 都重试；**4xx 其余一律不重试**（那是服务端的明确回答，重试只会把
 * 「上游真的没有这个文件」拖慢成三次请求还报同样的话，也加深限流）。
 *
 * 5xx 为什么必须进重试（2026-10-24 实测）：CDN 返回 503 时旧实现一次都不重试，
 * 而 503 恰恰是最经典的可重试瞬态 —— 同一探针换成传输层断流时重试了 3 次、
 * 正确退 2，换成 503 却只请求 1 次并退 1（假红）。同一个「这次没做完」，
 * 两种形态必须得到同一处理。
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} operation 要执行的操作。
 * @param {{attempts?: number, backoffMs?: number, sleep?: (ms: number) => Promise<void>}} [options]
 *   attempts=总尝试次数（含首次）；backoffMs=退避基数；sleep=可注入的等待。
 * @returns {Promise<T>} 操作结果。
 * @throws {Error} 重试用尽后抛出最后一次的错误（保持原始形状，分类函数照旧能判）。
 */
export async function retryTransport(operation, options = {}) {
  const attempts = options.attempts ?? 3;
  const backoffMs = options.backoffMs ?? 250;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!classifyFailure(error).retryable || attempt === attempts) throw error;
      await sleep(backoffMs * attempt);
    }
  }
  throw lastError;
}

/**
 * 通过 jsDelivr CDN 读上游文件。
 *
 * 直连 raw.githubusercontent / github 在本机实测被重置（ECONNRESET），
 * jsDelivr 可稳定访问；它按 commit 或分支提供同一份仓库内容。
 *
 * 传输层失败与 5xx / 408 走 {@link retryTransport}；404 是有效结果，直接返回
 * undefined，不进重试。
 *
 * @param {string} ref 分支或 commit。
 * @param {string} repoPath 仓库内相对路径。
 * @returns {Promise<string | undefined>} 文件文本，404 时 undefined。
 */
async function fetchUpstream(ref, repoPath) {
  const url = `https://fastly.jsdelivr.net/gh/czm15053/write-notes-like-deepseek@${ref}/${UPSTREAM.pathPrefix}/${repoPath}`;
  return await retryTransport(async () => {
    const response = await fetch(url);
    if (response.status === 404) return undefined;
    if (!response.ok) throw httpStatusError(response.status, 'file', `拉取失败 ${response.status}: ${url}`);
    return await response.text();
  });
}

/**
 * 读取 jsDelivr 的目录清单，避免维护一份手工文件列表。
 *
 * @param {string} ref 分支或 commit。
 * @param {string} dir 仓库内目录（相对 pathPrefix，'' 表示根）。
 * @returns {Promise<string[]>} 该目录下的文件名；目录不存在时抛出（不静默返回空）。
 */
async function listUpstreamDir(ref, dir) {
  const url = `https://data.jsdelivr.com/v1/packages/gh/czm15053/write-notes-like-deepseek@${ref}`;
  /* 清单请求同样会偶发被掐断（实测失败就出现在「待核对」之前的那一步），
     所以也走同一套判据：传输层与 5xx/408 重试，其余 HTTP 失败直接抛。
     这里的 404 语义与文件端点**不同** —— 它说明 ref 不存在或路径不在那棵树上，
     是**真差异**，所以带 `endpoint: 'manifest'` 让分类函数判成 exit 1。 */
  const payload = await retryTransport(async () => {
    const response = await fetch(url);
    if (!response.ok) throw httpStatusError(response.status, 'manifest', `清单拉取失败 ${response.status}: ${url}`);
    return await response.json();
  });

  /** 在 jsDelivr 的树里按路径找节点；根节点自身 type 为 'gh'，只有子层才是 directory。 */
  const find = (node, segments) => {
    if (segments.length === 0) return node;
    const [head, ...rest] = segments;
    const next = (node.files ?? []).find((entry) => entry.name === head);
    return next === undefined ? undefined : find(next, rest);
  };

  const base = UPSTREAM.pathPrefix.split('/').filter(Boolean);
  const segments = dir === '' ? base : [...base, ...dir.split('/').filter(Boolean)];
  const target = find(payload, segments);
  if (target === undefined) {
    // 静默返回空会让「上游路径改了」伪装成「无需合并」，那是假绿；必须响。
    throw upstreamLayoutError(
      `上游清单中找不到目录 "${UPSTREAM.pathPrefix}${dir === '' ? '' : `/${dir}`}"（ref=${ref}）。`
      + '上游目录结构可能已变更，请人工核对后再同步。'
    );
  }
  return (target.files ?? []).filter((entry) => entry.type === 'file').map((entry) => entry.name);
}

/**
 * 计算文本的 SHA-256。
 *
 * @param {string} text 内容。
 * @returns {string} `sha256:<hex>`。
 */
function digest(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * 上游文件 → 本包内目标路径。
 *
 * SKILL.md 落在 skills/agent-notes/，其余子目录原样保留。
 *
 * @param {string} rel 仓库内相对 pathPrefix 的路径。
 * @param {string} [packageRoot] 本包根目录，默认本包根。
 *   **测试要传临时目录**：`checkLocalAgainstManifest()` 的注入根必须作用到读盘上，
 *   否则「拿临时清单去比真实副本」会得到无意义的结论。
 * @returns {string} 本包内绝对路径。
 */
function targetPath(rel, packageRoot = PACKAGE_ROOT) {
  return join(packageRoot, 'skills', 'agent-notes', ...rel.split('/'));
}

/**
 * 收集要同步的路径：根文件 + 已知子目录。
 *
 * @param {string} ref 分支或 commit。
 * @returns {Promise<string[]>} 仓库内相对路径列表。
 */
async function collectPaths(ref) {
  const paths = ['SKILL.md'];
  for (const dir of ['references', 'templates', 'scripts', 'assets']) {
    const names = await listUpstreamDir(ref, dir);
    for (const name of names) paths.push(`${dir}/${name}`);
    if (dir === 'assets' && names.length === 0) {
      // 上游 assets 含看板模板；变空说明结构变了，不能当「没有这个目录」放过。
      throw upstreamLayoutError(`上游 ${UPSTREAM.pathPrefix}/assets 为空，看板模板可能已改名或移走。`);
    }
  }
  return paths;
}

/**
 * 解析命令行参数。
 *
 * **导出是为了可测。** 此前它没有导出、文件导入即执行 `main()`，于是
 * 参数解析的全部边界（缺值、未知参数、组合语义）一条都测不了 ——
 * 而这是外部可传的输入。
 *
 * `--help` 走 `exit` 回调而不是直接 `process.exit`：直接退出在测试里
 * 会把整个测试进程带走，而它要表达的只是「打印用法并正常结束」。
 *
 * @param {string[]} argv 参数数组（不含 node 与脚本路径）。
 * @param {{onHelp?: () => void, defaultRef?: string}} [options] 选项。
 * @returns {{check: boolean, yes: boolean, latest: boolean, auto: boolean, branch: string, ref: string}} 解析结果。
 * @throws {Error} 参数缺值或未知时抛出。
 */
export function parseArgs(argv, options = {}) {
  const help = options.onHelp ?? (() => {
    printUsage();
    process.exit(0);
  });
  const args = {
    check: false,
    yes: false,
    latest: false,
    auto: false,
    branch: 'main',
    ref: options.defaultRef ?? resolveDefaultRef()
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') args.check = true;
    else if (arg === '--yes') args.yes = true;
    else if (arg === '--latest') args.latest = true;
    else if (arg === '--auto') args.auto = true;
    else if (arg === '--branch') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--branch 需要一个值');
      args.branch = value;
      index += 1;
    } else if (arg === '--ref') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--ref 需要一个值');
      args.ref = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      help();
      /* help() 正常情况下不返回（默认实现是 process.exit）。但测试注入的
         实现会返回，所以这里继续往下走 —— 解析成默认参数即可。 */
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return args;
}

/**
 * 打印用法。
 *
 * @returns {void}
 */
function printUsage() {
  console.log('用法: node tools/sync-upstream.mjs [--check] [--yes] [--latest] [--auto] [--branch <name>] [--ref <branch|commit>]');
  console.log('  --check        只报告内置副本与该 ref 的差异，零写入');
  console.log('  --latest       与上游默认分支逐文件比对，判断是否落后（防假绿）');
  console.log('  --auto         查上游 HEAD 并合并到它（CI 用；隐含 --yes）');
  console.log('  --branch <n>   配合 --latest/--auto 指定上游分支，默认 main');
  console.log('  --ref <b|c>    指定要比对的 commit 或分支，默认取 upstream.json 的记录');
  console.log('  --yes          真的覆盖内置副本并记录清单');
  console.log('  --help, -h     显示这段用法');
}

/**
 * 读 `upstream.json` 里记录的 `fileCount`（上次同步写下的条目数）。
 *
 * 用途：给「本地与清单比对」一个**下**限参照。记录数与清单条目数对不上时，
 * 说明清单被截断过，那就不能拿它当「一致」的依据。
 *
 * @param {string} [packageRoot] 本包根目录。
 * @returns {number | undefined} 记录的条目数；没有记录或不是正整数时 undefined。
 */
function readRecordedFileCount(packageRoot = PACKAGE_ROOT) {
  try {
    const file = join(packageRoot, 'upstream.json');
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const count = parsed?.fileCount;
    return typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 校验内置副本与清单记录的摘要是否一致（纯本地，不联网）。
 *
 * 用途：`--auto` 发现 ref 未变时，不能就此断定「没事」—— ref 只记录
 * 上次同步的目标 commit，本地文件仍可能被改过或被别的工具覆盖。
 *
 * ## 下限：空集合不得当绿（本仓库的既有纪律）
 *
 * `for (const [rel, expected] of Object.entries(manifest.files ?? {}))` 没有下限时，
 * **空清单 → 0 次比对 → `{mismatched: [], missing: []}`**，调用方读到的就是
 * 「一致」。实测过：那份空清单正是「全 404 时把清单写空」那个缺陷的产物，
 * 喂回 `--auto` 就得到一句「✔ 已是最新，且内置副本与清单一致，无需合并」。
 * 所以这里补齐两条：**清单为空**、以及**条目数少于 `upstream.json` 记录的数**
 * 一律返回 undefined（= 这次没能校验），由调用方报 exit 2，绝不当成一致。
 *
 * @param {{packageRoot?: string}} [options] 本包根目录，可注入**仅为可测**
 *   （临时仓库）：它同时作用于清单读取与副本读盘（`targetPath(rel, packageRoot)`）。
 *   注入的是**根**，不是清单内容 —— 清单一律从盘上读，测试才不会验到
 *   「一个只有测试会构造的对象」。
 * @returns {{ mismatched: string[], missing: string[] } | undefined}
 *   有出入的文件；清单缺失、不可读、或没达到下限时 undefined
 *   （调用方据此报错，不当成「无差异」）。
 */
export function checkLocalAgainstManifest(options = {}) {
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const manifest = readManifest(packageRoot);
  if (manifest === undefined) return undefined;

  const entries = Object.entries(manifest.files ?? {});
  const recorded = readRecordedFileCount(packageRoot);
  if (entries.length === 0) return undefined;
  if (recorded !== undefined && entries.length < recorded) return undefined;

  const mismatched = [];
  const missing = [];
  for (const [rel, expected] of entries) {
    const local = targetPath(rel, packageRoot);
    if (!existsSync(local)) {
      missing.push(rel);
      continue;
    }
    const actual = `sha256:${createHash('sha256').update(readFileSync(local, 'utf8'), 'utf8').digest('hex')}`;
    if (actual !== expected) mismatched.push(rel);
  }
  return { mismatched, missing };
}

/**
 * 主流程。
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  let ref = args.ref;

  /* `--auto`：查上游真实 HEAD 并设为目标 ref，隐含 --yes。
     这是给 CI 用的 —— 定时任务不知道上游新 commit 是什么，必须自己查。
     用 git ls-remote 而不是 GitHub API：后者未认证 60 次/小时就 403。
     先查一次 HEAD：若与已同步的 ref 相同，就能直接说「无事可做」，
     省掉逐个拉 21 个文件的开销。 */
  if (args.auto) {
    const head = resolveRemoteHead(args.branch);
    if (head === undefined) {
      console.error('✖ 查不到上游 HEAD（git ls-remote 失败）。');
      console.error('  这不是「已是最新」—— 本次无法判断，退出码 2。');
      process.exit(2);
    }
    const manifest = readManifest();
    const synced = manifest?.ref;
    console.log(`上游 HEAD: ${head}`);
    console.log(`已同步:   ${typeof synced === 'string' ? synced : '（无记录）'}`);
    if (synced === head) {
      /* ref 相同只说明「上次同步的目标」没变，**不代表本地文件没被改过**。
         实测踩到：手动改坏 manifest 里某个文件的摘要后，--auto 直接报
         「已是最新」放过 —— 那是假绿。所以再校验一遍本地文件与清单是否一致，
         有出入就仍然走合并流程把它纠正回来。 */
      const drift = await checkLocalAgainstManifest();
      if (drift === undefined) {
        console.error('✖ 无法校验内置副本与清单是否一致。');
        process.exit(2);
      }
      if (drift.mismatched.length === 0 && drift.missing.length === 0) {
        console.log('\n✔ 已是最新，且内置副本与清单一致，无需合并。');
        process.exit(0);
      }
      const total = drift.mismatched.length + drift.missing.length;
      console.error(`\n⚠ ref 未变但本地有 ${total} 个文件与清单不符，重新合并以纠正：`);
      for (const rel of drift.mismatched) console.error(`  内容不同  ${rel}`);
      for (const rel of drift.missing) console.error(`  文件缺失  ${rel}`);
    }
    ref = head;
    /* `--auto` 隐含 `--yes`，但**不得覆盖 `--check` 显式给出的「零写入」意图**。
       实测踩过：`node tools/sync-upstream.mjs --auto --check` 会把
       `args.yes` 置真，随后走到合并路径真的写文件 —— 而 `--check` 的
       契约是「零写入」。更糟的是它**不报错、退出码还可能是 0**，
       于是「我明明要检查」变成了「我覆盖了 vendored 副本」。

       `--check` 优先是保守方向：两者同传时退回「只检查」，
       想要写入就显式写 `--auto`（不带 --check）。 */
    if (!args.check) args.yes = true;
  }

  /* `--latest`：判断内置副本是否落后于上游默认分支。
     与 `--check` 是两件事 —— `--check` 只回答「副本与该 ref 是否逐字相同」，
     它永远回答「相同」，因为 ref 就是上次同步时钉下的那个 commit。
     真正该问的是「上游有没有新提交」，那只能查远端 HEAD。 */
  if (args.latest) {
    const branch = args.branch;
    const result = await compareWithBranch(branch);
    if (result === undefined) {
      console.error('✖ 无法核对上游（清单缺失、网络不可达或被限流）。');
      console.error('  这不是「已是最新」—— 本次检查无效，请稍后重试。');
      process.exit(2);
    }
    /* 比对下限：**一个文件都没比对成时不许下任何结论**。
       基准是本地清单，21 个文件全 404 时旧实现会打印
       「0 个文件内容变了，21 个文件上游已删除」并 exit 1 —— 那是在报告
       一个**没有依据**的结论（「上游真删光了」与「CDN 全线 404」在输出上完全一样）。
       这里改成如实说「没比成」（exit 2）。 */
    if (result.checked === 0) {
      console.error(`✖ 本次一个文件都没比对成功：基准里的 ${result.missing.length} 个文件全部取不到内容。`);
      console.error('  这不是「已是最新」，也不是「上游已删除」—— 本次检查无效，请稍后重试。');
      process.exit(2);
    }
    console.log(`上游默认分支: ${branch}`);
    console.log(`已核对 ${result.checked} 个文件（基准: tools/upstream-manifest.json）`);
    const changedCount = result.changed.length;
    const missingCount = result.missing.length;
    if (changedCount === 0 && missingCount === 0) {
      console.log('\n✔ 内置副本与上游一致，无漂移。');
      process.exit(0);
    }
    console.error(`\n✖ 内置副本已落后于上游：${changedCount} 个文件内容变了，${missingCount} 个文件上游已删除。`);
    for (const rel of result.changed) console.error(`  变更  ${rel}`);
    for (const rel of result.missing) console.error(`  删除  ${rel}`);
    console.error(`\n合并方式: node tools/sync-upstream.mjs --ref ${branch} --yes`);
    console.error('合并后必须重跑: npm run check');
    process.exit(1);
  }

  console.log(`上游: ${UPSTREAM.repository} @ ${ref}`);

  const paths = await collectPaths(ref);
  // 兜底：枚举结果异常少说明清单解析坏了，不能当「无需合并」放过。
  if (paths.length < 10) {
    throw upstreamLayoutError(
      `只枚举到 ${paths.length} 个上游文件（预期 >= 10），清单解析很可能已失效。`
      + `已枚举: ${paths.join(', ')}`
    );
  }
  console.log(`待核对: ${paths.length} 个文件\n`);

  const manifest = { version: 1, ref, files: {} };
  const report = [];

  for (const rel of paths) {
    const remote = await fetchUpstream(ref, rel);
    if (remote === undefined) {
      report.push({ rel, status: 'upstream-missing' });
      continue;
    }
    const local = targetPath(rel);
    const current = existsSync(local) ? readFileSync(local, 'utf8') : undefined;
    const remoteDigest = digest(remote);
    manifest.files[rel] = remoteDigest;

    if (current === undefined) report.push({ rel, status: 'new', remoteDigest });
    else if (digest(current) === remoteDigest) report.push({ rel, status: 'same', remoteDigest });
    else {
      const currentLines = current.split('\n').length;
      const remoteLines = remote.split('\n').length;
      report.push({
        rel,
        status: 'changed',
        remoteDigest,
        localDigest: digest(current),
        localLines: currentLines,
        remoteLines: remoteLines,
        delta: remoteLines - currentLines
      });
    }
  }

  /* ── 比对下限：空集合不得当绿 ────────────────────────────────────────────

     21 个文件**全部 404** 与 21 个文件**全部相同**必须走不同的分支。
     旧实现在这里分不开：`upstream-missing` 不计入任何计数，于是
     「一个文件都没比对成」也打印「内置副本与上游一致，无需合并」并 exit 0，
     不带 `--check` 时还**在不需要 `--yes` 的路径上**把 21 条摘要写成 0 条
     （实测：隔离副本里 files 从 21 条变 0 条，`upstream.json.fileCount=0`）。

     为什么连「只少读到一个」也判红：`manifest` 是「这次真读到了什么」的记录，
     少读一个就抹掉一条基线，而结论照样会印成「一致」。宁可不写，
     也不要写一份缩水的清单 —— **零写入比写坏好**。
     ──────────────────────────────────────────────────────────────────────── */
  const missingContent = report
    .filter((entry) => entry.status === 'upstream-missing')
    .map((entry) => entry.rel);
  if (missingContent.length > 0) {
    const comparedCount = paths.length - missingContent.length;
    const head = comparedCount === 0
      ? `本次**一个**上游文件都没比对成（${paths.length} 个全部没读到内容）`
      : `本次只比对成功 ${comparedCount}/${paths.length} 个上游文件`;
    throw incompleteCheckError(
      `${head}：${missingContent.join('、')}\n`
      + '文件端点的 404 在「上游真删了这个文件」时是有效结果；但这些路径是**刚从上游目录清单里'
      + '枚举出来的**，同一份清单里既列出又取不到，说明这次校验没做完（CDN 不一致、负缓存，'
      + '或者 `--ref` 指的是会移动的分支而不是钉住的 commit）。'
      + '所以这里既不说「一致」也不说「有差异」：**一条基线都不改写**，请稍后重试。'
    );
  }

  const changed = report.filter((entry) => entry.status === 'changed');
  const added = report.filter((entry) => entry.status === 'new');
  const same = report.filter((entry) => entry.status === 'same');

  console.log(`相同 ${same.length}｜变更 ${changed.length}｜新增 ${added.length}\n`);
  for (const entry of changed) {
    console.log(`  ~ ${entry.rel}  (行数 ${entry.localLines} → ${entry.remoteLines}，${entry.delta >= 0 ? '+' : ''}${entry.delta})`);
  }
  for (const entry of added) console.log(`  + ${entry.rel}  (新增)`);

  if (changed.length === 0 && added.length === 0) {
    console.log('\n内置副本与上游一致，无需合并。');
    /* 闸门必须在**明确不是 --check** 时才打开：这一行就是「零写入」的唯一开关。 */
    if (!args.check) withWrites('记录同步 ref', () => writeManifest(manifest, ref));
    return;
  }

  if (args.check) {
    console.log('\n--check 模式：未写入任何文件。');
    process.exit(1); // 有漂移即非零，便于 CI 发现
  }

  if (!args.yes) {
    console.log('\n以上为差异预览。确认合并请加 --yes；仅检查加 --check。');
    console.log('提示：合并后务必重跑 node --test tools/plugin.test.mjs 与 node tools/fault-injection.mjs。');
    return;
  }

  for (const entry of [...changed, ...added]) {
    const remote = await fetchUpstream(ref, entry.rel);
    const local = targetPath(entry.rel);
    withWrites(`写入上游副本 ${entry.rel}`, () => {
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, remote, 'utf8');
    });
    console.log(`  ✔ 已更新 ${entry.rel}`);
  }
  withWrites('记录同步 ref', () => writeManifest(manifest, ref));
  console.log('\n合并完成。请重跑测试与故障注入确认门禁仍可信。');
}

/**
 * 读已记录的逐文件摘要清单。
 *
 * 清单是「上次同步时每个上游文件的摘要」，也是 `--latest` 的比对基准 ——
 * 有了它就不必远端枚举目录（jsDelivr 对分支的清单缓存会滞后）。
 *
 * @param {string} [packageRoot] 本包根目录，默认本包根（可注入，见
 *   `checkLocalAgainstManifest()` 的说明）。
 * @returns {{ version: number, ref: string, files: Record<string, string> } | undefined}
 *   清单；缺失或损坏时 undefined（调用方据此明确报错，不当成「无差异」）。
 */
function readManifest(packageRoot = PACKAGE_ROOT) {
  const manifestFile = join(packageRoot, 'tools', 'upstream-manifest.json');
  if (!existsSync(manifestFile)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifestFile, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return undefined;
    if (parsed.files === null || typeof parsed.files !== 'object') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * 写 manifest 与 upstream.json 的同步记录。
 *
 * @param {any} manifest 逐文件摘要。
 * @param {string} ref 已同步的分支或 commit。
 * @param {string} [packageRoot] 输出根目录，默认本包根目录。
 *   **测试必须传临时目录**：默认值落在仓库里，一旦闸门自身被改坏，
 *   测试就会把真实的两份数据文件写坏（本轮变异时真的发生过）。
 */
export function writeManifest(manifest, ref, packageRoot = PACKAGE_ROOT) {
  /* 闸门放在**第一行**：本函数一进来就写盘，任何调用方忘了包 withWrites()
     都会在这里抛错，而不是先写坏 manifest 再说。 */
  assertWritesAllowed('写 tools/upstream-manifest.json 与 upstream.json');
  const manifestFile = join(packageRoot, 'tools', 'upstream-manifest.json');
  mkdirSync(dirname(manifestFile), { recursive: true });
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const upstreamFile = join(packageRoot, 'upstream.json');
  const previous = existsSync(upstreamFile) ? JSON.parse(readFileSync(upstreamFile, 'utf8')) : {};

  /* **保留本函数不负责的字段。**
     曾经的写法是白名单重建 next，只留 repository/path/ref/syncedAt/
     fileCount/commit —— 于是别人往这个文件里加的字段会被静默抹掉。
     实测踩过：`license` 与 `note`（第三方归属声明 `tools/notices.mjs` 的
     数据源）就是这样没的，表现为「跑一次 sync:check 之后 notices:check
     就红了：upstream.json 缺少 license 字段」。

     白名单式的「重建」看起来更干净，但代价是**这个文件从此只有本函数能
     写**。改成「先展开原有字段，再让本函数管的字段覆盖它」，
     新增字段就不必回头改这里。 */
  const managed = {
    repository: UPSTREAM.repository,
    path: UPSTREAM.pathPrefix,
    ref,
    syncedAt: new Date().toISOString(),
    fileCount: Object.keys(manifest.files).length
  };
  const next = { ...previous, ...managed };

  writeFileSync(upstreamFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`  已记录 tools/upstream-manifest.json 与 upstream.json`);
}

/**
 * 仅在被**直接执行**时才跑主流程。
 *
 * 为什么要有这个守卫：为了让 `parseArgs` 可测而把它导出后，测试就要
 * `import` 本文件 —— 而本文件末尾原本无条件调用 `main()`，那会让每次
 * import 都真的去访问网络、写文件。测试要能 import，就不能一进来就干活。
 *
 * 判定方式与 `tools/bilingual-docs.mjs` 一致：比较 `process.argv[1]` 与
 * 本文件路径（都归一化成正斜杠，Windows 下 `\` 要换掉）。
 */
const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replace(/\\/g, '/').endsWith('/tools/sync-upstream.mjs');

/* 失败分类（`classifyFailure` / `exitCodeFor`）与口径表在文件上半部分 ——
   它们必须与「要不要重试」共用同一张表，所以放在一起，不再各留一份词表。 */

if (invokedDirectly) {
  main().catch((error) => {
    const message = error?.message ?? error;
    const { area } = classifyFailure(error);
    if (area === 'contract') {
      console.error(`合并失败: ${message}`);
      /* 这里**不能用 process.exit()**：线上实测过（Node 22.19 + Windows 11），
         在「HTTP 4xx，响应体还没读」之后立刻 process.exit 会撞 libuv 断言
         `!(handle->flags & UV_HANDLE_CLOSING)`（async.c:76），退出码变成 127。
         127 既不是「检查失败」也不是「无法进行」，还会把调用方吓成「工具崩了」。
         设 exitCode 让事件循环自然收干，退出码就是约定的 1。 */
      process.exitCode = 1;
      return;
    }
    /* 措辞与既有约定一致：`tools/self-update.test.mjs` 早就在断言 exit 2 时
       消息匹配「查不到上游 HEAD|无法校验」，注释还写着「网络不可用时明确跳过，
       不算假绿」—— 它比我先处理了这个问题。所以是新代码向既有约定靠拢，
       不是要求既有约定改。 */
    console.error(`无法校验上游: ${message}`);
    if (area === 'incomplete') {
      console.error('这是**本次没能完成校验**（没读到内容 / 只读到一部分），不是「上游有差异」。');
    } else {
      console.error('这是**环境问题**（网络不可用或被限流），不是「上游有差异」。');
    }
    console.error('退出码 2 = 无法进行（本次没有完成校验）；上游真有差异时退出码是 1。');
    process.exitCode = exitCodeFor(error);
  });
}
