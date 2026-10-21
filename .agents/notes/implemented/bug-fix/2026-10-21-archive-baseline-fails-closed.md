# Agent Note: 归档基线读取失败与历史清单不存在分别处理

Status: implemented

本篇补充[归档路径验证](../testing/2026-10-19-client-bundle-and-archive-paths-verified.md)：既有验证涉及磁盘封印，本篇处理 Git 历史基线的读取与比较，不取代既有归档流程决定。

## Problem

受管技能的归档脚本把 Git 历史清单读取失败视为清单不存在。真实临时 Git 仓库回归证明：指定不存在的 AGENT_NOTE_ARCHIVE_BASE_REF 时，原路径仍返回 passed: true、exitCode: 0。这会跳过历史封印的只增不改检查。

上游 A 的归档校验区分有效提交、历史树中没有清单、历史清单读取失败。本插件需要吸收这一判据，同时保留上游 B 受管技能文件的完整性。

## Decision

插件自有 lib/notes.js 在执行 archived 门禁前校验 Git 基线。仓库存在时，先把基线解析为提交对象，再检查历史树中的清单条目；条目不存在允许继续，提交无效、树读取失败、清单读取失败或 JSON 损坏均返回失败。历史 files 必须是非数组对象，历史封印被删除或修改均返回失败。

路径由 Git 在笔记根目录返回的 --show-prefix 构造，配合 --literal-pathspecs 和 ls-tree --full-tree，避免 Windows 长路径与 8.3 短路径别名之间的绝对路径比较。验证后的提交 OID 传给后续受管脚本，避免两阶段解析可变 ref 得到不同提交。

没有 Git 仓库或 Git 程序缺失时保留磁盘封印校验的可移植路径；其他仓库发现错误和超时返回失败。该兼容分支现由 tools/non-node-project.test.mjs 覆盖（PATH 指向空目录，git 以 `spawn git ENOENT` 落到该分支），并通过。

空仓库（`git init` 之后一次都没提交）单独处理：HEAD 是未诞生的符号引用，解析不出 commit 时不判失败，继续交给受管脚本校验磁盘上的清单 —— 历史为空就没有任何历史封印可比对。判据是 `symbolic-ref --quiet HEAD` 成功，避免把任何解析失败都当成空仓库。显式指定的基线解析不出仍然失败关闭：那时调用方明确说了以哪个提交为准，静默忽略等于把门禁降级成空转。

## Alternatives considered

- 直接修改受管归档脚本：逻辑集中，最接近上游实现；但会破坏受管内容哈希与同步边界，因此在插件自有包装层补齐判据。
- 对仓库根与笔记根执行 realpathSync 后比较绝对路径：实现直接，也能处理常见符号链接；实测 Windows 长短路径别名仍导致有效基线被误拦，因此使用 Git 自己返回的仓库内前缀。
- 继续把所有 git show 失败视为历史清单不存在：兼容首次建立清单的仓库，代码最少；但真实回归证明它也放过无效基线，因此只允许历史树中确实没有条目的情况。
- 任何解析不出基线的仓库一律失败关闭（含空仓库）：最保守、最少分支，空仓库也会红；被否是因为新建仓库第一次会话就开规范是真实用法，此时历史为空、根本没有可篡改的封印，判红是纯误报，还会教人加 `--no-verify` 绕过。改为只对「HEAD 是未诞生符号引用」这一可判定的情形放行。
- 用 `git rev-list --count HEAD` 等于 0 判定空仓库：语义直白；被否是因为它在部分仓库形态（浅克隆、替换对象）下会因其它原因失败，仍无法区分「历史为空」与「基线写错」。

## Consequences

收益是无效基线和历史封印变化不再静默通过，且不修改受管技能。代价是 archived 门禁增加 Git 子进程与包装层逻辑，需要随受管脚本演进复核重复检查。

当前回归覆盖九种基线情况（有效提交无历史清单、无效 ref、空仓库、空仓库 + 显式基线、历史清单与当前一致、损坏历史 JSON、历史 files 数组、历史封印删除、历史封印修改），但尚未覆盖所有 Git 故障与特殊仓库布局；也不证明调用方提供的基线本身可信。基线选择仍由调用方与 CI 配置负责。

「历史清单与当前一致应通过」这条正例**单看不能**证明 `ls-tree` 真查到了条目：查不到时会走「历史无清单」分支，同样放行。区分两者的是「历史清单损坏必须失败」——查不到就会放过一份坏 JSON，只有真查到了才会红。正例守的是「查到了也别误报」。

## Verification

原始无效 ref 回归为红：预期失败，实际 passed: true、exitCode: 0。

修复后 node --test tools/archive-baseline.test.mjs 的九项全部通过，退出码 0。

**故障注入（真红）**：把「空仓库放行」分支改回「一律失败关闭」后重跑 archive-baseline 与 verify-notes-standalone，**2 项红**（`空仓库（git init 未提交）不判基线非法`、`独立仓库：自带 .agents/skills/…/scripts 时必须真的验它自己的笔记`），其余 13 项绿；恢复代码后 15 项全绿。这条注入同时证明：空仓库场景在两条不同入口上都被回归守着，且「修好了」不是靠测试变宽。

**故障注入（历史清单查询本身）**：把 `lib/notes.js:625` 的 `manifestRel` 改成 `archived/MUTANT-does-not-exist.json` 后重跑 archive-baseline，**5 pass / 4 fail**，红的正是四条历史清单用例（损坏 JSON、files 数组、封印删除、封印修改）；`cp` 还原后 9/9 绿。这条注入针对的正是当日修掉的路径混淆缺陷（Git 的 `C:/Users/<长用户名>/…` 与 Node 的 `C:\Users\<8.3 别名>\…` 不等）：它证明测试绑定的是真实的 `--literal-pathspecs ls-tree --full-tree` 查询，而不是一个假路径恰好也能绿的形状。

随后 node --test tools/archive-baseline.test.mjs tools/plugin.test.mjs tools/no-fake-green.test.mjs 共 27 项通过，退出码 0。夹具使用独立临时 Git 仓库，提交仅发生在夹具内，并在 finally 清理。此结果不是全量检查、实机验证或整体上游对齐完成结论。
