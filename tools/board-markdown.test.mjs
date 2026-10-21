/**
 * `lib/board-markdown.js` 的回归：把上游真实的 `parseMarkdown` 抽出来跑。
 *
 * ## 为什么从 vendored HTML 里抽函数，而不是在测试里复制一份
 *
 * 补丁的价值全在「接管上游那个函数」这件事上。若测试自己写一个替身
 * `parseMarkdown`，那测的是替身，不是真实渲染路径 —— 上游一旦改名、
 * 改成 module、或改了行内规则，测试仍然全绿而页面继续坏。
 *
 * 所以这里用 `vm` 把 `skills/agent-notes/assets/agent-notes-board.html` 里的
 * **真函数**装进沙箱，再注入补丁源码，断言补丁挂上去之后的行为。
 * 上游改名 → 抽取失败 → 用例直接红，这正是想要的。
 *
 * 上限（写清楚，避免过度声称）：这些用例证明「补丁对真实上游函数有效」，
 * 不证明「页面上肉眼看到表格」。后者要真机看（人工复核项）。
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  MARKDOWN_TABLE_JS,
  MARKDOWN_TABLE_PATCH_ID,
  injectMarkdownTables
} from '../lib/board-markdown.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BOARD_ASSET = join(ROOT, 'skills', 'agent-notes', 'assets', 'agent-notes-board.html');

/**
 * 从 vendored 看板里抽出上游渲染所需的源码。
 *
 * 连 `escapeHtml` 一起抽：`parseMarkdown` 渲染链接时会调它（实测抽漏了这条，
 * 用例报 `escapeHtml is not defined`）。两者都是顶层函数声明，与浏览器里
 * 的可见性一致。
 */
function upstreamParseMarkdownSource() {
  const html = readFileSync(BOARD_ASSET, 'utf8');
  const start = html.indexOf('function escapeHtml(str)');
  assert.notEqual(start, -1, '上游看板里找不到 escapeHtml —— 改名了？');
  const markdown = html.indexOf('function parseMarkdown(text)', start);
  assert.notEqual(markdown, -1, '上游看板里找不到 parseMarkdown —— 改名了？补丁需要跟着改');
  const end = html.indexOf('function parseNote(', markdown);
  assert.notEqual(end, -1, '找不到 parseMarkdown 的结束边界（下一个函数声明）');
  return html.slice(start, end);
}

/**
 * 造一个装好上游渲染器（可选再装补丁）的沙箱。
 *
 * @param {{ patched?: boolean }} [options] patched=false 时只装上游，作为对照。
 * @returns {any} 带 window 的沙箱上下文。
 */
function makeSandbox(options = {}) {
  const { patched = true } = options;
  const context = { window: {} };
  vm.createContext(context);
  /* 上游是经典脚本：把函数声明提升成 window 上的可写属性，与浏览器一致。 */
  vm.runInContext(
    `${upstreamParseMarkdownSource()}\nwindow.parseMarkdown = parseMarkdown;`,
    context
  );
  if (patched) vm.runInContext(MARKDOWN_TABLE_JS, context);
  return context;
}

const TABLE = [
  '| 场景 | is_decode | 说明 |',
  '|---|---|---|',
  '| A 读 body 超时 | true | operation timed out |',
  '| B 连接中断 | true | error reading a body |'
].join('\n');

test('board-markdown: 管道表格渲染成真 <table>，不再是带竖线的一段文字', () => {
  const bare = makeSandbox({ patched: false });
  const before = bare.window.parseMarkdown(TABLE);
  assert.doesNotMatch(before, /<table/, '前提：上游本来没有表格支持（否则这条补丁没意义）');
  assert.match(before, /\|/, '前提：上游把竖线原样留在正文里');

  const patched = makeSandbox();
  const after = patched.window.parseMarkdown(TABLE);
  assert.match(after, /<table class="md-table"/, '必须渲染出 table 元素');
  assert.match(after, /<thead><tr>/, '表头必须在 thead 里');
  assert.match(after, /<td style="[^"]*">A 读 body 超时<\/td>/, '第一列内容要进 td');
  assert.match(after, /<td style="[^"]*">operation timed out<\/td>/, '第三列内容要进 td');
  assert.equal((after.match(/<tr>/g) ?? []).length, 3, '1 行表头 + 2 行数据');
  assert.doesNotMatch(after, /\|-{3,}/, '分隔行不能被当成正文吐出来');
});

test('board-markdown: 对齐冒号变成 text-align', () => {
  const md = ['| 左 | 中 | 右 |', '|:--|:-:|--:|', '| a | b | c |'].join('\n');
  const html = makeSandbox().window.parseMarkdown(md);
  assert.match(html, /text-align:left;/, '左对齐');
  assert.match(html, /text-align:center;/, '居中');
  assert.match(html, /text-align:right;/, '右对齐');
});

test('board-markdown: 转义竖线 \\| 留在同一单元格内', () => {
  const md = ['| 表达式 | 结果 |', '|---|---|', '| a \\| b | 并集 |'].join('\n');
  const html = makeSandbox().window.parseMarkdown(md);
  assert.match(html, /<td style="[^"]*">a \| b<\/td>/, '转义竖线必须还原成字面量并留在本格');
  assert.equal((html.match(/<td /g) ?? []).length, 2, '只有两列 —— 转义竖线没有切开单元格');
});

test('board-markdown: 围栏代码块里的竖线不算表格', () => {
  const md = ['```', '| a | b |', '|---|---|', '| 1 | 2 |', '```'].join('\n');
  const html = makeSandbox().window.parseMarkdown(md);
  assert.match(html, /<pre><code>/, '代码块仍由上游渲染');
  assert.doesNotMatch(html, /<table/, '代码里的管道不是表格');
});

test('board-markdown: 非表格文本的渲染结果与上游逐字相同', () => {
  const md = [
    '## 小节',
    '',
    '一段带 `code` 与 **粗体** 的文字，还有 [链接](./other.md)。',
    '',
    '- 第一条',
    '- 第二条'
  ].join('\n');
  const bare = makeSandbox({ patched: false }).window.parseMarkdown(md);
  const patched = makeSandbox().window.parseMarkdown(md);
  assert.equal(patched, bare, '补丁不得改变任何非表格文本的渲染结果');
  assert.match(patched, /md-deep-link/, '上游的深链接类必须保留（说明走的是上游规则）');
});

test('board-markdown: 表格与正文混排时，正文段落仍走上游', () => {
  const md = ['前面一段。', '', TABLE, '', '后面一段。'].join('\n');
  const html = makeSandbox().window.parseMarkdown(md);
  assert.match(html, /<p style="margin-bottom:10px;">前面一段。<\/p>/, '表格前的正文保留');
  assert.match(html, /<p style="margin-bottom:10px;">后面一段。<\/p>/, '表格后的正文保留');
  assert.match(html, /<table/, '中间是表格');
});

test('board-markdown: 单元格内的行内标记用上游规则渲染', () => {
  const md = ['| 项 | 说明 |', '|---|---|', '| `x` | **重要** |'].join('\n');
  const html = makeSandbox().window.parseMarkdown(md);
  assert.match(html, /<code>x<\/code>/, '行内 code 由上游渲染');
  assert.match(html, /<b>重要<\/b>/, '粗体由上游渲染');
});

test('board-markdown: 列数不齐时按表头截断，不抛错', () => {
  const md = ['| a | b |', '|---|---|', '| 1 |', '| 1 | 2 | 3 |'].join('\n');
  const html = makeSandbox().window.parseMarkdown(md);
  assert.equal((html.match(/<td /g) ?? []).length, 4, '两行各两列');
});

test('board-markdown: 上游没有 parseMarkdown 时安静退出，不抛错', () => {
  const context = { window: {} };
  vm.createContext(context);
  assert.doesNotThrow(() => vm.runInContext(MARKDOWN_TABLE_JS, context), '不得抛错');
  assert.equal(context.window.parseMarkdown, undefined, '不得凭空造一个渲染器');
  assert.notEqual(context.window.__agentNotesMarkdownTables, true, '不得标记成已装');
});

test('board-markdown: 重复注入只留一个脚本块', () => {
  const page = '<html><body><div></div></body></html>';
  const once = injectMarkdownTables(page);
  const twice = injectMarkdownTables(once);
  assert.equal(once, twice, '第二次注入必须是 no-op');
  assert.equal((twice.match(new RegExp(`id="${MARKDOWN_TABLE_PATCH_ID}"`, 'g')) ?? []).length, 1);
  assert.ok(twice.indexOf(MARKDOWN_TABLE_PATCH_ID) < twice.indexOf('</body>'), '必须插在 body 尾部');
});

test('board-markdown: 正文提到补丁 id 不会被误判成已注入', () => {
  /* 实测踩过的同类坑（board-responsive 的注释里记着）：笔记正文会原样引用
     看板源码里的 id 字符串，只找裸 id 会让注入被静默跳过。 */
  const page = `<html><body><p>这篇笔记提到 ${MARKDOWN_TABLE_PATCH_ID}</p></body></html>`;
  const out = injectMarkdownTables(page);
  assert.notEqual(out, page, '提到 id 不等于已经注入');
  assert.match(out, new RegExp(`<script id="${MARKDOWN_TABLE_PATCH_ID}">`));
});

test('board-markdown: 没有 </body> 的页面原样返回', () => {
  const page = '<html><head></head></html>';
  assert.equal(injectMarkdownTables(page), page);
});

test('board-markdown: 看板路由真的接上了这道注入', () => {
  const source = readFileSync(join(ROOT, 'lib', 'board-route.js'), 'utf8');
  assert.match(source, /injectMarkdownTables\(injectResponsiveCss\(withData\)\)/,
    'board-route 必须把表格补丁接在响应式注入之外 —— 只写导出不接线等于没有');
});
