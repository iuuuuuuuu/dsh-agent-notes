# Agent Note: 三层检查的范围必须对齐，否则本地绿而远端红

Status: implemented

> 同域：本篇讲的是「各层检查的范围一致性」。
> 三个层次各自的内容见
> [2026-10-18-notes-coverage-gate.md](2026-10-18-notes-coverage-gate.md)、
> [2026-10-18-notes-supersession-check.md](2026-10-18-notes-supersession-check.md)、
> [2026-10-18-doc-budget-gate.md](2026-10-18-doc-budget-gate.md)。
> 本篇管的是**它们被装到了哪些层、有没有漏装**。

## Problem

本仓库有三层检查：本地 `commit-msg` 钩子、`npm run check`、CI。
它们应该是「同一套检查，不同触发时机」。实测发现**三层范围完全不一致**：

| 层 | 当时包含的检查 |
|---|---|
| 钩子 | coverage + supersession |
| `npm run check` | verify + notes:gate + test + fault-injection + evidence |
| CI | verify + notes:gate + **coverage** + **supersession** + **doc:budget** + test + fault-injection |

也就是说：**跑完 `npm run check` 全绿，推上去 CI 仍会红**。而这正是
Owner 反复强调不能出现的那类问题 —— 本地与远端判断不一致，
人会开始不信任本地门禁。

### 第二个更隐蔽的问题：`check` 里的检查是空转的

把 `notes:coverage` 直接加进 `check` 之后，它跑的是**暂存区模式**。
而 `check` 通常在提交**之后**跑，此时暂存区是空的：

```text
笔记覆盖门禁通过（暂存区）：改动未命中受管路径，无需笔记。
```

它打印「通过」，但**什么都没检查**。这是假绿的另一种形态：
门禁在跑，断言也返回 0，只是检查的对象是空集。

## Decision

**① `check` 补齐 CI 里全部「纯本地可跑」的检查。**

新增 `notes:coverage`、`notes:supersession`、`doc:budget`。

唯一保留的差异是 `evidence`：它需要本机安装 DSH（读 `$DSH_DIST` 或从
`$DSH_HOME` 推断），CI 上没有环境，跑不了。这个差异是**有意且可解释**的。

**② `check` 里用「最近一次提交」而非暂存区。**

新增两个入口专供 `check` 使用：

```sh
npm run notes:coverage:last      # = --range HEAD~1..HEAD
npm run notes:supersession:last  # = --range HEAD~1..HEAD
```

**must**：`check` 里不能用暂存区模式。提交后暂存区为空，
检查会变成空转 —— 打印通过但什么都没验。

**③ 新门禁必须登记进 `fault-injection` 的自证清单。**

`tools/fault-injection.mjs` 里维护一份「哪道门禁的故障注入在哪个测试文件」
的清单。新增门禁时忘了登记，总门禁会**继续报绿**，而那道门禁的故障注入
其实已经没人跑了。本次补登记了 `doc-budget` 与 `archive-note` 两项。

## Alternatives considered

- **让三层跑完全相同的命令**（包括把 `evidence` 也塞进 CI）— 范围最一致。
  否掉：`evidence` 需要真实 DSH 安装，CI 上必然失败。一个**注定失败**的
  检查会被加 `|| true` 绕过，那时连它在本地的价值也没了。
  差异应该显式写清楚，而不是强行抹平。
- **`check` 保持暂存区模式，约定「提交前跑 `check`」** — 不改脚本。
  否掉：约定不可验证。实测我就是提交后才跑 `check`，
  于是 coverage 与 supersession 两项一直是空转的。
  靠时序约定保证检查有效，与「靠人记得写笔记」是同一类不可靠。
- **`check` 里不跑 coverage/supersession，只在钩子里跑** — 少一处维护。
  否掉：钩子可被 `--no-verify` 绕过，而 `check` 是人主动跑的总验证。
  它不覆盖这两项，就等于「主动验证」比「被动拦截」还弱。
- **给 `check` 加一个 `--staged` 开关，让人自己选** — 更灵活。
  否掉：多一个选择就多一次选错。默认行为应该是最有用的那个，
  而 `check` 最有用的时候就是提交后跑全量。
- **`fault-injection` 自动发现测试文件**（扫 `tools/*.test.mjs`）—
  不会忘登记。否掉：`tools/` 下还有 board / plugin / integration 等
  与门禁无关的测试，自动发现会把它们也算进来，那个清单就失去意义 ——
  它记录的是「**这道门禁**的故障注入在哪」，不是「有哪些测试」。

## Consequences

- **收益**：`npm run check` 现在覆盖 CI 的全部纯本地检查。
  本地绿 → CI 绿，不再有两边不一致。
- **收益**：`check` 里的 coverage/supersession 第一次真正检查了东西
  （之前是空转，打印通过但没验任何内容）。
- **收益**：`fault-injection` 的自证清单补全，四道新门禁都在里面。
  而且这份清单本身**能变红** —— 实测把某个测试文件移走，
  它会报 `✖ tools/doc-budget.test.mjs 不存在 —— 文档预算没有故障注入，不可信`。
- **代价**：`npm run check` 变长（多了 3 项），跑一次更慢。
  这是「本地与远端一致」的必要代价。
- **代价**：`HEAD~1` 在只有一次提交的仓库里不存在，会退出码 2。
  首提交时 `check` 会失败一次 —— 这个方向是安全的（不会假绿），
  但对新仓库的首次体验不友好。
- **已知缺口**：**未跟踪文件看不见**。`notes:coverage` 用
  `git diff --cached`，未 `git add` 的新文件不在其中。实测确认：
  新建 `lib/new.js`（未 add）时门禁报「未命中受管路径」并放行。
  这在钩子场景是安全的（`commit-msg` 阶段文件必然已 add），
  但**手动跑 `npm run notes:coverage` 的人以为它检查了全部改动**。
  重访信号：有人反馈「我先写了代码直接跑 coverage，它说没问题」。
- **已知缺口**：三层范围仍不是完全相同的命令序列（`check` 用 `:last`
  变体，CI 用 `event.before` 区间）。抽查方法：

  ```sh
  node -pe "require('./package.json').scripts.check"   # 与 CI 的 run 行对比
  ```

  没有脚本自动比对这两处 —— 这是本次没做的一部分。

## Verification

```sh
npm run check        # 八项串跑
```

逐项实测（全部真跑，退出码为准）：

```text
verify                    自检通过
notes:gate                3 条 exit=0，15 篇笔记
notes:coverage:last       检查了 1 个提交，每次受管改动都同批带了笔记
notes:supersession:last   1 篇新笔记都声明了与既有笔记的关系
doc:budget                2 个文件都在预算内
test                      147/147（非网络测试）
gate:fault-injection      每条门禁都能对该拦的故障变红
```

**自证清单能变红**（实测）：

```text
$ mv tools/doc-budget.test.mjs /tmp/
$ npm run gate:fault-injection
  ✖ tools/doc-budget.test.mjs 不存在 —— 文档预算没有故障注入，不可信
  故障注入未通过：1 项。门禁不可信，先修门禁。
```
