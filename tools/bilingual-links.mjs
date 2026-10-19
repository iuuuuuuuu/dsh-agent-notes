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
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectRelativeLinks } from './markdown-links.mjs';

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
  /* 本文档不该指向自己 —— 那不是互链。 */
  const counterpart = selfName === pair.primary ? pair.secondary : pair.primary;
  const isPrimary = selfName === pair.primary;
  const switcher = new Set(languageSwitcherTargets(pair));

  /* ★ 语言切换器那行整体跳过：`[English](README.en.md)` 在中文文档里是
     **正确的**（它的作用就是切到另一版），不是「指向错误语言」。
     上游用 skipTargets 表达同一件事。 */
  const switcherLine = content.split('\n')
    .findIndex((l) => [...switcher].some((t) => l.includes(`](${t})`) || l.includes(`](${basename(t)})`)));

  const links = collectRelativeLinks(content);
  const edits = [];
  const details = [];

  for (const link of links) {
    const target = link.target;
    if (target.startsWith('#')) continue;
    /* 只处理「指向我们这一对」的链接 —— 其它链接（仓库内别的文件）
       没有语言概念，不该被改。 */
    const bare = target.split('#')[0].split('?')[0];
    const name = basename(bare);

    /* 语言切换器：那一行整体不动。 */
    const line = content.slice(0, link.start).split('\n').length - 1;
    if (line === switcherLine) continue;

    if (name !== basename(pair.primary) && name !== basename(pair.secondary)) continue;

    const shouldBe = isPrimary ? pair.primary : pair.secondary;
    if (name === shouldBe) continue;              /* 已经对了 */

    const rewritten = bare.replace(name, shouldBe)
      + target.slice(bare.length);
    edits.push({ start: link.start, end: link.end, value: rewritten });
    details.push(`${target} → ${rewritten}`);
  }

  if (edits.length === 0) return { content, rewritten: 0, details };

  /* 从后往前替换。 */
  let out = content;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.value + out.slice(e.end);
  }
  void counterpart;
  return { content: out, rewritten: edits.length, details };
}

/**
 * 扫描所有双语对，把指错语言的链接**改回来**。
 *
 * @param {string} [root] 仓库根。
 * @returns {{ pairs: number, rewritten: number, changed: string[], details: string[] }}
 *   `changed` 是被写了盘的文件；`details` 是逐条说明。
 */
export function fixTranslationLinkLocales(root = PACKAGE_ROOT) {
  let rewritten = 0;
  const changed = [];
  const details = [];

  for (const pair of PAIRS) {
    for (const name of [pair.primary, pair.secondary]) {
      const full = join(root, name);
      if (!existsSync(full)) continue;
      const before = readFileSync(full, 'utf8');
      const result = rewriteTranslationLinkLocales(before, pair, name);
      if (result.rewritten === 0) continue;
      writeFileSync(full, result.content, 'utf8');
      rewritten += result.rewritten;
      changed.push(name);
      for (const d of result.details) details.push(`${name}: ${d}`);
    }
  }

  return { pairs: PAIRS.length, rewritten, changed, details };
}
/* ── CLI 入口 ──────────────────────────────────────────────────── */

/**
 * 把双语文档之间「指错语言」的互链改回来。
 *
 * 当前仓库零改动 —— 互链本来是对的。它是防御性完备，不是修现存缺陷。
 *
 * @returns {number} 退出码。
 */
export function main() {
  const fix = fixTranslationLinkLocales();
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