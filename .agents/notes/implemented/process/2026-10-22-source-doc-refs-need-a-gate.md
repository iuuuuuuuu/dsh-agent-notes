# Agent Note: 源码里引用的文档路径也要有门禁

Status: implemented

> 承接 [笔记正文的行内引用也进门禁了](./2026-10-22-note-refs-join-the-gate.md)：
> 那篇把**文档侧**语料从 `docs/` 扩到 `.agents/notes/**`，判据是行内 `文件:行号`。
> 本篇补的是**源码侧**——同一道门禁里另一个方向：代码注释里写的文档路径。

## Problem

`tools/doc-refs.mjs` 原本只管「文档正文里的行内 `文件:行号` 引用」，方向是
**文档 → 源码**。反向的一类引用从来没人管：**源码里写的文档路径**。

这类引用在本仓库真实存在，而且密度不小：

```
tools/markdown-links.mjs:26      引 docs/ 与笔记树
tools/md-links.mjs:25            同上
tools/notes-supersession.mjs:7   引 .agents/notes/AGENTS.md 说明规则来源
tools/verify-plugin.mjs          引 README.md / package.json 的具体位置
```

它们与 `文件:行号` 引用是同一类东西：**写了就会漂**。`tools/md-links.mjs:26`
写的 `docs/` 路径一旦被重命名，那行注释就指向一个不存在的地方，而没有任何门禁
会说话——因为它既不是 Markdown 链接（mdast 的 link 节点里看不到），也不在
`docs/` 语料里（它住在 `tools/`）。

上游 A 的 `scripts/verify-doc-refs.ts:28-29` 判的正是这件事：扫仓库自有
TypeScript，把正文里形如 `docs/…md` / `.agents/notes/…md` 的**字面路径**
拿出来，逐个 `existsSync` 判存在。本仓库没有 `packages/`，但等价物明确存在。

## Decision

`tools/doc-refs.mjs` 新增源码侧扫描，判据与上游同口径：

- 扫描目录 `tools`、`lib`、`src`、`.github/workflows`（上游是 `packages/**/*.ts`，
  本仓库没有 `packages/`，这四棵是仓库自有的源码树）；
- 路径形态 `(?:\bdocs|\.agents\/notes)\/[A-Za-z0-9._/-]+\.md`（与上游
  `verify-doc-refs.ts:25` 逐字相同），**必须带 `.md` 扩展名**，只认字面路径，
  不解析字符串拼接；
- 命中即判：目标必须存在且**是文件**（是目录也算红）；
- 白名单 `SOURCE_EXTERNAL_REFS` 按 `源码文件::路径` 粒度，逐条必须有理由，
  且**必须真的被该文件命中一次**——从未命中的死条目判红。

排除三类文件：`*.test.mjs`（测试夹具里故意引用不存在的路径来证明门禁会红，
扫它们等于拿测试数据当仓库语料）、`lib/client.js`（`build.mjs` 从
`src/client.js` 生成的产物，扫两遍等于把同一条引用计两次）、`skills/**`
（受管上游副本，路径描述的是上游自己的结构）。

白名单用**文件级**而不是路径级粒度：`.agents/notes/AGENTS.md` 这个名字本仓库
将来可能真的补上（`docs/upstream-46-gates.md` 的 P3 行记着「未落地」），
路径级白名单一旦碰上就变成永不触发的死规则，而真正该红的引用反而被放过。

空集合一律红：没扫到源码文件、或扫到了但一条文档路径引用都没有，都判失败——
与 `tools/verify-notes.mjs`、文档侧同口径。

## Alternatives considered

- **只判「路径存在」，不判「是文件」** —— 与上游 `verify-doc-refs.ts:29` 完全同形
  （上游只 `existsSync`）。**否掉因为**目录也能 `existsSync` 通过，于是
  `docs/` 这种目录名会被当成合法引用放行；而文档侧那道门禁**已经**判目录
  （`tools/doc-refs.mjs` 文档侧的 `statSync(target).isFile()`），两侧口径不一致
  会让同一类错误在两处得到不同答案。
- **不设白名单，靠扩大前缀排除来解决上游引用** —— 少一张表要维护。**否掉因为**
  本仓库源码里确实有**指向本仓真实路径**的引用（`tools/notes-supersession.mjs`
  引 `.agents/notes/AGENTS.md` 说明规则来源，那条路径本仓确实不存在，但
  `tools/doc-refs.mjs` 自己在讲历史时也引它），前缀排除会把「本仓将来补上同名
  文件」这种情况永久放过。文件级白名单能在两种情形下都判对。
- **把源码侧语料做成「全仓 `.js`/`.mjs`/`.ts`」而不是固定四棵目录** —— 覆盖面更大，
  新增目录不会漏。**否掉因为**固定目录是**可核对的**：本仓库的源码树就是这四棵，
  写死在代码里比 glob 猜测更接近事实；而且 `skills/` 与 `tools/*.test.mjs` 本来就
  要排除，glob 只会让「扫到了什么」变成一件每次都要重算的事。
- **把源码侧判据拆成独立脚本 `tools/source-doc-refs.mjs`** —— 职责更单一。
  **否掉因为**判据、语料、失败格式与文档侧完全同源，拆开会产生两份几乎一样的
  遍历与白名单逻辑，而它们要防的是同一类漂移；合成一道门禁后「一次跑完、
  一次说清哪里错了」比「两个脚本各说各的」更有用。
- **用 TS AST 解析而不是正则抽字面路径** —— 上游用的就是 `findReferenceViolations`
  （`verify-doc-refs.ts:29`），能定位到具体 AST 节点。**否掉因为**本仓库零
  TypeScript 工具链（无 `typescript` 依赖、无 `tsconfig`），引入它违反
  `AGENTS.md` 硬约束 1；而且判据本身只是「字面路径存在性」，正则足够 ——
  上游的正则 `DOC_REF`（`:25`）也正是字面 token 匹配。

## Consequences

收益：源码注释里的文档路径漂移从「靠人眼」变成「exit 1」。当前实测
`42 个文件、21 条文档路径引用全部可解析`（`node tools/doc-refs.mjs`；文档数与行内引用数会随笔记增删变动，复核请自己跑）。
白名单的两条防腐（理由非空 + 必须命中）保证它不会退化成一张永不触发的表。

代价与已知边界：

- 白名单 `SOURCE_EXTERNAL_REFS` 是**第三份**白名单（另两份是文档侧的
  `EXTERNAL_REFS` 与 `tools/verify-plugin.mjs` 的 `RUNTIME_ARTIFACTS`）。三份各自
  防腐、互不知道；将来要加第四份时该考虑合并。
- 判据只认**字面**路径 token。源码里若用模板拼接出路径（`` `${dir}/x.md` ``），
  门禁看不见——这是上游同款限制。
- 判据只判「存在且是文件」，**不判「指的是不是那篇文档该说的内容」**。
  路径存在但内容早已改写，门禁无感。
- 源码侧引用**不进**文档侧的 `文件:行号` 校验：两者是不同形态的引用
  （下面第一行是源码侧认的形态，第二行是文档侧认的形态），前者不校验行号。

  ```
  docs/x.md
  docs/x.md:12
  ```
- 扫描目录是四棵固定目录；`scripts/`、`apps/` 这类在本仓库不存在的目录
  不扫，本仓也不该有它们。

## Verification

```sh
node tools/doc-refs.mjs
# 行内引用校验通过：96 个文档、73 条 `文件:行号` 引用全部可解析；
# 源码侧 42 个文件、21 条文档路径引用全部可解析。              (exit 0)

node --test tools/doc-refs.test.mjs
# tests 26 / pass 26 / fail 0                                    (exit 0)
```

26 条用例里源码侧占 8 条：存在即绿、缺失必红、白名单按文件粒度生效、
白名单缺理由必红、白名单死条目必红、源码侧空语料必红、
扫到文件但零引用必红、测试文件与生成产物被排除。

**真故障注入**：把 `tools/doc-refs.mjs` 源码侧的存在性判定
`if (!existsSync(target))` 改成 `if (false)` → **24 pass / 2 fail**，红的正是
「源码里引用的文档不存在必须红」与「源码侧白名单必须按文件粒度生效」；
`cp` 还原后 `diff` 逐字比对确认一致，复跑 **26/26** 绿。

**本轮修掉的两个真缺陷**（都是这条门禁自己的用例抓出来的，不是猜的）：

1. `collectSourceScanFiles` 的 `walk` 里 `readdirSync(rel)` 传的是**相对路径**，
   会按当前工作目录解析而不是仓库根 —— 于是 `root` 指向临时目录的用例实际扫的
   是 CWD 下的 `tools/`，在 CWD 没有该目录时直接抛 `ENOENT`。改成
   `readdirSync(join(root, rel))`。
2. 源码侧白名单的「死条目」判定在**夹具仓库**里会误报：夹具没有本仓那五条
   上游引用，于是全被判成死条目。修法是让 `verifySourceDocRefs` 接受
   `sourceExternalRefs` 覆盖参数，夹具显式传 `{}`；真仓库仍用默认表。

这两个缺陷说明：**一条门禁自己也要有真用例**，否则「它会红」这件事从未被验证过。
