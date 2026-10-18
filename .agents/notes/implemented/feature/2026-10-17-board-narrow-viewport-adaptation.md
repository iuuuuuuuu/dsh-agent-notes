# Agent Note: 窄屏适配由宿主注入，不改 vendored 看板

Status: implemented

> 同域：本篇解决**窄屏布局**。**抽屉滚动**见
> [../bug-fix/2026-10-18-drawer-scroll-and-double-scrollbar.md](../bug-fix/2026-10-18-drawer-scroll-and-double-scrollbar.md)，
> 上游修好后删掉重复注入的决定见
> [../simplification/2026-10-18-drop-redundant-drawer-patch-after-upstream-fix.md](../simplification/2026-10-18-drop-redundant-drawer-patch-after-upstream-fix.md)。
> 三者共用同一条原则：**能注入就不改 vendored 看板**。

## Problem

看板接进 dsh-better-sidebar 的右侧栏后，小窗口下观感崩了：顶栏的中文被压成**逐字竖排**，品牌、导航、搜索、状态四个子项挤成一列单字，几乎不可读。

实测数据（CDP 量 `getBoundingClientRect`，不是看图猜）：

| 视口宽度 | header 高度 | brand-group 实际高 | deck-tabs 实际高 |
|---|---|---|---|
| 400 | 64 | 154 | 134 |
| 500 | 64 | 154 | 134 |
| 652 | 64 | 154 | 134 |
| 760 | 64 | 77 | 95 |
| 900 | 64 | 51 | 58 |

根因是上游顶栏 `header.hud-topbar { height: 64px; display: flex; }` —— **固定高度且不换行**。窄容器里五个子项抢不到宽度，每个子项内部逐字换行，实际高度涨到 154px 却被 64px 的固定高度裁掉，视觉上就是竖排单字。400–760px 区间全部复现，正好覆盖右侧栏的常见宽度。

同时暴露两个连带问题（截图目视发现）：
- 两行布局下品牌区被 `hud-grow` 挤到右侧，左侧空一大块；
- 页脚左侧那段中文是 nowrap 长文本，把右侧「友情链接: LinuxDo」顶出视口、被切掉一半。

## Decision

新增 `lib/board-responsive.js`，在宿主侧把一段覆盖 CSS 注入看板页面：`injectResponsiveCss(html)` 把 `<style id="agent-notes-responsive">` 插到 `</head>` 之前，由 `lib/board-route.js` 的 `/agent-notes/ui` 响应调用。

`must`：`skills/agent-notes/assets/agent-notes-board.html` **保持零改动**。它是 vendored 的上游资产，`tools/verify-plugin.mjs` 用清单哈希比对，手改会被门禁拦下（AGENTS.md 硬约束 3）。适配只能落在宿主这一侧。

`must`：覆盖样式只在媒体查询内生效 —— `≤900px` 压缩间距、`≤720px` 顶栏改两行、`≤480px` KPI 降单列。宽屏（≥1100px）视觉与上游完全一致。

关键修复点：
- `≤720px` 必须 `height: auto` —— 不解除固定高度，换行后的内容仍会被裁成竖排；
- `nav.deck-tabs` 必须 `min-width: 0` + `overflow-x: auto` —— flex 子项默认 `min-width: auto` 会按内容撑开，`overflow-x` 根本不生效，实测 400px 下反过来把 header 顶到 420px；
- `.hud-grow` 必须显式 `order` —— 它是上游的弹性占位符，不设 order 会占住第一行剩余空间，把品牌区挤到右侧；
- `footer > div:first-child` 给 `flex: 1 1 auto; min-width: 0`，让长中文可收缩，右侧链接保持完整。

`must`：注入幂等（带 id 检测），且找不到 `</head>` 时**原样返回** —— 适配层不是功能前提，宁可少一层样式也不能把页面弄坏。

`must`：顶栏子项的 `white-space: nowrap` 必须写在**所有断点之外**（全宽度生效），不能塞进媒体查询。理由见下一节 —— 这是第三轮才查清的真根因。

`must`：幂等判据必须是**完整的 `<style id="...">` 标签**，不能是 id 子串。判据写成 `html.includes(RESPONSIVE_STYLE_ID)` 会踩一个很贵的坑：笔记正文会作为数据注入**同一个页面**，本仓库有一篇笔记恰好写了 `agent-notes-responsive` 这个 id —— 函数于是把「数据里提到过这个名字」误判成「样式已经插过了」，直接原样返回。表现是窄屏适配**时有时无**（笔记里提到一次就失效，删掉那篇又好了），排查时极易误判成「进程没重载」。已由 `board-responsive: 数据里提到样式 id 时仍必须注入` 这条测试钉住。

## 真根因：子项会折行，不是"太窄"（第三轮）

前两轮把问题定性成「窄屏布局」是**错的**。用户贴了一张 1146px 的截图，顶栏同样竖排 —— 逼着重测了全宽度谱系，才发现：

| 宽度 | brand-group 高 | deck-tabs 高 | 现象 |
| --- | --- | --- | --- |
| 1440/1300 | 32 | 39 | 正常 |
| 1146 | 51 | 58 | **竖排**（header 只有 64px）|
| 1000 | 51 | 58 | **竖排，比 900px 还差** |
| ≤900 | 32 | 39 | 正常（落进了第一轮的媒体查询）|

也就是说竖排发生在 **900–1440px 这片"宽屏"区间**，而第一轮只测 ≤900px，把整段漏掉了。根因是上游 `.deck-tab` / `.brand-text` 等**自己没有 `white-space: nowrap`**，宽度一紧张就在子项内部逐字折行，然后被固定 64px 裁掉。断点补在哪儿都治不了这个 —— 只要子项还能折行，换个宽度区间就会复发。

修法是把 `nowrap` 提到所有断点之外，再配 `min-width: 0` 允许收缩：

```css
header.hud-topbar > * { min-width: 0; }
.brand-text, nav.deck-tabs, .deck-tab, .sync-beacon { white-space: nowrap; }
```

**教训**：第一轮报告「400–700px 已修复、无横向溢出」在当时是真的，但**验证范围本身就是盲区** —— 只测了症状出现的那一段宽度，没测「症状没出现」的区间。UI 适配类改动必须扫一遍完整谱系（本例 320→1440），不能只测用户报的那一档。

补的两条测试直接钉住这个教训：断言 `nowrap` 出现在 `@media` 之前（`RESPONSIVE_CSS.split('@media')[0]`），以及搜索框必须可收缩 —— 后者是因为写死 150px 时实测 760px 处 input 右边缘 767（超 7px）、360px 处超 20px。

## 窄屏布局（第二轮）

第一版只解决了「不再竖排」，实测截图仍不好看：顶栏 140px 占三行、导航被挤得只剩一个半按钮。第二轮重排为**两行**：

- 第一行：品牌 + 状态灯（只留图标）+ 搜索框（固定 116px，隐藏 `/` 提示与占位文字）；
- 第二行：导航独占整行并横向滚动。

为什么不让导航和搜索并排：实测并排时 nav 只剩 130px 左右，四个 tab 只露出一个半，用户不知道还有别的视图 —— 可读性比省下的 36px 重要。重排后顶栏从 140px 降到 100px，500/652px 下四个 tab 完整显示。

`must`：上游的 `.hud-grow` 在两行布局里必须 `display: none`。它是弹性占位符，留着会抢走一整行（实测把品牌区挤到右上角、左侧空一大块）。

## Alternatives considered

- **直接改 `agent-notes-board.html`** — 最直接，改几行 CSS 就完事，也不用维护注入逻辑。否掉是因为它违反 AGENTS.md 硬约束 3：那是 vendored 上游副本，手改会被 `verify-plugin.mjs` 的哈希比对拦下，而且下次 `npm run sync` 合并上游时改动会被覆盖或产生冲突。适配是**本插件对宿主的适配**，本来就不属于上游资产。
- **fork 一份看板 HTML 改好再 vendored** — 能自由改样式且不违反「不手改」的字面约束。否掉是因为它把「跟随上游」的收益彻底丢掉：上游每次改进 UI 都要手工合并两份分叉，正是当初选择 vendored 上游成品而非自绘 UI 时要避免的成本。
- **在 iframe 外层用 CSS `zoom` 或 `transform: scale()` 整体缩小** — 一行就能让内容塞进窄容器，改动最小。否掉是因为它只是把「挤扁」换成「变小」：文字缩到 8px 依然不可读，而且缩放后点击热区与滚动条位置都会失真。问题出在布局不换行，不在尺寸。
- **让侧边栏 tab 不用 iframe，改成原生 React 渲染** — 能直接吃宿主的容器宽度，响应式由 React 组件自己控制。否掉的理由与上一轮「不用 iframe」相同：看板 UI 是 76K 的上游成品（多维筛选、因果链路、看板视图），重画必然与上游越走越远。为了一段响应式样式换掉整个渲染方式，代价与收益不成比例。
- **只在 ≤720px 做两行布局，不处理 720–900px** — 更少的覆盖代码，且 720–900px 只是「有点挤」还没到竖排。否掉是因为实测 760px 下 brand-group 仍是 77px 高（正常约 32px），deck-tabs 95px —— 已经在折行了，只是没到最难看的那一档。留着不管等于把明显的问题留在中间宽度。

## Consequences

- **收益**：右侧栏 400–700px 区间从「不可读的竖排单字」变成正常布局。实测各宽度 header 子项高度回落到 32/39px，页面无横向溢出。
- **收益**：vendored 资产零改动，`npm run sync` 合并上游时不会产生冲突；上游若自己补了响应式，这段覆盖最多变成冗余而不会打架。
- **收益**：注入层是独立模块（`lib/board-responsive.js`），可单测、可幂等、失败时原样返回，不成为功能前提。
- **代价与已知上限**：多了一层「上游 HTML + 宿主覆盖 CSS」的耦合。覆盖样式依赖上游的类名（`.hud-topbar`、`.deck-tabs`、`.hud-grow` 等），**上游改类名时这些选择器会静默失效** —— 样式不报错，只是不再生效，退回竖排。这是这套方案最脆弱的地方。
- **代价与已知上限**：`≤480px` 时 KPI 降为单列，信息密度下降（原本两列）。这是为了不让 38px 数字与中文标签互相顶，属于刻意的取舍。
- **代价与已知上限**：`≤420px` 时导航条需要横向滑动才能看到最后一项（实测 nav `scrollWidth 410 > clientWidth 394`）。这是有意的 —— 四个 tab 挤进 400px 必然折行，横向滚动比折行可读。
- **代价与已知上限**：幂等判据从「找 id 子串」收紧成「找完整 style 标签」后，判据与 HTML 结构绑定得更紧。若将来改注入形式（例如改用 `<link>`），`hasInjectedStyle()` 必须同步改，否则会重复注入。
- **重访信号**：若某天上游改版导致顶栏再次竖排，先查类名是否变了（`lib/board-responsive.js` 的选择器是否还命中），而不是怀疑注入没生效。探针 `.probe/measure-board.mjs` 能直接量出各宽度的实际高度。

## Verification

```sh
node --test tools/board.test.mjs    # 含注入内容、位置、幂等、上游字节不变
```

实测手段（`.probe/measure-board.mjs`，按仓库约定探针目录不入库）：无头 Chrome + CDP，
在指定宽度下量 `getBoundingClientRect`，排除抽屉与可滚动容器的正常溢出，并出截图。

```sh
BOARD_SID=<sessionId> node .probe/measure-board.mjs 652 1262
```

故障注入（已实测，三次都真红）：去掉 `height: auto` → 变红；完全不注入 → 变红；去掉幂等判断 → 变红。
宽屏回归：900/1100/1440px 下 header 高度仍为 64px、无溢出，与上游一致。
