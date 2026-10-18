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

import { DRAWER_PATCH_ID, injectResponsiveCss, RESPONSIVE_CSS, RESPONSIVE_STYLE_ID } from '../lib/board-responsive.js';
import { buildBoard, buildBoardFromRoots, buildInlineData, parseNote, scanNotes } from '../lib/board.js';
import { firstLines, isInside, registerBoardRoutes, renderNoticePage, revisionOf } from '../lib/board-route.js';
import { clearGitProbeCache, listGitChildren, originOf, resolveNotesRoots } from '../lib/notes.js';

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

test('board: 小节提取必须取全段落，不能在第一个换行处截断', () => {
  /* 实测踩过的坑，用户直接看到症状：看板详情页每个小节只有开头一句
     （比如 Decision 只剩「两件事分开处理。」），看着像模型没写完。

     根因在正则结尾哨兵：原先写 `(?=^##\\s|\\s*$)` 并带 `m` 标志。
     `\\s` **包含换行符**，配合 `m`（`$` 匹配行尾）后 `\\s*$` 会命中第一行末尾，
     惰性量词 `*?` 在第一个换行处就停 —— 于是每个小节只抽到第一行。

     正确写法是 `(?![\\s\\S])`：后面再没有任何字符，即真正的字符串结尾，
     不受 `m` 影响。

     顺带说明：这个缺陷**上游也有**（skills/agent-notes/scripts/build-board.ts
     里同样的 `(?=^## |\\s*$)`）。那份是 vendored 资产不能手改，所以只在
     本插件自己的 lib/board.js 修 —— 别以为"和上游一致"就没问题。 */
  const body = [
    '# Agent Note: 标题',
    '',
    '## Problem',
    '',
    '第一段：背景。',
    '',
    '第二段：还有更多内容。',
    '',
    '## Decision',
    '',
    '决策第一段。',
    '',
    '决策第二段。',
    ''
  ].join('\n');
  const { dir, root } = makeRepo([
    { lifecycle: 'implemented', class: 'process', file: '2026-01-01-a.md', body }
  ]);
  try {
    const data = buildInlineData([root]);
    assert.equal(data.length, 1);
    const note = data[0];
    assert.ok(note.problem.includes('第一段'), 'problem 必须含第一段');
    assert.ok(note.problem.includes('第二段'), `problem 被截断了：${JSON.stringify(note.problem)}`);
    assert.ok(note.decision.includes('决策第一段'), 'decision 必须含第一段');
    assert.ok(note.decision.includes('决策第二段'), `decision 被截断了：${JSON.stringify(note.decision)}`);
    // 不能把下一个小节的标题吞进来。
    assert.ok(!note.problem.includes('## Decision'), 'problem 不得跨到下一个 ## 小节');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('board: 最后一节（后面没有别的 ##）也要能取全', () => {
  /* 结尾哨兵的另一个边界：如果小节是全文最后一节，`(?=^##\\s|...)` 里
     `^##` 分支永不匹配，只能靠结尾分支。写错的话这一节会整段丢失。 */
  const body = [
    '# Agent Note: 标题',
    '',
    '## Consequences',
    '',
    '代价第一段。',
    '',
    '代价第二段。'
  ].join('\n');
  const { dir, root } = makeRepo([
    { lifecycle: 'implemented', class: 'process', file: '2026-01-01-b.md', body }
  ]);
  try {
    const note = buildInlineData([root])[0];
    assert.ok(note.consequences.includes('代价第一段'), '末节第一段必须取到');
    assert.ok(note.consequences.includes('代价第二段'), `末节被截断：${JSON.stringify(note.consequences)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    /* 关键断言：数据注入不得凭空增加 <script 数量。
       现在比上游多**恰好一个** —— 我们主动注入的抽屉补丁脚本
       （<script id="agent-notes-drawer-patch">）。多出第二个就说明
       数据里的 `</script>` 逃逸出来了，那正是 `\u003c` 转义要防的事。 */
    const scriptTags = (html.match(/<script/g) ?? []).length;
    const closeTags = (html.match(/<\/script>/g) ?? []).length;
    const upstream = (readFileSync(
      join(ROOT, 'skills', 'agent-notes', 'assets', 'agent-notes-board.html'), 'utf8'
    ).match(/<script/g) ?? []).length;
    const expected = upstream + 1;
    assert.equal(scriptTags, expected, `注入后 <script 应恰好 ${expected} 个（上游 ${upstream} + 补丁 1），实际 ${scriptTags}`);
    assert.equal(closeTags, expected, `注入后 </script> 应恰好 ${expected} 个，实际 ${closeTags}`);
    assert.equal((html.match(new RegExp(`id="${DRAWER_PATCH_ID}"`, 'g')) ?? []).length, 1,
      '补丁脚本必须恰好一个');

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

    /* ③ 关键：注入只能「加」，不能改动上游原有字节。
       剥离**两样**我们自己加的东西再比较：适配样式块、抽屉补丁脚本块。
       只剥样式的话，补丁脚本会留在里面导致不等 —— 而被改动的上游字节
       才是这条断言真正要防的。 */
    const stripped = html
      .replace(new RegExp(`<style id="${RESPONSIVE_STYLE_ID}">[\\s\\S]*?</style>\\n?`), '')
      .replace(new RegExp(`<script id="${DRAWER_PATCH_ID}">[\\s\\S]*?</script>\\n?`), '');
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

    /* ⑤ 顶栏子项必须 nowrap —— 这是 2026-10-18 复测发现的真缺陷。
       第一轮只测 ≤900px，漏掉了 900–1440px：实测 1146px 下 brand-group
       实际高 51px、deck-tabs 58px，而上游 header 固定 64px —— 也就是说
       「宽屏」区间同样在逐字竖排。根因不是「窄」，是「子项会折行」。
       所以 nowrap 必须在**所有断点之外**（全宽度生效），不能塞进媒体查询里。 */
    const outsideMedia = RESPONSIVE_CSS.split('@media')[0];
    for (const sel of ['.deck-tab', '.brand-text', 'nav.deck-tabs', '.sync-beacon']) {
      const re = new RegExp(`${sel.replace('.', '\\.')}\\s*\\{[^}]*white-space:\\s*nowrap`);
      assert.match(outsideMedia, re, `${sel} 必须在所有断点之外声明 white-space: nowrap`);
    }

    /* ⑥ 搜索框必须可收缩。写死宽度时实测 760px 处 input 右边缘 767（超出 7px）、
       360px 处超出 20px —— 全是横向溢出。 */
    assert.match(RESPONSIVE_CSS, /\.hud-search[^}]*min-width:\s*0/, '搜索框必须允许收缩');
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

test('board-route: 会话未加载时用前端带来的 cwd 兜底（不显示「暂时读不到」）', async () => {
  /* 实测复现过的场景：DSH 重启后，浏览器里持久化的「笔记」tab 会在会话
     加载完成前请求 /agent-notes/ui。那时 sessions.get(id) 返回 undefined，
     header.cwd 拿不到，看板只能显示「暂时读不到」—— 而用户明明就在那个
     会话里（截图里的 session id 正是当前会话）。
     兜底数据是宿主的会话列表摘要 cwd（SessionScope.cwd），不依赖服务端加载。
     这不是猜仓库：它是宿主声明的本会话目录。 */
  const dir = mkdtempSync(join(tmpdir(), 'an-cwd-'));
  const root = join(dir, '.agents', 'notes', 'implemented', 'process');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, '2026-01-01-a.md'), noteBody('用 cwd 兜底'), 'utf8');
  try {
    const handlers = [];
    const ctx = ctxWithWebServer((route) => { handlers.push(route); });
    const seen = [];
    registerBoardRoutes(ctx, {
      // 会话没加载：模拟 sessions.get() 拿不到 header.cwd
      notesRootFor: () => undefined,
      notesRootsForCwd(cwd) { seen.push(cwd); return [join(dir, '.agents', 'notes')]; }
    });
    const res = await new Promise((settle) => {
      const r = {
        statusCode: 0, body: '',
        writeHead(code) { this.statusCode = code; },
        end(body) { this.body = body ?? ''; settle(this); }
      };
      handlers[0].handler({
        method: 'GET',
        url: `/agent-notes/ui?session=session-abc&cwd=${encodeURIComponent(dir)}`
      }, r);
    });
    assert.equal(res.statusCode, 200, '有 cwd 时不该再回 409');
    assert.ok(!res.body.includes('笔记看板暂时读不到'), '不该显示说明页');
    assert.ok(res.body.includes('用 cwd 兜底'), '应真的读到该 cwd 下的笔记');
    assert.deepEqual(seen, [dir], '应把前端带来的 cwd 原样交给解析器');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('board-route: cwd 兜底必须是绝对路径，也不许抢在会话解析前面', async () => {
  /* 两条边界：
     ① 相对路径在不同进程目录下指向别处，等同猜 —— 必须忽略，连解析器都不调；
     ② 会话能解析时必须以会话为准（本测试里会话返回 /from/session/notes，
        cwd 解析器一旦被调用就会改变走向，用它来证明优先级）。 */
  const handlers = [];
  const ctx = ctxWithWebServer((route) => { handlers.push(route); });
  let cwdCalls = 0;
  registerBoardRoutes(ctx, {
    notesRootFor: () => undefined,
    notesRootsForCwd() { cwdCalls += 1; return ['/from/cwd/notes']; }
  });
  const call = (url) => new Promise((settle) => {
    const r = {
      statusCode: 0, body: '',
      writeHead(code) { this.statusCode = code; },
      end(body) { this.body = body ?? ''; settle(this); }
    };
    handlers[0].handler({ method: 'GET', url }, r);
  });

  const rel = await call('/agent-notes/board?session=s1&cwd=relative/dir');
  assert.equal(rel.statusCode, 409, '相对路径不得作为兜底');
  assert.equal(cwdCalls, 0, '相对路径连解析器都不该调用');
  assert.equal(JSON.parse(rel.body).reason, 'NO_NOTES_ROOT');

  // 会话能解析时，cwd 不该被用到
  const handlers2 = [];
  const ctx2 = ctxWithWebServer((route) => { handlers2.push(route); });
  let cwdCalls2 = 0;
  registerBoardRoutes(ctx2, {
    notesRootFor: () => ['/from/session/notes'],
    notesRootsForCwd() { cwdCalls2 += 1; return ['/from/cwd/notes']; }
  });
  await new Promise((settle) => {
    const r = {
      statusCode: 0, body: '',
      writeHead(code) { this.statusCode = code; },
      end(body) { this.body = body ?? ''; settle(this); }
    };
    handlers2[0].handler({
      method: 'GET',
      url: '/agent-notes/board?session=s1&cwd=%2Ffrom%2Fcwd'
    }, r);
  });
  assert.equal(cwdCalls2, 0, '会话能解析时不得走 cwd 兜底');
});

test('board-route: 说明页会自动重试，用户不必手动刷新', () => {
  /* 会话加载是几秒内的事。说明页若能自己重试并跳转，用户就完全感知不到
     这次失败；否则只能看到一张死页面，还得自己知道要刷新。 */
  const html = renderNoticePage({ reason: 'NO_NOTES_ROOT', hint: 'h', sessionId: 's' });
  assert.ok(html.includes('setInterval'), '应有定时重试');
  assert.ok(html.includes('location.replace'), '成功后就地跳进看板');
  assert.ok(/tries\s*>\s*\d+/.test(html), '必须有次数上限，不能无限重试');
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

test('board-responsive: 补丁脚本必须注入，且放在 body 末尾（DOM 已就绪）', () => {
  /* 补丁脚本现在只做一件事：热更新轮询。它必须放在 </body> 之前 ——
     脚本里要读 location 与调 window.ingestDataset，放 head 里拿不到上游
     刚定义好的函数。 */
  const page = '<html><head><title>t</title></head><body><aside id="drawer-console"></aside></body></html>';
  const out = injectResponsiveCss(page);
  assert.ok(out.includes(`<script id="${DRAWER_PATCH_ID}">`), '补丁脚本必须被注入');
  const scriptAt = out.indexOf(`id="${DRAWER_PATCH_ID}"`);
  const bodyEndAt = out.lastIndexOf('</body>');
  assert.ok(scriptAt > 0 && scriptAt < bodyEndAt, '脚本必须在 </body> 之前（DOM 就绪）');
  // 幂等：不能插两次脚本
  assert.equal((out.match(new RegExp(DRAWER_PATCH_ID, 'g')) ?? []).length, 1);
  assert.equal(injectResponsiveCss(out), out, '二次注入必须原样返回');
});

test('board-responsive: 抽屉滚动修复已由上游提供，注入层不得再重复一份', () => {
  /* 上游 commit 72573a5 修好了两件事：
       ① openConsole() 里加 `scrollTop = 0`（打开新笔记从头开始）；
       ② CSS 加 `body:has(#drawer-console.open), html:has(...) { overflow: hidden }`
          （锁背景滚动，消除双层滚动条）。
     本插件此前在注入层补过同样两处。上游修好后，实测把注入层完全剥离，
     抽屉行为依然正确 —— 说明重复实现已是纯冗余，故删除。

     这条测试**防止冗余悄悄长回来**：两份等效代码长期并存会漂移，
     改一处忘另一处时没人知道哪份在生效。若将来上游又回退这两处修复，
     应当新开决策笔记重新引入，而不是在这里悄悄加回来。 */
  assert.doesNotMatch(RESPONSIVE_CSS, /#drawer-console\.open[\s\S]{0,80}overflow:\s*hidden/,
    '注入层不应再重复上游的锁滚动规则');
  const page = '<html><head></head><body><aside id="drawer-console"></aside></body></html>';
  const out = injectResponsiveCss(page);
  assert.doesNotMatch(out, /MutationObserver/, '注入层不应再用 MutationObserver 补 scrollTop');
  assert.doesNotMatch(out, /\.scrollTop\s*=\s*0/, '注入层不应再补 scrollTop 归零');
});

test('board-route: /data 端点返回数据 + revision，且 revision 随内容变化', async () => {
  /* 这条端点是热更新的数据源。上游自己的自动同步依赖 FileSystem 目录句柄
     （Core.dirHandle），而走服务端注入这条路永远拿不到句柄 —— 实测
     triggerLiveSync 第一行 `if (!Core.dirHandle) return` 直接返回，
     改了笔记页面纹丝不动。所以刷新得由本插件补，端点必须在。
     同时 revision 必须真能反映**内容**变化，否则页面比对不出来。 */
  const { dir, root } = makeRepo([
    { lifecycle: 'implemented', class: 'process', file: '2026-01-01-a.md', body: noteBody('原始标题') }
  ]);
  const handlers = [];
  const ctx = ctxWithWebServer((route) => { handlers.push(route); });
  const call = (url) => new Promise((settle) => {
    const r = {
      statusCode: 0, body: '',
      writeHead(code) { this.statusCode = code; },
      end(body) { this.body = body ?? ''; settle(this); }
    };
    handlers[0].handler({ method: 'GET', url }, r);
  });
  try {
    registerBoardRoutes(ctx, { notesRootFor: () => root });
    const first = await call('/agent-notes/data?session=x');
    assert.equal(first.statusCode, 200);
    const p1 = JSON.parse(first.body);
    assert.ok(Array.isArray(p1.notes) && p1.notes.length === 1, '应返回笔记数据');
    assert.equal(typeof p1.revision, 'string');
    assert.ok(p1.revision.length >= 8, 'revision 应是有长度的指纹');

    // 同内容两次：指纹必须一致（否则页面会无谓重绘）
    const again = JSON.parse((await call('/agent-notes/data?session=x')).body);
    assert.equal(again.revision, p1.revision, '内容没变时 revision 必须稳定');

    /* 端点必须真的应用了 rawBody 瘦身 —— 只测 firstLines 单元不够。
       故障注入实测过：把端点里的 firstLines(...) 改回 note.rawBody，
       仅测单元的断言仍然全绿，这是假绿。 */
    const note = p1.notes[0];
    assert.ok(typeof note.rawBody === 'string' && note.rawBody.length > 0, 'rawBody 字段必须仍在');
    const rawLineCount = note.rawBody.split('\n').length;
    assert.ok(
      rawLineCount <= 3,
      `端点返回的 rawBody 必须被截成前 3 行（实际 ${rawLineCount} 行）—— 否则负载瘦身没生效`
    );
    /* crux 依赖第 3 行：截断后仍要能取到 Status 行。 */
    assert.match(note.rawBody.split('\n')[2] ?? '', /^Status:/, '第 3 行必须仍是 Status 行（crux 依赖它）');
    /* 四小节出自其它字段，必须完整保留，不能被瘦身波及。 */
    assert.ok(note.decision.length > 0, 'decision 不能受 rawBody 瘦身影响');

    // 改**内容**（不是篇数）：指纹必须变
    const file = join(root, 'implemented', 'process', '2026-01-01-a.md');
    writeFileSync(file, noteBody('改过的标题'), 'utf8');
    const changed = JSON.parse((await call('/agent-notes/data?session=x')).body);
    assert.notEqual(changed.revision, p1.revision, '内容变化时 revision 必须变');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('board-route: revision 只比篇数会漏掉内容修改（回归）', () => {
  /* 曾经最容易写错的版本是「按篇数 + mtime 判变化」：
     - 只比篇数：改一篇内容、篇数不变 → 察觉不到（正是本次要修的 bug）；
     - 只比 mtime：部分编辑器保留 mtime，改了内容却看不出。
     这里直接钉住「篇数相同但内容不同 → 指纹必须不同」。 */
  const base = [{
    id: 'a', title: 't', status: 'implemented', date: '2026-01-01',
    lifecycle: 'implemented', cls: 'process',
    problem: 'p1', decision: 'd1', alternatives: 'a1', consequences: 'c1', outLinks: []
  }];
  const same = [{ ...base[0] }];
  const edited = [{ ...base[0], decision: 'd2' }];
  assert.equal(revisionOf(base), revisionOf(same), '完全相同的输入必须同一指纹');
  assert.notEqual(revisionOf(base), revisionOf(edited), 'decision 变了必须换指纹 —— 只比篇数会漏掉');
  /* 四个小节**逐个**都要进指纹。只把其中一个算进去的话，
     改别的小节就察觉不到 —— 用逐字段断言钉住，别让某个字段被漏掉。 */
  for (const field of ['problem', 'decision', 'alternatives', 'consequences']) {
    const changed = [{ ...base[0], [field]: '改过了' }];
    assert.notEqual(
      revisionOf(base), revisionOf(changed),
      `${field} 必须计入指纹，否则只改这一节时页面不会更新`
    );
  }
  // 只有引用关系变也要能察觉（因果图谱会跟着变）
  const relinked = [{ ...base[0], outLinks: ['b'] }];
  assert.notEqual(revisionOf(base), revisionOf(relinked), 'outLinks 变了必须换指纹');
});

test('board-responsive: 热更新脚本必须轮询 /data，并调用上游 ingestDataset', () => {
  /* 三个关键点，任一遗漏都会让「改笔记后页面不更新」复现：
     ① 端点由当前路径推导（不能直接拼 'data'，实测会得到 /agent-notes/uidata 404）；
     ② 必须在页面加载后立刻探一次 —— 否则首个 4 秒周期拿到的已经是最新内容，
        而「首次只记录不重绘」会把这次变化直接吞掉（实测踩过）；
     ③ 必须调上游的 ingestDataset，而不是自己重画，否则引用计数/排序/四个视图
        各自为政。 */
  const page = '<html><head></head><body><aside id="drawer-console"></aside></body></html>';
  const out = injectResponsiveCss(page);
  const i = out.indexOf(`id="${DRAWER_PATCH_ID}"`);
  assert.ok(i > 0, '补丁脚本必须存在');
  const js = out.slice(i, out.indexOf('</script>', i));

  assert.match(js, /replace\(\/\[\^\/\]\*\$\/, 'data'\)/, '端点应从当前路径推导，不能直接拼 data');
  assert.match(js, /setInterval\(poll,/, '必须有轮询');
  assert.match(js, /window\.ingestDataset\(/, '必须调上游的 ingestDataset');
  assert.match(js, /document\.hidden/, '整页不可见时应跳过请求');
  /* 加载后立刻探一次：体现在启动分支里直接调用 poll()。 */
  assert.match(js, /\bpoll\(\);/, '页面加载后必须立刻探一次（否则首次变化被吞）');
});

test('board-responsive: 轮询必须按「是否真的渲染」门控，不能只看 document.hidden', () => {
  /* 实测踩过的性能坑：看板跑在侧边栏的 iframe 里。宿主把 iframe 的容器设为
     display:none（用户切到别的 tab）之后，iframe 内部的 document.hidden
     **仍然是 false** —— 它反映的是整个浏览器窗口是否可见，不是这个 iframe
     是否被渲染。于是「只看 document.hidden」等于没挡：用户切走后仍每 4 秒
     拉一次 100KB、服务端仍做一次全盘扫描（实测单次 78ms、响应 100402 字节）。
     实测 12 秒隐藏期内 polls 从 2 涨到 5。

     修法用 IntersectionObserver 盯 body：由浏览器在渲染树层面判定，
     iframe 被隐藏时给 isIntersecting=false。实测三态都准。
     隐藏期间停掉定时器，恢复时立刻补探一次。 */
  const page = '<html><head></head><body><aside id="drawer-console"></aside></body></html>';
  const out = injectResponsiveCss(page);
  const i = out.indexOf(`id="${DRAWER_PATCH_ID}"`);
  const js = out.slice(i, out.indexOf('</script>', i));

  assert.match(js, /new IntersectionObserver\(/, '必须用 IntersectionObserver 判断是否真的可见');
  assert.match(js, /io\.observe\(document\.body\)/, '应观察 body（iframe 被隐藏时 body 会退出交叉）');
  /* 隐藏时要真的停表，否则只是少发请求、定时器仍空转。
     断言 stop() 的**定义体**里确实调了 clearInterval —— 只搜 clearInterval
     会被别处的注释或另一处调用蒙混过去（故障注入实测：把 stop 里的
     clearInterval 删掉，宽松的正则仍能匹配到，测试不变红）。 */
  assert.match(js, /function stop\(\) \{[\s\S]{0,200}clearInterval\(timer\);[\s\S]{0,120}\}/,
    'stop() 内必须真的 clearInterval，否则定时器仍在空转');
  /* 恢复可见要立刻补探，别等下一个周期（隐藏期间的变更不能漏）。 */
  assert.match(js, /if \(visible\) \{[\s\S]{0,120}start\(\);[\s\S]{0,120}poll\(\);/, '恢复可见时应立刻补探一次');
  /* 不可见分支必须调 stop()。 */
  assert.match(js, /\} else \{\s*stop\(\);\s*\}/, '不可见时必须调 stop() 停掉定时器');
  /* 启动分支也要受门控：不可见时不该先把定时器建起来。 */
  assert.match(js, /if \(visible && !document\.hidden\) \{/, '启动时也要按可见性决定是否开始轮询');
});

test('board-route: /data 的 rawBody 只保留前 3 行（负载瘦身，但 crux 仍可取）', () => {
  /* 实测：8 篇笔记时响应体 115815 字节，其中 rawBody 占 53%。而看板对 rawBody
     的全部用法只有一处 —— `(n.rawBody||'').split('\n')[2]`，取第 3 行做
     rejected 笔记的 crux。所以整篇原文是纯浪费。

     边界必须守住：截断后第 3 行要一模一样（crux 依赖它），且四小节不能受影响
     （它们出自不同字段，本来就完整）。 */
  const body = '# Agent Note: 标题\n\nStatus: rejected — 否决理由\n\n## Problem\n\n很长的正文……';
  assert.equal(firstLines(body, 3), '# Agent Note: 标题\n\nStatus: rejected — 否决理由');
  // crux 取第 3 行：截断前后必须一致
  assert.equal(firstLines(body, 3).split('\n')[2], body.split('\n')[2]);
  // 行数不足时原样返回（内容本来就短，不该被改）
  assert.equal(firstLines('a\nb', 3), 'a\nb');
  // 非字符串原样返回，不能把 undefined 变成字符串
  assert.equal(firstLines(undefined, 3), undefined);
  assert.equal(firstLines(null, 3), null);
  assert.equal(firstLines('', 3), '');
});

test('notes: git 探测有缓存，且只缓存成功结果（TTL 到期会重探）', () => {
  /* 实测：`spawnSync('git', …)` 在 Windows 单次 73–76ms，比读文件慢三百多倍。
     `/data` 每次都走根解析 → TTFB 88ms 里业务逻辑只占 3ms，其余全是 fork。
     加缓存后 TTFB 降到 5ms 量级。

     这条测试守住三件事：
       ① 重复调用不再 fork（同参数第二次应命中缓存）；
       ② 失败结果**不缓存** —— 否则一次瞬时故障会变成持续的「找不到根」；
       ③ 缓存有 TTL —— 永久缓存会让新建的 worktree 一直不出现（静默漏数据）。
     直接量「第二次是否更快」太脆，改为行为断言 + 源码常量断言。 */
  clearGitProbeCache();

  // 失败结果不缓存：每次都要真的去问 git，结果仍是明确的 undefined
  assert.equal(originOf('D:/__definitely_not_a_repo__'), undefined);
  assert.equal(originOf('D:/__definitely_not_a_repo__'), undefined);

  // 成功结果可缓存：本仓库有 origin 时，重复调用必须一致
  const real = originOf(ROOT);
  if (typeof real === 'string') {
    assert.equal(originOf(ROOT), real, '同参数重复调用应返回同一结果');
  }

  // TTL 必须是存在的正数常量 —— 永久缓存是明确的错，用源码断言钉住。
  const src = readFileSync(join(ROOT, 'lib', 'notes.js'), 'utf8');
  const m = /GIT_PROBE_TTL_MS\s*=\s*([0-9_]+)/.exec(src);
  assert.ok(m !== null, '必须定义 GIT_PROBE_TTL_MS');
  const ttl = Number(m[1].replace(/_/g, ''));
  assert.ok(ttl > 0 && ttl <= 60_000, `TTL 应是合理的短时间（实际 ${ttl}ms）`);
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
