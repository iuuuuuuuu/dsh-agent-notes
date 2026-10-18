/**
 * 跨仓库可用性测试。
 *
 * ## 为什么需要
 *
 * Owner 的要求：**就算脱离 DSH、换别的 agent 工具，笔记主要功能也要正常**。
 *
 * 这要求所有门禁脚本都能在**任意仓库**里跑，而不是只能验自己所在的包。
 * 实测发现过真实缺陷：`verify-notes.mjs` 用 `PACKAGE_ROOT` 定位笔记根，
 * 于是被拷到别的仓库后**仍然报告原仓库的 16 篇笔记** ——
 * 「在别的仓库里跑」这件事静默地没发生，而输出看起来完全正常。
 *
 * 那是比报错更危险的失效：门禁在跑、退出码 0、输出合理，只是验错了对象。
 *
 * 本文件锁住三件事：
 *   1. 门禁脚本只依赖 Node 内置模块（不依赖 DSH 插件层）；
 *   2. 在独立仓库里能正确验**那个**仓库；
 *   3. 独立仓库没有笔记树时明确报错，不回退去验别处。
 */
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const NODE = process.execPath;

/**
 * 造一个「像别的 agent 工具的项目」的独立仓库。
 *
 * 特征：有 git、有源码、没有 DSH、没有 package.json 也照样工作。
 *
 * @returns {string} 仓库目录。
 */
function makeForeignRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'an-foreign-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 'probe@example.test');
  git('config', 'user.name', 'probe');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.js'), 'export const a = 1;\n', 'utf8');
  /* 拷门禁脚本 —— 不拷 lib/index.js（那是 DSH 插件本体）。 */
  mkdirSync(join(dir, 'tools'), { recursive: true });
  for (const name of ['notes-coverage.mjs', 'notes-supersession.mjs', 'doc-budget.mjs']) {
    copyFileSync(join(PACKAGE_ROOT, 'tools', name), join(dir, 'tools', name));
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

/**
 * 跑一个门禁脚本，返回退出码与输出。
 *
 * @param {string} dir 仓库目录。
 * @param {string} script 脚本名。
 * @param {string[]} [args] 参数。
 * @returns {{ code: number, out: string }} 结果。
 */
function run(dir, script, args = []) {
  const r = spawnSync(NODE, [join(dir, 'tools', script), ...args], {
    cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env }
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('脱离 DSH：门禁脚本只依赖 Node 内置模块', () => {
  /* 这是「能在任意仓库跑」的前提。任何 `@deepseek-ai/*` 或相对 lib/ 的
     导入都会让脚本在别的仓库里直接崩。 */
  const forbidden = [/@deepseek-ai/, /from ['"]\.\.\/lib\//];
  for (const name of ['notes-coverage.mjs', 'notes-supersession.mjs', 'doc-budget.mjs']) {
    const text = readFileSync(join(PACKAGE_ROOT, 'tools', name), 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${name} 不该 import ${pattern}`);
    }
  }
});

test('跨仓库：独立项目里改源码不写笔记 → 必须红', () => {
  const dir = makeForeignRepo();
  try {
    writeFileSync(join(dir, 'src', 'app.js'), 'export const a = 2;\n', 'utf8');
    execFileSync('git', ['add', 'src/app.js'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    const { code, out } = run(dir, 'notes-coverage.mjs');
    assert.equal(code, 1, `独立仓库里也必须拦下，实际 exit=${code}\n${out}`);
    assert.match(out, /src\/app\.js/, '必须点名那个文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('跨仓库：独立项目里写笔记 → 通过', () => {
  const dir = makeForeignRepo();
  try {
    writeFileSync(join(dir, 'src', 'app.js'), 'export const a = 2;\n', 'utf8');
    mkdirSync(join(dir, '.agents', 'notes', 'implemented', 'feature'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'notes', 'implemented', 'feature', '2026-01-01-a.md'),
      '# Agent Note: a\n\nStatus: implemented\n\n## Problem\nx\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    assert.equal(run(dir, 'notes-coverage.mjs').code, 0, '带笔记应通过');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('跨仓库：verify-notes 验的是「当前仓库」而不是脚本所在仓库', () => {
  /* 实测踩过的真缺陷：原先用 PACKAGE_ROOT，于是被拷到别处后
     仍然报告原仓库的 16 篇笔记 —— 「在别的仓库里跑」静默地没发生。
     那是比报错更危险的失效：退出码 0、输出合理，只是验错了对象。 */
  const dir = makeForeignRepo();
  try {
    mkdirSync(join(dir, '.agents', 'notes', 'implemented', 'feature'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'notes', 'implemented', 'feature', '2026-01-01-a.md'),
      '# Agent Note: a\n\nStatus: implemented\n\n## Problem\nx\n\n## Decision\ny\n\n'
      + '## Alternatives considered\n\n无\n\n## Consequences\nz\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', windowsHide: true });

    const r = spawnSync(NODE, [join(PACKAGE_ROOT, 'tools', 'verify-notes.mjs')], {
      cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, AGENT_NOTE_ROOT: '' }
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.equal(r.status, 0, `独立仓库的合规笔记应通过，实际 ${r.status}\n${out}`);
    /* 关键断言：报告里必须是**这个**仓库的路径与 1 篇，不是原仓库的 16 篇。 */
    assert.match(out, /1 篇笔记/, `必须报告当前仓库的 1 篇，实际：${out.trim().split('\n').pop()}`);
    assert.doesNotMatch(out, /16 篇笔记/, '绝不能报告原仓库的 16 篇');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('跨仓库：没有笔记树时明确报错，不回退去验别处', () => {
  /* 第一版在「cwd 有 .agents/notes 才算当前仓库」的判断下，
     会回退到 PACKAGE_ROOT —— 于是另一个仓库里跑出「通过，16 篇」，
     而那 16 篇跟当前仓库毫无关系。回退到别处比报错更危险。 */
  const dir = makeForeignRepo();
  try {
    const r = spawnSync(NODE, [join(PACKAGE_ROOT, 'tools', 'verify-notes.mjs')], {
      cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, AGENT_NOTE_ROOT: '' }
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.notEqual(r.status, 0, '没有笔记树必须非零退出');
    assert.match(out, /NO_NOTES_TREE|笔记树不存在/, '必须明确说「没有笔记树」');
    assert.doesNotMatch(out, /16 篇笔记/, '绝不能回退去验原仓库');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('跨仓库：supersession 在独立项目里可用', () => {
  const dir = makeForeignRepo();
  try {
    mkdirSync(join(dir, '.agents', 'notes', 'implemented', 'feature'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'notes', 'implemented', 'feature', '2026-01-01-a.md'),
      '# Agent Note: a\n\nStatus: implemented\n\nIndependent: 独立仓库首个决定\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    assert.equal(run(dir, 'notes-supersession.mjs').code, 0, '有 Independent 声明应通过');

    /* 没有声明的必须红。 */
    writeFileSync(join(dir, '.agents', 'notes', 'implemented', 'feature', '2026-01-02-b.md'),
      '# Agent Note: b\n\nStatus: implemented\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    assert.equal(run(dir, 'notes-supersession.mjs').code, 1, '没声明关系的必须红');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
