# Agent Note: 手写 frontmatter 解析与宿主真 YAML 口径不一致

Status: implemented

> 与 [2026-10-19-npm-gates-fail-under-node-modules.md](../bug-fix/2026-10-19-npm-gates-fail-under-node-modules.md)
> 同一类：**本地跑得好好的，换个环境就静默错**。那篇是「装成包就崩」，
> 本篇是「同一份文件两个解析器，一个对一个错，而门禁看不见」。

Independent: 那篇讲 npm 发布路径下的类型剥除限制，本篇讲技能 frontmatter 的
YAML 口径；两者除「本地测不出来」这层比喻外改动完全不重叠。

## Problem

`lib/skill.js` 里有个手写的 `parseFrontmatter()`，用来剥掉 `SKILL.md` 的 YAML 头并把
`description` 交给宿主当技能描述。它只按 `/^([A-Za-z0-9_-]+):\s*(.*)$/` 取顶层标量，
遇到引号就无脑切掉首尾两个字符。

问题不在「它不完整」——**问题是同一个文件还有另一个解析器在跑**。

DSH 宿主 `@deepseek-ai/dsh-skill-filesystem` 会把 `.agents/skills/`、`~/.agents/skills/`
等目录当作技能根，用真正的 `yaml` 包解析其中的 `SKILL.md`：

```js
// dsh-skill-filesystem/lib/index.js:790
const parsed = parse(raw.slice(start, closing.start));   // yaml 包的 parse()
```

而本插件自己又注册了一个 `agent-notes` 技能 provider，读的是同一份
`skills/agent-notes/SKILL.md`，走的是手写解析器。同一份文件、两个解析器、
两种口径——一旦两者理解不同，模型看到的技能描述就不是文件里写的那一句，
而且**没有任何门禁能发现**（`verify-plugin.mjs` 不看 description 内容）。

## 实测：哪些写法会真的读错

探针 `.probe/probe-which-cases-slip.mjs` 把 `description` 换成几种 YAML 合法写法，
逐个注入真实的 `SKILL.md` 再跑 `tools/plugin.test.mjs`：

| 写法 | 门禁 | 解析值 |
|---|---|---|
| 行尾注释 `description: … # 说明` | **绿（放行）** | `"… # 说明"` ★错 |
| 引号值 + 行尾注释 | **绿（放行）** | 引号与注释一起混进值里 ★错 |
| 值里 `#` 前有空格（YAML 里就是注释） | **绿（放行）** | `"… #11 已修"` ★错 |
| 块标量 `\|` | 红（拦住） | `"\|"` ★错 |
| 单引号 | 绿 | 正确 |

5 个用例里 **3 个「门禁放行且值错误」**。块标量那次是红，但红得偶然：解析成 `|`
后长度是 1，撞上了 `assert.ok(description.length > 10)` 这条**跟内容无关的**长度断言。
行尾注释解析出的值更长，同一条断言必然放行。

所以缺陷是「潜伏且无守卫」，不是「已经被触发」：真实的 vendored `SKILL.md` 用的是
普通标量，当前读出来是对的。但那份文件由 `tools/sync-upstream.mjs` 管理，
上游改一次写法就会静默错掉。

## Decision

**不引 `yaml` 包，把手写解析器补到与宿主同口径，并且对不建模的写法显式报告。**

三件事：

1. **补上真正会影响值的规则**：行尾注释（`#` 前必须有空白且不在引号内）、
   单双引号解转义（含 `''` 与 `\"`）、`|`/`>` 块标量（含 `+`/`-` chomping）、
   CRLF。
2. **YAML 会拒绝的写法不给值**：普通标量里出现 `": "`（`notes: write them`）时
   真 YAML 抛 `BLOCK_AS_IMPLICIT_KEY`，宿主整份忽略技能；本解析器改为不设该字段并告警。
3. **未建模的嵌套内容告警而不是当新键**：`metadata:` 下的缩进行以前会被
   `/^([A-Za-z0-9_-]+):/` 匹配成顶层键，现在记进 `warnings` 并由 `readSkill()`
   写到 stderr（`DSH_AGENT_NOTES_QUIET=1` 可静默）。

`parseFrontmatter` 的返回值多了 `warnings`，`readSkill()` 多返回 `warnings`。

## 为什么不用 `yaml` 包

这是本次唯一的真权衡。宿主就在用它，跟着用能保证 100% 同口径，成本也只是
`dependencies: { "yaml": "^2" }` 一行——**按「值不值得它的成本」衡量，它是划算的**。
不做的理由是另一件事：

本插件的零依赖不是风格洁癖，是**这个包要在 npm 上装到别人的 DSH 里**。多一个
运行时依赖，就多一份「上游 `yaml` 发新版、下游 DSH 自带的 `yaml` 是另一个版本」
的分歧面；而本插件只需要读 2 个字段（`name`、`description`），且这两个字段
由我们自己的 vendored 文件控制，不是用户输入的任意 YAML。

真正的判据不是「要不要依赖」，是「这 200 行手写代码值不值得换掉一个依赖」。
答案是：**补到同口径之后，剩余风险已经可以靠测试钉住**——21 条用例的值全部
由真 `yaml` 实测得出（见下），不是按规范手写。若将来 SKILL.md 需要建模
锚点/多行流标量/多文档这类东西，那时再引依赖，理由是「手写成本已经超过依赖成本」。

## 验证

- `.probe/probe-vs-real-yaml.mjs`：从 DSH 安装目录 `createRequire` 借出宿主那个
  `yaml` 包，照抄宿主 `parseFrontmatter` 的逻辑，对 21 条 fixture 逐条比对
  → **21/21 一致**（含「宿主抛异常」当「拒绝」参与比较）。
- `tools/plugin.test.mjs` 新增 4 条用例，其中「与宿主真 YAML 口径一致」把上述
  21 条里的 14 条值写进断言。**期望值由实测得出，不由我理解规范得出**。
- `.probe/probe-fault-inject-frontmatter.mjs`：6 个变异体（把刚修好的每处改回原样），
  **6/6 全部被测试捕获**，且失败项名字对得上。
- `npm run check` 14 步全绿，**357/357** 测试通过。

## Consequences

**收益**：同一份 `SKILL.md` 在两个解析器下读出的 `description` 现在逐字节相同，
21 条边界的值由真 `yaml` 钉住；新写法（注释、块标量、转义）不会静默读错；
未建模的写法会在 stderr 说出来，而不是当成一个新字段。

**代价**：

- `parseFrontmatter` 从 26 行涨到约 150 行。它现在是一个「部分 YAML 实现」，
  维护者必须知道它**故意只建模 SKILL.md 需要的子集**——代码注释与 `warnings`
  机制都是为了让这件事在改动时无法被忽略。
- 每处未建模写法都会在 stderr 打一行。如果上游哪天真的用了嵌套映射，
  用户会在日志里看到噪音——这是刻意的，比静默读错强。
- 测试用例表的「期望值」是从真 yaml 实测抄来的，**升级 `yaml` 版本后这条对照
  可能漂移**；漂移时 `.probe/probe-vs-real-yaml.mjs` 会先红，提醒重跑。

## 备选方案

### 一、引 `yaml` 包，与宿主完全同源

**最强理由**：宿主就在用它，同一份文件同一个解析器，口径分歧在结构上不可能存在；
手写 150 行去追一个成熟实现的边界，长期看是负资产，每遇到一个新写法就要补一次。

**否定理由**：本插件对 frontmatter 的需求只有 2 个顶层标量，且文件由自己 vendored
控制。引入依赖换来的确定性，可以用「拿真 yaml 当基准的测试」等价钉住——21/21 那条
就是干这个的。真正的风险点不是「解析器不够强」，是「两个解析器口径不同而没人知道」，
而后者用测试解决比用依赖解决更精准。若需求扩张（锚点、多文档），按上文判据重新评估。

### 二、让宿主统一解析，本插件不再自己读 frontmatter

**最强理由**：彻底消灭双解析器——这是问题的根源。宿主已经解析好 `description`
放在 `SkillDefinition` 里，插件再解析一遍本质上是重复劳动。

**否定理由**：做不到。本插件是**技能 provider**（`createSkillProvider` 实现
`list()`/`get()`），职责就是向宿主**提供**技能定义；宿主那份 `skill-filesystem`
provider 读的是 `.agents/skills/` 等项目目录，不读插件包内的 `skills/agent-notes/`。
也就是说这两条路径读的是**两份不同位置的副本**，让 provider 去依赖宿主已解析的结果
会形成循环。要消除重复只能让插件不自带技能，那是另一个产品决定。

### 三、什么都不改，只在文档里提醒「别用块标量写 description」

**最强理由**：真实文件当前读得对，改动面为零，不引入 150 行需要维护的解析代码。

**否定理由**：提醒拦不住上游。`SKILL.md` 由 `tools/sync-upstream.mjs` 自动同步，
写提醒的地方（本仓库文档）恰恰不在同步路径上。而且实测已有 3 种写法能让门禁
放行且值错误——靠人记住这些边界，正是机械门禁存在的理由。
