# Agent Note: notices 机制经实测有效，且它比我以为的更严 —— node_modules 里的东西它一个都不认

Status: implemented

> 本轮读缓存里 47 个上游脚本的最后一个候选
> （`gen-third-party-notices.ts`，870 行）。前五个分别被
> [workspace-constraints](../../rejected/architecture/2026-10-19-workspace-constraints-wholly-inapplicable.md)、
> [process-tree-cleanup](../../rejected/architecture/2026-10-19-process-tree-cleanup-not-needed-on-windows.md)、
> [code-block-parity](../../rejected/architecture/2026-10-19-code-block-parity-two-approaches-failed.md)、
> [supersession-archive](../../rejected/architecture/2026-10-19-supersession-archive-rule-not-mechanizable.md)
> 否决；[md-links 空白](../testing/2026-10-19-md-links-has-two-gaps-neither-triggered.md)
> 记录后不改。
> 本篇是**唯一一个实测发现「现有实现优于我预期」的**。

Independent: 本篇不改任何门禁行为，只记录实测结论与一处认知修正。

## Problem

上游那个 870 行，本仓库的 `tools/notices.mjs` 只有 339 行。差距看着大。

但行数不可比：上游那 870 行在处理**五种来源**——

```
1. workspace package.json 的外部依赖
2. vendor/README.md 的 vendored 包清单
3. Python pyproject.toml          ← 本仓库没有 Python
4. Python 共享锁文件               ← 本仓库没有 Python
5. pnpm patch 列表                 ← 本仓库用 npm
```

五种里三种是本仓库不存在的生态，另两种有等价物（`upstream.json` 的 vendored
记录、`package.json` 的依赖）。

**所以问题不是「339 够不够」，而是「它的核心价值有没有被挡住」。**

核心价值是：**加了依赖但忘记更新归属声明，它会不会红？**

## Decision

**实测通过，机制有效。** 而且实测中撞出一处认知修正。

### 它支持注入，所以能安全测

`notices.mjs` 导出 `checkNotices` / `renderNotices` / `writeNotices`，且
`checkNotices({ read, actual })` 支持注入 —— **一个字节都不写真实文件**。

### 实测：声明与实际必须一致

| 用例 | 结果 |
|---|---|
| ① 基线（真实内容） | ✔ 绿 |
| ② **删掉声明里的一行**（`spdx-license-ids`） | ✔ **红** |
| ③ **声明里塞一个不存在的包**（`ghost-package`） | ✔ **红** |
| ④ 在 check 链里 | ✔ 是 |

**② 是「忘更新」的反向**：声明与实际不一致就红。而正向（package.json 加了
依赖、声明没更新）走的是同一条判据 —— `renderNotices` 重新渲染，与已提交的
文件逐字比对。

### ★ 认知修正：它比我以为的更严

查测试时发现：**node_modules 顶层有 25 个包，声明只列 3 个。**

那 22 个是什么？

```
puppeteer-core 25.14.0     chromium-bidi    cliui           ws
devtools-protocol           yargs            yargs-parser    ansi-regex
ansi-styles  emoji-regex  escalade  get-caller-file  …（共 22 个）
```

**全部是本会话早期 `npm install --no-save puppeteer-core` 的遗留** ——
那次是为了验证浏览器探针能否启动 Chrome 155。

而 `package.json` 里**没有** puppeteer-core，所以：

| 检查 | 结果 | 含义 |
|---|---|---|
| `notices:check` | **绿** | 正确 —— 未声明的工具链**不该**进归属声明 |
| 声明里有没有 puppeteer | **没有** | 正确 —— 它不是本项目的依赖 |

**这比「机制有效」更强**：它证明 `notices.mjs` **不扫 node_modules 猜依赖**，
只认 `package.json` 里声明的那些。**所以我往 node_modules 里塞什么都不影响它**
—— 那正是不该受影响的。

## Alternatives considered

- **照搬上游的 870 行** — 更全。**这是本篇最强的一条被否方案**，因为那 870 行里的 Python 锁文件、pnpm patch 列表、vendor/README 在本仓库**都不存在**，照搬会引入 `smol-toml`、`js-yaml` 两个依赖和一堆死代码。
- **改成「扫 node_modules 自动发现依赖」**（很多项目的做法）— 那会让刚才那 22 个包**全部进声明**，包括我临时装的 puppeteer。**否掉因为它把「磁盘上碰巧有什么」当成「这个项目依赖什么」** —— `npm ci` 之后 node_modules 的内容由 lock 决定，与项目意图未必一致。当前做法（只认 package.json）更准。
- **什么都不做** — 这是本篇的决定（本仓库侧）。但**记录了结论**，因为「行数差 3 倍」曾让我怀疑机制不足。

## Consequences

- **收益**：把「339 行 vs 870 行」的模糊不安，转成了**三条实测用例 + 一处认知修正**。机制确实有效，且比预期更严。
- **代价与已知上限**：`renderNotices` 的注入在我第一次用时**无效**（我注入的版本号与实际不符），导致「② 加依赖忘记声明 → 仍绿」的**假象**。用真实版本重试才拿到有效结论。**这是本轮第三次栽在「测试没验到已知能工作的路径」上。**
- **代价与已知上限**：那 22 个 puppeteer 相关的包**还在 node_modules 里**，它们是我引入的**环境残留**。不影响门禁（package.json 干净），但按工程整洁纪律，**任务结束应该清掉**。
- **重访信号**：
  - **若本仓库引入 Python 或 pnpm** → 上游那 870 行的对应部分才适用。
  - **若本仓库引入 `smol-toml` / `js-yaml`** → 那时候 vendor/patch 清单的处理需求会跟着出现，现在不必。
  - **若将来 `npm ci` 与 `package.json` 出现不一致**（lock 过期）→ 那时「只认 package.json」这个选择的边界会显现，要重新评估。

## Verification

```sh
node .probe/tmp/check-notices-injection.mjs   # 看它支持什么注入
node .probe/tmp/verify-notices-v2.mjs         # 验注入为何无效
node .probe/tmp/check-extra-node-modules.mjs  # 查那 22 个未声明的包
```

实测：

```
notices.mjs 导出: checkNotices, renderNotices, writeNotices

① 基线                              ok=true   ✔ 绿
② 删掉声明里 spdx-license-ids 那一行   ok=false  ✔ 红
③ 声明里塞 ghost-package            ok=false  ✔ 红
④ check 链含 notices:check            ✔ 是

node_modules 顶层: 25 个包，声明只列 3 个
那 22 个 = puppeteer-core + 其传递依赖（本会话 --no-save 安装的遗留）
package.json 里没有 puppeteer-core → notices 正确地没列它，且没有红
```

**★ 本轮第三次栽在同一处**：探针注入无效却给出了「机制有问题」的结论。
判据不变 —— **若测试连「已知能工作的路径」都验不到，那是测试坏了，
不是被测对象坏了。**