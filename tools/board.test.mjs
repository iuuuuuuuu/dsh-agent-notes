/**
 * 看板数据层与 HTTP 通道的测试。
 *
 * 重点不是「能跑」，而是把三类会让看板撒谎的错误钉死：
 *   1. 把「没有笔记」显示成「0 篇全部合规」——空集不是证据；
 *   2. 路径穿越（`../../` 读到笔记根之外的文件）；
 *   3. 未知分类被猜进结果 —— 看板不该替门禁做判断。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { injectResponsiveCss, RESPONSIVE_CSS, RESPONSIVE_STYLE_ID } from '../lib/board-responsive.js';
import { buildBoard, buildBoardFromRoots, parseNote, scanNotes } from '../lib/board.js';
import { isInside, registerBoardRoutes } from '../lib/board-route.js';
import { listGitChildren, originOf, resolveNotesRoots } from '../lib/notes.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 造一个提供 `webServer` 的假 ctx。
 *
 * 必须模拟**真实的 `ctx.inject(['webServer'], cb)` 语义**：插件侧现在用
 * inject 等服务就绪（用 `ctx.get` 现取会拿到 undefined，导致路由永不挂上），
 * 所以 mock 只给 `get` 会让测试通过而真机失败 —— 那正是假绿。
 *
 * @param {(route: any) => void} onRegister 收到注册的 route。
 * @returns {any} 假 ctx。
 */
function ctxWithWebServer(onRegister) {
  const webServer = {
    register(route) { onRegister(route); return () => {}; }
  };
  return {
    inject(names, callback) {
      assert.ok(names.includes('webServer'), 'inject 必须声明 webServer');
      callback({ webServer });
      return () => {};
    },
    get() { throw new Error('测试应走 inject，不应走 get'); }
  };
}


/** 造一个临时仓库 + 笔记树。 */
function makeRepo(notes = []) {
  const dir = mkdtempSync(join(tmpdir(), 'an-board-'));
  const root = join(dir, '.agents', 'notes');
  for (const note of notes) {
    const target = join(root, note.lifecycle, note.class);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, note.file), note.body, 'utf8');
  }
  return { dir, root };
}

/** 一篇合规笔记的正文。 */
function noteBody(title = '测试笔记') {
  return [
    `# Agent Note: ${title}`,
    '',
    'Status: implemented',
    '',
    '## Problem',
    '有东西要记。',
    '',
    '## Decision',
    '就这么做。',
    '',
    '## Alternatives considered',
    '另一条路：强在 X，但被 Y 否掉。',
    '',
    '## Consequences',
    '代价是 Z。',
    ''
  ].join('\n');
}

test('board: 解析头块与章节', () => {
  const parsed = parseNote(noteBody('解析测试'));
  assert.equal(parsed.title, 'Agent Note: 解析测试');
  assert.equal(parsed.status, 'implemented');
  assert.deepEqual(parsed.sections, ['Problem', 'Decision', 'Alternatives considered', 'Consequences']);
});

test('board: 空树返回 total 0 且 exists 区分得清', () => {
  const { dir } = makeRepo();
  try {
    const board = buildBoard(join(dir, '.agents', 'notes'));
    assert.equal(board.exists, false, '目录不存在时 exists 必须是 false');
    assert.equal(board.total, 0);
    assert.deepEqual(board.notes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('board: 有目录但零篇 —— exists=true 且 total=0（两者必须能分开）', () => {
  const { dir, root } = makeRepo();
  try {
    mkdirSync(root, { recursive: true });
    const board = buildBoard(root);
    assert.equal(board.exists, true, '目录存在');
    assert.equal(board.total, 0, '但没有笔记');
    // 关键：这两个读数必须不同，否则看板无法区分「没树」和「空树」。
    assert.notEqual(board.exists, board.total > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('board: 真读出笔记，按日期倒序', () => {
  const { dir, root } = makeRepo([
    { lifecycle: 'implemented', class: 'feature', file: '2026-01-01-old.md', body: noteBody('旧') },
    { lifecycle: 'implemented', class: 'bug-fix', file: '2026-03-01-new.md', body: noteBody('新') }
  ]);
  try {
    const board = buildBoard(root);
    assert.equal(board.total, 2);
    assert.equal(board.notes[0].slug, 'new', '新的应排在前面');
    assert.equal(board.notes[1].slug, 'old');
    assert.deepEqual(board.byLifecycle, { implemented: 2 });
    assert.deepEqual(board.byClass, { feature: 1, 'bug-fix': 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('board: 未知分类不猜进结果（看板不替门禁做判断）', () => {
  const { dir, root } = makeRepo([
    { lifecycle: 'implemented', class: 'refactor', file: '2026-01-01-x.md', body: noteBody() }
  ]);
  try {
    const notes = scanNotes(root);
    assert.equal(notes.length, 0, 'refactor 不在封闭集里，不得出现在看板');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('board-route: isInside 挡住前缀误判与路径穿越', () => {
  assert.equal(isInside('/a/b', '/a/b/c'), true, '子路径算在内');
  assert.equal(isInside('/a/b', '/a/b'), true, '自身算在内');
  // 关键：/a/bc 不是 /a/b 的子路径，裸 startsWith 会误判。
  assert.equal(isInside('/a/b', '/a/bc'), false, '前缀相同但不是子路径');
  assert.equal(isInside('/a/b', '/a/b/../c'), false, '.. 穿越必须被挡');
  assert.equal(isInside('/a/b', '/etc/passwd'), false, '完全无关的路径');
});

test('board-route: 路由真能返回看板与单篇，且拒绝穿越', async () => {
  const { dir, root } = makeRepo([
    { lifecycle: 'implemented', class: 'feature', file: '2026-01-01-x.md', body: noteBody('路由测试') }
  ]);
  const handlers = [];
  const ctx = ctxWithWebServer((route) => { handlers.push(route); });
  try {
    registerBoardRoutes(ctx, { notesRootFor: () => root });
    assert.equal(handlers.length, 1, '应注册一个路由');
    assert.equal(handlers[0].kind, 'prefix');

    /** 造一个假 req/res 打路由。 */
    const call = (path) => new Promise((settle) => {
      const res = {
        statusCode: 0,
        headers: null,
        body: '',
        writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
        end(body) { this.body = body ?? ''; settle(this); }
      };
      handlers[0].handler({ method: 'GET', url: path }, res);
    });

    const board = await call('/agent-notes/board');
    assert.equal(board.statusCode, 200);
    const parsed = JSON.parse(board.body);
    assert.equal(parsed.total, 1);
    assert.equal(parsed.notes[0].title, 'Agent Note: 路由测试');

    const single = await call('/agent-notes/note?path=implemented/feature/2026-01-01-x.md');
    assert.equal(single.statusCode, 200);
    assert.match(JSON.parse(single.body).body, /## Decision/);

    // 穿越必须 404，绝不能读到根外的东西。
    const escaped = await call('/agent-notes/note?path=../../../../etc/passwd');
    assert.equal(escaped.statusCode, 404, '路径穿越必须被拒');

    const health = await call('/agent-notes/health');
    assert.equal(health.statusCode, 200);
    assert.equal(JSON.parse(health.body).ok, true);

    const missing = await call('/agent-notes/nope');
    assert.equal(missing.statusCode, 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('board-route: 没有 webServer 服务时静默降级，不抛', () => {
  const ctx = {
    get() {
      throw new Error('no such service');
    }
  };
  const dispose = registerBoardRoutes(ctx, { notesRootFor: () => '/tmp' });
  assert.equal(typeof dispose, 'function', '必须返回一个可调用 disposer');
  assert.doesNotThrow(() => dispose());
});

test('board-route: 会话解析不出笔记根时回 409，不猜一个路径', async () => {
  const handlers = [];
  const ctx = ctxWithWebServer((route) => { handlers.push(route); });
  registerBoardRoutes(ctx, { notesRootFor: () => undefined });
  const res = await new Promise((settle) => {
    const r = {
      statusCode: 0, body: '',
      writeHead(code) { this.statusCode = code; },
      end(body) { this.body = body ?? ''; settle(this); }
    };
    handlers[0].handler({ method: 'GET', url: '/agent-notes/board?session=x' }, r);
  });
  assert.equal(res.statusCode, 409, '解析不出根时应 409，而不是给一个空看板');
  assert.match(JSON.parse(res.body).error, /no notes root/);
});

test('board-route: 空 session 必须归一化成「没带会话」，诊断指向缺失而非无 cwd', async () => {
  /* 实测踩过：侧边栏宿主的 props 被丢弃后，iframe 拼出 `?session=` 空串。
     旧代码把它当成合法 id 一路查下去，最终也回 409，但 reason 会是
     「会话没有记录工作目录」—— 把人引向 sessions 服务，而真实原因是
     前端根本没把 id 传下来。两种成因必须能在响应里分辨。 */
  const seen = [];
  const handlers = [];
  const ctx = ctxWithWebServer((route) => { handlers.push(route); });
  registerBoardRoutes(ctx, {
    notesRootFor: (sessionId) => { seen.push(sessionId); return undefined; }
  });
  const call = (url) => new Promise((settle) => {
    const r = {
      statusCode: 0, body: '',
      writeHead(code) { this.statusCode = code; },
      end(body) { this.body = body ?? ''; settle(this); }
    };
    handlers[0].handler({ method: 'GET', url }, r);
  });

  const empty = await call('/agent-notes/board?session=');
  assert.equal(empty.statusCode, 409);
  const emptyBody = JSON.parse(empty.body);
  assert.equal(emptyBody.reason, 'MISSING_SESSION_ID', '空串应判成「没带会话」');
  assert.equal(seen[0], undefined, '空串不得被当成合法 session id 传下去');

  const missing = await call('/agent-notes/board');
  assert.equal(JSON.parse(missing.body).reason, 'MISSING_SESSION_ID', '完全不传也是同一个成因');

  const real = await call('/agent-notes/board?session=sess-1');
  assert.equal(real.statusCode, 409);
  assert.equal(JSON.parse(real.body).reason, 'NO_NOTES_ROOT', '真带了 id 才是解析不出仓库');
  assert.deepEqual(seen, [undefined, undefined, 'sess-1'], '只有非空 id 才原样传下去');
});

test('board-route: 正文含 HTML 片段时不得破坏注入的脚本块', async () => {
  /* 回归测试：曾经用字符串形式调 String.replace，payload 里的 `$&`、`$'`
     被当成反向引用展开，于是页面里凭空多出 <script 标签、数据被截断，
     看板恒显示「0 项」。笔记正文引用 HTML 片段是完全合法的，
     宿主必须挡住，不能让数据反过来改写宿主页面。 */
  const evil = [
    '# Agent Note: 引用 HTML 的笔记',
    '',
    'Status: implemented',
    '',
    '## Problem',
    '正文里引用了看板源码片段：',
    '',
    '```html',
    '</aside>',
    '<script id="embedded-data">',
    'window.__INLINE_DATA__ = null;',
    '</script>',
    '```',
    '',
    '还有会被 replace 当成反向引用的字符：$& 与 $` 与 $\'',
    '',
    '## Decision',
    '保持原样。',
    '',
    '## Alternatives considered',
    '无。',
    '',
    '## Consequences',
    '无。',
    ''
  ].join('\n');

  const { dir, root } = makeRepo([
    { lifecycle: 'implemented', class: 'process', file: '2026-01-01-evil.md', body: evil }
  ]);
  const handlers = [];
  const ctx = ctxWithWebServer((route) => { handlers.push(route); });
  try {
    registerBoardRoutes(ctx, { notesRootFor: () => root });
    const res = await new Promise((settle) => {
      const r = {
        statusCode: 0, body: '',
        writeHead(code) { this.statusCode = code; },
        end(body) { this.body = body ?? ''; settle(this); }
      };
      handlers[0].handler({ method: 'GET', url: '/agent-notes/ui?session=x' }, r);
    });

    assert.equal(res.statusCode, 200);
    const html = res.body;
    // 关键断言：注入不得增加 <script 的数量。
    const scriptTags = (html.match(/<script/g) ?? []).length;
    const closeTags = (html.match(/<\/script>/g) ?? []).length;
    const original = (readFileSync(
      join(ROOT, 'skills', 'agent-notes', 'assets', 'agent-notes-board.html'), 'utf8'
    ).match(/<script/g) ?? []).length;
    assert.equal(scriptTags, original, `注入后 <script 数量必须不变（${original}），实际 ${scriptTags}`);
    assert.equal(closeTags, original, `注入后 </script> 数量必须不变（${original}），实际 ${closeTags}`);

    // 数据必须能完整解析回来，且正文原样保留。
    const start = html.indexOf('window.__INLINE_DATA__ = ') + 'window.__INLINE_DATA__ = '.length;
    const end = html.indexOf(';\n</script>', start);
    const parsed = JSON.parse(html.substring(start, end));
    assert.equal(parsed.length, 1);
    assert.ok(parsed[0].rawBody.includes('</aside>'), '正文里的 HTML 标签必须原样保留');
    assert.ok(parsed[0].rawBody.includes('$&'), '正文里的 $& 必须原样保留');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('board-route: UI 响应里必须带窄屏适配样式，且不破坏上游页面', async () => {
  /* 右侧栏只有 400–700px，而上游顶栏是 `height:64px` 且不换行 ——
     实测 652px 下 brand-group 高 154px、deck-tabs 高 134px，文字被压成
     逐字竖排。看板 HTML 是 vendored 资产不能手改，所以由宿主注入覆盖样式。
     这条测试钉两件事：样式真的进了响应；注入不改变上游的其余结构。 */
  const { dir, root } = makeRepo([
    { lifecycle: 'implemented', class: 'process', file: '2026-01-01-a.md', body: noteBody() }
  ]);
  const handlers = [];
  const ctx = ctxWithWebServer((route) => { handlers.push(route); });
  try {
    registerBoardRoutes(ctx, { notesRootFor: () => root });
    const res = await new Promise((settle) => {
      const r = {
        statusCode: 0, body: '',
        writeHead(code) { this.statusCode = code; },
        end(body) { this.body = body ?? ''; settle(this); }
      };
      handlers[0].handler({ method: 'GET', url: '/agent-notes/ui?session=x' }, r);
    });
    assert.equal(res.statusCode, 200);

    const html = res.body;
    const original = readFileSync(
      join(ROOT, 'skills', 'agent-notes', 'assets', 'agent-notes-board.html'), 'utf8'
    );

    // ① 适配样式必须在，且只出现一次。
    const count = (html.match(new RegExp(`id="${RESPONSIVE_STYLE_ID}"`, 'g')) ?? []).length;
    assert.equal(count, 1, `适配样式应恰好注入一次，实际 ${count}`);
    assert.ok(html.includes(RESPONSIVE_CSS.trim()), '注入的必须是完整覆盖样式');

    // ② 必须插在 </head> 之前，否则样式要等 body 解析完才生效（会闪）。
    const styleAt = html.indexOf(RESPONSIVE_STYLE_ID);
    const headAt = html.lastIndexOf('</head>');
    assert.ok(styleAt !== -1 && styleAt < headAt, '样式必须在 </head> 之前');

    // ③ 关键：注入只能「加」，不能改动上游原有字节。
    const stripped = html.replace(new RegExp(`<style id="${RESPONSIVE_STYLE_ID}">[\\s\\S]*?</style>\\n?`), '');
    const expected = original.replace(
      'window.__INLINE_DATA__ = null;',
      () => `window.__INLINE_DATA__ = ${JSON.stringify(JSON.parse(
        stripped.slice(
          stripped.indexOf('window.__INLINE_DATA__ = ') + 'window.__INLINE_DATA__ = '.length,
          stripped.indexOf(';\n</script>')
        )
      )).replace(/</g, '\\u003c')};`
    );
    assert.equal(stripped, expected, '去掉适配样式后必须与「只注入数据」的结果逐字节一致');

    // ④ 覆盖样式本身必须真的针对窄屏（媒体查询），不能影响宽屏观感。
    assert.match(RESPONSIVE_CSS, /@media \(max-width: 900px\)/);
    assert.match(RESPONSIVE_CSS, /@media \(max-width: 720px\)/);
    // 顶栏解除固定高度是修好竖排的关键，钉死它。
    assert.match(
      RESPONSIVE_CSS,
      /header\.hud-topbar\s*\{[^}]*height:\s*auto/s,
      '窄屏下必须解除 header 的固定高度（否则换行内容被裁成竖排）'
    );
    // 导航条必须允许横向滚动，而不是让按钮内部折行。
    assert.match(RESPONSIVE_CSS, /nav\.deck-tabs\s*\{[^}]*overflow-x:\s*auto/s);
    assert.match(RESPONSIVE_CSS, /nav\.deck-tabs\s*\{[^}]*min-width:\s*0/s,
      'flex 子项不设 min-width:0 时 overflow-x 不生效，会反过来把 header 撑宽');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('board-route: 解析不出根时 /ui 回可读说明页，不是原始 JSON', async () => {
  /* 实测踩过：/agent-notes/ui 是 iframe 的 src，浏览器会原样渲染响应体。
     回 JSON 时用户在侧边栏里看到的就是一坨 `{"error":...}`，看着像插件坏了；
     而真实成因通常只是「这个 tab 指向的会话还没加载」。
     所以 /ui 必须回 HTML 说明页，/board 仍回 JSON（那是给程序用的）。 */
  const handlers = [];
  const ctx = ctxWithWebServer((route) => { handlers.push(route); });
  registerBoardRoutes(ctx, { notesRootFor: () => undefined });
  const call = (url) => new Promise((settle) => {
    const r = {
      statusCode: 0, body: '', headers: {},
      writeHead(code, headers) { this.statusCode = code; this.headers = headers ?? {}; },
      end(body) { this.body = body ?? ''; settle(this); }
    };
    handlers[0].handler({ method: 'GET', url }, r);
  });

  const ui = await call('/agent-notes/ui?session=deadbeef-0000-0000-0000-000000000000');
  assert.equal(ui.statusCode, 409);
  assert.match(String(ui.headers['content-type']), /text\/html/, '/ui 必须回 HTML');
  assert.ok(ui.body.includes('笔记看板暂时读不到'), '应给出可读标题');
  assert.ok(ui.body.includes('NO_NOTES_ROOT'), '应写清成因');
  assert.ok(ui.body.includes('deadbeef'), '应回显会话 id 便于排查');
  // 不能把 JSON 当页面吐出来。
  assert.ok(!ui.body.trimStart().startsWith('{'), '不能直接回 JSON');

  // 程序用的端点保持 JSON。
  const board = await call('/agent-notes/board?session=deadbeef');
  assert.equal(board.statusCode, 409);
  assert.match(String(board.headers['content-type']), /application\/json/);
  assert.equal(JSON.parse(board.body).reason, 'NO_NOTES_ROOT');
});

test('board-route: 说明页必须转义会话 id（防注入）', async () => {
  /* 会话 id 来自 URL 查询参数，会原样回显到页面里。不转义的话，
     `?session=<script>...` 就是一个反射型 XSS。虽然 iframe 有 sandbox，
     但没有理由把未转义的用户输入拼进 HTML。 */
  const handlers = [];
  const ctx = ctxWithWebServer((route) => { handlers.push(route); });
  registerBoardRoutes(ctx, { notesRootFor: () => undefined });
  const res = await new Promise((settle) => {
    const r = {
      statusCode: 0, body: '',
      writeHead(code) { this.statusCode = code; },
      end(body) { this.body = body ?? ''; settle(this); }
    };
    handlers[0].handler({
      method: 'GET',
      url: `/agent-notes/ui?session=${encodeURIComponent('<script>alert(1)</script>')}`
    }, r);
  });
  assert.equal(res.statusCode, 409);
  assert.ok(!res.body.includes('<script>alert(1)</script>'), '会话 id 必须被转义，不能原样拼进 HTML');
  assert.ok(res.body.includes('&lt;script&gt;'), '应以转义实体呈现');
});

test('board-responsive: 注入幂等、缺 head 时原样返回（适配层不是功能前提）', () => {
  const page = '<html><head><title>t</title></head><body>x</body></html>';
  const once = injectResponsiveCss(page);
  assert.notEqual(once, page, '应真的注入');
  assert.equal(injectResponsiveCss(once), once, '重复注入必须幂等，不能插两次');
  // 没有 </head> 的畸形页面：宁可少一层适配，也不能把页面弄坏。
  assert.equal(injectResponsiveCss('<p>x</p>'), '<p>x</p>');
  assert.equal(injectResponsiveCss(''), '');
  assert.equal(injectResponsiveCss(undefined), undefined);
});

test('board-responsive: 数据里提到样式 id 时仍必须注入（不能靠 includes 判重）', () => {
  /* 实测踩过的坑，代价很高：
     幂等判断原本写的是 `html.includes(RESPONSIVE_STYLE_ID)`。而笔记正文会
     作为数据被注入**同一个页面**，本仓库有一篇笔记恰好写了
     `agent-notes-responsive` 这个 id —— 于是函数把「数据里提到过这个名字」
     误判成「样式已经插过了」，直接原样返回。

     表现是窄屏适配**时有时无**：笔记里提到一次就失效，删掉那篇笔记又好了。
     排查时极易误判成「进程没重载」，我实际就在这上面绕了很久。
     判据必须是完整的 `<style id="...">` 标签，不是 id 子串。 */
  const page = '<html><head></head><body>x</body></html>';
  const dataMentionsId = `<html><head></head><body><script>window.__INLINE_DATA__ = [{"rawBody":"把 <style id=\\"${RESPONSIVE_STYLE_ID}\\"> 插到 head"}]</script></body></html>`;
  const out = injectResponsiveCss(dataMentionsId);
  assert.notEqual(out, dataMentionsId, '数据里提到 id 不等于样式已注入，必须仍然注入');
  assert.ok(
    out.includes(`<style id="${RESPONSIVE_STYLE_ID}">`),
    '必须插入真正的 style 标签'
  );
  // 但真的插过之后，幂等判断仍要生效。
  assert.equal(injectResponsiveCss(out), out, '已注入过就必须幂等');

  // 只有 style 标签才算「已注入」：正文里出现裸 id 不算。
  assert.notEqual(injectResponsiveCss(page.replace('x', RESPONSIVE_STYLE_ID)), page.replace('x', RESPONSIVE_STYLE_ID));
});

test('board: 多个 worktree 的笔记合并，当前工作树优先', () => {
  /* 回归测试：笔记常写在某个 git worktree 里（改哪条分支就在哪个工作树干活），
     而会话 cwd 可能落在主工作树上。只扫一个根会让别处的笔记凭空消失 ——
     实测踩到：主仓库零篇、wt-port 一篇，看板却显示「还没有 .agents/notes」。 */
  const { dir } = makeRepo();
  const main = join(dir, 'repo');
  const wtA = join(dir, 'wt-a');
  const wtB = join(dir, 'wt-b');
  const write = (root, file, body) => {
    const target = join(root, '.agents', 'notes', 'implemented', 'process');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, file), body, 'utf8');
  };
  try {
    write(main, '2026-01-01-shared.md', noteBody('主仓库版本'));
    write(wtA, '2026-02-01-only-a.md', noteBody('只有 A 有'));
    write(wtA, '2026-01-01-shared.md', noteBody('A 的版本'));
    write(wtB, '2026-03-01-only-b.md', noteBody('只有 B 有'));

    const roots = [join(main, '.agents', 'notes'), join(wtA, '.agents', 'notes'), join(wtB, '.agents', 'notes')];
    const board = buildBoardFromRoots(roots);

    assert.equal(board.total, 3, '三个不同 id 的笔记都要出现');
    assert.ok(board.notes.some((n) => n.slug === 'only-a'), 'wt-a 独有笔记必须在');
    assert.ok(board.notes.some((n) => n.slug === 'only-b'), 'wt-b 独有笔记必须在');

    // 同 id 去重：主仓库排在前面，所以主仓库的版本胜出。
    const shared = board.notes.filter((n) => n.slug === 'shared');
    assert.equal(shared.length, 1, '同 id 只能出现一次');
    assert.match(shared[0].title, /主仓库版本/, '当前工作树优先');
    assert.equal(shared[0].shadowedBy.length, 1, '被覆盖的那份要记下来源，不能悄悄吞掉');
    assert.match(shared[0].shadowedBy[0], /wt-a/, 'shadowedBy 指向被覆盖的 worktree');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('board: 全部根都不存在时 exists=false，不冒充「有树但空」', () => {
  const { dir } = makeRepo();
  try {
    const board = buildBoardFromRoots([
      join(dir, 'nope1', '.agents', 'notes'),
      join(dir, 'nope2', '.agents', 'notes')
    ]);
    assert.equal(board.exists, false, '所有根都不存在');
    assert.equal(board.total, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes: originOf 把 https 与 ssh 写法归一，且区分不同仓库', () => {
  /* origin 是「同一个仓库」的判据：容器目录下可能混着别人的参考仓库
     （实测有 ref-panel、ref-sliverkiss 两个第三方 clone），
     不加过滤就会把别人的决策笔记显示出来。
     用真实 git init，因为 git 只认真正的仓库元数据。 */
  const dir = mkdtempSync(join(tmpdir(), 'an-origin-'));
  const mk = (name, origin) => {
    const p = join(dir, name);
    mkdirSync(p, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: p, windowsHide: true });
    if (origin !== undefined) {
      spawnSync('git', ['remote', 'add', 'origin', origin], { cwd: p, windowsHide: true });
    }
    return p;
  };
  try {
    const repo = mk('repo', 'https://github.com/me/proj.git');
    const wt = mk('wt-a', 'https://github.com/me/proj.git');
    const other = mk('ref-x', 'https://github.com/someone/other.git');
    const ssh = mk('ssh-clone', 'git@github.com:me/proj.git');

    assert.equal(originOf(repo), originOf(wt), '同源仓库的 origin 必须相等');
    assert.notEqual(originOf(repo), originOf(other), '别人的仓库必须区分开');
    assert.equal(originOf(repo), originOf(ssh), 'ssh 与 https 应归一为同一个值');
    /* 归一结果里不该残留协议与 .git 后缀。 */
    assert.equal(originOf(repo), 'github.com/me/proj');
    assert.equal(originOf(mk('no-remote')), undefined, '没有 origin 时返回 undefined');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes: listGitChildren 只下探一层，跳过 node_modules', () => {
  const { dir } = makeRepo();
  try {
    mkdirSync(join(dir, 'a', '.git'), { recursive: true });
    mkdirSync(join(dir, 'b', '.git'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'x', '.git'), { recursive: true });
    mkdirSync(join(dir, 'plain'), { recursive: true });
    const found = listGitChildren(dir).map((p) => basename(p));
    assert.deepEqual(found, ['a', 'b'], '只认直接子目录里的 .git，跳过 node_modules');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes: resolveNotesRoots 在容器目录下真的排除别人的仓库', () => {
  /* 关键回归：只测 originOf 是不够的 —— 它证明「能分辨」，
     证明不了「真的按它过滤」。这条测试直接打 resolveNotesRoots，
     故障注入（去掉过滤）会让它变红。 */
  const dir = mkdtempSync(join(tmpdir(), 'an-filter-'));
  const mk = (name, origin) => {
    const p = join(dir, name);
    mkdirSync(p, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: p, windowsHide: true });
    if (origin !== undefined) {
      spawnSync('git', ['remote', 'add', 'origin', origin], { cwd: p, windowsHide: true });
    }
    return p;
  };
  try {
    const mine = mk('repo', 'https://github.com/me/proj.git');
    const wt = mk('wt-a', 'https://github.com/me/proj.git');
    const theirs = mk('ref-x', 'https://github.com/someone/other.git');

    /* 各自放一篇笔记，用 slug 区分来源。 */
    for (const [root, slug] of [[mine, 'mine'], [wt, 'mine-wt'], [theirs, 'theirs']]) {
      const target = join(root, '.agents', 'notes', 'implemented', 'process');
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, `2026-01-01-${slug}.md`), noteBody(slug), 'utf8');
    }

    const roots = resolveNotesRoots(dir);
    const slugs = buildBoardFromRoots(roots).notes.map((n) => n.slug);

    assert.ok(slugs.includes('mine'), '自己仓库的笔记必须在');
    assert.ok(slugs.includes('mine-wt'), '同源 worktree 的笔记必须在');
    assert.ok(!slugs.includes('theirs'), '别人的仓库的笔记必须被排除');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
