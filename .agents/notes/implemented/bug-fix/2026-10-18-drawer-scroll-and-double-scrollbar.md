# Agent Note: 抽屉的两个上游缺陷，靠宿主注入修

Status: implemented

## Problem

看板详情抽屉有两个独立缺陷，都是上游 vendored 资产（`skills/agent-notes/assets/agent-notes-board.html`）自身的实现问题：

**① 打开新笔记不重置滚动位置。** 读到一篇笔记最底部 → 关闭 → 打开另一篇 → **从底部开始显示**，用户得自己滚回顶部。

**② 抽屉打开后背景仍能滚动。** `#drawer-console` 是 `position: fixed` 浮层，但打开时没有禁止背景滚动，于是页面一条滚动条、抽屉内一条 —— 内外双层，滚轮落到哪一层取决于指针位置。

实测证据（CDP 驱动真实页面，未动鼠标、未抢焦点）：

| 步骤 | 修复前 | 修复后 |
|---|---|---|
| 打开第 1 篇并滚到底 | `scrollTop = 1353`（`scrollHeight 2189` / `clientHeight 836`）| 同 |
| 打开第 2 篇 | `scrollTop = 1353`（沿用上一篇位置）| `scrollTop = 0` |
| 抽屉打开时 `body.overflow` | `visible` | `hidden` |
| 抽屉打开时 `html.overflow` | `visible` | `hidden` |
| 用户能否滚背景 | 能 | 不能（`canUserScrollBg: false`）|

根因（读上游源码确认，不是猜）：

- `openConsole()` 只做两件事：给 `#drawer-console` 加 `.open` 类、写 `location.hash`。全文搜索 `scrollTop` **零次命中**，而承载滚动的 `.console-body` 是 `overflow-y: auto`。
- 抽屉的 CSS 里没有任何 `body { overflow: hidden }` 之类的锁滚动规则。

## Decision

两处都**不改 vendored 资产**（AGENTS.md 硬约束 3：手改会被 `verify-plugin.mjs` 的哈希比对拦下，且 `npm run sync` 合并上游时会冲突），改在宿主注入层：

**① 锁背景滚动：两行 CSS，用 `:has()`。**

```css
body:has(#drawer-console.open),
html:has(#drawer-console.open) { overflow: hidden; }
```

`must`：**`body` 和 `html` 都要设**。只锁 `body` 时实测 `documentElement` 仍能滚（CDP 量到 `scrollTop` 可设成 400），第二条滚动条还在 —— 视口滚动在不同 UA 下由不同元素承担。

**② 重置滚动位置：一小段运行时脚本。**

用 `MutationObserver` 观察 `#drawer-console` 的 `class` 变化，一旦出现 `.open` 就把 `.console-body.scrollTop` 归零。

`must`：归零必须推迟到下一帧（`requestAnimationFrame`）。上游在同一个同步流程里先加 `.open` 再填 `innerHTML`，立刻归零会被随后的重排顶回去。

`must`：脚本插在 `</body>` 之前，不能放 `head` —— 它要 `querySelector('#drawer-console')`，早于 DOM 就绪会拿到 null。注入函数因此有**两个插入点**：样式进 `</head>` 前，脚本进 `</body>` 前。

**为什么不改用「改 openConsole」的方式**：那需要改写上游 JS（`node` 脚本内联在 HTML 里），等于手改 vendored 资产。观察 `class` 变化属于外部观察，上游改实现也不会冲突。

## Alternatives considered

- **直接改 `agent-notes-board.html`（在 `openConsole` 里加一行 `scrollTop = 0`、CSS 里加锁滚动）** — 最直接、最少代码，两处各一行就完事，也不必维护观察器。否掉是因为它违反 AGENTS.md 硬约束 3：该文件是 vendored 上游资产，`tools/verify-plugin.mjs` 用清单哈希比对，手改会变红；而且下次 `npm run sync` 合并上游时改动会被覆盖或产生冲突。这条约束正是为了让「跟随上游」这件事可持续。
- **用 CSS 的 `scroll-behavior` 或 `overscroll-behavior` 处理滚动位置** — 一行 CSS，不用写脚本，看起来更干净。否掉是因为它们解决的不是同一个问题：`overscroll-behavior` 管的是滚动链传递（滚到边界后要不要带动父容器），`scroll-behavior` 管的是平滑动画。**重置「打开时从头开始」是状态问题，不是样式问题**，CSS 表达不出来。
- **在抽屉外层再包一个 iframe / 用 sandbox 隔离** — 能彻底隔离滚动与样式。否掉是因为代价与收益完全不成比例：为了两条 CSS + 十行脚本，要多一层文档上下文、多一份数据传递、多一套通信，还要重新解尺寸与主题继承。而且它会让「看板跟随上游视觉」这件事变得更难。
- **等上游修复，本地先不动** — 两个缺陷都不影响数据正确性，只是体验差。否掉是因为已经向上游提了 issue（见下），但上游节奏不可控；而本地修复成本极低（CSS 两行 + 脚本十行），且完全不阻碍将来上游修好后删掉这段注入。用户也明确要求「我们的也解决一下」。
- **只锁 `body` 不锁 `html`** — 更少的覆盖规则，符合「最小改动」。这是**实际写过的第一版**，被 CDP 实测否掉：`bodyOverflow` 确实是 `hidden` 了，但 `documentElement.scrollTop` 仍能设成 400，`canDocScroll: true`。肉眼看不出来，只有量了才知道第二条滚动条还在。

## Consequences

- **收益**：两个缺陷都消失。CDP 实测：打开第二篇 `scrollTop = 0`；抽屉打开时 `html/body` 均 `overflow: hidden`、`canUserScrollBg: false`。截图确认背景变暗且只有抽屉内一条滚动条。
- **收益**：vendored 资产零改动，`npm run sync` 不会冲突；上游修好后，删掉 `DRAWER_PATCH_JS` 与那两条 CSS 即可，无需回滚别的东西。
- **代价与已知上限**：多了一个 `MutationObserver` 常驻观察一个元素的 class。开销可忽略（只在 class 变化时回调），但它是「外部补丁」，属于技术债 —— 理想状态是上游修掉。
- **代价与已知上限**：`:has()` 依赖 Chromium 105+ / Safari 15.4+ / Firefox 121+。DSH 用 Chromium，满足；不支持时这条规则整条失效，退化成上游原状（双层滚动），**不会把页面弄坏**（适配层刻意做成非功能前提）。
- **代价与已知上限**：锁滚动依赖上游继续用 `.open` 这个类名、且继续把滚动容器做成 `.console-body`。上游若重命名，脚本会静默失效（`querySelector` 拿到 null 就提前 return）。重访信号：抽屉再次出现「从底部开始」或「双层滚动条」时，先查这两个选择器是否还命中。
- **重访信号**：上游 issue 修好后，`DRAWER_PATCH_ID` 脚本与 `:has()` 那两条规则都可删除；删除时同步移除 `board-responsive: 抽屉补丁脚本必须注入…` 与 `…html 与 body 都要锁滚动` 两条测试。

## Verification

```sh
node --test tools/board.test.mjs         # 含补丁脚本注入位置、幂等、锁滚动规则
node .probe/drawer-scroll.mjs            # CDP 真机：滚动位置 + 双层滚动条（探针不入库）
```

故障注入（已实测，均真红）：
- 不注入补丁脚本 → `抽屉补丁脚本必须注入，且放在 body 末尾` 变红；
- 只锁 `body` 不锁 `html` → `html 与 body 都要锁滚动` 变红。

CDP 实测脚本流程：打开第 1 篇 → `scrollTop` 设到底 → 关闭 → 打开第 2 篇 → 断言 `scrollTop === 0`；再断言抽屉打开时 `html/body` 的 `overflow` 均为 `hidden` 且 `canUserScrollBg === false`。

> **后续（2026-10-18，同日）**：上游 commit `72573a5` 已修好这两个缺陷，
> 修法与本笔记的建议一致。注入层的两段补丁随之成为纯冗余，已删除 ——
> 见 [../simplification/2026-10-18-drop-redundant-drawer-patch-after-upstream-fix.md](../../archived/simplification/2026-10-18-drop-redundant-drawer-patch-after-upstream-fix.md)。
> 本笔记保留为「当时为什么这么修」的记录；当前实现**不再**包含这两段。

上游 issue：
- https://github.com/czm15053/write-notes-like-deepseek/issues/10
