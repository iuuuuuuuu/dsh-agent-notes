# Changelog

本文件记录对使用者有影响的变更。格式对齐 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **浏览器端状态开关**（客户端插件，`src/client.js` + `lib/client.js`）：**输入框工具行左侧**一枚绿色胶囊「● 笔记规范」，紧挨权限选择器（「完全权限/工作区内修改」）那一排，**点击即切换**，关闭时变灰。读会话投影 `agentNotes`，刷新/重连/切会话都自动正确；点击走官方斜杠命令通道，与手敲命令完全等价。
- **会话投影 `agentNotes`**（`lib/projection.js`）：把「本会话是否启用」变成浏览器可读状态。折叠宿主自己写的 `command/run` 事件，插件**不写会话日志**（零依赖拿不到 `appendPluginRecord`，退路 `session.append('plugin:…')` 实测会写出 `ignorable=undefined` 的残废记录，故不走）。
- **全局默认的磁盘镜像**（`global.json`，与 `state.json` 同目录）：投影的 `view` 是同步纯函数，看不到插件内存，靠镜像让新会话显示正确的初值。
- **客户端构建**（`build.mjs`）：把 `src/client.js` 包成 DSH 客户端模块信封（`window.__ModuleLoader__.load({id, factory})`），`package.json` 声明 `dsh.client` 与 `./client` 导出。
- **诊断开关**：URL 带 `?anDebug=1` 时组件把内部状态画到 DOM 上。浏览器里下不了断点、而各处 try/catch 会静默吞异常，没有它只能靠猜；默认关闭。

### 变更

- 曾额外在输入框上方渲染一条整宽 tag，按 Owner 要求**移除**：工具行那枚胶囊已足够表达状态，上方再来一条是冗余视觉噪声。相关样式、文案、槽位注册与组件均已删净（新增测试断言不得留下孤儿引用）。
- 该 tag 当初被拉伸成与输入框等宽，是 `input.dock`（纵向 flex）的默认交叉轴拉伸所致；如需再放此类元素，记得 `align-self:flex-start` + `width:fit-content`。

### 修复

- **`ctx` 属性访问在服务缺失时直接抛，导致插件整体激活失败**（真机启动才暴露，三处）：
  - `ctx.sessionProjections ?? 兜底` 拦不住 —— 属性访问本身就抛 `cannot get property "sessionProjections" without inject`；
  - `ctx.agents?.list` 同理（`cannot get property "agents" without inject`）；
  - 客户端 `ctx.slots === undefined` 也是同一个坑。
  三处统一改为 `ctx.inject([...], cb)` / `ctx.get()`，缺失能力降级关闭而不是崩。
- **客户端在 `apply` 时就缓存 `sessions` 服务**：那一刻服务往往还没就绪，缓存下来就永久是 `undefined`，按钮点了只显示「切换失败」（真机点一下即复现）。改为点击时惰性解析。
- **生效 tag 原计划放对话头部，但该槽位被 DSH 包在 `!hideChrome` 里** —— 空会话（新会话）时整个工具区不渲染，而新会话恰恰最需要看到是否生效。实测确认后改到 `conversation.input.dock`（渲染在输入框之前，不受 `hideChrome` 影响）。
- **安装文档漏了关键一步**：`dsh plugin add` 只写 `dependencies`，**不写** `dsh.profile.bundles`，而 DSH 是按 `bundles` 逐层加载的 —— 只 `add` 的话插件装了却完全不跑，且启动日志无任何报错。README 中英文均已补充说明与验证方法。
- **`agent_notes_gate` 默认 cwd 取错对象，会在错的仓库上跑出真绿**（Owner 实机发现）。
  - 根因：`@deepseek-ai/dsh-agent` 的 `Agent` 接口**只有 `id` 一个字段**，没有 `cwd`；旧代码读 `exec.agent.cwd` 恒为 `undefined`，再静默退回 `process.cwd()` —— 那是 **DSH 自己的安装目录**（如 `C:\...\dependencies\dsh`）。该目录通常也有 `.agents/notes`（DSH 自己的开发笔记），于是门禁**真跑通并返回绿**，测的却是另一个仓库。属「假绿门禁」。
  - 修复：新增 `lib/target.js`，从**会话头** `ctx.sessions.get(agent.id).header.cwd` 取真实工作目录（实机解压会话日志确证该字段存在：`"cwd":"C:\\Users\\...\\default-workspace"`）。
  - 拿不到 cwd 时**明确失败**（`passed: false` + `reason: "NO_SESSION_CWD"` + `notesRoot: null` + `results: []`），绝不退回 `process.cwd()`；`agent_notes_status` 同步报告 `cwd: null` 与 `cwdUnresolved` 说明。
  - 新增 7 项回归测试，已做故障注入：把旧的回退行为注入回去，测试**变红 2 条**；还原后 7/7 绿。

### 说明

- 新增自检门禁：客户端源码与构建产物不同步（改了 `src/client.js` 忘了 build）、宿主与客户端投影键漂移、命令名不一致，任一项都会让 `npm run verify` 变红（已用故障注入验证会红）。

## [0.1.0] - 2026-10-17

首个可装可跑的版本。

### 新增

- **技能 provider**：把上游决策笔记方法论作为 `agent-notes` 技能提供给模型与用户（剥掉 frontmatter，`resourceBase` 指向 vendored 目录，故 `../references/` 相对引用可解析）。
- **`/agent-notes` 命令**：`on` / `off` / `reset` / `status` / `gate` / `init`，其中 `--global` 作用于全局默认。命令直接回 UI、不发给模型，开关操作零 token。
- **双层持久化开关**：全局默认 + 会话覆盖，写入 `~/.dsh/agent-notes/state.json`（原子替换），重载后保持。与参考实现「切换不持久化」相反，这是本项目明确要求的行为。
- **会话级规范注入**：只在开关打开的会话挂载 system-prompt section（`agent.ctx` 作用域），关闭即卸载，不污染全局提示词。
- **真门禁工具**：`agent_notes_gate` 返回**进程退出码**与 stdout/stderr 原文；脚本缺失、超时一律算失败，不降级为通过。`agent_notes_status` 返回开关与笔记树概况。
- **上游合并工具**：`tools/sync-upstream.mjs` 支持 `--check`（零写入、有漂移即非零）与 `--yes`（真覆盖），逐文件 SHA-256 清单记录在 `tools/upstream-manifest.json`。
- **发布前自检**：`tools/verify-plugin.mjs` 校验包清单、patch 一致性、零 `@deepseek-ai/*` 依赖约束、vendored 内容齐备、以及与上游清单的哈希一致。

### 修复

- 上游清单枚举在路径匹配失败时会**静默返回空**，导致工具把「解析失败」报告成「内置副本与上游一致」。现在枚举失败直接抛错并给出可读原因，另加「枚举到少于 10 个文件即失败」的兜底。已加回归测试。
- 上游 ref 默认钉在 commit 而非分支：jsDelivr 对分支名的清单缓存滞后，锚 `@main` 会拿到重构前的旧目录结构。
- vendored 模板文件名漏了 `.md` 扩展名（`implemented` 而非 `implemented.md`），已由新的漂移检测发现并修正。

### 说明

- 本插件不声明也不 import 任何 `@deepseek-ai/*` 包：profile 的 `node_modules` 实际无法解析它们（实测只解析到 `cosmokit`/`schemastery`），因此宿主 API 全按鸭子类型使用，缺失能力降级关闭。
- vendored 上游内容版权归原作者，见 `LICENSE` 的 Vendored upstream content 一节。
