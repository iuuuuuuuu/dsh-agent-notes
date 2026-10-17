# dsh-agent-notes

[English](README.en.md) | **中文**

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

把「为什么这样改、放弃了什么」变成仓库里**可机械校验**的决策笔记，装进 DeepSeek Harness。

> 方法提炼自 [czm15053/write-notes-like-deepseek](https://github.com/czm15053/write-notes-like-deepseek)（它又提炼自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `.agents/notes/` 实践）。
> 本插件把那套方法做成 DSH 原生插件：技能、会话开关、真门禁、上游合并。

## 它解决什么

代码能表达「系统现在怎么跑」，表达不了「**为什么必须这样跑、以及放弃了什么**」。于是每个新会话都会：
自作聪明地「优化」掉一段当年为避免死锁而刻意写别扭的代码；为赶局部需求打穿全局结构；把三个月前已证明会内存溢出的方案再提一遍。

本插件让规矩**绕不开**：和代码同仓库、同一次改动、机械校验、旧决定封存带封印。

## 安装

```sh
# 从本地目录装进你的 profile（开发期）
dsh plugin add --profile <你的profile> /path/to/dsh-agent-notes

# 或从 GitHub
dsh plugin add --profile <你的profile> github:iuuuuuuuu/dsh-agent-notes
```

> **注意：`plugin add` 只写依赖，不会把插件加进启用列表。** 实测确认：它把
> 包名写进 `profiles/<profile>/package.json` 的 `dependencies`，但
> `dsh.profile.bundles` 里没有这一项 —— 而 DSH 是按 `bundles` **逐层加载**
> 插件的（每层读该包自己的 `cordis.patch.yml`）。所以只 `add` 的话插件装了
> 却不生效，`--dump-config` 里也看不到它。
>
> 还需要手动把包名加进 `bundles`：
>
> ```jsonc
> // $DSH_HOME/profiles/<你的profile>/package.json
> "dsh": {
>   "profile": {
>     "bundles": [
>       "@deepseek-ai/dsh-base",
>       "@deepseek-ai/dsh-web-app",
>       "dsh-agent-notes"        // ← 加这一行
>     ]
>   }
> }
> ```
>
> 然后**重启 DSH**。验证是否真加载：`dsh --profile <你的profile> --dump-config`
> 里应出现 `# == dsh-agent-notes` 与 `- id: agent-notes`。若只在依赖里而不在
> `bundles` 里，启动日志不会有报错，插件却完全没跑 —— 这是最容易踩空的一步。

## 用起来

```
/agent-notes                 查看开关与笔记树状态
/agent-notes on              开启本会话的决策笔记（持久化，重载后保持）
/agent-notes on --global     改全局默认（影响所有未单独覆盖的会话）
/agent-notes reset           清除本会话覆盖，回到全局默认
/agent-notes init            在当前仓库建出 .agents/notes 骨架
/agent-notes gate            跑真门禁（也可 gate tree / gate format / gate archived）
```

### 界面上的两处状态提示

不用敲命令也能一眼看到当前会话是否生效：

| 位置 | 形态 |
|---|---|
| **输入框上方** | 整条绿色 tag「● 笔记规范 本会话」；关闭时不显示 |
| **输入框工具行左侧** | 绿色胶囊「● 笔记规范」，紧挨「完全权限/工作区内修改」那一排；点击即切换 |

两者读的是**同一个会话投影**（`agentNotes`），所以状态永远一致，刷新、重连、
切换会话都自动正确。

点击开关走的是官方斜杠命令通道（`/agent-notes on|off`），因此和手敲命令
**完全等价**，并且开关操作零 token。

> 设计说明：投影只折叠宿主自己写的 `command/run` 事件，本插件**不写会话日志**。
> 原因是插件零 `@deepseek-ai` 依赖，拿不到 `appendPluginRecord`；而退路
> `session.append('plugin:…')` 实测会写出 `ignorable=undefined` 的残废记录
> （`pluginRecordOf` 读不回），看着成功实则污染日志。走命令事件则完全绕开这个坑。

开启后，模型侧还会自动获得：
- **`agent-notes` 技能** —— 完整方法论、六类判定、模板、归档规矩，按需加载；
- **`agent_notes_gate` 工具** —— 真跑校验脚本并返回**进程退出码**，不是「看起来合规」；
- **`agent_notes_status` 工具** —— 当前开关与笔记树概况；
- **会话级规范段** —— 只在开关打开的会话注入，不污染全局系统提示词。

## 笔记长什么样

路径即状态，无总索引：

```
.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-主题.md
```

| lifecycle | 含义 |
|---|---|
| `proposed/` | 未落地的方案稿 |
| `implemented/` | 已落地，随代码同步事实 |
| `rejected/` | 审慎否掉，仅当能防重犯时保留 |
| `archived/` | 已封存，SHA-256 封印，只增不改 |

class 封闭集（六种，不可自造）：`feature`、`bug-fix`、`simplification`、`architecture`、`process`、`testing`。

## 门禁：以退出码为准

```sh
node skills/agent-notes/scripts/verify-agent-note-tree.ts       # 目录/分类/文件名/相对链接
node skills/agent-notes/scripts/verify-agent-note-format.ts     # 头部/必备小节/备选方案/禁提案标题
node skills/agent-notes/scripts/verify-archived-agent-notes.ts  # 归档封印只增不改
```

这些门禁**已被故障注入证明会真的变红**（见下）。插件把门禁能力交给模型，但**强制仍应放在宿主仓库的 CI**：

```yaml
# .github/workflows/verify-notes.yml（模板见 skills/agent-notes/templates/verify-notes.yml）
- run: node skills/agent-notes/scripts/verify-agent-note-*.ts
```

## 上游合并

内置内容来自上游固定 commit，可主动核对与合并：

```sh
node tools/sync-upstream.mjs --check    # 只报告漂移，零写入（有漂移则非零退出，可直接进 CI）
node tools/sync-upstream.mjs            # 展示逐文件 diff 摘要，需要 --yes 才落盘
node tools/sync-upstream.mjs --yes      # 真的覆盖内置副本并记录清单
node tools/sync-upstream.mjs --ref <branch|commit>   # 换 ref
```

**为什么默认钉 commit 而不是 `main`**：jsDelivr 对分支名的清单缓存实测会滞后——锚 `@main` 会拿到重构前的旧目录结构，导致路径匹配失败。钉 commit 才拿到该次提交的真实树。这条是踩出来的，不是猜的。

合并后必须重跑：

```sh
node --test tools/*.test.mjs && node tools/fault-injection.mjs
```

## 自检与测试

```sh
npm test                       # 行为测试（真跑子进程、真写文件）
npm run gate:fault-injection   # 证明门禁会红，而不是恒绿
npm run verify                 # 包自检：清单 / patch / 零依赖 / 双语文档与徽标 / vendored 与上游哈希
npm run sync:check             # 上游是否已有更新
npm run evidence               # 实机证据：用 DSH 自带的真实 SkillRegistry 验证注册
npm run check                  # 以上四条串跑
```

`fault-injection` 会为每条门禁注入它该拦的故障（非法分类、坏文件名、缺备选方案、`implemented` 残留提案标题、篡改/删除已封印归档……），断言必须非零退出；再清掉故障断言回到零。**任何一条对故障无反应，该脚本自身非零退出**——它自己也引入了一条必然失败的断言验证过会红。

> `npm run evidence` 与集成测试需要找到 DSH 安装位置。会自动探测 `$DSH_HOME`、`~/.dsh` 及其各 profile 的 `node_modules`；桌面端内置安装等非标准位置请显式指定：
>
> ```sh
> DSH_DIST=/path/to/dsh/lib/bin.js npm run evidence
> ```
>
> 探测不到时 `evidence` **明确失败（退出码 2）**，不假装通过；集成测试则降级为同契约承接器，并在输出里标注实际用的是哪种模式。

## 设计约束（为什么零依赖）

本插件**不 import 任何 `@deepseek-ai/*`**。原因是实测的：profile 的 `node_modules` 里 `@deepseek-ai` 只解析到 `cosmokit`/`schemastery`，插件运行时拿不到 DSH 的类型包。因此：

- 宿主 API 全部按**鸭子类型**使用（`ctx.skills` / `ctx.tools` / `ctx.commands` / `ctx.systemPrompt` / `ctx.agents`），缺失时对应能力降级关闭而不是崩；
- 只用 node 内建模块；
- 工具用**裸对象**注册（DSH 接受原始 `ToolDefinition`，MCP 工具就是这么进来的）。

`tools/verify-plugin.mjs` 会把这条约束当门禁检查：谁往 `lib/` 里加了 `@deepseek-ai/*` import，自检立刻红。

## 组件

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 组装；会话级规范注入的挂载/卸载 |
| `lib/state.js` | 全局默认 + 会话覆盖双持久化（原子写） |
| `lib/notes.js` | 笔记树探测、真门禁执行、脚手架 |
| `lib/skill.js` | `agent-notes` 技能 provider（剥 frontmatter） |
| `lib/policy.js` | 注入的规范文本 |
| `lib/commands.js` | `/agent-notes` 命令 |
| `lib/tools.js` | `agent_notes_gate` / `agent_notes_status` 工具 |
| `skills/agent-notes/` | vendored 上游内容（SKILL.md、references、templates、scripts、assets） |
| `tools/` | 上游合并、自检、故障注入、测试 |

## 已知限制

- **看板模板引 Google Fonts 外链**，离线环境下会退化到系统字体；功能不受影响。
- 上游内容同步依赖 jsDelivr 可访问；不可达时 `sync` 会明确失败而不是静默跳过。
- DSH 处于 developer preview，`peerDependencies` 未声明（本插件不依赖 DSH 包），但宿主 API 若变更需跟随。
- 会话开关按**会话 id**持久化；会话被删除后其覆盖项仍留在状态文件中，目前不做 GC。
- 宿主仓库的 CI 接入需自行配置；插件不代为修改仓库。

## 许可

MIT。vendored 上游内容版权归其作者，见 `skills/agent-notes/` 内注释与上游仓库。

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
