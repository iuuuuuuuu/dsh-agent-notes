# Agent Note: 指纹不许靠字段清单，漏报是没有信号的

Status: implemented

- 日期：2026-10-23
- 适用：`lib/board-route.js` 的 `revisionOf()`、看板热更新轮询

## Problem

看板热更新靠一个内容指纹判断「要不要重绘」：页面每 4 秒拉 `/data`，指纹变了才
调上游 `ingestDataset` 重画。指纹由 `revisionOf()` 算，而它按**字段清单**逐个
`h.update()`：`id / title / status / date / lifecycle / cls / problem / decision /
alternatives / consequences / outLinks`。

2026-10-18 那篇热更新笔记里，我自己把这条写进了「代价与已知上限」：

> `revisionOf()` 依赖字段清单 —— 上游将来若给笔记加新字段（比如 `tags`），
> 本插件不改就察觉不到那个字段的变化。

今天兑现了，而且比预测的更近：`lib/board.js` 的 `buildInlineData()` **当前就**
在每篇笔记上带 `slug` 与 `rawBody`，清单里两个都没有。后果是：

- 只改 `rawBody` 里**四个小节之外**的部分（重写 `## Verification`、改
  `## Consequences` 之外的行、动 frontmatter）⇒ 指纹不变 ⇒ 页面不刷新；
- 同一个仓库里 `slug` 变了（文件改名）⇒ 指纹不变；
- 而**什么都不会报**：日志全绿、页面看着「正常」，只是内容是旧的。

判据的失效方向决定了它必须换形态：清单式判据的失败是**静默漏报**，而漏报的价值
等于零；反过来「多算一个字段」的失败只是多重绘一次，用户看得见（滚动位置跳一下）。
两种失败的成本不对称，判据就该偏向「宁可多算」。

## Decision

指纹改为**按字段名排序后逐个写入，集合开放**：

```js
for (const key of Object.keys(note).sort()) {
  h.update(key); h.update(FIELD_SEP);
  const value = note[key];
  if (value === null || value === undefined) h.update(FIELD_NULL);
  else if (typeof value === 'string') h.update(value);
  else h.update(JSON.stringify(value));
  h.update(FIELD_SEP);
}
h.update(RECORD_SEP);
```

三条具体判断：

- **不维护任何字段名清单**：没见过的名字照样计入，上游加字段不需要本插件同步改。
- **字段的出现/消失本身算变化**：`tags: []` 与「没有 `tags`」指纹不同 ——
  页面多渲染一个空位也是变化。
- **数组/对象用 `JSON.stringify`**：顺序是内容的一部分，不改写成排序集合。
- 分隔符用 `String.fromCharCode(0x00/0x01/0x02)` 常量表达，**不把裸控制字符写进
  源码** —— 本仓库的 `tools/text-integrity.mjs` 会把源码里的裸控制字符判成失败，
  本轮第一次就是这么红的（4 处裸控制字符）。

## Alternatives considered

**① 把 `slug` 与 `rawBody` 补进清单（照旧维护清单）。**
最强的理由：改动最小，指纹的语义完全不变，测试不用动一行；而且它精确——
只对「会被页面渲染的东西」敏感，不会因为一个纯元数据字段变化就重绘。
否掉的原因：这正是 2026-10-18 预测过、今天兑现的那条路。补两个字段只是把
下一次漏报推后：下次上游加字段时，漏报依旧没有信号。**清单的维护成本落在
「记得同步」上，而它失效时没有任何提示** —— 这类判据不该继续存在。

**② 只哈希 `rawBody`（整篇正文），其他字段一概不算。**
最强的理由：正文是唯一真相，正文变了就是变了；实现最短，也不用担心字段集合。
否掉的原因：`buildInlineData` 的输出里有些字段**不是正文的纯函数**——
`outLinks` 由 `collectLinks(raw, selfDir, knownIds)` 算出，`knownIds` 取决于
**别的笔记是否存在**。A 篇的正文没变、但 B 篇被删，A 的 `outLinks` 会变
（引用目标消失）⇒ 只哈希正文就漏了这次变化。整字段集合能同时覆盖这两类。

**③ 在 `/data` 里带上文件的 `mtime`，前端比 `mtime`。**
最强的理由：零计算、天然覆盖一切修改。
否掉的原因：历史结论（2026-10-18 那篇已实测）—— 某些编辑器保留 `mtime`，
改了内容看不出；多根（worktree）合并时 `mtime` 的精度与来源都不稳；而且
`mtime` 变化不区分「内容变了」与「只是被 touch 过」。

## Consequences

收益：

- 上游给笔记加字段、本插件不改，热更新也不会退化成「静默不刷新」。
- 立刻修掉两处现存漏报：`rawBody`（正文里四个小节之外的任何修改）、`slug`（改名）。
- 判据从「白名单」变成「全量」，与仓库其它门禁同一条原则（默认拒绝 / 只认事实）。

代价与已知上限：

- 指纹对**任何**字段变化都敏感，包括纯元数据 ⇒ 极端情形下多重绘一次。
  这是刻意选的方向：多重绘用户看得见，漏刷新看不见。
- `rawBody` 进了摘要 ⇒ 指纹的计算量随笔记总字数增长。**实测**（109 篇、序列化
  839 KB，本机）：`revisionOf()` **6.472 ms/次**；旧清单版同一份数据的基线是
  0.13 ms（2026-10-18 那篇量的），即慢了约 50 倍。按 4 秒一次轮询算占用
  0.16%，可以接受，但这是**真实的**性能回退，不是零；笔记涨到万篇级、或轮询
  间隔缩到亚秒级时要重新评估（备选：只哈希 `rawBody` + 派生字段，但见上文
  Alternative ② 为何没选它）。
- 指纹仍是 16 位截断摘要（碰撞概率对「几百篇笔记、几次轮询」无实际意义，
  但如果哪天用它做**持久化**的版本标识，要改成全长）。
- 本 Note 只修「指纹漏算」；「页面已打开时」的更新链路本身没动。

## Verification

- `node --test tools/board.test.mjs` ⇒ `35 pass / 0 fail`（新增一条用例）。
- **先红后绿**：新增用例在改判据之前跑，`slug` 变化前后的指纹都是
  `bbbf1d374fe3268b`，`assert.notEqual` 直接失败 —— 这就是上面那处静默漏报。
- **真故障注入**：把循环改成 `.filter((k) => k !== 'slug')`（等价于把 slug 摘回
  清单外）⇒ `34 pass / 1 fail`，红的正是新用例；按字节还原后 `35 pass / 0 fail`。
- `node tools/text-integrity.mjs` ⇒ `文本完整性通过：222 个文件无替换字符与裸控制字符`
  （第一次实现写了裸控制字符，被这条门禁拦下后改成 `String.fromCharCode`）。
- **性能实测**（不是估算）：`buildInlineData(['.agents/notes'])` 得 109 篇、839 051
  字节序列化；20 次 `revisionOf()` 取均值得 `6.472 ms/次`。
- `GIT_SSL_BACKEND=openssl npm run check` ⇒ 全绿（48 个测试文件全登记）。
- **未做的**：本轮没有构建部署，所以「改笔记后页面真的自动刷新」这次**没有**
  在实机上看过；本 Note 的验证只覆盖判据本身（真 `buildInlineData` 输出 + 真实
  指纹比对 + 变异）。实机复核按批次攒到部署后做。

相关笔记：[`./2026-10-18-board-live-refresh-on-note-change.md`](./2026-10-18-board-live-refresh-on-note-change.md)
（热更新链路本身与它记下的这条已知上限）、
[`../architecture/2026-10-19-paired-derivatives-is-not-my-problem.md`](../architecture/2026-10-19-paired-derivatives-is-not-my-problem.md)
（同类判断：对派生数据做比对时，判据要选失败方向可见的那一侧）。
