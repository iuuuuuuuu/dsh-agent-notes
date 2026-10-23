/**
 * `tools/corpus-floor.mjs` 的行为测试。
 *
 * ## 这个门禁在补什么
 *
 * 门禁判定的是**语料**。语料被收窄时，门禁不会红 —— 它只是变得没那么
 * 有效了，而报告上写着「通过」。
 *
 * 所以这道门禁的用例必须证明两件事：
 *
 * 1. **收窄时它会红**（真故障注入的等价物，见 `.agents/notes/implemented/
 *    process/2026-10-22-gate-corpus-must-not-narrow.md`）。
 * 2. **正常时它不会误报** —— 仓库长大（语料变大）不该红，只有变**小**
 *    才该红。
 *
 * ## 夹具策略
 *
 * 用**真实收集函数**在临时目录上跑，而不是给 `checkCorpusFloor` 塞假
 * 语料：门禁的价值恰恰在于「它查的是门禁真正在用的那个收集函数」。
 * 所以夹具造的是一个小仓库，`collect` 会真的去那里找文件。
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { GATES, areaOf, checkCorpusFloor, loadManifest } from './corpus-floor.mjs';

const ROOT = join(import.meta.dirname, '..');

/** 一份「什么下限都能过」的清单（测试用；区域判据才是主判据）。 */
const LOOSE = Object.fromEntries(GATES.map((g) => [g.gate, { min: 1, reason: '测试夹具' }]));

/**
 * 在临时目录里造一个迷你仓库。
 *
 * @param {Record<string, string>} files 相对路径 → 内容。
 * @returns {string} 仓库根。
 */
function sandbox(files) {
  const dir = mkdtempSync(join(tmpdir(), 'an-corpus-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

/** 一个「各区域齐全」的迷你仓库。 */
function fullSandbox() {
  return sandbox({
    'AGENTS.md': '# 顶层\n',
    'README.md': '# 读我\n',
    'docs/x.md': '# 文档\n',
    '.agents/notes/implemented/process/a.md': '# 笔记\n',
    '.agents/notes/archived/process/b.md': '# 归档\n',
    'lib/i.js': 'export const a = 1;\n',
    'src/c.js': 'export const b = 2;\n',
    'tools/t.mjs': 'export const c = 3;\n',
    '.github/workflows/w.yml': 'name: w\n',
    '.githooks/commit-msg': '#!/bin/sh\n',
    'skills/agent-notes/SKILL.md': '# vendored\n'
  });
}

test('corpus: 当前仓库的语料都覆盖各自区域且不低于下限', () => {
  const result = checkCorpusFloor({ root: ROOT });
  assert.deepEqual(result.errors, [], `语料不该被收窄：\n${result.errors.join('\n')}`);
  assert.equal(result.checked, GATES.length);
});

test('corpus: 区域划分把归档与 vendored 分开算', () => {
  /* 顺序有讲究：`.agents/notes/archived/` 必须先于 `.agents/notes/` 命中，
     否则归档笔记会被算进「笔记」区，而归档区在很多门禁里是被排除的。 */
  assert.equal(areaOf('.agents/notes/archived/process/x.md'), 'archived-notes');
  assert.equal(areaOf('.agents/notes/implemented/process/x.md'), 'notes');
  assert.equal(areaOf('skills/agent-notes/SKILL.md'), 'vendored');
  assert.equal(areaOf('docs/x.md'), 'docs');
  assert.equal(areaOf('tools/x.mjs'), 'tools');
  assert.equal(areaOf('.githooks/commit-msg'), 'githooks');
  assert.equal(areaOf('AGENTS.md'), 'root');
});

test('corpus: 删掉 docs/ 语料必须红（区域对账）', () => {
  /* 失效形态：md-links 里删掉 walk('docs') → docs/ 的 2 篇脱离语料，
     而门禁照样绿。这条用例证明本门禁能接住它。 */
  const dir = sandbox({
    'AGENTS.md': '# 顶层\n',
    '.agents/notes/implemented/process/a.md': '# 笔记\n'
  });
  try {
    const result = checkCorpusFloor({ root: dir, manifest: LOOSE });
    assert.ok(result.errors.length > 0, 'docs 区域缺失必须红');
    assert.match(result.errors.join('\n'), /docs\/` 区域/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corpus: 笔记树整体脱离语料必须红', () => {
  const dir = sandbox({
    'AGENTS.md': '# 顶层\n',
    'docs/x.md': '# 文档\n',
    'lib/i.js': 'export const a = 1;\n',
    'src/c.js': 'export const b = 2;\n',
    'tools/t.mjs': 'export const c = 3;\n',
    '.github/workflows/w.yml': 'name: w\n'
  });
  try {
    const result = checkCorpusFloor({ root: dir, manifest: LOOSE });
    assert.ok(result.errors.length > 0, '笔记区域缺失必须红');
    assert.match(result.errors.join('\n'), /notes\/` 区域/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corpus: 数量低于下限必须红', () => {
  const dir = fullSandbox();
  try {
    /* 区域齐全，但把 eol 的下限调到 1000（当前只有 11 个 tracked 文件）。 */
    const manifest = { ...LOOSE, eol: { min: 1000, reason: '测试：故意抬到不可能达到' } };
    const result = checkCorpusFloor({ root: dir, manifest });
    assert.ok(result.errors.length > 0, '低于数量下限必须红');
    assert.match(result.errors.join('\n'), /低于下限 1000/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corpus: 语料变大（仓库长大）不得红', () => {
  const dir = fullSandbox();
  try {
    const result = checkCorpusFloor({ root: dir, manifest: LOOSE });
    assert.deepEqual(result.errors, [], '语料变大不该红 —— 只有变小才该红');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corpus: 清单缺条目 / 下限无理由必须红', () => {
  const dir = fullSandbox();
  try {
    const missing = checkCorpusFloor({ root: dir, manifest: {} });
    assert.ok(missing.errors.length > 0, '清单缺条目必须红');
    assert.match(missing.errors.join('\n'), /没有这条门禁的数量下限/);

    const noReason = checkCorpusFloor({
      root: dir,
      manifest: { ...LOOSE, 'md-links': { min: 1, reason: '  ' } }
    });
    assert.ok(noReason.errors.length > 0, '没有理由的下限必须红');
    assert.match(noReason.errors.join('\n'), /没有写理由/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corpus: 下限必须是正整数', () => {
  const dir = fullSandbox();
  try {
    const result = checkCorpusFloor({
      root: dir,
      manifest: { ...LOOSE, 'md-links': { min: 0, reason: 'x' } }
    });
    assert.ok(result.errors.length > 0, '非正下限必须红');
    assert.match(result.errors.join('\n'), /正整数/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corpus: 真实清单每条都写了理由', () => {
  const manifest = loadManifest();
  for (const spec of GATES) {
    const floor = manifest[spec.gate];
    assert.ok(floor !== undefined, `${spec.gate} 必须在清单里`);
    assert.ok(floor.min > 0, `${spec.gate} 的下限必须是正整数`);
    assert.ok(floor.reason.trim().length > 0, `${spec.gate} 的下限必须写理由`);
  }
});

test('corpus: CLI 在语料被收窄时非零退出（真跑子进程）', () => {
  /* 这条是「门禁自身能变红」的证据：CLI 走的是 checkCorpusFloor 之外的
     路径（读真实清单、判退出码）。 */
  const dir = mkdtempSync(join(tmpdir(), 'an-corpus-cli-'));
  try {
    execFileSync('git', ['init', '-q', '.'], { cwd: dir, windowsHide: true });
    /* 只放一个 AGENTS.md：其余区域全空 → 必然红。 */
    writeFileSync(join(dir, 'AGENTS.md'), '# 顶层\n', 'utf8');
    const result = execFileSync(
      process.execPath,
      [join(ROOT, 'tools', 'corpus-floor.mjs'), '--root', dir],
      { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }
    );
    assert.fail(`不该通过：${result}`);
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    assert.notEqual(error.status, 0, '语料被收窄时 CLI 必须非零退出');
    assert.match(output, /语料下限校验失败/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corpus: 语料为空必须红（空集合不得当绿）', () => {
  /* 判别力缺口：这条守卫原来**没有任何用例**。把 `errors.push('语料为空')` 那行
     换成 `void 0` 之后，`continue` 仍然跳过区域对账与数量下限，于是整份
     `errors` 为空、门禁照样绿 —— 一轮变异普查里它是唯一存活的那个。 */
  const dir = sandbox({});
  try {
    const result = checkCorpusFloor({ root: dir, manifest: LOOSE });
    assert.equal(result.checked, GATES.length);
    assert.equal(
      result.errors.filter((e) => e.includes('语料为空')).length,
      GATES.length,
      `每道门禁都要报「语料为空」：\n${result.errors.join('\n')}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
