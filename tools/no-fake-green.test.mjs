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
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createNotesService, runGate } from '../lib/notes.js';

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

for (const guide of ['AGENTS.md', 'CLAUDE.md']) {
  test(`生命周期根层只有 ${guide}：说明文件不算笔记，零篇必须判红`, async () => {
    const dir = bareRepo();
    try {
      const root = join(dir, '.agents', 'notes', 'implemented');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, guide), '# 目录说明\n', 'utf8');
      const result = await createNotesService({}, undefined).runAll({ cwd: dir });
      assert.equal(result.passed, false, '说明文件不得绕过零篇检查');
      assert.equal(result.noteCount, 0, '说明文件不得计入笔记数');
      assert.equal(result.strayCount, 1, '未参与笔记校验的说明文件应单独计数');
      for (const entry of result.results) {
        assert.match(entry.reason, /NO_NOTES_YET/, `${entry.gate} 应说明是零篇`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`合规笔记加生命周期根层 ${guide}：只计一篇，且不再判红（与 vendored 白名单一致）`, async () => {
    /* 2026-10-24 裁决：原先这条断言的是「保留布局检查」（passed=false / NOTES_LAYOUT）。
       但 vendored 的 `agent-note-tree.ts` 里 `ROOT_ALLOWLIST` **明确放行**
       `{lifecycle}/AGENTS.md` 与 `{lifecycle}/CLAUDE.md`，上游仓库自己也真的这么放。
       插件包着 vendored 却判它红 —— 同一棵树 vendored 全绿、插件红，那是**假红**：
       用户按上游布局写笔记，插件告诉他违规。
       所以现在跟着放行（只放这两个确切名字），但仍然**不计数**。 */
    const dir = goodRepo();
    try {
      writeFileSync(join(dir, '.agents', 'notes', 'implemented', guide), '# 目录说明\n', 'utf8');
      const result = await createNotesService({}, undefined).runAll({ cwd: dir });
      assert.equal(result.passed, true, 'vendored 放行的目录说明不该被插件判红');
      assert.equal(result.noteCount, 1, '说明文件不得虚增笔记数');
      assert.equal(result.strayCount, 1, '说明文件仍如实报为未计入独立笔记');
      for (const entry of result.results) {
        assert.equal(entry.passed, true, `${entry.gate} 不该再报布局错误`);
        assert.equal(entry.exitCode, 0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const lifecycle of ['proposed', 'implemented', 'rejected']) {
  test(`${lifecycle} 只有 .zh.md 旁挂：零篇必须判红`, async () => {
    const dir = bareRepo();
    try {
      const target = join(dir, '.agents', 'notes', lifecycle, 'feature');
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, '2026-10-24-only.zh.md'), '# Translation sidecar\n', 'utf8');
      const result = await createNotesService({}, undefined).runAll({ cwd: dir });
      assert.equal(result.passed, false, '旁挂文件不得绕过零篇检查');
      assert.equal(result.noteCount, 0);
      assert.equal(result.strayCount, 1);
      for (const entry of result.results) {
        assert.equal(entry.passed, false);
        assert.match(entry.reason, /NO_NOTES_YET/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('合规笔记加 .zh.md 旁挂：不虚增计数且正常通过', async () => {
  const dir = goodRepo();
  try {
    writeFileSync(join(dir, '.agents', 'notes', 'implemented', 'feature', '2026-10-17-ok.zh.md'), '# Translation sidecar\n', 'utf8');
    const result = await createNotesService({}, undefined).runAll({ cwd: dir });
    assert.equal(result.noteCount, 1);
    assert.equal(result.strayCount, 1);
    assert.equal(result.passed, true);
    for (const entry of result.results) {
      assert.equal(entry.passed, true);
      assert.equal(entry.exitCode, 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真实 CLI：翻译旁挂不虚增笔记数，也不误报为目录外文件', () => {
  const dir = goodRepo();
  try {
    writeFileSync(join(dir, '.agents', 'notes', 'implemented', 'feature', '2026-10-17-ok.zh.md'), '# Translation sidecar\n', 'utf8');
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./verify-notes.mjs', import.meta.url)), '--root', dir
    ], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      env: { ...process.env, AGENT_NOTE_ROOT: join(dir, '.agents', 'notes') }
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /共 1 篇笔记/);
    assert.match(result.stdout, /另有 1 个 \.md 散落件、说明文件或翻译旁挂/);
    assert.doesNotMatch(result.stdout, /散落在生命周期目录之外|也不会被校验/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('其他生命周期根层 Markdown 仍进入布局校验', async () => {
  const dir = goodRepo();
  try {
    writeFileSync(join(dir, '.agents', 'notes', 'implemented', 'unexpected.md'), '# Misplaced note\n', 'utf8');
    const result = await createNotesService({}, undefined).runAll({ cwd: dir });
    assert.equal(result.noteCount, 2);
    assert.equal(result.passed, false);
    for (const entry of result.results) {
      assert.equal(entry.exitCode, 1);
      assert.match(entry.reason, /NOTES_LAYOUT/);
      assert.ok(entry.stderr.includes('unexpected.md'));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archived 只有 .zh.md 旁挂：零篇必须判红（归档侧不许留同一个洞）', async () => {
  /* 2026-10-24 自审补：上面那三条只覆盖活动生命周期，archived 侧照旧把旁挂
     算作一篇笔记 —— 同一个零篇假绿在归档一侧原样存活。真实复现：
     只放一个 archived/<class>/x.zh.md + 给它的封印 ⇒ passed:true / noteCount:1，
     而三条门禁实际校验 ok: 0。 */
  const dir = bareRepo();
  try {
    const target = join(dir, '.agents', 'notes', 'archived', 'feature');
    mkdirSync(target, { recursive: true });
    const body = '# Translation sidecar\n';
    writeFileSync(join(target, '2026-10-20-arch.zh.md'), body, 'utf8');
    mkdirSync(join(dir, '.agents', 'notes', 'archived'), { recursive: true });
    const { createHash } = await import('node:crypto');
    const seal = `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
    writeFileSync(
      join(dir, '.agents', 'notes', 'archived', 'manifest.json'),
      `${JSON.stringify({ version: 1, files: { 'archived/feature/2026-10-20-arch.zh.md': seal } }, null, 2)}\n`,
      'utf8'
    );

    const result = await createNotesService({}, undefined).runAll({ cwd: dir });
    assert.equal(result.passed, false, '归档旁挂不得顶一篇笔记的额度');
    assert.equal(result.noteCount, 0, '没有任何 vendored 门禁验过它，计数必须是 0');
    assert.equal(result.strayCount, 1, '旁挂仍应如实报为未计入独立笔记');
    for (const entry of result.results) {
      assert.equal(entry.passed, false);
      assert.match(entry.reason, /NO_NOTES_YET/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('只传 env.AGENT_NOTE_ROOT：预检 / 门禁 / 计数必须看同一棵树', async () => {
  /* 审计 S4：原先四处各自解析笔记根、优先级还不一样，于是「只传 options.env」
     这个用法被服务层无条件盖掉 —— 调用方以为在验 env 那棵树，
     实际验的是默认位置（预检/计数一处、spawn 另一处）。 */
  const base = mkdtempSync(join(tmpdir(), 'an-envroot-'));
  try {
    const cwdNoTree = join(base, 'cwd-no-tree');
    const envTree = join(base, 'env-tree');
    mkdirSync(join(cwdNoTree, '.git'), { recursive: true });
    mkdirSync(join(envTree, 'implemented', 'feature'), { recursive: true });
    writeFileSync(join(envTree, 'implemented', 'feature', '2026-01-01-a.md'), [
      '# Agent Note: fixture', '', 'Status: implemented', '',
      '## Problem', 'p', '', '## Decision', 'd', '',
      '## Alternatives considered', 'a', '', '## Consequences', 'c', ''
    ].join('\n'), 'utf8');

    const result = await createNotesService({}, undefined).runAll({
      cwd: cwdNoTree,
      env: { AGENT_NOTE_ROOT: envTree }
    });

    assert.equal(result.passed, true, `env 指的树是合规的，应通过：${JSON.stringify(result.results.map((e) => e.reason ?? e.stdout))}`);
    assert.equal(result.noteCount, 1, '计数必须来自 env 那棵树');
    assert.equal(resolve(result.notesRoot), resolve(envTree), '报告的根必须是 env 指的树');
    /* 关键：门禁**真的验到了那一篇**，不是「计数说有、门禁验零篇」。 */
    for (const gate of ['tree', 'format']) {
      const entry = result.results.find((e) => e.gate === gate);
      assert.match(entry.stdout ?? '', /ok: 1 note\(s\)/, `${gate} 必须真验到 1 篇：${entry.stdout}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('取消信号必须真的传到子进程（运行中 abort 与已 abort 都要生效）', async () => {
  /* 审计发现 3：`lib/tools.js` 把宿主的 signal 交给 runGate，spawnCapture 也支持，
     但中间那一跳把它丢了 —— 点了取消，子进程仍跑满（最长 120s），
     结论还是 ExitCode=0 / passed=true。取消是契约，不该只是「传进去了」。 */
  const scripts = mkdtempSync(join(tmpdir(), 'an-slowgate-'));
  const repo = mkdtempSync(join(tmpdir(), 'an-slowrepo-'));
  const previous = process.env.AGENT_NOTE_SCRIPTS_DIR;
  try {
    mkdirSync(scripts, { recursive: true });
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, '.agents', 'notes', 'implemented', 'feature'), { recursive: true });
    writeFileSync(join(repo, '.agents', 'notes', 'implemented', 'feature', '2026-01-01-a.md'), [
      '# Agent Note: fixture', '', 'Status: implemented', '',
      '## Problem', 'p', '', '## Decision', 'd', '',
      '## Alternatives considered', 'a', '', '## Consequences', 'c', ''
    ].join('\n'), 'utf8');
    /* 假门禁：用**定时器**把进程按住 4 秒再报绿。
       不要用顶层 `await` —— 那在 .ts 下会解析失败、子进程立刻退出，
       用例就会「通过」在一条根本没跑起来的分支上（本轮真踩过：把 signal
       变异掉之后用例照样绿）。定时器不需要额外语法支持，且能保证进程真活着。 */
    writeFileSync(
      join(scripts, 'verify-agent-note-tree.ts'),
      'setTimeout(() => { console.log("ok: 1 note(s) fake"); }, 4000);\n',
      'utf8'
    );
    process.env.AGENT_NOTE_SCRIPTS_DIR = scripts;

    const notesRoot = join(repo, '.agents', 'notes');

    /* ① 运行中 abort。 */
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300);
    const t1 = Date.now();
    const running = await runGate('tree', { cwd: repo, notesRoot, signal: controller.signal });
    clearTimeout(timer);
    const elapsed1 = Date.now() - t1;
    /* 关键断言：必须是**被我们杀掉**的（SIGKILL）。signal 被吞或假脚本没跑起来时
       这里是 null，用例立刻红 —— 这正是上一版用例空转的原因。 */
    assert.equal(running.signal, 'SIGKILL',
      `子进程必须被取消杀掉（signal=SIGKILL），实际 exitCode=${running.exitCode} signal=${running.signal}`);
    assert.ok(elapsed1 < 2000, `运行中 abort 应立刻结束，实际 ${elapsed1}ms`);
    assert.equal(running.passed, false, '被取消不等于通过');

    /* ② 传入时**已经** abort：addEventListener 不会再触发，必须显式补一次。 */
    const dead = new AbortController();
    dead.abort();
    const t2 = Date.now();
    const pre = await runGate('tree', { cwd: repo, notesRoot, signal: dead.signal });
    const elapsed2 = Date.now() - t2;
    assert.equal(pre.signal, 'SIGKILL',
      `已 abort 的信号也必须杀掉子进程，实际 exitCode=${pre.exitCode} signal=${pre.signal}`);
    assert.ok(elapsed2 < 2000, `已 abort 的信号也应立刻生效，实际 ${elapsed2}ms`);
    assert.equal(pre.passed, false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_NOTE_SCRIPTS_DIR;
    else process.env.AGENT_NOTE_SCRIPTS_DIR = previous;
    rmSync(scripts, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
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
