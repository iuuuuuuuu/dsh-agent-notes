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

### 默认是关闭的

装好插件后，**新会话和旧会话默认都不启用**，需要时手动打开（点胶囊，或
`/agent-notes on`）。这样装上插件不会悄悄改变任何既有会话的行为。

想让所有会话默认开启，二选一：

```
/agent-notes on --global        # 运行时改全局默认，落盘持久化
```

或在插件配置里写 `enabled: true`（仅在该配置生效的 profile 里）。

会话级开关优先级高于全局：单独关掉某个会话后，改全局也不会影响它。

### 界面上的状态提示

不用敲命令也能一眼看到当前会话是否生效：**输入框工具行左侧**有一枚绿色胶囊
「● 笔记规范」，就挨着「完全权限/工作区内修改」那一排，**点击即切换**；
关闭时胶囊变灰。

它读的是**会话投影**（`agentNotes`），所以刷新、重连、切换会话都自动正确。
点击开关走的是官方斜杠命令通道（`/agent-notes on|off`），因此和手敲命令
**完全等价**，并且开关操作零 token。

> 设计说明：投影只折叠宿主自己写的 `command/run` 事件，本插件**不写会话日志**。
> 原因是插件零 `@deepseek-ai` 依赖，拿不到 `appendPluginRecord`；而退路
> `session.append('plugin:…')` 实测会写出 `ignorable=undefined` 的残废记录
> （`pluginRecordOf` 读不回），看着成功实则污染日志。走命令事件则完全绕开这个坑。

### 笔记看板：对话区多一个「笔记」tab

对话 / 轨迹 旁边会多出一个 **「笔记」** tab，里面就是上游那套成品看板
（架构基线 / 演进时间线 / 避坑智库 / 决策清单四个视图），**不自绘 UI**：

> tab 里用 iframe 加载 vendored 的上游资产
> `skills/agent-notes/assets/agent-notes-board.html`，宿主只负责把**当前会话仓库**的
> 笔记实时注入它预留的 `window.__INLINE_DATA__` 插槽。
>
> 这样做的理由：官方看板是 76K 的成熟 UI（交叉引用入度、因果链路、多维筛选），
> 自己重画一套只会更丑、且必然与上游越走越远。走 iframe 后**视觉与交互完全跟随
> 上游更新**，本插件只维护数据适配层（`lib/board.js` 的 `buildInlineData`）。

它读的是**实时磁盘内容**而不是静态快照：宿主注册只读 HTTP 路由
（`/agent-notes/ui`、`/agent-notes/board`、`/agent-notes/note`、`/agent-notes/health`），
每次切到该 tab 现读。

> 为什么不用会话投影：投影的 `view` 必须是**同步纯函数**，只能读会话日志折叠出的
> state，读不到文件系统（已核对源码 `view: state => wire.view(state)`）。
>
> 安全边界：路由只接受固定路径，只读 `notesRoot` 之下且拒绝任何 `..`；
> 会话解析不出笔记根时返回 **409**，绝不猜一个路径或退回进程目录。

**注入数据必须防住两件事**（都有回归测试）：

1. 笔记正文里出现 `</script>`、`<!--` 这类片段时，会把注入的脚本块从中间截断
   —— 表现为页面空白、计数恒为 0。做法是把 JSON 里每个 `<` 转成 `<`。
2. 用字符串形式调 `String.replace` 时，数据里的 `$&`、`` $` `` 会被当成反向引用
   展开，凭空塞进原 HTML 片段。必须用**函数式** replace。

开启后，模型侧还会自动获得：
- **`agent-notes` 技能** —— 完整方法论、六类判定、模板、归档规矩，按需加载；
- **`agent_notes_gate` 工具** —— 真跑校验脚本并返回**进程退出码**，不是「看起来合规」；
- **`agent_notes_status` 工具** —— 当前开关与笔记树概况；
- **会话级规范段** —— 只在开关打开的会话注入，不污染全局系统提示词。

### 工具作用于哪个仓库

`agent_notes_gate` / `agent_notes_status` 默认作用于**当前会话的仓库根**
（取自会话头的 `cwd`，向上找含 `.git` 的目录）。也可以显式传 `cwd` 覆盖。

**会话拿不到工作目录时会明确失败**，返回 `passed: false` + `reason: "NO_SESSION_CWD"`，
而不是退回进程当前目录。这一点是刻意的：DSH 进程的 cwd 是**它自己的安装目录**，
那里往往也有 `.agents/notes`（DSH 自己的开发笔记），退回过去会真的跑通并返回
绿 —— 但测的根本不是你的仓库，属于「假绿」。宁可报错。

> 所以：如果你的会话是在没有工作区的状态下建的，跑门禁请显式传 `cwd`。

### 零篇笔记不算通过

门禁只有在**至少验过一篇笔记**时才可能返回绿：

| 情况 | 结果 |
|---|---|
| `.agents/notes` 不存在 | `passed: false`，`reason: NO_NOTES_TREE` |
| 目录存在但一篇笔记都没有 | `passed: false`，`reason: NO_NOTES_YET` |
| 有笔记且全部合规 | `passed: true`，`noteCount` 为实际篇数 |
| 有笔记但有违规 | `passed: false`，`exitCode: 1` + 具体诊断 |

底层的三个校验脚本在空目录上都会 `exit 0` 并打印 `ok: 0 note(s) verified`。
从「脚本没说错」看是真的，但从「我的笔记合规吗」看是空的 ——
**没东西可验不等于验过了**。所以插件在调用脚本前先拦一道，避免把空集当通过证明。
返回值里始终带 `noteCount`，让你能分辨这两种情况。

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

> ⚠️ **照抄上面两行会得到一条恒绿门禁。** 三个脚本在**空集合**上都 `exit 0` 并打印
> `ok: 0 note(s) verified` —— 笔记树不存在时 CI 照样绿。它们只回答「已有的笔记合不合规」，
> 不回答「有没有笔记」。要么先在自己的 CI 里补一步「至少一篇」的前置判断，
> 要么直接复用本仓库的 `tools/verify-notes.mjs`（它调的 `lib/notes.js` 会把空树判成
> `NO_NOTES_TREE` / `NO_NOTES_YET`，并且这条行为有回归测试与故障注入守着）。

## 上游合并

内置内容来自上游固定 commit，可主动核对与合并：

```sh
npm run sync:latest                     # 与上游默认分支逐文件比对，判断是否落后
node tools/sync-upstream.mjs --auto      # 查上游 HEAD 并合并到它（CI 用，隐含 --yes）
node tools/sync-upstream.mjs --check    # 只比对钉死的那个 ref，零写入
node tools/sync-upstream.mjs            # 展示逐文件 diff 摘要，需要 --yes 才落盘
node tools/sync-upstream.mjs --yes      # 真的覆盖内置副本并记录清单
node tools/sync-upstream.mjs --ref <branch|commit>   # 换 ref
```

### 两条检查的区别（重要）

| 命令 | 回答的问题 | 会变红吗 |
|---|---|---|
| `--check` | 内置副本与**钉住的那个 commit** 是否逐字相同 | **几乎永远绿** —— ref 就是上次同步时的 commit |
| `--latest` | 内置副本与**上游默认分支**是否一致 | 会：落后即退出码 1 |

`--check` 单独用时是一条**恒绿的门禁**：它存在、每次都过、不验证任何东西。
真正该问的是「上游有没有新提交」，那只能拿本地清单去和上游分支逐文件比。
`--latest` 就是干这个的，`.github/workflows/verify.yml` 会在每次 push、
PR 和每日定时任务里跑它。

退出码语义：`0` 一致，`1` 已落后（真红），`2` 无法核对（网络/限流）。
**`2` 也让 job 变红** —— 否则「查不到」会被当成「没问题」。

**为什么默认钉 commit 而不是 `main`**：jsDelivr 对分支名的**清单缓存**实测会滞后——锚 `@main` 会拿到重构前的旧目录结构，导致路径枚举失败。但它的**文件读取**是准的（已验证 `@main` 与钉住 commit 的同一文件逐字相同），所以 `--latest` 走「按本地清单逐个取文件内容比对」，不依赖远端枚举。

**为什么不用 GitHub API 查 HEAD**：实测未认证请求 60 次/小时就 403（rate limit exceeded），CI 里天天跑必然撞墙。

合并后必须重跑：

```sh
node --test tools/*.test.mjs && node tools/fault-injection.mjs
```

### 项目内副本：只提示，不擅自改（`/agent-notes sync-skill`）

除了插件自带那份，**项目仓库里通常还有一份** `.agents/skills/agent-notes/`
（被项目 git 跟踪，供项目自己的 CI 门禁使用）。插件自更新**只管自己那份**。

为什么不去自动改项目那份：它属于项目仓库的正式内容。插件擅自改写会

- 让用户的 `git status` 突然变脏；
- 让本地与 CI 跑不同版本的校验脚本；
- 往项目仓库里注入意料之外的改动。

所以这里是**检测 + 提示 + 用户确认**：

1. 开关打开时，插件比对项目副本与内置版本；落后就在注入的规范末尾追加一段提示，
   明确要求模型**先问用户**，而不是自己动手；
2. 用户同意后跑 `/agent-notes sync-skill` —— 默认只打印差异（预览），
   加 `--yes` 才真的落盘；
3. 项目里多出来的文件（内置版本没有的）**不会被删除**，那是项目自己的东西。

#### CI 不用单独同步

项目 CI 的调用链是：

```
ci.yml → npm run verify-notes → tsx .agents/skills/agent-notes/scripts/*.ts
```

`ci.yml` 里只写 `npm run verify-notes`，**不含版本号或文件清单**。所以同步脚本目录
就等于更新了 CI 实际执行的校验逻辑，`ci.yml`、`package.json`、`.github/` 都不需要改。

这些脚本**零外部依赖**，只用 `node:` 内置模块和互相引用，换版本不会引入新的 npm 包。

### 技能副本会自己更新（异步，不阻塞启动）

`skills/agent-notes` 是 vendored 副本。为了让已安装的插件不必手动同步，插件在
`apply` 时**后台**拉一次本仓库的技能目录（`lib/self-update.js`）：

- **绝不阻塞启动**：`scheduleSkillUpdate()` 是 fire-and-forget，网络再慢也不拖慢
  `apply`。代价是启动那一瞬间技能可能还是旧的。
- **失败静默**：断网、CDN 不可达、任何一个文件拉不到 → 整批放弃，**保留现有副本**。
  技能旧一点可以接受，技能不可用不行。
- **原子写入**：逐文件写 `.tmp` 再 `rename`，中途失败不会留下半套内容。
- **内容相同不写盘**：避免每次启动都改 mtime、触发无谓的热替换。
- **热替换**：真的写入新内容后调宿主的 `SkillProviderControl.invalidate()`，
  宿主丢弃缓存并通知消费者重新取，模型下次加载即新内容。

为什么从**本仓库**拉而不是原始上游：本仓库跟随原始上游合并，等于多一层人工审核
——原始上游改坏了可以在这里挡掉。来源常量在 `UPDATE_SOURCE`。

关掉它：把 `lib/index.js` 里的 `scheduleSkillUpdate(...)` 调用删掉即可（或按需加配置项）。

### 侧边栏（dsh-better-sidebar）

装了 [dsh-better-sidebar](https://github.com/dhicoc/dsh-better-sidebar) 时，看板也会出现在它的
右侧栏里，**同一个开关控制**：笔记规范关着就不出现，打开才出现。

接入方式是该插件公开的客户端服务 `ctx.betterSidebar.registerTab(...)`，不是私有 API：

- **可选依赖**：用 `ctx.inject(['betterSidebar'], …)` 等待，绝不写进插件级 `inject` ——
  写进去的话，没装那个插件时本插件会**整个不加载**；
- **状态分开记账**：两个宿主（内置槽位 / 侧边栏）各存各的注册状态。共用一份会让
  「一个就绪、另一个没就绪」互相覆盖，表现为 tab 时有时无；
- **会话字段两种形状都认**：内置槽位给顶层 `sessionId`，better-sidebar 给
  `scope.sessionId`。只认一种的话，另一个宿主里 iframe 会拼出空 session，
  路由回 409，整块空白。

### 版本号

市场、官方插件源、第三方靠**版本号**判断有没有更新 —— 内容变了但版本号不动，
对它们来说等于没更新。所以：

- 自动合并上游后会 `minor` 递增（`0.2.0` → `0.3.0`）并打 `vX.Y.Z` tag；
- 手动发布用 `node tools/bump-version.mjs [patch|minor|major]`；
- 版本号同时是**自更新的快速探针**：插件启动时只读一个 1.8 KB 的
  `package.json` 判断版本变没变，变了才去拉 21 个技能文件。

实测提速：冷启动（拉全部文件）约 2028 ms，热启动（版本未变）约 79 ms，
**25.7 倍**，且热路径不产生任何文件请求。

> 为什么不用 commit SHA 做探针：试过 jsDelivr 的 `resolved` 端点（对本仓库返回
> `version: null`）、jsDelivr 版本列表（新 tag 迟迟不收录）、GitHub API `/tags`
> （未认证 60 次/小时就 403）。三条都不通，只有读 `package.json` 稳。

### 上游会自动合并进来（不再需要手动跑）

`.github/workflows/upstream-sync.yml` 每天定时（也可手动触发）执行：

1. `git ls-remote` 查上游分支的真实 HEAD；
2. 与 `tools/upstream-manifest.json` 记录的 `ref` 比较 —— **相同还不够**，
   还会逐文件校验本地内容与摘要是否一致（ref 只记录上次同步的目标，
   本地文件仍可能被改过）；有出入一样走合并；
3. 逐文件拉取并覆盖，更新清单；
4. **跑完 verify / notes:gate / test / fault-injection 才允许提交**；
5. 用 `github-actions[bot]` 身份提交并 push。

所以完整链路是：

```
原始上游 --(GitHub Action，每日)--> 本仓库 --(插件启动时异步)--> 用户机器
```

两段都不再需要人记得。任何一段失败都会让 job 变红，不会静默跳过。

**为什么用 `git ls-remote` 而不是 GitHub API**：未认证请求 60 次/小时就 403，
定时任务天天跑必撞墙。git 协议没这个限制。

**为什么拿到 commit 而不直接锚分支名**：jsDelivr 对分支名的清单缓存会滞后，
锚 commit 才能拿到该次提交的真实树。

### 副本更新后，模型什么时候看到新规则

`lib/skill.js` 的 `get()` **每次调用都现读磁盘**，没有缓存。所以：

- 自更新写入新内容后会调 `invalidate()`，宿主丢弃缓存的技能目录，
  模型下一次加载技能就是新内容，**不需要重启 DSH**；
- 但技能内容不是每轮都注入的 —— 它按需加载（`SkillDefinition` 语义），
  已加载过的会话可能还持有旧正文。

判据：让模型重新触发一次技能加载即可；要绝对确定就重启宿主。

## 自检与测试

```sh
npm test                       # 行为测试（真跑子进程、真写文件）
npm run gate:fault-injection   # 证明门禁会红，而不是恒绿
npm run verify                 # 包自检：清单 / patch / 零依赖 / 双语文档与徽标 / vendored 与上游哈希
npm run sync:latest            # 上游是否已漂移（会真变红）
npm run sync:check             # 副本与钉住 ref 是否逐字相同
npm run evidence               # 实机证据：用 DSH 自带的真实 SkillRegistry 验证注册
npm run check                  # 全部纯本地门禁串跑（提交后跑这个）
npm run check:full             # check + evidence（需本机 DSH）
npm run hooks:install          # 装 commit-msg 钩子：每个 clone 跑一次，此后漏写笔记会被当场拦下
npm run archive:note -- <路径> # 归档并封印（哈希由脚本算，勿手改 manifest）
npm run doc:budget             # 文档字数预算（超了会红，提示压缩而非扩预算）
```

`fault-injection` 会为每条门禁注入它该拦的故障（非法分类、坏文件名、缺备选方案、`implemented` 残留提案标题、篡改/删除已封印归档……），断言必须非零退出；再清掉故障断言回到零。**任何一条对故障无反应，该脚本自身非零退出**——它自己也引入了一条必然失败的断言验证过会红。

其中 `hooks:install` 值得单独说一句：它把「该写笔记而没写」这道检查挂到本地 `commit-msg` 上，当场给出反馈。但钩子能被 `git commit --no-verify` 绕过，**CI 那一道才是权威的**——两道都要在。

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
