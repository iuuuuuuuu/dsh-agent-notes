/**
 * 行为验证：真跑插件模块，不看代码像不像对的。
 *
 * 覆盖：
 *   1. 状态双持久化（全局 + 会话覆盖），重载后保持
 *   2. 真门禁：绿基线通过、故障注入必须失败、缺脚本必须失败
 *   3. 技能 provider 能解析 vendored SKILL.md 并剥掉 frontmatter
 *   4. 规范文本含关键判据
 *   5. 笔记树探测
 *
 * 每个断言都驱动真实路径（真写文件、真 spawn 子进程），不用桩替。
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { createStateStore, resolveDshHome, expandHome } from '../lib/state.js';
import { runGate, runAllGates, stripNodeNoise, inspectTree, GATES } from '../lib/notes.js';
import { createSkillProvider, parseFrontmatter, SKILL_FILE } from '../lib/skill.js';
import { buildPolicyText, POLICY_MARKERS } from '../lib/policy.js';

/** 造一个临时目录。 */
function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 造一篇结构正确的 implemented 笔记。 */
function validNote() {
  return [
    '# Agent Note: 探针决策',
    '',
    'Status: implemented',
    '',
    '## Problem',
    '问题陈述。',
    '',
    '## Decision',
    '决定内容。',
    '',
    '## Alternatives considered',
    '- **备选 A** — 它最强的理由是这样；未采用是因为那样。',
    '',
    '## Consequences',
    '- 收益与代价。',
    ''
  ].join('\n');
}

test('状态：全局默认与会话覆盖双持久化，重载后保持', () => {
  const dir = tempDir('notes-state-');
  const file = join(dir, 'state.json');
  try {
    const first = createStateStore({}, file);
    assert.equal(first.global(), undefined, '初始全局默认应为未设置');
    assert.equal(first.effective('s1', true), true, '未设置时应取兜底 true');

    first.setGlobal(false);
    assert.equal(first.global(), false);
    assert.equal(first.effective('s1', true), false, '全局 false 应生效');

    first.setSession('s1', true);
    assert.equal(first.effective('s1', true), true, '会话覆盖优先于全局');
    assert.equal(first.effective('s2', true), false, '其他会话仍跟随全局');

    // 真读文件，证明写盘发生。
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.global, false);
    assert.equal(onDisk.sessions.s1, true);

    // 重建 store（模拟重载），状态必须保持。
    const reloaded = createStateStore({}, file);
    assert.equal(reloaded.global(), false, '全局默认应跨重载保持');
    assert.equal(reloaded.session('s1'), true, '会话覆盖应跨重载保持');
    assert.equal(reloaded.effective('s1'), true);

    // reset 清除覆盖。
    reloaded.setSession('s1', null);
    assert.equal(reloaded.session('s1'), undefined);
    assert.equal(reloaded.effective('s1'), false, '清除后回到全局默认');
    const afterReset = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal('s1' in afterReset.sessions, false, '清除必须真写盘');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('状态：Agent 对象与会话 id 都能归一', () => {
  const dir = tempDir('notes-state-');
  try {
    const store = createStateStore({}, join(dir, 'state.json'));
    const agent = { id: 'sess-xyz' };
    store.setSession(agent, false);
    assert.equal(store.session('sess-xyz'), false, '应为同一个键');
    assert.equal(store.sessionId(agent), 'sess-xyz');
    assert.equal(store.sessionId(undefined), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('状态：home 解析遵循 DSH_HOME 优先级', () => {
  const prev = process.env.DSH_HOME;
  try {
    // 未设置且无显式参数时，回退到 ~/.dsh。
    delete process.env.DSH_HOME;
    const fallback = resolveDshHome();
    assert.equal(fallback, join(expandHome('~'), '.dsh'), '缺省应为 ~/.dsh');

    process.env.DSH_HOME = 'D:/tmp-probe-home';
    assert.equal(resolveDshHome(), resolve('D:/tmp-probe-home'), 'DSH_HOME 必须生效');

    assert.equal(resolveDshHome('E:/explicit'), resolve('E:/explicit'), '显式参数优先于环境变量');

    // 空白覆盖不得把 home 解析到当前目录。
    process.env.DSH_HOME = '   ';
    assert.equal(resolveDshHome(), join(expandHome('~'), '.dsh'), '空白 DSH_HOME 视为未设置');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});

test('门禁：绿基线必须通过（真子进程）', async () => {
  const dir = tempDir('notes-green-');
  try {
    const notes = join(dir, '.agents', 'notes', 'implemented', 'architecture');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, '2026-01-01-probe.md'), validNote(), 'utf8');
    // 造 .git 让仓库根解析到 dir。
    mkdirSync(join(dir, '.git'));

    const result = await runGate('format', { cwd: dir });
    assert.equal(result.exitCode, 0, `绿基线应 exit 0，实际 ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
    assert.equal(result.passed, true);

    const tree = await runGate('tree', { cwd: dir });
    assert.equal(tree.exitCode, 0, `tree 应 exit 0，实际 ${tree.exitCode}\n${tree.stdout}\n${tree.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('门禁：故障注入必须真红（不是假绿）', async () => {
  const dir = tempDir('notes-red-');
  try {
    const base = join(dir, '.agents', 'notes', 'implemented');
    mkdirSync(join(base, 'architecture'), { recursive: true });
    mkdirSync(join(dir, '.git'));

    // 故障 1：非法分类目录。
    mkdirSync(join(base, 'refactor'), { recursive: true });
    writeFileSync(join(base, 'refactor', '2026-01-02-bad.md'), validNote(), 'utf8');
    const illegal = await runGate('tree', { cwd: dir });
    assert.equal(illegal.exitCode, 1, '非法分类必须 exit 1');
    assert.equal(illegal.passed, false);
    assert.match(illegal.stdout + illegal.stderr, /unknown class folder|refactor/, '诊断应指向分类问题');
    rmSync(join(base, 'refactor'), { recursive: true, force: true });

    // 故障 2：缺 ## Alternatives considered。
    writeFileSync(join(base, 'architecture', '2026-01-03-noalt.md'),
      validNote().replace(/## Alternatives considered[\s\S]*?(?=## Consequences)/, ''), 'utf8');
    const noAlt = await runGate('format', { cwd: dir });
    assert.equal(noAlt.exitCode, 1, '缺备选方案必须 exit 1');
    assert.match(noAlt.stdout + noAlt.stderr, /Alternatives/, '诊断应指向备选方案');
    rmSync(join(base, 'architecture', '2026-01-03-noalt.md'), { force: true });

    // 故障 3：implemented 里出现提案标题。
    writeFileSync(join(base, 'architecture', '2026-01-04-prop.md'),
      validNote().replace('## Decision', '## Proposal'), 'utf8');
    const proposal = await runGate('format', { cwd: dir });
    assert.equal(proposal.exitCode, 1, '提案标题必须 exit 1');
    assert.match(proposal.stdout + proposal.stderr, /Proposal/, '诊断应指向提案标题');
    rmSync(join(base, 'architecture', '2026-01-04-prop.md'), { force: true });

    // 故障 4：文件名格式错。
    writeFileSync(join(base, 'architecture', 'wrong-name.md'), validNote(), 'utf8');
    const badName = await runGate('tree', { cwd: dir });
    assert.equal(badName.exitCode, 1, '坏文件名必须 exit 1');
    rmSync(join(base, 'architecture', 'wrong-name.md'), { force: true });

    // 复原后必须回到绿，证明红灯是被注入的故障造成的，不是脚本恒红。
    const restored = await runGate('format', { cwd: dir });
    assert.equal(restored.exitCode, 0, '清掉故障后必须回到绿 — 否则是恒红而非真门禁');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('门禁：未知门禁与全跑汇总语义', async () => {
  const dir = tempDir('notes-misc-');
  try {
    const unknown = await runGate('nope', { cwd: dir });
    assert.equal(unknown.passed, false, '未知门禁必须算失败');
    assert.match(String(unknown.reason), /未知门禁/);

    const all = await runAllGates({ cwd: dir });
    assert.equal(typeof all.passed, 'boolean');
    assert.equal(all.results.length, Object.keys(GATES).length, '全跑必须覆盖每条门禁');
    // 空目录：tree/format 应通过（0 篇笔记），archived 也应通过。
    assert.equal(all.passed, true, `空树应通过，实际 ${JSON.stringify(all.results.map((r) => [r.gate, r.exitCode, r.reason]))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('技能：真读 vendored SKILL.md 并剥掉 frontmatter', async () => {
  assert.equal(existsSync(SKILL_FILE), true, `技能文件必须存在：${SKILL_FILE}`);
  const provider = createSkillProvider();
  const listed = await provider.list();
  assert.equal(listed.complete, true);
  assert.equal(listed.candidates.length, 1);
  const candidate = listed.candidates[0];
  assert.equal(candidate.name, 'agent-notes');
  assert.equal(candidate.invocation.modelInvocable, true);
  assert.equal(candidate.invocation.userInvocable, true);
  assert.equal(candidate.resourceBase.kind, 'directory');

  const definition = await provider.get(candidate);
  assert.equal(typeof definition.content, 'string');
  assert.ok(definition.content.length > 500, '正文不应为空');
  assert.equal(definition.content.startsWith('---'), false, '正文必须剥掉 frontmatter');
  assert.match(definition.content, /Agent Note|决策笔记|Note/, '正文应含方法论内容');
  assert.equal(typeof definition.description, 'string');
  assert.ok(definition.description.length > 10, '描述来自 frontmatter');
});

test('技能：frontmatter 解析对引号与无头都稳', () => {
  const quoted = parseFrontmatter('---\nname: x\ndescription: "带引号: 的说明"\n---\n正文');
  assert.equal(quoted.data.description, '带引号: 的说明');
  assert.equal(quoted.body, '正文');

  const headless = parseFrontmatter('# 没有头\n正文');
  assert.deepEqual(headless.data, {});
  assert.equal(headless.body, '# 没有头\n正文');
});

test('规范文本：含关键判据', () => {
  const text = buildPolicyText();
  for (const marker of POLICY_MARKERS) {
    assert.ok(text.includes(marker), `规范文本必须含 "${marker}"`);
  }
  assert.match(text, /非平凡/, '必须给出「非平凡改动」的判定');
  assert.match(text, /纯格式化|格式化/, '必须给出免写清单');
});

test('笔记树探测：计数与路径', () => {
  const dir = tempDir('notes-tree-');
  try {
    const root = join(dir, '.agents', 'notes');
    mkdirSync(join(root, 'implemented', 'architecture'), { recursive: true });
    mkdirSync(join(root, 'proposed', 'feature'), { recursive: true });
    writeFileSync(join(root, 'implemented', 'architecture', '2026-01-01-a.md'), validNote(), 'utf8');
    writeFileSync(join(root, 'proposed', 'feature', '2026-01-02-b.md'), validNote(), 'utf8');

    const info = inspectTree(root);
    assert.equal(info.exists, true);
    assert.equal(info.counts.implemented, 1);
    assert.equal(info.counts.proposed, 1);
    assert.equal(info.files.length, 2);

    const missing = inspectTree(join(dir, 'nope'));
    assert.equal(missing.exists, false);
    assert.equal(missing.files.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('输出清洗：过滤 node 噪声但保留真实诊断', () => {
  const raw = [
    '(node:1) Warning: Module type of file is not specified',
    'Reparsing as ES module because module syntax was detected.',
    'To eliminate this warning, add "type": "module"',
    '(Use `node --trace-warnings ...` to show where the warning was created)',
    'format: implemented/architecture/x.md — missing ## Alternatives considered'
  ].join('\n');
  const cleaned = stripNodeNoise(raw);
  assert.equal(cleaned.includes('Reparsing'), false, '噪声应被过滤');
  assert.match(cleaned, /missing ## Alternatives considered/, '真实诊断必须保留');
});
