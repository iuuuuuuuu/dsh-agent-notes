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
 *
 * 其余任何路径项（未知目录、未知后缀的文件、`.json` / `.yml` 等）直接判失败。
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
      }
      continue;
    }

    if (!entry.isFile()) continue;

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
