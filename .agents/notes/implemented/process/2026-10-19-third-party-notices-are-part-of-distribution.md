# Agent Note: 第三方归属声明是分发流程的一部分

Status: implemented

> 同域：这与「上游合并」那条线同源。
> vendored 内容的同步机制见
> [2026-10-18-three-layer-checks-must-align.md](./2026-10-18-three-layer-checks-must-align.md)，
> 归档与冻结见 skill 的 `references/archiving.md`。

Independent: 本篇处理的是**许可证合规与依赖披露**，不涉及笔记治理、门禁红绿判定或上游同步的时序问题。

## Problem

本插件分发的是 MIT 作品的衍生：`skills/agent-notes/` 下 21 个文件是
`czm15053/write-notes-like-deepseek` 的 vendored 副本，由 `tools/sync-upstream.mjs`
维护、`tools/upstream-manifest.json` 记录逐文件哈希。

而仓库里只有一份自己的 `LICENSE`（`Copyright (c) 2026 dsh-agent-notes contributors`），
**完全没有提上游**。MIT 许可证第一条要求：分发衍生作品时必须保留原版权声明与
许可声明。这是一个真实的合规缺口。

### 我最初怎么错误地否决了它

第一轮核查时我写下「本仓库 0 篇归档笔记 → 无实际诉求」这样的判断，用
「今天恰好有没有」去决定要不要做，被指出后才发现判据本身是错的：

> 我们要照顾的是**完整流程**，不是只针对现有的。

一个规范与工具链仓库的判断标准应该是「完整的分发流程需要哪些环节」，
而不是「当前文件里碰巧出现了什么问题」。许可证明天不会因为「今天没被起诉」
就不需要 —— 它在**第一次分发**时就该在。

同时我还给自己加了一条并不存在的约束：以为「零依赖」意味着不能用任何 npm 包。
实际上 `tools/verify-plugin.mjs` 只拦 `@deepseek-ai/*`（理由是 profile 无法解析它们），
普通 devDependency 从来没被禁止。这道自设的枷锁让我差点因为「不能用
`spdx-expression-parse`」而写一个手搓正则去校验许可证标识符 —— 那必然会把
`MIT OR Apache-2.0` 这类表达式判错，而写错的许可证标识符比没有更糟。

## Decision

新增 `tools/notices.mjs`：生成并校验 `THIRD_PARTY_NOTICES.md`。

结构分三节：

1. **vendored 上游内容** —— 仓库地址、同步路径、钉死的 commit、许可证、文件数，
   数据全部来自 `upstream.json` 与 `tools/upstream-manifest.json`，不手抄。
2. **开发依赖** —— **递归**收集 devDependencies 及其传递依赖，许可证从实际安装的
   包 `package.json` 读取。
3. **本插件自身** —— 许可证与版权行。

`must`：归属声明里的每一项都必须**从数据源生成**，不得手写。手写的表格会随
同步漂移，而漂移后的归属声明是错误信息 —— 它看起来合规，实际指向旧版本。

`must`：依赖清单必须含传递依赖。只列直接依赖是不完整的：`spdx-expression-parse`
会带回 `spdx-exceptions`（CC-BY-3.0）与 `spdx-license-ids`（CC0-1.0），它们同样
落在开发者机器上。那两个许可证标识符手写绝猜不出，必须真读包元数据。

`must`：许可证标识符用 `spdx-expression-parse` 校验，不手写正则。手写判断
`MIT` 可行，判断 `MIT OR Apache-2.0`、`(MIT AND BSD-2-Clause)` 必错。
**写错的许可证标识符比没有更糟** —— 它会让人以为自己合规了。

`must`：校验失败要区分三种情况并给出可操作提示 —— 文件缺失（`actual === null`）、
内容不一致（指出前几处行差异）、数据源非法（SPDX 解析失败直接抛错）。

### 关于上游 LICENSE 文件缺失这件事

上游 README 有两处声明 MIT 并链接 `LICENSE`，但该文件在其仓库中**不存在**（实测 404）。
本仓库按 README 的声明处理，并把这一差异如实写进声明正文。

不写的话，读者会以为我们核对过那份文件。诚实的披露比看起来整齐更有价值 ——
我们无法核对一份不存在的文件，这个事实本身应该留在记录里。

## Alternatives considered

- **手写一份静态的 `THIRD_PARTY_NOTICES.md`** — 零代码、零依赖，改完就完事。否掉是因为它会立刻开始漂移：`sync-upstream` 每次合并都可能改 commit 与文件数，而手写文件不会跟着变。漂移后的归属声明比没有更危险 —— 它声称的版本与实际分发的版本不一致，读者无法分辨。生成 + `--check` 才能让「声明与实际一致」成为**可机械验证**的事。
- **只用正则校验许可证标识符，不引入 `spdx-expression-parse`** — 这是我最初的想法，动机是「保持零依赖」。否掉是因为它必然误判复合表达式。SPDX 表达式有 `WITH`、`AND`、`OR`、括号优先级、`+` 后缀，手写解析器等于重写一个规范实现，且没有一个测试能证明它做对了。引入一个 3 个包、总计数十 KB 的 devDependency 换取「许可证标识符判定正确」，这个交换在任何标准下都划算。**而且这类依赖不进用户的 `node_modules`** —— 它只在开发与 CI 时存在，不构成分发负担。
- **只列直接依赖，不递归** — 实现更短，表格更干净。否掉是因为它在合规语义上是错的：传递依赖同样是第三方作品。这个仓库恰好只有 2 个传递依赖，手工补两行看似可行 —— 但那份手工清单在下一次升级依赖时会漏，而漏掉的项没有任何门禁能发现。
- **不做 `--check`，只保留生成命令** — 少一道门禁，少一处维护。否掉是因为没有 `--check` 的话，「声明是不是最新的」只能靠人记得跑生成器。本仓库已经因为「靠人记得」吃过多次亏（连续 5 次改 CI 配置没写笔记），这个模式在这里同样成立。
- **把 `THIRD_PARTY_NOTICES.md` 纳入 `verify-plugin.mjs` 而不是独立脚本** — 少一个文件。否掉是因为 `verify-plugin.mjs` 的职责是「包本身是否可发布」（包清单、patch 一致性、vendored 哈希），而归属声明是**合规产物**，两者的失败含义不同：前者是「装不上」，后者是「分发时法律上有瑕疵」。分开能让 CI 日志直接指向问题性质。

## Consequences

- **收益**：补齐了分发流程里缺失的一环。此前仓库对上游 21 个文件的归属零声明。
- **收益**：`npm run notices:check` 接进 `npm run check`，与 CI 一起跑。声明一旦与实际脱节（改 `upstream.json`、升级依赖、同步上游），门禁立刻红。
- **收益**：传递依赖的许可证是**读出来的**，不是写死的。这一点被测试钉住（断言 `CC-BY-3.0` 与 `CC0-1.0` 必须出现）——若实现退化成硬编码表格，测试会红。
- **收益**：9 个测试 + 10/10 故障注入变红。故障注入覆盖到「不写 commit」「不写文件数」「许可证写死 MIT」「不递归传递依赖」「不校验 SPDX」「缺 license 时不报错」「文件缺失时当作通过」等，证明这些断言不是恒真。
- **代价与已知上限**：`devDependencies` 里多了一个 `spdx-expression-parse`（带 2 个传递依赖）。它只在开发与 CI 存在，不进用户的安装树 —— 但「零依赖」这个说法从此需要限定为「零**运行时**依赖」。这个限定已经写在 `verify-plugin.mjs` 的注释与本文里。
- **代价与已知上限**：`notices.mjs` 依赖 `node_modules` 存在才能读到包的许可证。在未安装依赖的干净 checkout 上，表格会显示「（未在包内声明）」。这是有意的降级 —— 生成器不该因为读不到元数据就失败，但 `--check` 在那种情况下会红，从而暴露「CI 必须先 install」这个前提。
- **重访信号**：若将来新增第二个 vendored 上游（现在只有一个），`vendoredSource()` 要改成遍历多个来源。当前实现假定单一来源，这个假定写在函数结构里而非注释里 —— 加第二个来源时会立刻碰到。
- **重访信号**：若上游补上了 `LICENSE` 文件，声明里那段「不存在的说明」就该删除，并改为引用真实文件的哈希。

## Verification

```sh
npm run notices          # 生成 THIRD_PARTY_NOTICES.md
npm run notices:check    # 校验（已接入 npm run check 与 CI）
node --test tools/notices.test.mjs   # 9 个用例
```

故障注入（已实测，10/10 全部变红）：不写上游地址 / 不写 commit / 不写许可证 /
不写文件数 / 去掉「文件不存在」说明 / 不递归传递依赖 / 许可证写死 MIT /
不校验 SPDX / 缺 license 时不报错 / 文件缺失时当作通过。
