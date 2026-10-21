# Agent Note: 看板 iframe 保留文档基址的挂载前缀

Status: implemented

## Problem

看板 iframe 使用根绝对路径，部署在带前缀的页面基址下时会丢失挂载前缀。通过实际注册的侧边栏组件渲染 iframe 后，以浏览器 URL 解析规则验证，旧实现对 https://example.test/dsh/ 得到 /agent-notes/ui，而预期是 /dsh/agent-notes/ui。

本决定与[侧边栏转交宿主 props](./2026-10-17-sidebar-tab-drops-host-props.md)互补：既有决定负责会话参数来源，本篇负责资源地址相对于文档基址的解析，不取代既有决定。

## Decision

客户端使用文档相对地址 agent-notes/ui，交由浏览器按 document.baseURI 解析。会话与目录参数继续分别使用 encodeURIComponent 编码，不改变宿主 props 的选择规则。构建产物与源码同步更新。

回归测试通过真实注册路径取得看板组件，检查实际渲染的 iframe 地址，覆盖根基址、单层和多层挂载前缀，以及包含空格、中文和查询分隔符的参数。

## Alternatives considered

- 保留根绝对路径：无需依赖页面基址，适用于根部署；未采用，因为它明确丢失非根挂载前缀。
- 在插件中显式构造绝对 URL：可直接检查最终地址；未采用，因为浏览器已有文档相对地址解析机制，额外构造并未增加当前需求所需的能力。

## Consequences

收益是资源地址遵循页面文档基址，且不新增运行时依赖。代价是依赖宿主正确提供文档基址；本次测试不证明宿主所有路由、反向代理或服务端端点均支持子路径部署。若宿主使用深层路由但未设置相应 base，仍需按真实宿主契约进一步验证。

## Verification

旧实现的新增回归退出 1，实际路径 /agent-notes/ui 与预期 /dsh/agent-notes/ui 不同。修复后客户端测试 21 项通过，npm run build 退出 0。此证据覆盖组件渲染与 URL 解析，不替代真实部署验证，也不表示全部上游对齐工作完成。
