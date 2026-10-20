# Agent Note: 那道「双语互链」门禁改的是仓库本身，所以它永远绿

Status: implemented

> 与 [sync:check 静默写盘](../bug-fix/2026-10-19-sync-auto-check-silently-writes.md)
> 是同一类缺陷的第二次出现：**一个叫「检查」的入口实际在写盘**。
> 那次的教训被写进了笔记，但没人回头审「还有没有别的检查在写盘」——
> 于是这一道从 [双语互链自动改写](../feature/2026-10-19-reference-links-and-locale-autofix.md)
> 落地那天起就一直是绿的。

## Problem

`npm run docs:fix-links` 的定义是 `node tools/bilingual-links.mjs`，
**没有任何参数**，而它就挂在 `npm run check` 链的第六位。

也就是说：**每次跑门禁都会往仓库里写盘。**

### 实测一：它永远不可能红

往 `README.md` 里真种一条指错语言的链接（把正文里的 `README.md` 改成
`README.en.md`），然后按顺序跑：

```
npm run docs:bilingual   → EXIT=0（结构没变，它当然绿）
npm run docs:fix-links   → EXIT=0，并且 README.md 的 sha 变了
```

★ 关键在这儿：**它自己把违规改好了，然后报告「无需改动」**。
一条永远返回 0 的门禁不是门禁，是一个会改文件的副作用。

### 实测二：它会把别人的未提交改动算到自己头上

`.github/workflows/verify.yml` 末尾有一道断言：工作区必须干净（`git status --porcelain`）。
它存在的理由是「某个门禁可能在仓库里留下了改动」。

但只要本地工作区**本来就脏**（改到一半、临时探针、`git stash` 没 stash 全），
这道断言就会红，而消息指向「某个门禁留下了改动」——**它指的是别人的改动**。
排查方向从这里开始就完全错了，而 `docs:fix-links` 每次跑都在制造这种误导。

（CI 里工作区是干净的，所以这个问题只在本地重放 CI 时出现 —— 而本地是唯一
会被人 `--no-verify`、也会忘记跑的那一层。）

## Decision

把「查」和「修」拆成两个入口，**门禁只查**：

| 入口 | 行为 | 谁用 |
|---|---|---|
| `npm run docs:links` | `--check`，只读，违规返回 1 | `check` 链、CI |
| `npm run docs:fix-links` | 默认，写盘 | 人手动修 |

`main(argv, root)` 收一个 `--check` 开关；`checkTranslationLinkLocales()` 与
`fixTranslationLinkLocales()` 共用同一个 `scanTranslationLinkLocales()`，
**判据只有一份**（拆成两份迟早分叉，本仓库已经吃过围栏口径分叉的亏）。

顺带在这一层修掉一个只有在写测试时才暴露的空集合漏洞：`scan` 原来对
不存在的文件 `continue`，于是「一对文档少了一个」时「没有指错语言的链」
是恒真命题 —— 又是空集合恒绿。现在缺失的名单单独返回，`--check` 见到就红。

## Consequences

- 这道门禁第一次具备「能红」这个属性：种一条违规，`docs:links` 返回 1 并
  点名是哪一条、哪个文件。
- `git status --porcelain` 那条断言重新只指向它该指向的东西。
- 代价是多了一个 npm script，以及「修」变成需要人显式跑的一步。
  后者是**故意的**：自动修会让「有人绕过了门禁」这件事消失。

## Alternatives considered

**① 保持一个入口，加 `--write` 前置开关（默认只读）。**
这是最省事的做法，而且行为与现在的实现完全等价。

否决理由不是行为，是**名字**：`docs:fix-links` 挂在 check 链里时，
读 `package.json` 的人会以为「跑门禁会顺便把链接修好」—— 而那正是原来
那个缺陷的心理成因。`docs:links`（查）与 `docs:fix-links`（修）把区别
写在名字上，比写在参数上更难忽略。

**② 干脆删掉这道门禁。**
最强理由是实在的：本仓库当前**零处违规**，它是纯防御性完备，删掉少一份维护面。

否决理由：它是「自动改写型工具必须支持参考式链接」这一类的同一件东西
（见 [参考式与语言互链](../feature/2026-10-19-reference-links-and-locale-autofix.md)），
将来若真按上游那套做双语自动改写，这段逻辑要重写一遍；而现在修它只花了
一次拆函数。**把成本 20 行、且已经写好测试的东西删掉，省下的不是复杂度，
是「以后还得再做一遍」。**

**③ 让 `docs:fix-links` 在 check 链里跑，但把它的写盘结果忽略掉。**
做不到 —— 写盘发生在进程内，外面看不出区别。这也是为什么只能拆入口。
