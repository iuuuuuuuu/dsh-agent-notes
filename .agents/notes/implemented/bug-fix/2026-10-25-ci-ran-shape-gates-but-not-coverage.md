# Agent Note: CI 只跑了「形状门禁」，没跑「覆盖门禁」

Status: implemented

> 这是**我自己交付物里的缺陷**，由 Owner 在真实仓库上发现：
> 「lan_pc_control 这个仓库没有走 pr 提交，工作 ci 也没被拦截，笔记就记了三篇」。
> 相关：[2026-10-24-configure-notes-gate-for-other-repos.md](../process/2026-10-24-configure-notes-gate-for-other-repos.md)
> 那篇讲的是**脚本副本**怎么升级，
> 本篇讲的是**CI 该跑哪几道门禁** —— 两者是不同的问题，我当初把它们混成了一个。

## Problem

给 6 个在用仓库接 CI 时，我写进 `verify-notes.yml` 的是三道 vendored 门禁：

```
verify-agent-note-tree.ts     → 目录/分类/文件名
verify-agent-note-format.ts   → 头部与必备小节
verify-archived-agent-notes.ts→ 归档封印
```

这三道回答的是「**已有的笔记写得对不对**」。而 Owner 关心的是另一件事：
「**改了代码却不写笔记**」——那由 `tools/notes-coverage.mjs` 负责，它既没有被拷进
那些仓库，也没有出现在 workflow 里。

实测（lan_pc_control 的 master）：CI 落地之后有 **5 个功能提交一条笔记没带**，
CI 全绿，笔记停在 3 篇。用覆盖门禁按同样的区间跑一遍，它精确点名了这 5 个提交：

```
$ node tools/notes-coverage.mjs --since fa2d6e2
✖ 有 5 个提交改了受管路径却没带决策笔记。
  cf33884  feat(v1.0.2-pre): 修扫描失效、本机免配对、…
  0c9e27e  feat(v1.0.2-pre): 设置页加开机自启开关…
  75affb7  fix(v1.0.3-pre): 白屏、托盘打开客户端…
  b0cc6b5  fix(v1.0.4-pre): 主题落盘记忆…
  aae4fed  chore: 补入 prefs.rs / normalizeStatus / 本机页…
```

也就是说：**门禁是好的，是我没把它接进去。** 一个只验「已有笔记形状」的 CI，
在「没写笔记」这件事上是**恒绿**的 —— 这恰恰是本仓库最忌的那种失效形态：
它显示通过，而它要防的事情正在发生。

还有第二层：这些仓库**都没有分支保护**（`gh api .../protection` → 404），
所以直推 master 可行、CI 不是必需检查 —— 就算 CI 红了也照样推得上去。
「没走 PR」与「CI 没拦住」是同一个原因：没人要求。

## Decision

### 一、CI 必须同时跑「形状」与「覆盖」两组门禁

`verify-notes.yml` 增加一步 `Notes coverage`，并把
`tools/notes-coverage.mjs`、`tools/notes-supersession.mjs` 一并装进目标仓库
（两者只依赖 Node 内置模块，脱离插件可跑）。

### 二、base 按事件类型取，取不到就失败关闭

```
PR        → github.event.pull_request.base.sha   （--since 自己求 merge-base）
push      → github.event.before                  （上一次推送的 tip）
首推/其它 → HEAD~1                                （只查最后一个提交）
```

`must`：**base 解析不出来时不许降级成「没东西可查」**。`before` 是全零 sha
（新分支首推）或该提交不在本地历史（浅克隆）时，直接 exit 2 并说明原因 ——
降级的后果正是本轮要修的那个形态：查了 0 个提交，然后报告通过。

### 三、「覆盖」与「形状」是两个问题，不能用一个门禁的绿去代替另一个

`notes-coverage.mjs` 有 `--since` / `--range` / `--message-file` 三种目标；
`Note-Skip:` 在区间模式下**逐提交**生效（一个提交的 Skip 不能替另一个顶账）。

## Alternatives considered

- **只装本地 `commit-msg` 钩子，不接 CI** — 零 CI 成本，提交时就能拦。**否掉因为它可被绕过**：`git commit --no-verify` 一句话就没了，而且钩子要在每个 clone 上手动装一次（`npm run hooks:install`），换台机器就忘。CI 是权威那道，这个判断在本仓库 2026-10-19 的笔记里已经定过。
- **把覆盖检查塞进 vendored 的三道脚本里** — 一处生效、不用多装两个文件。**否掉因为它不属于上游的职责**：vendored 只认「笔记树本身」的规则；「这次改动的代码有没有配笔记」是插件侧的流程判据（要看 git 区间、要认 `Note-Skip`）。塞进去等于改上游语义。
- **只在文档里写清「CI 要跑 coverage」，不动模板** — 最省事。**否掉因为它就是本轮失效的成因**：文档写对了，模板还是只跑三道，人照着模板走。能被复制的模板必须自带正确行为。
- **靠分支保护兜底（不跑 coverage，只要求 PR）** — 有 PR 就有人看。**否掉因为「有人看」不是判据**：本轮这 5 个提交是人推的，人自己没觉得缺笔记；要靠机械判据，不能靠自觉。
- **把历史那 5 个提交补上笔记** — 让仓库「看起来合规」。**否掉因为那是补作业**：`--since` 只查区间内的提交，历史不会被翻旧账；为历史补 5 篇编出来的笔记，正是 Owner 反复说的「为了写笔记而写笔记」。

## Consequences

- **收益**：CI 现在能回答两个问题 —— 「已有笔记对不对」和「这次改动带没带笔记」。实测那 5 个提交会被精确点名。
- **收益**：6 个仓库都有了 `notes-coverage.mjs` / `notes-supersession.mjs`，可以脱离插件跑（只依赖 Node 内置模块）。
- **收益**：`base` 取不到时失败关闭，不会再出现「查了 0 个提交 → 通过」。
- **代价与已知上限**：目标仓库多两个文件（各约 20KB / 13KB）。它们与插件里的版本会随发版漂移 —— 目前靠 `configure-notes-gate.mjs` 手工同步，**没有** `--check` 覆盖这两个文件（它只管 vendored 脚本）。见重访信号。
- **代价与已知上限**：**CI 绿了不等于「拦住了」。** 没有分支保护时，失败的 CI 只是红着，推送照样成功。
  2026-10-25 已替 Owner 在可用的仓库上开启，实测直推被拒（`Required status check "verify" is expected`）。两条实测结论：
  - **免费计划的私有仓库开不了分支保护**：GitHub 直接返回
    `Upgrade to GitHub Pro or make this repository public`（分支保护与 rulesets 都拒）。
    这 6 个仓库里 4 个是私有仓，因此只有 public 的 `landeck` 与 `dsh-reverse-skill` 开成了。
    要覆盖私有仓，只有升 Pro 或改公开——都不由本插件决定。
  - `dsh-reverse-skill` 只能**要求 PR、不强求 verify**：它的 workflow 带 `paths` 过滤，
    检查可能永不触发，一旦设成必需检查就会让所有 PR 永久挂起。
- **代价与已知上限**：启用覆盖门禁后，**第一次推送**若提交没带笔记，CI 会立刻红 —— 那是正确行为，但需要使用者知道 `Note-Skip:` 这个出口。
- **重访信号**：
  - 若这 6 个仓库里开始有人手工改 `tools/notes-coverage.mjs` → 该把它纳入 `configure-notes-gate --check` 的比对范围。
  - 若 Owner 开启分支保护 → 把「verify 是必需检查」写进各仓库自己的笔记，别只留在 GitHub 设置里。
  - 若出现「CI 因为 base 取不到而恒 exit 2」→ 说明该仓库的推送方式（force push / 浅克隆）需要显式给 `NOTES_COVERAGE_BASE`。

## Verification

真跑（不是看 YAML）：按 workflow 里那一步的 shell 逻辑，用真实事件参数在 6 个仓库上跑。

| 场景 | 结果 |
|---|---|
| lan_pc_control，`before=fa2d6e2`（那 5 个提交之前） | ✖ exit 1，精确点名 5 个提交 |
| lan_pc_control，`before=HEAD`（无新提交） | ✔ exit 0，「检查了 0 个提交」 |
| 其余 5 个仓库，`HEAD~1`（单提交推送） | ✔ exit 0，逐个显示「已用 Note-Skip 放行」 |
| lan_pc_control，`HEAD~1` | ✖ exit 1 —— 那个提交（`chore: 补入 prefs.rs…`）确实没带笔记 |

最后一行很关键：它不是误伤，而是这道门禁第一次在真实仓库上说出真话。

最后一行很关键：它不是误伤，而是这道门禁第一次在真实仓库上说出真话。

## 补充（2026-10-25）：Owner 指出「为写而写」，机制改在施压点

Owner 的话是：「会——如果把门禁当『必写』的指令用，那你就要修复这个」。

修复前先做了体检，**结果和我原本的假设相反**：5 个仓库共 188 篇笔记，
没有一篇正文 < 300 字、没有标题撞车、只有 3 篇「提交里没有代码改动却补了笔记」
（属于事后补记）。抽查的几篇都有根因、取舍与「何时该翻案」——**没有成片的流水账**。

但**施压点是真的**，而且能定位到具体判据：覆盖门禁要求**每个提交各自**带笔记
（一条笔记不能替另一个提交顶账）。这条严格性防的是「一个提交带笔记、
后面跟三个不相干改动」，代价是**同一个决定拆成三次提交就得写三篇近乎重复的笔记**。
真实仓库里「实现 → 补测试 → 修 CI」正是最常见的拆法。

所以加了**第三个出口** `Note-Ref: .agents/notes/<既有那篇>.md`：
声明这次提交属于已有那篇论证，**不必再写一篇**。它比 `Note-Skip` 强的地方是
**可核对**——路径必须存在、必须在 `.agents/notes/` 下、必须是 `.md`，
写错一律判红（不许变成比 Skip 更廉价的后门）。

同时把注入的规范（`lib/policy.js`）补上三个出口与那句话：
**写不出「为什么不选另一条路」就不是决策，凑数的笔记比不写更糟**。

回归：4 条（Note-Ref 放行 / 指向不存在判红 / 指向树外判红 / 不写就红的对照组），
真变异（区间模式不认 Note-Ref）⇒ 首条用例红。
