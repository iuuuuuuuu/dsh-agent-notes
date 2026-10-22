/**
 * 钉住事实：vendored 三道门禁在空集合上 exit 0，而 `lib/notes.js` 外壳判红。
 *
 * ## 为什么这条测试必须存在
 *
 * `tools/verify-notes.mjs` 与 `lib/notes.js` 的 `runGate` 里「没有可验对象
 * 不算通过」那一整套（`NO_NOTES_TREE` / `NO_NOTES_YET`），**唯一的存在理由**
 * 就是下面这个事实：
 *
 *   `skills/agent-notes/scripts/` 下三道脚本在零篇笔记时都 `exit 0`
 *   并打印 `ok: 0 ...`
 *
 * 「脚本没说错」是真的，「笔记合规」是空的。裸接进 CI 就是恒绿门禁，
 * 所以 AGENTS.md 明写「别把它们单独接进 CI」，改用带外壳的 `notes:gate`。
 *
 * 而这个事实**原先没有任何测试直证**（只被 `archive-baseline.test.mjs` 间接
 * 覆盖 archived 一条）。后果是双向的：
 *
 *   - 上游某天把空集合判成失败 → 外壳里的空集合分支变成**死代码**，
 *     而没人知道它已经不必要了（悄悄多一层判断，且 AGENTS.md 的告诫过期）；
 *   - 有人顺手删掉外壳的 `files.length === 0` 分支「简化」一下 →
 *     `notes:gate` 在零篇仓库上立刻变绿，**门禁本身变成恒绿**，而 CI 全程安静。
 *
 * 两个方向都是「安静地失去覆盖」，正是门禁最该防的那类退化。
 *
 * ## 为什么比退出码之外还要比 stdout
 *
 * 只断言 `exitCode === 0` 会漏掉一种假绿：脚本在 import 阶段就炸了，
 * 而某层包装把非零改写成了 0，或脚本走到了「什么都没查但打印成功」的分支。
 * 所以这里逐条断言**原文那句 `ok: 0 ...`** —— 它同时钉住了「退出码是 0」
 * 与「它确实打印了成功结论」两件事，后者证明它真跑到了结尾而不是崩在半路。
 *
 * ## 三重对照
 *
 *   ① 裸脚本 exit 0（绿）
 *   ② 同一空仓库上 `runGate(...)` passed=false、reason=NO_NOTES_YET（红）
 *   ③ 同一空仓库上 `tools/verify-notes.mjs` 进程退出码非 0（红）
 *
 * ①与②的对照是全部价值所在：**同样的输入，裸脚本绿、外壳红。**
 * ③则证明这个差别不是 `runGate` 的内部实现细节，而是真的透到了命令行
 * 与 CI 看到的退出码上（CI 只认退出码）。
 *
 * 另加一条反向对照（合规树必须真绿），否则 ② 的红可能只是「外壳一律报错」，
 * 那种情况下本文件里除 ① 外的所有断言都失去意义。
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { GATES, runAllGates, runGate } from '../lib/notes.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = join(PACKAGE_ROOT, 'skills', 'agent-notes', 'scripts');
const VERIFY_NOTES = join(PACKAGE_ROOT, 'tools', 'verify-notes.mjs');
const NODE = process.execPath;

/**
 * 三道 vendored 脚本各自在空集合上打印的那句原文。
 *
 * 逐字照抄实测输出（不是从代码里想当然写的），因为断言的正是「它自己怎么说」。
 * 实测原文（空 `.agents/notes/`、零篇笔记）：
 *
 *   verify-agent-note-tree.ts        ok: 0 note(s) tree and relative links verified
 *   verify-agent-note-format.ts      ok: 0 note(s) verified
 *   verify-archived-agent-notes.ts   ok: 0 archived note(s) verified, 0 seal(s) in manifest
 *
 * archived 那条还会在 stderr 打一行 `warning: not a git repository — append-only
 * check skipped`（临时目录没有真仓库）；那是**告警不是失败**，所以只断言退出码
 * 与 stdout，不拿 stderr 参与判定。
 */
const VACUOUS_OUTPUT = Object.freeze({
  'verify-agent-note-tree.ts': 'ok: 0 note(s) tree and relative links verified',
  'verify-agent-note-format.ts': 'ok: 0 note(s) verified',
  'verify-archived-agent-notes.ts': 'ok: 0 archived note(s) verified, 0 seal(s) in manifest'
});

/** 一篇合规笔记（供「反向对照」用）。 */
const GOOD_NOTE = [
  '# Agent Note: 空门禁对照样本',
  '',
  'Status: implemented',
  '',
  '## Problem',
  '问题。',
  '',
  '## Decision',
  '决定。',
  '',
  '## Alternatives considered',
  '另一条路更强的地方在于 X，但被 Y 否掉。',
  '',
  '## Consequences',
  '代价是 Z。',
  ''
].join('\n');

/**
 * 造一个「有笔记树、零篇笔记」的临时仓库。
 *
 * ★ 必须**建出目录**而不是留空 —— 任务是「空集合」，不是「没有笔记树」。
 *   `NO_NOTES_TREE`（目录不存在）与 `NO_NOTES_YET`（目录在、零篇）是两条
 *   不同的分支，只测后者才是本文件要钉的那条；前者已由
 *   `tools/no-fake-green.test.mjs` 覆盖。
 *
 * @returns {{ dir: string, notes: string }} 仓库目录与笔记根。
 */
function emptyTreeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'an-vacuity-'));
  mkdirSync(join(dir, '.git'), { recursive: true });
  const notes = join(dir, '.agents', 'notes');
  mkdirSync(join(notes, 'implemented'), { recursive: true });
  return { dir, notes };
}

/**
 * 造一个有合规笔记的临时仓库（反向对照用）。
 *
 * @returns {{ dir: string, notes: string }} 仓库目录与笔记根。
 */
function goodTreeRepo() {
  const { dir, notes } = emptyTreeRepo();
  mkdirSync(join(notes, 'implemented', 'feature'), { recursive: true });
  writeFileSync(join(notes, 'implemented', 'feature', '2026-10-22-ok.md'), GOOD_NOTE, 'utf8');
  return { dir, notes };
}

/**
 * 直接 spawn 一道 vendored 脚本（不走 `lib/notes.js` 的任何包装）。
 *
 * 这是本文件的**裸基线**：如果这里也红，那说明「空集合上裸脚本是绿的」
 * 这个前提已经不成立 —— 那不是本测试要断言的东西变了，而是被测事实变了，
 * 必须让人看见而不是被 `runGate` 的红掩盖过去。
 *
 * @param {string} script 脚本文件名。
 * @param {string} notes 笔记根。
 * @param {string} cwd 工作目录。
 * @returns {{ code: number, status: number|null, signal: string|null, stdout: string, stderr: string }} 结果。
 */
function runVendored(script, notes, cwd) {
  const result = spawnSync(NODE, [join(SCRIPTS, script)], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, AGENT_NOTE_ROOT: notes },
    windowsHide: true
  });
  return {
    code: result.status ?? -1,
    status: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
}

test('空集合：裸脚本三道全部 exit 0 并打印 ok: 0（外壳存在的理由本身）', () => {
  const { dir, notes } = emptyTreeRepo();
  try {
    for (const script of Object.values(GATES)) {
      const r = runVendored(script, notes, dir);
      /* signal 必须为 null：`status` 在 Windows 上是 NTSTATUS 数值，
         子进程被信号杀掉时它照样「非零」，只有 signal 能把两者分开。
         这里反过来 —— 崩了却返回 0 的场景由 stdout 断言兜住（崩了就打不出
         那句 ok: 0），但仍把 signal 显式钉住，免得将来出现「崩了也 exit 0」
         时这条断言毫无反应。 */
      assert.equal(r.signal, null, `${script} 子进程未正常结束（code=${r.code}）`);
      assert.equal(r.code, 0, `${script} 在空集合上应 exit 0，实际 ${r.code}\n${r.stderr}`);
      assert.equal(
        r.stdout.trim(), VACUOUS_OUTPUT[script],
        `${script} 应打印「${VACUOUS_OUTPUT[script]}」—— 这句原文是本测试的钉子`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('空集合：同一仓库上 runGate 判失败并给出 NO_NOTES_YET（对照①→②）', async () => {
  const { dir, notes } = emptyTreeRepo();
  try {
    for (const gate of Object.keys(GATES)) {
      const one = await runGate(gate, { cwd: dir, notes });
      assert.equal(one.passed, false, `${gate} 在零篇仓库上绝不能通过`);
      assert.match(one.reason ?? '', /NO_NOTES_YET/, `${gate} 必须说明是「有树零篇」`);
      /* 不能既说失败又留一个 exit 0 让人误读 —— 前置拦下时脚本根本没跑。 */
      assert.equal(one.exitCode, null, `${gate} 没真跑，exitCode 不该是数字`);
      assert.equal(one.stdout, '', `${gate} 没真跑，stdout 不该有内容`);
    }

    /* 汇总层同样必须红，且篇数为 0 —— 两条结论要能同时读到。 */
    const all = await runAllGates({ cwd: dir, notes });
    assert.equal(all.passed, false, 'runAllGates 在零篇仓库上绝不能通过');
    assert.equal(all.noteCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('空集合：命令行外壳进程退出码非 0（对照①→③，CI 认的就是它）', () => {
  const { dir, notes } = emptyTreeRepo();
  try {
    const r = spawnSync(NODE, [VERIFY_NOTES], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, AGENT_NOTE_ROOT: notes },
      windowsHide: true
    });
    assert.notEqual(r.status, 0, `notes 门禁在零篇仓库上必须非零退出，实际 ${r.status}`);
    /* 「非零」不等于「按契约变红」：Windows 上子进程被信号杀掉时 status 是个
       NTSTATUS 数值（实测见过 3221226505），它当然非零，但那是崩了不是判定。
       正常结束 signal 恒为 null，这里把它钉住，避免把崩溃记成门禁变红。 */
    assert.equal(r.signal, null, `子进程未正常结束（status=${String(r.status)}），不能算作门禁变红`);
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.match(out, /NO_NOTES_YET|没有可验|零篇/, `诊断必须指向「有树零篇」，实际：${out.trim()}`);
    /* 并且不能同时打印「通过」—— 两个结论同时出现比只判红更糟。 */
    assert.doesNotMatch(out, /笔记门禁通过/, `不得同时报通过，实际：${out.trim()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('反向对照：有一篇合规笔记时外壳必须真绿（否则上面的红没有意义）', async () => {
  /* 没有这条，上面的红可能只是「外壳一律报错」。一旦某天 runGate 因为
     无关原因（比如脚本定位失败）而恒红，上面三条会一起绿着骗人。 */
  const { dir, notes } = goodTreeRepo();
  try {
    for (const gate of Object.keys(GATES)) {
      const one = await runGate(gate, { cwd: dir, notes });
      assert.equal(one.passed, true, `${gate} 在合规树上应通过：${one.reason ?? ''}`);
      assert.equal(one.exitCode, 0, `${gate} 必须真跑过并 exit 0`);
    }
    const all = await runAllGates({ cwd: dir, notes });
    assert.equal(all.passed, true);
    assert.equal(all.noteCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});