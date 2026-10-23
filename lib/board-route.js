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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoardFromRoots, buildInlineData } from './board.js';
import { injectMarkdownTables } from './board-markdown.js';
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
 * 取一段文本的前 N 行（不去掉末尾换行符之前的空白，原样保留）。
 *
 * 用途：`/data` 端点给 `rawBody` 瘦身。上游只用第 3 行做 crux，
 * 发整篇原文纯属浪费带宽 —— 实测占响应体 53%。
 *
 * 边界：非字符串或空值原样返回，避免把 `undefined` 变成字符串 "undefined"。
 * 行数不足时原样返回（本来就短，没必要再算）。
 *
 * @param {any} text 原文。
 * @param {number} lines 保留的行数。
 * @returns {any} 裁剪后的文本，或原值。
 */
export function firstLines(text, lines) {
  if (typeof text !== 'string' || text === '') return text;
  const parts = text.split('\n');
  if (parts.length <= lines) return text;
  return parts.slice(0, lines).join('\n');
}

/**
 * 给一份看板数据算一个内容指纹。
 *
 * 用途：轮询端点让页面判断「有没有变化」，只有变了才重绘 —— 无变化时
 * 重绘会让用户正在看的视图（滚动位置、打开着的抽屉）莫名跳动。
 *
 * 为什么要真算内容而不是只看「篇数 + mtime」：
 *   - 只比篇数：改一篇笔记的内容、篇数不变 → 察觉不到（正是本次要修的 bug）；
 *   - 只比 mtime：某些编辑器会保留 mtime，改了内容却看不出；
 *   - 篇数 + mtime 看似够，但多根（worktree）合并时 mtime 精度与来源都不稳。
 * 因此直接对**整篇笔记的每个字段**做哈希 —— 不维护字段清单。
 *
 * 为什么不列清单（2026-10-23 兑现过的一条已知上限）：
 *   `buildInlineData` 今天给的字段里有 `slug` 与 `rawBody`，而当年的清单里
 *   两个都没有；上游哪天再给笔记加一个渲染字段，清单式判据会**静默漏报**：
 *   改了内容、页面不刷新、日志里什么都没有。清单得靠人记得同步，而漏报
 *   没有任何信号；反过来「多算了某个字段」只是多重绘一次，成本可见。
 *   所以按**字段名排序后逐个写进摘要**，陌生字段照样计入，字段的出现/
 *   消失本身也算变化。
 *
 * 内容一变指纹必变，只是空白/换行变化也会变 —— 宁可多重绘一次，也不要
 * 漏掉真实修改。
 *
 * @param {Array<object>} notes `buildInlineData` 的结果。
 * @returns {string} 16 进制摘要。
 */
/* 分隔符用字符串常量表达，不把裸控制字符写进源码：
   本仓库的 tools/text-integrity.mjs 会把源码里的裸控制字符判成失败
   （它自己的注释也这么说：通常是脚本拼接时漏了转义）。 */
const FIELD_SEP = String.fromCharCode(0x00);
const FIELD_NULL = String.fromCharCode(0x02);
const RECORD_SEP = String.fromCharCode(0x01);

export function revisionOf(notes) {
  const h = createHash('sha256');
  for (const note of notes) {
    /* 字段名排序后逐个写入：顺序稳定（同一份内容恒定同一指纹），
       集合开放（不认识的字段也计入）。值统一按字符串/JSON 处理，
       数组与对象用 JSON（数组顺序是内容的一部分，不改写）。 */
    for (const key of Object.keys(note).sort()) {
      h.update(key);
      h.update(FIELD_SEP);
      const value = note[key];
      if (value === null || value === undefined) {
        h.update(FIELD_NULL);
      } else if (typeof value === 'string') {
        h.update(value);
      } else {
        h.update(JSON.stringify(value));
      }
      h.update(FIELD_SEP);
    }
    /* 记录分隔：不同笔记之间必须可区分，否则「A 字段挪到 B」这类
       重排会被算成同一份内容。 */
    h.update(RECORD_SEP);
  }
  return h.digest('hex').slice(0, 16);
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
  <script>
  (function () {
    /* 自动重试：这张页面最常见的原因是「会话还没加载完就被请求了」（DSH 重启后
       持久化的 tab 就会这样）。会话加载是几秒内的事，所以这里定时重试，
       成功就自动跳进看板 —— 用户不需要知道要手动刷新。
       用 location.replace 而不是赋值 href：不往历史里塞重复条目。 */
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (tries > 12) { clearInterval(timer); return; }
      fetch(location.href, { method: 'GET', cache: 'no-store' }).then(function (res) {
        if (res.status === 200) {
          clearInterval(timer);
          location.replace(location.href);
        }
      }).catch(function () { /* 网络还没好，下一轮再试 */ });
    }, 2500);
  })();
  </script>
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
 * @param {{
 *   notesRootFor: (sessionId?: string) => string | string[] | undefined,
 *   notesRootsForCwd?: (cwd: string) => string[]
 * }} deps 依赖。
 * @returns {() => void} 注销函数；webServer 不可用时返回空函数。
 */
export function registerBoardRoutes(ctx, { notesRootFor, notesRootsForCwd }) {
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

  /**
   * 用前端带来的 `cwd` 兜底解析笔记根。
   *
   * 为什么需要（实测）：DSH 重启后，浏览器里持久化的「笔记」tab 会在**会话
   * 尚未加载进服务端**时就发起请求；`sessions.get(id)` 那时返回 undefined，
   * `resolveTargetCwd` 只能回 NO_CWD，于是渲染出「暂时读不到」说明页 ——
   * 而用户明明就在那个会话里。等会话加载完刷新就好，但用户不会知道要刷新。
   *
   * 为什么这个兜底**不是猜**：`cwd` 是宿主 client list summary 里的会话工作
   * 目录（dsh-better-sidebar 的 `SessionScope.cwd`，见其 service.d.ts），
   * 由前端按当前活跃会话填好再送过来 —— 它是宿主声明的会话事实，不是本插件
   * 从别处推断的。这与「随便取一个活跃会话的 cwd」有本质区别：后者会在多项目
   * 并行时指向别人的仓库（假绿门禁的成因），前者就是本会话自己的目录。
   *
   * 边界：只在 server 侧解析失败时使用；cwd 必须是绝对路径，否则忽略。
   *
   * @param {URL} url 请求 URL。
   * @returns {string[] | undefined} 笔记根列表；拿不到有效 cwd 时 undefined。
   */
  const rootsFromClientCwd = (url) => {
    const cwd = url.searchParams.get('cwd');
    if (cwd === null || cwd.trim() === '') return undefined;
    /* 没有注入 cwd 解析器时不做这件事（保持旧行为，不猜）。 */
    if (typeof notesRootsForCwd !== 'function') return undefined;
    const value = cwd.trim();
    /* 只接受绝对路径：相对路径在不同进程目录下会指向别处，等同于猜。 */
    if (!isAbsolute(value)) return undefined;
    let list;
    try {
      list = notesRootsForCwd(value);
    } catch {
      return undefined;
    }
    if (!Array.isArray(list)) return undefined;
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

      /* 先按会话解析；会话尚未加载时用前端带来的 cwd 兜底。
         顺序是有意的：会话解析是权威来源，cwd 只在它失败时补位 ——
         这样多开了同一项目的多个会话时，仍以服务端记录的 cwd 为准。 */
      let roots = rootsFor(url);
      if (roots === undefined) roots = rootsFromClientCwd(url);
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
        /* 表格补丁：上游 parseMarkdown 没有表格分支，笔记正文里的管道表格
           会退化成一段带竖线的文字。注入顺序在这里**不重要**（两者插入点
           不同、互不引用），但都在 `</body>` 之前、上游脚本之后，才能接管
           它的函数声明。 */
        const injected = injectMarkdownTables(injectResponsiveCss(withData));
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

      /* 轮询端点：只返回看板需要的内联数据（不含 76KB 的 HTML 外壳）。
         页面用它做热更新 —— 上游只在自己持有 FileSystem 目录句柄时才自动
         同步，而走服务端注入这条路径永远拿不到句柄，所以自动刷新由本插件补。

         `rawBody` 瘦身（实测 53% → 3% 的负载）：
         上游把整篇原文塞进每篇笔记的 `rawBody`，但它在整个看板里**只用了一处** ——
         `(n.rawBody || '').split('\n')[2]`，取第 3 行作为 rejected 笔记的 crux
         （见 agent-notes-board.html:1281）。抽屉里的正文是另外走
         `GET /agent-notes/note` 现读文件的，不依赖这个字段。
         所以这里只发那一行，而不是整篇。8 篇笔记实测：响应体 115815 → 约 82KB。

         **保留字段名与语义**：仍是 `rawBody`，仍能 `.split('\n')[2]` 取到同一行，
         只是内容被裁成前 3 行。这样上游那行代码不用改，也不会因为字段缺失
         而让 crux 退化成 `problem` 兜底。 */
      if (url.pathname === `${ROUTE_PREFIX}/data`) {
        const data = buildInlineData(roots).map((note) => ({
          ...note,
          rawBody: firstLines(note.rawBody, 3)
        }));
        sendJson(res, 200, { revision: revisionOf(data), notes: data });
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
