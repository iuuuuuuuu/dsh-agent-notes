#!/usr/bin/env node
/**
 * 看板样式补丁的选择器对齐门禁 —— CLI 外壳。
 *
 * 判据（必需集合、存在集合、自建集合、语料下限、模块清单）全部在
 * `lib/board-selector-audit.js` 里，这里只做三件事：读文件、打印结论、给退出码。
 * 这是本仓库的既有分工（见 `lib/notes.js` 与 `tools/*` 的关系）：判定逻辑的唯一
 * 真源在 `lib/`，`tools/` 下不许再写一份。
 *
 * 退出码：0 对齐；1 有缺失或读数失败（**空集合与读不到文件都不许当绿**）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD_PATCH_MODULES, judgeBoardSelectors } from '../lib/board-selector-audit.js';

const BOARD_HTML = 'skills/agent-notes/assets/agent-notes-board.html';

/**
 * 读盘后交给判据。
 *
 * @param {string} root 仓库根。
 * @returns {{ok: boolean, results: object[], problems: string[], total: number}} 结论。
 */
export function verifyBoardSelectors(root = process.cwd()) {
  let html;
  try {
    html = readFileSync(join(root, BOARD_HTML), 'utf8');
  } catch (error) {
    return { ok: false, results: [], problems: [`读不到 vendored 看板页面 ${BOARD_HTML}：${error.message}`], total: 0 };
  }
  const problems = [];
  const modules = [];
  for (const entry of BOARD_PATCH_MODULES) {
    try {
      modules.push({ rel: entry.path, js: readFileSync(join(root, entry.path), 'utf8') });
    } catch (error) {
      problems.push(`读不到补丁模块 ${entry.path}：${error.message}`);
    }
  }
  const judged = judgeBoardSelectors({ html, modules });
  return { ...judged, problems: [...problems, ...judged.problems], ok: problems.length === 0 && judged.ok };
}

function main() {
  const { ok, results, problems, total } = verifyBoardSelectors();
  if (!ok) {
    for (const line of problems) console.error(`✖ ${line}`);
    process.exit(1);
  }
  console.log(`看板选择器对齐通过：${results.length} 个补丁模块、${total} 个选择器类名都在 vendored 页面里存在。`);
}

const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replace(/\\/g, '/').endsWith('/tools/board-selector-alignment.mjs');
if (invokedDirectly) main();
