# Agent Note: 全流程核查完毕，8 个方向的证据链与剩余缺口

Status: implemented

> **先厘清「上游」指的是谁** —— 本仓库有两个不同的上游，混淆过一次：
>
> | 上游 | 是什么 | 本仓库与它的关系 |
> |---|---|---|
> | `deepseek-ai/deepseek-harness`（**DSH 本体**） | 方法论的发源地，含 42 道 `verify-*` 与 `.agents/notes/` 实践 | **本篇的比对对象**：逐项看它的门禁有没有值得吸收的 |
> | `czm15053/write-notes-like-deepseek` | 把 DSH 实践提炼成 skill 的中间层 | `skills/agent-notes/` 是它的 vendored 副本，由 `sync-upstream.mjs` 按 `upstream.json` 的固定 ref 合并 |
>
> 而 `dsh-tauri/dependencies/` 下的路径是**本机 DSH 的安装位置**（`live-evidence.mjs`
> 要从那里加载真实宿主类），**不是比对对象**。这一点曾被误读，故写在最前。

> 这是**上游比对**这条线的收尾篇。它汇总前十几轮的全部核查结论，
> 并明确列出「已核查无吸收点」与「明知不做的缺口」。
> 各方向的原始判定见本仓库 `rejected/architecture/` 下两篇，以及
> [2026-10-19-upstream-verify-count-was-wrong.md](../process/2026-10-19-upstream-verify-count-was-wrong.md)
> （那一篇修正了核查清单本身的分母）。

Independent: 本篇是**收尾与汇总**，不是新的技术决定 —— 它记录「核查到此为止」
这个判断的依据，与各篇具体判定（那些写「某项为什么不做」）分工不同。

## Problem

goal 要求「全部核查完毕后确认无实质优化空间再标记完成」。

而「我觉得查完了」不是证据。前几轮已经证明过我的印象会错：

- 我以为上游有 65 道 `verify-*`，实际是 **42**；
- 我以为已核查 6 项、快查完了，实际还有 **32** 项没看；
- 我以为 `md-links` 抓不到目录链接的问题，实际它会直接崩溃。

所以收尾必须基于**可核对的产物**：哪个方向、哪篇笔记、哪次实测。

## Decision

### 一、8 个方向的证据链

| 方向 | 关键证据 | 笔记 |
|---|---|---|
| **笔记本体** | 40 篇笔记三门禁全绿；归档路径实机验证（临时仓库真归档，封印与格式重写都正确）；supersession 检查 | `client-bundle-and-archive-paths-verified` |
| **门禁链** | 13 步 check 链，每步有测试与故障注入；`gate:fault-injection` 证明每条都能变红；`ci:align` 证明都在 CI 里 | `gates-that-nobody-runs-are-not-gates` |
| **hooks** | commit-msg 从 2 道扩到 8 道；真仓库实测拦截与放行；生成物一致性门禁 | `gates-that-nobody-runs-are-not-gates`、`generated-hook-drifted-from-source` |
| **CI** | verify job 从 8 步扩到 13 步；`ci:align` 门禁；分支保护（required checks + 禁 force push） | `gates-that-nobody-runs-are-not-gates`、`branch-protection-makes-gates-enforceable` |
| **命令/工具** | 25 个 scripts 全核对；十脚本跨仓库实测 9/10 可用；`verify-notes` 四种用法从全崩到可用 | `verify-notes-was-never-actually-standalone`、`comments-are-claims-not-facts` |
| **客户端** | `lib/client.js` 是构建产物；bundle 同步门禁实测会红（两种注入都拦住） | `client-bundle-and-archive-paths-verified` |
| **发布流程** | `release:check`（版本/日期/递减）；`notices:check`；实机证据链验 10 项宿主契约 | `release-bookkeeping-needs-a-gate`、`live-evidence-path-verified` |
| **文档** | `md:links`（45 文档、96 链接）、`docs:bilingual`、`text:integrity`、`doc:budget`；两版 README 归属指向已修 | `markdown-links-need-a-gate`、`bilingual-docs-compare-structure-not-length`、`ufffd-passes-every-gate`、`comments-are-claims-not-facts` |

### 二、上游 42 道 `verify-*` 的最终判定

| 判定 | 数量 | 依据 |
|---|---|---|
| **已实现** | 4 | `verify-agent-note-{format}`、`verify-archived-agent-notes`（vendored 直接用）、`doc-budgets`（`doc-budget.mjs`）、`md-links`（`md-links.mjs`） |
| **已部分实现** | 1 | `translation-pairing`（比结构，不补逐节哈希） |
| **有理由不适用** | 7 | `md-wrap`、`no-top-level-await`、`export-jsdoc`、`public-repository-links`、`concrete-terms`、`runtime-closure`、`agent-note-classification` |
| **结构性不适用** | 30 | 读 `packages/`、`cordis.yml`、`.d.ts`、VitePress 站点等本仓库没有的路径 |

合计 **4 + 1 + 7 + 30 = 42**，每项恰好归一类。

> **这张表我填错过两次，都被脚本抓出来：**
>
> 1. 第一版把 `md-links` 同时算进「已实现」与「不适用」→ 合计 43；
> 2. 第二版把 `verify-agent-note-tree.ts` 算进「已实现」→ 合计 43。那个文件
>    **确实存在于上游 `scripts/`**（本仓库一直在用它），但**没被任何
>    `package.json` script 引用** —— 而 42 这个分母是「被引用的 verify 脚本」。
>
> 两次都是「表格看起来整齐、数字也能凑对」，只是分类本身错了。
> **所以分类必须由脚本产出，并断言「每项恰好一类 + 合计等于真实总数」**，
> 不能凭印象填表。
>
> 顺带记下分母的边界：「被 `package.json` 引用的 verify 脚本」= 42，
> 而「`scripts/` 目录里的 `verify-*.ts` 文件」可能更多。本篇用前者 ——
> 它代表**上游实际在跑的门禁**。

### 三、明确接受的缺口（不是「没想到」，是「想过不做」）

| 缺口 | 为什么接受 | 重访信号 |
|---|---|---|
| 实机证据不在自动门禁 | 需装了 DSH 的 CI；且 DSH 升级会与「插件坏了」混淆 | 出现「DSH 升级后本地全绿但失效」的事故 |
| 中英 README 只比结构，不补逐节哈希 | 人工维护的翻译有合理表述差异，哈希会逼出假红 | 真的出现过「结构对但某节漏译」 |
| 归档路径无自动化测试 | 成本不对称（建临时仓库跑 TS 脚本），且未退化过 | 归档数增长到 10 篇以上 |
| 客户端 bundle 无自动化测试 | 核查要改真实 `src/` 再还原，并行测试会撞车 | 出现「改 src 忘 build」的真实事故 |
| `verify-md-wrap` 不做 | 缩进代码块 0 处，中文排版依赖折行，误报必然、收益为零 | 大量用行内代码表达断行且造成困扰 |
| 锚点校验不做 | 手写 slug 与 GitHub 逐字一致才有效，否则是另一种假绿 | 首次出现 `#fragment` 链接 |

### 四、非 verify 类上游脚本

135 个，多数是构建/打包/发布（Tauri 桌面端专属）。唯一值得对的是
`build:check`（`build.ts --scope check`，构建并校验）—— 本仓库的等价物是
`verify-plugin.mjs` 里的**重建比对**，已实现且已验证会红。无吸收点。

## Alternatives considered

- **不写收尾篇，直接标记 goal 完成** — 省一篇笔记。否掉因为「为什么可以停了」这个判断本身需要留痕：半年后有人问「上游还有没有该吸收的」，答案必须能从仓库里找到，而不是靠记得。
- **把 42 道 verify 逐条写进一篇长清单** — 更完整。否掉因为 29 道结构性不适用的理由同构（「读 `packages/`，本仓库没有」），逐条写会稀释真正有信息量的那 13 条。已在表格里按类别归纳，具体判定在两篇 rejected 笔记里。
- **把「明知不做的缺口」单独拆一篇 rejected** — 语义更纯。否掉因为那些缺口**不是被否决的方案**，而是**已落地决定的已知上限** —— 它们与对应的 implemented 笔记是同一件事的两面，拆开会让「某项做了什么、代价是什么」分散在两处。
- **继续核查，不标记完成** — goal 还有 240 轮额度。否掉因为**没有候选了**：8 个方向有证据，42 道 verify 全判定，非 verify 类无吸收点。继续下去只能为了「有产出」而制造改动，那正是 goal 明令禁止的。

## Consequences

- **收益**：把「核查完毕」从印象变成可核对的表格。8 个方向各自对上了笔记与实测，42 道 verify 有明确分类。
- **收益**：6 项明确接受的缺口有了重访信号 —— 它们不是遗漏，是权衡后的取舍，且每条都写清了「什么情况下该重新考虑」。
- **收益**：顺带清理了 `.probe/` 下十几轮的探针残留（2.6M → 546K），根目录保留 8 个更早轮次的浏览器/性能探针（有参考价值）。
- **代价与已知上限**：本篇是**汇总**，具体理由分散在 15+ 篇笔记里。新读者要理解某个判定，需要跳转。这是笔记树按「一次改动一篇」组织的固有代价。
- **代价与已知上限**：缺口表里 4 项「无自动化测试」的接受理由是「成本不对称 + 未退化过」。若其中任何一项退化，那个理由就不成立了 —— 但退化时不会有人自动想起这张表。**这是本篇最弱的一环**：重访信号需要人主动查，而没有机制提醒。
- **重访信号**：若上游新增 `verify-*`，需重新跑一遍分类（`audit-verify-list.mjs` 的思路可复用）。若本仓库开始发布可被第三方 import 的库，`export-jsdoc` 的判定要重评。

## Verification

```sh
npm run check              # exit 0：13 步门禁、300 测试、40 篇笔记
npm run gate:fault-injection   # 每条门禁都能对该拦的故障变红
```

清理后复查：

```sh
git status --porcelain     # 空
du -sh .probe              # 2.6M → 546K
git ls-files .probe        # 空（不入库）
```