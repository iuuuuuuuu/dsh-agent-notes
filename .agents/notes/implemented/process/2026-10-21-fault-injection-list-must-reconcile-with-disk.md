# Agent Note: 自证清单必须与磁盘对账，否则新测试能悄悄溜出去

Status: implemented

> 接续 [2026-10-18-three-layer-checks-must-align.md](./2026-10-18-three-layer-checks-must-align.md)
> 的第 ③ 条（新门禁必须登记进 `fault-injection` 的自证清单），并**部分采纳**
> 该篇否掉的「自动发现测试文件」。

Independent: 本篇只改 `fault-injection` 自证清单的**对账方向**；
三层检查范围一致性、以及各道门禁各自判什么，都不变。

## Problem

`tools/fault-injection.mjs` 的自证清单一直只做**正向**检查：

```
登记表里每一项  →  磁盘上必须有这个文件，且至少有一个 test(...)
```

反方向完全无感：**文件存在、但没登记**，门禁照样全绿。

本轮就是这么漏的。为「非 Node 项目 / 无 node 环境」这条新约束加了
`tools/non-node-project.test.mjs`，为归档基线加了 `tools/archive-baseline.test.mjs`，
两个文件都写完了、`npm test` 也在跑，但自证清单没加行。`npm run gate:fault-injection`
连跑几次都是「故障注入全部通过」，直到手工数文件才发现：

```
磁盘上 .test.mjs：37 个
自证清单登记：21 条
盲区：16 个测试文件（board / plugin / integration / version / target / sync-upstream …）
```

这 15 个文件对应门禁的故障注入，即便哪天被人删掉，总门禁也不会说一句话。
它比「门禁不存在」更隐蔽：日志里每天都有这句「故障注入全部通过」。

## Decision

自证清单仍是**手写声明表**（`FAULT_SUITES`），并增加一次**反向对账**：

- `readdirSync(tools)` 取全部 `*.test.mjs`，逐个比对声明表；
- 没登记的**每一个**都单独报错并点出文件名：
  `✖ tools/<name> 没在上面登记 —— 它的故障注入不会有人知道，请加一行标签`；
- 对账通过时打印 `✔ 磁盘上 N 个测试文件全部登记，无遗漏`，与逐条的 ✔ 并列。

仍然保留手写表而不是改成自动发现，因为表里那半列是**人写的语义标签**
（「这道门禁的故障注入在哪」），自动发现给不出标签。

## Alternatives considered

- **自动发现测试文件（上一轮否决的那个方案）** — 它现在能一次解决漏登记，
  且不需要任何人记得做任何事，这是它最强的理由。仍然不采用它做**替代**：
  自动发现只会得到一串文件名，`tools/board.test.mjs` 这类与门禁无关的测试
  会和门禁测试混成一片，而这份清单的全部价值就是「哪道门禁、故障注入在哪」。
  所以采纳的是它的**反向校验**那一半，声明表本身留着。
- **只靠人记得登记，或写进 CONTRIBUTING 一句「新增测试记得加行」** — 零代码。
  已经失败过一次（就是本轮），且和「靠记性跑门禁」是同一种病：紧急场景里
  最先被挤掉的就是记性。
- **未登记文件只报 warning，不算失败** — 改动更小，不会突然让别人的分支变红。
  在本仓库「警告不是门禁」：长日志里的 warning 会被无视，而这条缺陷的全部
  特征就是「没人注意到」。
- **单独加一道 CI 检查去扫未登记文件** — 职责更单一。但那道检查自己也是门禁，
  它同样需要被故障注入保护，于是要再有一道检查检查检查……放在
  `gate:fault-injection` 内部则能自我覆盖：这道门禁被绕过时，整个门禁就是红的。

## Consequences

- **收益**：全部测试文件登记，盲区从 17 个降到 0（本轮实测 49 个）。
- **收益**：新加 `tools/*.test.mjs` 却忘了登记，下一次 `gate:fault-injection`
  立刻红，并且直接点出文件名 —— 修法只有一行。
- **收益**：这条检查自己也能变红。本轮真造了一个 `tools/zz-undeclared-probe.test.mjs`，
  门禁报红并 `exit=1`；删掉后 `exit=0`，退出码两边都验过。
- **代价**：「加一个测试文件」从此是**两步**动作，少一步连总门禁一起红。
  这是有意的：宁可当下的红，也不要长久的静默。
- **代价与已知上限**：对账只比文件名，不判断**标签与文件的语义是否匹配**。
  把 A 的标签写成 B（`['文档预算', 'board.test.mjs']`）不会变红 —— 这需要理解
  文件内容，机械判据做不到。
- **已补上的缺口**（原先写在「已知缺口」里，2026-10-23 修掉）：对账范围曾写死
  `tools/`。把测试放到 `lib/`、`test/` 或任何别处，就等于绕开整本账 ——
  门禁照样打印「磁盘上 N 个测试文件全部登记，无遗漏」，而真正漏的那个根本没进视野。
  现在从仓库根递归收 `*.test.mjs`，只跳过不入库/不属于本插件的目录
  （`node_modules`/`.git`/`.probe`/`dist`/`build`/`coverage`/vendored `skills`）；
  声明表里可以写 `tools/x.test.mjs` 形式，只写文件名时仍按 `tools/` 解析，
  历史条目不必批量改。
- **仍然存在的上限**：跳过名单本身是手写的。新增一类「不该进账」的目录（例如将来的
  打包输出目录）时若不补进去，扫描会在那里收到测试文件并误报红 —— 方向是误红，不是假绿。

## Verification

```sh
node tools/fault-injection.mjs   # 49 个测试文件全部登记，无遗漏
```

**对账范围扩到全仓之后的正反两向实测**（2026-10-23）：

| 造的东西 | 结果 |
| --- | --- |
| `lib/zz-scope-probe.test.mjs`（`tools/` 之外、未登记的测试文件） | ✖ 报红并点出 `lib/zz-scope-probe.test.mjs`；扩范围前它是不可见的 |
| `.probe/zz-scope-probe.test.mjs`（落在跳过名单里） | 仍然「49 个全部登记」，不误红 |

两条探针用完即删（`git status --short` 为空）。

**同一轮里顺手修掉的计数偏差**：每条的「N 处 test 调用」原来用 `/^test\(/gm`
只数行首，漏掉「写在 `for` 里、缩进注册」的用例 —— `archive-baseline.test.mjs`
静态 5 处、实跑 9 条，行首计数只看到 3 处（两条顶格的 `test(` 在数组循环外，剩下
缩进的被漏掉）。一个专门用来对账的工具自带统计偏差，报出来的数字就不再是事实。
改成 `/\btest\(/g` 后 `archive-baseline.test.mjs` 报 5 处、`verify-plugin.test.mjs`
报 19 处，与文件里的实际注册处数一致。**上限照旧**：这只是「不是空壳」的自证，
真实用例数由 `npm test` 自己报，别把这里的数字当覆盖率。

真跑的故障注入（探针用完即删）：

```text
$ printf "import test from 'node:test';\ntest('x', () => {});\n" > tools/zz-undeclared-probe.test.mjs
$ node tools/fault-injection.mjs
  ✖ tools/zz-undeclared-probe.test.mjs 没在上面登记 —— 它的故障注入不会有人知道，请加一行标签
  故障注入未通过：1 项。门禁不可信，先修门禁。
  exit=1
$ rm -f tools/zz-undeclared-probe.test.mjs && node tools/fault-injection.mjs
  ✔ 行内 文件:行号 引用的故障注入在 tools/doc-refs.test.mjs（12 处 test 调用，由 npm test 执行）
  ✔ 磁盘上 38 个测试文件全部登记，无遗漏
  故障注入全部通过
  exit=0
```
