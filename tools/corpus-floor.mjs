#!/usr/bin/env node
/**
 * 语料下限门禁：每道门禁的语料都不得被「悄悄收窄」。
 *
 * ## 为什么需要
 *
 * 门禁判定的是**语料**。语料被收窄时，门禁不会红 —— 它只是变得没那么
 * 有效了，而报告上写着「通过」。
 *
 * 实测过的失效形态（每一条都真实发生过或可复现）：
 *
 * 1. `md-links.mjs` 里删掉 `walk('docs')` → `docs/` 整个不在语料里，
 *    而那 2 篇文档正是全仓唯一承载 46 道判定表的产物。门禁照样绿。
 * 2. `text-integrity.mjs` 的递归改成只看顶层 → 97 篇笔记全部脱离扫描，
 *    门禁照样绿。
 * 3. `doc-refs.mjs` 的扫描目录从 4 个缩成 1 个 → 源码侧引用大半消失，
 *    门禁照样绿。
 *
 * 上游 A 对这件事有明确判据，`scripts/verify-concrete-terms.ts:56-61`：
 *
 * ```ts
 * if (!files.includes('AGENTS.md')
 *     || !files.some((f) => f.startsWith('packages/'))
 *     || !files.some((f) => f.startsWith('docs/'))
 *     || !files.some((f) => f.startsWith('vendor/'))
 *     || !files.some((f) => f.startsWith('.agents/notes/archived/'))) {
 *   throw new Error('verify-concrete-terms: tracked-file discovery omitted a required repository area');
 * }
 * ```
 *
 * 它的关键点不是「数字要够大」，而是**按仓库区域对账**：语料必须仍然
 * 覆盖每一个该覆盖的区域。数字会随仓库长大而失效，区域不会。
 *
 * 所以本门禁做两层判据：
 *
 * - **区域覆盖**（主判据，抄上游形态）：每道门禁的语料必须仍然包含它
 *   应当覆盖的每一个仓库区域。删掉 `walk('docs')` 立刻红。
 * - **数量下限**（辅判据，抄上游 `verify-client-ui-i18n.ts:341-343` 的
 *   `MINIMUM_CLIENT_UI_SOURCES` 形态）：语料条数不得低于记录在
 *   `tools/corpus-floor.manifest.json` 里的下限。下限只会因「有意改动」
 *   而调整，且每次调整都要在 manifest 里写理由 —— 数字被悄悄调小会红。
 *
 * ## 为什么分成「区域」而不是只比数字
 *
 * 只比数字会漏掉一种收窄：把 `docs/` 的 2 篇删掉、再从别的目录补 2 篇，
 * 数量不变但覆盖面变了。区域对账抓得住这个 —— 因为 `docs` 是一个区域，
 * 它的条目数会掉到 0。
 *
 * 两条判据合起来才够：**区域**保证「该看的地方还在看」，**数量**保证
 * 「看得够多」。
 *
 * ## 区域是怎么划的
 *
 * 用**目录前缀**划，不用后缀白名单。理由：`tools/`、`lib/`、`docs/`、
 * `.agents/notes/` 这些是仓库的结构事实；后缀白名单会随新增目录而
 * 悄悄失效（实测 `text-integrity` 的后缀白名单就漏掉了 4 个无扩展名
 * 的文本文件：`.gitignore`、`.gitattributes`、`LICENSE`、
 * `.githooks/commit-msg`）。
 *
 * @see .agents/notes/implemented/process/2026-10-22-gate-corpus-must-not-narrow.md
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectDocuments } from './md-links.mjs';
import { collectDocRefDocuments, collectSourceScanFiles } from './doc-refs.mjs';
import { collectFiles } from './text-integrity.mjs';
import { listTrackedFiles } from './eol.mjs';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 数量下限清单（外部 JSON，可被有意调整）。 */
const MANIFEST_PATH = join(PACKAGE_ROOT, 'tools', 'corpus-floor.manifest.json');

/**
 * 仓库区域划分。
 *
 * 顺序有意义：**先匹配到的先算**。`.agents/notes/archived/` 必须在
 * `.agents/notes/` 之前，否则归档笔记会被算进「笔记」区。
 *
 * @param {string} rel 仓库相对路径（正斜杠）。
 * @returns {string} 区域名。
 */
export function areaOf(rel) {
  if (rel.startsWith('.agents/notes/archived/')) return 'archived-notes';
  if (rel.startsWith('skills/agent-notes/')) return 'vendored';
  if (rel.startsWith('.agents/notes/')) return 'notes';
  if (rel.startsWith('docs/')) return 'docs';
  if (rel.startsWith('lib/')) return 'lib';
  if (rel.startsWith('src/')) return 'src';
  if (rel.startsWith('tools/')) return 'tools';
  if (rel.startsWith('.github/workflows/')) return 'workflows';
  if (rel.startsWith('.githooks/')) return 'githooks';
  if (rel.includes('/')) return 'other-dir';
  return 'root';
}

/**
 * 每道门禁的语料来源与它必须覆盖的区域。
 *
 * `collect` 必须是**真的那个门禁在用的收集函数** —— 不是「重新实现一遍」。
 * 重新实现就等于测了一份副本，真实的收窄照样发生而门禁不红。
 *
 * @type {Array<{gate: string, label: string, collect: (root: string) => string[], areas: string[]}>}
 */
export const GATES = [
  {
    gate: 'md-links',
    label: 'Markdown 相对链接',
    collect: (root) => collectDocuments(root),
    /* 顶层文档、笔记树、docs/ 三块缺一不可。 */
    areas: ['root', 'notes', 'docs']
  },
  {
    gate: 'doc-refs-doc',
    label: '行内 文件:行号 引用（文档侧）',
    collect: (root) => collectDocRefDocuments(root),
    areas: ['notes', 'docs']
  },
  {
    gate: 'doc-refs-source',
    label: '行内 文件:行号 引用（源码侧）',
    collect: (root) => collectSourceScanFiles(root),
    areas: ['tools', 'lib', 'src', 'workflows']
  },
  {
    gate: 'text-integrity',
    label: '文本完整性（U+FFFD）',
    collect: (root) => collectFiles(root),
    /* 注意 `vendored` 不在清单里：text-integrity 刻意跳过 vendored
       （本仓库无权改它），所以要求它覆盖 vendored 会与设计矛盾。 */
    areas: ['root', 'notes', 'docs', 'lib', 'src', 'tools', 'workflows']
  },
  {
    gate: 'eol',
    label: '结尾换行',
    collect: (root) => listTrackedFiles(root).files,
    /* 结尾换行判的是**入库内容**，所以语料是全部 tracked 文件 ——
       含 `.githooks/`、`.gitignore`、`LICENSE` 这些无扩展名文本。 */
    areas: ['root', 'notes', 'docs', 'lib', 'src', 'tools', 'workflows', 'githooks']
  }
];

/**
 * 读数量下限清单。
 *
 * @param {string} [path] 清单路径（测试用）。
 * @returns {Record<string, {min: number, reason: string}>} 下限表。
 */
export function loadManifest(path = MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * 执行语料下限检查。
 *
 * @param {{ root?: string, manifest?: Record<string, {min: number, reason: string}> }} [options]
 *   可选仓库根与下限表（测试用）。
 * @returns {{ errors: string[], checked: number }} 结果。
 */
export function checkCorpusFloor(options = {}) {
  const root = options.root ?? PACKAGE_ROOT;
  const manifest = options.manifest ?? loadManifest();
  const errors = [];
  let checked = 0;

  for (const spec of GATES) {
    const files = spec.collect(root);
    checked += 1;

    if (files.length === 0) {
      errors.push(`${spec.gate}（${spec.label}）：语料为空 —— 没有任何东西可验`);
      continue;
    }

    /* 区域覆盖（主判据）。 */
    const present = new Set(files.map(areaOf));
    for (const area of spec.areas) {
      if (!present.has(area)) {
        errors.push(
          `${spec.gate}（${spec.label}）：语料不再覆盖 \`${area}/\` 区域 —— `
          + '语料被收窄，这道门禁已经变得没那么有效，而报告上仍写着「通过」'
        );
      }
    }

    /* 数量下限（辅判据）。 */
    const floor = manifest[spec.gate];
    if (floor === undefined) {
      errors.push(`${spec.gate}（${spec.label}）：清单里没有这条门禁的数量下限 —— 请补上并写明理由`);
      continue;
    }
    if (typeof floor.min !== 'number' || !Number.isInteger(floor.min) || floor.min <= 0) {
      errors.push(`${spec.gate}（${spec.label}）：下限必须是一个正整数，实际 ${JSON.stringify(floor.min)}`);
      continue;
    }
    if (typeof floor.reason !== 'string' || floor.reason.trim() === '') {
      errors.push(`${spec.gate}（${spec.label}）：下限没有写理由 —— 没有理由的下限会被悄悄调小`);
      continue;
    }
    if (files.length < floor.min) {
      errors.push(
        `${spec.gate}（${spec.label}）：语料 ${files.length} 条，低于下限 ${floor.min} —— `
        + `语料被收窄了。理由：${floor.reason}`
      );
    }
  }

  return { errors, checked };
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

function main(argv = process.argv.slice(2)) {
  /* `--root` 让这道门禁能在别的目录上跑（测试夹具、以及「检查另一个
     clone」的场景）。缺省是包根。 */
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? undefined : argv[rootIndex + 1];
  const result = checkCorpusFloor(root === undefined ? {} : { root });
  if (result.errors.length === 0) {
    console.log(
      `语料下限通过：${result.checked} 道门禁的语料都仍覆盖各自应有的区域，且不低于记录的下限。`
    );
    process.exit(0);
  }
  console.error(`语料下限校验失败：${result.errors.length} 处`);
  for (const error of result.errors) console.error(`  ✖ ${error}`);
  console.error('  语料被收窄的门禁不会自己变红 —— 这道门禁就是替它们说话的地方。');
  process.exit(1);
}

const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replace(/\\/g, '/').endsWith('/tools/corpus-floor.mjs');
if (invokedDirectly) main();
