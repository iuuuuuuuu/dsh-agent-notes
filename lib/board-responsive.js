/**
 * 看板的窄屏适配层：宿主侧注入的最小覆盖 CSS。
 *
 * 为什么需要（实测数据，不是猜）：
 * 上游看板的顶栏是 `header.hud-topbar { height: 64px; display:flex; }`，
 * 固定高度且不换行。窄容器（右侧栏约 400–700px）里五个子项抢不到宽度，
 * 于是每个子项内部逐字换行 —— 实测 652px 下 brand-group 的实际高度是
 * 154px、deck-tabs 是 134px，而 header 只有 64px，文字被裁成竖排单字。
 * 400–760px 区间全部复现。
 *
 * 为什么写在这里而不是改 HTML：
 * `skills/agent-notes/assets/agent-notes-board.html` 是 vendored 的上游资产，
 * AGENTS.md 硬约束 3 禁止手改（`tools/verify-plugin.mjs` 会用清单哈希比对拦下）。
 * 所以适配只能落在宿主这一侧：服务端吐页面时插一段 `<style>`。
 *
 * 边界（重要）：
 *   - 只在窄宽度生效（媒体查询），宽屏视觉与上游完全一致；
 *   - 只调整布局与间距，不改任何类名、不改 DOM 结构、不动交互逻辑；
 *   - 上游若自己补了响应式，这段覆盖会变成冗余但不会冲突（同样的选择器，
 *     上游的媒体查询更宽时以层叠顺序为准，最坏情况是间距略有出入）。
 *
 * 零依赖：纯字符串常量。
 */

/**
 * 覆盖样式。
 *
 * 两个断点：
 *   ≤900px —— 压缩顶栏间距，让各子项不再逐字换行；
 *   ≤720px —— 顶栏改为两行（品牌 + 状态 / 导航 + 搜索各占满），
 *             并收紧正文内边距、把多列网格降为单列。
 */
export const RESPONSIVE_CSS = `
/* ── 窄屏适配（宿主注入，vendored 资产未改动）── */
@media (max-width: 900px) {
  header.hud-topbar { padding: 0 14px; gap: 12px; }
  .brand-text { font-size: 14px; white-space: nowrap; }
  /* 导航条整体横向滚动，而不是每个按钮内部折行。
     min-width:0 是必须的：flex 子项的默认 min-width:auto 会让它按内容宽度
     撑开，overflow-x 就没机会生效 —— 实测 400px 下 nav 把 header 顶到 420px。 */
  nav.deck-tabs {
    overflow-x: auto; flex-wrap: nowrap; scrollbar-width: none;
    min-width: 0; max-width: 100%;
  }
  nav.deck-tabs::-webkit-scrollbar { display: none; }
  .deck-tab { white-space: nowrap; flex: 0 0 auto; padding: 6px 12px; }
  .hud-search { width: 150px; }
  .hud-search input:focus { width: 190px; }
  .sync-beacon { white-space: nowrap; padding: 6px 10px; }
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
  /* 搜索框收到第一行右端，固定宽度，不再独占一行。 */
  .hud-search { order: 3; flex: 0 0 116px; width: 116px; }
  .hud-search input { padding: 0 10px 0 28px; font-size: 12px; }
  .hud-search input:focus { width: 116px; }
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

@media (max-width: 480px) {
  /* KPI 仪表在极窄宽度下两列太挤（38px 数字 + 中文标签会互相顶）。 */
  .kpi-row { grid-template-columns: minmax(0, 1fr); }
  .kpi-num { font-size: 32px; }
}
`;

/** 注入标记：样式块的 id，便于排查时确认这段覆盖真的生效。 */
export const RESPONSIVE_STYLE_ID = 'agent-notes-responsive';

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
 * 把窄屏覆盖样式插进页面的 `</head>` 之前。
 *
 * 幂等：已经注入过（含该 id 的 style 标签）就不再插第二次。找不到
 * `</head>` 时原样返回 —— 宁可少一层适配，也不能把页面弄坏
 * （适配层不是功能前提）。
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
  return `${html.slice(0, at)}${style}\n${html.slice(at)}`;
}
