# Changelog

本文件记录对使用者有影响的变更。格式对齐 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **本仓库自己的决策笔记门禁**（`tools/verify-notes.mjs` + `npm run notes:gate`）：`.agents/notes/` 此前不存在，三条 vendored 校验脚本也从未接进 npm 与 CI —— 规范只写在 `AGENTS.md` 里，没有任何东西执行它。
  - 不直接把三脚本接进 CI 的原因：它们在**空集合**上都 `exit 0` 并打印 `ok: 0 note(s) verified`，笔记树不存在时 CI 照样绿，是一条恒绿门禁。外壳复用 `lib/notes.js` 的 `runAllGates()`，把空树判成 `NO_NOTES_TREE`、零篇判成 `NO_NOTES_YET`。
  - 判定逻辑不另写一份：CLI、`/agent-notes gate` 工具与 CI 走同一个 `runAllGates()`，避免两份真相漂移成「一个入口拦住、另一个没拦住」。
  - 已接进 `npm run check` 与 `.github/workflows/verify.yml`；`tools/fault-injection.mjs` 新增 `[verify-notes]` 一节，对空树、不存在的树、违规笔记断言变红，并以「合规树必须 exit=0」作反向对照。
  - 文档同步：`README.md` / `README.en.md` 的 CI 片段加了「照抄会恒绿」的警告，`AGENTS.md` 把 `npm run notes:gate` 列为推荐门禁。

- **接入 dsh-better-sidebar 侧边栏**：看板同时出现在该插件的右侧栏，**同一个开关控制**。
  用它的公开客户端服务 `ctx.betterSidebar.registerTab`，不是私有 API。
  - 用 `ctx.inject(['betterSidebar'], …)` 当可选依赖等待；写进插件级 inject 会让
    没装该插件时本插件整个不加载
  - 两个宿主各存各的注册状态，共用一份会让 tab 时有时无
  - 会话字段两种形状都认（顶层 `sessionId` / `scope.sessionId`）—— 只认一种时
    另一个宿主里 iframe 拼出空 session，路由回 409，整块空白
  - 故障注入：两宿主共用状态 → 变红；只认 props.sessionId → 变红；
    betterSidebar 进插件级 inject → 变红

- **版本号与快速探针**：市场/官方源/第三方靠版本号判断更新，所以自动合并后会
  `minor` 递增并打 tag。版本号同时作自更新的探针：只读一个 1.8 KB 的 `package.json`，
  变了才拉 21 个技能文件。实测冷启动 2028 ms → 热启动 79 ms（25.7 倍），热路径零文件请求。
  - 新增 `tools/bump-version.mjs`（patch / minor / major）
  - 试过三条不通的路：jsDelivr `resolved` 返回 `version: null`；jsDelivr 版本列表
    不收录新 tag；GitHub API `/tags` 未认证 60 次/小时即 403
  - `.synced-version` 进 .gitignore（本地状态，不进版本库）
  - 故障注入：minor 不清零 patch → 变红

- **上游自动合并**（`.github/workflows/upstream-sync.yml`）：每日定时把原始上游合并进本仓库，
  不再依赖人记得跑 `sync`。链路：原始上游 →(Action) 本仓库 →(插件启动异步) 用户机器，两段都自动。
  - 用 `git ls-remote` 查上游 HEAD，不用 GitHub API（未认证 60 次/小时即 403）
  - 拿到 commit 而非锚分支名（jsDelivr 对分支名的清单缓存会滞后）
  - 新增 `--auto`：ref 相同时**仍校验本地文件与摘要是否一致** —— 只比 ref 会漏掉
    「记录没变但本地被改过」，那是假绿。实测篡改摘要后旧逻辑直接报「已是最新」
  - 合并后必须过 verify / notes:gate / test / fault-injection 才允许提交

- **项目内副本的检测与同步**（`/agent-notes sync-skill`）：项目仓库里通常还有一份
  `.agents/skills/agent-notes/`（被项目 git 跟踪，供项目自己的 CI 用）。插件不擅自改它，
  改为「检测 + 提示 + 用户确认」：
  - 开关打开时比对项目副本与内置版本，落后就在注入的规范末尾追加一段提示，
    明确要求模型**先问用户**
  - `/agent-notes sync-skill` 默认只打印差异，加 `--yes` 才落盘
  - 项目里多出来的文件不会被删
  - 同步脚本目录即等于更新 CI 的校验逻辑：`ci.yml` 只写 `npm run verify-notes`，
    不含版本号或文件清单；脚本零外部依赖
  - 实机验证：在真实项目里篡改副本 → 检测到落后并生成提示 → 预览不写盘 →
    落盘还原 → 复核不落后，项目 `git status` 干净

- **技能副本异步自更新**：插件启动时在后台拉取本仓库的 `skills/agent-notes`，
  内容有变即替换并调 `SkillProviderControl.invalidate()` 热替换，模型下次加载即新规则。
  - 绝不阻塞启动：`scheduleSkillUpdate()` 是 fire-and-forget，实测 9.1 秒就绪
  - 失败静默：任一文件拉不到即整批放弃，保留现有副本
  - 原子写入：逐文件 `.tmp` + `rename`；内容相同不写盘
  - 来源是本仓库而非原始上游 —— 本仓库跟随上游合并，多一层人工审核
  - 实机验证：篡改副本文件为 13 字节后重启 DSH，启动完成即被拉回 2545 字节上游原文
  - 故障注入：去掉路径穿越检查 → 变红；改成阻塞式 → 变红

### 修复

- **上游漂移无法被发现**（假绿门禁）：`--check` 只比对钉死的 commit，永远返回「一致」——上游发 100 个提交它也报绿。新增 `--latest` 走「按本地清单逐文件取上游分支内容比对」，落后即退出码 1；`2` 表示无法核对（网络/限流），**同样让 job 变红**，避免「查不到」被当成「没问题」。
  - 不用 GitHub API 查 HEAD：未认证 60 次/小时就 403，CI 天天跑必撞。
  - 不用 jsDelivr 清单枚举分支：实测对分支名的缓存滞后，会拿到重构前的旧目录结构；但文件读取是准的，所以只比对内容。
  - 新增 `.github/workflows/verify.yml`：push / PR / 每日定时跑自检与漂移检查。
  - 故障注入验证：篡改 manifest 里一个摘要 → 退出码 1 并指名文件；还原 → 0。

### 新增

- **笔记看板 tab**（`conversation.view` 槽位）：对话 / 轨迹 旁边多一个「笔记」tab。**改用上游成品 UI**：iframe 加载 vendored 的 `agent-notes-board.html`，宿主只注入当前仓库的实时数据到它预留的 `window.__INLINE_DATA__` 插槽 —— 视觉与交互跟随上游更新，不再自绘。
  - 之前那版自己拼的列表 UI 已删除（`lib/client.js` 从 16988 降到 11068 字节）。
  - **实时读取**，不是静态快照：宿主侧注册只读 HTTP 路由（`lib/board-route.js`），浏览器每次切到该 tab 现读磁盘。原因是会话投影的 `view` 必须是同步纯函数（已核对源码），读不到文件系统。
  - **安全边界**：固定路径、只读 `notesRoot` 之下、`isInside` 拒绝 `..` 与「前缀相同但不是子路径」（`/a/bc` vs `/a/b`）；会话解析不出笔记根返回 409，不猜路径、不退回进程目录。
  - **三态分明**：没树 / 有树零篇 / 有笔记，看板如实显示，不拿「0 篇」冒充「全部合规」。
  - tab id 用 `agent-notes-board` 而非 `trajectory` —— 后者是宿主内置轨迹视图的保留 id 且受 developerTools 开关限制。
  - 新增 `lib/board.js`（解析与扫描，含 `buildInlineData` 适配上游格式）、`lib/board-route.js`（HTTP 通道）、`tools/board.test.mjs`（10 项）。已做故障注入：去掉 `isInside` 的路径校验、去掉未知分类过滤、把函数式 replace 改回字符串形式，各自**变红 1 条**。
  - **修复两个注入陷阱**（都补了回归测试）：① 笔记正文含 `</script>` / `<!--` 会截断脚本块 → JSON 里每个 `<` 转 `<`；② 字符串形式的 `String.replace` 会把数据里的 `$&` 当反向引用展开、凭空塞进原 HTML 片段 → 必须用函数式 replace。

### 变更

- **默认改为关闭**（Owner 要求）：新会话与旧会话默认都不启用，需要时手动打开。装插件不再悄悄改变既有会话的行为。
  - `state.effective` 兜底 `true → false`；`apply` 的 `config.enabled` 兜底 `true → false`；`commands.js` 的 `fallbackEnabled` 由 `config.enabled !== false` 改为 `config.enabled === true`；投影 `view` 的兜底 `global === null ? true` 改为 `false`（否则界面胶囊会显示成开）。
  - 想默认开启仍可：`/agent-notes on --global`（落盘），或配置 `enabled: true`。
  - 新增 3 项测试（默认关、显式 true 逃生口、重载后仍默认关），故障注入验证：把默认值改回 `true` 后**变红 2 条**。

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

- **空笔记树被当成「通过」，属假绿门禁**（Owner 指出，已实证复现）。三个校验脚本在空目录上都会 `exit 0` 并打印 `ok: 0 note(s) verified` —— 从「脚本没说错」看是真的，从「笔记是否合规」看是空的。实测一个 `.agents/notes` 根本不存在的仓库，三条门禁全 `passed: true`，被误当成本仓合规证明。
  - 修复：`runGate` 在 spawn 脚本前先拦。笔记树不存在 → `passed: false` + `reason: NO_NOTES_TREE`；目录存在但零篇 → `passed: false` + `reason: NO_NOTES_YET`（判据是「至少一篇」，不是「目录存在」，否则 `/agent-notes init` 后又会漏）。
  - `runAllGates` 与 `agent_notes_gate` 返回值新增 `noteCount` / `notesRoot`，让调用方能分辨「0 篇」与「N 篇全过」。
  - 有笔记且合规时行为不变，仍然 `passed: true`（未误杀正常通路）。
  - 顺带修掉一个把假绿固化下来的旧断言（`空树应通过`）与一处缺基线笔记的故障注入测试。
  - 新增 5 项回归测试，已做故障注入：去掉前置检查后**变红 2 条**，还原后全绿。

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
