# Agent Note: vendored 完整性门禁不再自己给自己发证

Status: implemented

## Problem

`tools/verify-plugin.mjs` 的 vendored 哈希比对一直在跑，也确实拦过手改，
但它的判据有四个结构性漏洞，四个都不是「算错了哈希」，而是**问错了问题**：

1. **清单是自我信任根。** `tools/upstream-manifest.json` 自己写着 `ref`，
   而全仓库没有任何代码读过 `upstream.json`（人工维护的意图声明）。两者
   分歧时没人会红：清单已经不代表那个上游快照，门禁却照样报「21 个文件一致」。
2. **只做 manifest → 磁盘的单向比对。** 磁盘上多出来的文件永远不会被报。
   手拷一个上游文件进来，或者上游删了而本地留着，该文件从此**不受哈希管辖**——
   而门禁的绿灯恰好说明「清单里的都对」，这句话为真却完全没回答问题。
3. **`lib/` 只扫一层 `lib/*.js`。** 模块一旦挪进 `lib/sub/`，那个文件对门禁
   就是隐形的。
4. **只认 `from '…'` 一种引用形态。** 副作用 `import 'x'`、动态 `import('x')`、
   CommonJS `require('x')` 全都不查——而这三者恰恰是最不容易被肉眼发现的。

另外 `package.json` 里有个 `upstreamCommit: 0e8200c0…`：**零个代码读者**，
而且既不是 vendored 上游 B 的 ref，也不是本插件自己的版本。两个「上游」概念
（A = deepseek-harness，B = vendored 技能）被一个死字段搅在一起。

## Decision

`tools/verify-plugin.mjs` 现在做七件原来不做的事，全部走真实失败路径：

- **意图声明对账**：`upstream.json.ref` 与 `upstream-manifest.json.ref` 必须相等，
  `fileCount` 与清单条目数必须相等。清单是推导产物，`upstream.json` 是人对
  「当前代表哪个快照」的声明；两者分歧即红。
- **清单外文件检测**：递归遍历 `skills/agent-notes/`，凡不在清单里的文件都报出来。
  唯一显式放行的是运行期标记 `.synced-version`（`lib/self-update.js` 写、被
  `.gitignore` 忽略，从来不是上游内容）。放行写成一个具名常量 `RUNTIME_ARTIFACTS`，
  不是「凡是点文件都放过」。
- **递归扫描 `lib/`**：`collectFiles(dir, accept)` 取代单层 `readdirSync`。
- **四种引用形态**：静态 `from`、副作用 `import`、动态 `import()`、`require()`，
  结果去重后一并报出。
- **依赖字段补 `optionalDependencies`**：它同样会被安装器写进 profile，是运行时
  依赖；`devDependencies` 仍不查（不进安装产物，查了会把 `spdx-expression-parse`
  这种合法工具链依赖误报成违规）。
- **随包配置不得内联取值**：`cordis.patch.yml` 会随包发布并被宿主直接加载，
  查 `!!js` 表达式与 `process.env` 读取。这条对应上游 `verify-config-source-ownership`：
  上游扫的是 `apps/*/config/**/*.yml`、`packages/*/*/cordis.patch.yml` 等 glob，
  本仓库一条都不匹配（只有仓库根一份手写 patch），所以只查这一份文件，不搬 glob。
  **口径比上游更宽**：上游只禁 `apiKey`/`baseURL`/`apiKeyEnv`/`authToken`/`headers`
  五个字段上的 `!!js` 值（`verify-config-source-ownership.ts:23-38`），这里禁的是
  整份 patch 里的任何 `!!js` 与 `process.env`。理由是本地这份 patch 只需要静态值，
  「哪个字段算凭据」这件事本身没有可机械判定的边界 —— 但这也意味着：将来真需要
  `!!js` 时得先改这条检查，而不是绕过去。

- **豁免名单自己也要被检查**：`.synced-version` 那条放行从 `Set` 改成「名字 → 理由」
  映射，并对每个条目要求两件事——理由非空、名字在 `lib/` 源码里**真的有写者**。
  只写 `new Set([...])` 的话，等到 `lib/self-update.js` 哪天不再写这个文件，这条豁免
  仍然会永久静默地放行同名脏文件，而没有任何门禁会提醒。这个做法直接来自上游
  `verify-package-readme-limitations.ts:24,34-45`：`NO_LIMITATIONS` 白名单的条目必须
  命中一个被扫到的包、理由必须非空，否则报「renamed or removed? update …」。

失败信息里的路径统一归一成 `/`：Windows 上 `relative()` 给反斜杠，同一处缺陷
在两个平台打出两种文本，人肉比对和断言都会因此打架。

同时删掉 `package.json` 的 `upstreamCommit` 死字段——它没有任何读者，留着只会
让人以为「上游已固定在这个 commit」，而真正被固定的 ref 在 `upstream.json`。

十一条故障注入写进 `tools/verify-plugin.test.mjs`（真拷副本、真跑子进程、读退出码）：
optionalDependencies 藏依赖、动态 `import()`、`lib/sub/` 里的 `require()`、
清单外多一个文件、`upstream.json.ref` 被改、`.synced-version` 不得被误伤、
patch 里内联 `!!js`、patch 里读 `process.env`、白名单条目没理由、
白名单条目在 `lib/` 里没有写者，加上原有的绿基线。19/19 通过，且每条都是先改坏
再验证真的红了。

## Alternatives considered

**改成「每次自检都去查远端 HEAD」**（这是最直觉的做法：ref 是否最新由远端说了算）。
它最强的理由是它直接消灭「清单自我授权」——谁也不用相信本地任何声明。否掉是因为
它把纯本地门禁变成联网门禁：本机实测 schannel TLS 全断时 `sync:check` 会 `exit 2`，
而 `npm run check` 的契约是「不需 DSH、不需网络、提交后就能跑」。为了一个一周才变一次
的 ref 引入一个能整体拖红本地检查的网络依赖，代价明显高于收益。所以只做本地可判定的
一致性对账，远端核对留给 `npm run sync:check`。

**把 `skills/agent-notes/` 下所有点文件都算合法**（`.synced-version` 是点文件，顺手
就能写成 `!name.startsWith('.')`）。理由是这样以后再加运行期标记不用改代码。否掉是
因为那等于给「清单外文件」开一个可命名的洞：任何 `.foo` 都能绕过哈希管辖，而漏检
正是这条检查要消灭的东西。具名白名单改起来只多一行。

**保留 `upstreamCommit`，改成写当前 vendored ref。** 理由是这样不用删字段，兼容
「可能有人读过它」。否掉：实测全仓库零读者，为不存在的读者维护一个与
`upstream.json.ref` 重复的真相源，正是这个仓库反复踩的「两个真相源」坑。

## Consequences

- 收益：vendored 完整性从「清单说什么就是什么」变成「清单必须与意图声明一致，且磁盘
  上不许有清单外的东西，豁免自己也要有理由和有写者」。六类真实缺陷（漏字段、漏形态、
  漏目录、漏方向、随包配置内联取值、豁免腐烂）各有测试；死字段消失，上游 ref 只剩
  一处真相源。
- 代价：`skills/agent-notes/` 以后不能随手放辅助文件（比如临时调试脚本），
  要么进清单（意味着它真是上游内容），要么进 `RUNTIME_ARTIFACTS`（意味着它是
  运行期产物）。这个约束是有意的，但确实比以前更容易撞红。
- 仍未覆盖（已知且不打算在这条门禁里解决）：哈希是 **文本** sha256，二进制被有损
  解码后写坏仍会全绿；`lib/self-update.js` 这个**第二个写者**运行时按字符串相等判断
  是否需要覆盖，不看 manifest、锚分支不锚 commit —— 它能在门禁之外改写 vendored
  目录，做出来的状态可能让下一个人看到方向相反的报错。这两条记在这里，不假装已解决。
- 相关：清单与上游比对的既有取舍见
  [2026-10-19-upstream-comparison-complete.md](./2026-10-19-upstream-comparison-complete.md)；
  归属声明的运行时依赖口径见
  [2026-10-20-notices-missed-runtime-dependencies.md](../bug-fix/2026-10-20-notices-missed-runtime-dependencies.md)。
