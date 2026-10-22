# Agent Note: 门禁要长在远端，否则 13 道都只是自觉

Status: implemented

> 同属**流程补齐**这条线。
> 覆盖门禁（本地那半道）见
> [2026-10-18-notes-coverage-gate.md](./2026-10-18-notes-coverage-gate.md)，
> 本地钩子（另一个「只在本地有效」的环节）见
> [2026-10-19-hooks-install-breaks-on-short-paths.md](../bug-fix/2026-10-19-hooks-install-breaks-on-short-paths.md)。

Independent: 本篇处理的是**远端分支保护**这个不在版本控制里的环节，
与本地门禁的实现、浏览器端逻辑、文档同步都无关。

## Problem

本仓库已经有 13 道门禁（`npm run check` 的 11 步 + 故障注入自证），
CI 工作流也在 `push` 和 `pull_request` 上跑。

但 `main` 分支**没有任何保护**：

```
$ gh api repos/iuuuuuuuu/dsh-agent-notes/branches/main/protection
{"message":"Branch not protected","status":"404"}
```

这意味着 `git push` 可以直接推上 `main`，13 道门禁全靠本地自觉。
CI 会在事后显示红/绿，但**已经写进历史了** —— 要么改写历史（AGENTS.md 里
明令禁止裸 `--force`），要么就那样留着。

更具体的三条绕过路径，每条都实测可行：

1. `git commit --no-verify` 绕过本地 commit-msg 钩子（这条此前已知）；
2. `git push` 直推 main，跳过 PR 与 CI 的必需检查；
3. `git push --force` 改写已推送的历史。

第 2、3 条此前**完全没有任何机制阻拦**。

## Decision

给 `main` 配分支保护（`admin` 权限操作，用户明确授权后执行）：

| 设置 | 值 | 理由 |
|---|---|---|
| `required_status_checks.contexts` | `["verify"]` | CI 的主 job 必须过 |
| `required_status_checks.strict` | `true` | 要求分支与 `main` 同步，杜绝「拿旧 main 推上去」 |
| `enforce_admins` | `true` | 管理员也受约束，否则这条规则对 owner 无效 |
| `allow_force_pushes` | `false` | 落实 AGENTS.md 里「`--force` 永不允许」 |
| `allow_deletions` | `false` | 防误删分支 |

**刻意不设** `required_pull_request_reviews` —— 用户选的是「必需检查 + 禁
force push」，不要求所有改动走 PR。

`must`：**`upstream-drift` 不设为必需检查**。那个 job 跑 `git ls-remote`，
而脚本在网络不可达时**故意**退出 2（查不到也必须红）。把它设为必需会让
「网络抖动」变成「无法推送」——用门禁的既定设计去惩罚用户，且失败原因与
代码无关。`verify` 才是判断代码质量的权威。

### 验证保护真的生效（不能只看 API 返回 200）

配完之后用三个真实推送验证：

| 场景 | 期望 | 实测 |
|---|---|---|
| `git push --force` → `main` | 拒绝 | **exit 1**，`GH006: Protected branch update failed ... Required status check "verify" is expected` |
| `git push --force` → 普通分支 | 允许（对照） | **exit 0**，推到 `probe-allowed` 成功 |
| 清理测试分支 | 成功 | 已删，远端只剩 `main` |

对照那条是关键：**只测「被拒绝」不能证明是保护在拦**，也可能是网络、鉴权
或 refspec 写错。对照组证明 force push 在别处是通的，所以 `main` 上的拒绝
确实来自分支保护。

### 这个设置不在 git 里

分支保护存在 GitHub 侧，**不随 clone 走**。下一个维护者看不到它，也没人
会提醒他「你绕过了一道门禁」。所以它必须写进笔记 —— 这是本篇存在的理由：
若只有配置没有记录，一年后没人知道它被设过、被谁设的、为什么这么设。

## Alternatives considered

- **一并设 `required_pull_request_reviews`（强制 PR + review）** — 更强。否掉是因为用户明确选了「必需检查 + 禁 force push」。单人多仓库的工作流下强制 PR 会增加摩擦，而当前的门禁强度（13 道 + CI）已足够支撑质量底线。需要时再加，不必一次到位。
- **用 `CODEOWNERS` + review 要求** — 更细的职责划分。否掉是因为仓库只有一个维护者，CODEOWNERS 解决的是「谁该 review」的问题，而这里没有第二个人。它是为团队协作设计的，不是单人项目的需求。
- **只靠 CI，不设保护** — 零配置。否掉是因为 CI 是**事后**信号：红了的 commit 已经在历史里，而本仓库明令禁止改写历史（裸 `--force` 永不允许）。事后信号与不可改写历史之间存在缺口，分支保护正是补这个缺口的东西。
- **写一个脚本每次 push 前检查保护是否还在** — 防御「保护被人关掉」。否掉是因为过度：关保护需要 admin 权限，那本身就是一个显式的、留痕的动作（本次操作就留了 API 调用记录）。而脚本要么依赖 `gh` CLI（外部工具），要么自己解析 API（更重），都不如「记录下来 + 靠 review 时的自觉」划算。**若将来出现多人协作，这条该重新评估。**
- **把分支保护配置写进仓库配置文件（如 `.github/protection.yml`）** — 配置随 clone 走。否掉是因为 GitHub 不支持这种声明式配置（它只有 Rulesets，那是组织级功能，个人仓库用不了）。只能记进文档。

## Consequences

- **收益**：13 道门禁第一次有了**远端强制力**。此前它们全靠本地自觉，而本地钩子可被 `--no-verify` 绕过、直推可跳过 CI、改写历史无人拦。
- **收益**：落实了 `AGENTS.md` 里已有的「`--force` 永不允许」规则 —— 那条规则此前**只有文字约束**，没有任何机制支持。
- **代价与已知上限**：`strict: true` 要求分支必须与 `main` 同步，所以推新 PR 前需要先 merge 或 rebase main。日常单线推进（本地直接 commit + push）会因此受阻 —— **这是本次配置带来的真实行为变化**：后续若要在本地直接推 main，必须先走 PR。这是有意的取舍（用户选了「必需检查」），但值得写明。
- **代价与已知上限**：这个设置**不在版本控制里**。仓库被 fork 或迁移到别处时不跟随（fork 的保护设置独立维护）。若迁移，需要重新配置 —— 本篇的表格就是迁移清单。
- **代价与已知上限**：验证保护需要**真实推送**，无法在离线或 CI 里做。所以这个检查不在 `npm run check` 里，它是一次性的手动验证。若将来有人误关了保护，`npm run check` 依然全绿。
- **重访信号**：若开始走多人协作，应重新评估加 `required_pull_request_reviews` 与 `CODEOWNERS`。若改用 GitHub Rulesets（组织级），本篇的配置方式需整体替换。

## Verification

用真实推送验证（探针：`.probe/tmp/branch-protection-probe.mjs`，不入库）：

```sh
gh api repos/iuuuuuuuu/dsh-agent-notes/branches/main/protection --jq '{
  checks: .required_status_checks.contexts,
  strict: .required_status_checks.strict,
  admins: .enforce_admins.enabled,
  force: .allow_force_pushes.enabled,
  delete: .allow_deletions.enabled
}'
```

实测结果：`checks=["verify"] strict=true admins=true force=false delete=false`。

⚠️ 探针本身踩了两个坑，都已写在探针注释里：
1. `git push --force` 相同内容会报「Everything up-to-date」直接跳过 ——
   那样测出的「成功」毫无意义，必须造真实请求。
2. 两个提交的 sha 必须在第二个提交**之前**取，否则两次 `rev-parse HEAD`
   返回同一个值，refspec 报「does not match any」。
3. `spawnSync` 的 git 调用必须显式给 `cwd`，否则继承 Node 进程的目录，
   在别的仓库里读到无关状态。
