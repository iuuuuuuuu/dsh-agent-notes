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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoard, parseNote, scanNotes } from '../lib/board.js';
import { isInside, registerBoardRoutes } from '../lib/board-route.js';

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
