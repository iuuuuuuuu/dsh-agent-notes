# Agent Note: 归档 append-only 的默认基线改成 origin/main

Status: implemented

> Owner 2026-10-24 裁定：「钉到 origin/main」。
> 本篇兑现
> [2026-10-24-archive-sidecar-seal-was-never-recomputed.md](../bug-fix/2026-10-24-archive-sidecar-seal-was-never-recomputed.md)
> 里「已知上限 · 一」那一条（原文保留，加互链）。
> 退出码约定见
> [2026-10-19-network-down-reported-as-contract-broken.md](../bug-fix/2026-10-19-network-down-reported-as-contract-broken.md)。

## Problem

归档区的核心承诺是「冻结只读：封印只增不改」。`lib/notes.js` 的 archived 前置校验
（以及 vendored 脚本）原先在**没有显式指定**基线时用 `HEAD`：

```js
const baseRef = gateEnv.AGENT_NOTE_ARCHIVE_BASE_REF || 'HEAD';
```

`HEAD` 与「当前工作区」在提交之后是**同一份内容**，于是这条检查只对
「改了还没提交」有效。实测（真 Git 仓库）：

```
改归档笔记内容 → 同步更新 manifest 里的封印 → 提交
默认（基线 HEAD）      → exit=0 / passed=true      ← 什么都没发现
显式指「改之前」的 ref → exit=1 / Archived seal changed or removed
```

也就是说默认配置下这道检查**基本空转**，而它印出来的仍然是
`ok: N archived note(s) verified`。`verify.yml` 与 `upstream-sync.yml`
跑 `npm run notes:gate` 时都没设 `AGENT_NOTE_ARCHIVE_BASE_REF`，所以 CI 上同样只到 HEAD。

## Decision

没有显式基线时，默认改为解析 `refs/remotes/origin/main`：

```
显式 AGENT_NOTE_ARCHIVE_BASE_REF ── 最高优先，且解析不出来仍然失败关闭（原行为）
        │
        ├─ 有 origin/main ⇒ 基線 = refs/remotes/origin/main
        └─ 没有        ⇒ 基線 = HEAD，**并往 stderr 打一条 warning**
```

`must`：**退让可以，静默不行。** 没有 `origin/main` 是常见且合法的形态
（本地新仓、夹具、浅克隆），直接失败关闭会把它们一律打红 —— 那不是收紧，
是把门禁弄坏。但「冻结强度下降」必须出现在**输出里**，不能只写在注释里：
warning 明确说清「已提交的封印改动看不见」以及怎么补回（设
`AGENT_NOTE_ARCHIVE_BASE_REF` 或补远端）。

`must`：**显式基线仍然失败关闭**。用户明确说了「以这个提交为准」，
解析不出来就必须 exit 1，不能悄悄退回 HEAD —— 那等于把用户的门禁降级成空转。

## Alternatives considered

- **保持 HEAD（不做改动，只写进已知上限）** — **这是本篇最强的一条被否方案**。理由：零风险、零兼容问题，本地仓库与 CI 行为都不变；而「冻结」本来就是个可以靠显式环境变量开启的强度。**否掉因为默认值就是事实标准**：没人设环境变量时，门禁仍在打印 `ok: N archived note(s) verified`，而它实际什么都没拦 —— 这正是本仓库反复点名的那类「看起来验了」。Owner 的选择是把默认值改成真的有效，而不是继续依赖使用者记得配置。
- **没有 origin/main 就失败关闭（exit 2）** — 更严格，且与「无法进行」的语义一致。**否掉因为代价落在错误的对象上**：本地新仓、`git init` 夹具、浅克隆都会红，而它们并没有做错任何事；本仓库的多个测试夹具正是这种形态。真正的判据是「这次比对有没有做成」，而不是「远端存在吗」。
- **默认用 `HEAD~1`** — 不需要远端，也能发现「最近一次提交改了封印」。**否掉因为它只覆盖一次提交**：改动随历史越走越远就越看不见，而且合并提交/浅克隆下 `HEAD~1` 的语义不稳定。追历史要一个**稳定的**锚点，`origin/main` 正是那个锚点。
- **只在 CI 里设 `AGENT_NOTE_ARCHIVE_BASE_REF=origin/main`** — 改动最小，不碰默认值。**否掉因为本地就永远空转**：开发者本地跑 `npm run notes:gate` 得到的绿与 CI 的绿含义不同，而两者用的是同一个命令名。另有操作性风险：`actions/checkout` 在浅克隆下可能没有该 ref，显式设置又会失败关闭，反而把 CI 打红。
- **把基线钉到「最近一个发版 tag」** — 冻结范围只覆盖发版之间，不翻旧账。**否掉因为它允许两次发版之间的改动被悄悄改掉**，而「冻结」的语义恰恰是不留这种窗口。

## Consequences

- **收益**：默认配置下「只增不改」真的生效。改归档笔记内容**并同步更新封印**再提交，现在会红（`Archived seal changed or removed`），而不再悄悄通过。
- **收益**：CI 不需要任何额外配置 —— `verify.yml` 已经是 `fetch-depth: 0`，`origin/main` 可得。
- **收益**：退让路径有可见告警，`AGENT_NOTE_ARCHIVE_BASE_REF` 的作用也顺带被解释清楚（此前只在注释里）。
- **代价与已知上限**：**需要 `origin/main` 才能达到完整强度。** 本地无远端仓库、浅克隆、只 fetch 单分支的 CI 都会退回 HEAD —— 那时只剩告警，冻结强度与改动前相同。
- **代价与已知上限**：**首次跑会更严**。任何历史上「改过封印并已提交」的仓库，从现在起会在 archived 门禁上红，直到把那条封印恢复或显式指定更晚的基线。这是刻意的收紧，不是回归；但升级时要知道。
- **代价与已知上限**：基线是 ref 名而不是 commit id，`origin/main` 移动后基线也随之移动（这正是「以已合并状态为准」的语义）。若要完全可复现，应显式传一个 commit id。
- **代价与已知上限**：本篇只改了**插件侧预检**的默认；vendored 脚本内部那条 append-only 比对仍用它自己的默认（被插件 pin 住的 oid 覆盖，因此实际生效的是插件选定的基线）。若将来有人直接跑 vendored 脚本，仍是 HEAD 语义 —— 与
  [2026-10-24-archive-sidecar-seal-was-never-recomputed.md](../bug-fix/2026-10-24-archive-sidecar-seal-was-never-recomputed.md)
  的「已知上限 · 二」同属 vendored 侧。
- **重访信号**：
  - 若 CI 改为浅克隆（`fetch-depth: 1`）→ `origin/main` 可能不可得，要显式 `git fetch origin main:refs/remotes/origin/main`，否则强度悄悄退回 HEAD。
  - 若出现「合法地需要改归档封印」的流程（例如批量修正元数据）→ 要提供显式的解封路径，而不是让人去改基线。
  - 若默认基线频繁导致升级后大红 → 先看是不是历史遗留的封印改动，不要直接把默认改回 HEAD。

## Verification

```sh
node --test tools/archive-baseline.test.mjs   # 11 tests / 11 pass / 0 fail
```

新增 2 条（真 Git 仓库夹具，`refs/remotes/origin/main` 用 `git update-ref` 造）：

1. **默认基线钉 origin/main**：归档笔记与封印提交成基线 → 登记 `origin/main` →
   改内容**并同步更新封印**再提交 ⇒ 不传任何基线环境变量也必须
   `exit=1` + `Archived seal changed or removed`。
2. **没有 origin/main 时退回 HEAD，且必须留痕**：同一夹具不登记远端 ⇒
   `stderr` 必须含「没有可解析的 origin/main」以及
   `AGENT_NOTE_ARCHIVE_BASE_REF`（告警要能指路）。

**真变异**（把默认改回 `explicitBaseline || 'HEAD'`）⇒ `0 pass / 2 fail`，
两条新用例同时红；还原后 `11/11`。

### 评审补强（CodeRabbit on PR #44）：把「Git 故障」与「没有该 ref」分开

上面第一版把 `git rev-parse --verify` 的**任何**非零退出都当成「没有 origin/main」，
于是超时、`spawn` 失败、仓库损坏都会悄悄退回 HEAD —— 而退回之后，
一批**已提交**的封印改动就被放过，门禁照样打印绿。这正是本篇要消除的那种失效。

现在：

- 探测命令加 `--quiet`：**只有「ref 不存在」才是退 1 且无输出**；
- 退 1 且非超时 ⇒ 退回 HEAD + 告警（原行为）；
- **其余（128 / 超时 / 被信号杀）⇒ 失败关闭**（`ARCHIVE_BASELINE: origin/main baseline probe failed`）。

另补一条同源洞：`GIT_DIR` / `GIT_WORK_TREE` / `GIT_COMMON_DIR` 被覆盖时，
`git` 报的也是「not a git repository」—— 插件预检会以为「这里不是仓库」而跳过，
vendored 也会跳过，**两层一起静默降级**、`exit 0` 还带一句 warning（实测）。
现在这种情形直接失败关闭：**无法判断仓库归属就不许判绿。**

两条都有回归（`tools/archive-baseline.test.mjs` 11 → 12 条）：
「Git 本身故障时不许退回 HEAD 顶替」用 `GIT_DIR` 指向不存在的目录制造真实故障，
断言不许绿；真变异（去掉覆盖判断）⇒ 该用例红。
