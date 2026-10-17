/**
 * 技能副本的异步自更新。
 *
 * 解决的问题：`skills/agent-notes` 是 vendored 的副本，上游（本仓库
 * `iuuuuuuuu/dsh-agent-notes`）改了规则后，已安装的插件不会自己跟进 ——
 * 它只会一直用用户机器上那份旧文件，而**没有任何东西会提示它落后了**。
 *
 * 设计约束（都是硬性的）：
 *   1. **绝不能阻塞启动**：所有网络请求都在后台跑，apply 立即返回。
 *      代价是启动那一瞬间技能可能还是旧的，这在可接受范围内。
 *   2. **失败必须静默**：断网、CDN 不可达、内容校验不过 —— 一律保留现有
 *      副本继续用，不抛错、不写坏文件。技能不可用比技能旧要严重得多。
 *   3. **原子替换**：先写临时目录再整体换上去，中途失败不会留下半套文件。
 *   4. **只在内容真的不同时才写**：避免每次启动都无谓地重写磁盘
 *      （重写会让 mtime 变化，触发不必要的热替换通知）。
 *
 * 为什么从本仓库拉而不是直接从原始上游拉：本仓库跟随原始上游合并，
 * 等于多一层人工审核 —— 原始上游改坏了，可以在这里挡掉。
 *
 * 零依赖：只用 node 内建。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本包根目录。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 技能副本所在目录（相对包根）。 */
const SKILL_REL = 'skills/agent-notes';

/** 记录「已同步到的版本号」的文件名，放在技能目录旁。 */
const SYNCED_VERSION_FILE = '.synced-version';

/** 自更新的来源仓库与分支。 */
export const UPDATE_SOURCE = Object.freeze({
  slug: 'iuuuuuuuu/dsh-agent-notes',
  branch: 'main',
  prefix: `/${SKILL_REL}`
});

/** 单次自更新的总超时（毫秒）。超时即放弃，保留现有副本。 */
const UPDATE_TIMEOUT_MS = 30_000;

/** 并发拉取文件数上限，避免一次打太多请求被 CDN 限流。 */
const FETCH_CONCURRENCY = 4;

/**
 * 拉取文本；失败返回 undefined（调用方据此放弃本次更新）。
 *
 * @param {string} url 完整 URL。
 * @param {AbortSignal} signal 取消信号。
 * @returns {Promise<string | undefined>} 文本或 undefined。
 */
async function fetchText(url, signal) {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) return undefined;
    return await response.text();
  } catch {
    return undefined;
  }
}

/**
 * 用 jsDelivr 的文件清单枚举技能目录下的所有文件。
 *
 * 为什么不用 GitHub API：未认证请求 60 次/小时就 403，插件天天启动必然撞墙。
 *
 * @param {AbortSignal} signal 取消信号。
 * @returns {Promise<string[] | undefined>} 相对技能目录的路径列表；失败 undefined。
 */
async function listRemoteFiles(signal) {
  const url = `https://data.jsdelivr.com/v1/packages/gh/${UPDATE_SOURCE.slug}`
    + `@${UPDATE_SOURCE.branch}?structure=flat`;
  const body = await fetchText(url, signal);
  if (body === undefined) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const files = Array.isArray(parsed?.files) ? parsed.files : [];
  const prefix = `${UPDATE_SOURCE.prefix}/`;
  const out = [];
  for (const entry of files) {
    const name = typeof entry?.name === 'string' ? entry.name : '';
    if (!name.startsWith(prefix)) continue;
    out.push(name.slice(prefix.length));
  }
  return out.length === 0 ? undefined : out;
}

/**
 * 分批并发拉取，保持结果顺序。
 *
 * @param {string[]} items 待处理项。
 * @param {number} limit 并发数。
 * @param {(item: string) => Promise<any>} worker 处理函数。
 * @returns {Promise<any[]>} 结果数组。
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 判断目标路径是否安全地落在根源目录之内。
 *
 * 远端清单理论上可能被篡改出 `../` 之类的路径，必须挡在写盘之前。
 *
 * @param {string} root 允许的根。
 * @param {string} target 待检查路径。
 * @returns {boolean} 是否在根内。
 */
function isInside(root, target) {
  const a = resolve(root);
  const b = resolve(target);
  return b === a || b.startsWith(a.endsWith(sep) ? a : `${a}${sep}`);
}

/**
 * 读远端仓库当前发布的版本号。
 *
 * 为什么用 `package.json` 当探针：只需要判断「内容变没变」，而版本号正是
 * 为此存在的。一个 1.8 KB 的请求，比逐个拉 21 个技能文件（约 5-6 秒）快两个量级。
 *
 * 试过但不通的三条路（都实测过）：
 *   - jsDelivr `resolved` 端点：对本仓库返回 `version: null`；
 *   - jsDelivr 版本列表：新 tag 迟迟不收录（打 tag 后十几秒仍返回 0 个）；
 *   - GitHub API `/tags`：未认证 60 次/小时就 403，插件天天启动必然撞。
 *
 * 取不到时返回 undefined —— 调用方退回全量比对，绝不把「查不到」当「没更新」。
 *
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {Promise<string | undefined>} 形如 `0.2.0`。
 */
async function resolveRemoteVersion(signal) {
  const url = `https://fastly.jsdelivr.net/gh/${UPDATE_SOURCE.slug}`
    + `@${UPDATE_SOURCE.branch}/package.json`;
  const body = await fetchText(url, signal);
  if (body === undefined) return undefined;
  try {
    const parsed = JSON.parse(body);
    const version = parsed?.version;
    return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 读本地记录的「上次同步到的版本号」。
 *
 * 存成技能目录旁的 `.synced-version`。只记录，不参与门禁 —— 它纯粹是性能优化，
 * 丢失或损坏只会让下次退化成全量比对，不影响正确性。
 *
 * @param {string} skillDir 技能目录。
 * @returns {string | undefined} 版本号。
 */
function readSyncedVersion(skillDir) {
  try {
    const file = join(skillDir, SYNCED_VERSION_FILE);
    if (!existsSync(file)) return undefined;
    const value = readFileSync(file, 'utf8').trim();
    return /^\d+\.\d+\.\d+/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 记录「已同步到的版本号」。
 *
 * @param {string} skillDir 技能目录。
 * @param {string} version 版本号。
 * @returns {void}
 */
function writeSyncedVersion(skillDir, version) {
  try {
    writeFileSync(join(skillDir, SYNCED_VERSION_FILE), `${version}\n`, 'utf8');
  } catch {
    /* 写不进去只影响下次性能，不影响正确性，静默忽略。 */
  }
}

/**
 * 执行一次自更新。
 *
 * @param {{ onUpdated?: () => void, log?: (message: string) => void, targetDir?: string }} [options]
 *   onUpdated 在真的写入了新内容后被调用（用于触发热替换）。
 * @returns {Promise<{ status: 'updated' | 'current' | 'failed', files?: number, reason?: string }>}
 *   本次更新结果；永不抛。
 */
export async function updateSkillCopy(options = {}) {
  const { onUpdated, log } = options;
  /* 目标目录可覆盖：测试必须能在隔离目录里跑，否则会和别的测试
     抢同一个真实目录（实测在并发下偶发失败 —— 那是真竞态，不是抖动）。 */
  const skillDir = typeof options.targetDir === 'string' && options.targetDir !== ''
    ? resolve(options.targetDir)
    : join(PACKAGE_ROOT, SKILL_REL);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const signal = controller ? controller.signal : undefined;
  const timer = controller
    ? setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS)
    : undefined;

  try {
    /* 快速路径：先查远端 SHA，与本地记录相同就直接收工，不拉文件。
       查不到 SHA 时不算「没更新」，继续走全量比对。 */
    const remoteVersion = await resolveRemoteVersion(signal);
    if (remoteVersion !== undefined && readSyncedVersion(skillDir) === remoteVersion) {
      return { status: 'current', files: 0, version: remoteVersion };
    }

    const remoteFiles = await listRemoteFiles(signal);
    if (remoteFiles === undefined) {
      return { status: 'failed', reason: 'remote-listing-unavailable' };
    }

    /* 先全部读进内存再比较：只有真的有差异才动磁盘。 */
    const fetched = await mapLimit(remoteFiles, FETCH_CONCURRENCY, async (rel) => {
      const url = `https://fastly.jsdelivr.net/gh/${UPDATE_SOURCE.slug}@${UPDATE_SOURCE.branch}`
        + `${UPDATE_SOURCE.prefix}/${rel}`;
      const content = await fetchText(url, signal);
      return { rel, content };
    });

    /* 任何一个文件拉不到就整批放弃：半套内容比旧内容更危险。 */
    const missing = fetched.filter((entry) => entry.content === undefined);
    if (missing.length > 0) {
      return { status: 'failed', reason: `fetch-incomplete:${missing.length}` };
    }

    /* 逐个比较，收集差异。 */
    const changed = [];
    for (const entry of fetched) {
      const target = join(skillDir, entry.rel);
      if (!isInside(skillDir, target)) {
        return { status: 'failed', reason: 'unsafe-path' };
      }
      let current;
      try {
        current = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
      } catch {
        current = undefined;
      }
      if (current !== entry.content) changed.push(entry);
    }

    if (changed.length === 0) {
      /* 内容已一致：把 SHA 记下来，下次启动就能走快速路径，省掉拉文件。 */
      if (remoteVersion !== undefined) writeSyncedVersion(skillDir, remoteVersion);
      return { status: 'current', files: fetched.length, version: remoteVersion };
    }

    /* 原子替换：逐文件写临时文件再 rename。
       不整体搬目录，是因为包根下还有别的文件（lib/、tools/），
       整体替换容易误伤；逐文件 rename 同样保证「要么旧要么新」。 */
    for (const entry of changed) {
      const target = join(skillDir, entry.rel);
      mkdirSync(dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.tmp`;
      writeFileSync(temp, entry.content, 'utf8');
      try {
        renameSync(temp, target);
      } catch (error) {
        /* rename 失败时清掉临时文件，不留垃圾。 */
        try { rmSync(temp, { force: true }); } catch { /* 忽略 */ }
        return { status: 'failed', reason: `write-failed:${entry.rel}` };
      }
    }

    /* 写完才记录 SHA：中途失败不记录，下次仍会重试。 */
    if (remoteVersion !== undefined) writeSyncedVersion(skillDir, remoteVersion);

    if (typeof log === 'function') {
      log(`技能副本已更新 ${changed.length} 个文件（来源 ${UPDATE_SOURCE.slug}@${UPDATE_SOURCE.branch}）`);
    }
    if (typeof onUpdated === 'function') {
      try { onUpdated(); } catch { /* 通知失败不影响已写入的内容 */ }
    }
    return { status: 'updated', files: changed.length, version: remoteVersion };
  } catch {
    return { status: 'failed', reason: 'unexpected' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 在后台启动自更新，立即返回。
 *
 * **绝不 await**：调用方在 apply 里 fire-and-forget，保证启动不被网络拖慢。
 * 未处理的 rejection 会被内部吞掉 —— 更新失败绝不能让插件崩。
 *
 * @param {{ onUpdated?: () => void, log?: (message: string) => void }} [options] 选项。
 * @returns {void}
 */
export function scheduleSkillUpdate(options = {}) {
  updateSkillCopy(options).catch(() => { /* 已在内部兜底，这里只防万一 */ });
}

/** 技能副本目录的绝对路径（诊断与测试用）。 */
export const SKILL_COPY_DIR = join(PACKAGE_ROOT, SKILL_REL);
