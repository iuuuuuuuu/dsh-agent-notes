/**
 * 双语互链自动改写 —— 对齐上游 `rewriteTranslationLinkLocales`。
 *
 * ## 上游做什么
 *
 * `up-translation-links.ts:296-308` 把「文档链接指向了错误语言版本」的情况
 * **自动改回来**。例如 `README.zh.md` 里有个链接该指 `README.md`，
 * 却写成了 `README.en.md` —— 工具改回。
 *
 * ## 为什么它必须支持参考式（理由与我们前两件相同）
 *
 * 它是**自动改写型**工具。只改行内式、漏了定义行 → **改一半**，
 * 比不改更糟。
 *
 * ## 我们的场景有多小（必须诚实说明）
 *
 * 本仓库只有一对文档（`README.md` / `README.en.md`），且互链当前是**对的**：
 *
 *     README.md:3     [English](README.en.md) | **中文**
 *     README.en.md:3  **English** | [中文](README.md)
 *
 * 而上游 `translation-pairing.ts:305-307` 的 `languageSwitcherTargets` 把
 * 这两行**列为 skipTargets** —— 它的自动改写**不管语言切换器**。
 *
 * ★ 所以严格说：**上游那套机制对我们当前没有可改的东西。**
 *   那它针对什么？多语言仓库（`README.md` / `README.zh.md` / `README.ja.md` …）
 *   里正文中的文档互链 —— 那种场景本仓库还没有。
 *
 * ## 那本轮做的是什么
 *
 * 做的是**同一机制的最小可用形态**：检查文档内**指向自己这一对**的链接，
 * 语言不对就改。同时保留 skipTargets —— 语言切换器那两行不动。
 *
 * ★ 这是**防御性完备**，不是修现存缺陷。当前零错误可改。
 *   记在笔记里，免得日后误以为「以前会报错、现在修好了」。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectRelativeLinks, referencedDefinitions, languageSwitcherOffset } from './markdown-links.mjs';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 一对双语文档。
 *
 * @typedef {object} Pair
 * @property {string} key 标识。
 * @property {string} primary 主语言（中文）。
 * @property {string} secondary 次语言（英文）。
 */

/** @type {Pair[]} */
export const PAIRS = [
  { key: 'README', primary: 'README.md', secondary: 'README.en.md' }
];

/** 语言切换器那两行**不许自动改** —— 与上游 `languageSwitcherTargets` 同口径。 */
export function languageSwitcherTargets(pair) {
  return [basename(pair.primary), basename(pair.secondary)];
}

/**
 * 把「双语文档之间的互链」指向正确语言。
 *
 * @param {string} content 文档原文。
 * @param {Pair} pair 该文档所属的对。
 * @param {string} selfName 当前文档自己的文件名。
 * @returns {{ content: string, rewritten: number, details: string[] }} 改写结果。
 */
export function rewriteTranslationLinkLocales(content, pair, selfName) {
  const source = resolve(PACKAGE_ROOT, selfName);
  const primary = resolve(PACKAGE_ROOT, pair.primary);
  const secondary = resolve(PACKAGE_ROOT, pair.secondary);
  if (source !== primary && source !== secondary) throw new Error("Document is not a translation pair member: " + selfName);
  const expected = source === primary ? primary : secondary;
  const portable = (path) => path.split(String.fromCharCode(92)).join("/");
  const accepted = [primary, secondary].map((path) => portable(relative(dirname(source), path)));
  const switcherOffset = languageSwitcherOffset(content, accepted);
  const used = referencedDefinitions(content);
  const edits = [];
  const details = [];
  for (const link of collectRelativeLinks(content)) {
    if (link.start === switcherOffset) continue;
    if (link.kind === "definition" && !used.has(String(link.identifier).toLowerCase())) continue;
    const target = link.target;
    const suffixAt = target.search(/[?#]/);
    const bare = suffixAt < 0 ? target : target.slice(0, suffixAt);
    const suffix = suffixAt < 0 ? "" : target.slice(suffixAt);
    let decoded;
    try { decoded = decodeURIComponent(bare); } catch { continue; }
    const resolved = resolve(dirname(source), decoded);
    if (resolved !== primary && resolved !== secondary) continue;
    if (resolved === expected) continue;
    const destination = portable(relative(dirname(source), expected));
    const rewritten = destination.split("/").map(encodeURIComponent).join("/") + suffix;
    edits.push({ start: link.start, end: link.end, value: rewritten });
    details.push(target + " → " + rewritten);
  }
  let out = content;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.value + out.slice(edit.end);
  }
  return { content: out, rewritten: edits.length, details };
}

/**
 * 扫描所有双语对，找出「指错语言」的互链 —— **只读，一个字节都不写**。
 *
 * @param {string} [root] 仓库根。
 * @returns {{ pairs: number, violations: number, missing: string[], findings: Array<{name: string, full: string, before: string, after: string, details: string[]}> }}
 *   结果。
 */
export function scanTranslationLinkLocales(root = PACKAGE_ROOT) {
  const findings = [];
  const missing = [];
  let violations = 0;

  for (const pair of PAIRS) {
    for (const name of [pair.primary, pair.secondary]) {
      const full = join(root, name);
      /* ★ 缺失必须单独记下来，不能只是 `continue` ——
         空集合上「没有指错语言的链」是个恒真命题，那样子门禁会在一对文件
         少了一个时照样报绿。本仓库反复栽在「空集合恒绿」上（vendored 三脚本
         在空树上 exit 0），所以这里主动把它变成失败。 */
      if (!existsSync(full)) { missing.push(name); continue; }
      const before = readFileSync(full, 'utf8');
      const result = rewriteTranslationLinkLocales(before, pair, name);
      if (result.rewritten === 0) continue;
      violations += result.rewritten;
      findings.push({ name, full, before, after: result.content, details: result.details });
    }
  }

  return { pairs: PAIRS.length, violations, missing, findings };
}

/**
 * 只查不改 —— 门禁走的是这条。
 *
 * ★ 为什么必须与「改写」分开：原来只有「改写」一个入口，它接在 check 链里
 *   且**没有任何参数**，于是每次跑门禁都会写盘。后果是实测出来的 ——
 *   只要工作区原本就是脏的，随后 `verify.yml` 里那条
 *   `git status --porcelain` 断言就会红，而报错写的是「某个门禁在仓库里
 *   留下了改动」，指向的却是**别人的**未提交改动，排查方向完全错。
 *
 *   门禁的职责是**判断**，写盘是**修**。两者不能是同一个按钮。
 *
 * @param {string} [root] 仓库根。
 * @returns {{ pairs: number, violations: number, missing: string[], findings: Array<{name: string, details: string[]}> }} 结果。
 */
export function checkTranslationLinkLocales(root = PACKAGE_ROOT) {
  const scanned = scanTranslationLinkLocales(root);
  return {
    pairs: scanned.pairs,
    violations: scanned.violations,
    missing: scanned.missing,
    findings: scanned.findings.map(({ name, details }) => ({ name, details }))
  };
}

/**
 * 扫描所有双语对，把指错语言的链接**改回来**（会写盘）。
 *
 * @param {string} [root] 仓库根。
 * @returns {{ pairs: number, rewritten: number, changed: string[], details: string[] }}
 *   `changed` 是被写了盘的文件；`details` 是逐条说明。
 */
export function fixTranslationLinkLocales(root = PACKAGE_ROOT) {
  const scanned = scanTranslationLinkLocales(root);
  const changed = [];
  const details = [];

  for (const finding of scanned.findings) {
    writeFileSync(finding.full, finding.after, 'utf8');
    changed.push(finding.name);
    for (const d of finding.details) details.push(`${finding.name}: ${d}`);
  }

  return { pairs: scanned.pairs, rewritten: scanned.violations, changed, details };
}
/* ── CLI 入口 ──────────────────────────────────────────────────── */

/**
 * 双语互链：查（`--check`，不写盘）或修（默认，写盘）。
 *
 * 当前仓库两种路径都会报「无可做」—— 互链本来是对的。它是防御性完备，
 * 不是修现存缺陷。
 *
 * @param {string[]} [argv] 命令行参数。
 * @param {string} [root] 仓库根（测试用它指向临时目录）。
 * @returns {number} 退出码。
 */
export function main(argv = process.argv.slice(2), root = PACKAGE_ROOT) {
  if (argv.includes('--check')) {
    const check = checkTranslationLinkLocales(root);
    if (check.missing.length > 0) {
      console.error(`✖ 双语文档缺失：${check.missing.join(', ')}`);
      console.error('  一对文件少了一个，互链检查就成了恒真命题 —— 必须两边都在。');
      return 1;
    }
    if (check.violations === 0) {
      console.log(`双语互链正确：${check.pairs} 对文档里没有指错语言的链。`);
      return 0;
    }
    console.error(`✖ 双语互链指错语言：${check.violations} 条`);
    for (const finding of check.findings) {
      for (const d of finding.details) console.error(`  ${finding.name}: ${d}`);
    }
    console.error('  修法：npm run docs:fix-links（不带 --check 时才写盘）');
    return 1;
  }

  const fix = fixTranslationLinkLocales(root);
  if (fix.rewritten === 0) {
    console.log(`双语互链正确：${fix.pairs} 对文档无需改动。`);
    return 0;
  }
  console.log(`已改写 ${fix.rewritten} 条指错语言的互链：`);
  for (const d of fix.details) console.log('  ' + d);
  console.log(`已写盘: ${fix.changed.join(', ')}`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replace(/\\/g, '/').endsWith('/tools/bilingual-links.mjs');

if (invokedDirectly) process.exit(main());