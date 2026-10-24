// 回归：未闭合的 `<!--` 让 vendored 格式门禁误报「缺小节」，我们必须把成因说出来
//
// 现场（2026-10-22，sourin-flutter-spike）：一篇 implemented 笔记里写了
// `` `<!--` `` 这样的字面量（在行内代码里），vendored 蒙版把它之后的行
// 全当注释 ⇒ 报 `missing one of ["## Consequences", …]`，而那一节的标题
// 明明就在文件里。作者会去加重复小节、依然红，最后只能改门禁脚本。
//
// 判据：① 红/绿结论绝不能被这条补充改变（只有已经红才追加提示）；
//       ② 提示必须指名行号，且能被机械断言。

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { explainMaskedCommentSections, runGate } from '../lib/notes.js';

const NOTE_WITH_UNCLOSED = [
  '# Agent Note: 有未闭合注释的一篇',
  '',
  'Status: implemented',
  '',
  '## Problem',
  '',
  '正文里写了 `<!--` 这个字面量（没有闭合）。',
  '',
  '## Decision',
  '',
  '写点东西。',
  '',
  '## Alternatives considered',
  '',
  '写点东西。',
  '',
  '## Consequences',
  '',
  '写点东西。',
  ''
].join('\n');

const NOTE_CLEAN = NOTE_WITH_UNCLOSED.replace('`<!--` 这个字面量（没有闭合）', '`&lt;!--` 这个字面量');

/**
 * 正文里**真的**开了一个不闭合的 HTML 注释（不是行内代码里的展示语法）。
 *
 * 2026-10-24 起必须与上面那篇区分开：行内代码里的 `<!--` 已由
 * `lib/vendored-patch.js` 在执行期修正为**不参与**注释状态机（那才是对的），
 * 所以那一篇现在是**绿**的。只有真的开在散文里的注释才会遮住后面的小节，
 * 也才需要 `explainMaskedCommentSections()` 那句成因说明。
 */
const NOTE_UNCLOSED_PROSE = [
  '# Agent Note: 真的开了不闭合注释的一篇',
  '',
  'Status: implemented',
  '',
  '## Problem',
  '',
  '这里真的开了一个注释且不闭合：',
  '',
  '<!-- 开注释',
  '',
  '## Decision',
  '',
  '写点东西。',
  '',
  '## Alternatives considered',
  '',
  '写点东西。',
  '',
  '## Consequences',
  '',
  '写点东西。',
  ''
].join('\n');

test('explainMaskedCommentSections: 报错里没有 format: 行就什么都不说', () => {
  assert.equal(explainMaskedCommentSections('/nonexistent', 'whatever\n'), '');
});

test('explainMaskedCommentSections: 指名未闭合的那一行', () => {
  const root = mkdtempSync(join(tmpdir(), 'notes-masked-'));
  try {
    mkdirSync(join(root, 'implemented', 'bug-fix'), { recursive: true });
    writeFileSync(join(root, 'implemented', 'bug-fix', '2026-10-22-x.md'), NOTE_WITH_UNCLOSED, 'utf8');
    const out = explainMaskedCommentSections(
      root,
      'format: implemented/bug-fix/2026-10-22-x.md — missing one of ["## Consequences"]\n'
    );
    assert.match(out, /第 7 行有未闭合的 `<!--`/);
    assert.match(out, /缺小节/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('explainMaskedCommentSections: 闭合的注释不产生提示（不制造假警报）', () => {
  const root = mkdtempSync(join(tmpdir(), 'notes-masked-'));
  try {
    mkdirSync(join(root, 'implemented', 'bug-fix'), { recursive: true });
    writeFileSync(join(root, 'implemented', 'bug-fix', '2026-10-22-x.md'), NOTE_CLEAN, 'utf8');
    assert.equal(
      explainMaskedCommentSections(root, 'format: implemented/bug-fix/2026-10-22-x.md — missing one of ["## Consequences"]\n'),
      ''
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runGate(format): 真未闭合的散文注释仍红，且把成因附在 stderr 里', async () => {
  /* 2026-10-24 改：原先这条用的是「行内代码里写 `<!--`」那篇，
     而那种写法现在是**合法**的（执行期补丁已让行内代码不参与注释状态机）。
     要验「解释逻辑还活着」，夹具必须换成真的开在散文里的注释。 */
  const root = mkdtempSync(join(tmpdir(), 'notes-masked-'));
  try {
    mkdirSync(join(root, 'implemented', 'bug-fix'), { recursive: true });
    writeFileSync(join(root, 'implemented', 'bug-fix', '2026-10-22-x.md'), NOTE_UNCLOSED_PROSE, 'utf8');
    const r = await runGate('format', { cwd: process.cwd(), notesRoot: root });
    assert.equal(r.passed, false, '真未闭合的注释必须红');
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /missing one of/, '原报错必须保留（不能被我这句话盖掉）');
    assert.match(r.stderr, /有未闭合的 `<!--`/, '必须指名行号');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runGate(format): 行内代码里写 `<!--` 是合法内容，必须绿（2026-10-24 修复）', async () => {
  /* 现场（sourin-flutter-spike）：一篇**必须**写出这个字面量才能说明问题的笔记，
     曾因 vendored 的蒙版把行内代码也当注释而被判「缺小节」。
     执行期补丁（`lib/vendored-patch.js`）修好之后，这一篇必须是绿的 ——
     否则维护者只能删掉笔记里的关键事实来迁就工具。 */
  const root = mkdtempSync(join(tmpdir(), 'notes-masked-'));
  try {
    mkdirSync(join(root, 'implemented', 'bug-fix'), { recursive: true });
    writeFileSync(join(root, 'implemented', 'bug-fix', '2026-10-22-x.md'), NOTE_WITH_UNCLOSED, 'utf8');
    const r = await runGate('format', { cwd: process.cwd(), notesRoot: root });
    assert.equal(r.passed, true, `行内代码里的字面量不该开注释：${r.stderr}`);
    assert.equal(r.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runGate(format): 干净的一篇必须绿（补充逻辑不能自己把绿变红）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notes-masked-'));
  try {
    mkdirSync(join(root, 'implemented', 'bug-fix'), { recursive: true });
    writeFileSync(join(root, 'implemented', 'bug-fix', '2026-10-22-x.md'), NOTE_CLEAN, 'utf8');
    const r = await runGate('format', { cwd: process.cwd(), notesRoot: root });
    assert.equal(r.passed, true, `应绿，实际 exitCode=${r.exitCode}\n${r.stderr}`);
    assert.equal(r.stderr.includes('未闭合的'), false, '绿的时候不许附这段提示');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
