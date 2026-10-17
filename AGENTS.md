# AGENTS.md — dsh-agent-notes

本仓库自身的开发约定。**本仓库就是这套「决策笔记」方法的第一个真实用例**：
非平凡改动必须留笔记，笔记与代码同批提交。

## 这是什么

一个 DSH 插件：把决策笔记方法论做成技能 + 开关 + 真门禁 + 上游合并。
内容来源与合并方式见 `README.md`，变更史见 `CHANGELOG.md`。

## 硬约束（改动前必读）

1. **零 `@deepseek-ai/*` 依赖。** 不是风格偏好，是实测约束：profile 的
   `node_modules` 里 `@deepseek-ai` 只解析到 `cosmokit`/`schemastery`，
   插件运行时拿不到 DSH 类型包。宿主 API 一律按鸭子类型用，缺失能力降级关闭。
   `tools/verify-plugin.mjs` 会把这条当门禁拦。
2. **门禁以退出码为准。** 任何校验都读子进程退出码；脚本缺失、超时算失败，
   不得降级为通过。`tools/fault-injection.mjs` 负责证明门禁会红。
3. **不要手改 `skills/agent-notes/` 下的 vendored 内容。** 那是上游副本，
   由 `tools/sync-upstream.mjs` 管理；手改会被 `verify-plugin.mjs` 的
   哈希比对拦下。要改就改上游或改本插件自己的 `lib/`。
4. **文档双语，中文为默认。** `README.md` 是中文（默认入口），`README.en.md`
   是英文，两者互链，且**都必须带 dsh 徽标**（powered by dsh）。
   `verify-plugin.mjs` 会把「少一个版本」或「缺徽标」当门禁拦下。
5. **不得硬编码本机路径。** 工具与测试对 DSH 位置一律自动探测或读
   `$DSH_DIST`；探测不到要明确失败，不要为了「跑通」写死绝对路径。

## 命令

```sh
npm test                       # 行为测试（真跑子进程、真写文件）
npm run gate:fault-injection   # 证明门禁会红
npm run verify                 # 包自检（含双语文档与 dsh 徽标门禁）
npm run sync:check             # 上游是否有更新
npm run evidence               # 实机证据（需能找到 DSH；非标准位置设 DSH_DIST）
npm run check                  # 上面四条串跑
npm run sync -- --yes          # 真合并上游（改完必须重跑 check）
```

## 本仓库的决策笔记

本仓库同样遵守这套方法。改动非平凡时，在 `.agents/notes/` 下按
`{lifecycle}/{class}/yyyy-mm-dd-主题.md` 记一篇：

```
.agents/notes/
├── proposed/      想法阶段，未落地
├── implemented/   已落地，随代码同步事实
├── rejected/      被否，仅当能防重犯时保留
└── archived/      封存只读（SHA-256 封印）
```

class 封闭集：`feature`、`bug-fix`、`simplification`、`architecture`、`process`、`testing`。

判定：改了**行为 / 架构 / 跨文件契约 / 流程工具链 / 测试策略 / 落盘·网络·配置格式** → 必写；
纯格式化、错别字、不改行为的补丁、常规 CRUD → 不写。

门禁：

```sh
node skills/agent-notes/scripts/verify-agent-note-tree.ts
node skills/agent-notes/scripts/verify-agent-note-format.ts
node skills/agent-notes/scripts/verify-archived-agent-notes.ts
```

要点：备选方案必写且**先写它最强的理由再否定**；`implemented` 的
`## Decision` 用现在时；收益与代价都写；一篇笔记不得被改写成另一个决定
（理由翻转就新开一篇并互链）。

## 上游

本插件内容提炼自 `czm15053/write-notes-like-deepseek`（MIT），
固定 ref 与逐文件摘要记在 `upstream.json` 与 `tools/upstream-manifest.json`。
上游一旦更新，用 `npm run sync` 核对后合并，**不要手工拷贝**。
