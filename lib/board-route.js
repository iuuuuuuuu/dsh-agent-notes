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
import { resolve, sep } from 'node:path';
import { buildBoard } from './board.js';

/** 路由前缀；与插件名一致，避免与别的插件撞车。 */
export const ROUTE_PREFIX = '/agent-notes';

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
  /** 解析一次请求的目标笔记根；会话不可知时退回默认。 */
  const rootFor = (url) => {
    const sessionId = url.searchParams.get('session') ?? undefined;
    return notesRootFor(sessionId);
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

      const root = rootFor(url);
      if (root === undefined) {
        sendJson(res, 409, { error: 'no notes root resolvable for this session' });
        return;
      }

      if (url.pathname === `${ROUTE_PREFIX}/board`) {
        sendJson(res, 200, buildBoard(root));
        return;
      }

      if (url.pathname === `${ROUTE_PREFIX}/note`) {
        const rel = url.searchParams.get('path');
        if (rel === null || rel.trim() === '') {
          sendJson(res, 400, { error: 'path is required' });
          return;
        }
        /* 拒绝穿越：先拼再校验，且要求落在 root 内。 */
        const target = resolve(root, rel);
        if (!isInside(root, target) || !existsSync(target) || !statSync(target).isFile()) {
          sendJson(res, 404, { error: 'note not found' });
          return;
        }
        sendJson(res, 200, { path: rel, body: readFileSync(target, 'utf8') });
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) });
    }
  };

  /* webServer 是可选能力：拿不到就静默降级（看板不可用，但不影响其他功能）。 */
  let webServer;
  try {
    webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
  } catch {
    webServer = undefined;
  }
  if (webServer === undefined || typeof webServer.register !== 'function') return () => {};

  return webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler });
}
