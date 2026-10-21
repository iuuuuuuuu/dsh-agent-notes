# Agent Note: 加了运行时依赖，归属声明却没红 —— notices 只扫 devDependencies

Status: implemented

> 部分修正 [2026-10-19-notices-mechanism-verified-and-stricter-than-expected.md](../process/2026-10-19-notices-mechanism-verified-and-stricter-than-expected.md)
> —— 那篇断言「package.json 加了依赖而声明没更新，会红」。本篇实测证明
> **不会**：那条判据只覆盖 `devDependencies`。
> 那篇的「机制经实测有效」在它当时测的范围内仍然成立，本文只修正它的范围。
> 它同时是 [解析器改用 mdast](../bug-fix/2026-10-19-i-was-wrong-about-not-needing-mdast.md)
> 的连带后果 —— 那篇把 mdast 引进来了，本篇修它带出的归属缺口。

Independent: 那篇讲 notices 的比对范围与认知修正，本篇修一个具体的漏扫缺陷；
同属第三方声明域，但决定不同，故新开一篇而非改写那篇。

## Problem

`tools/markdown-links.mjs` 改用 `mdast-util-from-markdown` 后，
`package.json` 第一次有了 `dependencies`（此前只有 `devDependencies`）。

随后发现三件事接连都对不上：

1. `THIRD_PARTY_NOTICES.md` 里**没有** mdast，也没有它带回的 30 多个传递依赖；
2. `npm run notices:check` **报绿**；
3. 那篇 notices 笔记的结论说「加了依赖会红」。

★ 第 3 条是本次最该记的：**测试全绿不是机制有效的证据**。那次注入只测了
「删声明里的一行」和「塞一个不存在的包」，两个方向都动的是**输出**；
而漏扫发生的地方是**输入**——`devDependencies()` 只读那一个字段。

## Decision

**`notices.mjs` 扫全部三类依赖，并按「随插件发布 / 仅开发使用」分表。**

### 输入契约修复

`devDependencies()` 改名 `npmDependencies(read)`，扫
`dependencies`、`peerDependencies`、`devDependencies`，连同各自的传递依赖。
同一个包被多处声明时按运行时记（保守侧）。

### 注入通道修复

`npmDependencies()` **必须接 `read` 参数**。它原本自己读真 `package.json`
—— 于是 `renderNotices` 明明已经解析过一份注入的 `package.json`，
依赖清单那份又回落到真仓库：**测试注入只在半个链路上生效**，
验的是真仓库而不是注入值。这是本仓库反复栽的形态。

### 两个维度都要留

| 维度 | 回答 | 别丢它的理由 |
|---|---|---|
| `direct` | 哪些是本包自己声明的 | 读者要判断「我们选了它」还是「被连带拉进来的」 |
| `scope` | 随插件发布还是仅开发期 | 读者要判断「装插件时会落到宿主机上吗」 |

既有的「直接 / 传递」断言继续有效，本次不破坏它。

### 故障注入（Owner 硬规则）

两条退化形态各跑一次真实子进程，证明新用例不是恒真：

| 退化 | 结果 |
|---|---|
| 扫回「只扫 devDependencies」 | 运行时依赖从声明里消失 → 被抓住 |
| `npmDependencies` 不接注入的 read | peerDependencies 消失 → 被抓住 |

夹具两处必需，缺一处都会在错误的地方失败：
`tools/upstream-manifest.json` 要留在 `tools/` 下（`vendoredSource` 按相对路径读它）；
必须挂 `node_modules`（否则 `spdx-expression-parse` 解析失败，那是夹具坏了，不是被测定退化）。

## Alternatives considered

- **只在 `README.md` 里补一句「还有运行时依赖」** —— 便宜且零风险。
  **否掉因为归属声明是法务文件**：`skills/agent-notes/` 下 21 个 vendored 文件
  靠它满足 MIT 第一条，而运行时依赖同样被分发到宿主机。散在散文里的声明，
  下次改依赖时没人会想起同步它。
- **把 mdast 挪进 devDependencies**（不是运行时依赖）—— 一行解决。
  **否掉因为 `tools/*.mjs` 是发布物的一部分**：`files` 里含 `tools/`，
  用户装插件后跑 `npm run check` 需要它。撒谎换取门禁绿，比改门禁更糟。
- **保留 `direct`/`scope` 中的一个维度** —— 表更窄。
  **否掉因为两个维度回答的是不同问题**（见上表），只留一个会让读者误判
  「装插件时到底会拖进来什么」。

## Consequences

- **收益**：归属声明的输入覆盖与 `package.json` 一致；这份声明现在真的能对
  「加了依赖忘更新」变红，而不只是对「手改声明」变红。
- **收益**：`peerDependencies` 此前完全不在披露范围，本次一并纳入。
- **代价**：声明从 3 行变 34 行（mdast 带回 30 多个传递依赖）。
  读者要翻更久 —— 但「读得久」好过「漏一项」。
- **代价与已知上限**：`npmDependencies` 现在要求调用方传 `read`，少传会
  在 `JSON.parse(read(...))` 处抛 `read is not a function`。**这是故意的**：
  静默回落读真文件正是本次的缺陷形态。将来若有人给它加默认值，要连
  故障注入那条用例一起删，否则测不出来。
- **重访信号**：
  - **若 `lib/` 也开始用 mdast** → 插件运行时依赖会更多，声明的运行时段会继续长；
    那时该重新评估「值不值得为省 34 行拆成独立文档」。
  - **若 pnpm-lock 或 npm-shrinkwrap 进仓库** → 可以从锁文件直接取全树，
    比现在递归 `node_modules` 更权威，也不受「包未安装」影响。

## Verification

```sh
npm run notices:check   # 绿（声明与当前 package.json 一致）
node --test tools/notices.test.mjs   # 16/16，含 2 条故障注入
```

对真实仓库的注入（不写盘）：给 `package.json` 注入
`dependencies: { 'mdast-util-from-markdown': '^2.1.0' }`，
渲染结果的「运行时依赖」段必须出现它；注入
`peerDependencies: { 'some-peer': '^1.0.0' }` 同理。
旧实现在这两个注入下都把它丢掉，而 `notices:check` 报绿。
