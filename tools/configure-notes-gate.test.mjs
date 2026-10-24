/**
 * `tools/configure-notes-gate.mjs` 的行为测试。
 *
 * 这个工具的职责只有一个：把目标仓库里那份**会自己漂移**的 vendored 门禁脚本
 * 升级到当前版本。所以测试也围着「会不会把别人的东西改坏」转 ——
 * 实测过两种真实形态：
 *   ① 目标仓库用的是旧技能名（`write-notes-like-deepseek`）；
 *   ② 目标仓库把某个脚本**刻意改过**（wt-port 修了「全零 sha 静默通过」）。
 * ② 若被贪心覆盖，就是拿「版本旧」换「把人家的修正抹掉」，比不升级更糟。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildPlan, resolveLayout } from './configure-notes-gate.mjs';

const ROOT = join(import.meta.dirname, '..');
const NODE = process.execPath;
const SOURCE_SKILL = join(ROOT, 'skills', 'agent-notes');

/**
 * 造一个最小仓库夹具。
 *
 * @param {(dir: string) => void} [setup] 附加布置。
 * @returns {string} 仓库根。
 */
function fixture(setup) {
  const dir = mkdtempSync(join(tmpdir(), 'an-cfg-'));
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.agents', 'notes', 'implemented'), { recursive: true });
  if (setup !== undefined) setup(dir);
  return dir;
}

test('布局：有 notes-scripts 时沿用它，assets 放同级（build-board 按 ../assets 找模板）', () => {
  const dir = fixture((root) => mkdirSync(join(root, '.agents', 'notes-scripts'), { recursive: true }));
  try {
    const layout = resolveLayout(dir);
    assert.equal(layout.layout, 'notes-scripts');
    assert.equal(layout.scriptsDir, join(dir, '.agents', 'notes-scripts'));
    assert.equal(layout.assetsDir, join(dir, '.agents', 'assets'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('布局：已有完整技能目录时沿用它的名字（不许另建第二份）', () => {
  /* 实测 CloudeMusicX / route-deck 用的是旧技能名。另建 `agent-notes/` 会让同一仓库
     出现两份门禁脚本，「哪份生效」就成了隐式约定。 */
  const dir = fixture((root) => {
    const scripts = join(root, '.agents', 'skills', 'write-notes-like-deepseek', 'scripts');
    mkdirSync(scripts, { recursive: true });
    for (const name of ['agent-note-tree.ts', 'verify-agent-note-tree.ts',
      'verify-agent-note-format.ts', 'verify-archived-agent-notes.ts']) {
      writeFileSync(join(scripts, name), '// stub\n', 'utf8');
    }
  });
  try {
    const layout = resolveLayout(dir);
    assert.equal(layout.layout, 'skills/write-notes-like-deepseek');
    assert.ok(!existsSync(join(dir, '.agents', 'skills', 'agent-notes')), '不许另建第二份');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('布局：同时有 notes-scripts 与完整技能目录时，更新技能目录、不动分叉区', () => {
  /* wt-port 的真实形态：notes-scripts 里是**刻意的本地分叉**。 */
  const dir = fixture((root) => {
    mkdirSync(join(root, '.agents', 'notes-scripts'), { recursive: true });
    const scripts = join(root, '.agents', 'skills', 'agent-notes', 'scripts');
    mkdirSync(scripts, { recursive: true });
    for (const name of ['agent-note-tree.ts', 'verify-agent-note-tree.ts',
      'verify-agent-note-format.ts', 'verify-archived-agent-notes.ts']) {
      writeFileSync(join(scripts, name), '// stub\n', 'utf8');
    }
  });
  try {
    const layout = resolveLayout(dir);
    assert.equal(layout.layout, 'skills/agent-notes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('覆盖策略：与「未打补丁的原文」逐字相同 ⇒ 判定为旧副本，升级成打了补丁的版本', () => {
  const stock = readFileSync(join(SOURCE_SKILL, 'scripts', 'verify-agent-note-format.ts'), 'utf8');
  const dir = fixture((root) => {
    const scripts = join(root, '.agents', 'skills', 'agent-notes', 'scripts');
    mkdirSync(scripts, { recursive: true });
    /* 旧副本 = 未打补丁的原文（正是 4 个在用仓库里的形态）。 */
    writeFileSync(join(scripts, 'verify-agent-note-format.ts'), stock, 'utf8');
  });
  try {
    const plan = buildPlan(dir);
    const target = plan.files.find((file) => file.path.endsWith('verify-agent-note-format.ts'));
    assert.ok(target !== undefined, '应当计划写入格式门禁');
    assert.ok(target.patched.length > 0, '应当打上补丁');
    assert.ok(String(target.content).includes('blankInlineCode'), '写入的内容必须含补丁');
    assert.equal(plan.skipped.length, 0, '旧副本属于可安全升级，不该被跳过');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('覆盖策略：本地改过的脚本默认跳过（不许拿「版本旧」换掉人家的修正）', () => {
  const dir = fixture((root) => {
    const scripts = join(root, '.agents', 'skills', 'agent-notes', 'scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'verify-agent-note-format.ts'), '// 本地魔改：修了别的东西\n', 'utf8');
  });
  try {
    const plan = buildPlan(dir);
    const target = plan.files.find((file) => file.path.endsWith('verify-agent-note-format.ts'));
    assert.equal(target, undefined, '本地改过的文件不该进入写入计划');
    assert.equal(plan.skipped.length, 1, '必须如实报告被跳过的那一份');
    assert.match(plan.skipped[0].reason, /本地改过/);

    /* --force 才覆盖，且要让人知道自己在覆盖什么。 */
    const forced = buildPlan(dir, { force: true });
    assert.ok(forced.files.some((file) => file.path.endsWith('verify-agent-note-format.ts')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('端到端：配置之后，目标仓库自己的格式门禁必须接受「行内代码里的 HTML 注释标记」', () => {
  /* 这是这个工具存在的唯一理由。修复前那份脚本会把行内代码里的 `<!--` 当成真注释，
     把一篇合法笔记判成「缺小节」—— 真实项目因此删过笔记里的事实。 */
  const dir = fixture();
  try {
    const run = (script) => spawnSync(NODE, [script], { cwd: dir, encoding: 'utf8', windowsHide: true });
    /* 先配置。 */
    const configure = spawnSync(NODE, [join(ROOT, 'tools', 'configure-notes-gate.mjs'), '--root', dir], {
      encoding: 'utf8', windowsHide: true
    });
    assert.equal(configure.status, 0, `配置失败：${configure.stdout}${configure.stderr}`);

    /* 写一篇「必须写出 `<!--` 才能说明问题」的笔记。 */
    const noteDir = join(dir, '.agents', 'notes', 'implemented', 'bug-fix');
    mkdirSync(noteDir, { recursive: true });
    writeFileSync(join(noteDir, '2026-01-01-x.md'), [
      '# Agent Note: inline html comment marker', '', 'Status: implemented', '',
      '## Problem', '', '正文里展示 `<!--` 这个字面量，同行没有闭合标记。', '',
      '## Decision', '', 'd', '',
      '## Alternatives considered', '', 'a', '',
      '## Consequences', '', 'c', ''
    ].join('\n'), 'utf8');

    const result = run(join(dir, '.agents', 'skills', 'agent-notes', 'scripts', 'verify-agent-note-format.ts'));
    assert.equal(result.status, 0,
      `配置后必须接受这种笔记：\n${result.stdout}${result.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--check：配套落后时退出 1，配置好之后退出 0（可放进 CI 防漂移）', () => {
  const dir = fixture();
  try {
    const args = [join(ROOT, 'tools', 'configure-notes-gate.mjs'), '--root', dir, '--check'];
    const before = spawnSync(NODE, args, { encoding: 'utf8', windowsHide: true });
    assert.equal(before.status, 1, '未配置时 --check 必须退 1');

    spawnSync(NODE, [join(ROOT, 'tools', 'configure-notes-gate.mjs'), '--root', dir], { encoding: 'utf8', windowsHide: true });
    const after = spawnSync(NODE, args, { encoding: 'utf8', windowsHide: true });
    assert.equal(after.status, 0, `配置后 --check 必须退 0：${after.stdout}${after.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--dry-run 不落盘', () => {
  const dir = fixture();
  try {
    const r = spawnSync(NODE, [join(ROOT, 'tools', 'configure-notes-gate.mjs'), '--root', dir, '--dry-run'], {
      encoding: 'utf8', windowsHide: true
    });
    assert.equal(r.status, 0);
    assert.ok(!existsSync(join(dir, '.agents', 'skills', 'agent-notes', 'scripts')), '--dry-run 不许创建目录');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
