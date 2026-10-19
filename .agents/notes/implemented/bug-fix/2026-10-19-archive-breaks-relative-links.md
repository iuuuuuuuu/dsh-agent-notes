# Agent Note: 归档会切断相对链接 —— 在调用上游脚本之前改写

Status: implemented

> 与 [2026-10-19-upstream-hit-the-same-archive-deadlock.md](../architecture/2026-10-19-upstream-hit-the-same-archive-deadlock.md)
> 同一问题。那一篇判定「**修不了**」—— 因为 `skills/agent-notes/` 是 vendored，
> 而归档脚本在它里面。**本篇推翻那个结论**，并说明为什么当时那个结论是对的。

Independent: 本篇改 `tools/archive-note.mjs`（本仓库自有的入口层），
不碰 vendored 内容，所以不需要 supersession；但它直接**解决**那篇记的死锁，
所以在此声明关系而不是声称无关。

## Problem

归档把笔记从 `implemented/<class>/x.md` 移到 `archived/<class>/x.md`。
深度不变，但路径段变了 —— 于是笔记正文里的**相对链接全部失效**：

```
implemented/simplification/x.md 里的  ../bug-fix/y.md
                                 → 解析成 archived/bug-fix/y.md
                                 → 不存在
```

### 上游脚本确实不管出向链接（读源码确认）

`skills/agent-notes/scripts/archive-agent-note.ts`：

- `:83` `const updatedContent = lines.join("\n")` —— 移动前只做**头部规范化**
  （去掉 `# Agent Note:` 前缀），**完全没动正文里的链接**
- `:127-155` 只**扫描入向**链接并打印
  「Please review and update their relative markdown links if necessary.」
  —— 即**把责任推给人**

★ 出向链接（笔记里指向别的笔记的那些）正是会断的那批，而它一条都不管。

### 实测代价

本仓库唯一的归档笔记（64 篇里的 1 篇）就有 **1 条这样的断链**，
且**修不了** —— `--write` 只封未封印的文件，改已封印的报 `seal mismatch`。

### 上游也卡在这里

`verify-archived-agent-notes.ts` 里有 `figmaLinkRemovals` 白名单
（精确到 path + before 哈希 + after 哈希，实测出现 2 处）。
说明上游遇到过同样的问题，而它能做的只是**硬编码豁免某一笔**。

## Decision

在本仓库加 `tools/archive-note.mjs` 作为 `archive:note` 的入口：
**先把相对链接改写成归档后仍可解析的形式，再调上游脚本完成归档与封印。**

用户看到的命令不变（`npm run archive:note`），只是实现换成本仓库的。

### 顺序是关键：先改写，再归档

★ 封印在归档那一刻计算。若「先归档、再改链接」，哈希立刻对不上，
`verify-archived-agent-notes` 报 `seal mismatch` ——
而**重算 manifest 等于「授权改封印」**，那与封印的意义直接冲突
（封印要证明的就是「归档后没被改过」）。

所以顺序必须是：

```
1. 读原笔记
2. 在内存里把相对链接改写成归档后的形式
3. 写回原路径（文件还在原处，链接仍有效，只是更深）
4. 调上游 archive-agent-note.ts → 它算封印时看到的是改写后内容
5. 封印天然一致，无需重算
```

第 3 步失败也安全：位置没变，链接仍能解析。
第 4 步失败则打印「链接已改写但文件仍在原位置」并以非零码退出。

### 改写规则

`../bug-fix/y.md`（在 `implemented/simplification/` 里）
→ `../../implemented/bug-fix/y.md`（在 `archived/simplification/` 里）

因为笔记根不变，只是中间那层从 `implemented` 变成 `archived`。

### 刻意不碰的

| | 为什么 |
|---|---|
| **代码块内的内容** | 笔记里贴示例 Markdown 完全合法（本仓就有一篇），改它就是**篡改历史内容** |
| 绝对 URL / 协议相对 / 纯锚点 | 不指向本仓库文件 |
| 指向笔记树**之外**的路径（如仓库根 `README.md`） | 它的解析基准在归档前后**没变**，改了反而错 |
| 已经是正确形式的目标 | 幂等 |

`fragment`（`#decision`）与 `query`（`?v=2`）必须跟着路径一起走。

### 两个真实 bug（故障注入查出来的，都不是靠读代码看出来的）

**① `notesRoot` 写死 `PACKAGE_ROOT/.agents/notes`**

故障注入第一版直接被护栏拦下：`只能归档 implemented/<class>/<file>.md，实际: C:/Users/.../Temp/an-fi-xxx/...`。

根因：它从**脚本自身位置**推 notes 根。改成从**目标路径**推导 ——
`{notesRoot}/implemented/<class>/<file>` 往上两级就是根。
这同时修掉第二个问题：在别的仓库归档笔记时不再被误判。

**② `PACKAGE_ROOT` 多上了一层 `dirname`**

`tools/archive-note.mjs` → `tools/` → 仓库根是**两层**，我写了三层，
结果找的是 `D:\WishProject\skills\...`（上一层目录）。

★ 这两个都是**故障注入跑真流程**才暴露的。离线用例全绿时它们都存在 ——
因为离线用例直接调 `rewriteRelativeLinks`，绕过了入口。

## Alternatives considered

- **直接改上游 `archive-agent-note.ts`** —— 最直接，改在正确的地方。**这是本篇最强的一条被否方案**：`skills/agent-notes/` 是 vendored，手改会被 `verify-plugin.mjs` 的 SHA-256 哈希比对当场拦下。**要改得推上游** —— 所以本篇末尾附了 issue。
- **在归档后改链接、再重算 manifest** —— 顺序上更自然。**否掉因为重算封印就是「授权改封印」**，与 `verify-archived-agent-notes` 的存在意义直接冲突。而且实测那条断链就是因此才「修不了」。
- **用 `pre-commit` 钩子改写** —— 挂在 `commit-msg` 旁边。**否掉因为语义错位**：钩子的职责是「校验提交内容」，不是「修内容」；而且要改的是**已暂存的内容**，比改工作区更危险。
- **改指向归档笔记的那些笔记（入向）** —— 上游现在只提示不改。**否掉因为入向链接不会因归档而断** —— 被指向的文件只是换了位置，指向它的链接仍解析得到（`../bug-fix/y.md` 指向 `implemented/bug-fix/y.md`，那篇还在原处）。**真正断的只有出向链接。**
- **只打印警告让人自己改** —— 上游现在的做法。**否掉因为实测这正是那条断链的成因**：警告被忽略了。

## Consequences

- **收益**：归档不再切断相对链接。这是「封存只读」这条生命周期规则**真正可用**的前提 —— 否则归档过的笔记引用其它笔记时必然断链。
- **收益**：不用「授权改封印」那套机制，封印的语义保持不变。
- **代价与已知上限**：改写发生在**调用上游脚本之前**，所以若上游脚本失败，文件内容已改但位置未变 —— 链接仍可解析，只是路径变深。**可恢复，但那一笔 diff 是噪音。**
- **代价与已知上限**：只处理 `archive:note` 这条路径。**若有人绕过它直接 `node skills/agent-notes/scripts/archive-agent-note.ts`，改写不会发生** —— 所以 issue 仍然要提。
- **代价与已知上限**：`AGENT_NOTE_ROOT` 环境变量传给上游脚本。上游 `agent-note-tree.ts:23` 支持它，但那是既有接口，我依赖它 —— 若上游改名，透传会静默失效。
- **代价与已知上限**：正则口径（`tools/archive-note.mjs` 的 `!\[...\]\(...\)`）与 `tools/md-links.mjs` 的 `localPathOf` **是两份独立实现**。两边若对「什么算相对链接」理解不一致，会出现「一个放行一个拦下」。**当前两边口径一致（都跳过围栏内、都跳过绝对 URL），但没有机制保证它们永远一致。**
- **重访信号**：
  - **上游接受了链接改写** → 删掉 `tools/archive-note.mjs`，把 `archive:note` 切回上游脚本。
  - **归档笔记出现新的链接形式**（引用式链接 `[x][ref]` + `[ref]: path`）→ 当前正则**不处理**参考式定义，那种链接仍会断。已知缺口。
  - **`md-links.mjs` 改了对相对链接的判定** → 两处口径可能分叉，要同步。

## Verification

```sh
npm run check    # exit 0（335 测试、65 篇笔记）
```

**离线用例 7 条**（`tools/archive-note.test.mjs`，追加在原有 5 条之后）：
改写 / 树外不改 / **代码块不改** / 绝对 URL 不改 / fragment+query 跟着走 / 幂等 / 两种围栏都认。

**故障注入**（真造笔记树、真归档、真算哈希）：

| 验证 | 结果 |
|---|---|
| 真链接归档后仍解析得到 | ✔ `../../implemented/bug-fix/target.md` |
| 代码块里的示例原样保留 | ✔ |
| **封印与内容一致**（不需授权改封印） | ✔ |
| 篡改归档文件后封印会红 | ✔ |

### 一条方法教训

离线用例 **12/12 全绿**时，两个真 bug（`notesRoot` 写死、`PACKAGE_ROOT` 多一层）
**都还存在** —— 因为离线用例直接调 `rewriteRelativeLinks`，**绕过了入口**。

**验「入口」必须真跑入口。** 只验被调用的那个函数，验的是「那个函数对」，
不是「这条命令能用」。这两者的差别在这次整整花掉了三次失败才看清。