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

## 8. 归档树判据是字面的，不认 front matter

`lib/archive-layout.js` 认 `Archived:` 必须在**第 4 行**、第 3 行是 `Status: implemented`。
笔记若把归档元数据改放进 front matter（例如 `archived: 2026-10-22`），
这套判据会判失败 —— 措辞是「布局不对」而不是「格式没被支持」。

- **为什么不修**：本仓库的归档块形状是 vendored 脚本定下的（头块五行布局），
  front matter 形式的归档需要先改受管脚本的形状约定，那属于改上游。
- **重访信号**：真有人用 front matter 写归档笔记。那时先把 vendored 的头块判据
  与 `lib/archive-layout.js` 一起改，并补一条「两种形状都接受」的回归。
- 证据：[归档树布局、归档日期与封印清单 schema 原本没有任何门禁](../.agents/notes/implemented/bug-fix/2026-10-22-archive-layout-has-no-gate.md)。

## 9. 源码侧文档引用只认字面路径 token

`tools/doc-refs.mjs` 的源码侧判据用正则抽 `docs/…md` / `.agents/notes/…md`
的**字面** token。源码里若用模板拼接出路径（`` `${dir}/x.md` ``），门禁看不见。

- **为什么不修**：与上游同款限制 —— 上游 `verify-doc-refs.ts:25` 也是字面 token 匹配。
  要支持拼接就得引入 TS AST 解析，违反「零 `@deepseek-ai/*` 依赖」与「本仓库零
  TypeScript 工具链」两条硬约束。
- **重访信号**：本仓库源码里真的开始用拼接拼文档路径时。
- 证据：[源码里引用的文档路径也要有门禁](../.agents/notes/implemented/process/2026-10-22-source-doc-refs-need-a-gate.md)。

## 10. 三份白名单各自防腐、互不知道

`tools/doc-refs.mjs` 的 `EXTERNAL_REFS`（文档侧）、`SOURCE_EXTERNAL_REFS`（源码侧）、
`tools/verify-plugin.mjs` 的 `RUNTIME_ARTIFACTS`（豁免名单）三张表各自防腐
（理由非空 + 必须被命中），但**互不知情**：一条路径在 A 表里被放行，B 表照样会红。

- **为什么不修**：合并三张表会把「文档侧/源码侧/包内产物」三种语义不同的豁免
  挤进一个键空间，键的形状就不再唯一。当前三张表各自边界清楚，
  代价是要在三个地方维护同一件事。
- **重访信号**：出现第四张白名单，或同一路径在三张表里都出现（那时合并的收益就具体了）。
- 证据：[源码里引用的文档路径也要有门禁](../.agents/notes/implemented/process/2026-10-22-source-doc-refs-need-a-gate.md)。

## 11. `.gitattributes` 的 `eol=lf` 没有任何断言

`.gitattributes` 里写着 `* text=auto eol=lf`。这一行的存在意义是**vendored 内容按
SHA-256 记账** —— 换行一旦被 Git 转成 CRLF，vendored 哈希就与上游清单对不上。
但删掉 `eol=lf` 之后，`npm run check` **整链 exit 0**：没有门禁断言这个约定。

- **为什么不修**：判据本身只有一行（首行必须含 `eol=lf`），成本几乎为零；
  否掉的理由是**误报真实存在** —— Windows 上有人故意把本仓库切成
  `eol=crlf` 是可能的本地配置（那样 vendored 哈希在本地必然对不上，
  但那是个人配置问题，不该由门禁在别人的仓库里报红）。
  换句话说：这条判据会把「个人配置」误判成「仓库被改坏」。
  代价对比：不对称的 —— 少查一件东西不会有人来道谢，多判一次会有人来骂。
- **重访信号**：真的发生过一次「换行导致 vendored 哈希对不上」而排查耗时很久
  （那时值得让门禁提前一步报「是换行问题」）。
- 证据：[vendored 完整性门禁不再信任自己](../.agents/notes/implemented/process/2026-10-21-vendored-integrity-gate-stops-trusting-itself.md)。

## 12. 孤儿文件不可机械判定

三类东西现在都没有门禁：根目录下没人 import 的 `.mjs`（如 `build.mjs` 本身）、
`docs/` 下没人引用的文档、`lib/` 下没人 import 的新模块。实测三种都全链 exit 0。

- **为什么不修**：「什么算孤儿」没有可机械判定的答案：根目录的 `build.mjs`
  正是「没人 import 但必需」的；`lib/` 的模块里有靠**字符串路径动态加载**的
  （`lib/skill.js`、`lib/notes.js` 都按路径拼），静态 import 图根本看不到它们。
  硬判必然误报，而误报的门禁会被绕过 —— 那比不判更糟。
  可行的替代形态是「只对**新增**文件提示」（像 `tools/fault-injection.mjs`
  对未登记测试文件那样），但那是提醒不是门禁，且提醒的噪声比价值大。
- **重访信号**：`lib/` 全部改成静态 import（那时 import 图就是完整依赖图，
  孤儿判定立刻变可机械）—— 本仓库的模块加载形态目前不会变。
- 证据：[门禁自证：声明表与磁盘双向对账](../.agents/notes/implemented/process/2026-10-21-fault-injection-list-must-reconcile-with-disk.md)。

## 13. `engines` 与 `LICENSE` 正文都没有门禁

`package.json` 的 `engines.node` 写成 `">=999"` 全链 exit 0；`LICENSE` 正文
被整体替换成别的文本也全链 exit 0（门禁判的是 `package.json` 的 `license === "MIT"`
字段，不是正文）。

- **为什么不修**：这两条判据**能**机械写出来，但判的东西价值很低。
  `engines` 是给 npm 装包时的**提示**，不是约束 —— 装出来的包在 Node 20 上
  大概率也能跑；而本仓库真正的 Node 版本约束是「需要 `node --test` 的
  `describe`/`it` 与 `mock` API」，那需要运行时探测而不是读字段。
  `LICENSE` 正文同理：本仓库的 LICENSE 是 MIT 全文，**上游 A 的门禁也不判正文**
  （上游 `verify-package-meta.ts` 只查 `license` 字段），判正文等于把法律文本
  的每次微调都变成 CI 失败。
- **重访信号**：真出现「在不支持的 Node 版本上装上去了而且坏了」，
  那时该加的是**运行时能力探测**（装包时或启动时）而不是 `engines` 字段断言。
- 证据：[发布清单与产物必须自洽](../.agents/notes/implemented/process/2026-10-22-publish-layout-files-and-exports-must-agree.md)。

## 14. 门禁脚本自身的 `process.exit(1)` 改成 `0` 无人拦

实测把 `tools/notices.mjs` 的 `process.exit(1)` 改成 `process.exit(0)` →
**完整链 exit 0**。`tools/fault-injection.mjs` 覆盖的是「测试文件的故障注入
有无登记」，它不覆盖「门禁脚本自己的退出码被改」。

- **为什么不修**：要判这件事，得为**每道**门禁造一个「已知坏输入」并断言它
  必然非零退出。这有两层问题：其一，输入构造本身可能误报 —— 某道门禁在某个
  输入下**合法地**返回 0（例如「没有需要检查的东西」在空仓库里就该是 0），
  断言会变成假红；其二，坏输入要**复刻**门禁的前置条件（很多门禁要求特定目录
  结构、特定语料），复刻得越像真的，测试越像在测夹具而不是门禁。
  最小形态（只对 `tools/notices.mjs` 一道做坏输入必红断言）可以做，但它证明的
  范围极窄，容易给人「这一族已经防住了」的错觉 —— 而错觉比缺口本身更危险。
  真正能防住这个族的形态是**在 CI 里统计每道门禁的执行次数**（跑过几次），
  那是另一套基础设施。
- **重访信号**：真发生一次「门禁的退出码被手滑改掉，且没人发现」——
  那时优先做的不是逐道造坏输入，而是先把「门禁跑了几次」变成可观测的事实。
- 证据：[门禁自证：声明表与磁盘双向对账](../.agents/notes/implemented/process/2026-10-21-fault-injection-list-must-reconcile-with-disk.md)。
