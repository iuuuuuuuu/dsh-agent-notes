# Agent Note: config 开关必须被注入成非默认值才算测过

Status: implemented

> 同域：`apply()` 编排层的覆盖。
> 它的浏览器半边的分层见
> [2026-10-19-logic-in-node-rendering-in-chrome.md](../testing/2026-10-19-logic-in-node-rendering-in-chrome.md)，
> 它内部的注册状态机缺陷见
> [2026-10-19-registration-state-must-record-results.md](../bug-fix/2026-10-19-registration-state-must-record-results.md)。

Independent: 本篇只讨论 `lib/index.js` 的 config 开关组合与测试外壳复用，不涉及浏览器渲染，也不涉及注册状态机语义。

## Problem

`apply()` 有六个可配项：`enabled`、`injectPolicy`、`registerTools`、`registerCommands`、`stateFile`、`notesRoot`（另有 `skillDir` 供测试注入）。但 `integration.test.mjs` 里 10 个用例几乎都写 `config: { enabled: true }` —— **其余五项从未被显式设成 false 或自定义值**。

这留下一个真实的失效面：把 `if (resolved.injectPolicy)` 改成 `if (true)`、把 `registerTools` 的默认值从 `true` 翻成 `false`，现有测试**全绿**。因为它们只看默认路径，而默认路径恰好两边都走得通。

更隐蔽的是我第一版补测也差点白写。写完 8 个用例全绿，做故障注入时三条仍然绿：

1. **`enabled` 默认值** —— 我只断言了「provider/tools/commands 被注册」，可这三样与 `enabled` 无关。默认值翻成 `true` 完全测不出来。
2. **`injectPolicy`** —— 我给会话的上下文是 `ctx: {}`，**没有 `systemPrompt.section`**。于是无论 `injectPolicy` 是真是假，section 都挂不上，断言「没有 section」在任何实现下都通过。
3. **`notesRoot`** —— 我写了 `if (roots !== undefined) { ... }` 这种软断言，且 `command.notes` 根本不存在（命令描述符不暴露 notes 服务）。等于什么都没断言。

三条的共同形态：**断言在「什么都不会发生」的情况下也成立**。这和「提前返回导致断言恒真」是同一个病，只是更隐蔽——因为用例名看起来是在测那个开关。

## Decision

`must`：**每个 config 开关都必须被注入成非默认值，并断言行为真的变了。** 只测默认路径等于没测那个开关。

补上 `tools/config.test.mjs`（8 个用例），逐个开关注入非默认值：

| 开关 | 注入值 | 可观测证据 |
|---|---|---|
| `enabled` | 不传（默认） | 新会话**不**挂规范段（对照组：传 `true` 时挂上） |
| `registerTools` | `false` | `registered.tools` 为空，命令仍在（两开关独立） |
| `registerCommands` | `false` | `registered.commands` 为空，工具仍在 |
| `injectPolicy` | `false` | 会话带可用 `systemPrompt` 时仍不挂 section（对照组：`true` 时挂上） |
| `stateFile` | 自定义路径 | 跑 `off` 命令后该路径上真的出现文件 |
| `notesRoot` | 自定义路径 | 跑 `init` 命令后笔记树真的建在那个位置 |
| 全关组合 | 四项全 false | 仍然不抛错 |

两条对照组（`injectPolicy`、`enabled`）是刻意加的：**证明「路径本身是通的」**。否则「没挂 section」可能只是因为没有 `systemPrompt`，而不是因为开关生效。

`must`：嵌套开关的验证要**证明正反两面**。只验「关掉后没有 X」，无法排除「X 本来就是坏的」。

同时把 `integration.test.mjs` 的挂载外壳抽成 `tools/harness.mjs`，两份测试共用。外壳（含真 Cordis 优先、退化承接器）不是被测对象，两处各写一份会让它成为不一致来源 —— 那种漂移的表现是「一份测试绿、另一份红」，而问题既不在产品代码也不在任何单个用例里。

## Alternatives considered

- **直接在 `integration.test.mjs` 里加用例，不新建文件** — 省一个文件、不必抽外壳。否掉是因为那会让集成文件同时承担两种意图：「挂到宿主上会怎样」与「config 组合差异」。混在一起后，想查「`registerTools:false` 覆盖了没有」要在 20 个用例里翻。分开后 `config.test.mjs` 的文件名本身就是「这里只测配置差异」的说明书。
- **抽外壳时保留两份拷贝（各文件自持一份）** — 避免为一个测试文件引入共享模块。否掉是因为外壳里有非平凡逻辑：真 Cordis 探测（`$DSH_DIST`、向上找 `node_modules`、退化标注）、技能沙箱清理、事件监听记录。任一处修 bug 都要改两遍，漏改就出现两套行为。这次抽的时候立刻发现 `emit` / `tempState` 需要导出，说明它们本来就是共用件。
- **用真实 DSH 起服务做端到端配置验证** — 最接近生产。否掉是因为它要求本机有可运行的 DSH（`npm run check` 的硬约束是不依赖 DSH，那部分单独在 `check:full` 里），而且起服务要数秒到数十秒。config 差异是纯编排逻辑，同契约承接器足以判定，成本差一个数量级。
- **`notesRoot` 通过读内部字段（`command.notes.roots()`）验证** — 写起来最短。否掉是因为那个字段不存在，我当时是猜的；即使存在也是私有实现细节，改一次内部结构就失效。改用 `init` 命令真建目录、断言目录真的出现在自定义位置上 —— 这是唯一不可伪造的证据。

## Consequences

- **收益**：六个 config 开关全部有「注入非默认值 + 断言行为变化」的覆盖，全部 6/6 故障注入变红。
- **收益**：两条对照组让「没发生」变得可信。这比单加一个断言更有价值：它把「这个用例会不会因为路径不通而恒真」这个疑问从每次复查都要重新想，变成测试自己回答。
- **收益**：`tools/harness.mjs` 消除了外壳重复。`integration.test.mjs` 的 10 个用例在重构后一个不差地保持绿，说明抽取没有改变语义。
- **收益**：`config.test.mjs` 已登记进 `tools/fault-injection.mjs` 自证清单（现 9 道）。
- **代价与已知上限**：`config.test.mjs` 依赖 `mountHarness` 的 `mode`——真 Cordis 可用时走 Cordis，不可用时走承接器。两条路径的 `ctx.inject` 语义有细微差别（真 Cordis 缺服务时静默不回调，承接器则要求依赖齐备才回调）。当前用例在两种模式下都通过，但**若将来出现「只在承接器模式下红」的用例，要先把承接器的注入语义对齐真 Cordis**，而不是改测试迁就它。
- **代价与已知上限**：`notesRoot` 的验证依赖 `init` 命令真的写磁盘，因此该用例有 I/O、比其它几条慢一个量级（约 28ms vs 10ms）。可以接受，但若将来这个文件变得很大，这条该单独分组。
- **重访信号**：`apply()` 新增 config 项时，`config.test.mjs` 必须同步加一行——否则新开关会重蹈「从未被注入过」的覆辙。这个约束没法自动检查（无法从代码推断「某个 config 项该有什么行为」），只能靠这张表格在 review 时被人翻到。

## Verification

```sh
node --test tools/config.test.mjs        # 8 个用例
node --test tools/integration.test.mjs   # 抽外壳后仍 10/10
npm test                                 # 全量 208 个用例
```

故障注入（已实测，6/6 全部变红）：把 `enabled` 默认值翻成 `true`、`registerTools` / `registerCommands` 恒为 `true`、`if (resolved.injectPolicy)` 改成 `if (true)`、`stateFile` / `notesRoot` 改传 `undefined` —— 每一次都有对应用例变红。
