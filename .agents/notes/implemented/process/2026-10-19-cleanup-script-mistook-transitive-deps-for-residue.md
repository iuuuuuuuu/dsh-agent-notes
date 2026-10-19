# Agent Note: 我把传递依赖当成残留删了 —— 清理脚本必须区分「声明的」与「传递的」

Status: implemented

> 与 [2026-10-19-notices-mechanism-verified-and-stricter-than-expected.md](./2026-10-19-notices-mechanism-verified-and-stricter-than-expected.md)
> 同批 —— 那一篇实测发现 `node_modules` 顶层有 22 个未声明的包，并指出
> **按工程整洁纪律该清掉**。本篇记录清理过程中我自己犯的错。

Independent: 本篇不改任何门禁行为，只记录一次清理失误与它的判据。

## Problem

`node_modules` 顶层有 25 个包，而 `package.json` 只声明 1 个直接依赖
（`spdx-expression-parse`）。那 24 个里：

| 类别 | 数量 | 该不该删 |
|---|---|---|
| puppeteer 及其传递依赖（本会话 `--no-save` 装的） | 22 | **该删** —— `package.json` 里没有 |
| `spdx-exceptions`、`spdx-license-ids`（**声明依赖的传递依赖**） | 2 | **绝不该删** |

我写了个清理脚本，判据是：

```js
const declared = new Set([...deps, ...devDeps, ...peerDeps]);
const residue = topLevel.filter((n) => !declared.has(n));
```

**那个判据是错的** —— `spdx-exceptions` 与 `spdx-license-ids` 也不在
`package.json` 的直接依赖里，它们是 **`spdx-expression-parse` 的传递依赖**。

## Decision

**脚本的判据从「是否声明」改成「是否可达」。**

「可达」= 从 `package.json` 的声明出发，沿各包的 `dependencies` /
`optionalDependencies` / `peerDependencies` 递归能到达。

理由：**要删的是「我引入的、与项目无关的东西」**，判据必须是
「这个包与本项目有没有关系」，而不是「它有没有被直接声明」。

### 实测后果

脚本删了 **25 个**（本该删 22 个），把两个传递依赖也删了。

**立刻用 `npm ci` 恢复**：

```
added 3 packages in 792ms
node_modules 顶层: spdx-exceptions / spdx-expression-parse / spdx-license-ids
node --test tools/notices.test.mjs → 10/10 通过
```

恢复无损 —— 因为 `package-lock.json` 里有完整记录。

## Alternatives considered

- **不清理，保留 puppeteer 残留** — 最安全。**这是本篇最强的一条被否方案**，因为工程整洁纪律明确要求「任务结束主动清场」「下次还会用到吗」—— `npm ci` 会重建它们，**留着的唯一价值是方便我随时再测浏览器**。而那个需求已经由 `tools/find-browser.mjs` 满足了（上一轮已实测两个探针真跑通）。**用「方便测试」当留着 24M 垃圾的理由，是把临时便利放在纪律之上。**
- **只删 puppeteer 那几个顶层包，保留传递依赖** — 折中。**否掉因为传递依赖（`chromium-bidi` 等）正是 puppeteer 带进来的，不删它们等于没清**，而且它们的父包已不在，留着更怪。
- **用 `npm ci` 重装整个 node_modules** — 最彻底。**其实就是这个方案**，只不过我先手工删了一轮再 `npm ci`。下次直接 `npm ci` 即可，**不需要写清理脚本**。

## Consequences

- **收益**：node_modules 从 32M 回到 3 个包（`npm ci` 后只装声明的那 1 个 + 它的 2 个传递依赖）。
- **收益**：记下了一条通用判据 —— **清理脚本判「残留」要用「可达性」，不是「直接声明」**。
- **代价与已知上限**：清理脚本本身没修（它还在 `.probe/tmp/`）。**但那是对的** —— 它是一次性清理，而正确做法是直接 `npm ci`。留着会误导将来的人以为那是可用工具。**下次清 `.probe/` 时一并删掉它。**
- **代价与已知上限**：这次靠 `npm ci` 恢复，说明 **`package-lock.json` 是这类操作的安全网**。若 lock 不完整，删了可能装不回来。**本仓库的 lock 是完整的**（实测 `npm ci` 恢复了全部 3 个包）。
- **重访信号**：**若本仓库将来引入传递依赖更多的包**（比如某个带 10 个子依赖的工具）→ 清理脚本那个判据会再次误删，而**若那时 lock 不完整就恢复不了**。所以本篇的结论其实是：**别写清理脚本，直接 `npm ci`**。

## Verification

```sh
node .probe/tmp/clean-puppeteer-residue.mjs    # 我那个有 bug 的脚本（一次性）
npm ci                                            # 正确的恢复方式
node --test tools/notices.test.mjs               # 10/10 通过
```

实测：

```
清理前: node_modules 顶层 25 个
脚本删了: 25 个（★ 多删了 spdx-exceptions / spdx-license-ids）
npm ci: added 3 packages in 792ms
恢复后: spdx-exceptions / spdx-expression-parse / spdx-license-ids
notices 测试: 10/10 ✔
```

**★ 判据**：判「某个包是不是我引入的残留」，要用
**「从 package.json 出发沿依赖边能否到达」**，不能用
**「它有没有被直接声明」** —— 后者会把传递依赖误判成残留。