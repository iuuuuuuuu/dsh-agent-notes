/**
 * 三件事的共用件：从 Markdown 文本里取出**全部**相对链接 —— 行内式 + 参考式。
 *
 * ## 为什么要有这个共用件
 *
 * 三处都要它，且**口径必须一致**：
 *
 *   1. `tools/md-links.mjs`      —— 检查断链
 *   2. `tools/archive-note.mjs`  —— 归档时改写会断的链接
 *   3. `tools/bilingual-docs.mjs`—— 双语互链改写（本轮新增）
 *
 * ★ 若三处各写一份正则，口径迟早分叉 —— 就会出现「一个放行一个拦下」。
 *   本仓库已经吃过这个亏：`archive-note` 与 `md-links` 的围栏口径分叉过一次。
 *
 * ## 两种写法
 *
 * 行内式（本仓库 137 处）：
 *
 *     [文字](../bug-fix/x.md)
 *
 * 参考式（本仓库 0 处，但上游支持）：
 *
 *     [文字][ref]
 *
 *     [ref]: ../bug-fix/x.md
 *
 * ## 上游为什么支持参考式（读了它的源码之后才明白）
 *
 * `up-translation-links.ts:62` 的类型里显式含 `definition`，
 * `:236-246` 追踪 `linkReference` 并**只处理被引用过的** definition。
 *
 * 而它做的是**自动改写**（`rewriteTranslationLinkLocales`）——
 * 只改行内式、漏了定义行 → **一篇文档改了一半**，比不改更糟。
 *
 * 那正是「自动改写」型工具必须覆盖参考式的理由。
 * 本仓库 `archive-note.mjs` 也是自动改写型，所以同一理由成立。
 */

/**
 * 一条相对链接的位置与目标。
 *
 * @typedef {object} RelativeLink
 * @property {'inline' | 'definition'} kind 行内式还是参考式定义行。
 * @property {number} start 目标文本在**原文**中的起始偏移。
 * @property {number} end 目标文本在原文中的结束偏移。
 * @property {string} target 目标文本（未解析）。
 * @property {string} [identifier] 参考式的标识符（`[ref]` 里的 `ref`）。
 */

/**
 * 跳过的目标形态 —— 与仓库里既有的两处保持同一口径。
 *
 * @param {string} target 链接目标。
 * @param {boolean} [includeAbsolute] 为真时**保留**绝对 URL 与协议相对地址。
 * @returns {boolean} 是否跳过。
 */
function skippable(target, includeAbsolute = false) {
  if (target === '') return true;
  /* 纯锚点永远跳过：它不指向「哪个文件」，跨语言必然不同（`#安装` vs `#install`），
     比它只会产出误报。这一条与 includeAbsolute 无关。 */
  if (target.startsWith('#')) return true;
  if (includeAbsolute) return false;
  if (target.startsWith('//')) return true;                /* 协议相对 */
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return true;     /* 绝对 URL / mailto */
  return false;
}

/**
 * 把围栏代码块**挖掉**，用等长空行替换，从而**保留全部偏移**。
 *
 * 为什么必须保留偏移：本模块返回的 `start` / `end` 是原文位置，
 * 接线方（归档改写、双语互链改写）靠它做精确替换。挖掉会移位。
 *
 * @param {string} content 原文。
 * @returns {string} 等长字符串，围栏块内全为空行。
 */
export function blankOutFences(content) {
  const lines = content.split('\n');
  const out = [];
  let inFence = false;
  let mark = '';
  for (const line of lines) {
    const m = /^\s*(```|~~~)/.exec(line);
    if (m !== null) {
      if (!inFence) { inFence = true; mark = m[1]; }
      else if (m[1] === mark) { inFence = false; }
        /* ★ 用等长空白，不是空串 —— 围栏内那些行可能有中文，
         换成空串会丢掉字节（汉字 UTF-8 占 3 字节），偏移随之全错。
         实测踩过：中文文档 71 字节 → 42 字节，于是替换落在错误位置，
         围栏里的示例反而被改了。
         ★ 同一段 ASCII 输入不会有这个问题 —— **只用 ASCII fixture
         验含中文的实现必然漏**。 */
      out.push(' '.repeat(line.length));
      continue;
    }
    out.push(inFence ? ' '.repeat(line.length) : line);
  }
  return out.join('\n');
}

/**
 * 收集一段 Markdown 里的全部相对链接（行内式 + 参考式）。
 *
 * ★ 只扫**围栏代码块之外** —— 笔记里贴示例 Markdown 完全合法，
 *   里面的 `[x](y)` 不是真链接。口径与 `tools/md-links.mjs` 一致。
 *
 * @param {string} content Markdown 原文。
 * @param {{ includeAbsolute?: boolean }} [options] `includeAbsolute` 为真时
 *   连绝对 URL / 协议相对地址一起返回（双语结构签名要用；查断链不要）。
 * @returns {RelativeLink[]} 相对链接列表，按在原文中的顺序。
 */
export function collectRelativeLinks(content, options = {}) {
  const includeAbsolute = options.includeAbsolute === true;
  const found = [];
  const consumedRefs = new Set();

  /* ★ 围栏必须挖掉 —— 笔记里贴示例 Markdown 完全合法，里面的链接不是真的。
     实测踩过：JSDoc 声称「只扫围栏之外」而实现没做，于是围栏内的示例链接
     被当成真链接收了进去。（本仓库第四次栽在「注释承诺 ≠ 实现做到」。） */
  const scannable = blankOutFences(content);

  /* ---- 行内式：`[文字](目标)` 与 `![alt](目标)` ---- */
  const inlineRe = /(!?\[[^\]]*\]\(\s*)(<?)([^)\s>]+)(>?)(\s*(?:"[^"]*")?\s*\))/g;
  let m;
  while ((m = inlineRe.exec(scannable)) !== null) {
    const target = m[3];
    if (skippable(target, includeAbsolute)) continue;
    const start = m.index + m[1].length + m[2].length;
    found.push({ kind: 'inline', start, end: start + target.length, target });
  }

  /* ---- 参考式的引用侧：`[文字][ref]` / `[ref][]` / 快捷式 `[ref]` ---- */
  const refRe = /(!?\[[^\]]*\])\[([^\]]*)\]/g;
  while ((m = refRe.exec(scannable)) !== null) {
    const id = m[2].trim() !== '' ? m[2].trim() : m[1].slice(1, -1).trim();
    if (id !== '') consumedRefs.add(id.toLowerCase());
  }
  /* 快捷式 `[ref]`（无第二个方括号）—— 仅在文档**没有**任何定义行时才有意义，
     ★ 那正是本仓库反复吃亏的那类错误：**注释承诺了一个行为，实现没做**。
     上游用 mdast 的 linkReference 节点天然覆盖，本仓库不引依赖，所以不实现。 */

  /* ---- 参考式的定义侧：`[ref]: 目标` ---- */
  const defRe = /^[ \t]{0,3}\[([^\]]+)\]:[ \t]*(?:<([^>\n]*)>|(\S+))[ \t]*$/gm;
  while ((m = defRe.exec(scannable)) !== null) {
    const identifier = m[1];
    const target = m[2] !== undefined ? m[2] : m[3];
    if (skippable(target, includeAbsolute)) continue;
    const offset = target === m[2] ? m.index + m[0].indexOf('<') + 1
      : m.index + m[0].lastIndexOf(target);
    found.push({
      kind: 'definition',
      start: offset,
      end: offset + target.length,
      target,
      identifier
    });
    void consumedRefs;
  }

  found.sort((a, b) => a.start - b.start);
  return found;
}

/**
 * 给出每个**被引用过**的参考式标识符对应的定义位置。
 *
 * 上游 `up-translation-links.ts:236-246` 只处理被引用过的 definition ——
 * 未被引用的定义不是链接，跳过它是正确的（否则孤立定义会变成假漂移）。
 *
 * @param {string} content Markdown 原文。
 * @returns {Map<string, RelativeLink>} 标识符（小写）→ 定义。
 */
export function referencedDefinitions(content) {
  const scannable = blankOutFences(content);
  const used = new Set();
  const refRe = /(!?\[[^\]]*\])\[([^\]]*)\]/g;
  let m;
  while ((m = refRe.exec(scannable)) !== null) {
    const id = m[2].trim() !== '' ? m[2].trim() : m[1].slice(1, -1).trim();
    if (id !== '') used.add(id.toLowerCase());
  }

  const map = new Map();
  const defRe = /^[ \t]{0,3}\[([^\]]+)\]:[ \t]*(?:<([^>\n]*)>|(\S+))[ \t]*$/gm;
  while ((m = defRe.exec(scannable)) !== null) {
    const identifier = m[1].toLowerCase();
    /* ★ 只收被引用过的 —— 与上游同一口径。 */
    if (!used.has(identifier) || map.has(identifier)) continue;
    const target = m[2] !== undefined ? m[2] : m[3];
    const offset = target === m[2] ? m.index + m[0].indexOf('<') + 1
      : m.index + m[0].lastIndexOf(target);
    map.set(identifier, {
      kind: 'definition', start: offset, end: offset + target.length, target,
      identifier: m[1]
    });
  }
  return map;
}

/**
 * 找出**未定义**的参考式引用 —— 那是坏引用，md-links 该报。
 *
 * @param {string} content Markdown 原文。
 * @returns {string[]} 未定义的标识符。
 */
export function undefinedReferences(content) {
  const scannable = blankOutFences(content);
  const used = new Map();
  const refRe = /(!?\[[^\]]*\])\[([^\]]*)\]/g;
  let m;
  while ((m = refRe.exec(scannable)) !== null) {
    const id = m[2].trim() !== '' ? m[2].trim() : m[1].slice(1, -1).trim();
    if (id !== '') used.set(id.toLowerCase(), id);
  }
  const defined = new Set();
  const defRe = /^[ \t]{0,3}\[([^\]]+)\]:/gm;
  while ((m = defRe.exec(scannable)) !== null) defined.add(m[1].toLowerCase());

  const missing = [];
  for (const [lower, original] of used) {
    if (!defined.has(lower) && !missing.includes(original)) missing.push(original);
  }
  return missing;
}