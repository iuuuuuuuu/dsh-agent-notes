# Agent Note: 三道 vendored 门禁在空集合上是绿的 —— 用测试钉住这个事实

Status: implemented

## Problem

`skills/agent-notes/scripts/` 下三道 vendored 脚本在**零篇笔记**时都 `exit 0`。这不是推测，
是实测（空 `.agents/notes/`、`AGENT_NOTE_ROOT` 指向它）：

```
verify-agent-note-tree.ts        exit=0  ok: 0 note(s) tree and relative links verified
verify-agent-note-format.ts      exit=0  ok: 0 note(s) verified
verify-archived-agent-notes.ts   exit=0  ok: 0 archived note(s) verified, 0 seal(s) in manifest
```

这个事实是**两样东西的唯一存在理由**：`lib/notes.js` 的 `runGate` 里那套前置拦截
（`NO_NOTES_TREE` / `NO_NOTES_YET`），以及 AGENTS.md 里那句「别把它们单独接进 CI，
接 `npm run notes:gate`」。裸接进 CI 就是一条恒绿门禁。

而这个事实**原先没有任何测试直证** —— 只有 `tools/archive-baseline.test.mjs` 顺带覆盖了
archived 一条，且它测的是归档封印，不是空集合。两侧的退化都是安静的：

- 上游哪天把空集合判成失败 → 外壳里的空集合分支变成**死代码**，而没人发现它已经不必要，
  AGENTS.md 的告诫悄悄过期，仓库多一层没人需要的判断；
- 有人顺手删掉 `files.length === 0` 那个分支「简化」一下 → `notes:gate` 在零篇仓库上
  立刻变绿，**门禁本身变成恒绿**，CI 全程安静。

这与 [2026-10-19-gates-that-nobody-runs-are-not-gates.md](../process/2026-10-19-gates-that-nobody-runs-are-not-gates.md)
是同一类问题的另一面：那条讲「登记了但没人跑」，这条讲「**判据本身没人钉**」——
外壳红了，但没人能说出它凭什么该红。

## Decision

新增 `tools/notes-gate-vacuity.test.mjs`，用真子进程钉住这个事实，三重对照：

| 对照 | 被测对象 | 断言 |
|---|---|---|
| ① 裸脚本 | 直接 spawn 三道 vendored `.ts` | `exitCode === 0` **且** stdout 逐字等于那句 `ok: 0 ...` |
| ② 外壳内部 | `runGate(...)` / `runAllGates(...)` | `passed === false`、`reason` 匹配 `NO_NOTES_YET`、`exitCode === null` |
| ③ 外壳命令行 | `node tools/verify-notes.mjs` | 进程 `status !== 0`、`signal === null`、诊断指向零篇，且**不**同时打印「通过」 |

①与②的对照是全部价值所在：**同样的输入，裸脚本绿、外壳红。**
③证明这个差别不是 `runGate` 的内部实现细节，而是真的透到了 CI 唯一认的退出码上。

三条判定口径，逐条都有理由：

- **必须建出目录、零篇**（`NO_NOTES_YET`），而不是留空（`NO_NOTES_TREE`）。后者是另一条
  分支，已由 `tools/no-fake-green.test.mjs` 覆盖；只测前者才是本文件要钉的那条。
- **必须同时断言 stdout 那句原文**，不只比退出码。只比退出码会漏掉一种假绿：脚本在
  import 阶段就炸了、而某层包装把非零改写成 0，或脚本走到「什么都没查但打印成功」的分支。
  那句原文同时钉住「退出码是 0」与「它真跑到了结尾并宣布成功」两件事。
  三句原文是实测抄下来的，不是从代码里想当然写的。
- **必须加一条反向对照**：有一篇合规笔记时外壳真绿。否则上面的红可能只是「外壳一律报错」，
  一旦某天 `runGate` 因无关原因恒红，前三条会一起绿着骗人。

「非零 ≠ 按契约变红」：`signal === null` 的门槛沿用
[2026-10-21-crash-is-not-a-red-gate.md](2026-10-21-crash-is-not-a-red-gate.md) 的判据 ——
Windows 上子进程被信号杀掉时 `status` 是个 NTSTATUS 数值（实测见过 `3221226505`），
它当然非零，但那是崩了不是判定。

同批在 `tools/fault-injection.mjs` 的 `FAULT_SUITES` 登记该文件：那条反向完整性检查会按磁盘
对账，不登记就红（机制见
[2026-10-21-fault-injection-list-must-reconcile-with-disk.md](../process/2026-10-21-fault-injection-list-must-reconcile-with-disk.md)）。

## Alternatives considered

**上游修好之后删掉这条测试。** 最强的理由是：它钉的是一个**上游缺陷**。若上游某天让
`ok: 0` 变成 `error: 0 note(s)`，①会立刻红，而那时候外壳的拦截确实不再必要 —— 留着一个
断言别人 bug 的测试很奇怪，还会在同步上游时平白制造摩擦。否掉的原因：本文件真正要钉的是
**「外壳与脚本的判定必须不一致」这个不变量**，不是「上游必须错」。上游修好后 ①的
`ok: 0` 断言该由上游自己的测试负责，届时把 ① 改成断言「脚本的结论是空集合」、
把 ②③④ 留下即可，②③④ 现在就已经能独立表达价值。反过来，删测试的那次改动恰恰需要
有人来批准 —— 保留它就是保留那道批准关。这与
[2026-10-21-vendored-integrity-gate-stops-trusting-itself.md](../process/2026-10-21-vendored-integrity-gate-stops-trusting-itself.md)
是同一个姿态：不因为「上游会守规矩」就不验证它。

**只测 ①，不测 ②③。** 改动最小，一个文件都不用碰，`ok: 0` 那三句原文断言就足够钉住事实。
否掉的原因：①单独成立时，它证明的只是「脚本今天是这样」；而仓库真正依赖的是**由此推出
「所以要绕开它们」**这一步。①红了而②③没人管，`notes:gate` 依然可能在零篇仓库上报绿，
而那才是会被真实用到的通路。价值全在对照上。

**并进 `tools/no-fake-green.test.mjs`，不新建文件。** 那个文件已经在测空树判红，主题看起来
高度重合，还省一个文件、少一条 `FAULT_SUITES` 登记。否掉的原因：那篇测的是**外壳的输出**
（`passed === false` + `reason`），从不跑 vendored 脚本；本篇测的是**脚本与外壳的差**，
必须自己 spawn 裸脚本才能拿到那条基线。合成一篇会让「谁在验什么」变得要读全文才分得清 ——
而判据来源正是这次要防的那类漂移，见
[2026-10-19-self-review-found-three-silent-gaps.md](../process/2026-10-19-self-review-found-three-silent-gaps.md)。

**用 `runAllGates` 的 `noteCount === 0` 一句话代替三道逐条断言。** 代码量最少。
否掉的原因：`noteCount` 是 `inspectTree` 的结论，不是脚本的退出码；脚本崩了它照样是 0。
那样钉住的是「我们数出零篇」，而本篇要钉的是「**三个独立进程都打印了成功**」。

## Consequences

- 收益：外壳的空集合分支从「没人验证的判断」变成「有对照证明的必要分支」。删掉它会红，
  上游修好空集合会让①红 —— 两个方向都要有人来改代码，这正是意图。
- 代价：多一个测试文件（4 条用例，约 3.3s，其中三条各 spawn 真子进程）和一条
  `FAULT_SUITES` 登记。本仓库 `npm test` 已注明是 IO 密集（见
  [2026-10-19-tests-are-io-bound-not-cpu-bound.md](../process/2026-10-19-tests-are-io-bound-not-cpu-bound.md)），
  这点开销与既有风格一致，不改变取舍。
- 代价：①的断言会随上游改文案而红。这是刻意的「提前通知」而非脆弱 ——
  文案变了意味着脚本的空集合语义可能变了，正是本篇要盯的东西。但它要求同步上游时
  顺手看一眼红的原因，不能直接改字符串了事。
- 已知边界：①的 stdout 断言用 `stdout.trim()` 逐字比对，**上游若在 stdout 里加任何额外行**
  （例如附带耗时）都会红。同样的取舍反过来也成立：宽松匹配会让「脚本崩了却打印了
  前半句」混过去。选了严格，因为这条断言的全部作用就是「它真的跑完了并宣布成功」。
- 已知边界：③只验 `tools/verify-notes.mjs` 这一个 CLI 入口。插件工具
  （`agent_notes_gate`）与 `notes:gate` 走的是同一个 `runAllGates`，由
  `tools/plugin-tools.test.mjs` 覆盖，不在本篇重复。

## Verification

故障注入：临时把 `lib/notes.js` 里那条「有树零篇」判失败的分支改成放行
（`if (inspectTree(notesRoot).files.length === 0)` → `if (false && ...)`），
本文件必须红 —— 实际 `pass 2 / fail 2`，退出码 1，红的正是②③：

```
$ node --test tools/notes-gate-vacuity.test.mjs     # 注入后
✔ 空集合：裸脚本三道全部 exit 0 并打印 ok: 0（外壳存在的理由本身）
✖ 空集合：同一仓库上 runGate 判失败并给出 NO_NOTES_YET（对照①→②）
  AssertionError: tree 在零篇仓库上绝不能通过    actual: true, expected: false
✖ 空集合：命令行外壳进程退出码非 0（对照①→③，CI 认的就是它）
ℹ tests 4   ℹ pass 2   ℹ fail 2      退出码 1
```

还原后逐字节一致（`md5sum lib/notes.js` = `168951b797322f3faa7cd180c097a4dd`，
与注入前的备份同一值），且 `git status --short lib/notes.js` 无输出。

```
$ node --test tools/notes-gate-vacuity.test.mjs     # 还原后
✔ 空集合：裸脚本三道全部 exit 0 并打印 ok: 0（外壳存在的理由本身）      (935ms)
✔ 空集合：同一仓库上 runGate 判失败并给出 NO_NOTES_YET（对照①→②）      (49ms)
✔ 空集合：命令行外壳进程退出码非 0（对照①→③，CI 认的就是它）          (362ms)
✔ 反向对照：有一篇合规笔记时外壳必须真绿（否则上面的红没有意义）        (1754ms)
ℹ tests 4   ℹ pass 4   ℹ fail 0      退出码 0
```

故障注入总门禁（`lib/notes.js` 已还原后）：

```
$ node tools/fault-injection.mjs
  ✔ vendored 门禁在空集合上 exit 0 与外壳判红的对照的故障注入在
    tools/notes-gate-vacuity.test.mjs（4 处 test 调用，由 npm test 执行）
  ✔ 磁盘上 40 个测试文件全部登记，无遗漏
故障注入全部通过：每条门禁都能对该拦的故障变红，且无故障时为绿。   退出码 0
```

文件计数由 39 变 40，与登记新增项一一对应。