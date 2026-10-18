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
npm run gate:fault-injection   # 证明门禁会红（含笔记门禁外壳）
npm run notes:gate             # 本仓库笔记门禁（空树/零篇判失败）
npm run verify                 # 包自检（含双语文档与 dsh 徽标门禁）
npm run sync:check             # 上游是否有更新
npm run evidence               # 实机证据（需能找到 DSH；非标准位置设 DSH_DIST）
npm run check                  # 上面五条串跑（含 notes:gate）
npm run notes:coverage         # 覆盖门禁：该写笔记的改动必须同批带笔记
npm run hooks:install          # 装 commit-msg 钩子（每个 clone 跑一次）
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

门禁（日常用第一条；它复用 `lib/notes.js`，把「空树 / 零篇」判成失败）：

```sh
npm run notes:gate    # ← 推荐：等价于下面三条，但空集合会红
node skills/agent-notes/scripts/verify-agent-note-tree.ts
node skills/agent-notes/scripts/verify-agent-note-format.ts
node skills/agent-notes/scripts/verify-archived-agent-notes.ts
```

⚠️ 直接跑下面三条时，它们在**空集合**上都 `exit 0` 并打印 `ok: 0 note(s)` ——
笔记树不存在也算绿。**别把它们单独接进 CI**，接 `npm run notes:gate`。

要点：备选方案必写且**先写它最强的理由再否定**；`implemented` 的
`## Decision` 用现在时；收益与代价都写；一篇笔记不得被改写成另一个决定
（理由翻转就新开一篇并互链）。

### 覆盖门禁：拦住「该写而没写」

上面 `notes:gate` 的三条只验**已写笔记的格式**，对「改了代码却一篇没写」
完全无感。本仓库连续 5 次改 `.github/workflows/verify.yml` 一篇没写，
就是这么漏掉的 —— 当时在修紧急 CI 故障，注意力全在「让它绿」上，
而「这次要不要留笔记」需要主动回想规范，多轮对话里必被挤掉。

所以有第二道门禁，判定口径是**路径白名单**（不猜语义，只认路径）：

| 命中即要求笔记 | 说明 |
|---|---|
| `lib/`、`tools/`、`.github/`、`skills/agent-notes/` | 行为 / 工具链 / 流程 / vendored |
| `AGENTS.md`、`CLAUDE.md` | 流程规范本身（改了它就是改规则） |

豁免（规范里的「机械改动严禁立笔记」）：`CHANGELOG.md`、`package.json`、
`upstream.json`、`tools/upstream-manifest.json`。

白名单之外的新顶层目录（如以后的 `apps/`）会打一条 `⚠` 提示，因为白名单
只能覆盖已想到的路径 —— 它不会自动失声，但也不会自动生效，看到就该补清单。

```sh
npm run notes:coverage    # 查暂存区（钩子用的也是它）
```

**确实不需要笔记时**，在提交信息里加一行非空理由（空理由会被拒）：

```
Note-Skip: 只改了注释，无行为变化
```

双层挂载：本地 `commit-msg` 钩子（`npm run hooks:install` 装一次）给即时反馈，
CI 是权威那道 —— 因为实测 `git commit --no-verify` 能绕过本地钩子。
钩子挂 `commit-msg` 而非 `pre-commit`，是因为 `pre-commit` 阶段本次提交
信息还不存在，读不到 `Note-Skip`，会把合法出口堵死。

详细的取舍（为什么不用 husky、为什么保留 `Note-Skip` 口子、白名单的失效面）
见 [.agents/notes/implemented/process/2026-10-18-notes-coverage-gate.md](.agents/notes/implemented/process/2026-10-18-notes-coverage-gate.md)。

## 上游

本插件内容提炼自 `czm15053/write-notes-like-deepseek`（MIT），
固定 ref 与逐文件摘要记在 `upstream.json` 与 `tools/upstream-manifest.json`。
上游一旦更新，用 `npm run sync` 核对后合并，**不要手工拷贝**。
