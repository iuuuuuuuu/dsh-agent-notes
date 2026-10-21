# Agent Note: 归档卡掉到第二行、点它也没换视图 —— 两个症状各有各的因

Status: implemented

> 承接 [2026-10-19-board-missing-archived-entry.md](../feature/2026-10-19-board-missing-archived-entry.md)：
> 那一篇补上「已归档」入口，本篇修它补得不够的几处。两篇都改的是
> `lib/board-responsive.js` 的注入层，都不动 vendored 上游 HTML。
>
> 本篇经两轮独立复审（`.probe/review-r2.md`）后改写过一次：第一版把
> 「点卡只设 status」当成完整修法，复审指出它在用户先前筛过 class、或在
> 搜索框里留过字时**照样 0 行**（`renderDirectory` 是 st+cls+q 三条件与运算）。
> 同轮还纠正了两处事实：`routeToListFilter` 其实**可以**从全局调到（实测），
> `hashchange` 是**异步**派发、不存在「顺序不能反」的因果。

Independent: 本篇只改注入层的布局与点击行为，不涉及数据层、
归档封印与决策笔记的结构。

## Problem

Owner 在真实看板上看到两个问题，都发生在「已归档」那张卡上：

1. **它没跟另外四张在同一行** —— 单独掉到第二行第一列，像掉队的附件。
2. **点它看不到归档笔记** —— 于是 owner 的结论是「没有已归档的筛选项」。

两个症状的成因完全不同，第二个其实叠了**两个**缺陷。

### ① 是布局：上游那行写死了 4 列

`skills/agent-notes/assets/agent-notes-board.html:223`：

```css
.kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; }
```

注入的第 5 张卡是这个网格的第 5 个子项 → 自动换行。
（上游窄屏有 `:224` 的 `@media (max-width: 960px)` → `repeat(2, 1fr)`，
所以「写死 4 列」只对宽屏成立；窄屏档位另有问题，见 Decision。）

实测（headless Chrome + 虚拟时间，量 `getBoundingClientRect()`）：

| | 修前 | 修后 |
|---|---|---|
| 卡片数 | 5 | 5 |
| 占用行数（distinct `top`） | **2** | **1** |
| `grid-template-columns` | `320.75px ×4` | `253px ×5` |
| 前四张 `top` | 92 | 92 |
| 「已归档」`top` / `left` | **248 / 36** | **92 / 1120** |

修前的四个数字来自当轮 `--dump-dom` 的打印输出（**未落盘**，`.probe/board-probe2.mjs`
当时只 `console.log`）；修后的数字有落盘证据 `.probe/board-metrics.json`
（见 Verification）。两者的可复核程度不同，不要当成同等强度的证据。

### ② 是视图 + 残留筛选：两个缺陷叠在一条路径上

`document.getElementById('select-status')` 里**本来就有** `archived` 选项
（`:813` `LIFECYCLES` 含它、`:1662` 逐个塞 `<option>`）。补丁设值后上游的
`change` 监听（`:1663`）也确实生效。

**缺陷 A：筛了，但用户不在那个视图。** 点击后的中间状态实测：

```
Core.stFilter         = archived      ✔
#matrix-matched-count = 匹配 1 条      ✔
#matrix-rows-stream 里  = 1 行          ✔
.deck-tab.active      = baseline      ✘ ← 用户还在「架构基线」
```

列表渲染在另一个 `.canvas-view` 里，不切视图就等于没筛。**用户看到的
「没有筛选项」，其实是「筛了但没在看的那个页面」。**

**缺陷 B：只设 status，旧筛选留着。** `renderDirectory`（`:1342-1354`）按
`st`+`cls`+`q` 三个条件**与运算**过滤。用户先前按 class 筛过、或在搜索框
里留过字，点「已归档」照样 0 行 —— 症状②在自己的修法上复发。
上游本来就有 `routeToListFilter`（`:1466-1485`），函数第一行注释写的就是
「彻底清空可能残留的旧筛选项与搜索词」。

## Decision

三处都在注入层修，都不碰 vendored HTML。

### ① 让补丁自己给行挂 5 列

```js
row.className += (row.className.indexOf('kpi-row-5') === -1 ? ' kpi-row-5' : '');
row.appendChild(card);
```

```css
.kpi-row.kpi-row-5 { grid-template-columns: repeat(5, minmax(0, 1fr)); }
```

- 类名**只有真正插了卡片才挂**（JS 才知道卡片在不在），所以没有卡片时
  这一组规则一条都不生效，宽屏观感与上游一致。
- 选择器写成 `.kpi-row.kpi-row-5`（特异性 0,2,0）而不是 `.kpi-row`（0,1,0）：
  **媒体查询不增加特异性**，窄屏档位用低权重会输给上游基础规则、退回 4 列。
- 三档窄屏都跟同权重：≤1200px 3 列、≤960px 2 列、≤480px 1 列。
- 上游那条旧的窄屏单列规则（原 `.kpi-row { … minmax(0, 1fr) }`）改成
  `.kpi-row:not(.kpi-row-5)`：留给「没有第 5 张卡」的退化情形，不与 5 列
  规则争同一权重 —— 否则「本层不得回退到低特异性」的用例说不清对错。
- 顺手补了 `.kpi-accent-bar`（`:244`，另外四张卡底部那条 3px 色条），
  否则同排里唯独这张没有底边色带。

### ② 点击复用上游的 `routeToListFilter('archived')`

```js
if (typeof window.routeToListFilter === 'function') {
  window.routeToListFilter('archived');
  return;
}
location.hash = 'directory';                        // 退路：只保证切视图
sel.value = 'archived';
sel.dispatchEvent(new Event('change', { bubbles: true }));
```

上游那个 `<script>` 是**经典脚本**，所以顶层 `function` 声明就是 `window`
属性。实测（`.probe/board-metrics.json` 的 `reachability` 段，在真实页面里
取 `typeof`）：

```
window.routeToListFilter = function
window.switchDeckTab     = function
window.Core              = undefined
```

第一版注释写的「`routeToListFilter` 在模块作用域、外部触达不到」是**错的** ——
那句话是照 `switchDeckTab` 的猜测推的，没量过。`Core` 确实拿不到（`const`
声明不进 `window`），所以数据仍只能读 `window.__INLINE_DATA__`。

`routeToListFilter` 一次做完三件事：`switchDeckTab('directory')` → 清空
`Core.stFilter`/`clsFilter`/`filterQuery`/`#global-query`/两个 `select` →
设值 → `renderDirectory()`。自己拼等效物就是在复制上游逻辑，且必然会漏
（第一版就漏了清筛选那一半）。

退路（能力探测失败时）只承诺「切到清单视图并设 status」，**不清旧筛选**。
它存在是因为注入层不该假设上游函数名永不变；但它是退路，不是主路径。

`hashchange` 的机制要写清（第一版写反了）：`location.hash = x` 触发的
`hashchange` 是**后续任务里异步**派发的，不会在赋值语句处同步回调。
所以「先切视图再派发 change」这种顺序**不构成因果**，两行反过来写也是同一
终态；终态只有实测能证。上游监听在 `:1527-1530`，原文是

```js
window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  if (h) switchDeckTab(h);
});
```

## Alternatives considered

- **改上游 HTML，把 `kpis` 数组直接加第 5 项、把 `repeat(4` 改成 `repeat(5`**
  —— 最直接，一行 CSS + 一个对象。**否掉因为它是 vendored 资产**：
  `tools/verify-plugin.mjs` 用清单哈希比对，手改当场红；要改得推上游。
- **用 `.kpi-row:has(#an-archived-card)` 代替 JS 挂类名** —— 更纯 CSS。
  **否掉因为它是「支持才有」的能力**：`:has` 在 Chrome 105+ 才有，老内核上
  整条规则被丢弃 → 退回第二行的老症状，而且**降级是静默的**（没有报错、
  没有测试能发现）。JS 挂类名在任何内核上都一样，且能顺手在测试里断言
  「挂类名发生在 appendChild 之前」。
- **`grid-template-columns: repeat(auto-fit, minmax(180px, 1fr))`** —— 不用
  数卡片数量，以后加第 6 张也不用改。**否掉因为列数会随容器宽度漂**，
  而 KPI 区是「一眼扫过去对齐」的东西；宁可显式写死档位。
  诚实标注：第一版这里写「实测同一视口改窗口宽度会让 5 张卡在 3/4/5 列间跳」，
  **那次测量没有留档**，所以这条理由当前只有机理（`auto-fit` 按可用宽度
  决定列数）撑着，没有数据撑着。
- **自己拼「切视图 + 设 status + 清四个筛选」** —— 第一版就是这么写的，
  只做了「切视图 + 设 status」。**否掉因为它在复制上游逻辑且漏了一半**：
  清筛选的字段清单（`clsFilter`/`filterQuery`/`#global-query`/两个 select）
  是上游 `routeToListFilter` 内部知识，抄一份就多一份漂移面。
- **点击时用 `document.querySelector('.deck-tab[data-view="directory"]').click()`**
  —— 也是公开 DOM。**否掉因为两条路都可用时该选更窄的那条**：tab 的 click
  监听是上游自己 `addEventListener` 挂的（`:1523-1525`），它一旦改成
  委托或改成别的事件名就会失效；`routeToListFilter` 是上游自己给 KPI 卡
  用的入口（`:1084` 的 inline `onclick` 就是它），语义上更贴。
- **只用离线单元测试（像前一篇那样）** —— 最省事。**否掉因为离线用例守不住
  这两条**：它们是布局与视图状态，`assert.match(源码, 正则)` 只能证明
  「我写了这行」，不能证明「5 张卡真的在一行」「点击后真的换了视图」。
  所以本轮必须真起浏览器量尺寸，见 Verification。

## Consequences

- **收益**：5 张 KPI 卡在一行，1440×1600 视口下每张 253px（实测 1424 内容宽）；
  「已归档」不再像附件。
- **收益**：点归档卡直达「决策清单」视图、筛好、旧筛选清干净。实测
  `activeTab=directory`、`statusValue=archived`、`classValue=''`、
  `searchValue=''`、列表 1 行 —— 这一组是在**故意弄脏**（class=bug-fix、
  搜索框=zzz）之后再点的，见 `.probe/board-metrics.json` 的 `afterDirtyClick`。
- **收益**：离线用例从 10 条增到 13 条（分两个文件），全部在 `npm test` 里跑：
  5 列规则 + 窄屏同权重、点卡必须走 `window.routeToListFilter` + 退路仍在、
  挂类名先于 `appendChild`、源码级「模板没被裸反引号截断」。
- **代价与已知上限**：`kpi-row-5` 这类名是我们挂在**上游 DOM** 上的——上游若
  改 `.kpi-row` 的类名或改成非 grid 布局，这几条规则会失效且**不会报错**。
  重访信号：上游动 KPI 区结构时重跑真机测量。
- **代价与已知上限**：依赖 `window.routeToListFilter` 与 `window.switchDeckTab`
  这两个全局名。它们存在是因为上游用经典脚本 + 顶层 function 声明；上游若把
  那段 `<script>` 改成 `<script type="module">`，两个名字同时消失（`Core`
  现在就已经不在 window 上）。届时会退到「改 hash + 派发 change」，
  表现为**症状 B 复活、A 仍在修**——所以重访信号是：上游脚本标签类型变化。
- **代价与已知上限**：`location.hash = 'directory'`（仅退路）会写进浏览器历史
  /地址栏。侧边栏 iframe 里表现为 iframe 自身 hash 变化，不影响宿主 URL；
  但若上游以后改成「hash 决定初始视图」，首次进入可能落到清单视图。
- **代价与已知上限**：离线用例仍是源码级断言（新增判据都是「源码里有没有
  这条规则/这个分支」），真正的布局与视图切换只有真机测量能证。分工与前一篇
  一致：`npm test` 管「补丁还在、形状没被改坏」，真机管「它在页面上活着」。
- **代价与已知上限**：注入层是**进程启动时**载入的常量。改了
  `lib/board-responsive.js` 后，正在运行的那个 dsh 进程仍在服务旧字符串，
  **必须重启宿主**才在真实侧边栏里生效（本轮未重启）。

## Verification

```sh
node --test tools/board-responsive.test.mjs tools/board-response-source.test.mjs
# 13 条，13 pass / 0 fail
node tools/fault-injection.mjs    # 39 个测试文件全部登记，无遗漏
```

**真故障注入**（改生产文件 → 跑 → 还原，`sha256` 逐次核对）：

| 变异 | 期望 | 实际 |
|---|---|---|
| 5 列改回 `repeat(4, …)` + 删 `location.hash = 'directory'` | 「同一行」「点卡切视图」两条红 | ✖ 两条红，8 pass / 2 fail |
| `routeToListFilter('archived')` → `('implemented')` | 该条红 | ✖ 1 红，8 pass / 1 fail |
| 还原 | 全绿 | ✔ 9/9（该文件） |

**真机测量**（`node .probe/board-probe3.mjs`：headless Chrome + 虚拟时间 +
`--dump-dom`，读 `getBoundingClientRect()`、`typeof window.*`、
`.deck-tab.active`、`#matrix-rows-stream` 行数，不读源码）：

```json
// 修后（.probe/board-metrics.json 的 before 段）
"cardCount": 5, "occupiedRows": 1,
"gridTemplateColumns": "253px 253px 253px 253px 253px",
"rowClassName": "kpi-row kpi-row-5",
"已归档": { "top": 92, "left": 1120, "width": 253 },
"reachability": { "routeToListFilter": "function", "switchDeckTab": "function", "Core": "undefined" }

// 弄脏筛选后再点（afterDirtyClick 段）
{ "statusValue": "archived", "classValue": "", "searchValue": "",
  "activeTab": "directory", "matchedText": "匹配 1 条", "rowCount": 1 }
```

`修前` 的对照值是当轮 `--dump-dom` 打印、**未落盘**；`修后` 的这组有
`.probe/board-metrics.json` 与 `.probe/shot-kpi-fixed.png`（截图由
`--screenshot=<绝对路径>` 产出，命令参数写在探针文件里，可照着重跑）。
两样都在 `.probe/`（`.gitignore` 内），**不入库**。
另需说明：我这个模型**没有图像输入能力**，所以截图**我没有看过**，
布局结论全部来自上面的数值测量，不是「肉眼确认」。

**一条方法教训（本轮现场实证）**：`RESPONSIVE_CSS` / `ARCHIVED_CARD_JS`
本身是模板字面量，注释里写一个反引号（比如为了引用 `.probe/...` 或
`Core.stFilter`）就会**提前终止模板**，整个模块 `SyntaxError`，而报错行号
指向注释本身。本轮踩了三次。

第一版把防线写成 `board-responsive.test.mjs` 里的一条
`assert.doesNotMatch(ARCHIVED_CARD_JS, /`/)` —— 它**永远不会执行**：
真出反引号时该文件的 `import` 先抛，`node --test` 报的是
`tests 1 / fail 1`（文件加载失败），断言连注册都到不了。复审 r2 的 G-2
指出这点时，现场正是一次真实事故，它确实没抓到。

现在的防线是 `tools/board-response-source.test.mjs`：**只用 `readFileSync`
读源码、不 import 模块**，逐个常量从声明扫到下一个反引号，并要求正文里
出现「本该在结尾」的片段 —— 于是提前截断会变成一条指名道姓的红：
「X 的模板在第 N 行被一个裸反引号提前结束」。本轮它真的抓到了一次。

**同类事故的第二个形态（本轮也真的发生了）**：注释里写了 `<script` 两个词。
它不会打断 HTML 解析（脚本数据态只认 `</script`），但注入的都是**内联脚本**，
于是 `</script>` 的配平断言之外的「`<script` 总数」当场多了 1 ——
`tools/board.test.mjs:404` 报「应恰好 5 个（上游 2 + 补丁 3），实际 6」。
这条断言原本只为防「数据里的 `</script>` 逃逸」，顺带把一个纯注释问题也
变成了红。修法是把注释里的尖括号去掉，而不是放宽计数。
