# Agent Note: 生命周期根层的目录说明，插件不该比 vendored 更严

Status: implemented

> 本篇**裁决**了一处规则冲突：
> [2026-10-22-stray-notes-at-notes-root-are-invisible.md](2026-10-22-stray-notes-at-notes-root-are-invisible.md)
> 当时的写法是「生命周期根层的说明文件不计数、但**仍受布局检查**」——
> 那一半现在推翻。
> 上游契约见 vendored 的 `skills/agent-notes/scripts/agent-note-tree.ts`。

## Problem

`lib/notes-layout.js` 的 `checkLifecycle()` 原先这样判：生命周期根层只要出现 `.md`
（`.gitkeep` 与系统垃圾文件除外），一律报「散落文件」并判红。

而 vendored 的 `agent-note-tree.ts` 里有：

```ts
ROOT_ALLOWLIST = new Set(['AGENTS.md', 'CLAUDE.md'])
// …
if (segs.length === 2 && ROOT_ALLOWLIST.has(segs[1] ?? '')) continue
```

也就是**明确放行** `{lifecycle}/AGENTS.md` 与 `{lifecycle}/CLAUDE.md`（当成该生命周期的
目录说明）。上游仓库自己真的这么放：`.agents/notes/implemented/AGENTS.md` 与
`…/CLAUDE.md` 都在（只读审计翻上游检出目录时发现，报告见 `.probe/audit-notes-gate.md` 的 S3）。

于是同一棵树：**vendored 三条门禁全绿，插件判红**。

这不是「更严格更安全」，而是**假红**：本插件是包着 vendored 的，用户按上游的布局
写笔记，插件却告诉他违规 —— 他只能去改一个本来合法的树，或者干脆不信这道门禁。
一个会让合法输入变红的门禁，很快就会被整体忽略（假红的危害不比假绿小）。

## Decision

`notes-layout.js` 新增 `LIFECYCLE_ROOT_GUIDES = ['AGENTS.md', 'CLAUDE.md']`，
与 vendored 的 `ROOT_ALLOWLIST` **逐字对应**；`checkLifecycle()` 遇到这两个确切名字
就跳过（既不报错，也不计数 —— 它们仍归 `strayFiles`）。

`must`：**名单只放这两个确切名字**，不做前缀、大小写或通配匹配。
放宽成「生命周期根层任何 `.md` 都行」等于取消这一层的形状检查，
而「散落文件不会被枚举、不进笔记数、也不受格式门禁管辖」正是 `checkLifecycle()`
存在的唯一理由。有用例钉住这条边界：`implemented/unexpected.md` 必须仍然判红。

## Alternatives considered

- **维持原判：插件保持更严，用户就不该在生命周期根层放说明文件** — **这是本篇最强的一条被否方案**。理由很硬：布局是插件自己的判据，统一口径不会因为上游的宽松而漂移；而且「生命周期根层只允许六个 class 目录」确实更好看。**否掉因为它与上游契约直接矛盾**：vendored 的 `ROOT_ALLOWLIST` 不是疏漏，是显式白名单（上游自己的笔记树就在用它）。包着一个上游，却在它的白名单上判它违规，用户遇到时无法判断该信谁 —— 而本仓库反复强调的判据是「同一事实只能有一处真相」。
- **把 `AGENTS.md`/`CLAUDE.md` 当成正常笔记文件** — 编码更简单（少一个分支）。**否掉因为它们是说明文件不是笔记**：vendored 不算它们，格式门禁也不验它们，算进笔记数会让「磁盘上有 N 篇」与 `ok: N note(s)` 再次对不上 —— 那正是上一篇修掉的假绿。
- **跟随上游但允许任意名字的说明文件（例如 `README.md`、任意 `*.md`）** — 更宽容。**否掉因为 vendored 只放行这两个**：放行 vendored 不放行的名字，会让插件判绿而 vendored 判红 —— 方向反过来，同样是两处真相。要扩名单就必须先改上游。
- **在本插件里复制一份白名单并定期人工同步** — 现在就是这样做的（两份常量）。**本轮接受**，因为 vendored 不能手改（哈希门禁），且名单只有两个名字、变动概率极低；代价与重访信号见下。

## Consequences

- **收益**：按上游布局写的笔记树不再被插件判红。`vendored 绿 / 插件红` 这种最令人困惑的组合消失。
- **收益**：零篇守卫不受影响 —— 目录说明仍不进 `noteFiles`，只有它一个文件的树仍然判 `NO_NOTES_YET`。
- **收益**：放宽的边界被一条现有用例钉住（`implemented/unexpected.md` 必须仍然红），不会滑成「任意 `.md` 都放行」。
- **代价与已知上限**：**白名单有两份**（vendored 的 `ROOT_ALLOWLIST` 与本模块的 `LIFECYCLE_ROOT_GUIDES`）。**2026-10-24 评审补强**：这份漂移现在由 `npm run verify` 机械比对（`tools/verify-plugin.mjs` 里新增的「生命周期白名单」检查，解析两份源码的常量并逐项比较，不一致即非零退出）——CodeRabbit 在 PR #44 上点名「仅把检查加入 sync:check 不足以覆盖常规门禁」，所以放进了 check 链。两份仍然存在、仍要人工同步，但**不一致会被门禁抓住**，不再靠注释自律。vendored 是只读副本，无法从它 import 常量，所以两份必然共存；上游一旦新增白名单条目，插件这边要跟着加，否则又会出现「vendored 绿 / 插件红」。这是本轮明确接受的代价。
- **代价与已知上限**：本篇推翻了 `2026-10-22-stray-notes-at-notes-root-are-invisible.md` 里「说明文件仍受布局检查」那一句的一半；那篇原文按「不得把一篇笔记改写成另一个决定」的规矩**不改写**，只加互链指向本篇。
- **重访信号**：
  - 上游 `ROOT_ALLOWLIST` 有变动（增删名字）→ 必须同步本模块的常量，并跑 `node --test tools/no-fake-green.test.mjs`。
  - 若上游把这两个名字也从根层移走（改成 `.agents/notes/AGENTS.md` 单一入口）→ 本模块这条白名单要删掉，否则又会反向放宽。
  - 若出现第三份「需要跟着上游同步的常量」→ 该考虑把它们集中到一个可核对的清单文件，而不是散在两个模块里。

## Verification

```sh
node --test tools/no-fake-green.test.mjs tools/notes-layout.test.mjs   # 49 tests / 49 pass / 0 fail
```

改动的是两条用例的**期望**（`合规笔记加生命周期根层 AGENTS.md` / `CLAUDE.md`：
由「passed=false / NOTES_LAYOUT」改为「passed=true / exit 0」，计数与 `strayCount` 不变），
另外两条「只有说明文件 ⇒ 零篇判红」的期望不变（仍然红）。

**真变异**（把 `if (LIFECYCLE_ROOT_GUIDES.includes(name)) continue;` 删掉）：

```
✖ 合规笔记加生命周期根层 AGENTS.md：只计一篇，且不再判红（与 vendored 白名单一致）
✖ 合规笔记加生命周期根层 CLAUDE.md：只计一篇，且不再判红（与 vendored 白名单一致）
✔ 生命周期根层只有 AGENTS.md：说明文件不算笔记，零篇必须判红
✔ 生命周期根层只有 CLAUDE.md：说明文件不算笔记，零篇必须判红
✔ 其他生命周期根层 Markdown 仍进入布局校验      ← 关键：放宽没有扩大
```

`3 pass / 2 fail`，还原后 `49/49`。最后那条仍然绿，正是「只放两个确切名字」的证据。
