#!/usr/bin/env node
/**
 * 覆盖门禁：**该写笔记的改动，必须同批带一篇笔记**。
 *
 * ## 为什么需要它（这是本仓库真实踩过的坑）
 *
 * 既有的 `notes:gate` 校验的是「**已经写了的**笔记格式对不对」——
 * 头块、状态、必备节、备选方案、相对链接。它**从不检查「该写而没写」**。
 * 于是出现了一个稳定复现的失效模式：
 *
 *   修 CI 时连续 5 次提交改了 `.github/workflows/verify.yml`，一次笔记都没写。
 *   而这恰恰是规范里明确要求记录的「改了流程与工具链」。
 *
 * 原因不是规范写错了 —— 规范连「对 AI 来说写在散文里的规矩等于没有规矩」
 * 都写进去了。真正的原因是：**判断「要不要写」这一步全靠模型自觉，
 * 而多轮对话里它一定会忘。** 规范自己承认这一点，却没有给出兜底。
 *
 * 所以这里把「要不要写」从语义判断降级成**机械可判定的路径规则**：
 * 只要改动命中受管路径，同一次提交里就必须有 `.agents/notes/` 的变更。
 *
 * ## 判定口径（刻意保守，宁少报不多报）
 *
 * 命中即要求笔记：
 *   - `lib/**`            插件运行时行为
 *   - `tools/**`          工具链与门禁
 *   - `.github/**`        CI 流程
 *   - `skills/agent-notes/**`   vendored 内容（正常由 sync 维护，手改必须解释）
 *
 * 明确**不要求**（否则门禁会被噪音淹没，最后被 --no-verify 绕过）：
 *   - `.agents/notes/**`  笔记本身
 *   - `CHANGELOG.md` / `README*.md` / `LICENSE`   文档
 *   - `package.json` / `upstream.json` / `tools/upstream-manifest.json`
 *     版本号、上游 ref、清单摘要 —— 这些是 `sync` / `bump-version` 的
 *     机械产物，写笔记反而是噪音（见规范里的「机械改动严禁立笔记」）
 *     ⚠️ 但 `tools/upstream-manifest.json` 在 `tools/**` 之下，
 *     所以下面用**显式豁免表**在路径命中之后再做减法。
 *   - `.probe/**` 等临时目录（通常已被 .gitignore 排除）
 *
 * ## 为什么做成「路径白名单」而不是「判断这次改动是否非平凡」
 *
 * 后者需要理解 diff 语义，做不到可靠。而路径白名单的**误报方向是安全的**：
 * 它只会多要求笔记，不会漏要求。真正不该写的改动可以走豁免标记（见下），
 * 而不是让门禁去猜。
 *
 * ## 用法
 *
 *   node tools/notes-coverage.mjs                 # 检查暂存区（pre-commit 用）
 *   node tools/notes-coverage.mjs --range A..B    # 检查提交区间（CI 用）
 *   node tools/notes-coverage.mjs --staged        # 显式指定暂存区
 *
 * 环境变量：
 *   NOTES_COVERAGE_BASE   与 --range 等价（CI 里传 base sha 更方便）
 *
 * 退出码：0=通过（该写的都写了，或本来就不需要写）；1=有改动缺笔记；2=无法判定。
 * **2 也必须算失败** —— 「查不到」绝不能当成「没问题」。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * 命中即要求配笔记的路径前缀。
 *
 * 顺序无关，逐个前缀判断是否命中。
 */
const MANAGED_PREFIXES = Object.freeze([
  'lib/',
  'tools/',
  '.github/',
  'skills/agent-notes/'
]);

/**
 * 受管路径内的豁免项（精确匹配）。
 *
 * 只豁免**机械产物**：同步清单是 `sync-upstream` 写出来的哈希表，
 * 为它写笔记是纯噪音。
 *
 * 注意这里**只放生成物**，不放源文件 —— `tools/sync-upstream.mjs` 是工具链
 * 源码，改它必须写笔记。（我第一版把它误放进来，等于给「改门禁不写笔记」
 * 留了后门，正是本门禁要堵的那个洞。）
 */
const EXEMPT_EXACT = Object.freeze([
  'tools/upstream-manifest.json'
]);

/**
 * 允许「这次确实不需要笔记」的显式标记。
 *
 * 提交信息里单独一行 `Note-Skip: <理由>` 即可放行。要求理由非空，
 * 因为「写了理由」这个动作本身就会让人再想一遍 —— 空理由直接拒绝。
 *
 * 为什么保留这个口子：路径白名单必然有误报（比如改个错别字、
 * 或纯粹调整注释）。没有合法出口的门禁只会被非法出口（--no-verify）绕过，
 * 那样连检查都跑不起来了。
 */
const SKIP_MARKER = /^Note-Skip:\s*(\S.*)$/m;

/**
 * 跑 git 并返回 stdout。
 *
 * cwd 取**当前工作目录**而不是脚本所在目录：门禁要能对任意仓库生效
 * （测试就是在临时仓库里跑它），写死 PACKAGE_ROOT 会让它永远只看本仓库，
 * 换到别的项目就静默失效 —— 那是假绿的另一种形态。
 *
 * @param {string[]} args git 参数。
 * @returns {{ ok: boolean, out: string, err: string }} 结果。
 */
function git(args) {
  const result = spawnSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    out: String(result.stdout ?? ''),
    err: String(result.stderr ?? '')
  };
}

/**
 * 取本次要检查的变更文件列表。
 *
 * @param {string[]} argv 命令行参数。
 * @returns {{ files: string[] | undefined, label: string, reason?: string }} 文件列表或失败原因。
 */
function collectFiles(argv) {
  const rangeFlag = argv.indexOf('--range');
  const rangeValue = rangeFlag >= 0 ? argv[rangeFlag + 1] : undefined;
  const envBase = process.env.NOTES_COVERAGE_BASE;

  /* CI：按区间取。base 为空（例如首个提交）时退化为「只比 HEAD」。 */
  const range = rangeValue ?? envBase;
  if (typeof range === 'string' && range !== '') {
    /* 允许 `--range <sha>`：自动补成 <sha>..HEAD。 */
    const spec = range.includes('..') ? range : `${range}..HEAD`;
    /* 过滤掉删除（D）：删一篇笔记不能算「带了笔记」。 */
    const result = git(['diff', '--name-status', '--diff-filter=ACMR', spec]);
    if (!result.ok) {
      return { files: undefined, label: spec, reason: `git diff 失败: ${result.err.trim()}` };
    }
    return { files: statusLines(result.out), label: spec };
  }

  /* 本地：默认看暂存区（commit-msg 钩子的语义）。
     过滤删除（D）：删一篇旧笔记配合任意受管改动就能过门禁 —— 实测确认是后门。 */
  const result = git(['diff', '--cached', '--name-status', '--diff-filter=ACMR']);
  if (!result.ok) {
    return { files: undefined, label: '暂存区', reason: `git diff --cached 失败: ${result.err.trim()}` };
  }
  return { files: statusLines(result.out), label: '暂存区' };
}

/**
 * 按行切分并去掉空项。
 *
 * @param {string} text 原始输出。
 * @returns {string[]} 路径列表。
 */
function splitLines(text) {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

/**
 * 解析 `git diff --name-status` 的输出，只返回文件路径。
 *
 * 每行形如 `M\tpath`、`A\tpath`、`R100\told\tnew`；改名（R）取**新路径**，
 * 它才是当前存在的那个文件。
 *
 * @param {string} text 原始输出。
 * @returns {string[]} 路径列表。
 */
function statusLines(text) {
  const out = [];
  for (const line of splitLines(text)) {
    const parts = line.split('\t');
    if (parts.length >= 2) out.push(parts[parts.length - 1].trim());
  }
  return out;
}

/**
 * 判断某个路径是否要求配笔记。
 *
 * @param {string} path 仓库相对路径。
 * @returns {boolean} 是否受管。
 */
function isManaged(path) {
  if (EXEMPT_EXACT.includes(path)) return false;
  return MANAGED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * 从提交信息里找放行标记。
 *
 * @returns {string | undefined} 理由；没有标记则为 undefined。
 */
function skipReason() {
  /* 只接受两个来源：环境变量，或 commit-msg 传进来的**本次**提交信息。
     绝不回退去读 `git log -1`（上一次提交）—— 实测确认那是永久后门：
     上一条提交写过 `Note-Skip:`，紧接着毫不相干的改动就被静默放行。
     那比没有门禁更危险，因为看起来还在管。 */
  const fromEnv = process.env.NOTES_COVERAGE_SKIP;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return SKIP_MARKER.exec(pendingCommitMessage() ?? '')?.[1];
}

/**
 * 读本次正在创建的提交信息。
 *
 * 由 `commit-msg` 钩子把 `$1`（COMMIT_EDITMSG 路径）通过参数传进来。
 * `pre-commit` 阶段没有这个东西 —— 那时本次提交信息还没生成，
 * 所以 `Note-Skip` 天然要由 `commit-msg` 承担（只用一个钩子会漏）。
 *
 * @returns {string | undefined} 提交信息正文；不是从 commit-msg 调用则为 undefined。
 */
function pendingCommitMessage() {
  const flag = process.argv.indexOf('--message-file');
  const file = flag >= 0 ? process.argv[flag + 1] : undefined;
  if (typeof file !== 'string' || file === '') return undefined;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

const { files, label, reason } = collectFiles(process.argv.slice(2));

if (files === undefined) {
  console.error('✖ 无法判定本次改动是否配了笔记。');
  console.error(`  ${reason ?? '未知原因'}`);
  console.error('  这不是「已合规」—— 本次检查无效，退出码 2。');
  process.exit(2);
}

const managed = files.filter(isManaged);
const hasNote = files.some((path) => path.startsWith('.agents/notes/') && path.endsWith('.md'));

if (managed.length === 0 || hasNote) {
  if (managed.length === 0) {
    console.log(`笔记覆盖门禁通过（${label}）：改动未命中受管路径，无需笔记。`);
  } else {
    console.log(`笔记覆盖门禁通过（${label}）：命中 ${managed.length} 个受管路径，且同批带了笔记。`);
  }
  process.exit(0);
}

/* 走到这里：有受管改动但没有笔记。看有没有显式放行。
   skipReason() 内部已只认「环境变量」与「本次提交信息」，不再回退到
   上一次提交 —— 那条回退曾导致写一次 Note-Skip 就永久开门。 */
const reasonText = skipReason();

if (typeof reasonText === 'string' && reasonText.trim() !== '') {
  console.log(`笔记覆盖门禁通过（${label}）：已用 Note-Skip 放行 —— ${reasonText.trim()}`);
  process.exit(0);
}

console.error('✖ 有受管路径的改动，但本次没有带决策笔记。');
console.error('');
console.error(`  检查范围：${label}`);
for (const path of managed) console.error(`    ${path}`);
console.error('');
console.error('这些路径一改，行为/工具链/流程就变了，按规范属于「非平凡改动」。');
console.error('请在 .agents/notes/ 下补一篇（推荐用 agent-notes 技能，含 Problem /');
console.error('Decision / Alternatives considered / Consequences 四节）：');
console.error('');
console.error('  .agents/notes/{proposed|implemented|rejected|archived}/');
console.error('    {feature|bug-fix|simplification|architecture|process|testing}/yyyy-mm-dd-主题.md');
console.error('');
console.error('如果这次确实只是机械改动（错别字、纯注释、生成物），在提交信息里加一行：');
console.error('');
console.error('  Note-Skip: <一句话理由>');
console.error('');
console.error('理由必须非空 —— 写理由这个动作本身就是要你再想一遍。');
process.exit(1);
