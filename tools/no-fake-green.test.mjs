/**
 * 回归测试：笔记树不存在时，门禁**不得**返回绿。
 *
 * 这是实机发现的假绿（Owner 指出）：
 *   三个校验脚本在空目录上都 exit 0 并打印「ok: 0 note(s) verified」。
 *   从"脚本没说错"看是真的，从"我的笔记合规"看是空的。
 *   曾实测：一个 `.agents/notes` 根本不存在的仓库，三条门禁全 passed: true。
 *
 * 没东西可验 ≠ 验过了。所以 runGate 前置拦下，改报 NO_NOTES_TREE。
 * 同时必须保证：真的有合规笔记时仍然能通过（别把正常通路一起杀掉）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotesService } from '../lib/notes.js';

/** 建一个临时仓库目录（不建笔记树）。 */
function bareRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'an-bare-'));
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

/** 建一个有合规 implemented 笔记的仓库。 */
function goodRepo() {
  const dir = bareRepo();
  const target = join(dir, '.agents', 'notes', 'implemented', 'feature');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, '2026-10-17-ok.md'), [
    '# Agent Note: 合规模板',
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
    '另一条路更强的地方在于 X，但被 Y 否掉。',
    '',
    '## Consequences',
    '代价是 Z。',
    ''
  ].join('\n'));
  return dir;
}

test('空树：笔记树不存在时三条门禁全部判失败，且不给 exit 0', async () => {
  const dir = bareRepo();
  try {
    const notes = createNotesService({}, undefined);
    const result = await notes.runAll({ cwd: dir });
    assert.equal(result.passed, false, '空树绝不能报通过');
    assert.equal(result.noteCount, 0);
    for (const entry of result.results) {
      assert.equal(entry.passed, false, `${entry.gate} 在空树上不应通过`);
      assert.match(entry.reason, /NO_NOTES_TREE/, `${entry.gate} 应说明原因是空树`);
      // 关键：不能既说失败又留一个 exit 0 让人误读
      assert.equal(entry.exitCode, null, `${entry.gate} 没真跑，exitCode 不该是 0`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('空树：单条门禁同样判失败（不是只有 runAll 拦）', async () => {
  const dir = bareRepo();
  try {
    const notes = createNotesService({}, undefined);
    for (const gate of ['tree', 'format', 'archived']) {
      const one = await notes.runGate(gate, { cwd: dir });
      assert.equal(one.passed, false, `${gate} 单跑也应失败`);
      assert.match(one.reason, /NO_NOTES_TREE/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('空树：init 建出目录但零篇笔记，同样不算通过', async () => {
  const dir = bareRepo();
  try {
    const notes = createNotesService({}, undefined);
    notes.scaffold({ cwd: dir });
    // 目录有了，但一篇笔记都没有 —— 仍然是「没有可验对象」。
    const result = await notes.runAll({ cwd: dir });
    assert.equal(result.passed, false, '有树零篇也不能算通过');
    assert.equal(result.noteCount, 0);
    for (const entry of result.results) {
      assert.match(entry.reason, /NO_NOTES_YET/, `${entry.gate} 应说明是零篇`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('只根层散落一个 .md：零篇笔记，不许当通过', async () => {
  /* 实测过的假绿：笔记根下只放一个 `2026-01-01-looks-like-a-note.md`
     （不在任何生命周期目录里），三道门禁全都 `ok: 0 note(s)` 且 exit 0，
     `runAll` 报 `passed: true` —— 零篇被冒充成通过。
     根因是「有没有笔记」的判据用了 `files.length`（含散落件），
     而 vendored 门禁只按 `{lifecycle}/{class}/` 枚举。
     现在判据改用 `noteFiles`（只数生命周期目录里的），并单独报 `strayCount`。 */
  const dir = bareRepo();
  try {
    const root = join(dir, '.agents', 'notes');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '2026-01-01-looks-like-a-note.md'), '# 随便\n', 'utf8');
    const notes = createNotesService({}, undefined);
    const result = await notes.runAll({ cwd: dir });
    assert.equal(result.passed, false, '只有散落 .md 时绝不能报通过');
    assert.equal(result.noteCount, 0, '散落件不算笔记');
    assert.equal(result.strayCount, 1, '必须单独报出散落件数量');
    for (const entry of result.results) {
      assert.match(entry.reason, /NO_NOTES_YET/, `${entry.gate} 应说明是零篇`);
      assert.match(entry.reason, /另有 1 个 \.md 散落/, `${entry.gate} 应点出散落件`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('正常通路：有合规笔记时仍然通过（别把正常场景一起杀掉）', async () => {
  const dir = goodRepo();
  try {
    const notes = createNotesService({}, undefined);
    const result = await notes.runAll({ cwd: dir });
    assert.equal(result.noteCount, 1);
    assert.equal(result.passed, true, '合规笔记必须能通过');
    for (const entry of result.results) {
      assert.equal(entry.passed, true, `${entry.gate} 应通过`);
      assert.equal(entry.exitCode, 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('正常通路：有笔记但违规时仍然变红（没被前置检查掩盖）', async () => {
  const dir = bareRepo();
  try {
    const target = join(dir, '.agents', 'notes', 'implemented', 'feature');
    mkdirSync(target, { recursive: true });
    // implemented 里带 ## Proposal 是明令禁止的
    writeFileSync(join(target, '2026-10-17-bad.md'), [
      '# Agent Note: 违规',
      '',
      'Status: implemented',
      '',
      '## Problem',
      'x',
      '',
      '## Proposal',
      'y',
      '',
      '## Alternatives considered',
      'z',
      ''
    ].join('\n'));
    const notes = createNotesService({}, undefined);
    const result = await notes.runAll({ cwd: dir });
    assert.equal(result.passed, false, '违规笔记必须红');
    const format = result.results.find((entry) => entry.gate === 'format');
    assert.equal(format.passed, false);
    assert.equal(format.exitCode, 1, '真跑了就该是 1，而不是被前置检查替换成 null');
    assert.match(format.stdout + format.stderr, /banned in implemented/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
