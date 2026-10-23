# Agent Note: 散落在笔记根的笔记是不可见的 —— 补上笔记根这一层的形状校验

Status: implemented

> 承接[门禁的语料不得被悄悄收窄](../process/2026-10-22-gate-corpus-must-not-narrow.md)
> 与[三道 vendored 门禁在空集合上是绿的](../testing/2026-10-22-vendored-gates-are-vacuous-on-empty-tree.md)：
> 那两篇管的是「门禁还在跑，但语料被改小了」与「门禁什么也没查却报通过」。
> 本篇管第三种：**门禁照常跑、语料照常有，但它压根看不见某一部分笔记**。

## Problem

三条 vendored 门禁（`skills/agent-notes/scripts/verify-agent-note-tree.ts`、
`verify-agent-note-format.ts`、`verify-archived-agent-notes.ts`）都是**按
`{lifecycle}/{class}/` 形状枚举**来找笔记的。vendored 的枚举逻辑在
`skills/agent-notes/scripts/agent-note-tree.ts:52-73`：它只遍历 `proposed`、
`implemented`、`rejected` 三个 lifecycle 目录下的六个 class 目录。

于是**落在这些枚举路径之外的东西是隐形的**。实测（真实临时仓库 + 真实
`runGate`，三种门禁各跑一遍）：

| 笔记根下的东西 | tree | format | archived | 门禁报告的笔记数 |
|---|---|---|---|---|
| 根层散落一篇 `stray.md`（树里零篇生命周期笔记） | 绿 exit 0 | 绿 exit 0 | 绿 exit 0 | `ok: 0 note(s)` |
| 根层散落一篇 `stray.md`（树里另有一篇合规笔记） | 绿 exit 0 | 绿 exit 0 | 绿 exit 0 | `ok: 1 note(s)` |

这份「隐形」不是「多了一个文件」那么轻的代价：

- 它**不被判定为已归档** —— 不在 `archived/` 下，就不是封印对象；
- 它**不被判定为格式违规** —— 不在任何 lifecycle 枚举里，格式门禁看不到它；
- 它**不进 vendored 的 `ok: N note(s)` 计数** —— 于是「磁盘上的 `.md` 数」与
  「门禁报告的笔记数」对不上，而**没有任何门禁会指出这一点**。

换句话说：一份笔记可以完全绕开这套方法的管理 —— 既不会被归档，也不会被判
违规，团队也不会知道它存在。`runAllGates` 的 `noteCount`（`inspectTree`，
当时在 `lib/notes.js:838`，现为 `:924`）把它算进文件数，于是连汇总层的数字
都对不上门禁的输出。（2026-10-23 已改：只数生命周期目录里的，见 Consequences 第 2 条。）

同时，形状校验缺失还让「未知目录」这一类完全无人管：vendored 的
`agent-note-tree.ts:48-50` 只在「树里已经有笔记」时才会走到那段枚举，
所以一棵**只有**未知目录的笔记树，报出来的是「有树零篇」而不是「目录不对」。

## Decision

插件新增自有模块 `lib/notes-layout.js`，判据落在 `lib/notes.js` 的
`runGate` 里 —— 位置在「没有可验对象不算通过」那一整套之后
（`lib/notes.js:627` 的 `NO_NOTES_YET` 之后，`lib/notes.js:646` 调用
`checkNotesLayout`），命中即返回 `reason: NOTES_LAYOUT: 笔记根不合规（N 项）`、
`exitCode: 1`，诊断走 stderr 且每行带 `notes: ` 前缀。

`lib/notes-layout.js` 的判据是**笔记根这一层**允许出现哪些路径项：

- 四个 lifecycle 目录：`implemented` / `proposed` / `rejected` / `archived`；
- 根层说明文件：任意 `*.md`；
- 归档封印清单：`manifest.json`。

其余任何目录或文件判失败。笔记根**不存在**时返回空错误 ——
那是 `NO_NOTES_TREE` 的真相，不该出现第二个判据抢同一个事实。

`lib/notes-layout.js` 只管笔记根这一层；`archived/` **里面**的形状
（分类目录、文件名日期、日历真实性、封印 schema、旁挂 `.zh.md` 必须被封印）
由 `lib/archive-layout.js` 管，两者互不重叠。归档区那部分的缺口与取舍写在
[归档树布局原本没有任何门禁](./2026-10-22-archive-layout-has-no-gate.md)。

### 刻意保留的一处放行

根层**任意** `*.md` 被放行，不只是 `AGENTS.md` 与 `CLAUDE.md`。理由是
上游 A 的笔记根就放着 `AGENTS.md`（vendored 的 `agent-note-tree.ts:31`
那个 `ROOT_ALLOWLIST` 是 lifecycle 目录**内**根层说明文件的白名单，
不是笔记根这一层的）；禁掉根层的 `*.md` 会让「在笔记根放一份说明」变成
必须改 vendored 才能做的事。

代价必须说清，而且它就是本篇开头那张表的**第一行**：根层的一篇 `.md`
**仍然不可见** —— 它不会被归档、不会被判格式违规、不计入 vendored 的
`ok: N note(s)` 计数。根层是「说明区」，不是「笔记区」；真要把一份文档变成
笔记，它必须放进 `{lifecycle}/{class}/`。

这条取舍是**插件侧的选择**，不是上游的判据，所以它没有上游那层兜底：
vendored 的 `agent-note-tree.ts:44-47` 只对 `INDEX.md` 判红，其余根层
`*.md` 无人过问。本篇如实记下这个残留缺口（见 Consequences），
并用回归把它钉住 —— 钉的是**当前契约**（放行），不是「散落即错」。

## Alternatives considered

- **把 vendored 的 `agent-note-tree.ts` 改成递归枚举整个笔记根**：
  一次性解决「根层散落看不见」与「未知目录看不见」两个问题，判据最彻底，
  逻辑集中在一处。但会破坏受管内容哈希 —— `tools/verify-plugin.mjs` 的
  逐文件哈希比对会立刻拦下，且 `tools/sync-upstream.mjs` 下次同步会把手改
  冲掉，等于每次同步都要重打一遍补丁。这与 AGENTS.md 硬约束 3 冲突。
  被否，改为在插件自有 `lib/` 里补判据。
- **把形状校验做成一道独立的门禁脚本（如 `tools/notes-layout.mjs`）**：
  与 `lib/notes.js` 分离、职责清晰，任何人单独跑都能验。但笔记根的解析口径
  会与 `lib/notes.js` 的 `resolveNotesRoot` 分叉（配置项、`$AGENT_NOTE_ROOT`、
  仓库根探测三处），失败信息也要分两个文件输出，容易出现「两边看到的不是
  同一棵树」。被否，改为 `lib/notes.js` 内的一段前置校验，失败直接并入
  同一次门禁输出。
- **只补「未知目录」这一条**：改动最小，且能挡住最容易犯的错（把笔记放错
  一层）。但笔记根的形状问题不止目录 —— 根层放一个 `notes.txt`、
  `notes.json` 同样完全无人管，它们比散落的 `.md` 更危险（散落的 `.md`
  至少是「看起来像笔记」的东西，容易被注意到）。被否，整类一起补，
  每一类都有对应回归。
- **把根层 `*.md` 收紧成白名单（只允许 `AGENTS.md` / `CLAUDE.md` /
  `README.md`）**：这样「散落的笔记」会被真拦下，本篇开头那张表的第一行
  也就消失了。它是**最强**的备选 —— 直接把本篇要修的那个洞堵死。代价是
  插件侧从此要维护一份「根层允许哪些说明文件」的白名单，而白名单会随
  「有人在笔记根放一份新说明」的需求增长；更要紧的是它会与上游
  `agent-note-tree.ts:31` 的 `ROOT_ALLOWLIST` 形成**两套不同口径**
  （上游允许 `AGENTS.md`/`CLAUDE.md`，插件再允许 `README.md`），两份
  清单互不知情 —— 而「两份白名单互不知情」已经是本仓库登记在案的已知缺口
  之一。权衡后**故意不收紧**：根层是说明区，让它宽松比让它精确更不容易
  误伤真人；但把「根层 `.md` 仍然不可见」这个残留明确记下来，交给
  将来决定，而不是在一次补门禁里顺手改掉一条语义。
- **把形状校验放到 `NO_NOTES_YET` 之前**：这样「树里只有散落文件」时
  报的是「目录不对」而不是「有树零篇」，诊断更贴近真相。代价是
  `NO_NOTES_YET` 判据的语义（「零篇笔记」）会被形状问题抢走 —— 一个既
  零篇又形状坏掉的树只能看到一个真相，另一个被掩盖。保持现状：形状校验
  在后，零篇先报零篇；形状坏了且有笔记时才报形状。

## Consequences

收益是两类原本静默通过的笔记树现在会红：**笔记根下的未知目录**与
**笔记根下的非 `.md`/非 `manifest.json` 文件**（`.txt` / `.json` / `.yml` …），
命中即 `NOTES_LAYOUT` 判红，且诊断逐条列出「是什么」与「为什么算错」
（「散落的目录既不会被归档、也不会被判违规，还不会计入笔记数」、
「其它文件放在这里不会被任何门禁看见」）。`notes:gate` 复用同一条路径，
所以它一道就够。

代价有四条，都要说清：

1. **根层 `.md` 仍然不可见**（本篇开头那张表的第一行）。这是有意的取舍，
   但它意味着「散落一篇笔记到笔记根」这个动作**依然不会被拦下** ——
   只有「散落到根层且不是 `.md`」与「散落成目录」会被拦。回归用例
   `notes-layout: 根层散落的 .md 不算笔记，零篇不许当通过（契约已收紧）`
   钉的是**收紧后的边界**：散落件仍不被 vendored 枚举，但它不算笔记，
   所以「整棵树只有它」会被零篇判据拦下。**别把它读成「散落件被拦住了」**：
   实测「1 篇合规笔记 + 1 篇根层散落 `.md`」仍然 `passed: true`、
   `ok: 1 note(s)`，多出来的那篇继续完全隐形。
2. **根层 `.md` 与门禁的笔记数对不上 —— 已在 2026-10-23 修掉**。原先
   `inspectTree` 把它算进 `runAllGates` 的 `noteCount`，vendored 的
   `ok: N note(s)` 不算它，两处数字各说各话；更糟的是「零篇」判据用的是
   `files.length`（含散落件），实测**只放一个根层 `.md`**，三道门禁全部
   `ok: 0 note(s)` 且 exit 0、`runAll` 报 `passed: true` —— 零篇被冒充成通过。
   现在 `inspectTree` 分出 `noteFiles`（生命周期目录里的）与 `strayFiles`；
   零篇判据改用 `noteFiles`；`runAllGates` 多返回 `strayCount`，
   `tools/verify-notes.mjs` 有散落件时明确打一行「另有 N 个 .md …不会校验」。
   回归 `no-fake-green: 只根层散落一个 .md：零篇笔记，不许当通过`；
   变异（判据换回 `files.length` / 分类判据恒真）各自 5 pass / 1 fail。
   同一口径也落到工具层：`lib/tools.js` 的 `agent_notes_gate` 原先把
   `inspect().files.length` 当 `noteCount`，散落件会让它报「1 篇」而
   `passed: false`，两个信号自相矛盾；现在只数 `noteFiles`，另返回
   `strayCount`。回归 `plugin-tools: 只有根层散落 .md 时 noteCount 报 0…`
   （变异 `noteFiles → files` 后该文件 7 pass / 1 fail）。
   仍然没做的是：**散落件本身不会被拦下**（第 1 条那条取舍没变）。
3. **`NO_NOTES_YET` 在形状校验之前**（`lib/notes.js:627` vs `:646`）。
   所以一棵**只有**未知目录、零篇生命周期笔记的树报的是「有树零篇」，
   不是「目录不对」。这不是 bug，是上面那条取舍的副作用：零篇先报零篇。
4. **符号链接等既非目录又非文件的路径项被静默跳过**
   （`lib/notes-layout.js:113`）。实测 `readdirSync(withFileTypes)` 对符号
   链接返回 `isFile() === false && isDirectory() === false`，于是落到
   `continue` 分支。Windows 上创建符号链接需要管理员权限或开发者模式，
   本仓库不做断言 —— 这是已知边界，不是已验证的通过。

另外两条与「未知目录」有关的分工：vendored 的 `agent-note-tree.ts:48-50`
**自己就判红**未知 lifecycle 目录（当树里已经有笔记时），所以「未知目录」
实际有两道机制拦；`INDEX.md` 反而只有 vendored 那一道拦
（插件侧因它以 `.md` 结尾而放行）。两道机制并存不冲突 ——
同一个文件被一道判据拦下就够了。

## Verification

`node --test tools/notes-layout.test.mjs` → **19 tests / 19 pass / 0 fail**，
退出码 0（duration 2496.9ms）。（2026-10-23 修零篇判据时该文件已长到
30 tests / 30 pass；下面列的是最初那批 19 条的构成。）

回归覆盖 19 条情形：8 条负例（未知目录、未知目录再套一层、`.txt`、
`.json`、`.yml` 四类文件、以及「错误信息要点明散落/不会被看见」「多个违规
项一次全报」）+ 5 条正例与对照（四 lifecycle + 根层 `AGENTS.md` +
`README.md` + `manifest.json` 必须通过、`archived/manifest.json` 与
`archived/` 子目录不误伤、笔记根不存在返回空错误、允许集合本身、
合规树端到端真绿）+ 3 条端到端（`runGate('tree')` 在未知目录上红且
`reason` 以 `NOTES_LAYOUT` 开头、在根层 `.txt` 上同上、笔记根不存在时
`reason` 必须是 `NO_NOTES_TREE` 而不是 `NOTES_LAYOUT`）+ 2 条「有意
不覆盖」的如实钉住（根层 `*.md` 被放行；散落的 `.md` 不算笔记 ——
2026-10-23 由「三道门禁下都不可见」收紧为「整棵树只有它时判红」）
+ 1 条 `INDEX.md` 两道机制并存。

**故障注入（三次，每次还原后复跑全绿；全部在 `.probe/probe-gaps/gc-sandbox/`
的 `git clone --no-hardlinks` 副本里做，真实仓库零变异）**：

1. 把 `lib/notes-layout.js` 的 `!NOTE_ROOT_LIFECYCLES.includes(name)` 换成
   `false`（于是 `!false` 恒真，判红失效）→ **19 tests / 14 pass / 5 fail**，
   红的正是那 5 条依赖「未知目录要判红」的用例（表驱动负例 2 条、错误信息
   2 条、多项全报 1 条、`runGate` 端到端 1 条）；还原后 19/19。
2. 把 `lib/notes-layout.js` 的 `NOTE_ROOT_LIFECYCLES.includes(name)` 换成
   `false`（lead 字面描述的变体；语义与第 1 条相反：`!false` 恒真 ⇒ **任何**
   目录都被判成未知目录）→ **19 tests / 6 pass / 13 fail**，红的包含
   「四个 lifecycle + 说明文件 + manifest.json 必须通过」与「合规树必须
   真绿」这两条正例 —— 正例同样能抓住判据写反；还原后 19/19。
3. 把 `lib/notes.js` 的 `const layout = checkNotesLayout({ notesRoot });` 换成
   `const layout = { errors: [] };`（整条前置校验失效）→ **19 tests /
   17 pass / 2 fail**，红的正是两条 `runGate` 端到端用例（纯函数层仍绿，
   因为校验根本没被调用）；还原后 19/19。

三次注入都用 `readFileSync`/`writeFileSync` 走 **Buffer** 字节级写回
（不用 Python —— Windows 上它会把 LF 翻成 CRLF）。还原后逐字核对：
`RESTORE_BYTE_IDENTICAL=true` 且 `cmp` 与仓库里的 `lib/notes-layout.js` /
`lib/notes.js` 无差异，md5 与还原前一致（`6a897aebceecff608e804688e398b34b`
/ `e203817e2515c60dfc6aa5aa33c395bb`），复跑 19/19 全绿。

注入脚本本身踩过一个坑，值得记下来：v1 的 `restore` 模式在开头又执行了一次
「备份」，于是备份被**变异后的文件**覆盖，「还原」等于什么都没还原，而它
打印的 `RESTORE_BYTE_IDENTICAL=true` 是拿变异体与自己比 —— 恒真的假信号。
v2 把备份与还原拆成互斥分支，还原后与**仓库里的原文件**逐字比较才作数。
这类「自己跟自己比」的断言，比没有断言更危险：它让一次失败的注入看起来是
成功的。

真实仓库侧：`lib/notes-layout.js`（5140 字节，md5 `6a897aebceecff608e804688e398b34b`）
与 `lib/notes.js`（38016 字节，md5 `e203817e2515c60dfc6aa5aa33c395bb`）
在全部实验后逐字未变。本篇的回归文件 `tools/notes-layout.test.mjs` 是新增
文件，未提交。
