# Agent Note: 注册状态要记「实际结果」，不是「上次想让它怎样」

Status: implemented

> 同域：本篇处理**开关驱动的注册状态记账**。`component` 必须转交宿主 props 见
> [2026-10-17-sidebar-tab-drops-host-props.md](./2026-10-17-sidebar-tab-drops-host-props.md)
> （那篇的 `## Consequences` 已经预言过「桩 React 写得太弱会让测试重新变成假绿」，
> 本篇就是这句话的第二次应验）。
> 「解析不出仓库时怎么报」见
> [2026-10-17-board-409-readable-notice.md](./2026-10-17-board-409-readable-notice.md)。
> 零覆盖这件事的起点见
> [2026-10-19-runtime-layer-had-zero-coverage.md](../testing/2026-10-19-runtime-layer-had-zero-coverage.md)。

Independent: 这里讨论的是 `syncHost` 的状态机语义与「一次瞬时故障会不会变成永久故障」，不涉及 props 如何转交，也不涉及路由如何报错。

## Problem

「笔记」看板 tab 由常驻在输入框里的开关组件按投影状态驱动注册/注销。它的状态机原本写成：

```js
if (host.enabled === enabled) return;   // ← 早退
host.enabled = enabled;
if (enabled) {
  if (host.dispose === null) {
    try { host.dispose = host.register(); } catch (e) { /* 忽略 */ }
  }
}
```

问题出在**注册抛错**这条路径：`host.enabled` 已经被记成 `true`，但 `host.dispose` 仍然是 `null`（注册没成功，自然没有 disposer）。此后每一次同状态的对齐都会被执行到那行早退挡掉，于是一次瞬时故障就变成了**整场会话的永久故障** —— 看板 tab 再也不出现，用户只能靠反复点开关才可能碰巧恢复，而界面上没有任何提示说明发生了什么。

这行早退的意图是「避免重复注册」，但它把**意图**当成了**结果**来记账。

### 为什么原有测试没拦住

严格说，当时**根本没有测试**覆盖浏览器端 —— 这正是「运行时那一层零覆盖」的后续。补测时我先写了一版 6 个用例全绿的测试，然后才发现它们是假绿：

1. `apply(ctx)` 第一行就是 `if (slots === undefined || typeof slots.register !== 'function') return;`。我用空上下文测「宿主缺失不抛错」，等于在测那个 `return` 自己，`syncHost` 一次都没被调到。
2. `syncHost` 在 `createAgentNotesClient` 的闭包里，没有导出。我只能断言「我在测试里造的那个数组仍是空的」—— 那个数组在代码没跑的情况下当然也是空的。

也就是说：**断言的对象必须由被测代码产生，不能由测试自己产生**。这条和 `2026-10-17-sidebar-tab-drops-host-props.md` 里「不能只断言字符串存在」是同一个病的两个变种。

## Decision

`syncHost` 的判据一律看**实际结果**（`dispose` 是否为 `null`），不再看 `enabled` 记的意图：

```js
if (enabled) {
  host.enabled = true;
  if (host.dispose !== null) return;   // 已经真的注册上了才算幂等
  try { host.dispose = host.register(); } catch (e) { /* 注册失败不得影响开关 */ }
} else {
  host.enabled = false;
  if (host.dispose === null) return;   // 本来就没注册，无需注销
  try { host.dispose(); } catch (e) { /* 注销失败不得影响开关本身 */ }
  host.dispose = null;                 // 无论成功与否都复位，否则失败的那次会挡住重试
}
```

`must`：状态机记账记**可观测的结果**，不记「上一次期望的状态」。凡是有「尝试可能失败」的动作，失败后必须让状态回到可重试的位置。

`must`：`dispose()` 无论成功还是抛错，`dispose` 句柄都要复位为 `null`。不复位的话，一次注销失败会同时造成两个后果：tab 已经关不掉、并且再也不会重试去关。

代价写清楚：**注册持续失败时会重复尝试**。每次宿主重渲染都试一次，比「静默放弃」安全 —— 失败本身已经是异常路径，而静默放弃的表现是功能永久消失且无任何提示。

## Alternatives considered

- **把注册失败也记进 `enabled`，用一个三态（`null` / `true` / `false` / `'failed'`）区分** — 语义上最精确：「失败」和「未尝试」确实是不同状态，分开记能避免重复尝试。否掉是因为它把一条两行的状态机变成需要理解四种状态的小机器，而唯一的使用者只有 `syncHost` 自己。更重要的是，多出来的 `'failed'` 状态**不改变任何行为**：无论记成「失败」还是「未尝试」，下一步都只能是「再试一次」。为不改变行为的状态付复杂度，不划算。
- **在 `catch` 里安排退避重试（定时器或计数上限）** — 能避免「注册持续失败 → 每次重渲染都打一次」的最坏情况。否掉是因为重试的触发源本来就有：宿主每次重渲染、每次投影变化都会对齐一次，天然带节流，而失败原因是「宿主不认这个座位」这类基本不会自愈的情况，退避只是把同一次失败推迟。真要退避，得先有证据说明重复尝试有害 —— 目前没有，日志里也看不到（异常被吞是既定设计）。
- **不吞异常，让注册失败冒出去** — 能立刻暴露问题，省掉「静默降级」的排查成本。否掉是因为它违背这个插件的第一原则：**看板 tab 是附加功能，不能因为注册失败就让输入框里的开关消失**。开关能切换笔记规范，那才是核心；附件模块的故障不该拖垮核心。同理，`apply` 里两处 `slots.inject` 都包在 `try` 里。
- **只写测试，不改生产代码**（认为「瞬时故障」在实际使用中不常见） — 改动最小。否掉是因为它把一个可以两行修掉的脆弱点留在代码里，而代价是**故障发生时不可诊断**：用户看到的是看板 tab 不见了，日志里什么都没有，重启会话才好 —— 这类问题每次排查都要花掉远多于两行的时间。而且 `register` 抛错并非理论情况，宿主版本不认座位时就是这条路径。

## Consequences

- **收益**：一次注册失败不再让看板 tab 在整个会话里消失。故障恢复后，下一次投影变化或重渲染就会自动补上。
- **收益**：新增 `tools/client.test.mjs`（20 个用例），是这份浏览器端逻辑的第一份覆盖。它走 `apply` 的真实注册路径拿到组件，再真执行 `useEffect`，所以断言的副作用全部由被测代码产生。
- **收益**：`package.json` 补上了 `build` 脚本。`tools/verify-plugin.mjs` 早就有一条「`lib/client.js` 与 `src/client.js` 不同步」的门禁，失败提示写的是「请跑 `npm run build`」——**而那个脚本并不存在**。改完 `src/client.js` 的人照着提示跑会得到 `Missing script: "build"`。这条门禁因此实测红过一次（确认它真的会拦），再由补上的脚本变绿。
- **收益**：`tools/fault-injection.mjs` 的「每道新门禁必须带自己的故障注入」自证，从「文件存在即通过」改成「必须有 `test(...)` 用例且数量不为零」。原来那种检查对一个全是恒真断言的文件同样报绿 —— 本篇开头那版假绿测试就能大摇大摆通过。
- **代价与已知上限**：`src/client.js` 的闭包结构决定了测试必须绕过 `apply` 的真实路径去拿组件。这条路径依赖 `slots.inject('conversation.input.left', cb)` 的行为，若宿主改了座位名，测试会在 `harness()` 里以「拿不到开关组件」失败 —— 失败方向是好的（不会静默通过），但报错信息会指向测试而不是真实的缺陷位置。
- **代价与已知上限**：桩 React 仍在维护（`createElement` 必须就地展开函数组件，否则 `AgentNotesBoard` 里的 iframe 永远看不到）。这条陷阱已被两篇笔记分别记录，说明它是这个仓库的复发点，不是一次性问题。
- **重访信号**：若宿主支持「注册失败可被观测」（例如 `register` 返回 `Result` 而不是抛错），这段 `try/catch` 就应该改成显式分支，把失败原因留下来 —— 那会同时解决「静默降级不可诊断」这个遗留痛点。

## Verification

```sh
npm run build                          # 重建 lib/client.js（这条命令由本次改动补上）
npm run verify                         # 比对 bundle 是否与 src 同步
node --test tools/client.test.mjs      # 20 个用例
npm test                               # 全量 200 个用例
```

故障注入（已实测，13/13 全部变红）：把 `syncHost` 改回「意图当结果」→「注册失败后再次对齐会重试」变红；去掉 `dispose()` 的 `try` →「dispose 抛错时被吞掉」变红；把 `dispose = null` 复位删掉 → 同一用例变红；`component` 改回零参 → props 转交用例变红；投影键/命令名各自漂移 → 对应用例变红。
