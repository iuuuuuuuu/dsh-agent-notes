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
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAllGates } from '../lib/notes.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 解析笔记根。
 *
 * 与 `lib/notes.js` 的 `resolveNotesRoot` 同一优先级：显式 > `$AGENT_NOTE_ROOT`
 * > `<cwd>/.agents/notes`。此处 cwd 钉在仓库根，确保从任意子目录调用都验同一棵树。
 *
 * @returns {string} 笔记根绝对路径。
 */
function notesRoot() {
  const env = process.env.AGENT_NOTE_ROOT;
  if (typeof env === 'string' && env.trim() !== '') return resolve(env.trim());
  return resolve(PACKAGE_ROOT, '.agents', 'notes');
}

const root = notesRoot();
const result = await runAllGates({ cwd: PACKAGE_ROOT, notesRoot: root });

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
