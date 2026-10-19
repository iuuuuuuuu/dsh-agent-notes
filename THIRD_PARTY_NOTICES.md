# 第三方内容归属声明

<!-- 由 `npm run notices` 生成，请勿手改。
     校验：`npm run notices:check`（已接入 npm run check 与 CI）。 -->

本仓库分发的内容里包含第三方作品。本文件按 MIT 等许可证的要求，
保留它们的来源、版本与许可声明。

本插件自身以 **MIT** 许可发布，全文见 [LICENSE](LICENSE)。

## 1. vendored 上游内容

`skills/agent-notes/` 下的 21 个文件是下列上游内容的副本，
由 `tools/sync-upstream.mjs` 同步维护（**请勿手改**，改动会被
`tools/verify-plugin.mjs` 的哈希比对拦下）。

| 项目 | 值 |
|---|---|
| 上游仓库 | <https://github.com/czm15053/write-notes-like-deepseek> |
| 同步路径 | `skills/write-notes-like-deepseek` |
| 固定 commit | `72573a5b179de7798bbb7c4aeacdc0df6bf62439` |
| 许可证 | MIT |
| 文件数 | 21 |

> **关于上游许可证文件的说明**：上游仓库的 README 声明 MIT 并链接
> `LICENSE`，但该文件在其仓库中并不存在（实测 404）。本仓库按 README 的
> MIT 声明处理，并在此如实记录这一差异 —— 我们无法核对一份不存在的文件。

## 2. 开发依赖

以下依赖**不随本插件发布**，只在开发与校验时使用（`dependencies` 与
`peerDependencies` 为空，`tools/verify-plugin.mjs` 会拦下任何
`@deepseek-ai/*` 运行时依赖）。列出它们是为了让「这个仓库靠什么构建」
可被审计。

**传递依赖也一并列出**：归属声明只列直接依赖是不完整的 —— 那些被间接
拉进来的包同样落在开发者机器上，许可证同样该被披露。

| 包 | 类型 | 版本 | 许可证 |
|---|---|---|---|
| `spdx-expression-parse` | 直接 | `^5.0.0` | MIT |
| `spdx-exceptions` | 传递 | `2.5.0` | CC-BY-3.0 |
| `spdx-license-ids` | 传递 | `3.0.24` | CC0-1.0 |

## 3. 本插件自身

`@iuuuuuuuu/agent-notes` 以 MIT 发布，版权归 dsh-agent-notes contributors，
全文见 [LICENSE](LICENSE)。
