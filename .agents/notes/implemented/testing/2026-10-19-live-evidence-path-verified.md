# Agent Note: 实机证据与 check:full 已核查，路径可用且接线正确

Status: implemented

> 同属**全流程核查**这条线，与
> [2026-10-19-client-bundle-and-archive-paths-verified.md](./2026-10-19-client-bundle-and-archive-paths-verified.md)
> 是同一批（那一篇查客户端与归档，本篇查发布流程与实机证据）。
> 门禁链本身的完整性见
> [2026-10-19-gates-that-nobody-runs-are-not-gates.md](../process/2026-10-19-gates-that-nobody-runs-are-not-gates.md)。

Independent: 本篇核查的是**实机证据链**（需真实 DSH 宿主），与纯本地门禁链、
客户端 bundle、归档机制是不同的失效面 —— 它是唯一验证「宿主真的认」的路径。

## Problem

goal 点名要核查「发布流程」与「命令/工具」。25 个 npm scripts 里有一个特殊项：

```
evidence      node tools/live-evidence.mjs     ← 需真实 DSH
check:full    npm run check && npm run evidence
```

它与所有其他门禁的区别是**依赖外部环境**（真实的 DSH 安装），所以：

- 不在 `check` 链里（那个必须纯本地可跑）
- 不在 CI 里（CI 没有 DSH）
- **只由人主动跑 `check:full`**

前几轮的教训是「有机制但可能从未真跑过」（归档路径）。所以这条也要真的驱动一次，
并确认它的接线是否合理。

## Decision

### 一、实机证据真能跑，且验的是真宿主

用本机真实 DSH 跑：

```
DSH 位置: .../dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js
真实 SkillRegistry: function
真实 ToolRuntime  : function
真实 CommandRuntime: function

✔ SkillRegistry 已自动注册为 ctx.skills
✔ SkillRegistry.list() 返回了 agent-notes（共 1 项）
✔ source 为 bundled
✔ 模型可调用 / 用户可调用
✔ description 非空
✔ SkillRegistry.get() 取到完整定义
✔ 正文长度 7887 > 500
✔ 正文已剥掉 frontmatter
✔ resourceBase 指向目录（相对引用可解析）
✔ 未知名技能返回 undefined（契约）

实机证据通过
```

三条前提都核过：

| 前提 | 结果 |
|---|---|
| 无 DSH 时退出码是 2（「无法进行」而非「通过」） | ✔ exit=2，并说明怎么修 |
| 用的是**真** DSH 模块，不是 stub | ✔ `createRequire(<DSH_DIST>/package.json)`，全文无 stub/mock |
| 本机实跑通过 | ✔ exit=0，10 项断言全过 |

### 二、`check:full` 完整跑通

```
DSH_DIST=... npm run check:full   → exit 0
```

`check` 的 12 步 + 实机证据全部通过。

### 三、接线是对的，不需要改

| 验证方式 | 用什么 | 在 check 链 | 在 CI |
|---|---|---|---|
| `integration.test.mjs`（10 用例） | 假宿主（stub） | ✔ | ✔ |
| `npm run evidence` | **真 DSH** | ✘（只在 `check:full`） | ✘（CI 无 DSH） |

两者互补：前者验「插件能被挂载」，后者验「真注册表接受」。**这个分工是合理的**，
不是缺口 —— 实机证据依赖具体 DSH 版本，放进 CI 会让「DSH 升级」与
「我们的插件坏了」混为一谈。

### 四、探测不到本机 DSH 是**有意取舍**

本机 DSH 在 `dsh-tauri/dependencies/`（Tauri 客户端特有布局），而
`findDshDist()` 只查 `$DSH_DIST` → `$DSH_HOME` → `~/.dsh` → 逐级向上。

源码注释写明了理由：**不硬编码本机路径（那会让别人跑不起来，也会把机器信息
带进公开仓库）**。

所以这不是覆盖不足，是刻意的取舍：宁可让人显式设 `$DSH_DIST`，也不猜一个
只有某台机器才有的路径。

## Alternatives considered

- **把 `evidence` 接进 `npm run check`** — 让每次 check 都验实机。**这是本篇最强的一条被否方案**：它能保证实机契约持续被验证。否掉因为 `check` 的核心承诺是「**纯本地、不需 DSH**」（AGENTS.md 明写）。接进去会让没装 DSH 的人跑不了 check，而那是本插件「脱离 DSH 也能用」的前提。**为一条验证牺牲核心承诺，方向错了。**
- **把 `evidence` 接进 CI** — 让远端也验。否掉因为 CI 没有 DSH，且装上 DSH 意味着 CI 要跟上游版本走；那时「DSH 升级导致红」与「插件坏了」会混在一起，排查成本高于收益。
- **给 `findDshDist` 加 `dsh-tauri/dependencies/` 候选** — 让本机零配置可跑。否掉因为那正是源码注释明确拒绝的「硬编码本机路径」——它只对 Tauri 客户端用户有效，对其他人是噪音，且会把客户端特有的目录结构带进公开仓库。
- **把 `evidence` 固化成定时任务（每周跑一次）** — 保证不长期不跑。否掉因为它需要一台装了 DSH 的机器持续可用，而本仓库没有这样的基础设施。**重访信号记在下面。**

## Consequences

- **收益**：确认实机证据链**真能工作**，且验的是真宿主而非 stub。这消除了一个重要的不确定性 —— 若 `lib/skill.js` 与宿主契约漂移，这是唯一能发现的路径。
- **收益**：确认 `check:full` 端到端可跑（12 步门禁 + 实机证据）。
- **收益**：确认「探测不到本机 DSH」是**有意设计**而非缺陷 —— 这一点此前没被记录过，容易被误认为 bug 去「修」。
- **代价与已知上限**：`evidence` **仍不在任何自动门禁里**。所以「宿主契约有没有漂移」这个问题，只有在有人主动跑 `check:full` 时才有答案。**这是明知的缺口**，且短期内没有低成本解法（需要装了 DSH 的 CI）。
- **代价与已知上限**：本篇的核查依赖本机恰好装了 DSH（Tauri 客户端）。在没有 DSH 的机器上，这条路径无法被验证 —— 包括本仓库的 CI。
- **代价与已知上限**：`check:full` 不在 CI 的 `ci:align` 豁免表里 —— 因为 `ci:align` 只比 `check` 链与 CI。`check:full` 是 `check` 的超集，不参与那个比对。这是正确的，但值得记下：**若将来 `check:full` 新增了不属于 `check` 的步骤，`ci:align` 不会知道**。
- **重访信号**：
  - 若出现「DSH 升级后插件在某处失效，而本地全绿」的事故 → 说明实机证据必须进自动化，届时考虑 CI 里装 DSH。
  - 若有了一台常驻的、装了 DSH 的机器 → 把 `evidence` 做成定时任务（每周一次），比接进每次 check 更合适。
  - 若 `check:full` 新增了 `check` 之外的步骤 → 要确认 `ci:align` 是否该扩展去覆盖它。

## Verification

```sh
# 无 DSH 时：exit 2，明确说怎么修
node tools/live-evidence.mjs; echo $?

# 有 DSH 时：exit 0，10 项断言
DSH_DIST=<path>/lib/bin.js node tools/live-evidence.mjs
# 目录形式同样可以（2026-10-21 起）：DSH_DIST=<path> node tools/live-evidence.mjs

# 端到端
DSH_DIST=<path>/lib/bin.js npm run check:full
```

### 一个我自己踩的坑

第一次测无 DSH 时的退出码，我用的是：

```sh
node tools/live-evidence.mjs 2>&1 | tail -12; echo "EXIT=$?"
```

输出 `EXIT=0` —— 我以为发现了假绿。**实际那是 `tail` 的退出码，不是 node 的。**

去掉管道重测：

```sh
node tools/live-evidence.mjs > /dev/null 2>&1; echo $?   # → 2 ✔
```

这与本仓库反复强调的「以退出码为准」是同一件事的两面：**管道会吃掉真实退出码**。
在 bash 里 `$?` 取的是管道最后一个命令的状态，除非用 `PIPESTATUS`。
