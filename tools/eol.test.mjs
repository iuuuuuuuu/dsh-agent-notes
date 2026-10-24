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
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * 把临时仓库的索引文件写坏，制造「`.git` 在但 git 命令报错」的真故障。
 *
 * 用它而不是「删掉 `.git`」：删掉 `.git` 会变成「不是 git 仓库」——
 * 那正是可以合法退回文件系统遍历的情况，测不到失败关闭。
 *
 * @param {string} dir 临时仓库根。
 */
function corruptIndex(dir) {
  writeFileSync(join(dir, '.git', 'index'), 'DIRC\x00\x00\x00\x00 这不是真的索引', 'utf8');
}

/**
 * 把**被测脚本本体**复制进夹具根下的 `tools/eol.mjs` 再运行它。
 *
 * 为什么复制而不是跑仓库里那个：`main()` 的语料根是脚本自己所在位置推出来的
 * （`PACKAGE_ROOT`），只有让脚本落在夹具里，才能在**不改本仓库任何文件**的
 * 前提下真跑一遍 CLI 的退出码通道。复制的就是磁盘上这份被测代码本身 ——
 * 不是副本实现，所以退出码逻辑改了它一定会红。
 *
 * @param {string} dir 夹具根（临时仓库或普通临时目录）。
 * @returns {string} 夹具里的脚本路径。
 */
function copyToolInto(dir) {
  mkdirSync(join(dir, 'tools'), { recursive: true });
  const script = join(dir, 'tools', 'eol.mjs');
  copyFileSync(join(ROOT, 'tools', 'eol.mjs'), script);
  return script;
}

/**
 * 运行 CLI（真子进程），返回退出码与合并输出。
 *
 * `status === null` 时退出码记 `-1`：那种情况是「没正常结束」，
 * 不能与任何按契约的退出码混淆（`tools/syntax-check.mjs` 同口径）。
 *
 * @param {string} script 夹具里的脚本路径。
 * @param {Record<string, string>} [env] 追加/覆盖的环境变量。
 * @returns {{ code: number, status: number|null, signal: string|null, out: string }} 退出码与输出。
 */
function runCli(script, env = {}) {
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    windowsHide: true
  });
  return {
    code: result.status ?? -1,
    status: result.status,
    signal: result.signal ?? null,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`
  };
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
    assert.equal(result.exitCode, 1, '真违规走「检查失败」通道 —— 不许放宽成 2');
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

test('eol: 目录不是 git 仓库时退回文件系统遍历（夹具可用，不算失败）', () => {
  /* 唯一的降级口子：git 明确说「这里不是 git 仓库」。临时目录本来就没有 .git，
     要是这条不成立，所有夹具都得先 `git init` —— 那是让测试迁就实现。
     （早先这里靠调用方传 `allowNonGit: true` 开关，等于把「要不要失败关闭」
     交给调用方；现在按 git 的报错判定，开关已删。） */
  const dir = mkdtempSync(join(tmpdir(), 'an-eol-nogit-'));
  try {
    writeFileSync(join(dir, 'bad.md'), '没有结尾换行', 'utf8');
    const result = verifyTrailingNewlines({ root: dir });
    assert.equal(result.source, 'fs');
    assert.equal(result.checked, 1);
    assert.match(result.errors.join('\n'), /bad\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eol: 真仓库里 git 坏了必须失败关闭（不许静默改用工作区遍历）', () => {
  /* 失效形态（CodeRabbit 在 PR #30 上指出的正是这条，我最初只改了注释没改行为）：
     原来的 catch 直接退到文件系统遍历 —— 在**真仓库**里 git 坏了、索引坏了、
     权限没了，门禁会换一份语料（工作区内容，含未跟踪文件）继续报「通过」。
     那不是「降级」，是换了个问题去答。
     这里用「索引文件被写坏」制造真故障：`.git` 在（所以不是「不是仓库」那种可放行
     的情况），但 `git ls-files` 会报错 —— 正是要区分开的两种状态。 */
  const dir = gitSandbox({ 'bad.md': '没有结尾换行' });
  try {
    corruptIndex(dir);
    const result = verifyTrailingNewlines({ root: dir });
    assert.equal(result.checked, 0, '取不到语料时不许声称检查过文件');
    assert.equal(result.source, 'git-error');
    assert.equal(result.exitCode, 2, '取不到语料 ⇒ 2（无法进行），不是 1（检查失败）');
    assert.match(result.errors.join('\n'), /取不到已跟踪文件列表/);
    assert.doesNotMatch(result.errors.join('\n'), /bad\.md/, '不许改用工作区遍历后报文件级结果');
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
    assert.equal(result.exitCode, 1, '索引为空是真语料异常 ⇒ 检查失败（1），不是「无法进行」（2）');
    assert.match(result.errors.join('\n'), /空语料不得当绿/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── CLI 退出码通道（真子进程，断言的是调用方/CI 真正读到的那个数） ──────────
   为什么必须真跑 CLI：本缺陷的形态就是「函数返回得很诚实，通道是错的」。
   只断言 `verifyTrailingNewlines()` 的返回值会让「`main()` 里把 2 又压回 1」
   这类改法留一条活路 —— 而 CI 只看退出码，所以退出码必须端到端钉住。 */

test('eol: git 不可用时 CLI 退 2（无法进行），不是「校验失败」的 1', () => {
  /* 复现审计报告「发现 5」的场景：`PATH` 里没有 git。用 `PATH: ''` 而不是
     删单个条目 —— 夹具目录里放着一个**真的违规文件**（缺结尾换行），
     所以「退 2 且不提这个文件」同时证明了「没有偷偷改用工作区遍历」。 */
  const dir = mkdtempSync(join(tmpdir(), 'an-eol-nogit-bin-'));
  try {
    const script = copyToolInto(dir);
    writeFileSync(join(dir, 'bad.md'), '没有结尾换行', 'utf8');
    const { code, status, out } = runCli(script, { PATH: '' });
    assert.equal(status, 2, `git 取不到 ⇒ 退出码 2（无法进行），实际 ${code}；输出：\n${out}`);
    assert.match(out, /无法进行/, '必须明说「无法进行」');
    assert.match(out, /没有完成校验/, '必须明说本次没有完成校验');
    /* 「把结论说错」是这条缺陷的本体：不许再把「取不到语料」讲成「文件违规」。 */
    assert.doesNotMatch(out, /校验失败/, '不许把「无法进行」报成「校验失败」');
    assert.doesNotMatch(out, /bad\.md/, '一条文件都没检查，不许出现文件级结论');
    assert.doesNotMatch(out, /No newline at end of file/, '没检查成时不许解释违规的后果');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eol: 真仓库里 git 坏了时 CLI 也退 2（不依赖 PATH 的花招）', () => {
  /* 与上一条同一通道，另一条触发路径：git 在 PATH 里、`.git` 也在，
     但 `git ls-files` 真报错（索引被写坏）。
     现有断言只到返回值；这条把「真故障 → 退出码 2」端到端钉住。 */
  const dir = gitSandbox({ 'bad.md': '没有结尾换行' });
  try {
    corruptIndex(dir);
    const script = copyToolInto(dir);
    const { code, status, out } = runCli(script);
    assert.equal(status, 2, `git ls-files 失败 ⇒ 退出码 2，实际 ${code}；输出：\n${out}`);
    assert.match(out, /取不到已跟踪文件列表/, '诚实诊断必须保留');
    assert.match(out, /无法进行/);
    assert.doesNotMatch(out, /bad\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eol: 真违规文件时 CLI 仍然退 1（没有把 1 一起放宽成 2）', () => {
  /* 反面对照。缺了它，「把所有 errors 一律压成 2」这种改法会全绿 ——
     而那样真违规就失去了可区分的退出码，CI 分不清「该修文件」还是「环境不行」。 */
  const dir = gitSandbox({ 'bad.md': '第一行\n\n' });
  try {
    const script = copyToolInto(dir);
    const { code, status, out } = runCli(script);
    assert.equal(status, 1, `真违规 ⇒ 退出码 1（检查失败），实际 ${code}；输出：\n${out}`);
    assert.match(out, /结尾换行校验失败/, '真违规仍走「校验失败」通道');
    assert.match(out, /bad\.md/, '必须点名违规文件');
    assert.match(out, /多余的空行/);
    assert.doesNotMatch(out, /无法进行/, '真违规不是「无法进行」');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eol: CLI 在「不是 git 仓库」时仍退回文件系统遍历并退 1（那是合法回退信号）', () => {
  /* 这条钉住两种状态的边界，免得为修退出码把回退口子也一起关掉：
     - 「这里不是 git 仓库」= 可判定的稳定状态（夹具/导出目录）⇒ 退回 fs 遍历；
     - 其它任何 git 失败 ⇒ `git-error` ⇒ 2。
     同一条测试也证明 fs 遍历路径上的**真违规**依旧是 1，不是 2。 */
  const dir = mkdtempSync(join(tmpdir(), 'an-eol-nogit-fs-'));
  try {
    const script = copyToolInto(dir);
    writeFileSync(join(dir, 'bad.md'), '没有结尾换行', 'utf8');
    const { code, status, out } = runCli(script);
    assert.equal(status, 1, `fs 遍历发现真违规 ⇒ 1，实际 ${code}；输出：\n${out}`);
    assert.match(out, /bad\.md/, 'fs 遍历必须报出文件级结论');
    assert.doesNotMatch(out, /取不到已跟踪文件列表/, '「不是 git 仓库」不是错误，不许走 git-error 的文案');
    assert.doesNotMatch(out, /无法进行/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
