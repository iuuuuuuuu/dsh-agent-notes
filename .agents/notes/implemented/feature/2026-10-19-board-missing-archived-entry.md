# Agent Note: 看板首页缺「已归档」入口 —— 补它要过三道真机才做成的

Status: implemented

> 与 [2026-10-19-logic-in-node-rendering-in-chrome.md](../testing/2026-10-19-logic-in-node-rendering-in-chrome.md)
> 同属「渲染验证」这条线。那一篇确立「`npm test` 管逻辑、`.probe/` 管渲染」，
> 本篇是那套分工的第一次实战：**三个关键结论全部来自真机，读代码一个都看不出来。**
> 注入机制沿用既有的 `DRAWER_PATCH_JS`，见同文件。

Independent: 本篇不改 vendored 上游 HTML，只在本仓库的注入层补一个补丁。

## Problem

Owner 发现看板看不到已归档的笔记。查证结果：**不是隐藏，是首页少了一个入口。**

### 数据层完全正常（实测）

```
buildBoard()      → byLifecycle 含 archived: 1，notes 含那条
buildInlineData() → 63 条全在，archived 那条字段完整
真机渲染          → 归档那条**确实显示**，带「已归档」徽标
```

### 但同一份 HTML 里，首页统计漏了它

上游 `renderBaseline()`（`:1069-1074`）只取三个 lifecycle：

```js
const implemented      = nodes.filter(n => n.lifecycle === 'implemented');
const proposed        = nodes.filter(n => n.lifecycle === 'proposed');
const rejected        = nodes.filter(n => n.lifecycle === 'rejected');
const simplifications = nodes.filter(n => n.cls === 'simplification');
```

首页那 4 张卡 = 现行落地 / 待评审提案 / 避坑否决 / 化简裁撤 —— **没有 archived**。

而归档在别处是完整支持的：
`:481` 有 `.st-archived` 徽标样式 · `:813` `LIFECYCLES` 含它 ·
`:814` `STATUS_LABELS.archived = '已归档'` · `:1477` 筛选器认它。

**结论：4 个 lifecycle 只显示 3 个，是遗漏不是设计。** 不点筛选下拉就找不到归档。

## Decision

在本仓库的注入层补一张「已归档」卡，不动 vendored HTML
（手改会被 `verify-plugin.mjs` 的哈希比对拦下）。

### 三个关键结论，全部来自真机

**① 上游会整体覆盖 `kpi-row`，所以「插一次」必然被抹掉**

实测采样（每 500ms 记一次，跑 8.5 秒）：

```
0ms:row=4  500ms:row=4  …  8000ms:row=4  card=NO
```

全程 `row=4`（上游一直在重渲染），最后卡片没了。原因是
`renderBaseline()` 每次做 `kpi-row.innerHTML = ...` —— **整体覆盖**，
而它有 5 秒一轮的热更新。

→ 所以必须用 `MutationObserver` 盯住，被覆盖就补回。
用 5 秒轮询会漏（上游可能刚好在两次轮询之间覆盖又恢复）。

**② `MutationObserver` 的回调是微任务，置标志位拦不住自触发**

第一版用 `busy` 标志抑制自触发，结果**页面直接卡死**（DOM 0 字节）。

原因：`inject()` → `appendChild` → 触发 observer → 微任务在同步块**结束后**
才执行 → 那时 `busy` 已被我置回 false → 又调 `inject()` → 无限循环。

→ 必须用 `disconnect()` / `observe()` 临时断开，**它不依赖时序**。

**③ 数据注入要转义 `<`**

`lib/board-route.js:360` 早就处理了：`.replace(/</g, '\\u003c')` +
函数式 `replace(marker, () => ...)`。

★ 本仓**真的有一篇笔记引了看板源码**（`board-409-readable-notice.md`），
其正文含 `<script` 与 `</script>` —— 所以那不是假设，是必需的。

## Alternatives considered

- **改上游 HTML**（直接给 `kpis` 加第 5 个元素）—— 最直接。**这是本篇最强的一条被否方案**，因为 `skills/agent-notes/assets/agent-notes-board.html` 是 vendored 内容，手改会被 `verify-plugin.mjs` 的哈希比对当场拦下。**要改必须推上游**，那是别人的仓库。
- **只在文档里写「归档笔记要用筛选器看」** —— 零代码。**否掉因为那把「界面少一个入口」当成「用户该知道」**。4 个 lifecycle 显示 3 个是遗漏，文档解释不修它。
- **`archived=0` 时把卡藏起来** —— 与其它 lifecycle 不一致（它们 0 也显示）。**否掉因为那又变成「有时有有时没有」**，而那正是本次要修的问题形态。
- **用轮询而非 MutationObserver** —— 更简单。**否掉因为上游 5 秒一轮，轮询会漏**（实测证明覆盖确实发生）。而且 `sample-kpi.mjs` 的采样显示上游**每轮都重渲染**，不是偶发。

## Consequences

- **收益**：4 个 lifecycle 在首页都可见了。归档笔记从「要点两次筛选下拉才找得到」变成「首页有入口」。
- **收益**：真机验证证明它**扛得住上游重渲染**（25 秒后仍在，跨过至少 3 轮）。
- **代价与已知上限**：补丁是**注入层**，上游升级 `renderBaseline` 的结构时可能失效（比如上游若改成增量更新而不整体覆盖，`disconnect/observe` 仍工作；若它改了 KPI 卡的类名或 id，卡片样式会不匹配）。**那时要重跑真机验证。**
- **代价与已知上限**：`tools/board-responsive.test.mjs` 的 6 条用例**不真起浏览器** —— 它们守的是「补丁源码含什么、注入是否发生、幂等」，**不是**「它在页面上活着」。后者由 `.probe/tmp/verify-arch-final.mjs` 做（不入库）。**这是有意的分工**：真机验证慢且不稳（实测连跑 4 次 Chrome 时第 4 次会因进程没退干净而行为不同）。
- **代价与已知上限**：改 `tools/board.test.mjs` 三处断言（脚本块数量、抽屉 MutationObserver 判据、剥补丁范围）。**都是把「补丁 1 个」这个写死的假设改成「补丁数」**，判据本身一个字没改 —— 但**这意味着原有测试不再能发现「有人加了第三个补丁却没更新断言」**。缓解：新增的 `board-responsive.test.mjs` 里有「注入同时包含两个补丁」与「每个补丁恰好一个」的用例。
- **重访信号**：
  - **上游升级后首页结构变了**（类名/id 改动）→ 卡片会不匹配，重跑真机验证。
  - **若上游自己补了 archived 入口** → 本补丁会与它重复，那时应删掉本补丁（判据：首页出现两个「已归档」）。
  - **若归档笔记数量增长到两位数** → 卡片数字变大，可能需要考虑布局（未验证）。

## Verification

```sh
node --test tools/board-responsive.test.mjs   # 6 条离线用例
node --test tools/board.test.mjs             # 34 条（含 3 处改窄的断言）
npm run check                                # exit 0，328/328
```

**真机验证**（`.probe/tmp/`，不入库）四个用例：

| 用例 | 期望 | 实际 |
|---|---|---|
| archived = 1 | 卡片出现、数字 1 | ✔ |
| archived = 0 | 卡片出现、数字 **0**（不是隐藏） | ✔ |
| 撤掉补丁 | 卡片消失（证明来自本补丁） | ✔ |
| **25 秒后** | 卡片仍在（跨 3 轮上游重渲染） | ✔ |

**★ 一条方法教训**（本篇踩了四次才做对）：

前三次验证全部失败，而**代码、注入位置、数据、DOM 都是对的**。真因是
**我的验证脚本自己有问题**（漏了生产的 `<` 转义 → `</script>` 提前闭合
脚本块 → 数据没注入）。

**验证注入行为时必须复用生产代码的那段**，否则验的是「我临时拼的 HTML」
而不是「用户看到的页面」。同理，两个 `null`（卡片不存在 / 浏览器崩了）
必须分开 —— 混为一谈会得出「门禁坏了」的错误结论。