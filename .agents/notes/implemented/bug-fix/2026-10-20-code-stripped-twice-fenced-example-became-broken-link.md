# Agent Note: 代码区被剥离两遍，围栏里的示例就成了断链

Status: implemented

> 接 [2026-10-19-i-was-wrong-about-not-needing-mdast.md](../bug-fix/2026-10-19-i-was-wrong-about-not-needing-mdast.md)
> —— 那篇把 mdast 引进了 `tools/markdown-links.mjs`，本篇修它留下的接线缺口：
> 三个消费方里有一个还在用自己的正则先清一遍代码区。

Independent: 那篇改的是**提取器本体**，本篇改的是**一个消费方的接线**；
同一处代码（`md-links.mjs`）但决定不同，故新开一篇。

## Problem

`tools/md-links.mjs` 的 `verifyOne` 里写着：

```js
const stripped = stripCodeFences(text);        // 自己的正则：围栏 + 行内代码
…
for (const missing of undefinedReferences(stripped)) …
const found = extractLinks(stripped);          // 传给共用件，它内部又按 mdast 清一次
```

`stripCodeFences` 是 mdast 引进**之前**的实现。共用件接进来之后它没有被删掉，
于是同一段文本被按两套口径各清一遍。

★ 这不是「多跑一次」的性能问题，是**误报**：两道正则的口径不同，
前置那次抹不掉「未闭合围栏」和「缩进围栏」，而共用件的 mdast 认得
（CommonMark 里缩进≤3 空格的围栏合法；未闭合围栏一直延伸到文末）。
于是围栏**里面**的示例链接活了下来，被当成断链报出来。

实测（`.probe/probe-double-strip.mjs`，同一输入两条路径比对）：

| 输入 | 单次剥离 | 双重剥离 |
|---|---|---|
| 正常围栏 | `real.md` | `real.md` 一致 |
| **未闭合围栏** | `real.md` | `real.md` + **`fake.md`** |
| **缩进围栏** | `real.md` | `real.md` + **`fake.md`** |
| 波浪号围栏 | `real.md` | `real.md` 一致 |
| 嵌套反引号 | `real.md` | `real.md` 一致 |

## Decision

**删掉前置剥离，`verifyOne` 直接传原文给共用件。**

共用件 `collectRelativeLinks` / `undefinedReferences` 内部已用 mdast 清掉
围栏、行内代码与 HTML，且它返回的偏移是**原文**偏移 —— 这正是
`extractLinks` 里 `text.slice(l.start, l.end)` 需要的。传原文同时修掉偏移基准。

顺带删掉已成死代码的 `stripCodeFences`，并把文件头那段
「为什么不用 mdast」改成事实：那个判断已被前一篇推翻，留着会误导下一个人。

## Alternatives considered

- **保留 `stripCodeFences`，只把共用件的清码关掉** —— 改动更小。
  **否掉因为那等于把 mdast 已解决的问题退回给正则**：围栏嵌套、语言标注、
  未闭合、缩进全都要正则重新认一遍，正是前一篇否掉手写解析的理由。
- **两处都留，靠「取交集」避免误报** —— 听起来最稳。
  **否掉因为交集会让真实链接也被吞**（任一道正则漏认就漏检），
  而漏检比误报更难发现：误报会被人报 bug，漏检不会。
- **只删调用、不删函数定义** —— 留个「以后可能用」。
  **否掉因为死代码是负资产**：它会被下一个人当成在用路径读，而它的口径与
  现行实现不一致。本次删除连同注释里的引用一起清。

## Consequences

- **收益**：未闭合围栏、缩进围栏下的误报消失；三个消费方的代码区口径
  终于统一到一处（前篇设立的共用件现在真的只有一个入口）。
- **收益**：`md-links.mjs` 少一层字符串拷贝（`stripCodeFences` 每次校验都要
  对每份文档做两次全文字符替换）。
- **代价与已知上限**：现在断链报告给的行列位置在**原文**上，与修复前一致
  （共用件返回原文偏移），所以这条没有变化 —— 但将来若某人给共用件加
  「返回剥离后坐标」的选项，这里的错误信息会悄悄错位。
- **代价与已知上限**：误报依赖 CommonMark 对「缩进≤3 空格的围栏合法」的判定。
  若上游改用更严格的围栏规则，这里的“缩进围栏”用例要跟着改判据。
- **重访信号**：
  - **若 `bilingual-docs.mjs` 仍在用自己的 `withoutFences`** → 那是第四处口径，
    按同一理由并入共用件（它替换成 `\n` 而不是等长空白，会动偏移）。

## Verification

```sh
node --test tools/md-links.test.mjs   # 16/16，含 1 条故障注入
npm run md:links                     # 79 文档、161 链接全可达
```

故障注入：把 `verifyOne` 改回「先 `stripCodeFences` 再传共用件」，
在未闭合围栏输入下必须报出围栏内那条假链接。第一版注入用了**正常围栏**，
结果恒假 —— 那说明场景选错了，不是用例无效；换成未闭合围栏后才真红。
