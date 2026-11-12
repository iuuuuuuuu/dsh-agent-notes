# Agent Note: 默认提供笔记技能；看板随仓库自动出现；输入区开关删除

Status: implemented

> Owner 2026-11-12 原话：「改为默认提供笔记 skill，当检测到工作目录存在 agent-notes 的
> skill 的时候主动打开面板；删除掉对话区域的 笔记规范 的开关按钮」。
> 与 [2026-10-19-network-down-reported-as-contract-broken.md](../bug-fix/2026-10-19-network-down-reported-as-contract-broken.md)
> 无关；看板路由与数据格式仍见
> [2026-10-17-board-409-readable-notice.md](../bug-fix/2026-10-17-board-409-readable-notice.md)。

## Problem

原来的形态是「一切围绕那枚开关」：

- 插件默认**关**（`enabled ?? false`）。装上以后什么都不会发生，直到用户在
  输入框工具行点一下「● 笔记规范」；
- 那枚开关同时兼职**看板 tab 的开关**：它订阅会话投影 `agentNotes`，把
  「开/关」推给 `syncBoardTab()`，tab 才注册或注销；
- 于是「这个仓库用不用决策笔记」被表达成**每会话一次的手动确认**。

问题在于：那本来不是用户的决定，而是**仓库的事实**。一个已经在用笔记的仓库，
每个新会话都要再点一次；而一个根本不用笔记的仓库，模型照样拿到规范段
（因为默认关，用户也不会去点）。两头都不对。

## Decision

### 一、默认开

`lib/index.js` 的 `enabled` 默认值改为 `true`；`lib/projection.js` 的视图在
「会话未设置 + 全局未设置」时也回 `true`，两处必须一致（否则命令状态与看板
判断会各说各话）。

关掉仍有两路：插件配置 `enabled: false`，或会话里 `/agent-notes off`
（命令保留 —— 删的是 UI 按钮，不是能力）。

### 二、看板按「仓库事实」自动出现

判据抽成 `projectUsesNotes(cwd)`（`lib/project-skill.js`）：

```
.agents/skills/<名字含 notes>/ 存在 → 在用（agent-notes 或上游旧名 write-notes-like-deepseek）
仓库根的 skills/agent-notes/ 存在    → 在用（本插件仓库自己的包布局）
其余                                 → 不用，不出现看板 tab
```

**判据只认「装了这套技能」，不认笔记树。** 第一版额外把 `.agents/notes` 也算进去，
理由是「刚建了树也说明在用」—— 当天就被 Owner 实测推翻：**没有装 skill 的目录也出现了
看板 tab**。笔记树是技能的产出物，不是安装凭据；只要判据放宽到「磁盘上碰巧有个 notes
目录」，任何曾跑过门禁留下 `.agents/notes` 的仓库都会冒出看板。

### 三、判据在 Host，浏览器只问一次

浏览器端没有文件系统，也不能拿「任意活跃会话的 cwd」凑数（那会在多项目并行时
指向别人的仓库 —— 本仓库修过的假绿就是这个形状）。所以新增
`GET agent-notes/status?session=…&cwd=…`，由 Host 解析会话 cwd 后读磁盘，
只回一个布尔 `available`。

`must`：**恒 200。**「这个仓库没用笔记」是正常答案，不是错误；回 4xx 会让前端
把「没笔记」显示成「读不到」。

### 四、闸门组件不渲染任何东西

输入区座位仍在（`conversation.input.left`），但组件从**按钮**换成**无渲染闸门**：
它只负责问一次 status，再驱动 tab 注册，返回 `null`。用户看不到任何按钮。

`must`：**判定跟随仓库，允许收起。** 服务端回 `true` 就挂出 tab，
回 `false` 就**注销**。第一版写成「只加不减」，理由是「多会话并存时别互相关掉」——
当天被实测推翻：切到没装 skill 的仓库，tab 仍在，Owner 看到的正是这个。
现在按最新一次判定执行；同一时刻只有一个活跃会话在驱动它。

`must`：**请求失败时不猜。** 路由未就绪、断网、HTTP 错误一律**保留上一次判定**，
既不默认可用也不默认不可用。第一版「失败按可用处理」（失败开放）的后果是：
启动瞬间一次请求失败，就把看板挂到了所有仓库上 —— 另一个被 Owner 抓到的假象。

## Alternatives considered

- **保留开关，只把默认值改成开** —— 改动最小，用户仍能随时切换。**否掉因为
  Owner 明确要求删除按钮**，而且它正是把「仓库事实」变成「每会话决定」的根源；
  留着默认开的按钮，只会让人怀疑「我是不是该关掉」。
- **看板 tab 无条件常驻** —— 实现最简单：不判仓库，所有会话都有「笔记」tab。**否掉因为它给不相关仓库塞噪音**：一个从不用笔记的仓库，每次打开对话都多一个永远空的 tab，而空 tab 无法自我解释。
- **客户端按 `props.scope.cwd` 自己判断** —— 不用新端点。**否掉因为浏览器没有文件系统**：`cwd` 只是字符串，判不了目录存在与否；让宿主把「有没有」算好再回，是唯一诚实的做法。
- **继续用会话投影当信号** —— 不动既有通道。**否掉因为投影回答的是「开关开没开」**，而开关已经删除；把「仓库有没有笔记」硬塞进投影状态，等于让纯折叠层去表达磁盘事实 —— 那是两种真相混在一起。
- **请求失败时按「不可用」处理（失败关闭）** —— 更保守，不会多出 tab。**否掉因为失败关闭在这里会静默去掉功能**：用户看不到 tab、也看不到任何解释，只能怀疑插件坏了。看板页面本身已经能说明「没笔记 / 读不到」，让它出现更诚实。

## Consequences

- **收益**：装上就生效，不用每会话点一次；不用笔记的仓库不再被塞规范段（`enabled:false` 的部署不受影响）。
- **收益**：看板按仓库自动出现 —— 已经在用笔记的仓库（本机 7 个）打开就有。
- **收益**：客户端不再执行会话命令、不再读投影，`:command(` 与投影键都已从 bundle 移除（`verify-plugin.mjs` 与 `client.test.mjs` 双向钉住）。
- **代价与已知上限**：**默认值翻转会影响既有用户**。原来默认关、靠点开关的人，升级后所有会话都开始注入规范段。这是刻意的，但要写进 CHANGELOG；`enabled:false` 是逃生口。
- **代价与已知上限**：**没有 UI 开关了**。要在某个会话里关掉，只能 `/agent-notes off`（命令仍在）。这符合 Owner 的要求，但对不熟悉命令的人是退步 —— README 里已把这条写在显眼位置。
- **代价与已知上限**：**只加不减**意味着一旦某个会话让 tab 出现，切到没笔记的仓库时 tab 仍在（页面会说明原因）。要做到「跟着仓库消失」需要知道哪个会话是当前活跃的，而宿主没给这个信号。
- **代价与已知上限**：判据依赖两个目录名。仓库把笔记放到别处（自定义 `notesRoot`）时，`projectUsesNotes` 只认默认位置 —— 那时看板不出现，但 `/agent-notes gate` 仍可用。
- **重访信号**：
  - 若宿主提供「当前活跃会话」或「按会话条件隐藏 tab」的能力 → 把「只加不减」换成按会话精确显示。
  - 若用户开始抱怨「默认开改变了我的会话」→ 先看 CHANGELOG 是否写清，再考虑给一次性提示，而不是把默认改回去。
  - 若 `cwd` 判据频繁误判（例如 monorepo 子目录会话）→ 需要向上找仓库根再判，而不是只看 `cwd`。

## Verification

```sh
npm run build                                  # 重建 lib/client.js（信封契约要求同步）
node --test tools/client.test.mjs              # 21 tests / 21 pass
node --test tools/board.test.mjs               # 37 tests / 37 pass（新增 2 条 /status）
node --test tools/config.test.mjs tools/integration.test.mjs tools/projection.test.mjs
npm run check                                  # 全量门禁 + 测试 + 故障注入
```

关键断言：

| 断言 | 位置 |
|---|---|
| 不传配置时**默认挂上**规范段（对照组：`enabled:false` 不挂） | `config.test.mjs` / `integration.test.mjs` |
| 客户端**不再**出现 `.command(` 与投影键，改用 `agent-notes/status` | `client.test.mjs` / `projection.test.mjs` / `verify-plugin.mjs` |
| `available:true` 才注册 tab；`false` **注销**；请求失败保留上次判定 | `client.test.mjs` |
| 判定跟随仓库：先可用后不可用 ⇒ 必须注销 | `client.test.mjs` |
| `/status` 恒 200，判据抛错时回 `available:false` | `board.test.mjs` |
| 只认技能副本（含上游旧名与本仓库包布局）；**只有笔记树不算** | `project-skill.test.mjs` |

### 真机取证的实况（不夸大）

用本机 Chrome 的 CDP 打开 127.0.0.1:3080 的真实页面（无头，不干扰用户窗口），实测：

| 观察 | 结果 |
|---|---|
| 插件客户端 bundle 是否加载 | ✅ 页面资源里出现 `@iuuuuuuuu/agent-notes/client.js` |
| 闸门是否真的问了服务端 | ✅ 网络里有 `GET /agent-notes/status?session=session-d5c749e6…` |
| 服务端对该会话怎么判 | ✅ `{"ok":true,"available":true}`（本仓库有 `.agents/notes`） |
| 页面上还有没有「笔记规范」 | ✅ `.an-switch` 数量 0，正文里也不含这四个字 |

**我没做到的部分，以及谁补上的**：我这一侧的 CDP 取证没能截到「笔记 tab 出现在会话视图」
那一帧 —— Web GUI 停在**新建会话的落地页**（有输入框、没有 tab 栏），`#/session/<id>`、
`?session=<id>`、`/session/<id>` 三种直达地址都没进去，点工作区条目只是切换工作区；
页面还被另一个插件的「用户须知」弹窗盖住（只在无头页面里移除，没动用户浏览器）。

所以当时只有测试与端点证据，**没有**写成「已亲眼确认」。随后 Owner 在自己正常打开的 GUI
重载后确认：「没有了，tab也出现了，已经好了」—— 即输入区胶囊已消失、看板 tab 自动出现。
**这一条以 Owner 的肉眼判读为准结案**；我这边仍未独立截到该帧，记录在此以免后人误以为
是我截的图。
