/**
 * vendored 门禁脚本的**执行期补丁**。
 *
 * ## 为什么不直接改 `skills/agent-notes/` 里的文件
 *
 * 那是上游副本，`tools/verify-plugin.mjs` 会用哈希比对拦手改（AGENTS.md 硬约束 3）。
 * 但上游的格式门禁有个**会把合法笔记判红**的缺陷，而它已经在一个真实项目里
 * 造成了实际损失（sourin-flutter-spike，2026-10-22）—— 详见
 * `.agents/notes/implemented/bug-fix/2026-10-24-format-gate-masks-inline-code-as-comment.md`。
 *
 * 所以补丁落在**执行期的临时副本**上：磁盘上的 vendored 字节不变（哈希门禁照旧通过），
 * 真正被 Node 执行的是一份修正过的副本。
 *
 * ## 纪律
 *
 * - **锚点必须精确匹配**。上游改了这段代码 ⇒ 补丁打不上 ⇒ `missed` 非空 ⇒
 *   调用方必须**大声告警**（不是静默降级）。静默降级的后果是：缺陷回来了，
 *   而人以为它还修着。
 * - 补丁只碰「注释蒙版」这一段状态机，不动任何判据（缺哪些小节、禁哪些标题）。
 *   判据仍只有上游那一处真相。
 *
 * ## 为什么用单引号数组拼源码，而不是模板字符串
 *
 * 补丁里的代码本身含**反引号**（行内代码围栏）与 **HTML 注释字面量**。
 * 放进模板字符串会与反引号打架（一次实测：模板被提前闭合，剩下的代码里出现
 * 裸 HTML 注释开头，Node 直接报 `HTML comments are not allowed in modules`）。
 * 用 `'…'` 逐行拼接则完全不用转义这两样。
 */

/** 行内代码遮蔽的两个辅助函数（多行源码，逐行拼接以免转义地狱）。 */
const INLINE_CODE_HELPERS = [
  '/**',
  ' * 判断某个位置的反引号是否被反斜杠转义。',
  ' *',
  ' * @param {string} line 行文本。',
  ' * @param {number} index 反引号位置。',
  ' * @returns {boolean} 是否被转义（前面有奇数个反斜杠）。',
  ' */',
  'function isEscaped(line: string, index: number): boolean {',
  '  let backslashes = 0;',
  '  let i = index - 1;',
  '  while (i >= 0 && line[i] === "\\\\") { backslashes += 1; i -= 1; }',
  '  return backslashes % 2 === 1;',
  '}',
  '',
  '/**',
  ' * 把行内代码抹成**等长空格**，保留其余字符的位置。',
  ' *',
  ' * 为什么必须等长：后面要用 indexOf 比较 HTML 注释开头与结尾的先后关系，',
  ' * 长度一变，同一行的相对顺序判断就可能翻车。',
  ' *',
  ' * 未闭合的反引号按字面处理（与 Markdown 一致），不吞掉本行其余内容；',
  ' * 被转义的反引号也不当作围栏开始。',
  ' *',
  ' * @param {string} line 单行文本。',
  ' * @returns {string} 等长的遮蔽结果。',
  ' */',
  'function blankInlineCode(line: string): string {',
  '  let out = "";',
  '  let i = 0;',
  '  while (i < line.length) {',
  '    if (line[i] !== "`") { out += line[i]; i += 1; continue; }',
  '    if (isEscaped(line, i)) { out += "`"; i += 1; continue; }',
  '    let ticks = 0;',
  '    while (line[i + ticks] === "`") ticks += 1;',
  '    const fence = "`".repeat(ticks);',
  '    let close = -1;',
  '    let probe = i + ticks;',
  '    while (probe < line.length) {',
  '      const at = line.indexOf(fence, probe);',
  '      if (at === -1) break;',
  '      if (!isEscaped(line, at)) { close = at; break; }',
  '      probe = at + ticks;',
  '    }',
  '    if (close === -1) { out += line.slice(i, i + ticks); i += ticks; continue; }',
  '    out += " ".repeat(close + ticks - i);',
  '    i = close + ticks;',
  '  }',
  '  return out;',
  '}',
  ''
].join('\n');

/** 上游「找注释边界」那三行（锚点必须与 vendored 文件逐字一致）。 */
const MASK_ANCHOR = [
  '    if (inFence) continue;',
  '    const openIdx = inComment ? -1 : l.indexOf("<!--");',
  '    const closeIdx = l.indexOf("-->");'
].join('\n');

/** 修正后的同一段。 */
const MASK_REPLACEMENT = [
  '    if (inFence) continue;',
  '    // 行内代码里的注释标记是展示语法，不该改变状态机。',
  '    const scan = blankInlineCode(l);',
  '    const openIdx = inComment ? -1 : scan.indexOf("<!--");',
  '    // 已经在注释里时反引号没有 Markdown 语义：必须用原始行找结尾标记，',
  '    // 否则恰好写在行内代码里的结尾标记会被抹掉，注释一路吃到文末。',
  '    const closeIdx = (inComment ? l : scan).indexOf("-->");'
].join('\n');

/** 辅助函数的插入锚点：`maskSource` 定义之前。 */
const HELPERS_ANCHOR = 'function maskSource(raw: string): MaskedSource {';

/**
 * 给 `verify-agent-note-format.ts` 打「行内代码不参与注释状态机」补丁。
 *
 * @param {string} source 原始脚本源码。
 * @returns {{ code: string, applied: string[], missed: string[] }} 补丁结果。
 */
function patchFormatMasking(source) {
  const applied = [];
  const missed = [];
  let code = source;

  if (code.includes(HELPERS_ANCHOR)) {
    code = code.replace(HELPERS_ANCHOR, `${INLINE_CODE_HELPERS}\n${HELPERS_ANCHOR}`);
    applied.push('inline-code helpers');
  } else {
    missed.push('helpers anchor (maskSource definition)');
  }

  if (code.includes(MASK_ANCHOR)) {
    code = code.replace(MASK_ANCHOR, MASK_REPLACEMENT);
    applied.push('comment mask state machine');
  } else {
    missed.push('mask anchor (openIdx/closeIdx)');
  }

  return { code, applied, missed };
}

/**
 * 需要打补丁的脚本：文件名 → 补丁函数。
 *
 * **只放「执行期必须修正」的那些**。能用解释说明解决的不要写进这里 ——
 * 每加一条就多一处与上游漂移的风险。
 */
export const VENDORED_PATCHES = Object.freeze({
  'verify-agent-note-format.ts': patchFormatMasking
});

/**
 * 按文件名决定是否给源码打补丁。
 *
 * @param {string} fileName 脚本文件名。
 * @param {string} source 源码。
 * @returns {{ code: string, applied: string[], missed: string[] }} 结果；无补丁时两者皆空。
 */
export function patchVendoredScript(fileName, source) {
  const patch = VENDORED_PATCHES[fileName];
  if (patch === undefined) return { code: source, applied: [], missed: [] };
  return patch(source);
}

/**
 * 这个脚本是否需要「复制到临时目录再打补丁」。
 *
 * @param {string} fileName 脚本文件名。
 * @returns {boolean} true 表示需要复制。
 */
export function needsPatchCopy(fileName) {
  return Object.hasOwn(VENDORED_PATCHES, fileName);
}
