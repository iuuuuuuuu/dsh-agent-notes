# Agent Note: `await fetch()` 之后 `process.exit()` 会崩成 127；守它的用例又测不到真缺陷

Status: implemented

- 日期：2026-10-23
- 适用：`tools/sync-upstream.mjs` 的失败退出路径；`tools/sync-upstream.test.mjs` 那条「枚举失败」用例

Independent: 本篇处理的是**进程怎么退出**与**用例怎么认原因**，不改任何同步判据、不改清单格式、不改退出码语义（1 = 检查失败，2 = 无法进行）。相关但不相同：网络不可用被报成契约破裂见
[2026-10-19-network-down-reported-as-contract-broken.md](./2026-10-19-network-down-reported-as-contract-broken.md)（那篇修的是**说什么**，本篇修的是**怎么退出**）；崩溃不算红门禁见
[2026-10-21-crash-is-not-a-red-gate.md](../testing/2026-10-21-crash-is-not-a-red-gate.md)（本篇是它在真实工具上的一个实例）；断言必须弄坏就会红见
[2026-10-23-assertions-must-be-able-to-fail.md](../testing/2026-10-23-assertions-must-be-able-to-fail.md)（本篇第二次踩同一个坑，且**是我自己放松断言踩的**）。

## Problem

两件事撞在一起，第一次是在 `npm run check` 里被一条「红灯」暴露出来的：**那条红灯本身是假的**。

### 一、HTTP 4xx 之后立刻 `process.exit()`，退出码是 127

`node tools/sync-upstream.mjs --check --ref refs-does-not-exist-zzz` 的输出：

```
上游: https://github.com/czm15053/write-notes-like-deepseek.git @ refs-does-not-exist-zzz
合并失败: 清单拉取失败 404: https://data.jsdelivr.com/v1/packages/gh/...@refs-does-not-exist-zzz
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
```

退出码 **127**。连跑三次，三次都是 127。用六行探针把它缩到最小：`fetch()` 拿到一个非 2xx 响应（**响应体没读**）之后立刻 `process.exit(1)`，Windows + Node 22.19 上稳定撞 libuv 的 `async.c:76` 断言；同样的代码改成 `process.exitCode = 1` 后正常退出 1（三次都是 1）。

127 的害处不是「非零所以会红」—— 是它**不是任何约定的退出码**：调用方看到 127 会判「工具自己崩了」，于是去查工具，而真因是「那个 ref 不存在」。约定里 1 是检查失败、2 是无法进行，127 两者都不是。

### 二、守这条的用例，抓不到它该抓的缺陷

同一条命令有专门用例「枚举失败必须报错，不得伪装成「无需合并」」。它原来的断言是三句：

```js
assert.notEqual(code, 0, '清单拉取失败时必须以非零退出');
assert.match(out, /失败|找不到目录|枚举/, …);
assert.doesNotMatch(out, /无需合并/, …);
```

两处失效，都实测过：

1. **假红**：断网时（`HTTPS_PROXY` 指向死端口）工具输出 `无法校验上游: fetch failed …`，退出码 2 —— 行为**完全正确**，但这句里没有「失败」「找不到目录」「枚举」，用例红了。
2. **测不到**：把 `listUpstreamDir()` 的 `if (!response.ok) throw …` 改成 `return []`（就是历史缺陷「枚举静默返回空」），工具换成另一句失败信息 `上游 skills/…/assets 为空，看板模板可能已改名或移走。`（exit 1、也带 ref）—— 用例 **5/5 全绿**。宽词 `/失败|枚举/` 对「换一句失败的话」毫无判别力。

更难看的是：我自己第一版「修假红」就是把正则放宽成 `/无法校验上游|失败|找不到目录|枚举/` —— 假红修好了，判别力同时归零，**同一个坑当天第二次**。

## Decision

1. **异步失败路径不再 `process.exit()`**，改成 `process.exitCode = 2`（环境不可用）/ `= 1`（检查失败）后 `return`，让事件循环自然收干。
2. **用例只认两种具体原因句**：`清单拉取失败`（HTTP 分支）或 `无法校验上游`（环境分支）；再要求退出码 ∈ {1, 2}、原因里能定位到那次请求的 ref、且不出现 `无需合并|已是最新|一致，无漂移`。

## Alternatives considered

**只把 `process.exit(1)` 换成就地 `await response.body?.cancel()` 再退出。** 最强的理由是它最贴病根：崩是「响应体没读就退」，把体读掉/取消掉，`process.exit()` 确实能干净退出——我实测过，能过。否掉的原因：这要求**每一处**未来新增的非 2xx 分支都记得先收尸，漏一处就回到 127，而漏的方式是静默的（只有崩的时候才知道）。`process.exitCode` 是「不依赖每处都记得」的写法。

**干脆把非 2xx 也归到 exit 2（环境不可用）。** 最强的理由是调用方不必区分两种失败，CI 只看非零。否掉的原因：`ref` 写错、上游把目录改名，都是**契约侧**的事实，说成「环境不可用」会把人指向错误方向——这正是
[2026-10-19-network-down-reported-as-contract-broken.md](./2026-10-19-network-down-reported-as-contract-broken.md)反着踩过的坑，不该反向再踩一次。

**用例就保留宽词 `失败|枚举`。** 最强的理由是它对实现措辞不敏感，改文案不会红。否掉的原因：实测它连「枚举静默返回空」都放过（5/5 绿），对实现措辞的「宽容」等于对缺陷的「宽容」；而且宽词还带来了假红（断网时 `fetch failed` 不含中文「失败」）。宁可绑两句具体原因句——它们不是文案，是**两种失败语义**的名字。

**在测试里注入假 fetch 来摆脱网络依赖。** 最强的理由是断网就不该红，而且快。否掉的原因：这条用例的价值正在于「真的发一次请求、真的失败」，用桩替掉就变成测桩。网络依赖确实是代价，见下面 Consequences。

## Consequences

收益：

- 失败退出码回到约定：HTTP 失败 1、环境不可用 2，**不再出现 127**；三次重复实测稳定。
- 那条守卫用例重新有判别力：两个真变异（枚举静默返回空、退回 `process.exit(1)`）都能让它红。
- 「宽词断言」这个形态本身有了一份实测记录：它不是风格问题，是判别力归零。

代价与上限：

- 退出依赖事件循环收干。今天所有失败路径都没有残留句柄（实测每次都立即退出），但**如果将来某个失败路径握着长连接不放，进程可能挂住而不是崩**；这一点没有判据守着，只能靠 review。
- 用例仍然需要网络（这个文件 5 条里有 3 条要真拉上游）。本篇只解决「环境失败被误判成契约破裂」，**没有**解决网络依赖本身。
- `tools/sync-upstream.mjs` 里成功路径仍有 10 处 `process.exit()`（成功收尾时实测干净退出 0），我没有一并改：那是另一件事，改了没有观测到的故障可对照。

## Verification

- 复现崩溃：最小探针 `fetch(404) → process.exit(1)` 连跑三次，三次都是 `exit=127` + `async.c:76` 断言；同探针改 `process.exitCode` 后三次都是 `exit=1`。
- 修复后真实命令：`node tools/sync-upstream.mjs --check --ref refs-does-not-exist-zzz` 连跑三次，三次都是 `exit=1`；断网（`HTTPS_PROXY=http://127.0.0.1:1`）时 `exit=2` 且输出 `无法校验上游: fetch failed`。
- `node --test tools/sync-upstream.test.mjs` → 5 tests / 5 pass。
- 离线分支的断言成立性单独验证（整份用例需要网络，无法在断网时全跑）：`.probe/check-offline-assert.mjs` 拿真实离线输出跑那四条判据，四条全 ✔、退出码实测 2。
- 真故障注入两次（备份 → 变异 → 跑本文件 → 还原 → `cmp` 确认逐字节相同）：
  | 变异 | 结果 |
  |---|---|
  | `listUpstreamDir()` 非 2xx 改 `return []`（历史缺陷形态） | 4 pass / **1 fail**（正是这条用例） |
  | 退出改回 `process.exit(1)`（127 崩溃） | 4 pass / **1 fail**（退出码不在 {1,2}） |
- 反面记录：**宽词版本断言（`/无法校验上游|失败|找不到目录|枚举/`）对第一个变异 5/5 全绿** —— 这是本篇最关键的一条证据，它说明「断言能通过」不等于「断言在测东西」。
