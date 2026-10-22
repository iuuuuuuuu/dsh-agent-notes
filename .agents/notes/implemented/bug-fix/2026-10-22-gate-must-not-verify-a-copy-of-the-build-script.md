# Agent Note: 门禁不能验证一份和构建脚本可能分叉的副本

Status: implemented

> 承接[保护发布的那道门禁，自己没人保护](../process/2026-10-19-publish-gate-had-no-guardian.md)：
> 那篇的教训是「门禁配置本身要有人保护」；本篇是同一条线的另一处 ——
> **门禁的判据本身**不能是一份复制品。
> 相关：[发布清单与产物必须自洽](../process/2026-10-22-publish-layout-files-and-exports-must-agree.md)
> 同属「发布面」这条线。

## Problem

`tools/verify-plugin.mjs` 有一条「`lib/client.js` 与 `src/client.js` 是否同步」的检查
（现 `:173`）。它的做法是**在门禁里重建一遍 bundle**，然后与磁盘上的
`lib/client.js` 逐字比对。

问题是：这份重建逻辑是**从 `build.mjs` 原样复制过来的**。
两处注释当时都写着「用与 build.mjs 完全相同的规则重建客户端 bundle」——
那句话是真的，但它靠的是**人工同步**，不是任何机制。

一旦 `build.mjs` 被改坏（哪怕改的是与重建逻辑无关的一行），
门禁会拿**自己那份**实现去重建，然后与磁盘上的 `lib/client.js` 比对 ——
**两边都还是对的**，于是全绿。

实测这个形态：把 `build.mjs` 里写死的信封 id
（`window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},...`）
改成别的字面量，`npm run check` **整链 exit 0**。
构建脚本已经产不出正确的 bundle 了，而没有任何门禁会说话。

真实风险不是「有人手滑改坏 build.mjs」——而是**改了 `build.mjs` 的算法之后
忘记同步门禁里那份副本**，那时门禁验证的是一份已经不存在的实现。

## Decision

`build.mjs` 改为导出两个纯函数，**写盘只发生在直接执行本文件时**：

- `buildClientBundle(baseDir = root)` —— 算出 bundle 文本，**不写盘**；
- `build(baseDir = root)` —— 重建并写入 `lib/client.js`，返回写入字节数。

`tools/verify-plugin.mjs` 删掉自己那份复制品，改为
`import { buildClientBundle } from '../build.mjs';`，
并把原来的重建调用换成 `buildClientBundle(PACKAGE_ROOT)`。

判定是**同一份实现**，不是两份实现的比对 —— 这才是这道检查想要的语义：
「磁盘上的产物是不是当前源码与当前构建脚本能产出的东西」。

顺带把 `build.mjs` 的文件头注释改写：原来那段「为什么要导出函数」写的是
**已经发生的事实**（两份实现的隐患与实测形态），现在它描述的是**正在成立的机制**。

## Alternatives considered

- **加一道「跑一遍 `build.mjs`」的检查**：最直白 —— 门禁里执行构建脚本，
  看它是否成功。**否掉因为**：那会**写盘**。`verify.yml` 末尾有「测试不得改动
  工作区」的断言，构建门禁写盘会与它正面冲突；而且构建脚本执行成功
  **不等于**产物与磁盘上的一致（它只会覆盖磁盘上的那份，让比对永远成立）。
- **在门禁里比对 `build.mjs` 的源码哈希**：能发现「门禁副本与构建脚本不同步」，
  但那只是**代理指标** —— 真正的目标是「产物是最新的」。**否掉因为**：
  哈希一致仍不保证语义一致（改的是同一份文件的同一处，只是哈希变了），
  而真正要证明的是产物对。
- **把重建逻辑抽到第三个模块，`build.mjs` 与门禁都 import 它**：同样消除重复。
  **否掉因为**：`build.mjs` 本身已经是一个自洽的模块（读源码 → 产出 bundle），
  为此再加一层只含一个函数的中间模块，是为「门禁要 import 一点东西」而造结构。
- **让 `build.mjs` 只在构建时跑，门禁用 `git diff` 判断产物是否脏**：
  判据最省。**否掉因为**：门禁跑在 CI 上，工作区是 checkout 出来的干净副本，
  `git diff` 无从判断「产物是否与源码同步」—— 那正是「改了 `src/` 忘了 build」
  这类缺陷的检测点。而且这个判据要求产物入库，引入的是另一种约束。
- **让 `build.mjs` 每次运行都写盘（保持原样），门禁用子进程调用它**：
  能消除重复。**否掉因为**同上 —— 会写盘，且与「测试不得改动工作区」冲突。

## Consequences

收益是「构建脚本被改坏 / 两处实现分叉」这一类缺陷现在会红：
门禁与构建脚本共用同一份实现，不存在「分叉」这个状态。
实测把 `build.mjs` 的信封 id 改坏 → `node tools/verify-plugin.mjs` 退出码 1，
报 `✖ lib/client.js 与 src/client.js 不同步（请跑 npm run build）`。

代价与已知边界：

- `build.mjs` 从「一个只有副作用的脚本」变成「一个模块 + 一个脚本」。
  入口判定是 `process.argv[1]` 的路径后缀匹配（`build.mjs`），
  所以从别处 `import` 它不会意外写盘；但**直接以相对路径 `node build.mjs`**
  与**以绝对路径**执行都能被认出来，而 `node ./build.mjs` 也在内 ——
  判定用的是斜杠归一化后的 `endsWith('/build.mjs')`。
- 门禁现在**依赖** `build.mjs` 是可 import 的 ESM 模块。`package.json` 是
  `"type": "module"`，`build.mjs` 后缀是 `.mjs`，两者都满足；
  但这意味着 `build.mjs` 的语法不能为了「脚本更好读」而改成 CommonJS。
- `tools/verify-plugin.test.mjs` 与 `tools/publish-layout.test.mjs` 的
  包副本清单都必须带上 `build.mjs`（否则副本里的门禁会因模块解析失败而崩），
  少拷一个文件会让「绿基线」变成别的原因导致的红。
- 门禁比对的是**文本逐字相等**。`build.mjs` 生成的文本若因换行风格变化
  （Windows 上 CRLF/LF）而与磁盘不同，门禁会红 —— 这与
  `.gitattributes` 的 `eol=lf` 约定绑定，那条约定目前**没有门禁**（已登记在
  `docs/known-gaps.md`）。

## Verification

**真故障注入（改坏构建脚本）**：把 `build.mjs` 里
`window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:function(require){`
改成写死的 `id:"mutant-broken-id"` → `node tools/verify-plugin.mjs` **退出码 1**，
输出末尾：

```
自检未通过（1 项）:
  ✖ lib/client.js 与 src/client.js 不同步（请跑 npm run build）
```

`cp` 还原后 `diff` 逐字比对确认一致，复跑 `node tools/verify-plugin.mjs` 退出码 0
（「自检通过：包清单、patch 一致性、零 @deepseek-ai 依赖、双语文档与 dsh 徽标、
vendored 内容及上游哈希均一致。」）。

**这条注入在改动前是无效的**：改同一处，`npm run check` 整链 exit 0 ——
因为门禁拿的是自己那份复制品。这就是本篇要修的东西。

`node --test tools/verify-plugin.test.mjs` 与 `node --test tools/publish-layout.test.mjs`
均全绿（19 / 19 与 10 / 10），两条用例文件都把 `build.mjs` 列进包副本清单。
