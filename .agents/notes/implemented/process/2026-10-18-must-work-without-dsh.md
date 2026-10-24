# Agent Note: 脱离 DSH 后，笔记功能必须仍然可用

Status: implemented

> 同域：本篇讲的是**可移植性**（能不能在别的仓库、别的 agent 工具下跑）。
> 功能本身的三层分工见
> [2026-10-18-notes-coverage-gate.md](2026-10-18-notes-coverage-gate.md)、
> [2026-10-18-notes-supersession-check.md](2026-10-18-notes-supersession-check.md)、
> [2026-10-18-doc-budget-gate.md](2026-10-18-doc-budget-gate.md)。
> 各层是否都装好了见
> [2026-10-18-three-layer-checks-must-align.md](2026-10-18-three-layer-checks-must-align.md)。

## Problem

Owner 的要求：**就算脱离 DSH、换别的 agent 工具（Claude Code / Codex 等），
笔记主要功能也要正常。**

这个要求暴露了一个此前从未验证过的假设：门禁脚本是不是只能验**自己所在的包**？

实测（把脚本拷到一个纯 Node 项目，完全没有 DSH）：

| 脚本 | 结果 |
|---|---|
| `notes-coverage.mjs` | ✅ 正常拦下「改代码不写笔记」 |
| `notes-supersession.mjs` | ✅ 正常要求「新笔记声明关系」 |
| `doc-budget.mjs` | ✅ 正确报「清单里的文件不存在」 |
| `verify-notes.mjs` | ❌ **仍然报告原仓库的 16 篇笔记** |

最后一行是真缺陷。`verify-notes.mjs` 用 `PACKAGE_ROOT`
（由 `import.meta.url` 推出）定位笔记根，于是脚本被拷到任何地方后，
它**永远去验原来那个仓库**。

### 这比报错危险得多

它退出码 0、输出「笔记门禁通过：3 条全部 exit=0，共 16 篇笔记」——
完全合理的样子。只是那些笔记跟当前仓库毫无关系。

**「在别的仓库里跑」这件事静默地没有发生**，而没有任何信号提示。

### 第二层缺陷：回退去验别处

第一版修法是「cwd 里有 `.agents/notes` 就验 cwd，否则回退 `PACKAGE_ROOT`」。
这更糟：在一个**没有笔记树**的仓库里跑，它会回退去验本插件的 16 篇，
报「通过」。**回退到别处比报错危险。**

## Decision

**① 判定「验哪个仓库」用 git 说了算，不用脚本位置。**

```js
const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd });
if (gitRoot.status === 0) return gitRoot.stdout.trim();   // cwd 是仓库根就是它
return PACKAGE_ROOT;                                      // cwd 完全不是仓库才回退
```

**must**：cwd 是 git 仓库根时**必须验它**，哪怕它没有笔记树 ——
那时由 `runAllGates` 报 `NO_NOTES_TREE`，而不是偷偷去验别处。

**must**：允许 `--root <path>` 显式指定，供 CI 或特殊布局使用。

**② 门禁脚本必须只依赖 Node 内置模块。**

实测确认：`notes-coverage.mjs`、`notes-supersession.mjs`、`doc-budget.mjs`
的 import 全部是 `node:child_process` / `node:fs` / `node:path` / `node:url`。
只有 `lib/index.js`（DSH 插件本体）与依赖它的
`integration.test.mjs` / `live-evidence.mjs` 才需要 DSH。

这条现在由测试锁住（扫源码，禁止 `@deepseek-ai` 与 `../lib/` 导入）。

## Alternatives considered

- **保持 `PACKAGE_ROOT`，只在文档里说明「本脚本只验本插件自己的笔记」** —
  零改动。否掉：那等于承认它不能跨仓库用，而「脱离 DSH 也能用」
  正是本次要保证的事。更关键的是它**静默验错对象**，
  文档说明改变不了这一点。
- **用 cwd 优先，找不到笔记树就回退脚本目录** — 这是第一版修法。否掉：
  在无笔记树的仓库里会回退去验本插件，报「通过 16 篇」。
  回退到别处比报错危险 —— 使用者以为验过了。
- **把门禁逻辑搬进一个独立的 npm 包**（`@xxx/agent-notes-gates`）—
  跨仓库使用最干净。否掉：本插件零依赖、单包发布，为一个脚本拆包
  会带来版本同步与安装成本。而 `node <路径>` 已经够用。
- **要求使用者 `cd` 到目标仓库再跑** — 不必改代码。否掉：
  实测正是「拷到别处跑」暴露的缺陷；而且 cwd 判断本身就要改，
  否掉这条并不能省掉改动。
- **用 `AGENT_NOTE_ROOT` 环境变量强制指定** — 已有该机制。否掉：
  要求每次调用都设环境变量，忘一次就回到验错对象。
  默认行为应该是对的，环境变量只作覆盖。

## Consequences

- **收益**：三道门禁（coverage / supersession / doc-budget）在**任意仓库**
  可用，不依赖 DSH、不需要 `package.json`、不需 tsx。实测在纯 Node 项目里
  四个场景全对。
- **收益**：`verify-notes.mjs` 第一次能验「当前仓库」，
  而且没有笔记树时明确报 `NO_NOTES_TREE`。
- **收益**：这条约束（只依赖 Node 内置模块）现在有测试锁住 ——
  以后有人加 `@deepseek-ai/*` 导入会立刻红。
- **收益**：门禁在**机器上根本没装 node / npm** 时也能跑。插件侧执行
  门禁用的是 `nodeExecutable()`（即 `process.execPath`，harness 自己的
  node），不走 PATH 查找；`tools/non-node-project.test.mjs` 把 `PATH`
  指向一个空目录来证明这点 —— 任何一处去 shell 里找 `node` / `npm`
  都会立刻红。
- **边界**：这条保证只覆盖**插件服务路径**（`runAllGates` / `runGate`
  经 `lib/notes.js` 调脚本）。仓库自带的 `tools/*.mjs`（coverage /
  supersession / doc-budget）是给目标仓库自己的 CI 用的，仍需
  `node` 在 PATH 里、仍需 `package.json` 挂脚本 —— 那部分不在本保证内。
- **代价**：`verify-notes.mjs` 多起一次 `git rev-parse`（可忽略）。
- **代价**：`--root` 是个新参数，需要知道它存在。默认行为已覆盖绝大多数场景。
- **已知缺口**：vendored 的 `.ts` 脚本在**没有 `package.json`** 的仓库里
  会打印一条 Node 警告（`add "type": "module"`）。实测不影响功能
  （退出码与结果都正确），但输出里多两行噪音。
  重访信号：若某版 Node 把这条警告升级成错误。
- **已知缺口**：`doc-budget.mjs` 用 `fileURLToPath(new URL('..'))` 定位
  仓库根（与 `verify-notes.mjs` 的旧写法同源）。实测在独立仓库里
  它正确报「清单里的文件不存在」，行为可接受；但若把脚本放进**子目录**
  而非仓库根，它会读错位置。当前用法（`tools/` 下）没有问题。
- **未做**：插件本体（`lib/index.js`）仍然需要 DSH —— 那是它的定义，
  不可能脱离。本次保证的是**笔记门禁功能**可脱离。

## Verification

```sh
node --test tools/standalone.test.mjs        # 6 项
node --test tools/non-node-project.test.mjs  # 2 项（无 node 环境 / 非 Node 项目）
```

后两条断言在**没有 `package.json`、没有 `node_modules`、没有 `.git`、
`PATH` 指向空目录**的临时项目里，经 `lib/notes.js` 的服务入口跑：

| 断言 | 结果 |
|---|---|
| 三道门禁全部 `passed: true` 且 `exitCode: 0` | ✅ |
| 目标仓库里**不出现** `package.json` / `node_modules`（顶层只剩 `.agents`）| ✅ |
| 同一非 Node 项目里删掉 `## Alternatives considered` → `format` 门禁红、非零退出码 | ✅ |

最后一条是防「跑成空转」：没有它，上面两条绿也可能只是三条门禁都没真跑。


六条断言（全部在**临时构造的独立仓库**里跑，不用桩）：

| 断言 | 结果 |
|---|---|
| 门禁脚本不 import `@deepseek-ai` 或 `../lib/` | ✅ |
| 独立仓库改源码不写笔记 → 红 | ✅ |
| 独立仓库写笔记 → 绿 | ✅ |
| `verify-notes` 验的是当前仓库（报「1 篇」，不报「16 篇」）| ✅ |
| 无笔记树 → `NO_NOTES_TREE`，不回退 | ✅ |
| supersession 在独立仓库可用（有无声明分别绿/红）| ✅ |

**故障注入（真红）**：把 `repoRoot()` 改成直接 `return PACKAGE_ROOT`
（复现原缺陷）⇒ **2 项红**。

真实场景复核（纯 Node 项目，无 DSH、无 `package.json`）：

```text
改 src/app.js 不写笔记        → 退出码 1，点名 src/app.js
写笔记后再提交               → 退出码 0
git commit（挂了 commit-msg） → 拦下，日志未前进
verify-notes 在独立仓库      → ok，报「1 篇笔记」（不再报 16 篇）
verify-notes 在无笔记树仓库  → NO_NOTES_TREE，退出码 1
```

### 2026-10-24 复验（Owner 追问「现在做到了吗」）

做法：造一个**干净仓库**（`git init` + 一篇笔记；**没有** `package.json`、没有
`node_modules`、没有 DSH），把实现按 README 承诺的方式拷进去，用系统 `node` 直接跑。

| 场景 | 结果 |
|---|---|
| 拷 `lib/` + `tools/verify-notes.mjs` + `skills/` → 跑门禁 | ✅ exit 0，报「共 1 篇笔记」，路径指向**那个仓库** |
| 同一份拷贝里把笔记改坏 → 再跑 | ✅ exit 1，`missing one of`（真在验，不是空转） |
| 只拷 `lib/`+`tools/`（漏 `skills/`） | ✅ 红，并给出「脚本缺失 + 候选目录 + `cp -r` 指引」 |
| `notes-coverage.mjs`（只 staged 受管源码、不带笔记） | ✅ 拦下并提示 `Note-Skip` |
| `notes-supersession.mjs`（新笔记没声明关系） | ✅ 拦下 |
| `doc-budget.mjs`（清单缺失） | ✅ exit 2「本次检查无效」 |

6/6 符合预期；既有回归 `standalone.test.mjs` + `verify-notes-standalone.test.mjs`
共 17 条全绿。

**复验暴露的三条边界**（都属本节上文「边界/已知缺口」的同一族，不是新缺陷）：

- 需要 Node ≥ 22.19（`.ts` 类型剥除）。这一条本轮补了运行时守卫：
  版本不够时报 `NODE_TOO_OLD` 并说清要什么，而不是死在加载错误上
  （见 `lib/notes.js` 的 `REQUIRED_NODE`，与 `engines` 由用例互校）。
- 目标仓库**没有 `package.json`** 时，vendored `.ts` 会打印
  `MODULE_TYPELESS_PACKAGE_JSON` 警告（输出噪音，退出码与结论都正确）。
- `doc-budget.mjs` **没有** `--config` 参数，清单固定读
  `<脚本所在包>/tools/doc-budget.json`；所以它必须放在目标仓库的 `tools/` 下。
  这是上面「已知缺口 · doc-budget 用脚本位置定位仓库根」的具体表现。
