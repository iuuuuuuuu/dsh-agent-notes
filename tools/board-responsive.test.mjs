/**
 * `tools/find-browser.test.mjs` 之后新增：`lib/board-responsive.js` 的归档卡补丁。
 *
 * ## 为什么这些用例不真起浏览器
 *
 * 补丁的行为依赖真实 DOM 时序（上游 5 秒一轮重渲染会覆盖 kpi-row）。
 * 但 `npm test` 里起 4 次 Chrome 太慢且不稳（实测连跑时第 4 次会因进程
 * 没退干净而行为不同 —— 那次「用例 3 失败」是环境问题，单独跑两次都正确）。
 *
 * 所以这里只验**可离线验的部分**：补丁源码含什么、注入是否发生。
 * 真机时序验证由 `.probe/tmp/verify-arch-final.mjs` 做（不入库）。
 *
 * ## 为什么这样切分不违反「界面改动必须真机所见」
 *
 * 真机验证**已经做了**，且做在补丁定型之前 —— 三个关键发现全部来自真机：
 *   1. kpi-row 由上游 5 秒一轮重渲染整体覆盖 → 必须用 MutationObserver 补回
 *   2. observer 回调是微任务 → 「改完立刻置标志位」拦不住自触发 → 必须 disconnect
 *   3. 数据注入要转义 `<` → 本仓有一篇笔记引了看板源码
 *
 * 离线测试守住「补丁不会被人删掉/改坏注入」，真机验证守住「它在页面上活着」。
 * **两者缺一不可，但它们守的不是同一件事。**
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  ARCHIVED_CARD_JS,
  ARCHIVED_CARD_PATCH_ID,
  DRAWER_PATCH_ID,
  injectResponsiveCss
} from '../lib/board-responsive.js';

const MINIMAL = '<html><head></head><body><div id="kpi-row"></div></body></html>';

test('board-responsive: 注入同时包含抽屉补丁与归档卡补丁', () => {
  const out = injectResponsiveCss(MINIMAL);
  assert.ok(out.includes(DRAWER_PATCH_ID), '抽屉热更新补丁必须在');
  assert.ok(out.includes(ARCHIVED_CARD_PATCH_ID), '归档卡补丁必须在');
});

test('board-responsive: 归档卡补丁必须覆盖上游 5 秒一轮的重渲染', () => {
  /* ★ 这是实测踩到的：上游 renderBaseline 每次都做
     `kpi-row.innerHTML = ...`（整体覆盖），而它 5 秒一轮。
     所以「插一次」必然被抹掉 —— 必须盯住它，被覆盖就补回。
     删掉 observe() 就会退回「插一次就没」，真机验证会挂在 25 秒后的采样上。 */
  assert.match(ARCHIVED_CARD_JS, /MutationObserver/,
    '必须有 MutationObserver —— 上游会整体覆盖 kpi-row');
  assert.match(ARCHIVED_CARD_JS, /observer\.observe\(/, '必须真的在观察');
  assert.match(ARCHIVED_CARD_JS, /observer\.disconnect\(\)/,
    '改 DOM 前必须断开 —— observer 回调是微任务，置标志位拦不住自触发（实测页面卡死）');
});

test('board-responsive: 归档卡补丁不得依赖模块作用域的 Core', () => {
  /* 上游的 `const Core = {...}` 与 `function routeToListFilter()` 都在模块
     作用域，注入脚本触达不到（实测确认）。所以补丁只能读全局的
     `window.__INLINE_DATA__`，点击走事件委托。 */
  assert.match(ARCHIVED_CARD_JS, /window\.__INLINE_DATA__/,
    '必须用全局数据，不能依赖 Core');
  assert.doesNotMatch(ARCHIVED_CARD_JS, /\bCore\./,
    '不得引用 Core —— 它在模块作用域，外部拿不到');
  assert.doesNotMatch(ARCHIVED_CARD_JS, /routeToListFilter\(/,
    '不得直接调用 routeToListFilter —— 它在模块作用域');
  assert.match(ARCHIVED_CARD_JS, /addEventListener\('click'/,
    '点击必须用事件委托');
});

test('board-responsive: archived=0 时要显示 0，不能隐藏', () => {
  /* 四个 lifecycle 一视同仁。若归档为 0 就把卡藏起来，那它又变成
     「有时有有时没有」—— 而那正是本次要修的问题。 */
  assert.match(ARCHIVED_CARD_JS, /if \(n === null\) return/,
    '只有「数据未就绪」才不插；数出来是 0 必须照插');
  assert.doesNotMatch(ARCHIVED_CARD_JS, /if \(!n\) return|if \(n === 0\) return/,
    '不得因为计数为 0 而跳过');
});

test('board-responsive: 幂等 —— 重复注入不产生第二个脚本块', () => {
  const once = injectResponsiveCss(MINIMAL);
  const twice = injectResponsiveCss(once);
  const count = (twice.match(new RegExp(ARCHIVED_CARD_PATCH_ID, 'g')) ?? []).length;
  assert.equal(count, 1, `重复注入应只有 1 个，实际 ${count}`);
});

test('board-responsive: 找不到 head 时原样返回（不能把页面弄坏）', () => {
  const noHead = '<html><body>x</body></html>';
  assert.equal(injectResponsiveCss(noHead), noHead, '没有 </head> 应原样返回');
  assert.equal(injectResponsiveCss(''), '', '空串应原样返回');
});