/** 归档基线回归：使用真实临时 Git 仓库与门禁子进程。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

for (const [label, historical, current, reason] of [
  ['历史清单损坏必须失败', '{broken', '{"version":1,"files":{}}', /Archive manifest validation failed/],
  ['历史 files 数组必须失败', '{"version":1,"files":[]}', '{"version":1,"files":{}}', /Invalid baseline files map/],
  ['历史封印删除必须失败', '{"version":1,"files":{"testing/old.md":"seal-a"}}', '{"version":1,"files":{}}', /Archived seal changed or removed/],
  ['历史封印修改必须失败', '{"version":1,"files":{"testing/old.md":"seal-a"}}', '{"version":1,"files":{"testing/old.md":"seal-b"}}', /Archived seal changed or removed/]
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
