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
 * ## 2026-10-24 补的那一类：旁挂封印从不被复算
 *
 * 上面最后一条当初**只补了一半**：`lib/archive-layout.js` 只查「manifest 里有没有
 * 这个键」，封印值从不复算。实测（真 Git 仓库）改旁挂内容、甚至把封印值写成与
 * 磁盘完全无关的哈希，三条门禁仍全绿，而归档门禁照样打印 `2 seal(s) in manifest`
 * —— 「看起来验了、实际没验」。现在按与 vendored 验正笔记**同一套摘要**复算，
 * 下面四条用例钉住它：改内容判红、无关哈希判红、封印正确仍通过、两套口径互证。
 *
 * ★ 夹具必须继续用 `lib/archive-layout.js` 的 `sealOf` 算封印，不要自己再写一份：
 * 那正是「摘要只有一处实现」的保证 —— 夹具算出的封印会被 **vendored** 拿去验正笔记
 * （同一字节），两套口径一旦分叉，用例当场红。
 *
 * ## 隔离纪律
 *
 * 每条用例只在自己建的临时目录里跑，只删自己的目录。
 * 绝不用 `test.skip()` 掩盖环境问题 —— 那样等于把「没验到」写成「通过了」。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runGate } from '../lib/notes.js';
import { checkArchiveLayout, checkManifestSchema, isRealDate, sealOf } from '../lib/archive-layout.js';

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
 * ★ 封印由 `lib/archive-layout.js` 的 `sealOf` 算 —— 不是本文件再写一份摘要。
 * 这不只是「少写几行」：这些封印会被 **vendored** 脚本拿去校验同一批字节
 * （见「两套口径互证」那条用例），所以摘要实现只有一处，分叉就会红。
 * 谁若把这里改成自己算，那条用例就悄悄失效了。
 *
 * @param {string} root 笔记根。
 * @param {string} rel 相对 `archived/` 的路径。
 * @param {string | Buffer} content 正文（传 `Buffer` 时是逐字节写入）。
 * @returns {string} 封印值。
 */
function seal(root, rel, content) {
  const target = join(root, 'archived', rel);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
  return sealOf(target);
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

/**
 * 读 manifest 的封印表。
 *
 * @param {string} root 笔记根。
 * @returns {Record<string, string>} 封印表。
 */
function readSeals(root) {
  const raw = readFileSync(join(root, 'archived', 'manifest.json'), 'utf8');
  return JSON.parse(raw).files;
}

/**
 * 跑一次 git（真临时仓库用）。
 *
 * @param {string} cwd 仓库根。
 * @param {string[]} args 参数。
 */
function git(cwd, args) {
  execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe']
  });
}

/**
 * 把 `.agents/notes` 当前内容提交成归档基线。
 *
 * @param {string} cwd 仓库根。
 * @param {string} message 提交信息。
 */
function commitBaseline(cwd, message) {
  git(cwd, ['add', '--', '.agents/notes']);
  git(cwd, [
    '-c', 'user.name=Archive Layout Test',
    '-c', 'user.email=archive-layout@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '--no-verify', '-m', message
  ]);
}

/** 真 Git 仓库夹具里正笔记与旁挂的相对 `archived/` 路径。 */
const MAIN_REL = 'testing/2026-01-01-a.md';
const SIDE_REL = 'testing/2026-01-01-a.zh.md';

/**
 * 造一个**真 Git 仓库**：归档区里一篇正笔记 + 一篇 `.zh.md` 旁挂，
 * 两条封印都按**当前字节**算好，与 manifest 一起进基线提交。
 *
 * ## 为什么必须真 Git
 *
 * `lib/notes.js` 的 archived 门禁在形状校验之后还要比一次 **Git 基线**
 * （封印只增不改）。审计 S2 的证据正是在真仓库里取的 —— 「改了旁挂内容仍然全绿」
 * 只有在基线校验**真的跑过**时才说明问题；不是仓库时 vendored 只打一句
 * `not a git repository` 降级警告，那条路径证明不了「基线也拦不住它」。
 * 所以下面的用例都断言输出里**没有**那句警告。
 *
 * 提交之后工作树与基线逐字一致，于是后续任何改动都只可能来自用例自己，
 * 「改了什么就红什么」的因果是干净的。
 *
 * @param {{ body?: string | Buffer }} [options] 归档正文；缺省用合规的归档笔记。
 * @returns {{ cwd: string, root: string }} 仓库根与笔记根。
 */
function makeSealedRepo(options = {}) {
  const body = options.body ?? archivedNote('2026-01-02');
  const cwd = mkdtempSync(join(tmpdir(), 'notes-archive-sideseal-'));
  const root = join(cwd, '.agents', 'notes');
  const live = join(root, 'implemented', 'testing');
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, '2026-01-01-live.md'), [
    '# Agent Note: 活跃样本', '', 'Status: implemented', '',
    '## Problem', '问题。', '',
    '## Decision', '决定。', '',
    '## Alternatives considered', '- **备选** — 最强理由。', '',
    '## Consequences', '代价。', ''
  ].join('\n'));
  try {
    const main = seal(root, MAIN_REL, body);
    const side = seal(root, SIDE_REL, body);
    writeManifest(root, {
      [`archived/${MAIN_REL}`]: main,
      [`archived/${SIDE_REL}`]: side
    });
    git(cwd, ['init']);
    commitBaseline(cwd, 'Seal main note and sidecar as baseline');
    return { cwd, root };
  } catch (error) {
    rmSync(cwd, { recursive: true, force: true });
    throw error;
  }
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

/* ── 旁挂封印必须被**复算**（2026-10-24） ────────────────────────────────
 *
 * 修之前：`lib/archive-layout.js` 对 `.zh.md` 只查 `sealed.has(key)` ——
 * 键在就算过，值从不复算。于是「补了一条封印」被当成「验过了」：
 * 真 Git 仓库里改旁挂内容、或把封印写成与磁盘无关的哈希，一律全绿，
 * 而正笔记一改就红。这四条用例把复算的两端都钉住：该红的红、该绿的绿。
 */

test('archived: 改归档旁挂内容必须判红（真 Git 仓库）', async () => {
  const { cwd, root } = makeSealedRepo();
  try {
    const target = join(root, 'archived', SIDE_REL);
    writeFileSync(target, `${readFileSync(target, 'utf8')}\n事后补的一段\n`, 'utf8');

    const result = await runGate('archived', {
      cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root }
    });
    const output = `${result.reason ?? ''}\n${result.stderr}`;
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.notEqual(result.exitCode, 0, JSON.stringify(result));
    /* 夹具前提：基线校验真的跑过。否则这条只证明了「不是仓库时没人管」。 */
    assert.ok(!output.includes('not a git repository'),
      `夹具必须是真 Git 仓库，实际输出：${output.trim()}`);
    assert.match(output, /seal mismatch/, '必须指出是封印不匹配');
    assert.ok(output.includes(`archived/${SIDE_REL}`),
      `诊断必须点名旁挂文件，实际：${output.trim()}`);
    /* manifest 一字未改 —— 红的必须是**复算**，不是「封印被改」。 */
    assert.ok(!output.includes('Archived seal changed or removed'),
      `基线里 manifest 没动，不该报「封印被改」：${output.trim()}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('archived: 旁挂封印写成与磁盘无关的哈希必须判红（基线已同步，只剩复算这一条判断）', async () => {
  const { cwd, root } = makeSealedRepo();
  try {
    /* 把旁挂封印换成**形状合法但与磁盘内容无关**的值，然后**提交**它。
       于是历史基线与当前 manifest 逐条一致，「只增不改」那一条一定放行 ——
       此时唯一还能红的只有复算。这条是审计 S2 里最极端的那种形态。 */
    const seals = readSeals(root);
    const unrelated = `sha256:${'a'.repeat(64)}`;
    assert.notEqual(seals[`archived/${SIDE_REL}`], unrelated, '夹具前提：随机哈希不等于真封印');
    writeManifest(root, { ...seals, [`archived/${SIDE_REL}`]: unrelated });
    commitBaseline(cwd, 'Seal the sidecar with an unrelated hash');

    const result = await runGate('archived', {
      cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root }
    });
    const output = `${result.reason ?? ''}\n${result.stderr}`;
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.notEqual(result.exitCode, 0, JSON.stringify(result));
    assert.ok(!output.includes('not a git repository'),
      `夹具必须是真 Git 仓库，实际输出：${output.trim()}`);
    assert.ok(!output.includes('Archived seal changed or removed'),
      `封印值与基线一致，不该被「只增不改」拦下：${output.trim()}`);
    assert.match(output, /seal mismatch/, '必须指出是封印不匹配');
    assert.ok(output.includes(`archived/${SIDE_REL}`),
      `诊断必须点名旁挂文件，实际：${output.trim()}`);
    /* 诊断要把两边实际值都写出来，否则「内容被改」与「当初就填错了」分不出来。 */
    assert.ok(output.includes(unrelated), '诊断必须回显 manifest 里的封印值');
    assert.ok(output.includes(sealOf(join(root, 'archived', SIDE_REL))),
      '诊断必须回显按磁盘算出的封印值');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('archived: 旁挂封印正确时仍然通过（真 Git 仓库）', async () => {
  const { cwd, root } = makeSealedRepo();
  try {
    const result = await runGate('archived', {
      cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root }
    });
    const output = `${result.stdout ?? ''}\n${result.stderr}`;
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.ok(!output.includes('not a git repository'),
      `夹具必须是真 Git 仓库，实际输出：${output.trim()}`);
    /* 数字要能对上：vendored 真验了那篇正笔记，manifest 里两条封印都在。 */
    assert.match(result.stdout, /ok: 1 archived note\(s\) verified, 2 seal\(s\) in manifest/,
      `vendored 必须真跑过，实际：${result.stdout}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('archived: 旁挂封印与 vendored 正笔记封印必须同口径（同一字节互证）', async () => {
  /* 这是全组用例里唯一**独立于本插件实现**的那条判据：
     同一批字节（含非 ASCII 与非法 UTF-8 尾部）写进正笔记与旁挂，
     两条封印都由 `lib/archive-layout.js` 的 `sealOf` 算，
     然后让 **vendored** 用它自己那套摘要去验那篇正笔记。
     vendored 绿 ⇒ 两套摘要对同一批字节给出了同一个值。
     若 `sealOf` 哪天改成先解码再编码（例如给 `readFileSync` 传 `'utf8'`），
     非法字节会被替换成 U+FFFD，两套摘要立刻分叉，这条用例当场红 ——
     那种漂移没有任何其它用例拦得住。 */
  const body = Buffer.concat([
    Buffer.from(`${archivedNote('2026-01-02')}中文旁挂正文。\n`, 'utf8'),
    Buffer.from([0xff, 0xfe, 0x0a])
  ]);
  const { cwd, root } = makeSealedRepo({ body });
  try {
    const seals = readSeals(root);
    assert.equal(seals[`archived/${MAIN_REL}`], seals[`archived/${SIDE_REL}`],
      '夹具前提：两侧字节相同，封印必须相同');
    assert.equal(seals[`archived/${SIDE_REL}`], sealOf(join(root, 'archived', SIDE_REL)),
      '旁挂封印必须由 lib 的 sealOf 算出');
    assert.match(seals[`archived/${SIDE_REL}`], /^sha256:[0-9a-f]{64}$/,
      '封印形状必须是 sha256: + 64 位小写十六进制');

    const result = await runGate('archived', {
      cwd, notesRoot: root, env: { AGENT_NOTE_ROOT: root }
    });
    assert.equal(result.passed, true,
      `vendored 用同一封印验正笔记必须通过，否则说明两套摘要已分叉：${JSON.stringify(result)}`);
    assert.match(result.stdout, /ok: 1 archived note\(s\) verified, 2 seal\(s\) in manifest/,
      `vendored 必须真跑过，实际：${result.stdout}`);
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
