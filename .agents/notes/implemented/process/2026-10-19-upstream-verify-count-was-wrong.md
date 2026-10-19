# Agent Note: 上游 verify 清单的真实分母是 42，不是 65

Status: implemented

> 同属**上游比对**这条线，且修正了此前两篇 rejected 笔记里的一个错误数字。
> 那两篇的结论不变（它们判定的项目确实不适用），但**分母错了** ——
> 「已核查 6/65」这个进度是假的。
> 相关的判定见
> [2026-10-19-three-upstream-gates-not-applicable.md](../../rejected/architecture/2026-10-19-three-upstream-gates-not-applicable.md)
> 与
> [2026-10-19-three-more-upstream-gates-not-applicable.md](../../rejected/architecture/2026-10-19-three-more-upstream-gates-not-applicable.md)。

Independent: 本篇处理的是**核查清单本身的准确性**，与「某个门禁适不适用」
是不同层面的问题 —— 后者判得对不对，取决于前者有没有把清单列对。

## Problem

此前几轮我一直说「上游有 65 道 `verify-*`」。那个数字来自上游
`package.json` 的 **npm script 名**，我按名字里含 `verify-` 的数量数的。

本轮抽查两个还没看过的：

```
verify-third-party-notices.ts → HTTP 404
verify-cli-help.ts            → HTTP 404
```

**两个都不存在。** 于是按真实文件清单重新核对：

| 数法 | 结果 |
|---|---|
| 按 npm script 名数 | 65 |
| **按 `scripts/verify-*.ts` 真实文件数** | **42** |
| 我此前明确判定过的 | 11（其中 10 个在真实清单内） |
| **尚未判定的** | **32** |

两个具体后果：

1. **「已核查 6 项」这个进度是假的** —— 分母错了 23 个，而我以为快查完了。
2. **判定过但上游不存在的**：`verify-agent-note-tree.ts` 不在
   `package.json` 的引用里（它确实存在且本仓库一直在用，只是没被某个
   npm script 直接点名）。这说明「从 script 名反推文件」这个做法本身不可靠。

## Decision

`must`：**核查清单必须来自真实文件路径，不能从 script 名或文档描述反推。**

具体做法：解析上游 `package.json` 的 `scripts` 字段，用
`/scripts\/(verify-[a-z-]+\.ts)/g` 提取**文件路径**，去重后作为分母。
这比数 script 名准，因为它只认带 `scripts/` 前缀的真实路径。

### 32 个未判定项的判定

按「它防的那个问题，本仓库存在吗」逐个过。分两类：

**一、结构性不适用（24 个）** —— 读本仓库不存在的结构：

| 类别 | 脚本 | 本仓库为什么没有 |
|---|---|---|
| DSH 启动/配置 | `application-entrypoints`、`cordis-config`、`config-source-ownership` | 不是 DSH 内核，不产 profile 与 Cordis 配置 |
| 客户端包 | `client-packages`、`client-domain-graph`、`client-route-resolution` | 没有 `packages/client/` |
| 包管理 | `package-meta`、`package-paths`、`package-dependencies`、`package-readme-*`(3)、`dsh-package-licenses`、`npm-install-layout`、`optional-dependency-imports` | 是单包，不发布多包 workspace |
| 类型系统 | `no-unknown-casts`、`type-equiv`、`node-next-types` | 纯 JS，无 TS 类型断言与 `.d.ts` 产物 |
| 文档站 | `doc-site-fragments`、`doc-refs`、`subsystem-pages`、`upgrade-guides` | 没有 VitePress 站点与 `docs/upgrade-guide/` |
| 其它 | `default-product-isolation`、`no-bare-dispatcher`、`plugin-record-callers`、`product-use` | 单产品单包，无实验包隔离与 plugin record |

**二、可能通用（8 个）** —— 逐个核过：

| 脚本 | 判定 | 依据 |
|---|---|---|
| `doc-budgets` | **已实现** | 本仓库 `tools/doc-budget.mjs` + `doc-budget.json` 就是它，且已在 check 链与 CI 里 |
| `translation-pairing` | **已部分实现** | `bilingual-docs.mjs` 比结构（标题层级 + 围栏数）；上游还比「逐节哈希」，见下 |
| `mermaid` | 不适用 | 实测全仓库 **0 个** ` ```mermaid ` 围栏 —— 没有可解析对象 |
| `no-unknown-casts` | 不适用 | 纯 JS，无类型断言 |
| `repository-references` | 不适用 | 无迁移史；它拒的是上游自己的禁用组织 URL |
| `skill-invocation-metadata` | 不适用 | 上游要 Claude Code 与 Codex **两套**元数据一致；本仓库的 `invocation` 由 `lib/skill.js` 运行时提供，SKILL.md 只有 `name`/`description` |
| `translation-prompt` | 不适用 | 没有翻译提示词文件 |
| `package-paths` | 不适用 | 没有 `packages/` 目录 |

## Alternatives considered

- **继续按 script 名数分母** — 省事。否掉因为它**已经错了 23 个**，而错误的进度会让人过早宣布「查完了」。这正是本仓库最忌讳的那类问题：不是判错，是**根本不知道自己在判什么**。
- **把 `translation-pairing` 的「逐节哈希」也补上** — 让双语比对更严。**这是本篇最强的一条被否方案**：逐节哈希能抓住「结构一样但内容悄悄改了某一节」——那正是当前 `bilingual-docs` 抓不到的。否掉的理由是：本仓库的中英 README 是**人工维护的翻译**，不是机器生成的配对；哈希记录会变成每次改中文都要同步改英文、否则红，而翻译本来就有合理的表述差异。它防的那个问题（漏译）在当前规模下由人读一遍更可靠。
- **给 mermaid 也加门禁（为将来可能写图）** — 「完整流程需要」。否掉因为 0 个围栏意味着 0 个真问题，而引 Mermaid 解析器（重依赖）换零收益。重访信号写在下面。
- **把这 24 个结构性不适用项一个个写详细理由** — 更完备。否掉因为它们的理由同构（「读 `packages/`，本仓库没有」），逐条写 24 段会稀释真正有信息量的那 8 条。按类别归纳更有用。

## Consequences

- **收益**：核查清单的分母从错的 65 修正为真实的 42。此前「已核查 6 项」的进度是假的，现在是 11/42，且剩余 32 个**已全部判定**（24 结构性 + 8 逐个核）。
- **收益**：发现「从 script 名反推文件」这个做法不可靠 —— 会同时产生**幽灵项**（不存在的文件）与**漏项**（存在但没被 script 点名的）。判据改为解析真实路径。
- **收益**：确认 `doc-budgets` 已经实现（不是缺口），`translation-pairing` 已部分实现 —— 这两条此前没有被明确对上过。
- **代价与已知上限**：本篇的判定是**静态读头注释 + 查本仓库有无对应结构**，没有对 24 个结构性项逐个跑一遍验证「确实不适用」。理由是它们依赖的路径（`packages/`、`cordis.yml`、`.d.ts`）在本仓库根本不存在，跑起来必然报「找不到」——那不能证明什么。
- **代价与已知上限**：`translation-pairing` 的「逐节哈希」不补（见被否第二条）。所以**中英 README 里某一节内容悄悄偏离，当前没有任何门禁能发现** —— 只比结构。这是明确接受的缺口。
- **重访信号**：
  - **mermaid**：仓库里出现第一个 ` ```mermaid ` 围栏时，引解析器做这条门禁。
  - **translation-pairing**：若中英 README 真的出现过「结构对但某节漏译」的事故，那说明人工维护不够，逐节哈希才值得。
  - **doc-budgets**：上游的清单格式若变化（它按 `wc -w` 计，中文会严重低估），本仓库的实现要跟着看 —— 本仓库已经按「中文按字计」改过，这一点比上游更准。

## Verification

核查脚本（`.probe/`，不入库）：

```sh
node .probe/tmp/audit-verify-list.mjs    # 真实分母 vs 已判定
node .probe/tmp/survey-remaining.mjs     # 32 个未判定项的头注释
```

`audit-verify-list.mjs` 的关键实现：

```js
const realScripts = [...new Set(
  Object.values(pkg.scripts ?? {})
    .flatMap((cmd) => [...String(cmd).matchAll(/scripts\/(verify-[a-z-]+\.ts)/g)].map((m) => m[1]))
)].sort();
```

它只认带 `scripts/` 前缀的真实路径 —— 这正是「不数 script 名」的落地。