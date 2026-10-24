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

/**
 * 这个错误属于「传输层抖动」吗？（决定要不要重试）
 *
 * 与 {@link isEnvironmentUnavailable} 的区别是**故意更窄**：
 * 那里把 401/403/429 也算「暂时查不到」（该退 2），但那些是服务端的
 * 明确回答，立刻重试只会加深限流，所以不进重试。
 * 这里只认「连接没建起来 / 读到一半被掐断 / 超时」这一类。
 *
 * @param {unknown} error 捕获到的错误。
 * @returns {boolean} true 表示值得重试。
 */
function isTransportError(error) {
  const message = String(error?.message ?? error ?? '');
  const code = String(error?.cause?.code ?? error?.code ?? '');
  if (/^UND_ERR_/.test(code)) return true;
  if (['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED'].includes(code)) {
    return true;
  }
  return /(fetch failed|terminated|socket hang up|other side closed|ECONNRESET|EPIPE|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED)/i
    .test(message);
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
 * 重试只覆盖传输层，**不覆盖** HTTP 4xx/5xx：那是服务端的明确回答，
 * 重试会把「上游真的没有这个文件」拖慢成三次请求还报同样的话。
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
      if (!isTransportError(error) || attempt === attempts) throw error;
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
 * 传输层失败走 {@link retryTransport}；404 是有效结果，直接返回 undefined，
 * 不进重试。
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
    if (!response.ok) throw new Error(`拉取失败 ${response.status}: ${url}`);
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
     所以也走同一套传输层重试；HTTP 状态码失败仍然直接抛，不重试。 */
  const payload = await retryTransport(async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`清单拉取失败 ${response.status}: ${url}`);
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
    throw new Error(
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
 * @returns {string} 本包内绝对路径。
 */
function targetPath(rel) {
  return join(PACKAGE_ROOT, 'skills', 'agent-notes', ...rel.split('/'));
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
      throw new Error(`上游 ${UPSTREAM.pathPrefix}/assets 为空，看板模板可能已改名或移走。`);
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
 * 校验内置副本与清单记录的摘要是否一致（纯本地，不联网）。
 *
 * 用途：`--auto` 发现 ref 未变时，不能就此断定「没事」—— ref 只记录
 * 上次同步的目标 commit，本地文件仍可能被改过或被别的工具覆盖。
 *
 * @returns {{ mismatched: string[], missing: string[] } | undefined}
 *   有出入的文件；清单缺失或不可读时 undefined（调用方据此报错，不当成「无差异」）。
 */
function checkLocalAgainstManifest() {
  const manifest = readManifest();
  if (manifest === undefined) return undefined;
  const mismatched = [];
  const missing = [];
  for (const [rel, expected] of Object.entries(manifest.files ?? {})) {
    const local = targetPath(rel);
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
    throw new Error(
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

  // 本包内有、上游没有的文件（例如我们自己加的东西）。
  for (const entry of report) {
    if (entry.status === 'upstream-missing') console.log(`  ? ${entry.rel} — 上游已无此文件（保留本地）`);
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
 * @returns {{ version: number, ref: string, files: Record<string, string> } | undefined}
 *   清单；缺失或损坏时 undefined（调用方据此明确报错，不当成「无差异」）。
 */
function readManifest() {
  const manifestFile = join(PACKAGE_ROOT, 'tools', 'upstream-manifest.json');
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

/**
 * 这个错误是「环境不可用」还是「检查失败」？
 *
 * 必须分清：exit 1 = 检查失败，exit 2 = 无法进行（本仓库既有约定，
 * 见 verify-notes / install-hooks / doc-budget）。
 *
 * 混为一谈的后果实测到了：断网时 `--check` 返回 1，测试报
 * 「--check 在上游一致时应 exit 0，实际 1 / 合并失败: fetch failed」——
 * 断言在说契约被破坏，实际是网络不行。**那是误导性诊断**，
 * 会把人引向错误的方向去查。
 *
 * **只认 `fetch failed` 仍然漏了一整族**（2026-10-24 实测）：CDN 在读到一半时
 * 关掉连接，undici 抛的是 `TypeError: terminated`，`cause` 为
 * `SocketError: other side closed` / `code=UND_ERR_SOCKET`。名字、message、code
 * 三样都不在上面的词表里，于是又退回 exit 1「合并失败: terminated」——
 * 同一种误导性诊断换个马甲复发。所以这里不能只列举具体措辞，还要认
 * undici 的传输层错误码前缀 `UND_ERR_`：那一族**全部**是「请求没做完」，
 * 没有一个是「上游内容变了」。HTTP 状态码类失败（如 404）走的是
 * `拉取失败 404` 这种自造错误，不带 `UND_ERR_`，分类不会被带偏。
 *
 * @param {unknown} error 捕获到的错误。
 * @returns {boolean} true 表示环境不可用（该用 exit 2）。
 */
export function isEnvironmentUnavailable(error) {
  /* fetch 的失败一律是 TypeError，message 各平台不同，但都含这几个词。 */
  const message = String(error?.message ?? error ?? '');
  const code = String(error?.cause?.code ?? error?.code ?? '');

  /* 网络层：连不上、超时、DNS 失败、TLS 失败。 */
  if (/(fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EPROTO|self-signed|certificate)/i.test(message)) {
    return true;
  }
  if (['ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EPROTO'].includes(code)) {
    return true;
  }
  /* 连接在读到一半被对端掐断：undici 报 `terminated` / `socket hang up`，
   * Node 的 http 客户端报 `ECONNRESET` / `EPIPE`。都是「没做完」，不是「上游变了」。 */
  if (/(^|\W)(terminated|socket hang up|other side closed|ECONNRESET|EPIPE)(\W|$)/i.test(message)) {
    return true;
  }
  if (['ECONNRESET', 'EPIPE'].includes(code)) {
    return true;
  }
  /* undici 的传输层错误码族（UND_ERR_SOCKET / UND_ERR_CONNECT_TIMEOUT /
   * UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT / UND_ERR_CLOSED …）。
   * 前缀即语义：这一类全是「这次的请求没能完成」。 */
  if (/^UND_ERR_/.test(code)) {
    return true;
  }
  /* 认证与限流：是「暂时查不到」，不是「上游变了」。 */
  if (/\b(401|403|429)\b/.test(message)) {
    return true;
  }
  return false;
}

if (invokedDirectly) {
  main().catch((error) => {
    const message = error?.message ?? error;
    if (isEnvironmentUnavailable(error)) {
      /* 措辞与既有约定一致：`tools/self-update.test.mjs` 早就在断言 exit 2
         时消息匹配「查不到上游 HEAD|无法校验」，注释还写着「网络不可用时
         明确跳过，不算假绿」—— 它比我先处理了这个问题。所以是新代码向
         既有约定靠拢，不是要求既有约定改。 */
      console.error(`无法校验上游: ${message}`);
      console.error('这是**环境问题**（网络不可用或被限流），不是「上游有差异」。');
      console.error('退出码 2 = 无法进行（本次没有完成校验）；上游真有差异时退出码是 1。');
      process.exitCode = 2;
      return;
    }
    console.error(`合并失败: ${message}`);
    /* 这里**不能用 process.exit()**：线上实测过（Node 22.19 + Windows 11），
       在「HTTP 4xx，响应体还没读」之后立刻 process.exit 会撞 libuv 断言
       `!(handle->flags & UV_HANDLE_CLOSING)`（async.c:76），退出码变成 127。
       127 既不是「检查失败」也不是「无法进行」，还会把调用方吓成「工具崩了」。
       设 exitCode 让事件循环自然收干，退出码就是约定的 1。 */
    process.exitCode = 1;
  });
}
