# Changelog

本文件记录对使用者有影响的变更。格式对齐 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-10-17

首个可装可跑的版本。

### 新增

- **技能 provider**：把上游决策笔记方法论作为 `agent-notes` 技能提供给模型与用户（剥掉 frontmatter，`resourceBase` 指向 vendored 目录，故 `../references/` 相对引用可解析）。
- **`/agent-notes` 命令**：`on` / `off` / `reset` / `status` / `gate` / `init`，其中 `--global` 作用于全局默认。命令直接回 UI、不发给模型，开关操作零 token。
- **双层持久化开关**：全局默认 + 会话覆盖，写入 `~/.dsh/agent-notes/state.json`（原子替换），重载后保持。与参考实现「切换不持久化」相反，这是本项目明确要求的行为。
- **会话级规范注入**：只在开关打开的会话挂载 system-prompt section（`agent.ctx` 作用域），关闭即卸载，不污染全局提示词。
- **真门禁工具**：`agent_notes_gate` 返回**进程退出码**与 stdout/stderr 原文；脚本缺失、超时一律算失败，不降级为通过。`agent_notes_status` 返回开关与笔记树概况。
- **上游合并工具**：`tools/sync-upstream.mjs` 支持 `--check`（零写入、有漂移即非零）与 `--yes`（真覆盖），逐文件 SHA-256 清单记录在 `tools/upstream-manifest.json`。
- **发布前自检**：`tools/verify-plugin.mjs` 校验包清单、patch 一致性、零 `@deepseek-ai/*` 依赖约束、vendored 内容齐备、以及与上游清单的哈希一致。

### 修复

- 上游清单枚举在路径匹配失败时会**静默返回空**，导致工具把「解析失败」报告成「内置副本与上游一致」。现在枚举失败直接抛错并给出可读原因，另加「枚举到少于 10 个文件即失败」的兜底。已加回归测试。
- 上游 ref 默认钉在 commit 而非分支：jsDelivr 对分支名的清单缓存滞后，锚 `@main` 会拿到重构前的旧目录结构。
- vendored 模板文件名漏了 `.md` 扩展名（`implemented` 而非 `implemented.md`），已由新的漂移检测发现并修正。

### 说明

- 本插件不声明也不 import 任何 `@deepseek-ai/*` 包：profile 的 `node_modules` 实际无法解析它们（实测只解析到 `cosmokit`/`schemastery`），因此宿主 API 全按鸭子类型使用，缺失能力降级关闭。
- vendored 上游内容版权归原作者，见 `LICENSE` 的 Vendored upstream content 一节。
