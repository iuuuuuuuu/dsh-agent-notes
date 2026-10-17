# Agent Note: 本仓库的笔记门禁要经 CLI 外壳接进 npm 与 CI

Status: implemented

## Problem

本仓库的 `AGENTS.md` 早就写明「非平凡改动必须留笔记」，但 `.agents/notes/` 目录此前**并不存在**，三条 vendored 校验脚本也从未接进 `npm run check` 或 CI。规范写在文档里、没有任何东西执行它，等于没有规范。

更麻烦的是，即使把那三条脚本原样接进 CI，得到的仍是一条**恒绿门禁**：`verify-agent-note-tree.ts` / `verify-agent-note-format.ts` / `verify-archived-agent-notes.ts` 在空集合上都 `exit 0` 并打印 `ok: 0 note(s) verified`。从「脚本没说错」看是真的，从「本仓库的笔记合规」看是空的 —— 笔记树根本不存在时 CI 照样绿。这与 Owner 的硬规则「禁止假绿门禁」直接冲突，也是插件侧已经实测踩过的坑（`lib/notes.js` 为此前置拦下 `NO_NOTES_TREE` / `NO_NOTES_YET`，由 `tools/no-fake-green.test.mjs` 逐条钉住）。

缺一个把「没有可验对象」和「验过了且合规」区分开的命令行入口。

## Decision

仓库根新增 `tools/verify-notes.mjs` 作为本仓库笔记门禁的唯一 CLI 入口，并接进 `npm run notes:gate`、`npm run check` 与 `.github/workflows/verify.yml`。

它**不自己判断结构**，只做三件事：

1. 解析笔记根（显式 > `$AGENT_NOTE_ROOT` > `<包根>/.agents/notes`），cwd 钉在仓库根，保证从任意子目录调用验的是同一棵树；
2. 调 `lib/notes.js` 的 `runAllGates()` —— 那里是「没有可验对象不算通过」的唯一真源，且已被 `tools/no-fake-green.test.mjs` 逐条钉住（空树、有树零篇、有笔记违规必须变红，合规必须真绿）；
3. 把每条门禁的**进程退出码**映射成 CLI 退出码与可读诊断。脚本缺失、超时、非零一律算失败，不降级。

`must`：判据是「至少一篇笔记」，不是「目录存在」。`/agent-notes init` 建出空目录后直接算通过，就又回到假绿。

`must`：外壳的绿必须能被证伪。`tools/fault-injection.mjs` 新增 `[verify-notes]` 一节，对空树、不存在的树、违规笔记三种故障断言 `exit != 0`，并用「合规树必须 exit=0」作反向对照 —— 否则「外壳一律报错」也能让前三条通过。

## Alternatives considered

- **把三条 vendored 脚本直接写进 npm script 与 CI** — 这是最省事也最贴近上游的接法：零新代码、零维护，`sync-upstream.mjs` 合并上游时不用管本仓库的适配层。否掉的原因只有一条，但足够致命：它们在空集合上 `exit 0`，而本仓库在引入笔记之前笔记树就是空的，CI 会从第一天起恒绿。一条永远不会红的门禁比没有门禁更坏，因为它会被人当作证据。
- **在 `tools/verify-notes.mjs` 里自己数笔记、自己判断目录结构** — 优点是 CLI 可独立运行，不依赖 `lib/` 的内部实现，将来 `lib/` 重构也不会波及门禁。我实际先写了这一版（自带 `countNotes()` 与前置拦截），跑通后才否掉：它立刻产生了第二份「没有可验对象」的判定逻辑，而两份判定迟早漂移，漂移的表现恰恰是「一种入口拦住了、另一种没拦住」—— 这正是要防的那类缺陷。改成复用 `runAllGates()` 后，判定只有一处，且有回归测试守着。
- **只建 `.agents/notes/` 目录与首篇笔记，不接门禁** — 改动最小，也不会引入任何新的失败模式。否掉是因为它把规范退化成自觉：本仓库的 `AGENTS.md` 已经这样写了很久，笔记树依然不存在。文档不执行自己。
- **把门禁做成 `verify-plugin.mjs` 的第 7 项检查** — 这样只需要维护一个自检入口。否掉是因为两者职责不同：`verify-plugin.mjs` 验的是**这个包作为交付物**是否自洽（清单、哈希、双语文档），笔记门禁验的是**本仓库的开发过程**是否留痕，后者在别人把本插件装进自己仓库时并不适用，也不该影响包的发布。

## Consequences

- **收益**：`.agents/notes/` 有了真实结构，规范从文档变成可执行的门禁；空树与零篇笔记不再能冒充通过，本仓库第一次有了「笔记合规」这个可被证伪的判断。故障注入的 `[verify-notes]` 一节让这条门禁的绿本身也是被证过的。
- **收益**：判定逻辑只有一处。CLI、`/agent-notes gate` 工具、CI 走的是同一条 `runAllGates()`，不会出现「命令说绿、CI 说红」的分裂。
- **代价与已知上限**：CLI 依赖 `lib/notes.js`，因此不再是纯 vendored 脚本调用；若将来把 `lib/` 拆出独立包，这个入口要跟着改。这是刻意接受的耦合——换取判定单一真源。
- **代价与已知上限**：外壳只能拦「没有可验对象」与「脚本报错」，拦不住「笔记写得好不好」。语义质量仍靠人工复核（`references/quality-gate.md`），门禁只保证结构。
- **重访信号**：若上游三条脚本自己补上了空集合判定（打印失败而非 `ok: 0`），本外壳的前置拦截会变成冗余 —— 但它不会变成错误，因此不必急着删；若上游改了 `AGENT_NOTE_ROOT` 语义，则必须同步这里的解析顺序。

## Verification

```sh
node tools/verify-notes.mjs                  # 合规树 → exit 0；空树/零篇/违规 → exit 1
node tools/fault-injection.mjs               # [verify-notes] 一节断言上述故障都会变红
AGENT_NOTE_ROOT=<空目录> node tools/verify-notes.mjs   # 单独复现 NO_NOTES_YET
```
