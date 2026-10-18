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

所以有第二道门禁，判定口径是**自动检测仓库结构**（不写死任何路径）：

| 受管 | 说明 |
|---|---|
| 含源码后缀的顶层目录 | 自动检测：目录里有 `.dart`/`.rs`/`.go`/`.ts`… 就算源码 |
| 仓库根清单（`pubspec.yaml`、`Cargo.toml`、`go.mod`…）| 改依赖约束/工具链 |
| `AGENTS.md`、`CLAUDE.md`、`.github/workflows/` | 流程规范本身 |

豁免：`docs/`（计划与工作日志是**过程**，不是**决策**；纳入会让笔记树迅速
注水）、锁文件、`package.json`（日常发布只改版本号，属机械改动）。

需要额外声明时，在仓库根加 `.agents/notes-coverage.json`：

```json
{ "sourceDirs": ["odd-dir"], "exemptFiles": ["some.json"], "managedFiles": ["foo.yaml"] }
```

检测不出来的目录会打 `⚠` 提示，不会静默放行。

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

### Supersession 检查：新笔记必须声明与既有笔记的关系

规则借鉴 `deepseek-ai/deepseek-harness` 的 `.agents/notes/AGENTS.md`：

> **Every new Agent Note triggers a supersession check.**

写新笔记前要搜既有笔记树，判定「完全取代 / 部分取代 / 无关」。本插件
把其中可机械化的最低要求做成门禁 —— 新增笔记必须满足其一：

1. 正文里有指向既有笔记的**相对链接**；
2. 正文声明 `Independent: <理由>`（理由非空，表示确实无关）；
3. 它本身在 `proposed/` 或 `rejected/`（还没成为已落地的决定，豁免）。

```sh
npm run notes:supersession    # 查暂存区新增的笔记
```

为什么不做「语义判重」：判断两篇讲的是不是同一个决定需要理解内容，
做不到可靠，硬做会产出大量误报，而误报的门禁会被绕过。
所以只做可机械验证的最低要求 —— `Independent:` 那一行把
「我查过了」变成**可验证的动作**：写理由这件事本身会促使人真去查一遍。

### 改写历史必须用 `--force-with-lease`

同样来自 `deepseek-harness` 的硬规则：**`--force` 永不允许。**

```sh
# 改写前先记录远端当前 OID
git fetch origin
OID=$(git rev-parse origin/<branch>)
# 用 lease 推送：若远端已被别人更新，推送会中止而不是覆盖
git push --force-with-lease=<branch>:$OID origin <branch>
```

裸 `--force` 会静默覆盖别人的提交，而失败方向不可逆 ——
被覆盖的提交若没有别处留存就直接丢了。`--force-with-lease` 把
「我知道远端当时是什么」变成一个必须显式给出的前提。

## 上游

本插件内容提炼自 `czm15053/write-notes-like-deepseek`（MIT），
固定 ref 与逐文件摘要记在 `upstream.json` 与 `tools/upstream-manifest.json`。
上游一旦更新，用 `npm run sync` 核对后合并，**不要手工拷贝**。
