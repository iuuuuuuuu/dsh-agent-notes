# Agent Note: 渲染探针的浏览器路径不该硬编码

Status: implemented

> 同属**流程补齐**这条线，接续
> [2026-10-19-logic-in-node-rendering-in-chrome.md](./2026-10-19-logic-in-node-rendering-in-chrome.md)
> ——那一篇确立了「`npm test` 管逻辑、`.probe/` 管渲染」的分工，本篇处理
> **分工的代价**：渲染验证全靠人工，而 6 个探针硬编码本机 Chrome 路径。
> 它也**部分回应**了
> [2026-10-19-zero-dep-was-my-own-self-imposed-shackle.md](../process/2026-10-19-zero-dep-was-my-own-self-imposed-shackle.md)
> 里判定的「渲染探针该进 npm test」那条重访信号。

Independent: 本篇处理的是**浏览器定位**，与门禁判什么、跑多快、跑几轮都无关 ——
它是「让渲染验证从人工变成自动」的**前置条件**。

## Problem

`tools/find-browser.mjs` 存在之前，6 个渲染探针各自硬编码：

```js
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
```

**换机器、换平台就崩。** 这是它们**不能进 `npm test` 的直接原因** —— 而
「界面改动必须真机所见」是本仓库的硬约束，现在这条约束**靠人的记性维持**。

而 `2026-10-19-logic-in-node-rendering-in-chrome` 那篇曾判定「渲染探针进
`npm test`」**暂不做**，理由是「需要本机装 Chrome（硬约束是零依赖、不假定
外部环境）」。那个理由后来被我自己纠正过 —— 「不假定外部环境」说的是**门禁
不能因用户没装 DSH 就失败**，不是「CI 不能装浏览器」。

## Decision

### 一、抽出 `tools/find-browser.mjs`，探针改用它

查找顺序（**显式指定永不猜**）：

1. `$CHROME_PATH`
2. `$PUPPETEER_EXECUTABLE_PATH`（puppeteer 生态的约定变量）
3. `PATH` 里的可执行名
4. 各平台常见安装位置
5. **puppeteer 下载缓存**（CI 里 `npx puppeteer browsers install chrome` 装到那）

找不到时返回 `undefined` 而**不抛异常**，并给出 `explainMissingBrowser()` ——
三条可执行的解决方式。

### 二、退出码用 2 而不是 1

```js
const CHROME = findBrowser().path;
if (CHROME === undefined) {
  console.error(explainMissingBrowser());
  process.exit(2);   // 2 = 无法进行
}
```

「没装浏览器」是**环境问题**，不是「探针失败」。报成 1 会被当成「渲染验证
失败」而误导排查 —— 那正是本仓库反复修的那类问题。2 = 无法进行，与
`verify-notes` / `install-hooks` / `doc-budget` 一致。

### 三、**不引入 puppeteer**（尽管它已经装好并验证可用）

探针是**原生 CDP**（`spawn` Chrome + WebSocket），逻辑完整且已验证有效
（`switch-render.mjs` 470 行：桩 React、`mountFresh()`、盒模型断言）。全部重写
成 puppeteer 是纯浪费，且新写的版本没被充分验证。

所以只解决「**找到浏览器**」这一层，探针其余部分不动。

## Alternatives considered

- **直接引 puppeteer，把探针重写成 puppeteer API** — 更彻底。**这是本篇最强的一条被否方案**，因为它解决的是**不存在的问题**：探针的逻辑没坏，坏的只是「找浏览器」。而且我已实测 `puppeteer-core`（25 包 / 4 秒装完）能启动 Chrome 155.0.8059.82 —— **它能用恰恰说明不需要重写探针**。
- **在 README/AGENTS.md 里写「请先装 Chrome」** — 零代码。否掉因为**「没装」仍然会让探针崩**，而崩掉与「说不清原因」是两种体验。人会以为是探针坏了。
- **把渲染探针直接接进 `npm test`** — 那是这篇笔记被引用的那条重访信号。**本轮不做**：探针要起浏览器（约 1.5 秒/个 × 8 个），会让 check 从 45 秒涨到 1 分钟以上，而 CI 还要装 Chrome。**先把前置条件（自动定位）做好，接进 `npm test` 是下一步**，且该步需要单独决定 CI 装不装浏览器。
- **让探针在找不到浏览器时静默 exit 0** — 零成本。**否掉，因为那是纯假绿**：探针会「通过」而什么都没验，正是本仓库最忌讳的形态。

## Consequences

- **收益**：6 个探针不再绑死某台机器。实测 `visibility.mjs` 与 `switch-render.mjs` **真跑通** —— 后者在真实 Chrome 里验了渲染、交互与窄屏适配（`高度仍是 24px（未被压扁）`、`文案没有溢出按钮`）。
- **收益**：`tools/find-browser.test.mjs` 有 5 个用例，其中**两条真启动 headless Chrome**（读回 DOM、打开本地文件）。**不 mock `spawnSync`** —— mock 掉它，这测试就变成「验证 mock 自己」。
- **代价与已知上限**：探针**仍未进 `npm test`**。所以「界面改动必须真机所见」这条约束**仍然靠人的记性** —— 本篇只拆掉了障碍（硬编码路径），没拆掉最后一环（自动触发）。
- **代价与已知上限**：`findBrowser()` 在 `PATH` 遍历里对每个目录做 `existsSync`，本机约 50 个 PATH 项 × 2 个名字 ≈ 100 次 syscall。**可忽略**，但若 PATH 极长会变慢。
- **代价与已知上限**：puppeteer 缓存的目录结构若变（版本段命名），第 5 层查找会失效 —— 但前 4 层仍能覆盖大多数情况。
- **重访信号**：**把探针接进 `npm test`** —— 前置条件已具备，但要决定两件事：① CI 装不装浏览器（`npx puppeteer browsers install chrome`，约 300MB 下载）；② 找不到浏览器时 check 该红（严格）还是该提示后跳过（宽松）。**倾向严格 + 显式跳过渲染部分**，因为「跳过」必须说明「跳过了什么」。另一个信号：若 PATH 遍历被证明是瓶颈，改成只查常见位置。

## Verification

```sh
node --test tools/find-browser.test.mjs   # 5 个用例（2 个真启动 Chrome）
node .probe/visibility.mjs                # 真跑通，量出 computedDisplay: flex
node .probe/switch-render.mjs            # 真跑通，470 行那个
```

**三层都真跑过，不是推断**：

```
=== 2. 真启动（headless）===
  退出码: 0    拿到 DOM: 是    title 正确: 是 ✔
=== 3. 用它打开一个本地文件 ===
  读到本地文件内容: 是 ✔
```

### 一个被测试抓到的 bug

第一版 `findBrowser()` 有个实现缺陷，**由我自己写的测试抓到**：

设 `$CHROME_PATH=/tmp/fake`（不存在）后，它继续往下探测并**成功返回**，
`tried` 里那句「$CHROME_PATH（已设但文件不存在）」被**丢掉**了。

后果：用户设了路径却被静默忽略，而返回的 `source` 让他以为「用了我的设置」
或「用了自动探测」—— **完全看不出他的显式设置被跳过**。

「显式设置被静默忽略」是最难查的一类问题，因为它**表现得像「设置生效了」**。

修法：`source` 改成始终包含「已跳过」的说明。
