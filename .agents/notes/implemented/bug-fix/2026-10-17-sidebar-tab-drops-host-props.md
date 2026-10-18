# Agent Note: 侧边栏 tab 必须把宿主 props 转交给看板

Status: implemented

> 同域：本篇解决**宿主 props 转交**。**解析不出仓库时怎么报**见
> [2026-10-17-board-409-readable-notice.md](./2026-10-17-board-409-readable-notice.md)，
> **热更新为什么不靠上游目录句柄**见
> [2026-10-18-board-live-refresh-on-note-change.md](./2026-10-18-board-live-refresh-on-note-change.md)。
> 三条都在处理「看板跑在宿主侧边栏里」这个前提带来的边界问题。

## Problem

接入 dsh-better-sidebar 之后，侧边栏里点开「笔记」tab 显示 `{"error":"no notes root resolvable for this session"}`，整块空白。

根因是 `src/client.js` 里侧边栏 descriptor 的组件写成了**零参函数**：

```js
component: function () { return h(AgentNotesBoard, null); }
```

而 better-sidebar 是用 `createElement(descriptor.component, {ctx, store, scope, tab, visible, …})` 渲染的（`dsh-better-sidebar/lib/client.js` 的 RenderBoundary 那处），会话 id 只挂在 `scope.sessionId` 上。零参函数把整个 props 丢掉，`AgentNotesBoard` 拿不到 `scope`，于是 iframe 的 src 拼成 `?session=` 空串；路由按设计对空会话回 409。

`AgentNotesBoard` 内部其实已经写了读 `props.scope.sessionId` 的分支（为侧边栏准备的那段），只是值永远传不进来。

**为什么原有测试没拦住**：`tools/projection.test.mjs` 里那条断言是 `assert.match(bundle, /scope\.sessionId/)` —— 字符串确实在 bundle 里，所以永远为真。它验的是「代码里出现过这句话」，不是「值能不能流到 iframe」。这类断言对「props 被丢弃」完全免疫，属于假绿。

## Decision

`descriptor.component` 改为接收并转交宿主 props：`component: function (props) { return h(AgentNotesBoard, props); }`。两个宿主的会话字段来源因此都能到位 —— 内置 `conversation.view` 走顶层 `sessionId`，侧边栏走 `scope.sessionId`。

`must`：注册给第三方宿主的组件**不得忽略宿主传入的 props**。descriptor 的 `component` 契约是 `(props) => ReactNode`，宿主会把会话作用域放在 props 里；零参写法在宿主侧不会报错，只会静默降级成空数据。

`must`：验证这类接线不能只断言字符串存在。`tools/projection.test.mjs` 新增一条**执行真实路径**的测试：捕获 bundle 工厂 → 用桩 React 实例化 → 渲染开关让投影为「已开启」触发 `registerTab` → 拿 descriptor 调 `component({scope:{sessionId}})` → 断言最终 iframe 的 `src` 里带那个 id。桩 React 的 `createElement` 必须**就地展开函数组件**，否则看不到 `AgentNotesBoard` 内部渲染出的 iframe，「props 有没有传进去」就验不到。

同时给路由补了诊断区分（`lib/board-route.js`）：`?session=` 空串归一化成 `undefined`，409 响应里新增 `reason` 字段 —— `MISSING_SESSION_ID`（前端没传会话）与 `NO_NOTES_ROOT`（传了但解析不出仓库）。原先两种情况都回同一句话，把排查方向引向 sessions 服务，而真实原因可能在前端。

## Alternatives considered

- **在 `AgentNotesBoard` 内部再兜一层，从 `props.ctx` 里反查当前会话** — 这样即使 props 传的是空对象也能自救，看似更健壮。否掉是因为它把「组件契约」变成「猜上下文」：`ctx` 是插件上下文，不是会话作用域，反查出来的可能是错的会话（多标签页时尤其危险）。而且它掩盖了真正的缺陷 —— 宿主明明把 `scope` 递到了手边，绕开不用会让下一个接第三个宿主的人继续踩同一个坑。
- **让侧边栏 tab 不走 iframe，改成原生渲染看板** — 能彻底绕开会话 id 传递问题（数据可由组件自己按 `scope` 取）。否掉是因为这与本插件既定的取舍冲突：看板 UI 是 vendored 的上游成品，原生重画必然与上游越走越远，且维护成本翻倍。会话 id 传递是一行的事，不值得为此换架构。
- **保留字符串断言，只补一条「props 非空」的弱检查** — 改动最小，不必写 React 桩。否掉是因为它仍然验不到值能不能流到 iframe：props 传了但组件内部没用，同样会空白。实测证据是故障注入 —— 把 `component` 改回零参后，只有执行真实路径的那条测试变红，字符串断言毫无反应。
- **只修组件、不改路由诊断** — 修好传递后 409 不再出现，诊断区分似乎多余。否掉是因为这次排查被误导过：报错说「no notes root resolvable」，看的人第一反应是去查 sessions 服务与 `header.cwd`，而真实原因在前端。留着区分能把这个方向性误导的成本降下来，代价只是响应里多两个字段。

## Consequences

- **收益**：侧边栏的「笔记」tab 能正常显示看板。已用运行中服务下发的真实 bundle 做过端到端验证：`registerTab` 被调用、iframe src 带上真实会话 id、该 URL 返回 200 且内联数据里有笔记。
- **收益**：新测试对「props 被丢弃」这种缺陷真的会红 —— 已做故障注入（改回零参函数 → 该测试失败 → 还原 → 全绿）。
- **收益**：409 现在能区分「前端没传会话」与「后端解析不出仓库」，减少排查时的方向性误导。
- **代价与已知上限**：测试里的桩 React 需要维护（`createElement` 要展开函数组件、`useEffect` 要同步执行）。桩写得太弱会让测试重新变成假绿 —— 这已经发生过一次（最初 `useEffect` 写成空函数，开关永远打不开，测试以「没注册」的方式失败而非通过，但方向同样不对）。
- **代价与已知上限**：**浏览器目视验证仍未完成**。浏览器桥接在本轮不可用（`no browser extension is connected to the bridge`），所以「侧边栏里肉眼看到 tab 并点开」这一步没有做。端到端探针覆盖了数据链路（真实 bundle → 真实路由 → 真实数据），但覆盖不到布局、iframe 高度、宿主样式冲突这类只有肉眼能判断的问题。
- **重访信号**：若 better-sidebar 改了 `TabComponentProps` 的形状（例如会话 id 不再在 `scope` 上），`AgentNotesBoard` 的两处取值都要同步；探针 `.probe/sidebar-e2e.mjs` 是发现这件事的最快途径。

## Verification

```sh
node --test tools/projection.test.mjs     # 含「component 必须转交 props」执行式测试
node --test tools/board.test.mjs          # 含空 session 归一化与 reason 区分
```

端到端探针放在 `.probe/sidebar-e2e.mjs`（按本仓库约定，探针目录不入库），
它从运行中的 DSH 取真实 bundle 与真实路由，需要 DSH 在跑并传一个真实 sessionId：

```sh
node .probe/sidebar-e2e.mjs <sessionId>
```

故障注入（已实测）：把 `component` 改回零参函数 → `projection.test.mjs` 那条变红；把空串归一化去掉 → `board.test.mjs` 那条变红。
