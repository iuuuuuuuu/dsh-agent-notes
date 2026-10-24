/**
 * 笔记服务：探测宿主仓库的笔记树、执行真门禁、归档。
 *
 * 门禁的诚实性要求（Owner 硬规则：禁止假绿）：
 *   - `runGate()` 真的 spawn vendored 校验脚本，读它的**进程退出码**；
 *     绝不把「脚本存在」「输出含 ok」当成通过。
 *   - 脚本缺失、node 不可用、超时，一律算**失败**并给出原因，
 *     不能静默降级成通过。
 *   - 返回结构里带 `exitCode` 与 `stdout/stderr` 原文，便于核对。
 *
 * 零依赖：只用 node 内建（child_process / fs / path / url）。
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchiveLayout } from './archive-layout.js';
import { checkNotesLayout } from './notes-layout.js';

/** 本包根目录。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** vendored 校验脚本在本包内的位置（第一候选）。 */
export const SCRIPTS_DIR = join(PACKAGE_ROOT, 'skills', 'agent-notes', 'scripts');

/**
 * 门禁脚本的其它候选目录，按优先级排列。
 *
 * ## 为什么需要多来源
 *
 * `runAllGates` 要能在**任意仓库**里跑（那是「脱离 DSH 也能用」的前提），
 * 但脚本曾把 `SCRIPTS_DIR` 当成唯一真相 —— 一个「在别的仓库里验笔记」的
 * 门禁，却只在自己所在包里找门禁脚本。实测四种独立用法**全部失败**：
 *
 *   - 只拷 `tools/verify-notes.mjs` → import 本包的 lib 就崩
 *   - 连 `lib/` 一起拷 → 去那个仓库的 `skills/` 找，找不到
 *   - **独立仓库自带 `.agents/skills/<skill>/scripts`**（那才是它真正有的
 *     形态，按 skill 模板脚本与笔记同在）→ **完全无视**，仍去包里找
 *
 * 第三条最说明问题：脚本就在眼前却看不见。所以按优先级列候选，
 * 谁先存在用谁。
 *
 * 优先级：
 *   1. `$AGENT_NOTE_SCRIPTS_DIR` —— 显式指定，永不猜
 *   2. 本包的 `skills/agent-notes/scripts` —— 本仓库的正常路径
 *   3. 目标仓库的 `.agents/skills/` 下各技能目录的 `scripts` ——
 *      **别的仓库用这条**：那个仓库自己的门禁脚本才是与它的笔记配套的版本
 *
 * @param {string} [cwd] 目标仓库工作目录，缺省为 `process.cwd()`。
 * @returns {string[]} 存在的候选目录，按优先级排列。
 */
export function scriptsDirCandidates(cwd = process.cwd()) {
  const candidates = [];
  if (typeof process.env.AGENT_NOTE_SCRIPTS_DIR === 'string'
    && process.env.AGENT_NOTE_SCRIPTS_DIR.trim() !== '') {
    candidates.push(process.env.AGENT_NOTE_SCRIPTS_DIR.trim());
  }
  candidates.push(SCRIPTS_DIR);

  /* 目标仓库里可能有好几个技能副本（不同 skill 名），全收进来 ——
     以「里面有没有门禁脚本」为准，而不是猜技能名。 */
  const skillsRoot = join(cwd, '.agents', 'skills');
  if (existsSync(skillsRoot)) {
    try {
      for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const scripts = join(skillsRoot, entry.name, 'scripts');
        if (existsSync(scripts)) candidates.push(scripts);
      }
    } catch {
      /* 读不到就跳过这一路，还有前两路兜底。 */
    }
  }

  return [...new Set(candidates.filter((dir) => {
    try { return statSync(dir).isDirectory(); } catch { return false; }
  }))];
}

/** 四条门禁：名字 → 脚本文件名。顺序即推荐执行顺序。 */
export const GATES = Object.freeze({
  tree: 'verify-agent-note-tree.ts',
  format: 'verify-agent-note-format.ts',
  archived: 'verify-archived-agent-notes.ts'
});

/** 生命周期目录（与上游封闭集一致）。 */
export const LIFECYCLES = Object.freeze(['proposed', 'implemented', 'rejected', 'archived']);

/** 分类封闭集（与上游一致，硬编码以防上游脚本缺失时无从判断）。 */
export const CLASSES = Object.freeze([
  'feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'
]);

/**
 * 解析宿主仓库的笔记根。
 *
 * 优先显式配置，其次 $AGENT_NOTE_ROOT（与上游脚本同一环境变量），
 * 最后 <cwd>/.agents/notes。
 *
 * @param {string} [configured] 显式覆盖。
 * @param {string} [cwd] 工作目录。
 * @returns {string} 笔记根绝对路径。
 */
export function resolveNotesRoot(configured, cwd = process.cwd()) {
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim());
  const env = process.env.AGENT_NOTE_ROOT;
  if (typeof env === 'string' && env.trim() !== '') return resolve(env.trim());
  return resolve(cwd, '.agents', 'notes');
}

/**
 * 向上找仓库根（含 .git 的目录），找不到则回退到起点。
 *
 * 笔记要跟代码同仓库，因此门禁默认跑在仓库根，而不是某个子目录。
 *
 * @param {string} start 起始目录。
 * @returns {string} 仓库根或起始目录。
 */
export function findRepoRoot(start = process.cwd()) {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = resolve(current, '..');
    if (parent === current) return resolve(start);
    current = parent;
  }
}

/**
 * git 探测结果的短缓存。
 *
 * **为什么需要**（实测）：`spawnSync('git', …)` 在 Windows 上是真的 fork 进程，
 * 单次 73–76ms，比读文件的 0.22ms 慢三百多倍。而 `/agent-notes/data` 每次
 * 轮询都要走一遍根解析：
 *   - `listWorktrees(cwd)` 一次；
 *   - cwd 若是**容器目录**，还要对每个子仓库各来一次 —— 子仓库越多越慢。
 * 实测 `/data` 的 TTFB 88ms 里，业务逻辑只占 3ms，其余全花在这两个 git 调用上。
 *
 * **为什么带 TTL 而不是永久缓存**：`git worktree list` 的结果会变 ——
 * 用户新建/删除 worktree 是常事。永久缓存会让新 worktree 的笔记一直不出现，
 * 这类「静默漏数据」比慢一点糟得多。TTL 到期重探，兼顾两者。
 *
 * **为什么 TTL 取 10 秒**：笔记内容变更走的是 `/data` 的 `revision` 比对
 * （每次都重新读文件，不受此缓存影响）；这里缓存的只是「有哪些根目录」，
 * 它变化的频率极低。10 秒足够挡住轮询（4 秒一次）的重复开销，
 * 又让新增 worktree 最多晚 10 秒被发现。
 *
 * 只缓存**成功**结果：失败（git 不存在、不是仓库）时缓存的空值会让
 * 一次瞬时故障变成持续 10 秒的「找不到根」，宁可每次重试。
 */
const GIT_PROBE_TTL_MS = 10_000;
const gitProbeCache = new Map();

/**
 * 带 TTL 的 git 探测缓存包装。
 *
 * @param {string} key 缓存键（必须包含命令与目录）。
 * @param {() => any} probe 实际探测函数。
 * @param {(value: any) => boolean} isSuccess 判断结果是否可缓存。
 * @returns {any} 探测结果。
 */
function cachedGitProbe(key, probe, isSuccess) {
  const hit = gitProbeCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < GIT_PROBE_TTL_MS) return hit.value;
  const value = probe();
  if (isSuccess(value)) gitProbeCache.set(key, { at: Date.now(), value });
  else gitProbeCache.delete(key);
  return value;
}

/**
 * 清空 git 探测缓存。仅测试用 —— 让用例之间不互相影响。
 */
export function clearGitProbeCache() {
  gitProbeCache.clear();
}

/**
 * 读一个目录的 origin remote URL，作为「同一个仓库」的判据。
 *
 * 为什么不靠 worktree 清单或目录名：容器目录下可能并列着**别人的参考仓库**
 * （实测：`WorkbuddySwitchAPi/` 下有 `ref-panel`、`ref-sliverkiss` 两个
 * 第三方 clone）。把它们和你的仓库混在一起，看板就会显示别人的决策笔记。
 *
 * @param {string} dir 仓库目录。
 * @returns {string | undefined} 归一后的 remote URL；没有则 undefined。
 */
export function originOf(dir) {
  /* 同一个子仓库在一次根解析里可能被问多次（基准判定 + 逐个过滤），
     缓存能省掉重复 fork。remote URL 几乎不会变，但仍走 TTL 以求一致。 */
  return cachedGitProbe(
    `origin\u0000${dir}`,
    () => originOfUncached(dir),
    (value) => typeof value === 'string' && value !== ''
  );
}

/**
 * `originOf` 的无缓存实现。
 *
 * @param {string} dir 仓库目录。
 * @returns {string | undefined} 归一后的 remote URL；没有则 undefined。
 */
function originOfUncached(dir) {
  try {
    const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
    const url = result.stdout.trim();
    if (url === '') return undefined;
    /* 归一：去掉协议、末尾 `.git`、末尾斜杠，让 https 与 ssh 两种写法可比。 */
    return url
      .replace(/^git@([^:]+):/, 'https://$1/')
      .replace(/^https?:\/\//, '')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * 找出 cwd 下（一层深）属于 git 工作树的子目录。
 *
 * 为什么需要：会话的 cwd 常常是**一个容器目录**而不是仓库本身 ——
 * 实测碰到：`WorkbuddySwitchAPi/` 本身不是仓库，里面并列着 `repo/`
 * 与 `wt-*` 等 7 个 git 工作树，笔记写在 `wt-port/` 里。
 * 这时在 cwd 上跑 `git worktree list` 会直接 fatal，什么根都拿不到。
 *
 * 只下探一层：再深就变成全盘扫描，代价与误报都不可控。
 *
 * @param {string} cwd 起始目录。
 * @returns {string[]} 含 `.git` 的子目录绝对路径。
 */
export function listGitChildren(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return [];
  const out = [];
  let entries;
  try {
    entries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    /* 跳过明显的噪音目录：它们不可能是用户的工作树，且遍历代价高。 */
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(cwd, entry.name);
    if (existsSync(join(full, '.git'))) out.push(full);
  }
  return out.sort();
}

/**
 * 列出与某目录同属一个仓库的所有 git 工作树。
 *
 * 为什么需要：笔记常写在**某个 worktree** 里（改哪条分支就在哪个工作树干活），
 * 而会话的 cwd 可能落在主工作树或另一个 worktree 上。只看 `<cwd>/.agents/notes`
 * 会让「写在 wt-port 里的笔记」在会话 cwd 是 repo 时完全消失 —— 实测踩到过：
 * 主仓库零篇，wt-port 一篇，看板却显示「这个仓库还没有 .agents/notes」。
 *
 * 做法：`git worktree list --porcelain` 是 git 自己维护的权威清单，
 * 比猜目录命名（`wt-*`）可靠得多 —— worktree 可以放在仓库外的任意路径。
 *
 * 失败时静默返回空数组：这不是关键路径，拿不到就退回只看 cwd 一个根。
 *
 * @param {string} cwd 起点目录（不必是仓库根）。
 * @returns {string[]} 各工作树的绝对路径；不含当前 cwd 之外的重复项。
 */
export function listWorktrees(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return [];
  /* 缓存（见 GIT_PROBE_TTL_MS 的说明）：这是单次最贵的调用（实测 73ms），
     而容器目录场景下会被调用很多次。只缓存非空结果 —— 空数组意味着
     「这里不是仓库」或「git 刚失败」，两种都不该被记住 10 秒。 */
  return cachedGitProbe(
    `worktrees\u0000${cwd}`,
    () => listWorktreesUncached(cwd),
    (value) => Array.isArray(value) && value.length > 0
  );
}

/**
 * `listWorktrees` 的无缓存实现。
 *
 * @param {string} cwd 起点目录（不必是仓库根）。
 * @returns {string[]} 各工作树的绝对路径；不含当前 cwd 之外的重复项。
 */
function listWorktreesUncached(cwd) {
  try {
    const result = spawnSync('git', ['worktree', 'list', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return [];
    const roots = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      /* 只认 `worktree <path>` 行；HEAD/branch 行不参与。 */
      const match = /^worktree\s+(.+)$/.exec(line);
      if (match !== null && match[1] !== undefined) roots.push(resolve(match[1].trim()));
    }
    return [...new Set(roots)];
  } catch {
    return [];
  }
}

/**
 * 找出与 cwd 相关的**所有**笔记根，主工作树优先。
 *
 * 顺序很重要：cwd 自己的笔记根排第一，其余按 git worktree 清单顺序。
 * 调用方按此顺序做「先到先得」的去重合并，从而让当前所在工作树说了算。
 *
 * @param {string} cwd 会话的工作目录。
 * @param {string} [configured] 显式配置的笔记根（有则只用它，不再探测）。
 * @returns {string[]} 笔记根绝对路径列表（可能为空）。
 */
export function resolveNotesRoots(cwd, configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return [resolve(configured.trim())];
  const env = process.env.AGENT_NOTE_ROOT;
  if (typeof env === 'string' && env.trim() !== '') return [resolve(env.trim())];

  const roots = [resolve(cwd, '.agents', 'notes')];
  const add = (root) => {
    const candidate = resolve(root, '.agents', 'notes');
    if (!roots.includes(candidate)) roots.push(candidate);
  };

  /* ① cwd 自己就是（或在）一个仓库里：拿它的全部 worktree。 */
  for (const root of listWorktrees(cwd)) add(root);

  /* ② cwd 是**容器目录**（本身不是仓库）：下探一层，把子仓库的 worktree
     算进来。实测碰到：工作区根下并列着 repo/ 与 wt-* 共 7 个工作树，
     笔记写在 wt-port/ 里，而在根上跑 git worktree list 直接 fatal。
     ⚠️ 必须按 origin remote 过滤：这些子目录里可能混着**别人的参考仓库**
     （实测有 ref-panel、ref-sliverkiss 两个第三方 clone），
     把它们和你的仓库混在一起，看板就会显示别人的决策笔记。 */
  const children = listGitChildren(cwd);
  if (children.length > 0) {
    /* 用「笔记最多的那个子仓库」的 origin 当基准？不行 —— 那是猜。
       基准取 cwd 下第一个有 origin 的子仓库，但只有**同源**的才收。 */
    const origins = new Map();
    for (const child of children) origins.set(child, originOf(child));
    /* 基准：优先取名为 repo 的（主工作树惯例），否则取第一个有 origin 的。 */
    const baseline = origins.get(join(cwd, 'repo'))
      ?? [...origins.values()].find((value) => value !== undefined);
    for (const child of children) {
      const origin = origins.get(child);
      /* 没有 origin（纯本地仓库）时保守收纳：用户自己的目录通常没 remote，
         而第三方 clone 一定带 remote。 */
      if (origin === undefined || baseline === undefined || origin === baseline) {
        for (const root of listWorktrees(child)) add(root);
        add(child);
      }
    }
  }

  return roots;
}

/**
 * 判断一个路径是否平台上的 node 可执行文件。
 *
 * @param {string} nodePath 候选路径。
 * @returns {boolean} 是否可用。
 */
function isRunnable(nodePath) {
  try {
    return existsSync(nodePath) && statSync(nodePath).isFile();
  } catch {
    return false;
  }
}

/**
 * 选一个 node 可执行文件。
 *
 * 直接用 process.execPath（当前 harness 进程自己的 node），这是最可靠的选择：
 * 它一定存在，且版本满足脚本要求（本插件要求 node >= 22.19）。
 *
 * @returns {string} node 绝对路径。
 */
export function nodeExecutable() {
  return process.execPath;
}

/**
 * 把门禁脚本准备成**可执行形态**。
 *
 * ## 为什么需要（实测的硬阻塞）
 *
 * Node **不允许在 `node_modules` 下运行 `.ts`**：
 *
 *     ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING:
 *     Stripping types is currently unsupported for files under node_modules
 *
 * 加 `--experimental-strip-types` 也拦不住 —— 限制在**路径**，不在开关。
 *
 * 而本插件经 npm 装进 `node_modules` 后，`skills/agent-notes/scripts/`
 * 下那 7 个 `.ts` 门禁脚本就全都跑不了。
 * 本地永远测不出来（本地不在 node_modules 下）。
 *
 * ## 做法：复制到临时目录
 *
 * 脚本放在 node_modules 下时，把**整个 scripts 目录**复制到一个临时目录
 * （那里不在 node_modules 下，Node 允许跑 `.ts`），并从那里执行。
 *
 * ★ 必须复制**整个目录**：脚本之间互相 `import`（`verify-agent-note-tree.ts`
 *   引 `agent-note-tree.ts`），只复制单个文件会解析失败。
 *
 * ★ 临时目录要放 `package.json` 声明 `type: module` —— 否则每次执行都打
 *   `MODULE_TYPELESS_PACKAGE_JSON` 警告，污染门禁输出。
 *
 * ## 为什么不在发布前预编译成 .js
 *
 * 试过：手写正则转译 7 个源文件，**0 个成功**。TS 形态比预估多得多
 * （`let x: T | null;` 后跟分号、泛型、`as` / `!` 断言），手写等于重做 TS。
 *
 * 而复制执行用 Node 官方剥除器，零转译风险，且**天然免疫上游同步** ——
 * `skills/` 是 vendored 会随上游更新，预编译就要记得重新编译，
 * 那本身是一类新的漏。
 *
 * @param {string} script 脚本绝对路径。
 * @returns {{ script: string, cleanup: () => void }} 可执行路径与清理函数。
 */
/**
 * 降级时的留痕。
 *
 * ★ 为什么需要：这个模块里有两处「复制失败就按原路径执行」的降级。
 *   静默降级会让「看起来正常、其实没生效」成为常态 —— 本会话已栽多次。
 *   写 stderr 而不是 stdout：门禁的 stdout 是给用户看结论的。
 *
 * @param {string} message 说明。
 */
function warnDegraded(message) {
  if (process.env.DSH_AGENT_NOTES_QUIET === '1') return;
  process.stderr.write(`[agent-notes] ${message}\n`);
}

export function prepareScriptForExecution(script) {
  const noop = () => {};
  if (!/node_modules/i.test(script)) return { script, cleanup: noop };

  const dir = dirname(script);
  let files;
  try {
    files = readdirSync(dir);
  } catch (e) {
    /* 降级但留痕 —— 静默降级会让「看起来正常其实没生效」成为常态。 */
    warnDegraded(`脚本目录不可读，按原路径执行（可能踩类型剥除限制）：${dir} — ${e.message}`);
    return { script, cleanup: noop };
  }

  let tmp;
  try {
    tmp = mkdtempSync(join(tmpdir(), 'dsh-agent-notes-'));
    for (const name of files) {
      const from = join(dir, name);
      try {
        if (statSync(from).isFile()) copyFileSync(from, join(tmp, name));
      } catch { /* 单个文件复制失败就让下游报「脚本缺失」，别在这里吞掉 */ }
    }
    /* 声明 ESM —— 否则每次执行打 MODULE_TYPELESS_PACKAGE_JSON 警告。 */
    writeFileSync(join(tmp, 'package.json'), '{"type":"module"}', 'utf8');
  } catch (e) {
    warnDegraded(`复制脚本到临时目录失败，按原路径执行：${e.message}`);
    return { script, cleanup: noop };
  }

  return {
    script: join(tmp, basename(script)),
    cleanup: () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  };
}

/**
 * 给 vendored 格式门禁的「缺小节」报错补一句更准的成因说明。
 *
 * 实测来源（2026-10-22，sourin-flutter-spike）：笔记正文里写了**未闭合**的
 * `<!--` 字面量（哪怕包在行内代码 `` `<!--` `` 或围栏里），vendored 的
 * 蒙版逻辑会把**它之后的每一行**都当成 HTML 注释 ⇒ 于是报
 * `missing one of ["## Consequences", …]`，可那一节的标题明明在文件里。
 * 作者的第一反应只会是「再补一个同名小节」—— 还是红，最后只能去改门禁脚本。
 *
 * 所以这里**只在已经判红之后**追加一条定位提示：不改变红/绿结论，
 * 也不猜「是不是注释导致的」，只陈述可核对的事实（第几行、几处未闭合）。
 *
 * @param {string} notesRoot 笔记根目录。
 * @param {string} stderr 门禁的原始 stderr。
 * @returns {string} 需要追加的文本（没有可追加的就返回空串）。
 */
export function explainMaskedCommentSections(notesRoot, stderr) {
  const rels = new Set();
  for (const m of String(stderr ?? '').matchAll(/^format: (.+?) — /gm)) rels.add(m[1]);
  if (rels.size === 0) return '';
  const hints = [];
  for (const rel of rels) {
    let text;
    try {
      text = readFileSync(join(notesRoot, rel), 'utf8');
    } catch {
      continue; // 读不到就不猜（门禁已经红了，别用读错误盖掉它）
    }
    const lines = text.split('\n');
    let depth = 0;
    let firstOpen = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const opens = (lines[i].match(/<!--/g) ?? []).length;
      const closes = (lines[i].match(/-->/g) ?? []).length;
      if (depth === 0 && opens > closes && firstOpen === 0) firstOpen = i + 1;
      depth = Math.max(0, depth + opens - closes);
    }
    if (depth > 0 && firstOpen > 0) {
      hints.push(
        `format: ${rel} — 补充：第 ${firstOpen} 行有未闭合的 \`<!--\`（还差 ${depth} 处）。`
        + '它之后的每一行都会被当成注释，所以上面「缺小节」很可能是假象：'
        + '先补上 `-->`，或把字面量改写成 `&lt;!--`。'
      );
    }
  }
  if (hints.length === 0) return '';
  const text = String(stderr ?? '');
  const sep = text === '' || text.endsWith('\n') ? '' : '\n';
  return `${sep}${hints.join('\n')}\n`;
}

/**
 * 跑一条门禁，返回真实退出码与输出。
 *
 * **笔记树不存在时一律判失败**（`reason: NO_NOTES_TREE`）。这是刻意的：
 * 三个校验脚本在空目录上都会 exit 0 并打印「ok: 0 note(s) verified」——
 * 从"脚本没说错"的角度是真的，但从"你的笔记合规"的角度是**空的**。
 * 曾实测：一个 `.agents/notes` 根本不存在的仓库，三条门禁全 passed: true。
 * 把这种结果报成绿，就是拿空集当通过证明，属于明令禁止的假绿。
 * 没东西可验 ≠ 验过了。
 *
 * @param {string} gateName GATES 里的键。
 * @param {{ cwd?: string, env?: Record<string,string>, timeoutMs?: number, notesRoot?: string, requireNotesTree?: boolean, signal?: AbortSignal }} [options] 执行选项。
 *   `signal` 会被真正传给子进程（宿主取消时门禁应当立刻停），不是只做个样子。
 * @returns {Promise<{ gate: string, script: string, passed: boolean, exitCode: number | null, signal: string | null, stdout: string, stderr: string, reason?: string }>}
 */
export async function runGate(gateName, options = {}) {
  const scriptName = GATES[gateName];
  if (scriptName === undefined) {
    return {
      gate: String(gateName),
      script: '',
      passed: false,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      reason: `未知门禁 "${gateName}"（可选：${Object.keys(GATES).join(', ')}）`
    };
  }

  /* 脚本定位按优先级试：显式指定 → 本包 → **目标仓库自己的**技能目录。
     最后一路是「别的仓库用」的关键 —— 那个仓库的门禁脚本才是与它的笔记
     配套的版本，而它就在 `.agents/skills/` 下各技能的 scripts 里。 */
  const searchDirs = scriptsDirCandidates(options.cwd ?? process.cwd());
  const scriptDir = searchDirs.find((dir) => existsSync(join(dir, scriptName)));
  const script = scriptDir === undefined
    ? join(SCRIPTS_DIR, scriptName)
    : join(scriptDir, scriptName);
  const base = {
    gate: gateName,
    script,
    passed: false,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    ...(scriptDir === undefined
      ? { searchedDirs: searchDirs }
      : {})
  };

  if (!isRunnable(script)) {
    /* 找不到时必须说清**找过哪些地方** —— 独立仓库里最常见的情形是
       「脚本在 .agents/skills/<某名>/scripts 下但名字对不上」，只报一个
       拼出来的路径会让人以为是文件真不存在。 */
    const dirs = base.searchedDirs ?? [];
    const searched = dirs.length === 0
      ? '（没有任何候选目录存在 —— 脚本所在包与目标仓库都没找到门禁脚本）'
      : dirs.join('\n      ');
    return {
      ...base,
      reason: `门禁脚本缺失：${script}`
        + `\n    已查找：${searched}`
        + '\n    若脚本在目标仓库里，请确认它位于 .agents/skills/<技能名>/scripts/'
        + `\n    （本文件名是 ${scriptName}），或用 $AGENT_NOTE_SCRIPTS_DIR 显式指定目录。`
    };
  }
  const node = nodeExecutable();
  if (!isRunnable(node)) {
    return { ...base, reason: `node 不可用：${node}` };
  }

  const cwd = options.cwd ?? process.cwd();

  /* ★ 2026-10-24：笔记根**只解析一次，全程复用**。
     原先三处各解析一次，优先级还不一样 —— 预检用
     `options.notesRoot ?? resolveNotesRoot(undefined, cwd)`（不看 options.env），
     真正 spawn 的门禁用 `options.notesRoot ?? gateEnv.AGENT_NOTE_ROOT ?? …`，
     计数又回到第一式。于是**只传 `options.env.AGENT_NOTE_ROOT`** 时：
     预检看树 A（有 1 篇）、门禁验树 B（空）、计数报树 A ⇒
     `passed: true` / `noteCount: 1` 而三条门禁全是 `ok: 0`。
     「三处各自解析」就是这次假绿的成因，收敛成一处才能真正对齐
     （原先只为修活动侧的零篇假绿而加的判据，敌不过解析漂移）。 */
  const notesRootResolved = resolveNotesRoot(
    options.notesRoot ?? options.env?.AGENT_NOTE_ROOT,
    cwd
  );

  /* 没有笔记树就没有可验对象。脚本会 exit 0，但那不是"你的笔记合规"，
     而是"没有笔记"。必须在这里拦下，不能让空集冒充通过。 */
  if (options.requireNotesTree !== false) {
    const notesRoot = notesRootResolved;
    if (!existsSync(notesRoot)) {
      return {
        ...base,
        reason: `NO_NOTES_TREE：笔记树不存在（${notesRoot}）。没有可校验的笔记，`
          + '这不等于通过；请先建立笔记树（/agent-notes init）或确认 cwd 是否指对了仓库。'
      };
    }
    /* `init` 刚建出目录时是「有树、零篇」—— 同样没有可验对象，一并拦下。
       判据必须是「至少一篇」，不是「目录存在」。
       而且「一篇」得是 vendored 真会枚举的那种（落在生命周期目录里）：
       根层散落的 `.md` 它们一个都不验，拿它抵数就是零篇冒充通过。 */
    const tree = inspectTree(notesRoot);
    if (tree.noteFiles.length === 0) {
      const stray = tree.strayFiles.length;
      return {
        ...base,
        reason: `NO_NOTES_YET：笔记树存在但一篇笔记都没有（${notesRoot}）。`
          + '零篇通过校验没有意义，这不等于笔记合规；请先写笔记，或确认 cwd 是否指对了仓库。'
          + (stray > 0
            ? `\n    另有 ${stray} 个 .md 散落件或翻译旁挂未计入独立笔记，`
              + '因此不能算作笔记。'
            : '')
      };
    }

    /* ★ 笔记根这一层的形状（插件自有，vendored 不管）。
       三条 vendored 门禁都按 `{lifecycle}/{class}/` 形状**枚举**笔记，
       于是落在枚举路径之外的文件是隐形的：顶层散落的 `.md` 既不会被判
       归档、也不会被判格式违规，还不计入笔记数 —— 「磁盘上有几篇笔记」
       与「门禁报告几篇」会对不上，而没有任何门禁会指出这一点。
       判据与理由见 `lib/notes-layout.js` 顶部注释。 */
    const layout = checkNotesLayout({ notesRoot });
    if (layout.errors.length > 0) {
      return {
        ...base,
        exitCode: 1,
        stdout: '',
        stderr: layout.errors.map((line) => `notes: ${line}`).join('\n') + '\n',
        reason: `NOTES_LAYOUT: 笔记根不合规（${layout.errors.length} 项）`
      };
    }
  }

  const gateEnv = { ...process.env, ...(options.env ?? {}) };
  /* ★ 2026-10-22：`AGENT_NOTE_ROOT` 必须对**每一条**门禁都生效，不只 archived。
     原先它只在 archived 分支里设置 ⇒ `runGate('format', { notesRoot })` 会被
     静默忽略：vendored 脚本退回 cwd 下的 `.agents/notes`，于是「对着临时树跑
     一条门禁」实际验的是当前仓库的笔记 —— 结果是绿，而绿得毫无意义。
     这类「参数被吞掉、结论却是绿的」正是最该消灭的形态。 */
  const gateNotesRoot = notesRootResolved;
  gateEnv.AGENT_NOTE_ROOT = gateNotesRoot;
  /* 预检阶段的警告要留给调用方看（不能只在内存里）——
     最典型的是「没找到 origin/main，退回 HEAD」，那等于冻结强度下降，
     而输出若与正常情况一字不差，没人会发现。 */
  const preflightWarnings = [];
  if (gateName === 'archived') {
    const notesRoot = gateNotesRoot;

    /* ★ 归档树的形状/元数据/封印 schema 前置校验（插件自有，vendored 不管）。
       放在 Git 基线校验**之前**：形状坏了就是坏了，不该先花一次 Git 调用。
       判据与理由见 `lib/archive-layout.js` 顶部注释。 */
    const layout = checkArchiveLayout({ notesRoot });
    if (layout.errors.length > 0) {
      return {
        ...base,
        exitCode: 1,
        stdout: '',
        stderr: layout.errors.map((line) => `archived: ${line}`).join('\n') + '\n',
        reason: `ARCHIVE_LAYOUT: 归档树不合规（${layout.errors.length} 项）`
      };
    }

    const git = (args) => spawnCapture('git', args, {
      cwd: notesRoot,
      env: gateEnv,
      timeoutMs: options.timeoutMs ?? 120_000,
      signal: options.signal
    });
    const failed = (result, detail) => ({
      ...base,
      passed: false,
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      reason: `ARCHIVE_BASELINE: ${detail}`
    });
    const repository = await git(['rev-parse', '--show-toplevel']);
    if (repository.exitCode !== 0) {
      // 无仓库时仍由 vendored 脚本检查磁盘封印；其他 Git 故障失败关闭。
      if (repository.timedOut || !/not a git repository|spawn git ENOENT/i.test(repository.stderr)) {
        return failed(repository, 'Git repository discovery failed');
      }
    } else {
      /* 基线 ref：显式指定优先；否则钉 `origin/main`。
       *
       * **为什么默认是 origin/main 而不是 HEAD**（2026-10-24 实测 + Owner 裁定）：
       * 「只增不改」要比对的是「历史里的封印」与「现在的封印」。用 `HEAD` 时，
       * 未提交的改动会被发现，但**已提交**的改动不会 —— 因为当前工作区与 HEAD
       * 都已经是改后的那一份。实测：改归档笔记内容、把 manifest 里的封印同步更新、
       * 再提交，`HEAD` 基线下 `exit=0 / passed=true`；显式指旧 commit 时 `exit=1`。
       * 也就是说默认配置下这道检查**基本是空转**的（只防「改了没提交」）。
       * 钉 `origin/main` 才真正冻结：任何已合并的封印改动都会对上历史基线。
       *
       * 没有 `origin/main` 时（本地新仓、浅克隆、无远端）**退回 HEAD 并明确告警** ——
       * 直接失败关闭会让所有本地仓库与夹具一律红，那不是收紧而是把门禁弄坏；
       * 但退让必须留痕，否则「冻结强度下降」这件事只存在于注释里。 */
      const explicitBaseline = gateEnv.AGENT_NOTE_ARCHIVE_BASE_REF;
      let baseRef = explicitBaseline;
      if (baseRef === undefined || baseRef === '') {
        const remoteMain = await git(['rev-parse', '--verify', '--end-of-options', 'refs/remotes/origin/main^{commit}']);
        if (remoteMain.exitCode === 0) {
          baseRef = 'refs/remotes/origin/main';
        } else {
          baseRef = 'HEAD';
          preflightWarnings.push(
            'warning: 没有可解析的 origin/main，归档 append-only 基线退回 HEAD ——'
            + ' 已提交的封印改动看不见（只防工作区未提交的改动）。'
            + ' 要真正冻结，请设置 AGENT_NOTE_ARCHIVE_BASE_REF（例如 origin/main）或补一个远端。'
          );
        }
      }
      const commit = await git(['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`]);
      if (commit.exitCode !== 0) {
        /* 空仓库（`git init` 之后一次都没提交）里 HEAD 是**未诞生**的符号引用：
           解析不出 commit 是正常的，此时历史为空，没有任何历史封印可对照 ——
           放行给 vendored 脚本验磁盘上的那份 manifest 即可。

           但**显式**指定的基线解析不出来仍然失败关闭：那时用户明确说了
           「以这个提交为准」，静默忽略等于把门禁降级成空转。
           实测来源：tools/verify-notes-standalone.test.mjs 的沙箱只 `git init`
           不提交，不区分这条就把它整条打成红。 */
        if (Boolean(explicitBaseline)) return failed(commit, 'Invalid archive baseline commit');
        const symbolic = await git(['symbolic-ref', '--quiet', 'HEAD']);
        if (symbolic.exitCode !== 0) return failed(commit, 'Invalid archive baseline commit');
      } else {
        const oid = commit.stdout.trim();
        const manifestPath = join(notesRoot, 'archived', 'manifest.json');
        const prefix = await git(['rev-parse', '--show-prefix']);
        if (prefix.exitCode !== 0) return failed(prefix, 'Archive baseline prefix resolution failed');
        const manifestRel = `${prefix.stdout.trim()}archived/manifest.json`;
        const entry = await git(['--literal-pathspecs', 'ls-tree', '--full-tree', '-z', oid, '--', manifestRel]);
        if (entry.exitCode !== 0) return failed(entry, 'Archive baseline tree read failed');
        if (entry.stdout !== '') {
          const historical = await git(['show', `${oid}:${manifestRel}`]);
          if (historical.exitCode !== 0) return failed(historical, 'Archive baseline manifest read failed');
          try {
            const baseline = JSON.parse(historical.stdout);
            const current = existsSync(manifestPath)
              ? JSON.parse(readFileSync(manifestPath, 'utf8'))
              : { files: {} };
            if (!baseline.files || typeof baseline.files !== 'object' || Array.isArray(baseline.files)) {
              throw new Error('Invalid baseline files map');
            }
            for (const [key, seal] of Object.entries(baseline.files)) {
              if (current.files?.[key] !== seal) {
                return failed(historical, `Archived seal changed or removed: ${key}`);
              }
            }
          } catch (error) {
            return failed(historical, `Archive manifest validation failed: ${error.message}`);
          }
        }
        // Pin the verified commit across preflight and vendored checks.
        gateEnv.AGENT_NOTE_ARCHIVE_BASE_REF = oid;
      }
    }
  }

  /* ★ 脚本若在 node_modules 下，`.ts` 跑不了（Node 硬限制）——
     复制到临时目录再执行。详见 prepareScriptForExecution 的注释。 */
  const prepared = prepareScriptForExecution(script);

  let result;
  try {
    result = await spawnCapture(node, [prepared.script], {
      cwd,
      env: gateEnv,
      timeoutMs: options.timeoutMs ?? 120_000,
      /* ★ 2026-10-24：`signal` 必须真的传下去。
         原先这里只传 cwd/env/timeoutMs —— `lib/tools.js` 明明把宿主的
         `exec.signal` 交给 runGate，`spawnCapture` 也明明支持它，中间这一跳
         却把它丢了：用户在界面上点了取消，子进程仍会跑满（最长 120s），
         而结论还是绿的。实测对照：同一个「睡 4 秒的假门禁」+ 300ms abort，
         `spawnCapture` 322ms 就被 SIGKILL，`runGate` 却跑了 4324ms
         并以 exitCode=0 / passed=true 收尾。
         这与本文件里「参数被吞掉、结论却是绿的」是同一种形态。 */
      signal: options.signal
    });
  } finally {
    prepared.cleanup();
  }

  // ★ 2026-10-22：把 vendored format 门禁最容易误导读者的失败翻译一句。
  //   实测（sourin-flutter-spike）：正文里写了未闭合的 `<!--` 字面量
  //   （哪怕在行内代码或围栏里），vendored 蒙版会把**它之后的所有行**
  //   当成注释 ⇒ 于是报「missing one of ["## Consequences", …]」。
  //   可那篇的 `## Consequences` 明明在文件里 —— 作者会去加一个重复小节、
  //   依然红，最后只能去改门禁脚本（Owner 2026-10-22 报过的形态）。
  //   ⇒ 只在**已经判红**时补一句更准的解释，绝不改变红/绿结论。
  const stderr = result.exitCode === 0
    ? result.stderr
    : `${result.stderr}${explainMaskedCommentSections(gateNotesRoot, result.stderr)}`;

  return {
    ...base,
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    /* 预检警告必须随结果带出去（当前只有 archived 产生）：
       「基线退回 HEAD」这类事若只留在注释里，等于没发生。 */
    stderr: `${stderr}${preflightWarnings.length > 0 ? `${stderr.endsWith('\n') || stderr === '' ? '' : '\n'}${preflightWarnings.join('\n')}\n` : ''}`,
    ...(result.timedOut ? { reason: `门禁超时（${options.timeoutMs ?? 120_000}ms）` } : {}),
    ...(result.exitCode === 0 ? {} : { reason: result.exitCode === null ? '进程未正常结束' : undefined })
  };
}

/**
 * 跑全部门禁。
 *
 * @param {{ cwd?: string, env?: Record<string,string>, timeoutMs?: number, notesRoot?: string, requireNotesTree?: boolean, signal?: AbortSignal }} [options] 执行选项。
 * @returns {Promise<{ passed: boolean, results: any[], noteCount: number, strayCount: number, notesRoot: string }>} 汇总结果；全绿才算通过。
 */
export async function runAllGates(options = {}) {
  const results = [];
  for (const gateName of Object.keys(GATES)) {
    results.push(await runGate(gateName, options));
  }
  /* 带上笔记数：0 篇是「通过」还是「空树」，调用方必须能分辨。
     `noteCount` 只数 vendored 真会枚举的那些（生命周期目录里的、且不是翻译旁挂），
     散落在根层的另记 `strayCount` —— 两处数字必须与门禁输出对得上，
     否则「磁盘上有几篇」与 `ok: N note(s)` 会各说各话。
     ★ 解析方式必须与 runGate 完全一致（同一优先级、同一处收敛），
     否则又是「预检看树 A、门禁验树 B、计数报树 A」那种假绿。 */
  const tree = inspectTree(resolveNotesRoot(
    options.notesRoot ?? options.env?.AGENT_NOTE_ROOT,
    options.cwd ?? process.cwd()
  ));
  return {
    passed: results.every((entry) => entry.passed),
    results,
    noteCount: tree.noteFiles.length,
    strayCount: tree.strayFiles.length,
    notesRoot: tree.root
  };
}

/**
 * spawn 一个进程并收集输出，带超时与取消。
 *
 * @param {string} command 可执行文件。
 * @param {string[]} args 参数。
 * @param {{ cwd?: string, env?: any, timeoutMs?: number, signal?: AbortSignal }} options 选项。
 * @returns {Promise<{ exitCode: number | null, signal: string | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function spawnCapture(command, args, options = {}) {
  return new Promise((settle) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      settle({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: String(error?.message ?? error),
        timedOut: false
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let finished = false;

    const finish = (payload) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (options.signal !== undefined) {
        options.signal.removeEventListener?.('abort', onAbort);
      }
      settle(payload);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出。
      }
    }, options.timeoutMs ?? 120_000);
    if (typeof timer.unref === 'function') timer.unref();

    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出。
      }
    };
    if (options.signal !== undefined) options.signal.addEventListener?.('abort', onAbort, { once: true });
    /* ★ 2026-10-24：**已经 abort 过**的信号必须显式补一次。
       `addEventListener` 对「注册时就已经 abort」的情况不会再触发，
       于是「传一个已取消的信号」等于没传 —— 门禁照跑满。
       取消是个契约，不该依赖调用者恰好赶在窗口内。 */
    if (options.signal?.aborted === true) onAbort();

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish({ exitCode: null, signal: null, stdout, stderr: `${stderr}${String(error?.message ?? error)}`, timedOut });
    });
    child.on('close', (code, signal) => {
      finish({ exitCode: code, signal: signal ?? null, stdout, stderr, timedOut });
    });
  });
}

/**
 * 清掉 node 在无 "type":"module" 场景下的重解析告警，保留真实诊断。
 *
 * 这些告警是 node 的 MODULE_TYPELESS_PACKAGE_JSON 噪声，会掩盖真错误；
 * 只过滤告警行，任何 `format:` / `structure:` / `archived:` 前缀的真实
 * 诊断一律保留。
 *
 * @param {string} text 原始输出。
 * @returns {string} 过滤后的输出。
 */
export function stripNodeNoise(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/MODULE_TYPELESS_PACKAGE_JSON|Reparsing as ES module|To eliminate this warning|^\(Use `node --trace-warnings/.test(line))
    .join('\n')
    .trim();
}

/**
 * 列出笔记树内容（用于状态展示与诊断）。
 *
 * @param {string} root 笔记根。
 * @returns {{
 *   root: string, exists: boolean, counts: Record<string, number>,
 *   files: string[], noteFiles: string[], strayFiles: string[]
 * }} `files` 是磁盘上所有 `.md`；`noteFiles` 只含生命周期目录里的
 *   （排除说明文件与活动翻译旁挂）；`strayFiles` 包含其余未计入独立笔记的 Markdown。
 */
export function inspectTree(root) {
  /* 树不存在时也要给出同形状的返回值：调用方按字段取值，
     少一个 `noteFiles` 就会在空树上抛 `Cannot read properties of undefined`
     —— 崩溃不是判红（`2026-10-21-crash-is-not-a-red-gate.md`）。 */
  if (!existsSync(root)) {
    return { root, exists: false, counts: {}, files: [], noteFiles: [], strayFiles: [] };
  }
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
    }
  }
  const counts = {};
  const noteFiles = [];
  const strayFiles = [];
  for (const file of files) {
    const rel = file.slice(root.length + 1).split(/[\\/]/);
    const lifecycle = rel[0] ?? 'unknown';
    /* 只有落在生命周期目录**里面**的 `.md` 才算「一篇笔记」。
       判据必须与 vendored 门禁实际枚举的路径一致 —— 它们按
       `{lifecycle}/{class}/` 枚举，根层散落的 `.md` 一个都不验、也不计数。
       原先这里把根层散落件也算进 `counts` 与 `files`，于是
       「磁盘上有 1 篇」与门禁报的 `ok: 0 note(s)` 对不上；
       更糟的是零篇判据 `files.length === 0` 被它骗过：
       只放一个散落 `.md` 就能让三道门禁都绿（实测 `passed: true`,
       `ok: 0 note(s)`）—— 零篇被冒充成通过。 */
    const isLifecycleRootGuide = rel.length === 2
      && (rel[1] === 'AGENTS.md' || rel[1] === 'CLAUDE.md');
    /* `.zh.md` 翻译旁挂**任何生命周期都不算独立笔记**，archived 也不行。
       2026-10-24 自审补上：先前只排除活动生命周期的旁挂，archived 侧照旧计入，
       于是**同一个零篇假绿在归档一侧原样存活** —— 树里只放一个
       `archived/<class>/x.zh.md` 外加给它的封印，就得到
       `passed: true` / `noteCount: 1`，而三条门禁实际校验的是
       `ok: 0 note(s)`（实测复现）。
       判据必须是「vendored 到底验不验它」：vendored 扫描时一律跳过 `.zh.md`，
       archived 的旁挂另由 `lib/archive-layout.js` 管**封印**（那是另一件事，
       不等于「验了这篇笔记的格式」）。既然没有任何门禁验它的笔记格式，
       它就不能顶一篇笔记的额度。
       旁挂仍归 `strayFiles`：它表示「未计入独立笔记的 Markdown」，不是「违规」。 */
    const isTranslationSidecar = file.endsWith('.zh.md');
    if (rel.length >= 2 && LIFECYCLES.includes(lifecycle) && !isLifecycleRootGuide && !isTranslationSidecar) {
      counts[lifecycle] = (counts[lifecycle] ?? 0) + 1;
      noteFiles.push(file);
    } else {
      strayFiles.push(file);
    }
  }
  return {
    root,
    exists: true,
    counts,
    files: files.sort(),
    noteFiles: noteFiles.sort(),
    strayFiles: strayFiles.sort()
  };
}

/**
 * 创建笔记服务。
 *
 * @param {any} ctx Cordis 上下文。
 * @param {string} [notesRootOption] 笔记根覆盖。
 * @returns {any} 笔记服务 API。
 */
export function createNotesService(ctx, notesRootOption) {
  return {
    /** 当前解析出的笔记根。 */
    root(cwd) {
      return resolveNotesRoot(notesRootOption, cwd ?? process.cwd());
    },

    /**
     * 与 cwd 相关的**所有**笔记根（当前工作树优先）。
     *
     * 供看板用：一个仓库可有多个 git worktree，笔记散落在各自工作树里。
     * 门禁仍只跑 `root()` 一个根 —— 合并后的树会让「当前 checkout 是否合规」
     * 这个判断失真。
     *
     * @param {string} [cwd] 会话工作目录。
     * @returns {string[]} 笔记根列表。
     */
    roots(cwd) {
      return resolveNotesRoots(cwd ?? process.cwd(), notesRootOption);
    },

    /** 仓库根（笔记默认所在）。 */
    repoRoot(cwd) {
      return findRepoRoot(cwd ?? process.cwd());
    },

    /** 探测笔记树。 */
    inspect(cwd) {
      return inspectTree(this.root(cwd));
    },

    /** 跑单条门禁（真退出码）。 */
    runGate(gateName, options = {}) {
      const cwd = this.repoRoot(options.cwd);
      /* 把服务自己解析出的 root 传下去：notesRootOption / $AGENT_NOTE_ROOT
         可能覆盖默认位置，让 runGate 自己推导会验错目录。
         ★ 2026-10-24：`options.env.AGENT_NOTE_ROOT` 必须排在 `this.root(cwd)` **之前**。
         它原先被无条件盖掉 —— 而 `this.root()` 只看服务选项与 `process.env`，
         从不看调用方传进来的 `options.env`。于是「只传 options.env」这个用法
         被静默忽略：调用方以为在验 env 指的那棵树，实际验的是默认位置。
         这与本文件里「参数被吞掉、结论却是绿的」是同一种形态。 */
      const resolved = options.notesRoot
        ?? options.env?.AGENT_NOTE_ROOT
        ?? this.root(cwd);
      return runGate(gateName, { ...options, cwd, notesRoot: resolved });
    },

    /** 跑全部门禁。 */
    runAll(options = {}) {
      const cwd = this.repoRoot(options.cwd);
      /* 与 runGate 同一优先级（见上一条注释）：两处必须一致，
         否则又是「预检/门禁/计数」各看一棵树。 */
      const resolved = options.notesRoot
        ?? options.env?.AGENT_NOTE_ROOT
        ?? this.root(cwd);
      return runAllGates({ ...options, cwd, notesRoot: resolved });
    },

    /** 是否已建立笔记树。 */
    isInitialized(cwd) {
      return existsSync(this.root(cwd));
    },

    /**
     * 脚手架：建出标准目录结构（用到的目录即建，不预建空目录）。
     *
     * @param {{ cwd?: string, lifecycles?: string[] }} [options] 选项。
     * @returns {{ created: string[] }} 建出的目录。
     */
    scaffold(options = {}) {
      const root = this.root(options.cwd);
      const wanted = options.lifecycles ?? ['proposed', 'implemented', 'rejected'];
      const created = [];
      for (const lifecycle of wanted) {
        const dir = join(root, lifecycle);
        mkdirSync(dir, { recursive: true });
        created.push(dir);
      }
      return { created };
    }
  };
}

/**
 * 读一条笔记的原文（供工具返回给模型）。
 *
 * @param {string} file 绝对路径。
 * @returns {string | undefined} 内容或 undefined。
 */
export function readNote(file) {
  try {
    if (!existsSync(file)) return undefined;
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}
