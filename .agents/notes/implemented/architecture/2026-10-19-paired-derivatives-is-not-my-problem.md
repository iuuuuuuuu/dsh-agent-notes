# Agent Note: 上游有个叫 paired-markdown-derivatives 的机制，它解决的**不是**我那个问题

Status: implemented

> 与 [2026-10-19-code-block-parity-two-approaches-failed.md](../../rejected/architecture/2026-10-19-code-block-parity-two-approaches-failed.md)
> 直接接续 —— 那一篇证伪了「比代码块内容」的两种折中。本篇记录一个**容易
> 误以为能解决该问题**的上游机制，以及它为什么不能。
> 它与 [2026-10-19-i-was-wrong-about-not-needing-mdast.md](../bug-fix/2026-10-19-i-was-wrong-about-not-needing-mdast.md)
> 同属「上游多测了什么」这条线。

Independent: 本篇不改任何门禁行为，只**记录一个区分**，防止后来者（包括我自己）
把两个不同的问题当成同一个。

## Problem

上一轮证伪了两种折中后，我在缓存的 47 个上游脚本里扫到一个名字很像的东西：

`up-paired-markdown-derivatives.ts` —— 文件头第一句：

> Separate **byte-identical** Chinese Markdown code blocks from the primary
> checks performed on their unsuffixed English siblings.

「分离**逐字节相同**的中文代码块」—— 看起来正好解决我证伪的那个问题。

**而它不解决。** 本篇说清为什么，因为「名字像」很容易被当成「就是它」。

## Decision

**记录区分，不改门禁。** 两个问题方向相反：

| | 我的问题 | 上游的机制 |
|---|---|---|
| **问什么** | 两版代码块**内容不同**，这差异**是不是漂移** | 中英两块**逐字节相同**时，不必重复检查 |
| **方向** | 跨语言**判定** | 单语言内的**去重** |
| **省什么** | —— | 省一次重复检查（source-oriented 门禁只查一份） |
| **判据** | 猜「哪部分是说明文字」 | 测「是否逐字节相同」 |

### 上游怎么做的（`:38-59`）

```ts
for (const [doc, candidates] of byDoc) {
  const sibling = unsuffixedSibling(doc)           // x.zh.md → x.md
  if (sibling === null) continue
  const originals = byDoc.get(sibling)
  if (originals === undefined || originals.length !== candidates.length) continue
  if (candidates.every((candidate, index) => {
    const original = originals[index]
    return original !== undefined
      && fingerprintOf(candidate) === fingerprintOf(original)   // ← 逐字节相同
  })) {
    derivativeDocs.add(doc)
  }
}
```

然后把 `derivativeDocs` 里的块归入 `derivatives`（跳过检查），其余归 `primary`。

**它不判断「差异是否合法」，只判断「是否完全一样」。**

### 为什么这个区分很重要

我上一轮的两种折都是在**猜**：哪些部分是「说明文字」（注释 / 分栏 / ASCII 图），
把猜中的排除掉。猜错了就会：
- **放过真漂移**（说明文字里混着真错的内容）
- **误报**（把正确的 `主题.md` vs `topic.md` 当漂移）

上游那个机制**不猜** —— 它只问「一不一样」。这是它明显更好的地方。

**但它回避了而不是解决了我的问题。** 我的 README 里那 3 处差异
（`查看开关与笔记树状态` / `主题.md` vs `topic.md` / ASCII 图括号注释）
**本来就不逐字节相同**，所以它们会被归为 `primary`，
**照样交给配对门禁跨语言比对** —— 也就是照样会红。

### 它的「fail closed」设计值得抄

注释写得很明确：

> A partial or reordered match **stays primary so the caller fails closed**;
> the translation-pairing gate reports the cross-language mismatch.

**部分匹配或顺序不同 → 留在 primary → 让配对门禁去报。**

这是本仓库该学的姿态：**辅助层不替主层做判断，只在「确定安全」时跳过。**
我那两种折中的做法恰好相反 —— 它们在**不确定**时就跳过（把猜中的排除）。

## Alternatives considered

- **用 `partitionPairedMarkdownDerivatives` 解决我的问题** — 名字最像。**这是本篇最强的一条被否方案**，而且若我草率采用，会得到一个「看起来在解决问题、实际只换了实现方式」的门禁：那 3 处逐字节不同的差异仍会被判为漂移，而它们是正确的。**换了实现但没换结果 = 更难发现的假绿。**
- **直接抄 `fail closed` 的姿态到自己那两种折中上** —— 有价值但本轮不动。**因为本轮已判定那两种折中整体不成立**（形态识别无终止条件），姿态对了载体没了也没有意义。
- **什么都不记录** — 最省事。**否掉因为「名字像就当成是」是我这轮明确识别出的思维陷阱**，不写下来下次还会踩。

## Consequences

- **收益**：避免一次「看起来解决了、实际没解决」的改动。那类改动比不改更糟——它让人以为问题已被处理。
- **收益**：记下了上游 `fail closed` 的设计（辅助层只在确定安全时跳过），这是本仓库**可以借鉴的姿态**，与它具体解法无关。
- **代价与已知上限**：「比代码块内容」这件事**仍未解决**，且本轮的结论是「当前判据下不可解」。若将来真要做，需要的是「豁免清单」或「生成区标记」这类**显式声明**，不是形态识别。
- **重访信号**：**若上游把 `partitionPairedMarkdownDerivatives` 用到跨语言判定上**（而不只是去重）→ 那它可能已经有了解决我那个问题的方法，届时读它的最新源码。另一个信号：若本仓库出现「中英代码块应当逐字节相同」的约定（例如命令清单从单文件生成两版）→ 那时这个机制**正好适用**，因为差异会真的归零。

## Verification

```sh
node .probe/tmp/read-paired-derivatives.mjs    # 读上游源码并列出对比表
sed -n '38,59p' .probe/probe-upstream/up-paired-markdown-derivatives.ts
```

上游源码实测（`:38-59`，节选核心）：

```ts
if (originals === undefined || originals.length !== candidates.length) continue
if (candidates.every((candidate, index) => {
  const original = originals[index]
  return original !== undefined
    && fingerprintOf(candidate) === fingerprintOf(original)   // 逐字节相同
})) {
  derivativeDocs.add(doc)
}
```

注释原文：

> A partial or reordered match stays primary so the caller fails closed.
