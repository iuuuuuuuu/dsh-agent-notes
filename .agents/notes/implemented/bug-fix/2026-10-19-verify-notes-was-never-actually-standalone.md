# Agent Note: verify-notes 说「任意仓库可用」，实际四种用法全崩

Status: implemented

> 同属**流程补齐**这条线，且直接推翻了一处既有承诺。
> 原承诺写在 `tools/standalone.test.mjs` 的注释里（「本脚本要能在任何仓库里
> 用 —— 那是脱离 DSH 也能用的前提」），实测不成立。
> 相关的浏览器端分层见
> [2026-10-19-logic-in-node-rendering-in-chrome.md](../testing/2026-10-19-logic-in-node-rendering-in-chrome.md)，
> 测试并行纪律见
> [2026-10-19-parallel-tests-must-not-share-real-trees.md](../testing/2026-10-19-parallel-tests-must-not-share-real-trees.md)。

Independent: 本篇处理的是**笔记门禁外壳的跨仓库可用性**，与门禁判据本身
（tree/format/archived 验什么）、覆盖率、文档同步是不同的失效面。

## Problem

`tools/verify-notes.mjs` 是笔记门禁的 CLI 外壳 —— README 明确告诉用户：

> 要么直接复用本仓库的 `tools/verify-notes.mjs`

而它的代码注释里写着：

> 本脚本要能在**任何仓库**里用 —— 那是「脱离 DSH 也能用」的前提。

**这两句都是假的。** 实测四种独立用法：

| 场景 | 结果 |
|---|---|
| A. 只拷 `tools/verify-notes.mjs` | `ERR_MODULE_NOT_FOUND` |
| B. 拷 `tools/` + `lib/` | 三条门禁全报「脚本缺失」 |
| C. 独立仓库自带 `.agents/skills/<技能名>/scripts` | **同样全报「脚本缺失」** |
| D. 只拷脚本 + 仓库自带技能脚本 | `ERR_MODULE_NOT_FOUND` |

两个独立缺陷：

**一、静态 import 让它无法被单独拷走。**
`import { runAllGates } from '../lib/notes.js'` 是静态的，找不到就崩。

**二、更根本的：它只在自己包里找门禁脚本。**
`SCRIPTS_DIR` 写死为本包的 `skills/agent-notes/scripts`。而按 skill 模板，
**独立仓库的脚本在 `.agents/skills/<技能名>/scripts`** —— 脚本就在眼前，
它却完全看不见（场景 C）。

### 为什么一直没被发现

`tools/standalone.test.mjs` 里有一条测试「门禁脚本只依赖 Node 内置模块」，
它检查三个脚本：`notes-coverage` / `notes-supersession` / `doc-budget`。

**`verify-notes.mjs` 不在那三个里** —— 而它恰恰是唯一 import `../lib/` 的那个。

而且就算把它加进去，静态检查也抓不到场景 C：那需要**真的在别的仓库里
跑一遍**，而没人做这件事。

## Decision

### 一、脚本定位改为多来源，按优先级

新增 `lib/notes.js` 的 `scriptsDirCandidates(cwd)`：

1. `$AGENT_NOTE_SCRIPTS_DIR` —— 显式指定，永不猜
2. 本包的 `skills/agent-notes/scripts` —— 本仓库的正常路径
3. **目标仓库 `.agents/skills/` 下各技能的 `scripts`** —— 别的仓库用这条

以「里面有没有门禁脚本」为准，而不是猜技能名。

### 二、静态 import 改为动态加载 + 明确降级

`loadGateRunner()` 先找 `../lib/notes.js`，再找 `$DSH_AGENT_NOTES_LIB`；
都没有就**明确报错并列出该拷哪些文件**，退出码 **2**（「无法进行」，
与「检查不通过」的 1 区分开 —— 与 `sync-upstream` 的约定一致）。

`must`：**不内联复制 `runAllGates`**。`lib/notes.js` 是「没有可验对象不算
通过」的唯一真源；复制一份会立刻产生第二份真相，而漂移的表现正是
「一种入口拦住了、另一种没拦住」—— 正是本脚本存在要防的那类假绿。

`must`：**不提供「只拷外壳也能跑」的降级路径**。少跑的那几条检查正是
「空集合冒充通过」的拦截器，降级等于把问题换回来。所以是把「怎么做」说清楚，
而不是让它安静地少验几项。

### 三、错误信息要能指导排查

「门禁脚本缺失」现在会列出**找过哪些目录**。独立仓库里最常见的情形是
「脚本在技能目录下但名字对不上」，只报一个拼出来的路径会让人以为是文件
真不存在。

候选目录全不存在时**不留空行** —— 「一个都没找到」本身就是最该告诉人的信息。

## Alternatives considered

- **把 `runAllGates` 内联进 `verify-notes.mjs`** — 单文件、随便拷。否掉，因为那正是本脚本顶部注释警告的「第二份真相」。而这类漂移的表现最恶劣：两处判定随时间分叉，**一种入口拦住、另一种没拦住**，没人发现哪边对。
- **让 `verify-notes.mjs` 改成 shell 脚本** — 没有 import 问题。否掉因为它已经承载了 `--root`、退出码映射、`NO_NOTES_TREE` 诊断等逻辑，改写等于重写；而跨平台 shell 差异会引入新的一类问题。
- **只在 README 里改掉那句承诺（说明要连 `lib/` 一起拷）** — 零代码。**否掉，因为这是本条最弱的做法**：承诺是真的做到了，只是没做到自己说的那样。用户照文档做就会撞墙，而「文档说了要拷三样东西」远不如「脚本在正确的仓库里能自己找到」。
- **把 `verify-notes.mjs` 也加进 `standalone.test.mjs` 的依赖检查清单** — 只加一行。否掉是因为那条检查是**静态**的（grep 有没有 import `../lib/`），抓不到场景 C —— 「脚本就在眼前却看不见」只有真跑才看得见。所以单独建了一份真跑的测试。
- **让 `scriptsDirCandidates` 猜技能名（如固定找 `write-notes-like-deepseek`）** — 少一次目录遍历。否掉因为技能名会变（上游改名过一次），而「里面有没有门禁脚本」是稳定的判据。

## Consequences

- **收益**：兑现了两处此前只是「写在注释和 README 里」的承诺。场景 C 从失败变成通过，且**验的是目标仓库自己的笔记**（断言输出里「共 1 篇笔记」—— 不是本插件的 32 篇）。
- **收益**：场景 A/D 从「一堆未捕获异常堆栈」变成「exit 2 + 该拷哪两个目录 + 两个环境变量名」。
- **收益**：「脚本缺失」现在能自查 —— 列出找过哪些目录、期望的文件名、可以用哪个变量指定。
- **收益**：新增 `tools/verify-notes-standalone.test.mjs`（7 个用例），**全部真跑**：真建 git 仓库、真拷文件、真执行。**8/8 故障注入全部符合预期**，其中两条是原始缺陷的还原（「只查本包目录」「恢复静态 import」）。
- **代价与已知上限**：场景 A/D（只拷一个外壳文件）**仍然跑不了**，只是从崩溃变成明确报错。这是**有意接受**的 —— 一个 CLI 外壳没有实现就本该跑不了门禁，而我们做的是让它说清楚该带什么过去，而不是伪造一个「能跑」的假象。
- **代价与已知上限**：`scriptsDirCandidates` 会遍历目标仓库 `.agents/skills/` 下的每个技能目录。有技能目录越多开销越大 —— 实测是毫秒级，且只在门禁启动时做一次。
- **代价与已知上限**：多来源查找引入了一个**新失败面**：若目标仓库恰好有个名字相同的门禁脚本但版本与本插件不配，可能验错版本。缓解办法是优先级把本包排在前面（只在找不到时才用目标仓库的），但这**不能完全排除** —— 若本包目录被删掉而目标仓库有旧版脚本，会验那个旧版。记在重访信号里。
- **重访信号**：若 `lib/notes.js` 未来新增本包之外的运行时依赖（如某个 npm 包），场景 A/D 会从「exit 2 明确报错」退回「加载失败」—— 那时 `loadGateRunner` 需要区分「文件不在」与「文件在但依赖缺失」两种失败，并给出不同的指引。另一个信号：若目标仓库开始把笔记门禁脚本放在 `.agents/skills/` 之外的位置（例如只用 skill 不落盘），第 3 路候选要跟着调整。

## Verification

```sh
node --test tools/verify-notes-standalone.test.mjs   # 7 个用例
npm run notes:gate                                    # 本仓库不受影响
```

四场景探针（`.probe/tmp/verify-standalone.mjs`，按本仓库约定不入库）：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| A 只拷脚本 | import 崩溃栈 | exit 2 + 可操作指引 |
| B 拷 tools/+lib/ | 「脚本缺失」无指引 | 「脚本缺失」列出已查找目录 |
| C 仓库自带技能脚本 | **失败** | **通过**（且验的是目标仓库的 1 篇笔记） |
| D 只拷脚本 + 仓库带脚本 | import 崩溃栈 | exit 2 + 可操作指引 |

故障注入（已实测，8/8 全部符合预期）：只查本包目录（原始缺陷）、
不扫描目标仓库 `.agents/skills`、忽略 `$AGENT_NOTE_SCRIPTS_DIR`、
不列已查找目录、已查找留空行、恢复静态 import（原始缺陷）、
抛未捕获异常不给指引、退出码 1 而非 2。

其中「退出码」那条初次注入时**仍全绿** —— 我只断言了「实现找不到时非 0」，
没锁定 `2`。补成 `assert.equal(result.code, 2)` 后才变红。