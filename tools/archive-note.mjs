/**
 * 归档时改写笔记里的相对链接 —— 补 `archive-agent-note.ts` 的缺口。
 *
 * ## 缺口（读源码确认）
 *
 * `skills/agent-notes/scripts/archive-agent-note.ts:83`：
 *
 *     const updatedContent = lines.join("\n");
 *
 * 它移动文件前只做**头部规范化**（去掉 `# Agent Note:` 前缀），
 * **完全没动正文里的相对链接**。
 *
 * 而 `:127-155` 只**扫描入向**链接并打印提示
 * （「Please review and update their relative markdown links if necessary」），
 * 出向链接完全不管 —— 而出向链接正是会断的那批。
 *
 * ## 后果（实测）
 *
 * 归档把笔记从 `implemented/<class>/x.md` 移到 `archived/<class>/x.md`，
 * 深度不变但路径段变了 → `../bug-fix/y.md` 解析成 `archived/bug-fix/y.md`
 * → 不存在。实测那唯一一篇归档笔记就有 1 条这种断链。
 *
 * ## 顺序：先改写、再调上游脚本（关键）
 *
 * ★ 封印在归档那一刻被计算。若「先归档、再改链接」，哈希就对不上，
 *   `verify-archived-agent-notes` 报 `seal mismatch` ——
 *   而重算 manifest 等于「授权改封印」，那与封印的意义直接冲突。
 *
 * 所以本工具的顺序是：
 *
 *   1. 读原笔记
 *   2. **在内存里**把相对链接改写成归档后的形式
 *   3. 写回**原路径**（文件还在原处，链接仍有效，只是更深）
 *   4. 调上游 `archive-agent-note.ts` 归档 → 它算封印时看到的是改写后内容
 *   5. 封印天然一致，无需重算
 *
 * ★ 第 3 步失败也安全：位置没变，链接仍能解析。
 *
 * ## 改写规则
 *
 * `../bug-fix/y.md`（在 `implemented/simplification/` 里）
 *   → `../../implemented/bug-fix/y.md`（在 `archived/simplification/` 里）
 *
 * 因为笔记根不变，只是中间那层从 `implemented` 变成 `archived`。
 *
 * ## 刻意不碰的
 *
 *   · **代码块内的内容** —— 笔记里贴示例 Markdown 完全合法（本仓就有一篇），
 *     改它就是**篡改历史内容**
 *   · 绝对 URL / 协议相对 / 纯锚点 —— 不指向本仓库文件
 *   · 指向笔记树**之外**的路径（如仓库根 README）—— 它的解析基准没变，
 *     改了反而错
 *   · 已经是正确形式的目标 —— 幂等
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* tools/archive-note.mjs → tools/ → 仓库根。两层 dirname，不是三层。 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const UPSTREAM_ARCHIVE = join(
  PACKAGE_ROOT, 'skills', 'agent-notes', 'scripts', 'archive-agent-note.ts'
);

/**
 * 只对**围栏代码块之外**的行应用变换。
 *
 * @param {string} content 原文。
 * @param {(line: string) => string} fn 逐行变换。
 * @returns {string} 处理后的文本。
 */
export function replaceOutsideFences(content, fn) {
  const lines = content.split('\n');
  const out = [];
  let inFence = false;
  let fenceMark = '';

  for (const line of lines) {
    const m = /^\s*(```|~~~)/.exec(line);
    if (m !== null) {
      if (!inFence) { inFence = true; fenceMark = m[1]; }
      else if (m[1] === fenceMark) { inFence = false; }
      out.push(line);           /* 围栏行本身不动 */
      continue;
    }
    out.push(inFence ? line : fn(line));
  }
  return out.join('\n');
}

/**
 * 改写单个链接目标；不适用时原样返回。
 *
 * @param {string} target 链接目标。
 * @param {string} fromDir 改写前的解析基准目录。
 * @param {string} toDir 改写后的解析基准目录。
 * @param {string} notesRoot 笔记根目录。
 * @returns {string} 改写后的目标；未变时返回原值。
 */
function rewriteOne(target, fromDir, toDir, notesRoot) {
  if (target === '') return target;
  if (target.startsWith('#')) return target;
  if (target.startsWith('//')) return target;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return target;

  /* fragment 与 query 不参与路径解析。 */
  let cut = target.length;
  const hashAt = target.indexOf('#');
  const queryAt = target.indexOf('?');
  if (hashAt !== -1) cut = Math.min(cut, hashAt);
  if (queryAt !== -1) cut = Math.min(cut, queryAt);
  const pathPart = target.slice(0, cut);
  const suffix = target.slice(cut);
  if (pathPart === '') return target;

  const absolute = resolve(fromDir, pathPart);

  /* 指向笔记树之外的（仓库根 README 等）—— 基准没变，不该改。 */
  const notesRootAbs = resolve(notesRoot);
  const inTree = relative(notesRootAbs, absolute).replace(/\\/g, '/');
  if (inTree.startsWith('..')) return target;

  const rewritten = relative(toDir, absolute).replace(/\\/g, '/');
  if (rewritten === pathPart) return target;
  /* 跨盘符时 relative 会给绝对路径 —— 那说明目标不在同一棵树里。 */
  if (/^[a-z]:/i.test(rewritten)) return target;

  return rewritten + suffix;
}

/**
 * 把一段 markdown 里的相对链接改写成「从归档后的位置也能解析」的形式。
 *
 * @param {string} content 笔记原文（归档**前**）。
 * @param {string} fromDir 归档**前**该笔记所在目录。
 * @param {string} toDir 归档**后**该笔记所在目录。
 * @param {string} notesRoot 笔记根目录。
 * @returns {{ content: string, changed: number }} 改写结果与条数。
 */
export function rewriteRelativeLinks(content, fromDir, toDir, notesRoot) {
  let changed = 0;
  const out = replaceOutsideFences(content, (line) => line.replace(
    /(!?\[[^\]]*\]\(\s*)(<?)([^)\s>]+)(>?)(\s*(?:"[^"]*")?\s*\))/g,
    (whole, head, open, target, close, tail) => {
      const rewritten = rewriteOne(target, fromDir, toDir, notesRoot);
      if (rewritten === target) return whole;
      changed += 1;
      return `${head}${open}${rewritten}${close}${tail}`;
    }
  ));
  return { content: out, changed };
}

/**
 * 归档入口：先改写链接，再调上游脚本完成归档与封印。
 *
 * @param {string[]} argv 命令行参数（笔记路径 + 可选 `--superseded-by`）。
 * @returns {number} 退出码。
 */
export function archiveWithLinkRewrite(argv) {
  const targetArg = argv[0];
  if (targetArg === undefined) {
    console.error('用法: node tools/archive-note.mjs <path-to-note> [--superseded-by <new-note-path>]');
    return 2;
  }

  const targetPath = resolve(process.cwd(), targetArg);
  if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
    console.error(`找不到待归档笔记: ${targetPath}`);
    return 1;
  }

  /* ★ notes 根从**目标路径**推导，不用脚本自身位置。
       路径形状是 `{notesRoot}/implemented/<class>/<file>`，往上两级就是根。
     写死 `PACKAGE_ROOT/.agents/notes` 有两个问题：
       1. 测试在沙箱里跑时必然不匹配（实测：故障注入直接被护栏拦下）
       2. 用户在**别的仓库**归档笔记时会被误判为「路径不对」 */
  const fromDir = dirname(targetPath);
  const notesRoot = dirname(dirname(fromDir));
  const relFromRoot = relative(notesRoot, targetPath).replace(/\\/g, '/');
  const parts = relFromRoot.split('/');
  if (parts[0] !== 'implemented' || parts.length !== 3) {
    console.error(`只能归档 implemented/<class>/<file>.md，实际: ${relFromRoot}`);
    return 1;
  }
  const cls = parts[1];

  const toDir = join(notesRoot, 'archived', cls);

  const original = readFileSync(targetPath, 'utf8');
  const { content, changed } = rewriteRelativeLinks(original, fromDir, toDir, notesRoot);

  if (changed > 0) {
    writeFileSync(targetPath, content, 'utf8');
    console.log(`已改写 ${changed} 条相对链接，使其在归档后仍可解析。`);
    for (const m of original.matchAll(/\]\((\.[^)]+)\)/g)) {
      const now = new RegExp(
        '\\]\\(' + m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\)'
      );
      if (now.test(content)) continue;
      const after = [...content.matchAll(/\]\(([^)\s]+)\)/g)]
        .map((x) => x[1]);
      console.log(`  ${m[1]} → ${after.find((t) => !original.includes(t)) ?? '(见上)'}`);
    }
  } else {
    console.log('无需改写链接（没有会因归档而失效的相对链接）。');
  }

  /* ★ 顺序关键：此刻 targetPath 里已是改写后的内容。上游脚本会读它、
     算封印、再移动 —— 封印因此与最终内容一致，无需重算 manifest。

     AGENT_NOTE_ROOT 显式传过去：上游 `agent-note-tree.ts` 默认从 cwd 解析
     `.agents/notes`，而这里的目标可能属于**别的仓库**（或测试沙箱），
     cwd 兜不住。 */
  const r = spawnSync(process.execPath, [UPSTREAM_ARCHIVE, ...argv], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, AGENT_NOTE_ROOT: notesRoot }
  });
  process.stdout.write(r.stdout ?? '');
  process.stderr.write(r.stderr ?? '');
  if (r.status !== 0) {
    console.error('\n★ 上游归档脚本失败 —— 链接已改写但文件仍在原位置，链接仍可解析。');
    return r.status === null ? 1 : r.status;
  }
  console.log('\n归档完成：链接已同步改写，封印一致。');
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replace(/\\/g, '/').endsWith('/tools/archive-note.mjs');

if (invokedDirectly) {
  process.exit(archiveWithLinkRewrite(process.argv.slice(2)));
}