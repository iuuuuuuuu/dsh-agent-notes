# Agent Note: 归档造成的断链有活实例了，且它结构性地查不出

Status: implemented

> 与 [2026-10-19-archiving-breaks-links-by-design.md](../process/2026-10-19-archiving-breaks-links-by-design.md)
> 直接接续 —— 那一篇**预测**了「归档会让出向链接失效，且事后修不了」，
> 并把 `archived/` 从 md-links 的校验源里排除。本篇给出**那篇预测的第一个活实例**，
> 并量化「排除的代价」。
> 与它同属**流程补齐**这条线。

Independent: 本篇不引入新门禁，只做**量化与归因** —— 把一个已知代价从
「理论上」变成「实测多少条、能不能修」。

## Problem

收尾审计时我写了个链接检查脚本（因为今天这类错误犯了 6 次），扫出 91 条笔记树
里的相对链接有 3 条失效。逐一查：

| 失效链接 | 判定 |
|---|---|
| `../bug-fix/y.md`（我的笔记里的**示例代码**） | 不是真链接 |
| `../../../etc/passwd`（示例代码） | 不是真链接 |
| `../bug-fix/2026-10-18-drawer-scroll-and-double-scrollbar.md` | **真实断链** |

那条真断链在**唯一的归档笔记**里。而 `npm run md:links` 报「55 个文档、
118 条相对链接全部可达」—— **它根本没看见**。

## Decision

**查清归因并量化，不修。** 因为修不了（封印只读）。

### 归因：确实是归档造成的

用 git 追到归档前的版本：

```
$ git show 369cd59:.agents/notes/implemented/simplification/2026-10-18-drop-redundant-….md
](../bug-fix/2026-10-18-drawer-scroll-and-double-scrollbar.md)
```

从 `implemented/simplification/` 解析 `../bug-fix/x.md` → `implemented/bug-fix/x.md` ✔ **存在**

归档到 `archived/simplification/` 后，同样的相对路径解析到
`archived/bug-fix/x.md` → **不存在**（正确路径应是 `../../implemented/bug-fix/x.md`）

`git log --name-status` 显示 `03ca1db` 把它从 `implemented/simplification/`
移到了 `archived/simplification/`。

**所以这是 `archiving-breaks-links-by-design` 那篇预测的活实例**，不是历史上就写错了。

### 量化：目前只有 1 条，且只有 1 篇归档笔记

```
归档区笔记: 1 篇
真实断链:   1 条
示例代码:   0 条（那两条是我笔记里的举例）
```

**样本只有 1 个，不能拿它估比例。** 但它证明那篇笔记的**机制**是对的 ——
不是「可能有 95% 断链」的理论推演，而是**确实断了，且门禁看不见**。

### 为什么修不了

`skills/agent-notes/scripts/verify-archived-agent-notes.ts --write` 只封印
**未封印**的文件。已封印的文件有任何改动都会报 `seal mismatch`。

所以：改归档笔记 → 必须重算 manifest → 那是「改封印」，而封印存在的意义
就是**证明归档后没被改过**。**这两件事直接冲突。**

## Alternatives considered

- **重算 manifest 让链接修好** — 技术上就是改一行哈希。**这是本篇最强的一条被否方案**，因为它把封印从「证据」降级成「快照」：谁都能改，改了再重新封印，那它还证明什么？**封印的全部价值就在于它不能被随手更新。**
- **把 `archived/` 重新纳入 md-links 的校验源** — 那会立刻让 check 变红。否掉因为那正是 `archiving-breaks-links-by-design` 那篇已经处理过的问题：归档区的断链**绝大多数来自归档本身**，不是笔误。纳入会让门禁恒红，而**恒红的门禁等于没有门禁**。
- **归档时自动改写笔记里的相对链接** — 这是根治：让 `archive:note` 在移动文件的同时，把笔记里的 `../x/y.md` 改写成能跨 lifecycle 段解析的形式。**这是真正的解法，但需要改上游的归档脚本**（`skills/agent-notes/` 是 vendored 内容，手改会被 `verify-plugin` 的哈希比对拦下）。见重访信号。
- **什么都不做，只记录** — 这是本篇的决定。

## Consequences

- **收益**：把 `archiving-breaks-links-by-design` 的「95% 会断」从**理论推演**变成**实测活实例**。那篇笔记当时只能靠构造样例证明机制成立，现在有真实数据。
- **收益**：量化了「排除 `archived/` 作为校验源」的代价 —— **代价是归档区的断链永远查不出**。这个数字目前是 1，但它会随归档篇数增长。
- **代价与已知上限**：**这 1 条断链永久存在**，且没人会知道它在那（门禁结构性看不见）。若将来有人从 `archived/` 复制内容出来，会拿到一条坏链接。
- **代价与已知上限**：我的链接检查脚本只查**笔记树**（91 条），而 `md-links` 查全仓库（118 条）。两者口径不同 —— 所以**脚本不能替代门禁**，它只是「在写笔记时自查」的工具，且**不入库**（在 `.probe/` 里）。
- **重访信号**：**归档第 2 篇笔记时** —— 那时这个缺口的实际损失才有两个数据点，而 `archived/` 的断链数会开始有意义。届时要么接受（记下数字），要么推动上游修归档脚本（见下）。
  另一个信号：若有人报告「从归档笔记复制出来的链接是坏的」，那就是这条缺口的第一次实际伤害。

## Verification

```sh
node .probe/tmp/measure-archived-broken-links.mjs   # 量化
node .probe/tmp/fix-note-links.mjs                   # 扫描（--write 可修）
npm run md:links                                     # 118 条全通 —— 但不含 archived/
```

实测数据：

```
归档区笔记: 1 篇
真实断链:   1 条

$ git show 369cd59:.agents/notes/implemented/simplification/2026-10-18-drop-redundant-….md
](../bug-fix/2026-10-18-drawer-scroll-and-double-scrollbar.md)
  → 从 implemented/simplification/ 解析到 implemented/bug-fix/ ✔ 存在
  → 归档后解析到 archived/bug-fix/ ✘ 不存在
```

`npm run md:links` 报「118 条相对链接全部可达」——**这条断链不在其中**，
因为 `tools/md-links.mjs:89` 把 `archived/` 排除为源。
