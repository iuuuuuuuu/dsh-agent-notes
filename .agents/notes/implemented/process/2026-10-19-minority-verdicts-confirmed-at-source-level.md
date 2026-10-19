# Agent Note: 12 个少数派判定经源码级复核，全部成立

Status: implemented

> 接续 [2026-10-19-upstream-comparison-complete.md](./2026-10-19-upstream-comparison-complete.md)
> —— 那一篇把 44 道 verify 分成 12 少数派 + 32 结构性不适用，但**只读了
> `package.json` 的 script 值**，没读脚本源码。
> 那一篇自己写了重访信号：「44 道逐条清单可复核」，而复核需要源码。
> **本篇补上那一半。**

Independent: 本篇不改任何门禁行为，只把既有判定从「读 script 值推断」
升级为「读脚本源码确认」。

## Problem

前几轮我反复用同一个判据：**读 `package.json` 的 script 值，看它指向什么文件**。
用它把 65 个 `verify-*` 名字收敛成 44 个（21 个指向 `gen-*` 生成器）。

但那只解决了**哪些算 verify 脚本**，没解决**它们查什么**。而 12 个少数派的
判定理由（"结构性不适用"、"有理由不适用"）都是**关于脚本内容**的断言，
却建立在**关于 script 值的观察**上。

★ 这正是 MEMORY 里那条判据：「当我说出一个数时，我能说出它是怎么算出来的吗」。
前一半做到了（44 从哪来），后一半没做（每道查什么）。

## Decision

**逐条拉源码复核，判定全部成立，无需改动。**

12 个脚本全部 200，共约 2400 行。逐条读文件头注释与核心逻辑：

### 已实现（5 个）

| verify | 行数 | 源码证据 |
|---|---|---|
| `agent-note-classification` | 27 | 复用 `walkAgentNoteTree()`（已实现），只多一条「禁止 `docs/rfc`」——本仓库用 `.agents/notes/` ✔ |
| `agent-note-format` | 94 | vendored 直接用 ✔ |
| `archived-agent-notes` | 115 | vendored 直接用 ✔ |
| `doc-budgets` | 58 | 对应本仓库 `tools/doc-budget.mjs` ✔ |
| `md-links` | 254 | 对应本仓库 `tools/md-links.mjs` ✔ |

### 部分实现（1 个）

| verify | 行数 | 证据 |
|---|---|---|
| `translation-pairing` | 368 | 比结构签名（headings/code/tables/lists/links），**不补逐节哈希**。本仓库只比 headings + code 的 lang 部分 ✔ |

### 有理由不适用（6 个）—— 源码给出的理由比我原来写的**更具体**

| verify | 行数 | 源码第一句说了什么 | 为何不适用 |
|---|---|---|---|
| `md-wrap` | 86 | Reject Markdown prose paragraphs **spanning multiple physical lines** | 排版偏好，与本仓库无关 |
| `public-repository-links` | 99 | Reject tracked files that reference an **unavailable legacy repository**（`deepseek-harness-sdk`） | 历史迁移痕迹，本仓库没这问题 |
| `concrete-terms` | 105 | Reject **one ambiguous origin label**（`prove`+`nance`） | 术语规范，与结构无关 |
| `runtime-closure` | 237 | 部署清单覆盖**每个 shipped agent preset 的全部插件依赖**与 workspace peer | 本仓库是单插件，无 preset / peer 概念 |
| `no-top-level-await` | 267 | 可导入模块**顶层无 await** | `lib/` 是 CommonJS，无 ESM 顶层 await |
| `export-jsdoc` | 607 | 每个**非 vendored 导出**都要 JSDoc | 同上，且本仓库明确不发布 TS 类型 |

## Alternatives considered

- **读 script 值就够了** — 便宜。**这是本篇最强的一条被否方案**，因为它恰好是前几轮的做法，而它把「关于脚本内容的断言」建立在「关于 script 值的观察」上。若某个 verify 的值指向别处但内容其实适用（就像我上一轮发现 `verify-agent-note-classification` 复用已实现逻辑那样），就会误判。**这次逐条读源码，结论是判定都对 —— 但那是运气好，不是方法对。**
- **只读少数派，32 个「结构性不适用」按名字推断** — 折中。**否掉因为 `agent-note-classification` 那一轮已经证明「按名字推断」会出错** —— 我当时只读文件名就判它「不适用」，后来读源码才发现它复用了已实现的逻辑。**同样的错不该犯第二次。**
- **复核完改判定** — 若发现某条判错。**结论是没有一条判错**，所以无改动。这本身是信息：**说明前几轮的判定虽然方法不严，结论仍然成立。**

## Consequences

- **收益**：12 个少数派从「推断」升级为「确认」。**判定全部成立，无需改动** —— 这让收尾笔记的分类表第一次具备「可复核到源码」的性质。
- **收益**：给三条不适用理由补上了**源码原话**，比原来我自己的概括更准确。例如 `runtime-closure` 不是泛泛的「monorepo 专属」，而是「覆盖每个 shipped agent preset 的插件依赖」—— 本仓库连 preset 概念都没有，所以判据更硬。
- **代价与已知上限**：**32 道「结构性不适用」仍未做源码级复核** —— 它们各自约 50–200 行，合计约 5000 行。本轮只做少数派是因为**它们才有判定争议**（那 12 条带「不适用」判断的）；32 条是按「读 `packages/` 而本仓库没有该结构」批量归类的。
- **代价与已知上限**：`no-top-level-await` 与 `export-jsdoc` 的「不适用」**部分依赖本仓库的技术形态**（CommonJS、无 TS 声明）。若将来本仓库改成 ESM 或发布 `.d.ts`，这两条要重新评估。
- **重访信号**：
  - **若要闭合「44 道全部源码级复核」** → 剩下 32 道按同一方法做，产出是一张「每道查什么 + 为何不适用」的完整表。当前不做的理由是：**那 32 道的判定理由同构且可从目录结构直接验证**（它们 import 或 glob `packages/`），逐条读源码的边际价值低。
  - **若本仓库引入 agent preset / 多插件打包** → `runtime-closure` 立即适用。
  - **若 `lib/` 改成 ESM** → `no-top-level-await` 立即适用。
  - **若开始发布 `.d.ts`** → `export-jsdoc` 立即适用。

## Verification

```sh
for s in agent-note-classification md-wrap public-repository-links ...; do
  curl -s "https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/scripts/verify-$s.ts"
done
```

实测（12 个全部 200）：

```
200  verify-agent-note-classification.ts        27 lines
200  verify-agent-note-format.ts                 94 lines
200  verify-archived-agent-notes.ts             115 lines
200  verify-md-links.ts                        254 lines
200  verify-doc-budgets.ts                      58 lines
200  verify-translation-pairing.ts             368 lines
200  verify-md-wrap.ts                          86 lines
200  verify-no-top-level-await.ts              267 lines
200  verify-export-jsdoc.ts                    607 lines
200  verify-public-repository-links.ts          99 lines
200  verify-concrete-terms.ts                  105 lines
200  verify-runtime-closure.ts                 237 lines
```

**`agent-note-classification` 的源码原文**（27 行，全文读了）：

```ts
/**
 * Enforce Agent Note lifecycle/class paths and dated filenames. Structural rules
 * are shared with `agent-note-tree.ts`; the closed classification rules live
 * in `.agents/notes/README.md`.
 */
import { walkAgentNoteTree } from './agent-note-tree.ts'
const { notes, errors } = walkAgentNoteTree()
// Keep the former homes unavailable so new notes cannot silently escape this tree.
for (const legacyRoot of ['docs/rfc', 'docs/rfcs']) { ... }
```

**证实它复用已实现的 `agent-note-tree.ts`** —— 判定「已实现」成立。
