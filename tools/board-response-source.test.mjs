/**
 * `lib/board-responsive.js` 的**源码级**体检 —— 不 import 那个模块。
 *
 * ## 为什么单独一个文件
 *
 * 这个模块把大段 JS 与 CSS 存在**模板字面量**里。注释里手写一个反引号
 * （比如为了解释 `Core.stFilter` 而写 `` `Core.stFilter` ``）会提前终止模板，
 * 整个文件变成语法错误。这个事故在 2026-10-21 真的发生了两次。
 *
 * 第一版把它写成 `tools/board-responsive.test.mjs` 里的一条断言：
 * `doesNotMatch(ARCHIVED_CARD_JS, /`/)`。它**永远不会执行** —— 真出反引号时
 * 那行 `import` 就先 SyntaxError，`node --test` 报的是
 * `tests 1 / fail 1`（文件加载失败），那条断言连注册都到不了。
 * 复审 r2 的 G-2 指出这点时，现场正是一次真实事故，它确实没抓到。
 *
 * 所以这里的分工是：**只用 `readFileSync` 读源码，不 import**。
 * 语法炸掉时本文件照样能跑，并直接指出「哪个常量在第几行被提前结束」。
 * 模块能正常加载时，`tools/board-responsive.test.mjs` 才接手验行为。
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const SOURCE_PATH = join(import.meta.dirname, '..', 'lib', 'board-responsive.js');
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

/** 行号（1 起），用于把偏移翻译成人能找的位置。 */
const lineOf = (at) => SOURCE.slice(0, at).split('\n').length;

/**
 * 取出 `export const NAME = \`...\`` 的正文（两个反引号之间）。
 *
 * 不解析 JS，只做「找到声明 → 找开引号 → 找下一个反引号」。这正是缺陷
 * 形态本身：正文里多一个反引号，扫描就会在那里提前收尾 —— 于是下面
 * 「正文必须以某段结尾」的断言失败，并报出提前收尾的行号。
 */
function templateBody(name) {
  const decl = `export const ${name} = `;
  const at = SOURCE.indexOf(decl);
  assert.notEqual(at, -1, `找不到 ${name} 的声明（改名了？）`);
  const open = SOURCE.indexOf('`', at + decl.length);
  assert.notEqual(open, -1, `${name} 的声明后面没有模板开引号`);
  const close = SOURCE.indexOf('`', open + 1);
  assert.notEqual(close, -1, `${name} 的模板没有收尾反引号`);
  return { body: SOURCE.slice(open + 1, close), open, close };
}

/**
 * 三个模板常量各自「结尾处」必须出现的一段原文。
 *
 * 选它们是因为都在正文最后几行、且不会出现在正文别处：
 * 一旦模板被裸反引号提前截断，这段就落不进来。
 */
const TAILS = {
  RESPONSIVE_CSS: '.kpi-row.kpi-row-5 { grid-template-columns: minmax(0, 1fr); }',
  ARCHIVED_CARD_JS: '}, 5000);\n})();',
  DRAWER_PATCH_JS: "window.addEventListener('focus', poll);\n})();"
};

for (const [name, tail] of Object.entries(TAILS)) {
  test(`board-responsive 源码：${name} 的模板没有被裸反引号提前截断`, () => {
    const { body, close } = templateBody(name);
    if (body.includes('`')) {
      /* 走到这里说明扫描在正文内部就收尾了。 */
      assert.fail(`${name} 的模板在第 ${lineOf(close)} 行被一个裸反引号提前结束`
        + '（模板字面量里的反引号要写成「」或去掉引号，否则整个模块 SyntaxError）');
    }
    assert.ok(body.includes(tail),
      `${name} 的模板正文不以预期片段结尾 —— 要么被截断了，要么结尾改过了。`
      + `第 ${lineOf(close)} 行收尾，缺的片段是：${JSON.stringify(tail)}`);
  });
}

test('board-responsive 源码：模板正文不是空壳', () => {
  /* 防止「扫描恰好停在开引号后面」这种退化：body 为空时上面那条的 tail
     断言已经会红，这里再钉一个下限，让失败信息更直白。 */
  for (const name of Object.keys(TAILS)) {
    const { body } = templateBody(name);
    assert.ok(body.length > 500, `${name} 的正文只有 ${body.length} 字符，明显不对`);
  }
});
