/**
 * 校验 `docs/` 与笔记正文里的**行内 `文件:行号` 引用**是否还能解析。
 *
 * 语料范围：`docs/**` + `.agents/notes/**`（**不含 `archived/`**）。
 *
 * ## 为什么需要
 *
 * 本仓库的判定全是「上游判据 `scripts/x.ts:83`」「本地对照 `lib/notes.js:625`」
 * 这种形状。相对链接有 `tools/md-links.mjs` 管，但**行内代码引用没人管**：
 * 它不是链接，mdast 的 link 节点里根本看不到它。
 *
 * 复审（`.probe/review-final-2.md` 的 P2-6）实测出的漂移：
 * `README.md:409` 应为 `410`、`README.en.md:474` 应为 `477`、
 * `verify-plugin.mjs:118-136` 这个范围根本不存在该文件里、
 * `package.json:89` 指的是一个已删除的字段。**四处全是同一类漂移**，
 * 而它们只能靠人眼发现 —— 一份承载 46 道判定的文档，靠人眼就是不可维护。
 *
 * ## 判据（只做能机械判定的部分）
 *
 * 一条引用算「可校验」当且仅当它写在行内代码里、形如 `path:N` 或
 * `path:N-M`，且 `path` **含 `/`**（说明是仓库相对路径，不是文件名碎片）。
 * 可校验的引用必须：
 *
 *   1. 指向真实存在的文件；
 *   2. `N` 与 `M` 不超过该文件的行数（`N <= M`）。
 *
 * 明确**不校验**：
 *
 *   - 只有文件的引用（`lib/notes.js`）—— 存在性由 md-links / verify-plugin 覆盖；
 *   - 冒号后只有行号的裸引用（`:43`、`:59-85`）—— 它指代上文某个文件，
 *     解析它需要理解段落，做不到可靠；
 *   - 指向上游语料的路径（`apps/`、`packages/`、`vendor/`、`python/`、`./`）——
 *     那些文件在本仓库不存在，是本仓库**故意**在描述的别人的结构；
 *   - 指向 `.probe/` 的路径 —— 探针目录是 gitignore 的一次性证据
 *     （`.gitignore` 的「探针/临时」段），在别人的 clone 里根本不存在，
 *     校验它等于让门禁依赖我的本地残留；
 *   - `archived/` 下的笔记 —— 已按 SHA-256 封印，改一行就破坏清单，
 *     校验它们只会产出**无法修复**的红。
 *
 * 这几条排除是**有意收窄**：宁可只查一部分，也不要产出误报 ——
 * 误报的门禁会被绕过（同 `AGENTS.md` 对语义判重的论证）。
 *
 * ## 外部路径为什么用白名单而不是前缀
 *
 * 少数引用看起来是仓库相对路径、其实是**上游**的路径（比如上游 CLI 的
 * `lib/bin.js`、上游笔记规范的 `.agents/notes/AGENTS.md`）。用前缀排除会
 * 连带放过本仓库真实的 `lib/` 引用，所以改成白名单，且**每个条目必须写理由**：
 * 理由为空一律报错。这套「白名单防腐」的做法与 `tools/verify-plugin.mjs`
 * 的 `RUNTIME_ARTIFACTS` 同源（理由见
 * `.agents/notes/implemented/process/2026-10-21-vendored-integrity-gate-stops-trusting-itself.md`）。
 *
 * 本轮又把防腐补完整：**只写理由不够，条目还必须真的命中一条引用**。
 * 原来那两条（`lib/bin.js`、`.agents/notes/AGENTS.md`）在 `docs/` 里只以
 * 文件名出现、从不带 `:N`，从来没生效过 —— 一个永不命中的白名单条目
 * 看起来像校验，实际上什么都没拦。现在这种条目会被判红，所以表被清空了。
 *
 * ## 用法
 *
 * ```sh
 * npm run doc:refs          # 校验
 * ```
 *
 * 退出码：0 通过；1 有引用解析不了；2 语料为空（没扫到任何文档或任何引用）——
 * **空集合不得当绿**，与 `tools/verify-notes.mjs` 的口径一致。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankOutFences } from './markdown-links.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 看起来是仓库相对路径、其实是上游语料的白名单。理由必须非空，且必须真的命中。
 *
 * ## 现在是空的，为什么还留着这张表
 *
 * 第一版有两条：`lib/bin.js`（上游 CLI 入口）与 `.agents/notes/AGENTS.md`
 * （上游笔记规范）。复审 r1 的 P2-4 实测**零命中** —— `docs/upstream-46-gates.md`
 * 里它们只以**文件名**出现（`` `lib/bin.js` ``、`` `AGENTS.md` ``），从来不带
 * `:N`，所以 `collectInlineRefs` 根本不会产出这两条，白名单一次都没生效过。
 *
 * 那两条属于「为了可能的需要先开的洞」：洞开着而没人走，等于给未来的
 * 误报留了一条不需要理由的后门。所以按同一口径**删掉**，而不是留着当装饰。
 *
 * 表本身留着，是因为防腐规则要能被复用：任何新条目都必须满足
 * ① 理由非空（防「先放行再想理由」）② 真的被某条引用命中（防死条目复活）。
 * 第二条是本轮新加的 —— 只有第一条时，一条永不命中的条目可以永远躺在
 * 这里，看起来像「有校验」，实际上什么都没拦。
 *
 * @type {Record<string, string>}
 */
export const EXTERNAL_REFS = {};

/**
 * 需要排除的上游语料前缀。
 *
 * `scripts/` 也在其中：上游 A 把全部 `verify-*.ts` 放在仓库根的 `scripts/`，
 * 所以笔记里写 `scripts/verify-*.ts:83` 说的是**上游**的行号，本仓库没有这个
 * 目录。哪天本仓库真长出 `scripts/`，先把它从这张表里删掉再加引用。
 */
const UPSTREAM_PREFIXES = ['apps/', 'packages/', 'vendor/', 'python/', './', 'scripts/'];

/** 只在本地有、别人 clone 里没有的前缀：校验它就会让门禁依赖本地残留。 */
const LOCAL_ONLY_PREFIXES = ['.probe/'];

/**
 * 收集待校验的文档（仓库相对路径，正斜杠）。
 *
 * 收 `docs/` 与 `.agents/notes/`：两者都是**承载判定**的语料 —— 一处写「上游
 * 判据 `scripts/x.ts:83`」，一处写「本地对照 `lib/notes.js:625`」。第一版只收
 * `docs/`，理由是笔记里引用的绝对数量大且大量指向上游；实测下来这个理由
 * 只对「宽口径」成立，见 `.agents/notes/implemented/process/2026-10-22-note-refs-join-the-gate.md`
 * 里的量化（严格口径下笔记里 14 条候选只有 1 条真解析不了，且那是示例）。
 *
 * 跳过 `archived/`：那批笔记被封印，红了也改不动。
 *
 * @param {string} root 仓库根。
 * @returns {string[]} 文档列表。
 */
export function collectDocRefDocuments(root = PACKAGE_ROOT) {
  const files = [];
  const walk = (relDir) => {
    const full = join(root, relDir);
    if (!existsSync(full)) return;
    for (const name of readdirSync(full)) {
      if (name === 'archived') continue;
      const childRel = `${relDir}/${name}`;
      const childFull = join(root, childRel);
      if (statSync(childFull).isDirectory()) walk(childRel);
      else if (name.endsWith('.md')) files.push(childRel.split(sep).join('/'));
    }
  };
  walk('docs');
  walk('.agents/notes');
  return files.sort();
}

/**
 * 从一段 Markdown 里抽出可校验的行内引用。
 *
 * 先 `blankOutFences` 抹掉围栏代码块（用等长空白替换，偏移量不变），
 * 再在行内代码里找 `path:N` / `path:N-M`。
 *
 * @param {string} content 文档正文。
 * @returns {Array<{ path: string, from: number, to: number, at: number }>} 引用。
 */
export function collectInlineRefs(content) {
  const text = blankOutFences(content);
  const refs = [];
  const span = /`([^`\n]+)`/g;
  let spanMatch;
  while ((spanMatch = span.exec(text)) !== null) {
    const inner = spanMatch[1].trim();
    const ref = /^([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(inner);
    if (ref === null) continue;
    const path = ref[1];
    if (!path.includes('/')) continue;
    if (UPSTREAM_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
    if (LOCAL_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
    const from = Number(ref[2]);
    const to = Number(ref[3] ?? ref[2]);
    refs.push({ path, from, to, at: spanMatch.index });
  }
  return refs;
}

/**
 * 数一份文件有多少行。
 *
 * `split('\n').length` 会把结尾换行当成多一行（`"a\n"` 是 2），
 * 于是 `:2` 引用一个只有 1 行的文件会**被放过** —— 第一版就是这么写的，
 * 用例「行号越界必须红」当场把它抓出来。
 *
 * @param {string} body 文件正文。
 * @returns {number} 行数（空文件记 0）。
 */
function countLines(body) {
  if (body === '') return 0;
  const parts = body.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/**
 * 执行校验。
 *
 * @param {{ root?: string, externalRefs?: Record<string, string> }} options
 *   可选仓库根（测试用临时目录）与白名单覆盖（默认 `EXTERNAL_REFS`）。
 * @returns {{ checked: number, refs: number, errors: string[] }} 结果。
 */
export function verifyDocRefs(options = {}) {
  const root = options.root ?? PACKAGE_ROOT;
  const externalRefs = options.externalRefs ?? EXTERNAL_REFS;
  const documents = collectDocRefDocuments(root);
  const errors = [];
  const usedExternal = new Set();
  let refs = 0;

  for (const doc of documents) {
    const content = readFileSync(join(root, doc), 'utf8');
    for (const ref of collectInlineRefs(content)) {
      refs += 1;
      const lineOf = content.slice(0, ref.at).split('\n').length;
      const where = `${doc}:${lineOf}`;
      const reason = externalRefs[ref.path];
      if (reason !== undefined) {
        usedExternal.add(ref.path);
        if (reason.trim() === '') errors.push(`${where} 白名单条目 \`${ref.path}\` 没有写理由`);
        continue;
      }
      const target = join(root, ref.path);
      if (!existsSync(target)) {
        errors.push(`${where} 引用的文件不存在：\`${ref.path}\``);
        continue;
      }
      if (!statSync(target).isFile()) {
        errors.push(`${where} 引用的路径是目录，不是文件：\`${ref.path}\``);
        continue;
      }
      if (ref.from > ref.to) {
        errors.push(`${where} 行号范围倒置：\`${ref.path}:${ref.from}-${ref.to}\``);
        continue;
      }
      const body = readFileSync(target, 'utf8');
      const lines = countLines(body);
      if (ref.to > lines) {
        errors.push(`${where} 行号越界：\`${ref.path}:${ref.to}\`，该文件只有 ${lines} 行`);
      }
    }
  }

  for (const key of Object.keys(externalRefs)) {
    if (!usedExternal.has(key)) {
      errors.push(`白名单条目 \`${key}\` 从未命中任何引用：死条目请删除，或补上真正的引用`);
    }
  }

  if (documents.length === 0) errors.push('没有扫到任何 `docs/` 或 `.agents/notes/` 文档：空集合不得当绿');
  if (refs === 0) errors.push('没有扫到任何行内 `文件:行号` 引用：空集合不得当绿');
  return { checked: documents.length, refs, errors };
}

/* 与本仓库其它工具同口径（`archive-note.mjs:216`、`ci-alignment.mjs:515`）：
   按尾段比对，不在 Windows 上拼 `file://` URL —— 那条路对盘符、反斜杠与
   相对路径都不稳，失败时还会**静默不跑**（exit 0 却一行输出都没有）。 */
const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replace(/\\/g, '/').endsWith('/tools/doc-refs.mjs');

if (invokedDirectly) {
  const result = verifyDocRefs();
  if (result.errors.length > 0) {
    console.error('行内引用校验失败：');
    for (const error of result.errors) console.error(`  ✖ ${error}`);
    process.exit(1);
  }
  console.log(`行内引用校验通过：${result.checked} 个文档、${result.refs} 条 \`文件:行号\` 引用全部可解析。`);
}
