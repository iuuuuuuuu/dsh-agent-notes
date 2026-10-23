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

1. `listTrackedFiles(root)`：**按 git 的报错判定**，不设开关 ——
   - stderr/message 里有 `not a git repository` → 退回文件系统遍历（`source: 'fs'`），
     这是唯一允许降级的状态，因为它是可判定的、稳定的、只有夹具才有的；
   - 其余任何失败（索引损坏、权限、git 半死）→ `{ files: [], source: 'git-error', gitError }`。
2. `git ls-files` 返回空列表 → `source: 'git-empty'`，不再静默遍历。
3. `verifyTrailingNewlines()` 把 `git-error` / `git-empty` 直接转成错误：
   前者说「拒绝改用工作区遍历，因为那会换掉语料」，后者说「空语料不得当绿」。
4. 「失败关闭」没有任何开关可以关掉 —— 早先一版用调用方传的 `allowNonGit: true`
   兜夹具，等于把「要不要失败关闭」交给调用方，已删。

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
- 夹具需求靠**可判定的信号**（`not a git repository`）满足，不是靠开关、也不是靠 `catch` 兜底；
- 空索引（真仓库里一条 tracked 文件都没有）从「静默遍历」变成「空语料不得当绿」。

代价（真实存在）：

- 判据依赖 git 的**报错文本**（`not a git repository`）。这不是契约，只是事实：
  git 换语种或改文案时，这条匹配会失效 —— 失效方向是「本来该放行的夹具被判红」，
  不是假绿，可接受；但它是唯一一处靠字符串匹配 git 输出的地方；
- 权限类故障（git 能跑但读不了自己的对象库）走的是 `git-error`，用例没覆盖到
  —— 覆盖的是索引损坏那条同类路径；
- 新增两条用例都读 `source` 字段，字段改名会让它们一起失效（缺省值缺失时
  `assert.equal` 会红，属于能失败的一侧，可接受）。

## Verification

- `node tools/eol.mjs` → exit 0，`结尾换行通过：232 个文本文件都以恰好一个换行结尾（语料来源：git ls-files）`。
- `node tools/corpus-floor.mjs` → exit 0，`5 道门禁的语料都仍覆盖各自应有的区域`。
- `node --test tools/eol.test.mjs` → **13 tests / 13 pass**（原 10 条）；
  `node --test tools/corpus-floor.test.mjs` → **11 tests / 11 pass**（原 10 条）。
- 新增 `eol: 真仓库里 git 坏了必须失败关闭`：`git init` 后把 `.git/index` 写成垃圾
  （`.git` 还在 ⇒ 不是「不是仓库」那种可放行情况）→ `source: 'git-error'`、`checked: 0`、
  报错含「取不到已跟踪文件列表」，且**不报** `bad.md` 的文件级结果。
- 新增 `eol: 目录不是 git 仓库时退回文件系统遍历`：同一份 `bad.md` 在非 git 目录里
  确实被扫到（`source: 'fs'`、`checked: 1`）—— 证明上一条的「不报 bad.md」不是判据整个没跑。
- 新增 `eol: 空仓库必须红`：`git rm --cached` 后 `source: 'git-empty'`、报错含「空语料不得当绿」。
- 新增 `corpus: 语料为空必须红`：空夹具 → 5 道门禁各报一条「语料为空」。
- 真变异 1：`errors.push('语料为空…')` → `void 0` ⇒ 只有新用例红（10 pass / 1 fail），
  还原后 11/11。这条变异此前是**存活**的（一轮八变异普查里唯一没被抓住的那个）。
- 真变异 2：把 `if (!/not a git repository/i.test(detail))` 改成 `if (false)`
  （等于恢复「无条件退回遍历」）⇒ 只有 `eol: 真仓库里 git 坏了必须失败关闭` 红
  （12 pass / 1 fail），还原后 13/13，`grep -c MUTANT tools/eol.mjs` 为 0。
