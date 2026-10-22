#!/usr/bin/env node
/**
 * 结尾换行门禁：每个文本文件必须**恰好以一个换行结尾**。
 *
 * ## 为什么需要
 *
 * 上游 A 的根 `AGENTS.md:165` 写着一条明确的仓库级约定：
 *
 * > Files end with exactly one trailing newline; `git diff --cached --check`
 * > (pre-commit) gates it.
 *
 * 它守卫的不是「好看」，而是**两件具体会咬人的事**：
 *
 * 1. **缺结尾换行**会让 diff 里出现 `\ No newline at end of file`，而这行
 *    挂在**最后一个改动行**后面 —— 看 diff 的人会把「作者忘了换行」误读成
 *    「作者把最后一行改了」。实测本仓库有 63 个 tracked 文件处于这个状态。
 * 2. **结尾多一个空行**是纯噪音：它不携带任何信息，却让每个碰过该文件的
 *    diff 都多出两行无关内容。
 *
 * ## 为什么不能照抄上游的 `git diff --cached --check`
 *
 * 实测（临时仓库，两个文件：一个缺结尾换行、一个结尾多一个空行）：
 *
 * ```
 * $ git diff --cached --check
 * extra.md:2: new blank line at EOF.
 * $ echo $?
 * 2
 * ```
 *
 * **只抓到了「多空行」，缺结尾换行的那个文件根本没被报出来**。也就是说
 * 照抄上游的做法会得到「以为有门禁、实际上只覆盖一半」的假绿 —— 正是本
 * 仓库最忌讳的形态。
 *
 * 所以这里自己判定字节：末尾必须是恰好一个 `\n`，且它前面不能再是 `\n`。
 *
 * ## 范围
 *
 * - **只判 tracked 文件**（`git ls-files`）。未跟踪的新文件由提交钩子与
 *   CI 在入库那一刻管；把工作区里的一切都扫进来会让门禁对「还没打算提交
 *   的草稿」发红。
 * - **跳过二进制**：含 NUL 字节的文件不是文本，「结尾换行」对它无意义。
 * - **跳过 `skills/agent-notes/`**：vendored 上游副本，手改会被哈希门禁
 *   拦下（`AGENTS.md` 硬约束 3），本仓库无权改它 —— 那里有 2 个文件
 *   处于「缺结尾换行」状态，**这是已知的、故意留下的例外**。
 * - **跳过归档笔记**（`.agents/notes/archived/`）：被 SHA-256 封印，改了就
 *   报 `seal mismatch`，红了自己也改不动。
 * - **空文件不算错**：空文件没有「结尾」，谈不上多一个或少一个换行。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 遍历时跳过的目录（与 `tools/text-integrity.mjs` 同口径）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.probe', 'dist', 'build', 'coverage']);

/** 路径前缀豁免：这些目录不受本门禁管辖（理由见文件头注释）。 */
const EXEMPT_PREFIXES = [
  'skills/agent-notes/',
  '.agents/notes/archived/'
];

/**
 * 判断一段字节是不是「文本」。
 *
 * 判据：不含 NUL 字节，且能按 UTF-8 解码（解码失败说明它是二进制）。
 *
 * 为什么不用「扩展名白名单」：白名单会漏掉无扩展名的文本文件
 * （`.gitignore`、`.gitattributes`、`LICENSE`、`.githooks/commit-msg`）——
 * 实测本仓库正好有 4 个这种文件在语料之外，白名单式扫描对它们完全无感。
 *
 * @param {Buffer} buffer 文件内容。
 * @returns {boolean} 是否为文本。
 */
export function isTextFile(buffer) {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * 判断一个文件的结尾是不是「恰好一个换行」。
 *
 * @param {Buffer} buffer 文件内容。
 * @returns {{ ok: boolean, reason: string|null }} 结论与理由。
 */
export function checkTrailingNewline(buffer) {
  if (buffer.length === 0) return { ok: true, reason: null };
  /* ⚠️ Buffer 没有 `endsWith`（那是字符串的方法）—— 写错会当场抛
     `TypeError: buffer.endsWith is not a function`，而门禁的失败必须是
     「判据输出」而不是「栈」。逐字节判断。 */
  if (buffer[buffer.length - 1] !== 0x0a) {
    return { ok: false, reason: '文件没有以换行结尾' };
  }
  if (buffer.length >= 2 && buffer[buffer.length - 2] === 0x0a) {
    return { ok: false, reason: '文件结尾有多余的空行' };
  }
  return { ok: true, reason: null };
}

/**
 * 列出仓库根下所有 tracked 文件（仓库相对路径，正斜杠）。
 *
 * 用 `git ls-files` 而不是遍历文件系统：门禁要判的是**入库内容**的形态，
 * 而不是工作区里一切东西的形态 —— 未跟踪的草稿不该让门禁发红。
 *
 * Git 不可用时（本仓库只在 git 仓库里跑，但测试夹具可能不是）退回文件系统
 * 遍历：这时扫到的是工作区内容，判据仍成立，只是不再区分「已跟踪」。
 *
 * @param {string} root 仓库根。
 * @returns {{ files: string[], source: 'git'|'fs' }} 文件列表与来源。
 */
export function listTrackedFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      /* 吞掉 git 自己的报错：不是仓库时它会往 stderr 写「fatal: not a git
         repository」，而那道输出在门禁结果之外 —— 会被读成「出了什么
         意外」。这里已经用 catch 退回文件系统遍历，stderr 不该外泄。 */
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const files = out.split('\0').filter((name) => name !== '');
    if (files.length > 0) return { files: files.map((f) => f.split('\\').join('/')), source: 'git' };
  } catch {
    /* 没有 git 或不是仓库：退回文件系统遍历。 */
  }

  const files = [];
  const walk = (rel) => {
    const dir = rel === '' ? root : join(root, rel);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(childRel);
      else files.push(childRel.split('\\').join('/'));
    }
  };
  walk('');
  return { files: files.sort(), source: 'fs' };
}

/**
 * 判断某个路径是否被豁免。
 *
 * @param {string} rel 仓库相对路径（正斜杠）。
 * @returns {boolean} 是否豁免。
 */
export function isExempt(rel) {
  return EXEMPT_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

/**
 * 执行检查。
 *
 * @param {{ root?: string }} [options] 可选仓库根（测试用临时目录）。
 * @returns {{ checked: number, errors: string[], source: string }} 结果。
 */
export function verifyTrailingNewlines(options = {}) {
  const root = options.root ?? PACKAGE_ROOT;
  const { files, source } = listTrackedFiles(root);
  const errors = [];
  let checked = 0;

  for (const rel of files) {
    if (isExempt(rel)) continue;
    let buffer;
    try {
      buffer = readFileSync(join(root, rel));
    } catch {
      /* 文件已消失（并发删除）：不是本门禁要管的事。 */
      continue;
    }
    if (!isTextFile(buffer)) continue;
    checked += 1;
    const { ok, reason } = checkTrailingNewline(buffer);
    if (!ok) {
      errors.push(`${rel}：${reason}（必须恰好以一个换行结尾）`);
    }
  }

  return { checked, errors, source };
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

function main() {
  const result = verifyTrailingNewlines();
  if (result.errors.length === 0) {
    console.log(
      `结尾换行通过：${result.checked} 个文本文件都以恰好一个换行结尾`
      + `（语料来源：${result.source === 'git' ? 'git ls-files' : '文件系统遍历'}）。`
    );
    process.exit(0);
  }
  console.error(`结尾换行校验失败：${result.errors.length} 处`);
  for (const error of result.errors) console.error(`  ✖ ${error}`);
  console.error('  缺结尾换行会让 diff 出现 "\\ No newline at end of file"，看 diff 的人会误读最后一行。');
  console.error('  结尾多空行是纯噪音 —— 每个碰过该文件的 diff 都多两行无关内容。');
  process.exit(1);
}

const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replace(/\\/g, '/').endsWith('/tools/eol.mjs');
if (invokedDirectly) main();
