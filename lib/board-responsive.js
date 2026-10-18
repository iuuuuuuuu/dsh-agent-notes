/**
 * 看板的窄屏适配层：宿主侧注入的最小覆盖 CSS。
 *
 * 为什么需要（实测数据，不是猜）：
 * 上游看板的顶栏是 `header.hud-topbar { height: 64px; display:flex; }`，
 * 固定高度、不换行，而且**子项自己没有 nowrap** —— 宽度一紧张，文字就在
 * 子项内部逐字折行，然后被 64px 的固定高度裁掉。
 *
 * 实测（2026-10-18 复测，比第一轮更全）：
 *   - 1146px：brand-group 实际高 51px、deck-tabs 58px（header 只有 64px）
 *   - 1000px：154/51px、368/58px —— **比 900px 还差**
 *   - 900px 以下才落进第一轮的媒体查询，反而正常
 * 也就是说顶栏竖排在 **900–1440px 这片"宽屏"区间同样存在**，第一轮只测
 * ≤900px，把这一段整个漏掉了。根因不是"窄"，是"子项会折行"。
 *
 * 为什么写在这里而不是改 HTML：
 * `skills/agent-notes/assets/agent-notes-board.html` 是 vendored 的上游资产，
 * AGENTS.md 硬约束 3 禁止手改（`tools/verify-plugin.mjs` 会用清单哈希比对拦下）。
 * 所以适配只能落在宿主这一侧：服务端吐页面时插一段 `<style>`。
 *
 * 边界（重要）：
 *   - 只在需要时生效（媒体查询），宽屏视觉与上游保持一致；
 *   - 只调整布局与间距，不改任何类名、不改 DOM 结构、不动交互逻辑；
 *   - 上游若自己补了响应式，这段覆盖会变成冗余但不会冲突（同样的选择器，
 *     上游的媒体查询更宽时以层叠顺序为准，最坏情况是间距略有出入）。
 *
 * 零依赖：纯字符串常量。
 */

/**
 * 覆盖样式。
 *
 * 四档断点，按"先保不折行，再保不吃掉内容"的顺序：
 *   ≤1200px —— 只收紧间距；子项 nowrap（治 900–1440px 的竖排）
 *   ≤900px  —— 进一步压间距，导航可横向滚动
 *   ≤720px  —— 顶栏两行：品牌+状态+搜索 / 导航独占一行
 *   ≤480px  —— KPI 单列、抽屉全宽
 */
export const RESPONSIVE_CSS = `
/* ── 窄屏适配（宿主注入，vendored 资产未改动）── */

/* 治本：顶栏子项一律不折行。
   上游没写 nowrap，宽度一紧就在子项内部逐字换行，再被 height:64px 裁掉。
   这条放在所有断点之外（= 全宽度生效），因为它修的是"会折行"这个 bug，
   不是"太窄"这个症状 —— 实测 1146px 就已经在折了。 */
header.hud-topbar > * { min-width: 0; }
.brand-group { flex: 0 0 auto; white-space: nowrap; }
.brand-text { white-space: nowrap; }
.telemetry-chip { flex: 0 0 auto; white-space: nowrap; }
nav.deck-tabs { flex: 0 0 auto; white-space: nowrap; }
.deck-tab { white-space: nowrap; flex: 0 0 auto; }
.hud-search { flex: 0 1 auto; }
.sync-beacon { flex: 0 0 auto; white-space: nowrap; }

@media (max-width: 1200px) {
  /* 900–1440px 这段：子项 nowrap 后总宽会超，先靠收紧间距腾空间。
     实测这里原本 brand 51px / tabs 58px（竖排），收紧后回落到 32/39px。 */
  header.hud-topbar { padding: 0 16px; gap: 12px; }
  .hud-search { width: 190px; }
  .hud-search input { width: 190px; }
  .hud-search input:focus { width: 220px; }
  .sync-beacon { padding: 6px 10px; }
  .deck-tab { padding: 6px 11px; }
}

@media (max-width: 900px) {
  header.hud-topbar { padding: 0 12px; gap: 8px; }
  .brand-text { font-size: 14px; }
  nav.deck-tabs { overflow-x: auto; scrollbar-width: none; max-width: 100%; }
  nav.deck-tabs::-webkit-scrollbar { display: none; }
  .hud-search { width: 150px; min-width: 0; flex: 0 1 auto; }
  .hud-search input { width: 100%; min-width: 0; }
  .hud-search input:focus { width: 100%; }
  /* 状态文字在 900px 以下先让位给图标（title 仍说明用途，点击行为不变）。 */
  #beacon-status { display: none; }
  .sync-beacon { padding: 6px 8px; }
}

@media (max-width: 720px) {
  /* 窄屏顶栏改成紧凑两行：
     第一行：品牌 + 状态灯 + 搜索框
     第二行：导航（横向滚动，独占整行）
     height:auto 是必须的 —— 上游写死 64px，不解除就会裁掉换行后的内容。 */
  header.hud-topbar {
    height: auto; flex-wrap: wrap; padding: 8px 12px;
    row-gap: 8px; column-gap: 8px;
  }
  .brand-group { order: 1; }
  /* 状态灯紧贴品牌右侧；文字隐藏只留图标（title 仍说明用途，点击行为不变）。 */
  .sync-beacon { order: 2; flex: 0 0 auto; }
  #beacon-status { display: none; }
  /* 搜索框收到第一行右端，固定宽度，不再独占一行。
     min-width:0 + flex-shrink 是必须的：写死 150px 时实测 760px 处搜索框
     右边缘顶到 767（超出 7px）、360px 处超出 20px。 */
  .hud-search { order: 3; flex: 0 1 116px; width: 116px; min-width: 0; }
  .hud-search input { width: 100%; padding: 0 10px 0 28px; font-size: 12px; }
  .hud-search input:focus { width: 100%; }
  /* 窄屏下 "/" 提示与占位文字都会挤爆输入框：只留图标 + 输入区。 */
  .hud-search .shortcut-key { display: none; }
  .hud-search input::placeholder { color: transparent; }
  /* 上游的弹性占位符在两行布局里没有用处，隐藏掉避免它抢行。 */
  .hud-grow { display: none; }

  /* 第二行：导航独占一行并横向滚动。
     为什么不让导航和搜索并排：实测并排时 nav 只剩 130px 左右，
     四个 tab 只露出一个半，用户不知道还有别的视图 —— 可读性比省
     下的 36px 重要。 */
  nav.deck-tabs {
    order: 4; flex: 1 1 100%; width: 100%; min-width: 0; max-width: 100%;
  }

  main.mission-canvas { padding: 16px 14px 56px; gap: 18px; }
  .hud-panel { padding: 18px 16px; }
  .panel-masthead { flex-wrap: wrap; row-gap: 4px; }

  /* 页脚：上游用 flex + space-between，左侧那段中文是长文本，
     窄屏下会挤占右侧「友情链接: LinuxDo」的空间。让左侧可收缩换行。 */
  footer > div:first-child { flex: 1 1 auto; min-width: 0; }
  footer > div:last-child { flex: 0 0 auto; }

  /* 多列网格降为单列：minmax(330px/380px) 在窄容器里会把轨道撑得比容器宽。 */
  .pillars-vault { grid-template-columns: minmax(0, 1fr); }
  .pitfalls-grid { grid-template-columns: minmax(0, 1fr); }
  .alt-search-input { min-width: 0; }

  /* 详情抽屉：上游 min-width 520px，在 400px 视口里会横向溢出。 */
  #drawer-console { min-width: 0; width: 100%; max-width: none; }
  .console-body { padding: 20px 16px 56px; }
  .console-header { padding: 0 16px; }
}

@media (max-width: 420px) {
  /* 极窄（≤420px）：搜索框让位，只留图标按钮。
     实测 320px 下第一行放不下「品牌 + 状态 + 116px 搜索框」，搜索框被挤到
     第三行，顶栏涨到 140px。这里把搜索框收成 34px 的图标位：点开仍可用
     （它拿焦点时展开成全宽），但静态占位只剩图标。
     这是刻意的取舍 —— 320px 已经接近手机宽度，搜索本来就该是「点开再用」。 */
  .hud-search {
    flex: 0 0 34px; width: 34px; overflow: hidden;
    transition: width .18s ease, flex-basis .18s ease;
  }
  .hud-search:focus-within { flex-basis: 140px; width: 140px; }
  .hud-search input { padding: 0; text-indent: -9999px; }
  .hud-search input:focus { text-indent: 0; padding: 0 8px 0 28px; }
  .hud-search .search-ico { left: 50%; transform: translateX(-50%); }
  .hud-search:focus-within .search-ico { left: 8px; transform: none; }

  /* 导航在极窄下横向滚动，不折行。 */
  nav.deck-tabs { overflow-x: auto; scrollbar-width: none; }
  nav.deck-tabs::-webkit-scrollbar { display: none; }

  .brand-text { font-size: 13px; }
}

@media (max-width: 480px) {
  /* KPI 仪表在极窄宽度下两列太挤（38px 数字 + 中文标签会互相顶）。 */
  .kpi-row { grid-template-columns: minmax(0, 1fr); }
  .kpi-num { font-size: 32px; }
}

/* ── 抽屉打开时锁住背景滚动 ──
   上游把 #drawer-console 做成 position:fixed 浮层，但**没有禁止背景滚动**，
   于是抽屉打开后背景页面仍能滚 —— 出现内外两层滚动条，用户滚到哪一层
   全看指针落在哪里，体验混乱。

   :has() 让「抽屉打开」这个状态直接可选中（上游是给 #drawer-console
   加 .open 类），不需要改它的 JS。支持度：Chrome 105+/Safari 15.4+/
   Firefox 121+，DSH 用的是 Chromium，满足。
   退路：万一 :has() 不被支持，这条规则整条失效，只是退化回上游原状
   （双层滚动），不会把页面弄坏。

   **body 和 html 都要锁**：视口滚动在不同 UA 下由不同元素承担，
   只锁 body 时实测 documentElement 仍能滚（CDP 实测 scrollTop 能设成 400），
   第二条滚动条依然在。两个都设 overflow:hidden 才彻底。 */
body:has(#drawer-console.open),
html:has(#drawer-console.open) { overflow: hidden; }
`;

/** 注入标记：样式块的 id，便于排查时确认这段覆盖真的生效。 */
export const RESPONSIVE_STYLE_ID = 'agent-notes-responsive';

/** 运行时补丁的标记（脚本块的 id）。 */
export const DRAWER_PATCH_ID = 'agent-notes-drawer-patch';

/**
 * 运行时补丁：打开新笔记时把抽屉滚回顶部。
 *
 * 为什么必须是脚本而不是 CSS（实测）：
 * 上游 `openConsole()` 只做两件事 —— 给 `#drawer-console` 加 `.open`、
 * 写 `location.hash`。它**从不重置 `.console-body` 的 scrollTop**，而
 * `.console-body` 是 `overflow-y: auto` 的滚动容器。于是：读到一篇笔记的
 * 底部 → 打开另一篇 → 直接从底部开始显示。纯 CSS 无法重置滚动位置。
 *
 * 做法：用 `MutationObserver` 盯 `#drawer-console` 的 class 变化，一旦
 * 加上 `.open` 就把 `.console-body` 的 scrollTop 归零。这样**完全不碰
 * 上游的 openConsole / closeConsole**，上游改实现也不冲突。
 *
 * 时机必须晚一帧：上游在同一个同步流程里先加 .open，再填 innerHTML。
 * 若立刻归零，随后填入内容会重新布局、滚动位置可能又被带着走，所以用
 * requestAnimationFrame 推到下一帧再归零。
 */
const DRAWER_PATCH_JS = `
(function () {
  var consoleEl = document.getElementById('drawer-console');
  if (!consoleEl) return;
  var body = consoleEl.querySelector('.console-body');
  if (!body) return;
  var observer = new MutationObserver(function () {
    if (!consoleEl.classList.contains('open')) return;
    /* 推到下一帧：上游会在同一同步流程里继续填 innerHTML，
       立刻归零可能被随后的重排顶回去。 */
    requestAnimationFrame(function () { body.scrollTop = 0; });
  });
  observer.observe(consoleEl, { attributes: true, attributeFilter: ['class'] });
})();
`;

/**
 * 判断页面里是否已经插过这段样式。
 *
 * **必须匹配完整的 `<style id="...">` 标签，不能只找 id 字符串。**
 * 实测踩过的坑：笔记正文里可能原样提到 `agent-notes-responsive`（本仓库的
 * 决策笔记就写了这个 id），而那篇笔记的正文会作为数据被注入同一个页面。
 * 只找 id 时，函数会把「数据里提到过这个名字」误判成「样式已经插过了」，
 * 直接原样返回 —— 表现为窄屏适配**时有时无**：笔记里提到一次就失效，
 * 删掉那篇笔记又好了。排查时极易误判成「进程没重载」。
 *
 * @param {string} html 页面文本。
 * @returns {boolean} 是否已有注入的样式块。
 */
function hasInjectedStyle(html) {
  return new RegExp(`<style[^>]*\\bid=["']${RESPONSIVE_STYLE_ID}["']`).test(html);
}

/**
 * 把适配样式与抽屉补丁插进页面。
 *
 * 幂等：已经注入过（含该 id 的 style 标签）就不再插第二次。找不到
 * `</head>` 时原样返回 —— 宁可少一层适配，也不能把页面弄坏
 * （适配层不是功能前提）。
 *
 * 脚本插在 `</body>` 之前：它要拿 `#drawer-console`，必须等 DOM 就绪。
 *
 * @param {string} html 上游页面原文。
 * @returns {string} 注入后的页面。
 */
export function injectResponsiveCss(html) {
  if (typeof html !== 'string' || html === '') return html;
  if (hasInjectedStyle(html)) return html;
  const at = html.lastIndexOf('</head>');
  if (at === -1) return html;
  const style = `<style id="${RESPONSIVE_STYLE_ID}">${RESPONSIVE_CSS}</style>`;
  let out = `${html.slice(0, at)}${style}\n${html.slice(at)}`;

  /* 脚本单独找一个插入点：它依赖 DOM，只能放 body 末尾。 */
  const bodyAt = out.lastIndexOf('</body>');
  if (bodyAt !== -1) {
    const script = `<script id="${DRAWER_PATCH_ID}">${DRAWER_PATCH_JS}</script>\n`;
    out = `${out.slice(0, bodyAt)}${script}${out.slice(bodyAt)}`;
  }
  return out;
}
