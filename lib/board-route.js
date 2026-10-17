/**
 * 看板的 HTTP 通道：把笔记树实时送到浏览器。
 *
 * 为什么需要它：浏览器侧读不到文件系统，而笔记内容在磁盘上、随时可能被
 * 编辑器改动。会话投影的 `view` 是同步纯函数（只能读会话日志折叠出的 state），
 * 装不下磁盘内容，所以走一条只读的 HTTP 路由。
 *
 * 安全边界（重要）：
 *   - 路由路径固定，不接受任意路径参数；
 *   - 只能读 `notesRoot` 之下的文件，且拒绝任何 `..`；
 *   - 只返回笔记内容，不返回目录列表以外的任何本机信息。
 *
 * 零依赖：只用 node 内建。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoardFromRoots, buildInlineData } from './board.js';
import { injectResponsiveCss } from './board-responsive.js';

/** 路由前缀；与插件名一致，避免与别的插件撞车。 */
export const ROUTE_PREFIX = '/agent-notes';

/** 官方看板 HTML 的位置（vendored 上游资产，不手改）。 */
const BOARD_HTML = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'skills', 'agent-notes', 'assets', 'agent-notes-board.html'
);

/**
 * 判断 target 是否真的在 root 之内（防路径穿越）。
 *
 * 不用 `startsWith(root)` 裸比较：`/a/bc` 会被 `/a/b` 误判为子路径。
 * 必须带上分隔符，或完全相等。
 *
 * @param {string} root 允许的根。
 * @param {string} target 待检查路径。
 * @returns {boolean} 是否在根内。
 */
export function isInside(root, target) {
  const a = resolve(root);
  const b = resolve(target);
  return b === a || b.startsWith(a.endsWith(sep) ? a : `${a}${sep}`);
}

/**
 * 渲染一张可读的「暂时读不到笔记」说明页。
 *
 * 为什么不是 JSON：`/agent-notes/ui` 是 iframe 的 src，浏览器会原样渲染
 * 响应体。回 JSON 时用户看到的就是一坨 `{"error":...}`，看着像插件坏了；
 * 而真实成因通常只是「这个 tab 指向的会话还没加载」。
 *
 * 页面刻意极简、内联样式、不引外部资源 —— 它在出错路径上，不能依赖任何
 * 可能同样失败的东西。会话 id 原样回显（已做 HTML 转义），便于排查。
 *
 * @param {{ reason: string, hint: string, sessionId: string }} info 诊断信息。
 * @returns {string} HTML 文本。
 */
export function renderNoticePage({ reason, hint, sessionId }) {
  const escape = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>笔记看板 · 暂时读不到</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font: 14px/1.7 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f8fafc; color: #0f172a; padding: 24px;
  }
  .card {
    max-width: 520px; width: 100%; background: #fff; border: 1px solid #e2e8f0;
    border-radius: 10px; padding: 24px 26px; box-shadow: 0 1px 3px rgba(15,23,42,.05);
  }
  h1 { font-size: 15px; margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #d97706; flex: 0 0 auto; }
  p { margin: 0 0 10px; color: #475569; font-size: 13.5px; }
  .tip { background: #f1f5f9; border-radius: 6px; padding: 10px 12px; font-size: 13px; color: #334155; }
  code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11.5px;
    background: #f1f5f9; padding: 1px 5px; border-radius: 4px; color: #64748b;
    word-break: break-all;
  }
  .meta { margin-top: 14px; font-size: 11.5px; color: #94a3b8; }
  @media (prefers-color-scheme: dark) {
    body { background: #0b1220; color: #e2e8f0; }
    .card { background: #111a2e; border-color: #1e293b; }
    p { color: #94a3b8; }
    .tip { background: #16203a; color: #cbd5e1; }
    code { background: #16203a; color: #94a3b8; }
  }
</style>
</head>
<body>
  <div class="card">
    <h1><span class="dot"></span>笔记看板暂时读不到</h1>
    <p class="tip">${escape(hint)}</p>
    <p>点一下别的会话再切回来，或者关掉这个「笔记」tab 重新打开，通常就能恢复。</p>
    <div class="meta">
      成因 <code>${escape(reason)}</code><br>
      会话 <code>${escape(sessionId === '' ? '(空)' : sessionId)}</code>
    </div>
  </div>
</body>
</html>`;
}

/**
 * 写一个 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} res 响应对象。
 * @param {number} code HTTP 状态码。
 * @param {any} value 待序列化的值。
 */
function sendJson(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * 注册看板路由。
 *
 * 提供三个端点（全部只读）：
 *   GET /agent-notes/board           —— 整棵树的快照（含正文）
 *   GET /agent-notes/note?path=...   —— 单篇正文（path 是相对 notesRoot 的路径）
 *   GET /agent-notes/health          —— 探活，用于诊断路由是否真挂上
 *
 * @param {any} ctx Cordis 上下文。
 * @param {{ notesRootFor: (sessionId?: string) => string | undefined }} deps 依赖。
 * @returns {() => void} 注销函数；webServer 不可用时返回空函数。
 */
export function registerBoardRoutes(ctx, { notesRootFor }) {
  /**
   * 解析一次请求的目标笔记根。
   *
   * `notesRootFor` 可以返回**数组**：一个仓库可能有多个 git worktree，
   * 笔记散落在各自的工作树里，只取一个会让别的消失。统一成数组处理。
   *
   * @param {URL} url 请求 URL。
   * @returns {string[] | undefined} 笔记根列表；undefined 表示解析不出。
   */
  const rootsFor = (url) => {
    /* 空串必须归一化成 undefined：`?session=` 是「没传会话」而不是「会话 id 为空」。
       不归一化时，空串会被当成合法 id 一路查下去（sessions.get('') → 无 header
       → NO_CWD），最终同样回 409，但诊断指向「会话没有记录工作目录」——
       而真实原因是前端没把会话 id 传过来（实测：侧边栏宿主 props 被丢弃时
       就是 `?session=`，报错信息把人引向了错误的方向）。 */
    const raw = url.searchParams.get('session');
    const sessionId = raw === null || raw.trim() === '' ? undefined : raw;
    const value = notesRootFor(sessionId);
    if (value === undefined || value === null) return undefined;
    const list = Array.isArray(value) ? value : [value];
    const cleaned = list.filter((r) => typeof r === 'string' && r !== '');
    return cleaned.length === 0 ? undefined : cleaned;
  };

  const handler = (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }

      /* 探活：不依赖任何文件，用来区分「路由没挂上」和「笔记树为空」。 */
      if (url.pathname === `${ROUTE_PREFIX}/health`) {
        sendJson(res, 200, { ok: true, prefix: ROUTE_PREFIX });
        return;
      }

      const roots = rootsFor(url);
      if (roots === undefined) {
        /* 诊断要能区分两种成因，否则只会把人引向错的方向：
           ① 前端没带 session（`?session=` 空串）—— 多半是宿主 props 没传下来；
           ② 带了 session 但解析不出仓库（会话尚未加载 / header 无 cwd）。 */
        const raw = url.searchParams.get('session');
        const missing = raw === null || raw.trim() === '';
        const reason = missing ? 'MISSING_SESSION_ID' : 'NO_NOTES_ROOT';
        const hint = missing
          ? '请求没带 session 参数（或为空串）：宿主侧组件可能没有把会话 id 传下来。'
          : '该会话尚未加载或没有记录工作目录。持久化的看板 tab 可能仍指向旧会话 —— '
            + '切到该会话或重新打开这个 tab 通常即可恢复。';

        /* `/ui` 是 iframe 直接加载的页面：回 JSON 会让用户看到一坨原始
           JSON（实测截图就是这样，看着像插件坏了）。这里给一张可读的
           说明页，并把会话 id 与成因写清楚，便于用户自己恢复。 */
        if (url.pathname === `${ROUTE_PREFIX}/ui`) {
          const html = renderNoticePage({ reason, hint, sessionId: raw ?? '' });
          res.writeHead(409, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(html)
          });
          res.end(html);
          return;
        }

        sendJson(res, 409, { error: 'no notes root resolvable for this session', reason, hint });
        return;
      }

      /* 官方看板 UI：把 vendored 的成品 HTML 原样吐出，只把实时数据
         注入到它预留的 `window.__INLINE_DATA__` 插槽。
         这样视觉与交互完全跟随上游更新，本插件不维护任何 UI。 */
      if (url.pathname === `${ROUTE_PREFIX}/ui`) {
        if (!existsSync(BOARD_HTML)) {
          sendJson(res, 503, { error: 'board asset missing', path: BOARD_HTML });
          return;
        }
        const html = readFileSync(BOARD_HTML, 'utf8');
        const data = buildInlineData(roots);
        /* 把 JSON 塞进 <script> 时必须挡住「提前闭合」：
           笔记正文里完全可能引用 HTML 片段（本仓就有一篇引了看板的源码），
           其中的 `</script>`、`</aside>`、`<!--` 会让解析器把后面的内容
           当成正文，脚本从中间被截断 —— 表现为页面空白、计数恒为 0。
           最稳的做法是把每个 `<` 都转成 `\u003c`（JSON 合法转义，解析后
           字符串值不变），这样数据里无论出现什么标签都不可能闭合脚本块。 */
        const payload = JSON.stringify(data).replace(/</g, '\\u003c');
        const marker = 'window.__INLINE_DATA__ = null;';
        /* 必须用函数式 replace：payload 里含 `$&`、`$'` 这类片段时，
           字符串替换串会把它们当成「反向引用」展开，导致数据被替换成
           原 HTML 的片段 —— 表现为页面里凭空多出 <script 标签、数据被截断。 */
        const withData = html.includes(marker)
          ? html.replace(marker, () => `window.__INLINE_DATA__ = ${payload};`)
          : html;
        /* 窄屏适配层：右侧栏只有 400–700px，上游顶栏是固定 64px 且不换行，
           子项会被压成逐字竖排（实测 652px 下 brand-group 高 154px）。
           看板 HTML 是 vendored 资产不能手改，所以在这里注入覆盖样式。 */
        const injected = injectResponsiveCss(withData);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(injected)
        });
        res.end(injected);
        return;
      }

      if (url.pathname === `${ROUTE_PREFIX}/board`) {
        sendJson(res, 200, buildBoardFromRoots(roots));
        return;
      }

      if (url.pathname === `${ROUTE_PREFIX}/note`) {
        const rel = url.searchParams.get('path');
        if (rel === null || rel.trim() === '') {
          sendJson(res, 400, { error: 'path is required' });
          return;
        }
        /* 依次在各笔记根里找：同一相对路径可能存在于不同 worktree。
           每个候选都必须过 isInside（拒绝 `..` 穿越与「前缀相同但不是子路径」），
           命中第一个就返回 —— 与看板列表的去重顺序一致（当前工作树优先）。 */
        for (const root of roots) {
          const target = resolve(root, rel);
          if (!isInside(root, target)) continue;
          if (!existsSync(target) || !statSync(target).isFile()) continue;
          sendJson(res, 200, { path: rel, body: readFileSync(target, 'utf8'), root });
          return;
        }
        sendJson(res, 404, { error: 'note not found' });
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) });
    }
  };

  /* webServer 是可选能力，但**必须用 ctx.inject 等它就绪**，不能用
     `ctx.get('webServer')` 现取一次：apply 跑的那一刻 webServer 往往还没
     注册完，现取只会拿到 undefined，于是路由永远不挂上（实测：重启后
     /agent-notes/health 恒 404，看板一片空白）。ctx.inject 会等声明就绪，
     与 lib/projection.js 注册会话投影、客户端侧 slots.inject 是同一个模式。 */
  if (typeof ctx.inject !== 'function') return () => {};
  ctx.inject(['webServer'], (subCtx) => {
    const webServer = subCtx.webServer;
    if (webServer === undefined || typeof webServer.register !== 'function') return;
    return webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler });
  });
  /* 注销由 Cordis 的 effect 生命周期接管，这里不需要额外的 disposer。 */
  return () => {};
}
