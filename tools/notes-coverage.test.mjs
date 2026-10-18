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
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * 在临时仓库里跑门禁，返回退出码。
 *
 * @param {string} dir 仓库目录。
 * @param {object} [opts] 选项：message 模拟 commit-msg 传入的提交信息。
 * @returns {number} 退出码。
 */
function gateIn(dir, opts = {}) {
  const args = [join(dir, 'tools', 'notes-coverage.mjs')];
  if (typeof opts.message === 'string') {
    const file = join(dir, '.git', 'MSG_PROBE');
    writeFileSync(file, opts.message, 'utf8');
    args.push('--message-file', file);
  }
  const env = { ...process.env };
  delete env.NOTES_COVERAGE_SKIP;
  const r = spawnSync(NODE, args, { cwd: dir, encoding: 'utf8', windowsHide: true, env });
  return r.status ?? -1;
}

/**
 * 造一个已装好门禁脚本的临时仓库。
 *
 * @returns {string} 仓库目录。
 */
function makeRepoWithGate() {
  const dir = makeRepo();
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  mkdirSync(join(dir, 'lib'), { recursive: true });
  copyFileSync(SCRIPT, join(dir, 'tools', 'notes-coverage.mjs'));
  writeFileSync(join(dir, 'lib', 'board.js'), 'export const a = 1;\n', 'utf8');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('notes-coverage: 删除笔记不能算「带了笔记」（后门 1）', () => {
  /* 实测确认过的真后门：原先只判断「有没有 .agents/notes/ 下以 .md 结尾的
     路径」，于是「git rm 一篇旧笔记 + 改代码」会被判成「同批带了笔记」而放行。
     那等于任何人删一篇笔记就能给任意改动开门禁后门。
     修法是用 --diff-filter=ACMR 把删除挡掉。 */
  const dir = makeRepoWithGate();
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    const note = '.agents/notes/implemented/process/2026-01-01-old.md';
    mkdirSync(join(dir, '.agents/notes/implemented/process'), { recursive: true });
    writeFileSync(join(dir, note), '# Agent Note: old\n\nStatus: implemented\n', 'utf8');
    git('add', note);
    git('commit', '-q', '-m', 'add note');

    git('rm', '-q', note);
    writeFileSync(join(dir, 'lib', 'board.js'), 'export const b = 2;\n', 'utf8');
    git('add', 'lib/board.js');

    assert.equal(gateIn(dir), 1, '删笔记 + 改受管路径必须被拦下，不能算「带了笔记」');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: Note-Skip 不能从上一条提交继承（后门 2）', () => {
  /* 实测确认过的真后门：原先在找不到本次提交信息时会回退去读
     `git log -1 --format=%B`，于是上一条提交写过 Note-Skip 之后，
     紧接着任意不相干的改动都被静默放行 —— 写一次就永久开门，
     比没有门禁更危险（因为看起来还在管）。 */
  const dir = makeRepoWithGate();
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    writeFileSync(join(dir, 'lib', 'board.js'), 'export const b = 2;\n', 'utf8');
    git('add', 'lib/board.js');
    git('commit', '-q', '--no-verify', '-m', 'probe\n\nNote-Skip: 临时');

    writeFileSync(join(dir, 'lib', 'board.js'), 'export const c = 3;\n', 'utf8');
    git('add', 'lib/board.js');

    assert.equal(gateIn(dir), 1, '上一条提交的 Note-Skip 不得继承到本条');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: 本次提交信息里的 Note-Skip 仍然有效', () => {
  /* 后门 2 的修法不能把合法出口一起堵掉 —— 那是另一种失效。 */
  const dir = makeRepoWithGate();
  try {
    execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    writeFileSync(join(dir, 'lib', 'board.js'), 'export const b = 2;\n', 'utf8');
    execFileSync('git', ['add', 'lib/board.js'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    assert.equal(gateIn(dir, { message: 'probe\n\nNote-Skip: 只改了注释\n' }), 0,
      '本次提交信息里的 Note-Skip 必须能放行');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: 改 AGENTS.md 也要求笔记', () => {
  /* AGENTS.md 定义了「什么算非平凡改动」，改它就是改流程 ——
     和 .github/ 属于同一类。原先只把 .github/ 放进白名单、AGENTS.md 却没放，
     实测确认改它不要求任何笔记，这是逻辑矛盾。 */
  const dir = makeRepoWithGate();
  try {
    writeFileSync(join(dir, 'AGENTS.md'), '# A\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    execFileSync('git', ['commit', '-q', '-m', 'init agents'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    writeFileSync(join(dir, 'AGENTS.md'), '# A\n\n新规则\n', 'utf8');
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    assert.equal(gateIn(dir), 1, '改流程规范必须要求笔记');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: 未归类的顶层目录要显式警告，不能静默放行', () => {
  /* 通用化之后，源码目录是**自动检测**出来的（看目录里有没有常见源码后缀），
     所以 apps/ 这类含代码的目录会被正常识别、正常要求笔记。
     真正需要警告的是「检测不出来」的情况：目录里暂时只有非源码文件
     （纯数据、纯文档），于是不算源码目录 —— 之后往里加代码就会静默不受管。 */
  const dir = makeRepoWithGate();
  try {
    mkdirSync(join(dir, 'weird'), { recursive: true });
    writeFileSync(join(dir, 'weird', 'notes.txt'), 'pure data\n', 'utf8');
    execFileSync('git', ['add', 'weird'], { cwd: dir, encoding: 'utf8', windowsHide: true });

    const r = spawnSync(NODE, [join(dir, 'tools', 'notes-coverage.mjs')], {
      cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env }
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.match(out, /weird/, '必须点名出现在输出里');
    assert.match(out, /notes-coverage\.json|sourceDirs/, '必须告诉人怎么修');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: 源码目录靠仓库结构自动检测，不写死语言', () => {
  /* 通用性的核心：同一份脚本要能装进任何技术栈的仓库。
     这里造三种语言标志，验证检测不依赖任何仓库专属配置。 */
  const dir = makeRepo();
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    mkdirSync(join(dir, 'tools'), { recursive: true });
    copyFileSync(SCRIPT, join(dir, 'tools', 'notes-coverage.mjs'));

    /* Dart / Rust / Go 三栈各一个文件，分属三个目录。 */
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'main.dart'), 'void main() {}\n', 'utf8');
    mkdirSync(join(dir, 'crates'), { recursive: true });
    writeFileSync(join(dir, 'crates', 'lib.rs'), 'pub fn f() {}\n', 'utf8');
    mkdirSync(join(dir, 'cmd'), { recursive: true });
    writeFileSync(join(dir, 'cmd', 'main.go'), 'package main\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    for (const rel of ['lib/main.dart', 'crates/lib.rs', 'cmd/main.go']) {
      writeFileSync(join(dir, rel), `// touched ${rel}\n`, 'utf8');
    }
    git('add', '-A');

    const r = spawnSync(NODE, [join(dir, 'tools', 'notes-coverage.mjs')], {
      cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env }
    });
    assert.equal(r.status, 1, `三种语言的源码目录都必须被识别为受管，实际 exit=${r.status}`);
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    for (const p of ['lib/main.dart', 'crates/lib.rs', 'cmd/main.go']) {
      assert.match(out, new RegExp(p.replace('/', '\\/')), `必须点名 ${p}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: 改门禁脚本自己要要求笔记（.agents/ 不能整目录豁免）', () => {
  /* 实测踩过的后门：第一版把整个 `.agents/` 放进豁免前缀，
     于是 `.agents/notes-scripts/notes-coverage.mjs`（门禁脚本本身）改动
     也不要求笔记 —— 那正是「改门禁不写笔记」这个洞。
     正确做法是只豁免**笔记目录本身**，`.agents/` 下其它内容照常判定。 */
  const dir = makeRepoWithGate();
  try {
    /* makeRepoWithGate 把脚本放在 tools/，这里另造一个 .agents/notes-scripts 下的。 */
    mkdirSync(join(dir, '.agents', 'notes-scripts'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'notes-scripts', 'gate.mjs'), '// gate v1\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    execFileSync('git', ['commit', '-q', '-m', 'add gate'], { cwd: dir, encoding: 'utf8', windowsHide: true });

    writeFileSync(join(dir, '.agents', 'notes-scripts', 'gate.mjs'), '// gate v2\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', windowsHide: true });

    assert.equal(gateIn(dir), 1, '改门禁脚本必须要求笔记，不能因为它在 .agents/ 下就豁免');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: 写笔记本身不要求再写笔记', () => {
  /* 上一条的反面：如果笔记目录也被受管，那「补一篇笔记」这个动作本身
     又需要一篇笔记 —— 无限递归，门禁没法用。 */
  const dir = makeRepoWithGate();
  try {
    mkdirSync(join(dir, '.agents', 'notes', 'implemented', 'process'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'notes', 'implemented', 'process', '2026-01-01-a.md'),
      '# Agent Note: a\n\nStatus: implemented\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', windowsHide: true });

    assert.equal(gateIn(dir), 0, '只写笔记不该被要求笔记');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: 已受管的目录不该再被报「未归类」（误报噪音）', () => {
  /* 实测踩过：unclassifiedTopDirs 原先只检查 sourceDirs 与豁免前缀，
     没有检查 PROCESS_FILES。于是 .githooks 明明已经在流程文件清单里、
     会被正常拦下，却仍然被报「没被识别为受管」——
     一条总在误报的门禁，人会开始无视它的全部输出。
     修复后：命中任何受管规则的目录都不该出现在警告里。 */
  const dir = makeRepoWithGate();
  try {
    mkdirSync(join(dir, '.githooks'), { recursive: true });
    writeFileSync(join(dir, '.githooks', 'commit-msg'), '#!/bin/sh\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', windowsHide: true });

    /* 同时带一篇笔记，让整体走「通过」分支（警告在通过分支也会打印）。 */
    mkdirSync(join(dir, '.agents', 'notes', 'implemented', 'process'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'notes', 'implemented', 'process', '2026-01-01-a.md'),
      '# Agent Note: a\n\nStatus: implemented\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', windowsHide: true });

    const r = spawnSync(NODE, [join(dir, 'tools', 'notes-coverage.mjs')], {
      cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env }
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.doesNotMatch(out, /没被识别为受管/, `.githooks 已在 PROCESS_FILES 里，不该报未归类：\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: 区间里一个提交的笔记不能替另一个提交顶账', () => {
  /* 实测确认的后门：区间模式原先用 `git diff base..HEAD` 合并看，
     于是「一次 push 多个提交」时，只要其中**一次**带了笔记，
     其余改代码却漏记的提交全被掩护过去 —— 而那正是最需要门禁盯住的形态。
     现在改成按提交逐个判定（`git rev-list --reverse` + 每个 `sha^!`）。 */
  const dir = makeRepoWithGate();
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    const base = git('rev-parse', 'HEAD').trim();

    /* 提交 1：改代码 + 带笔记。 */
    writeFileSync(join(dir, 'lib', 'board.js'), 'export const b = 2;\n', 'utf8');
    mkdirSync(join(dir, '.agents', 'notes', 'implemented', 'process'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'notes', 'implemented', 'process', '2026-01-01-a.md'),
      '# Agent Note: a\n\nStatus: implemented\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'good: 带笔记');

    /* 提交 2：改代码，漏记。 */
    writeFileSync(join(dir, 'lib', 'board.js'), 'export const c = 3;\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'bad: 漏记');

    const r = spawnSync(NODE, [join(dir, 'tools', 'notes-coverage.mjs'), '--range', `${base}..HEAD`], {
      cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env }
    });
    assert.equal(r.status, 1, `区间里有漏记提交必须红，实际 exit=${r.status}`);
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.match(out, /bad: 漏记/, '必须点名是哪个提交漏记');
    assert.doesNotMatch(out, /good: 带笔记\s*\n\s+lib\//, '带笔记的那个提交不该被报');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: 区间里每个提交都能用自己的 Note-Skip 放行', () => {
  /* 逐提交检查的副作用：Note-Skip 也必须逐提交生效，
     不能因为别的提交带了笔记就自动放行。 */
  const dir = makeRepoWithGate();
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    const base = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, 'lib', 'board.js'), 'export const b = 2;\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'skip: 只改注释\n\nNote-Skip: 无行为变化');

    const r = spawnSync(NODE, [join(dir, 'tools', 'notes-coverage.mjs'), '--range', `${base}..HEAD`], {
      cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env }
    });
    assert.equal(r.status, 0, `该提交自己有 Note-Skip，应放行，实际 exit=${r.status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: 配置文件可覆盖自动检测', () => {
  /* 自动检测不是万能的（比如把源码放在名字奇怪、暂时只有非源码文件的目录里）。
     这时用 .agents/notes-coverage.json 显式声明 —— 但**整体替换**而非叠加，
     避免「我以为配了、其实没配」的模糊状态。 */
  const dir = makeRepo();
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    mkdirSync(join(dir, 'tools'), { recursive: true });
    copyFileSync(SCRIPT, join(dir, 'tools', 'notes-coverage.mjs'));
    mkdirSync(join(dir, 'odd'), { recursive: true });
    writeFileSync(join(dir, 'odd', 'thing.txt'), 'not source\n', 'utf8');
    mkdirSync(join(dir, '.agents'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'notes-coverage.json'),
      JSON.stringify({ sourceDirs: ['odd'] }), 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    writeFileSync(join(dir, 'odd', 'thing.txt'), 'changed\n', 'utf8');
    git('add', '-A');

    const r = spawnSync(NODE, [join(dir, 'tools', 'notes-coverage.mjs')], {
      cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env }
    });
    assert.equal(r.status, 1, `配置里声明的目录必须受管，实际 exit=${r.status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
