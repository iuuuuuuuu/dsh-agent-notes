/**
 * 文本完整性门禁：拒绝 U+FFFD 替换字符与控制字符。
 *
 * ## 为什么需要
 *
 * U+FFFD（替换字符）是无损检测的结果：**编辑或工具链在某一步损坏了字节，
 * 但文件仍然是合法的 UTF-8**（因为替换字符本身就是合法字符）。
 *
 * 所以现有门禁全都看不见它 —— 实测一份正文含 3 个 U+FFFD 的 Markdown，
 * `tools/md-links.mjs` 报 `errors = 0`。笔记门禁也不拦：格式完全合法，
 * 链接、标题、段落结构都没问题，只是**内容坏了**。
 *
 * 实测踩过：本轮写一篇 rejected 笔记时，中文被截断出 5 处 U+FFFD，
 * 它们安静地待在段落中间（「它会在半年␦被人重新提起」）。若没有这道门禁，
 * 它会进仓库、进历史、永久留在文档里 —— 而读者只会以为「作者写了个奇怪
 * 的字」，不会想到是编码损坏。
 *
 * ## 检查什么
 *
 * 1. **U+FFFD 替换字符** —— 字节损坏的确凿证据，一律拒绝。
 * 2. **裸控制字符**（除 `\t \n \r` 外）—— 通常是脚本拼接时漏了转义。
 * 3. **行尾空白** 与 **行尾空格后的内容**不做检查：那是格式偏好，
 *    不属于「内容损坏」，且会与 `md-links` 的误报率问题同类。
 *
 * ## 为什么不做「可读性/排版」类检查
 *
 * 措辞、换行、列表风格这些是**风格**，不是**损坏**。本门禁只抓
 * 「确定是错的」，不抓「不够好」—— 否则又是一条会被绕过的门禁。
 *
 * ## 用法
 *
 * ```sh
 * npm run text:integrity
 * ```
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 要扫描的文件类型。 */
const EXTENSIONS = ['.md', '.mjs', '.js', '.json', '.yml', '.yaml'];

/** 不扫描的目录。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.probe', 'dist', 'build', 'coverage']);

/**
 * 收集要检查的文件。
 *
 * 跳过 `skills/agent-notes/`：那是 vendored 上游副本，手改会被哈希门禁
 * 拦下，而上游可能有它自己的编码习惯。本仓库无权改它的内容，也不该因为
 * 它的内容让门禁变红。
 *
 * @param {string} root 扫描根。
 * @returns {string[]} 相对路径列表。
 */
export function collectFiles(root = PACKAGE_ROOT) {
  const out = [];

  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      const info = statSync(full);
      if (info.isDirectory()) {
        /* vendored 上游内容整体跳过。 */
        if (full === join(root, 'skills', 'agent-notes')) continue;
        walk(full);
        continue;
      }
      if (!EXTENSIONS.some((ext) => name.endsWith(ext))) continue;
      out.push(relative(root, full).split('\\').join('/'));
    }
  };

  walk(root);
  return out.sort();
}

/**
 * 检查一段文本里的字符级问题。
 *
 * @param {string} text 原文。
 * @returns {{ mojibake: number[], controls: number[] }} 问题位置（行号，1 起）。
 */
export function findProblems(text) {
  const mojibake = [];
  const controls = [];

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (let j = 0; j < line.length; j += 1) {
      const code = line.codePointAt(j);
      if (code === 0xfffd) {
        mojibake.push(i + 1);
        continue;
      }
      /* C0 控制字符（0x00–0x1F）除 \t（9）外一律可疑；
         DEL（0x7F）同样。 */
      const isControl = (code < 0x20 && code !== 9) || code === 0x7f;
      if (isControl) controls.push(i + 1);
    }
  }

  return { mojibake, controls };
}

/**
 * 执行检查。
 *
 * @param {string} [root] 扫描根。
 * @returns {{ checked: number, errors: string[] }} 结果。
 */
export function verifyTextIntegrity(root = PACKAGE_ROOT) {
  const files = collectFiles(root);
  const errors = [];

  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    const { mojibake, controls } = findProblems(text);

    if (mojibake.length > 0) {
      errors.push(
        `${file}: 第 ${[...new Set(mojibake)].join(', ')} 行含 U+FFFD 替换字符 —— `
        + '这是字节损坏的痕迹（编辑或工具链在某一步截断了字符）。'
        + 'UTF-8 合法所以编码检查抓不到它，但内容已经坏了。'
      );
    }
    if (controls.length > 0) {
      errors.push(
        `${file}: 第 ${[...new Set(controls)].join(', ')} 行含裸控制字符 —— `
        + '通常是脚本拼接时漏了转义'
      );
    }
  }

  return { checked: files.length, errors };
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

function main() {
  const result = verifyTextIntegrity();
  if (result.errors.length === 0) {
    console.log(`文本完整性通过：${result.checked} 个文件无替换字符与裸控制字符。`);
    process.exit(0);
  }
  console.error(`文本完整性失败：${result.errors.length} 处`);
  for (const error of result.errors) console.error(`  ✖ ${error}`);
  console.error('  U+FFFD 说明有字节在编辑中被截断 —— 找到上下文后手动改回正确字符。');
  process.exit(1);
}

const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replace(/\\/g, '/').endsWith('/tools/text-integrity.mjs');
if (invokedDirectly) main();