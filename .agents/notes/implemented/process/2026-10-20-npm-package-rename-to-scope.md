# Agent Note: npm 包名改成 scope 形式 —— 三次 E403 才拿到实证

Status: implemented

> 续 [2026-10-19-npm-gates-fail-under-node-modules.md](../bug-fix/2026-10-19-npm-gates-fail-under-node-modules.md)
> —— 那篇解决了「装成包后门禁跑不起来」。本篇是发包本身卡住，
> 以及改名时**哪些该改、哪些绝对不能改**。
> 改动不重叠：那篇管运行时机制，本篇管包名与归属。

Independent: 那篇讲 node_modules 下的执行机制；本篇讲 npm 的发布策略与
包名作用域边界。两者没有共享实现。

## Problem

发 `npm publish` 连续三次 E403，三次的报错信息**一字不差**：

```
403 Forbidden - Two-factor authentication or granular access token
              with bypass 2fa enabled is required to publish packages.
```

★ **那句话把两件事混在一句里，而两次都不是它说的那个原因。**

### 三次尝试与两次错误猜测

| 次 | token 的实际状态 | 我以为的原因 | 实际 |
|---|---|---|---|
| ① | `auth-type: web` | 没有发布权限 | ✔ 对（web 登录 token 确实不能发） |
| ② | `bypass_2fa: **false**` | 还是 2FA | ✔ 对 |
| ③ | `bypass_2fa: true`，scope = `@iuuuuuuuu` + org `iuuuuuuuuu` | **猜是 scope 问题** | ✘ **猜错了**，scope 已经覆盖不到无 scope 的包名 —— 但真正的限制还没查到 |
| ④ | `bypass_2fa: true`，scope = **`null`（所有包）** | — | ✘ 仍失败 |

第 ④ 次连 scope 都放开了还是拒，才意识到**前三次都在猜**。

### 真正的根因（拿到实证的方式）

直接向 registry 发一个**故意非法**的 PUT：

```sh
curl -X PUT -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d '{"name":"dsh-agent-notes","versions":{...}}' \
  https://registry.npmjs.org/dsh-agent-notes
```

返回的不是 403，而是：

```
Packument must include a valid _id field (package name).
```

**认证过了。** 再查账号接口：

```sh
curl -H "Authorization: Bearer $T" \
  https://registry.npmjs.org/-/org/iuuuuuuuuu/package?format=cli
```

```
You may not perform that action with these credentials.
```

★ 结论：**token 无权访问 `iuuuuuuuuu` 这个 org**。而 npm 对**首次发布**有硬要求：
**包名必须归属你的账号或 org**。`dsh-agent-notes` 不属于 `iuuuuuuuuu`，所以发不上去。

**判据**：报错信息是给人看的提示，不是原因。拿实证的方式是
**构造一个能区分假设的最小请求** —— 那个故意非法的 PUT 就是。

## Decision

**npm 包名改为 `@iuuuuuuuu/agent-notes`**（scope 形式，与账号一致）。

### ★ 改什么、不改什么 —— 这是本篇最要紧的部分

| 改 | 不改 |
|---|---|
| `package.json` 的 `name` | 目录名（仓库仍叫 dsh-agent-notes） |
| `package-lock.json` 两处 `name` | README 里的 dsh-agent-notes |
| `tools/verify-plugin.mjs` 的包名断言 | 所有笔记里的 dsh-agent-notes |
| `THIRD_PARTY_NOTICES.md` 里的包名 | |
| **`cordis.patch.yml` 的 `name`** | |

> ⚠️ **本表原先把 `cordis.patch.yml` 的 `name` 列在「不改」里，那是错的，
> 已造成一次线上故障**（插件客户端半边在发版后静默消失）。更正与原因见
> [2026-10-20-patch-name-is-a-module-specifier.md](2026-10-20-patch-name-is-a-module-specifier.md)。
> 一句话：`cordis.patch.yml` 的 `name` **不是**界面显示名，而是宿主拿去
> `import` 的**模块 specifier**；改了包名却不改它，宿主解析不到，
> 客户端半边被静默跳过。

★ 而 `lib/client.js` 那处**确实要改**（包名变了，门禁
`verify-plugin.mjs:130` 要求信封 id 等于 `pkg.name`，否则客户端加载不了）——
这一点我一开始判断错了，是**门禁拦下来的**：

```
✖ lib/client.js 的信封 id 必须等于包名（否则客户端加载不了）
```

所以改完必须 `npm run build` 重新生成 bundle。

## Alternatives considered

- **不用 npm 发布，继续用 GitHub tag + 手动安装** —— 零门槛。**否掉因为用户明确要发 npm 包**，而 npm 生态里「装插件」迟早要走 registry。
- **建一个名为 `dsh-agent-notes` 的 npm org** —— 能保住原包名。**否掉因为要额外走组织创建 + 邀请成员，而 scope 形式一步到位且语义更清楚**（`@某人/包` 明示归属）。
- **换用 `npm login` 的传统 token** —— 实测 `auth-type: web` 的 token 无发布权限，而 npm 现在要求 granular token。**否掉因为这不是可选路径，是现行策略。**

## Consequences

- **收益**：包名归属清晰（`@iuuuuuuuu/agent-notes` 明示归属），且能发布。
- **代价与已知上限**：npm 包名与仓库名/DSH 插件名**不再一致**（仓库与插件仍叫 `dsh-agent-notes`）。使用者若按包名搜会找不到，得按 `@iuuuuuuuu/agent-notes`。
- **代价与已知上限**：`tools/verify-plugin.mjs` 只断言 `pkg.name` 等于那一个名字 —— 若将来再改包名，仍要改它。**没有做成「从 package.json 读期望值」是因为那个断言的意义正是「防止有人手改包名」。**
- **代价与已知上限**：验证脚本也要认 scoped 名 —— npm 把 tarball 打成 `scope-name-0.0.0.tgz`（`/` 换 `-`），自己拼名字会 ENOENT。已改用 `npm pack --json` 的 `filename` 字段（npm 自己算的权威答案）。
- **重访信号**：
  - **若将来把这个包挪进某个组织** → 包名变 `@组织名/...`，`verify-plugin.mjs` 与 `package-lock.json` 要跟着改。
  - **若 npm 放宽「包名须归属」的策略** → 可以拿回无 scope 的短名，但那时 `verify-plugin.mjs` 的断言也要改回去。

## Verification

```sh
npm run check    # exit 0（340 测试）
```

- `verify-plugin`：包清单、patch 一致性、零 `@deepseek-ai` 依赖、双语文档与 dsh 徽标、vendored 哈希**均一致**
- **真机验证 9 条全过**（scoped 名下重新跑）：装进 `node_modules` 后门禁真跑通
  （`ok: 68 note(s)`），三个门禁脚本逐一 exit=0

★ 包名改了之后**必须重跑那 9 条** —— 之前的验证是旧包名下做的。
改名影响打包、安装路径、loader id，不重验等于没验。

### 一条方法教训

**报错信息是提示，不是原因。** 同一句 E403 背后是三个不同的问题
（无发布权限 / 2FA 未绕过 / 包名不归属），而那句话把三者并列在一起。

拿实证的方式不是再读一遍那句报错，而是**构造一个能区分假设的最小请求** ——
本篇用的就是「故意非法的 PUT」：它返回了 payload 错误而非 403，
**一眼就把「认证/权限问题」与「请求内容问题」分开了**。
