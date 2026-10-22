# Agent Note: 发版记账要有门禁，因为「发版需许可」是纪律不是机制

Status: implemented

> 同属**完整流程补齐**这一组。
> 归属声明见
> [2026-10-19-third-party-notices-are-part-of-distribution.md](./2026-10-19-third-party-notices-are-part-of-distribution.md)，
> 断链门禁见 [2026-10-19-markdown-links-need-a-gate.md](./2026-10-19-markdown-links-need-a-gate.md)，
> 双语一致性见
> [2026-10-19-bilingual-docs-compare-structure-not-length.md](./2026-10-19-bilingual-docs-compare-structure-not-length.md)。

Independent: 本篇处理的是**发布流程的记账一致性**，与前面三项的失效面都不同：归属是法律、链接是可达性、双语是同步，而这里是「发布说明与实际版本对得上」。

## Problem

仓库里已有三块发版相关的东西：

- `tools/bump-version.mjs` —— 递增版本号，职责单一，不碰 git；
- `tools/version.test.mjs` 的一条用例 —— 守着「`package.json` 版本 == 最新 `git tag`」；
- `CHANGELOG.md` —— 格式对齐 Keep a Changelog，有 `[Unreleased]` 段。

但 **CHANGELOG 完全无人管**。三条真实失效路径：

1. 版本号改了、tag 打了，CHANGELOG 里没有对应段 → 用户看到的发布说明是空的；
2. CHANGELOG 里写了 `[0.6.0]`，包还是 `0.5.0` → 说明与实际不符；
3. 同一版本出现两个段、日期格式不统一 → 记账本身不可信。

### 为什么这件事的分量比「文档完整性」更重

本仓库有一条硬性工作纪律：**发版必须先获得用户明确许可**（改版本号、
打 tag、推送版本都算发版）。

这类纪律如果没有机制支撑，迟早会靠不住 —— 它依赖的是「每次都记得」，
而多轮对话里注意力会被别的事占满。这与本仓库当初做覆盖门禁的起因完全
同型：连续 5 次改 CI 配置一篇笔记没写，靠的是「记得」，结果没记住。

把「版本 / tag / CHANGELOG 三者对得上」变成机器可判定的一刻，纪律才有落点。

## Decision

新增 `tools/release-check.mjs`（`npm run release:check`，已接入 `check` 与 CI）：

1. `package.json` 当前版本**必须**在 CHANGELOG 有对应版本段；
2. 版本段不得重复（语义化版本不允许复用版本号）；
3. 版本段必须严格递减（文件里最新版本在前）；
4. 每个版本段必须带 `YYYY-MM-DD` 日期；
5. `[Unreleased]` 是唯一允许无日期的段；**存在时必须有内容** ——
   空段说明「攒着不发」，而攒到什么时候此前完全看不见。

`must`：**不检查 CHANGELOG 的内容是否准确**。判断「这段文字是否描述了本次
变更」是语义问题，做不成可靠门禁，硬做会产出误报而误报的门禁会被绕过。
本门禁只保证结构对得上，内容准确性仍靠 review。这条写进了代码注释，
避免下一个维护者以为它漏了功能。

`must`：**不检查 tag 是否已打**。`version.test.mjs` 已经守着 `package.json ↔ tag`，
这里重复会变成两套可能互相矛盾的判断。发 tag 是发版动作，不是 CHANGELOG 的属性。

### 顺带补的 CHANGELOG 内容

`[Unreleased]` 段此前是空的 —— 本轮三轮补齐的 notices / md:links /
docs:bilingual 三项，以及注册状态机修复、`build` 脚本、两处测试稳定性修复、
CI 的 `npm ci`，全都没进 CHANGELOG。已补齐。

## Alternatives considered

- **做一个 `release` 脚本，像上游那样把 bump/tag/publish 全串起来** — 上游 `deepseek-ai/deepseek-harness` 有 `scripts/release/bump.ts`、`release:verify`、`release:pack`、`release:publish` 一整套。看起来更完整。否掉是因为它与本仓库的硬约束冲突：发版**必须先获得用户明确许可**，一个「一键 bump + tag + publish」的脚本恰恰是把最需要人确认的动作自动化了。而且这个仓库的发布就是「改版本号 + 打 tag + 推」，没有 pack / publish / 多包联动那套复杂度。为三步做的事造一个自动化流水线，是把人的确认点换成了脚本的便利。**若将来要发到 npm 而不是 git tag，才该重评这条。**
- **把 CHANGELOG 检查塞进 `version.test.mjs`** — 它已经在管版本，少一个文件。否掉是因为两者运行方式不同：`version.test.mjs` 是 `npm test` 的一部分（每次都跑），而发版记账的失败含义是「发布说明与实际不符」，属于流程门禁而非单元测试。塞进去会让 `npm test` 承担流程职责。
- **只做「当前版本有对应段」这一条** — 覆盖最常见的失效，其余不管。否掉是因为空 `[Unreleased]` 恰好是本仓库当下的真实状态（补 CHANGELOG 之前它就是空的），而那正是最该被看见的一种「攒着不发」。
- **要求 `[Unreleased]` 永远存在** — 统一格式，不允许删。否掉是因为「没有未发布内容」时留一个空段是噪音，而空段本身又该被报错 —— 两个要求互相矛盾。正确做法是：**有内容就必须存在，没内容就可以不存在**，两条规则各管一半。

## Consequences

- **收益**：发版流程第一次有了机器可判定的落点。10 个测试，输入层故障注入 9/9 全部符合预期（含 3 条绿灯对照：删掉 Unreleased 段、往 Unreleased 攒内容、升版本号并同步加段都必须放行）。
- **收益**：`[Unreleased]` 为空会红。这直接对应「攒着不发却看不见」—— 本仓库补 CHANGELOG 之前就处于这个状态。
- **代价与已知上限**：只管结构不管内容。一段写错了但格式正确的说明，本门禁放行。
- **代价与已知上限**：`version.test.mjs` 与本门禁各管一半记账（前者管 tag，后者管 CHANGELOG）。两套判断理论上可能互相矛盾（例如 tag 打了但 CHANGELOG 没段 —— 这时 tag 测试绿、CHANGELOG 测试红）。目前没有测试断言「两个门禁不冲突」，若将来有人改动其中一条的判定口径，那种矛盾不会被自动发现。
- **重访信号**：若开始发到 npm（而非仅 git tag），`package.json` 的 `files` 白名单、`publishConfig`、以及打包产物的完整性都需要新的门禁 —— 那时应该引入上游那套 `release:pack` + `verify-packed-install`，并重新评估上面那条「不做一键发版脚本」的结论。

## Verification

```sh
npm run release:check                  # 当前 package.json 0.5.0 与 CHANGELOG 对得上
node --test tools/release-check.test.mjs  # 10 个用例
npm run gate:fault-injection           # 含「自证清单必须有真实用例」
```

故障注入（已实测，输入层 9/9）：版本号无对应段、同一版本出现两次、版本顺序
不是最新在前、版本段缺日期、日期格式不对、`[Unreleased]` 为空 —— 各自变红；
删掉 `[Unreleased]` 段、往 Unreleased 攒内容、升版本号并同步加段 —— 各自放行。

其中「版本顺序」那条的构造踩了个坑：最初用两次字符串 `replace` 试图打乱
顺序，但第二次会命中第一次刚改出来的文本，结果根本没打乱，门禁当然不红。
**那是探针的错，不是门禁的错** —— 必须整段对调。教训写进了测试注释。
