# 上游 46 道校验在本仓库的逐条分类

> 这份清单是一次**穷尽分类**的产物：分母来自磁盘枚举（`.probe/upstream-a-687f282/scripts/verify-*.ts`
> 的 76 个文件、17200 行，其中 30 个 `*.spec.ts`、46 个门禁本体 10783 行），
> 每道 gate 只落在「已采纳 / 有意保留差异 / 不适用·否决」中的一个，并带上游判据与本地对照的行号。
>
> 决策与取舍写在 `.agents/notes/implemented/process/2026-10-21-upstream-46-gates-classified-exactly-once.md`。
> 清单里引用的 `.probe/audit-*.md` 是当轮审计子代理的**临时报告**（探针目录不入库），
> 保留其路径是为了标明判定出处；这些报告本身不作为长期证据，行号证据以本文件的「上游判据/本地对照」为准。
>
> 重新生成上游副本再核对：

```sh
git clone --filter=blob:none --no-checkout https://github.com/deepseek-ai/deepseek-harness /tmp/dsh-upstream
git -C /tmp/dsh-upstream sparse-checkout set scripts && git -C /tmp/dsh-upstream checkout 687f282e8625c6b8d11ff58211a90524be2e4317
ls /tmp/dsh-upstream/scripts/verify-*.ts | grep -v '\.spec\.ts$' | wc -l   # 46
```

## 判定出处与口径

> 合并来源：`.probe/audit-notes-docs.md`、`.probe/audit-package-runtime.md`、`.probe/audit-client-architecture.md`、`.probe/audit-source-policy.md`、`.probe/audit-upstream-b-drift.md`；上游 A 稀疏副本 `.probe/upstream-a-687f282/scripts/`；本仓库既有笔记两篇。
> 纪律：本清单只做归类与引用，不修改任何门禁；凡不确定处标「未验证」。「审计判据」列的 `路径:行号` 指向**审计报告里的结论行**（审计报告自身再引上游 `scripts/...:行号`）。
> 审计报告自身的不完整状态（如 `audit-client-architecture.md:6`「本报告为增量工作记录，不是完成声明」）已保留在各行备注里，不当作已核实。

---

## 0. 名单来源：磁盘枚举（权威）

```
$ ls .probe/upstream-a-687f282/scripts/verify-*.ts | wc -l
76
$ ls .probe/upstream-a-687f282/scripts/verify-*.spec.ts | wc -l
30
```

- `verify-*.ts` 共 **76** 个；其中 `*.spec.ts` **30** 个（自测用例，不是门禁本体）。
- 非 spec 的 `verify-*.ts` = **46** 个 —— **与任务给的 46 一致，无差异**。
- 行数取自 `wc -l verify-*.ts`（实测，非估计）：

| 文件 | 行数 | | 文件 | 行数 |
|---|---|---|---|---|
| verify-agent-note-classification.ts | 27 | | verify-package-dependencies.ts | 1038 |
| verify-agent-note-format.ts | 94 | | verify-package-meta.ts | 285 |
| verify-application-entrypoints.ts | 203 | | verify-package-paths.ts | 113 |
| verify-archived-agent-notes.ts | 115 | | verify-package-readme-limitations.ts | 95 |
| verify-client-domain-graph.ts | 104 | | verify-package-readme-model-experience.ts | 638 |
| verify-client-packages.ts | 713 | | verify-package-readme-summaries.ts | 77 |
| verify-client-route-resolution.ts | 339 | | verify-plugin-record-callers.ts | 283 |
| verify-client-ui-i18n.ts | 361 | | verify-product-use.ts | 317 |
| verify-concrete-terms.ts | 105 | | verify-public-repository-links.ts | 99 |
| verify-config-source-ownership.ts | 56 | | verify-repository-references.ts | 155 |
| verify-cordis-config.ts | 578 | | verify-runtime-closure.ts | 237 |
| verify-default-product-isolation.ts | 413 | | verify-skill-invocation-metadata.ts | 122 |
| verify-doc-budgets.ts | 58 | | verify-ssh-helper-artifact.ts | 167 |
| verify-doc-refs.ts | 45 | | verify-ssh-helper-ssh.ts | 108 |
| verify-doc-site-fragments.ts | 181 | | verify-subsystem-pages.ts | 137 |
| verify-dsh-package-licenses.ts | 89 | | verify-translation-pairing.ts | 368 |
| verify-export-jsdoc.ts | 607 | | verify-translation-prompt.ts | 98 |
| verify-md-links.ts | 254 | | verify-type-equiv.ts | 391 |
| verify-md-wrap.ts | 86 | | verify-upgrade-guides.ts | 85 |
| verify-mermaid.ts | 106 | | verify-v3-event-vocabulary.ts | 105 |
| verify-no-bare-dispatcher.ts | 226 | | **合计** | **17200** |
| verify-no-top-level-await.ts | 267 | | | |
| verify-no-unknown-casts.ts | 186 | | | |
| verify-node-next-types.ts | 164 | | | |
| verify-npm-install-layout.ts | 275 | | | |
| verify-optional-dependency-imports.ts | 213 | | | |

三类标签是**互斥且穷尽**的：`已采纳` / `有意保留差异` / `不适用·否决`。每道 gate 只出现一次。

---

## 1. 分类总表（46 行，逐条唯一）

| # | gate 文件名 | 行数 | 审计判据（路径:行号） | 分类 | 一句话理由（含本仓库对应实现或缺失原因） |
|---|---|---|---|---|---|
| 1 | verify-agent-note-classification.ts | 27 | `audit-notes-docs.md:13`；上游 `verify-agent-note-classification.ts:14-18` | 有意保留差异 | 本仓库以 `skills/agent-notes/scripts/agent-note-tree.ts:28-71` + `lib/notes.js:558-577` 覆盖生命周期/分类/深度/日期，但未等价禁止宿主 `docs/rfc` 旧路径；空树假绿已由 `npm run notes:gate` 补偿。 |
| 2 | verify-agent-note-format.ts | 94 | `audit-notes-docs.md:14`；上游 `:13-36`、`:55-84` | 有意保留差异 | vendored 版 `skills/agent-notes/scripts/verify-agent-note-format.ts:11-47`、`:59-97`、`:109-150` 支持中文别名、正文屏蔽与禁标题匹配，判据与上游不同口径。 |
| 3 | verify-application-entrypoints.ts | 203 | `audit-client-architecture.md:53`（「本次批量读取输出截断」） | 不适用·否决 | **结构性不存在**：`package.json:6-7` 只有库入口 `main`/`exports`，实测**无 `bin`、无 `types` 字段** —— 不发布任何 CLI 应用入口，无「应用入口文件」契约可校验。上游判据：`:28-39` 是一张**显式的入口分类表**（`apps/cli/package.json`→`lib/bin.js`、`packages/experimental/webworker-packer`→`./bin.js`，加上 `apps/cli/src/bin.ts`、notarytool 包装、test fixtures 逐条标注用途），`:7` `globSync` 扫 `**/package.json` 找 `bin`。本地：`package.json` 无 `bin`/`scripts` 入口可分类（库插件，由宿主加载），分类表无对象。 |
| 4 | verify-archived-agent-notes.ts | 115 | `audit-notes-docs.md:15`；上游 `:61-112` | 已采纳 | `lib/notes.js:580-649` + `skills/agent-notes/scripts/verify-archived-agent-notes.ts:63-124` 实现同口径「封存只增不改」；审计记录包装层修过基线读取失败。 |
| 5 | verify-client-domain-graph.ts | 104 | `audit-client-architecture.md:54`（「输出截断，需完整重读」） | 不适用·否决 | **结构性不存在**：无 `packages/` workspace、无客户端域图；`src/client.js:1-40` 是单文件浏览器模块，没有图层可校验。上游判据：`:21` `CLIENT_DIR = packages/client`，`:32` `globSync("**/*.{ts,tsx}")`，`:84-85` 遍历 `packages/client/<pkg>/src/client`，按 `contract/`(层0) → 域名目录(层1) → `apply.ts`/`index.ts`(层2) 判越层导入。本地：`src/client.js` 是**单文件浏览器模块**，无 `packages/client/*/src/client` 目录、无 TS/TSX，层模型无对象。 |
| 6 | verify-client-packages.ts | 713 | `audit-client-architecture.md:36`、`:48`、`:55` | 不适用·否决 | **结构性不存在**：单包发布（`package.json:1-25`），无 tsdown 构建产物、无 platform/parser preload 多包矩阵（上游 `:11-18`）。 |
| 7 | verify-client-route-resolution.ts | 339 | `audit-client-architecture.md:55`（「待完整读取及本地对照」） | 已采纳（部分） | **原则已采纳、机制未移植**：相对文档解析这条规则已在 `src/client.js:366-368` + `tools/client.test.mjs:485-503` 落地（本轮真修过一次假挂载点竞态）；未移植的是 TS AST 语法扫描本身。上游判据：`:30` `globSync`，`:132` 只把「请求目标」当对象（`fetch`/`fetcher` 第一个参数、`new Import()` 动态导入、`script.src=` 赋值、JSX `src`/`href`），`:302` 扫 `packages/*/*/src/client/**/*.{ts,tsx}`，`:294-300` 空集合即抛（`browser-reference producer` 消失），`:313` 生产者文件缺失即红；判据文案见 `:72`「resolve the route against document.baseURI, not against a location read」。**本地已按同一原则落地**：`src/client.js:366-368` 用相对 `agent-notes/ui?session=` 而不是 `/agent-notes/ui`，`tools/client.test.mjs:485-503` 在 `/`、`/dsh/`、`/nested/dsh/` 三挂载点做回归。差异：无 TS AST 门禁（无 TSX、单 JS 文件），靠行为测试而非语法扫描。 |
| 8 | verify-client-ui-i18n.ts | 361 | `audit-client-architecture.md:56`（「待完整读取及本地对照」） | 有意保留差异 | **规则形式被违反、判为有意**：`src/client.js` 有 16 处内联中文字面量，`lib/` 无 locale 字典；文档层双语由 `tools/bilingual-docs.mjs` 保证。 上游判据：`:10` `globSync`，`:69-74` locale 归属（`locale.ts`/`locales.ts`/`/locales/`），`:111` locale 文件豁免，`:257-271` 覆盖 JSX 文本、copy 属性与数据/helper 形式，`:321` 扫 `packages/*/*/src/client/**/*.tsx`。本地实证：`src/client.js` 有 16 处内联中文字面量（`笔记规范`、`切换中…` 等），`lib/` 无 locale 文件 —— 规则形式被违反但判为有意：单文件中文 UI，代价是 UI 文案不可本地化。 |
| 9 | verify-concrete-terms.ts | 105 | `audit-source-policy.md:20`（「拒绝原样采用」）、`:21`；上游 `:10-11`、`:39-63` | 不适用·否决（会造成假绿） | 上游禁用单个含混来源词并强制 tracked 语料含 `packages/`、`docs/`、`vendor/`；本仓库无该语料结构，术语规范属风格偏好。 |
| 10 | verify-config-source-ownership.ts | 56 | `audit-client-architecture.md:57`（「待完整读取及本地对照」） | **已采纳（部分）** | **已按更窄更严的方式采纳**：`tools/verify-plugin.mjs:110-111` 禁掉整份 `cordis.patch.yml` 里的 `!!js` 与 `process.env` （上游只禁五字段的 `!!js` 值，判据 `:23-38`），`tools/verify-plugin.test.mjs` 两条红测各覆盖一种。**未采纳部分**：上游 `:14-19` 的 glob（`apps/*/config/**/*.yml`、`packages/*/*/cordis.patch.yml`、`presets/*.patch.yml`、`python/*/src/**/cordis.yml`）在本仓库**一条也不匹配**（唯一的 `cordis.patch.yml` 在仓库根），照搬等于装一道永远绿的检查；`:42-56` 的「每个配置值必须归属于某个源文件」需要多源结构，本仓库只有一个插件声明，结构性不存在。判据已由 lead 亲读（`:1-56`）。 |
| 11 | verify-cordis-config.ts | 578 | `audit-client-architecture.md:58`（「待完整读取及本地对照」） | 不适用·否决 | **结构性不存在**：无 `cordis.yml` 生成链（只有手写 `cordis.patch.yml`），没有 preset/group 树可校验。 上游判据：`:39` `globSync("apps/cli/config/examples/**/*.yml")`，`:107` `globSync("packages/client/*/package.json")`，`:143` 读 `packages/bundle/base/cordis.patch.yml`，`:17-20` 依赖 `packages/boot/app-boot`/`packages/util/package-manifest` 与 TS AST；校验 Loader 的 `config`/`disabled` 插值语义。本地：glob 全不匹配 + import `@deepseek-ai/*` 违反零依赖硬约束。 |
| 12 | verify-default-product-isolation.ts | 413 | `audit-client-architecture.md:59`（「待完整读取及本地对照」） | 不适用·否决 | **结构性不存在**：无「默认产品」与多产品隔离概念（单插件单产品），隔离对象不存在。 上游判据：`:66-68` `globSync(["apps/*/package.json","packages/*/*/package.json","vendor/*/package.json","native/system/packages/*/package.json","python/sdk-runtime/package.json"])`，`:25-27` `EXTERNAL_KIT_PACKAGES`/`PROFILE_SOURCE`/`PRESET_PATTERN`，`:11` 依赖 `jsdom` + `@deepseek-ai/cordis-plugin-include`；判据是「实验包不得进入默认安装/运行期 import/出厂组合」。本地：单包单产品，无实验/默认二分类。 |
| 13 | verify-doc-budgets.ts | 58 | `audit-notes-docs.md:16`；上游 `:16-48` | 有意保留差异 | 本仓库有等价门禁 `tools/doc-budget.mjs:49-57`、`:64-87`、`:94-137`（`AGENTS.md` 里 `npm run doc:budget`），但 CJK 计数口径不同。 |
| 14 | verify-doc-refs.ts | 45 | `audit-notes-docs.md:17`；上游 `:15-45` | 有意保留差异 | 本仓库确有源码内文档引用（`tools/markdown-links.mjs:26`、`tools/md-links.mjs:25`、`tools/notes-supersession.mjs:7`），但 Markdown 门禁不覆盖裸源码路径存在性。 |
| 15 | verify-doc-site-fragments.ts | 181 | `audit-notes-docs.md:18`；上游 `:81-140`、`:154-181` | 有意保留差异 | 上游要求先构建文档站再验 HTML 路由/ID/片段；本仓库 `package.json:60-87`、`.github/workflows/verify.yml:9-11` 不构建 VitePress，不能把站点构建前提施加给任意宿主。 |
| 16 | verify-dsh-package-licenses.ts | 89 | `audit-package-runtime.md:33`；上游 `:32-45`、`:61-72`、`:78-89` | 已采纳 | `tools/verify-plugin.mjs:81` 精确校验 MIT，与上游同口径；仅收窄为单包（不照搬包名前缀发现与 workspace 遍历）。 |
| 17 | verify-export-jsdoc.ts | 607 | `audit-source-policy.md:29`、`:34`；上游 `:18-21`、`:175-253`、`:383-474` | 有意保留差异 | 保留 JS/鸭子类型与解析成本取舍：本仓库纯 JS 无 `.d.ts`（无 `types` 字段、无 `.ts` 源），上游要求 TS 返回注解，直接移植会改变本地 API 写法。 |
| 18 | verify-md-links.ts | 254 | `audit-notes-docs.md:19`；上游 `:108-146`、`:213-236` | 有意保留差异 | `tools/md-links.mjs:75-104`、`:135-143`、`:178-236` 检查目标存在，但默认跳过 `#fragment` 且不递归 `docs/`，判据窄于上游。 |
| 19 | verify-md-wrap.ts | 86 | `audit-notes-docs.md:20`（「已否决」）；上游 `:1-86` | 不适用·否决（成本高于收益） | 上游禁止「跨物理行的段落」；本仓库保留中文折行习惯且无等价门禁，否决记录在 `.agents/notes/rejected/architecture/2026-10-19-three-upstream-gates-not-applicable.md`。 |
| 20 | verify-mermaid.ts | 106 | `audit-notes-docs.md:21`（「已否决」）；上游 `:42-55`、`:81-106` | 不适用·否决（成本高于收益） | 历史决定为零图引入 Mermaid 重依赖（`.agents/notes/implemented/process/2026-10-19-upstream-verify-count-was-wrong.md:77-96`），「当前语料另核」未做。 |
| 21 | verify-no-bare-dispatcher.ts | 226 | `audit-client-architecture.md:10`、`:16`、`:19-22`；上游 `:81-122`、`:133-153`、`:163-207` | 有意保留差异 | 本仓库无自建 transport：本轮 `grep -rn "undici\|ProxyAgent\|EnvHttpProxyAgent\|dispatcher" lib/ src/` **零命中**，运行时用全局 `fetch`（`lib/self-update.js:55-62`），也没有等价语法门禁。〔浏览器 `fetch` 执行上下文未核实〕 |
| 22 | verify-no-top-level-await.ts | 267 | `audit-source-policy.md:39`（「历史 CommonJS 理由失效」）；上游 `:33`、`:47-55`、`:145-168` | 有意保留差异 | 本仓库是 ESM（`package.json` `"type":"module"`），TLA **语法上可用**，不是「不可用」；真实理由是模块作用域无顶层 await 且手写判定会漏报（`2026-10-19-minority-verdicts-confirmed-at-source-level.md:70` 已订正该事实错误）。 |
| 23 | verify-no-unknown-casts.ts | 186 | `audit-source-policy.md:47`、`:49`；上游 `:25-39`、`:103-171` | 有意保留差异 | 本仓库纯 JS、无 `as`/角括号断言（`find lib src tools -name "*.ts*"` 为空），上游的断言指纹基线（`:103-171`）无对象。 |
| 24 | verify-node-next-types.ts | 164 | `audit-package-runtime.md:37`；上游 `:1-164` | 有意保留差异 | 本仓库不发布 `.d.ts`（无 `types`/`typings`），NodeNext 声明消费项目无输入；上游自身 `skipLibCheck=true`，也不是完整语义验证。 |
| 25 | verify-npm-install-layout.ts | 275 | `audit-package-runtime.md:43`、`:45`；上游 `:74-110`、`:149-239` | 有意保留差异 | 上游构造 0.1.0/0.2.0 双 DSH 发布图验物理安装路径；本仓库单包且 `tools/verify-plugin.mjs:86-92` 明确禁止 DSH runtime/peer 依赖。审计同时指出「普通干净安装消费」**仍未覆盖**，不能推断已覆盖。 |
| 26 | verify-optional-dependency-imports.ts | 213 | `audit-package-runtime.md:47`、`:51`；上游 `:68-81`、`:114-188` | 有意保留差异 | `package.json` 当前无 `optionalDependencies`/optional peer，源码为 JS；审计明确：有效依据是「没有可选依赖」，**不是**单包结构。 |
| 27 | verify-package-dependencies.ts | 1038 | `audit-package-runtime.md:11`、`:13-25`、`:53`；上游 `:231-329`、`:469-538`、`:694-741`、`:807-850` | **已采纳（部分）** | `tools/verify-plugin.mjs:86-97` 覆盖 `dependencies`/`peerDependencies`/`optionalDependencies` 三区；`:128-158` 用 `collectFiles()` 递归 `lib/` 并对四种引用形态（`from`／副作用 `import`／动态 `import()`／`require()`）各一条正则。**审计当初点的五类缺口已全部补齐**；唯一仍未采纳的是上游的 TS **AST** 级导入分析（`:231-329`）。边界见 §3。 |
| 28 | verify-package-meta.ts | 285 | `audit-package-runtime.md:59`、`:61`；上游 `:76-113`、`:115-165`、`:166-255`、`:265-274` | **已采纳（部分，暂定）** | `tools/verify-plugin.mjs:73-84` 校验 name/ESM/main/license/patch/files，`:118-136` 校验 client 声明与重建一致性；未覆盖 exports 资源解析与 36x36 SVG 规范。边界见 §3。 |
| 29 | verify-package-paths.ts | 113 | `audit-package-runtime.md:65`；上游 `:1-6`、`:58-95` | 有意保留差异 | 上游只识别 `packages/...` 迁移残留且「存在即放行」，不是通用路径存在性检查；本仓库无 `packages/` 树。〔上游末段排除逻辑未读完〕 |
| 30 | verify-package-readme-limitations.ts | 95 | `audit-source-policy.md:55`（「暂不作最终分类」）、`:56`；上游 `:16`、`:19-21`、`:34-45`、`:59-85` | 已采纳（部分） | 上游按包发现 README 并要求**恰好一个精确英文 H2** `Known Limitations and Deferred Work`；本仓库单包、限制章是中文 `## 已知限制`（`README.md:410`），且 `README.en.md:477` 是 `## Known limitations`（小写、无后半句） —— 标题语种与包发现层都不同。〔2026-10-21 改判：逐字英文 H2 判据仍不成立，但**白名单防腐机制已移植**——`tools/verify-plugin.mjs` 的 `RUNTIME_ARTIFACTS` 由 `Set` 改为「名字→理由」映射，理由必须非空、名字必须在 `lib/` 源码里真有写者，否则红；两条故障注入见 `tools/verify-plugin.test.mjs`（19/19 通过）。markdown 辅助逻辑仍未读，属保留部分〕 |
| 31 | verify-package-readme-model-experience.ts | 638 | `audit-source-policy.md:61`（「暂不作最终分类」）、`:62`；上游 `:13-18`、`:20-47` | 不适用·否决 | **结构性不存在**：上游要求每个包 README 固定四段（Model Experience / What the model sees / Token effect / KV Cache effect）；本仓库 README 无此结构，强制引入只会产出形式化空话。〔审计仅读开头 638 行中的前段〕 |
| 32 | verify-package-readme-summaries.ts | 77 | `audit-source-policy.md:67`；上游 `:9`、`:23-26`、`:40-54`、`:64-76` | 有意保留差异 | 上游限英文学包 README 的 `Summary` H2 ≤100 空白分词并拒绝空语料；本仓库单包、`README.en.md` 无 `Summary` 章，双语预算由 `tools/doc-budget.mjs` 承担。〔本地语料未逐一核〕 |
| 33 | verify-plugin-record-callers.ts | 283 | `audit-client-architecture.md:60`（「待完整读取及本地对照」） | 不适用·否决 | **结构性不存在**：本仓库**刻意不调用** `appendPluginRecord`（`lib/projection.js:5-10` 记录零依赖约束与实测 `MODULE_NOT_FOUND`），改用宿主自带 `command/run`、`command/done` 事件（`lib/projection.js:11-19`），无调用点可校验。 上游判据：`:34` `OWNER_FILE = packages/core/session/src/index.ts`，`:37` `EXPERIMENTAL_PREFIX = packages/experimental/`，`:158` 拥有者不再导出即抛，`:162-163` 语料守卫（不出现 `packages/` 路径就抛「the corpus lacks experimental or release package source」），`:206-226` 用 TS program 比对 `PluginRecordMap`。本地：守卫必然抛（无 `packages/`），且 TS API 与零依赖硬约束冲突。 |
| 34 | verify-product-use.ts | 317 | `audit-client-architecture.md:61`（「待完整读取及本地对照」） | 不适用·否决 | **结构性不存在**：无「产品」抽象与多产品消费图（单插件单包）。 上游判据：`:78` `globSync(["apps/*/package.json","packages/*/*/package.json","vendor/*/package.json"])`，`:17-20` 钉死 profile/on-demand/picker 三个源与五个 `PROFILES`，`:84-85` 缺名/重名即抛，`:8-12` 依赖 `jsdom`/`typescript`/`@deepseek-ai/*`；判据是「维护中的包必须有真实产品使用面或显式非默认角色」。本地：无产品矩阵，glob 一条不匹配。 |
| 35 | verify-public-repository-links.ts | 99 | `audit-source-policy.md:75`（「拒绝原样采用」）、`:76`；上游 `:9-12`、`:27-83` | 不适用·否决（会造成假绿） | 上游封禁特定仓库名 `deepseek-ai/deepseek-harness-sdk` 并扫 tracked 语料；本仓库不存在该链接语料，属组织政策而非通用门禁。〔NFKC/转义规范化实现未逐行核〕 |
| 36 | verify-repository-references.ts | 155 | `audit-source-policy.md:83`、`:85`；上游 `:10-15`、`:41-55`、`:93-131` | 有意保留差异 | 本仓库以固定 ref + 逐文件摘要替代「旧组织名/提交 hash 引用」禁令：`tools/upstream-manifest.json`、`upstream.json` 的 `ref`（固定提交）、`AGENTS.md` 上游段；`package.json` 里的 `upstreamCommit` 死字段已删除（两份清单各自自证，不再在包元数据里重复）；上游 `:93-131` 的本地对象库唯一前缀判定无对应需求。 |
| 37 | verify-runtime-closure.ts | 237 | `audit-package-runtime.md:69`、`:71`、`:73`；上游 `:48-100`、`:121-155`、`:158-173`、`:205-237` | 有意保留差异 | 上游从 runtime deps 遍历 workspace 闭包并校验每个 shipped preset；本仓库无 preset/workspace peer，`cordis.patch.yml:11-13` 是单插件插入入口，`tools/verify-plugin.mjs:94-101` 只验 patch 加载名。 |
| 38 | verify-skill-invocation-metadata.ts | 122 | `audit-source-policy.md:91`、`:93`；上游 `:19-37`、`:76-104` | 有意保留差异 | `skills/agent-notes/SKILL.md:1-4` 只有 name/description（无 `agents/openai.yaml` 配对），能力在运行时显式声明（`lib/skill.js:219-256` 的 `invocation`），零配对时上游本也通过。 |
| 39 | verify-ssh-helper-artifact.ts | 167 | `audit-package-runtime.md:75`、`:77`（判定「暂定」）；上游 `:115-130` | 有意保留差异 | 上游要求打包 artifact、只读安装目录、双消费者并发冷启动与 `report-0.json` 证据（timeout 120s、输出保留 32768 字符）；本仓库无 SSH helper 产物。〔审计判定为暂定；本地无对照证据〕 |
| 40 | verify-ssh-helper-ssh.ts | 108 | `audit-package-runtime.md:81`、`:83`（判定「暂定」）；上游 `:1-108` | 有意保留差异 | 上游验真实 SSH 运输（Docker OpenSSH fixture、隔离 HOME、固定 known_hosts、glibc 2.28 断言）；本仓库无 helper、无运输可验。〔本地无对照证据〕 |
| 41 | verify-subsystem-pages.ts | 137 | `audit-source-policy.md:99`、`:102`；上游 `:17-22`、`:49-58`、`:71-117` | 有意保留差异 | 上游要求 package group/子 manifest 的 README 链到 `../../docs/subsystems/<英文页>.md`；本仓库是单插件发布面（`package.json:1-25`），无子包与子系统页。 |
| 42 | verify-translation-pairing.ts | 368 | `audit-notes-docs.md:22`；上游 `:231-368`、`translation-pairing-record.ts:176-230` | 有意保留差异 | `tools/bilingual-docs.mjs:227-240` + `tools/bilingual-links.mjs:55-57`、`:115-160` 做结构 + locale 链接配对，但**只有 README 一对**，且无逐节确认哈希记录。 |
| 43 | verify-translation-prompt.ts | 98 | `audit-notes-docs.md:23`；上游 `:44-98` | 有意保留差异 | 上游验证双向翻译提示词渲染与响应消费契约；本仓库不含翻译管线（`package.json:60-87` 无相关脚本），不能把该管线施加给宿主。 |
| 44 | verify-type-equiv.ts | 391 | `audit-package-runtime.md:87`、`:89`；上游 `:57-77`、`:282-391` | 有意保留差异 | 本仓库无 `.d.ts`/host 声明副本（无 `types` 字段），declaration 文本一致性无对象；上游自身也只是文本差异检查，不是语义等价证明。〔辅助逻辑与本地语料未完整复核〕 |
| 45 | verify-upgrade-guides.ts | 85 | `audit-source-policy.md:108`（「暂不作最终分类」）、`:109`；上游 `:14-45`、`:55-74` | 不适用·否决 | **结构性不存在**：需 `docs/upgrade-guide/<semver>/` 树 + `guide.md`/`guide.zh.md`/`guide.i18n.yaml` 三件套与 frontmatter `kind=upgrade-guide`；本仓库变更叙事由 `CHANGELOG.md` 承担，无升级指南树。〔审计未完成，本文自行判定〕 |
| 46 | verify-v3-event-vocabulary.ts | 105 | `audit-client-architecture.md:62`（「待完整读取及本地对照」） | 不适用·否决 | **结构性不存在**：无 v3 事件词表与事件总线胶水层（单插件，事件面由宿主承担）。上游判据：`:10-11` 钉死 `WRITER_PATH = packages/core/session/src/types.ts`、`EVENTS_PATH = packages/core/session/src/known-event-types.ts`，`:7` 从 `@deepseek-ai/dsh-session-format-v3-to-v4` 导入 `RELEASED_V3_EVENT_TYPES`，`:21` 源不可得即抛，`:42-49` 要求 `KNOWN_SESSION_EVENT_TYPES` 是字面量 `Set` 且无重名，`:70` 只接受 40/64 位完整 commit。本地：无 v3 事件词表、无 session 事件写入面（事件由宿主产生），无对应源文件，import 违反零依赖约束。 |

---

## 2. 统计

| 分类 | 条数 | 占 46 的比例 |
|---|---|---|
| 已采纳 | **7**（含 5 条部分采纳） | 15.2% |
| 有意保留差异 | **25** | 54.3% |
| 不适用·否决 | **14** | 30.4% |
| **合计** | **46** | 100%（= 磁盘枚举的 46 道非 spec `verify-*.ts`） |

对账：`46 = 7 + 25 + 14`（已采纳内部再分 2 条整体 + 5 条部分），无重复、无遗漏。

- **已采纳 7 条**：#4、#16（整体采纳）；#7、#10、#27、#28、#30（部分采纳，其中 #28 为审计「暂定」，见 §5；#30 于 2026-10-21 由「有意保留差异」改判（见 §5D）、#10 由「不适用·否决」改判（见 §3 的 #10 小节））。
- **有意保留差异 25 条**：#1、#2、#8、#13、#14、#15、#17、#18、#21、#22、#23、#24、#25、#26、#29、#32、#36、#37、#38、#39、#40、#41、#42、#43、#44。
- **不适用·否决 14 条**：#3、#5、#6、#9、#11、#12、#19、#20、#31、#33、#34、#35、#45、#46。

**保留差异落在哪些机制层**（对 25 条的归并）：

| 机制层 | 条数 | 涉及 gate |
|---|---|---|
| 宿主侧门禁 vs 维护者工具（不把维护者链施加给任意宿主） | 6 | #13、#15、#41、#42、#43、#36 |
| 语料结构/发布面不同（单包、无 `packages/`、无 preset） | 6 | #25、#29、#32、#37、#39、#40 |
| 语法层前提不同（纯 JS、无 `.d.ts`、无 TS 断言） | 5 | #17、#22、#23、#24、#44 |
| 判据口径较窄（本地实现存在但覆盖更少） | 4 | #1、#2、#18、#26 |
| 运行时实现形态不同（全局 fetch、运行时声明） | 2 | #21、#38 |
| 交付形态不同（单语言内联文案，无 locale 文件、无 `.tsx`） | 1 | #8 |
| 无等价对象但有替代通道 | 1 | #14 |

**不适用·否决 14 条的否定理由类型**：

| 否定理由类型 | 条数 | 涉及 gate |
|---|---|---|
| 结构性不存在（对应结构/产品/产物在本仓库根本没有） | 10 | #3、#5、#6、#11、#12、#31、#33、#34、#45、#46 |
| 成本高于收益（外部基建/重依赖/组织政策） | 2 | #19、#20 |
| 会造成「假绿」或语料结构不匹配（门禁无法证明它宣称的事） | 2 | #9、#35 |

---

## 3. 「部分采纳」的边界说明（哪些只采纳了一部分）

七条 `已采纳` 里有五条是部分的（#7、#10、#27、#28、#30），另外两条（#4、#16）是完整采纳。

### #10 `verify-config-source-ownership.ts` —— 采纳了「随包配置不得内联取值」，没采纳「Cordis 配置源所有权图」

- **采纳的部分**：上游禁止的是「随包发布的 Cordis 配置里内联凭据/端点」（判据 `:23-38` 对五字段的 `!!js` 值）。本地 `tools/verify-plugin.mjs:110-111` 禁掉**整份** `cordis.patch.yml` 里的 `!!js` 与 `process.env` 读取，`tools/verify-plugin.test.mjs` 有两条红测各覆盖一种。口径更宽也更严：上游的五个字段名是黑名单，而「哪些字段算凭据」没有可机械判定的边界，所以本地禁整类表达式。
- **为什么不照搬 glob**：上游 `:14-19` 扫 `apps/*/config/**/*.yml`、`packages/*/*/cordis.patch.yml`、`packages/*/*/presets/*.patch.yml`、`python/*/src/**/cordis.yml` —— 本仓库的 `cordis.patch.yml` 在**仓库根**，一条 glob 都不匹配。照搬上游等于给自己装一道永远绿的检查（那正是「会造成假绿」）。本地的做法是把同一原则挂到本仓库真实存在的那个文件上。
- **仍未采纳**：`:42-56` 的所有权图判定（每个配置值必须由某个源文件拥有）。本仓库只有一个插件声明，没有「多源」这个结构，画不出这张图 —— 这部分是结构性不存在，不是懒得做。


### #27 `verify-package-dependencies.ts` —— 采纳了「依赖分区里的 DSH 禁令」，没采纳「语法级导入发现」

- **采纳的部分**：`tools/verify-plugin.mjs:86-97` 读 `dependencies`、`peerDependencies`、`optionalDependencies` 三区，对名字匹配 `@deepseek-ai/*` 的项直接失败；`:128-158` 用 `collectFiles()` **递归**扫 `lib/` 全部 `.js`，并对四种引用形态各一条正则 —— 静态 `from`、副作用 `import 'x'`、动态 `import('x')`、`require('x')`，结果去重后报出。
- **本轮已关闭的旧缺口**（审计 `audit-package-runtime.md:19-23` 当时逐条列出的五条，现已全部在磁盘上成立，不再是缺口）：
  1. `optionalDependencies` 已读 —— 安装器会把它写进 profile，属运行时依赖；
  2. 裸 side-effect `import '...'` 已覆盖；
  3. 动态 `import(...)` 已覆盖；
  4. `require(...)` 已覆盖；
  5. `lib/` 递归已覆盖（`collectFiles()` 取代单层 `readdirSync`）。
  对应回归在 `tools/verify-plugin.test.mjs`：optional 藏依赖、动态 `import()`、`lib/sub/` 里的 `require()`、清单外文件、`upstream.json.ref` 被改、`.synced-version` 不得被误伤，加上 patch 内联两条与白名单腐烂两条，共 19/19 通过。
- **仍未采纳的部分**：上游 `:231-329` 起是**语法级/AST 级**依赖发现（TypeScript 编译器面）。本地是纯 JS 零依赖单包，引入编译器面与 `AGENTS.md` 硬约束 1（零 `@deepseek-ai/*` 依赖、运行时拿不到 DSH 类型包）方向相反；正则的代价是「字符串拼接出来的模块名」查不到，这一点不假装已解决。
- **审计只声称「检查逻辑缺口」，从未声称当前清单已有违规依赖**（`audit-package-runtime.md:19`）；本轮实测三区依赖皆无 `@deepseek-ai/*`。

### #28 `verify-package-meta.ts` —— 采纳了「包元数据与发布清单」，没采纳「图标/locale 资源语义」

- **采纳的部分**：`tools/verify-plugin.mjs:73-84` 校验 `name`、`"type":"module"`、`main`、`license`、`patch`、`files` 含 `lib`；`:161-180` 校验 `client` 声明、`window.__ModuleLoader__.load({id:"<包名>",…})` 信封形状与「重建产物 == 磁盘产物」。
- **刻意没采纳的部分**：上游 `:76-113` 的 SVG 结构/尺寸/局部引用校验、`:115-165` 的导出与源码资源候选发现、`:166-255` 的 locale/icon 可解析性与嵌套包归属 —— 本仓库无 `packages/` 嵌套、无 locale 资源，且 36x36 SVG 是官方图标规范而非插件必要条件。
- **状态**：审计标为「已采用（部分，**暂定**）」（`audit-package-runtime.md:59`），理由是上游导入的实际资源解析器仍需读取；本清单沿用该暂定，不升级为完整采纳。

### #7 `verify-client-route-resolution.ts` —— 采纳了「按 baseURI 解析」，没采纳「TS AST 扫描」

- **采纳的部分**：上游 `:72` 的文案就是判据本体 ——「resolve the route against document.baseURI, not against a location read」。本地 `src/client.js:366-368` 用相对的 `agent-notes/ui?session=…` 而非绝对路径，因此三种挂载点（`/`、`/dsh/`、`/nested/dsh/`）都解析到同一路由。
- **回归**：`tools/client.test.mjs:485-503` 用可配置的 `document.baseURI` 跑三个挂载点，并对 session `s /?&中`、cwd `/repo with spaces/中文` 做往返编码断言，还断言 query 只有 `session` 与 `cwd` 两个键。
- **刻意没采纳的部分**：上游 `:132` 的请求目标识别（`fetch`/`fetcher` 首参、动态 `import`、`script.src=`、JSX `src`/`href`）、`:302` 的 `packages/*/*/src/client/**/*.{ts,tsx}` 扫面、`:294-300` 的「空集合即失败」。本地是手写 JS、单文件客户端、无 TS 工具链；`tools/client.test.mjs` 用真 DOM 跑具体挂载点，覆盖的是同一风险的实例而非全语料。

### #30 `verify-package-readme-limitations.ts` —— 采纳了「豁免名单防腐」，没采纳「逐字英文 H2」

- **采纳的部分**：上游 `:34-45` 对 `NO_LIMITATIONS` 白名单做两件事 —— 条目必须命中被扫到的对象、理由必须非空（否则报「renamed or removed? update …」）。本地 `tools/verify-plugin.mjs` 的 `RUNTIME_ARTIFACTS` 已从 `new Set(['.synced-version'])` 改成「名字→理由」映射，并加第二条更强的检查：名字必须在 `lib/` 源码里**真的有写者**，否则这条豁免已经腐烂、应删除。
- **回归**：`tools/verify-plugin.test.mjs` 末尾两条（断言 `没有写理由`、`gone-artifact 在 lib/ 里找不到任何写者`），全文件 19/19 通过。
- **刻意没采纳的部分**：上游 `:16`、`:19-21` 的按包发现 `apps/*`、`packages/*/*` README 与 `:59-85` 的「恰好一个精确英文 H2 `## Known Limitations and Deferred Work`」。本仓库单包、限制章是中文 `## 已知限制`（`README.md:410`），`README.en.md:477` 是 `## Known limitations`（小写、无后半句）——标题语种与包发现层都不同。
- **顺带记下未覆盖的**：上游那份脚本里 markdown 辅助逻辑（围栏/标题位置判定）仍未读，不假装已对齐。

### 另外两条「完整采纳」的边界（为何仍算完整）

- **#4 archived**：`lib/notes.js:580-649` 与 vendored `verify-archived-agent-notes.ts:63-124` 的判据同构（只增不改 + 哈希封印）；差异仅在「包装层 vs 直跑脚本」的入口，不是判据收窄。
- **#16 dsh-package-licenses**：上游 `:61-72` 只查文件名匹配 DSH 前缀的包是否 `license=MIT`；本地单包 → 收窄为单包检查，判据未削弱。审计明确边界：**不验证 LICENSE 正文、不审计第三方许可证**，这两件事由 `tools/notices.mjs` 等别的机制承担（`audit-package-runtime.md:33`）。

---

## 4. 非 verify 类但相关的实践（逐条唯一分类，20 条）

| # | 实践 | 审计/来源依据 | 分类 | 本仓库是否落地 |
|---|---|---|---|---|
| P1 | **Supersession 检查**：每篇新笔记必须声明与既有笔记的关系 | `AGENTS.md:122-138`（含 `> **Every new Agent Note triggers a supersession check.**`）；`tools/notes-supersession.mjs:26`、`:173-211`、`:299`、`:328` | 已采纳 | **是**。三条出路（相对链接 / `Independent: <理由>` / 位于 `proposed`、`rejected`）由 `declaresRelation()` 硬校验，`npm run notes:supersession` 查暂存区（`AGENTS.md:136`）。边界：不做语义判重（`AGENTS.md:140-145`）。 |
| P2 | **`--force-with-lease` 才能改写历史，裸 `--force` 永不允许** | `AGENTS.md:146-156`；`.agents/notes/implemented/process/2026-10-19-branch-protection-makes-gates-enforceable.md` | 已采纳 | **是**。文档规则 + 远端强制（`main` 上 `allow_force_pushes=false`、`required_status_checks=verify`）。落地方式是仓库设置层，不是本地脚本。 |
| P3 | 独立的 `.agents/notes/AGENTS.md` 写法规范文件 | `AGENTS.md:126` 引用了上游这条规则 | 有意保留差异 | **未落地**：`ls .agents/notes/` 只有 `archived/ implemented/ rejected/`，无 `AGENTS.md`。规则内容拆进根 `AGENTS.md` + vendored 格式门禁，避免两处规范漂移。 |
| P4 | **Decision note 生命周期**（proposed → implemented / rejected → archived，class 封闭集） | `AGENTS.md:43-62`；`skills/agent-notes/scripts/agent-note-tree.ts:28-71`；`lib/notes.js:558-577` | 已采纳 | **是**。目录 + class 封闭集（`feature`/`bug-fix`/`simplification`/`architecture`/`process`/`testing`）由树门禁验。 |
| P5 | **归档封印只增不改**（SHA-256 manifest，脚本算哈希，禁止手写） | `AGENTS.md:137`；`verify-archived-agent-notes.ts:63-124` | 已采纳 | **是**。`npm run archive:note -- <路径>` 写入封印，归档门禁只增不改。 |
| P6 | **Translation recording**（逐节确认哈希，`translation-pairing-record.ts`） | `audit-notes-docs.md:22`；上游 `translation-pairing-record.ts:176-177`、`:199-230`、`:281-298` | 有意保留差异 | **部分替代**：`tools/bilingual-links.mjs:115-160` 做 locale 链接对（`PAIRS` 在 `:55-57`），但没有逐节确认记录。审计明确「哈希不是跨语言相等」，且逐节确认维护成本高。 |
| P7 | **CI 对齐**（本地脚本名 ↔ CI 步骤一一对应） | `tools/ci-alignment.mjs:294`、`:363`、`:442`；`package.json:75`、`:82`；`.github/workflows/verify.yml` | 已采纳 | **是**。`ci:align` 校验 CI 引用的脚本与 `package.json` 一致，接在 `check` 链里。 |
| P8 | **分支保护 / required checks**（让门禁真的可执行） | `.agents/notes/implemented/process/2026-10-19-branch-protection-makes-gates-enforceable.md`；`AGENTS.md:156` | 已采纳 | **是**。`main` 走 PR + `verify` 必过（远端配置层）。 |
| P9 | **`Note-Skip:` 出口 + `commit-msg` 钩子双层挂载** | `AGENTS.md:104-118`；`tools/install-hooks.mjs`、`tools/hook-body.mjs`、`tools/notes-coverage.mjs` | 已采纳 | **是**。本地钩子即时反馈，CI 权威（`--no-verify` 可绕本地钩子，`AGENTS.md:113-118` 说明为何挂 `commit-msg` 而非 `pre-commit`）。 |
| P10 | **覆盖门禁**：受管改动必须同批带笔记 | `AGENTS.md:66-105`；`tools/notes-coverage.mjs`；`package.json:41`、`:105` | 已采纳 | **是**。自动检测源码目录/根清单/流程文件，`docs/`、锁文件、`package.json` 豁免，检测不出的目录打 `⚠` 不静默放行。 |
| P11 | **空集合 / 假绿防护**（`compared >= 20`、空语料抛错） | `audit-upstream-b-drift.md:20`、`:46`；`tools/verify-plugin.mjs:211-229`、`:227`；`AGENTS.md:62-64` | 已采纳 | **是**。哈希门禁要求 `compared >= 20` 防「清单删空后全绿」；`npm run notes:gate` 把空树/零篇判红（`AGENTS.md:54-64`）。 |
| P12 | **构建产物与源一致性**（重建后比对，不信任提交的产物） | `tools/verify-plugin.mjs:118-136`、`:170-177`；`npm run build` | 已采纳 | **是**。`client.js` 重建后与磁盘比对，不一致即红。 |
| P13 | **文本完整性**（拒绝 U+FFFD 替换字符） | `tools/text-integrity.mjs`；`npm run check`（`package.json:82`） | 已采纳 | **是**。接在 `check` 链。 |
| P14 | **第三方归属 / notices** | `AGENTS.md:40`；`tools/notices.mjs:200` | 已采纳 | **是**。`npm run notices`（`notices:check` 在 `check` 内）。注意 `audit-upstream-b-drift.md:234` 指出 `ref: String(manifest.ref ?? upstream.ref)` 在两个来源冲突时**静默取 manifest**，属「事实正确、机制未校验」。 |
| P15 | **上游同步 + vendored 哈希门禁**（manifest 逐文件 sha256，禁手改） | `AGENTS.md:29-31`、`:200-208`；`tools/verify-plugin.mjs:190-236`；`audit-upstream-b-drift.md:16`、`:198`、`:218-229` | 已采纳 | **是**，实测 21/21 一致、`compared >= 20`、`exit 0`（`audit-upstream-b-drift.md:16`）。**已知缺口 G1–G9**：不读 `upstream.json`（`:223`）、孤儿文件不报（`:241`）、manifest 是自身信任根（`:66`）。 |
| P16 | vendored 文档里的 `npx tsx` / `npm run verify-notes` 说法 vs 插件自带运行器 | `audit-upstream-b-drift.md:261`、`:273-275`；`lib/notes.js:387-393`、`:660` | 有意保留差异 | **插件侧已覆盖、文档表面未改**：`lib/notes.js:387-393` 用 `process.execPath`、`:660` spawn 宿主 node；但 `SKILL.md:174-177` 等仍是上游原文（不得手改），宿主 agent 读文档会误以为必须 `npx tsx`。缺口编号 G9。 |
| P17 | **双语文档预算**（`doc:budget`） | `AGENTS.md:139`；`tools/doc-budget.mjs:49-57`、`:64-87`、`:94-137` | 已采纳 | **是**。与 gate #13 是同一机制的「流程入口 vs 门禁本体」两面。 |
| P18 | **实机证据**（`live-evidence`，需真 DSH） | `audit-package-runtime.md:73`；`tools/live-evidence.mjs:119-157`；`AGENTS.md:38` | 有意保留差异 | **有限落地**：只验真实 `SkillRegistry`；`tools/live-evidence` 的命令承接器是占位（`:127-132`），且直接导入工作树 `lib/index.js`，**不是发布归档重定位消费**。`check:full` 需本机 DSH，`check` 不需要。 |
| P19 | **门禁故障注入**（证明门禁会红，脚本缺失/超时算失败） | `AGENTS.md:26-28`、`:37`；`tools/fault-injection.mjs`；`package.json` `gate:fault-injection` | 已采纳 | **是**。这是本仓库对「门禁以退出码为准」的自证手段。 |
| P20 | **技能调用元数据的运行时声明**（`invocation` 显式给出） | `audit-source-policy.md:93`；`lib/skill.js:219-256` | 已采纳 | **是**。前端 frontmatter 只有 name/description，能力在运行时显式声明 `{modelInvocable:true, userInvocable:true}`。 |

**实践侧统计**：已采纳 **16**、有意保留差异 **4**、不适用·否决 **0**，合计 20。

---

## 5. 未验证项与原欠账的去向

「未验证」的两种来源：① 审计报告自认输出截断/未完成；② 本地对照没做全。

原表标注的 20 处已按下述 A–D 四段逐项处置。**处置完不等于证完**：A 段关掉的是
「没读上游判据」，D 段关掉的是「审计输出被截断」；每一行判定真正的强度，仍受该行
「本地否证」一栏里那条命令/那次读的约束。仍显式写着「未读/未跑」的局部，就是
还欠着的地方（例如 #30 的 markdown 辅助逻辑、#21 的浏览器执行上下文是否被真的跑到）。

**A. 上游判据：client-architecture 组 10 道已由 lead 亲读上游源码补齐**
已补判据（各行「上游判据：」字段）：#3、#5、#7、#8、#10、#11、#12、#33、#34、#46。曾为审计原文、未经 lead 复核的截断项 #29、#30、#31、#32、#35、#39、#40、#44 **已于 §5D 逐道复核并关闭**（判定未变，补齐了此前缺的末段判据与本地否证输出）；#21 的浏览器/Node 侧归属也一并确认（见 §5D 首条）。

**B. 本地对照未完成（2 处，均已于 §5D 关闭）**
- ~~#21 `verify-no-bare-dispatcher.ts`~~：已实读周边确认 —— `lib/board-route.js:186-195` 与 `lib/board-responsive.js:394-400` 两处 `fetch` 都在注入浏览器的脚本字符串内（同段出现 `location.replace`/`document.hidden`/`res.json()`），是页面侧调用，不是 Node transport。
- ~~#32 `verify-package-readme-summaries.ts`~~：已核 `README.en.md` 的 11 个 H2（`:13,20,57,193,210,233,423,450,460,474,482`），确无 `## Summary`；该门禁的 globs 全在 `packages/` 下，本地空语料会让它 exit 1。

**C. 整块审计欠账**
`audit-client-architecture.md:53-62` 曾把 12 项里的 11 项标为「待完整读取及本地对照」。本轮 lead 直接读上游 `scripts/verify-*.ts` 补齐了其中 10 道的扫描表达式与失败条件（见各行「上游判据：」），本地否证也用 `ls`/`grep` 复核过；**因此这 10 道的「不适用/保留」是「上游判据 + 本地实测」的结论**。`no-bare-dispatcher`（#21）的浏览器/Node 侧归属与非 client 组的 8 处截断项均已复核，见 §5D。

**D. 剩余 8 处截断项已由 lead 逐道复核（2026-10-21，本轮实读）**

以下每一条都重读了上游源码末段（此前审计输出被截断处），并补了本地否证命令的实际输出。
判定**未变**，但「未验证」标记就此关闭；§5A 里那 8 个编号不再是欠账。

- **#21 verify-no-bare-dispatcher（226 行）**：上游对象是 **Node 侧传输**（undici / Dispatcher / ProxyAgent）。本地两处 fetch 都是**浏览器脚本字符串内部**的调用 —— `lib/board-route.js:190` 落在页面内 setInterval 重试逻辑里（同段用 location.replace、res.status），`lib/board-responsive.js:399` 落在页面内轮询 poll() 里（同段用 document.hidden、res.json()）。二者都不经过 Node 的 dispatcher，属该门禁管辖范围之外。判定：有意保留差异。
- **#29 verify-package-paths（113 行）**：读全 `:55-113`。判据是 `PKG_REF = /\bpackages\/[A-Za-z0-9._/-]+/g` 抓 `packages/...` 字面引用，**目标存在即放行**；缺路径只在「某个路径段命中一个活包名」时才算漂移，另有两条豁免（深度二的包根下未构建 lib/、首段是现存分组目录）。末段空集合**打印 `0 file(s) checked` 仍 exit 0**（不防空语料）。本仓库无 packages/ 树、无 packages/ 引用 → 无可检对象。判定：有意保留差异。
- **#30 verify-package-readme-limitations（95 行）**：读全 `:1-45`。`CANONICAL = '## Known Limitations and Deferred Work'` 逐字要求；`NO_LIMITATIONS` 白名单（packages/util/brand）**自身也被校验**：条目必须命中被扫包、理由必须非空，否则报「renamed or removed? update …」。本地 `README.en.md:477` 是 `## Known limitations`（小写、无后半句），`README.md:410` 是 `## 已知限制` → 逐字判据不成立。**值得记的是那条白名单防腐机制**（`NO_LIMITATIONS` 条目必须命中被扫包、理由必须非空，否则报「renamed or removed? update …」）。

**2026-10-21 改判：已采纳（部分）。** 逐字标题那条判据依然不成立（标题语种与包发现层都不同，维持原否定理由）；但白名单防腐机制已在本地落地：`tools/verify-plugin.mjs` 的 `RUNTIME_ARTIFACTS` 从 `new Set(['.synced-version'])` 改成「名字→理由」映射，两条检查——理由非空、名字在 `lib/` 源码里真有写者（否则说明这条豁免已经腐烂）。对应回归 `tools/verify-plugin.test.mjs` 末尾两条（`没有写理由`、`在 lib/ 里找不到任何写者`），全文件 19/19 通过。
- **#32 verify-package-readme-summaries（77 行）**：读全 `:1-77`。globs 只有 `packages/README.md`、`packages/*/README.md`、`packages/*/*/README.md`；`h2Body(source,'Summary')` 取不到即报「missing ## Summary」；超 100 空白分词才报超限；**空语料直接 exit 1**（no English package READMEs found; the scan is empty or narrowed）。本地无 packages/、`README.en.md` 无 `## Summary`（H2 清单见 `README.en.md:13,20,57,193,210,233,423,450,460,477,482`）→ 移植会以「空语料」红。而「空语料不得当绿」这条**原则本地已由 `npm run notes:gate` 与 `tools/no-fake-green` 承担**。判定：有意保留差异（原则已采纳于别处；README 预算由 `tools/doc-budget.mjs` 承担）。
- **#35 verify-public-repository-links（99 行）**：读全 `:1-99`。封禁对象是**单一具体仓库** deepseek-ai/deepseek-harness-sdk（由数组拼出，避免自身被扫到），语料为 `git ls-files -z`，跳过 `.agents/notes/archived/` 前缀、跳过含 NUL 的二进制、软链读目标内容；比对前经 `canonicalReferenceText` 做 NFKC + `\/` / `\uXXXX` / `%XX` / `&#NN;` / 命名实体解码再小写。本地 grep：全仓库仅 1 处命中，且是**既有笔记里对该门禁的描述文字**（`.agents/notes/implemented/process/2026-10-19-minority-verdicts-confirmed-at-source-level.md:53`），不是仓库链接 —— 顺带证伪「照搬它就能用」：真搬过来，第一个被它判红的就是这句描述。判定：不适用·否决（组织政策 + 无该语料）。
- **#39 verify-ssh-helper-artifact（167 行）**：本地无 SSH helper 产物；grep `ssh|openssh|known_hosts` 在源码/工具里仅命中 `lib/notes.js:218`（git origin 归一注释）与 `tools/board.test.mjs:989-1012`（originOf 单测夹具），**没有任何 helper、Docker fixture 或安装目录可验**。判定：有意保留差异（结构性无对象；审计原判「暂定」就此定案）。
- **#40 verify-ssh-helper-ssh（108 行）**：同上，无运输可验。判定：有意保留差异。
- **#44 verify-type-equiv（391 行）**：`find . -name '*.d.ts' -not -path './node_modules/*' -not -path './.probe/*'` 输出为空；`package.json` 的 `types` / `typings` 均为 undefined，`exports` 只有 `{".":{default:"./lib/index.js"},"./client":{default:"./lib/client.js"},"./package.json":{default:"./package.json"}}`。声明文本一致性无对象。判定：有意保留差异。

---

## 6. 审计报告之间（及与既有笔记之间）的互相矛盾

按「两边各自 `文件:行号`」列出，供裁决，不在此处强行调和。

1. **`no-top-level-await` 定性冲突**
   笔记：`2026-10-19-upstream-comparison-complete.md:57`（有理由不适用）、`:121`。
   审计：`audit-source-policy.md:39`「有意保留差异；**历史 CommonJS 理由失效**」。
   且该笔记自己在 `2026-10-19-minority-verdicts-confirmed-at-source-level.md:70` 承认原写「CommonJS、无 TS 声明」是**事实错误**（`package.json` 是 `"type": "module"`）。本清单按审计归「有意保留差异」。

2. **`export-jsdoc` 定性冲突**
   笔记：`2026-10-19-upstream-comparison-complete.md:57`、`:122`（有理由不适用）。
   审计：`audit-source-policy.md:29`（有意保留差异）、`:34`（保留 JS/鸭子类型取舍）。
   同一件事一方是「不适用」、一方是「保留差异」。

3. **`runtime-closure` 定性冲突**
   笔记：`2026-10-19-upstream-comparison-complete.md:57`、`:125`（有理由不适用）。
   审计：`audit-package-runtime.md:71`（有意保留差异，暂定）。

4. **`agent-note-classification` 定性冲突**
   笔记：`2026-10-19-upstream-comparison-complete.md:81-93`「主体已实现…整体归『已实现』」。
   审计：`audit-notes-docs.md:13`「有意保留差异」，理由是本仓库未等价禁止宿主 `docs/rfc` 旧路径。
   「已实现」与「已采纳」不是同一判据：前者按主体判，后者按判据等价性判。

5. **`package-dependencies` 定性冲突**
   笔记：`2026-10-19-upstream-comparison-complete.md:58`（归入「结构性不适用 30 道」，理由是读 `packages/`）。
   审计：`audit-package-runtime.md:11`、`:53`（「已采用（部分）」）。
   同一条既有「结构性不适用」又有「部分已采纳」，两边不能同真。

6. **46 / 44 / 43 三个总数并存**
   笔记：`2026-10-19-upstream-comparison-complete.md:263-267`「46 个实现 = 44 被引用 + 2 个 SSH 脚本」；同文件 `:6` 附近按 44 分 12+32；`:64` 自述「把 `md-links` 同时算进『已实现』与『不适用』→ 合计 43」。
   本题磁盘枚举 = 76 个 `verify-*.ts`，其中 30 个 `.spec.ts`，**46 个门禁本体**。44 是「被 package.json/CI 引用」的子集，不是门禁全集。

7. **「结构性不适用」计数自相矛盾**
   同一篇：`2026-10-19-upstream-comparison-complete.md:58` 写 **30**，`:127` 写 **32**；`2026-10-19-minority-verdicts-confirmed-at-source-level.md:6` 也写 32。

8. **`client-architecture` 审计的范围 vs 交付**
   `audit-client-architecture.md:3` 声明范围「task-6 分配的 12 项」，但 `:53-62` 把 11 项标为待读，实际只有 `no-bare-dispatcher` 出了暂定结论。也就是说这 12 项的分类在本清单里**主要由磁盘结构否证 + 文件名级理解**支撑，不是审计结论。

9. **`package-readme-summaries` 的本地判据缺证**
   审计 `audit-source-policy.md:67` 给出「有意保留差异」但未引任何本仓库 README 证据行（对比 #30 至少引了概念层对比）；本清单该行的本地部分为自核，已标未验证。

10. **`ssh-helper-artifact` / `ssh-helper-ssh` 的「暂定」与「无产物」张力**
    审计 `audit-package-runtime.md:77`、`:83` 都写「有意保留差异（暂定）」，但同时承认本仓库无 helper 产物；按 §2 的否定理由分类学，「无产物」应落「结构性不存在」。本清单**沿用审计的暂定标签**并在行内标注，不擅自改判 —— 这是「分类学口径」与「审计用词」的差异，不是事实冲突。

11. **`mermaid` 的否决理由强度**
    笔记：`2026-10-19-upstream-verify-count-was-wrong.md:77-96` 以「零图不引入重依赖」否决。
    审计：`audit-notes-docs.md:21` 同意「已否决」但补「**当前语料另核**」—— 即否决理由的适用前提（无 mermaid 图）未复核。结论一致、证据强度不一致。

---

## 7. 一句话结论

46 道门禁里，本仓库**采纳了 7 道**（归档封印 #4、许可证清单 #16 为整体采纳；依赖分区禁令 #27、包元数据/发布清单 #28、客户端路由按 `baseURI` 解析 #7、README 限制白名单防腐 #30、随包配置禁内联取值 #10 为部分采纳）；**25 道是有意的机制层差异**（宿主侧门禁 vs 维护者工具、单包 vs workspace、纯 JS vs TS 声明、窄口径 vs 全口径）；**14 道在本仓库结构上不成立或被明确否决**。此前笔记里的「44 道 / 32 道结构性不适用」与本表的 46 / 14 不是同一判据体系，引用时须注明口径。