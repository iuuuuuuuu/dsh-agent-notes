#!/usr/bin/env node
/**
 * 本仓库自己的决策笔记门禁（.agents/notes）。
 *
 * 为什么不把三条 vendored 脚本直接写进 npm script / CI：
 * 它们在**空集合**上会 exit 0 并打印 `ok: 0 note(s) verified`。
 * 从「脚本没说错」看是真的，从「本仓库的笔记合规」看是**空的** ——
 * `.agents/notes` 不存在时 CI 依然会绿。那正是 Owner 明令禁止的假绿。
 * 插件侧为此已实测踩坑并前置拦下（`NO_NOTES_TREE` / `NO_NOTES_YET`），
 * 命令行与 CI 侧不能比工具侧更松。
 *
 * 因此本脚本不自己判断结构，直接复用 `lib/notes.js` 的 `runAllGates`：
 * 那里是「没有可验对象不算通过」的唯一真源，且有 tools/no-fake-green.test.mjs
 * 逐条钉住（空树、有树零篇、有笔记违规必须变红，合规必须真绿）。
 * 在这里另写一份判定会立刻产生第二份真相 —— 两份迟早漂移，
 * 而漂移的表现正是「一种入口拦住了、另一种没拦住」。
 *
 * 本脚本只做 CLI 外壳：解析笔记根 → 调 runAllGates → 把结果映射成退出码
 * 与可读诊断。**以进程退出码为准**：脚本缺失、超时、非零一律算失败。
 *
 * 用法：
 *   node tools/verify-notes.mjs
 * 环境变量：
 *   AGENT_NOTE_ROOT  覆盖笔记根（与 vendored 脚本同一变量，供故障注入用）。
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 加载 `runAllGates`。
 *
 * ## 为什么用动态 import 而不是静态的
 *
 * 静态 `import ... from '../lib/notes.js'` 在脚本被拷到别的仓库时会直接
 * `ERR_MODULE_NOT_FOUND` —— 而 README 明确承诺「直接复用本仓库的
 * `tools/verify-notes.mjs`」。实测四种独立用法里有两种死在这一点上。
 *
 * ## 为什么不内联复制 runAllGates
 *
 * `lib/notes.js` 是「没有可验对象不算通过」的唯一真源（见本文件顶部注释）。
 * 复制一份会立刻产生第二份真相，而漂移的表现正是「一种入口拦住了、
 * 另一种没拦住」—— 正是本脚本存在要防的那类假绿。
 *
 * ## 找不到时为什么不降级
 *
 * 降级意味着少跑那几条「空集合判失败」的检查，而那正是本脚本的**唯一**
 * 理由。所以明确报错，并告诉用户该拷哪些文件。
 *
 * @returns {Promise<Function>} `runAllGates`。
 * @throws {Error} 找不到实现时抛出，消息里列出该拷什么。
 */
async function loadGateRunner() {
  const candidates = [
    { path: resolve(HERE, '..', 'lib', 'notes.js'), label: '包内 lib/notes.js' },
    ...(typeof process.env.DSH_AGENT_NOTES_LIB === 'string'
      && process.env.DSH_AGENT_NOTES_LIB.trim() !== ''
      ? [{ path: resolve(process.env.DSH_AGENT_NOTES_LIB.trim()), label: '$DSH_AGENT_NOTES_LIB' }]
      : [])
  ];

  const failures = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    let module;
    try {
      module = await import(pathToFileURL(candidate.path).href);
    } catch (error) {
      /* `lib/notes.js` 会 import 同目录的兄弟模块（如 `archive-layout.js`），
         只拷一个文件就会在这里炸成裸的 ERR_MODULE_NOT_FOUND ——
         用户看到的是 Node 的模块解析错误，不是「你少拷了哪些文件」。
         记下来，最后一起报出去。 */
      failures.push(
        `${candidate.label}（${candidate.path}）加载失败：`
        + `${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    if (typeof module.runAllGates === 'function') return module.runAllGates;
  }

  throw new Error(
    [
      '找不到笔记门禁实现（runAllGates）。',
      '  本脚本只做 CLI 外壳，判定逻辑在 lib/notes.js —— 它是「空集合不算通过」',
      '  的唯一真源，复制一份会立刻产生第二份真相。',
      ...(failures.length > 0 ? ['', '  尝试过的候选：', ...failures.map((line) => `    - ${line}`)] : []),
      '',
      '  在别的仓库里用时请把实现一起带过去（**整个 lib 目录**，',
      '  lib/notes.js 会 import 同目录的兄弟模块，只拷一个文件跑不起来）：',
      '    cp -r dsh-agent-notes/lib  <目标仓库>/',
      '    cp -r dsh-agent-notes/skills <目标仓库>/',
      '  或用 $DSH_AGENT_NOTES_LIB 指向 lib/notes.js 的绝对路径。',
      '  门禁脚本本身则放在 <目标仓库>/.agents/skills/<技能名>/scripts/，',
      '  或用 $AGENT_NOTE_SCRIPTS_DIR 显式指定。'
    ].join('\n')
  );
}

const runAllGates = await loadGateRunner().catch((error) => {
  /* 加载失败是「无法进行」，不是「检查失败」。两者退出码必须区分 ——
     上游用 2 表示前者，沿用它，免得调用方把环境问题当成门禁红了。 */
  console.error(`✖ ${error.message}`);
  process.exit(2);
});

/**
 * 挑一个「要验哪个仓库」的根。
 *
 * ## 为什么不能写死 PACKAGE_ROOT
 *
 * 本脚本要能在**任何仓库**里用 —— 那是「脱离 DSH 也能用」的前提。
 * 实测踩过：脚本被拷到另一个目录后运行，它仍然报告原仓库的 16 篇笔记
 * （`PACKAGE_ROOT` 永远指向脚本自己所在目录）。于是「在别的仓库里跑」
 * 这件事**静默地没发生**，而输出看起来完全正常 ——
 * 这是最难发现的一类错：不是报错，是验错了对象。
 *
 * ## 为什么不在找不到笔记树时回退到 PACKAGE_ROOT
 *
 * 第一版这样做，结果在「cwd 是另一个仓库但没有 .agents/notes」时
 * 静默去验了本插件自己的笔记树 —— 报「通过，16 篇」，而那些笔记
 * 跟当前仓库毫无关系。**回退到别处比报错更危险。**
 *
 * 现在的规则：cwd 是 git 仓库根就必须验它（没有笔记树 → 由 runAllGates
 * 报 NO_NOTES_TREE）；只有 cwd 完全不是仓库时，才验脚本所在的包。
 *
 * ## 2026-10-24：把「git 失败」与「不是仓库」分开
 *
 * 上面那条规则原先用 `gitRoot.status === 0` 做判据，于是 `status === null`
 * （git 不可用/ENOENT/被信号杀）与「真的不是仓库」被**混为一谈**，一律落到
 * `return PACKAGE_ROOT`。实测：在一个**别的**仓库里（该仓库的笔记违规）把
 * PATH 里的 git 去掉 ⇒ 输出「笔记门禁通过…… 共 116 篇笔记
 * （<本插件的路径>）」∈ **exit 0**，那篇违规笔记从未被读过。
 * 这不是报错，是**换了对象还报了绿** —— 本文件自己上面刚写过「回退到别处比报错更危险」。
 *
 * 口径照 `tools/eol.mjs` 的既有做法：**只有 git 明确说「不是 git 仓库」**
 * 才允许回退（那是夹具/导出目录的唯一合法信号）；其余失败一律 exit 2，
 * 并说清「本次没有完成校验」。没有任何开关可以关掉这条。
 *
 * @returns {string} 仓库根绝对路径。
 */
function repoRoot() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--root');
  if (idx >= 0) {
    const value = args[idx + 1];
    if (typeof value !== 'string' || value.trim() === '') {
      console.error('✖ --root 需要一个路径。');
      process.exit(2);
    }
    return resolve(value.trim());
  }

  const cwd = process.cwd();
  /* cwd 是 git 仓库根 → 就是它。哪怕它没有笔记树（那该报 NO_NOTES_TREE，
     而不是偷偷去验别处）。 */
  const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd, encoding: 'utf8', windowsHide: true
  });
  if (gitRoot.status === 0) {
    const top = String(gitRoot.stdout ?? '').trim();
    if (top !== '') return top;
  }

  /* `status === 0` 但 stdout 为空也算异常：正常仓库根不会这样。
     成功路径只接受「拿到了一个非空路径」。 */
  const detail = `${gitRoot.stderr ?? ''}${gitRoot.error?.message ?? ''}`.trim();
  const notARepo = /not a git repository/i.test(detail);
  if (gitRoot.status === 0 || !notARepo) {
    console.error('✖ 无法判断当前目录属于哪个仓库，本次没有完成校验。');
    console.error(`  原始报错：${detail === '' ? `git 退出码 ${String(gitRoot.status)}（无输出）` : detail}`);
    console.error('  退出码 2 = 无法进行；这不是「笔记违规」，也不等于通过。');
    console.error('  若确实要验本插件自己的笔记，请显式传 --root <路径>。');
    process.exit(2);
  }
  /* git 说「这里不是仓库」—— 夹具/导出目录的合法形态，验脚本所在的包。 */
  return PACKAGE_ROOT;
}

/**
 * 解析笔记根。
 *
 * 与 `lib/notes.js` 的 `resolveNotesRoot` 同一优先级：显式 > `$AGENT_NOTE_ROOT`
 * > `<root>/.agents/notes`。
 *
 * @param {string} root 仓库根。
 * @returns {string} 笔记根绝对路径。
 */
function notesRoot(root) {
  const env = process.env.AGENT_NOTE_ROOT;
  if (typeof env === 'string' && env.trim() !== '') return resolve(env.trim());
  return resolve(root, '.agents', 'notes');
}

const root = repoRoot();
const result = await runAllGates({ cwd: root, notesRoot: notesRoot(root) });

for (const entry of result.results) {
  if (entry.passed) {
    const tail = `${entry.stdout ?? ''}${entry.stderr ?? ''}`.trim().split('\n').pop();
    console.log(`  ✔ ${entry.gate} — exit=${entry.exitCode}${tail ? ` (${tail})` : ''}`);
    continue;
  }
  console.error(`  ✖ ${entry.gate} — exit=${entry.exitCode ?? 'null'}`);
  if (entry.reason) console.error(`    ${entry.reason}`);
  for (const line of `${entry.stdout ?? ''}${entry.stderr ?? ''}`.trim().split('\n')) {
    if (line !== '') console.error(`    ${line}`);
  }
}

/* 未计入独立笔记的 Markdown 包括散落件、说明文件和活动翻译旁挂。
   不能把它们全部描述为目录之外，也不能声称它们不受布局检查。
   这里解释磁盘 Markdown 数与独立笔记数的差额。 */
const strayLine = result.strayCount > 0
  ? `\n另有 ${result.strayCount} 个 .md 散落件、说明文件或翻译旁挂：它们不计入独立笔记数。`
  : '';

if (!result.passed) {
  const failed = result.results.filter((entry) => !entry.passed).length;
  console.error(
    `\n笔记门禁未通过：${failed}/${result.results.length} 条失败`
    + `（共 ${result.noteCount} 篇笔记，${result.notesRoot}）。${strayLine}`
  );
  process.exit(1);
}

console.log(
  `笔记门禁通过：${result.results.length} 条全部 exit=0，`
  + `共 ${result.noteCount} 篇笔记（${result.notesRoot}）。${strayLine}`
);
