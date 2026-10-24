/** 归档基线回归：使用真实临时 Git 仓库与门禁子进程。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runGate } from '../lib/notes.js';

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'notes-archive-baseline-'));
  const root = join(cwd, '.agents', 'notes');
  const dir = join(root, 'implemented', 'testing');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-01-01-baseline.md'), [
    '# Agent Note: Archive baseline fixture', '', 'Status: implemented', '',
    '## Problem', 'Exercise baseline validation.', '',
    '## Decision', 'Use an isolated repository.', '',
    '## Alternatives considered', 'None.', '',
    '## Consequences', 'The fixture requires Git.', ''
  ].join('\n'));
  const git = (...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    git('init');
    git('add', '--', '.agents/notes');
    git('-c', 'user.name=Archive Test', '-c', 'user.email=archive-test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'Create isolated baseline');
    return { cwd, root };
  } catch (error) {
    rmSync(cwd, { recursive: true, force: true });
    throw error;
  }
}

/**
 * 历史/当前清单里用到的**合法**键与封印。
 *
 * ## 为什么不用随手编的假值
 *
 * `lib/notes.js` 的 archived 前置校验分两层：`lib/archive-layout.js` 先验**当前**
 * 清单的封闭 schema（键须 `archived/` 开头、封印须 `sha256:<64 位小写十六进制>`），
 * 然后才做**历史基线**的封印逐条比对。
 *
 * 夹具若写成 `"seal-a"` / `testing/old.md`，第一层就先判红，第二层根本不跑 ——
 * 测的就不是「封印被改」而是「清单 schema 不合法」，而断言还在等
 * `Archived seal changed or removed`，于是用例变成一个测不到目标机制的红。
 */
const OLD_KEY = 'archived/testing/2026-01-01-old.md';
const SEAL_A = `sha256:${'a'.repeat(64)}`;
const SEAL_B = `sha256:${'b'.repeat(64)}`;

for (const [label, historical, current, reason] of [
  ['历史清单损坏必须失败', '{broken', '{"version":1,"files":{}}', /Archive manifest validation failed/],
  ['历史 files 数组必须失败', '{"version":1,"files":[]}', '{"version":1,"files":{}}', /Invalid baseline files map/],
  ['历史封印删除必须失败', `{"version":1,"files":{"${OLD_KEY}":"${SEAL_A}"}}`, '{"version":1,"files":{}}', /Archived seal changed or removed/],
  ['历史封印修改必须失败', `{"version":1,"files":{"${OLD_KEY}":"${SEAL_A}"}}`, `{"version":1,"files":{"${OLD_KEY}":"${SEAL_B}"}}`, /Archived seal changed or removed/]
]) {
  test(`archived: ${label}`, async () => {
    const { cwd, root } = sealFixture(historical, current);
    try {
      const result = await runGate('archived', {
        cwd, notesRoot: root,
        env: { AGENT_NOTE_ROOT: root, AGENT_NOTE_ARCHIVE_BASE_REF: 'HEAD' }
      });
      assert.equal(result.passed, false, JSON.stringify(result));
      assert.notEqual(result.exitCode, 0, JSON.stringify(result));
      assert.match(`${result.reason ?? ''}\n${result.stderr}`, reason);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

/**
 * 造一个**带历史清单**的仓库：基线提交里就有 `archived/manifest.json`。
 *
 * 与 {@link fixture} 的区别在于「基线里已经有清单」这件事本身：它让
 * `git --literal-pathspecs ls-tree --full-tree` 必须真的**查到条目**。
 * 上一条路径若静默查不到，下面那组「历史清单损坏/封印被删」用例就会
 * 被当成「基线里没有清单」而放行 —— 所以这里必须有一个**应当通过**的用例，
 * 才能把「查到了并验过」与「压根没查到」区分开。
 *
 * @param {string} historical 基线提交里的清单内容。
 * @param {string} current 工作树里最终的清单内容。
 * @returns {{ cwd: string, root: string }} 仓库根与笔记根。
 */
function sealFixture(historical, current) {
  const { cwd, root } = fixture();
  const archived = join(root, 'archived');
  mkdirSync(archived, { recursive: true });
  const manifest = join(archived, 'manifest.json');
  const git = (...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  writeFileSync(manifest, historical);
  git('add', '--', '.agents/notes/archived/manifest.json');
  git('-c', 'user.name=Archive Test', '-c', 'user.email=archive-test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'Create historical manifest fixture');
  writeFileSync(manifest, current);
  return { cwd, root };
}

/**
 * 造一个「归档笔记 + 封印都已提交，随后被改并重新封印」的真实仓库。
 *
 * 这个夹具专门复现默认基线的问题：**连封印一起改**之后，当前 manifest 与
 * HEAD 的 manifest 是同一份，用 HEAD 做基线永远发现不了；只有对着一个
 * 「改之前」的 ref 比对才抓得到。
 *
 * @param {{ withOriginMain: boolean }} options 是否把改之前的提交登记为 origin/main。
 * @returns {{ cwd: string, root: string, baseline: string }} 仓库根、笔记根、基线 commit。
 */
function resealFixture(options) {
  const cwd = mkdtempSync(join(tmpdir(), 'notes-archive-reseal-'));
  const root = join(cwd, '.agents', 'notes');
  const archived = join(root, 'archived', 'testing');
  mkdirSync(archived, { recursive: true });
  const notePath = join(archived, '2026-01-01-x.md');
  const manifestPath = join(root, 'archived', 'manifest.json');
  const key = 'archived/testing/2026-01-01-x.md';

  const git = (...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const commit = (message) => git('-c', 'user.name=Archive Test', '-c', 'user.email=archive-test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', message);

  const write = (body) => {
    writeFileSync(notePath, [
      '# Agent Note: frozen fixture', '', 'Status: implemented', 'Archived: 2026-01-01', '',
      '## Problem', '', body, '',
      '## Decision', '', 'd', '',
      '## Alternatives considered', '', 'a', '',
      '## Consequences', '', 'c', ''
    ].join('\n'), 'utf8');
    const seal = `sha256:${createHash('sha256').update(readFileSync(notePath)).digest('hex')}`;
    writeFileSync(manifestPath, `${JSON.stringify({ version: 1, files: { [key]: seal } }, null, 2)}\n`, 'utf8');
  };

  try {
    git('init');
    write('原始内容');
    git('add', '--', '.agents/notes');
    commit('frozen baseline');
    const baseline = git('rev-parse', 'HEAD').trim();
    if (options.withOriginMain === true) {
      git('update-ref', 'refs/remotes/origin/main', baseline);
    }
    /* 改动内容**并同步更新封印**再提交 —— 这正是只有「对着旧 ref 比对」才抓得到的形态。 */
    write('被悄悄改过的内容');
    git('add', '--', '.agents/notes');
    commit('tamper and reseal');
    return { cwd, root, baseline };
  } catch (error) {
    rmSync(cwd, { recursive: true, force: true });
    throw error;
  }
}

test('archived: 默认基线钉 origin/main —— 连封印一起改并提交也必须判红', async () => {
  /* 2026-10-24 Owner 裁定「钉到 origin/main」。
     旧默认是 HEAD：当前与基线永远是同一份，这道检查等于空转（实测 exit=0）。 */
  const { cwd, root } = resealFixture({ withOriginMain: true });
  try {
    const result = await runGate('archived', {
      cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root }
    });
    assert.equal(result.passed, false, `改过的封印必须被发现：${JSON.stringify(result)}`);
    assert.equal(result.exitCode, 1);
    assert.match(`${result.reason ?? ''}${result.stderr}`, /Archived seal changed or removed/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('archived: 没有 origin/main 时退回 HEAD，且必须在输出里留痕', async () => {
  /* 退让是必要的（本地新仓/浅克隆没有远端），但不能静默 ——
     否则「冻结强度下降」只存在于注释里。 */
  const { cwd, root } = resealFixture({ withOriginMain: false });
  try {
    const result = await runGate('archived', {
      cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root }
    });
    assert.match(result.stderr, /没有可解析的 origin\/main/,
      `退回 HEAD 必须明确告警：${result.stderr}`);
    assert.match(result.stderr, /AGENT_NOTE_ARCHIVE_BASE_REF/,
      '告警要给出怎么补回真正的冻结');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('archived: 历史清单与当前一致时通过（证明 ls-tree 真的查到了条目）', async () => {
  const { cwd, root } = sealFixture('{"version":1,"files":{}}', '{"version":1,"files":{}}');
  try {
    const result = await runGate('archived', {
      cwd, notesRoot: root,
      env: { AGENT_NOTE_ROOT: root, AGENT_NOTE_ARCHIVE_BASE_REF: 'HEAD' }
    });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(result.exitCode, 0, JSON.stringify(result));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

/**
 * 造一个**空仓库**：`git init` 之后一次都没提交。
 *
 * 这不是假想场景：新建仓库、第一次会话就打开规范、还没提交过任何东西，
 * 是真实用法。此时 HEAD 是**未诞生**的符号引用，解析不出 commit。
 *
 * @returns {{ cwd: string, root: string }} 仓库根与笔记根。
 */
function unbornFixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'notes-archive-unborn-'));
  const root = join(cwd, '.agents', 'notes');
  const dir = join(root, 'implemented', 'testing');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-01-01-unborn.md'), [
    '# Agent Note: Unborn baseline fixture', '', 'Status: implemented', '',
    '## Problem', 'No commit exists yet.', '',
    '## Decision', 'Do not treat an unborn HEAD as an invalid baseline.', '',
    '## Alternatives considered', 'Fail closed on every unresolvable ref.', '',
    '## Consequences', 'An explicit ref still fails closed.', ''
  ].join('\n'));
  execFileSync('git', ['init'], { cwd, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { cwd, root };
}

test('archived: 空仓库（git init 未提交）不判基线非法', async () => {
  /* 历史为空 ⇒ 没有任何历史封印可对照，放行给 vendored 脚本验磁盘那份 manifest。
     修之前这里 exit=128 报 Invalid archive baseline commit，
     把「仓库还是空的」错报成「你的基线有问题」。 */
  const { cwd, root } = unbornFixture();
  try {
    const result = await runGate('archived', { cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root } });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(result.exitCode, 0, JSON.stringify(result));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('archived: 空仓库里显式指定的基线解析不出仍然失败关闭', async () => {
  const { cwd, root } = unbornFixture();
  try {
    const result = await runGate('archived', {
      cwd, notesRoot: root,
      env: { AGENT_NOTE_ROOT: root, AGENT_NOTE_ARCHIVE_BASE_REF: 'HEAD' }
    });
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.notEqual(result.exitCode, 0, JSON.stringify(result));
    assert.match(`${result.reason ?? ''}\n${result.stderr}`, /baseline/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const [label, ref, expected] of [
  ['有效提交中没有历史清单仍通过', 'HEAD', true],
  ['无效基线必须失败而非当作缺少清单', 'refs/heads/archive-baseline-does-not-exist', false]
]) {
  test(`archived: ${label}`, async () => {
    const { cwd, root } = fixture();
    try {
      const result = await runGate('archived', {
        cwd, notesRoot: root,
        env: { AGENT_NOTE_ROOT: root, AGENT_NOTE_ARCHIVE_BASE_REF: ref }
      });
      assert.equal(result.passed, expected, JSON.stringify(result));
      if (expected) assert.equal(result.exitCode, 0);
      else assert.match(`${result.reason ?? ''}\n${result.stderr}`, /baseline|基线/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test('archived: Git 本身故障时不许退回 HEAD 顶替（必须失败关闭）', async () => {
  /* CodeRabbit 在 PR #44 上点名：把「超时 / Git 执行错误」当成「没有 origin/main」，
     就会悄悄退回 HEAD，于是一批已提交的封印改动被放过，而门禁照样打印绿。
     这里用 GIT_DIR 指到一个不存在的目录制造真实的 Git 故障 ——
     判据是「不许绿」，而不是某个具体退出码（失败关闭的形态可以不同）。 */
  const { cwd, root } = resealFixture({ withOriginMain: true });
  try {
    const result = await runGate('archived', {
      cwd, notesRoot: root,
      env: { AGENT_NOTE_ROOT: root, GIT_DIR: join(cwd, 'no-such-git-dir') }
    });
    assert.equal(result.passed, false, `Git 故障下不许判绿：${JSON.stringify(result)}`);
    assert.notEqual(result.exitCode, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
