# Agent Note: 上游非 verify 类脚本 26 个已核查，无一值得吸收

Status: rejected — 26 个脚本逐个读源码，全部无吸收点或本仓库版本更强

> 同属**上游比对**这条线，是
> [2026-10-19-upstream-comparison-complete.md](../../implemented/process/2026-10-19-upstream-comparison-complete.md)
> 的补充：那篇覆盖 `verify-*`（42 个），本篇覆盖**非 verify 类**。
> 归档相关的判定与本篇交叉印证，见
> [2026-10-19-archiving-breaks-links-by-design.md](../../implemented/process/2026-10-19-archiving-breaks-links-by-design.md)。

Independent: 本篇核查的是**辅助工具脚本**（build/test/hook/通知生成等），
与 `verify-*` 门禁族（那篇）是不同的类别 —— 前者是工具，后者是判据。
## Problem

前几轮我只系统核查了 `verify-*` 门禁族（42 个）。上游 `scripts/` 里还有
**26 个非 verify 的脚本**没逐个读过 —— 它们是辅助工具（变更范围计算、
并行调度、钩子安装、通知生成），可能有可吸收的实现。

不查的风险：漏掉「上游已经解决过、我们重复造轮子」的地方。
## Proposal

曾考虑吸收上游这 26 个非 verify 脚本，逐条列在这里以便日后重新评估：

1. **`change-scope.ts`** —— 变更范围报告器（`--base` + `--head`，输出
   committed/staged/unstaged/untracked 四个路径集）。
2. **`archived-agent-notes.ts` 的额外检查** —— `.md`+`.zh.md`+`.i18n.yaml`
   三元组完整性，以及 Git blob SHA-1 sidecar 封印。
3. **`markdown.ts`** —— 用 mdast 解析 Markdown，替换本仓库 `bilingual-docs.mjs`
   的正则剥围栏。
4. **`run-gates.ts` / `parallelism.ts`** —— 门禁并行执行，压缩 41 秒的
   `npm test`。
5. **`install-lefthook.mjs`** —— 用 lefthook 管理 git 钩子。
6. **`repo-files.ts` 的自实现 glob walker** —— 处理 `fs.glob` + `**` +
   符号链接 ENOTDIR 的组合。
7. **`translation-pairing.ts` 的链接目标逐条比对** —— 不只比结构，还比
   两版里每个链接指向的目标是否一致。

它们看起来都能带来改进，理由分别是「上游已经解决过」「能压缩耗时」
「能更严格」。**但逐条读源码后，7 项全部不采纳** —— 见下。

## Decision

**26 个逐个读源码，无一值得直接吸收。** 关键判定：

| 上游脚本 | 本仓库等价物 | 判定 |
|---|---|---|
| `change-scope.ts` | `notes-coverage.mjs:258-282`（diffPaths 已内联） | **已吸收**，本仓库注释明写「我最初判定它们不必要，那是错误的判据」 |
| `verify-doc-budgets.ts` | `doc-budget.mjs` | **本仓库更强**：上游用 `wc -w`，对中文严重低估；本仓库按 CJK 逐字计费 |
| `archived-agent-notes.ts` | `verify-archived-agent-notes.ts`（vendored） | 上游多出的「`.md`+`.zh.md`+`.i18n.yaml` 三元组」与「Git blob SHA-1 sidecar」是**上游的双语要求**，本仓库笔记树不要求双语，照搬只会凭空造红。它独有的 `Archived:` 日期校验本仓库已实现 |
| `markdown.ts` | `bilingual-docs.mjs` 用正则剥围栏 | 否：依赖 mdast，违反零依赖约束 |
| `run-gates.ts` / `parallelism.ts` | `package.json` 的 13 步串跑 + `ci-alignment.mjs` | 否：与本仓库「零依赖 + 线性 check」的路线直接冲突 |
| `install-lefthook.mjs` | `install-hooks.mjs` | 否：引入 lefthook 依赖，换不来东西 |
| `gen-third-party-notices.ts` | `notices.mjs` | 否：已明确取舍过 |
| `agent-note-tree.ts` | vendored 同一份 | 否：同一份代码，本仓库不得手改 |
| `test-fixture-cleanup.ts` | 无 | 否：本仓库不建 junction |

**两处值得记但本轮不改**：

1. **`repo-files.ts` 的自实现 glob walker** —— 它的触发条件是
   `fs.glob` + `**` + 符号链接 ENOTDIR 三者同时出现。本仓库全手写
   `readdirSync`（`grep globSync tools/*.mjs` 零命中），那个条件不存在。
2. **`translation-pairing` 的链接目标逐条比对** —— 这**正是**
   `bilingual-docs.mjs` 注释里已写下的重访触发条件。应单开一篇笔记，
   不该在核查任务里顺手改（那属于「有归属的改动」，规矩要求就地更新事实）。

**附带验证（交叉印证）**：上游所有文档类门禁都把
`.agents/notes/archived/` 当冻结历史排除 —— 这**独立印证**了同一批改动里
我给 `md-links.mjs` 加的排除是对的（那篇笔记的依据是读上游第 33 行的注释）。

## Alternatives considered

- **把 `archived-agent-notes.ts` 的三元组检查照搬过来** — 它能防止「归档笔记缺翻译」。**这是本篇最强的一条被否方案**，因为本仓库的笔记树**不要求双语**（`docs:bilingual` 只管 `README.md` / `README.en.md`）。照搬后每一篇归档笔记都要有 `.zh.md` + `.i18n.yaml`，而本仓库根本没有这个约定 —— 结果是凭空造红。
- **用 `markdown.ts`（mdast）替换 `bilingual-docs.mjs` 的正则剥围栏** — 正则确实脆弱。否掉因为它引入 mdast，而本仓库的硬约束是零运行时依赖（`verify-plugin.mjs` 会拦 `@deepseek-ai/*`，但 mdast 也会让 `npm test` 需要 `npm install` 才能跑）。且正则方案的实际失效面已知且可控（只比结构，不比内容）。
- **采用 `parallelism.ts` 并行跑门禁** — 能把 41 秒的 `npm test` 压下来。否掉因为并行测试正是本仓库踩过 5 轮的坑的根源（测试互相写真实目录）。而且门禁是串行的**语义要求**：前面的门禁红了，后面的跑了也没意义。
- **真跑一遍上游脚本再下结论**（而不只是读源码） — 见下「代价与已知上限」。

## Consequences

- **收益**：`verify-*` 之外的类别也核查完了，两个上游的**全部可吸收点**已穷尽。
- **收益**：拿到 4 处「本仓库版本比上游强」的证据（diff flags、CJK 计费、archived 格式、线性 check），这些是**已经做对的决定**，现在有了出处。
- **收益**：两处「值得记但不改」的判定被明确归位 —— 尤其第 2 点（translation-pairing 的链接比对）是 `bilingual-docs.mjs` 自己写下的重访信号，不该被一次核查任务顺手实现。
- **代价与已知上限**：**结论全部来自源码阅读，没有真跑上游脚本** —— 那需要上游 monorepo 的依赖树（328 个文件、`pnpm` workspace）。所以「照搬会造红」这类判断是推理，不是实测。这是本篇最弱的一环。
- **代价与已知上限**：核查由 teammate 完成，我核对了它的源码引用（给了具体文件与行号），但没有逐条重跑它的比对。**这是「不许只凭执行者汇报就标完成」的边界** —— 我核对了证据链，但没重做全部 26 个。
- **重访信号**：
  - 若本仓库开始要求**笔记双语**（每篇笔记都要 `.zh.md`），则上游的 archived 三元组检查立刻变成真需求。
  - 若 `npm test` 的 41 秒开始成为瓶颈，可重新评估并行（但必须先解决测试写真实目录的问题）。
  - 若上游 `markdown.ts` 的 mdast 依赖被本仓库接受，则 `bilingual-docs.mjs` 的正则方案该重估。

## Verification

本轮无代码改动。findings 在 `.probe/probe-upstream/findings.md`（按仓库约定探针不入库）。

```sh
npm run check    # exit 0（300 测试、42 篇笔记）
```
