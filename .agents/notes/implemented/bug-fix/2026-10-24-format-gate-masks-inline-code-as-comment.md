# Agent Note: 格式门禁把行内代码里的 HTML 注释当成真注释

Status: implemented

> 来自真实项目（`sourin-flutter-spike`，2026-10-22）的实测缺陷。那边自己改了
> 一份脚本来绕过；本插件此前只补了一句**解释**（`explainMaskedCommentSections`），
> 结论仍然是红。本篇把它真正修掉。
> 同一份笔记在那边记录的分析见该仓库
> `.agents/notes/implemented/bug-fix/2026-10-22-note-format-gate-masks-inline-code.md`。
> 与 [2026-10-24-lifecycle-root-guides-are-not-layout-errors.md](2026-10-24-lifecycle-root-guides-are-not-layout-errors.md)
> 同属「插件比上游更严/更错，把合法输入判红」这一族。

## Problem

vendored 的格式门禁在 `maskSource()` 里这样判定注释边界：

```ts
const openIdx = inComment ? -1 : l.indexOf("<!--");
const closeIdx = l.indexOf("-->");
```

它扫的是**原始行文本**。于是一篇**必须**写出 `<!--` 才能说明问题的笔记
（比如记录「HTML 注释会吞掉后续内容」这一事实），只要那串字符出现在
**行内代码**里、且同行没有 `-->`，状态机就会认为注释从这一行开始，
一路吃到文末 ⇒ 后面所有 `## Consequences` 之类的标题都落在「注释区」，
被判成非散文行 ⇒ 报 `missing one of ["## Consequences", …]`。

**而那一节明明就在文件里。** 作者的第一反应只会是「再补一个同名小节」——
还是红；最后只能去删掉笔记里的 `<!--`，也就是**销毁证据来迁就工具**。

本仓库此前只加了 `explainMaskedCommentSections()`：在已经判红之后补一句
「第 N 行有未闭合的 `<!--`，上面缺小节很可能是假象」。那是**诊断**，
不是修复 —— 结论仍然是红，作者仍要改笔记。

实测（`node tools/verify-notes.mjs --root <flutter 仓库>`）：
那边 154 篇笔记里有 2 篇因此被判红，而它们用自己修过的副本跑是绿的。

## Decision

在**执行期的临时副本**上给 vendored 的 `maskSource()` 打补丁，磁盘上的
vendored 文件保持逐字节不变（哈希门禁照旧通过）。

补丁做两件事：

1. 扫注释开头前先把**行内代码抹成等长空格**（`blankInlineCode`）——
   反引号里的 `<!--` 是展示语法，不该改变状态机；等长是为了让
   `indexOf` 的先后比较仍然成立。
2. 已经在注释里时，找结尾 `-->` **仍用原始行** —— 注释内部反引号没有
   Markdown 语义，若用遮蔽后的文本去找，恰好写在行内代码里的 `-->`
   会被抹掉，注释一路吃到文末（这条是补丁 A 若照搬会引入的回归）。

`must`：**锚点对不上必须大声告警，不许静默降级。** `prepareScriptForExecution()`
打完补丁会检查 `missed`；非空时往 stderr 写一条「vendored 补丁未命中……
行内代码里的 `<!--` 会再次被当成 HTML 注释」。上游改了这段代码时，
缺陷会原样回来，而人若只看到门禁照常输出，会以为它还修着。

`must`：**补丁只碰注释蒙版这一段状态机**，不动任何判据（缺哪些小节、
禁哪些标题）。判据仍只有上游那一处真相。

## Alternatives considered

- **继续只给解释、不改结论**（维持 `explainMaskedCommentSections`）— **这是本篇最强的一条被否方案**。理由很实在：不动 vendored、不引入补丁机制、零风险，而且解释已经把「缺小节是假象」说清楚了。**否掉因为它把成本转嫁给写笔记的人**：门禁红着，CI 就红；作者只有两条路 —— 删掉笔记里的 `<!--`（销毁证据），或者去改门禁脚本（分叉）。一个**要求你销毁证据才能通过**的门禁，比没有门禁更糟。
- **手改 `skills/agent-notes/scripts/verify-agent-note-format.ts`** — 最直接，改完就生效。**否掉因为它跨过本仓库自己的红线**：AGENTS.md 硬约束 3 明确禁止手改 vendored，`verify-plugin.mjs` 的哈希比对会拦。更重要的是下次 `sync-upstream` 会把改动覆盖掉，缺陷静默复活。
- **把格式检查整体复制进 `lib/`，绕开 vendored** — 一步到位，还能顺手改别的判据。**否掉因为那是两份真相**：上游的判据（缺哪些小节、禁哪些标题）会与本地的渐渐漂移，而这类漂移最难发现 —— 两边都「有道理」，只是答案不同。
- **向上游提 issue / PR** — 最干净。**本轮做不到**：本仓库只固定引用上游某个 commit，没有可用的反馈通道；而且缺陷正在造成实际损失，等不了。
- **在笔记里要求把 `<!--` 写成 `&lt;!--`** — 零代码改动。**否掉因为那是让作者为工具的缺陷改事实**：笔记里写的是「这里有多少个字符」，转义之后读者复制到的就不是原文了。

## Consequences

- **收益**：行内代码里的注释标记不再伪造「缺小节」。实测同一个真实仓库从
  `format exit=1`（2 篇假红）变成 `exit=0`（154 篇全绿），与它自己修过的副本结论一致。
- **收益**：`explainMaskedCommentSections()` 保留 —— 现在它只在**真的**有未闭合
  注释时说话，那时它是准的。
- **代价与已知上限**：**补丁锚点会随上游漂移**。上游改了 `maskSource()` 的实现，
  补丁就打不上 —— 已用「`missed` 非空 ⇒ stderr 告警」把这种失效变成可见事件，
  但它仍然需要人去更新锚点。这是本轮明确接受的代价。
- **代价与已知上限**：格式门禁现在**总是**复制到临时目录再执行（其余门禁仍按原路径）。
  多一次目录复制，可忽略；但也意味着「执行的就是磁盘上那份」这条直觉在格式门禁上不成立
  —— 已在 `prepareScriptForExecution` 的注释里写明。
- **代价与已知上限**：补丁实现里不能再用模板字符串拼源码（反引号与 HTML 注释字面量
  会打架，实测直接让模块解析失败），只能用单引号数组拼。这会让补丁源码读起来更笨重。
- **重访信号**：
  - 上游修好了 `maskSource()` → **删掉这条补丁与它的用例**，`VENDORED_PATCHES` 清空。
  - 上游改了函数名/结构 → `missed` 会告警；据告警更新锚点或删补丁。
  - 出现第二条需要打补丁的脚本 → 先评估能不能靠「解释」解决；补丁越多，漂移风险越大。

## Verification

```sh
node --test tools/plugin.test.mjs            # 19 tests / 19 pass
node --test tools/verify-notes-standalone.test.mjs  # 10 tests / 10 pass
```

新增 3 条（`tools/plugin.test.mjs`，全部走**真子进程**）：

1. **行内代码里的 `<!--` 不得开注释**：造一篇含 `` `<!--` `` 且小节齐全的笔记，
   断言 `runGate('format')` 通过；同时断言磁盘上的 vendored 源码**仍然**是
   未打补丁的样子（`l.indexOf("<!--")` 还在）—— 证明绿是补丁带来的。
2. **对照组**：正文里真的开了一个不闭合的注释时，`## Consequences` 仍应被判成
   注释内、仍然红 —— 补丁不许把真正的遮罩一起放宽。
3. **锚点漂移必须报 missed**：拿真实源码打（两处都命中），再用一段改过的源码打
   （两处都 miss），断言 `missed.length === 2`。

**真变异**：让 `needsPatchCopy()` 恒假（等于关掉补丁）⇒ 第 1 条变红
（`pass 0 / fail 1`）；还原后 19/19。

**真实项目验证**：`node tools/verify-notes.mjs --root <sourin-flutter-spike>` ——
修复前 `format exit=1`（2 篇假红），修复后三条门禁全绿、154 篇笔记。
