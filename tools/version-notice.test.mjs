// 「插件版本变了」的一次性提示 —— 判据与诚实性边界。
//
// Owner 2026-10-22：版本更新时 agent 对话根本不会触发提示 ⇒ 插件升完了，
// 模型与用户都不知道，也就谈不上「引导去更新项目里的技能副本」。
//
// 这条提示的三条边界（每条都有用例钉住）：
//   ① 首次运行不提示（没记录 ≠ 发生过更新）
//   ② 版本没变不提示（不能每轮都刷一遍）
//   ③ 版本号形态不认识就不猜（宁可不说话）

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { mountHarness as mount, tempState, emit } from './harness.mjs';

import {
  isVersion,
  buildVersionChangeHint,
  buildVersionLabel,
  compareCore,
  readPluginVersion
} from '../lib/version-notice.js';

test('首次运行（没有上次记录）不提示：没记录 ≠ 更新过', () => {
  assert.equal(buildVersionChangeHint({ current: '0.9.0' }), undefined);
  assert.equal(buildVersionChangeHint({ current: '0.9.0', lastSeen: '' }), undefined);
});

test('版本没变不提示', () => {
  assert.equal(buildVersionChangeHint({ current: '0.9.0', lastSeen: '0.9.0' }), undefined);
});

test('版本变了就提示，且指名两个版本号', () => {
  const hint = buildVersionChangeHint({ current: '0.9.0', lastSeen: '0.8.0' });
  assert.match(hint, /更新/);
  assert.match(hint, /0\.8\.0/);
  assert.match(hint, /0\.9\.0/);
  assert.match(hint, /sync-skill/, '必须给出下一步怎么做');
  assert.match(hint, /只出现一次/, '必须告诉模型别反复提');
});

test('降级说成「回退」，并提醒可能是装错包', () => {
  const hint = buildVersionChangeHint({ current: '0.8.0', lastSeen: '0.9.0' });
  assert.match(hint, /回退/);
  assert.match(hint, /装错/);
});

test('版本号形态不认识就不猜（脏记录不得当成更新）', () => {
  assert.equal(buildVersionChangeHint({ current: 'v0.9.0', lastSeen: '0.8.0' }), undefined);
  assert.equal(buildVersionChangeHint({ current: '0.9.0', lastSeen: 'not-a-version' }), undefined);
  assert.equal(buildVersionChangeHint({ current: '', lastSeen: '0.8.0' }), undefined);
});

test('预发布后缀不参与排序，但被原样写进提示', () => {
  assert.equal(compareCore('0.9.0-rc.1', '0.9.0'), 0);
  assert.ok(compareCore('0.9.0', '0.8.9') > 0);
  assert.ok(compareCore('0.8.0', '0.10.0') < 0, '必须按数字比，不能按字符串比');
  const hint = buildVersionChangeHint({ current: '0.9.0-rc.1', lastSeen: '0.9.0' });
  assert.match(hint, /0\.9\.0-rc\.1/);
});

test('当前版本取自 package.json，且是语义化版本', () => {
  const v = readPluginVersion();
  assert.equal(typeof v, 'string');
  assert.match(v, /^\d+\.\d+\.\d+/);
});

test('「上次见到的版本」会落盘，且重复写同一个值不产生写入', async () => {
  const { createStateStore } = await import('../lib/state.js');
  const { mkdtempSync, rmSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'version-notice-'));
  const file = join(dir, 'state.json');
  try {
    const first = createStateStore({}, file);
    assert.equal(first.pluginVersion(), undefined, '没记录过时必须返回 undefined');
    assert.equal(first.setPluginVersion('0.9.0'), true);
    assert.equal(first.setPluginVersion('0.9.0'), false, '同样的值不该再写一次');

    // 落盘 + 重新加载：这条是「下次升级才提示得出来」的前提。
    const second = createStateStore({}, file);
    assert.equal(second.pluginVersion(), '0.9.0');

    // 不变时不写盘：用「写入前先睡 10ms 再看 mtime」证明没有多余写入。
    const before = statSync(file).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 12));
    assert.equal(second.setPluginVersion('0.9.0'), false);
    assert.equal(statSync(file).mtimeMs, before, '值没变却重写了状态文件');

    // 形态不认识的版本一律不记录（脏值会毒化下一次比对）。
    assert.equal(second.setPluginVersion('not-a-version'), false);
    assert.equal(second.pluginVersion(), '0.9.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('标签始终带版本号；刚变过才多一个「已更新」', () => {
  assert.equal(buildVersionLabel({ current: '0.9.0', lastSeen: '0.9.0' }), 'v0.9.0');
  assert.equal(buildVersionLabel({ current: '0.9.0', lastSeen: '0.8.0' }), 'v0.9.0 · 已更新');
  assert.equal(buildVersionLabel({ current: '0.9.0' }), 'v0.9.0', '首次运行不标「已更新」');
  assert.equal(buildVersionLabel({ current: 'bad' }), undefined, '版本号不认识就不加标签');
});

test('标签落在标题行上，且正文顺序是「版本提示 → 项目副本落后」', async () => {
  const { buildPolicyText } = await import('../lib/policy.js');
  const label = buildVersionLabel({ current: '0.9.0', lastSeen: '0.8.0' });
  const hint = buildVersionChangeHint({ current: '0.9.0', lastSeen: '0.8.0' });
  const text = buildPolicyText('项目副本落后', label, hint);
  const firstLine = text.split('\n')[0];
  assert.match(firstLine, /^# 决策笔记（Agent Notes） · v0\.9\.0 · 已更新$/, '标签必须挂在标题行，不是正文里');
  assert.ok(text.indexOf('插件版本已') < text.indexOf('项目副本落后'), '版本变化比副本落后更紧要');

  const plain = buildPolicyText(undefined, 'v0.9.0', undefined);
  assert.match(plain.split('\n')[0], /· v0\.9\.0$/);
  assert.equal(buildPolicyText(undefined, undefined, undefined).split('\n')[0], '# 决策笔记（Agent Notes）');
});

test('版本判据只有一处：state 落盘与提示生成共用 isVersion', () => {
  /* CodeRabbit 在 PR #29 上指出 `lib/state.js` 另写了一份版本正则（Major）：
     两处各写一份，就允许「状态记下的版本」与「提示认得的版本」各说各话 ——
     状态里存了提示逻辑不认的形状，「上次 0.9.0、现在也是 0.9.0」永远判不出来。 */
  assert.equal(isVersion('0.9.0'), true);
  assert.equal(isVersion('0.9.0-rc.1'), true);
  assert.equal(isVersion('0.9'), false);
  assert.equal(isVersion('v0.9.0'), false);
  assert.equal(isVersion(undefined), false);
});

test('真实挂载：版本变了，注入段落的标题带「已更新」，且新版本真落盘', () => {
  /* 为什么非补这条（2026-10-24 自审）：上面所有用例都是**直接调函数** ——
     `buildVersionLabel` / `buildVersionChangeHint` / `buildPolicyText` 各自都对，
     但 Owner 报的缺陷恰恰出在它们之间的**接线**上（`lib/index.js` 的挂载路径）。
     只测零件不测接线，正是「函数全绿、功能不生效」的成因。
     这里用真 Cordis 上下文（解析不到则同契约承接器）真挂一次插件，
     从 `agent/created` 事件走到注入段落，再真读状态文件。 */
  const { dir, file } = tempState();
  try {
    const current = readPluginVersion();
    assert.match(current, /^\d+\.\d+\.\d+/, '取不到当前版本，这条用例就失去意义');
    /* 造出「装过旧版、现在装了新版」的真实形态：状态文件里留着上次见到的旧版本。 */
    writeFileSync(file, JSON.stringify({
      version: 1, global: true, sessions: {}, pluginVersion: '0.0.1'
    }), 'utf8');

    const { registered } = mount({ stateFile: file, config: { enabled: true } });
    emit(registered, 'agent/created', { agent: { id: 'sess-ver' } });

    assert.equal(registered.sections.length, 1, '开关打开时应挂规范段');
    const text = registered.sections[0].text;
    const firstLine = text.split('\n')[0];
    const escaped = current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      firstLine, new RegExp(`· v${escaped} · 已更新$`),
      `标签必须挂在标题行并标出这次变化，实际: ${firstLine}`
    );
    assert.match(text, /插件版本已/, '正文应带一次性的版本变化说明');

    /* 真读状态文件：不落盘的话，下次挂载算不出「变过」，标签永远退不回去。 */
    const state = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(state.pluginVersion, current, '当前版本必须真写进状态文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真实挂载：下一次挂载标签退回只有版本号，一次性提示消失', () => {
  const { dir, file } = tempState();
  try {
    const current = readPluginVersion();
    writeFileSync(file, JSON.stringify({
      version: 1, global: true, sessions: {}, pluginVersion: '0.0.1'
    }), 'utf8');

    const first = mount({ stateFile: file, config: { enabled: true } });
    emit(first.registered, 'agent/created', { agent: { id: 'sess-a' } });
    const firstText = first.registered.sections[0].text;
    assert.ok(firstText.split('\n')[0].endsWith('· 已更新'), '第一次挂载应标「已更新」');

    /* 下一次挂载读的是**刚被上一次写过的状态文件** —— 这一步不真读盘就验不到。 */
    const second = mount({ stateFile: file, config: { enabled: true } });
    emit(second.registered, 'agent/created', { agent: { id: 'sess-b' } });
    const secondText = second.registered.sections[0].text;
    const secondFirst = secondText.split('\n')[0];
    assert.ok(
      secondFirst.endsWith(`· v${current}`),
      `标签应退回只有版本号，实际: ${secondFirst}`
    );
    assert.doesNotMatch(secondText, /已更新/, '「已更新」标记的是那一次变化，不是永久徽章');
    assert.doesNotMatch(secondText, /插件版本已/, '正文提示每个版本只该出现一次');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真实挂载：首次运行只加版本号，不加「已更新」', () => {
  const { dir, file } = tempState();
  try {
    const current = readPluginVersion();
    /* 状态文件里连 pluginVersion 字段都没有 —— 装上插件、从没升过级的真实形态。 */
    writeFileSync(file, JSON.stringify({ version: 1, global: true, sessions: {} }), 'utf8');

    const { registered } = mount({ stateFile: file, config: { enabled: true } });
    emit(registered, 'agent/created', { agent: { id: 'sess-fresh' } });

    const text = registered.sections[0].text;
    const firstLine = text.split('\n')[0];
    assert.ok(firstLine.endsWith(`· v${current}`), `首次运行应只有版本号，实际: ${firstLine}`);
    assert.doesNotMatch(text, /已更新|插件版本已/, '没记录过就不算发生过更新');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('端到端（真子进程 + 真状态文件）：升级提示只出现一次，第三次消失', () => {
  /* CodeRabbit 在 PR #30 上指出：上面那条只直接调 isVersion，没有真跑子进程、
     也没写测试文件 —— 而 `tools/**` 的判据要求测试驱动真实路径。
     这里改成：起真 node 子进程，读真状态文件，走一遍「装旧版 → 升级 → 再挂载」。 */
  const dir = mkdtempSync(join(tmpdir(), 'version-e2e-'));
  const file = join(dir, 'state.json');
  const script = join(dir, 'run.mjs');
  try {
    /* 子进程脚本只做「一次插件挂载」会做的事，然后用 JSON 报结果。
       路径用 file URL 传进去，避免依赖子进程 cwd。 */
    writeFileSync(script, `
const [stateFile, current] = process.argv.slice(2);
const { createStateStore } = await import(${JSON.stringify(new URL('../lib/state.js', import.meta.url).href)});
const { buildVersionChangeHint, buildVersionLabel } = await import(${JSON.stringify(new URL('../lib/version-notice.js', import.meta.url).href)});
const store = createStateStore({}, stateFile);
const lastSeen = store.pluginVersion();
const label = buildVersionLabel({ current, lastSeen });
const hint = buildVersionChangeHint({ current, lastSeen });
store.setPluginVersion(current);
process.stdout.write(JSON.stringify({ lastSeen: lastSeen ?? null, label: label ?? null, hint: hint ?? null }));
`, 'utf8');

    const run = (current) => {
      const r = spawnSync(process.execPath, [script, file, current], {
        encoding: 'utf8', windowsHide: true
      });
      assert.equal(r.status, 0, `子进程必须成功：${r.stderr}`);
      return JSON.parse(r.stdout);
    };

    /* 第一次挂载：没记录过 ⇒ 不提示，标签只有版本号。 */
    const first = run('0.9.0');
    assert.equal(first.lastSeen, null, '首次运行没有上次记录');
    assert.equal(first.hint, null, '首次运行不得提示');
    assert.equal(first.label, 'v0.9.0');

    /* 版本没变再挂载：仍然不提示（不能每轮刷）。 */
    const second = run('0.9.0');
    assert.equal(second.lastSeen, '0.9.0', '上次记录必须来自真状态文件');
    assert.equal(second.hint, null, '版本没变不得提示');
    assert.equal(second.label, 'v0.9.0');

    /* 真升级：这次提示一次，标签多一个「已更新」。 */
    const third = run('0.10.0');
    assert.match(third.hint, /0\.9\.0/);
    assert.match(third.hint, /0\.10\.0/);
    assert.equal(third.label, 'v0.10.0 · 已更新');

    /* 再挂载一次：提示自动消失（它标记的是那一次变化，不是永久徽章）。 */
    const fourth = run('0.10.0');
    assert.equal(fourth.hint, null, '同一次升级不得提示第二遍');
    assert.equal(fourth.label, 'v0.10.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
