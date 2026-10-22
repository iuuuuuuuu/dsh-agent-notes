/**
 * 归档树布局/元数据/封印 schema 的回归。
 *
 * ## 为什么要有这组用例
 *
 * 归档门禁是「包装层 + vendored 脚本」两层，两层加起来仍漏一整类问题：
 * 归档区的**形状**（多出来的文件、未知分类目录、嵌套子目录）、
 * **日期真实性**（`2026-13-45`）、**日期次序**（归档日期早于文件名日期）、
 * **manifest 的封闭 schema**、以及**旁挂文件（`.zh.md`）不受封印管辖**。
 * 这些在 vendored 脚本里全部 exit 0 —— 判据见 `lib/archive-layout.js` 顶部注释。
 *
 * 判据来源是上游 A 的 `scripts/verify-archived-agent-notes.ts` +
 * `scripts/archived-agent-notes.ts`（commit 687f282e…），
 * 本仓库刻意不跟的部分写在 `lib/archive-layout.js` 的注释里。
 *
 * ## 隔离纪律
 *
 * 每条用例只在自己建的临时目录里跑，只删自己的目录。
 * 绝不用 `test.skip()` 掩盖环境问题 —— 那样等于把「没验到」写成「通过了」。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runGate } from '../lib/notes.js';
import { checkArchiveLayout, checkManifestSchema, isRealDate } from '../lib/archive-layout.js';

/**
 * 一篇合规的归档笔记。
 *
 * @param {string} archivedDate `Archived:` 行上的日期。
 * @returns {string} 笔记正文。
 */
function archivedNote(archivedDate) {
  return [
    '# Agent Note: 归档布局样本', '',
    'Status: implemented',
    `Archived: ${archivedDate}`, '',
    '## Problem', '问题。', '',
    '## Decision', '决定。', '',
    '## Alternatives considered', '- **备选** — 最强理由。', '',
    '## Consequences', '代价。', ''
  ].join('\n');
}

/**
 * 造一个带一篇活跃笔记的临时笔记树。
 *
 * @returns {{ cwd: string, root: string }} 仓库根与笔记根。
 */
function makeTree() {
  const cwd = mkdtempSync(join(tmpdir(), 'notes-archive-layout-'));
  const root = join(cwd, '.agents', 'notes');
  mkdirSync(join(root, 'implemented', 'testing'), { recursive: true });
  writeFileSync(join(root, 'implemented', 'testing', '2026-01-01-live.md'), [
    '# Agent Note: 活跃样本', '', 'Status: implemented', '',
    '## Problem', '问题。', '',
    '## Decision', '决定。', '',
    '## Alternatives considered', '- **备选** — 最强理由。', '',
    '## Consequences', '代价。', ''
  ].join('\n'));
  return { cwd, root };
}

/**
 * 在笔记树里放一篇归档笔记并按当前内容算封印。
 *
 * @param {string} root 笔记根。
 * @param {string} rel 相对 `archived/` 的路径。
 * @param {string} content 正文。
 * @returns {string} 封印值。
 */
function seal(root, rel, content) {
  const target = join(root, 'archived', rel);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
  const digest = createHash('sha256').update(readFileSync(target)).digest('hex');
  return `sha256:${digest}`;
}

/**
 * 写 manifest。
 *
 * @param {string} root 笔记根。
 * @param {Record<string, string>} files 封印表。
 */
function writeManifest(root, files) {
  mkdirSync(join(root, 'archived'), { recursive: true });
  writeFileSync(join(root, 'archived', 'manifest.json'),
    `${JSON.stringify({ version: 1, files }, null, 2)}\n`);
}

for (const [label, rel, archivedDate, mutate, expect] of [
  [
    '归档根目录出现未知文件必须失败',
    null, null,
    (root) => {
      mkdirSync(join(root, 'archived'), { recursive: true });
      writeFileSync(join(root, 'archived', 'stray.md'), '随手放的\n');
    },
    /归档根目录只允许/
  ],
  [
    '未知分类目录必须失败',
    null, null,
    (root) => mkdirSync(join(root, 'archived', 'bogus'), { recursive: true }),
    /未知归档分类目录/
  ],
  [
    '分类目录下再套一层目录必须失败',
    null, null,
    (root) => mkdirSync(join(root, 'archived', 'testing', 'sub'), { recursive: true }),
    /不允许子目录/
  ],
  [
    '归档文件名缺日期必须失败',
    'testing/notes-a.md', '2026-01-01',
    (root) => {
      const target = join(root, 'archived', 'testing', 'notes-a.md');
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, archivedNote('2026-01-01'));
    },
    /归档文件名必须是/
  ],
  [
    '归档日期不是真实日期必须失败',
    'testing/2026-01-01-a.md', '2026-13-45',
    (root) => {
      const target = join(root, 'archived', 'testing', '2026-01-01-a.md');
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, archivedNote('2026-13-45'));
    },
    /不是真实存在的日期/
  ],
  [
    '归档日期早于文件名日期必须失败',
    'testing/2026-01-01-a.md', '2025-12-31',
    (root) => {
      const target = join(root, 'archived', 'testing', '2026-01-01-a.md');
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, archivedNote('2025-12-31'));
    },
    /早于笔记文件名日期/
  ],
  [
    '旁挂 .zh.md 未封印必须失败',
    'testing/2026-01-01-a.zh.md', '2026-01-01',
    (root) => {
      const target = join(root, 'archived', 'testing', '2026-01-01-a.zh.md');
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, archivedNote('2026-01-01'));
    },
    /未在 manifest.json 里封印/
  ]
]) {
  test(`archived: ${label}`, async () => {
    const { cwd, root } = makeTree();
    try {
      mutate(root);
      const result = await runGate('archived', {
        cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root }
      });
      assert.equal(result.passed, false, JSON.stringify(result));
      assert.notEqual(result.exitCode, 0, JSON.stringify(result));
      assert.match(`${result.reason ?? ''}\n${result.stderr}`, expect);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test('archived: 形状合规的归档树必须通过', async () => {
  const { cwd, root } = makeTree();
  try {
    const sealValue = seal(root, 'testing/2026-01-01-a.md', archivedNote('2026-01-02'));
    writeManifest(root, { 'archived/testing/2026-01-01-a.md': sealValue });
    const result = await runGate('archived', {
      cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root }
    });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(result.exitCode, 0, JSON.stringify(result));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('archived: 旁挂 .zh.md 被封印后必须通过', async () => {
  const { cwd, root } = makeTree();
  try {
    const main = seal(root, 'testing/2026-01-01-a.md', archivedNote('2026-01-02'));
    const side = seal(root, 'testing/2026-01-01-a.zh.md', archivedNote('2026-01-02'));
    writeManifest(root, {
      'archived/testing/2026-01-01-a.md': main,
      'archived/testing/2026-01-01-a.zh.md': side
    });
    const result = await runGate('archived', {
      cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root }
    });
    assert.equal(result.passed, true, JSON.stringify(result));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('archived: archived/AGENTS.md 允许存在（不要求六个分类目录齐全）', async () => {
  const { cwd, root } = makeTree();
  try {
    mkdirSync(join(root, 'archived'), { recursive: true });
    writeFileSync(join(root, 'archived', 'AGENTS.md'), '# archived/ — 冻结只读\n');
    writeManifest(root, {});
    const result = await runGate('archived', {
      cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root }
    });
    assert.equal(result.passed, true, JSON.stringify(result));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('archived: manifest 的封闭 schema 必须被校验', async () => {
  const { cwd, root } = makeTree();
  try {
    mkdirSync(join(root, 'archived'), { recursive: true });
    writeFileSync(join(root, 'archived', 'manifest.json'),
      `${JSON.stringify({ version: 2, files: {}, extra: 1 }, null, 2)}\n`);
    const result = await runGate('archived', {
      cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root }
    });
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.match(`${result.reason ?? ''}\n${result.stderr}`, /字段封闭集/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('archived: manifest 里封了非归档路径必须失败', async () => {
  const { cwd, root } = makeTree();
  try {
    writeManifest(root, { 'implemented/testing/2026-01-01-live.md': 'sha256:'.padEnd(71, 'a') });
    const result = await runGate('archived', {
      cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root }
    });
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.match(`${result.reason ?? ''}\n${result.stderr}`, /archived\/ 开头的相对路径/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('archived: 封印格式非法必须失败', () => {
  const errors = checkManifestSchema(JSON.stringify({
    version: 1,
    files: { 'archived/testing/a.md': 'not-a-seal' }
  }));
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /封印格式非法/);
});

test('archived: manifest 非 JSON 必须失败', () => {
  const errors = checkManifestSchema('{broken');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /不是合法 JSON/);
});

test('archived: 日历真实性判定本身要准', () => {
  assert.equal(isRealDate(2026, 2, 29), false, '2026 不是闰年');
  assert.equal(isRealDate(2024, 2, 29), true, '2024 是闰年');
  assert.equal(isRealDate(2026, 13, 45), false);
  assert.equal(isRealDate(2026, 0, 1), false);
  assert.equal(isRealDate(2026, 12, 31), true);
});

test('archived: 布局检查对不存在的归档目录返回空错误', () => {
  const { cwd, root } = makeTree();
  try {
    const result = checkArchiveLayout({ notesRoot: root });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.artifacts, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
