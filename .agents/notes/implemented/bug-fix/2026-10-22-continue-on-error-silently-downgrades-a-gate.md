# Agent Note: 门禁步骤不许被 continue-on-error 静默降级

Status: implemented

> 承接[保护发布的那道门禁，自己没人保护](../process/2026-10-19-publish-gate-had-no-guardian.md)：
> 那篇给 `ci-alignment` 加了 6 条 CI 安全属性断言，并留了一句「我自己独立验时抓到
> 一个漏洞（执行者漏了）」。本篇是同一类漏洞的**第二次**复发 ——
> 这次漏掉的是 `continue-on-error`。

## Problem

`tools/ci-alignment.mjs` 的 6 条安全属性里，有一条是「门禁排在 push 之前」、
一条是「push 受 `if` 保护」。它们管的是**顺序**与**触发条件**。

但 GitHub Actions 还有一个字段能单独废掉一道门禁：

```yaml
      - name: 文本完整性
        continue-on-error: true
        run: npm run text:integrity
```

`continue-on-error: true` 的语义是「这一步失败只记一条警告，**job 照样绿**」。
加了它，那道门禁在 CI 里就**存在但没人执行** ——
`ci-align` 的包含式判据（本地门禁 ⊆ CI 步骤）看不见这种变化：
命令还在、位置还在、顺序也没变，只有「失败会不会让 job 变红」被改掉了。

实测：给 `verify.yml` 的「文本完整性」步加 `continue-on-error: true` →
`npm test` 退出码 0、**整链 exit 0**，`ci:align` 一声不吭。

这个字段特别危险的地方在于它是**加**上去的 —— 不删任何东西、不改任何命令，
只在步骤下面多一行。加它的人通常是想「这一步偶尔不稳定，先别让它卡住 CI」，
而实际效果是「这一步以后永远不会卡住 CI」。

`upstream-sync.yml` 更危险：那个 workflow 有 `permissions: contents: write`
且会 `git push` main 与 tag，它守着的是**发布**。

## Decision

`tools/ci-alignment.mjs` 的 `SAFETY` 数组新增两条判据，**两个 workflow 各一条**：

- `verify.yml` / `no-continue-on-error`；
- `upstream-sync.yml` / `no-continue-on-error`。

判据读的是 `stripComments(yml)` 之后的正文，匹配
`/^\s*continue-on-error:\s*true\s*$/m`。

三个边界写进了用例：

1. **注释里的不算**。整行注释掉的字段不会被 YAML 执行，不能因为它出现在文件里
   就判红。判据读的是「会被执行的内容」。
2. **`continue-on-error: false` 允许**。显式写 false 的人表达的是「这道不许降级」，
   与本门禁的意图一致；判据不能写成「出现 continue-on-error 就红」。
3. **只判 `true`**。GitHub Actions 的合法取值是 `true` / `false`；
   其它值不会被执行（YAML 会把它当未定义），但那属于 workflow 自己的错，
   不由这条判据负责。

## Alternatives considered

- **判「任何 workflow 步骤都不得带 `continue-on-error`」**：比现判据更严。
  **否掉因为**：`continue-on-error: false` 是合法且有意义的显式声明，
  判它红会逼人删掉一句正确的说明 —— 误报的门禁会被绕过，而这里没有任何收益。
- **在 `ci-alignment` 之外单开一道「workflow lint」**：职责更清晰。
  **否掉因为**：`ci-alignment` 干的就是「CI 配置里的门禁是否被保护」，
  新开一道要重新实现「读哪些 workflow、怎么去注释、怎么比对」这一整套，
  而判据集合本就该放在一起 —— 否则会出现「6 条属性在一道门禁里、
  第 7 条在另一道门禁里」的分裂。
- **改成判「整个 workflow 不得有 `continue-on-error`」并豁免特定步骤**：
  覆盖更广。**否掉因为**豁免清单本身需要防腐机制（理由非空 + 必须命中），
  而本仓库的 workflow 里**目前没有任何一步需要这个豁免** ——
  先加一张空表不如不加。
- **靠 `actionslint` 之类的现成工具**：判据更权威。**否掉因为**那要引入
  第三方依赖与 CI action 供应链，而这条判据只有一行正则；
  本仓库的原则是「能机械判定就自己写，别把门禁的成败挂在别人的发布节奏上」。
- **只判 `verify.yml`，不管 `upstream-sync.yml`**：省一半工作量。
  **否掉因为** `upstream-sync.yml` 守的是发布，且它有 `contents: write` ——
  那里静默降级的代价更大。两处同形态扩展，误报风险相同。

## Consequences

收益是「门禁步骤被静默降级」现在会红，且**点名是哪一条属性、哪个文件**。
两个 workflow 都覆盖，`upstream-sync.yml` 那一处是发布链路上唯一一道
「静默降级就等于永久失守」的地方。

代价与已知边界：

- 判据是**文本级**的：它认的是 `continue-on-error: true` 这个字面形态。
  YAML 里写成 `continue-on-error: !!bool "true"`、或用锚点/合并键
  （`<<: *defaults`）间接引入，这道判据看不见。
  GitHub Actions 的 workflow 里这两种写法都极少见，但**不是不可能**。
- 判据只覆盖**这两个已登记的 workflow**。`ci-alignment.mjs` 对未登记的
  workflow 只报 `⚠` 不判失败（那是既有设计，见
  [那篇笔记](../process/2026-10-19-publish-gate-had-no-guardian.md)），
  所以「新增一个 workflow 并在里面加 `continue-on-error`」不会被这道判据拦。
- 判据不区分「这道步骤本来就是非阻塞的」（例如纯通知步骤）。
  本仓库两个 workflow 里目前没有这种步骤；若将来有，
  该步需要一条带理由的豁免（届时要同时加豁免表的防腐机制）。

## Verification

```sh
node --test tools/ci-alignment.test.mjs
# tests 22 / pass 22 / fail 0                                    (exit 0)
```

新增 4 条用例：verify.yml 加 `continue-on-error: true` 必须变红；
upstream-sync.yml 加同样字段必须变红；注释里写该字段不判红；
`continue-on-error: false` 不判红。

**真故障注入（改真实 workflow，不是夹具）**：备份
`.github/workflows/verify.yml` 后，用字节级写入在「文本完整性」步下面插入
`        continue-on-error: true` → `node tools/ci-alignment.mjs` **退出码 1**：

```
CI 安全属性被删改：1 处
  ✖ verify.yml：no-continue-on-error
      任何一步都不得带 continue-on-error: true（那等于把门禁静默降级成警告，CI 照样绿 —— 门禁存在但没人执行等于没有）
```

`cp` 还原后 `diff` 确认与备份逐字相同，复跑 `node tools/ci-alignment.mjs`
退出码 0（「8 条 CI 安全属性均未被删改」—— 判据从 6 条增加到 8 条）。

写入用 Python 字节级方式（`newline=''`），避免 Windows 上把 LF 翻成 CRLF。
