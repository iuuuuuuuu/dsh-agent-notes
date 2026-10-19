# Agent Note: 上游也卡在「归档后不能改已封印文件」，它用精确哈希白名单硬编码豁免

Status: implemented

> 补上 [2026-10-19-archiving-caused-a-real-broken-link.md](../bug-fix/2026-10-19-archiving-caused-a-real-broken-link.md)
> 的另一半证据 —— 那一篇实测了本仓库的死锁（归档断链 1 条、修不了）。
> 本篇给出**上游遇到同一个问题时怎么做的**，那是本轮读到缓存源码里
> 最硬的一条证据。

Independent: 本篇只读上游源码并记录，**不改任何机制** —— 恰恰因为上游的
做法证明了「没有干净解法」，所以本仓库不该照搬。

## Problem

本仓库的死锁（上一轮实测）：

1. 归档把笔记从 `implemented/<class>/` 移到 `archived/<class>/`
2. 相对链接的解析基准变了 → 出向链接失效
3. `--write` **只封未封印文件** → 改已封印文件报 `seal mismatch`
4. 所以要修链接就必须改已封印文件 → 必须重算 manifest
5. **而 manifest 的意义就是「证明归档后没被改过」** → 直接冲突

那问题来了：**上游遇到同一件事了吗？如果遇到了，它怎么办的？**

## Decision

**记录上游的做法，并明确不照搬。**

### 上游遇到的，而且比我更严重

`up-archived-agent-notes.ts`（204 行，文件头：`Pure archive-format,
triplet, and **immutable**-manifest helpers`）里有一个专门的豁免机制：

```ts
/** Reject sealed changes except the exact authorized Figma-link removal hashes. */
export function validateArchiveManifestExtension(
  baseline: ArchiveManifest,
  current: ArchiveManifest,
): string[]
```

而那个 `figmaLinkRemovals` 白名单长这样（源码 `:62-74` 附近）：

```ts
const figmaLinkRemovals = [
  {
    path: 'feature/2026-08-10-durable-workflow-runs-in-chat.zh.md',
    before: 'sha256:f4ffd2700bc9c2a0cc4b9d90f84e1d0a576939e2e6f0b130c5b142fd8cd518b0',
    after:  'sha256:0080859221773122022d5880efa3d52f29c0872b52d63e170250d94f214ff37a',
  },
  {
    path: 'feature/2026-08-10-durable-workflow-runs-in-chat.i18n.yaml',
    before: 'sha256:0db3c21a3c8785e56d5d7b90df990b158069cd1cea664e62fc4786c6d7588450',
    after:  'sha256:03eadb60c8ba4fde262cd61e3f911d8cd68ea4a58f57adeb8dd7bb9a97d08ca2',
  },
]
```

### 这份代码说明三件事

**① 死锁是真的，不是我本仓库的特例。** 上游也被「归档后要改内容」卡住过
—— 那两处改的是 **Figma 链接**（一种会失效的外部引用，典型的「当初写、
后来必须改」）。

**② 上游没有"干净"的解法，只能硬编码白名单。** 判据是
**`path` + `before` 哈希 + `after` 哈希三者全中**才放行。那不是「规则」，
那是**一次性事件记录** —— 精确到某次具体修改的两端哈希。

**③ 代价是白名单会无限增长，而且无法预先知道该加什么。** 每次归档后要改，
就得加一条；加错了（`before` 写错）会让合法的修改被拒。

### 所以本仓库不照搬

照搬 `figmaLinkRemovals` 那种机制，对本仓库意味着：
- 为**已经发生**的那 1 条断链硬编码一个 `before`/`after` 哈希
- 而那条断链**本来就该避免**（归档时用相对深度不对的链接）

**用一次性白名单去掩盖一个设计问题，是把「以后还会再犯」写进代码。**

## Alternatives considered

- **照搬 `validateArchiveManifestExtension` + 白名单** — 上游的做法，**这是本篇最强的一条被否方案**，因为它把「不可修改」的封印变成了「有例外」，而例外必须逐条手写。本仓库只有 1 条断链且它本来可避免，**没有例外的必要**。
- **让 `archive:note` 在移动文件时同步改写笔记里的相对链接**（上一轮笔记里就留作「根治方案」）—— 那才是根治：归档时把 `../bug-fix/x.md` 改写成跨 lifecycle 也能解析的形式（如用绝对锚点或全路径）。**这需要改上游的归档脚本**（`skills/agent-notes/` 是 vendored，手改会被 `verify-plugin` 的哈希比对拦下），所以本仓库做不了，只能推动上游。
- **接受当前状态（1 条断链，修不了）** — **这是本篇的决定**。把它记录下来而不是硬修。

## Consequences

- **收益**：本仓库的死锁**从「我以为是这样」变成「上游也这样」**。这不是新信息，但它把「这是设计代价不是 bug」这个判断**从推断变成了有据**。
- **收益**：记下了上游的解法（精确哈希白名单）**及其代价**（必须逐条手写、无法预知、加错就误拒），这样将来若真要走这条路，知道它的边界在哪。
- **代价与已知上限**：本仓库那 1 条归档断链**仍然存在且修不了**，且本轮证明了**没有干净解法**（上游也只能硬编码豁免）。这与上一轮笔记的结论一致，本篇只是给了它一个上游的对照。
- **代价与已知上限**：本仓库的 `skills/agent-notes/scripts/verify-archived-agent-notes.ts`（vendored 副本）与上游 `archived-agent-notes.ts` 可能已经有实现差异 —— 若上游后来把那个白名单机制正式化了（而不是硬编码两个哈希），本仓库的 vendored 副本会落后。**但那是 vendored 同步的事，不在本轮范围。**
- **重访信号**：**归档第 2 篇笔记时** —— 那时要么接受「断链会累积」，要么推动上游改归档脚本（在移动时改写链接）。这是本轮反复出现的重访信号，因为「1 条不足以估比例，2 条才开始有意义」。另一个信号：若本仓库出现「归档后必须改某类内容」的真实需求（如引用了会失效的外部链接），那时才考虑引入白名单，且**必须走一个决策**（哪些类型可豁免），不能像上游那样一次一个哈希。

## Verification

```sh
node .probe/tmp/read-archive-extend.mjs   # 读上游源码
```

上游源码实测（`up-archived-agent-notes.ts`）：

```
文件头： Pure archive-format, triplet, and immutable-manifest helpers

validateArchiveManifestExtension 注释：
  Reject sealed changes except the exact authorized Figma-link removal hashes.

figmaLinkRemovals 白名单（节选）：
  path:   feature/2026-08-10-durable-workflow-runs-in-chat.zh.md
  before: sha256:f4ffd2700bc9c2a0cc4b9d90f84e1d0a576939e2e6f0b130c5b142fd8cd518b0
  after:  sha256:0080859221773122022d5880efa3d52f29c0872b52d63e170250d94f214ff37a
  path:   feature/2026-08-10-durable-workflow-runs-in-chat.i18n.yaml
  before: sha256:0db3c21a3c8785e56d5d7b90df990b158069cd1cea664e62fc4786c6d7588450
  after:  sha256:03eadb60c8ba4fde262cd61e3f911d8cd68ea4a58f57adeb8dd7bb9a97d08ca2

extendArchiveManifest 的逻辑：
  对已存在的 file：内容哈希必须等于 baseline，否则报 "sealed content hash changed"
  对新增的 file：加入 files 并记入 added
  → 允许新增（归档新文件），不允许修改既有（除非白名单）
```