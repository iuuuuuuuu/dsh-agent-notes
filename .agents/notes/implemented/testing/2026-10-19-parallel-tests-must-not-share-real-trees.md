# Agent Note: 并行测试改同一批真文件 = 偶发失败的根源

Status: implemented

> 同属**测试策略**类。浏览器端的分层见
> [2026-10-19-logic-in-node-rendering-in-chrome.md](../testing/2026-10-19-logic-in-node-rendering-in-chrome.md)，
> config 开关注入见
> [2026-10-19-config-switches-need-non-default-injection.md](../testing/2026-10-19-config-switches-need-non-default-injection.md)。

Independent: 本篇处理的是**测试之间的并发干扰**（测试文件怎么写），
与「断言是否恒真」「门禁判据是否正确」是不同的失效面 —— 前两者让断言失真，
本篇让断言读到不一致的输入。

## Problem

`npm test` 是 `node --test tools/*.test.mjs`。Node 为每个测试文件起一个进程
并**并行**跑。而本仓库有三份测试**真改仓库里的文件**：

| 测试文件 | 改什么 | 谁在读它 |
|---|---|---|
| `md-links.test.mjs` | `AGENTS.md`（追加 Markdown）、`skills/agent-notes/`（放探针） | `doc-budget`、`verify-plugin`、全仓库门禁、`project-skill` / `self-update` 的 `cpSync` 源 |
| `bilingual-docs.test.mjs` | `README.md` / `README.en.md` | `md-links`（扫全仓库）、`docs:bilingual` 门禁 |
| `notices.test.mjs` | `upstream.json` / `THIRD_PARTY_NOTICES.md` | `notices:check` 门禁 |

于是出现这条真实的干扰链：

```
md-links 往 skills/agent-notes/ 写一个探针文件
        ↓（同时刻）
project-skill 正在 cpSync 同一棵树 → 拷进去的内容不一致
        ↓
assert.equal(info.behind, false) 偶发红
```

症状极具迷惑性：单独跑该文件 **4/4 全绿**，全量跑偶发红（8 次全量跑红 2 次）。
而 `project-skill.test.mjs` 里早就有注释写着「这条测试在 CI 上偶发失败过」
—— **这个信号被忽略了整整几轮**，因为我一直把它当成网络问题。

### 只修一处不够

第一版只把 `md-links` 的 vendored 探针挪进临时目录，稳定性复测**依然红**
（6 次红 4 次），失败的还变成了 `md-links` **自己文件里的别的用例**。

因为我当时只看到一条链（「A 写 B 的输入」），漏掉了更重要的一层：

> **门禁自己也是读者。**

`npm run check` 串行跑没问题，但 `npm test` 并行时，测试改写的那几十毫秒里，
门禁与其它测试读到的就是中间态。

## Decision

`must`：**真仓库文件只读不写。** 需要构造「坏输入」时走注入，不改盘。

| 测试 | 原做法 | 现做法 |
|---|---|---|
| `md-links` | 改真 `AGENTS.md` | 临时目录里造一份**自足的最小文档**，用新增的 `verifyMarkdownLinksIn` 校验 |
| `md-links`（vendored） | 写真 vendored 目录放探针 | 复制整棵 vendored 树到临时目录，在复制品里放探针 |
| `bilingual-docs` | 改真 README 两版 | `verifyBilingual({ read })` 把内容指向内存 Map，**零字节写盘** |
| `notices` | 改真 `upstream.json` / `THIRD_PARTY_NOTICES.md` | `renderNotices({ read })` 与 `checkNotices({ actual })` 注入 |
| `release-check` | 改真 `package.json` / `CHANGELOG.md` | `verifyRelease({ read })` 注入（这是本篇初稿里的「重访信号」，同批就处理掉了） |

门禁「覆盖真仓库」这件事由**只读**的用例负责（`md-links` 第一条用
`verifyMarkdownLinks()` 扫真仓库）。两类用例分工明确：只读的验覆盖面，
注入的验检测逻辑。这样既消除了竞争，又没有把「门禁真的作用在这个仓库上」
从测试里删掉。

`must`：临时文档必须**自足**。最初 `withAppended` 复制真 README 进去，结果
它自带的互链（指向 `README.en.md`）在临时目录里没有对应文件，于是凭空多报
一条「链接目标不存在」，把「必须恰好报一处」的断言变成 `2 !== 1` —— 12 条
用例一起红。正确做法是用最小文档，并把它引用的每个目标都放进去。

`must`：否定式断言必须带对照。「不扫描 vendored」若没有「同一份文件被显式
扫描时报错」的对照，就可能因为**检测器整体坏了**而假绿。

### 顺带修掉一个静默退化

给 `renderNotices` 加 `{ read }` 覆盖后出现过一次真实事故：调用点写成
`renderNotices(readFn)`（把函数直接当参数传）**不报错**，`options.read`
取到 undefined，于是静默回落到真仓库 —— 注入的数据根本没生效，测试变成在验
真仓库并全绿。

同类问题在 `withUpstream` 上又发生一次：它返回裸 `read` 函数，调用点写成
`renderNotices(withUpstream(…))` 形状不匹配，同样静默退化。修法是让辅助函数
返回**完整的参数对象** `{ read }`，形状与参数名对齐，传错会立刻炸。

这类「安静地做另一件事」比崩溃危险得多 —— 崩溃会告诉你出事了，静默退化会让
你以为自己测了。现在 `renderNotices` 收到非对象参数会抛 `TypeError`，
并有一条用例钉住。

## Alternatives considered

- **给 `npm test` 加跨进程网络锁**（我先写了一个 `net-lock.mjs`） — 当时以为根因是网络竞争。否掉是因为**那个假设是错的**：`board.test.mjs` 里的 git 操作全是**本地**的（`git init` + `remote add`，不发请求），真正的网络只有 `self-update` 里的 `git ls-remote`，而它自己处理了不可达。基于错误假设写的锁属于工程垃圾，已删除 —— 留着它会让人以为并发问题被解决了。
- **调大超时** — 掩盖问题。文件竞争不是时间问题，加超时毫无作用。
- **把 `node --test` 降为 `--test-concurrency=1`** — 彻底消除文件间并行。否掉是因为 249 个测试的耗时会接近翻倍（当前 34 秒），而真正的缺陷是**某三个测试写了不该写的文件**，不是并行本身有罪。并行是 Node 的默认与正确选择。
- **让所有测试都改副本，连门禁覆盖面也一起** — 那样门禁就不再覆盖真文件，等于把「门禁真的作用在这个仓库上」这件事从测试里删掉。只读 + 注入的两分法保住了它。
- **接受偶发失败，在 CI 上重跑** — 零成本。否掉是因为「重跑一次就好了」会让人把并发缺陷误判成环境问题，进而长期容忍它。这正是本条被忽略几轮的原因。

## Consequences

- **收益**：消除并行缺陷。四个测试文件现在对真仓库**零写入**（`md-links` 只往临时目录写）。
- **收益**：新增四个「把校验指向别处」的注入口 —— `verifyMarkdownLinksIn(files)`、
  `verifyBilingual({ read })`、`renderNotices({ read })` / `checkNotices({ actual })`、
  `verifyRelease({ read })`。这不只是为了测试：诊断「某一份具体的文档会被怎么处理」时也需要它们。
- **收益**：`project-skill` 那条自建时就记录在案的「CI 上偶发失败」终于有了解释，不再是悬案。
- **代价与已知上限**：`writeNotices()` 仍然写 `THIRD_PARTY_NOTICES.md`（那是它的职责，CLI 用），但
  **没有任何测试调用它** —— 生成路径靠 `checkNotices` 的内容比对间接覆盖。若将来改坏生成逻辑，
  测试会通过而 `npm run notices` 产出错误内容。这是一条已知敞口。
- **代价与已知上限**：本次诊断花了五轮，暴露了自己的四个问题：(1) 连续两次**靠推断**下结论
  （先怀疑悬挂后台任务、再怀疑跨文件网络竞争），两次都不成立 —— 正确做法是先把失败块原文打出来
  再下结论；(2) 第一版探针只匹配 TAP 的 `not ok`，而 `npm test` 的包装层输出 `✖`，导致
  「跑了一轮什么都没看到」看起来像「没复现」；(3) 只修了一处（vendored 探针）就以为解决了，
  漏掉 `AGENTS.md` / `README.md` / `upstream.json` 这三条同类链；(4) 改成临时副本后，用
  「复制真 README」引入互链缺失，让 12 条用例一起红 —— **修并发时改坏了被测输入**。
  每一步都要单独验证，不能因为前一步变绿就以为整体好了。
- **重访信号**：若将来新增会改真文件的测试，必须用注入而不是写盘。若某个门禁还没有 `read`
  之类的注入口，就在补测试时顺手加上 —— 这是让「测试可并行」与「门禁覆盖真文件」两者兼得的
  唯一办法。

## Verification

```sh
npm test                              # 全量，应稳定通过
node --test tools/md-links.test.mjs   # 不再写真目录
node --test tools/bilingual-docs.test.mjs
node --test tools/notices.test.mjs
```

诊断手法（值得复用）：用探针连跑全量 6–8 次，把**失败块原文**打出来，
而不是靠推断。注意 `npm test` 的输出不是裸 TAP，`✖` 与 `not ok` 两种前缀
都要匹配 —— 只匹配一种会让「跑了一轮什么都没看到」看起来像「没复现」。