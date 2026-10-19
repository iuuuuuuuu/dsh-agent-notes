# Agent Note: 浏览器端逻辑可以在 Node 里测，但渲染必须真 Chrome

Status: implemented

> 同域：这是「运行时那一层零覆盖」的后续。
> 起点见 [2026-10-19-runtime-layer-had-zero-coverage.md](./2026-10-19-runtime-layer-had-zero-coverage.md)，
> 注册状态机本身的缺陷见
> [2026-10-19-registration-state-must-record-results.md](../bug-fix/2026-10-19-registration-state-must-record-results.md)。
> 「桩 React 太弱会制造假绿」这条陷阱，最早由
> [2026-10-17-sidebar-tab-drops-host-props.md](../bug-fix/2026-10-17-sidebar-tab-drops-host-props.md) 记录。

Independent: 本篇讲的是**测试分层**（哪些用 Node、哪些必须 CDP）与三类假绿的具体形态，不重复注册状态机的语义，也不重复 props 转交那个具体缺陷。

## Problem

`src/client.js`（507 行）是浏览器端唯一入口，长期没有任何测试。它的入口 `createAgentNotesClient(require)` 接受一个 `require` 函数——这个签名本来是给 `build.mjs` 打包用的，但它同时是一个天然的注入点：喂桩 `require` 就能在 Node 里加载整份客户端逻辑。

于是补测时我写了两版，**第一版 6 个用例全绿，但全部是假绿**：

1. **`apply` 提前返回**。第一行是 `if (slots === undefined || typeof slots.register !== 'function') return;`。我用空上下文测「宿主缺失不抛错」，实际测的是那个 `return` 自己。
2. **闭包拿不到**。`syncHost` 在 `createAgentNotesClient` 的闭包里、没有导出。我只能断言「我在测试里造的那个数组仍是空的」——那个数组在代码根本没跑的情况下当然也是空的。

断言的对象必须由**被测代码**产生，不能由测试自己产生。这是本篇的中心。

## Decision

按「能不能脱离浏览器」把覆盖分成两层，各自有明确的职责边界：

**第一层：Node 里测逻辑**（`tools/client.test.mjs`，20 个用例）。

用 `vm` 加载源码、喂桩 `require`，并通过 **`apply` 的真实注册路径**拿到组件——`apply` 会把开关组件交给 `slots.register`，让假的 `slots` 把注册调用记下来，就能取到组件本身。这条路走的就是生产代码的路径，不是绕过它。

覆盖：`apply` 的能力门槛、座位描述符字段、`syncHost` 的注册/注销/幂等/失败重试、两个宿主（`slots` / `sidebar`）互不影响、投影键与命令名的跨文件一致性。

**第二层：真 Chrome 测渲染**（`.probe/switch-render.mjs`，28 项断言，不入库）。

headless Chrome + 临时 profile + 随机调试端口，全程不动鼠标、不抢焦点。把 `lib/client.js` 内联进宿主页，用真 DOM 渲染，再用 CDP 读回**计算样式与盒模型**。

覆盖：按钮真的出现在 DOM 里、高 24px / 圆角 999px / `gap` 与 `align-items` 生效、`data-on` 与 `aria-pressed` 随投影变化、点击真的发出 `/agent-notes on|off`、失败/reject/`matched:false`/拿不到 SessionFace 四种异常都提示「切换失败」、busy 态、400px 窄屏下不溢出。

`must`：**渲染类断言不得用 React 元素树代替**。断言「`createElement` 被调用了、props 里有什么」，等于测「我以为它会长成什么样」，不是测「用户看到什么」。CSS 根本没加载、字体把文字挤出按钮、`height:0` 让按钮点不到 —— 这些在元素树里全都看不出来。

## Alternatives considered

- **只做第一层，不写 CDP 探针** — 成本最低，`npm test` 里跑完就结束，不需要启 Chrome。否掉是因为它有个不可接受的盲区：**样式表是否真的生效**它验不到。`injectStyle()` 里全是 `try/catch` 降级（为了不让插件炸掉宿主 UI），CSS 注入失败会被静默吞掉，而元素树里 `.an-switch` 依然存在、props 依然正确 —— Node 测试会一直绿，用户看到的却是一个没有样式的裸按钮。这次探针第一次运行就在真实 Chrome 里量出了 `display` 的实际计算值是 `flex` 而不是 CSS 里写的 `inline-flex`（flex 父容器对子项的块级化），这类事实只有真渲染能给出。
- **用 jsdom 代替真 Chrome** — 可以在 Node 里跑、无进程管理负担、CI 友好。否掉是因为 jsdom 不做布局与样式计算：`getBoundingClientRect()` 一律返回 0，`getComputedStyle` 拿不到层叠结果。而这次要验的恰恰是「按钮多高、圆角多少、文案有没有溢出」——这些在 jsdom 里全部无从判断，会退化成断言 `style` 属性字符串，等于回到元素树的老路。
- **把 `.probe/` 探针纳入 `npm test`** — 能让渲染验证天天跑，覆盖更完整。否掉是因为它需要本机装 Chrome（本仓库的硬约束是零依赖、不假定外部环境），且启动 headless 浏览器要数秒，会把 `npm test` 从 40 秒推到几分钟。当前的分工是：`npm test` 管逻辑（任何 clone 都能跑），`.probe/` 管渲染（人工在改动浏览器端时跑）。门禁不假装覆盖了渲染，比假装覆盖了更诚实。
- **给桩 React 加一个真正的调和器（reconciler）** — 能精确模拟 React 的 diff、effect 时序、并发特性，测得更真。否掉是因为维护成本远超收益：手写调和器本身就是个持续产出 bug 的项目，而它要验的东西（状态更新后界面怎么变）用「重放整次挂载 + hook 槽位」二十行就能覆盖到位。**桩的强度只要够让它验的东西能变红即可**，超过这个点就是在给测试基础设施本身写测试。

## Consequences

- **收益**：浏览器端从零覆盖变成两层覆盖——20 个逻辑用例 + 28 项渲染断言。
- **收益**：`tools/client.test.mjs` 已登记进 `tools/fault-injection.mjs` 的自证清单。该清单同时被加强：从「文件存在即通过」改为「必须有 `test(...)` 用例且数量不为零」——原来那种检查对全是恒真断言的文件同样报绿。
- **收益**：故障注入证明这些断言真的会红。逻辑层 13/13（改 `syncHost`、去掉 `try`、删 `dispose` 复位、组件写零参、单实例改 false、投影键/命令名漂移等）；渲染层 10/10（`height:24px→0px`、`border-radius:999px→0`、`display:inline-flex→block`、`onClick` 摘掉、切换方向写死 on / 写死 off、`setFailed` 摘掉、`matched:false` 分支禁用、reject 不捕获、busy 不复位）。
- **收益**：过程中抓到并修掉一个真缺陷 —— 切换方向写死成 `'on'` 时，探针最初**仍然全绿**，因为它只测了「关→开」一个方向。补上反向用例后立刻变红。这条值得单独记：**只测一个方向的用例，等于没测方向逻辑。**
- **代价与已知上限**：桩 React 有四个必须同时成立的细节 —— `createElement` 要就地展开函数组件、`useEffect` 要立即执行、`useState` 的 setter 要触发重渲染、状态要按 hook 槽位跨渲染保留。少任何一个都会让断言朝错误的方向失效。这是本仓库的复发陷阱（已第三次记录），不是一次性问题。
- **代价与已知上限**：探针用 `data:text/html` 内联 bundle，好处是不依赖网络与 DSH 服务（不会因抖动假红假绿），代价是验不到 DSH 真实的下发链路（模块信封的 `rev` 参数、缓存策略）。后者由 `.probe/sidebar-e2e.mjs` 从运行中服务取真实字节来覆盖，两者互补。
- **代价与已知上限**：`.probe/` 不入库，所以渲染验证**不会随 CI 自动跑**，只能靠人记得在执行。这是一个已知的、被接受的口子 —— 记在这里是为了让下一个维护者知道它是有意为之，而不是忘了接。
- **重访信号**：若将来 CI 环境可以稳定提供 Chrome（或出现零依赖的 headless 布局引擎），渲染探针应移入 `npm test`，那时上面那条「不会自动跑」的代价就该被消掉。另一个信号：`AgentNotesSwitch` 若引入 `useReducer` / `useContext`，桩 React 需要同步扩展，否则相关断言会静默失效。

## Verification

```sh
node --test tools/client.test.mjs          # 逻辑层 20 个用例
node .probe/switch-render.mjs              # 渲染层 28 项（需本机 Chrome，不入库）
npm run gate:fault-injection               # 含「自证清单必须有真实用例」
npm run check                              # 全量门禁
```

故障注入（已实测，逻辑层 13/13、渲染层 10/10 全部变红）。渲染层的注入方式是把 `lib/client.js` 里的目标字符串改掉再跑探针，还原后重新变绿。
