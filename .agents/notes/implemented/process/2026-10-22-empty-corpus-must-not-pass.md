# Agent Note: 空语料不得当绿 —— 两道门禁补上自己的空集合守卫

Status: implemented

> 承接[门禁的语料不得被悄悄收窄](../process/2026-10-22-gate-corpus-must-not-narrow.md)：
> 那篇管「语料被改小了」，本篇管**语料被清空了**这一极端形态。
> 与[三道 vendored 门禁在空集合上是绿的](../testing/2026-10-22-vendored-gates-are-vacuous-on-empty-tree.md)
> 是同一类失效在另一个位置的对照：那边是「**判据本身没人钉**」，
> 这边是「**判据被测试钉成了错误答案**」。

## Problem

`tools/md-links.mjs` 与 `tools/text-integrity.mjs` 在**语料为空**时都 `exit 0`。
这不是推测，是实测（第三轮穷尽核对的探针记录在 `.probe/probe-gaps/findings-3.md`）：

| 门禁 | 语料 | 空语料时的行为 |
|---|---|---|
| `md-links` | `collectDocuments(root)` | 遍历一次都不进 → `errors` 恒空 → exit 0 |
| `text-integrity` | `collectFiles(root)` | 同上 → exit 0 |

**「一条链接都没检查过」与「链接全部可达」在退出码上完全一样。**
这不是理论可能：`collectDocuments` 读的是磁盘目录树，只要根下什么都没扫到
（路径写错、在错误目录里跑、扩展名后缀全被改掉），门禁就会安静地报告「通过」。

更糟的是 `text-integrity` 这一侧**原先有测试，而测试断言的是相反的答案**：

```js
test('text: 空仓库通过（但 checked 为 0，不算有意义的绿）', () => {
  const result = inSandbox({});
  assert.equal(result.ok, true, '空仓库不该报错');
  assert.equal(result.checked, 0, '但 checked 为 0 —— 这不是有意义的通过');
});
```

这段代码的意图是「把假绿记录下来，避免它冒充成有效覆盖」。
但它写成 `assert.equal(result.ok, true)`，实际效果是
**把这个门禁会放行空语料这件事，钉成了期望行为** ——
后来任何人删掉判据，这条用例会红，而且红的信息是
「空仓库不该报错」。假绿从「隐患」升级成「契约」。

`md-links` 侧更彻底：连用例都没有。

对照：本仓库早就有正确范式。`tools/doc-refs.mjs:364-365` 判的是
「没有扫到任何 `docs/` 或 `.agents/notes/` 文档：空集合不得当绿」；
`tools/bilingual-links.mjs:124-130` 的注释也写了同一个道理：
「空集合上没有指错语言的链是恒真命题」。这两处都不是在教别人，
是各自在自己那道门禁里已经付过代价。

## Decision

给两道门禁各补一条**自己的**空集合守卫，并把那条钉错方向的用例改写过来。

**判据**（`tools/md-links.mjs:186`）：

```js
if (documents.length === 0) errors.push('没有扫到任何 Markdown 文档：空集合不得当绿');
```

**判据**（`tools/text-integrity.mjs:146`）：

```js
if (files.length === 0) errors.push('没有扫到任何文本文件：空集合不得当绿');
```

措辞与 `tools/doc-refs.mjs:364-365` 同族，都是把「空集合不得当绿」写进错误文本，
让人在日志里一眼看出是哪一类失效。

**为了让测试能驱动真实收集函数**，把 `tools/md-links.mjs:75` 的
`collectDocuments` 由内部函数改为导出，**签名不变**
（仍收一个 root、仍返回 `string[]`）。`tools/corpus-floor.mjs:66/111`
已经 import 并使用它，导出它不改变任何现有调用。

**用例**（每条都是负例 + 正例成对）：

- `tools/md-links.test.mjs` 新增 2 条：
  「空语料必须判失败」用 `mkdtempSync` 造**真实空目录**驱动真实 `collectDocuments`，
  **不 mock 收集函数**（mock 掉就变成在验「我传给判据的东西」而不是「判据会不会响」），
  并先断言 `collectDocuments(root)` 深度等于 `[]` 作为前置条件；
  「语料恢复后必须重新判绿」用**同一对调用**先证红、再写入文档、断言转绿 ——
  只有负例时，「永远红」也能让负例通过。
- `tools/text-integrity.test.mjs` 改写 1 条 + 新增 1 条：
  原「空仓库通过（但 checked 为 0…）」改写为「空仓库必须判失败（空集合不得当绿）」；
  另加「只有非目标后缀的文件也算空语料」—— 只放 `notes.txt` 与 `data.bin`，
  证明「目录非空」不等于「语料非空」（改掉 `EXTENSIONS` 会得到同样的假绿）。

退出码沿用本仓库惯例：判定不通过 = 1，无法判定 = 2。
本轮两项都是「判定不通过」，走既有 `process.exit(1)` 路径，**没有新增退出码分支**。

## Alternatives considered

- **保留旧用例、只加一条新判据**：旧用例断言 `ok === true`，
  新判据会让它红，于是「改旧用例」变成「改测试让门禁变绿」——
  这正是最该避免的动作。仍然否决：本轮**就是要收回这条错误期望**。
  旧用例的名字（「不算有意义的绿」）和它的断言（「不该报错」）
  自相矛盾：它想标记假绿，实际却把假绿批准为行为。
  改写它不是「把测试改成迎合实现」，是**把测试的意图还原成它自己声明的意图** ——
  名字说的是「空仓库不是有意义的通过」，断言说的却是「空仓库通过」。
  一条测试只能有一种承诺，现在它承诺的是后者。
- **不写判据，改成在 `docs/known-gaps.md` 里登记「空集合恒绿是已知取舍」**：
  登记成本最低，且不产生任何代码改动。仍然否决：这条失效的**触发条件是真实的**
  ——删掉 `docs/` 与 `.agents/notes/` 后 `md-links` 仍有 3 篇顶层文档（非空，
  所以 `corpus-floor` 的区域对账抓不到它），而把根下文档删光时
  `md-links` 与 `text-integrity` 都会安静通过。登记一个「真实存在、且没有任何
  其他门禁覆盖」的失效，等于把门禁的沉默合法化。
  对照[三道 vendored 门禁在空集合上是绿的](../testing/2026-10-22-vendored-gates-are-vacuous-on-empty-tree.md)：
  那边的空集合行为**是设计意图**（外壳专门拦它），所以值得登记成事实；
  这边不是。
- **把「语料不得为空」统一交给 `tools/corpus-floor.mjs`**（横向对账那道门禁）：
  那是更自然的落点 —— 它本就是「语料覆盖面」的门禁，
  而且它**已经登记**了 `md-links` 与 `text-integrity`。
  仍然否决，两条理由：
  ①`corpus-floor` 的判据是**区域对账 + 数量下限**，
  它判的是「该看的区域还在不在」；若 `collectDocuments` 被改成恒返回 `[]`，
  `corpus-floor` 只会报「docs 区域缺失」，
  **不会报「`md-links` 自己不再检查任何东西」**。这两句话不是一回事：
  前者是覆盖面问题，后者是**门禁自身的契约**。让 A 门禁替 B 门禁担保正确性，
  会在 A 出问题时把 B 一起拖下水。
  ②覆盖面与「空不空」是**两个独立的失效面**：
  语料从 106 篇缩到 3 篇（非空）时 `corpus-floor` 响，空语料时本轮这两行响。
  两道门禁互补，合起来才覆盖两个形态；只留一道就少一半。
- **判据写成「语料少于 N 个文件就红」**：能顺便抓「语料被收窄」。仍然否决：
  `corpus-floor` 已经用「区域 + 数量下限」在做这件事，且它带「下限必须写理由」
  的机制。再加一条数字阈值会与它打架，且数字会随仓库长大而失效
  （要改就容易被人随手改小）。
- **只修 `text-integrity`、不修 `md-links`**：因为 `md-links` 的语料更不容易为空。
  仍然否决：两者的失效形态完全同构（遍历一个可能为空的收集结果），
  只修一半会让下一个人以为另一半不需要修。

## Consequences

- **收益**：两道门禁在语料为空时都会红，且错误文本点明「空集合不得当绿」。
  「一个字节都没检查过」不再与「所有字节都完好」共用同一个退出码。
- **收益**：旧用例那句 `assert.equal(result.ok, true, '空仓库不该报错')`
  被收回。`text-integrity` 的测试不再**主动批准**假绿。
- **收益**：`collectDocuments` 变成导出函数后，测试能直接断言
  「收集函数确实扫到了什么」，而不必靠 `checked` 数字反推。
- **代价**：两处判据各 1 行，两处测试共 3 条用例；不引依赖、不改 CI、
  不新增 npm 脚本、不改任何现有调用方（`collectDocuments` 只多了 `export` 关键字）。
- **代价与已知边界**：本轮只保证「语料为空时判红」。
  **「语料被收窄到 1 篇但仍非空」不在本轮范围** —— 那是
  [门禁的语料不得被悄悄收窄](../process/2026-10-22-gate-corpus-must-not-narrow.md)
  的职责，本篇不重复实现它。
- **已知边界**：判据只在「扫到 0 个文件」时触发。本仓库正常状态下语料是
  106 篇 / 208 个文件，距触发条件差两个数量级，误报风险接近零。
- **已知边界**：新增的「语料恢复后必须重新判绿」那条正例只覆盖
  「有语料且链接全可达」这一种恢复方式；它证明的是**判据不是恒红**，
  不是「任何恢复方式都会转绿」。

## Verification

真实仓库：

```sh
node --test tools/md-links.test.mjs       # tests 19 / pass 19 / fail 0   exit 0
node --test tools/text-integrity.test.mjs # tests  9 / pass  9 / fail 0   exit 0
npm run md:links                           # exit 0
#   Markdown 链接校验通过：106 个文档、233 条相对链接全部可达。
npm run text:integrity                     # exit 0
#   文本完整性通过：208 个文件无替换字符与裸控制字符。
node tools/corpus-floor.mjs                # exit 0
#   语料下限通过：5 道门禁的语料都仍覆盖各自应有的区域，且不低于记录的下限。
node tools/eol.mjs                         # exit 0
#   结尾换行通过：201 个文本文件都以恰好一个换行结尾（语料来源：git ls-files）。
npm test                                   # tests 541 / pass 541 / fail 0   exit 0
```

**真故障注入**（副本 `.probe/probe-gaps/ggh` = `git clone --no-hardlinks` @ `3d14b50`，
`node_modules` 用 junction symlink 指向真仓库；真实仓库全程零变异）：

| 变异 | 注入位置 | 结果 |
|---|---|---|
| M1 | `tools/md-links.mjs` 的 `if (documents.length === 0) errors.push(` → `if (false) errors.push(` | `node --test tools/md-links.test.mjs` → **exit 1**，tests 19 / pass 17 / **fail 2**，红的是「空语料必须判失败（空集合不得当绿）」与「语料恢复后必须重新判绿（证明空集合判据不是恒红）」 |
| M2 | `tools/text-integrity.mjs` 的 `if (files.length === 0) errors.push(` → `if (false) errors.push(` | `node --test tools/text-integrity.test.mjs` → **exit 1**，tests 9 / pass 7 / **fail 2**，红的是「空仓库必须判失败（空集合不得当绿）」与「只有非目标后缀的文件也算空语料（不得当绿）」 |

两次注入都没波及无关用例（19→2 fail、9→2 fail），
且红的正是新加/改写的空集合用例，语料与链接相关用例仍绿。

**还原确认**（两次注入各自从副本内的 `*.orig` 备份还原）：

```
cmp tools/md-links.mjs       md-links.mjs.orig            → RESTORE_BYTE_IDENTICAL
cmp tools/md-links.mjs       <真仓库>/tools/md-links.mjs   → MATCHES_REAL_REPO
cmp tools/text-integrity.mjs text-integrity.mjs.orig        → RESTORE_BYTE_IDENTICAL
cmp tools/text-integrity.mjs <真仓库>/tools/text-integrity.mjs → MATCHES_REAL_REPO
```

还原后复跑：`md-links` exit 0 / 19 pass 0 fail；`text-integrity` exit 0 / 9 pass 0 fail。
副本里不留任何变异。

**行尾**：四个文件 CRLF 计数实测均为 0，且都以**恰好一个** `\n` 结尾
（`tools/text-integrity.mjs` 原本缺尾换行，本轮顺带补上，`tools/eol.mjs` 通过）。

这些是离线回归结果，不是实机验证，也不是「上游对齐已完成」的结论。
