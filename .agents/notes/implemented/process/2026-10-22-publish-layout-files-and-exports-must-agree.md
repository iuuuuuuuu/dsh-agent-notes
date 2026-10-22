# Agent Note: 发布清单（files/exports）与产物必须自洽

Status: implemented

> 承接[保护发布的那道门禁，自己没人保护](./2026-10-19-publish-gate-had-no-guardian.md)：
> 那篇管的是「CI 里的门禁步骤会不会被改坏」；本篇管的是「**发出去的包**里少没少东西」。
> 与[包元数据与发布清单的上游判定](../process/2026-10-21-upstream-46-gates-classified-exactly-once.md)
> 同属「发布面」这条线。

## Problem

本仓库原先对 `package.json` 的 `files` 只有一句 `files 应包含 lib`
（`tools/verify-plugin.mjs:83`），对 `exports` 更是只有
`exports['./client'] !== undefined`（**不校验它指向的文件存不存在**）。

这两种改坏方式**实测都是绿灯**：

1. 把 `"skills"` 从 `files` 里删掉 → `npm pack --dry-run` 显示**产物里没有
   `skills/`**，而 `lib/skill.js:21`、`lib/notes.js:27`、`lib/self-update.js:212`
   都在运行时从包根读 `skills/agent-notes` —— 装上去的插件**技能整个消失**，
   而仓库里的每一条测试仍然全绿（它们测的是仓库，不是产物）。
2. 给 `exports` 加一条 `"./probe-missing": {"default": "./lib/nope.js"}` →
   消费者 `import '@iuuuuuuuu/agent-notes/probe-missing'` 得到 `MODULE_NOT_FOUND`。

还有第三种：`files` 里写一个**磁盘上不存在的目录名**。npm 对这种条目是
**静默忽略**的 —— 拼错一个目录名，产物里就少一整棵树，而仓库里什么都不会红。

这一类缺陷的共同点是：**发布出去的东西和仓库里的东西不是一回事**，
而仓库里的测试全都只测仓库里的东西。所以判据必须比对「产物会包含什么」，
而不是「仓库里有什么」。

上游 A 的 `scripts/verify-package-meta.ts:66-74` 有一层同款判据
（`published()`）：**凡是运行时需要的文件，都必须被 `files` 覆盖**，
否则报 `files must include <file>`（`:201-202`、`:236-237`）。本仓库此前没有对应物。

## Decision

新增 `tools/publish-layout.mjs`，导出 `checkPublishLayout({ root, pkg })`，
由 `tools/verify-plugin.mjs` 在包清单检查之后调用。判据分四类：

1. **每条 `files` 条目必须在磁盘上存在**（含通配符的条目除外 —— 那是 glob
   模式，本地不存在并不代表发布时不存在）。理由写在错误文案里：npm 会静默忽略它。
2. **`exports` 的每个目标必须存在，且必须会被发布**。`exports` 的值可能是字符串、
   数组或条件对象（`{"default": "./x.js"}`），**每个分支**都是一次可能的解析目标，
   全部都要能落地 —— 少查一个分支，就等于允许「在某些条件下装出来的包是坏的」。
3. **`main` 与 `dsh.bundle.patch` 必须会被发布**。前者漏了则 `require` 失败，
   后者漏了则宿主加载不到插件。
4. **运行时需要的每一个文件都必须会被发布**。运行时文件集合**从代码推导**
   （`lib/**` 与 `skills/agent-notes/**`），不是手写清单。

`files` 覆盖判定实现 npm 文档那条主规则：条目是目录就整棵目录进去，
条目是 glob 就按 glob 匹配（`?` 单字符、`*` 单层、`**` 跨层）。
npm **总是**发布 `package.json`、`README*`、`LICENSE*`、`NOTICE*`，
无论 `files` 写没写 —— 这几个豁免，否则会造出假红。

## Alternatives considered

- **直接在 `tools/verify-plugin.mjs` 里加几行断言**（比如「`files` 必须含
  `skills`」）：改动最小，五行就能堵住最危险的那一种。但它只挡**白名单里的几项**：
  往 `files` 加一个不存在的目录名、给 `exports` 加一条坏路径、`main` 漏了 —— 全都还在。
  **否掉因为**：白名单形态的门禁只能证明「该在的在」，证明不了「不该有的不在」，
  而后者恰恰是静默失败的那一半。
- **真的跑 `npm pack --dry-run` 再检查产物清单**：判据最接近真相。
  **否掉因为**：它依赖 npm 的完整打包语义（`.npmignore`、`.gitignore` 优先级、
  `alwaysIncluded` 的历史行为），而 npm 不保证跨版本行为一致；门禁一旦依赖某个
  npm 版本的行为，就得跟着那个版本走。本仓库只实现 npm 文档写明的那条主规则。
- **改 `package.json` 的 `files`，让它显式列出每个文件**：判据就不需要判覆盖了。
  **否掉因为**：本仓库的 `lib/` 与 `skills/agent-notes/` 都是多文件目录，逐个列
  会让每加一个模块就改一次清单，而清单与代码的偏离正是这道门禁要防的东西。
- **把「运行时文件集合」写成手写清单**（像 `RUNTIME_ARTIFACTS` 那样）：
  不用扫盘。**否掉因为**：手写清单会与磁盘漂移 —— 加了新模块忘了加进清单，
  门禁就默默放过；而扫描出来的集合天然与磁盘一致。
- **给 `files` 漏项这件事单独建一道门禁脚本**（如 `tools/publish-layout.mjs`
  独立成 CLI）：职责更单一，可以单独跑。**否掉因为**：判据要回答的是
  「这个包发出去能不能用」，那必须同时看 `package.json`、磁盘与代码三处；
  拆成独立脚本后，失败信息会与 `verify-plugin` 的其它结论分两处输出，
  而它们本来就是同一个问题（这个包对不对）。

## Consequences

收益是三种此前静默通过的坏包现在会红：删掉 `files` 里的 `skills` 或 `lib`、
`exports` 指向不存在或未被发布的文件、`main`/patch 未被发布、
`files` 条目指向不存在的目录。

代价与已知边界：

- `files` 覆盖判定是**近似** npm 语义：它实现了目录前缀与三种通配，
  没有实现 npm 的 `!` 取反、`.npmignore` 交互与 `alwaysIncluded`。
  判据因此可能对极冷门的 `files` 写法给出与 npm 不同的答案。
- 运行时文件集合目前覆盖 `lib/**` 与 `skills/agent-notes/**`。
  `tools/` 不在运行时集合里 —— 它是维护者工具，不随包安装；但本仓库
  `files` 里仍然带着 `tools`，那是给下游仓库做笔记门禁时用的（README 有说明），
  两者不冲突：集合判「必须被发布」，不判「不该被发布」。
- `exports` 的条件对象只判**目标路径**，不判条件表达式本身
  （例如 `"node"` 与 `"default"` 指向不同文件时，只检查两个文件都存在）。
- 白名单式豁免（npm 恒含的那几个文件）将来若 npm 改语义，这里会漂。

## Verification

```sh
node --test tools/publish-layout.test.mjs
# tests 10 / pass 10 / fail 0                                    (exit 0)
```

10 条用例：绿基线 1 条；`files` 删掉 `skills` / 删掉 `lib` / 条目指向不存在目录
3 条负例；`exports` 指向不存在文件 / 指向存在但未被 `files` 覆盖 2 条负例；
`main` 未被覆盖 / patch 未被覆盖 2 条负例；单元判据 2 条（目录前缀覆盖与 npm
恒含文件、`exports` 每个条件分支都要被收集）。

用例的形状是**真包副本 + 真子进程**：拷一份包到临时目录，改副本里的
`package.json`，真跑一次 `tools/verify-plugin.mjs`，读退出码与失败文案。

**真故障注入**：把 `tools/publish-layout.mjs` 的
`return (files ?? []).some((pattern) => coversFile(pattern, f));` 改成 `return true;`
（覆盖判定整体失效）→ **4 pass / 6 fail**，红的正是
「files 删掉 skills 必须红」「files 删掉 lib 必须红」
「exports 指向存在但没被 files 覆盖的文件必须红」「main 没被 files 覆盖必须红」
「patch 没被 files 覆盖必须红」与那条单元判据；
`cp` 还原后 `diff` 逐字比对确认一致，复跑 **10/10** 绿。

登记进 `tools/fault-injection.mjs` 的声明表（与磁盘上的测试文件双向对账），
`node tools/fault-injection.mjs` 退出码 0，末尾「磁盘上 42 个测试文件全部登记，无遗漏」。
