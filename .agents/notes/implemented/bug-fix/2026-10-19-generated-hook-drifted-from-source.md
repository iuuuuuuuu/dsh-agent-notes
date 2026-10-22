# Agent Note: 生成物与源漂移时，所有测试都看着新的那份

Status: implemented

> 同属**流程补齐**这条线，直接接续
> [2026-10-19-gates-that-nobody-runs-are-not-gates.md](../process/2026-10-19-gates-that-nobody-runs-are-not-gates.md)
> —— 那一篇把钩子从 2 道扩到 8 道，本篇发现**它自己的生成物没跟上**。
> 钩子原有的设计见
> [2026-10-18-notes-coverage-gate.md](../process/2026-10-18-notes-coverage-gate.md)。

Independent: 本篇处理的是**生成物与源的一致性**，与「门禁何时被触发」
（上一篇）和「门禁判什么」都不同 —— 那两者都是对的，坏的是这份**落盘副本**。

## Problem

上一轮把 `commit-msg` 钩子从 2 道扩到 8 道，钩子正文抽到
`tools/hook-body.mjs`。收尾时我改了源里的一行：

```diff
- node tools/docs:bilingual 2>/dev/null || node tools/bilingual-docs.mjs
+ node tools/bilingual-docs.mjs
```

**但我没有重新生成 `.githooks/commit-msg`**，并把它一起合进了 main。

### 两个后果，都不显眼

**一、那行本身是错的。** `node tools/docs:bilingual` 试图执行一个名为
`docs:bilingual` 的文件 —— 那不是路径，是 npm script 名。shell 里跑它必然
失败，靠 `2>/dev/null || ...` 的兜底才「看起来能跑」。也就是说：

> 合并进 main 的钩子，第三道门禁**是坏的**，而且它把错误静默吞掉了。

**二、生成物与源不一致，没有任何门禁发现。**

这是本轮主题的第三次重演，也是最讽刺的一次：

| 版本 | 状态 |
|---|---|
| `tools/hook-body.mjs`（源） | 新写法，正确 |
| `.githooks/commit-msg`（落盘副本） | 旧写法，坏的那行 |
| `hook-body.test.mjs` | **读源**，全部通过 |

**所有 11 条测试都看着新的那份，而实际执行的是旧的那份。** 门禁测的是
源文件，跑的是生成物 —— 两者之间没有任何一致性检查。

## Decision

新增一条测试：**已安装的 `.githooks/commit-msg` 必须逐字节等于
`HOOK_BODY`**。

```js
const actual = readFileSync(installed, 'utf8').replace(/\r\n/g, '\n');
const expected = HOOK_BODY.replace(/\r\n/g, '\n');
assert.equal(actual, expected, '跑 npm run hooks:install 重新生成');
```

`must`：**比较前统一行尾。** Windows 上 git 可能把工作区文件换成 CRLF，
而 `HOOK_BODY` 是 LF。不归一化会得到「内容一样但字节不同」的假红 ——
那种红会被人当成噪声而关掉门禁。

`must`：**失败信息里要写怎么办**（`npm run hooks:install`）。只说
「不一致」会让人去手改生成物，而手改下次就被覆盖。

`must`：**同时把那一行改对。** 只加门禁不改内容，等于把一道坏门禁锁进
仓库 —— 门禁会红，而人为了让它绿会去改断言。

## Alternatives considered

- **不提交 `.githooks/commit-msg`，每次 clone 后现场生成** — 从根上消除漂移。否掉因为它让「新 clone 立刻有门禁」失效：`hooks:install` 得记得跑，而这正是上一篇刚证明靠不住的那件事。提交生成物 + 一致性门禁，比「记得生成」可靠。
- **让 `install-hooks.mjs` 支持 `--check`，接进 `npm run check`** — 语义更清楚。**这是更好的长期方案**，但本篇先做测试版本：`--check` 要在钩子未安装（新 clone）时跳过，而「跳过」与「通过」的区分需要额外设计，容易做成假绿。测试版本判据更简单（文件必须存在且相等），先把漂移堵住。
- **在钩子里加一行 `# 由 tools/hook-body.mjs 生成，勿手改`** — 已经有这行。**但它没有阻止我。** 警告文字不是机制。
- **只改那一行，不加门禁** — 修完就走。否掉因为这是**第三次**同类问题（门禁没人跑、门禁没接进 CI、现在生成物没跟上），每次都是「机制缺口靠人补」而不是「机制自己发现」。再不把它变成门禁，第四次只是时间问题。

## Consequences

- **收益**：漂移从此会红。故障注入实测三条全部符合预期：基线绿 → 改回旧写法红 → 删掉一整道红 → 还原绿。
- **收益**：修掉一个**已经在 main 上的坏门禁**。`.githooks/commit-msg` 第三道现在真的能跑。
- **收益**：测试数从 10 条到 11 条，且这条测的是**落盘副本**而非源 —— 补上了此前完全没人看的那个面。
- **代价与已知上限**：这条测试只在「钩子被提交」的前提下成立。若将来改成不提交钩子，它必须改为跳过，否则会在新 clone 上假红。
- **代价与已知上限**：它只覆盖 `commit-msg` 这一个生成物。本仓库还有别的生成物（`lib/client.js` 由 `src/` 构建、`THIRD_PARTY_NOTICES.md` 由 `notices.mjs` 生成）—— 那两者**各自已有**一致性门禁（`verify-plugin` 验 bundle、`notices:check` 验声明），所以不重复。但这条纪律要记住：**每个生成物都需要自己的漂移检查，没有通用机制。**
- **重访信号**：若再出现「源改了、生成物没改」的第四种生成物，应把 `install-hooks.mjs --check` 做出来并接进 check 链 —— 那时三处以上就值得统一机制。另一个信号：若这条测试因为行尾差异在 CI 上假红，说明归一化不完整，要按平台补。

## Verification

```sh
node --test tools/hook-body.test.mjs   # 11 个用例（新增生成物一致性一条）
npm run check                          # 300 测试
```

故障注入（已实测，三条全部符合预期）：

| 注入 | 期望 | 实际 |
|---|---|---|
| 基线 | 绿 | ✔ 绿 |
| 把 bilingual 那行改回旧写法（模拟漂移） | 红 | ✔ 红 |
| 删掉一整道门禁（模拟少跑一道） | 红 | ✔ 红 |
| 还原 | 绿 | ✔ 绿 |

### 这一篇的元教训

本轮连续三篇笔记记录的是同一个形状的缺陷：

1. **门禁没人跑** —— 门禁存在，触发靠记性；
2. **门禁没接进 CI** —— 本地有，CI 没有；
3. **生成物没跟上源** —— 源是对的，执行的是旧副本。

三者都不是「判据写错了」，而是**「改动真的生效了吗」没有人验证**。
这类缺陷的共性：**所有测试都绿**，因为它们看的是同一个面（源），
而坏掉的是另一个面（触发时机 / 执行位置 / 落盘副本）。

所以每次修完，要问一句：**我验的那个面，是不是用户实际走的那个面？**
