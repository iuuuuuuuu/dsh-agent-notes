/**
 * 校验仓库内 Markdown 的**相对链接**是否都指向真实存在的文件。
 *
 * ## 为什么需要
 *
 * 本仓库有 5 个顶层文档 + 23 篇笔记，它们互相引用（README ↔ README.en、
 * AGENTS → 笔记、笔记 → 笔记、THIRD_PARTY_NOTICES → LICENSE）。
 *
 * 笔记门禁（`verify-agent-note-tree.ts`）只验**笔记之间**的链接，
 * `tools/verify-plugin.mjs` 只验**双语文档与徽标存在**。两者都不管
 * 「README 指向的那个文件还在不在」。实测这类断链最容易在两种时候出现：
 *
 *   - 归档 / 删除一篇笔记时，入站链接没人修；
 *   - 重命名文件后，只改了正文里的说法，忘了改链接。
 *
 * 上游 `deepseek-ai/deepseek-harness` 用 `scripts/verify-md-links.ts`
 * 覆盖这件事（依赖 mdast 做 AST 解析，还校验 `#fragment` 锚点）。
 *
 * ## 为什么不用 mdast
 *
 * 本仓库的链接形态很简单：行内链接 `[文字](目标)` 与图片 `![alt](目标)`。
 * 用 mdast 要引入一棵依赖树（以及它的 GFM 扩展）才能覆盖同样的事，
 * 而收益只有「极端边缘情况更准」——例如链接出现在代码块里要不要跳过。
 * 这一点用「跳过围栏代码块」的轻量扫描就能处理，见 `stripCodeFences`。
 *
 * **不做 `#fragment` 锚点校验**：本仓库当前零处使用锚点链接（实测 grep）。
 * 为不存在的需求增加「标题转 slug」这套逻辑，是纯粹的复杂度 —— 而它一旦
 * 实现得与渲染器不一致，就会产出误报。这条记在重访信号里：等到真的用上
 * 锚点时再加，那时应以实际渲染器（GitHub）的 slug 规则为准。
 *
 * ## 用法
 *
 * ```sh
 * npm run md:links          # 校验
 * ```
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 需要校验的 Markdown 文件（相对仓库根）。
 *
 * 刻意**不含** `skills/agent-notes/`：那是 vendored 上游内容，手改会被哈希
 * 门禁拦下。它内部的链接由上游负责，本仓库无权也不该修。
 *
 * ## 归档笔记作为「源」被排除（但指向它们的链接仍检查）
 *
 * 与上游 `verify-md-links.ts` 对齐（它用 `isArchivedAgentNotePath` 做同样的
 * 排除，注释写明「Archived notes are excluded as sources, but links to them
 * remain checked」）。
 *
 * **为什么要排除**：归档会把 `implemented/<class>/x.md` 移到
 * `archived/<class>/x.md` —— 深度不变、只有 lifecycle 段变了。所以笔记里
 * 原先的 `../bug-fix/y.md` 归档后会解析成 `archived/bug-fix/y.md`，而 `y.md`
 * 还在 `implemented/` —— **断链**。
 *
 * 实测规模：待归档笔记的出向链接 63 条里 **60 条（95%）会断**。而归档后
 * **不能再改归档文件**（封印机制：`--write` 只封未封的，已封的改了就报
 * `seal mismatch`）。所以这不是「忘了修」，而是**设计上无法事后修**。
 *
 * 把归档笔记排除出「源」，等于承认「封存内容的内部链接会随时间腐化」——
 * 这是**有意的取舍**，不是漏洞：归档笔记是历史快照，不是活文档。
 *
 * 但**指向**归档笔记的链接必须继续检查 —— 那是活文档里的引用，断了要修。
 */
function collectDocuments() {
  const files = [];

  /* 顶层文档。 */
  for (const name of readdirSync(PACKAGE_ROOT)) {
    if (!name.endsWith('.md')) continue;
    const full = join(PACKAGE_ROOT, name);
    if (statSync(full).isFile()) files.push(name);
  }

  /* 笔记树：递归收集，跳过归档区。 */
  const walk = (relDir) => {
    const full = join(PACKAGE_ROOT, relDir);
    if (!existsSync(full)) return;
    for (const name of readdirSync(full)) {
      const childRel = `${relDir}/${name}`;
      const childFull = join(PACKAGE_ROOT, childRel);
      const info = statSync(childFull);
      if (info.isDirectory()) {
        /* 归档区不作为校验源（理由见上方）。 */
        if (relDir === '.agents/notes' && name === 'archived') continue;
        walk(childRel);
      } else if (name.endsWith('.md')) {
        files.push(childRel.split(sep).join('/'));
      }
    }
  };
  walk('.agents/notes');

  return files.sort();
}

/**
 * 把围栏代码块与行内代码替换成等长空白。
 *
 * 为什么保留长度：替换成等长空白后，报错时给出的行列位置仍然对应原文，
 * 不必做位置换算。
 *
 * 为什么要跳过：文档里常有「链接长这样」的示例（本仓库的笔记里就有），
 * 那些不是真链接。不跳过会产生大量误报，而误报多的门禁会被绕过。
 *
 * @param {string} text 原文。
 * @returns {string} 同长度、代码区域已清空的文本。
 */
function stripCodeFences(text) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');

  /* 围栏代码块：``` 或 ~~~ 开头，允许有语言标注。 */
  let out = text.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g,
    (whole) => blank(whole));

  /* 行内代码：成对的单反引号（不跨行）。 */
  out = out.replace(/`[^`\n]*`/g, (whole) => blank(whole));

  return out;
}

/**
 * 从一段 Markdown 里抽取所有相对链接目标。
 *
 * 支持的形态：
 *   - `[文字](目标)`、`[文字](目标 "标题")`
 *   - `[文字](<目标>)`（CommonMark 的尖括号目标，用来含空格）
 *   - `![alt](目标)`（图片）
 *
 * @param {string} text 已去掉代码区域的文本。
 * @returns {{ target: string, raw: string }[]} 链接目标清单。
 */
function extractLinks(text) {
  const links = [];
  /* 图片与链接同构，`!` 可有可无。目标部分允许尖括号包裹与可选标题。 */
  const pattern = /!?\[[^\]]*\]\(\s*(?:<([^>]*)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const target = (match[1] ?? match[2] ?? '').trim();
    if (target !== '') links.push({ target, raw: match[0] });
  }
  return links;
}

/**
 * 判断一个链接目标是否需要校验，需要时返回去掉 fragment 的路径部分。
 *
 * 跳过：绝对 URL（含协议）、协议相对 URL（`//`）、页内锚点（`#`）、
 * 纯 mailto/tel。这些都不指向本仓库的文件。
 *
 * @param {string} target 链接目标。
 * @returns {string | null} 相对路径，或 null（不需要校验）。
 */
function localPathOf(target) {
  if (target.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  if (target.startsWith('//')) return null;
  /* fragment 与 query 都不影响文件是否存在。 */
  const withoutFragment = target.split('#')[0].split('?')[0];
  if (withoutFragment === '') return null;
  return withoutFragment;
}

/**
 * 执行校验。
 *
 * @returns {{ checked: number, links: number, errors: string[] }} 结果。
 */
export function verifyMarkdownLinks() {
  const documents = collectDocuments();
  const errors = [];
  let links = 0;

  for (const doc of documents) {
    const full = join(PACKAGE_ROOT, doc);
    const found = verifyOne(full, doc, errors);
    links += found;
  }

  return { checked: documents.length, links, errors };
}

/**
 * 校验单个文档里的相对链接，把错误累积进 errors。
 *
 * 拆出来是为了让「校验一个不在仓库里的文件」成为可能：测试需要在临时
 * 目录里造一份 vendored 副本再验它，而不能往真仓库里写探针文件 ——
 * `node --test` 并行跑各个测试文件，往真目录写东西会让**别的**测试读到
 * 不一致的内容（实测 `project-skill` 与 `self-update` 偶发失败就是这么来的）。
 *
 * @param {string} full 文档绝对路径。
 * @param {string} label 出错时用于显示的路径。
 * @param {string[]} errors 错误累积数组，原地 push。
 * @param {string} [baseRoot] 越界判断的根目录，缺省为仓库根。
 * @returns {number} 本文档里被检查的相对链接数。
 */
function verifyOne(full, label, errors, baseRoot = PACKAGE_ROOT) {
  const text = readFileSync(full, 'utf8');
  const stripped = stripCodeFences(text);
  const found = extractLinks(stripped);
  let links = 0;

  for (const { target } of found) {
    const local = localPathOf(target);
    if (local === null) continue;
    links += 1;

    /* 百分号编码要及时解码：`%E4%B8%AD` 这种写法指向真实存在的中文文件名。 */
    let decoded = local;
    try { decoded = decodeURI(local); } catch { /* 非法编码：按原样检查 */ }

    const base = dirname(full);
    const resolved = resolve(base, decoded);

    /* 目标必须在根目录内：`../../../etc/passwd` 这类穿越路径不算合法文档链接。 */
    const rel = relative(baseRoot, resolved);
    if (rel.startsWith('..') || rel.startsWith(sep + '..')) {
      errors.push(`${label}: 链接越出仓库范围 -> ${target}`);
      continue;
    }

    if (!existsSync(resolved)) {
      errors.push(`${label}: 链接目标不存在 -> ${target}`);
      continue;
    }

    /* 指向目录要单独判。
       实测踩过：`[见说明](docs/)` 这种写法会让 readFileSync 抛 EISDIR，
       **整个门禁直接崩掉** —— 不是报告问题，是自己挂了。崩掉时退出码非 0，
       看起来像「门禁红了」，实际是「门禁没能运行」。那正是本仓库最忌讳的
       形态：红的含义必须清楚。
       Markdown 里 `x/` 会渲染成目录下的 index，行为取决于渲染器；
       本门禁只保证「目标是文件」，所以明确报出来而不是崩溃。 */
    let isDirectory = false;
    try { isDirectory = statSync(resolved).isDirectory(); } catch { /* 读不到就当不是目录 */ }
    if (isDirectory) {
      errors.push(
        `${label}: 链接指向目录而非文件 -> ${target}`
        + '（目录没有内容可指；要指某个文件请写全文件名）'
      );
    }
  }

  return links;
}

/**
 * 只校验给定的几个文档（不按默认规则收集）。
 *
 * 用途是测试与诊断：验证某一份特定的 Markdown 会被怎么处理，
 * 而不必也不该把整仓库扫一遍。
 *
 * @param {string[]} files 文档绝对路径。
 * @param {string} [baseRoot] 越界判断的根，缺省为这些文件的公共父目录。
 * @returns {{ checked: number, links: number, errors: string[] }} 结果。
 */
export function verifyMarkdownLinksIn(files, baseRoot) {
  const errors = [];
  let links = 0;
  /* 缺省根取第一份文件的目录：临时目录里的探针文件之间互相引用时，
     以它为界才不会把同一目录里的兄弟文件判成越界。 */
  const root = baseRoot ?? (files.length > 0 ? dirname(files[0]) : PACKAGE_ROOT);
  for (const full of files) {
    links += verifyOne(full, full, errors, root);
  }
  return { checked: files.length, links, errors };
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

function main() {
  const result = verifyMarkdownLinks();
  if (result.errors.length === 0) {
    console.log(`Markdown 链接校验通过：${result.checked} 个文档、${result.links} 条相对链接全部可达。`);
    process.exit(0);
  }
  console.error(`Markdown 链接校验失败：${result.errors.length} 处`);
  for (const error of result.errors) console.error(`  ✖ ${error}`);
  process.exit(1);
}

/* 只在被当作脚本直接执行时跑 CLI —— 被 import 时保持纯净，便于测试。 */
const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
