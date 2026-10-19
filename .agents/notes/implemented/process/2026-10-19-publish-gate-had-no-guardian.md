# Agent Note: 保护发布的那道门禁，自己没人保护

Status: implemented

> 同属**流程补齐**这条线，接续
> [2026-10-19-gates-that-nobody-runs-are-not-gates.md](./2026-10-19-gates-that-nobody-runs-are-not-gates.md)
> ——那一篇把门禁从「靠记性触发」变成「提交即跑」，本篇处理**更靠后一层**：
> CI 里的门禁步骤本身有没有人保护。

Independent: 本篇处理的是 **workflow 文件本身的完整性**，与门禁判什么、
何时触发、跑多快都无关 —— 那些是「门禁在做什么」，本篇是「门禁配置会不会被改坏」。

## Problem

teammate 做覆盖面扫描时发现一个结构性问题：

> **门禁只校验「自己声明的那份东西」，没有任何门禁校验「门禁自己的基础设施」。**

具体到最危险的一处：

```
.github/workflows/upstream-sync.yml
  permissions: contents: write
  - name: 门禁（合并后必须通过才允许提交）
      run: npm run verify / notes:gate / npm test / gate:fault-injection
  - name: 提交并推送
      git push                      ← 直接推 main
  - name: 打 tag
      git push origin "$tag"        ← 直接推 tag = 发布
```

那道门禁守着**发布**。而当时的 `ci-alignment.mjs:40` 是：

```js
const WORKFLOW = join(PACKAGE_ROOT, '.github', 'workflows', 'verify.yml');
```

**硬编码只读 verify.yml。** 全仓 grep `upstream-sync` 零引用。

于是：**删掉那道发布门禁的整步，全链仍然 exit 0。** 我独立验证过——把
4 个 `npm` 命令整块删掉，`ci-align` 报「通过」。

## Decision

### 一、`ci-alignment` 从「读一个文件」改成「扫所有 workflow」

两种口径，因为两个 workflow 的职责不同：

| workflow | 口径 | 必需门禁 |
|---|---|---|
| `verify.yml` | `mode: 'all'` | 本地 `check` 链每一步 |
| `upstream-sync.yml` | `mode: 'subset'` | `verify` / `notes:gate` / `npm test` / `gate:fault-injection` |

**subset 的豁免逐条写了理由**，不是笼统一句「不需要」：

- `notices:check` / `md:links` —— 判上游 vendored 内容与第三方归属。上游内容
  由 `sync-upstream` 按 ref 与哈希保证，归属声明只针对本仓库引入的依赖。
- `docs:bilingual` / `doc:budget` / `release:check` —— 判**人写的**文档。这个
  job 不改 README/CHANGELOG，跑它们只会因「本来就超预算」误报。
- `notes:coverage:last` / `supersession:last` —— 判「本次提交范围」，机器人
  commit 不经人审。

### 二、加 6 条 CI 安全属性断言

| 属性 | 为什么必须有 |
|---|---|
| PR 触发器存在 | 否则只在 push 时跑，PR 上看不到红 |
| `fetch-depth: 0` | 归档门禁要读可信的 PR base；浅克隆会**从「通过」退化成「查不到」** |
| 最小权限 | `contents: write` 不该给不需要它的 job |
| 工作区洁净断言 | 测试不得改工作区（那是个真实事故） |
| **门禁排在 push 之前** | 顺序倒了等于没有门禁 |
| push 受 `if` 保护 | 无条件 push 会在「没改动」时也推 |

每条删掉都红，且**点名是哪一条**。

### 三、我自己独立验时抓到一个漏洞（执行者漏了）

teammate 汇报「13 条故障注入全按预期」。但规矩写着**不许只凭执行者汇报就标完成**，
所以我逐条重注。抓到：

```
把 upstream-sync 的 `npm test` 改成 `npm test --if-present`
→ ci-alignment 仍报「齐全」，exit 0
```

**而那一步后面就是 `git push main` + `git push tag`。**

根因是判据匹配了**字面量**：

```js
tests += [...text.matchAll(/(^|[;&|\n]\s*|\s)npm test(\s|$)/g)].length;
```

`npm test --if-present` 里 `npm test` 后面跟空格 → 匹配 → 算数。
但 `--if-present` 的语义恰恰是「脚本不存在就跳过」= **没有这道门禁**。

修法：排除 `--if-present` / `--if-present=true` / `-if-present`（含
`=false` 那种写法，因为它同样是「可跳过」）。

**这与「扫全文没区分注释与命令」是同族错误**：判据匹配了字面量，没匹配语义。
我在笔记里写过这个教训，又在同一道门禁里犯了一次。

## Alternatives considered

- **给 upstream-sync 也跑完整 check 链** — 最省事。否掉因为那个 job **不改** README/CHANGELOG，`docs:bilingual` / `doc:budget` / `release:check` 会因「本来就超预算」误报，而误报会让整个发布流程卡住。**给自动化加会误报的门禁 = 让它被绕过。**
- **要求所有新 workflow 都登记，否则判红** — 更严。**这是 teammate 特意问我的取舍点。** 它选了「报出来但不判红」。我同意：强制登记会逼着人给纯通知型 workflow 填一堆不需要的门禁豁免 —— **乱填的豁免表比没有更糟**，因为它稀释了这张表的可信度。报出来 = 让人知道；不判红 = 不逼人乱填。
- **不校验安全属性，只校验门禁齐全** — 少做。否掉因为实测证明它们**删掉都会变绿**，而其中 `fetch-depth: 0` 最隐蔽：它不会让门禁变红，只会让 `notes-coverage` **从「通过」退化成「查不到」** —— 那是另一种假绿。
- **把 workflow 的校验做成独立脚本，不塞进 ci-alignment** — 职责更纯。否掉因为 `ci-alignment` 已经会读 yml、比对步骤名、有豁免表、有故障注入，**另起一个等于从零再写一遍 yml 解析**，而那正是本次出 bug 的地方（`run: |` 块标量）。

## Consequences

- **收益**：保护发布的那道门禁**第一次有人保护**。删它、改成可跳过、把门禁挪到 push 之后、删任一条安全属性 —— 全部会红。
- **收益**：`ci-alignment` 从「查一个文件」变成「查所有 workflow」，新增 workflow 会被报出来（即使不判红）。
- **代价与已知上限**：6 条安全属性是**硬编码的期望值**，若将来 workflow 该改（比如加了第三个 job），要先改这里。**但这正是它的价值** —— 想改就得看见这条断言。
- **代价与已知上限**：`mode: 'subset'` 的 9 条豁免是逐条判断的，**可能判错**。比如若将来那个 job 开始改 README，`docs:bilingual` 就该变成 required。判断随职责变，豁免表也要跟着改。
- **代价与已知上限**：未登记的新 workflow 只「报出来不判红」—— 这是一个**有意的宽松**，代价是新 workflow 的门禁缺失不会被拦。**这是那个取舍的另一面**：换来的是豁免表可信。
- **重访信号**：若新增第三个带 `permissions: write` 的 workflow，`ci-align` 会报它出来 —— 那时要决定给它什么口径（`all` 还是 `subset`），并把它的安全属性加进断言。另一个信号：若某条安全属性断言在合理改动后误报，要判断是断言过时还是 workflow 真有问题。

## Verification

```sh
npm run ci:align      # 现在查两个 workflow + 6 条安全属性
node --test tools/ci-alignment.test.mjs   # 18 个用例
npm run check                              # exit 0（312 测试）
```

**我自己独立做的故障注入**（不凭执行者汇报），9/9 全部符合预期：

| 注入 | 期望 | 实际 |
|---|---|---|
| 删 upstream-sync 门禁整步 | 红 | ✔ 红 |
| 删 `npm run verify` | 红 | ✔ 红 |
| 删 `npm run notes:gate` | 红 | ✔ 红 |
| 删 `npm test` | 红 | ✔ 红 |
| 删 `npm run gate:fault-injection` | 红 | ✔ 红 |
| `npm test` → `npm test --if-present`（**漏洞**） | 红 | ✔ 红（修前是**绿**） |
| `npm test` → `npm test --reporter=dot` | 绿（不误伤） | ✔ 绿 |
| 删 `fetch-depth: 0` | 红 | ✔ 红 |
| 删工作区洁净断言 | 红 | ✔ 红 |