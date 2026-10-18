# Agent Note: /data 轮询的 88ms 来自 git 子进程，不是文件 I/O

Status: implemented

## Problem

热更新轮询（见 [../bug-fix/2026-10-18-board-live-refresh-on-note-change.md](../bug-fix/2026-10-18-board-live-refresh-on-note-change.md)
与 [../bug-fix/2026-10-18-poll-only-when-rendered.md](../bug-fix/2026-10-18-poll-only-when-rendered.md)）
已经把「不必要的次数」降到零，但**必要的那一次仍然重**：单次 `/data`
88ms、115815 字节。

**先入为主的判断是错的。** 我最初以为 78ms 花在「每次重新扫盘读文件」上，
差点去写服务端文件缓存。实测拆解后完全不是：

| 环节 | 耗时 |
|---|---|
| `buildBoardFromRoots`（扫目录 + 读全部 md + 解析） | **2.96 ms** |
| `buildInlineData`（提取四小节 + 链接） | 2.86 ms |
| `revisionOf`（sha256） | 0.13 ms |
| `JSON.stringify` | 0.12 ms |
| **四项合计** | **3.21 ms** |

业务逻辑一共只要 3.21ms，而 TTFB 是 88ms。差的 85ms 在别处。

用 TTFB 与总耗时对比（`probe/bench-http.mjs`，12 次采样）确认：TTFB ≈ 总耗时
（88.24 vs 88.39），说明时间全花在**发出首字节之前**，即 handler 内部，
而不是网络传输。

逐层排查到根因（`bench-git.mjs`）：

| 调用 | 耗时 |
|---|---|
| `spawnSync('git', ['remote', 'get-url', 'origin'])` | **76.38 ms** |
| `spawnSync('git', ['worktree', 'list', '--porcelain'])` | **73.38 ms** |
| 对照：`statSync` 5 个文件 × 10 轮 | **0.22 ms/轮** |

`lib/notes.js` 的根解析每次请求都要 fork 两个 git 进程。**git 子进程比文件
I/O 慢三百多倍** —— 这才是那 85ms。

更糟的是它会被放大：cwd 若是**容器目录**，`listWorktrees` 要对每个子仓库各调
一次、`originOf` 再对每个各调一次。子仓库越多越慢，且是线性叠加。

## Decision

两处独立优化，都不改行为。

**① git 探测加短 TTL 缓存（`lib/notes.js`）。**

`originOf` 与 `listWorktrees` 各自包一层 `cachedGitProbe`，TTL 10 秒。

`must`：**只缓存成功结果**。`listWorktrees` 缓存条件是
`Array.isArray(value) && value.length > 0` —— 空数组意味着「这里不是仓库」
或「git 刚失败」，把它记住 10 秒会把一次瞬时故障放大成持续的「找不到根」，
表现为看板莫名少了几棵树。`originOf` 同理只缓存非空字符串。

`must`：**不能永久缓存**。`git worktree list` 的结果会变 —— 用户新建/删除
worktree 是常事。永久缓存会让新 worktree 的笔记一直不出现，这类**静默漏数据**
比慢一点糟得多。TTL 到期重探。

TTL 取 10 秒的理由：笔记**内容**变更走的是每次都重读文件的 `revision` 比对，
不受这个缓存影响；这里只缓存「有哪些根目录」，它变化的频率极低。10 秒足够
挡住 4 秒一次的轮询重复开销，又让新增 worktree 最多晚 10 秒被发现。

**② `/data` 的 `rawBody` 瘦身（`lib/board-route.js`）。**

`rawBody` 占响应体 **53%**（32926 / 62041 字节）。而看板对它的**全部**用法
只有一处 —— `agent-notes-board.html:1281`：

```js
const crux = (n.rawBody || '').split('\n')[2]?.replace(/Status:\s*rejected\s*[—–-]/, '').trim() || n.problem || ...
```

即取第 3 行做 rejected 笔记的 crux。抽屉里的正文是另外走
`GET /agent-notes/note` 现读文件的，不依赖这个字段。

所以 `/data` 只发前 3 行（`firstLines(note.rawBody, 3)`）。

`must`：**保留字段名与语义**。仍是 `rawBody`，仍能 `.split('\n')[2]` 取到同一行，
只是内容被裁短。这样上游那行代码不用改，也不会因字段缺失而让 crux 退化成
`problem` 兜底（那会静默改变显示内容）。

`must`：四小节（problem / decision / alternatives / consequences）**不受影响** ——
它们是从全文提取的独立字段，本来就完整。`revisionOf` 也基于这些字段，
所以指纹判断不受瘦身影响。

实测效果（8 篇笔记）：

| 指标 | 优化前 | 优化后 | 变化 |
|---|---|---|---|
| TTFB | 88.24 ms | **5.13 ms** | **17×** |
| 响应体 | 115815 B | **53487 B** | **−54%** |

## Alternatives considered

- **服务端文件缓存（按 mtime 判断是否重读）** — 直击「每次重新扫盘」这个
  直觉上的瓶颈，实现也不复杂。这是我**最先想到的方案**，但实测证伪了前提：
  扫盘读文件只要 2.96ms，根本不是瓶颈；真正贵的是 git 子进程。按错误前提
  写的缓存会优化掉 3% 的时间，却引入缓存失效的复杂度。
  这正是「先量再改」的价值 —— 如果直接动手，会得到一个看起来合理、
  实际几乎没效果的改动。
- **永久缓存 git 探测结果** — 最省，缓存建好之后永不再 fork，TTFB 能压到
  更低。否掉是因为它把「新建 worktree 后笔记不出现」变成永久性问题，
  且**不报错、不易察觉** —— 用户只会觉得看板坏了。10 秒 TTL 只损失一点点
  性能，换掉一整类静默漏数据。
- **不用 git，直接按目录命名猜 worktree（`wt-*`）** — 彻底摆脱子进程，
  零 fork。否掉是这条路径已经被证明不可靠（`lib/notes.js` 的既有注释写明：
  worktree 可以放在仓库外的任意路径，猜目录名会漏）。而且文件头注释还记着
  另一个实测教训：容器目录下混着**别人的参考仓库**（`ref-panel`、
  `ref-sliverkiss`），靠 origin remote 过滤才能不显示别人的笔记 —— 而
  origin 只能问 git。
- **把 `rawBody` 整个从 `/data` 里删掉** — 负载能再降，字段干脆不要。否掉是
  因为它是上游的数据契约：`ingestDataset` 之后的节点对象会缺少 `rawBody`，
  上游那行 `(n.rawBody || '')` 会走 `|| ''` 分支、`.split('\n')[2]` 得到
  `undefined`，crux 静默退化成 `problem` 兜底 —— 显示内容变了但没人报错。
  留 3 行只花几十字节，避免这类隐蔽退化。
- **改用 ETag / 304，让浏览器自己省流量** — 标准做法，能省掉重复传输。
  否掉是因为它省不了**服务端**那 85ms —— 服务端仍要算 `revision` 才能给出
  ETag，而算 revision 就要先扫盘（3ms）。省的是传输，不是瓶颈。
  而且 53KB 的本地 HTTP 传输实测只占 0.1ms 量级（TTFB ≈ 总耗时）。
- **把 `revisionOf` 改成按文件 mtime 算，省掉读全文** — 能省那 3ms 的扫盘。
  否掉：前面已经实测过 mtime 不可靠（部分编辑器保留 mtime，改了内容看不出），
  且这 3ms 已经不是瓶颈了。为一个 3% 的收益换掉正确性不值得。

## Consequences

- **收益**：`/data` TTFB 88ms → **5.1ms**（17 倍），响应体 −54%。
  轮询对 DSH 主进程的影响从「每次卡 88ms」降到「5ms」，
  而 DSH 是单线程 Node —— 87ms 的同步 fork 是**真的会阻塞**其他请求的。
- **收益**：容器目录场景不再随子仓库数量线性变慢（缓存命中后零 fork）。
- **收益**：`rawBody` 瘦身是纯减法，不改任何字段语义，上游代码无需改动。
- **代价与已知上限**：新增 worktree 后最多有 **10 秒**延迟才会被看板发现。
  这是有意的取舍（见备选方案），重访信号：用户报告「新建的 worktree 笔记不出现」
  且超过 10 秒仍未出现时，先查 TTL 是否被改坏或 `listWorktrees` 是否命中了
  不该缓存的空结果。
- **代价与已知上限**：git 缓存在**进程内**。DSH 重启后首次请求仍要 fork 一次
  （实测冷启动 88–105ms），这是不可避免的。
- **代价与已知上限**：`rawBody` 现在只有 3 行。若将来上游改用 `rawBody` 渲染
  别的东西（比如抽屉正文、或提取第 5 行），这里会**静默给出不完整数据**。
  重访信号：`grep -n 'rawBody' skills/agent-notes/assets/agent-notes-board.html`
  出现新用法时，同步调整 `firstLines` 的行数或改变策略。
- **未解决**：每次请求仍要读全部 md 文件（2.96ms）。笔记量到几千篇时这会成为
  新瓶颈，届时的方向是增量读取或内容缓存 —— 但**现在不做**，
  因为 2.96ms 相对 5ms 的总耗时还不是主要矛盾，过早优化会让缓存失效逻辑
  提前复杂化。

## Verification

```sh
npm test                          # 110 项
node .probe/bench-http.mjs        # TTFB 与响应体（12 次采样）
node .probe/bench-data.mjs        # 各阶段拆解
node .probe/bench-git.mjs         # git 子进程 vs 文件 I/O
node .probe/perf-e2e.mjs          # 端到端：抽屉正文、crux、热更新
```

故障注入（三组，全部实测真红）：
- 端点里把 `firstLines(note.rawBody, 3)` 改回 `note.rawBody` → 变红；
- 只截 2 行（crux 会丢 Status 行）→ 变红；
- TTL 改成 999999（等同永久缓存）→ 变红。

**过程中修掉一条假绿**：最初只测 `firstLines` 的单元行为，把端点改回
`note.rawBody` 后测试**仍然全绿** —— 因为单元函数没变，变的是「端点有没有用它」。
补上端到端断言（驱动真实 `/data` 响应、检查返回的 `rawBody` 行数 ≤ 3 且
第 3 行仍是 `Status:`）之后才真正变红。**测了函数不等于测了调用点**，
这条只有靠故障注入才暴露。

端到端实测（8 篇笔记，CDP 真机）：
- 抽屉正文 2552 字符，含结尾小节（走 `/note`，不受瘦身影响）；
- rejected 笔记 crux 正确：造一篇探针笔记，`rawBody` 第 3 行
  `Status: rejected — 这个理由要能被看板取到`，正则清洗后得到
  `这个理由要能被看板取到`（探针已删除）；
- 热更新 `{polls: 6, applied: 1}`，四个视图全中。

优化前后对比（同一台机、同一份 8 篇笔记）：

| 指标 | 优化前 | 优化后 |
|---|---|---|
| TTFB | 88.24 ms | 5.13 ms |
| 冷启动首次 | 82–105 ms | 88 ms（缓存未命中，仍要 fork）|
| 响应体 | 115815 B | 53487 B |
| `rawBody` 占比 | 53% | 约 3% |
