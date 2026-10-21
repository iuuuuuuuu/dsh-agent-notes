/**
 * 三件事的共用件：从 Markdown 文本里取出**全部**相对链接 —— 行内式 + 参考式。
 *
 * ## 为什么要有这个共用件
 *
 * 三处都要它，且**口径必须一致**：
 *
 *   1. `tools/md-links.mjs`       —— 检查断链
 *   2. `tools/archive-note.mjs`   —— 归档时改写会断的链接
 *   3. `tools/bilingual-links.mjs`—— 双语互链改写
 *   4. `tools/bilingual-docs.mjs` —— 结构指纹（标题/围栏/表格/链接）
 *
 * ★ 若各处各写一份正则，口径迟早分叉 —— 就会出现「一个放行一个拦下」。
 *   本仓库已经吃过这个亏，而且连吃五次（见下）。
 *
 * ## 为什么用 mdast 而不是正则
 *
 * 手写正则分不清这些（全部实测过）：
 *
 *   - 目标里的成对括号：`[x](docs/a(b).md)` 会被截成 `docs/a(b`；
 *   - 目标后的标题：`[x](y.md "标题")` 会把标题一起吃进去；
 *   - 带标题的参考式定义：`[ref]: y.md "标题"` 整条识别不到；
 *   - 快捷式引用：`[ref]` 无第二个方括号，正则无从判断它是不是链接；
 *   - 代码区边界：未闭合围栏、缩进围栏、围栏内嵌围栏标记。
 *
 * 详见 `.agents/notes/implemented/bug-fix/2026-10-19-i-was-wrong-about-not-needing-mdast.md`
 * 与后续四篇「第 N 处口径分叉」。
 *
 * ## 上游为什么支持参考式
 *
 * `up-translation-links.ts:62` 的类型里显式含 `definition`，
 * `:236-246` 追踪 `linkReference` 并**只处理被引用过的** definition。
 *
 * 而它做的是**自动改写**（`rewriteTranslationLinkLocales`）——
 * 只改行内式、漏了定义行 → **一篇文档改了一半**，比不改更糟。
 * 那正是「自动改写型工具必须覆盖参考式」的理由。
 *
 * ## 偏移契约（调用方依赖它）
 *
 * 本模块返回的 `start` / `end` 是**原文**的 UTF-16 偏移。接线方
 * （归档改写、双语互链改写）靠它做精确替换，所以：
 *
 *   - `maskCode` 必须用**等长**空白替换，不能删字符；
 *   - 调用方必须传**原文**，不要先自己剥离一遍代码区
 *     （双重剥离会让围栏口径再次分叉，实测过）。
 */
import { fromMarkdown } from 'mdast-util-from-markdown';

/** Walk parsed Markdown without treating code examples as links. */
function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function normalizeIdentifier(value) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function skippable(target, includeAbsolute = false) {
  if (!target || target.startsWith('#')) return true;
  return !includeAbsolute && (target.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(target));
}

/** Mask code using UTF-16 offsets, preserving newlines and every source position. */
function maskCode(content, tree, includeInline) {
  const ranges = [];
  walk(tree, (node) => {
    if (node.type === 'code' || (includeInline && (node.type === 'inlineCode' || node.type === 'html'))) {
      ranges.push([node.position.start.offset, node.position.end.offset]);
    }
  });
  let result = content;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
    result = result.slice(0, start) + result.slice(start, end).replace(/[^\r\n]/g, ' ') + result.slice(end);
  }
  return result;
}

/** Compatibility API: blank block-code nodes without changing source offsets. */
export function blankOutFences(content) {
  return maskCode(content, fromMarkdown(content), false);
}

/** Locate the authored destination inside a parser-confirmed link or definition. */
function destination(content, node) {
  const start = node.position.start.offset;
  const end = node.position.end.offset;
  let cursor = start;
  if (node.type === 'definition') {
    while (cursor < end) {
      if (content[cursor] === '\\') { cursor += 2; continue; }
      if (content[cursor] === ']' && content[cursor + 1] === ':') { cursor += 2; break; }
      cursor += 1;
    }
  } else {
    if (content[cursor] === '!') cursor += 1;
    let depth = 0;
    let found = false;
    for (; cursor < end; cursor += 1) {
      const char = content[cursor];
      if (char === '\\') { cursor += 1; continue; }
      if (char === '[') depth += 1;
      if (char === ']') {
        depth -= 1;
        if (depth === 0 && content[cursor + 1] === '(') {
          cursor += 2;
          found = true;
          break;
        }
      }
    }
    // Autolinks have no authored parenthesized destination to rewrite.
    if (!found) return null;
  }
  while (cursor < end && /\s/.test(content[cursor])) cursor += 1;
  const angle = content[cursor] === '<';
  if (angle) cursor += 1;
  const targetStart = cursor;
  let depth = 0;
  for (; cursor < end; cursor += 1) {
    const char = content[cursor];
    if (char === '\\' && cursor + 1 < end) { cursor += 1; continue; }
    if (angle) {
      if (char === '>') break;
    } else {
      if (/\s/.test(char)) break;
      if (char === '(') depth += 1;
      if (char === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
    }
  }
  return { start: targetStart, end: cursor, target: content.slice(targetStart, cursor) };
}

function analyze(content) {
  const tree = fromMarkdown(content);
  const definitions = new Map();
  const used = new Set();
  const inline = [];
  walk(tree, (node) => {
    if (node.type === 'definition') {
      const identifier = normalizeIdentifier(node.identifier);
      const location = destination(content, node);
      if (location && !definitions.has(identifier)) {
        definitions.set(identifier, { kind: 'definition', ...location, identifier });
      }
    } else if (node.type === 'linkReference' || node.type === 'imageReference') {
      used.add(normalizeIdentifier(node.identifier));
    } else if (node.type === 'link' || node.type === 'image') {
      const location = destination(content, node);
      if (location) inline.push({ kind: 'inline', ...location });
    }
  });
  return { tree, definitions, used, inline };
}

/** Collect actual inline destinations and first definitions, including unused definitions. */
export function collectRelativeLinks(content, options = {}) {
  const { definitions, inline } = analyze(content);
  return [...inline, ...definitions.values()]
    .filter((link) => !skippable(link.target, options.includeAbsolute === true))
    .sort((a, b) => a.start - b.start);
}

/** Include full, collapsed and shortcut references; duplicate definitions use the first. */
export function referencedDefinitions(content) {
  const { definitions, used } = analyze(content);
  return new Map([...definitions].filter(([identifier]) => used.has(identifier)));
}

/** Preserve the project's explicit undefined-reference diagnostic outside code examples. */
export function undefinedReferences(content) {
  const { tree, definitions } = analyze(content);
  const scannable = maskCode(content, tree, true);
  const missing = new Map();
  const references = /!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g;
  for (const match of scannable.matchAll(references)) {
    const authored = match[2].trim() || match[1].trim();
    const identifier = normalizeIdentifier(authored);
    if (!definitions.has(identifier)) missing.set(identifier, authored);
  }
  return [...missing.values()];
}

/** Identify only the canonical switcher link near the document's initial H1. */
export function languageSwitcherOffset(content, acceptedTargets) {
  const tree = fromMarkdown(content);
  const children = tree.children;
  const heading = children.findIndex((node) => node.type === 'heading' && node.depth === 1);
  if (heading < 0) return undefined;
  for (const block of children.slice(heading + 1)) {
    if (block.type === 'heading') break;
    if (block.type !== 'paragraph') continue;
    for (const node of block.children ?? []) {
      if (node.type !== 'link' || !acceptedTargets.includes(node.url)) continue;
      const label = (node.children ?? []).map((child) => child.value ?? '').join('');
      if (label !== 'English' && label !== '\u4e2d\u6587') continue;
      return destination(content, node)?.start;
    }
    // A body paragraph cannot grant switcher status to a later paragraph.
    break;
  }
  return undefined;
}
