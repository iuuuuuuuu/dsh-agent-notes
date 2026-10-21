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

## 2. 运行时依赖

以下依赖**随本插件一起发布**，会被装到宿主机上：

| 包 | 类型 | 版本 | 许可证 |
|---|---|---|---|
| `mdast-util-from-markdown` | 直接 | `2.1.0` | MIT |
| `@types/debug` | 传递 | `4.1.13` | MIT |
| `@types/mdast` | 传递 | `4.0.4` | MIT |
| `@types/ms` | 传递 | `2.1.0` | MIT |
| `@types/unist` | 传递 | `3.0.3` | MIT |
| `character-entities` | 传递 | `2.0.2` | MIT |
| `debug` | 传递 | `4.4.3` | MIT |
| `decode-named-character-reference` | 传递 | `1.3.0` | MIT |
| `dequal` | 传递 | `2.0.3` | MIT |
| `devlop` | 传递 | `1.1.0` | MIT |
| `mdast-util-to-string` | 传递 | `4.0.0` | MIT |
| `micromark` | 传递 | `4.0.3` | MIT |
| `micromark-core-commonmark` | 传递 | `2.0.4` | MIT |
| `micromark-factory-destination` | 传递 | `2.0.1` | MIT |
| `micromark-factory-label` | 传递 | `2.0.1` | MIT |
| `micromark-factory-space` | 传递 | `2.1.0` | MIT |
| `micromark-factory-title` | 传递 | `2.0.1` | MIT |
| `micromark-factory-whitespace` | 传递 | `2.0.1` | MIT |
| `micromark-util-character` | 传递 | `2.1.1` | MIT |
| `micromark-util-chunked` | 传递 | `2.0.1` | MIT |
| `micromark-util-classify-character` | 传递 | `2.0.1` | MIT |
| `micromark-util-combine-extensions` | 传递 | `2.0.1` | MIT |
| `micromark-util-decode-numeric-character-reference` | 传递 | `2.0.2` | MIT |
| `micromark-util-decode-string` | 传递 | `2.0.1` | MIT |
| `micromark-util-edit-map` | 传递 | `1.0.0` | MIT |
| `micromark-util-encode` | 传递 | `2.0.1` | MIT |
| `micromark-util-html-tag-name` | 传递 | `2.0.1` | MIT |
| `micromark-util-normalize-identifier` | 传递 | `2.0.1` | MIT |
| `micromark-util-resolve-all` | 传递 | `2.0.1` | MIT |
| `micromark-util-sanitize-uri` | 传递 | `2.0.1` | MIT |
| `micromark-util-subtokenize` | 传递 | `2.1.0` | MIT |
| `micromark-util-symbol` | 传递 | `2.0.1` | MIT |
| `micromark-util-types` | 传递 | `2.0.3` | MIT |
| `ms` | 传递 | `2.1.3` | MIT |
| `unist-util-stringify-position` | 传递 | `4.0.0` | MIT |

## 3. 开发依赖

以下依赖**不随本插件发布**，只在开发与校验时使用。列出它们是为了让
「这个仓库靠什么构建」可被审计。

**传递依赖也一并列出**：归属声明只列直接依赖是不完整的 —— 那些被间接
拉进来的包同样落在使用者机器上，许可证同样该被披露。

| 包 | 类型 | 版本 | 许可证 |
|---|---|---|---|
| `spdx-expression-parse` | 直接 | `5.0.0` | MIT |
| `spdx-exceptions` | 传递 | `2.5.0` | CC-BY-3.0 |
| `spdx-license-ids` | 传递 | `3.0.24` | CC0-1.0 |

## 4. 本插件自身

`@iuuuuuuuu/agent-notes` 以 MIT 发布，版权归 dsh-agent-notes contributors，
全文见 [LICENSE](LICENSE)。
