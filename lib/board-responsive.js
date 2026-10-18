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
`;

/** 注入标记：样式块的 id，便于排查时确认这段覆盖真的生效。 */
export const RESPONSIVE_STYLE_ID = 'agent-notes-responsive';

/** 运行时补丁的标记（脚本块的 id）。 */
export const DRAWER_PATCH_ID = 'agent-notes-drawer-patch';

/**
 * 运行时补丁：笔记变更后热更新数据。
 *
 * **为什么要轮询**（实测）：上游**有**自动同步 —— window 的 focus 事件、
 * 以及每 5 秒的 setInterval 各扫一遍目录。但 `triggerLiveSync()` 第一行是
 * `if (!Core.dirHandle) return;`，而 `Core.dirHandle` 只在用户手动点
 * 「连接本地目录」并用 File System Access API 授权之后才赋值。
 * 侧边栏走的是服务端注入 `window.__INLINE_DATA__` 这条路，**永远不会设置
 * dirHandle** —— 所以改了笔记，页面纹丝不动。实测验证过：
 * `Core.dirHandle === false`，改标题后页面看不到新内容。
 *
 * 做法：定时拉 `/agent-notes/data`（只返回数据，不拉 76KB HTML），
 * 比对 `revision` 指纹；变了才调上游自己的 `ingestDataset()` 重绘。
 * 用上游现成的入口，引用计数、排序、所有视图都跟着更新，不需要我们重画。
 *
 * `must`：无变化时**绝不重绘** —— 重绘会让用户正在看的滚动位置、打开着的
 * 抽屉莫名跳动。指纹由服务端按渲染字段算，见 `revisionOf()`。
 *
 * `must`：页面不可见时跳过请求（`document.hidden`），别让后台 tab 空转。
 *
 * 注：这里**不再**处理抽屉的滚动位置与背景滚动锁。这两件事曾由本层注入
 * 补救（上游当时缺失），但上游已在 commit 72573a5 修好 —— 锁滚动 CSS 与
 * 我们的写法逐字相同，`scrollTop = 0` 也进了 `openConsole()`。实测把本层
 * 完全剥离后抽屉行为依然正确，故删除重复实现，避免两份等效代码长期漂移。
 */
const DRAWER_PATCH_JS = `
(function () {
  /* ── 笔记变更后热更新 ── */
  /* 从当前路径推导 /data 端点：把最后一段（ui）换成 data。
     **不能直接 location.pathname 加 'data'** —— 那会拼成
     /agent-notes/uidata，实测 404，轮询静默失效（踩过）。
     也不能写死 /agent-notes/data：路由前缀是插件的常量，
     将来若允许改前缀，写死就会指向别处。 */
  var DATA_URL = location.pathname.replace(/[^/]*$/, 'data') + location.search;
  var INTERVAL_MS = 4000;
  /* 暴露状态供探针与人工排查用：polls 只增不减，一眼看出轮询是否在跑；
     revision 是当前认到的指纹；applied 是真正重绘过的次数。 */
  var state = { polls: 0, applied: 0, revision: null, failures: 0, error: null };
  window.__agentNotesLive = state;

  /* ── 只在「真的看得见」时轮询 ──
     看板跑在侧边栏的 iframe 里。实测：宿主把 iframe 的容器设为 display:none
     （切到别的 tab）之后，iframe 内部的 document.hidden **仍然是 false** ——
     因为 hidden 反映的是「整个浏览器窗口/标签页」是否可见，而不是这个 iframe
     是否被渲染。所以只看 document.hidden 等于没挡：用户切走后仍每 4 秒拉一次
     100KB、服务端仍做一次全盘扫描（实测单次 78ms）。
     用 IntersectionObserver 盯 body：它由浏览器在渲染树层面判定，iframe 被
     隐藏时会给 isIntersecting=false，实测三态都准（可见/隐藏/恢复）。
     隐藏期间直接停掉定时器，恢复时立刻补探一次 —— 既不空转，也不会漏掉
     隐藏期间发生的变更。 */
  var visible = true;
  var timer = null;

  function start() {
    if (timer !== null) return;
    timer = setInterval(poll, INTERVAL_MS);
  }
  function stop() {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  if (typeof IntersectionObserver === 'function') {
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i += 1) {
        visible = entries[i].isIntersecting;
      }
      if (visible) {
        start();
        /* 隐藏期间可能改过笔记，恢复可见时立刻补一次，不等下一个周期。 */
        poll();
      } else {
        stop();
      }
    }, { threshold: 0 });
    io.observe(document.body);
  } else {
    /* 没有 IntersectionObserver 时退化为「按文档可见性判断」——
       挡不住 iframe 被隐藏，但不会比旧行为更差。 */
    visible = !document.hidden;
  }

  function poll() {
    /* 双保险：IO 已挡住绝大部分，但整页 hidden（切到别的浏览器标签页）时
       IO 未必回调，这里再查一次。 */
    if (!visible || document.hidden) return;
    state.polls += 1;
    fetch(DATA_URL, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (payload) {
        state.failures = 0;
        if (!payload || !Array.isArray(payload.notes)) return;
        /* 首次拿到指纹只记录，不重绘：页面刚由内联数据渲染过，同内容
           重绘一次纯属浪费，还可能打断用户刚做的操作。 */
        if (state.revision === null) {
          state.revision = payload.revision;
          return;
        }
        if (payload.revision === state.revision) return;
        state.revision = payload.revision;
        /* 用上游自己的入口重绘：引用计数、排序、四个视图都会更新。 */
        if (typeof window.ingestDataset === 'function') {
          window.ingestDataset(payload.notes);
          state.applied += 1;
        } else {
          state.error = 'ingestDataset 不在全局作用域';
        }
      })
      .catch(function (e) {
        state.failures += 1;
        state.error = String(e && e.message ? e.message : e);
      });
  }

  /* 启动：先探一次拿初始指纹，再按可见性起定时器。
     若此刻不可见（侧边栏不在前台），定时器先不建，等 IO 报可见时再起。 */
  if (visible && !document.hidden) {
    poll();
    start();
  }
  /* 切回窗口时立刻探一次（整页 hidden 的场景 IO 未必回调）。 */
  window.addEventListener('focus', poll);
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
