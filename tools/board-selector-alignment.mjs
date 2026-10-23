#!/usr/bin/env node
/**
 * 看板样式补丁的选择器对齐门禁 —— CLI 外壳。
 *
 * 判据在 `lib/board-selector-audit.js`（纯函数，便于测试）；本文件只负责：
 *   1. 找到 vendored 看板页面与本仓库的补丁模块；
 *   2. 逐个模块抽出 CSS 与 `querySelector` 里的类名，跟页面里真实存在的类名对账；
 *   3. 报缺失并给非零退出码。
 *
 * 退出码：0 对齐；1 有缺失；2 读数失败或语料为空（**空集合不得当绿**）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkSelectorAlignment } from '../lib/board-selector-audit.js';

const BOARD_HTML = 'skills/agent-notes/assets/agent-notes-board.html';

/**
 * 需要对齐的补丁模块（新增模块记得加进来：`npm test` 里有一条用例盯着）。
 *
 * 不带 CSS 的模块必须写清 `noCssReason` —— 空集合不得当绿，但「这个模块本来就
 * 没有选择器依赖」是合法事实，只是必须**显式声明**，不能靠「抽不到就跳过」蒙过去。
 */
export const PATCH_MODULES = [
  { path: 'lib/board-responsive.js' },
  {
    path: 'lib/board-markdown.js',
    noCssReason: '表格样式全部内联写在注入的 HTML 上（见 lib/board-markdown.js 的 <table style=…>），没有 CSS 选择器依赖'
  }
];

/** 选择器类名总数的下限。当前实测 22 个；留 2 个余量，收窄到明显不对就红。 */
export const MIN_SELECTORS = 20;

/**
 * 从模块源码里抽出 CSS 文本：本仓库的约定是「名字里带 CSS 的模板字面量」。
 *
 * @param {string} js 模块源码。
 * @returns {string[]} 每段 CSS 的文本。
 */
export function extractCss(js) {
  return [...js.matchAll(/const\s+[A-Z_]*CSS[A-Z_]*\s*=\s*`([\s\S]*?)`;/g)].map((m) => m[1]);
}

/**
 * 跑一次对账。
 *
 * @param {string} root 仓库根。
 * @returns {{ok: boolean, results: object[], problems: string[]}} 结果。
 */
export function verifyBoardSelectors(root = process.cwd()) {
  const problems = [];
  let html;
  try {
    html = readFileSync(join(root, BOARD_HTML), 'utf8');
  } catch (error) {
    return { ok: false, results: [], problems: [`读不到 vendored 看板页面 ${BOARD_HTML}：${error.message}`] };
  }
  const results = [];
  for (const entry of PATCH_MODULES) {
    const rel = entry.path;
    let js;
    try {
      js = readFileSync(join(root, rel), 'utf8');
    } catch (error) {
      problems.push(`读不到补丁模块 ${rel}：${error.message}`);
      continue;
    }
    const css = extractCss(js).join('\n');
    const result = checkSelectorAlignment({ css, js, html });
    results.push(result);
    if (result.checked === 0) {
      if (typeof entry.noCssReason === 'string' && entry.noCssReason.trim() !== '') continue;
      problems.push(`${rel}：没有抽到任何选择器类名，也没有声明 noCssReason（空集合不得当绿）`);
      continue;
    }
    for (const item of result.missing) {
      problems.push(`${rel}：选择器 .${item.cls}（${item.where}）在 vendored 看板页面里不存在 —— 上游改名了，这条样式已静默失效`);
    }
  }
  /* 语料下限：一个模块都没读到等于什么都没验。 */
  if (results.length === 0 && problems.length === 0) problems.push('没有校验任何补丁模块（空集合不得当绿）');
  const total = results.reduce((sum, item) => sum + item.checked, 0);
  if (total < MIN_SELECTORS && problems.length === 0) {
    problems.push(`只对账了 ${total} 个选择器类名（下限 ${MIN_SELECTORS}）—— 抽取口径或补丁模块清单被悄悄收窄了`);
  }
  return { ok: problems.length === 0, results, problems, total };
}

function main() {
  const { ok, results, problems, total: counted } = verifyBoardSelectors();
  if (!ok) {
    for (const line of problems) console.error(`✖ ${line}`);
    process.exit(1);
  }
  console.log(`看板选择器对齐通过：${results.length} 个补丁模块、${counted} 个选择器类名都在 vendored 页面里存在。`);
}

const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replace(/\\/g, '/').endsWith('/tools/board-selector-alignment.mjs');
if (invokedDirectly) main();
