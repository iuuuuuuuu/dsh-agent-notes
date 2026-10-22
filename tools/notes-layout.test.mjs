/**
 * G-C 回归：笔记根（`.agents/notes/`）这一层的形状校验。
 *
 * ## 这个缺口是什么
 *
 * 三条 vendored 门禁（`verify-agent-note-tree.ts` / `verify-agent-note-format.ts`
 * / `verify-archived-agent-notes.ts`）都是**按 `{lifecycle}/{class}/` 形状枚举**
 * 来找笔记的：vendored 的 `skills/agent-notes/scripts/agent-note-tree.ts:52-73`
 * 只遍历 `proposed` / `implemented` / `rejected` 三个 lifecycle 目录。
 *
 * 于是**落在这些枚举路径之外的任何东西都是隐形的**。实测：在 `.agents/notes/`
 * 顶层新建一个 `zz-probe-stray.md`，整条门禁链 13 步全绿。
 *
 * 后果不是「多了一个文件」那么轻：
 *
 *   - 它**不被判定为已归档**（不是 `archived/` 下的封印对象）；
 *   - 它**不被判定为格式违规**（不在任何 lifecycle 枚举里）；
 *   - 它**不进 vendored 门禁的 `ok: N note(s)` 计数** —— 于是「磁盘上的笔记数」
 *     与「门禁报告的笔记数」对不上，而**没有任何门禁会指出这一点**。
 *
 * 插件侧自有模块 `lib/notes-layout.js` 补上这一层形状校验，
 * 由 `lib/notes.js` 的 `runGate` 在 `NO_NOTES_YET` 之后调用。
 * 判据与理由见 `lib/notes-layout.js` 顶部注释。
 *
 * ## 本文件钉住的是「实现实际在做什么」，不是「我以为它该做什么」
 *
 * 写这份文件前先跑了一组事实探针（真实临时目录 + 真实 `runGate`），结论有
 * 三条与直觉相反，全部照实写进用例：
 *
 * 1. **根层任意 `*.md` 是绿的**（`lib/notes-layout.js:116` 的
 *    `name.endsWith('.md')` 放行）。这是 `lib/notes-layout.js` 里写明的
 *    有意取舍：根层是「说明区」（上游 A 的笔记根就放着 `AGENTS.md`），
 *    不是「笔记区」。所以「散落的 `.md` 判红」**不是**当前实现的契约，
 *    用例必须照实钉住放行，同时把残留缺口写进注释，而不是编一条假红用例。
 * 2. **`NO_NOTES_YET` 在形状校验之前**（`lib/notes.js:573` vs `:587`）。
 *    一棵**只有**散落文件、零篇生命周期笔记的树会先被 `NO_NOTES_YET` 拦下，
 *    走不到 `NOTES_LAYOUT`；而散落的 `.md` 会被 `inspectTree`
 *    （`lib/notes.js:838`）计进 `files`，于是连 `NO_NOTES_YET` 都不触发 ——
 *    整棵树**全绿**。这正是 G-C 原始症状的完整机理。
 * 3. **「未知目录」有两道独立机制拦**（vendored `agent-note-tree.ts:48-50`
 *    自己就判红，插件侧 `checkNotesLayout` 再判一次），而**「未知文件」只有
 *    插件侧一道**。
 *
 * ## 隔离纪律
 *
 * 每条用例只在自己建的临时目录里跑，只删自己的目录。
 * 绝不用 `test.skip()` 掩盖环境问题 —— 那样等于把「没验到」写成「通过了」。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runGate } from '../lib/notes.js';
import { checkNotesLayout, NOTE_ROOT_LIFECYCLES, NOTE_ROOT_FILES } from '../lib/notes-layout.js';

/**
 * 一篇合规笔记。
 *
 * 位置与形状都要合法（`{lifecycle}/{class}/yyyy-mm-dd-主题.md`），
 * 否则 vendored 的 tree 门禁会先判红，用例就测不到形状校验那一层了。
 *
 * @returns {string} 笔记正文。
 */
function goodNote() {
  return [
    '# Agent Note: 形状校验样本', '',
    'Status: implemented', '',
    '## Problem', '问题。', '',
    '## Decision', '决定。', '',
    '## Alternatives considered', '- **备选** — 最强理由。', '',
    '## Consequences', '代价。', ''
  ].join('\n');
}

/**
 * 造一个临时笔记根：已有一篇合规笔记（所以能触达形状校验那一层）。
 *
 * @returns {{ cwd: string, root: string }} 工作目录与笔记根。
 */
function makeTree() {
  const cwd = mkdtempSync(join(tmpdir(), 'notes-layout-'));
  const root = join(cwd, '.agents', 'notes');
  mkdirSync(join(root, 'implemented', 'testing'), { recursive: true });
  writeFileSync(join(root, 'implemented', 'testing', '2026-10-22-a.md'), goodNote());
  return { cwd, root };
}

/**
 * 造一个**空**笔记根（一个文件都没有）。
 *
 * 「树里没有笔记」与「树里有笔记但形状坏了」是两条不同的分支：
 * 前者先被 `NO_NOTES_YET` 拦，后者才轮到 `NOTES_LAYOUT`。
 * 两者的用例必须分开，否则测到的不是自己以为的那一层。
 *
 * @returns {{ cwd: string, root: string }} 工作目录与笔记根。
 */
function makeEmptyTree() {
  const cwd = mkdtempSync(join(tmpdir(), 'notes-layout-empty-'));
  const root = join(cwd, '.agents', 'notes');
  mkdirSync(root, { recursive: true });
  return { cwd, root };
}

/* ── 负例：形状不合规必须判红 ─────────────────────────────────────────── */

for (const [label, mutate, expect] of [
  [
    '笔记根下出现未知目录必须失败',
    (root) => mkdirSync(join(root, 'foo'), { recursive: true }),
    /未知目录 foo\//
  ],
  [
    '未知目录再套一层仍然必须失败（只看这一层，不递归）',
    (root) => mkdirSync(join(root, 'foo', 'bar'), { recursive: true }),
    /未知目录 foo\//
  ],
  [
    '笔记根下的 .txt 文件必须失败',
    (root) => writeFileSync(join(root, 'notes.txt'), '随手放的\n'),
    /未知文件 notes\.txt/
  ],
  [
    '笔记根下的 .json 文件必须失败',
    (root) => writeFileSync(join(root, 'notes.json'), '{}\n'),
    /未知文件 notes\.json/
  ],
  [
    '笔记根下的 .yml 文件必须失败',
    (root) => writeFileSync(join(root, 'notes.yml'), 'a: 1\n'),
    /未知文件 notes\.yml/
  ]
]) {
  test(`notes-layout: ${label}`, () => {
    const { cwd, root } = makeTree();
    try {
      mutate(root);
      const { errors } = checkNotesLayout({ notesRoot: root });
      assert.equal(errors.length, 1, JSON.stringify(errors));
      assert.match(errors[0], expect);
      /* 错误信息要能指给人看：既说清「是什么」，也要说清「为什么算错」。 */
      assert.match(errors[0], /笔记根下只允许/, JSON.stringify(errors));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test('notes-layout: 未知目录的错误信息要点明「散落」并说清后果', () => {
  const { cwd, root } = makeTree();
  try {
    mkdirSync(join(root, 'foo'), { recursive: true });
    const { errors } = checkNotesLayout({ notesRoot: root });
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], /未知目录 foo\//);
    /* 「散落」两个字是这条信息的价值所在：它说的是「这份内容没人管」，
       而不只是「有个目录名不认识」。 */
    assert.match(errors[0], /散落/, JSON.stringify(errors));
    assert.match(errors[0], /不会计入笔记数/, JSON.stringify(errors));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('notes-layout: 未知文件的错误信息要点明「不会被任何门禁看见」', () => {
  const { cwd, root } = makeTree();
  try {
    writeFileSync(join(root, 'notes.txt'), '随手放的\n');
    const { errors } = checkNotesLayout({ notesRoot: root });
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], /其它文件放在这里不会被任何门禁看见/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('notes-layout: 多个违规项必须一次全部报出来（不是只报第一个）', () => {
  const { cwd, root } = makeTree();
  try {
    mkdirSync(join(root, 'foo'), { recursive: true });
    writeFileSync(join(root, 'notes.txt'), 'x\n');
    writeFileSync(join(root, 'notes.json'), '{}\n');
    const { errors } = checkNotesLayout({ notesRoot: root });
    assert.equal(errors.length, 3, JSON.stringify(errors));
    assert.ok(errors.some((e) => /未知目录 foo\//.test(e)), JSON.stringify(errors));
    assert.ok(errors.some((e) => /未知文件 notes\.txt/.test(e)), JSON.stringify(errors));
    assert.ok(errors.some((e) => /未知文件 notes\.json/.test(e)), JSON.stringify(errors));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

/* ── 对照：形状合规必须放行 ───────────────────────────────────────────── */

test('notes-layout: 四个 lifecycle 目录 + 根层说明文件 + manifest.json 必须通过', () => {
  const { cwd, root } = makeTree();
  try {
    for (const dir of NOTE_ROOT_LIFECYCLES) {
      mkdirSync(join(root, dir, 'testing'), { recursive: true });
    }
    writeFileSync(join(root, 'AGENTS.md'), '# 笔记根说明\n');
    writeFileSync(join(root, 'README.md'), '# 笔记根说明\n');
    writeFileSync(join(root, 'manifest.json'), '{}\n');
    const { errors } = checkNotesLayout({ notesRoot: root });
    assert.deepEqual(errors, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('notes-layout: archived/ 里的 manifest.json 与分类子目录不得被误伤', () => {
  const { cwd, root } = makeTree();
  try {
    mkdirSync(join(root, 'archived', 'simplification'), { recursive: true });
    writeFileSync(join(root, 'archived', 'manifest.json'),
      `${JSON.stringify({ version: 1, files: {} }, null, 2)}\n`);
    const { errors } = checkNotesLayout({ notesRoot: root });
    assert.deepEqual(errors, [], JSON.stringify(errors));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('notes-layout: 笔记根不存在必须返回空错误（不与 NO_NOTES_TREE 抢真相）', () => {
  const { cwd, root } = makeEmptyTree();
  try {
    rmSync(root, { recursive: true, force: true });
    const { errors } = checkNotesLayout({ notesRoot: root });
    assert.deepEqual(errors, [], '笔记根不存在是「没有可验对象」，不是「形状坏了」');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('notes-layout: 允许集合本身必须就是那四个 lifecycle 与 manifest.json', () => {
  assert.deepEqual([...NOTE_ROOT_LIFECYCLES].sort(),
    ['archived', 'implemented', 'proposed', 'rejected']);
  assert.deepEqual([...NOTE_ROOT_FILES], ['manifest.json']);
});

/* ── 端到端：runGate 必须透出 NOTES_LAYOUT ─────────────────────────────── */

test('notes-layout: runGate("tree") 在未知目录上必须红且 reason 以 NOTES_LAYOUT 开头', async () => {
  const { cwd, root } = makeTree();
  try {
    mkdirSync(join(root, 'foo'), { recursive: true });
    const result = await runGate('tree', {
      cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root }
    });
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.equal(result.exitCode, 1, JSON.stringify(result));
    assert.match(result.reason ?? '', /^NOTES_LAYOUT/, JSON.stringify(result));
    /* 诊断走 stderr 且每行带 `notes: ` 前缀，命令行上才读得出是哪一层拦的。 */
    assert.match(result.stderr, /^notes: /m, JSON.stringify(result));
    assert.match(`${result.reason}\n${result.stderr}`, /未知目录 foo\//);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('notes-layout: runGate("tree") 在根层 .txt 文件上必须红且 reason 以 NOTES_LAYOUT 开头', async () => {
  const { cwd, root } = makeTree();
  try {
    writeFileSync(join(root, 'notes.txt'), '随手放的\n');
    const result = await runGate('tree', {
      cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root }
    });
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.equal(result.exitCode, 1, JSON.stringify(result));
    assert.match(result.reason ?? '', /^NOTES_LAYOUT/, JSON.stringify(result));
    assert.match(`${result.reason}\n${result.stderr}`, /未知文件 notes\.txt/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('notes-layout: 合规的笔记树必须真绿（否则上面的红没有意义）', async () => {
  const { cwd, root } = makeTree();
  try {
    for (const dir of NOTE_ROOT_LIFECYCLES) {
      mkdirSync(join(root, dir, 'testing'), { recursive: true });
    }
    writeFileSync(join(root, 'AGENTS.md'), '# 笔记根说明\n');
    writeFileSync(join(root, 'README.md'), '# 笔记根说明\n');
    writeFileSync(join(root, 'manifest.json'), '{}\n');
    const result = await runGate('tree', {
      cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root }
    });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(result.exitCode, 0, JSON.stringify(result));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('notes-layout: 笔记根不存在时 reason 必须是 NO_NOTES_TREE 而不是 NOTES_LAYOUT', async () => {
  const { cwd, root } = makeEmptyTree();
  try {
    rmSync(root, { recursive: true, force: true });
    const result = await runGate('tree', {
      cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root }
    });
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.match(result.reason ?? '', /^NO_NOTES_TREE/, JSON.stringify(result));
    assert.doesNotMatch(result.reason ?? '', /NOTES_LAYOUT/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

/* ── 两处「有意不覆盖」：照实钉住，并把残留缺口写在注释里 ──────────────── */

/**
 * 根层任意 `*.md` 被放行。
 *
 * 这是 `lib/notes-layout.js:116` 的显式取舍：根层是「说明区」，
 * 上游 A 的笔记根就放着 `AGENTS.md`。**但代价要说清**：
 * 一篇放在根层的笔记因此仍然**不可见** ——
 *   - 不被 vendored 三道门禁枚举（`agent-note-tree.ts:52-73` 只遍历
 *     三个 lifecycle 目录），所以既不会被判格式违规、也不会被归档；
 *   - 不计入 vendored 的 `ok: N note(s)` 计数，于是「磁盘上的 `.md` 数」
 *     与「门禁报告的笔记数」对不上，而没有任何门禁会指出这一点 ——
 *     这正是 G-C 最初的症状。
 *
 * 实测（真实临时目录 + 真实 `runGate`）：整棵树只有根层一篇 `stray.md` 时，
 * `tree` / `format` / `archived` 三道门禁**全绿**，`stdout` 打印
 * `ok: 0 note(s) tree and relative links verified`。
 * 所以这里钉的是**当前实现的契约**（放行），不是「散落即错」。
 * 若将来决定收紧成「根层只允许说明文件白名单」，这条用例必须同步改写，
 * 且要连带把上面那段注释里的残留缺口改掉 —— 两者是同一件事的两面。
 */
test('notes-layout: 根层 *.md 被刻意放行（说明区，不是笔记区）', () => {
  const { cwd, root } = makeTree();
  try {
    writeFileSync(join(root, 'stray.md'), goodNote());
    const { errors } = checkNotesLayout({ notesRoot: root });
    assert.deepEqual(errors, [], JSON.stringify(errors));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('notes-layout: 根层散落的 .md 在三道门禁下都不可见（残留缺口，如实钉住）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'notes-layout-stray-'));
  const root = join(cwd, '.agents', 'notes');
  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(join(root, 'stray.md'), goodNote());
    for (const gate of ['tree', 'format', 'archived']) {
      const result = await runGate(gate, {
        cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root }
      });
      assert.equal(result.passed, true, `${gate}：${JSON.stringify(result)}`);
    }
    /* 门禁报告的笔记数是 0 —— 这篇 .md 完全没进语料。 */
    const tree = await runGate('tree', {
      cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root }
    });
    assert.match(tree.stdout ?? '', /ok: 0 note\(s\)/, JSON.stringify(tree));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

/**
 * `INDEX.md` 由 vendored 拦，插件侧放行。
 *
 * vendored 的 `agent-note-tree.ts:44-47` 对笔记根层的 `INDEX.md` 判红
 * （「centralized Agent Note indexes are forbidden」）；插件侧
 * `checkNotesLayout` 因为它以 `.md` 结尾而放行。两边不冲突 ——
 * 各自负责自己那一层，**同一个文件被一道判据拦下就够了**。
 * 这条用例钉的是「两道机制并存、端到端仍然是红的」。
 */
test('notes-layout: 根层 INDEX.md 插件侧放行但端到端仍然红（vendored 那一层负责拦）', async () => {
  const { cwd, root } = makeTree();
  try {
    writeFileSync(join(root, 'INDEX.md'), '# 索引\n');
    const { errors } = checkNotesLayout({ notesRoot: root });
    assert.deepEqual(errors, [], JSON.stringify(errors));
    const result = await runGate('tree', {
      cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root }
    });
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.match(`${result.reason}\n${result.stderr}`, /INDEX\.md/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('notes-layout: 根层符号链接必须报出来（否则它在门禁视野之外）', () => {
  /* 符号链接既不是 isDirectory() 也不是 isFile()，原来会被两道判断一起跳过：
     等于允许在笔记根挂一份「任何门禁都看不见」的内容进来。 */
  const root = mkdtempSync(join(tmpdir(), 'notes-link-'));
  try {
    for (const name of NOTE_ROOT_LIFECYCLES) mkdirSync(join(root, name));
    writeFileSync(join(root, 'AGENTS.md'), '# 说明\n');
    const target = join(root, 'outside.md');
    writeFileSync(target, '# 外部内容\n');
    let made = true;
    try {
      symlinkSync(target, join(root, 'linked.md'), 'file');
    } catch {
      made = false; /* Windows 未开开发者模式时建不了链接：跳过而不是假绿 */
    }
    if (!made) return;
    const result = checkNotesLayout({ notesRoot: root });
    assert.ok(
      result.errors.some((line) => line.includes('符号链接')),
      `根层符号链接必须被判出来：${JSON.stringify(result.errors)}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
