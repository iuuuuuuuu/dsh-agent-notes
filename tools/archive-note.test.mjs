/**
 * `archive:note` 入口的测试。
 *
 * ## 为什么需要这条门禁/入口
 *
 * 规范要求「归档」，而 `archive-agent-note.ts` 一直存在却**没有 npm 入口** ——
 * 只能手写 `node <路径>` 或干脆手改 `archived/manifest.json`。
 *
 * 手写封印没有意义：`verify-archived-agent-notes.ts` 校验的是
 * 「manifest 里的哈希与文件内容一致」。若两边都是人手工填的，
 * 它只能证明「填的时候两边对得上」，证明不了「封印之后没被改过」——
 * 而后者才是封印的全部价值。
 *
 * 所以必须有一个**计算哈希**的入口，把哈希交给机器算。
 *
 * ## 测什么
 *
 * 1. 归档后门禁绿（封印建立）；
 * 2. **篡改归档文件后门禁红**（封印生效）—— 这是封印存在意义的证明；
 * 3. `Status:` 不是 implemented 时拒绝归档；
 * 4. 参数缺失时非零退出。
 */
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { rewriteRelativeLinks } from './archive-note.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = join(PACKAGE_ROOT, 'skills', 'agent-notes', 'scripts');
const NODE = process.execPath;

/**
 * 造一个带笔记脚本的临时仓库，并放一篇可归档的笔记。
 *
 * @param {string} status 笔记的 Status 行。
 * @returns {string} 仓库目录。
 */
function makeRepo(status = 'Status: implemented') {
  const dir = mkdtempSync(join(tmpdir(), 'an-archive-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 'probe@example.test');
  git('config', 'user.name', 'probe');
  git('config', 'commit.gpgsign', 'false');

  /* 拷全部脚本：archive 依赖 agent-note-tree.ts，verify 也共用它。 */
  mkdirSync(join(dir, 'skills', 'agent-notes', 'scripts'), { recursive: true });
  for (const name of ['agent-note-tree.ts', 'archive-agent-note.ts', 'verify-archived-agent-notes.ts']) {
    copyFileSync(join(SCRIPTS, name), join(dir, 'skills', 'agent-notes', 'scripts', name));
  }

  mkdirSync(join(dir, '.agents', 'notes', 'implemented', 'process'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'notes', 'implemented', 'process', '2026-01-01-old.md'), [
    '# Agent Note: 待归档测试',
    '',
    status,
    '',
    '## Problem',
    '',
    '测试用。',
    '',
    '## Decision',
    '',
    '测试用。',
    '',
    '## Alternatives considered',
    '',
    '无',
    '',
    '## Consequences',
    '',
    '测试用。',
    ''
  ].join('\n'), 'utf8');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

/**
 * 跑脚本，返回退出码与输出。
 *
 * @param {string} dir 仓库目录。
 * @param {string} script 脚本名。
 * @param {string[]} [args] 参数。
 * @returns {{ code: number, signal: string|null, out: string }} 结果。
 */
function run(dir, script, args = []) {
  const r = spawnSync(NODE, [join(dir, 'skills', 'agent-notes', 'scripts', script), ...args], {
    cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env }
  });
  /* 带上 signal：Windows 上子 node 崩溃时 status 会是一个 NTSTATUS 数值
     （实测见过 3221226505 = 0xC0000409），只有 signal/status 一起看才分得清
     「脚本按约定 exit 1」和「子进程崩了」。别把崩溃当成「非零就是对的」。 */
  return { code: r.status ?? -1, signal: r.signal ?? null, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('archive:note: 归档后门禁绿，且 manifest 由脚本算出', () => {
  const dir = makeRepo();
  try {
    const before = join(dir, '.agents/notes/implemented/process/2026-01-01-old.md');
    assert.equal(existsSync(before), true, '前置：笔记在 implemented 下');

    const archived = run(dir, 'archive-agent-note.ts',
      ['.agents/notes/implemented/process/2026-01-01-old.md']);
    assert.equal(archived.code, 0, `归档应成功，实际 exit=${archived.code}\n${archived.out}`);
    assert.equal(existsSync(before), false, '归档后原位置不该再有文件');

    const moved = join(dir, '.agents/notes/archived/process/2026-01-01-old.md');
    assert.equal(existsSync(moved), true, '应移到 archived/<class>/ 下');

    /* 归档笔记头部必须插入 Archived: 行（DSH 的归档规范）。 */
    const head = readFileSync(moved, 'utf8').split('\n').slice(0, 5).join('\n');
    assert.match(head, /^Archived: \d{4}-\d{2}-\d{2}$/m, '必须插入 Archived: YYYY-MM-DD 行');

    /* manifest 必须由脚本写入，而不是人手填。 */
    const manifest = JSON.parse(readFileSync(join(dir, '.agents/notes/archived/manifest.json'), 'utf8'));
    const hash = manifest.files['archived/process/2026-01-01-old.md'];
    assert.match(String(hash), /^sha256:[0-9a-f]{64}$/, 'manifest 里必须有一条合法哈希');

    const gate = run(dir, 'verify-archived-agent-notes.ts');
    assert.equal(gate.code, 0, `归档后门禁应绿，实际 exit=${gate.code}\n${gate.out}`);
    assert.match(gate.out, /1 archived note\(s\) verified, 1 seal\(s\)/,
      '必须报告 1 篇 1 封印 —— 否则「绿」可能只是因为没检查到东西');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archive:note: 篡改归档文件后门禁红（封印真的生效）', () => {
  /* 这是封印存在意义的唯一证明。若这条不变红，
     整个归档机制就只是「把文件挪个地方」。 */
  const dir = makeRepo();
  try {
    const archived = run(dir, 'archive-agent-note.ts',
      ['.agents/notes/implemented/process/2026-01-01-old.md']);
    assert.equal(archived.code, 0, '前置：归档成功');

    const moved = join(dir, '.agents/notes/archived/process/2026-01-01-old.md');
    writeFileSync(moved, `${readFileSync(moved, 'utf8')}\n篡改的内容\n`, 'utf8');

    const gate = run(dir, 'verify-archived-agent-notes.ts');
    assert.notEqual(gate.code, 0, '篡改归档文件后门禁必须红');
    assert.match(gate.out, /seal mismatch|modified after sealing/, '诊断必须指出是封印不匹配');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archive:note: 非 implemented 的笔记拒绝归档', () => {
  const dir = makeRepo('Status: proposed');
  try {
    const r = run(dir, 'archive-agent-note.ts',
      ['.agents/notes/implemented/process/2026-01-01-old.md']);
    assert.notEqual(r.code, 0, 'proposed 笔记不该被归档');
    assert.match(r.out, /Status: implemented/, '必须说明要求 implemented');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archive:note: 缺参数时非零退出', () => {
  /* 用法错误返回 0 是典型的假绿：CI 里若有人传错参数，
     脚本「成功」了但什么都没做。 */
  const dir = makeRepo();
  try {
    const r = run(dir, 'archive-agent-note.ts');
    assert.equal(r.code, 1, `缺参数必须 exit 1（崩溃不算，signal=${String(r.signal)}），实际 ${r.code}`);
    assert.match(r.out, /Usage/, '必须打印用法');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archive:note: 拒绝归档仓库外的路径', () => {
  /* 安全边界：脚本只该动当前仓库 .agents/notes/implemented 下的文件。
     否则一个拼错的相对路径可能把别处的文件搬进来并封印。

     注意这条必须让文件**真实存在**才测得到路径检查 ——
     否则先命中的是「文件不存在」，测不到边界本身（实测踩过）。 */
  const dir = makeRepo();
  try {
    /* 在仓库外造一个真实存在的笔记，再试图归档它。 */
    const outside = join(dir, '..', 'outside-note.md');
    writeFileSync(outside, '# Agent Note: outside\n\nStatus: implemented\n', 'utf8');
    const r = run(dir, 'archive-agent-note.ts', [outside]);
    assert.notEqual(r.code, 0, '仓库外路径必须拒绝');
    assert.match(r.out, /only notes in .*implemented|can be archived/,
      `诊断必须说明只接受仓库内 implemented 下的笔记，实际：${r.out.trim()}`);
    rmSync(outside, { force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 链接改写 ──────────────────────────────────────────────────
 *
 * 归档把笔记从 implemented/<class>/ 移到 archived/<class>/，深度不变但
 * 路径段变了 —— 于是笔记里的相对链接会失效。上游 archive-agent-note.ts
 * 只做头部规范化，**没动正文里的链接**。
 *
 * tools/archive-note.mjs 在调用它之前先改写，使封印与最终内容一致。
 */

/** 造一个临时「仓库」，返回 notes 根。 */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'an-arch-'));
  const notes = join(dir, '.agents', 'notes');
  for (const lc of ['implemented', 'archived']) {
    mkdirSync(join(notes, lc, 'process'), { recursive: true });
    mkdirSync(join(notes, lc, 'bug-fix'), { recursive: true });
  }
  writeFileSync(join(dir, 'README.md'), '# root\n', 'utf8');
  writeFileSync(join(notes, 'implemented', 'bug-fix', 'y.md'), 'target\n', 'utf8');
  return { dir, notes };
}

test('archive-note 链接改写: 相对链接要加一级并补 implemented', () => {
  const s = sandbox();
  try {
    const r = rewriteRelativeLinks(
      '见 [旧决策](../bug-fix/y.md)\n',
      join(s.notes, 'implemented', 'process'),
      join(s.notes, 'archived', 'process'),
      s.notes
    );
    assert.equal(r.changed, 1, '应改写 1 条');
    assert.ok(r.content.includes('](../../implemented/bug-fix/y.md)'),
      `应改成跨 lifecycle 的形式，实际: ${r.content}`);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('archive-note 链接改写: 指向笔记树外的链接不得改写', () => {
  const s = sandbox();
  try {
    const r = rewriteRelativeLinks(
      '见 [README](../../README.md)\n',
      join(s.notes, 'implemented', 'process'),
      join(s.notes, 'archived', 'process'),
      s.notes
    );
    assert.equal(r.changed, 0, '树外链接不该被改 —— 基准未变，改了反而错');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('archive-note 链接改写: 代码块里的示例不得改写（那是历史内容）', () => {
  const s = sandbox();
  try {
    const src = [
      '正文引用了示例：', '', '```md', '[示例](../bug-fix/y.md)',
      '```', '', '而真链接是 [真的](../bug-fix/y.md)', ''
    ].join('\n');
    const r = rewriteRelativeLinks(
      src,
      join(s.notes, 'implemented', 'process'),
      join(s.notes, 'archived', 'process'),
      s.notes
    );
    assert.equal(r.changed, 1, '只该改真链接那一条');
    assert.ok(r.content.includes('[示例](../bug-fix/y.md)'),
      '代码块内的示例必须原样保留 —— 改它就是篡改历史');
    assert.ok(r.content.includes('[真的](../../implemented/bug-fix/y.md)'),
      '代码块外的真链接应被改写');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('archive-note 链接改写: 绝对 URL、协议相对与纯锚点不得改写', () => {
  const s = sandbox();
  try {
    const src = [
      '[a](https://example.com/x.md)', '[b](//cdn.example.com/y.md)',
      '[c](#section)', '[d](mailto:x@y.z)', ''
    ].join('\n');
    const r = rewriteRelativeLinks(
      src,
      join(s.notes, 'implemented', 'process'),
      join(s.notes, 'archived', 'process'),
      s.notes
    );
    assert.equal(r.changed, 0, '这四种都不指向本仓库文件');
    assert.equal(r.content, src, '必须逐字不变');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('archive-note 链接改写: fragment 与 query 必须跟着走', () => {
  const s = sandbox();
  try {
    const r = rewriteRelativeLinks(
      '见 [笔记](../bug-fix/y.md#decision) 与 [查询](../bug-fix/y.md?v=2)\n',
      join(s.notes, 'implemented', 'process'),
      join(s.notes, 'archived', 'process'),
      s.notes
    );
    assert.equal(r.changed, 2);
    assert.ok(r.content.includes('y.md#decision'), 'fragment 必须跟着走');
    assert.ok(r.content.includes('y.md?v=2'), 'query 必须跟着走');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('archive-note 链接改写: 幂等 —— 已经是归档后形式的不再改', () => {
  const s = sandbox();
  try {
    const r = rewriteRelativeLinks(
      '见 [旧决策](../../implemented/bug-fix/y.md)\n',
      join(s.notes, 'archived', 'process'),
      join(s.notes, 'archived', 'process'),
      s.notes
    );
    assert.equal(r.changed, 0, '同目录之间不该有改写');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('archive-note 链接改写: 围栏内的示例不得改写（走真实生产路径）', () => {
  /* 原先这里测的是 `replaceOutsideFences` —— 一个只被这条测试使用的
     逐行状态机。它从未进过生产路径（`rewriteRelativeLinks` 走的是共用件
     `blankOutFences`），于是它成了第五套围栏口径，而测试还写着
     「与 md-links 完全一致」。实测两套口径在两种输入下分叉：

     | 输入 | 状态机 | mdast |
     |---|---|---|
     | 未闭合围栏 | 区内 [3,4,5] | 区内 [3,4] |
     | 嵌套标记文本 | 区内 [2,3,5,6,7,8] | 区内 [2,3,5,7] |

     第二种会让本该改写的正文链接被跳过 —— 归档后即断链。
     所以删掉那个函数，改为直接验 `rewriteRelativeLinks` 的真实行为。 */
  const src = [
    '见 [正常](../bug-fix/a.md)。',
    '',
    '```js',
    'const a = 1;',
    '见 [示例](../bug-fix/example.md);',
    '```',
    '',
    '~~~',
    '见 [示例2](../bug-fix/example2.md)',
    '~~~',
    '',
    '见 [另一条](../feature/b.md)。',
    ''
  ].join('\n');

  const s = sandbox();
  try {
    const from = join(s.notes, 'implemented', 'process');
    const to = join(s.notes, 'archived', 'process');
    const result = rewriteRelativeLinks(src, from, to, s.notes);

    /* 围栏外两条都要改写（归档后要跨 lifecycle，所以补 implemented/）。 */
    assert.match(result.content, /\[正常\]\(\.\.\/\.\.\/implemented\/bug-fix\/a\.md\)/,
      '围栏外的链接必须被改写');
    assert.match(result.content, /\[另一条\]\(\.\.\/\.\.\/implemented\/feature\/b\.md\)/,
      '围栏外的链接必须被改写');

    /* 围栏内两条必须原样 —— 那是历史示例，改了会篡改快照。 */
    assert.ok(result.content.includes('见 [示例](../bug-fix/example.md);'),
      'js 围栏内的示例不得改写');
    assert.ok(result.content.includes('见 [示例2](../bug-fix/example2.md)'),
      'tilde 围栏内的示例不得改写');
    assert.equal(result.changed, 2, `只该改两条，实际 ${result.changed}`);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});
