# Agent Note: 我说「不需要 mdast」说错了 —— 上游用 mdast 多测了三项

Status: implemented

> 与 [2026-10-19-bilingual-only-fence-langs-are-unambiguous.md](../process/2026-10-19-bilingual-only-fence-langs-are-unambiguous.md)
> 直接接续 —— 那一篇断言「**不需要 mdast**」。本篇**纠正那个断言**：
> 它成立，但只对「我实际比的那几项」成立；作为对整个双语门禁的判断，它是错的。
> 那篇本轮刚合并，不改它 —— 按笔记树规矩「理由翻转就新开一篇并互链」。

Independent: 本篇不引入新门禁，只**纠正一个结论的范围**。它不影响任何门禁行为
—— 那三项的上游做法是**待评估的信号**，不是已知该做的改动。

## Problem

本轮审计「非 verify 类 135 个脚本已看」时，顺手读了缓存里的上游源码，发现：

`up-translation-pairing.ts` —— 上游那个双语配对门禁 —— **真的在用 mdast**：

```ts
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import type { Nodes } from 'mdast'
```

而我本轮的结论是「**不需要 mdast**」。**那正是我否决掉的东西。**

## Decision

**纠正结论的范围，不改任何门禁行为。**

### 先说对的部分：段落数确实不该取

上游的签名构建（`:352-382`）有个 `default` 分支：

```ts
default:
  // Every other node kind is prose or a container, not part of the signature.
  break
```

**它明确不取段落。** 而我实测的结论正是「段落数/列表数在中英之间不是漂移
信号」—— 那 30 处「差异」全是排版惯例造成的假象。

**所以上游在这一点上与我一致**，只是理由不同：它是按「prose 不是结构」排除的，
而我是按「实测它会常红且红得没道理」排除的。

### 说错的部分：上游取了我否决的三项

上游签名由**五项**组成：

| 项 | 源码 | 我本轮做的 |
|---|---|---|
| `sig.headings` | `node.depth` 逐个推入 | ✅ 已有（我原本就有） |
| `sig.code` | `` `\`\`\`${lang}${meta}\n${node.value}` `` —— **含代码块完整内容** | ⚠️ **只比了 `lang`** |
| `sig.tables` | `` `${rows}x${cols}` `` —— **表格行列数** | ❌ 无 |
| `sig.lists` | `` `bullet:items=..` `` / `` `ordered:start=..:items=..` `` —— **列表项数** | ❌ 无（我否决了） |
| `sig.links` | 链接**目标**，且**排除语言切换链接** | ❌ 无 |

**我否决了 `tables` 与 `lists`，只做了 `headings` 的一部分与 `code` 的一部分。**

### 为什么当初会否决得那么绝对

我当时看到的「30 处差异」是在**README.md / README.en.md** 这一对上测的，
逐条看下来是排版差异。

但上游比的是它自己的文档对（`foo.md` / `foo.zh.md` / `foo.i18n.yaml`），
而且它有两层降噪机制：

- `translation-pairing.manifest.json` 的 `excluded` 字段 —— 手工豁免清单
- `GENERATED_REGION`（`<!-- BEGIN GENERATED -->`）—— **生成区不参与比对**

**我没有这两层。** 所以「列表项数在本仓库不是信号」这个结论，
**只对 README 这一对成立，不能推广**。

### 所以正确的说法是

- ❌ 「双语门禁不需要 mdast」← **我上轮说的，过强**
- ✔ 「比语言标记不需要 mdast」← **成立**（它在围栏行上，正则够）
- ⚠️ 「表格行列数 / 列表项数 / 代码块内容 / 链接目标该不该比」← **尚未评估**

## Alternatives considered

- **立刻按上游的五项签名改门禁** — 证据充分。**这是本篇最强的一条被否方案**，因为我在**没有降噪机制**的情况下直接比列表项数：README 上那 30 处排版差异会立刻让门禁恒红，而**恒红的门禁等于没有门禁**。要先有 `excluded` 清单或生成区标记，才有资格比列表项数。
- **直接抄上游的 `GENERATED_REGION` 语法**（`<!-- BEGIN GENERATED x -->` … `<!-- END GENERATED x -->`）— 它是「唯一住处」，被配对门禁与生成器共用，语义清晰。**但本仓库目前没有生成区概念** —— README 全是人写的。**先造概念再用它过滤，是本末倒置。**
- **改口说「我上轮说错了」就完事** — 最省事。**否掉因为那会丢掉可操作的部分**：那三项**该不该比**是个真问题，需要给出评估路径而不是一句认错。
- **什么都不做**（保持现状，只纠正措辞）— 这是本篇的决定。

## Consequences

- **收益**：纠正了一个会误导后来者的结论。「不需要 mdast」若被当成「双语门禁到此为止」，就会关掉一个真实的改进方向。
- **收益**：记下了上游签名的五项构成，以及它**排除段落**的显式理由 —— 那是「prose 不是结构」的另一种表述。
- **代价与已知上限**：**本仓库的门禁能力仍低于上游** —— 代码块内容、表格行列、列表项数、链接目标四项都没比。这是**已知的差距**，不是遗漏。
- **代价与已知上限**：**本轮无法验证上游那三项在本仓库是否有意义** —— 我只有它的源码，没有它的文档对做对照实验（网络不通，且它的文档不在缓存里）。所以「该不该比」这件事**本轮只是提出，没有结论**。
- **重访信号**：
  - **若本仓库出现「表格两版行列数不同」或「列表项数不同」的真实事故** → 立刻比那两项，且**先建 `excluded` 清单**。
  - **若本仓库引入生成型文档**（如 `lib/client.js` 由 `build.mjs` 生成、README 里嵌入生成片段）→ 立刻需要 `GENERATED_REGION` 那种降噪机制，然后才谈比列表项数。
  - **代码块内容这一项值得单独评估** —— 它与段落数不同：代码不承载语言，所以**内容必须逐字一致**。我本轮实测发现代码块里混着命令输出示例（要翻译的），所以不能简单比全文。但**可以比「去掉注释后的命令部分」**。这个折中本轮没做，留作下一步。

### 事后补记（同日，第 9 轮复审时发现）

「改完必须 `npm run build` 重新生成 bundle」这条当时记的是客户端信封，
但同一轮重写 `tools/markdown-links.mjs` 时，**整个文件头注释（约 37 行
设计理由）被我整段删掉了**——包括「三处共用」「上游为什么支持参考式」
「偏移契约」。功能与测试全绿，所以没有任何门禁发现它。

那正是本仓库反复记的「注释承诺 ≠ 实现做到」的**镜像**：
实现做到了、注释丢了。区别只在前者会被人发现，后者不会
（注释缺失不产生任何可观测症状）。

已补回，并把「调用方必须传原文、不要双重剥离」写进偏移契约
—— 后者是后续五次口径分叉的共同根因，写在共用件里比写在四篇
分叉笔记里更难被绕过。

## Verification

```sh
node .probe/tmp/analyze-mdast-usage.mjs   # 读上游的签名构建代码
node .probe/tmp/verify-my-verdict.mjs     # 读 :348-390 行原文
```

实测证据（上游源码 `:352-382`）：

```
case 'heading':  sig.headings.push(node.depth)
case 'code':     sig.code.push(`\`\`\`${node.lang}${meta}\n${node.value}`)
case 'table':    sig.tables.push(`${rows}x${cols}`)
case 'list':     sig.lists.push(node.ordered ? `ordered:start=..:items=..`
                                          : `bullet:items=..`)
case 'link':     if (node.position?.start.offset !== switcherOffset)
                   sig.links.push(linkTarget(node))
default:         // Every other node kind is prose or a container,
                 // not part of the signature.
```
