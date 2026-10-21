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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAllGates, runGate } from '../lib/notes.js';

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
