/**
 * 笔记覆盖门禁的测试。
 *
 * 这条门禁解决的是本仓库**真实发生过的失效**：连续 5 次改动
 * `.github/workflows/verify.yml`，一篇笔记都没写，而规范明确要求
 * 「改了流程与工具链」必须记。既有的 `notes:gate` 只验已写笔记的格式，
 * 对「该写而没写」完全没有感知。
 *
 * 测的重点不是「脚本能跑」，而是三件事：
 *   1. 命中受管路径且没带笔记 → **必须红**（这是它存在的唯一理由）；
 *   2. 带了笔记 → 必须绿（否则它会变成总在误报的噪音，最后被 --no-verify 绕过）；
 *   3. 机械产物（版本号、清单、CHANGELOG）→ 必须绿（规范明确禁止为它们立笔记）。
 *
 * 每条断言都跑真实子进程、拿真实退出码，不用桩替。
 */
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(PACKAGE_ROOT, 'tools', 'notes-coverage.mjs');
const NODE = process.execPath;

/**
 * 造一个独立的 git 仓库，用于真实提交与区间比对。
 *
 * 为什么不在本仓库里造分支：那会把测试状态混进开发者自己的工作区，
 * 一旦中途失败还留下脏引用。临时仓库彻底隔离。
 *
 * @returns {string} 仓库目录。
 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'an-coverage-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 'probe@example.test');
  git('config', 'user.name', 'probe');
  git('config', 'commit.gpgsign', 'false');
  return dir;
}

/**
 * 在临时仓库里造一次提交，返回提交后跑门禁的结果。
 *
 * @param {string} dir 仓库目录。
 * @param {Record<string, string>} files 相对路径 → 内容。
 * @param {string} message 提交信息。
 * @returns {{ code: number, out: string }} 退出码与输出。
 */
function commitAndCheck(dir, files, message) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  git('add', '-A');

  /* 直接把门禁脚本拷进临时仓库，让它以自己的仓库根为准 —— 这样测的
     正是 pre-commit / CI 会跑的那份代码，而不是被测试文件重新实现一遍。 */
  const result = spawnSync(NODE, [SCRIPT, '--staged'], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, NOTES_COVERAGE_SKIP: '' }
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

test('notes-coverage: 改了 lib 但没写笔记 → 必须红', () => {
  const dir = makeRepo();
  try {
    const { code, out } = commitAndCheck(dir, { 'lib/board.js': 'export const a = 1;\n' }, 'feat: 改行为');
    assert.notEqual(code, 0, `受管路径改动没有笔记时必须拦下，实际 exit=${code}\n${out}`);
    assert.match(out, /lib\/board\.js/, '诊断必须点出是哪个文件触发的');
    assert.match(out, /Note-Skip/, '必须告诉人怎么合法放行');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: 改了 lib 且同批带了笔记 → 必须绿', () => {
  const dir = makeRepo();
  try {
    const { code, out } = commitAndCheck(dir, {
      'lib/board.js': 'export const a = 1;\n',
      '.agents/notes/implemented/feature/2026-01-01-x.md': '# Agent Note: x\n\nStatus: implemented\n'
    }, 'feat: 带笔记');
    assert.equal(code, 0, `带了笔记就该放行，实际 exit=${code}\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: 机械产物不要求笔记', () => {
  /* 规范原文：「纯格式化、错别字、版本发布打标、依赖补丁 → 严禁立笔记」。
     门禁必须尊重这条，否则每发一次版都要被逼着写一篇注水笔记，
     噪音会让人开始用 --no-verify，门禁等于废掉。 */
  const dir = makeRepo();
  try {
    const { code, out } = commitAndCheck(dir, {
      'CHANGELOG.md': '# Changelog\n',
      'package.json': '{ "version": "1.0.1" }\n',
      'upstream.json': '{ "ref": "abc" }\n',
      'tools/upstream-manifest.json': '{ "files": {} }\n'
    }, 'chore(release): 1.0.1');
    assert.equal(code, 0, `机械产物不该要求笔记，实际 exit=${code}\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: tools/ 与 .github/ 属于受管路径', () => {
  /* 这正是本仓库漏记的那两次：改 CI 流程、改测试工具。
     规范把「流程与工具链」列为非平凡，门禁必须覆盖到。 */
  const dir = makeRepo();
  try {
    for (const rel of ['tools/install-hooks.mjs', '.github/workflows/verify.yml']) {
      const { code, out } = commitAndCheck(dir, { [rel]: '# probe\n' }, 'ci: 改流程');
      assert.notEqual(code, 0, `${rel} 改动必须要求笔记，实际 exit=${code}\n${out}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: Note-Skip 有理由才放行，空理由拒绝', () => {
  const dir = makeRepo();
  try {
    /* 只造 lib/board.js 一个文件；mkdirSync 由 commitAndCheck 之外的
       这段自己负责，别再单独 writeFileSync 到目录路径（会 EEXIST）。 */
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'board.js'), 'export const a = 1;\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', windowsHide: true });

    const run = (skip) => spawnSync(NODE, [SCRIPT, '--staged'], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, NOTES_COVERAGE_SKIP: skip }
    });

    const empty = run('   ');
    assert.notEqual(empty.status, 0, '空理由必须拒绝 —— 「写了理由」这个动作本身就是要人再想一遍');

    const filled = run('只改了注释，无行为变化');
    assert.equal(filled.status, 0, `非空理由应放行，实际 exit=${filled.status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: 无法判定时必须退出码 2，绝不能当成通过', () => {
  /* 「查不到」被当成「没问题」是假绿的经典形态。这里用不存在的 range
     造一个 git diff 失败，断言它是 2 而不是 0。 */
  const result = spawnSync(NODE, [SCRIPT, '--range', 'deadbeefdeadbeef..HEAD'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(result.status, 2, `无法判定时必须 exit 2，实际 ${result.status}`);
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.match(out, /无法判定|无效/, '必须说明「这不是已合规」');
});
