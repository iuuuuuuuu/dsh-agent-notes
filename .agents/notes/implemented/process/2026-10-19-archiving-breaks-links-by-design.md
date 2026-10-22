# Agent Note: 归档必然断链，且事后无法修 —— 这是设计取舍不是漏洞

Status: implemented

> 同属**流程补齐**这条线，与
> [2026-10-19-client-bundle-and-archive-paths-verified.md](../testing/2026-10-19-client-bundle-and-archive-paths-verified.md)
> 是同一批的续篇 —— 那一篇验证了归档路径**能跑**，本篇发现它跑完之后**必然断链**。
> 上游比对的总账见
> [2026-10-19-upstream-comparison-complete.md](../process/2026-10-19-upstream-comparison-complete.md)。

Independent: 本篇处理的是**归档的链接语义**，与归档脚本能不能跑、门禁触发时机、
客户端 bundle 都无关 —— 那些是「机制可用性」，本篇是「机制的已知代价」。

## Problem

Owner 让我「归档一份看看」。真归档时撞上一个死锁：

```
$ npm run archive:note -- .agents/notes/implemented/simplification/2026-10-18-....md
Moved: implemented/simplification/x.md -> archived/simplification/x.md
Sealed in archived/manifest.json with hash sha256:3199ac94...

[Notice] The following active notes link to the archived note:
  - implemented/bug-fix/2026-10-18-drawer-scroll-and-double-scrollbar.md
  - implemented/feature/2026-10-17-board-narrow-viewport-adaptation.md
```

`md:links` 随即报 **3 处**断裂。而我去修归档笔记自己的那条链接时：

```
✖ archived: archived/simplification/x.md — seal mismatch:
  archived note was modified after sealing (frozen notes must never change)
```

**`--write` 也救不了** —— 读源码确认它只封**未封**的：

```ts
if (!entry) {
  if (isWrite) manifest.files[key] = sealOf(key);   // 只处理未封的
  else fail(...)
} else if (entry !== sealOf(key)) {
  fail(`... seal mismatch ...`)                       // 已封且不匹配 → 直接失败
}
```

于是形成死锁：**归档后必然断链，但断了不能改归档文件**。

### 断链的规模：95%

模拟「把所有待归档笔记都归档一次」：

| 指标 | 值 |
|---|---|
| `implemented/` 下笔记的出向相对链接 | 63 条 |
| 归档后会断 | **60 条（95%）** |
| 有出向链接的笔记 | 33 / 41 篇 |

**为什么是 95% 而不是个别情况**：笔记路径是
`.agents/notes/<lifecycle>/<class>/file.md`，**深度固定**。归档只把
lifecycle 段从 `implemented` 换成 `archived`，深度不变。所以

```
](../bug-fix/y.md)   在 implemented/bug-fix/ → implemented/bug-fix/y.md  ✔
                     在 archived/bug-fix/    → archived/bug-fix/y.md    ✘ y.md 还在 implemented/
```

**任何**跨 class 或指向同 class 兄弟的相对链接，归档后都会指向一个
「同 lifecycle 但不同 class」的路径 —— 而那里没有文件。

## Decision

`must`：**归档笔记作为「源」排除出 `md-links` 扫描，但指向它们的链接仍检查。**

这与上游 `verify-md-links.ts` 的做法逐字对齐，它第 33 行的注释写着：

> Archived notes are excluded as sources, but links to them remain checked.

分工因此清楚：

| 链接类型 | 处理 | 理由 |
|---|---|---|
| 归档笔记**指向别处** | 排除，不检查 | 封存内容的内部链接会随时间腐化；且封印机制**设计上禁止**事后修改 |
| 活文档**指向归档笔记** | **必须检查** | 那是活文档里的引用，读者点进去必须能到达 |

`must`：**不能为了「让门禁绿」而放宽检查。** 排除归档区是有依据的取舍
（对齐上游 + 承认封存内容的链接会腐化），不是为了让红变绿。

实现（`tools/md-links.mjs` 的 `collectDocuments`）：

```js
if (info.isDirectory()) {
  /* 归档区不作为校验源（理由见上方）。 */
  if (relDir === '.agents/notes' && name === 'archived') continue;
  walk(childRel);
}
```

**目标解析路径没动** —— `verifyOne` 仍用 `existsSync(resolved)` 判断，
所以「活文档 → 归档笔记」这条链路照常被检查。实测：排除后从 3 处降到
2 处，剩下的 2 处正是「活文档指向归档笔记」，改成
`../../archived/<class>/x.md` 后全通。

## Alternatives considered

- **归档时自动重写笔记内部的出向链接** — 一劳永逸。**这是本篇最强的一条被否方案**，因为它与封印机制**直接冲突**：脚本要在移动后改归档文件，而那会立刻触发 `seal mismatch`（除非在移动前先重写、再移动、再封存）。技术上可行，但那意味着**归档不再是「冻结历史快照」而是「重写历史」** —— 一篇 2026 年的决策笔记，其内部链接被 2026-10-19 的工具改写，读者无法判断「我当时写的是什么」。
- **把链接改成绝对式（相对仓库根）** — 位置无关，永不断。否掉因为 `md-links` 明确**排除 root-absolute 目标**（与上游一致），写了反而扫不到 —— 变成「看起来是绝对路径所以不用检查」，那正是另一种假绿。
- **让归档脚本在移动后校验并提示「请手工修归档笔记的链接」** — 半个方案。否掉因为**做不到**：提示了也改不了（封印）。给一个无法执行的提示是噪音。
- **什么都不做，记进笔记当已知缺口** — 最省事。否掉因为活文档指向归档笔记的链接**是真会断的**（实测 2 处），那部分必须修；而排除归档区作为源是一行代码就能对齐上游的明确取舍。两者都该做。

## Consequences

- **收益**：对齐上游行为。归档后 `md:links` 从 3 处红降到 0 处，且**不是靠放宽检查** —— 排除的是封存区，活文档的引用照常验。
- **收益**：归档流程现在真正可用了。第一篇归档笔记（`2026-10-18-drop-redundant-drawer-patch-after-upstream-fix.md`，上游已修复、插件删掉重复补丁，决策使命完成）已入库，`archived/` 门禁报 `1 archived note(s) verified, 1 seal(s) in manifest`。
- **代价与已知上限**：**归档笔记内部的链接永久无法修复**。若一篇归档笔记指向的笔记后来被改名或删除，那个链接就永远断着。**这是接受的** —— 它是封存快照的一部分，改它就失去了「当时写了什么」的可信度。
- **代价与已知上限**：`md-links` 不再报告归档区的问题，所以**归档笔记里若有明显的链接错误，也不会被发现**。同样接受：那属于「封存内容」，不该在今天被打扰。
- **代价与已知上限**：活文档指向归档笔记的链接**仍需人工修**（归档脚本会打印提示，但不自动改）。这是有意的 —— 改法取决于语义（是「见归档的历史决定」还是「这条已作废」），必须人判断。
- **重访信号**：若归档笔记的数量增长到 20 篇以上，且出现「有人抱怨归档笔记里的链接点不开」，那说明「封存即冻结」的代价超过了它的收益 —— 届时可以考虑「归档时把内部链接改写成不可点击的纯文本引用」（牺牲可点性，换取可修改性）。这是**重新设计归档语义**，不是补一个 bug。

## Verification

```sh
npm run archive:note -- <路径>          # 归档，看它打印的入站链接提示
npm run md:links                        # 应只报「活文档 → 归档笔记」的断链
node tools/verify-notes.mjs             # archived 门禁应报 1 seal(s)
```

故障注入（证明排除不是「为了让红变绿」）：

| 场景 | 期望 | 理由 |
|---|---|---|
| 归档笔记内部断链 | **不报** | 上游明确 excluded as sources |
| 活文档指向归档笔记且路径写错 | **必须报** | links to them remain checked |
| 活文档指向归档笔记路径正确 | 不报 | 正常 |

第二条是关键：它证明排除只作用于「源」，没有削弱对活文档的检查。
