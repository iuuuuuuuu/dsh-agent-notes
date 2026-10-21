# Agent Note: 看板正文的表格被渲染成一段竖线文字

Status: implemented

> 同属「看板 UI 的宿主侧补丁」这条线，与本篇的邻居
> [2026-10-21-board-iframe-mount-prefix.md](./2026-10-21-board-iframe-mount-prefix.md)
> 一起看：那篇修的是看板挂在哪，本篇修的是挂上之后正文怎么渲染。
> vendored 资产不可手改这条硬约束的来由见
> [2026-10-21-vendored-integrity-gate-stops-trusting-itself.md](../process/2026-10-21-vendored-integrity-gate-stops-trusting-itself.md)。

## Problem

用户报：看板抽屉里的正文「该是表格的地方是一堆文字」。复现路径是读代码 + 离线跑真实上游函数：

上游看板的正文渲染是 `skills/agent-notes/assets/agent-notes-board.html:891` 的
`parseMarkdown()`。它只做五件事 —— 转义、围栏代码块、行内 code、`**bold**`、
相对链接 —— 然后把剩下的按空行切段、段内换行变 `<br>`。**没有表格分支。**

所以笔记正文里的 GFM 管道表格：

```
| 场景 | is_decode | is_timeout |
|---|---|---|
| A 读 body 超时 | true | true |
```

会变成一段 `<p>| 场景 | is_decode ...<br>|---|---|<br>...</p>` —— 表格语法全废。

为什么这不是边角情况：抽屉显示的正是 problem / decision / alternatives /
consequences 四段正文（`agent-notes-board.html:1409-1412`），而决策笔记里
对照表、判据表极常见。本仓库自己就有十几处（`inventory-46.md` 全篇是表、
`2026-10-19-live-evidence-path-verified.md:60-64` 的三行前提表等）。

## Decision

在宿主侧注入一段运行时补丁接管上游那个函数，不改 vendored 资产。

- 新文件 `lib/board-markdown.js`：导出 `MARKDOWN_TABLE_PATCH_ID`、
  `MARKDOWN_TABLE_JS`、`injectMarkdownTables(html)`。
- 接线在 `lib/board-route.js:374`：
  `injectMarkdownTables(injectResponsiveCss(withData))`。注入点在 `</body>`
  之前、上游脚本之后。
- 补丁只做「切块」：按表格边界把正文切开，表格自己拼 `<table>`，**其余文本
  原封不动交回上游** `original(chunk)`；单元格的行内格式也是先调上游、再剥掉
  它包的 `<p style="margin-bottom:10px;">…</p>`。这样转义规则、`md-deep-link`
  类、危险协议过滤都只有一份实现。
- 兜底：上游把 `parseMarkdown` 改名或改成 module 时，补丁**安静退出**（不接管、
  不抛错），坏的是表格，不是整个看板；列数不齐按表头截断/补空，不抛错。

为什么能接管：上游那段是**经典脚本**（`<script>`，不是 module），
`function parseMarkdown` 是函数声明 → 成为全局对象上的可写属性，后注入脚本
`window.parseMarkdown = …` 即生效；上游调用点写的是裸标识符，走全局查找。
对照 `const Core = {…}` 这类顶层 `const` 只建脚本作用域绑定、注入脚本触达不到
（`lib/board-responsive.js` 的 `ARCHIVED_CARD_JS` 注释记着这条）。
**补丁能成立仅仅因为它挂的是函数声明。**

## Alternatives considered

- **手改 vendored 的 `agent-notes-board.html`，给 `parseMarkdown` 加表格分支** —
  这是最省事的一条，改完立刻就好。否掉不是因为难，而是它会被
  `tools/verify-plugin.mjs` 的清单哈希比对拦下（AGENTS.md 硬约束 3），
  而且下次 `npm run sync` 会把改动冲掉：**一份随时会被上游覆盖的本地修改，
  比没有修改更危险**（它让人以为问题修好了）。
- **在插件里重写一整套 Markdown 渲染器，替换掉 `parseMarkdown`** — 能一次
  把标题、有序列表、引用、表格全补上。否掉因为那等于复制上游全部行内规则：
  转义、链接白名单、`md-deep-link` 交互都要跟着上游改，两边必然漂移，而漂移
  发生在「渲染」这种不容易发现的地方。**只补缺口、其余交回上游**，是这个
  取舍下代价最小的形态。
- **把表格当纯文本但加等宽样式，让竖线对齐看起来像表** — 零解析风险。否掉
  因为它只是让难看变得能看：中文宽度不等、单元格内没有换行与行内标记，
  和真表格的读法完全不同。用户报的就是「该是表格却成了文字」，不解决语义。
- **让笔记作者别写表格** — 成本最低，也最诚实的一条。否掉因为表格是决策笔记
  最有效的对照形式（判据表、备选方案对比），禁掉等于让人写更长的散文；
  而且约束落在写作者身上，门禁查不出来，会退化成口头规矩。

## Consequences

- **收益**：抽屉里的表格变成真 `<table>`（带 `thead`/`tbody`、对齐、行内标记），
  与正文其余部分同款渲染；`overflow-x:auto` 保证窄侧栏下不挤爆布局。
- **收益**：改动全部在插件自有 `lib/` 内，vendored 哈希门禁照旧能过，
  `npm run sync` 不会冲突。
- **代价与已知上限**：这是**服务端注入的字符串脚本**，不是模块 —— 它没有
  导入关系，靠 `window.parseMarkdown` 这个约定活着。上游若把渲染改成
  ES module 或改函数名，补丁会安静失效（表格退回文字），而**没有任何门禁会红**。
  故 `tools/board-markdown.test.mjs` 直接从 vendored HTML 里抽真实
  `parseMarkdown` 来跑：上游改名 → 抽取断言失败 → 用例红。这是唯一能自动
  发现「约定断了」的地方。
- **代价与已知上限**：只补了表格。标题（`##`）、有序列表、引用块、删除线
  仍走上游原逻辑（渲染成普通段落）。要补得一条一条加，每条都要重跑一次
  真机复核。
- **代价与已知上限**：单元格内的 `|` 必须作者自己写成 `\|`（GFM 规则），
  补丁不做猜测 —— 不转义就按分列处理。
- **重访信号**：若上游 `parseMarkdown` 改成 module / 改名 / 自己补了表格 →
  本补丁应删除（留着就是两份实现）；若笔记里开始出现有序列表与标题被当成
  正文的事故 → 按同一机制继续补。

## Verification

**离线用例**：`node --test tools/board-markdown.test.mjs` → 13/13 pass。用例从
vendored HTML 里抽真实的 `parseMarkdown` 源码来跑（连 `escapeHtml` 一起抽：
首跑漏了它，用例报 `escapeHtml is not defined`），所以上游改名/改口径会红。

**真故障注入**：把 `isDelimiterRow` 改成恒 `return false`（等于关掉表格识别）→
5 pass / 8 fail，红的正是五条与表格识别相关的用例；还原后 13/13，
`grep -c "return false;" lib/board-markdown.js` 与改动前一致（2）。

**真浏览器（不是用例里的字符串断言）**：`.probe/make-markdown-preview.mjs`
生成同一段 Markdown 的两份页面 —— 一份只有 vendored 渲染器（对照组），
一份再叠本补丁；`.probe/render-markdown-probe.mjs` 用真 Chrome
（`tools/find-browser.mjs` 定位，`--headless=new --dump-dom`）跑脚本后取回 DOM
与截图，并把布局度量写进页面（`#probe-metrics`）：

| 页面 | `tables` | `rows` | `headerCells` | `tableWidth` | `display` | 首行单元格宽度 |
|---|---|---|---|---|---|---|
| 对照（无补丁） | 0 | 0 | 0 | 0 | `null` | — |
| 有补丁 | 1 | 3 | 4 | 836px | `table` | 240 / 137 / 143 / 316px |

即：真排版成 4 列 3 行的表，列宽由内容撑开；非表格段落两页文本完全相同
（「这是一段普通正文…」）—— 证明补丁只切走了表格，没改其余渲染。

**上限（不折成绿）**：`--dump-dom` 证明的是结构与布局，**不是**「肉眼看着好看」。
本机浏览器扩展对 `file://` / 临时端口没有 host 权限，无法在扩展里直接截图；
能读图的是人。所以这条证据的边界是：**渲染行为已验证，视觉样式未由人复核**。
若样式（间距、深色底下的边框颜色）需要调，`TD_STYLE` / `TH_STYLE` 两处即可改。
