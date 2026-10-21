# Agent Note: 第五处围栏口径只服务于一条测试 —— 删掉它，让测试走真实路径

Status: implemented

> 接 [2026-10-20-fourth-fence-dialect-in-bilingual-docs.md](../bug-fix/2026-10-20-fourth-fence-dialect-in-bilingual-docs.md)
> —— 那篇收敛了四处口径，并把判据写进重访信号：
> `grep '(```|~~~)' tools/*.mjs` 应只剩共用件内部那一处。
> 本篇是继续执行该判据的结果：还剩一处，而且它**只在测试里跑**。

Independent: 前两篇改的是生产路径的口径来源，本篇删的是一个从未进过
生产路径的辅助函数。同域但决定不同，故新开一篇。

## Problem

`tools/archive-note.mjs` 导出 `replaceOutsideFences(content, fn)` ——
一个逐行状态机，自己判哪些行在围栏内。

它**只有一个调用方**：`tools/archive-note.test.mjs` 里那条
「replaceOutsideFences 认两种围栏且不误伤」。

生产路径 `rewriteRelativeLinks` 早在接入共用件之后就走 `blankOutFences` 了，
与这个状态机无关。于是：

- 它是第五套围栏口径，且**没有任何生产代码用它**；
- 测试却通过它声称「与 md-links 完全一致」；
- 更糟的是，那条测试覆盖的行为（围栏外才变换）**与真实生产路径是同一件事**，
  却绕过了真实路径去验一个影子实现。

实测两套口径的分叉（`.probe/probe-archive-fence.mjs`）：

| 输入 | 状态机判「区内」 | mdast 判「区内」 |
|---|---|---|
| 未闭合围栏 | `[3,4,5]` | `[3,4]` |
| **嵌套标记文本** | `[2,3,5,6,7,8]` | `[2,3,5,7]` |
| 其余四种 | 一致 | 一致 |

第二种会让本该改写的正文链接被跳过 —— 归档后即断链。虽然当前生产路径
不走它，但只要有人以为「测试覆盖过了」而把它接回去，坑立刻复活。

## Decision

**删掉 `replaceOutsideFences`，把那条测试改成直接验 `rewriteRelativeLinks`。**

新用例用同一份输入（两种围栏各包一个示例链接，围栏外两条真链接），断言：

- 围栏外两条被改写（且补上 `implemented/`）；
- 围栏内两条**原样不动**（那是历史快照，改了就是篡改）；
- `changed === 2`。

这样测的是真实生产路径，且围栏口径只有一处。

## Alternatives considered

- **修好状态机，让它与 mdast 一致** —— 保留 API。
  **否掉因为它的存在本身是问题**：一个只被测试用的导出，等于给后来的人
  留了一条「看起来该用」的旁路。修好它只会让旁路更可信。
- **保留函数但标为 @internal / 不导出** —— 缩小暴露面。
  **否掉因为死代码仍是死代码**：没人调用、还要跟着共用件的口径演进，
  每次改 `blankOutFences` 都得记得同步它。删掉是唯一的收敛。
- **把测试改成同时验两套口径一致** —— 最严格。
  **否掉因为那要求状态机继续存在**，而本篇的目的正是消除它。
  两套口径的一致性由「只有一套」保证，比由断言保证更可靠。

## Consequences

- **收益**：围栏口径从五处减到一处（共用件），且测试不再验影子实现。
- **收益**：`archive-note.mjs` 少一个导出、少约 20 行状态机。
- **代价与已知上限**：新用例比旧的慢（要跑真实的 `rewriteRelativeLinks`，
  内含 mdast 解析）。实测 26ms，可接受。
- **代价与已知上限**：`rewriteRelativeLinks` 的围栏行为此前只被间接测过
  （`archive-note` 的归档用例覆盖了「代码块里的示例不得改写」），
  现在多一条直接针对两种围栏标记的 —— 但**仍未覆盖未闭合围栏下的归档改写**。
  那条留给重访信号：未闭合围栏是文档缺陷，归档时它会被整段当代码，
  改写不到其中的链接；要验证需先确认 mdast 在该输入下的 `code` 边界。
- **重访信号**：
  - **再有人在 `tools/` 里贴围栏正则** → 那是第六处。判据同上：
    `grep -n '(```|~~~)' tools/*.mjs` 应只剩共用件内部与测试注入夹具。

## Verification

```sh
node --test tools/archive-note.test.mjs   # 12/12
node --test tools/*.test.mjs              # 388/388
npm run check                             # 全链 exit 0
```

新用例的输入同时含 js 围栏与波浪号围栏，围栏外两条链接、围栏内两条示例；
断言 `changed === 2` 且示例原样。第一版断言写成 `../../bug-fix/a.md`，
漏了归档后要跨 lifecycle 补的 `implemented/` —— 是判据写错，不是实现错。
