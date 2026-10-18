# Agent Note: 热更新轮询按「是否真的渲染」门控，document.hidden 在 iframe 里不管用

Status: implemented

## Problem

热更新轮询（见 [2026-10-18-board-live-refresh-on-note-change.md](2026-10-18-board-live-refresh-on-note-change.md)）
原本用 `if (document.hidden) return;` 做节流。用户指出「应该只在可见的时候刷新，
而不是时时刻刻刷新」—— 实测确认这条检查形同虚设。

**实测数据（修复前）：**

| 观测 | 数值 |
|---|---|
| 单次 `/agent-notes/data` 响应 | **100402 字节** |
| 单次服务端耗时 | **74–82ms**（每次请求都重新扫盘并读全部 md）|
| 轮询间隔 | 4 秒 |
| 折算 | 每分钟 15 次 ≈ **1.5MB**，服务端 15 次全盘扫描 |

**`document.hidden` 为什么挡不住**：看板跑在侧边栏的 **iframe** 里。
宿主把 iframe 的容器设为 `display:none`（用户切到别的 tab）之后，
iframe 内部的 `document.hidden` **仍然是 `false`**：

```
① iframe 可见          → hidden: false, polls 正常
② 宿主 display:none    → hidden: false  ← 骗人，实际已经看不见了
③ 隐藏 12 秒期间        → polls 2 → 5   ← 仍在每 4 秒拉 100KB
```

`document.hidden` / `visibilityState` 反映的是**整个浏览器窗口/标签页**是否可见，
不是这个 iframe 是否被渲染。所以对于「侧边栏切到别的 tab」这种最常见的场景，
它给的是错误答案。

## Decision

改用 `IntersectionObserver` 观察 `document.body`，由它在**渲染树层面**判定本页是否
真的参与布局。隐藏时 `clearInterval` 停表，恢复时立刻补探一次。

**实测三态都准：**

| 状态 | `IntersectionObserver` | `document.hidden` |
|---|---|---|
| 可见 | `isIntersecting: true` | false |
| 宿主 `display:none` | **`isIntersecting: false`** | false（错）|
| 恢复显示 | **`isIntersecting: true`** | — |

`must`：隐藏时要**真的 `clearInterval`**，不能只「跳过请求」。
只跳过的话定时器仍在空转，每个周期都要醒一次；停表才是真的不耗。

`must`：恢复可见时**立刻补探一次**，不等下一个周期。隐藏期间用户可能改了笔记，
补探保证切回来马上看到最新内容，而不是最多再等 4 秒。

`must`：启动分支也要受门控 —— 若页面一加载就是不可见的（侧边栏在后台），
不该先把定时器建起来。

保留 `document.hidden` 作为**双保险**（`if (!visible || document.hidden) return`）：
整页 hidden（切到别的浏览器标签页）时 `IntersectionObserver` 未必回调，
两条判据覆盖的场景不同，不重复。

`must`：`IntersectionObserver` 不可用时退化为「按 `document.hidden` 判断」。
挡不住 iframe 被隐藏，但不会比旧行为更差 —— 适配层刻意做成非功能前提。

## Alternatives considered

- **改用 `visibilitychange` 事件** — 标准做法，比轮询内的判断更省。否掉是因为它
  与 `document.hidden` 同源，同样反映「整个窗口/标签页」而非「这个 iframe」，
  实测在这个场景下给的是错误答案。换事件名治不了判据本身不对。
- **每次轮询前查 `document.body.getClientRects().length === 0`** — 实测也能准确
  判断（隐藏时返回 0），不需要额外的 observer，代码更少。否掉是因为它是**轮询式
  的判据**：为了判断「要不要请求」而每个周期主动触发布局计算（`getClientRects`
  会强制 reflow），净收益不如事件驱动的 `IntersectionObserver`。而且它仍需定时器
  醒着，省不掉唤醒。
- **用 `window.innerWidth === 0` 判断** — 一行就够。否掉是实测证伪：
  宿主 `display:none` 之后 `innerWidth` 仍是 `1100`、`innerHeight` 仍是 `800`
  （见 Problem 的实测输出），完全不变。iframe 被隐藏不会把视口尺寸清零。
- **把轮询间隔从 4 秒放长到 30 秒** — 改一个常量，最简单，直接把开销降 87%。
  否掉是因为它牺牲了「改完马上看到」这个核心体验：用户改完笔记切回来，
  要等最多 30 秒。而可见性门控能在**不损失响应速度**的前提下把不可见时的开销
  降到零 —— 两者不是同一档的方案，后者严格更优。
- **服务端加缓存，命中就不扫盘** — 直击那 78ms 的主要成本，看似更根本。否掉
  是因为它让「变更检测」变复杂：要判断文件是否变化就得 stat 或监听，
  而 stat 的 mtime 不可靠（前面已实测：部分编辑器保留 mtime）。
  更要紧的是它解决不了**一半**的问题 —— 客户端每 4 秒醒来、发 HTTP、
  收 100KB 这些开销与服务端缓存无关。可见性门控是客户端侧的，两者可以叠加，
  但本次只做能确定判对的那一半。

## Consequences

- **收益**：不可见时开销归零。实测隐藏 12 秒期间 `polls` 保持不变（修复前 +3 次），
  即不发请求、不扫盘、定时器不醒。
- **收益**：可见时的响应速度**完全不变**（仍是 4 秒），恢复可见时立刻补探，
  用户切回来看不到「过时内容」。
- **收益**：状态仍可观测（`window.__agentNotesLive.polls`），排查时一眼看出有没有在轮询。
- **代价与已知上限**：多了一个 `IntersectionObserver` 常驻。开销可忽略（只在交叉
  状态变化时回调），且它比定时器省得多。
- **代价与已知上限**：门控依赖「iframe 被隐藏时 `IntersectionObserver` 会报
  `isIntersecting: false`」。这是实测结论（Chrome headless，三态验证），但若未来
  宿主改成 `visibility:hidden` 或 `content-visibility` 而非 `display:none`，
  行为可能不同。重访信号：用户报告「切走后仍在跑」或「切回来不更新」时，
  先复测这三态。
- **代价与已知上限**：`IntersectionObserver` 观察的是 `document.body`。若上游把
  页面结构改成 body 不参与布局（极不可能），需改观察目标。
- **未解决**：单次请求仍是 100KB / 78ms，且每次都在服务端重新扫盘。
  可见性门控把「不必要的次数」降到零，但「必要的那一次」仍然重。
  若笔记规模继续增长，下一步该做服务端缓存或增量读取 —— 本次未做，理由见
  「备选方案」里那条。

## Verification

```sh
npm test                       # 32 项（board.test.mjs）
node .probe/visibility.mjs     # iframe 隐藏/恢复三态 + polls 计数
node .probe/live-refresh.mjs   # 热更新端到端仍工作
```

故障注入（四组，全部实测真红）：
- 去掉 `IntersectionObserver`、退回只看 `document.hidden` → 变红；
- 删掉 `stop()` 里的 `clearInterval(timer)` → 变红；
- 不可见分支不调 `stop()` → 变红；
- 去掉启动时的可见性门控 → 变红。

**过程中修掉一条潜在假绿**：最初的断言是 `assert.match(js, /clearInterval\(timer\)/)`，
故障注入把 `stop()` 里的 `clearInterval` 删掉后测试**仍绿** —— 因为正则匹配到了
另一处的同名调用。改成断言 `stop()` 的**定义体**里确实调了它
（`/function stop\(\) \{[\s\S]{0,200}clearInterval\(timer\);[\s\S]{0,120}\}/`）
之后才真正变红。这类「正则命中了别处」是断言层面的假绿，只有靠故障注入才暴露得出来。

实测对比：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 隐藏 12 秒期间 `polls` | 2 → 5（+3 次请求）| 3 → 3（**零请求**）|
| 恢复可见后 | — | 3 → 4（立刻补探）|
| 热更新是否仍工作 | 是 | 是（`applied: 1`，四视图全中）|
