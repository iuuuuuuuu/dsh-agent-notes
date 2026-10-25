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
  /* 关掉行尾转换：测试断言的是「git diff 的内容」，而行尾转换会污染它。
     并行时 git 对同一批文件做 stat 检查会互相失效 → 打出 CRLF warning →
     warning 混进 diff 输出 → 解析失败（表现为文件级 test failed，没有断言）。
     这不是为本机绕过：CI 是 ubuntu（autocrlf 本就 false），
     加上这行是让所有平台看到同一份 diff。 */
  git('config', 'core.autocrlf', 'false');
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

/**
 * 带提交信息跑一次（等价于 `commit-msg` 钩子：`--staged --message-file <path>`）。
 *
 * @param {string} dir 仓库。
 * @param {Record<string,string>} files 要写的文件。
 * @param {string} message 提交信息。
 * @returns {{ code: number, out: string }} 结果。
 */
function commitWithMessage(dir, files, message) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  git('add', '-A');
  const msgFile = join(dir, '.git', 'COMMIT_EDITMSG_TEST');
  writeFileSync(msgFile, message, 'utf8');
  const result = spawnSync(NODE, [SCRIPT, '--staged', '--message-file', msgFile], {
    cwd: dir, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, NOTES_COVERAGE_SKIP: '' }
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

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

test('notes-coverage: 嵌套的流程清单项不该被报未归类（.github / .agents）', () => {
  /* 实测踩过两次同类误报：PROCESS_FILES 里写的是嵌套路径
     （`.github/workflows/`、`.agents/notes-scripts/`），而警告判断用的是
     顶层段（`.github`、`.agents`）。只做整条比较就会「明明受管却报未归类」。
     一条总在误报的门禁，人会开始无视它的全部输出。 */
  const dir = makeRepoWithGate();
  try {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n', 'utf8');
    mkdirSync(join(dir, '.agents', 'notes', 'implemented', 'process'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'notes', 'implemented', 'process', '2026-01-01-a.md'),
      '# Agent Note: a\n\nStatus: implemented\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', windowsHide: true });

    const r = spawnSync(NODE, [join(dir, 'tools', 'notes-coverage.mjs')], {
      cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env }
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.doesNotMatch(out, /没被识别为受管/,
      `.github/workflows 与 .agents/notes 都已在清单里，不该报未归类：\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: 中文路径必须被识别（git 默认会转义它们）', () => {
  /* 实测发现的真缺陷，不是理论风险：
     不带 `-z` 时 git 把非 ASCII 路径转义成 `"lib/\344\270\255\346\226\207.js"`
     并加引号 ⇒ `startsWith('lib/')` 失败 ⇒ **中文路径的源码改动被静默放行**。

     这条 flag 是我照着 deepseek-harness 的 change-scope.ts 补的。
     我最初判定它「不必要」，理由写的是「我没能构造出受影响的场景」——
     那是错误的判据：防御性 flag 的价值恰恰在于防那些罕见的配置，
     而这条一测就发现是真会踩到的。 */
  const dir = makeRepoWithGate();
  try {
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'lib', '中文模块.js'), 'export const a = 1;\n', 'utf8');
    writeFileSync(join(dir, 'lib', '有 空格.js'), 'export const b = 2;\n', 'utf8');
    /* 刻意不放双引号：Windows 文件名不允许 `"`，测试会 ENOENT。
       中文 + 空格已经能覆盖 git 的路径转义问题（非 ASCII 触发 C 风格转义）。 */
    execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', windowsHide: true });

    const r = spawnSync(NODE, [join(dir, 'tools', 'notes-coverage.mjs')], {
      cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env }
    });
    assert.equal(r.status, 1, `中文/空格/引号路径的源码改动必须被拦下，实际 exit=${r.status}`);
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.match(out, /中文模块\.js/, '诊断里必须出现原始中文路径（不能被转义）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: 中文路径的笔记同样算「带了笔记」', () => {
  /* 反向：笔记文件名也可能是中文。若路径被转义，
     `startsWith('.agents/notes/')` 与 `endsWith('.md')` 都会失败 ⇒
     人会看到「明明写了笔记却被拦」。 */
  const dir = makeRepoWithGate();
  try {
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'lib', '中文模块.js'), 'export const a = 1;\n', 'utf8');
    mkdirSync(join(dir, '.agents', 'notes', 'implemented', 'process'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'notes', 'implemented', 'process', '2026-01-01-中文笔记.md'),
      '# Agent Note: 中文\n\nStatus: implemented\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', windowsHide: true });

    const r = spawnSync(NODE, [join(dir, 'tools', 'notes-coverage.mjs')], {
      cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env }
    });
    assert.equal(r.status, 0, `中文文件名的笔记必须被认作带了笔记，实际 exit=${r.status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: 仓库根目录的源码文件也必须受管', () => {
  /* 实测确认的静默漏检：`detectSourceDirs` 只按「顶层目录」分组，
     根目录下的文件不属于任何目录，于是 `index.js` / `main.py`
     **完全不被识别为源码**。

     单文件项目（`index.js` + `package.json`）很常见 —— 在那种仓库里
     改代码不写笔记会被静默放行。 */
  const dir = makeRepoWithGate();
  try {
    writeFileSync(join(dir, 'index.js'), 'export const x = 1;\n', 'utf8');
    writeFileSync(join(dir, 'main.py'), 'print(1)\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    execFileSync('git', ['commit', '-q', '-m', 'add root sources'], { cwd: dir, encoding: 'utf8', windowsHide: true });

    writeFileSync(join(dir, 'index.js'), 'export const x = 2;\n', 'utf8');
    execFileSync('git', ['add', 'index.js'], { cwd: dir, encoding: 'utf8', windowsHide: true });

    const r = spawnSync(NODE, [join(dir, 'tools', 'notes-coverage.mjs')], {
      cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env }
    });
    assert.equal(r.status, 1, `根目录源码文件改动必须被拦下，实际 exit=${r.status}`);
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.match(out, /index\.js/, '必须点名 index.js');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: 根目录的非源码文件不受管', () => {
  /* 反向：根目录的 README、LICENSE 不该被误判成源码 ——
     否则每改一次文档都要写笔记，噪音会让人绕过门禁。 */
  const dir = makeRepoWithGate();
  try {
    for (const name of ['README.md', 'LICENSE']) {
      writeFileSync(join(dir, name), '# x\n', 'utf8');
    }
    execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    execFileSync('git', ['commit', '-q', '-m', 'add docs'], { cwd: dir, encoding: 'utf8', windowsHide: true });

    writeFileSync(join(dir, 'README.md'), '# x\n\nmore\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: dir, encoding: 'utf8', windowsHide: true });

    assert.equal(gateIn(dir), 0, '根目录文档改动不该要求笔记');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 跑门禁并返回完整结果（供新增用例断言输出文本）。
 *
 * 与 {@link gateIn} 的区别：这里要拿到 stderr/stdout，因为新增的几条判定
 * 「分叉点求不出来必须说清原因」—— 只看退出码无法区分「说了原因」
 * 和「碰巧也是 2」。
 *
 * @param {string} dir 仓库目录。
 * @param {string[]} args 追加的命令行参数。
 * @returns {{ code: number, out: string }} 退出码与合并输出。
 */
function gateOut(dir, args = []) {
  const r = spawnSync(NODE, [join(dir, 'tools', 'notes-coverage.mjs'), ...args], {
    cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env }
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * 造一个**分叉**的仓库：`main` 与 `feature` 各自在分叉点之后有提交。
 *
 * ## 为什么要分叉，不能拿一条直线冒充
 *
 * `--since` 的全部价值在于「只查本 PR 自己带来的提交」。若历史是一条直线，
 * 那么 `--since <某个祖先>` 与 `--range <同一个祖先>` 求出的提交集合完全相同，
 * 测不出任何差别 —— 用例会**假绿**。
 *
 * 所以这里造出真实场景：接这道门禁的下游仓库历史里已经堆了大量
 * 「改了代码但当时还没这道门禁」的提交（`main` 上的 `legacy-no-note`），
 * 当前 PR 只带 `feature` 上那一个提交。这正是 `--range` 接不上去、
 * `--since` 能接上的那个形态。
 *
 * @param {object} [opts] 选项。
 * @param {boolean} [opts.featureHasNote] feature 分支上是否带笔记。
 * @param {boolean} [opts.addFeatureCommit] 是否在 feature 上造提交。
 * @returns {{ dir: string, featureCommit: string | undefined, legacyCommit: string }} 仓库与相关 sha。
 */
function makeDivergedRepo(opts = {}) {
  const { featureHasNote = false, addFeatureCommit = true } = opts;
  const dir = makeRepoWithGate();
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });

  /* 老账先落在 main 上，接门禁之前就存在 —— 且它**必须**是 feature 的祖先，
     否则「分叉点之前的老提交」根本不在 HEAD 的历史里，任何以 HEAD 为终点的
     区间都自然查不到它，两种口径就会显得一样（第一版就踩了这个坑）。 */
  writeFileSync(join(dir, 'lib', 'board.js'), 'export const legacy = 1;\n', 'utf8');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'legacy-no-note: 接门禁之前的老提交');
  const legacyCommit = git('rev-parse', 'HEAD').trim();

  /* 显式立一个叫 main 的基准分支：`git init` 的默认分支名可能是 master，
     硬编码假设 main 会让 `checkout main` 直接报 pathspec 错误。 */
  git('branch', '-f', 'main', 'HEAD');
  git('checkout', '-q', '-b', 'feature');
  let featureCommit;
  if (addFeatureCommit) {
    const files = { 'lib/board.js': 'export const b = 2;\n' };
    if (featureHasNote) {
      mkdirSync(join(dir, '.agents', 'notes', 'implemented', 'process'), { recursive: true });
      files['.agents/notes/implemented/process/2026-01-01-feature.md'] =
        '# Agent Note: feature\n\nStatus: implemented\n';
    }
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(dir, rel), content, 'utf8');
    }
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'feature: 改行为');
    featureCommit = git('rev-parse', 'HEAD').trim();
  }

  /* main 之后再有提交，让 main 与 feature 真的分叉（merge-base 仍有唯一值）。 */
  git('checkout', '-q', 'main');
  writeFileSync(join(dir, 'lib', 'board.js'), 'export const mainline = 1;\n', 'utf8');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'mainline-no-note: 基准分支自身的老账');

  git('checkout', '-q', 'feature');
  return { dir, featureCommit, legacyCommit };
}

test('notes-coverage --since: 分叉点之后有代码改动无笔记 → 必须红', () => {
  const { dir, featureCommit, legacyCommit } = makeDivergedRepo();
  try {
    const { code, out } = gateOut(dir, ['--since', 'main']);
    assert.equal(code, 1, `--since 必须拦下本 PR 漏记的提交，实际 exit=${code}\n${out}`);
    assert.match(out, /feature: 改行为/, '必须点名本 PR 那个漏记的提交');
    assert.doesNotMatch(out, /legacy-no-note/,
      `分叉点之前的老账不属于本 PR，不该被算进来：\n${out}`);
    assert.match(out, new RegExp(featureCommit.slice(0, 7)), '诊断应带出问题提交的 sha 前缀');
    assert.doesNotMatch(out, new RegExp(legacyCommit.slice(0, 7)),
      '老提交的 sha 不该出现在失败清单里');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage --since: 本 PR 带笔记即绿；字面全历史区间在同一仓库仍红', () => {
  /* 这一条是 `--since` 存在的**理由**，所以必须测「同一仓库、同一 HEAD，
     两种区间来源结论不同」。只测「--since 绿」会漏掉「因为它压根没查任何
     东西所以绿」。

     ⚠️ 一个必须说清的事实（第一版断言写错过，纠正后钉在这里）：
     在分叉的仓库里 `--range main..HEAD` 与 `--since main` 求出的提交集合
     **本来就相同** —— git 两点语义的 `A..B` 就是「B 有而 A 没有的」。
     所以「`--since` 比 `--range main..HEAD` 更准」是**错的说法**。

     `--since` 真正的价值在于：**基准可以随手给一个 ref 或 sha，
     工具自己去求分叉点**，于是 CI 里不需要先把 base 算对再传进来；
     而传进来的区间端点一旦比分叉点更早（下游仓库把基准配成初始提交、
     或 `NOTES_COVERAGE_BASE` 指到很早的位置），`--range` 就会把
     「接这道门禁之前的老账」一起查出来 ⇒ 第一次接就必红 ⇒ 门禁接不上。
     那道红改不动（要补几百篇笔记）又拦不住任何东西，最后只会被人
     `--no-verify` 关掉。本用例用 `--range <初始提交>..HEAD` 复现这个形态。 */
  const { dir, legacyCommit } = makeDivergedRepo({ featureHasNote: true });
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    const rootSha = git('rev-list', '--max-parents=0', 'HEAD').trim();

    const since = gateOut(dir, ['--since', 'main']);
    assert.equal(since.code, 0, `本 PR 带笔记就该放行，实际 exit=${since.code}\n${since.out}`);
    assert.match(since.out, new RegExp(legacyCommit.slice(0, 7)),
      '通过时必须报出它自己求出的分叉点，让人能核对查的是哪个区间');
    assert.doesNotMatch(since.out, /mainline-no-note/,
      '基准分支自己那条线上的提交不在 HEAD 历史里，更不该被算成本 PR 的账');

    const range = gateOut(dir, ['--range', `${rootSha}..HEAD`]);
    assert.equal(range.code, 1,
      `字面全历史区间必须仍红（老账在范围内）—— 若这里也绿，说明两种口径没区别：\n${range.out}`);
    assert.match(range.out, /legacy-no-note/, '字面区间应把接门禁之前的老提交也算进去');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage --since: 分叉点之后没有代码改动 → 必须绿（空区间不是失败）', () => {
  /* 空区间是「这次 PR 没改任何东西」，不是「查不到」。两者必须区分：
     混为一谈会让「PR 什么都没改」变成一道永远红的门禁。 */
  const { dir } = makeDivergedRepo({ addFeatureCommit: false });
  try {
    const { code, out } = gateOut(dir, ['--since', 'main']);
    assert.equal(code, 0, `本 PR 没有提交就该放行，实际 exit=${code}\n${out}`);
    assert.match(out, /检查了 0 个提交/, '必须说清「查了 0 个提交」，让人知道它真的查过');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage --since: base-ref 不存在 → 必须退出 2 且说明原因', () => {
  const { dir } = makeDivergedRepo();
  try {
    const { code, out } = gateOut(dir, ['--since', 'refs/heads/does-not-exist']);
    assert.equal(code, 2, `base-ref 查不到必须判「无法判定」，实际 exit=${code}\n${out}`);
    assert.match(out, /merge-base/, '必须说明是 merge-base 出的问题');
    assert.match(out, /不是「已合规」/, '必须明确这不是通过');
    assert.doesNotMatch(out, /legacy-no-note/, '判失败时不该继续往下查（更不该顺手放行）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage --since: 非 git 目录 → 必须退出 2，不得静默放行', () => {
  /* 真实成因：CI 里 job 跑错目录、或源码没 checkout 就执行门禁。
     若此时退化成全绿，那道门禁就在「没检查任何东西」的情况下报通过。 */
  const dir = mkdtempSync(join(tmpdir(), 'an-coverage-nogit-'));
  try {
    const r = spawnSync(NODE, [SCRIPT, '--since', 'main'], {
      cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env }
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.equal(r.status, 2, `非 git 目录必须判「无法判定」，实际 exit=${r.status}\n${out}`);
    assert.match(out, /merge-base/, `必须说明原因，实际输出：\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage --since: 缺基准引用或与 --range 同时给 → 必须退出 2', () => {
  /* 漏值时若「当成没给」退回暂存区模式，这次 CI 什么都没查却报告通过 ——
     正是这道门禁唯一要防的失效。所以两类参数错误都判 2。 */
  const { dir } = makeDivergedRepo();
  try {
    for (const args of [['--since'], ['--since', ''], ['--since', 'main', '--range', 'main..HEAD']]) {
      const r = spawnSync(NODE, [SCRIPT, ...args], {
        cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env }
      });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      assert.equal(r.status, 2,
        `参数 ${JSON.stringify(args)} 必须判「无法判定」，实际 exit=${r.status}\n${out}`);
      assert.match(out, /不是「已合规」/, '必须明确这不是通过');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage --since: 仍然逐个提交判定，一个提交的笔记不能替另一个顶账', () => {
  /* `--since` 换了区间来源，但「逐提交判定」这条不能被顺带丢掉 ——
     丢掉的话，一次 push 三个提交只要有一个带笔记就全部放行。 */
  const { dir } = makeDivergedRepo({ featureHasNote: true });
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    /* 在 feature 上再加一笔「改代码、漏记」的提交。 */
    writeFileSync(join(dir, 'lib', 'board.js'), 'export const c = 3;\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'feature-2: 又一笔漏记');

    const { code, out } = gateOut(dir, ['--since', 'main']);
    assert.equal(code, 1, `漏记的那个提交必须被逐个抓出来，实际 exit=${code}\n${out}`);
    assert.match(out, /feature-2: 又一笔漏记/, '必须点名第二个提交');
    assert.doesNotMatch(out, /feature: 改行为\s*\n\s+lib\//, '带笔记的第一个提交不该被报');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notes-coverage: 不带参数时行为与改动前一致（仍只看暂存区）', () => {
  /* 加了新参数不代表默认口径能变。这里钉住：不给参数 ⇒ 查暂存区，
     已提交的历史改动一律不查。 */
  const dir = makeRepoWithGate();
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    writeFileSync(join(dir, 'lib', 'board.js'), 'export const legacy = 1;\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'legacy-no-note: 已提交的老账');
    assert.equal(gateIn(dir), 0, '已提交的历史不该被暂存区模式翻出来');

    writeFileSync(join(dir, 'lib', 'board.js'), 'export const staged = 1;\n', 'utf8');
    git('add', '-A');
    assert.equal(gateIn(dir), 1, '暂存区里改了受管路径仍必须红');
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

test('notes-coverage: 拦截文案必须先讲「该不该写」，并点明机械同步可跳过', () => {
  /* 需求来源（Owner 2026-10-24）：「可不要为了写笔记而写笔记，要预防这种情况」。
     门禁只能识别「改了受管路径」，识别不了改动性质；如果文案一上来就催「补一篇」，
     人就会为凑数而写 —— 笔记树注水之后，后来人分不清哪篇是真决策。
     所以文案要先让人判断，并把最常见的机械形态（含 vendored 脚本同步）说清楚。 */
  const dir = makeRepo();
  try {
    const { code, out } = commitAndCheck(dir, { 'lib/board.js': 'export const a = 1;\n' }, 'feat: 改行为');
    assert.notEqual(code, 0);
    assert.match(out, /先判断这次该不该写/, '必须先讲判断，再讲怎么补');
    assert.match(out, /凑数的笔记比不写更糟/, '要说清写凑数笔记的代价');
    assert.match(out, /同步 vendored 门禁脚本/, '必须点明「同步门禁脚本」属于可跳过的机械改动');
    assert.match(out, /Note-Skip/, '仍要给出合法出口');
    /* 顺序：先判断 → 先给「便宜的出口」（机械改动 + Note-Skip）→ 再说「确属非平凡才补写」。
       用出现位置钉住，防止将来被改回「一上来就催写」。 */
    const judgeAt = out.indexOf('先判断这次该不该写');
    const skipAt = out.indexOf('属于「机械改动」');
    const writeAt = out.indexOf('确属非平凡');
    assert.ok(
      judgeAt !== -1 && skipAt !== -1 && writeAt !== -1 && judgeAt < skipAt && skipAt < writeAt,
      `文案顺序不合理：judge=${judgeAt} skip=${skipAt} write=${writeAt}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 在临时仓库里做一次**真实提交**。
 *
 * 为什么要真提交：Note-Ref 解决的是「同一个决定拆成多个提交」，而这个机制只在
 * **区间模式**下逐提交生效；staged 模式整批一起看，区分不出「两篇笔记」与
 * 「一个决定两次提交」。（我第一版就用 staged 写，结果第二个提交里那篇笔记
 * 还留在暂存区，用例测的是同一批，等于什么都没验。）
 *
 * @param {string} dir 仓库。
 * @param {Record<string, string>} files 这次提交要写的文件。
 * @param {string} message 提交信息（可含 Note-Ref / Note-Skip）。
 * @returns {string} 这次提交的 sha。
 */
function commitReal(dir, files, message) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  git('add', '-A');
  git('-c', 'user.name=Coverage Test', '-c', 'user.email=coverage@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', message);
  return git('rev-parse', 'HEAD').trim();
}

/**
 * 以某个提交为基准跑区间模式。
 *
 * @param {string} dir 仓库。
 * @param {string} base 基准提交。
 * @returns {{ code: number, out: string }} 结果。
 */
function runSince(dir, base) {
  const result = spawnSync(NODE, [SCRIPT, '--since', base], {
    cwd: dir, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, NOTES_COVERAGE_SKIP: '', NOTES_COVERAGE_BASE: '' }
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

test('Note-Ref：同一决定的后续提交可指向既有笔记，不必再写一篇', () => {
  /* Owner 2026-10-25：「不要为了写笔记而写笔记」。机制上的施压点是覆盖门禁
     **逐提交**要求笔记（一条不能替另一个提交顶账），于是同一个决定拆成
     「实现 → 补测试 → 修 CI」三次提交就得写三篇近乎重复的笔记。
     Note-Ref 给第三条路：声明这次属于已有那篇，且路径要能被核对。 */
  const dir = makeRepo();
  try {
    const first = commitReal(dir, {
      'lib/board.js': 'export const a = 1;\n',
      '.agents/notes/implemented/feature/2026-01-01-one-decision.md':
        '# Agent Note: 一个决定\n\nStatus: implemented\n\n## Problem\n\np\n'
    }, 'feat: 一个决定（带笔记）');

    commitReal(dir, { 'lib/board.js': 'export const a = 2;\n' },
      'feat: 同一决定的后续（测试）\n\nNote-Ref: .agents/notes/implemented/feature/2026-01-01-one-decision.md');

    const result = runSince(dir, first);
    assert.equal(result.code, 0, `Note-Ref 指向存在的笔记应放行：${result.out}`);
    assert.match(result.out, /关联既有笔记/, `应当说明它关联到了哪篇：${result.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Note-Ref：指向不存在的笔记必须判红（不许变成廉价后门）', () => {
  const dir = makeRepo();
  try {
    const first = commitReal(dir, { 'lib/board.js': 'export const a = 1;\n' }, 'chore: 起始');
    commitReal(dir, { 'lib/board.js': 'export const a = 2;\n' },
      'feat: 改行为\n\nNote-Ref: .agents/notes/implemented/feature/2026-01-01-nope.md');
    const r = runSince(dir, first);
    assert.notEqual(r.code, 0, `指向不存在的笔记必须判红：${r.out}`);
    assert.match(r.out, /Note-Ref 无效/, `要说明是 Note-Ref 无效：${r.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Note-Ref：指向笔记树之外的路径必须判红', () => {
  const dir = makeRepo();
  try {
    const first = commitReal(dir, { 'lib/board.js': 'export const a = 1;\n' }, 'chore: 起始');
    commitReal(dir, { 'lib/board.js': 'export const a = 2;\n', 'README.md': '# readme\n' },
      'feat: 改行为\n\nNote-Ref: README.md');
    const r = runSince(dir, first);
    assert.notEqual(r.code, 0, `指向笔记树之外必须判红：${r.out}`);
    assert.match(r.out, /Note-Ref 无效/, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('反证：同一决定的后续提交若既不写笔记也不 Note-Ref，仍然判红', () => {
  /* 对照组：证明 Note-Ref 不是把门禁整体放宽了。 */
  const dir = makeRepo();
  try {
    const first = commitReal(dir, {
      'lib/board.js': 'export const a = 1;\n',
      '.agents/notes/implemented/feature/2026-01-01-one-decision.md':
        '# Agent Note: 一个决定\n\nStatus: implemented\n\n## Problem\n\np\n'
    }, 'feat: 一个决定（带笔记）');
    commitReal(dir, { 'lib/board.js': 'export const a = 2;\n' }, 'feat: 同一决定的后续');
    const r = runSince(dir, first);
    assert.notEqual(r.code, 0, `没声明关系就必须红：${r.out}`);
    assert.match(r.out, /没带决策笔记/, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
