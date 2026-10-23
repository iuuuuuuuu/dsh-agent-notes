/**
 * 笔记根（`.agents/notes/`）的形状校验。
 *
 * ## 这个缺口是什么
 *
 * 三条 vendored 门禁（`verify-agent-note-tree.ts` / `verify-agent-note-format.ts`
 * / `verify-archived-agent-notes.ts`）都是**按 `{lifecycle}/{class}/` 形状枚举**
 * 来找笔记的：它们遍历 `implemented/`、`proposed/`、`rejected/` 三个 lifecycle
 * 目录，再遍历每个 lifecycle 下的六个 class 目录。
 *
 * 于是**落在这些枚举路径之外的任何东西都是隐形的**。实测（`gap-scan` 第三轮
 * 覆盖矩阵第 31 行）：在 `.agents/notes/` 顶层新建一个 `zz-probe-stray.md`，
 * 整条门禁链 13 步全绿。
 *
 * 后果不是「多了一个文件」那么轻：
 *   - 它**不被判定为已归档**（不是 `archived/` 下的封印对象）；
 *   - 它**不被判定为格式违规**（不在任何 lifecycle 枚举里）；
 *   - 它**不占笔记树的 `ok: N note(s)` 计数** —— 于是「磁盘上的笔记数」
 *     与「门禁报告的笔记数」对不上，而**没有任何门禁会指出这一点**。
 *
 * 换句话说：一份笔记可以完全绕过这套方法的管理，既不会被归档，也不会被
 * 判违规，团队也不会知道它存在。这正是「改了某类文件但没有任何门禁会红」
 * 的典型形态。
 *
 * ## 判据
 *
 * 笔记根下**只允许**出现：
 *   - 四个 lifecycle 目录：`implemented/` `proposed/` `rejected/` `archived/`
 *   - 根层说明文件：`*.md`（如上游的 `AGENTS.md`、`README.md`）
 *   - 归档封印清单：`manifest.json`
 *   - `.gitkeep`（空目录要在 git 里留住的唯一办法，本身不带内容）
 *
 * 其余任何路径项（未知目录、未知后缀的文件、`.json` / `.yml` 等）直接判失败。
 *
 * ## 再往下一层也管（2026-10-23 补）
 *
 * 原来只查笔记根**这一层**，于是 `implemented/odd/`（未知分类目录）、
 * `implemented/bug-fix/stray.txt`（分类目录里的非笔记文件）、
 * `implemented/bug-fix/nested/x.md`（分类目录下再套目录）全都隐形 ——
 * 与根层那条缺口是同一族：**落在枚举路径之外的东西没人管**。
 *
 * 现在逐个 lifecycle 目录（`archived/` 除外，它由 `lib/archive-layout.js` 管）
 * 校验：子项必须是六个 class 目录之一；每个 class 目录下只允许普通 `.md` 文件
 * 与 `.gitkeep`，不许子目录、不许符号链接。**这一层不判文件名规则与内容**
 * ——那是 vendored 格式门禁的活，不在这里制造第二个真相。
 *
 * ## 系统垃圾文件给专门的话（2026-10-23 补）
 *
 * `.DS_Store` / `Thumbs.db` / `desktop.ini` / `._*` 落在笔记树里时，原来报
 * 「未知文件 … 不会被任何门禁看见」—— 技术上没错，但对着 macOS 自动生成的
 * `.DS_Store` 说这句话，用户不知道该干什么。现在单独报「系统垃圾文件，
 * 加进 `.gitignore` 并删掉」。**只是换了提示，没有放行**：放行等于让门禁
 * 默认允许垃圾进仓库。
 *
 * ## 为什么放在插件侧而不是改 vendored
 *
 * AGENTS.md 硬约束 3：**不得手改 `skills/agent-notes/` 下的 vendored 内容**
 * （那是上游副本，由 `tools/sync-upstream.mjs` 管理，手改会被
 * `tools/verify-plugin.mjs` 的哈希比对拦下）。所以这道校验必须落在
 * 本插件自己的 `lib/` 里。
 *
 * ## 为什么允许根层 `*.md`
 *
 * 上游 A 的 `.agents/notes/` 根层就放着 `AGENTS.md`（说明文件），
 * 它的 `agent-note-tree.ts` 里 `ROOT_ALLOWLIST = new Set(['AGENTS.md', 'CLAUDE.md'])`
 * 允许根层说明文件存在。禁掉它会让「在笔记根放一份说明」变成必须改
 * vendored 才能做的事 —— 那是要避免的。
 *
 * 代价要说清：根层的 `*.md` **不会**被任何门禁校验内容与形状（它们不计入
 * 笔记数、不进归档封印、不受格式门禁管辖）。这是有意的取舍：根层是
 * 「说明区」，不是「笔记区」；真要把一份文档变成笔记，它必须放进
 * `{lifecycle}/{class}/`。
 *
 * ## 与归档形状校验的分工
 *
 * `lib/archive-layout.js` 管的是 `archived/` **里面**的形状（分类目录、
 * 文件名日期、日历真实性、封印 schema）。本模块管的是笔记根**这一层**
 * 有哪些路径项。两者互不重叠。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ARCHIVE_CLASSES } from './archive-layout.js';

/**
 * 允许出现在笔记根的 lifecycle 目录。
 *
 * 与 `lib/notes.js` 的 `LIFECYCLES` 一致（含 `archived`）。
 */
export const NOTE_ROOT_LIFECYCLES = Object.freeze([
  'implemented', 'proposed', 'rejected', 'archived'
]);

/** 允许出现在笔记根的非目录文件。 */
export const NOTE_ROOT_FILES = Object.freeze(['manifest.json']);

/**
 * 在哪一层都允许存在、且**不带内容**的占位文件。
 *
 * `.gitkeep` 是「空目录也要进 git」的唯一通用办法：没有它，
 * 一个刚建好还没写笔记的 `proposed/` 目录在下一次 clone 后就不存在了。
 * 它不进入笔记计数、不被格式门禁看见 —— 这是它的用途，不是缺陷。
 */
export const NOTE_IGNORED_FILES = Object.freeze(['.gitkeep']);

/**
 * 操作系统自动生成的垃圾文件（按名字匹配，`._*` 另算，见 {@link isJunkFile}）。
 *
 * 这些文件**不放行**，只是给一句能指路的提示。
 */
export const NOTE_JUNK_FILES = Object.freeze(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/**
 * 判断一个名字是不是系统垃圾文件。
 *
 * `._*` 是 macOS 的 AppleDouble 伴生文件（`._note.md`），会与真笔记并排出现，
 * 名字不固定，所以按前缀判。
 *
 * @param {string} name 文件名。
 * @returns {boolean} 是否垃圾文件。
 */
function isJunkFile(name) {
  return NOTE_JUNK_FILES.includes(name) || name.startsWith('._');
}

/**
 * 校验笔记根这一层的形状。
 *
 * @param {{ notesRoot: string }} options 选项。
 * @param {string} options.notesRoot 笔记根绝对路径。
 * @returns {{ errors: string[] }} 错误清单；空数组表示合规。
 */
export function checkNotesLayout({ notesRoot }) {
  const errors = [];
  if (!existsSync(notesRoot)) {
    /* 笔记根不存在由 `lib/notes.js` 的 `NO_NOTES_TREE` 负责拦。
       这里返回空错误，避免同一件事有两个真相。 */
    return { errors };
  }

  let entries;
  try {
    entries = readdirSync(notesRoot, { withFileTypes: true });
  } catch (error) {
    return {
      errors: [`读取笔记根失败：${error instanceof Error ? error.message : String(error)}`]
    };
  }

  for (const entry of entries) {
    const name = entry.name;

    if (entry.isDirectory()) {
      if (!NOTE_ROOT_LIFECYCLES.includes(name)) {
        errors.push(
          `未知目录 ${name}/ —— 笔记根下只允许四个 lifecycle 目录：`
          + `${NOTE_ROOT_LIFECYCLES.join('/')}。`
          + '散落的目录既不会被归档、也不会被判违规，'
          + '还不会计入笔记数，等于凭空多出一份没人管的内容。'
        );
        continue;
      }
      /* `archived/` 里面的形状由 `lib/archive-layout.js` 管，这里不重复判。 */
      if (name !== 'archived') {
        errors.push(...checkLifecycle({ lifecycleDir: join(notesRoot, name), lifecycle: name }));
      }
      continue;
    }

    if (entry.isSymbolicLink()) {
      errors.push(
        `符号链接 ${name} —— 笔记根下只允许真实目录与文件。`
        + '链接既不是 isDirectory() 也不是 isFile()，会被后面两道判断一起跳过，'
        + '等于在门禁视野之外挂进一份内容。'
      );
      continue;
    }

    if (!entry.isFile()) continue;

    if (isJunkFile(name)) {
      errors.push(junkMessage(name, ''));
      continue;
    }
    if (NOTE_IGNORED_FILES.includes(name)) continue;
    if (NOTE_ROOT_FILES.includes(name)) continue;
    if (name.endsWith('.md')) continue;

    errors.push(
      `未知文件 ${name} —— 笔记根下只允许四个 lifecycle 目录、`
      + `根层说明文件（*.md）与 ${NOTE_ROOT_FILES.join('、')}。`
      + '其它文件放在这里不会被任何门禁看见。'
    );
  }

  return { errors };
}

/**
 * 系统垃圾文件的提示。放行与给出通用「未知文件」都不够：用户需要知道怎么办。
 *
 * @param {string} name 文件名。
 * @param {string} where 位置描述（空字符串表示笔记根，否则是相对路径前缀）。
 * @returns {string} 错误行。
 */
function junkMessage(name, where) {
  const at = where === '' ? '' : `（${where}/）`;
  return `系统垃圾文件 ${name}${at} —— 这是操作系统自动生成的，不是内容。`
    + '把它加进 `.gitignore` 并删掉；门禁不会为它开白名单'
    + '（放行等于让垃圾文件名正言顺地进仓库）。';
}

/**
 * 校验一个 lifecycle 目录：子项必须是六个 class 目录之一，再往下只看「是不是笔记文件」。
 *
 * 不判文件名规则、不读内容 —— 那是 vendored 格式门禁的职责，
 * 这里再判一次会出现两个真相。
 *
 * @param {{ lifecycleDir: string, lifecycle: string }} options 选项。
 * @param {string} options.lifecycleDir lifecycle 目录绝对路径。
 * @param {string} options.lifecycle lifecycle 名字（用于报错定位）。
 * @returns {string[]} 错误清单。
 */
function checkLifecycle({ lifecycleDir, lifecycle }) {
  const errors = [];
  let entries;
  try {
    entries = readdirSync(lifecycleDir, { withFileTypes: true });
  } catch (error) {
    return [`读取 ${lifecycle}/ 失败：${error instanceof Error ? error.message : String(error)}`];
  }

  for (const entry of entries) {
    const name = entry.name;
    const rel = `${lifecycle}/${name}`;

    if (entry.isDirectory()) {
      if (!ARCHIVE_CLASSES.includes(name)) {
        errors.push(
          `未知分类目录 ${rel}/ —— ${lifecycle}/ 下只允许六个 class 目录：`
          + `${ARCHIVE_CLASSES.join('/')}。`
          + '分类名是封闭集，写错一个字的目录里的笔记不会被任何门禁看见。'
        );
        continue;
      }
      errors.push(...checkClassDir({ classDir: join(lifecycleDir, name), rel }));
      continue;
    }

    if (entry.isSymbolicLink()) {
      errors.push(
        `符号链接 ${rel} —— ${lifecycle}/ 下只允许真实目录与文件。`
        + '链接会被后面的判断一起跳过，等于在门禁视野之外挂进一份内容。'
      );
      continue;
    }

    if (!entry.isFile()) continue;
    if (isJunkFile(name)) {
      errors.push(junkMessage(name, lifecycle));
      continue;
    }
    if (NOTE_IGNORED_FILES.includes(name)) continue;

    errors.push(
      `散落文件 ${rel} —— ${lifecycle}/ 下只允许六个 class 目录。`
      + '笔记本该放进 `{lifecycle}/{class}/`，放在这一层不会被枚举、不进笔记数、'
      + '也不受格式门禁管辖。'
    );
  }

  return errors;
}

/**
 * 校验一个 class 目录：只允许普通 `.md` 文件与 `.gitkeep`。
 *
 * @param {{ classDir: string, rel: string }} options 选项。
 * @param {string} options.classDir class 目录绝对路径。
 * @param {string} options.rel 相对笔记根的路径（用于报错定位）。
 * @returns {string[]} 错误清单。
 */
function checkClassDir({ classDir, rel }) {
  const errors = [];
  let entries;
  try {
    entries = readdirSync(classDir, { withFileTypes: true });
  } catch (error) {
    return [`读取 ${rel}/ 失败：${error instanceof Error ? error.message : String(error)}`];
  }

  for (const entry of entries) {
    const name = entry.name;
    const path = `${rel}/${name}`;

    if (entry.isDirectory()) {
      errors.push(
        `多余的目录 ${path}/ —— 笔记只放在 \`{lifecycle}/{class}/\` 这一层，`
        + '再深一层不会被枚举，里面的笔记等于不存在。'
      );
      continue;
    }

    if (entry.isSymbolicLink()) {
      errors.push(`符号链接 ${path} —— class 目录下只允许真实文件。`);
      continue;
    }

    if (!entry.isFile()) continue;
    if (isJunkFile(name)) {
      errors.push(junkMessage(name, rel));
      continue;
    }
    if (NOTE_IGNORED_FILES.includes(name)) continue;
    if (name.endsWith('.md')) continue;

    errors.push(
      `非笔记文件 ${path} —— class 目录下只允许 \`.md\` 笔记与 \`.gitkeep\`。`
      + '别的文件既不会被归档、也不进笔记数。'
    );
  }

  return errors;
}
