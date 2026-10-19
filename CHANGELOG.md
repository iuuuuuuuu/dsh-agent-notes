# Changelog

本文件记录对使用者有影响的变更。格式对齐 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **`npm run text:integrity` —— U+FFFD 能穿过所有现有门禁**
  - U+FFFD（替换字符）是**字节损坏**的痕迹，但文件仍是合法 UTF-8（U+FFFD
    本身是合法字符）—— 所以编码检查抓不到它
  - 实测一份含 U+FFFD 的 Markdown 过 `md-links`：`errors = 0`。笔记门禁也不拦：
    标题层级、段落结构、链接全都正常，**只是内容坏了**
  - 危害比错别字大：读者看到「见上〈U+FFFD〉被否的第三条」只会以为作者写了个
    怪字，不会想到是编码损坏。且一旦提交就进历史，永久留存
  - 首跑即抓出 **12 处**，散落 7 个文件，其中**包括已合并进历史的笔记**
  - 顺带一条：用 `grep` 找 U+FFFD 不可靠（实测漏报全部 12 处）

- **清理仓库里已积累的字符损坏**
  - 上一条门禁抓出的 12 处已逐条修复（多为「见上␦被否的」这类段落中间截断）

- **`main` 分支保护：13 道门禁第一次有了远端强制力**
  - 此前 `main` 无任何保护（`Branch not protected`）。三条绕过路径都实测可行：
    `--no-verify` 绕本地钩子、直推 `main` 跳过 CI、`--force` 改写历史
  - 已配 `required_status_checks=[verify]`、`strict`、`enforce_admins`、
    禁 force push、禁删除。实测 `git push --force` 到 `main` 被 GitHub 拒绝：
    `GH006: Required status check "verify" is expected`
  - 刻意**不**把 `upstream-drift` 设为必需检查：那个 job 在网络不可达时
    **故意**退出 2（查不到也必须红），设为必需会让网络抖动变成无法推送
  - 代价：`strict=true` 要求分支与 `main` 同步，推 `main` 必须走 PR
  - **该设置不在 git 里**，迁移或 fork 时需按笔记里的表格重新配置

- **第三方归属声明 `THIRD_PARTY_NOTICES.md`**
  - 本插件分发的 `skills/agent-notes/` 下 21 个文件是上游
    `czm15053/write-notes-like-deepseek` 的 vendored 副本，此前仓库里
    **完全没有提过上游**。MIT 要求分发衍生作品时保留原版权与许可声明
  - `npm run notices` 生成、`npm run notices:check` 校验（已接入 `check` 与 CI）。
    来源、commit、许可证、文件数全部从 `upstream.json` 与上游清单生成，不手抄 ——
    手写的声明会随同步漂移，而漂移后的归属声明比没有更危险
  - 依赖清单**递归**收集并含传递依赖，许可证从实际安装的包元数据读取。
    只列直接依赖在合规语义上是错的：传递依赖同样落在开发者机器上
  - 许可证标识符用 `spdx-expression-parse` 校验而非手写正则 ——
    `MIT OR Apache-2.0` 这类复合表达式手写必错，而写错的许可证比没有更糟

- **`md:links` —— 拦住文档断链**
  - 仓库有 29 个 Markdown、56 条相对链接。此前没有任何门禁检查它们是否还指向
    存在的文件：笔记门禁只管笔记之间，`verify` 只管双语文档存在
  - 断链在归档/删除笔记、重命名文件时必然出现，且不会让任何测试变红 ——
    只让后来点开的人撞 404
  - 覆盖：fragment/query 剥离、代码块与行内代码跳过、百分号编码解码、
    越界路径拒绝；不扫描 vendored 目录（无权修上游内容）

- **`docs:bilingual` —— 拦住双语 README 结构漂移**
  - `verify` 只验「两个 README 都在且带徽标」。实测给英文版追加一整节，
    中文版完全不知道，它照样绿灯；改的人不会察觉，因为他只读了自己写的那一版
  - 比**结构**（标题层级序列 + 代码块数）而非字数：中英长度天然不同
    （416 vs 471 行，而结构完全一致），拿字数当判据只会长期误报
  - 本次顺带补齐两版 README 都漏掉的 6 个命令说明（`hooks:install`、
    `archive:note`、`notes:coverage`、`notes:supersession`、`doc:budget`、
    `check:full`）—— 装钩子、归档这些日常操作此前根本没写

### 修复

- **`verify-notes` 说「任意仓库可用」，实测四种用法全部失败**
  - README 承诺「直接复用本仓库的 `tools/verify-notes.mjs`」，脚本注释也写着
    「本脚本要能在任何仓库里用 —— 那是脱离 DSH 也能用的前提」。两句都是假的
  - 只拷脚本 → `ERR_MODULE_NOT_FOUND`（静态 import `../lib/notes.js`）
  - **独立仓库自带 `.agents/skills/<技能名>/scripts`（它真正有的形态）→
    仍然全报「脚本缺失」**：脚本就在眼前，而它只在自己包里找
  - 修法一：脚本定位改为多来源 —— 显式指定 → 本包 → **目标仓库的技能目录**
  - 修法二：静态 import 改动态加载。找不到实现时 **exit 2**（「无法进行」，
    与「检查不通过」的 1 区分开）并列出该拷哪些文件，不静默降级成少验几项
  - 修法三：「脚本缺失」现在列出**找过哪些目录** —— 独立仓库里最常见的是
    「脚本在技能目录下但名字对不上」，只报一个拼出来的路径会让人以为文件不存在

- **`standalone.test.mjs` 的依赖检查漏了 `verify-notes.mjs`**
  - 那条检查列了三个脚本，恰恰漏了唯一 import `../lib/` 的那个
  - 且静态检查抓不到「脚本就在眼前却看不见」—— 那要**真的在别的仓库里跑一遍**
    才发现得了。故新增 `tools/verify-notes-standalone.test.mjs`（7 用例，全真跑）

  - 有意接受的代价：只拷一个外壳文件**仍然跑不了**，但从崩溃变成明确报错。
    一个 CLI 外壳没有实现本该跑不了门禁 —— 关键是让它说清该带什么过去，
    而不是伪造一个「能跑」的假象

- **测试里不得用 U+FFFD 字面量**
  - `text:integrity` 会扫到测试文件本身，而那里的 U+FFFD 是**故意构造的**
    测试数据。写成字面量会让门禁永远红，且无法区分「测试数据」与「真损坏」
  - 改用 `String.fromCharCode(0xfffd)` 构造：测试语义不变，源码里没有那个字节

- **`node tools/sync-upstream.mjs --auto --check` 会静默写入**
  - `--auto` 隐含 `--yes` 是设计（CI 用它自动合并），但它**无条件**覆盖了用户
    显式写下的 `--check`。两者同传时会走合并路径真的覆盖 vendored 副本，
    而 `--check` 的契约是「零写入」
  - 隐蔽之处：这次没出事纯属巧合 —— ref 相同且本地与清单一致，路径恰好没写文件
    而已，**退出码仍是 0、不报任何错**。本地一旦有出入就会真的写
  - 修法：`--check` 优先。两者同传退回「只检查」，要写入就显式写 `--auto`

- **`sync:check` 会抹掉 `upstream.json` 里别人的字段**
  - `writeManifest` 原本用白名单重建该文件，只留 `repository`/`path`/`ref`/
    `syncedAt`/`fileCount`/`commit`。于是任何别的字段都会被静默抹掉
  - 实测：第三方归属声明（`THIRD_PARTY_NOTICES.md` 的数据源）依赖的 `license`
    与 `note` 就这样没的，`notices:check` 随之变红 —— 而触发它的只是一次
    普通的同步检查，**没有人改过那个文件**
  - 修法：改成 `{ ...previous, ...managed }`，保留本函数不负责的字段
  - 白名单式的「重建」把「这个文件只有我能写」变成隐式约束，
    而那个约束没有任何文档说明 —— 谁往里加字段都会被抹掉

- **`--help` 的两处文档缺口**
  - `--help` / `-h` 与 `--ref` 都没在用法说明里出现
  - 由新增的「用法文本一致性」测试抓出：每个开关必须拥有自己的说明行

- **`npm run hooks:install` 在部分 Windows 上装不上钩子**
  - 脚本比对 `git rev-parse --show-toplevel` 与自己的 `PACKAGE_ROOT` 来判定
    「是否在仓库根」。原有的归一化处理了大小写、斜杠方向、尾随分隔符，
    **漏了 8.3 短路径**：`import.meta.url` 可能解析出 `C:\Users\<短用户名>\...`，
    而 git 给的是 `C:\Users\<用户名>\...`，两者永不相等
  - 后果：在 `%TEMP%` 或用户目录位于 8.3 形式下的 Windows 机器上，安装直接
    退出 2，**钩子装不上** —— 「该写笔记却没写」这道本地门禁静默消失，
    只剩 CI 那一道还拦着
  - 修法：归一化前用 `realpathSync.native` 展开。注意 JS 版 `realpathSync`
    **不会**展开短路径，只有 `.native` 会（实测）
  - 本机仓库在 `D:\` 下没有 8.3 形式，所以本地一直正常；是补测试时在
    `%TEMP%` 下建沙箱才暴露出来

- **并行测试的偶发失败**
  - `node --test` 各测试文件并行，而 `md-links` / `bilingual-docs` /
    `notices` / `release-check` 各自在改真实仓库文件（`AGENTS.md`、
    `README.md`、`upstream.json`、`package.json`）。**门禁自己也是读者** ——
    测试改写的那几十毫秒里，门禁与其它测试读到的是中间态
  - 症状极具迷惑性：单独跑某文件全绿，全量跑偶发红（8 次红 2 次）
  - 修法：真仓库只读不写，测试构造坏输入改走注入（`verifyMarkdownLinksIn`、
    `verifyBilingual({ read })`、`renderNotices({ read })`、
    `verifyRelease({ read })`）

- **浏览器端注册状态改记「实际结果」**
  - `syncHost` 原先用「上次想让它怎样」当「实际是什么」：注册抛错时
    `enabled` 已记成 true、`dispose` 仍是 null，此后每次同状态对齐都被早退挡掉
    —— 一次瞬时故障会让看板 tab 在整个会话里消失，界面无任何提示
  - 改为以 `dispose` 是否为 null 作判据，且注销失败也要复位句柄

- **补上 `npm run build` 脚本**
  - `verify-plugin.mjs` 早就提示「请跑 `npm run build`」，而该命令并不存在

- **两处测试偶发红**
  - `project-skill` 的 `cpSync` 未建父目录（`cp ENOENT`）；`self-update` 用
    永不 resolve 的 fetch 留下悬挂后台任务，`finally` 删目录后它还在跑

- **CI 增加 `npm ci`**
  - 新增 devDependency 后的必然后果，此前零依赖时不需要这一步

## [0.5.0] - 2026-10-18

### 新增

- **三道笔记纪律门禁，全部借鉴 `deepseek-ai/deepseek-harness` 的实践**
  - 规则来源：DSH 的 `.agents/notes/AGENTS.md`、`scripts/change-scope.ts`、
    `scripts/doc-budgets.manifest.json`、`skills/dsh-pre-push-checks`

- **`notes:coverage` —— 拦住「该写而没写」**
  - 既有的 `notes:gate` 三条脚本只验**已写笔记的格式**，对「改了代码却
    一篇没写」完全无感。本仓库连续 5 次改 CI 流程一篇没写，就是这么漏的
  - 判定口径**自动检测仓库结构**（看目录里有没有 `.dart`/`.rs`/`.go`/`.ts`…），
    不写死任何路径 —— 换技术栈不用改脚本
  - 实测：本插件检测出 `lib, skills, src, tools`；某 Flutter 仓库检测出
    `android, lib, macos, rust, scripts, test, tools, windows`
  - `docs/` 故意豁免：那是计划与排查记录（**过程**），不是决策（**结论**）
  - **区间模式逐提交检查**：合并看会让一个笔记掩护其余所有漏记，
    而那正是批量 push 的常见形态
  - 检测不出来的目录打 `⚠` 提示，不静默放行

- **`notes:supersession` —— 新笔记必须声明与既有笔记的关系**
  - DSH 规则：**Every new Agent Note triggers a supersession check.**
    本仓库原先完全没有，实测 11 篇笔记只有 3 篇有互链
  - 三种合法路径：相对链接 / `Independent: <非空理由>` / `proposed`·`rejected` 豁免
  - 不做语义判重（需要理解内容，做不到可靠；误报的门禁会被绕过）；
    `Independent:` 那一行把「我查过了」从口头声明变成**可验证的动作**

- **`doc:budget` —— 文档字数预算**
  - DSH 给 7 个文件设了字数上限。本仓库 `AGENTS.md` 在一天内从 148 词涨到
    275 词，而没有任何东西阻止它继续吸收「顺便补一句」
  - 中文按**字**计、英文按**词**计（`wc -w` 对中文低估约 7 倍）
  - 预算刻意贴近当前值，只留几十的余量 —— 留太多等于没设

- **`hooks:install` 现在装两道检查**：覆盖门禁 + supersession 检查

### 修复

- **门禁的 git 调用缺 `-z`，中文路径静默逃检**
  - 不带 `-z` 时 git 把非 ASCII 路径转义成 `"lib/\344\270\255\346\226\207.js"`
    并加引号 ⇒ `startsWith('lib/')` 失败 ⇒ **中文路径的源码改动静默放行**
  - 反向也坏：中文文件名的笔记会被认为「没带笔记」
  - 同时补齐 `--no-ext-diff` / `--no-textconv` / `--no-renames` /
    `--ignore-submodules=none` / `maxBuffer: 64MB`
  - 这条是我先前误判「不必要」后经用户提醒重新实测发现的

- **`npm test` 会改写真实的 `skills/agent-notes`，导致 CI 必红而本地全绿**
  - 现象：CI 报 `--check` 失败「相同 15｜变更 6」，且那 6 个文件正是刚合并的，
    行数还是合并前的值；本地 `npm test`、干净 clone、`sync:check` 全绿
  - 根因：`apply()` 里 `scheduleSkillUpdate()` 是 fire-and-forget 且**不传
    `targetDir`**，默认目标就是真实 `skills/agent-notes`；而
    `integration.test.mjs` 真的调用了 `applyPlugin`，等于跑一次真实自更新
  - 本地断链、CI 打通是两个差异叠加：仓库里未被 git 跟踪的
    `skills/agent-notes/.synced-version` 让本地走「版本相同」快速路径什么都不拉；
    CI 全新 clone 没有它 → 全量拉 21 个文件，而推送瞬间 jsDelivr 上 `@main`
    仍指向上一个 commit → 旧内容覆盖刚检出的新版
  - 修法：`apply()` 接受 `config.skillDir` 并透传为 `targetDir`（生产不传，
    行为不变）；`integration.test.mjs` 每个 `mount()` 开一个技能沙箱；
    `self-update.test.mjs` 的「立即返回」测试同样补上 `targetDir`
  - CI 新增永久门禁**测试不得改动工作区**：`npm test` 后断言
    `git status --porcelain` 为空，非空打出完整 diff 并 `exit 1`
  - 故障注入确认（非推断）：传 `skillDir` → `bb76d4d` 保持新版；去掉注入
    且移走 `.synced-version` 模拟 CI → `0e6628c` 被覆盖成旧版，
    与 CI 报的 6 个文件、旧摘要逐字吻合

## [0.4.1] - 2026-10-18

> 版本号说明：`0.4.0` 由 `.github/workflows/upstream-sync.yml` 的自动同步
> 任务先行占用（该提交只升了 `package.json` 与上游 ref，未含本文件的条目）。
> 本次改动在其之上，故记为 `0.4.1`。

### 新增

- **笔记变更后看板自动刷新**：上游的自动同步依赖 FileSystem 目录句柄
  （`Core.dirHandle`），而走服务端注入这条路径永远拿不到句柄 ——
  `triggerLiveSync()` 第一行 `if (!Core.dirHandle) return` 直接返回，
  改了笔记页面纹丝不动（实测 `Core.dirHandle === false`）。
  - 服务端新增 `GET /agent-notes/data`，只返回 `{ revision, notes }`
  - `revision` 是**内容指纹**（对渲染字段做 sha256），不是篇数也不是 mtime ——
    只比篇数时改一篇内容察觉不到，只比 mtime 时部分编辑器会保留时间戳
  - 前端每 4 秒拉一次，变了才调上游的 `ingestDataset()` 重绘；
    无变化零重绘，用户正在看的滚动位置与打开的抽屉不会跳动
  - 状态可观测：`window.__agentNotesLive` 暴露 `{ polls, applied, revision, failures }`
  - **加载后必须立刻探一次**：只等 4 秒周期的话，首次请求拿到的已是最新内容，
    而「首次只记录不重绘」会把这个变化直接吞掉 —— 表现为「轮询在跑但页面永不更新」

### 变更

- **合并上游 `72573a5`，删除抽屉的两处冗余注入**
  - 上游已修好我们提的两个 issue：锁背景滚动 CSS（与我们的写法逐字相同）
    与 `openConsole()` 里的 `scrollTop = 0`
  - 删除前做了剥离实验：用 CDP `Fetch.fulfillRequest` 拦掉注入层再测，
    抽屉行为依然正确（滚到底 → 开第二篇 `scrollTop: 0`、`html/body` 均 `overflow: hidden`），
    证明上游修复单独就够
  - 保留一条**反向**测试，防止冗余悄悄长回来：两份等效实现长期并存必然漂移，
    改一处忘另一处时没人知道哪份在生效
  - 注入层现在只剩热更新轮询（上游没有对应能力）
  - 上游其余改动：`extractSection` 采纳了我们 issue #9 的修法
    （`(?=^## |(?![\s\S]))`）、笔记正文要求简体中文、备选方案允许写「无」、
    归档校验跳过 `AGENTS.md`/`manifest.json`、日期排序加 id 兜底保证稳定
  - 顺带修掉一个合并后遗症：`tools/sync-upstream.mjs` 的 `defaultRef` 是写死的
    常量，`--auto` 合并后只更新 `upstream.json` 不回来改它，导致 `--check`
    拿旧 ref 比新清单报假漂移。改为优先读 `upstream.json` 的记录，常量降为兜底

### 修复

- **`/data` 轮询单次 88ms / 115KB —— 瓶颈是 git 子进程，不是文件 I/O**
  - 最初以为是「每次重新扫盘读文件」，实测证伪：扫目录 + 读全部 md + 解析
    一共只要 **2.96ms**，四阶段合计 **3.21ms**，而 TTFB 是 88ms
  - TTFB ≈ 总耗时（88.24 vs 88.39）→ 时间全花在发出首字节**之前**
  - 根因：`lib/notes.js` 每次根解析都 `spawnSync` 两个 git 子进程 ——
    `git remote get-url origin` **76ms**、`git worktree list --porcelain`
    **73ms**；对照 `statSync` 5 个文件只要 **0.22ms/轮**。git fork 比文件
    I/O 慢三百多倍。容器目录场景还会放大：每个子仓库各 fork 一次
  - **修法一**：给 `originOf` / `listWorktrees` 加 10 秒 TTL 缓存。
    只缓存**成功**结果（把空结果记住会把一次瞬时故障放大成持续的「找不到根」）；
    不能永久缓存（新建 worktree 会静默不出现，比慢更糟）
  - **修法二**：`/data` 的 `rawBody` 只发前 3 行。它占响应体 **53%**，
    而看板对它的全部用法只有一处 —— 取第 3 行做 rejected 笔记的 crux
    （抽屉正文另走 `/note` 现读文件）。保留字段名与语义，上游代码无需改动
  - 实测：TTFB **88.24 → 5.13ms（17 倍）**、响应体 **115815 → 53487 字节（−54%）**
  - 故障注入三组全红：端点不截断 `rawBody`、只截 2 行（crux 丢 Status）、
    TTL 改成永久
  - 修掉一条**假绿**：最初只测 `firstLines` 单元，把端点改回 `note.rawBody`
    后测试仍全绿（单元函数没变，变的是「端点有没有用它」）；
    补上驱动真实响应的断言后才真红

- **热更新轮询在侧边栏切走后仍在跑**（性能问题）：原本用
  `if (document.hidden) return` 节流，但看板跑在侧边栏的 **iframe** 里 ——
  宿主把 iframe 容器设为 `display:none` 后，iframe 内部的 `document.hidden`
  **仍是 `false`**（它反映的是整个浏览器窗口是否可见，不是这个 iframe
  是否被渲染）。实测隐藏 12 秒期间 `polls` 从 2 涨到 5，即仍在每 4 秒拉
  一次 **100402 字节**、服务端仍在做全盘扫描（单次 74–82ms）。
  - 改用 `IntersectionObserver` 观察 `document.body`，渲染树层面判定是否真的可见；
    隐藏时 `clearInterval` 真停表，恢复时立刻补探一次
  - 实测：隐藏 12 秒 `polls` 3 → 3（零请求）、恢复后 3 → 4（立刻补探）；
    可见时响应速度不变（仍是 4 秒）
  - `document.hidden` 保留作双保险（整页 hidden 时 IO 未必回调），两者覆盖场景不同
  - 故障注入四组全红：退回只看 `document.hidden`、删掉 `stop()` 里的
    `clearInterval`、不可见分支不调 `stop()`、去掉启动门控
  - 顺带修掉一条**潜在假绿**断言：原先 `/clearInterval\(timer\)/` 会匹配到别处的
    同名调用，删掉 `stop()` 里的实现后测试仍绿；改为断言 `stop()` 定义体内确实调了它

## [0.3.1] - 2026-10-18

### 修复

- **看板抽屉：打开新笔记不重置滚动位置 + 内外双层滚动条**（两个上游缺陷，改在宿主注入层）
  - 读到一篇最底部 → 打开另一篇 → 从底部开始显示。上游 `openConsole()` 全文没有一次
    `scrollTop` 操作，而 `.console-body` 是 `overflow-y: auto` 的滚动容器
  - 抽屉是 `position: fixed` 浮层，但上游没锁背景滚动，于是页面一条、抽屉内一条，
    滚轮落到哪层取决于指针位置
  - 修法：CSS `body:has(#drawer-console.open), html:has(#drawer-console.open) { overflow: hidden }`
    ＋ 一小段 `MutationObserver` 补丁（观察 `.open` 类变化后把 `scrollTop` 归零，推迟到下一帧）
  - **`html` 也必须锁**：只锁 `body` 时实测 `documentElement` 仍能滚（CDP 量到 `scrollTop`
    可设成 400），第二条滚动条还在
  - 已向上游提 issue：https://github.com/czm15053/write-notes-like-deepseek/issues/10
  - 故障注入：不注入补丁脚本 → 变红；只锁 body 不锁 html → 变红

- **看板详情页每个小节只显示第一行 / 显示为空**：`extractSection()` 的结尾哨兵写错，
  用户看到的「决策 = 两件事分开处理。」就是被截断的第一行。
  - 根因：`(?=^##\s|\s*$)` 配 `m` 标志 —— `\s` **包含换行符**，`m` 让 `$` 匹配行尾，
    两者组合后 `\s*$` 在**第一行末尾**就命中，惰性量词立刻停下。小节标题后紧跟空行时
    直接匹配到空串
  - 修法：`(?=^##\s|(?![\s\S]))` —— `(?![\s\S])` 是真正的字符串结尾，不受 `m` 影响
  - **上游 `build-board.ts` 有同一处 bug**，已提 issue：
    https://github.com/czm15053/write-notes-like-deepseek/issues/9
  - `lib/board.js` 不在 vendored 清单，`npm run sync` 不会覆盖这个补丁
  - 故障注入：正则改回旧写法 → 两条回归测试都变红

- **顶栏在 900–1440px 同样被压成逐字竖排**：上一版把问题定性成「窄屏布局」是错的。
  用户贴出 1146px 的截图后重测全宽度谱系，才发现竖排发生在**宽屏区间**（实测 1146px 下
  `brand-group` 实际高 51px、`deck-tabs` 58px，而上游 header 固定 64px；1000px 情况相同）。
  上一轮只测 ≤900px，把整段漏掉了。
  - 真根因：上游 `.deck-tab` / `.brand-text` 等**自己没有 `white-space: nowrap`**，
    宽度一紧张就在子项内部逐字折行，再被固定 64px 裁掉 —— 断点补在哪儿都治不了
  - 修法：把 `nowrap` 提到**所有断点之外**（全宽度生效），配 `min-width: 0` 允许收缩
  - 顺带修掉两处横向溢出：搜索框写死宽度时实测 760px 处 input 右边缘 767（超 7px）、
    360px 处超 20px；改为可收缩
  - 新增 ≤420px 断点：搜索框收成图标位（聚焦时展开），320px 下顶栏从 140px 回到 100px
  - 实测 320→1440 共 18 个宽度：全部零溢出，品牌/导航恒为 32/39px 正常高度
  - 故障注入：把 `nowrap` 移出全局范围 → 变红

- **会话未加载时看板停在「暂时读不到」**：DSH 重启后，持久化的 tab 会在会话加载完成前
  请求数据，那时服务端拿不到 `header.cwd`；等会话加载完页面已停在错误页，用户不知道要刷新
  （实测截图里的 session id 正是当前会话）。
  - 前端带上 `&cwd=`（宿主的 `SessionScope.cwd`，来自客户端列表摘要，**不依赖服务端是否
    已加载**）；服务端在会话解析失败时才用它兜底，且只接受绝对路径
  - 说明页自动重试：每 2.5s 探一次，成功就地跳进看板，上限 30s
  - 优先级不可反：会话能解析时必须以会话为准（多开同项目时前端 cwd 可能是旧的）
  - 故障注入：撤掉兜底调用 → 变红；去掉绝对路径校验 → 变红；去掉前端拼接 → 变红

## [0.3.0] - 2026-10-17

### 修复

- **侧边栏 tab 显示原始 JSON / 整块空白**：better-sidebar 用
  `createElement(descriptor.component, {ctx, store, scope, tab, visible, …})` 渲染 tab，
  会话 id 只在 `scope.sessionId` 上。上一版把 `component` 写成零参函数，
  把整个 props 丢掉 —— iframe 拼出 `?session=` 空串，路由按设计回 409。
  - 改为 `component: function (props) { return h(AgentNotesBoard, props); }`
  - **原测试为什么没拦住**：断言的是 `bundle 里出现过 scope.sessionId 这段字符串`。
    那句话确实在，但值根本传不到 —— 字符串断言对「props 被丢弃」完全免疫，属假绿。
  - 新测试执行真实路径：捕获 bundle 工厂 → 桩 React 实例化 → 渲染开关触发 `registerTab`
    → 调 `component({scope:{sessionId}})` → 断言最终 iframe 的 `src` 带该 id。
    桩的 `createElement` 必须就地展开函数组件，否则看不到内部的 iframe。
  - 故障注入：改回零参函数 → 变红；还原 → 绿

- **窄屏下顶栏被压成逐字竖排**：上游 `header.hud-topbar` 是 `height:64px` 且不换行，
  右侧栏 400–700px 里五个子项抢不到宽度，每个子项内部逐字换行 —— 实测 652px 下
  `brand-group` 实际高 154px、`deck-tabs` 134px，却被 64px 固定高度裁掉。
  - 看板 HTML 是 vendored 上游资产，**手改会被 `verify-plugin.mjs` 的哈希比对拦下**，
    因此新增 `lib/board-responsive.js`，由宿主在 `/agent-notes/ui` 响应里注入覆盖 CSS
    （只在媒体查询内生效，宽屏视觉与上游完全一致）
  - 窄屏重排为两行：品牌 + 状态灯 + 搜索框 / 导航独占整行并横向滚动。
    顶栏从 140px 降到 100px，500–652px 下四个 tab 完整显示
  - 关键点：`height: auto`（不解除固定高度换行内容仍被裁）、
    `nav { min-width: 0 }`（flex 子项默认 `min-width:auto` 会让 `overflow-x` 失效）、
    `.hud-grow { display: none }`（弹性占位符会抢走一整行，把品牌挤到右上角）
  - **注入幂等判据踩过一个很贵的坑**：原本用 `html.includes(RESPONSIVE_STYLE_ID)`，
    而笔记正文会作为数据注入**同一个页面**，本仓库一篇笔记恰好写了
    `agent-notes-responsive` 这个 id —— 于是把「数据里提到过这个名字」误判成
    「样式已经插过了」，直接原样返回。表现是适配**时有时无**，排查时极易误判成
    「进程没重载」。已改成匹配完整的 `<style id="...">` 标签，并加回归测试
  - 故障注入：去掉 `height:auto` → 变红；完全不注入 → 变红；去掉幂等判断 → 变红；
    把判据改回 `includes(id)` → 变红

- **读不到笔记时把原始 JSON 显示在侧边栏里**：`/agent-notes/ui` 是 iframe 的 `src`，
  浏览器会原样渲染响应体。会话尚未加载（持久化的 tab 仍指向旧会话）时回 409 JSON，
  用户看到的是一坨 `{"error":...}`，看着像插件坏了。
  - `/ui` 现在回一张可读的说明页：写清成因、给出恢复方法（切会话或重开 tab）、
    回显会话 id 与 `reason`；`/board`、`/note` 等给程序用的端点仍回 JSON
  - 会话 id 做了 HTML 转义（它来自 URL 查询参数并回显到页面，不转义就是反射型 XSS）
  - `?session=` 空串归一化成「没传会话」，与「传了但解析不出」用不同 `reason` 区分
  - **没有为了消掉 409 去猜仓库**：曾实现「从同项目其它活跃会话推断 cwd」，实测证伪 ——
    同一项目下 209 个会话的 id 是彼此无关的 UUID，无共享前缀；而 `get()` 只查活跃会话，
    没有任何可证信号能绑定项目。唯一「能拿到值」的写法会在多项目并行时把看板指向
    别人的仓库（显示别人的决策笔记），那种绿比报错更坏，因此保持明确失败
  - 故障注入：说明页分支改成 `if (false)` → 变红；去掉转义 → 变红

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
