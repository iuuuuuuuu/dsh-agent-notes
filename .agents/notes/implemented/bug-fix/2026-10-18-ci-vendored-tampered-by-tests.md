# Agent Note: CI 上「本地全绿、远端必红」的 vendored 篡改

Status: implemented

## Problem

推送 v0.4.1 后 CI 稳定失败，本地**一切全绿**。失败集中在两条：

```
not ok 95 - 同步清单确实存在且覆盖全部上游文件
  --check 在上游一致时应 exit 0，实际 1
  相同 15｜变更 6｜新增 0
    ~ SKILL.md  (行数 192 → 196，+4)
    ~ scripts/build-board.ts  (行数 236 → 236，+0)
    ...
```

最刺眼的是：**这 6 个文件正是我刚合并的那 6 个**，`192 → 196` 也正好是
合并前后的行数。看起来像「合并没生效」。

但事实是合并**生效了**：`88d504f` 里 21 个文件的摘要与清单逐一比对全部一致；
GitHub 上 `main` 的 blob sha 与本地完全相同；真 `git clone https://…` 出来的
干净副本跑 `npm run sync:check` 是绿的（连跑 3 次都绿）。

**故障只在 CI 的运行环境里出现。**

## 排查过程（这条弯路本身值得记）

我先花了很多时间怀疑「上游 CDN 返回旧缓存」「rebase 把文件搞坏了」「检出内容不对」，
全部方向都是错的。真正让我转向的是给 CI 加仪表：把原本一条
`npm run verify && notes:gate && npm test && fault-injection` 拆成多步，
在 `npm test` **前后**各打一次 `SKILL.md` 的 sha256。

一次就拿到了决定性证据：

```
测试前: bb76d4d...（与清单一致，检出完全正常）
测试后: 0e6628c...（合并前的旧版！）
git status: M skills/agent-notes/SKILL.md 等 6 个文件
```

**检出是对的，是 `npm test` 自己把真实 vendored 文件改回了旧版。**

这里有个方法论教训：前面几轮我都在「推断 CI 环境哪里不同」，而正确做法是
**先在 CI 里装仪表取第一现场数据**。一旦拿到前后摘要，根因本身就已经指出来了。

## Root cause

`lib/index.js` 的 `apply()` 里有一行 fire-and-forget：

```js
scheduleSkillUpdate({ log, onUpdated });   // 不传 targetDir
```

`updateSkillCopy` 的 `targetDir` 是可选的，不传就落到**真实的**
`skills/agent-notes`。它会去拉 jsDelivr 上 `iuuuuuuuu/dsh-agent-notes@main`
的全部 21 个文件，逐个 `renameSync` 覆盖。

而 `tools/integration.test.mjs` 真的调用 `applyPlugin(ctx, …)` ——
于是**跑集成测试就等于跑了一次真实自更新**。

链路在本地断掉、在 CI 打通的原因是两处差异叠加：

1. `skills/agent-notes/.synced-version` **没有被 git 跟踪**。本地有这个文件
   （值为 `0.4.1`），`updateSkillCopy` 走快速路径「版本相同 → 直接 return」，
   什么都不拉。CI 是全新 clone，**没有这个文件**，快速路径失效，只能全量拉。
2. 推送瞬间，jsDelivr 上 `@main` 的缓存仍指向上一个 commit。于是拉下来的是
   **旧内容**，把刚检出的新版覆盖成旧版。

两条缺一不可，所以本地怎么跑都绿。

故障注入验证（这是确认根因的关键，不是推测）：

| 条件 | 结果 |
|---|---|
| 传 `skillDir` 到沙箱 | `bb76d4d` —— 保持新版 |
| 去掉注入（模拟 CI）| `0e6628c` —— **变成旧版，与 CI 现象逐字吻合** |

## Decision

**① `apply()` 接受 `config.skillDir`，透传给 `scheduleSkillUpdate` 的 `targetDir`。**

生产路径不传，行为不变；测试必须传。**没有做成「测试模式开关」**，
因为那会让生产与测试走不同分支，等于测的不是真代码。

**② `integration.test.mjs` 的 `mount()` 每个实例开一个技能沙箱**，通过
`config.skillDir` 注入，进程退出时统一清理。

**③ CI 加永久门禁「测试不得改动工作区」**（不是临时诊断）：`npm test` 之后
断言 `git status --porcelain` 为空，非空就打出完整 diff 并 `exit 1`。

**④ `self-update.test.mjs` 的「立即返回」测试也补了 `targetDir`**：它原先传
`{}`，同样是碰真实目录。虽然探针显示该场景下后台任务会卡在首个 `await`
直到 30 秒超时、实际没写盘，但那是**依赖时序巧合**干净，不是设计上干净。

## Alternatives considered

- **把 `.synced-version` 提交进 git** — 最省事，CI 一 clone 就有它，快速路径
  生效，什么都不拉，问题「消失」。否掉是因为**它只是掩盖**：一旦版本号变化
  （每次发版都会），快速路径立刻失效，同样的问题在发版后必然重演；而且
  它让「测试会写生产目录」这个真缺陷继续潜伏。治的是症状不是病。
- **让 `updateSkillCopy` 在 `NODE_ENV=test` 时直接 return** — 一行就够。
  否掉：这与「零依赖、按真实路径跑」的设计相悖，且会让测试永久失去覆盖
  这条自更新链路的机会。而且环境变量式的开关很容易被漏设，漏设就等于
  又回到会写真实目录的状态 —— 失败方向是危险的。
- **把 `scheduleSkillUpdate` 从 `apply()` 里挪到别处，测试就不触发** —
  能让测试干净，但那是为了测试而改变生产结构。自更新必须挂在 `apply()`
  里才能在用户机器上生效，挪走等于砍功能。
- **给 `targetDir` 设成必填参数** — 最彻底，编译器/运行时会强制每个调用点
  想清楚写哪里。否掉：这是对外的 `apply()` 契约（DSH 宿主按约定调用插件），
  加必填参数会让宿主调用直接报错。用在测试侧传值即可。
- **只在 CI 里 `git checkout -- skills/agent-notes` 重置** — 简单粗暴，
  门禁会绿。否掉：那是**把红抹掉**而不是修好，等于承认「测试会改工作区」
  并把它常态化；而且重置发生在测试后，被覆盖期间的测试读到的是错内容
  （本次 `project-skill` 那条 `behind=true` 就是这么被带红的）。
- **改用 `--test-concurrency=1` 串行跑** — 试图避开竞态。否掉：实测串行
  也红（因为污染不是竞态，是确定性的自更新），而且串行会拖慢门禁。

## Consequences

- **收益**：`npm test` 不再改动真实工作区。这条缺陷此前会让本地与 CI 结论
  长期背离 —— 那是最坏的一类不一致，因为它让人开始不信任门禁。
- **收益**：CI 新增「测试不得改动工作区」断言后，同类「测试有写盘副作用」
  的缺陷会当场变红，而不是拖到后面的步骤以别的面目失败（本次它伪装成
  「上游合并没生效」）。
- **收益**：`config.skillDir` 让「自更新写到哪」变成可注入的，为将来
  多 profile / 多副本场景留了口子。
- **代价**：`apply()` 多一个配置项。它只在测试里用，属于「为可测性开放的
  注入点」，需要在文档里说明它不是给终端用户调的。
- **代价**：集成测试每个 `mount()` 多一个临时目录，进程退出时清理；
  若测试进程被强杀，`/tmp` 会残留 `an-int-skill-*` 目录。
- **未解决（有意）**：`.synced-version` 仍不进 git。它本来就是纯性能优化，
  丢失只让下次退化成全量比对 —— 现在全量比对已经是安全的了，所以不需要
  靠提交它来兜底。
- **重访信号**：若将来有人在 `apply()` 里再加 fire-and-forget 的写盘逻辑，
  「测试不得改动工作区」这条门禁会立刻红。看到它红时，**不要**用
  `git checkout` 抹掉，去找那个副作用并给它一个可注入的目标目录。

## Verification

```sh
npm test                          # 110 项，且跑完 git status 为空
npm run verify
npm run notes:gate                # 10 篇
npm run gate:fault-injection
```

故障注入（真实执行，非推断）：

```sh
# 1. 模拟 CI 全新 clone（移走未被跟踪的 .synced-version）
mv skills/agent-notes/.synced-version /tmp/sv.bak
node --test tools/integration.test.mjs
sha256sum skills/agent-notes/SKILL.md      # → bb76d4d（干净，修复生效）

# 2. 去掉 config.skillDir 注入，同样条件重跑
#    去掉 lib/index.js 里透传 targetDir 的那一段
node --test tools/integration.test.mjs
sha256sum skills/agent-notes/SKILL.md      # → 0e6628c（被覆盖成旧版）
git status --porcelain skills/             # → 6 个文件 M
```

第二组与 CI 报的现象**逐字吻合**（6 个文件、旧摘要），这是根因确认的根据，
而不是「改完就好了」式的猜测。
