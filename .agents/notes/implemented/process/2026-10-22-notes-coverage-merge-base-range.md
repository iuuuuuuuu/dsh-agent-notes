# Agent Note: 覆盖门禁增加 `--since`，让下游 CI 能真的接上

Status: implemented

> 承接 [笔记覆盖门禁](./2026-10-18-notes-coverage-gate.md)。
> 那篇把「改了受管文件却没写笔记」变成机械可查，但**没解决「怎么在别人的仓库里接上」**：
> 它的 `--range A..B` 是字面区间，接 CI 就会去查历史欠账。

## Problem

`tools/notes-coverage.mjs` 原来只有两个入口：暂存区（本地 `commit-msg` 钩子）与 `--range A..B`。
`--range` 的本义是「git 怎么解释就怎么查」，所以 CI 里传 `origin/main..HEAD` 时**会把分支上的
老提交一起查**。真实形态是这样的：

一个跑了半年的仓库，历史里有几十个「改了代码、当时还没有这道门禁」的提交。
接上 CI 的第一天，门禁红在那些提交上 —— 那些红**改不动**（要补几十篇笔记，且补了也不是当时的判断），
也**拦不住**任何东西（它们已经进了历史）。这种红的结局是确定的：有人加 `--no-verify`、
有人把这一步从 CI 里删掉，门禁等于没装。

实现在 `WorkbuddySwitchAPi` 的工作树 `wt-port` 上验证过：`--range` 全历史必红，
而当时**没有任何**入口能表达「只查这次 PR 自己带来的提交」。

## Decision

`tools/notes-coverage.mjs` 增加 `--since <base-ref>`：

1. 先 `git merge-base <base-ref> HEAD` 求分叉点，再只查 `<分叉点>..HEAD`（仍逐个提交判定）；
2. **分叉点求不出来一律退出 2 并说明原因** —— 不是 git 仓库、base-ref 不存在（force-push 后
   分支没了）、浅克隆缺对象、空仓库 HEAD 未诞生。不静默退化成全历史，也不退化成绿；
3. `--since` 缺值（漏了、空串、下一个参数是另一个开关）→ 退出 2，**不退回暂存区模式**；
4. `--since` 与 `--range`（或 `NOTES_COVERAGE_BASE`）同时给 → 退出 2，不替调用者挑一个;
5. `--range` 的行为一字不改，与 `--since` 的区别写进脚本头的用法段。

## Alternatives considered

- **继续用 `--range`，让下游自己算好分叉点再传** —— 最强理由是「工具不猜」：调用者最清楚
  该查哪一段，工具只做字面执行，语义简单、没有隐藏行为。**否掉因为它把最容易错的一步留给了
  每个调用者**：`merge-base` 要在 CI 里先取到 `base.sha`、还要处理浅克隆与 force-push，
  每个仓库都要抄一遍这段 shell，抄错的形式恰好是「区间取成 `HEAD..HEAD`」—— 那会**静默变绿**。
  工具自己做这件事时，失败路径只有一处，且能被测试钉住。
- **分叉点求不出来时退化成查全历史** —— 「宁可多查」。**否掉因为它把一种明确的环境问题
  变成了几十条改不动的红**，而人看到无法修的红只会关掉门禁。反过来「退化成绿」更糟，
  所以只剩「报错退出」这一条路。
- **用 `git rev-list --since=<date>` 按时间取** —— 一行就能写。**否掉因为时间是会撒谎的**：
  rebase / cherry-pick / 时区 / 本机时钟漂移都会让「最近 7 天」既可能漏掉刚改的提交，
  也可能把别人的老提交卷进来 —— 而漏掉的那一半是**静默**的。
- **默认基准取 `origin/main`，不给就自动用** —— 用起来最省事。**否掉因为默认值会掩盖配错**：
  下游的分支模型不一定是 `main`（`wt-port` 的工作树里 `main` 反而是发布分支），
  猜错基准等于查错区间还报告通过。显式传、缺了就红，是这里唯一安全的形态。

## Consequences

收益：

- 下游可以一条命令接上：`node .agents/notes-scripts/notes-coverage.mjs --since origin/main`，
  只查本 PR 的提交，历史欠账不进视野。
- 失败面收敛到一处：环境问题（浅克隆 / force-push / 跑错目录）都以退出码 2 明确报出来，
  不会再出现「看着绿其实什么都没查」。

代价 / 边界：

- CI 需要能取到分叉点：`actions/checkout` 默认 `fetch-depth: 1` 的浅克隆会**红**（这是刻意的，
  但要写进下游的接入说明 —— 需要 `fetch-depth: 0` 或至少 fetch 到 base）。
- 多分叉点（criss-cross 历史）时取 `merge-base` 的第一行，区间可能略宽，方向是宁可多查。
- 「逐个提交判定」意味着一次 PR 里多个提交不能互相顶账；这是既有语义，`--since` 继承它。
- 本插件自己不用 `--since`（它用暂存区模式），所以这条路径的日常曝光只有测试 ——
  这也是它必须带真 git 临时仓库用例的原因。

## Verification

```sh
node --test tools/notes-coverage.test.mjs
# tests 31 / pass 31 / fail 0        (exit 0)

node tools/notes-coverage.mjs
# 笔记覆盖门禁通过（暂存区）：改动未命中受管路径，无需笔记。   (exit 0，默认行为未变)
```

新增 7 条用例：分叉点后有代码无笔记必须红；带笔记即绿且同一仓库的字面全历史区间仍红；
分叉点后无改动必须绿；base-ref 不存在退出 2；非 git 目录退出 2；缺值/与 `--range` 冲突退出 2；
一提交的笔记不能替另一提交顶账。全部用 `mkdtemp` + 真 `git init` 建临时仓库。

真故障注入（把 `resolveMergeBase` 的返回值换成 `HEAD`，等于查空区间）：

```
tests 31 / pass 28 / fail 3
✖ --since: 分叉点之后有代码改动无笔记 → 必须红
✖ --since: 本 PR 带笔记即绿；字面全历史区间在同一仓库仍红
✖ --since: 仍然逐个提交判定，一个提交的笔记不能替另一个顶账
```

还原后 md5 `0cce40dd7702d596aa4b486f0c6b7489`，复跑 31/31 绿。

**这次故障注入留下了一个真实教训**：注入是并行 teammate 做的，它把改坏的版本留在了工作区
（`resolveMergeBase` 里多一行 `if (sha !== '') return { ok: true, sha: 'HEAD' };` 加一条
`FAULT-INJECTION-M2` 注释），随后自身中断、没跑还原。表现就是本文件开头那种
「3 条 `--since` 用例红」。**恢复不能靠执行者自述，要靠 `git diff` 复核**：本轮是 lead 读
diff 时看到那行注释才发现，而不是靠谁的汇报。教训已并入
[故障注入清单必须与磁盘对账](./2026-10-21-fault-injection-list-must-reconcile-with-disk.md) 的口径。
