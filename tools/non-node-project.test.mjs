/**
 * 回归：门禁**不得**假定目标仓库是 Node/npm 项目。
 *
 * 这是实机约束（Owner 指出的目标）：本插件要能用在任意技术栈的项目上，
 * 那些项目可能：
 *   - 没有 `package.json`、没有 `node_modules`、没有 npm 脚本；
 *   - 目标机器上根本没装 node/npm（只有宿主 harness 自带的运行时）。
 *
 * 实现上靠两件事满足：门禁脚本用 `process.execPath` 执行（见 lib/notes.js
 * 的 nodeExecutable），临时目录的 `package.json` 只写在系统临时目录里。
 *
 * 但「实现看起来满足」不等于「证明过」。因此这里把 PATH 清空 ——
 * 若任何一处真的去 shell 里找 `node` / `npm` / `git`，这条就会红。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAllGates, runGate, isNodeNewEnough, REQUIRED_NODE } from '../lib/notes.js';

/** 一份完全合规的 implemented 笔记。 */
const GOOD_NOTE = [
  '# Agent Note: 非 Node 项目模板',
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
];

/**
 * 建一个「非 Node 项目」：只有笔记树，没有 package.json / node_modules / .git。
 *
 * @param {string[]} [body] 笔记内容。
 * @returns {string} 项目根。
 */
function plainProject(body = GOOD_NOTE) {
  const cwd = mkdtempSync(join(tmpdir(), 'an-plain-project-'));
  const dir = join(cwd, '.agents', 'notes', 'implemented', 'feature');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-01-01-plain.md'), body.join('\n'));
  return cwd;
}

/**
 * 建一个空目录当作 PATH，里面既没有 node 也没有 npm。
 *
 * @returns {string} 空目录绝对路径。
 */
function emptyPath() {
  return mkdtempSync(join(tmpdir(), 'an-empty-path-'));
}

test('非 Node 项目：无 package.json / node_modules 且 PATH 里没有 node、npm、git 时三道门禁仍然通过', async () => {
  const cwd = plainProject();
  const path = emptyPath();
  try {
    const result = await runAllGates({ cwd, env: { PATH: path } });
    assert.equal(result.noteCount, 1);
    assert.equal(
      result.passed,
      true,
      `非 Node 项目上不应失败：${JSON.stringify(result.results.map((r) => [r.gate, r.reason, r.stderr]))}`
    );
    for (const entry of result.results) {
      assert.equal(entry.passed, true, `${entry.gate} 在非 Node 项目上应通过`);
      assert.equal(entry.exitCode, 0, `${entry.gate} 应真的跑完并 exit 0`);
    }
    // 门禁不得在目标仓库里造出 Node 项目的痕迹。
    assert.equal(existsSync(join(cwd, 'package.json')), false, '不得在目标仓库写 package.json');
    assert.equal(existsSync(join(cwd, 'node_modules')), false, '不得在目标仓库建 node_modules');
    assert.deepEqual(readdirSync(cwd), ['.agents'], '目标仓库只应多出笔记树');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(path, { recursive: true, force: true });
  }
});

test('非 Node 项目：笔记不合规时仍然变红（不是把门禁跑成空转）', async () => {
  // 删掉 `## Alternatives considered` —— 格式门禁必须抓（备选方案是必填节）。
  const body = GOOD_NOTE.filter((line) => line !== '## Alternatives considered'
    && line !== '另一条路更强的地方在于 X，但被 Y 否掉。');
  const cwd = plainProject(body);
  const path = emptyPath();
  try {
    const format = await runGate('format', { cwd, env: { PATH: path } });
    assert.equal(format.passed, false, '缺备选方案节必须判失败');
    assert.notEqual(format.exitCode, 0, '失败必须是非零退出码');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(path, { recursive: true, force: true });
  }
});

test('Node 版本守卫：低于 engines 声明的版本必须给出可读原因，而不是 loader 错误', () => {
  /* 归到本文件：这一族问题的共同点是「门禁依赖运行时，而运行时的边界没人守」。
     `.ts` 门禁靠 Node 的类型剥除执行；老版本上会死在加载阶段，
     报的还是与笔记毫无关系的一句话 —— 那种红会把人引向完全错误的方向。 */
  assert.equal(isNodeNewEnough('22.19.0'), true, '恰好等于下限应放行');
  assert.equal(isNodeNewEnough('22.19.7'), true);
  assert.equal(isNodeNewEnough('23.0.0'), true, '大版本更高就够');
  assert.equal(isNodeNewEnough('25.9.0'), true);
  assert.equal(isNodeNewEnough('22.18.0'), false, '同大版本但小版本不够，必须拒绝');
  assert.equal(isNodeNewEnough('20.11.1'), false, '大版本不够');
  assert.equal(isNodeNewEnough('garbage'), false, '认不出来时保守判不够');
  assert.equal(isNodeNewEnough(''), false);
  /* 当前运行时（跑这条测试的这个 Node）必须满足要求 —— 否则下面的门禁用例没意义。 */
  assert.equal(isNodeNewEnough(), true, `当前 Node ${process.versions.node} 应满足要求`);
});

test('Node 版本常量必须与 package.json 的 engines 一致（防止只改一边）', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  const required = String(pkg.engines?.node ?? '');
  const match = />=\s*(\d+)\.(\d+)/.exec(required);
  assert.ok(match !== null, `engines.node 应形如 ">=22.19"，实际 ${required}`);
  assert.equal(Number(match[1]), REQUIRED_NODE.major, 'engines 的主版本与 REQUIRED_NODE 不一致');
  assert.equal(Number(match[2]), REQUIRED_NODE.minor, 'engines 的次版本与 REQUIRED_NODE 不一致');
});

test('runGate: Node 太老时必须带着 NODE_TOO_OLD 失败（守卫真的接在门禁上）', async () => {
  /* 只测纯函数还不够 —— 要证明这条守卫**接在 runGate 上**。
     伪造 process.versions.node 后跑一次：既不能绿，也不能把 vendored 脚本
     拖进去撞 loader 错误（那样人只会看到一句与笔记无关的话）。 */
  const cwd = plainProject();
  const path = emptyPath();
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node');
  try {
    Object.defineProperty(process.versions, 'node', { value: '20.11.0', configurable: true, writable: true });
    const result = await runAllGates({ cwd, env: { PATH: path } });
    assert.equal(result.passed, false, 'Node 太老不许判绿');
    for (const entry of result.results) {
      assert.match(entry.reason ?? '', /NODE_TOO_OLD/, `${entry.gate} 应报 NODE_TOO_OLD：${JSON.stringify(entry)}`);
      assert.equal(entry.exitCode, null, '没真跑门禁时 exitCode 不该是 0');
    }
  } finally {
    if (descriptor !== undefined) Object.defineProperty(process.versions, 'node', descriptor);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(path, { recursive: true, force: true });
  }
});
