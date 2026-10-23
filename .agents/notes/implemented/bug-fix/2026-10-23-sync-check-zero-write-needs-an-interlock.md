# Agent Note: 零写入不能靠分支顺序，要有一道默认关着的闸门

Status: implemented

- 日期：2026-10-23
- 适用：`tools/sync-upstream.mjs` 的 `--check`（零写入）路径

## Problem

2026-10-19 那篇同步笔记修掉了「`--check` 悄悄变成写入」，但它自己留了一条上限：

> - **代价与已知上限**：`--check` 的「零写入」目前靠**分支顺序**与**新加的条件判断**
>   共同保证，没有机制化的验证（见被否的第一条）。若将来有人在 `--check` 路径里插入
>   写盘，现有测试抓不到。
> - **把 `--check` 的「零写入」做成硬断言（发现任何写盘就抛错）** — 更彻底，能挡住
>   未来新加的写入路径。**这是个好主意，但本篇不做** —— 它要包一层文件系统代理，
>   改动面比修 bug 大得多。

写下面这段代码时的实际形态，能看出这条上限为什么是真的：

```js
if (args.check) { console.log('--check 模式：未写入任何文件。'); process.exit(1); }
...
if (!args.yes) { return; }
for (const entry of [...changed, ...added]) { … writeFileSync(local, remote, 'utf8'); }
writeManifest(manifest, ref);
```

「零写入」由两件事共同保证：早退分支在写盘**之前**、写盘段在 `--yes` 之后。两者之间
没有任何断言。有人在早退分支上面插一笔写盘（比如「先把查到的 ref 记下来」），
`--check` 就悄悄写了文件 —— 不报错、退出码还可能 0，而症状会在**很久之后**以
「`verify-plugin` 的哈希比对莫名变红」的形式出现，那时已看不出是谁写的。

判据的失效方向决定了它必须换成机制：**这个属性的失败是静默的、且延迟暴露**。
靠「人记得把写盘放在早退下方」不属于判据。

## Decision

给写盘加一道**默认关闭**的闸门，只有明确打开时才允许落盘：

```js
let writesAllowed = false;                      // 默认关闭

function assertWritesAllowed(what) {            // 写盘函数第一行自查
  if (writesAllowed) return;
  throw new Error(`✖ ${what}：当前处于零写入模式，却走到了写盘 —— 写盘必须发生在 withWrites() 打开的窗口内。`);
}

export function withWrites(what, fn) {           // 窄窗口
  writesAllowed = true;
  try { return fn(); } finally { writesAllowed = false; }
}
```

三处写盘各包一个窗口，`writeManifest()` 自己也在第一行自查：

| 写盘点 | 现在的形态 |
|---|---|
| 无漂移时记 ref | `if (!args.check) withWrites('记录同步 ref', () => writeManifest(manifest, ref))` |
| 合并时覆盖副本 | `withWrites(\`写入上游副本 ${entry.rel}\`, () => { mkdir; writeFile })` |
| 合并后记 manifest | `withWrites('记录同步 ref', () => writeManifest(manifest, ref))` |

三条刻意的选择：

- **闸门默认关**，不是可配开关：新增一条写盘路径时忘了包 `withWrites` 会当场抛错，
  而不是「按需打开」。默认值站在安全那一侧。
- **`finally` 关闸**，不靠「正常路径记得关」：写盘抛异常（磁盘满、权限）时闸门若
  留在打开状态，之后任何漏包的写盘都会静默通过 —— 一次失败换来永久失效是最坏的组合。
- **不做文件系统代理**（当年否掉的那条路）：代理要拦 `fs` 全家族，还得处理
  `fs.promises`、`fs.open` 之类，改动面大且容易漏；而闸门只需覆盖**本脚本自己**
  那三处写盘，成本是三行。

## Alternatives considered

**① 做文件系统代理，拦一切写盘（当年笔记里被否的那条）。**
最强的理由：它是真隔离 —— 覆盖未来任何写法（`fs.promises`、`createWriteStream`、
子进程 `cp`），而闸门只覆盖本脚本里被包住的那几处；而且它的验证不需要代码里
存在「闸门」这种自我检查，属于外部证据。
否掉的原因：代理要拦 `fs` 整个家族，还得对 `import { writeFileSync } from 'node:fs'`
这种**已解构绑定**生效 —— 静态 import 拿到的是模块原始函数，代理只能靠
`--experimental-loader`/`module.register` 换模块图，或者改用子进程 + `--import` 预加载。
两者都比「三处写盘各包一行」贵一个量级，而收益只多覆盖「未来新写法」这一种情形；
真出现新写法时，闸门会在**测试里**立刻报错，仍然可见。

**② 在测试里跑真 `--check` 再比文件哈希。**
最强的理由：这是**端到端**证据 —— 不需要代码里任何自查，验的就是用户看到的命令。
否掉的原因：`--check` 要 `git ls-remote` 并下载上游原始文件，是**真网络**。
放进 `npm test` 会让本地门禁依赖外网：断网时这条只能变成「不可判定」，而门禁里
没有「不可判定」这一态 —— 要么假绿（跳过）要么假红（误报），两者都比如实说
「这条没验」更糟。所以这条降级为**人工验证**：本轮真跑了一次
`node tools/sync-upstream.mjs --check`（内置副本与上游一致，exit 0），
前后比对了 `tools/upstream-manifest.json` 与 `upstream.json` **逐字未变**。

**③ 只把写盘函数改成 `async` 并 `await` 一个 `if (args.check) throw`。**
最强的理由：改动最小，一行。
否掉的原因：它把「是不是 check」变成每个写盘点都要重复的参数，正是当年
「分散的优先级规则」那条上限的复现（`--auto --check` 打架就是这么来的）。

## Consequences

收益：

- 「零写入」从**约定**变成**机制**：在 `--check` 路径上插一笔写盘会抛错，不是静默写。
- 三条属性进了 `npm test`（`tools/sync-write-interlock.test.mjs`）：闸门默认关、
  被拦下时磁盘逐字不变、异常路径之后闸门仍关。
- 顺手修掉一个隐患：`withWrites` 的 `finally` 保证「写盘失败一次」不会让闸门永久开着。

代价与已知上限：

- 闸门只覆盖**本脚本**的写盘。若将来这个脚本改用子进程写文件（例如 `git checkout`、
  `cp`），闸门看不到 —— 那时要靠 code review 或另加判据。这条写进重访信号。
- 闸门是**代码内自查**，不是外部隔离：如果有人把 `assertWritesAllowed` 一并删掉，
  测试会红（下面有变异证据），但那是「测试能拦」而不是「做不到」。
- 本轮为做变异把 `tools/upstream-manifest.json` 与 `upstream.json` 真写坏过一次，
  已从 HEAD 还原并逐字核对（见 Verification）。这是**违反自己定的规则**：
  变异只许在临时副本上做。

## Verification

- `node --test tools/sync-write-interlock.test.mjs` ⇒ `5 pass / 0 fail`（3 条闸门 + 2 条 CLI 入口）。
- **真故障注入 ①**（去掉 `withWrites` 的 `finally`，改成 `return fn()`）⇒
  `2 pass / 1 fail`，红的正是「退出后闸门立刻关回」；按字节还原后全绿。
- **真故障注入 ③**（把「仅直接执行」的 `invokedDirectly` 改成恒 `false`）⇒
  `3 pass / 2 fail`，红的正是两条 CLI 入口用例（`--help` 什么都不打印、`--branch`
  缺值静默 exit 0）—— 这条变异证明「守卫判定写错就静默退出 0」不再只靠手工实测；
  按字节还原后 `5 pass / 0 fail`。
- **真故障注入 ②**（删掉 `writeManifest` 第一行的 `assertWritesAllowed`）⇒
  `0 pass / 3 fail`。这次变异**真的写坏了两个数据文件**（`upstream.json` 的
  `ref` 变成 `refs/heads/main`、`fileCount: 0`；manifest 变成 `{"files":{}}`），
  已 `git checkout --` 还原，`git status` 里只剩本次该有的两处改动；
  `node tools/verify-plugin.mjs` 复跑「上游清单比对: 21 个文件一致」通过。
- **端到端人工验证**：`node tools/sync-upstream.mjs --check` ⇒
  `内置副本与上游一致，无需合并。` exit 0；前后 `cmp` 两个数据文件**逐字未变**。
- `node --test tools/sync-upstream.test.mjs` ⇒ `5 pass / 0 fail`（原有 5 条未受影响）。

相关笔记：[`./2026-10-19-sync-auto-check-silently-writes.md`](./2026-10-19-sync-auto-check-silently-writes.md)
（当年的两个真缺陷与它自己写下的这条上限）、
[`./2026-10-22-gate-judgments-must-default-deny.md`](./2026-10-22-gate-judgments-must-default-deny.md)
（同一原则的另一次应用：判据要默认拒绝，不靠列举）。
