# Agent Note: 上游的门禁分层是它的规模逼出来的，不是通用做法

Status: rejected — 单包插件照搬只会多维护一组分组边界，不解决任何真问题

> 收尾审计的延续。上一轮复核「42 道 verify」时发现 goal 里那个数字是错的
> （真值 44，见
> [upstream-comparison-complete](../../implemented/process/2026-10-19-upstream-comparison-complete.md)）。
> 本轮复核另一条声明「非 verify 类 135 个脚本已看」—— **135 是对的**
> （200 总数 − 65 个 `verify-*` = 135），但那条声明让我去看了非 verify 的形态，
> 于是发现了这个看起来像吸收点的做法。
> 同类否决见
> [upstream-non-verify-scripts-not-worth-absorbing](./2026-10-19-upstream-non-verify-scripts-not-worth-absorbing.md)。

Independent: 本篇否决的是**一个具体的上游做法**（门禁分层），与门禁判什么、
跑多快、并发度定多少都无关。

## Problem

复核 goal 的第二条声明时，顺带看到上游的 script 形态：

```
check:ci:static                tsx scripts/run-gates.ts ci-static
check:ci:lint:contracts-ready  tsx scripts/run-gates.ts ci-lint-contracts-ready
check:ci:coverage              tsx scripts/run-gates.ts ci-coverage
check:ci:unit                  tsx scripts/run-gates.ts ci-unit
check:ci:bench                 tsx scripts/run-gates.ts ci-bench
check:ci:snapshot              tsx scripts/run-gates.ts ci-snapshot
check:ci:artifacts             tsx scripts/run-gates.ts ci-artifacts
check:ci:consumers             tsx scripts/run-gates.ts ci-consumers
check:ci:windows-blocking      tsx scripts/run-gates.ts ci-windows-blocking
check:ci:windows-complete      tsx scripts/run-gates.ts ci-windows-complete
check:ci:windows-observational-ready …
check:node-compat              tsx scripts/run-gates.ts node-compat
test:docs                      tsx scripts/run-gates.ts doc-quick
```

**13 层**，全部走同一个 `run-gates.ts`。而本仓库是 13 步 `&&` 串起来的一条链。

看起来上游更「现代」——分层、可并行、可 fail-fast。

## Proposal

曾考虑把门禁按 static / lint / unit / doc 分层（照搬上游的 `check:ci:*`），
逐条列在这里以便日后重新评估：

1. **完全照搬分层结构** —— 把 13 步分成 static/lint/unit/doc 四层。
2. **只在 CI 侧分层，本地仍用一条链** —— 两边不用对齐分组。
3. **把 `check` 链拆成 2–3 段「快的」与「慢的」**。
4. **什么都不做** —— 这是本篇的决定。

理由分别是「更专业」「折中」「更轻量」「避免引入维护成本」。
**但前三条不采纳** —— 理由见 Decision。

## Decision

**不吸收。** 判据不是「分层是坏实践」，而是：

### 分层要解决的是「CI 墙钟时间」，而本仓库 CI 本来就不慢

| | 本仓库 |
|---|---|
| check 链耗时 | **约 45 秒** |
| 本地与 CI 的关系 | **跑同一条链** → 「本地绿了」等价于「CI 会绿」 |

45 秒对本地提交钩子够用，对 CI 也不长。**分层想解决的问题，本仓库没有。**

### 而分层的代价是「分组边界要维护」

分层后：
- CI 上各 job 并行 → 快（本仓库不需要）
- **但本地那条链仍然要存在** → 分组边界（哪些门禁归 `static`？归 `lint`？）
  要在 CI 与本地两侧对齐，**维护成本翻倍**

而本仓库现在的「一条链」有一个真实收益：**本地跑的与 CI 跑的是同一份**。
分层会削弱它。

### 上游是**被规模逼的**，不是主动选的

上游的规模是：200 个 script、pnpm monorepo、多包、Windows/macOS/Linux 矩阵。
那种规模下，一条链跑到底要几十分钟，**不分层就没法用**。

**单包插件照搬只会增加维护成本，不解决任何本仓库的真问题。**

## Alternatives considered

- **照搬分层结构**（把 13 步分成 static/lint/unit/doc 四层）— 看起来更专业。**这是本篇最强的一条被否方案**，因为它确实解决了「CI 并行」。否掉理由是**它解决的问题本仓库没有**：45 秒不需要并行，而分组边界的维护成本是真实的。
- **只在 CI 侧分层，本地仍用一条链** — 折中，两边不用对齐。否掉因为那等于**CI 与本地跑的东西不同**，而本仓库的一致性正是靠「同一条链」保证的（`ci:align` 门禁强制两者对齐）。分层会让那道门禁变复杂。
- **把 `check` 链拆成 2–3 段（比如「快的」与「慢的」）** — 更轻量。**这个想法有价值但现在做不了**：判据是「哪几步慢」，而本轮实测并发测试时后台测量与 `check` 互相干扰，**没有拿到干净的耗时分解**。数据不足就不该动 —— 那会变成拍脑袋的 10 秒 vs 40 秒。
- **什么都不做** — 这是本篇的决定。

## Consequences

- **收益**：避免了一个「上游这么做，所以我们也该做」的改动。它会引入分组边界的双侧维护，而收益仅是 CI 上几秒的并行。
- **收益**：记下了判据 —— **上游的做法要先问「它的规模逼出来的需求，本仓库有没有」**。这个问法适用于任何「上游有、本仓库没有」的做法。
- **代价与已知上限**：若本仓库规模变大（文件数、门禁数、CI 矩阵），分层会变成刚需。**判据是实测的耗时，不是文件数**。
- **代价与已知上限**：本仓库的 check 链**没有分段**，所以「快速反馈」目前靠 hook 筛（commit-msg 只跑 8 步按文件类型筛）。若门禁继续增加，hook 的筛选规则会变复杂 —— 那时需要重新评估。
- **重访信号**：**`npm run check` 耗时超过 2 分钟** —— 那时分层就有价值了，届时要按耗时把 13 步分成「快/慢」两段。**注意那要求先有干净的耗时分解数据**（见上面被否的第三条）。另一个信号：若 CI 上 `verify` job 开始因墙钟时间被 runner 超时杀掉 —— 那也是分层的信号。

## Verification

```sh
node .probe/tmp/recheck-135.mjs          # 复核「135」这条声明成立
node .probe/tmp/check-layered-gates.mjs  # 本篇的判据推演
```

实测数据：上游 200 个 script（65 个 `verify-*` + 135 个非 verify）；
本仓库 `check` 链 13 步、约 45 秒。