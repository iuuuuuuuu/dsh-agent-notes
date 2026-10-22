# Agent Note: `--auto --check` 会静默写入，白名单重建会抹掉别人的字段

Status: implemented

> 同属**上游合并**这条线。
> 归属声明见
> [2026-10-19-third-party-notices-are-part-of-distribution.md](../process/2026-10-19-third-party-notices-are-part-of-distribution.md)
> （它正是本篇两个缺陷的受害者）。
> 并行测试的并发纪律见
> [2026-10-19-parallel-tests-must-not-share-real-trees.md](../testing/2026-10-19-parallel-tests-must-not-share-real-trees.md)。

Independent: 本篇处理的是**同步脚本的写入契约**，与文档同步、发布记账、
浏览器端逻辑是不同的失效面。

## Problem

给 `sync-upstream` 补参数解析测试（此前 `parseArgs` 未导出、文件导入即执行
`main()`，一条边界都测不了）时，撞上两个真实缺陷。

### 缺陷一：`--auto` 会覆盖 `--check` 的「零写入」意图

```
$ node tools/sync-upstream.mjs --auto --check
上游 HEAD: 72573a5b…
已同步:   72573a5b…
✔ 已是最新，且内置副本与清单一致，无需合并。
$ echo $?
0
```

看起来一切正常。但 `--auto` 的实现里有：

```js
ref = head;
args.yes = true;      // ← 无条件覆盖
```

`--auto` 隐含 `--yes` 是设计（CI 用它自动合并），但它**不该覆盖用户显式写下的
`--check`**。两者同传时，路径会走向合并，真的覆盖 vendored 副本。

之所以没被发现，是因为这条路径的**失败模式极其隐蔽**：

- 不报错；
- 退出码是 **0**（走的是「ref 相同 → 检查本地是否被改 → 走不了合并」的分支，
  恰好没写文件）；
- 也就是说，**这次没出事纯属巧合** —— 若本地与清单有出入，它就会真的写。

一次「看起来成功的检查」悄悄变成了「写入」。

### 缺陷二：`writeManifest` 用白名单重建 `upstream.json`

```js
const next = {
  repository, path, ref, syncedAt, fileCount,
  ...(previous.commit === undefined ? {} : { commit: previous.commit })
};
```

白名单重建看起来更干净，代价是**这个文件从此只有 `writeManifest` 能写**。

实测代价立刻兑现：我给 `upstream.json` 加的 `license` 与 `note` 两个字段
（`tools/notices.mjs` 生成第三方归属声明的数据源）被静默抹掉，表现为

```
Error: upstream.json: 缺少 license 字段。第三方归属必须声明许可证，不能留空。
```

`notices.test.mjs` 的 6 个用例同时变红。而触发它的只是一次
`npm run sync:check` 式的正常操作 —— **没有任何人改过那个文件**。

## Decision

`must`：**显式的 `--check` 优先于 `--auto` 的隐含 `--yes`。**

```js
if (!args.check) args.yes = true;
```

两者同传时退回「只检查」。想要写入就显式写 `--auto`（不带 `--check`）。

选择保守方向的理由：把「检查」解释成「写入」是**不可逆**的（覆盖 vendored
副本要靠 `npm run sync` 才能回来），而把「写入」解释成「只检查」只是没做事。
两者不对称时，**永远站在可逆的一边**。

`must`：**写入数据文件时保留本函数不负责的字段。**

```js
const next = { ...previous, ...managed };
```

`managed` 是本函数管的五个字段（`repository`/`path`/`ref`/`syncedAt`/`fileCount`），
它们覆盖原有值；其余字段原样保留。

白名单式的「重建」把「这个文件只有我能写」变成了隐式约束 —— 而那个约束
没有任何文档说明，任何人往里加字段都会被静默抹掉。改成「先展开再覆盖」之后，
新增字段不必回头改 `writeManifest`。

### 参数解析可测化

`parseArgs` 导出，`--help` 的实现改成可注入的 `onHelp` 回调（默认仍是
`printUsage()` + `process.exit(0)`）。文件末尾加「仅在直接执行时才跑
`main()`」的守卫 —— 否则测试 import 就会真的去访问网络、写文件。

`must`：给脚本加「仅直接执行」的守卫时，**必须实测 CLI 的每个入口**。
我抽出 `printUsage` 时忘了把调用接回去，`--help` 就变成了「什么都不打印就
退出 0」—— 测试全绿，功能已坏。是手工跑 `node tools/sync-upstream.mjs --help`
才发现的。**只看测试通过，看不到输出内容变空。**

顺带修好两个 `--help` 的真实缺口：`--help` / `-h` 与 `--ref` 都没在用法里
说明。是被新加的「用法文本一致性」测试抓出来的。

## Alternatives considered

- **让 `--auto` 与 `--check` 互斥（同时传就报错）** — 语义上更干脆，用户必须选一个。否掉是因为它把一个「静默做错事」的问题换成了「显式报错」，而后者会打断 `sync:check` 这类自动化调用（脚本里常顺带带几个参数）。保守优先级（`--check` 赢）不需要调用方改任何东西。
- **把 `--check` 的「零写入」做成硬断言（发现任何写盘就抛错）** — 更彻底，能挡住未来新加的写入路径。**这是个好主意，但本篇不做** —— 它要包一层文件系统代理，改动面比修 bug 大得多。记在重访信号里。
- **把 `upstream.json` 拆成两个文件（机器写的 + 人写的）** — 从结构上消除「谁该写谁」的问题。否掉是因为这个文件只有 6 个字段，拆分带来的「多一个文件要对齐」比「合并时保留字段」更麻烦。而 `{...previous, ...managed}` 已经足够。
- **不导出 `parseArgs`，改成让测试用子进程跑 CLI** — 不用改被测代码。否掉是因为那样测不了「缺值」「未知参数」这类**抛错路径**（子进程只能看退出码与 stderr，看不到内部状态），而且每条用例都要起一个 Node 进程，慢一个量级。

## Consequences

- **收益**：修掉两个真实缺陷。第一个是「检查模式悄悄变成写入」—— 那类缺陷不报错、退出码还可能为 0，只能靠**在正确时机读代码**发现。第二个会让任何往 `upstream.json` 加字段的人莫名丢数据。
- **收益**：`parseArgs` 从零覆盖变成 8 个用例 + **9/9 故障注入全部符合预期**（含「`--branch` 缺值静默用默认值」「未知参数被忽略」「`--check` 隐含 `--yes`」「`-h` 不等价于 `--help`」）。
- **收益**：`tools/notices.mjs` 的数据源不再会被同步脚本弄坏。两者本就该解耦，但此前是通过「同一个文件」耦合的，且是**隐式**的。
- **代价与已知上限**：本篇的 `--check` 优先级只覆盖 `--auto` 这一条路径。若将来新增别的隐含 `--yes` 的开关，仍需重复这个判断。这是「分散的优先级规则」的固有代价 —— 记在重访信号里。
- **代价与已知上限**：`--check` 的「零写入」目前靠**分支顺序**与**新加的条件判断**共同保证，没有机制化的验证（见被否的第一条）。若将来有人在 `--check` 路径里插入写盘，现有测试抓不到。
- **代价与已知上限**：给脚本加「仅直接执行」守卫引入了新的风险面 —— 若守卫判定写错，脚本会**什么都不做并静默退出 0**。已通过实测三个 CLI 入口（`--help` / `--check` / 未知参数）来覆盖，但那是手工的，不在 `npm test` 里。
- **重访信号**：若开始用别的工具写 `upstream.json`（例如某个 catalog 生成器），要重新确认字段归属 —— `{...previous, ...managed}` 只保证「sync-upstream 不抹掉别人的」，不保证「别人不抹掉 sync-upstream 的」。另一个信号：若 `--auto` 新增别的隐含写入开关，需要把优先级判断收敛成一处。

## Verification

```sh
node --test tools/args-parse.test.mjs   # 8 个用例
npm run check                           # 全量
```

手工验证的两个缺陷（这类语义问题必须在真实 CLI 上验）：

```sh
B=$(sha256sum upstream.json)
node tools/sync-upstream.mjs --auto --check; echo $?     # 期望：零写入、exit 0
[ "$B" = "$(sha256sum upstream.json)" ] && echo 零写入
```

故障注入（已实测，9/9 全部符合预期）：`--branch` / `--ref` 缺值时静默用默认值、
未知参数被忽略、`--branch` 吃掉下一个开关当值、`--check` 隐含 `--yes`、
`--auto` 恒 false、`-h` 不等价于 `--help`、`--help` 不触发回调、
用法文本漏掉某个开关的说明行。

其中最后一条最初**注入后仍全绿** —— 我在测试里用 `helpText.includes(flag)`
做断言，而 `--branch` 那行的说明里顺带提到了 `--latest/--auto`，
整段 includes 被无关行满足了。改成「每个开关必须拥有**自己那一行**」才变红。
这是「验证 A 时不要在测试里另写一份 A」的第三次应验。
