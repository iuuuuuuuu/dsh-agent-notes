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
import test from 'node:test';

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
