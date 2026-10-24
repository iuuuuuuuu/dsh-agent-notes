# Changelog

本文件记录对使用者有影响的变更。格式对齐 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。


## [0.10.0] - 2026-10-24

### 新增

- **`tools/configure-notes-gate.mjs`：把别的仓库的门禁配套升到当前版本。**
  实测 6 个在用仓库里有 4 份格式门禁仍是**未修复版**（会把行内代码里的 `<!--` 当成真注释、
  把合法笔记判红），1 份是刻意的本地分叉，1 个仓库根本没有脚本 —— 而这类漂移不会自己暴露。

  用法：`node tools/configure-notes-gate.mjs --root <仓库> [--dry-run] [--check] [--force]`。

  - 沿用目标仓库**已有布局**（`.agents/skills/<任意技能名>/scripts/` 或 `.agents/notes-scripts/`），
    不另建第二份；
  - 只覆盖**能证明是旧副本**的文件（与未打补丁的原文逐字相同）；本地改过的默认跳过并打印原因；
  - 不碰目标仓库的 `.agents/notes/`、它自己的门禁壳与项目专用脚本；
  - `--check` 供 CI 用（配套落后即退 1）。

  实测结果：4 份旧副本升级、1 份本地分叉跳过、1 个仓库从零配齐；6 个仓库里 5 个的笔记门禁
  全部 exit 0（第 6 个没有笔记树，如实报 `NO_NOTES_TREE`）。

### 修复

- **上游校验会永久挂住**（真缺陷，本轮实测）：不带超时的 `fetch` 遇到「服务端接受连接却永不响应」会一直等 —— 用不存在的 ref 打 jsDelivr 时 CLI 45 秒零输出，测试撞 120 秒上限才被杀。CI 上（`upstream-sync.yml` 定时 `--auto`）会把 job 挂到平台超时。现在每次请求带 20 秒超时，超时判「环境问题」（exit 2）且**不重试**（不响应的端点不会在 250ms 后恢复），错误里带上 URL 便于定位。

## [0.9.1] - 2026-10-24

### 修复

- **笔记里泄漏本机标识**：隐私扫描（整棵已发布树，不是只扫暂存 diff）抓到一篇笔记引用了
  实测调试输出里的 Windows 8.3 短名（前六位即用户名）。已替换为 `<8.3 短名>`，语义不变。
  该目录不在 npm 发布清单（`files` 不含 `.agents/`）里，所以包没受影响，但仓库里有 —— 已修。
  这类泄漏「扫暂存 diff」永远发现不了，只有按 HEAD 全树扫才看得见。

## [0.9.0] - 2026-10-24

这一版是一次「门禁可信度」的集中修补：两份只读审计找出的 10 条假绿/假红全部修掉，
每条都有能真红的回归与真变异证据。**有两条默认行为变化，升级前请看「变更」。**

### 修复

- **归档旁挂绕过零篇守卫**（假绿）：活动生命周期已排除 `.zh.md`，archived 侧却仍计入 ⇒
  树里只放一个 `archived/<class>/x.zh.md` 加一条封印，就得到 `passed: true` / `noteCount: 1`，
  而三条门禁实际校验 `ok: 0`。现在任何生命周期的 `.zh.md` 都不算独立笔记。
- **归档旁挂的封印从不复算**（假绿）：只查 manifest 里有没有这个键，改内容或伪造封印值全绿。
  现在按与 vendored 验正笔记**逐字相同**的字节口径复算，不一致报 `seal mismatch` 并打出两边实际值。
- **上游校验：5xx 被判成「上游有差异」**（假红）：判据用 `\b(401|403|429)\b` 匹配消息里的数字，
  5xx 整族落进「检查失败」（exit 1）且不重试。现按类别判：408/5xx 判环境且重试，
  401/403/429 判环境不重试，只有**清单端点**的 404 留在 exit 1（ref 不存在是真差异）。
- **上游校验：一个文件都没比对成就报「一致」**（假绿 + 基线自毁）：全 404 与全相同走同一条绿分支，
  打印「无需合并」并 exit 0；非 `--check` 时还在不需要 `--yes` 的路径上把 21 条摘要写成 0 条。
  现在比对不全即 exit 2，且发生在写盘之前。
- **传输层抖动被报成契约破坏**（假红）：`TypeError: terminated` + `UND_ERR_SOCKET` 不在原词表里，
  退化成 exit 1「合并失败」。判据改为认错误码族（`^UND_ERR_`），并对传输层失败做 3 次有限重试。
- **Git 不可用时改验另一棵笔记树**（假绿）：`repoRoot()` 把 git 失败与「不是仓库」混为一谈，
  在别的仓库里会去验插件自己的笔记并报绿。现在只有 git 明确说「not a git repository」
  才允许回退；`GIT_DIR` / `GIT_WORK_TREE` / `GIT_COMMON_DIR` 被覆盖时一律 exit 2。
- **笔记根被解析了四处**（假绿）：只传 `options.env.AGENT_NOTE_ROOT` 时预检看树 A、门禁验树 B、
  计数报树 A。现在只解析一次、全程复用。
- **取消信号传到一半就丢**：`lib/tools.js` 传了 `exec.signal`、`spawnCapture` 也支持，
  但 `runGate` 转发时丢了。实测 4 秒的假门禁 + 300ms abort：修前跑满 4324ms 且报绿，
  修后 320ms 被 SIGKILL。已 abort 的信号现在也立刻生效。
- **取不到语料报成「校验失败」**（退出码语义）：`tools/eol.mjs` 在 git 不可用时 exit 1（= 这批文件违规），
  实际一条都没检查。现在 `git-error` ⇒ exit 2，真违规与 `git-empty` 仍 ⇒ exit 1。
- **格式门禁把行内代码里的 HTML 注释当成真注释**（假红，来自真实项目 sourin-flutter-spike）：
  一篇**必须**写出该字面量才能说明问题的笔记会被判「缺小节」，诱导作者删掉笔记里的事实。
  现在执行期给脚本副本打补丁（磁盘上的 vendored 逐字节不变）：行内代码不参与注释状态机，
  已在注释里时仍用原始行找结尾。锚点对不上会**大声告警**，不许静默降级。
- **生命周期根层的目录说明被判红**（假红）：vendored 的 `ROOT_ALLOWLIST` 明确放行
  `{lifecycle}/AGENTS.md` 与 `CLAUDE.md`，插件却判成「散落文件」⇒ 同一棵树 vendored 绿、插件红。
  现在跟着放行（只放这两个确切名字，其他浅层 `.md` 仍判红）。

### 新增

- **`scriptsDirCandidates` 认识 `.agents/notes-scripts/`**：真实项目长出来的布局（门禁脚本与
  `notes-coverage`/`notes-selftest` 等项目专用脚本同目录，迁不走）。排在官方技能目录**之后**。
- **生命周期白名单一致性门禁**：`npm run verify` 解析 vendored 的 `ROOT_ALLOWLIST` 与
  `lib/notes-layout.js` 的 `LIFECYCLE_ROOT_GUIDES` 并逐项比较，不一致即非零退出 ——
  两份名单仍然存在，但漂移会被抓住。
- **版本标签的真实挂载回归**：此前 10 条版本提示用例全是直接调函数，`lib/index.js` 的接线
  一条没验；新增 3 条真挂载用例（真 Cordis → 真 `agent/created` → 真读状态文件）。

### 变更

- **归档 append-only 的默认基线改为 `origin/main`**（原为 `HEAD`）。`HEAD` 与提交后的工作区
  是同一份内容，于是这道检查只防「改了没提交」——已提交的封印改动看不见（实测默认 exit 0）。
  没有 `origin/main` 时退回 `HEAD` 并往 stderr 告警。**升级后，历史上改过封印并已提交的仓库
  会首次变红** —— 那是刻意的收紧，不是回归。
- **`--check` 的错误分类变了**：5xx/408 现在报「无法校验上游」（exit 2）而不是「合并失败」（exit 1）；
  比对不全同样 exit 2 且零写入。

### 附注

- `tools/sync-upstream.test.mjs` 不再写死清单条目数（21），改为从清单读取 ——
  上游增删文件不再让用例因为「数字过时」而假红。

## [0.8.0] - 2026-10-22

### 新增

- **笔记正文的行内位置引用也进门禁**：`npm run doc:refs` 的语料从 `docs/` 扩到
  `.agents/notes/**`（跳过 `archived/`），本仓库受检引用从 57 条增到 73 条。
  三类引用按位置跳过，不靠白名单：`.probe/`（探针目录被 gitignore，别人 clone 里不存在）、
  上游 `scripts/` 前缀（上游 A 的 verify 脚本在仓库根）、`archived/`（已封印，红了也改不动）。
- **`notes-coverage --since <base-ref>`**：先 `git merge-base <base-ref> HEAD` 求分叉点，
  只查「本 PR 自己带来的提交」。分叉点求不出来（浅克隆、base-ref 已删、非 git 目录）
  一律退出 2 并说明原因，不静默退化成全历史或全绿。现有 `--range` 行为不变。
- **`docs/known-gaps.md`**：把已经判定过、明确不做的缺口写成清单（每条带「为什么不修」
  与「什么情况下重访」），防止同一批问题被反复重新讨论。
- **`tools/notes-gate-vacuity.test.mjs`**：用测试钉住「vendored 三道门禁在空集合上
  `exit 0`，而 `lib/notes.js` 外壳判红」这个对照，连带钉住「有合规笔记时外壳必须真绿」。

### 修复

- 覆盖门禁 `--since` 路径上一处遗留的故障注入改动被清掉（`resolveMergeBase` 曾把
  分叉点换成 `HEAD`，等价于永远查空区间）。


## [0.7.0] - 2026-10-22

### 新增

- **行内位置引用门禁**（`npm run doc:refs`）
  - 文档里写成 `文件:行号` 的引用现在会被逐条检查：文件不存在、行号超出
    该文件实际行数、目标不是普通文件，都判红
  - 围栏代码块里的示例按**等长**遮盖，报出来的行号仍是原文行号
  - 白名单条目必须写理由，且必须真的被某条引用命中 —— 没人用的死条目判红
  - `docs/` 一并纳入链接检查；两处空集合（没有 `docs/`、有文档但零引用）都判红，
    不再「没东西可查所以通过」

- **看板补齐归档入口**
  - `已归档` 那张 KPI 卡原本被上游四列网格挤到第二行，现在与另外四张同排
    （窄屏按 3 / 2 / 1 列降级）
  - 点它原本只设了状态下拉、人还停在架构基线视图，等于没反应；
    现在复用上游的筛选路由，先清掉类目/搜索残留再切到目录视图

- **一处正文渲染补丁**：上游 Markdown 渲染不认 GFM 表格，看板抽屉里表格
  显示成一堆竖线文字；`lib/board-markdown.js` 只补这一条规则，其余输出沿用上游

- **`docs/upstream-46-gates.md`**：上游 46 道校验的逐条唯一分类
  （7 道已采纳、25 道机制层差异、14 道不适用或否决），每条都带双方
  `文件:行号` 证据。分类口径与判定依据写在同一页，便于日后重访

- **归档基线不再「查不到就当没有」**：`archived` 门禁在基线 ref 解析、
  `ls-tree` 读取、历史清单解析、封印比对任一环节异常时判红；
  空仓库（有 `HEAD` 但没有归档清单）明确放行，并有正例证明查询真的命中了条目

- **随包自检加强**：依赖三区（含 `optionalDependencies`）、四种 `import` 形态、
  递归扫描 `lib/` 子目录、孤儿文件、`cordis.patch.yml` 禁 `!!js` 与 `process.env`、
  运行时产物白名单条目必须有理由且在源码里真有写者

### 修复

- **空预算清单恒绿**：`doc:budget` 拿到空清单时打印「0 个文件都在预算内」并
  退出 0，等于清单丢了也通过；现在先判红
- **故障注入清单漏算用例**：原来按行首 `test(` 计数，写在 `for` 里缩进注册的
  用例被漏掉；改为词界匹配，并让失败信息带上 `signal` —— 子进程崩溃不再
  被当成「门禁变红」
- **`DSH_DIST` 指向目录时 `npm run evidence` 起不来**：`createRequire` 的入参
  必须是文件名，传目录会让 Node 去父目录找 `node_modules`；现在两种写法都行
- **模板常量被裸反引号提前终止**：新增一条只读源码的体检（不 `import` 模块），
  报出被提前结束的行号；此前这类错误只在运行期以 `SyntaxError` 的形式出现

### 变更

- 桌面端 iframe 改用相对地址，`/`、`/dsh/`、嵌套前缀三种挂载位置都能加载

- **双语门禁补上第五项：链接目标逐条比**
  - 原来只比标题层级 / 代码块 / 围栏语言标记 / 表格行列数。
    把英文版里一个 GitHub 地址换成另一个仓库、中文版不动，**四项全绿**，
    而中英读者点过去是两个不同项目
  - ★ 新判据必须**含绝对 URL**：真实 README 两版各 8 条链接，其中 6 条是
    外链 —— 只比相对链接等于把最容易漂的那一类全放了
  - 语言切换器那两行按 `languageSwitcherTargets` 跳过（与
    `bilingual-links` 共用，不另写一份口径）
  - `tools/markdown-links.mjs` 加 `includeAbsolute` 选项（默认 `false`，
    查断链的既有口径不变）

### 修复

- **`docs:fix-links` 是以「检查」的身份接进 `check` 链的改写型脚本**
  - 它没有参数、每次跑都写盘：种一条指错语言的链接进去，
    它自己改好然后报「无需改动」—— **永远返回 0 的门禁等于不存在**
  - 它还会让 `verify.yml` 末尾的「工作区必须干净」断言在本地把
    **别人的未提交改动**说成「某个门禁留下了改动」，排查方向从这里就错
  - 拆成两个入口：`npm run docs:links`（`--check`，只读，门禁用）
    与 `npm run docs:fix-links`（写盘，人手动用）。判据仍是同一份
    `scanTranslationLinkLocales()`
  - 顺带修掉空集合恒绿：一对文档少了一个时，`--check` 现在报「缺失」
    并返回 1，不再因为「没有指错语言的链」而恒真通过

- **npm 包在 `node_modules` 下门禁跑不起来**
  - Node 拒绝在 `node_modules` 下剥离类型（实测）：
    `node node_modules/probe/a.ts` → `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`。
    加 `--experimental-strip-types` **也拦不住** —— 限制在路径本身，不在开关
  - 而 `skills/agent-notes/scripts/` 下 7 个门禁脚本全是 `.ts`，
    所以**直接发包 = 交付一个装完就坏的门禁**
  - ★ 关键：**本地测不出来**。本地仓库不在 `node_modules` 下，跑一切正常；
    `npm run check` 340/340 全绿，对这个问题完全无感

  - 修法：运行时把 scripts 目录**复制到临时位置再执行**（零转译）。
    选它而不是预编译 `.js`：
    · 手写转译实测栽了三次（正则漏 4 类 → 补了仍漏 3 类 → 扫描器误吞括号 0/7）
    · 官方 `module.stripTypeScriptTypes` 确实 7/7 一次过，
      **但那是「能不能做」不是「该不该做」** —— 预编译产物要跟着 vendored
      上游同步重新生成，那是一条新的漏
    · 复制到 tempdir 天然免疫上游同步

  - ★★ 真正的根因是**一个退格符**（0x08）混进了正则：

        if (!/^Hnode_modules^H/i.test(script)) ...

    语义变成 `/\x08node_modules\x08/` —— **永不匹配**，这个函数一直没生效。
    `text-integrity` 本来抓得到，是我没在改动后立刻跑 check。
    而这行若不是**真机验证**（把包装进 node_modules 真跑）永远看不出来：
    本地走的是「不复制」的**正确分支**，看起来一切正常

  - 真机验证 9 条全过，其中一条是**故障注入的前提确认**：
    先证明「直接跑确实会失败」，再验「复制后能跑通」
    —— 否则可能在解一个不存在的问题

    门禁真跑通：`ok: 67 note(s) tree and relative links verified`
    三个门禁脚本在 `node_modules` 下逐一验过，全部 exit=0
## [0.6.0] - 2026-10-19

### 新增

- **参考式链接支持 + 双语互链自动改写**
  - 参考式链接（`[文字][ref]` + `[ref]: 目标`）的路径不在 `()` 里，所以
    用 `](路径)` 正则的代码全都看不见它
  - 现状实测：行内式 137 条、参考式 **0 条**。所以这是**防御性完备**，
    不是修现存缺陷

  - **为什么值得做**（读了上游源码才明白，与「省 token」无关）：
    上游 `translation-links.ts:62` 的类型里显式含 `definition`，而它做的是
    **自动改写**（`rewriteTranslationLinkLocales`）—— 只改行内式、漏了定义行
    → **一篇文档改了一半，比不改更糟**
    ★ 「自动改写型工具必须支持参考式」才是真正理由。`archive-note.mjs`
    同样是自动改写型，所以同一理由成立

  - 抽出共用件 `tools/markdown-links.mjs`，三处都接它：
    · `md-links` —— 检查行内式 + 参考式，**新增「未定义引用」检查**
      （未定义引用渲染出来是字面的 `[文字][ref]`，原实现完全看不见）
    · `archive-note` —— 改写行内式 + **仅被引用过的**定义（与上游同口径；
      孤立定义不是链接，改它就是擅自修改未使用的内容）
    · `bilingual-links`（新）—— 双语互链自动改写，语言切换器那行跳过
      （与上游 `skipTargets` 同口径）

  ★ 诚实说明第三件的适用面：本仓库只有一对文档且互链**当前是对的**；
    而上游 `languageSwitcherTargets` 把切换器那两行也列为 skipTargets，
    所以**上游那套机制对我们当前没有可改的东西**。做的是最小可用形态。

  ★ 三条方法教训（本轮各栽一次）：
  ① **注释承诺 ≠ 实现做到** —— `collectRelativeLinks` 的 JSDoc 写着
     「只扫围栏之外」而实现里根本没有围栏过滤。漏的原因：只跑了注释里的
     例子，**没跑反例**
  ② ★ **只用 ASCII fixture 验含中文的实现必然漏** —— `blankOutFences`
     把围栏内换成空串，ASCII 下长度不变而中文下每个汉字 3 字节：
     `原文 71 字节 → 处理后 42 字节`，偏移全错，围栏里的示例反而被改
  ③ **断言本身可能写错** —— 我断言「所有链接都不指向 README 自身」
     失败了，查证后发现是**断言错了**：第 3 行就是语言切换器，正确行为
     断言失败时先问「是实现错还是断言错」，别默认实现错

- **双语门禁补上表格结构比对**
  - 现状：只比标题层级、代码块数量、代码块语言标记三项；上游比五项
  - 决策依据（实测，不是偏好）：
    · **表格进** —— 4 张真表（6x2 / 6x2 / 4x3 / 11x2）中英每行单元格数逐行相同。
      表格是**跨语言刚体**：同一份对照表列数不一致读者就对不上，与翻译无关
    · **列表不进** —— 分节实测 25 节里 24 节一致，唯一不一致的第 19 节是
      **真漂移但属排版选择**：中文两个列表项、英文两段散文，内容不缺。
      加进去立刻红，且红了也没错。半边比全边比更有价值
  - 顺带确认：上游的 `excluded` 是**文档路径级**排除，没有段落级降噪机制；
    `GENERATED_REGION` 是给机器生成内容做替换用的，不是降噪清单 ——
    所以「照抄上游就能降噪」这条路不通

  ★ 表格提取逻辑前三次都留下碎片，而**中英碎片恰好一致所以门禁每次都绿**
  （两次假绿）：
  ① 没有分隔行判据 → 正文里带竖线的行被切成 6 张单行碎片
  ② 分隔行判据放在「是不是内容」之后 → 分隔行 `|---|---|` 字符全在 `[\s|:-]` 里，
     那个判据对它必然为假 → 分隔行永远不被识别
  ③ 顺序对了但状态机错了 → 分隔行 push 后置空 pending，数据行成了新片段，
     真表格被拆成 `[表头,分隔]` + `[数据...]` 两半
  最终：**只有被分隔行确认的候选才算表**；表格体由空行终止。11 张（含碎片）→ 4 张全真

  验证：故障注入 9 条全过（删一列红 / 多一表红 / 同步改绿 / 少一行红 /
  整表删掉红 / **单侧加碎片也不红**，证明碎片确实没被算成表）

- **看板首页补上「已归档」入口**
  - 现象：归档笔记在数据层、渲染层都正常（真机确认带「已归档」徽标显示），
    但**首页那 4 张 KPI 卡只覆盖 3 个 lifecycle** —— implemented / proposed /
    rejected / simplification，`archived` 不在其中。不点筛选下拉找不到
  - 判为**遗漏而非设计**：同一份 HTML 里归档是完整支持的（`.st-archived`
    徽标样式、`LIFECYCLES` 含它、`STATUS_LABELS.archived`、筛选器认它）
  - 改在上游 HTML 的**注入层**（`lib/board-responsive.js`）补一张卡 ——
    vendored 内容手改会被 `verify-plugin.mjs` 的哈希比对拦下
  - 三个关键结论**全部来自真机**，读代码一个都看不出来：
    ① 上游 `renderBaseline()` 每次做 `kpi-row.innerHTML = ...` **整体覆盖**，
       而它 5 秒一轮热更新 → 「插一次」必然被抹掉（实测采样 8.5 秒，
       全程 row=4 但最后 card=NO）→ 必须用 MutationObserver 补回
    ② observer 回调是**微任务**，在同步块结束后才执行 → 「改完立刻置标志位」
       拦不住自触发 → **页面卡死（DOM 0 字节）** → 必须 disconnect/observe
    ③ 数据注入要转义 `<`（生产代码早有：`.replace(/</g, "\\u003c")` + 函数式
       replace）—— 本仓**真有一篇笔记引了看板源码**，不是假设
  - 真机验证四用例：archived=1 显示 1 / archived=0 **显示 0 不隐藏** /
    撤掉补丁卡片消失（证明来自本补丁）/ **25 秒后仍在**（跨 3 轮上游重渲染）
  - 配套 `tools/board-responsive.test.mjs`（6 条离线用例）守「补丁源码含什么、
    注入是否发生、幂等」；真机时序验证不入库（慢且不稳）
  - 顺带把 `tools/board.test.mjs` 三处写死「补丁 1 个」的断言改成按补丁数算 ——
    **判据本身一个字没改**，只是「干净」的定义要跟着注入物数量更新

- **`tools/find-browser.mjs`：6 个渲染探针不再硬编码本机 Chrome 路径**
  - 原先每个探针各写死 `C:/Program Files/Google/Chrome/Application/chrome.exe`，
    **换机器/换平台就崩** —— 这是它们不能进 `npm test` 的直接原因
  - 查找顺序：$CHROME_PATH → $PUPPETEER_EXECUTABLE_PATH → PATH →
    各平台常见位置 → **puppeteer 下载缓存**（CI 可用 `npx puppeteer browsers
    install chrome` 装到那）。显式指定永远优先，永不猜
  - 找不到时 **exit 2**（无法进行）而非 1 —— 「没装浏览器」是环境问题，
    报成「渲染验证失败」会误导排查
  - **不引入 puppeteer**（尽管它已装好且实测可用）：探针是原生 CDP，逻辑完整
    且已验证有效，重写是纯浪费。只解决「找到浏览器」这一层
  - 实测 `visibility.mjs` 与 `switch-render.mjs`（470 行那个）真跑通，
    后者在真实 Chrome 里验了渲染、交互与窄屏适配
  - 测试有两条**真启动 headless Chrome**（读回 DOM、打开本地文件），
    **不 mock `spawnSync`** —— mock 掉它那测试就变成「验证 mock 自己」
  - 由测试抓到一个真 bug：设了不存在的 `$CHROME_PATH` 时那句「已设但文件不存在」
    被丢掉，用户设的路径**静默被忽略**而返回值让他以为设置生效了 ——
    「显式设置被静默忽略」是最难查的一类问题
  - **仍未进 `npm test`** —— 前置条件（自动定位）已做好，接进去是下一步，
    届时要决定 CI 装不装浏览器

- **修正一处「不假定外部环境」的误读**
  - 此前把「渲染探针不能进 npm test」的理由写成「需要本机装 Chrome，
    而本仓库硬约束是不假定外部环境」。**那句话说的是「门禁不能因用户没装
    DSH 就失败」，不是「CI 不能装浏览器」** —— 与零依赖那条同源，
    已在 zero-dep 那篇里统一纠正

- **并发度不做改动，并否决上游那套「按 CPU 数的固定上限」**
  - 先纠正一个更基础的错误说法：`node --test` **默认就是并行的**。
    所以「切到并行」这件事**早就完成了** —— 真正的问题只是「偶发红」，
    而那两个根因（autocrlf 污染 diff、if-present 语义漏洞）已修
  - 实测本仓库 29 个测试文件里 **23 个（79%）是进程与 I/O 密集**
    （起子进程 / 建临时目录 / 拷文件树），不是 CPU 密集
  - 所以按 CPU 核数定并发是**错的信号**：实测「并发 4」（54s）反而比
    「默认≈并发 16」（44s）**更慢** —— 核数再多，进程创建与临时目录 I/O
    也不会更快，只会互相踩
  - 上游的 `LOCAL_PARALLELISM_CAP = 12` 解决的是「容器配额 vs 宿主机核数」，
    而本仓库的真实瓶颈是进程与 I/O —— **照搬会解决错的问题**
  - 本轮**不设**并发上限：手头两份测量数据都不可信（一份脚本的通配符在
    Windows 上不展开导致「12 次跑 10 红」完全无效；一份后台测量与 check
    互相干扰）。**不能用被污染的数据做调度决策**
  - 下一轮该测的是「机器能并行跑多少**进程**」而不是「多少**核**」

- **`docs:bilingual` 增加「代码块语言标记顺序一致」检查**
  - 原有检查只比「围栏**数量**」，不比「标记**是什么**」
  - 语言标记（sh / bash / yaml）**不承载语义** —— 翻译它没有意义，
    所以两版不一致**一定是真漂移**
  - 实测三个候选只有它无歧义：
    · 段落数 / 列表项数 —— **中英排版惯例本来就不同**（中文把内容排在列表里、
      英文排在正文段落里；中文还有「一格多项」）。翻历史数据发现 30 处
      「差异」全是方法假象 —— 做成门禁会一直红且红了也没错
    · 代码块内的命令行 —— 命令**相同**但**注释不同**（注释本就该翻译）
    · **围栏语言标记** —— 完全相同 ✅
  - **不需要 mdast**：判据就是「围栏行里那三个反引号后面跟的词」，
    它在代码块内容之外，正则不会误吃块内文本
  - **原计划的 mdast 方案被替代** —— 动手核实后发现那 5 个「增量」全是方法假象，
    引一个依赖去测一件测错的事是最坏的结果
  - 只取**开启**围栏（开闭成对，奇偶位置），否则闭合围栏的空标记会混进序列
  - 故障注入 6/6 全部符合预期，含「两版同时加同样围栏 → 必须绿」
    （证明这不是「只要有围栏就红」的假红门禁）

- **`ci:align` 从「查一个文件」扩到「查所有 workflow」+ 6 条 CI 安全属性**
  - 两种口径：`verify.yml` 是 `all`（跑齐本地链），`upstream-sync.yml` 是
    `subset`（4 道必需：verify / notes:gate / npm test / fault-injection）
  - subset 的 9 条豁免**逐条写了理由**（文档类门禁判的是人写的文档，
    机器人不改那些文件；coverage 类判「本次提交范围」，机器人不经人审）
  - 新增 6 条安全属性断言：PR 触发器 / `fetch-depth:0` / 最小权限 /
    工作区洁净断言 / **门禁排在 push 之前** / push 受 `if` 保护
    —— 删任一条都红并点名
  - 其中 `fetch-depth:0` 最隐蔽：删掉不会让门禁变红，只会让 `notes-coverage`
    **从「通过」退化成「查不到」** —— 那是另一种假绿

- **未登记的新 workflow 报出来但不判红**（有意取舍）
  - 强制登记会逼着人给纯通知型 workflow 填一堆不需要的门禁豁免，
    **乱填的豁免表比没有更糟** —— 它稀释了这张表的可信度
  - 报出来 = 让人知道；不判红 = 不逼人乱填

- **`md:links` 排除归档笔记作为「源」（对齐上游 `verify-md-links.ts`）**
  - 上游第 33 行注释写明：`Archived notes are excluded as sources,
    but links to them remain checked`
  - 本仓库此前无差别扫描 `.agents/notes/`，所以第一篇归档笔记一落地
    `md:links` 就报 3 处红
  - 排除后：归档笔记内部的断链不再报（承认封存内容会腐化，且封印机制
    **设计上禁止**事后修改）；**活文档指向归档笔记的断链照常报**
  - 故障注入证明排除没蔓延：给活文档造一条指向归档笔记的坏链 → 仍 exit=1

- **仓库第一篇归档笔记已入库**
  - `2026-10-18-drop-redundant-drawer-patch-after-upstream-fix.md`
    （上游已修复抽屉缺陷、插件删掉注入层重复补丁，决策使命完成）
  - `archived` 门禁报 `1 archived note(s) verified, 1 seal(s) in manifest`
  - 两处「活文档 → 归档笔记」的入站链接已手工改成 `../../archived/<class>/x.md`
    —— 归档脚本会打印提示但不自动改，因为改法取决于语义

- **提交前钩子从 2 道扩到 8 道**（`.githooks/commit-msg`）
  - 字符完整性、门禁对齐、Markdown 链接、双语结构、归属声明、发版记账，
    外加原有的覆盖与 supersession
  - **刻意不放 `npm test`**：283 个用例约 34 秒，每次提交都等这么久
    人就会转去 `--no-verify` —— 那时门禁彻底失效，比没有更糟
  - 钩子正文拆到 `tools/hook-body.mjs` 导出：它是「门禁的门禁」，
    藏在模板字符串里就没法单独测

- **`npm run ci:align`：门禁对齐检查**
  - 本地 `check` 链里的每一步都必须在 CI 里出现，否则报缺失
  - 豁免必须显式登记理由 —— 否则将来有人删掉 CI 那步时它不会知道
    少了东西，而那正是它要防的缺陷

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

- **归档不再切断笔记里的相对链接**
  - 问题：`archive-agent-note.ts` 移动文件时只做头部规范化，**正文里的
    相对链接一条都不改**（`:83`）；而 `:127-155` 只**扫描入向**链接并打印
    「请自行检查」，出向链接（正是会断的那批）完全不管
  - 后果：`implemented/<class>/x.md` 里的 `../bug-fix/y.md` 归档后解析成
    `archived/bug-fix/y.md` → 不存在。**本仓库唯一的归档笔记就有 1 条，
    且修不了**（已封印，改动报 `seal mismatch`）
  - 修法：加 `tools/archive-note.mjs` 作为 `archive:note` 入口，
    **先把相对链接改写成归档后仍可解析的形式，再调上游脚本**
  - ★ 顺序是关键：封印在归档那一刻计算。「先归档再改链接」会让哈希对不上，
    而**重算 manifest 等于「授权改封印」**，与封印的意义直接冲突。
    所以必须「先改写、再归档」—— 封印天然一致，无需重算
  - 刻意不碰：代码块内的内容（改它就是篡改历史）、绝对 URL、纯锚点、
    指向笔记树之外的路径（如仓库根 README，其基准没变）
  - 已知缺口：**参考式链接**（`[x][ref]` + `[ref]: path`）不处理，仍会断

  ★ 这次两个真 bug 都是故障注入跑真流程才暴露的：
  `notesRoot` 写死成脚本自身位置（沙箱测试直接被护栏拦下）、
  `PACKAGE_ROOT` 多上了一层 `dirname`。
  **离线用例 12/12 全绿时它们都还在** —— 因为离线用例直接调
  `rewriteRelativeLinks`，**绕过了入口**。验入口必须真跑入口。

- **断网时 `sync-upstream --check` 报「契约被破坏」，实际是网络不行**
  - 实测断网（SSL 握手失败）时它返回 **exit 1**（= 检查失败），
    与「上游真有差异」**无法区分**
  - 后果：测试报「--check 在上游一致时应 exit 0，实际 1 / 合并失败: fetch failed」
    —— **断言在说契约被破坏，实际是网络连不上**。会误导排查
  - 修：新增 `isEnvironmentUnavailable()`，网络类错误（含 401/403/429 限流）
    映射到 **exit 2 = 无法进行**，与本仓库其它工具一致
    （`verify-notes` / `install-hooks` / `doc-budget` 都用 2 表示无法进行）。
    404 留在 1 —— 上游确实没那个 ref，那是**有效检查结果**
  - 测试侧同步改：遇到 exit 2 时**仍然失败但说清原因**，**不用 `test.skip()`** ——
    跳过是假绿的温床，会让「这条契约现在没人验」静悄悄过去
  - 措辞向既有约定靠拢（用「无法校验上游」而不是我最初写的「无法检查」）——
    `self-update.test.mjs` 早就在断言 exit 2 的消息格式，**它比我先处理了这个问题**
  - 新增的纯函数用例在任何网络状态下都能跑，**不把门禁可用性绑在网络上**

- **保护发布的那道门禁，自己没有任何门禁保护**
  - `upstream-sync.yml` 有一道「合并后必须通过才允许提交」，它握着
    `contents: write` + `git push main` + `git push origin <tag>` —— 直接发布
  - 而 `ci-alignment.mjs` 当时**硬编码只读 `verify.yml`**，全仓 grep
    `upstream-sync` 零引用。**删掉那道门禁整步，全链仍 exit 0**

- **`npm test --if-present` 被当成「门禁存在」（我独立验时抓到的漏洞）**
  - 把 `upstream-sync` 的 `npm test` 改成 `npm test --if-present`，
    `ci-align` 仍报「齐全」—— 而那后面就是 `push main` + `push tag`
  - 根因：正则 `npm test(\s|$)` 匹配了**字面量**，没匹配**语义**。
    而 `--if-present` 的语义恰恰是「不存在就跳过」= 没有这道门禁
  - 与「扫全文没区分注释与命令」是同族错误 —— 我在笔记里写过这个教训，
    又在同一道门禁里犯了一次

- **并行测试偶发红的根因：`core.autocrlf` 污染 `git diff` 输出**
  - 症状：并行下 `notes-coverage` / `notes-supersession` 偶发文件级失败
    （`test failed` 没有具体断言 —— 因为崩在解析阶段，不是断言阶段）
  - 抓到的证据：输出里有 `warning: LF will be replaced by CRLF`，
    本机 `core.autocrlf=true`，而测试建的临时仓库**继承了它**
  - 链条：并行 → git 对同一批文件做 stat 检查互相失效 → warning 混进
    `git diff` stdout → 解析失败
  - 修法：给两个测试的临时仓库加 `core.autocrlf=false`
  - 验证：**修前 4 轮红 1 次 → 修后 8 轮全绿**
  - 这不是为本机绕过：CI 是 ubuntu（autocrlf 本就 false），
    加上它是让所有平台看到同一份 diff

- **「零依赖」是自设的枷锁，却被当成否决理由用了 6 次 —— 全部纠正**
  - Owner 第二次指出这个问题。扫描发现 6 处判定用「零依赖 / 引依赖」否决方案，
    横跨 5 篇笔记。最能说明问题的一处写着「`devDependencies` 都是 `{}`」——
    **而那个依赖正是 Owner 同意引入的**
  - 错误的链条是：Owner 说「可以引依赖」→ 我引入了 spdx-expression-parse
    （正确）→ **但我同时给自己造了一条新规矩**「零依赖现在指零运行时依赖」
    → 然后用这条新规矩否决了后续 6 个方案。一次授权被翻译成了新的枷锁
  - 正确判据不是「要不要引依赖」，而是「**值不值得它的成本**」。
    依赖只在开发与 CI 时存在，不进用户的安装树
  - 逐条重判后：**2 处结论翻转成「该做」**（mdast 链接检测、
    渲染探针进 npm test），**4 处结论不变但理由全部换掉** ——
    理由错比结论错更危险：结论会过期，而理由会被当成判据继续套用
  - 最该做的是渲染验证：8 个浏览器探针**全靠人工跑**（且硬编码了本机
    Chrome 路径），而 Owner 的硬约束是「界面改动必须真机所见」。
    已实测可行性：`puppeteer-core` 25 包 / 4 秒装完，能启动 Chrome 155.0.8059.82，
    且**不必重写探针** —— 只需抽一个共享的「找浏览器」模块
  - 本批只改**理由**，不实现那两项（它们各有独立的笔记与验证）

- **归档必然断链，且事后无法修 —— 死锁**
  - 归档把 `implemented/<class>/x.md` 移到 `archived/<class>/x.md`，深度不变
    只换 lifecycle 段。所以 `../bug-fix/y.md` 归档后会解析成
    `archived/bug-fix/y.md`，而 `y.md` 还在 `implemented/`
  - 实测规模：待归档笔记的出向链接 **63 条里 60 条（95%）会断**，
    涉及 33/41 篇笔记
  - 而 `--write` **救不了**：读源码确认它只封**未封**的，
    已封的改了就报 `seal mismatch: frozen notes must never change`
  - 于是形成死锁：归档后必然断链，但断了不能改归档文件

- **上游比对核查收尾：42 道 verify 全部判定，8 个方向证据链完整**
  - 判定结果：**5 已实现 + 1 部分实现 + 6 有理由不适用 + 30 结构性不适用 = 42**
  - 结构性不适用的都是读本仓库没有的路径（`packages/`、`cordis.yml`、
    `.d.ts`、VitePress 站点等）
  - 顺带厘清一个长期歧义：本仓库有**两个**上游 —— 比对对象是
    `deepseek-ai/deepseek-harness`（方法论发源地），而 `skills/agent-notes/`
    的 vendored 来源是 `czm15053/write-notes-like-deepseek`。
    而 `dsh-tauri/dependencies/` 只是**本机 DSH 的安装位置**，不是比对对象
  - 分类表我填错过两次（`md-links` 重复计数、`agent-note-tree` 混入），
    都被「每项恰好一类 + 合计等于真实总数」的脚本断言抓出 ——
    表格看起来整齐、数字能凑对，不代表分类对
  - 6 项明确接受的缺口已列在笔记里，各带重访信号

- **核查实机证据链与 `check:full`：可用，接线正确（无代码改动）**
  - `npm run evidence` 用**真实 DSH** 的 SkillRegistry/ToolRuntime/CommandRuntime
    验 10 项契约（注册、list、source: bundled、模型可调用、正文剥离 frontmatter
    等），本机实跑 exit 0
  - 无 DSH 时 exit **2**（「无法进行」而非「通过」），并说明怎么修 —— 不是假绿
  - `check:full`（check 12 步 + 实机证据）端到端跑通
  - 接线是对的，不改：实机证据依赖具体 DSH 版本，进 CI 会让「DSH 升级」与
    「插件坏了」混为一谈；而进 `check` 会破坏它「纯本地不需 DSH」的核心承诺
  - 顺带确认：「探测不到本机 DSH」是**有意取舍**（源码注释明写不硬编码本机
    路径），不是覆盖不足 —— 容易被误认为 bug 去「修」
  - 已知缺口：实机证据仍不在任何自动门禁里，「宿主契约有没有漂移」只在有人
    主动跑 check:full 时才有答案。短期无低成本解法（需装了 DSH 的 CI）

- **核查客户端 bundle 同步与归档路径：两条都可用（无代码改动）**
  - 客户端 bundle：真改 `src/client.js` 函数体、不 build、跑 `verify-plugin.mjs`
    —— 两种注入都被正确拦下，报错明确指向 `npm run build`
  - 归档路径：在临时仓库真归档一篇 —— 文件移动、封印生成、格式重写
    （加 `Archived: 日期`）、门禁验证（`1 archived note(s) verified`）全部正确
  - 归档数一直是 0 只是因为还没有需要归档的笔记，**不是机制坏了**
  - 两条都**没有**固化成常驻测试（成本不对称，且均未退化过），重访信号已记

- **上游 verify 清单的分母算错了：真实 42，此前一直按 65 数**
  - 此前的 65 来自上游 `package.json` 的 **npm script 名**，按名字里含
    `verify-` 的数量数的。抽查发现 `verify-third-party-notices` 与
    `verify-cli-help` **都不存在**（HTTP 404）
  - 按 `scripts/verify-*.ts` 真实文件路径重数：**42 个**。于是
    「已核查 6 项」的进度是假的 —— 分母错了 23，而实际未判定的是 32 个
  - 后果不止数字：错误的进度会让人**过早宣布「查完了」**
  - 判据改为解析真实文件路径（`/scripts\/(verify-[a-z-]+\.ts)/g`），
    不数 script 名 —— 后者会同时产生幽灵项与漏项
  - 32 个未判定项已全部判定：24 个结构性不适用（读 `packages/`、
    `cordis.yml`、`.d.ts` 等本仓库没有的路径），8 个逐个核过
  - 其中确认 `doc-budgets` **已实现**（就是本仓库的 `doc-budget.mjs`）、
    `translation-pairing` 已部分实现（比结构，不补逐节哈希）

- **`lib/skill.js` 的 `createSkillProvider` 漏了 `@param`**
  - 92 个导出里唯一一处 JSDoc 不完整（其余 91 个都有完整的 `@param`/`@returns`）
  - 是逐项核查上游 `verify-export-jsdoc` 时人工发现的，**不是门禁发现的**
  - 该门禁本身不采纳：覆盖率已 91/92，而要正确实现需 TypeScript 解析器 ——
    手写近似会在两个方向都错（误报 void 函数、漏报空壳注释），
    那是假绿的经典形态。详见 rejected/architecture 那篇

- **`.githooks/commit-msg` 与源漂移，且漂移的那行本身是坏的**
  - 上一轮把钩子正文抽到 `tools/hook-body.mjs`，收尾时改了源里一行，
    但**没有重新生成 `.githooks/commit-msg`**，并把它一起合进了 main
  - 那行 `node tools/docs:bilingual 2>/dev/null || ...` 是错的 ——
    `docs:bilingual` 是 npm script 名，不是文件路径。于是**合并进 main 的
    钩子第三道门禁是坏的**，而 `2>/dev/null` 把错误静默吞掉了
  - 更隐蔽：`hook-body.test.mjs` 的 11 条测试**读源**、全部通过，
    而实际执行的是旧副本。门禁测的是源，跑的是生成物
  - 修：重新生成钩子 + 新增一条测试「已安装文件必须逐字节等于 HOOK_BODY」
    （比较前归一化行尾，否则 Windows 上会因 CRLF/LF 差异假红）
  - 故障注入三条全部符合预期：基线绿 → 改回旧写法红 → 删掉一道红 → 还原绿

- **五道门禁只接进了本地 `check` 链，CI 一道都没跑**
  - 连续三轮加了 `notices:check` / `md:links` / `docs:bilingual` /
    `text:integrity` / `release:check`，全部只进本地链
  - 后果：那五道红过时 CI 毫无反应 —— 本地成了唯一防线，而本地会被人
    `--no-verify`、也会忘记跑。**门禁存在但没人执行它，等于没有门禁**
  - 已全部接入 CI 的 verify job（逐个列出而非一句 `npm run check`：
    拆开是为了哪一步变红在日志里一目了然，而 range 型门禁要用
    `event.before..HEAD` 更准的范围）

- **字符完整性门禁一直有效，但从「靠记性触发」变成「提交即跑」**
  - 核查数据：门禁上线后 **2 个提交里没有一个把乱码带进历史** —— 它每次都
    正确报红，只是**提交前没人跑它**
  - 而我自己在这几轮里反复写出乱码（至少 5 次），每次都靠事后手改
  - 所以真实缺陷不是「门禁漏了」，是「门禁靠记得跑触发」，而记得跑在
    「紧急修个 CI 问题」的场景里必然被挤掉

- **`md-links` 遇到指向目录的链接会整个崩掉**
  - `[见说明](docs/)` 这类写法让 `readFileSync` 抛 `EISDIR`，门禁直接崩
    —— 不是报告问题，是自己挂了
  - 崩溃时退出码非 0，看起来像「门禁红了」，实际是「门禁没能运行」。
    红的含义必须清楚，这是本仓库最忌讳的形态
  - 现在明确报「链接指向目录而非文件」，并给出怎么改（写全文件名）。
    新增测试覆盖「目录」「目录+尾斜杠」「./ 前缀目录」「图片指向目录」四种形态

- **两版 README 的归属声明指向了一个不存在的地方**
  - 原文两版都写「见 `skills/agent-notes/` 内注释与上游仓库」，但那个目录里
    **没有任何版权声明**（唯一含 MIT 的是看板 UI 的一句文案，那不是归属声明）
  - 真正的归属声明在 `THIRD_PARTY_NOTICES.md` —— 它存在、有校验门禁，
    但两版 README 都没指过去。于是 MIT 要求的「保留原版权与许可声明」
    在分发物里没有入口，而读者被指向一个不存在的地方
  - 已修：两版都改为指向真实文件（同时补齐中英，结构保持对应）

- **十脚本跨仓库能力核查：9/10 站得住**
  - 把 `tools/` 下每个门禁脚本拷进临时 git 仓库真跑一遍，按
    「可用 / 明确报错 / 崩溃」三档归类
  - 唯一崩溃的 `notices.mjs` **不该**被拷到别处（README 与 AGENTS.md 都没这个
    承诺），所以不算违背承诺 —— 不为凑数字给它加依赖降级
  - 关键设计：区分「明确报错」与「崩溃」。前者是正确行为，后者是缺陷，
    两者退出码都非 0，光看退出码分不出来

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
