# Agent Note: check-workspace-constraints 整体结构性不适用 —— 它 20 个函数里没有一个是通用不变量

Status: rejected — 逐个读源码注释后确认：全是 monorepo 专属或上游内部约定

> 本轮读缓存里 47 个上游脚本的第五个候选。前四个分别被
> [process-tree-cleanup](./2026-10-19-process-tree-cleanup-not-needed-on-windows.md)、
> [code-block-parity](./2026-10-19-code-block-parity-two-approaches-failed.md)、
> [supersession-archive](./2026-10-19-supersession-archive-rule-not-mechanizable.md)
> 否决；[md-links 空白](../../implemented/testing/2026-10-19-md-links-has-two-gaps-neither-triggered.md)
> 记录后不改。

Independent: 本篇否决一整个上游脚本，不改变任何门禁行为。

## Problem

`up-check-workspace-constraints.ts`（667 行，缓存里最长的之一）：

> Workspace **package invariant** checks for **package-manager-independent**
> quality gates.

「package-manager-independent」这个限定吸引了注意——上游刻意要把约束写成
**不依赖 pnpm 行为**的形式，而本仓库用 npm。若上游有一些约束是
**任何包管理器下都该成立**的，而本仓库只按 npm 写，换工具就会漏。

而本仓库的 `tools/verify-plugin.mjs` 只有 235 行。667 vs 235 看着差很多。

## Proposal

曾考虑过以下做法，逐条列在这里以便日后重新评估：

1. **挑「package-manager-independent」那部分吸收**
2. **用 667 vs 235 的行数差当「我们缺很多」的证据**
3. **什么都不做**

**但均不采纳** —— 理由见 Decision。

## Decision

**整体结构性不适用。** 逐个读源码注释后确认。

### 20 个函数的三类归属

**A. monorepo 专属（本仓库没有那个结构）**

| 函数 | 它查什么（源码注释） |
|---|---|
| `readWorkspaceManifests` | Read the root manifest and every member declared by **pnpm-workspace.yaml** |
| `checkWorkspaceManifest` | Check one workspace manifest against **publication and dsh-package policy**（117 行） |
| `checkHierarchyShape` | Enforce `packages/<group>/<pkg>` |
| `checkDshFamilyVersion` | —— |
| `checkExperimentalManifest` | **Experimental** manifest requirements |
| `checkWorkspaceProtocol` | —— |
| `expectedDshPackageFiles` | canonical **publication** patterns（63 行） |

**C. 上游内部约定（与本仓库无关）**

`exportFields` / `isExportList` / `hasExportPair` / `exportDefault` /
`exportCondition` / `usesEmittedTreeDefaults` —— 全部是 **TypeScript 源码
导出面**检查（conditional exports、`.d.ts` 配对）。

★ **本仓库是纯 JS 插件**，没有 `.d.ts`，没有 `exports` 条件面 ——
这些函数连输入都不存在。

**B. 任何 npm 包都该成立 → 空**

只剩 `readJson` / `sameStringList` 两个，**它们是工具函数，不是检查项**。

### 所以

**上游那 20 个函数里，没有一个是「任何包都该查但本仓库没查」的通用不变量。**

不是「挑几个吸收」，是**整体不适用**。

### 依赖也印证了这一点

```
上游的 import：
  node:fs  node:path  node:url
  js-yaml
  ./publication-payload.ts
  ../packages/util/package-manifest/src/types.ts     ← 上游内部包
  ../packages/boot/app-boot/src/profile.ts          ← 上游内部包
  ./project-reference-faces.ts
```

**它 import 的是上游自己的 `packages/boot/app-boot` 与 `packages/util/…`**——
本仓库连那些目录都不存在。

## Alternatives considered

- **挑「package-manager-independent」那部分吸收** — 标题最吸引人。**这是本篇最强的一条被否方案**，因为读源码后确认：**那 20 个函数没有一个是包管理器无关的不变量**。「independent」修饰的是**实现方式**（不依赖 pnpm 的行为来推断），不是**检查内容**。**照搬标题会搬错东西。**
- **用 667 vs 235 的行数差当「我们缺很多」的证据** — 直观。**否掉因为行数不可比**：上游管整个 monorepo（`packages/<group>/<pkg>` 两层结构、pnpm workspace、TS 导出面、实验包策略），本仓库管一个单包插件。这正是我这轮反复栽的形态——**用数字的差距代替内容的核对**。
- **什么都不做** — **这是本篇的决定**。

## Consequences

- **收益**：把一个「667 行 vs 235 行」的模糊不适感，**转成了逐函数核对的确定结论**。
- **收益**：记下了判据 —— **上游脚本标题里的限定词修饰的是实现方式，不是检查内容**。「package-manager-independent」不等于「有包管理器无关的检查」。
- **代价与已知上限**：本仓库的 `verify-plugin.mjs` 仍然只查它那几项（零 `@deepseek-ai` 依赖、vendored 哈希、双语文档、徽标、包元数据）。**若将来本仓库变成 workspace**，那时这些约束才有意义。
- **重访信号**：
  - **本仓库引入 pnpm workspace 或变成多包** → 立刻重新评估这个脚本（`checkHierarchyShape` / `checkWorkspaceProtocol` 会直接适用）。
  - **本仓库开始发布 TypeScript 声明（`.d.ts`）** → `exportFields` / `hasExportPair` 那组会适用。
  - 若本仓库开始有「实验性包」策略 → `checkExperimentalManifest` 适用。

## Verification

```sh
node .probe/tmp/read-workspace-constraints.mjs       # 列函数与 import
node .probe/tmp/classify-workspace-constraints.mjs   # 逐个读注释并分类
```

实测（源码注释节选）：

```
readWorkspaceManifests   Read the root manifest and every member declared by
                         pnpm-workspace.yaml.
checkWorkspaceManifest   Check one workspace manifest against publication and
                         dsh-package policy.
checkHierarchyShape      Enforce `packages/<group>/<pkg>`: groups are open-named
                         containers without a package.json
expectedDshPackageFiles  Compute canonical publication patterns …（63 行）
exportFields             Fields of a conditional export; scalar and list targets
                         have no named conditions.
hasExportPair            Whether one conditional export exactly names the
                         generated runtime and declaration pair.
```

**本轮读它时特意核对了每个函数前面的块注释，而不是只看函数名** ——
上一轮 `verify-agent-note-classification` 我读文件名就判「不适用」，
后来读源码才发现它复用了已实现的逻辑。**判定必须读源码，不能读文件名。**