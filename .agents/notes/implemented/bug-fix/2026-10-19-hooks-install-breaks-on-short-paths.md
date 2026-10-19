# Agent Note: 8.3 短路径会让钩子装不上，而这条路径没有测试

Status: implemented

> 同属**流程补齐**与**测试覆盖**两条线。
> 并行测试的并发纪律见
> [2026-10-19-parallel-tests-must-not-share-real-trees.md](../testing/2026-10-19-parallel-tests-must-not-share-real-trees.md)
> （本篇的测试同样遵守「真仓库只读不写」：全程在临时 git 仓库里跑）。
> 发版记账见
> [2026-10-19-release-bookkeeping-needs-a-gate.md](../process/2026-10-19-release-bookkeeping-needs-a-gate.md)。

Independent: 本篇处理的是**路径归一化在 Windows 上的失效**，与笔记治理、
文档同步、发版记账是不同的失效面。

## Problem

`npm run hooks:install` 是**每个 clone 都要跑一次**的入口，它改 git 配置与
工作区文件。给它补测试时，第一条用例就红了：

```
✖ 当前目录不是 git 仓库根，无法安装钩子。
  PACKAGE_ROOT = C:\Users\IUUUUU~1\AppData\Local\Temp\an-hooks-xxx\
```

脚本用 `git rev-parse --show-toplevel` 的输出与自己的 `PACKAGE_ROOT` 比对，
判定「当前目录是不是仓库根」。原有的 `normalize` 已经处理了三种 Windows
路径差异：大小写、斜杠方向、末尾多一个分隔符。

**但漏了第四种：8.3 短路径 vs 长路径。**

实测数据：

| 来源 | 路径 |
|---|---|
| `import.meta.url` 解析出的 `PACKAGE_ROOT` | `C:\Users\IUUUUU~1\AppData\...` |
| `git rev-parse --show-toplevel` | `C:/Users/iuuuuuuuu/AppData/...` |

`C:\Users\IUUUUU~1` 是 8.3 短路径（Windows 对长文件名给的兼容名）。
两者字符串永不相等，于是**在任何 `%TEMP%` 或用户目录位于 8.3 形式下的
Windows 机器上，`npm run hooks:install` 直接退出 2，钩子装不上**。

而钩子装不上意味着「该写笔记却没写」这件事完全没人拦 —— 本地那半道门禁
静默消失，只有 CI 那一道还拦着。

### 为什么本机没暴露

本机的仓库在 `D:\WishProject\`，路径没有 8.3 形式，所以本地一直正常。
暴露它的是测试：一旦在 `%TEMP%`（`C:\Users\IUUUUU~1\...`）下建沙箱，
差异立刻显现。

## Decision

归一化前先用 **`realpathSync.native`** 展开真实路径。

关键在于 **`.native` 与 JS 版行为不同**（实测）：

| 实现 | 输入 `C:\Users\IUUUUU~1\AppData\Local\Temp\an-8-he6krr` 的输出 |
|---|---|
| `realpathSync()`（JS 版） | `C:\Users\IUUUUU~1\AppData\...` ← **不展开** |
| `realpathSync.native()` | `C:\Users\iuuuuuuuu\AppData\...` ← **展开** |

我第一版修法用的是 JS 版 `realpathSync`，**测试仍然全红** —— 那一刻才明白
不是「加 realpath 就行」，而是「加对的那一版 realpath」。

`must`：优先 `.native`，失败回退 JS 版（某些环境没有 native），两者都失败
才返回原值。失败时不能让整个脚本崩 —— 那会让「路径不对」变成「脚本报错」，
两种问题混在一起更难查。

`must`：**保留 `PACKAGE_ROOT` 的诊断输出**。判定失败时打印它，是排查这类
问题的第一现场；只留一句「不是仓库根」的话，路径形式的差异根本无从查起。

### 测试怎么覆盖这个缺陷

`tools/install-hooks.test.mjs`（9 个用例）。全部在 `mkdtempSync` 出来的
**临时 git 仓库**里跑 —— 脚本靠 `git rev-parse` 判定仓库根，所以要把脚本
**复制**进沙箱，��则它的 `PACKAGE_ROOT` 永远指向本仓库、判定必然失败。

覆盖：安装成功、写钩子文件、设 `core.hooksPath`、钩子正文两道门禁、
shebang、重复安装幂等、内容不同才提示覆盖、`--undo`、重复卸载、
非仓库根退 2、旧 pre-commit 清理、**不删别人的 pre-commit**。

`must`：涉及路径归一这类「在特定环境下才失效」的逻辑，测试必须**在那个环境
里跑**。这里天然满足 —— 沙箱建在 `%TEMP%` 下，而 `%TEMP%` 在本机就是
8.3 形式。等于环境帮我们构造出了复现条件。

## Alternatives considered

- **用 `child_process` 调 `cmd /c for %I in (path) do @echo %~fI` 展开短路径** — 绕开 Node API。否掉是因为要起子进程只为做一次路径展开，而 `realpathSync.native` 就在同一个 `node:fs` 里、零成本且跨平台。引子进程等于引入了「子进程失败」「编码问题」「不同 shell 行为」一整类新的故障点。
- **干脆不比较路径，改成「在 git 仓库里就装」** — 只要 `git rev-parse` 成功就装，不管是不是仓库根。否掉是因为那样会在**子目录**或**另一个仓库**里也执行安装，把钩子写进不属于它的地方。那是更严重的问题，且会破坏用户的 git 配置。
- **把路径判定改成「用 git 自己的 cwd」**（如 `git rev-parse --show-prefix` 判空串）。这是个更优雅的方案：完全不需要比较路径。**但会改变语义** —— 它判定的是「cwd 是否为仓库根」，而现在的判定是「脚本所在目录是否为仓库根」。两者在正常情况下等价，但在「脚本在别处、cwd 在仓库根」的调用方式下不同（从子目录调用 npm script 时 cwd 才是关键）。这是个真实的行为差异，改它需要先确认现有调用方式，本篇不做 —— 记在重访信号里。
- **只加一条「路径含短路径时能装上」的测试，不修 bug** — 显然不行，那正是缺陷本身。

## Consequences

- **收益**：修掉一个真实的、会导致门禁静默失效的缺陷。受影响的是所有 `%TEMP%` 或用户目录在 8.3 形式下的 Windows 机器 —— 那不是边缘情况，`C:\Users\<8字符用户名>\AppData\Local\Temp` 是 Windows 的常规布局。
- **收益**：`install-hooks` 从零覆盖变成 9 个用例 + 10/10 故障注入。注入里第一条就是**还原这个 bug**（`.native` 换回 JS 版），测试确实变红 —— 证明这条覆盖不是摆设。
- **收益**：顺带发现并补上一个测试缺口：钩子正文的 `notes-supersession.mjs` 只出现在注释里，我最初没断言「实际执行」。故障注入把它换成 `true` 时测试仍全绿 —— **只跑一道门禁的钩子看起来在工作，实际漏掉了一半**。
- **代价与已知上限**：测试要复制脚本进沙箱，因为它靠 `git rev-parse` 判定。**这意味着沙箱里的脚本副本与仓库里的可能不同步** —— 若两者行为分叉，测试验的就不是真正在用的那份。缓解办法是每次测试都从仓库复制（当前如此），但「复制」本身是一份拷贝，仍有理论上的漂移窗口。
- **代价与已知上限**：`.native` 与 JS 版在**非 Windows** 平台行为是否一致未验证。当前 CI 只跑 ubuntu（`realpathSync.native` 在 Linux 上可用且会展开符号链接，与 JS 版基本一致），但没有专门用例锁住这个差异。
- **代价与已知上限**：8.3 短路径只在 Windows 上出现，所以**这个缺陷在 Linux CI 里永远不会复现**。这条覆盖完全依赖本地 Windows 环境 —— 若将来只跑 Linux CI，这份测试对该缺陷就退化成了「其它边界路径的覆盖」。这也是它值得单独记的原因。
- **重访信号**：若 `npm run hooks:install` 将来支持「从子目录调用」（例如 npm workspaces 或 `npm --prefix`），应重新评估「脚本目录 vs cwd」这个语义选择 —— 见上��被否的第三条。

## Verification

```sh
node --test tools/install-hooks.test.mjs   # 9 个用例
npm run gate:fault-injection               # 含「自证清单必须有真实用例」
```

故障注入（已实测，10/10 全部符合预期）：不用 `.native` 展开短路径（= 原始
bug）、完全不展开真实路径、不统一斜杠方向、钩子不传 `--message-file`、
钩子不跑 supersession、shebang 改成 node、静默覆盖别人的钩子、误删别人的
pre-commit、非仓库根不报错、`--undo` 重复执行报错。

其中「不去掉尾随分隔符」这条被移除了：它原本在测试里**重写了一遍**归一
逻辑，改的是副本不是被测代码，所以故障注入时照样全绿（实测）。改为直接
依赖「安装成功」这个结果 —— 归一扛不住尾斜杠，安装就必然失败。这是本篇的
第二条教训：**验证 A 的逻辑时，不要在测试里再写一份 A**。