# Agent Note: 外壳与门禁之间的两处「参数被吞」

Status: implemented

> 同一族形态的两个实例：调用方传了、中间那一跳丢了、结论还是绿的。
> 计数侧的同类缺陷见
> [2026-10-22-stray-notes-at-notes-root-are-invisible.md](2026-10-22-stray-notes-at-notes-root-are-invisible.md)；
> 环境类判据的同类缺陷见
> [2026-10-24-http-status-and-empty-comparison-must-not-pass.md](2026-10-24-http-status-and-empty-comparison-must-not-pass.md)。

## Problem

只读审计（`.probe/audit-notes-gate.md` 的 S4、`.probe/audit-tool-gates.md` 的发现 3）
在 `lib/notes.js` 里找出两处「参数传进来了却没生效」。

**一、笔记根解析了三处，优先级还各不相同。**

- 零篇预检用 `options.notesRoot ?? resolveNotesRoot(undefined, cwd)`（**不看** `options.env`）
- 真正 spawn 的门禁用 `options.notesRoot ?? gateEnv.AGENT_NOTE_ROOT ?? …`
- `runAllGates` 报告计数时又回到第一式

于是**只传 `options.env.AGENT_NOTE_ROOT`** 时：预检看树 A（有 1 篇）、
门禁验树 B（空）、计数报树 A ⇒ `passed: true` / `noteCount: 1`，
而三条门禁全是 `ok: 0`。**假绿**。

**二、取消信号传到一半就丢了。**

`lib/tools.js` 把宿主的 `exec.signal` 交给 `runGate`，`spawnCapture` 也支持
`signal`，但 `runGate` 转发时只传了 `cwd` / `env` / `timeoutMs`。
实测对照：同一个「睡 4 秒的假门禁」+ 300ms abort，`spawnCapture` **322ms 被
SIGKILL**，`runGate` 却跑了 **4324ms** 并以 `exitCode=0` / `passed=true` 收尾。

第三处是同一形态的边界：`spawnCapture` 只 `addEventListener('abort')`，
对**注册时就已经 abort** 的信号不会触发 —— 传一个已取消的信号等于没传。

## Decision

### 一、笔记根只解析一次，全程复用

实际有**四处**各自解析，优先级各不相同：

| 位置 | 原表达式 | 是否看 `options.env` |
|---|---|---|
| `runGate` 零篇预检 | `options.notesRoot ?? resolveNotesRoot(undefined, cwd)` | **否** |
| `runGate` spawn 前注入 `AGENT_NOTE_ROOT` | `options.notesRoot ?? gateEnv.AGENT_NOTE_ROOT ?? …` | 是 |
| `runAllGates` 报告计数 | `options.notesRoot ?? resolveNotesRoot(undefined, cwd)` | **否** |
| `createNotesService.runGate` / `runAll` | 无条件 `notesRoot: this.root(cwd)` | **否**（`this.root()` 只看服务选项与 `process.env`） |

修法：`runGate` 开头算一次
`notesRootResolved = resolveNotesRoot(options.notesRoot ?? options.env?.AGENT_NOTE_ROOT, cwd)`，
预检、守卫、`AGENT_NOTE_ROOT` 注入全用它；`runAllGates` 用**同一表达式**计数；
服务层把 `options.env.AGENT_NOTE_ROOT` 排在 `this.root(cwd)` **之前**。

`must`：**「同一份配置解析多次」本身就是缺陷。** 四处各自解析时，任何一处
漏掉一个优先级就制造出「预检看 A、门禁验 B」的假绿，而每一处单独看都是对的。
**服务层那一处最隐蔽**：它会无条件覆盖调用方传下来的根，于是「只传 `options.env`」
这个用法被静默忽略 —— 调用方以为在验 env 指的那棵树，实际验的是默认位置。

### 二、`signal` 一路传到底，且已 abort 的立刻生效

`runGate` → `spawnCapture` 传 `signal`（archived 分支里的 `git` 调用同样传）；
`spawnCapture` 在注册监听后补一句 `if (options.signal?.aborted === true) onAbort()`。

`must`：**取消是契约，不该依赖调用者恰好赶在窗口内。**
只挂监听不查 `aborted` 的实现，对「晚到的调用者」等于没传
——而那恰恰是最常见的一种（用户在门禁启动前就点了取消）。

## Alternatives considered

- **让 `runAllGates` 把 `runGate` 解析出的 `notesRoot` 收集回来再计数** — 只有一处解析，最彻底。**否掉因为耦合方向反了**：`runGate` 是独立可调用的（工具、命令、测试都直接调它），让它向 `runAllGates` 回传「我用了哪个根」会给单向调用加一个反向依赖；而「同一表达式在两处各算一次」在纯函数语义下结果一致，风险远小于新加的数据流。
- **给 `runGate` 加一个显式的 `resolvedNotesRoot` 参数由调用方传入** — 优先级定义只有一处。**否掉因为调用方会忘**：默认路径必须仍然正确，否则每加一个调用点就多一次「忘了传」的机会——那正是本缺陷的成因。
- **在 `lib/tools.js` 里补一次 abort 检查就够**（不改 `spawnCapture`）— 改动面最小。**否掉因为它只覆盖一条调用路径**：`spawnCapture` 是导出的公共函数，任何直接使用者都该得到同样的语义；而且「注册时已 abort」这个坑与调用方无关，属于被调方的责任。
- **把 `signal` 只在 `runAllGates` 层透传，`runGate` 不单独支持** — 少改一处。**否掉因为 `runGate` 是公开 API 且工具层直接用它**（`lib/tools.js` 调用 `runGate`），跳过它等于让最常用的那条路径继续吞参数。
- **顺带把 `notesRoot`/`env` 的优先级重排成「`env` 优先于 `options.notesRoot`」** — 也能消除不一致。**否掉因为会改既有语义**：显式参数优先于环境变量是更可预测的方向，重排会让所有显式传根的调用方行为翻转。

## Consequences

- **收益**：只传 `options.env.AGENT_NOTE_ROOT` 时不再可能「预检看树 A、门禁验树 B」。计数与校验对象重新对齐。
- **收益**：取消门禁真的会停。实测从 4324ms 降到被信号杀掉；且「已 abort」的信号也立刻生效。
- **收益**：`runGate` / `runAllGates` 的 JSDoc 补上了 `signal` 与 `notesRoot`，文档与实现不再脱节（这两处参数此前在类型注释里根本不存在）。
- **代价与已知上限**：解析表达式在 `runGate` 与 `runAllGates` 各写一次（同一形式）。若将来新增第三个解析点，需要人工对齐——本轮没有引入机械约束（例如把它抽成一个内部函数并在两处调用；抽函数也可以，但两处同形已经足够，且抽函数会让「优先级只有一个定义」这一点更隐晦）。
- **代价与已知上限**：**取消不改变门禁结论**。被取消的子进程返回 `exitCode=null` + `signal`，`runGate` 据此判 `passed: false`、`reason: 进程未正常结束` —— 也就是说取消会让门禁「红」，不会静默变绿。这是刻意的：取消不等于通过。
- **代价与已知上限**：S4 那条假绿**本仓库当前没有调用方**（只传 `env` 不传 `notesRoot` 的组合没人用），所以它是「潜在缺陷」而不是「正在发生的错误」。修复的价值在于关掉这个口子，而不是修好了一个正在骗人的输出。
- **重访信号**：
  - 若新增第三处解析笔记根 → 先看它是否复用了同一表达式。
  - 若将来支持「一次运行验多棵树」→ 解析必须改成显式传入，`??` 兜底会变成歧义。
  - 若宿主改为「取消后应当返回成功」→ 要重新定 `exitCode=null` 的判据（现在判红）。

## Verification

```sh
node --test tools/no-fake-green.test.mjs tools/notes-layout.test.mjs tools/plugin-tools.test.mjs tools/plugin.test.mjs
# 70 tests / 70 pass / 0 fail（接线改动落地前的基线，用于确认没打破既有断言）
```

**Lead 独立探针**（`.probe/lead-verify-wiring.mjs`，临时目录夹具，不碰本仓库笔记）：

**A) S4 —— 只传 `options.env.AGENT_NOTE_ROOT`，不传 `notesRoot`：**

```
修复前: passed=false noteCount=0 notesRoot=<cwd>/.agents/notes      ← env 被服务层盖掉
        tree:fail / format:fail / archived:fail（NO_NOTES_TREE）
修复后: passed=true  noteCount=1 notesRoot=<env 指的树>
        tree:ok(ok: 1 note(s) …) / format:ok(ok: 1 note(s) …) / archived:ok(ok: 0 archived …)
```

修复前不是假绿（三处都失败），而是**配置被静默忽略**：调用方以为验的是 env 那棵树。
修复后计数与门禁验到的是同一篇。

**B) 取消信号 —— 假门禁脚本（真子进程，睡 4 秒）：**

```
B1 运行中 300ms abort: 修复前 4324ms / exitCode=0 / passed=true
                       修复后  320ms / exitCode=null / signal=SIGKILL / passed=false
B2 传入时已 abort:     修复后   39ms / exitCode=null / signal=SIGKILL / passed=false
```

`must`：**取消会让门禁「红」，不会静默变绿** —— `exitCode=null` 判 `passed:false`。

**真变异**（把 `runGate` 传给 `spawnCapture` 的 `signal` 删掉）：
`✖ 取消信号必须真的传到子进程` —— `4166ms`、`exitCode=0`、`signal=null`。
还原后 19/19。

> 这条用例的第一版是**空转的**：假门禁脚本写成顶层 `await`，在 `.ts` 下解析失败、
> 子进程立刻退出，于是「耗时 < 2s + passed=false」轻松成立，而它什么都没验
> （把 signal 变异掉仍全绿）。改成 `setTimeout` 保持进程存活，并加
> `assert.equal(signal, 'SIGKILL')` 之后才真的会红。
> **教训：光看「用例是绿的」不够，得看它在变异下死不死。**
