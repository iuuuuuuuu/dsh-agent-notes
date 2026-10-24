# Agent Note: 归档旁挂的封印只查「有没有」，从不复算

Status: implemented

> 接续 [2026-10-22-archive-layout-has-no-gate.md](2026-10-22-archive-layout-has-no-gate.md)
> ——那一篇给归档树补上了形状/元数据/封印 schema 的门禁，本篇修的是那道门禁
> **自己对旁挂文件只查了一半**。
> 同一族「看起来验了、实际没验」的形态见
> [2026-10-24-http-status-and-empty-comparison-must-not-pass.md](2026-10-24-http-status-and-empty-comparison-must-not-pass.md)。

## Problem

`lib/archive-layout.js` 管的是 **vendored 跳过的那些文件**：vendored 扫描归档区时
显式跳过 `.zh.md`，所以归档旁挂既不进它的语料、也不受它的封印保护。本模块
因此要求「旁挂必须被封印」—— 但第一版只检查 `sealed.has(key)`：**manifest 里
有没有这个键**，封印值从不复算。

后果实测（真 Git 仓库，只读审计 `.probe/audit-notes-gate.md` 的 S2）：

```
改动前:        passed=true  archived: ok: 1 archived note(s) verified, 2 seal(s) in manifest
改旁挂内容后:  passed=true  archived: ok: 1 archived note(s) verified, 2 seal(s) in manifest   ← 没红
改正笔记内容后: passed=false archived: exit=1 archived/… — seal mismatch: …
```

更极端：把旁挂的封印值写成**与磁盘内容完全无关的哈希**，照样 `passed=true`。
也就是说 `lib/archive-layout.js` 文件头自称要堵的那个洞仍然敞着，只是门口
多贴了一张**从不检查**的封印标签；而归档门禁还打印 `2 seal(s) in manifest`，
读起来像两条都验过。

**这是本仓库最忌的形态**：不是「没做检查」，是「做了个看起来通过、实际不验东西的检查」。

## Decision

### 一、存在的键必须复算，且口径与 vendored 逐字相同

新增 `sealOf(absolutePath)`：`sha256:` + `createHash('sha256').update(readFileSync(path)).digest('hex')`。
对每个 `archived/**/*.zh.md`，比对 manifest 里的封印值与磁盘实际值，不一致报
与 vendored 同款的 `seal mismatch`，并把**两边实际值都打出来** ——
否则「内容被改」与「当初就填错了」两种成因长得一模一样。

`must`：**不要传 `'utf8'`**。vendored 算的是 `readFileSync` 的**原始字节**；
先解码再编码遇到非 UTF-8 字节就会分叉，而分叉只在对不上的那一刻才暴露。

### 二、口径一致性不靠注释保证，靠一条互证用例

`tools/archive-layout.test.mjs` 里有一条**同一字节互证**用例：内容逐字相同的
`.md` 与 `.zh.md` **共用同一个由 `sealOf` 算出的封印**，然后让 **vendored 自己去验那篇
`.md`**。两边一旦分叉，那条用例立刻红。也正因如此，该测试文件的夹具必须继续
用 `sealOf` 算封印，不要自己再写一份。

### 三、不重复 vendored 已经做过的对账

「封印指向一个不存在的文件」**刻意不在这里做**：vendored 已有同口径判据
（`sealed entry has no file on disk`）。同一问题两处真相，而两处文案不同会让人
怀疑是不是两回事。这里只管 vendored **不拦**的那一类：旁挂的封印是否正确。

## Alternatives considered

- **改 vendored 脚本，让它也验 `.zh.md`** — **这是本篇最强的一条被否方案**。理由很硬：封印口径只有一份、由一个验证者算，从根本上消除「两边各算一套」的分叉风险，也不需要外壳再兜一层。**否掉有两条**：其一，`skills/agent-notes/` 是上游副本，手改会被 `verify-plugin.mjs` 的哈希比对拦下（AGENTS.md 的硬约束 3），改动等于要同时改上游并等同步；其二，上游是**刻意**跳过 `.zh.md` 的（它把旁挂当翻译产物而非独立笔记），本插件要管的恰恰是「上游不管、但落在归档区里」的字节 —— 那本来就该由外壳负责。
- **只查「有没有封印」，在文档里写明「不校验封印值」** — 最省事，且不算说谎。**否掉因为那是本仓库明令禁止的形态**：贴一张从不检查的标签，比不贴更糟 —— 它让人以为验过了，而「以为验过了」会让真正的问题在归档区里长期存活。冻结只读区的全部价值就是「它不会变」，这条不验等于整个归档门禁只验了一半。
- **给 vendored 传一个「旁挂清单」参数，让它一起验** — 口径只会有一份，且不用在外壳里重写哈希。**否掉因为要给上游提需求**，同步周期不可控；而在那之前归档区一直是敞的。等上游真支持了，本模块这段可以删（见重访信号）。
- **连「封印指向不存在文件」也一并在这里报** — 更完整。**否掉因为它制造两处真相**：vendored 已经报同一条，而两处文案不同会让人以为是两个问题。本仓库反复栽在「同一判据两处实现」上。
- **算哈希时用 `readFileSync(path, 'utf8')`** — 与文本读取路径统一，看起来更一致。**否掉因为它与 vendored 分叉**：vendored 用的是字节。口径分歧只会在某个非 UTF-8 字节上暴露一次，那时几乎不可能想到是编码问题。

## Consequences

- **收益**：归档旁挂从「贴了标签」变成「真的复算」。改内容、伪造封印值都会红，且诊断同时给两边的值。
- **收益**：口径与 vendored 的一致性由一条**互证用例**钉住，不再靠注释自律 —— 分叉会立刻变成红灯。
- **收益**：没有新增第二处对账（反向对账仍留给 vendored），同一事实只有一份真相。
- **代价与已知上限**：旁挂封印的**生成端**不在本模块；若生成端本来就没登记某个旁挂，用户看到的是 `未在 manifest.json 里封印`（这条判据原地保留，未改动）。本轮只改了**校验端**。
- **代价与已知上限**：`sealOf` 会把整个文件读进内存。归档笔记都是文本、体量很小，可接受；若将来归档里出现大二进制旁挂，要改成流式。
- **代价与已知上限**：本轮由 teammate 实现、Lead 复核并补笔记，实现与笔记不是同一时刻落盘。
- **重访信号**：
  - 若上游的 vendored 脚本开始自己验 `.zh.md` → **本模块这段应当删掉**（重复判据比缺判据更难排查），并保留那条互证用例改为直测 vendored。
  - 若归档允许二进制/大文件旁挂 → `sealOf` 要改成流式，且互证用例要补二进制字节的用例。
  - 若有人把 `sha256:` 前缀换掉或改大小写 → 互证用例会红；那是刻意的，口径改动必须两边同时改。

## Verification

```sh
node --test tools/archive-layout.test.mjs   # 20 tests / 20 pass / 0 fail
```

新增 4 条（都用**真 Git 仓库**夹具，不是纯函数）：

1. 改归档旁挂内容 ⇒ **必须判红**（真 Git 仓库）。
2. 把旁挂封印写成与磁盘无关的哈希 ⇒ **必须判红**（基线已同步，只剩复算这一条判断）。
3. 旁挂封印正确时**仍然通过**（别把正常通路一起杀掉）。
4. 旁挂封印与 vendored 正笔记封印**必须同口径**（同一字节互证）。

**真变异**：把 `if (actual !== seal)` 改成恒假（即退回「只查键存在」的旧行为）
⇒ `18 pass / 2 fail`，红的正是上面第 1、2 条；还原后 `20 pass / 0 fail`，
`git diff --stat lib/archive-layout.js` 与变异前一致。
