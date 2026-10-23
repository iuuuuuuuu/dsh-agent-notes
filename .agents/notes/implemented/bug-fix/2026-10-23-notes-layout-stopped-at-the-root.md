# Agent Note: 笔记树的形状校验只查了根这一层

Status: implemented

- 日期：2026-10-23
- 适用：`lib/notes-layout.js`（`checkNotesLayout`）与它的用例 `tools/notes-layout.test.mjs`

## Problem

昨天补的「笔记根形状校验」（见
[2026-10-22-stray-notes-at-notes-root-are-invisible.md](./2026-10-22-stray-notes-at-notes-root-are-invisible.md)）
只 foreach 了 `readdirSync(notesRoot)` 的结果，**没有往下走一层**。于是同一族缺口在更深处原样存在：

| 塞进去的东西 | 补之前 | 补之后 |
|---|---|---|
| `.agents/notes/implemented/odd/2026-10-23-x.md` | 全绿 | `未知分类目录 implemented/odd/` |
| `.agents/notes/implemented/2026-10-23-loose.md` | 全绿 | `散落文件 implemented/2026-10-23-loose.md` |
| `.agents/notes/implemented/testing/scratch.txt` | 全绿 | `非笔记文件 …/scratch.txt` |
| `.agents/notes/implemented/testing/nested/x.md` | 全绿 | `多余的目录 …/nested/` |

机制完全一样：三条 vendored 门禁按 `{lifecycle}/{class}/` **枚举**找笔记，落在枚举路径之外的东西既不被归档、不被判违规、也不进 `ok: N note(s)` 计数。我在上一篇笔记里把「根这一层」当成了一整类问题的边界 —— 实际上它只是碰巧被看见的那一层。

同时暴露两个可用性问题：

1. `.gitkeep` 被判成「未知文件」。它是「空目录也要进 git」的唯一通用办法：一个刚建好、还没写笔记的 `proposed/feature/`，不放 `.gitkeep` 的话 clone 后就不存在了。判它红等于逼用户为了通过门禁去改 git 习惯。
2. `.DS_Store` / `Thumbs.db` / `._*`（macOS AppleDouble 伴生文件）报的是「未知文件 … 不会被任何门禁看见」。技术上没错，但对着系统自动生成的文件说这句话，用户不知道下一步干什么 —— 而「不知道该干什么」的报错，最后会被绕过（删门禁而不是删垃圾）。

## Decision

1. **往下一层走到底，但只判形状**：`implemented/` `proposed/` `rejected/` 的子项必须是六个 class 目录之一；每个 class 目录下只允许普通 `.md` 与 `.gitkeep`，不许子目录、不许符号链接、不许别的后缀。**不判文件名规则、不读内容** —— 那两件是 vendored 格式门禁的职责。
2. **`archived/` 内部仍由 `lib/archive-layout.js` 独占**，本模块明确跳过，并用一条用例钉住「本模块对它内部的垃圾不报错」，防止两个模块对同一件事产出两个真相。
3. **`.gitkeep` 在任何一层都放行**（`NOTE_IGNORED_FILES`），理由写在常量注释里：它不带内容、不进计数，用途就是让空目录进 git。
4. **系统垃圾文件给专门的一句话**：`NOTE_JUNK_FILES`（`.DS_Store`、`Thumbs.db`、`desktop.ini`）+ `._*` 前缀，报「加进 `.gitignore` 并删掉」。**只换提示，不放行**。

## Alternatives considered

**把 `.DS_Store` 加进白名单（CodeRabbit 原建议里有这一条）。** 最强的理由是「它是系统自动生成的，不是用户主动放进去的，判红等于惩罚 macOS 用户」。否掉的原因：门禁的判据是「仓库里有没有不该有的东西」，不是「谁放进去的」；白名单一旦开了这个口，下一步就是 `Thumbs.db`、`.idea/`、`*.swp`，而每一个都同样「不是我主动放的」。真要免打扰，正确位置是 `.gitignore`（git 层就不该跟踪它），门禁不该替 git 做这件事 —— 否则文件被跟踪进仓库、门禁还报绿。

**只判到 lifecycle 层（分类目录名），不管 class 目录里面的散件。** 最强的理由是散件影响小、判据越深越容易误伤（比如用户想放一张截图说明）。否掉的原因：误伤的边界用 `.gitkeep` 与 `.md` 已经划清了 —— 需要放别的文件，说明它不该在笔记树里；而「放一张截图」这类需求在笔记树里从来没有被支持过（vendored 门禁只认 `.md`）。

**把「文件名必须 `yyyy-mm-dd-主题.md`」也放进这一层。** 最强的理由是形状和命名本来就该一起判，用户能一次看到所有问题。否掉的原因：命名规则 vendored 格式门禁已经在判，两边都判就有两个真相 —— 一旦两边的口径漂移（比如一边允许 `.zh.md` 一边不允许），用户会看到互相矛盾的报错。这条在 `2026-10-22-single-form-matching-and-second-source-of-truth.md` 里已经付过学费。

**递归扫描整棵笔记树，任何深度都不许出现未知项。** 最强的理由是「一次到位，别再来一层」。否掉的原因：`archived/` 有自己的一套形状规则（分类目录、文件名日期、日历真实性、封印 schema，由 `lib/archive-layout.js` 管），无差别递归会把它的规则和本模块的规则混在一起；而且**真正需要判的深度是有限的**（`{lifecycle}/{class}/文件`），递归到任意深度是在判一个不存在的设计。

## Consequences

收益：

- 「散件隐形」这一族缺口在**已知的三个深度**上都关掉了（根、lifecycle、class），不再是「这次碰巧看了一层」。
- `.gitkeep` 放行之后，下游项目可以在还没写笔记的时候就把四个 lifecycle 目录建好并提交 —— 这是「开箱即用」的实际一步，而不是让人第一次用就去改门禁。
- 垃圾文件的报错从「不知道怎么办」变成「加进 .gitignore 并删掉」。
- `archived/` 的分工被一条用例钉住，以后谁想在这里加判据，会先看到「这是别人的活」。

代价与上限：

- **多了一层 `readdirSync` 遍历**（每篇笔记的目录各一次）。实测对当前 111 篇笔记的树仍是毫秒级，但这是随目录数线性增长的。
- **不判内容**：`.md` 里写了什么都不管，一个空文件也能过这一层（由格式门禁拦）。这是刻意的分工，代价是「这道门禁单独看很弱」。
- **`.gitkeep` 放行意味着一个只有 `.gitkeep` 的 class 目录算合规**。如果一个项目把所有笔记都放错层，只剩 `.gitkeep`，本模块不会报错，只能靠 vendored 门禁的 `ok: N note(s)` 计数和覆盖门禁兜。这是为了「空目录合法」必须付的代价。
- **`._*` 前缀判据可能误伤**：真有用户把笔记命名为 `._something.md` 会被判成垃圾文件。出现这种命名时改成更精确的判据（AppleDouble 的文件名恒为 `._` + 原名）。

## Verification

- `node --test tools/notes-layout.test.mjs` → **30 tests / 30 pass**（原 20 条 + 新增 10 条）。
- 真仓库不因新判据变红：`checkNotesLayout({ notesRoot: '.agents/notes' })` → `errors: 0`。
- 三次真故障注入（备份 → 变异 → 跑 → 还原 → `cmp` 逐字节确认，`grep -c MUTANT` = 0）：

  | 变异 | 结果 |
  |---|---|
  | 跳过 class 目录层的全部检查（`checkClassDir` 调用注释掉） | 26 pass / **4 fail**（未知分类目录、非笔记文件、嵌套目录、垃圾文件 class 层） |
  | 根层垃圾文件退回通用「未知文件」提示 | 29 pass / **1 fail** |
  | `.gitkeep` 不再放行（`NOTE_IGNORED_FILES` 置空） | 29 pass / **1 fail** |

- **未做**：没有验证「符号链接建在 class 目录里」这一条 —— Windows 未开开发者模式时建不了链接，用例里 `symlinkSync` 抛错就 `return`（跳过而不是假绿）。这条判据在真实 Windows 环境上**没有被执行过**，只在代码里存在。
