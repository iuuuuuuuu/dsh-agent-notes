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
 * 真机时序验证由 headless Chrome 探针做（`.probe/board-probe2.mjs`，`--dump-dom` 读回
 * 页面内自测量；探针与截图都**不入库**，`.probe/` 在 `.gitignore` 里）。
 * 源码级语法体检在 `tools/board-response-source.test.mjs` —— 它不 import 本模块，
 * 所以模块自己语法炸掉时它仍能跑出可读的诊断（这条分工是被真实事故逼出来的）。
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
  DRAWER_PATCH_JS,
  RESPONSIVE_CSS,
  injectResponsiveCss
} from '../lib/board-responsive.js';

const MINIMAL = '<html><head></head><body><div id="kpi-row"></div></body></html>';

/** 去掉注释，只留可执行代码。
 *  为什么要这一步：注释里会提到 `Core.stFilter` 这类标识符来解释背景，
 *  而「不得引用 Core」这条规则管的是**代码**，不是注释。
 *  不剥注释的话，写清注释反而会让用例红 —— 那是测试在逼人少写解释。 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

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

test('board-responsive: 归档卡补丁不得依赖 Core，但可以调全局函数', () => {
  /* 实测（`.probe/board-metrics.json` 的 reachability 段，headless Chrome 在
     真实页面里取的 typeof）：routeToListFilter=function、switchDeckTab=function、
     **Core=undefined**。原因：上游那个 <script> 是经典脚本，顶层 function 声明
     成为 window 属性；`const Core = {...}` 是 const 声明，不进 window。
     所以「只读 window.__INLINE_DATA__、不碰 Core」成立；
     「不得调用 routeToListFilter」**不成立** —— 那条断言是照猜测写的，已改掉
     （它还会把正确的修法判红）。 */
  assert.match(ARCHIVED_CARD_JS, /window\.__INLINE_DATA__/,
    '必须用全局数据，不能依赖 Core');
  const code = stripComments(ARCHIVED_CARD_JS);
  assert.doesNotMatch(code, /\bCore\./,
    '不得引用 Core —— const 声明不进 window，外部拿不到');
  assert.match(code, /window\.routeToListFilter\(/,
    'routeToListFilter 是全局 function，要用就走 window 上的那个');
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

/* ── 2026-10-21：用户报的两个症状 ──
   ①「已归档」卡没跟另外四张在同一行；②点它看不到归档笔记。
   两条都先在真机量到数据才动手（见各用例注释里的实测值）。 */

test('board-responsive: 归档卡必须留在 KPI 同一行（上游只有 4 列）', () => {
  /* 实测（1440px 视口、headless Chrome 量 getBoundingClientRect）：
     修之前 4 列 × 320.75px，前四张 top=92，第 5 张 top=248 / left=36
     —— 单独掉到第二行。上游 .kpi-row 是 repeat(4, 1fr)。
     修法是注入 CSS 把带 kpi-row-5 的行改成 5 列；类名由 JS 挂，
     所以没有卡片时这几条规则一条都不生效。 */
  assert.match(RESPONSIVE_CSS, /\.kpi-row\.kpi-row-5\s*\{[^}]*repeat\(5,/,
    '必须有 5 列规则，否则第 5 张卡会被挤到第二行');
  /* 特异性：媒体查询不增加权重，窄屏档位若不是 .kpi-row.kpi-row-5（0,2,0），
     就会输给上游基础规则 `.kpi-row`（0,1,0）而退回 4 列。 */
  const narrow = RESPONSIVE_CSS.match(/@media \(max-width: (?:1200|960|480)px\) \{[^@]*?\.kpi-row\.kpi-row-5/g) ?? [];
  assert.ok(narrow.length >= 3,
    `三个窄屏档位都必须用 .kpi-row.kpi-row-5 覆盖，实际 ${narrow.length} 处`);
  /* 剥注释再判：`lib/board-responsive.js` 里有一句解释性注释写着
     `.kpi-row`（说明为什么不能用它），不剥就会假红 —— 那等于逼人少写解释。
     复审 r2 的 G-4 指的正是这一处（当时靠一句注释恰好挡住正则）。 */
  assert.doesNotMatch(stripComments(RESPONSIVE_CSS), /@media[^{]*\{\s*\.kpi-row\s*\{/,
    '窄屏档位不得回退到低特异性的 .kpi-row（会盖不住上游）');
});

/* 这里原先有一条「样式与脚本模板里不得出现反引号」的用例，已删除。
   理由（复审 r2 的 G-2，2026-10-21 现场实证）：模板字面量里真出现裸反引号时，
   **模块自己 import 就 SyntaxError**，本文件第 26-33 行的 import 直接抛，
   整套用例连注册都到不了 —— 所以 `doesNotMatch(RESPONSIVE_CSS, /`/)` 永远
   没有执行机会。它宣称防的事故真的发生了，它没抓到。
   换成 `tools/board-response-source.test.mjs`：那里只用 readFileSync 读源码，
   不 import 模块，因此能在语法炸掉时给出「哪个常量在哪一行被裸反引号提前结束」。 */

test('board-responsive: 点归档卡要复用上游的 routeToListFilter', () => {
  /* 两个症状，两轮才修全：
     ① 只设筛选值时 Core.stFilter 变成 archived、计数也显示「匹配 1 条」，
        但 activeTab 仍是 baseline —— 列表在另一个 .canvas-view 里，没切视图。
     ② 只设 status 不清旧筛选：renderDirectory 是 st+cls+q 三个条件与运算，
        用户先前筛过 class 或搜过词，点「已归档」照样 0 行（复审 r2 的 G-1）。

     上游 routeToListFilter（agent-notes-board.html:1466-1485）两件事都做：
     switchDeckTab('directory') → 清 Core.stFilter/clsFilter/filterQuery/
     #global-query/两个 select → 设值 → renderDirectory()。经典 <script> 的
     顶层函数声明是 window 属性，所以注入脚本能直接调。 */
  const code = stripComments(ARCHIVED_CARD_JS);
  assert.match(code, /window\.routeToListFilter\('archived'\)/,
    '必须优先调上游 routeToListFilter —— 它才清得干净旧筛选');
  const guardAt = code.indexOf("typeof window.routeToListFilter === 'function'");
  const callAt = code.indexOf("window.routeToListFilter('archived')");
  assert.ok(guardAt !== -1 && callAt > guardAt,
    '调用要在能力探测之后（取不到就退路，不能直接抛）');
  assert.ok(code.indexOf('return;', callAt) > callAt,
    '调用成功要 return，别把退路也执行一遍');
  /* 退路保留但**只承诺切视图**：它不清旧筛选，能力探测失败时才会走到。
     这里断言退路还在（别把兜底删成裸 return），不断言它的效果。 */
  assert.match(code, /location\.hash = 'directory'/,
    '退路要真的切视图（改 hash 触发上游 hashchange 监听）');
  assert.match(code, /dispatchEvent\(new Event\('change'/,
    '退路还要派发 change，否则筛选值不会作用到列表');
});

test('board-responsive: 插卡片时才给行挂 kpi-row-5', () => {
  assert.match(ARCHIVED_CARD_JS, /row\.className[^;]*kpi-row-5/,
    '类名必须由插卡片的代码挂上，CSS 才知道该不该改列数');
  /* 类名要在 appendChild 之前挂：先挂类再插，避免一帧 4 列布局的闪烁。
     这条顺序**有**语义（同一帧里的样式计算看的是插入时的类名），
     与上面那条「两行先后无关」的断言不是一回事。 */
  /* 剥注释再定位：注释里先出现 `kpi-row-5` 会让 indexOf 拿到错位置，
     于是「先挂类再插卡」变成假绿（复审 r2 的 G-3）。 */
  const live = stripComments(ARCHIVED_CARD_JS);
  const clsAt = live.indexOf("' kpi-row-5'");
  const appendAt = live.indexOf('row.appendChild(card)');
  assert.ok(clsAt !== -1 && appendAt !== -1 && clsAt < appendAt,
    '挂类名要在 appendChild 之前');
});