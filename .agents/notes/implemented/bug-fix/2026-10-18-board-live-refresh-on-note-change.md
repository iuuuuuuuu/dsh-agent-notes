# Agent Note: 笔记改了页面不刷新 —— 热更新由宿主补，不靠上游目录句柄

Status: implemented

## Problem

改了磁盘上的笔记，看板页面纹丝不动，必须手动刷新才看到新内容。

**上游其实有自动同步**，读源码能看到两处：

```js
window.addEventListener('focus', () => { if (Core.dirHandle && …) triggerLiveSync(true); });
setInterval(() => { if (Core.dirHandle && …) triggerLiveSync(true); }, 5000);
```

问题是两条都被同一个前置条件挡死了 —— `triggerLiveSync()` 第一行：

```js
async function triggerLiveSync(silent = false) {
  if (!Core.dirHandle) return;
```

而 `Core.dirHandle` 只在用户**手动点「连接本地目录」并用 File System Access API 授权**之后才会赋值。侧边栏走的是服务端注入 `window.__INLINE_DATA__` 这条路，启动分支是：

```js
if (window.__INLINE_DATA__ && window.__INLINE_DATA__.length) {
  ingestDataset(window.__INLINE_DATA__);   // ← 只渲一次，从不设置 dirHandle
}
```

于是 focus 与 5 秒轮询永远空转。

实测确认（CDP 驱动真实页面，未动鼠标）：

| 观测 | 修复前 |
|---|---|
| `Core.dirHandle` 是否存在 | `false`（注意 `Core` 是 `const`，不在 window 上，探针要改走 DOM）|
| 改文件后页面出现新内容 | `false` |
| 轮询次数 | 0 |

## Decision

在宿主注入层补一条轮询，用上游自己的入口重绘。

**服务端**（`lib/board-route.js`）：新增 `GET /agent-notes/data`，只返回 `{ revision, notes }`。不返回 HTML 外壳 —— 页面每 4 秒拉一次，76KB 的外壳没必要重传。

`must`：`revision` 必须是**内容指纹**（`revisionOf()` 对渲染字段做 sha256），不能是「篇数」或「mtime」。只比篇数时改一篇内容察觉不到（正是本次的 bug）；只比 mtime 时部分编辑器保留 mtime 会漏掉。已由 `revision 只比篇数会漏掉内容修改` 这条测试钉住，它对 problem / decision / alternatives / consequences 四个字段**逐个**断言。

**前端**（`lib/board-responsive.js` 的补丁脚本）：每 4 秒拉 `/data`，比对 `revision`，变了才调上游的 `ingestDataset(notes)`。

`must`：首次拿到指纹**只记录不重绘** —— 页面刚由内联数据渲染过，同内容重绘纯属浪费，还可能打断用户操作。

`must`：**加载后立刻要探一次**（IIFE 末尾直接 `poll()`）。这是实际踩过的坑：只等 4 秒周期的话，那一次请求拿到的已经是最新内容，而「首次只记录不重绘」会把这个变化直接吞掉 —— 表现为「轮询在跑（`polls` 在涨）但页面永远不更新」。这个 bug 很难从现象上分辨，是靠把 `polls` / `applied` 两个计数器暴露到 `window.__agentNotesLive` 才定位到的。

`must`：端点 URL 由当前路径推导（把最后一段 `ui` 换成 `data`），**不能**直接 `location.pathname + 'data'` —— 那得到 `/agent-notes/uidata`，实测 404，轮询静默失效。

`must`：也不写死 `/agent-notes/data`。路由前缀是插件常量，写死会在前缀变化时指向别处。

`must`：页面不可见时跳过请求（`document.hidden`），别让后台 tab 空转。

> **后续（2026-10-18，同日）**：上面这条判据**不够**。实测发现 iframe 被宿主
> `display:none` 之后 `document.hidden` 仍是 `false`，轮询照跑不误。
> 已改用 `IntersectionObserver` 按「是否真的渲染」门控，见
> [2026-10-18-poll-only-when-rendered.md](2026-10-18-poll-only-when-rendered.md)。
> 本笔记保留轮询机制本身的记录；可见性判据以新笔记为准。

**可观测性**：脚本把 `{ polls, applied, revision, failures, error }` 挂到 `window.__agentNotesLive`。排查「热更新没生效」时先看这里 —— `polls` 不涨说明轮询没跑，`polls` 涨但 `applied` 不涨说明指纹没变或首次吞掉了。

## Alternatives considered

- **直接用 `location.reload()` 定时刷新页面** — 一行就能「看到新内容」，最简单。否掉是因为它会打断用户：正在读的抽屉会关掉、滚动位置丢失、筛选与搜索状态全部重置。看板是阅读工具，每次更新都把阅读位置清零是不可接受的。
- **上 SSE / WebSocket 推变更，而不是轮询** — 更实时、更省流量，技术上更优雅。否掉是因为收益与成本不成比例：笔记变更频率是「人写代码时改几份文档」级别，4 秒延迟完全够用；而 SSE 要在 DSH 的 webServer 上多挂一条长连接路由、处理重连与心跳、还要在插件卸载时正确清理，复杂度和出错面都高一档。轮询用现成的 `fetch` + 一个 16 位指纹，实现只有十几行。
- **在服务端渲染时把数据也塞进 HTML，让用户 F5** — 等价于「不改」，只是把刷新责任推给用户。否掉是因为用户的原话就是「不会自动扫描到变更」，他要的是自动。
- **自己写一份渲染逻辑，不调上游的 `ingestDataset`** — 能完全控制重绘范围。否掉是因为看板的渲染耦合了引用计数（`Core.inCount`）、排序、四个视图的状态，自己重画必然与上游漂移；调上游现成入口，引用图谱与视图都会正确跟着更新。
- **按 mtime 判断变化，不读内容** — `fs.stat` 比读全文便宜，看似更高效。否掉是实测过其不可靠：部分编辑器写文件会保留 mtime，改了内容却看不出；而且笔记跨多个 worktree 根合并，mtime 来源与精度都不统一。指纹按渲染字段算，代价是每次请求多读一遍文件 —— 5 篇笔记量级下完全可忽略（实测 `/data` 响应 < 10KB，本地读取亚毫秒）。
- **首次拿到指纹时也重绘一次** — 少一个分支，逻辑更简单。否掉是因为页面刚被内联数据渲染过，同内容重绘一次纯属浪费，而且如果用户此时正打开抽屉，重绘会把它刷掉。

## Consequences

- **收益**：改笔记后页面自动更新，四个视图（架构基线 / 演进时间线 / 避坑智库 / 决策清单）与抽屉都会跟着变。CDP 实测：`applied: 1`，四个视图逐项断言全部 `true`。
- **收益**：无变化时零重绘 —— 用户正在看的滚动位置、打开的抽屉不会莫名跳动。指纹比对在服务端算，页面只比一个字符串。
- **收益**：状态可观测（`window.__agentNotesLive`）。下次「热更新不生效」时不必再靠猜测，先看 `polls` 与 `applied` 就知道断在哪一环。
- **代价与已知上限**：多了一条 4 秒一次的轮询。本地 HTTP、响应 < 10KB、页面不可见时跳过；对笔记这种低频变更的场景完全够用，但如果有人把它当成实时协作工具会显得滞后。
- ~~**代价与已知上限**：`revisionOf()` 依赖字段清单~~ —— **已于 2026-10-23 兑现并修复**：当时
  预言的「上游加字段就察觉不到」，在 `slug` 与 `rawBody` 上**已经发生**（`buildInlineData()`
  一直在给这两个字段，清单里两个都没有），只改正文里四个小节之外的部分时页面静默不刷新。
  判据已改成「字段名排序后全量计入、不维护清单」，见
  [`./2026-10-23-fingerprint-must-not-keep-a-field-list.md`](./2026-10-23-fingerprint-must-not-keep-a-field-list.md)。
- **代价与已知上限**：轮询依赖 `/data` 端点存在。若将来 `registerBoardRoutes` 的依赖注入方式变化（`notesRootFor` 改名等），这条链路要一起改。
- **代价与已知上限**：本 Note 讨论的是「页面已打开时」的更新；页面本身仍是服务端渲染的 HTML，首次加载依旧走 `/ui`。

## Verification

```sh
node --test tools/board.test.mjs
```

新增四条测试：
- `/data 端点返回数据 + revision，且 revision 随内容变化` —— 断言同内容指纹稳定、改内容指纹变；
- `revision 只比篇数会漏掉内容修改` —— 对四个小节字段逐个断言，防止只把某一个算进指纹；
- `热更新脚本必须轮询 /data，并调用上游 ingestDataset` —— 断言端点推导方式、`setInterval`、`window.ingestDataset`、`document.hidden`、以及**加载后立刻 `poll()`**；
- 既有 `抽屉补丁脚本必须注入…` 仍覆盖脚本注入位置。

故障注入（全部实测真红）：
- 去掉 IIFE 末尾的 `poll()` → 变红；
- 端点改成 `location.pathname + 'data'`（得到 `/agent-notes/uidata`）→ 变红；
- 不调 `window.ingestDataset` → 变红；
- `revisionOf` 里漏掉 `problem` 字段 → 变红。

端到端（`.probe/` 内的探针，不入库）：CDP 驱动真实页面，改文件写入哨兵标题后等两轮轮询，再逐个视图断言哨兵可见 —— baseline / directory / timeline / alternatives 全部 `true`。

排查过程中值得记住的一条：**「轮询在跑」与「页面更新了」是两件事**。我曾看到 `polls` 在涨就以为链路通了，实际 `applied` 一直是 0 —— 因为首次请求就拿到了最新内容，而「首次只记录不重绘」把它吞了。把这两个计数分开暴露，才定位到根因。
