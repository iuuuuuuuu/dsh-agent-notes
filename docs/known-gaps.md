# 已知缺口与明确不做的项

这份清单只有一个用途：**防止已经判定过的东西被反复重新讨论**。每条都必须写「为什么不修」
和「什么情况下重访」，否则它只是一张焦虑清单。

判定口径：出现过「以为没得可做了 → 实际还有」或「以为还得做 → 实际有理由不做」两类对话，
两种误解都已发生过，所以两边都要留证据。**这里不是待办列表** —— 待办要么在做，要么已经
变成一条有理由的否决。

## 1. vendored 的三道门禁在空集合上 `exit 0`

`skills/agent-notes/scripts/` 下 `verify-agent-note-tree.ts`、`verify-agent-note-format.ts`、
`verify-archived-agent-notes.ts` 在零篇笔记时都 `exit 0` 并打印 `ok: 0 ...`。裸接进 CI 就是恒绿门禁。

- **为什么不改**：那是上游副本，由 `tools/sync-upstream.mjs` 管理，手改会被
  `tools/verify-plugin.mjs` 的哈希比对拦下（见
  [vendored 完整性门禁](../.agents/notes/implemented/process/2026-10-21-vendored-integrity-gate-stops-trusting-itself.md)）。
  本仓库的答案是在外面套一层判红的外壳（`npm run notes:gate`），并把这个事实用测试钉住。
- **重访信号**：上游把空集合改成失败 → `tools/notes-gate-vacuity.test.mjs` 里那条逐字
  stdout 断言会红，那时删掉外壳的空集合分支并同步上游。
- 证据：[vendored 门禁在空集合上是恒绿](../.agents/notes/implemented/testing/2026-10-22-vendored-gates-are-vacuous-on-empty-tree.md)。

## 2. 封存笔记里的行内引用是死角

`tools/doc-refs.mjs` 跳过 `archived/`，所以那批笔记里 `文件:行号` 引用漂了不会被发现。

- **为什么不修**：那批笔记按 SHA-256 封印、只追加。允许为改行号重新封印，等于废掉封印的
  全部保证；而一个**改不动**的红会让整道门禁被关掉，比少查几篇更糟。
- **重访信号**：封存笔记的引用真的指错了且误导判断（届时正确做法是写新笔记更正，
  不是改封存件）。
- 证据：[笔记正文的行内引用也进门禁了](../.agents/notes/implemented/process/2026-10-22-note-refs-join-the-gate.md)。

## 3. `doc-refs` 只验「行号存在」，不验「指向的代码还是原来那段」

行号没越界但语义已经变了（同一行被改成别的语句），门禁无感。

- **为什么不修**：判断「这一行还是不是笔记所描述的那段代码」需要理解内容，做不到可靠；
  硬做会产出大量误报，误报的门禁会被绕过（同 `AGENTS.md` 对语义判重的论证）。
- **重访信号**：出现「行号对但引用已经撒谎」并造成实际误判的案例。
- 证据：[行内 `文件:行号` 引用需要门禁](../.agents/notes/implemented/process/2026-10-22-inline-file-line-refs-need-a-gate.md)。

## 4. supersession 门禁不认参考式链接

`[文字][label]` 加定义行的写法，`tools/notes-supersession.mjs` 认不出，会当成「没有指向既有笔记」。

- **为什么不修**：认不出的方向是**少算**，也就是误拒合规笔记，不会放过不合规的；而支持它
  需要完整的 Markdown 引用解析。当前仓库没人用这种写法。
- **重访信号**：出现一次真实的误拒（有人用参考式链接写笔记被判红）。
- 证据：[supersession 检查](../.agents/notes/implemented/process/2026-10-18-notes-supersession-check.md)。

## 5. Markdown 标题锚点的 slug 规则没有独立门禁

`tools/md-links.mjs` 会跳过 `#anchor` 校验，所以「链接指向一个不存在的标题」查不出来。

- **为什么不修**：slug 规则（大小写、中文、标点、重复标题加后缀）没有权威规范可依赖，
  自己实现一套等于自定义一门方言。已记录的第三条路是「抓一次真实渲染结果当固定语料离线比对」，
  成本明确但还没到值得做的程度。
- **重访信号**：真出现锚点 404，或 GFM 规范给出可依赖的 slug 定义。
- 证据：[锚点 slug 门禁的第三条路（已知缺口）](../.agents/notes/proposed/process/2026-10-21-anchor-slug-gate-third-path-known-gap.md)。

## 6. npm 上的包仍是旧版本

`@iuuuuuuuu/agent-notes` 线上最新是 `0.6.0`，本仓库已到 `0.7.0` 且 GitHub 侧
（commit / tag / PR）已发布。

- **为什么不修**：`~/.npmrc` 里指向 `registry.npmjs.org` 的 token 已失效
  （`npm whoami --registry=https://registry.npmjs.org/` → `E401`）。这是凭据问题，不是工程问题；
  在拿到有效凭据前任何「发布脚本」都只是把失败挪个地方。
- **重访信号**：`npm login --registry=https://registry.npmjs.org/` 成功后
  `npm publish --registry=https://registry.npmjs.org/ --access public` 一次即可。
- 证据：[`.agents/notes/implemented/process/2026-10-20-npm-package-rename-to-scope.md`](../.agents/notes/implemented/process/2026-10-20-npm-package-rename-to-scope.md)。

## 7. 下游仓库是否把笔记门禁接进 CI，由各仓库自己决定

`tools/notes-coverage.mjs` 有 `--since <base-ref>`（基于 `merge-base` 只查本次 PR 自己的提交），
但**是否在某个下游仓库启用**不是本插件的决定：那取决于该仓库愿不愿意用一次全量补记来换取
此后每 PR 的机械检查。

- **为什么不替它决定**：接上第一天会扫出历史欠账，这件事必须由仓库所有者拍板；
  本插件只提供能接的口子，并把「接了会看到什么」写清楚。
- **重访信号**：下游仓库有人要求「笔记门禁接 CI」时，直接用 `--since origin/main`。
- 证据：[笔记覆盖门禁](../.agents/notes/implemented/process/2026-10-18-notes-coverage-gate.md)。
