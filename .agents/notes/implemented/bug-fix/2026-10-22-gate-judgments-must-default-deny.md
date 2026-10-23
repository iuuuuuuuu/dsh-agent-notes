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

### 键那一半：同一类缺陷又现形五次

「默认拒绝」只修了**值**那一半，**键**那一半还是「只认 `continue-on-error:` 这一种写法」。
之后连着五次被同一类缺陷追上，每一次都证明「列举写法」这条路走不通：

1. `- continue-on-error: true`（行内序列表项）与 `continue-on-error : true`（冒号前空格）不进违规列表。
2. flow 映射 `- {name: build, run: exit 1, continue-on-error: true}` —— 键既不在行首也不在行前。
3. 引号键 `"continue-on-error": true` —— YAML 解析成同一个键。
4. 转义键 `"continue\u002don-error": true` —— 双引号里的 `\u002d` 解码就是 `-`。
5. `\UXXXXXXXX`（8 位）同样能拼出同一个键。

于是判定改成：**先扫出候选键、把 double-quoted 里的转义解码成真实键名，再与判据要的键名比字符串**。
位置、引号、转义三个维度因此一起消失，剩下的只有「键名拼写」这一件事。
只解 `\uXXXX`、`\UXXXXXXXX`、`\xXX` 与 `\0\n\t\"\\/`；超出 U+10FFFF 或落在代理区的码点原样保留
（真解析器会拒这份 workflow，这里只需不崩）。

**另一件必须一起说的是我自己改出来的第七次。** 第一版「先解码」是全文扫、引号允许跨行配对，
实测立刻炸在真仓库上：`verify.yml` 的 shell 片段 `if [ "$NOTES_SUPERSESSION_BASE" = "000…" ]; then`
里的 `"` 与后面某行的 `"` 被配成一对，**跨行吞掉十几行**，中间新插的 `continue-on-error: true`
一起消失 —— 判据看不见它。修法是把「一个键从这里开始」这条语法约束显式写出来：
引号必须**同行**闭合，键只能起于行首、空白、`{`、`,`、`-`。这不是补第 N 种写法，
而是承认「键从哪儿开始」本身是语法，不是拼写。

注释同理：`cancel-in-progress: ${{ … == 'pull_request' }} # 仅取消 PR` 的取消条件一个字没变，
剥掉行尾注释后必须照常通过；剥注释不得顺手放过额外表达式（`… || true # 看似合法` 仍判红）。

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

**④ 只解 `\uXXXX`，`\UXXXXXXXX` 与其它转义按「不认识」原样保留。**
最强的理由：`\U` 这种写法几乎没有作者会手写，为它写解码 + 码点范围检查是纯成本；
而「不认识的转义原样保留」听上去是个诚实的边界 —— 不猜就不会猜错。
否掉的原因：「解不出来」的后果是**放行**，正好与本文的默认拒绝相反。既然判定已经
承认「键名要按解析后的字符串比」，那少解一种会产生同一个键名的转义，就等于自己
留一个绕过口。码点超范围时保留原文是安全的（真解析器会拒那份 workflow），
但「合法且等价」的转义必须解 —— 这两件事的差别是方向，不是风格。

**⑤ 继续按字面量列举键的写法（含引号、flow、`\u`），不加「解码」这一层。**
最强的理由：不改判据形状，零新概念，也不需要解释「为什么键名要先解码」；
补一个正则比加一个函数更容易被别人看懂和改动。
否掉的原因：同一类缺陷在一天里已经现形五次（见 Decision 里的清单），每次都是
「下一种没列到的写法」。列表永远比语法短，而漏列的方向是放行。

`cancel-in-progress` 那条也有同一族的病（键绑定「行首、无引号、块映射」），
在同一轮一并改成「只取值、不看键的写法」：`cancelInProgressValues()` 全篇取值，
逐个与允许值比对。这样两条判据的失效面收敛成同一个：**只剩键名拼写**。

### 判据不能只会「更严」：两个预测过的假红方向已修

收紧判据的第一步总要问「这样会不会把合法写法也判红」。本文预测过两处，当时写着
「偏向失败，可接受」，后来发现它们不是纸面风险 —— 都是真会让人被迫改写仓库的假红：

1. `run:` 里的 shell 字符串 `echo "log continue-on-error: 文本"` 会被当成真键而判红。
   修法是 `insideQuotedScalar()`：只数**本行**前缀里未转义的引号，奇数即视为在字符串里。
   判据刻意做得浅（不解析 YAML），拿不准时仍然判红，方向不变。
2. flow 映射 `concurrency: {group: x, cancel-in-progress: ${{ … }}}` 里，值后面还跟着
   `, group: x`；原先整行取值后与允许值比 ⇒ 合法写法被判红。修法是 `firstScalarValue()`
   只取第一个完整标量（有 `${{` 时取到配对 `}}`）。同一处还补了 `concurrencyBlock()`
   对 flow 写法的识别，否则连 `has-concurrency` 都会判「没有 concurrency 块」。

**顺带记一条关于用例自己的教训。** 第一版「字符串里的键不算键」用例写的是
`run: echo "continue-on-error: 文本"` —— 键紧贴引号，`YAML_KEY_ENTRY` 的键起边界
根本不匹配它，于是**把判据里的豁免注释掉，这条用例照样绿**。是「跑一遍变异看它红不红」
把它揪出来的：改写成 `echo "log continue-on-error: 文本"`（键前先是空白）之后变异才红。
这正是「用例看着在测，其实测的是恒真」的形态 —— 纸面上有断言，判别力是零。

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

- `node --test tools/ci-alignment.test.mjs` ⇒ `40 / pass 40 / fail 0`（含转义键、`\U` 转义键、
  行尾注释、跨行引号不许吞键、字符串内的键不判红、flow 映射六组）。
- **真故障注入**（六条，都已还原）：
  1. 判据换回「列举 true 各写法」的旧正则 ⇒ `pass 28 / fail 4`，红的四条正是
     continue-on-error 相关的四条（含表达式用例）。
  2. 把扫描式换回「全文扫、引号可跨行」的旧实现 ⇒ `pass 35 / fail 1`，红的正是
     「任何一步加 continue-on-error 必须变红（门禁不许被静默降级）」—— 即真仓库里
     插进去的那个键被跨行引号吞掉。这条证明「同行闭合 + 键起边界」不是多余的收紧。
  3. 让 `decodeYamlQuoted()` 变成恒等函数 ⇒ `pass 35 / fail 1`，红的正是
     「YAML 转义键（`\u002d` 解码成连字符）与裸键是同一个键」。
  4. 去掉 `stripInlineComment()`（改回直接 trim）⇒ 带行尾注释的合法条件被判红，
     红的正是「合法取消表达式后面的行尾注释不算改条件」。
  5. 把 `insideQuotedScalar()` 的豁免短路掉 ⇒ 红的正是「字符串里的「键」不算键」。
     **第一次跑这条变异时它没红**（用例构造让键紧贴引号，压根不匹配），改构造后才红 ——
     这一步本身就是「用例必须有判别力」的证据。
  6. 把 `concurrencyBlock()` 的 flow 分支短路掉 ⇒ 红的正是
     「flow 映射里合法的 cancel-in-progress 不许被尾巴上的别的键带红」。
  还原后 `40 / 40`，且 `grep -c MUTANT` 为 `0`（无残留变异）。
- 真实仓库此刻仍全绿：`node tools/ci-alignment.mjs` ⇒ 三道全过、`14 条 CI 安全属性均未被删改`。

补充（同日）：`tools/version-notice.test.mjs` 里那条「判据只有一处」原来只直接调
`isVersion`，没跑子进程也没写文件 —— 按 `tools/**` 的口径这算没验证到真实路径
（CodeRabbit 在 PR #30 上指出的是这一点，Minor 但成立）。已补一条端到端用例：
起真 node 子进程、读写真状态文件，走「首次挂载 → 版本没变 → 真升级 → 再挂载」四步，
断言提示只在升级那一次出现、标签在那一刻多一个「已更新」。
真故障注入（让 `buildVersionChangeHint` 恒返回 `undefined`）⇒ 4 条红，含该端到端用例。

相关笔记：[`./2026-10-22-single-form-matching-and-second-source-of-truth.md`](./2026-10-22-single-form-matching-and-second-source-of-truth.md)
（同一批缺陷的第一版修法，本文更正其中「列举等价写法」那半边）。
