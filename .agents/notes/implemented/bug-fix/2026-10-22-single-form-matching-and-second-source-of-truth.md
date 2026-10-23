# Agent Note: 判据只认一种写法，等于给自己留了三种绕过

Status: implemented

- 日期：2026-10-22
- 适用：`tools/ci-alignment.mjs`（两条安全属性）、`lib/version-notice.js` 与 `lib/state.js`（版本判据）、`lib/notes-layout.js`（根层符号链接）、`tools/publish-layout.mjs`（always-include 只在根生效）

## Problem

CodeRabbit 在 PR #29 上提了 11 条意见，其中四条指向同一类缺陷：门禁的判据写成
**「只匹配我见过的那一种形态」**，而现实里同一条规则有多种写法。四处都实测确认：

1. `tools/ci-alignment.mjs` 的 `no-continue-on-error` 正则只认
   `^\s*continue-on-error:\s*true\s*$`。于是这三种都能把一道门禁静默降级成警告：
   `continue-on-error: True`、`continue-on-error: "true"`、
   `continue-on-error: true # 临时放行`（第三种最要命 —— 加一个行尾注释就绕过了）。
2. 同一个文件的 `cancels-only-superseded-pr` 只要求那一行里出现 `pull_request`。
   写成 `${{ github.ref != 'refs/heads/main' }}  # 见 pull_request 说明` 也能过，
   而它在 `main` 上照样会取消正在跑的发布验证 —— 那正是这条判据要防的事。
3. `lib/state.js` 的 `setPluginVersion` 自己写了一份版本正则，与
   `lib/version-notice.js` 的 `VERSION_RE` 重复。两处一旦漂移，状态里可以记下
   提示逻辑不认的版本，于是「上次 0.9.0、现在也是 0.9.0」永远判不出来。
4. `lib/notes-layout.js` 的根层循环先判 `isDirectory()`、再判 `isFile()`。
   符号链接两者都不是，于是被**两道判断一起跳过** —— 根层挂一个链接，
   任何笔记门禁都看不见它。

另有一处方向相反但同源：`tools/publish-layout.mjs` 的 `isPublished` 用 basename
匹配「npm 总是发布」的文件名，于是 `tools/LICENSE` 也算已发布 —— 判据比 npm
的实际行为宽，会放过「运行时文件躲在同名非根路径里」这种组合。

## Decision

四处统一成一种写法：**把「同一条规则的等价形态」显式列全，并让实现只留一处真相。**

- `CONTINUE_ON_ERROR_TRUE` 一条正则覆盖裸 `true`、`True`、`"true"`、`${{ true }}`
  与行尾注释；两个 workflow 都复用它。
- `cancels-only-superseded-pr` 先 `stripComments()`，再要求
  `cancel-in-progress` 那行同时出现 `github.event_name` 与 `pull_request`。
- `lib/version-notice.js` 导出 `isVersion(value)`，`lib/state.js` 改为调用它，
  不再自带正则。
- `lib/notes-layout.js` 在两道判断之前显式拦 `entry.isSymbolicLink()`。
- `isPublished` 的 always-include 分支加 `!f.includes('/')`，只在仓库根生效。

每条都配了一条**断言「绕过写法必须判红」**的回归，而不是只测正确写法。

> **更正（同日）**：本文「把等价形态列全」这一半当天就被证伪 —— 列举补不完
> （`${{ true || false }}` 是下一个绕过）。`continue-on-error` 与 `cancel-in-progress`
> 两条判据已改为**默认拒绝**，见
> [`./2026-10-22-gate-judgments-must-default-deny.md`](./2026-10-22-gate-judgments-must-default-deny.md)。
> 「判据只许一处」那半边仍然成立，未改。

## Alternatives considered

**① 只把正则改成大小写不敏感（`/i`）。**
最强的理由：一行改动，成本近乎为零，而且直觉上「`True` 与 `true` 是同一个意思」
已经覆盖了最可能的误写。
否掉的原因：`"true"`（带引号）和 `true # 注释`（行尾注释）都过不了 `\s*$`，
而后者恰恰是「临时放行」时最常见的写法 —— 只改 `/i` 会留下最大的那个口子。

**② 找一个 YAML 解析器，按结构判 `steps[].continue-on-error === true`。**
最强的理由：这是唯一真正语义正确的做法 —— 结构判据不可能被写法绕过，
注释、引号、大小写、块标量全都不再是问题。
否掉的原因：本插件的硬约束是零 `@deepseek-ai/*` 依赖，`js-yaml` 会新增一个
运行期依赖，而这道门禁在 `npm test` 里跑、也要能在别人的项目里跑；
为一条判据引入解析器，与「插件本体不拉依赖」的既有取舍冲突。
退一步说，即使引入解析器，`${{ true }}` 这种表达式仍然要靠字符串识别。

**③ 顺着第 3 条把 `VERSION_RE` 也搬进 `lib/state.js`，两边各留一份但加测试对齐。**
最强的理由：`lib/state.js` 不必多一个 import，模块依赖图更浅。
否掉的原因：「判据只许一处」是本仓库写进 `path_instructions` 的硬规则；
用测试对齐两份正则，只是在漂移发生后才发现，而不是让它不可能发生。

## Consequences

收益：

- 四种绕过写法现在都有回归钉住；`continue-on-error` 的行尾注释不再是免死金牌。
- 版本判据回到一处，状态与提示不可能各说各话。
- 笔记根层的符号链接从「静默忽略」变成「判红并说明为什么」。
- `isPublished` 与 npm 的实际发布行为对齐，少一类假绿。

代价与残留：

- 正则仍然是字符串匹配，`${{ }}` 里更复杂的表达式（如
  `${{ inputs.retry }}`）不会被识别 —— 这条判据的能力边界没有变，只是把
  已知的三种绕过补上。真正的解法仍是结构化解析（见备选②）。
- `isSymbolicLink()` 判红意味着**确实想用链接**的仓库要改结构；
  这是刻意的：让不可见的内容变成可见的失败。
- 这一批改的是「判据的宽严」，不改任何门禁要防的**结论**：
  真实仓库此刻依然全绿。

## Verification

- `node --test tools/ci-alignment.test.mjs` ⇒ `30 / pass 30 / fail 0`
  （新增「continue-on-error 的等价写法都要被拦」与
  「cancel-in-progress 只要不是按 event_name 收窄就必须红」两条）。
- **真故障注入**：把 `CONTINUE_ON_ERROR_TRUE` 还原成旧的
  `/^\s*continue-on-error:\s*true\s*$/m` ⇒ `pass 29 / fail 1`，红的正是新加的那条；
  还原后 `30 / 30`。
- `node --test tools/notes-layout.test.mjs tools/version-notice.test.mjs` ⇒ `31 / 31`
  （符号链接用例在本机真的建出了链接，不是 `markTestSkipped`）。
- `node --test tools/publish-layout.test.mjs` ⇒ `11 / 11`
  （含「`tools/LICENSE` 不算已发布」与「`files` 覆盖 `lib` 时 `lib/LICENSE` 算已发布」）。

相关笔记：[`../process/2026-10-19-gates-that-nobody-runs-are-not-gates.md`](../process/2026-10-19-gates-that-nobody-runs-are-not-gates.md)。
