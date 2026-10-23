/**
 * 选择器对齐门禁的用例。
 *
 * 判别力来自「**上游改名**」这一条：它是这道门禁存在的唯一理由，也是最容易
 * 写成恒绿的地方。所以有一条用例专门把 vendored 页面里真实存在的 `kpi-row`
 * 改名，断言门禁红且点名了这个类 —— 如果哪天抽取口径退化到抓不到选择器，
 * 这条会跟着红（空集合另有专门用例）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSelectorAlignment } from '../lib/board-selector-audit.js';
import { verifyBoardSelectors, extractCss, PATCH_MODULES, MIN_SELECTORS } from './board-selector-alignment.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML_REL = 'skills/agent-notes/assets/agent-notes-board.html';

/**
 * 造一份「仓库副本」：复制 vendored 页面与补丁模块，返回根目录。
 * @returns {string} 临时根目录。
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'board-selector-'));
  for (const rel of [HTML_REL, ...PATCH_MODULES.map((item) => item.path)]) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(root, rel));
  }
  return root;
}

test('board-selector: 当前仓库的选择器全部落在 vendored 页面上', () => {
  const result = verifyBoardSelectors(ROOT);
  assert.equal(result.ok, true, result.problems.join('\n'));
  assert.ok(result.total >= MIN_SELECTORS, `只对账了 ${result.total} 个类名`);
});

test('board-selector: querySelector 的上游独占类名·改名必须红（kpi-num 是自建，不能拿它当例子）', () => {
  const root = fixture();
  try {
    /* 现状：模块里唯一的 querySelector 指向 `.kpi-num`，而那段卡片是**本模块自己**
       注入的（`'<div class="kpi-num">'`），所以它不算上游依赖。这里给副本模块
       追加一个真正指向上游结构的 querySelector，再让上游失去那个类。 */
    const moduleFile = join(root, 'lib/board-responsive.js');
    writeFileSync(
      moduleFile,
      `${readFileSync(moduleFile, 'utf8')}\nexport const probe = () => document.querySelector('.deck-tabs');\n`,
      'utf8'
    );
    const htmlFile = join(root, HTML_REL);
    writeFileSync(htmlFile, readFileSync(htmlFile, 'utf8').replaceAll('deck-tabs', 'deck-tabbar'), 'utf8');
    const result = verifyBoardSelectors(root);
    assert.equal(result.ok, false, 'querySelector 的类名没被对账 —— 这一半失效了');
    assert.ok(
      result.problems.some((line) => line.includes('.deck-tabs') && line.includes('querySelector')),
      result.problems.join('\n')
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('board-selector: querySelector 指向不存在的类名会被点名（含出处）', () => {
  const result = checkSelectorAlignment({
    css: '.card { color: red; }',
    js: "el.querySelector('.ghost-cell');",
    html: '<div class="card"></div>'
  });
  assert.deepEqual(result.missing.map((item) => item.cls), ['ghost-cell']);
  assert.match(result.missing[0].where, /querySelector\('\.ghost-cell'\)/);
});

test('board-selector: 上游把 kpi-row 改名后必须变红（这是它存在的唯一理由）', () => {
  const root = fixture();
  try {
    const file = join(root, HTML_REL);
    const html = readFileSync(file, 'utf8');
    writeFileSync(file, html.replaceAll('kpi-row', 'kpi-rows'), 'utf8');
    const result = verifyBoardSelectors(root);
    assert.equal(result.ok, false, '上游改名后门禁竟然仍绿 —— 这条样式已静默失效却没人知道');
    assert.ok(
      result.problems.some((line) => line.includes('.kpi-row') && line.includes('上游改名')),
      result.problems.join('\n')
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('board-selector: 上游把 deck-tabs 改名同样必须变红', () => {
  const root = fixture();
  try {
    const file = join(root, HTML_REL);
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('deck-tabs', 'deck-tabbar'), 'utf8');
    const result = verifyBoardSelectors(root);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((line) => line.includes('.deck-tabs')), result.problems.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('board-selector: 读不到 vendored 页面必须判失败，不许当成「没有选择器要对账」', () => {
  const root = fixture();
  try {
    rmSync(join(root, HTML_REL));
    const result = verifyBoardSelectors(root);
    assert.equal(result.ok, false);
    assert.ok(result.problems[0].includes(HTML_REL), result.problems.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('board-selector: 抽取口径被收窄到抓不到选择器时必须红（空集合不得当绿）', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'lib/board-responsive.js'), 'export const RESPONSIVE_CSS = `body { color: red; }`;\n', 'utf8');
    const result = verifyBoardSelectors(root);
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((line) => line.includes('只对账了') || line.includes('没有抽到')),
      result.problems.join('\n')
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('board-selector: 没有 CSS 的模块必须显式声明理由，否则红', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'lib/board-markdown.js'), "export const X = 1;\n", 'utf8');
    /* 已有的 noCssReason 让这条模块合法通过，所以这里改的是「本来该有 CSS 的模块」 */
    writeFileSync(join(root, 'lib/board-responsive.js'), 'export const Y = 1;\n', 'utf8');
    const result = verifyBoardSelectors(root);
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((line) => line.includes('board-responsive.js') && line.includes('没有抽到')),
      result.problems.join('\n')
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('board-selector: 只对账到极少数类名时必须红（下限不是摆设，且不跟着常量自证）', () => {
  const root = fixture();
  try {
    /* 这个类名**确实存在**于 vendored 页面，所以缺失去向为空；唯一能拦住它的
       就是「总数下限」。把常量改成 0 时这条会红 —— 上面那条把它当真理就等于自证。 */
    writeFileSync(
      join(root, 'lib/board-responsive.js'),
      'export const RESPONSIVE_CSS = `.kpi-row { color: red; }`;\n',
      'utf8'
    );
    const result = verifyBoardSelectors(root);
    assert.equal(result.ok, false, '只对账了 1 个类名竟然放行 —— 语料下限失效');
    assert.ok(result.problems.some((line) => line.includes('只对账了')), result.problems.join('\n'));
    assert.ok(MIN_SELECTORS >= 20, `下限被调到 ${MIN_SELECTORS}，已经挡不住收窄`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('board-selector: 补丁模块清单里的文件必须真实存在（防止清单漂移）', () => {
  for (const entry of PATCH_MODULES) {
    assert.doesNotThrow(() => readFileSync(join(ROOT, entry.path), 'utf8'), `清单里的 ${entry.path} 不存在`);
  }
  assert.ok(PATCH_MODULES.some((item) => item.path === 'lib/board-responsive.js'));
});

test('board-selector: 自己创建的类名不算缺失（kpi-row-5 来自本仓库的 className 追加）', () => {
  const css = '.kpi-row.kpi-row-5 { grid-template-columns: repeat(5, minmax(0, 1fr)); }';
  const js = "row.className += (row.className.indexOf('kpi-row-5') === -1 ? ' kpi-row-5' : '');";
  const html = '<div class="kpi-row"></div>';
  const result = checkSelectorAlignment({ css, js, html });
  assert.deepEqual(result.missing, []);
  assert.ok(result.selfCreated.includes('kpi-row-5'));
});

test('board-selector: 注入片段里写死的 class 也算自建（md-table）', () => {
  const css = '.md-table { border-collapse: collapse; }';
  const js = "return '<table class=\"md-table\">' + body + '</table>';";
  const result = checkSelectorAlignment({ css, js, html: '<div class="x"></div>' });
  assert.deepEqual(result.missing, []);
  assert.ok(result.selfCreated.includes('md-table'));
});

test('board-selector: 数字开头不算类名（0.18s 这种时长不许进必需集合）', () => {
  const css = '.card { transition: opacity 0.18s ease; }';
  const html = '<div class="card"></div>';
  const result = checkSelectorAlignment({ css, js: '', html });
  assert.equal(result.checked, 1);
  assert.deepEqual(result.missing, []);
});

test('board-selector: CLI 在真实仓库上退出码为 0', () => {
  const run = spawnSync(process.execPath, [join(ROOT, 'tools/board-selector-alignment.mjs')], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /看板选择器对齐通过：2 个补丁模块、/);
});

test('board-selector: extractCss 只认名字里带 CSS 的模板字面量', () => {
  const js = 'const A_CSS = `.x { color: red; }`;\nconst OTHER = `.y { color: red; }`;\n';
  assert.deepEqual(extractCss(js), ['.x { color: red; }']);
});
