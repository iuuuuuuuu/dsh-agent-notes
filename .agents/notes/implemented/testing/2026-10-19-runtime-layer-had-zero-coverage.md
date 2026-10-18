# Agent Note: 运行时层零覆盖的地方藏着一个从未能工作的命令

Status: implemented

> 同域：本篇补齐的是**运行时层（`lib/`）**的测试强度。
> 门禁层（`tools/`）的强度见
> [../process/2026-10-18-notes-coverage-gate.md](../process/2026-10-18-notes-coverage-gate.md)、
> [../process/2026-10-18-notes-supersession-check.md](../process/2026-10-18-notes-supersession-check.md)。
> 本篇发现的问题正是「只加固门禁、没顾运行时」的直接后果。

## Problem

前几轮一直在加固 `tools/`（门禁脚本），而 `lib/` 是用户天天用的运行时层。
实测统计覆盖情况：

| 文件 | 行数 | 直接测试覆盖 |
|---|---|---|
| `lib/commands.js` | 229 | **0** |
| `lib/tools.js` | 144 | **0** |
| 其余 13 个文件 | — | 各 1–3 个测试文件 |

`integration.test.mjs` 只验证「注册了一个命令 / 两个工具」，
**不验证任何分支行为**。

### 补上测试后立刻发现一个真 bug

`lib/commands.js` 里 `sync-skill` 分支调用了：

```js
const info = inspectProjectSkillCopy(cwd);
const result = syncProjectSkillCopy(cwd, { dryRun });
```

而**这个文件一个 import 都没有**。执行结果被外层 `catch` 包成：

```text
执行失败: inspectProjectSkillCopy is not defined
```

`/agent-notes sync-skill` 这个命令**从上线起就是坏的** ——
不是偶发、不是边界，是每次必坏。而它零测试覆盖，所以没人发现。

这条正是本轮目标的全部理由：**门禁层再严，运行时层的 bug 也不会自己暴露**。

## Decision

**① 用真实服务、只桩 DSH 外壳。**

两个测试文件都直接 `import` 真实的 `createStateStore` / `createNotesService`，
只把 Cordis 的 `ctx.inject` / `ctx.effect` / `commands.register` 桩掉。

**must**：不桩 state 与 notes。它们是纯本地逻辑（读写 JSON、spawn 脚本），
桩掉就等于在测一个不存在的插件 —— 那样即使全绿也不说明产品能用。

**② 每个断言都写「事实」，不只写 kind。**

一个永远 `return { kind: 'success' }` 的实现能通过所有只看 kind 的断言。
所以每条都断言文案里的**可验证事实**：

```js
assert.match(again.text, /原本就是该值/);        // 第二次设置必须承认没变化
assert.equal(box.state.session(agent), undefined); // 状态真的被清了
assert.equal(result.noteCount, 0);                // 空树时数量如实为 0
```

**③ 补上缺失的 import。**

```js
import { inspectProjectSkillCopy, syncProjectSkillCopy } from './project-skill.js';
```

补导入是修 bug，不是重构 —— 它让一个从未能执行的命令开始工作。

## Alternatives considered

- **只测「注册了什么」，沿用 `integration.test.mjs` 的写法** — 改动最小，
  也不必构造完整 ctx。否掉：那正是当前的状态，而它漏掉了一个**每次必坏**
  的命令。注册成功与执行正确是两件事。
- **桩掉 state 与 notes，让测试更快更可控** — 单测的常规做法。否掉：
  这两个服务是纯本地逻辑，没有网络、没有时序依赖，真实跑成本很低。
  桩掉它们的唯一后果是**测不到真 bug** —— 本轮那个 import 缺失就测不到。
- **`commands.js` 补 import 后不写测试，直接提交** — 修完就走。否掉：
  没有测试守着，下次有人删掉那行 import 仍会再次坏掉，而且同样没人知道。
- **把 `sync-skill` 分支删掉，改由 skill 文档描述** — 少一处代码。否掉：
  同步项目副本是个真实需求（项目有自己的 CI 门禁脚本副本），
  而且它已经有 `project-skill.js` 的完整实现，删命令只会让那部分实现失去入口。
- **只做故障注入，不写行为测试** — 「证明会红」看起来已经够。否掉：
  故障注入证明的是「测试能红」，不证明「被测行为正确」。
  两者都要：先有行为断言，再用故障注入证明那些断言不是恒真。

## Consequences

- **收益**：`/agent-notes sync-skill` 从**从未能工作**变成可用。
  这是本轮唯一的功能性修复，而它是靠补测试发现的。
- **收益**：`commands.js` 的 8 个分支（status / on / off / --global / reset /
  gate / init / sync-skill / 未知参数 / 异常兜底）全部有断言。
- **收益**：`tools.js` 的两个工具覆盖了每条返回路径，其中两条是
  **诚实性断言**：拿不到会话 cwd 时 `passed:false`、`cwd:null`，
  绝不退回 `process.cwd()`。那条约束以前只写在注释里。
- **代价**：多了两个测试文件、17 条测试，`npm test` 慢了一点。
- **代价**：mock 必须正确模拟 `sessions.get(id)?.header.cwd` 的结构。
  实测踩过两次：先漏了 `sessions` 服务（全部 `NO_SESSION_CWD`），
  再给了 `{cwd}` 而非 `{header:{cwd}}`（报「该会话尚未加载」）。
  这两次都**不是产品缺陷**，而是 mock 不完整 —— 已在注释里写明。
- **已知缺口**：`lib/index.js` 的 `apply()` 整体编排仍只有
  `integration.test.mjs` 的间接覆盖，没有针对「各 config 开关组合」的测试。
  重访信号：新增 config 项时。
- **已知缺口**：`client.js`（491 行，浏览器端 bundle）没有浏览器内测试，
  只有构建产物的哈希校验。重访信号：改动看板交互逻辑时。

## Verification

```sh
node --test tools/commands.test.mjs      # 10 项
node --test tools/plugin-tools.test.mjs  # 7 项
```

**故障注入四组，全部真红**：

| 注入 | 结果 |
|---|---|
| `commands.js` 的 `default` 分支改成返回 success | 1 项红 |
| `state.setSession` 的返回值恒为 true（掩盖「原本就是该值」）| 1 项红 |
| `tools.js` 的 `passed` 恒为 true | 1 项红 |
| `status` 的 cwd 退回 `process.cwd()` | 1 项红 |

四组都登记进 `fault-injection` 的自证清单（现共 7 项），
并实测确认清单本身能变红：把 `commands.test.mjs` 移走 →
`✖ tools/commands.test.mjs 不存在 —— 斜杠命令 agent-notes没有故障注入，不可信`。

全量：**180/180 测试通过**，`npm run check` 退出码 0。
