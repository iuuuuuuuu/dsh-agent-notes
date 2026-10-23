# Agent Note: 取不到语料就必须红 —— 静默改用工作区遍历是换了道题

Status: implemented

> 承接[门禁的语料不得被悄悄收窄](../process/2026-10-22-gate-corpus-must-not-narrow.md)与
> [断言必须有能力失败](../testing/2026-10-23-assertions-must-be-able-to-fail.md)：
> 那两篇管「语料被改小」「断言测不到缺陷」，
> 本篇管第三种：**语料整个取不到时，门禁自己另找了一份语料**。

Independent: 本篇只改 `listTrackedFiles` 的失败口径与补一条空语料用例，
不动任何门禁判什么。

## Problem

`tools/eol.mjs` 的 `listTrackedFiles()` 原来在 `catch` 里**直接退回文件系统遍历**。
理由写在注释里：「本仓库只在 git 仓库里跑，但测试夹具可能不是」。这个理由只对夹具成立，
对真仓库是假绿：

- git 坏了（装了但报错）、索引坏了、目录权限变了、在 CI 里 checkout 出了半成品 ——
  任何一条都会让门禁**换一份语料**继续报「通过」；
- 换来的语料是**工作区内容**，含未跟踪文件，既不是入库内容，也没有人知道语料换了
  （`source: 'fs'` 只出现在绿行的括号里，读日志的人不会为一句话停下来）；
- `git ls-files` 返回空列表时更糟：它**不抛异常**，于是连「有错误」都不知道，
  直接掉进文件系统遍历。

这条是 CodeRabbit 在 PR #30 上指出的第 2 条发现。我当时在笔记里写了「已改为失败即红」，
但代码里的 `catch` 一直是原样 —— 记一笔不等于改了，本篇把两者对齐。

## Decision

1. `listTrackedFiles(root, { allowNonGit })`：git 失败时
   - **不带** `allowNonGit` → 返回 `{ files: [], source: 'git-error', gitError }`；
   - 带 `allowNonGit` → 才允许退回文件系统遍历（`source: 'fs'`）。
2. `git ls-files` 返回空列表时不再静默遍历：不带 `allowNonGit` 返回 `source: 'git-empty'`。
3. `verifyTrailingNewlines()` 把 `git-error` / `git-empty` 直接转成错误：
   前者说「拒绝改用工作区遍历，因为那会换掉语料」，后者说「空语料不得当绿」。
4. `tools/corpus-floor.mjs` 里 eol 那道语料的收集器显式传 `{ allowNonGit: true }`：
   它在测试夹具上必须还能工作；在真仓库上 git 正常，口径不变。

## Alternatives considered

**① 干脆删掉文件系统遍历，所有场景都要求 git。** 最强的备选：口径最干净，
「非 git 目录 = 判红」一句话就说完了。不选是因为真实的测试夹具确实不是 git 仓库
（`tools/corpus-floor.test.mjs` 的 `sandbox()` 只写文件、不 init），
而要给每个夹具加 `git init && git add && git commit` 会让十来个用例各自慢上一秒，
且与这些用例要测的东西（区域对账、数量下限）无关。

**② 保留回退，只把 `source` 打进失败输出让「看得见」。** 成本最低。
不选：`source` 已经出现在绿行里了，问题不是没打印，而是**打印了也算通过**。
看得见的降级仍然是降级。

**③ 让 `verifyTrailingNewlines` 在 `source === 'fs'` 时一律判红。** 这样连
夹具场景也保住了「必须 git」的强度。不选：那就等于方案 ① 从另一个方向实现，
夹具全部要造 git 仓库，代价同 ①。

**④ 只在 `root !== PACKAGE_ROOT` 时才允许回退**（按「是不是仓库本体」判）。
看起来最省事，但它把「谁是仓库本体」写成了路径常量 —— 换一个 clone 目录
（`--root` 指向别处、CI 的 workspace）时判据就静默失效，正是本仓库反复栽的那种
「按位置而不是按语义」的判据。

## Consequences

收益：

- 「取不到语料」有了明确出口：报错、`checked: 0`、不谎称检查过文件；
- 夹具需求通过**显式开关**表达，而不是靠 `catch` 兜底，读代码能看出谁要这份宽容；
- 空索引（真仓库里一条 tracked 文件都没有）从「静默遍历」变成「空语料不得当绿」。

代价（真实存在）：

- `allowNonGit: true` 是个**可以被真门禁误用**的开关：将来若有人在 CLI 路径上也传它，
  这道门禁就退回旧行为。目前只有 corpus-floor 的夹具收集器传它，用例也没锁死这一点；
- 用例只用「非 git 临时目录」验证 `git-error` 分支，没有模拟「git 装了但在真仓库里报错」
  （如索引损坏）—— 两者走的是同一条 `catch`，但严格说后者没有被实测覆盖；
- 新增两条用例都读 `source` 字段，字段改名会让它们一起失效（缺省值缺失时
  `assert.equal` 会红，属于能失败的一侧，可接受）。

## Verification

- `node tools/eol.mjs` → exit 0，`结尾换行通过：232 个文本文件都以恰好一个换行结尾（语料来源：git ls-files）`。
- `node tools/corpus-floor.mjs` → exit 0，`5 道门禁的语料都仍覆盖各自应有的区域`。
- `node --test tools/eol.test.mjs` → **12 tests / 12 pass**（原 10 条）；
  `node --test tools/corpus-floor.test.mjs` → **11 tests / 11 pass**（原 10 条）。
- 新增 `eol: git 取不到语料必须失败关闭`：非 git 目录 → `source: 'git-error'`、
  `checked: 0`、报错含「取不到已跟踪文件列表」，且**不报** `bad.md` 的文件级结果；
  阳性对照（同一个目录 + `allowNonGit: true`）确实报出 `bad.md`，证明前一条绿不是判据没跑。
- 新增 `eol: 空仓库必须红`：`git rm --cached` 后 `source: 'git-empty'`、报错含「空语料不得当绿」。
- 新增 `corpus: 语料为空必须红`：空夹具 → 5 道门禁各报一条「语料为空」。
- 真变异 1：`errors.push('语料为空…')` → `void 0` ⇒ 只有新用例红（10 pass / 1 fail），
  还原后 11/11。这条变异此前是**存活**的（一轮八变异普查里唯一没被抓住的那个）。
- 真变异 2：`catch` 里退回静默遍历 ⇒ 只有 `eol: git 取不到语料必须失败关闭` 红
  （11 pass / 1 fail），还原后 12/12，`grep -rn MUTANT tools lib` 无残留。
