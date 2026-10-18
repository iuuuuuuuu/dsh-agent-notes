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
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAllGates } from '../lib/notes.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

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

if (!result.passed) {
  const failed = result.results.filter((entry) => !entry.passed).length;
  console.error(
    `\n笔记门禁未通过：${failed}/${result.results.length} 条失败`
    + `（共 ${result.noteCount} 篇笔记，${result.notesRoot}）。`
  );
  process.exit(1);
}

console.log(
  `笔记门禁通过：${result.results.length} 条全部 exit=0，`
  + `共 ${result.noteCount} 篇笔记（${result.notesRoot}）。`
);
