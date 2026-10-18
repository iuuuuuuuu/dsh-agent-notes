# Agent Note: 上游修好了抽屉缺陷，删掉注入层的重复实现

Status: implemented

## Problem

本插件曾在注入层（`lib/board-responsive.js`）补过抽屉的两个缺陷：

1. 打开新笔记不重置滚动位置（`MutationObserver` 盯 `.open` 后归零 `scrollTop`）；
2. 抽屉打开时背景仍可滚（`body:has(#drawer-console.open) { overflow: hidden }`）。

两处都是因为上游 `agent-notes-board.html` 缺这两件事（详见
[../bug-fix/2026-10-18-drawer-scroll-and-double-scrollbar.md](../bug-fix/2026-10-18-drawer-scroll-and-double-scrollbar.md)，
并向上游提了 issue #10）。

合并上游 `72573a5` 后，上游把两件都修了：

```css
/* 上游 agent-notes-board.html:521-525 —— 与我们的写法逐字相同 */
body:has(#drawer-console.open),
html:has(#drawer-console.open) { overflow: hidden; }
```

```js
// 上游 openConsole() 内
document.querySelector('#drawer-console .console-body').scrollTop = 0;
```

于是注入层那两段变成**纯冗余**：同一件事有两份实现，且分别在不同仓库维护。

## Decision

删掉注入层的两处重复实现，只保留热更新轮询。

删除前先做了**剥离实验**确认上游修复单独就够：用 CDP 的 `Fetch.fulfillRequest`
拦截 `/agent-notes/ui` 响应，把注入层注入的 `<style>` 与 `<script>` 全部剥掉，
再测抽屉行为：

| 观测 | 剥离注入层后 |
|---|---|
| 打开第 1 篇滚到底 `scrollTop` | 2089 / 2104 |
| 打开第 2 篇 `scrollTop` | **0**（正确从头开始）|
| `html.overflow` | `hidden` |
| `body.overflow` | `hidden` |

行为全部正确 → 上游修复确实单独成立 → 冗余可安全删除。

`must`：删除后必须用**同一套端到端探针**复验，不能只靠单测。
删除后的实测（`.probe/drawer-scroll.mjs`）：滚到底 `2089` → 打开第二篇 `scrollTop: 0`，
`bodyOverflow: hidden` —— 全靠上游生效。

`must`：留一条**反向**测试防止冗余长回来
（`board-responsive: 抽屉滚动修复已由上游提供，注入层不得再重复一份`），
断言注入层里不含 `#drawer-console.open … overflow: hidden`、不含 `MutationObserver`、
不含 `.scrollTop = 0`。理由：两份等效代码长期并存必然漂移，改一处忘另一处时
没人知道哪份在生效 —— 这正是「删掉」比「留着当保险」更安全的地方。

注入层保留的是热更新轮询（`/agent-notes/data` + `revision` 指纹），
上游**没有**对应能力，不属于冗余。

## Alternatives considered

- **保留两份当双保险，上游回退时不至于退化** — 这有真实的合理性：上游是个人维护的
  MIT 项目，回退或重写的可能性不能排除，而多留十几行代码的成本看起来极低。
  否掉是因为「保险」的代价被低估了：两份实现分散在两个仓库，一旦上游改了选择器
  或类名，我们的那份会**静默失效**（`querySelector` 拿 null 就 return，不报错），
  而人看到上游已有修复，不会再怀疑本层 —— 那才是真正危险的失效方式。
  真要防回退，正确做法是留一条能变红的测试（已留），而不是留一份没人看的实现。
- **只删 CSS，保留 MutationObserver 脚本** — CSS 用 `:has()`，理论上存在浏览器
  不支持的可能（Chromium 105 以下），脚本没有这个顾虑，看起来是更稳的组合。
  否掉是因为 DSH 跑在 Chromium 里，`:has()` 早已可用；更重要的是上游 CSS 与我们
  逐字相同，若 `:has()` 不可用，上游自己就先坏了，我们多留一份也救不了 ——
  真正该修的是上游。
- **把上游的修复 cherry-pick 到我们 vendored 的副本里，不依赖 sync** — 能让
  内置副本立刻带上修复，不必等合并。否掉是硬约束 3：`skills/agent-notes/` 是
  vendored 内容，手改会被 `verify-plugin.mjs` 的哈希比对拦下，且下次 `sync`
  会冲突。修复只能来自上游，这正是 vendoring 的意义。
- **给上游提 PR 而不是提 issue** — 更直接，能让修复更快落地。这次上游采纳的
  修法与 issue 里给的建议完全一致（锁滚动 CSS 逐字相同、`scrollTop = 0` 位置也对），
  说明 issue 已经足够；提 PR 需要 fork、保持同步、跟维护节奏，对一个我们只
  vendored 使用的项目来说成本偏高。

## Consequences

- **收益**：同一件事只有一份实现，且在被维护的那一侧（上游）。我们不必再跟。
- **收益**：注入层职责变单一 —— 只剩「上游没有的能力」（热更新）。以后看这个
  文件不用再分辨哪段是补上游、哪段是自己的。
- **收益**：`lib/board-responsive.js` 少了约 20 行，`DRAWER_PATCH_ID` 脚本也变短。
- **代价与已知上限**：抽屉滚动与背景锁现在**完全依赖上游**。若上游回退这两处，
  本插件会立刻退化回原状（从底部开始 + 双层滚动条），而且不会报错。
  重访信号：用户再次报告「打开笔记从底部开始」或「内外双层滚动条」时，
  先查上游 `agent-notes-board.html` 里这两段是否还在（`grep -n 'scrollTop = 0'`
  与 `grep -n 'drawer-console.open'`），再决定是否重新引入本层补丁。
- **代价与已知上限**：那条反向测试会在「有人好心把补丁加回来」时变红。这是有意的：
  它逼着后来者去读这篇笔记，而不是默默叠一份重复实现。
- **未变的**：热更新（笔记改了页面自动刷新）仍由本插件提供，上游没有对应能力，
  不受本次删除影响。实测 `applied: 1`、四个视图全部更新。

## Verification

```sh
npm test                                  # 107 项
node .probe/drawer-scroll.mjs             # 抽屉行为（剥离/保留两态都测过）
node .probe/live-refresh.mjs              # 热更新端到端
```

故障注入（两条都实测真红）：
- 把锁滚动 CSS 加回注入层 → `注入层不得再重复一份` 变红；
- 把 `MutationObserver` 归零脚本加回注入层 → 同一条变红。

端到端实测（删除冗余之后）：
- 抽屉：滚到底 `2089` → 打开第二篇 `scrollTop: 0`，`bodyOverflow: hidden`；
- 热更新：`{polls: 4, applied: 1}`，baseline / directory / timeline / alternatives 四视图哨兵全可见。

上游修复位置：
- CSS：`skills/agent-notes/assets/agent-notes-board.html:521-525`
- JS：同文件 `openConsole()` 内 `scrollTop = 0`
- 上游 commit：`72573a5`
