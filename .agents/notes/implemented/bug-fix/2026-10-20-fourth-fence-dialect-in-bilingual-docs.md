# Agent Note: 同一处围栏口径第四次分叉 — bilingual-docs 还在用自己的正则

Status: implemented

> 接 [2026-10-20-code-stripped-twice-fenced-example-became-broken-link.md](./2026-10-20-code-stripped-twice-fenced-example-became-broken-link.md)
> —— 那篇清掉了 `md-links.mjs` 的双重剥离，并在「重访信号」里写明：
> **若 `bilingual-docs.mjs` 仍在用自己的 `withoutFences`，那是第四处口径，
> 按同一理由并入共用件**。本篇就是执行那一信号。

Independent: 那篇改 `md-links.mjs` 的接线，本篇改 `bilingual-docs.mjs` 的
口径来源。同一个共用件的两个消费方，决定分别落地，故各记一篇。

## Problem

`tools/bilingual-docs.mjs` 的 `structureOf` 里有一行：

```js
const withoutFences = text.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g, '\n');
```

它**不是**双重剥离（这里只剥一次），而是**第四套独立口径**：自带正则，
与共用件的 mdast 判据不同。

实测（`.probe/probe-bilingual-fence.mjs`，同一输入两套口径比标题层级）：

| 输入 | 正则 | mdast |
|---|---|---|
| 正常围栏内有 `#` 注释 | `[2]` | `[2]` 一致 |
| **未闭合围栏** | **`[1, 1]`** | **`[1]`** |
| 缩进围栏 | `[2]` | `[2]` 一致 |
| 行内代码含 `#` | `[2]` | `[2]` 一致 |

正则在未闭合围栏下抹不掉块内内容，于是示例里的 `# 假标题` 被数成
**又一个一级标题**。mdast 按 CommonMark 判它一路延伸到文末、整段都是代码。

★ 危害形态是**假阴性**：两版 README 若都带未闭合围栏，两边都多数一个标题，
门禁照样绿。而误报至少会被人报 bug，漏检不会。

## Decision

**`structureOf` 改用共用件的 `blankOutFences`，删掉自带正则。**

它替换成**等长空白**而非 `'\n'`，这里仍然安全：`structureOf` 只按行遍历
（数标题、扫表格），不做偏移替换，行数不变即可。（`md-links` 那次需要保偏移，
因为它要把 `start`/`end` 交回接线方做精确改写 —— 两个消费方需求不同，
但**口径同一处**。）

### 第二处：围栏计数与语言标记也是正则

写完上文后按它自己写的重访信号自查（`grep '(```|~~~)' tools/*.mjs`），
发现同一函数里还有两行正则，且分叉更坑：

| 输入 | 正则 | mdast |
|---|---|---|
| 未闭合围栏 | `fences=0, langs=["sh"]` | `fences=1, langs=["sh"]` |
| 围栏内含围栏标记文本 | `fences=1` | `fences=2` |
| **缩进围栏** | `fences=1, langs=[]` | `fences=1, langs=["sh"]` |

★ 第三种是**数量对、语言标记 silent 丢失** —— 两版都丢时门禁照样绿，
比误报危险得多。根因：`^\s*` 让缩进围栏进得了 `fenceLines`，
却进不了 `marks` 的 `(?:^|\n)` 分支，**数量与语言标记用了两套边界**。

一并改成从摊平的 AST 里取 `type === 'code'` 的节点（数量）与 `node.lang`（标记）。

## Alternatives considered

- **保留正则，只把「未闭合围栏」补一条特例** —— 改动最小。
  **否掉因为那是在给正则打补丁**：未闭合只是已发现的一种，还有缩进超限、
  围栏标记不匹配、围栏内嵌围栏等一堆未枚举形态。mdast 一次全覆盖，
  补丁只会让正则越来越像 mdast 却不如它。
- **两套口径取交集**（都认为是代码才当代码）—— 看起来最稳。
  **否掉因为交集会放大漏检**：任一套漏认就漏一处，而漏检无声。
  并到一处至少让「代码区判据」只有一个真相。
- **换 mdast 但保留 `'\n'` 替换** —— 省几字节。
  **否掉因为「替换成什么」与「按什么判」是两件事**：等长空白保留了未来
  若要做报错行号时的可能性，而换掉判据才是本次的目的。混在一起会让下
  一次改口径的人误以为行号已经能用了。

## Consequences

- **收益**：四处围栏口径收敛到一处（`blankOutFences`），
  `md-links` / `archive-note` / `bilingual-links` / `bilingual-docs` 一致。
- **收益**：未闭合围栏下的假标题不再计入结构指纹。
- **代价与已知上限**：`blankOutFences` 只清块级 `code`，不清 `inlineCode`。
  实测当前四种形态下行内代码与块级结论一致（行内 `#` 后跟空格才算标题，
  而行内代码在段内、不在行首），但若将来结构指纹开始按字符偏移判内容，
  这条要重新评估。
- **代价与已知上限**：现在「报错指向第几行」仍不可靠（掩码是空格行不是空行），
  与修复前一样 —— 本次不改这件事，只改判据来源。
- **重访信号**：
  - **若还有人往 `tools/` 里贴围栏正则** → 那是第五处口径。判据：
    `grep -n '(```|~~~)' tools/*.mjs` 应只剩共用件内部那一处。

## Verification

```sh
node --test tools/bilingual-docs.test.mjs   # 25/25，含 1 条故障注入
npm run docs:bilingual                      # 真仓库两版结构一致
npm run check                               # 全链
```

故障注入：把共用件的 `blankOutFences` 改回正则口径（等长空白），
未闭合围栏输入下 `structureOf` 必须输出 `[1,1]`（多数出假标题）。
第一版断言写成期望 `[1]` —— 把「注入后应该变红」写反了，
于是绿灯证明的是注入**没生效**，恰恰是要防的假绿。
