# Agent Note: 检查链里的工具必须走只读模式 —— 体检探针把仓库改了

Status: implemented

> 承接[fetch 之后 exit 会崩成 127](../bug-fix/2026-10-23-fetch-then-exit-crashes-with-127.md)与
> [门禁的语料不得被悄悄收窄](./2026-10-22-gate-corpus-must-not-narrow.md)：
> 那两篇管「门禁崩了却算绿」「语料被改小」，
> 本篇管另一种「检查时顺手改了仓库，而它照样 exit 0」。

Independent: 本篇只加一条「命令行用没用只读模式」的判据，
不改任何门禁判什么，也不改 CI 结构。

## Problem

2026-10-23 我为了看「每个 CLI 裸跑会输出什么」，把 `tools/` 下 16 个工具逐个
`node tools/x.mjs` 跑了一遍。其中两个**就地改了仓库**：

- `tools/bump-version.mjs` 把 `package.json` 的 `0.8.0` 改成 `0.8.1`；
- `tools/sync-upstream.mjs` 重写了 `upstream.json` 的 `syncedAt` 时间戳。

探针本身是我的操作失误（`git checkout --` 已还原，工作区复检干净）。但它暴露的
真问题不是「我不该裸跑」，而是：**`--check` 这种只读模式存在，用不用它全靠人记得。**

`package.json` 的 `check` 链里只要有人把 `node tools/notices.mjs --check` 写成
`node tools/notices.mjs`，那道「检查」就会一边检查一边重写 `THIRD_PARTY_NOTICES.md`，
而它**仍然 exit 0** —— CI 全绿，没人会知道门禁在改仓库。

这个失效面此前没有任何判据：`tools/ci-alignment.mjs` 只管「本地门禁在不在 CI 里」，
`tools/text-integrity.mjs` 只管字符，`tools/sync-upstream.test.mjs` 的零写入用例
只管 `sync-upstream` 一个工具。

## Decision

`tools/ci-alignment.mjs` 增加 `verifyReadOnlyChain()`，判据是：

1. 从 `check` / `check:full` 出发**递归展开** `npm run` 引用，收集每条
   `node tools/*.mjs` 命令行 —— 不手写「当前有哪几步」，加了新门禁自动纳管；
2. 若该工具源码**真的解析**了 `--check`（`.includes('--check')` 或 `=== '--check'`），
   命令行就必须带 `--check`；
3. 工具没有 `--check` 时不判 —— 它本来就只读，判了只是噪音。

输出的绿行写明条数（`check 链里 20 条工具命令都用了只读模式`），让「判据确实跑了」
可见，而不是只留一个沉默的 exit 0。

## Alternatives considered

**① 只把「别裸跑」写进文档／AGENTS.md。** 这是最强的备选：成本几乎为零，
而且这次事故的成因确实是我没记住。不选的理由是**文档不是判据** —— 本仓库的
历史反复证明「写在说明里的规则」会被绕过：`npm test --if-present` 那条漏洞、
`continue-on-error: true`、以及注释里假装存在的检查，都在文档写着「要跑」的时候发生过。
一条能被 `grep` 读出来的规则，才能在有人改 `package.json` 的同一秒拦住他。

**② 在检查期间快照整棵树，跑完比对，有差异就判红。** 判据更强（能抓「工具真的写了」
而不只是「命令行少了个参数」），但要跑完整条 `check` 再比一遍文件系统，代价是
每个门禁两倍 I/O；而且它只能事后发现，报错指向的是「某个文件变了」，
定位不到是哪个脚本的哪条命令。`tools/sync-upstream.test.mjs` 已经用这种口径
守住了 `sync-upstream` 这一个工具，那里值得付这个代价；全局再付一次不值。

**③ 干脆让所有工具默认只读，另给一个 `--write` 才写盘。** 语义最干净。
但那就得改 7 个工具的 CLI 契约（`notices`、`bilingual-links`、`sync-upstream`、
`doc-budget`、`archive-note`、`bump-version`、`board:selectors`），
属于破坏性变更，且会让「发布时就是要写」这条路径多一个必填参数。
与「只加判据、不改契约」比，风险收益倒挂。

**④ 判「源码里出现过 `--check` 这个字符串」。** 这是我第一版实现，实测当场红三处：
`tools/eol.mjs` 的注释在讲上游的 `git diff --cached --check`、
`tools/syntax-check.mjs` 的 `['--check', file]` 是**给 eslint 的**、
`tools/ci-alignment.mjs` 自己的说明文字里就有 `argv.includes('--check')` 这个例子。
所以最终判据是「剥掉注释 + 只认解析形态」，注释不构成证据。
（这条不是「备选」，是被证伪的实现 —— 留着是因为它会被再犯，而且犯的时候很像对的。）

## Consequences

收益：

- 「检查时改仓库」这一类失效有了机械判据，且**不需要人记得**；
- 递归展开 `npm run` 意味着新加门禁自动被纳管，不会出现「新步骤逃出判据」；
- 判据自身被两次真变异证明会红：把「判据永远跳过」注入后
  `42 → 40 pass / 2 fail`，红的正是新加的两条；
  把判据退回「源码里出现过 `--check`」后，真仓库当场红（含 `真实 workflow 此刻是对齐的`）。

代价（真实存在，不粉饰）：

- 只判「命令行带没带 `--check`」，不判工具**真的**没写盘。一个只读模式内部
  仍然会写文件的工具，这条判据看不见；
- 工具文件不存在时**跳过不判**（沙箱里只复制关心的文件）。代价是沙箱里这条判据
  只对被复制进来的工具生效 —— 真仓库里 20 条命令都被复制齐全，所以真实场景无洞，
  但用例的覆盖面确实小于真仓库；
- 「有只读模式」的识别依赖源码写法：把 `argv.includes('--check')` 改写成
  `argv.some((a) => a === '--check')` 这类形态会让判据**漏认**（保守方向，
  不会造成假绿，但会让这条判据静默失效）；
- 粗粒度剥注释不区分字符串里的 `/*`，可能多剥代码 —— 同样是保守方向。

## Verification

- `node tools/ci-alignment.mjs` → exit 0，输出含
  `✔ check 链里 20 条工具命令都用了只读模式（有 --check 的都带上了）`。
- `node --test tools/ci-alignment.test.mjs` → **43 tests / 43 pass / 0 fail**（原 40 条）。
- 新增三条用例：`检查链里裸跑带 --check 的工具必须变红（实测会写盘）`
  （红 + 绿双向）、`注释里提到 --check 不算「有这个模式」`（含阳性对照：
  同一份源码补上解析后必须判红，证明前一条绿不是「判据没跑」）、
  `!== '--check' 是排除这个参数，不算「有只读模式」`（收紧方向：`filter((a) => a !== '--check')`
  恰恰说明它不支持只读模式，认成支持会给裸跑判红 —— 那是假红）。
- 真变异 1：`if (/\s--check\b/.test(args)) continue;` → `continue;`（判据永远跳过）
  ⇒ `pass 40 / fail 2`，红的正是新加两条。还原后 `grep -c MUTANT` = 0、42/42。
- 真变异 2：判据退回 `/--check/.test(source)`（不剥注释、不认解析形态）
  ⇒ 真仓库直接红（`tools/eol.mjs`、`tools/syntax-check.mjs`、自身说明文字被误判）。
- 真变异 3：去掉 `(?<![!])` 前瞻（把 `!==` 也算成「有只读模式」）
  ⇒ `pass 42 / fail 1`，红的正是 `!== '--check'` 那条。还原后 43/43。
- 事故残留复核：`git status --short` 已干净（`package.json` 与 `upstream.json` 均 `git checkout --` 还原）。
