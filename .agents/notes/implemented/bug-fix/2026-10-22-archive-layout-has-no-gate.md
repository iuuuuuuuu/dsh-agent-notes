# Agent Note: 归档树布局、归档日期与封印清单 schema 原本没有任何门禁

Status: implemented

本篇补齐[归档路径验证](../testing/2026-10-19-client-bundle-and-archive-paths-verified.md)与[归档基线失败关闭](../bug-fix/2026-10-21-archive-baseline-fails-closed.md)都没有覆盖的第三个层面：那两篇分别管「路径可达」与「Git 历史里封印只增不改」，而归档树**长什么样、归档日期写没写对、封印清单本身合不合规**此前无人过问。

## Problem

本仓库的归档门禁有两层。插件自有 `lib/notes.js` 在执行受管脚本前校验 Git 基线，保证历史封印只增不改；受管的 `skills/agent-notes/scripts/verify-archived-agent-notes.ts` 校验头块五行布局、磁盘封印哈希、以及封印条目有对应文件。

两层之间有一整类判据谁都不管。真实临时仓库回归证明，以下六种归档树全部 `passed: true`、`exitCode: 0`：

1. 归档根目录下多出散落文件（`archived/stray.md`）；
2. 归档根下出现未知分类目录（不在 `feature`/`bug-fix`/`simplification`/`architecture`/`process`/`testing` 内）；
3. 分类目录内再套一层子目录；
4. 归档文件名缺 `yyyy-mm-dd-` 前缀；
5. `Archived:` 行写成日历上不存在的日期（`2026-13-45`）——受管脚本用 `\d{4}-\d{2}-\d{2}` 正则放行；
6. 封印清单 `archived/manifest.json` 的字段、版本号、哈希格式、键路径全都无约束——受管脚本只做 `JSON.parse`。

同一批回归还暴露一条更隐蔽的：受管脚本在扫描语料时**显式跳过** `.zh.md`（`!entry.name.endsWith(".zh.md")`），于是旁挂的 `*.zh.md` 既不进语料、也不受封印清单管辖，删掉或篡改它都不会被任何一层门禁发现。

上游 A 在 `scripts/verify-archived-agent-notes.ts` 与 `scripts/archived-agent-notes.ts` 里判了其中大部分：归档根只允许 `AGENTS.md` 与 `manifest.json`、分类目录内只允许普通文件、文件名日期形状、归档日期日历真实性、归档日期不得早于文件名日期、清单 schema 封闭。本仓库这一整类判据缺失。

## Decision

插件新增自有模块 `lib/archive-layout.js`，在归档门禁进入 Git 基线校验**之前**先跑形状检查：形状坏了就是坏了，不该先花一次 Git 子进程调用。

`lib/archive-layout.js` 判据：

- 归档根目录只允许 `AGENTS.md`、`manifest.json` 与六个分类目录，其余根文件与未知分类目录均判失败；
- 分类目录内只允许普通文件，套一层目录判失败；
- 文件名须匹配 `^(\d{4})-(\d{2})-(\d{2})-.+\.(md|zh\.md)$`；
- `Archived:` 行的日期须是**真实存在的日历日期**（用 `new Date(Date.UTC(...))` 回读比对，不接受 `2026-13-45` 这类正则放行的形状），且不得早于文件名日期；
- 封印清单 schema 是封闭的：字段只能是 `files` 与 `version`、`version` 必须是 `1`、`files` 必须是对象、每个封印须匹配 `^sha256:[0-9a-f]{64}$`、每个键须以 `archived/` 开头；
- 旁挂的 `*.zh.md` 允许存在，但**必须被清单封印**——不封印判失败。

`lib/notes.js` 把 `checkArchiveLayout({ notesRoot })` 接到 `runGate('archived')` 的最前面，返回 `reason: ARCHIVE_LAYOUT: 归档树不合规（N 项）` 与逐条 `archived: …` 错误行。

刻意保留的差异有五处，写在 `lib/archive-layout.js` 的文件头注释里：

1. **不要求双语三元组**（`topic.md` + `topic.zh.md` + `topic.i18n.yaml`）。上游 A 要求，本仓库的笔记树本就不要求双语。
2. **不要求六个分类目录齐全**。上游 A 要求齐全；本仓库的下游工作区（如 `sourin-flutter-spike`）只归档了 `process/` 一类，强制六个目录会误判一个合法归档。
3. **允许 `archived/AGENTS.md` 存在**，不为它单独要求六目录齐全。
4. **旁挂 `.zh.md` 从「不受管辖」翻成「必须被封印」**：从完全不管到有明确归属，是收紧。
5. **不改受管技能**，只在插件自有 `lib/` 落实现，避免破坏受管内容哈希与同步边界。

`Archived:` 那行只在第 3 行确实是 `Status: implemented` 时才判——否则受管脚本会报得更准，同一问题不出现两个真相。反向对账（清单封了但磁盘无文件）刻意不做，受管脚本已有同口径判据。

## Alternatives considered

- **直接改受管的 `verify-archived-agent-notes.ts`**：逻辑集中、最接近上游实现，六类判据一次补齐，不用维护两份归档规则；但会破坏受管内容哈希，`tools/verify-plugin.mjs` 的哈希比对会立刻拦下，且 `tools/sync-upstream.mjs` 下次同步会把手改冲掉——每次同步都要重打一遍补丁。被否，改为在插件自有包装层补齐判据。
- **在受管脚本之外再加一道独立的门禁脚本（如 `tools/archive-layout.mjs`）**：与 `lib/notes.js` 分离、职责更清晰；但归档判据必须知道笔记根、必须与受管脚本看到同一棵树，独立脚本会多一份「笔记根从哪来」的口径，且归档门禁的失败信息要分两处输出。被否，改为 `lib/notes.js` 内的一段前置校验，失败直接并入同一次门禁输出。
- **把六类判据做成一条「归档必须形状完美」的严格门禁（要求六目录齐全 + 双语三元组）**：判据最齐，与上游 A 完全同构；但对本仓库的真实用法会误判——只归档一类的笔记树会被判红，教人加 `--no-verify` 绕过。被否，改为「上游判据减去本仓库不适用的两类」。
- **只补「归档根目录只允许两个文件」这一条最明显的缺口**：改动最小，能挡掉散落文件；但根目录与分类目录是一体的，只挡一半会留下「分类目录里套子目录」「日期不存在」这类同样静默通过的判据，等于给假绿开一半的口子。被否，整类一起补，每类都有对应回归。
- **把「旁挂 `.zh.md` 必须被封印」改成「旁挂 `.zh.md` 一律判失败」**：判据更简单；但双语笔记的英文侧是主笔记、中文侧是旁挂，判死等于禁止双语归档，与本仓库的实际做法冲突。被否，改为「必须被封印」，把不管变成有归属。
- **在清单 schema 上要求哈希覆盖所有归档文件（包括未被受管脚本扫描的 `.zh.md`）**：更彻底；但那等于改变受管脚本的封印语义（受管脚本的语料显式排除 `.zh.md`），会让清单与受管脚本的语料口径不一致。受否，改为只要求「若存在旁挂 `.zh.md`，则清单必须封它」，不强制所有归档文件都在清单里。

## Consequences

收益是六类原本静默通过的归档树现在会红：散落文件、未知分类目录、嵌套子目录、缺日期文件名、假日历日期、坏清单 schema，以及**不被任何一层管辖的旁挂 `.zh.md`**。这些判据全部落在插件自有代码，受管技能保持原样，`tools/verify-plugin.mjs` 的受管哈希比对不受影响。

代价是归档门禁多一层判据、两种失败信息可能同时出现（形状不对时根本走不到受管脚本，所以实际上形状错误会**掩盖**受管脚本的其它错误——这是有意的短路，但排障时先看到的不是最内层原因）。另外，形状判据是**字面**的：它认得 `Archived:` 这一行的位置与格式，笔记若改用别的写法（例如放进 front matter）会被判失败；这是已知边界，尚未支持 front matter 形式。

回归覆盖 16 条情形（7 条负例 + 2 条正例 + `archived/AGENTS.md` 允许存在 + 4 条清单 schema 负例 + 日历真实性单测 + 归档目录不存在返回空错误），但尚未覆盖：清单里同时存在合法键与非法键时的部分放行、`.zh.md` 旁挂多个文件时的逐个封印、归档文件名含路径分隔符的形态、以及 `Archived:` 写在 front matter 里的形态。

## Verification

`node --test tools/archive-layout.test.mjs` → **16 tests / 16 pass / 0 fail**，退出码 0。

**故障注入（真红，三次，每次还原后复跑全绿）**：

1. 把 `lib/archive-layout.js` 的 `if (!isRealDate(Number(year), Number(month), Number(day)))` 改成 `if (false)` → **15 pass / 1 fail**，红的正是「归档日期不是真实日期必须失败」；还原后 16/16。
2. 把 `if (!ARCHIVE_CLASSES.includes(entry.name))` 改成 `if (false)` → **15 pass / 1 fail**，红的正是「未知分类目录必须失败」；还原后 16/16。
3. 把 `lib/notes.js:589` 的 `const layout = checkArchiveLayout({ notesRoot });` 改成 `const layout = { errors: [] };`（整条前置校验失效）→ **7 pass / 9 fail**；还原后 16/16。

三次注入都用 Python 字节级写入（`newline=''`），避免 Windows 上把 LF 翻成 CRLF；每次还原后用 `diff` 与备份逐字比对确认一致，再复跑用例。

随后 `node tools/verify-notes.mjs` → 三条全 `exit=0`（tree 92 note(s)、format 92 note(s)、archived `ok: 1 archived note(s) verified, 1 seal(s) in manifest`），共 93 篇笔记；`node tools/fault-injection.mjs` → 退出码 0，末尾「磁盘上 41 个测试文件全部登记，无遗漏」；`node tools/verify-plugin.mjs` → 退出码 0（「上游清单比对: 21 个文件一致」）。

**加了形状校验之后被它抓出来的一处真问题**：`lib/notes.js` 现在静态 import `./archive-layout.js`，
于是 `tools/verify-notes-standalone.test.mjs` 的沙箱（原本只把 `lib/notes.js` 一个文件拷进去）
在**模块解析阶段**就炸成 `ERR_MODULE_NOT_FOUND` —— 走不到「门禁脚本缺失」那条判据，
整条用例测的变成了「模块没拷全」。这暴露了两件事，都已修：

1. `lib/notes.js` 会 import 同目录的兄弟模块，只拷一个文件根本跑不起来 ——
   而 README 承诺的用法一直是 `cp -r dsh-agent-notes/lib`（**整个目录**）。
   沙箱改成拷整个 `lib/` 目录，与承诺一致。
2. `tools/verify-notes.mjs` 的 `loadGateRunner()` 之前把 `import` 失败原样抛出，
   用户只看到一句 Node 的模块解析错误，看不出「该拷什么」。现在捕获每个候选的
   加载失败，最后连同「该拷整个 lib 目录」一起报出来，退出码仍是 2（无法进行）。

另有一处**夹具失真**被全量 `npm run check` 抓出来：`tools/archive-baseline.test.mjs`
的历史清单夹具原本用随手编的假值（`"seal-a"` / 键 `testing/old.md`）。加了形状校验后，
**当前**清单的 schema 判据先判红，基线比对那一层根本没跑到，用例却还在等
`Archived seal changed or removed` —— 变成一个测不到目标机制的红。夹具改成
schema 合法的形态（键 `archived/testing/2026-01-01-old.md`、封印
`sha256:` + 64 位十六进制），于是每条用例测的又是它自己该测的那一层。

最终 `GIT_SSL_BACKEND=openssl npm run check` → 退出码 0（487 tests / 486 pass / 0 fail；
末尾「故障注入全部通过」与「磁盘上 41 个测试文件全部登记，无遗漏」）。

这些是离线回归结果，不是实机验证、也不是上游对齐已完成的结论。
