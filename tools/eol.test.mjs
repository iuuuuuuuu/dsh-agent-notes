/**
 * `tools/eol.mjs` 的行为测试。
 *
 * ## 这个门禁在补什么
 *
 * 上游 A 的根 `AGENTS.md:165` 写着「Files end with exactly one trailing
 * newline」，并用 `git diff --cached --check` 守卫。但实测发现那个命令
 * **只抓「结尾多空行」，抓不到「缺结尾换行」** ——
 * 照抄它会得到「以为有门禁、实际只覆盖一半」的假绿。
 *
 * 本门禁自己按字节判定：末尾必须是恰好一个 `\n`。
 *
 * ## 语料来自 git，不是文件系统遍历
 *
 * 门禁要判的是**入库内容**的形态。扫工作区里的一切会让「还没打算提交的
 * 草稿」把门禁弄红 —— 那是最容易被绕过的门禁形态。
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  checkTrailingNewline,
  isExempt,
  isTextFile,
  verifyTrailingNewlines
} from './eol.mjs';

const ROOT = join(import.meta.dirname, '..');

/**
 * 在临时目录里造一个 git 仓库，塞入给定文件。
 *
 * @param {Record<string, string>} files 相对路径 → 内容（字节以字符串给）。
 * @returns {string} 仓库根。
 */
function gitSandbox(files) {
  const dir = mkdtempSync(join(tmpdir(), 'an-eol-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'eol@example.invalid'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'eol'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, windowsHide: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: dir, windowsHide: true });
  return dir;
}

test('eol: 当前仓库所有文本文件都以恰好一个换行结尾', () => {
  const result = verifyTrailingNewlines({ root: ROOT });
  assert.deepEqual(result.errors, [], `不得有结尾形态问题：\n${result.errors.join('\n')}`);
  /* 空集合通过是最隐蔽的假绿 —— 必须证明扫到了东西。 */
  assert.ok(result.checked > 150, `必须扫到足够多的文件，实际 ${result.checked}`);
});

test('eol: 缺结尾换行必须红', () => {
  const dir = gitSandbox({ 'a.md': '第一行\n第二行' });
  try {
    const result = verifyTrailingNewlines({ root: dir });
    assert.equal(result.errors.length, 1, '缺结尾换行必须判失败');
    assert.match(result.errors[0], /a\.md/);
    assert.match(result.errors[0], /没有以换行结尾/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eol: 结尾多一个空行必须红', () => {
  const dir = gitSandbox({ 'a.md': '第一行\n\n' });
  try {
    const result = verifyTrailingNewlines({ root: dir });
    assert.equal(result.errors.length, 1, '结尾多空行必须判失败');
    assert.match(result.errors[0], /多余的空行/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eol: 恰好一个换行必须绿（不能过度拦截）', () => {
  const dir = gitSandbox({ 'a.md': '第一行\n第二行\n' });
  try {
    const result = verifyTrailingNewlines({ root: dir });
    assert.deepEqual(result.errors, [], '正常结尾必须通过');
    assert.equal(result.checked, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eol: 空文件不算错', () => {
  const dir = gitSandbox({ 'empty.md': '' });
  try {
    const result = verifyTrailingNewlines({ root: dir });
    assert.deepEqual(result.errors, [], '空文件没有「结尾」，不该判错');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eol: 二进制文件被跳过（判定的是文本形态）', () => {
  const dir = gitSandbox({ 'a.bin': 'abc\u0000def' });
  try {
    const result = verifyTrailingNewlines({ root: dir });
    assert.deepEqual(result.errors, [], '二进制不该被当成文本判错');
    assert.equal(result.checked, 0, '二进制不计入 checked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eol: vendored 上游副本与归档笔记被豁免（本仓库无权改）', () => {
  /* skills/agent-notes/ 是受管副本，手改会被哈希门禁拦下；
     .agents/notes/archived/ 被 SHA-256 封印，改了就报 seal mismatch。 */
  assert.ok(isExempt('skills/agent-notes/SKILL.md'));
  assert.ok(isExempt('skills/agent-notes/assets/agent-notes-board.html'));
  assert.ok(isExempt('.agents/notes/archived/simplification/x.md'));
  assert.ok(!isExempt('tools/eol.mjs'));
  assert.ok(!isExempt('.agents/notes/implemented/process/x.md'));

  /* 真实仓库里那 2 个 vendored 文件确实缺结尾换行 —— 它们必须被豁免，
     否则这道门禁会要求我们改不该改的文件。 */
  const result = verifyTrailingNewlines({ root: ROOT });
  const vendored = result.errors.filter((e) => e.startsWith('skills/agent-notes/'));
  assert.deepEqual(vendored, [], 'vendored 文件不得出现在错误列表里');
});

test('eol: 未跟踪的文件不参与判定（语料是入库内容）', () => {
  /* 门禁判的是「入库内容」的形态。扫工作区里的一切，会让一份还没打算
     提交的草稿把门禁弄红 —— 那是最容易被绕过的形态。 */
  const dir = gitSandbox({ 'a.md': 'ok\n' });
  try {
    writeFileSync(join(dir, 'draft.md'), '还没有结尾换行', 'utf8');
    const result = verifyTrailingNewlines({ root: dir });
    assert.deepEqual(result.errors, [], '未跟踪文件不该被判定');
    assert.equal(result.checked, 1, '只统计已跟踪的文本文件');
    assert.equal(result.source, 'git');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eol: isTextFile 认得无扩展名的文本文件', () => {
  /* 白名单式扫描会漏掉 .gitignore / LICENSE / .githooks/commit-msg ——
     实测本仓库正好有 4 个这种文件在语料之外。 */
  assert.ok(isTextFile(Buffer.from('# comment\n', 'utf8')));
  assert.ok(!isTextFile(Buffer.from([0x61, 0x00, 0x62])));
  assert.ok(!isTextFile(Buffer.from([0xff, 0xfe, 0xfd])));
});

test('eol: checkTrailingNewline 的判据逐条明确', () => {
  assert.equal(checkTrailingNewline(Buffer.from('a\n', 'utf8')).ok, true);
  assert.equal(checkTrailingNewline(Buffer.from('a', 'utf8')).ok, false);
  assert.equal(checkTrailingNewline(Buffer.from('a\n\n', 'utf8')).ok, false);
  assert.equal(checkTrailingNewline(Buffer.alloc(0)).ok, true);
});

test('eol: git 取不到语料必须失败关闭（不许静默改用工作区遍历）', () => {
  /* 失效形态（CodeRabbit 在 PR #30 上指出的正是这条，我最初只改了注释没改行为）：
     原来的 catch 直接退到文件系统遍历 —— 在**真仓库**里 git 坏了、索引空了、
     权限没了，门禁会换一份语料（工作区内容，含未跟踪文件）继续报「通过」。
     那不是「降级」，是换了个问题去答。 */
  const dir = mkdtempSync(join(tmpdir(), 'an-eol-nogit-'));
  try {
    writeFileSync(join(dir, 'bad.md'), '没有结尾换行', 'utf8');
    /* 不加 allowNonGit：非 git 目录 ⇒ 必须报「取不到语料」，而不是报 bad.md。 */
    const strict = verifyTrailingNewlines({ root: dir });
    assert.equal(strict.checked, 0, '取不到语料时不许声称检查过文件');
    assert.equal(strict.source, 'git-error');
    assert.match(strict.errors.join('\n'), /取不到已跟踪文件列表/);
    assert.doesNotMatch(strict.errors.join('\n'), /bad\.md/, '不许改用工作区遍历后报文件级结果');

    /* 阳性对照：显式允许非 git（夹具场景）时，同一个目录确实会被扫到 ——
       证明上面那条「没报 bad.md」不是因为判据整个没跑。 */
    const loose = verifyTrailingNewlines({ root: dir, allowNonGit: true });
    assert.equal(loose.source, 'fs');
    assert.equal(loose.checked, 1);
    assert.match(loose.errors.join('\n'), /bad\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eol: 空仓库（一个已跟踪文件都没有）必须红，不是「0 个文件通过」', () => {
  const dir = gitSandbox({ 'keep.txt': 'x\n' });
  try {
    /* 把唯一文件从索引里删掉但留在磁盘上：git 在、索引空。 */
    execFileSync('git', ['rm', '-q', '--cached', 'keep.txt'], { cwd: dir, windowsHide: true });
    const result = verifyTrailingNewlines({ root: dir });
    assert.equal(result.source, 'git-empty');
    assert.match(result.errors.join('\n'), /空语料不得当绿/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
