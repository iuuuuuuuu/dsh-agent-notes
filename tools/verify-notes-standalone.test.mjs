/**
 * `tools/verify-notes.mjs` 在**独立仓库**里的可用性测试。
 *
 * ## 为什么单独一份，而不是并进 standalone.test.mjs
 *
 * `standalone.test.mjs` 里有一条「门禁脚本只依赖 Node 内置模块」，它检查
 * 三个脚本：`notes-coverage` / `notes-supersession` / `doc-budget`。
 *
 * **`verify-notes.mjs` 不在那三个里** —— 而它恰恰是唯一 import
 * `../lib/notes.js` 的那个。实测四种独立用法全部失败：
 *
 *   - 只拷 `tools/verify-notes.mjs` → `ERR_MODULE_NOT_FOUND`
 *   - 连 `lib/` 一起拷 → 去那个仓库的 `skills/` 找门禁脚本，找不到
 *   - **独立仓库自带 `.agents/skills/<技能名>/scripts`**（它真正有的形态）
 *     → **完全无视**，仍只去自己包里找
 *
 * 而 README 明确承诺「直接复用本仓库的 tools/verify-notes.mjs」。承诺与
 * 行为矛盾，且没有任何测试发现 —— 因为要测它得**真的在别的仓库里跑一遍**，
 * 而那件事没人做。
 *
 * ## 这份测试做什么
 *
 * 造四个真实场景（真建 git 仓库、真拷文件、真跑），逐个断言结果。
 * 真跑是必须的：静态检查「有没有 import ../lib/」看不出运行时行为，
 * 而这次的缺陷恰恰是「静态看着有问题、实际能不能跑要看运行时」。
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SCRIPTS_DIR, scriptsDirCandidates } from '../lib/notes.js';

const ROOT = join(import.meta.dirname, '..');
const NODE = process.execPath;
const SANDBOXES = [];

process.on('exit', () => {
  for (const dir of SANDBOXES) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});

/** 一篇结构合规的笔记。 */
const VALID_NOTE = [
  '# Agent Note: 独立仓库的笔记', '', 'Status: implemented', '',
  '## Problem', '', '要能验别的仓库。', '',
  '## Decision', '', '所以要真的跑一遍。', '',
  '## Alternatives considered', '', '静态检查不够。', '',
  '## Consequences', '', '得建临时仓库。', ''
].join('\n');

/**
 * 造一个带笔记的独立 git 仓库。
 *
 * @param {{ withSkill?: boolean, withTools?: boolean, withLib?: boolean }} [options] 要放哪些东西。
 * @returns {string} 沙箱目录。
 */
function sandbox(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'an-vn-'));
  SANDBOXES.push(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"other","type":"module","version":"0.0.0"}\n');

  const noteDir = join(dir, '.agents', 'notes', 'implemented', 'process');
  mkdirSync(noteDir, { recursive: true });
  writeFileSync(join(noteDir, '2026-01-01-x.md'), VALID_NOTE, 'utf8');

  if (options.withTools === true) {
    mkdirSync(join(dir, 'tools'), { recursive: true });
    cpSync(join(ROOT, 'tools', 'verify-notes.mjs'), join(dir, 'tools', 'verify-notes.mjs'));
  }
  if (options.withLib === true) {
    mkdirSync(join(dir, 'lib'), { recursive: true });
    cpSync(join(ROOT, 'lib', 'notes.js'), join(dir, 'lib', 'notes.js'));
  }
  if (options.withSkill === true) {
    const scripts = join(dir, '.agents', 'skills', 'write-notes-like-deepseek', 'scripts');
    mkdirSync(scripts, { recursive: true });
    for (const name of ['verify-agent-note-tree.ts', 'verify-agent-note-format.ts',
      'verify-archived-agent-notes.ts', 'agent-note-tree.ts', 'archive-agent-note.ts']) {
      const src = join(ROOT, 'skills', 'agent-notes', 'scripts', name);
      if (existsSync(src)) cpSync(src, join(scripts, name));
    }
    writeFileSync(join(scripts, 'package.json'), '{"type":"module"}\n');
  }
  return dir;
}

/**
 * 在沙箱里跑 verify-notes.mjs。
 *
 * @param {string} dir 沙箱。
 * @param {string} entry 相对入口路径。
 * @param {Record<string,string>} [env] 额外环境变量。
 * @returns {{ code: number, out: string }} 结果。
 */
function run(dir, entry, env = {}) {
  const r = spawnSync(NODE, [entry], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env }
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('独立仓库：自带 .agents/skills/…/scripts 时必须真的验它自己的笔记', () => {
  /* 这是最关键的一条 —— 目标仓库**有自己的**门禁脚本（按 skill 模板，
     脚本与笔记同在 `.agents/skills/` 下），而旧实现只去自己包里找，
     于是「脚本就在眼前却看不见」，三条门禁全部报「脚本缺失」。 */
  const dir = sandbox({ withTools: true, withLib: true, withSkill: true });
  const result = run(dir, 'tools/verify-notes.mjs');

  assert.equal(result.code, 0, `应通过（exit=${result.code}）：\n${result.out}`);
  assert.match(result.out, /笔记门禁通过/, `必须报告通过：\n${result.out}`);
  /* 而且验的是**目标仓库**的笔记，不是本插件的 —— 计数应为 1。 */
  assert.match(result.out, /共 1 篇笔记/, `必须是目标仓库的 1 篇，不是本插件的：\n${result.out}`);
});

test('独立仓库：只拷脚本时给出可操作指引，不许抛未捕获异常', () => {
  /* 只拷一个 CLI 外壳不该能跑门禁，但**必须说清该怎么办**。
     旧实现是静态 import，直接 ERR_MODULE_NOT_FOUND —— 一堆栈、
     没有一句「该拷什么」。 */
  const dir = sandbox({ withTools: false, withLib: false, withSkill: true });
  cpSync(join(ROOT, 'tools', 'verify-notes.mjs'), join(dir, 'verify-notes.mjs'));
  const result = run(dir, 'verify-notes.mjs');

  assert.equal(result.code, 2,
    `找不到实现属「无法进行」，退出码必须是 2 而非 1`
    + `（1 表示检查不通过，混用会让调用方把环境问题当成门禁红）：`
    + `\n实际 ${result.code}\n${result.out}`);
  assert.doesNotMatch(result.out, /at file:\/\/|at async |node:internal\/modules/,
    `不得抛未捕获异常堆栈：\n${result.out}`);
  assert.match(result.out, /runAllGates|lib\/notes\.js/, `必须说明缺什么：\n${result.out}`);
  assert.match(result.out, /cp -r|DSH_AGENT_NOTES_LIB/, `必须给出怎么办：\n${result.out}`);
});

test('独立仓库：退出码 2 表示「无法进行」，与「检查失败」区分', () => {
  /* 与 sync-upstream 的约定一致：2 = 环境问题，1 = 检查不通过。
     混用会让调用方把环境问题当成门禁红了。 */
  const dir = sandbox({ withTools: true, withLib: true, withSkill: false });
  const result = run(dir, 'tools/verify-notes.mjs');
  assert.equal(result.code, 1,
    `有笔记但门禁脚本缺失 = 检查不通过，应为 1（实际 ${result.code}）：\n${result.out}`);
});

test('独立仓库：脚本缺失时报错要列出找过哪些目录', () => {
  /* 独立仓库里最常见的是「脚本在技能目录下但名字对不上」。
     只报一个拼出来的路径会让人以为是文件真不存在。 */
  const dir = sandbox({ withTools: true, withLib: true, withSkill: false });
  const result = run(dir, 'tools/verify-notes.mjs');

  assert.match(result.out, /门禁脚本缺失/, `必须报脚本缺失：\n${result.out}`);
  assert.match(result.out, /已查找：/, '必须列出找过哪些目录');
  /* 候选全不存在时不能留空行 —— 「一个都没找到」本身就是关键信息。 */
  assert.doesNotMatch(result.out, /已查找：\s*\n/, '「已查找」不得为空行');
});

test('本仓库：正常路径不受影响', () => {
  /* 多来源查找的第一候选必须仍然是本包 —— 否则会为了照顾别的仓库
     把自己的路径弄坏。 */
  const r = spawnSync(NODE, [join(ROOT, 'tools', 'verify-notes.mjs')], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true
  });
  assert.equal(r.status, 0, `本仓库必须照常通过：\n${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}`, /笔记门禁通过/);
});

test('scriptsDirCandidates：优先级是 显式 → 本包 → 目标仓库', () => {
  /* 显式指定必须排第一：用户显式说了就别猜。 */
  const explicit = join(tmpdir(), 'an-explicit-scripts-dir');
  mkdirSync(explicit, { recursive: true });
  const previous = process.env.AGENT_NOTE_SCRIPTS_DIR;
  process.env.AGENT_NOTE_SCRIPTS_DIR = explicit;
  try {
    const dirs = scriptsDirCandidates(ROOT);
    assert.equal(dirs[0], explicit, `显式指定必须排第一，实际 ${JSON.stringify(dirs)}`);
    assert.ok(dirs.includes(SCRIPTS_DIR), '本包目录也应在候选里（第二顺位）');
  } finally {
    if (previous === undefined) delete process.env.AGENT_NOTE_SCRIPTS_DIR;
    else process.env.AGENT_NOTE_SCRIPTS_DIR = previous;
    rmSync(explicit, { recursive: true, force: true });
  }
});

test('scriptsDirCandidates：能发现目标仓库里的技能脚本目录', () => {
  const dir = sandbox({ withSkill: true });
  const dirs = scriptsDirCandidates(dir);
  const found = dirs.some((d) => d.includes(join('.agents', 'skills')));
  assert.ok(found, `必须发现目标仓库的技能脚本目录，实际：${JSON.stringify(dirs)}`);
});