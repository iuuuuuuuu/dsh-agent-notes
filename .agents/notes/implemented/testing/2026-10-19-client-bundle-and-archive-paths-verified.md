# Agent Note: 客户端 bundle 与归档路径已核查，两条都可用

Status: implemented

> 同属**上游比对 / 全流程核查**这条线。
> 生成物漂移的通用教训见
> [2026-10-19-generated-hook-drifted-from-source.md](../bug-fix/2026-10-19-generated-hook-drifted-from-source.md)
> ——那一篇记录的是**真的漂了**；本篇记录的是**核查后发现没漂，但过程有收获**。
> 归档机制的原始设计见
> [2026-10-18-notes-coverage-gate.md](../process/2026-10-18-notes-coverage-gate.md)。

Independent: 本篇核查的是**两个从未被真实执行过的路径**（客户端 bundle 同步、
归档），与门禁链、CI 对齐、钩子触发时机是不同的失效面。

## Problem

goal 点名要核查「客户端」与「笔记本体」。这两块最近几轮都没碰过，而且各有
一个共同特征：**它们都是「有机制但可能从未真跑过」的路径。**

- `lib/client.js` 是 `src/client.js` 的构建产物，`verify-plugin.mjs` 里有
  一段「重建后比对」的检查；
- `.agents/notes/archived/` 有封印机制（SHA-256 manifest），
  `verify-archived-agent-notes.ts` 一直在门禁链里跑，但**归档数一直是 0**。

前几轮的教训是「代码里有检查 ≠ 检查会红」。所以这两条都要**真的驱动一次**。

## Decision

### 一、客户端 bundle 同步：已核查，会红

真改 `src/client.js` 的函数体、不 build、跑 `verify-plugin.mjs`：

| 注入 | 期望 | 实际 |
|---|---|---|
| 基线 | 绿 | ✔ 绿 |
| 函数体内加注释 | 红 | ✔ 红 |
| 改真实标识符（`NS` 的值） | 红 | ✔ 红 |
| 还原 | 绿 | ✔ 绿 |

报错信息明确：`✖ lib/client.js 与 src/client.js 不同步（请跑 npm run build）`。

**这条不用改** —— 它已经能拦住「改了 src 却忘了 build」。

### 二、归档路径：已核查，可用

在临时 git 仓库里真归档一篇：

```
Moved: implemented/process/2026-01-01-probe.md -> archived/process/2026-01-01-probe.md
Sealed in archived/manifest.json with hash sha256:393a38788...
No active notes link to this archived note.
```

结果全部正确：

| 检查 | 结果 |
|---|---|
| 原文件已移走 | ✔ |
| 归档文件存在（保留 class 层级 `archived/process/`） | ✔ |
| 封印清单生成 | ✔ `{"version":1,"files":{"archived/process/...":"sha256:393a..."}}` |
| **格式被重写**（加 `Archived: 2026-10-19`） | ✔ |
| 归档门禁 | ✔ `ok: 1 archived note(s) verified, 1 seal(s) in manifest` |

**这条也不用改。** 归档数 0 只是因为还没有需要归档的笔记，不是因为机制坏了。

## Alternatives considered

- **不核查，直接认定「有门禁就是好的」** — 省时间。否掉因为前几轮连续三次栽在「机制存在但没生效」上（门禁没人跑、门禁没接进 CI、生成物没跟上源）。**「有检查」这个事实本身不构成证据。**
- **归档一篇真实笔记来验证** — 更直接。否掉因为它会改动真实笔记树（不可逆地改变 lifecycle），而验证机制可用不需要动真实数据。临时仓库能证明同样的事，且不产生任何需要回滚的副作用。
- **给客户端 bundle 与归档各加一条常驻测试** — 防止将来退化。**这是本篇最强的一条被否方案**。否掉的理由是成本不对称：客户端 bundle 的核查要改真实 `src/` 再还原（并行测试时那会与其他测试撞车，本仓库已因「测试写真实目录」踩过 5 轮坑）；归档核查要建临时 git 仓库并跑 TypeScript 脚本（约 1.5 秒）。两者都不是「顺手加一条」的量级。而它们当前都**没有退化过** —— 与「字符门禁漏过 5 次」的处境不同。记在重访信号里。
- **把归档脚本的依赖清单写进文档** — 减少下次搭沙箱的摩擦。否掉因为那是探针的内部细节，不属于仓库文档。本篇的 Verification 段已记下依赖，够用。

## Consequences

- **收益**：确认两条「有机制但没跑过」的路径都是可用的。这消除了两个潜在的不确定性 —— 若归档真坏了，等到第一次需要归档时才会发现，那时通常正赶着要归档一批笔记。
- **收益**：客户端 bundle 同步门禁被证明**会红**（两种注入都拦住），不是摆设。
- **收益**：归档门禁在**有对象**时确实验了东西（`1 archived note(s) verified, 1 seal(s)`），而不是空集合的 `ok: 0`。这一点很重要 —— 空集合通过是本仓库反复强调的假绿形态。
- **代价与已知上限**：两条核查都**没有固化成常驻测试**（见被否第三条）。所以将来若退化，仍要靠人工发现。这是明知的缺口。
- **代价与已知上限**：归档核查是在临时仓库里跑的，它证明的是「脚本本身能用」，**不证明**「在真实笔记树上归档一批不会破坏别的东西」（例如入站链接的批量修复）。后者只在真的归档时才会暴露。
- **重访信号**：
  - **客户端 bundle**：若出现「改了 src 忘了 build」的真实事故，把核查固化成测试（届时需解决并行写真实目录的问题）。
  - **归档**：第一次真的归档笔记时，注意观察入站链接是否被正确处理 —— 脚本会打印 `No active notes link to this archived note`，若有链接则会有别的提示，那条路径尚未验证过。
  - **归档**：若归档数增长到 10 篇以上，考虑把核查固化 —— 那时「机制坏了」的代价变高。

## Verification

客户端 bundle（`.probe/tmp/verify-client-sync2.mjs`，不入库）：

```sh
node .probe/tmp/verify-client-sync2.mjs
```

归档路径（`.probe/tmp/verify-archive-path.mjs`，不入库）：

```sh
node .probe/tmp/verify-archive-path.mjs
```

归档探针的沙箱依赖（下次重写时直接照抄）：

```
skills/agent-notes/scripts/archive-agent-note.ts
skills/agent-notes/scripts/agent-note-tree.ts
skills/agent-notes/scripts/verify-archived-agent-notes.ts
skills/agent-notes/scripts/verify-agent-note-tree.ts
skills/agent-notes/scripts/verify-agent-note-format.ts
```

### 这一轮的方法论收获

第一版客户端核查**报了假失败**：我把注入点放在 `src/client.js` 的文件第一行，
而 `buildClientBundle()` 只截取 `function createAgentNotesClient(require) {`
**之后**的内容 —— 文件头部不参与构建，所以改了它重建结果不变，门禁正确放行。

**那是我的注入点错了，不是门禁坏了。**

所以：验证「改 A 会红」时，注入必须落在 **A 真正参与计算的那部分**。
这与「验证 A 时不要在测试里另写一份 A」是同一族的错误 —— 都在问
「我动的那个地方，真的是被测逻辑读的那个地方吗」。

归档核查也踩了同族的两处：沙箱先后缺 `agent-note-tree.ts`、缺
`verify-archived-agent-notes.ts`，每次都表现成「归档坏了」，实际是沙箱不完整。
**现象一样，修复方向相反。**
