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
node --test tools/standalone.test.mjs   # 6 项
```

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
