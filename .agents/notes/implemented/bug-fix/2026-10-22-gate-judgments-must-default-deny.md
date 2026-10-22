# Agent Note: 门禁判据要「默认拒绝」，列举法等号后面补不完

Status: implemented

- 日期：2026-10-22
- 适用：`tools/ci-alignment.mjs`（`no-continue-on-error`、`cancels-only-superseded-pr`）

## Problem

同一天里，这两条 CI 安全属性被判据**绕过两次**，每次都出在同一个思路上：判据写成
「把我知道的坏写法列出来」，凡是没列到的就默认放行。

第一次（PR #29 → PR #30 修）：`continue-on-error` 只认裸小写 `true`。
`True`、`"true"`、`true # 临时放行` 三种都能把一道门禁静默降级成警告。

第二次（PR #30 上被当场指出）：修成列举 `true` / `True` / `"true"` / `${{ true }}` 之后，
`${{ true || false }}` 照样能过 —— 它求值为 `true`，而正则不认识这个表达式。
同一轮里另一条 `cancels-only-superseded-pr` 也只要求「这一行里出现 `github.event_name`
与 `pull_request`」，于是语义**相反**的 `${{ github.event_name != 'pull_request' }}`
也能过：它在 push 上才取消，取消的正是要保住的发布验证。

两次的共同点：坏集合不是「有限的几种写法」。GitHub Actions 的表达式是图灵完整的，
列举法在原理上补不完；而每补一次都要等下一次被绕过才知道漏了。

## Decision

两条判据都改成**默认拒绝**：白名单只放行唯一一种已知安全形态，其余一切（含任何
`${{ … }}` 表达式）判红，并让人来解释。

- `continue-on-error`：只放行字面量 `false`（`CONTINUE_ON_ERROR_ALLOWED`）。
  实现改为 `offendingContinueOnError(yml)`：收集所有 `continue-on-error:` 行，
  逐行判「是否等于允许的唯一形态」，非空即失败。
- `cancel-in-progress`：只放行 `${{ github.event_name == 'pull_request' }}`
  （`CANCEL_ONLY_FOR_PR`）。`!=`、`&&`、`||`、裸 `true` 一律拒绝 ——
  不做表达式语义推导，因为能自动判对的前提是有解析器，而本仓库没有。

代价是**将来真要写条件降级时得先改判据**。这是刻意留的摩擦：一条安全属性
被人主动改掉，比被人顺手绕过去要可见得多。

## Alternatives considered

**① 继续补列举：把 `||`、`&&`、`!` 都写进正则。**
最强的理由：不动判据的形状，也不增加「要改门禁才能做某件事」的摩擦 ——
对绝大多数仓库来说，`continue-on-error: ${{ matrix.experimental }}` 是合法需求，
一律拒绝会让它们被迫改门禁。
否掉的原因：这次是 `${{ true || false }}`，下次可以是 `${{ 1 == 1 }}`、
`${{ vars.RETRY != '' }}`。每漏一种就多一次「门禁看着绿、其实门禁被降级」，
而这正是这两条判据存在的唯一理由。需求可以用别的写法表达（把它拆成两个 step）。

**② 引 YAML 解析器（`yaml` / `js-yaml`），按结构判 `steps[].continue-on-error === true`。**
最强的理由：这是唯一真正语义正确的做法，注释、引号、大小写、块标量都不再是问题；
结构判据不可能被写法绕过。
否掉的原因：本插件的硬约束是**零 `@deepseek-ai/*` 依赖**，而这道门禁既要在本仓库
`npm test` 里跑，也要能在别人的项目里跑；为两条判据新增一个运行期依赖，
与「插件本体不拉依赖」的既有取舍冲突。另外即使有了 YAML 结构，
`${{ true || false }}` 这类**表达式值**仍然要单独判断 —— 默认拒绝照样是必需的，
解析器只是把「写法」那一半消掉。

**③ 只对 `verify.yml` 做默认拒绝，`upstream-sync.yml` 保留宽松判据。**
最强的理由：`upstream-sync.yml` 会 push，误判红会让上游同步流程卡死，
保守一点可能更实用。
否掉的原因：那个 job 恰好是**最不能**被静默降级的一个 —— 它有 `contents: write`
且会 push main 与 tag，一道门禁被降级就意味着坏内容可能被直接推上去。

## Consequences

收益：

- 两条判据从「列举坏写法」变成「只放行一种好写法」，绕过面从「未列出的写法」
  收缩到「表达式求值为 false 的写法」（当且仅当它不等于字面量 `false`，会被判红 →
  偏向失败，不是偏向通过）。
- 已有回归钉住：`${{ true || false }}`、`${{ matrix.experimental }}`、`true && true`
  三种继续降级写法必须红；`${{ github.event_name != 'pull_request' }}` 必须红。

代价与残留：

- **误判方向已确认**：将来合法的条件降级（如 `${{ matrix.experimental }}`）
  会被判红，必须改判据或用别的写法。这是刻意的。
- 判据仍是字符串级：它不解析 YAML，也不求值表达式。一条**等于**字面量 `false`
  但写法变形（如 `continue-on-error: !!bool false`）会被误判红 —— 偏向失败，
  可接受。反方向（判绿）已被默认拒绝堵住。

## Verification

- `node --test tools/ci-alignment.test.mjs` ⇒ `32 / pass 32 / fail 0`。
- **真故障注入**：把 `CONTINUE_ON_ERROR_ALLOWED` 换回「列举 true 各写法」的旧正则 ⇒
  `pass 28 / fail 4`，红的四条正是 continue-on-error 相关的四条（含新加的表达式用例）；
  还原后 `32 / 32`。
- 真实仓库此刻仍全绿：`node tools/ci-alignment.mjs` ⇒ 三道全过、`14 条 CI 安全属性均未被删改`。

补充（同日）：`tools/version-notice.test.mjs` 里那条「判据只有一处」原来只直接调
`isVersion`，没跑子进程也没写文件 —— 按 `tools/**` 的口径这算没验证到真实路径
（CodeRabbit 在 PR #30 上指出的是这一点，Minor 但成立）。已补一条端到端用例：
起真 node 子进程、读写真状态文件，走「首次挂载 → 版本没变 → 真升级 → 再挂载」四步，
断言提示只在升级那一次出现、标签在那一刻多一个「已更新」。
真故障注入（让 `buildVersionChangeHint` 恒返回 `undefined`）⇒ 4 条红，含该端到端用例。

相关笔记：[`./2026-10-22-single-form-matching-and-second-source-of-truth.md`](./2026-10-22-single-form-matching-and-second-source-of-truth.md)
（同一批缺陷的第一版修法，本文更正其中「列举等价写法」那半边）。
