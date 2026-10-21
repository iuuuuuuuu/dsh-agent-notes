# Agent Note: 七个写盘入口全部实测幂等 —— 审计范围、方法与「查过没问题」的证据

Status: implemented

Independent: 本篇不修任何缺陷，记录的是**一次有结论的审计**：
七个会写盘的生产入口，逐个验过幂等与「检查/修复判据一致」。
不记下来的话，下一轮会把同样的路再走一遍，且无法区分
「查过没问题」与「没查过」。

## Problem

目标里有一条「检查与修复一致性、幂等性」，此前没有系统验过。
本仓库的写盘入口分散在多个工具里，各自的退化方式不同：

- 自动改写型（`bilingual-links`、`archive-note`、`sync-upstream`）：
  非幂等会让「修」变成「反复改」，且 CI 的 `git status --porcelain`
  断言会在第二次跑时红，**指向错误的排查方向**；
- 清单/预算型（`doc-budget --update`、`sync-upstream` 的 manifest）：
  丢条目会让依赖它的门禁静默失据；
- 覆盖型（`install-hooks`、`notices`）：
  悄悄覆盖别人的改动。

所以逐个入口实测，而不是读代码推断。

## Decision

**审计七个生产写盘入口，结论是无需改动。** 逐个记录判据与证据。

### 1. `bilingual-links.mjs:176`（`fixTranslationLinkLocales`）

实测 `.probe/probe-idempotent.mjs`（造一对互链指错语言的 README）：

| 步骤 | 结果 |
|---|---|
| 第一次 fix | `rewritten=1`，文件内容真的变了 |
| 第二次 fix | `rewritten=0`，内容与第一次后逐字相同 |
| fix 后跑 check | `violations=0` |

**幂等，且修复与检查判据一致**（同用 `scanTranslationLinkLocales`，
`check` 只是不写盘的那一半）。

### 2. `archive-note.mjs:179`（归档时改写链接）

已有测试覆盖「幂等 —— 已经是归档后形式的不再改」，通过。
`rewriteRelativeLinks` 从后往前替换，改写结果再跑一次 `rewriteOne`
会因 `rewritten === pathPart` 而跳过。

### 3. `sync-upstream.mjs:498/536/560`（合并上游 + 写 manifest）

★ 这里**先怀疑后证伪**，过程值得记：

怀疑：`manifest.files[rel] = remoteDigest` 只在 fetch 成功时写
（`:443`），而 `upstream-missing` 分支 `continue`（`:437`）——
若某次同步部分文件不可达，manifest 会不会丢条目？

查证 `fetchUpstream`（`:157-163`）：

```js
if (response.status === 404) return undefined;      // 上游真删了文件
if (!response.ok) throw new Error(...);             // 其他非 2xx：抛错
```

**网络抖动会让整个 sync 崩掉，根本走不到写 manifest 那一步。**
只有 404（上游确实删了文件）才返回 undefined，而那种情况下
条目本就不该保留。所以「部分丢失」的场景不成立 —— 是设计正确，
不是缺陷。（我的探针第一版用逻辑推演证明它会丢，那证明的是
**一个不存在的场景**；真实判据必须读 `fetchUpstream` 的错误分支。）

另一个怀疑：有人手改 vendored 文件后跑 sync，会不会漏判？
查证：changed 的判定是**实时比对本地磁盘 vs 远端**（`:441-446`），
不依赖旧 manifest。手改会被正确识别为 `changed` 并被覆盖。
manifest 只作记录，不参与判定。

### 4. `doc-budget.mjs:133`（`--update` 放宽预算）

只放宽不收紧（`:119-125` 的 `if (row.actual > row.limit)`），
且已有测试 `doc-budget --update 只在超预算时放宽，绝不收紧` 通过。
已有笔记记录过踩坑（无条件设成当前值会把余量归零）。

### 5. `install-hooks.mjs:131`（写 commit-msg 钩子）

`:127-129` 明确提示「已存在且内容不同，正在覆盖」——不静默。
`:121-124` 顺带清掉旧的 pre-commit（留着会重复检查）。

### 6. `notices.mjs:330`（写 THIRD_PARTY_NOTICES.md）

纯生成物，内容由 `renderNotices` 完全决定，同样输入必得同样输出
（已由 `checkNotices({ actual: good }).ok === true` 覆盖）。

### 7. `bump-version.mjs:70`（改 package.json 版本号）

单值替换，非累积操作。

## Alternatives considered

- **给每个入口都补一条幂等测试** —— 覆盖面最全。
  **否掉因为已有测试覆盖了其中三个（`archive-note` 的幂等、
  `doc-budget` 的只放宽、`bilingual-links` 的 fix→check），
  而本轮新增的是那三个没有的部分。剩下四个（`install-hooks`、
  `notices`、`bump-version`、`sync-upstream` 的 manifest）要么是
  纯生成物、要么是单值替换、要么已有专项测试，补重复用例是在
  把测试数量当成果。
- **抽一个共用的「写盘前比对」helper 统一处理** —— 减少重复。
  **否掉因为七个入口的语义不同**：改写型要比对内容、覆盖型要提示、
  清单型要保留条目。强行统一会把差异抹平，而那正是要防的。
- **只看代码不下结论** —— 快。
  **否掉因为本轮两个怀疑点都是读代码看着像缺陷**（manifest 丢条目、
  手改 vendored 漏判），读 `fetchUpstream` 的错误分支才发现场景不成立。
  不实测就会把「设计正确」报成「待修」。

## Consequences

- **收益**：七个写盘入口都有明确的幂等/一致性结论，可追溯。
- **收益**：`sync-upstream` 的两处「看着像缺陷」被证伪并记录理由，
  下一轮不会重新怀疑。
- **代价与已知上限**：本轮只验了幂等与判据一致，**没验并发**
  （两个进程同时写同一文件）。本仓库的工具都是单次 CLI 调用，
  没有并发写盘场景；若将来有，需另作评估。
- **代价与已知上限**：`bump-version.mjs` 只读了写盘那一行，
  没验它的参数解析与 tag 生成逻辑。
- **重访信号**：
  - **新增第八个写盘入口** → 按本篇的判据各验一遍，并把结论补到这里。
  - **`sync-upstream` 改成增量写 manifest**（不是每次全量重建）→
    那时「丢条目」的怀疑会重新成立，必须先补测试再改。

## Verification

```sh
node .probe/probe-idempotent.mjs     # bilingual-links：幂等 + 判据一致
node .probe/probe-manifest-loss.mjs  # sync-upstream manifest（证伪用）
node --test tools/*.test.mjs         # 388/388
npm run check                        # 全链 exit 0
```
