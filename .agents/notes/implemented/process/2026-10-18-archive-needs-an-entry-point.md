# Agent Note: 归档必须有入口 —— 手写的封印没有意义

Status: implemented

> 同域：本篇补的是归档链路的**入口**。
> 归档笔记的格式与封印校验见
> [2026-10-17-notes-gate-cli-entry.md](2026-10-17-notes-gate-cli-entry.md)（门禁怎么接进去），
> 「新笔记触发 supersession 检查」见
> [2026-10-18-notes-supersession-check.md](2026-10-18-notes-supersession-check.md)。

## Problem

规范要求「完全取代的旧笔记应归档」，`archive-agent-note.ts` 也一直存在 ——
但**它从来没有 npm 入口**。只能这样用：

```sh
node skills/agent-notes/scripts/archive-agent-note.ts <路径>
```

或者更糟：跳过脚本，手写 `archived/manifest.json`。

### 手写封印为什么没有意义

`verify-archived-agent-notes.ts` 校验的是「manifest 里的哈希与文件内容一致」。
如果**两边都是人手填的**，它只能证明「填的那一刻两边对得上」，
证明不了「封印之后文件没被改过」。

而封印的全部价值就在后者：归档笔记是**冻结的历史快照**，
不该再被编辑。人手填哈希时，改完文件顺手更新哈希是完全自然的动作，
门禁照绿 —— 那时它保护的不是历史，只是「一个自洽的数字」。

**只有让机器算哈希，人改文件后哈希才会对不上。**

## Decision

新增入口：

```sh
npm run archive:note -- .agents/notes/implemented/<class>/<file>.md \
  [--superseded-by <新笔记路径>]
```

它直接调用 vendored 的 `archive-agent-note.ts`（`node` 原生跑 `.ts`，
不需要 tsx —— 本项目要求 node >= 22.19，type stripping 已可用）。

脚本负责：移动文件到 `archived/<class>/`、插入 `Archived: YYYY-MM-DD` 行、
**计算并写入哈希**、报告入站链接。

**must**：封印的哈希只能由脚本算。手写 `manifest.json` 得到的是一条
「自证清白」的记录，不是封印。

## Alternatives considered

- **只写进文档，提醒大家用 `node <路径>`** — 不用改代码。否掉：
  这正是当前失效的那一环。一个需要背路径的命令，实际使用中就会被
  简化成「直接改 manifest」。
- **用 `npx tsx` 跑**（vendored 脚本的建议写法）— 与上游文档一致。
  否掉：`npx` 会去网络拉 `tsx`，在离线环境或 CI 里不可靠；
  而本项目的 node 版本下限已经支持直接跑 `.ts`。
  少一个外部依赖，少一个失败点。
- **把归档逻辑搬进 `lib/`，做成插件命令** — 与「零依赖、vendored 内容
  不改」的架构更一致。否掉：`archive-agent-note.ts` 是 vendored 脚本
  （由 `sync-upstream` 管理、哈希被校验），搬进 `lib/` 等于分叉两份实现，
  上游改动后必定漂移。入口只需要转发，不需要重写。
- **让归档脚本自动 commit** — 少一步手工操作。否掉：脚本不该替人决定
  提交信息与提交范围，那属于使用者（见 AGENTS.md 的提交纪律）。
- **归档时自动修复入站链接** — 看起来更省事。否掉：脚本已经**报告**
  入站链接（`No active notes link to this archived note.`），但改链接需要
  判断「该指向新笔记还是删掉」，那是语义决定，不该机械做。

## Consequences

- **收益**：归档从「知道路径才能做」变成 `npm run archive:note -- <路径>`。
  封印的哈希由脚本算，人手改文件后**必然红**。
- **收益**：完整流程被实测验证：
  归档 → `ok: 1 archived note(s), 1 seal(s)`（绿）
  → 篡改归档文件 → `seal mismatch`（红）。
- **收益**：`Archived: YYYY-MM-DD` 行由脚本自动插入，不用记格式。
- **代价**：多一个 npm script。它只是转发，没有引入新逻辑 ——
  真正的实现仍在 vendored 脚本里，上游更新时自动跟进。
- **代价**：`npm run archive:note -- <路径>` 里的 `--` 必须写，
  否则 npm 会吞掉参数。这是 npm 的既有行为，不是本入口的设计。
- **已知缺口**：脚本会**报告**入站链接，但**不修复**。
  「旧笔记被引用着却被归档」这件事仍需要人决定怎么处理。
  实测确认了这条缺口的实际后果：在 15 篇真实笔记的副本上归档
  `board-409-readable-notice.md` 后，脚本正确报出
  `sidebar-tab-drops-host-props.md` 引用了它，而 `tree` 门禁随即报
  `target file does not exist`。**所以流程是三段的**：
  归档 → 按提示修入站链接 → 门禁才是绿的。
  这个「红」是有价值的：它把「你归档了别人正在引用的东西」变成
  必须处理的信号，而不是静默留一个坏链接。
  重访信号：`tree` 门禁报死链而来源是某篇笔记被归档时。
- **已知缺口**：`--superseded-by` 只在新笔记里写一条相对链接，
  不检查新笔记是否真的「完全取代」了旧笔记（那是语义判断）。

## Verification

```sh
node --test tools/archive-note.test.mjs   # 5 项
npm run archive:note -- <路径>
```

实测完整流程（临时仓库，非推断）：

```text
归档  → 退出码 0
        Moved: implemented/process/2026-01-01-old.md -> archived/process/2026-01-01-old.md
        Sealed in archived/manifest.json with hash sha256:87ef1a86c...
门禁  → ok: 1 archived note(s) verified, 1 seal(s) in manifest    （绿，退出码 0）
篡改  → archived: ... — seal mismatch: archived note was modified after sealing
        （红，退出码 1）
```

**真实笔记树上的验证**（15 篇真实笔记的副本，非构造数据）：

```text
归档 board-409-readable-notice.md
  → [Notice] The following active notes link to the archived note:
      - implemented/bug-fix/2026-10-17-sidebar-tab-drops-host-props.md
tree 门禁 → link: ... -> "./2026-10-17-board-409-readable-notice.md" target file does not exist
按提示改成 ../../archived/bug-fix/... 后
tree 门禁 → ok: 14 note(s) tree and relative links verified（绿）
```

这一段证明归档不是「挪个位置就完事」：它会让入站链接失效，
而门禁会抓住。**完整流程是三段的：归档 → 修入站链接 → 门禁绿。**

5 项测试覆盖：归档后门禁绿 / 篡改后红 / 非 implemented 拒绝 /
缺参数非零退出 / 仓库外路径拒绝。

**故障注入（真红）**：

| 注入 | 结果 |
|---|---|
| 封印校验文案改成 `(disabled)`（等价于不报不匹配） | 1 项红 |
| `Status: implemented` 检查改成固定取第 3 行（等于不校验） | 1 项红 |

**过程中修掉一条自己的测试缺陷**：第一版「拒绝仓库外路径」用
`../outside.md`，而那个文件不存在 —— 脚本先命中「文件不存在」，
根本走不到路径边界检查，测试却因为「退出码非 0」而通过。
改成先造一个**真实存在**的仓库外文件，才真正测到边界。
这是「断言通过但测的不是那件事」，与死代码假绿同类。
