# Agent Note: 格式门禁报「缺小节」时，真实成因可能是未闭合的 HTML 注释

Status: implemented

- 日期：2026-10-22
- 适用：`lib/notes.js`（`runGate` / `explainMaskedCommentSections`）、`tools/masked-comment-hint.test.mjs`

与 [../testing/2026-10-22-vendored-gates-are-vacuous-on-empty-tree.md](../testing/2026-10-22-vendored-gates-are-vacuous-on-empty-tree.md)
同一族问题的另一面：那篇讲「门禁在空集合上恒绿」，本篇讲「门禁判红了，但说的是错的原因」。
两篇都保留 —— 前者是漏判，后者是误判方向，修法不同。

## Problem

真实事故（2026-10-22，`D:\WishProject\sourin-flutter-spike`，一篇 implemented 笔记）：

```text
format: implemented/bug-fix/2026-10-22-…md — missing one of ["## Consequences","## 后果",…]
```

可那篇的 `## Consequences` 标题**明明就在文件第 82 行**。

根因在 vendored 的蒙版逻辑（`maskSource`）：它把围栏外/注释内的行从「正文行」里剔掉，
再在正文行里找小节标题。而它判断 HTML 注释时**不区分字面量与真注释** ——
正文里只要出现一个未闭合的 `&lt;!--`（哪怕包在行内代码里），**它之后的每一行都被当成注释**，
于是后面所有小节标题一起「消失」。

这条误报的代价不是「多看一眼」，而是**把人推向改门禁**：
作者看到「缺 ## Consequences」的第一反应是再补一个小节 —— 依然是红，
因为补的那个也在注释区里；折腾两轮之后唯一的出路就是改校验脚本。
`docs/` 里那条「门禁要开箱即用、不要逼用户改脚本」的要求，正是被这种形态破坏的。

同一轮还查出第二个更隐蔽的缺陷：`AGENT_NOTE_ROOT` 只在 `archived` 分支里设置
（`runGate` 里 `if (gateName === 'archived')` 内），其它门禁**静默忽略**
`options.notesRoot`。实测：对着临时笔记树跑 `runGate('format', { notesRoot })`，
实际验的是当前仓库的 `.agents/notes` ⇒ 返回绿，而绿得毫无意义。
这类「参数被吞掉、结论却是绿的」比红更危险：写测试的人会以为自己在测临时树。

## Decision

两处都不改 vendored（`skills/agent-notes/` 是上游副本，手改会被哈希门禁拦），改插件自己的调用层：

```text
① 只在门禁**已经判红之后**追加一条成因提示：
   解析 stderr 里的 `format: <rel> — …`，读该文件，数字面量的 <!-- 与 --> 是否配平，
   不配平就追加「第 N 行有未闭合的 `<!--`（还差 M 处）……先补 `-->` 或改写成 `&lt;!--`」。
② `AGENT_NOTE_ROOT` 对所有门禁统一生效：
   在 `gateEnv` 建好后立刻算出 `gateNotesRoot` 并写进 `gateEnv`，
   archived 分支改为复用它（原来只有那里设置）。
```

关键是 ① 的**方向**：只在红的时候补充解释，**绝不改变红/绿结论**。
绿的时候一个字节都不加（有用例钉住）。

## Alternatives considered

**① 修 vendored 的 `maskSource`：区分行内代码与真注释。**
最强的理由：这才是根治 —— 报错本身就该是正确的，不该靠调用层「翻译」。
否掉的原因：`skills/agent-notes/` 是上游快照，任何手改都会被
`tools/verify-plugin.mjs` 的哈希比对拦下（那也是**对的**，否则「上游同步」名存实亡）。
正确的路径是改上游 B 再同步；在那之前，插件层能做的只有「别让读者被误导」。
另外真要根治，还得先决定「行内代码里的 `&lt;!--` 到底算不算注释」——
这在 Markdown 语义上没有唯一答案，属于要改判据的事，不该顺手改。

**② 在插件层直接把 `&lt;!--`/`-->` 配平后自动修复笔记文件。**
否掉的原因：门禁不是改写器。自动改历史笔记会伪造「这笔记一直是这样的」，
而且配平只是其中一种可疑写法（`-->` 也可能出现在正文里）。

**③ 不改，只在文档里写「正文别写 `&lt;!--`」。**
否掉的原因：这条规则**没有执行体**。本仓库已经吃过一次同样的亏 ——
「注释不该显示」那句话原本只写在门禁的注释里，于是它一直是假的
（见 `sourin-flutter-spike` 的 `2026-10-22-release-notes-renderer-shows-markup-as-text.md`）。
写在文档里的约束，等于没有约束。

## Consequences

收益：

- 「缺小节」这条报错从此自带成因：作者不用去猜、不用去改脚本。
- `runGate(gate, { notesRoot })` 对所有门禁一致生效 ⇒ 针对临时树写回归才真的在测临时树。
  这条是**新回归能成立的前提**：`tools/masked-comment-hint.test.mjs` 的后两条用例
  正是靠它才能真跑 vendored 脚本验临时树。

代价：

- 插件层多了一份「注释配平」的判断，与 vendored 的蒙版逻辑**语义相近但不同源**。
  接受的理由：它不是判据，只是**解释器** —— 判红仍是 vendored 说了算，
  这里错了最多是少一句提示或多一句提示，不会产生假绿。
- 计数法（数 `&lt;!--` 与 `-->`）对「同一行里错序配对」这类写法不精确；
  它只用来定位**第一处**未闭合起点，够用，但不追求完备。
- `AGENT_NOTE_ROOT` 统一生效后，任何此前依赖「传了 notesRoot 也被忽略」的代码
  行为会变。实测本仓库无此依赖（改完全量绿）。

## Verification

- 新增 `tools/masked-comment-hint.test.mjs`：`node --test tools/masked-comment-hint.test.mjs`
  ⇒ `pass 5 / fail 0`。五条分别是：无 `format:` 行不插话；指名行号；
  已闭合不误报；**真跑 vendored 门禁**时空注释判红且原报错保留；
  干净笔记必须绿且不带提示（补充逻辑不能把绿变红）。
- 真故障注入：把 `lib/notes.js` 里追加提示的那行改回 `result.stderr`
  ⇒ `pass 4 / fail 1`（红的正是「必须指名行号」那条）。
  还原后 `pass 5 / fail 0`。
- 无残留：注入前后 `lib/notes.js` 用备份逐字覆盖还原。
