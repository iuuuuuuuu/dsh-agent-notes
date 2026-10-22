# Agent Note: 全流程核查完毕，8 个方向的证据链与剩余缺口

Status: implemented

> **先厘清「上游」指的是谁** —— 本仓库有两个不同的上游，混淆过一次：
>
> | 上游 | 是什么 | 本仓库与它的关系 |
> |---|---|---|
> | `deepseek-ai/deepseek-harness`（**DSH 本体**） | 方法论的发源地，含 44 道 `verify-*` 与 `.agents/notes/` 实践 | **本篇的比对对象**：逐项看它的门禁有没有值得吸收的 |
> | `czm15053/write-notes-like-deepseek` | 把 DSH 实践提炼成 skill 的中间层 | `skills/agent-notes/` 是它的 vendored 副本，由 `sync-upstream.mjs` 按 `upstream.json` 的固定 ref 合并 |
>
> 而 `dsh-tauri/dependencies/` 下的路径是**本机 DSH 的安装位置**（`live-evidence.mjs`
> 要从那里加载真实宿主类），**不是比对对象**。这一点曾被误读，故写在最前。
>
> **订正（2026-10-21）：本篇的计数口径已被推翻。** 本文多处出现 46 / 44 / 43 / 42
> 四个分母，且 `:53-60` 的「5+1+6+30=42」建立在「被 `package.json` 引用」这一口径上，
> 而磁盘实测 `scripts/` 下有 44 处引用覆盖不全、另有 2 个 SSH 脚本完全不进任何 script，
> 故分母应取**磁盘枚举的 46 个非 spec `verify-*.ts`**。「结构性不适用」的 30 与
> 32 也自相矛盾。逐条唯一分类与 46 = 4 + 25 + 17 的对账见
> [2026-10-21-upstream-46-gates-classified-exactly-once.md](./2026-10-21-upstream-46-gates-classified-exactly-once.md)。
> 本篇保留的仍有效的部分：其判定理由、`verify-agent-note-classification` 那节、
> 以及 `:62-79` 记下的三条填错教训。

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

### 二、上游 44 道 `verify-*` 的最终判定

| 判定 | 数量 | 依据 |
|---|---|---|
| **已实现** | 5 | `verify-agent-note-format`、`verify-archived-agent-notes`（vendored 直接用）、`doc-budgets`（`doc-budget.mjs`）、`md-links`（`md-links.mjs`）、`agent-note-classification`（见下） |
| **已部分实现** | 1 | `translation-pairing`（比结构，不补逐节哈希） |
| **有理由不适用** | 6 | `md-wrap`、`no-top-level-await`、`export-jsdoc`、`public-repository-links`、`concrete-terms`、`runtime-closure` |
| **结构性不适用** | 30 | 读 `packages/`、`cordis.yml`、`.d.ts`、VitePress 站点等本仓库没有的路径 |

合计 **5 + 1 + 6 + 30 = 42**，每项恰好归一类。

> **这张表我填错过三次，每次都是「看起来对」：**
>
> 1. 把 `md-links` 同时算进「已实现」与「不适用」→ 合计 43；
> 2. 把 `verify-agent-note-tree.ts` 算进「已实现」→ 合计 43。那个文件
>    **确实存在于上游 `scripts/`**，但**没被任何 `package.json` script 引用**，
>    而 42 这个分母是「被引用的 verify 脚本」；
> 3. 把 `agent-note-classification` 判成「不适用」—— 只看了它封禁旧路径那一半，
>    没看到它的结构检查复用了 tree 门禁（**已在做**）。
>
> 前两次是**计数错**（合计能凑对但分类重叠），第三次是**判定错**（读名字不读源码）。
> 共同点：表格整齐、数字能凑对，**错误藏在分类里而不是算术里**。
>
> 所以：分类必须由脚本产出，并断言「每项恰好一类 + 合计等于真实总数」；
> 而判定必须读源码，不能读文件名。
>
> 顺带记下分母的边界：「被 `package.json` 引用的 verify 脚本」= 42，
> 而「`scripts/` 目录里的 `verify-*.ts` 文件」可能更多。本篇用前者 ——
> 它代表**上游实际在跑的门禁**。

#### `verify-agent-note-classification` 为什么算「已实现」而不是「不适用」

我最初判它「不适用」，理由是「它封禁 `docs/rfc` 旧路径，本仓库全历史零出现」。
**读了源码才发现那个理由只覆盖了它的一半。**

它实际做两件事：

| 它做的 | 本仓库现状 |
|---|---|
| ① 强制 lifecycle/class 路径与日期文件名 —— 复用 `agent-note-tree.ts` 的 `walkAgentNoteTree` | **已实现**：`verify-agent-note-tree.ts` 就在做，且故障注入证明会红（「非法分类目录 refactor」「文件名不符合 yyyy-mm-dd」「出现 INDEX.md」三条都 exit=1） |
| ② 封禁 `docs/rfc` / `docs/rfcs` | 本仓库 git 全历史**零出现**，连 `docs/` 目录都不存在 |

所以准确说法是：**主体已实现，只有第 ② 条那个封禁不适用**。整体归「已实现」。

> **教训：「这个门禁叫什么名字」与「它实际做什么」是两回事。**
> 名字里有 `classification` 就以为它是「分类规则检查」，而它真正的结构检查
> 是**复用 tree 门禁**的。判定必须读源码，不能读文件名。


#### 逐条清单（44 道，可复核）

**分母怎么来的**：上游 `package.json` 里有 **65 个** `verify-*` script 名，
但其中 21 个的值指向 `gen-*.ts` / `persistence-*.ts` —— 它们是**生成器**，
名字带 verify 而已。判据是「script 的值指向的文件名是不是 `verify-*.ts`」，
**不需要网络**。

⚠️ **我当初算成了 42，错了。** 当时用的是「逐个 URL 探测哪个 `.ts` 文件存在」，
而那个探测把**探测失败**（404 / 分支不对 / CDN 缓存）当成了「文件不存在」。
典型例子：`verify-cli-help` 的值是 `tsx scripts/gen-cli-help.ts --check`，
它返回 404，我据此划进「不存在」—— **结论巧合对了，理由是错的**。

**少数派 13 道（判定各有具体理由，不适用归纳）**：

- `verify-agent-note-format` —— **已实现**（vendored 直接用）
- `verify-archived-agent-notes` —— **已实现**（vendored 直接用）
- `verify-doc-budgets` —— **已实现**（doc-budget.mjs）
- `verify-md-links` —— **已实现**（md-links.mjs）
- `verify-agent-note-classification` —— **已实现**（见下节）
- `verify-translation-pairing` —— **部分实现**（比结构，不补逐节哈希）
- `verify-md-wrap` —— **有理由不适用**
- `verify-no-top-level-await` —— **有理由不适用**
- `verify-export-jsdoc` —— **有理由不适用**
- `verify-public-repository-links` —— **有理由不适用**
- `verify-concrete-terms` —— **有理由不适用**
- `verify-runtime-closure` —— **有理由不适用**

**结构性不适用 32 道**：

> 判据：它们读 `packages/`（上游 monorepo 的业务代码），而本仓库是**单包插件**，
> 没有那个目录。逐条列在这里不是为了展开，而是**为了让「29」这个数可复核** ——
> 只写总数与分类时，没人能验证覆盖是否完整。

- `verify-application-entrypoints`
- `verify-client-domain-graph`
- `verify-client-packages`
- `verify-client-route-resolution`
- `verify-client-ui-i18n`
- `verify-config-source-ownership`
- `verify-cordis-config`
- `verify-default-product-isolation`
- `verify-doc-refs`
- `verify-doc-site-fragments`
- `verify-dsh-package-licenses`
- `verify-mermaid`
- `verify-no-bare-dispatcher`
- `verify-no-unknown-casts`
- `verify-node-next-types`
- `verify-npm-install-layout`
- `verify-optional-dependency-imports`
- `verify-package-dependencies`
- `verify-package-meta`
- `verify-package-paths`
- `verify-package-readme-limitations`
- `verify-package-readme-model-experience`
- `verify-package-readme-summaries`
- `verify-plugin-record-callers`
- `verify-product-use`
- `verify-repository-references`
- `verify-skill-invocation-metadata`
- `verify-subsystem-pages`
- `verify-translation-prompt`
- `verify-type-equiv`
- `verify-upgrade-guides`
- `verify-v3-event-vocabulary`
### 三、明确接受的缺口（不是「没想到」，是「想过不做」）

| 缺口 | 为什么接受 | 重访信号 |
|---|---|---|
| 实机证据不在自动门禁 | 需装了 DSH 的 CI；且 DSH 升级会与「插件坏了」混淆 | 出现「DSH 升级后本地全绿但失效」的事故 |
| 中英 README 只比结构，不补逐节哈希 | 人工维护的翻译有合理表述差异。**理由写错了一半**：上游 `translation-pairing` 不是拿中文哈希去比英文，而是**每种语言各对自己的「已确认哈希」**（`.probe/upstream-a-687f282/scripts/translation-pairing-record.ts:176-177` 分节各自哈希、`:199-230` 分别记录 en/zh、`:281-298` 与确认值比对报 `changed since confirmation`）。所以「中英哈希不等会逼出假红」不成立，真实理由只是**维护成本**：改中文仍要更新英文的确认值 | 真的出现过「结构对但某节漏译」 |
| 归档路径无自动化测试 | ~~成本不对称（建临时仓库跑 TS 脚本），且未退化过~~ **该缺口已关闭（2026-10-21）**：`tools/archive-baseline.test.mjs` 用真 Git 临时仓库覆盖合法/非法基线、历史清单损坏、历史封印被删或被改，且 `lib/notes.js` 的 archived 前置校验改为失败关闭。见 [2026-10-21-archive-baseline-fails-closed.md](../bug-fix/2026-10-21-archive-baseline-fails-closed.md) | 已触发（归档基线曾被伪造通过），故已补 |
| 客户端 bundle 无自动化测试 | 核查要改真实 `src/` 再还原，并行测试会撞车 | 出现「改 src 忘 build」的真实事故 |
| `verify-md-wrap` 不做 | 缩进代码块 0 处，中文排版依赖折行，误报必然、收益为零 | 大量用行内代码表达断行且造成困扰 |
| 锚点校验不做 | 手写 slug 与 GitHub 逐字一致才有效，否则是另一种假绿 | 首次出现 `#fragment` 链接 |

### 四、非 verify 类上游脚本

135 个，多数是构建/打包/发布（Tauri 桌面端专属）。唯一值得对的是
`build:check`（`build.ts --scope check`，构建并校验）—— 本仓库的等价物是
`verify-plugin.mjs` 里的**重建比对**，已实现且已验证会红。无吸收点。

### 五、收尾之后又发现并修掉的（这 5 轮说明「核查完毕」不是终态）

原以为收尾就是终态。实际后面 5 轮里**又发现了 5 个真缺口**，全部已修：

| 发现 | 性质 | 笔记 |
|---|---|---|
| 「零依赖」被当成否决理由用了 **6 次** | **判据错误**（Owner 两次纠正过） | `zero-dep-was-my-own-self-imposed-shackle` |
| `upstream-sync.yml` 里**保护发布**的门禁自己没人保护 | 真缺口（握 `contents:write` + push tag） | `publish-gate-had-no-guardian` |
| 断网时 `sync-upstream` 报「契约被破坏」而非「环境不可用」 | 真缺口（误导性诊断） | `network-down-reported-as-contract-broken` |
| `npm test --if-present` 被当成「门禁存在」 | **我自己独立验时抓到的**（执行者汇报说全通过） | `publish-gate-had-no-guardian` |
| 归档导致 **95% 的出向链接断裂**，且事后无法修 | 真缺口（死锁） | `archiving-breaks-links-by-design` |

**这条记录的真正含义**：写「核查完毕」那一刻是不准的 —— 它只是**那一刻**的
快照。后来的每一轮都在推翻它的一部分。所以本篇的数字会再次过时，那不是
本篇的缺陷，而是这件事的性质。

### 六、收尾之后做的三项改进（都是「够用就好」，不是大改造）

| 做了什么 | 为什么值得 | 依赖 |
|---|---|---|
| 双语只比**语言标记** | 段落数/列表数**不是漂移信号**（中英排版惯例不同，实测 30 处「差异」全是方法假象） | **零** —— 原计划的 mdast 方案被替代 |
| 并发度**不动** | 23/29 的测试是进程/IO 密集，按 CPU 数定并发是**错的信号** | 零 |
| 渲染探针不再硬编码 Chrome | 拆掉了探针进 `npm test` 的前置条件；实测 puppeteer 可用但**不必重写** | 零（只用 `findBrowser()`） |

三项都**没引入新依赖** —— 而这正是「按「值不值得它的成本」而非「要不要引依赖」
判断」的结果。

### 七、方法论：这一轮我推翻了自己三次

| # | 我说的 | 实测 | 教训 |
|---|---|---|---|
| 1 | 上游有 65 道 verify | **42** | 分母不能从 script 名反推 |
| 2 | mdast 能多测 5/7 场景 | **那 5 个不能当门禁** | 数字有说服力 ≠ 证据，必须能追到具体位置 |
| 3 | 并发高更快 | 并发 16 比 4 **更快** | 瓶颈不是 CPU 时，核数是错信号 |

三次都是**「看起来很确定的判断被实测推翻」**。共同点：我都在用**未经验证的
方法**（反推的名字、造的样例、单机的测量）去支撑一个结论。

> **判据**：当我说「A 比 B 更重要」时，我能指出具体是 A 的哪一条事实、
> 在哪个文件第几行吗？指不出就说明我在用感觉。

## Alternatives considered

- **不写收尾篇，直接标记 goal 完成** — 省一篇笔记。否掉因为「为什么可以停了」这个判断本身需要留痕：半年后有人问「上游还有没有该吸收的」，答案必须能从仓库里找到，而不是靠记得。
- **把 44 道 verify 逐条写进一篇长清单** — 更长，但**可复核**。**当初否掉了它，现在判定当初的否掉是错的**：理由是「32 道结构性不适用的理由同构，逐条写会稀释那 13 条」。
  实测证明那个理由站不住 —— 收尾审计要复核「42 道全部判定」时，本地只剩 4 个抽样，**无法验证覆盖是否完整**；顺带查出**分母本身错了**（真值 44，我用「URL 探测哪些文件存在」得到 42，而那个探测把**探测失败**当成了「文件不存在」）。
  → 逐条清单不是「稀释」，是**可复核的唯一凭据**。少数派的信息量靠「少数派」这个命名就已经保住，不需要靠「没列它们」来保护。清单见上文「逐条清单（44 道，可复核）」。
- **把「明知不做的缺口」单独拆一篇 rejected** — 语义更纯。否掉因为那些缺口**不是被否决的方案**，而是**已落地决定的已知上限** —— 它们与对应的 implemented 笔记是同一件事的两面，拆开会让「某项做了什么、代价是什么」分散在两处。
- **继续核查，不标记完成** — goal 还有 240 轮额度。否掉因为**没有候选了**：8 个方向有证据，44 道 verify 全判定（清单可复核），非 verify 类无吸收点。继续下去只能为了「有产出」而制造改动，那正是 goal 明令禁止的。

## Consequences

- **收益**：把「核查完毕」从印象变成可核对的表格。8 个方向各自对上了笔记与实测，44 道 verify 有明确分类，逐条清单在下一节。
- **收益**：6 项明确接受的缺口有了重访信号 —— 它们不是遗漏，是权衡后的取舍，且每条都写清了「什么情况下该重新考虑」。
- **收益**：顺带清理了 `.probe/` 下十几轮的探针残留（2.6M → 546K），根目录保留 8 个更早轮次的浏览器/性能探针（有参考价值）。
- **代价与已知上限**：本篇是**汇总**，具体理由分散在 15+ 篇笔记里。新读者要理解某个判定，需要跳转。这是笔记树按「一次改动一篇」组织的固有代价。
- **代价与已知上限**：缺口表里 4 项「无自动化测试」的接受理由是「成本不对称 + 未退化过」。若其中任何一项退化，那个理由就不成立了 —— 但退化时不会有人自动想起这张表。**这是本篇最弱的一环**：重访信号需要人主动查，而没有机制提醒。
- **重访信号**：若上游新增 `verify-*`，需重新跑一遍分类（分母判据见下节，别再用 URL 探测）（`audit-verify-list.mjs` 的思路可复用）。若本仓库开始发布可被第三方 import 的库，`export-jsdoc` 的判定要重评。

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

## 事后订正（2026-10-21，本篇的完成声明曾被推翻）

本篇同时写了 `42`（第 213 行、被否第二条）和 `44`（第 226–234 行）两个分母，
**两个都不对**。按上游固定提交 `687f282` 的真实目录重数：

```sh
cd .probe/upstream-a-687f282/scripts
ls verify-*.ts | grep -v '\.spec\.ts$' | wc -l   # 46 个实现
ls verify-*.spec.ts | wc -l                       # 30 个测试（不算门禁）
```

`46 = 44 被 package.json/CI 引用 + 2 个无人引用的 SSH 脚本`
（`verify-ssh-helper-artifact.ts`、`verify-ssh-helper-ssh.ts`）。
所以「44 道全部判定」那句话**不成立**，少的是两个从未被任何 script 点名的脚本 ——
它们恰恰是最容易被漏掉的一类，因为它们不出现在 `npm run verify` 的路径上。

同一轮复核还推翻了本篇的两条判据：

1. **「本仓库没有 `packages/` / 没有 `cordis.yml` / 没有 `.d.ts`，所以不适用」**
   只能证明上游那个**实现路径**不存在，证明不了它防的**问题**不存在。
   单包仓库同样有包元数据、依赖字段、许可证与安装布局问题，
   只是载体从 `packages/*/package.json` 变成仓库根 `package.json`。
2. **「中英逐节哈希会逼出假红」** 是对上游机制的误读：那是每种语言各对自己的
   已确认哈希，不是中英互比。真实的可否理由只有维护成本。
   （见缺口表那两行的订正。）

结论不必重写：本篇作为「那一刻的快照」仍然有用。但**「核查完毕」不是终态**
这句话，本篇自己又验证了一次 —— 这次连分母都还是错的。
