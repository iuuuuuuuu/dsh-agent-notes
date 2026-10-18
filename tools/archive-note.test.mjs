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
 * @returns {{ code: number, out: string }} 结果。
 */
function run(dir, script, args = []) {
  const r = spawnSync(NODE, [join(dir, 'skills', 'agent-notes', 'scripts', script), ...args], {
    cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env }
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
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
    assert.equal(r.code, 1, `缺参数必须 exit 1，实际 ${r.code}`);
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
