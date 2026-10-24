/**
 * 归档树（`archived/`）的结构、元数据与封印清单校验。
 *
 * ## 为什么需要它（缺口是实测出来的）
 *
 * 本仓库的归档门禁是「包装层 + vendored 脚本」两层：
 *
 *   - `lib/notes.js` 的 `runGate('archived')` 前置校验：只管**历史基线**
 *     （Git 基线里的 manifest 与当前 manifest 的封印逐条比对，证明「只增不改」）。
 *   - `skills/agent-notes/scripts/verify-archived-agent-notes.ts`（vendored）：
 *     管**头块布局**（L1 标题 / L2 空行 / L3 Status / L4 Archived / L5 空行）、
 *     **磁盘上的封印哈希**、以及「封印条目在磁盘上有对应文件」。
 *
 * 两层加起来**仍然漏掉一整类问题**（上游 A 的 `verify-archived-agent-notes.ts`
 * 有、本地没有）：
 *
 *   1. **目录布局**：`archived/` 根下多一个随手放的文件、出现未知分类目录、
 *      分类目录里再套一层子目录 —— vendored 扫描时要么忽略、要么当成正常笔记，
 *      一律 exit 0。归档树是「冻结只读」区，形状被破坏却没人报，就是假绿。
 *   2. **日期真实性**：vendored 只用正则 `Archived: \d{4}-\d{2}-\d{2}` 匹配，
 *      `2026-13-45` 这种不存在的日期照样通过（实测：`tools/doc-budget` 之外
 *      没有任何一处校验日历真实性）。
 *   3. **日期次序**：上游要求「归档日期不得早于笔记文件名日期」
 *      （`archived-agent-notes.ts` 的 `archive date ... predates the note filename`）。
 *      本地没有这条判断。
 *   4. **manifest 的封闭 schema**：vendored 只 `JSON.parse`，不校验字段集合、
 *      不校验 `version`、不校验哈希格式（`sha256:<64 位小写十六进制>`）。
 *      写成 `{"version": 2, "files": {}}` 或把哈希改成 `"ok"` 都不会被 manifest 校验拦下
 *      （哈希会因为与磁盘实算不符而报 seal mismatch，但那是另一条路径，不是 schema 校验）。
 *   5. **旁挂文件不受封印管辖**：vendored 扫描时**跳过 `.zh.md`**，
 *      所以 `archived/<class>/x.zh.md` 这类文件既不进它的封印语料、
 *      也不被校验 —— 可以在「冻结只读」区里塞任意内容而门禁全绿。
 *      （★ 2026-10-24：本模块第一版对这条**只补了一半** —— 只查「manifest
 *      里有没有这个键」，封印值从不复算，于是「贴了个标签」被当成了「验过了」。
 *      现在按与正笔记同一口径复算，见 `sealOf` 与下面第 7 点。）
 *
 * ## 与上游的差异（刻意保留）
 *
 *   - 上游要求归档是**完整双语三元组**（`.md` + `.zh.md` + `.i18n.yaml`），
 *     本仓库的笔记树不要求双语（README 双语是另一件事），照搬会凭空制造失败。
 *     本模块对 `.zh.md` 的处理是「**可以存在，但必须被封印、且封印值必须与
 *     磁盘字节一致**」——既不强制成对，也不给它留免检的洞。
 *   - 上游要求 `archived/AGENTS.md` 存在、且六个分类目录齐全。
 *     本仓库不要求：下游仓库（`sourin-flutter-spike`）只归档了 `process/` 一类，
 *     强制六个目录齐全会把正常仓库判红。`archived/AGENTS.md` 则**允许存在**
 *     （上游也允许，且不封印）。
 *
 * ## 位置：为什么是插件自有的 `lib/`，不是改 vendored
 *
 * vendored 副本由 `tools/sync-upstream.mjs` 管理，手改会被
 * `tools/verify-plugin.mjs` 的哈希比对拦下（`AGENTS.md` 硬约束 3）。
 * 所以补判据一律落在插件自有的 `lib/` 里 —— 与既有做法一致：
 * `lib/notes.js` 的归档基线前置校验也是这么加的。
 *
 * 零依赖：只用 `node:` 内建模块。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 归档分类封闭集（与 `lib/notes.js` 的 `CLASSES` 保持一致）。 */
export const ARCHIVE_CLASSES = Object.freeze([
  'feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'
]);

/** `Archived:` 日期的形状（真实性另判）。 */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 归档文件名形状：`yyyy-mm-dd-主题.md` 或其 `.zh.md` 旁挂。 */
const NAME_RE = /^(\d{4})-(\d{2})-(\d{2})-.+\.(?:md|zh\.md)$/;

/** manifest 允许的顶层字段（封闭集，与上游 `parseArchiveManifest` 同口径）。 */
const MANIFEST_FIELDS = ['files', 'version'];

/** 封印值的形状：`sha256:` + 64 位小写十六进制。 */
const SEAL_RE = /^sha256:[0-9a-f]{64}$/;

/** `archived/` 根目录允许出现的普通文件（与上游 `allowedRootFiles` 同口径）。 */
const ROOT_FILES = new Set(['AGENTS.md', 'manifest.json']);

/**
 * 判断是不是一个真实存在的日历日期。
 *
 * 「正则匹配上了」不等于「这个日期存在」——`2026-13-45` 能过正则。
 * 上游用 `new Date(Date.UTC(...))` 回读年月日来判定，本模块同口径。
 *
 * @param {number} year 年。
 * @param {number} month 月（1-12）。
 * @param {number} day 日（1-31）。
 * @returns {boolean} 该日期是否真实存在。
 */
export function isRealDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

/**
 * 校验 manifest 的封闭 schema。
 *
 * @param {string} raw manifest.json 的原文。
 * @returns {string[]} 问题列表；空数组表示通过。
 */
export function checkManifestSchema(raw) {
  const errors = [];
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return [`manifest.json 不是合法 JSON（${error.message}）`];
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['manifest.json 顶层必须是 JSON 对象'];
  }
  const fields = Object.keys(value).sort();
  if (fields.join(',') !== MANIFEST_FIELDS.join(',')) {
    errors.push(`manifest.json 字段封闭集必须是 ${MANIFEST_FIELDS.join(' + ')}（实际：${fields.join(', ') || '空'}）`);
  }
  if (value.version !== 1) {
    errors.push(`manifest.json 的 version 必须是 1（实际：${JSON.stringify(value.version)}）`);
  }
  if (typeof value.files !== 'object' || value.files === null || Array.isArray(value.files)) {
    errors.push('manifest.json 的 files 必须是对象');
    return errors;
  }
  for (const [key, seal] of Object.entries(value.files)) {
    if (typeof seal !== 'string' || !SEAL_RE.test(seal)) {
      errors.push(`manifest.json 的封印格式非法：${key}`);
    }
    if (!key.startsWith('archived/')) {
      errors.push(`manifest.json 的键必须是 archived/ 开头的相对路径：${key}`);
    }
  }
  return errors;
}

/**
 * 算一个文件的封印值。
 *
 * ## 为什么必须与 vendored 逐字同口径
 *
 * 归档封印有两个验证者：vendored 的 `verify-archived-agent-notes.ts` 验**正笔记**
 * （`.md` —— 它扫语料时显式跳过 `.zh.md`），本模块验**旁挂**（`.zh.md`）。
 * 若两边各算一套摘要，同一份 manifest 会对同一批字节给出两个答案；
 * 用户看到的就是「vendored 说这行哈希对、插件说不对」——两处真相互相拆台，
 * 这正是本仓库反复栽过的坑（`lib/notes.js` 的 Git 基线比对是第三个消费方，
 * 它比的是**封印值本身**，同样依赖这一套口径）。
 *
 * 所以下面这个表达式是**逐字照抄** vendored 的
 * `const sealOf = … createHash("sha256").update(readFileSync(…)).digest("hex")`：
 * 前缀 `sha256:` + 小写十六进制，输入是 `readFileSync` 的**原始字节**。
 * 特别注意**不要**传 `'utf8'` —— 那会先解码再编码，遇到非 UTF-8 字节
 * （或 BOM/CRLF 之外的任何编码畸形）就与 vendored 分叉，而分叉只在对不上的
 * 那一刻才暴露，排查成本极高。
 *
 * 口径是否真的一致，不靠注释保证：`tools/archive-layout.test.mjs` 里有一条
 * **互证用例** —— 内容逐字相同的 `.md` 与 `.zh.md` 共用一个由本函数算出的封印，
 * 让 vendored 自己去验那篇 `.md`。两边一旦分叉，那条用例立刻红。
 * 也正因如此，该测试文件的夹具必须继续用本函数算封印，不要自己再写一份。
 *
 * @param {string} absolutePath 文件绝对路径。
 * @returns {string} `sha256:<64 位小写十六进制>`。
 */
export function sealOf(absolutePath) {
  return `sha256:${createHash('sha256').update(readFileSync(absolutePath)).digest('hex')}`;
}

/**
 * 校验单篇归档笔记的头块元数据。
 *
 * 只看 vendored 判不到的两部分：**日期真实性**与**日期次序**。
 * 布局（标题行/空行/Status 行）由 vendored 报，这里不重复，
 * 免得同一个问题出两套文案。
 *
 * @param {string} rel 归档文件相对 `archived/` 的路径。
 * @param {string} content 文件原文。
 * @param {string} filenameDate 文件名里的 `yyyy-mm-dd`。
 * @returns {string[]} 问题列表。
 */
function checkArchivedMetadata(rel, content, filenameDate) {
  const errors = [];
  const lines = content.split('\n');
  /* 头块不是标准形状时，vendored 会报得更准，这里不重复报。 */
  if (lines[2] !== 'Status: implemented') return errors;
  const match = /^Archived: (\d{4}-\d{2}-\d{2})$/.exec(lines[3] ?? '');
  if (match === null) return errors;
  const archived = match[1];
  const [, year, month, day] = DATE_RE.exec(archived) ?? [];
  if (!isRealDate(Number(year), Number(month), Number(day))) {
    errors.push(`${rel}: Archived: ${archived} 不是真实存在的日期`);
    return errors;
  }
  if (archived < filenameDate) {
    errors.push(`${rel}: 归档日期 ${archived} 早于笔记文件名日期 ${filenameDate}`);
  }
  return errors;
}

/**
 * 校验归档树的形状、元数据与封印覆盖。
 *
 * @param {{ notesRoot: string }} options 笔记根。
 * @returns {{ errors: string[], artifacts: string[] }} 问题列表与发现的归档文件（相对 `archived/`）。
 */
export function checkArchiveLayout({ notesRoot }) {
  const archivedRoot = join(notesRoot, 'archived');
  if (!existsSync(archivedRoot)) return { errors: [], artifacts: [] };

  const errors = [];
  const artifacts = [];
  const manifestPath = join(archivedRoot, 'manifest.json');

  let entries = [];
  try {
    entries = readdirSync(archivedRoot, { withFileTypes: true });
  } catch (error) {
    return { errors: [`archived/ 目录读不出来（${error.message}）`], artifacts: [] };
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      if (!ARCHIVE_CLASSES.includes(entry.name)) {
        errors.push(`${entry.name}/: 未知归档分类目录（允许：${ARCHIVE_CLASSES.join(', ')}）`);
        continue;
      }
      let children = [];
      try {
        children = readdirSync(join(archivedRoot, entry.name), { withFileTypes: true });
      } catch (error) {
        errors.push(`${entry.name}/: 目录读不出来（${error.message}）`);
        continue;
      }
      for (const child of children) {
        if (child.name.startsWith('.')) continue;
        const rel = `${entry.name}/${child.name}`;
        if (!child.isFile()) {
          errors.push(`${rel}: 归档分类目录下只允许普通文件，不允许子目录`);
          continue;
        }
        const nameMatch = NAME_RE.exec(child.name);
        if (nameMatch === null) {
          errors.push(`${rel}: 归档文件名必须是 yyyy-mm-dd-主题.md（或 .zh.md 旁挂）`);
          continue;
        }
        artifacts.push(rel);
        let content = '';
        try {
          content = readFileSync(join(archivedRoot, rel), 'utf8');
        } catch (error) {
          errors.push(`${rel}: 读不出来（${error.message}）`);
          continue;
        }
        errors.push(...checkArchivedMetadata(rel, content, nameMatch[1] + '-' + nameMatch[2] + '-' + nameMatch[3]));
      }
      continue;
    }
    if (!entry.isFile()) {
      errors.push(`${entry.name}: 归档根目录只允许普通文件与分类目录`);
      continue;
    }
    if (!ROOT_FILES.has(entry.name)) {
      errors.push(`${entry.name}: 归档根目录只允许 ${[...ROOT_FILES].join(' 与 ')}`);
    }
  }

  /* manifest 的封闭 schema + 封印覆盖。 */
  const seals = new Map();
  if (existsSync(manifestPath)) {
    let raw = '';
    try {
      raw = readFileSync(manifestPath, 'utf8');
    } catch (error) {
      errors.push(`manifest.json 读不出来（${error.message}）`);
    }
    if (raw !== '') {
      errors.push(...checkManifestSchema(raw));
      try {
        const parsed = JSON.parse(raw);
        for (const [key, seal] of Object.entries(parsed?.files ?? {})) seals.set(key, seal);
      } catch {
        /* schema 校验已经报过了，这里不再重复报。 */
      }
    }
  }
  /* 封印覆盖：**只管 vendored 跳过的旁挂文件**（`.zh.md`）。
     vendored 扫描归档区时明确跳过 `.zh.md`，所以旁挂文件既不进它的语料、
     也不受它的封印保护 —— 那是真洞。普通 `.md` 未封印、封印不符时 vendored
     自己会报（"missing seal in manifest.json" / "seal mismatch"），
     这里不重复报，免得同一条问题出两处。

     刻意只报旁挂文件还有一个副作用上的好处：普通 `.md` 的「有文件无封印」
     留给 vendored 报，而 vendored 的诊断是逐文件的，比这里更适合定位。

     ★ 2026-10-24：这段原本**只查键存不存在**（`sealed.has(key)`），于是
     「补了一条封印」被当成了「验过了」—— 实测在真 Git 仓库里改旁挂内容、
     甚至把封印值写成与磁盘完全无关的哈希，三条门禁照样全绿，而归档门禁还打印
     `2 seal(s) in manifest`，读起来像是两条都验过。存在的键必须**复算**：
     口径与 vendored 验正笔记的那一套逐字相同（见 `sealOf`），不一致报与
     vendored 同款的 `seal mismatch`，并把两边实际值都打出来 ——
     否则「内容被改」与「当初就填错了」两种成因长得一模一样。 */
  for (const rel of artifacts) {
    if (!rel.endsWith('.zh.md')) continue;
    const key = `archived/${rel}`;
    if (!seals.has(key)) {
      errors.push(`${key}: 未在 manifest.json 里封印（旁挂文件同样属于归档区，必须被封印）`);
      continue;
    }
    const seal = seals.get(key);
    /* 封印形状非法这一条 `checkManifestSchema` 已经报过，不重复报。 */
    if (typeof seal !== 'string' || !SEAL_RE.test(seal)) continue;
    let actual;
    try {
      actual = sealOf(join(archivedRoot, rel));
    } catch {
      /* 读不出来这一条，上面的内容读取已经报过；同一条问题不报两次。 */
      continue;
    }
    if (actual !== seal) {
      errors.push(`${key}: seal mismatch: archived note was modified after sealing `
        + '(frozen notes must never change)'
        + `｜manifest=${seal}｜磁盘=${actual}`
        + '（旁挂 .zh.md：vendored 扫描跳过它，此条由插件复算）');
    }
  }
  /* 反向对账（封印指向不存在的文件）**刻意不做**：vendored 已有同口径判据
     （`sealed entry has no file on disk`）。这里再做一遍就是同一问题两处真相，
     而两处文案不同会让人怀疑是不是两回事。

     但有一类是 vendored **不拦**的：manifest 里封了一个**存在于笔记树别处**
     的路径（例如 `implemented/foo.md`）。vendored 只判「文件不存在」，
     文件存在但位置不对它不管。本模块的 schema 校验因此要求
     **每个封印键必须以 `archived/` 开头**（见 checkManifestSchema）。

     `present` 只用于这一处的说明性判断，不再单独报错。 */

  return { errors, artifacts };
}
