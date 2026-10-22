# Agent Note: 文件必须恰好以一个换行结尾 —— 但不能照抄上游的 `git diff --check`

Status: implemented

> 承接[三层检查必须对齐](../process/2026-10-18-three-layer-checks-must-align.md)
> 与[自证清单必须与磁盘对账](./2026-10-21-fault-injection-list-must-reconcile-with-disk.md)：
> 本篇是这批对标里**唯一一道判「仓库约定」而不是「门禁自身」的门禁**。
> 与[门禁语料不得被悄悄收窄](./2026-10-22-gate-corpus-must-not-narrow.md)
> 同属「门禁横向对账」这条线，但管的是文件形态。

Independent: 本篇只增加「结尾换行」这一项文件形态判据；
其它门禁的语料、判据与失败信息都不变。

## Problem

上游 A 的根 `AGENTS.md:165` 写着一条明确的仓库级约定：

> Files end with exactly one trailing newline; `git diff --cached --check`
> (pre-commit) gates it.

它守卫的不是「好看」，而是**两件具体会咬人的事**：

1. **缺结尾换行**会让 diff 里出现 `\ No newline at end of file`，而这行挂在
   **最后一个改动行**后面 —— 看 diff 的人会把「作者忘了换行」误读成
   「作者把最后一行改了」。实测本仓库有 **63 个 tracked 文件**处于这个状态。
2. **结尾多一个空行**是纯噪音：它不携带任何信息，却让每个碰过该文件的 diff
   都多出两行无关内容。实测本仓库有 **1 个文件**处于这个状态。

## Decision

新增 `tools/eol.mjs`，判据是**自己按字节判定**：文件末尾必须是恰好一个 `\n`，
且它前面不能再是 `\n`。

范围与豁免：

- **只判 tracked 文件**（`git ls-files`）。未跟踪的新文件由提交钩子与 CI 在
  入库那一刻管；把工作区里的一切都扫进来会让门禁对「还没打算提交的草稿」发红。
- **跳过二进制**（含 NUL 字节或非 UTF-8）—— 「结尾换行」对它无意义。
- **跳过 `skills/agent-notes/`**：vendored 上游副本，手改会被哈希门禁拦下
  （`AGENTS.md` 硬约束 3），本仓库无权改它。那里有 2 个文件处于「缺结尾换行」
  状态，**这是已知的、故意留下的例外**。
- **跳过 `.agents/notes/archived/`**：被 SHA-256 封印，改了就报 `seal mismatch`，
  红了自己也改不动。
- **空文件不算错**：空文件没有「结尾」，谈不上多一个或少一个换行。

接进 `package.json` 的 `check` 链（`npm run eol`）与 `.github/workflows/verify.yml`
的独立步骤；登记进 `tools/fault-injection.mjs` 的声明表。

## Alternatives considered

- **照抄上游的 `git diff --cached --check`**：零代码，git 自己实现。
  仍然否决 —— 实测（临时仓库，两个文件：一个缺结尾换行、一个结尾多一个空行）：
  ```
  $ git diff --cached --check
  extra.md:2: new blank line at EOF.
  $ echo $?
  2
  ```
  **只抓到了「多空行」，缺结尾换行的那个文件根本没被报出来。** 照抄会得到
  「以为有门禁、实际上只覆盖一半」的假绿 —— 正是本仓库最忌讳的形态。
- **挂进 pre-commit 钩子**（像上游那样）：反馈更早。仍然否决：钩子只在
  **本机**跑，而本仓库早就实测过 `git commit --no-verify` 能绕过本地钩子
  （见[分支保护让门禁可强制](../process/2026-10-19-branch-protection-makes-gates-enforceable.md)），
  CI 才是权威那道。把判据做成独立门禁后，CI 与本地 `check` 链都能跑它。
- **用后缀白名单决定哪些文件算文本**：实现更短。仍然否决：白名单会漏掉
  无扩展名的文本文件（`.gitignore`、`.gitattributes`、`LICENSE`、
  `.githooks/commit-msg`）—— 实测本仓库正好有 4 个这种文件在语料之外，
  白名单式扫描对它们完全无感。改用「含 NUL 字节或非 UTF-8 即二进制」的判据。
- **把 vendored 的 2 个文件也一起修**：让语料没有例外，更整齐。仍然否决：
  手改 `skills/agent-notes/` 会被 `tools/verify-plugin.mjs` 的哈希门禁直接拦下，
  而且 `tools/sync-upstream.mjs` 下次同步会把手改冲掉。豁免是**边界**，不是漏洞。
- **顺手把 63 个缺换行的文件一次性补齐**：让仓库立刻符合约定。采纳了
  **文件形态**这一半（这 63 个文件本轮已补），但**没有**为此新增一条
  「批量修复」的门禁或脚本 —— 那是机械改动，不值得一个决定。

## Consequences

- **收益**：缺结尾换行与结尾多空行两种形态现在都会红，且**判据覆盖两类**
  （上游那条只覆盖一类）。
- **收益**：语料是**入库内容**而不是工作区遍历 —— 门禁不会对「还没打算提交的
  草稿」发红。
- **代价**：仓库里 63 个文件（39 篇笔记 + 20 个 tools + 3 个其它）在本轮被
  一次性补齐了结尾换行。这是一次**纯机械**的批量改动（每文件只加一个 `\n`），
  单独看不该留笔记，但它触发了两处会咬人的东西：diff 里多出 63 处
  `\ No newline at end of file` 消失的记录，以及笔记文件的**内容哈希变化**。
  归档区那 1 篇被封印的笔记**没有**动（封印豁免）—— 动了会报 `seal mismatch`。
- **代价与已知上限**：豁免目录是**硬编码前缀**（`skills/agent-notes/` 与
  `.agents/notes/archived/`）。将来若再引入 vendored 副本目录，要跟着加。
- **已知上限**：判据只看**文件末尾**。文件中间的连续空行、结尾多多个空行
  （本门禁只判「多一个」）都不管 —— 那属于格式化工具的职责。

## Verification

```sh
node --test tools/eol.test.mjs
# tests 10 / pass 10 / fail 0                                     (exit 0)
```

10 条用例覆盖：绿基线；缺结尾换行必须红；结尾多一个空行必须红；空文件不算错；
二进制文件跳过；vendored 上游副本与归档笔记被豁免；未跟踪的文件不参与判定
（语料是入库内容）；`isTextFile` 认得无扩展名的文本文件；
`checkTrailingNewline` 的判据逐条明确。

`node tools/eol.mjs` → 退出码 0，输出「结尾换行通过：201 个文本文件都以恰好一个
换行结尾（语料来源：git ls-files）。」

**真故障注入**：把 `tools/eol.mjs` 的
`if (buffer[buffer.length - 1] !== 0x0a)` 改成 `if (false)`
（「缺结尾换行」这一支判据失效）→ **8 pass / 2 fail**，红的正是
「缺结尾换行必须红」与「`checkTrailingNewline` 的判据逐条明确」；
还原后（`diff` 逐字比对一致）10/10 绿。

注意「结尾多一个空行必须红」那条**没有变红** —— 因为它走的是另一支判据
（`buffer[buffer.length - 2] === 0x0a`）。两支判据互不依赖，这正是把它们
写成两个独立分支而不是合成一个的原因：合起来的话，一处变异会同时打掉
两类形态的检出能力，而那样的红读起来像「这道门禁整体坏了」，不如
「这一支坏了」清楚。

这些是离线回归结果，不是实机验证，也不是「上游对齐已完成」的结论。
