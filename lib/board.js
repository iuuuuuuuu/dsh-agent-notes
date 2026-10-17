/**
 * 笔记看板的数据层：把 `.agents/notes/` 读成浏览器能渲染的结构。
 *
 * 为什么不用会话投影：投影的 `view` 必须是**同步纯函数**，只能读会话日志
 * 折叠出的 state，读不到文件系统（已核实源码 `view: state => wire.view(state)`）。
 * 笔记内容在磁盘上、且随时可能被编辑器改动，所以走 HTTP 路由实时读，
 * 与 `dsh-better-sidebar` 读文件树的通道一致（`ctx.webServer.register`）。
 *
 * 零依赖：只用 node 内建。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

/** 生命周期目录（archived 单独处理，不进常规列表）。 */
const LIFECYCLES = ['proposed', 'implemented', 'rejected', 'archived'];

/** 合法分类，与上游脚本的封闭集一致。 */
const CLASSES = ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'];

/** 单篇笔记正文上限，防止看板把超大文件整个塞进内存。 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * 解析笔记头块与章节。
 *
 * 只做看板需要的浅解析：标题、Status 行、以及 `## ` 小节标题列表。
 * 不做完整 markdown 渲染 —— 那交给浏览器侧，宿主只给结构化数据。
 *
 * @param {string} text 笔记全文。
 * @returns {{ title: string, status: string, sections: string[], body: string }} 解析结果。
 */
export function parseNote(text) {
  const lines = text.split(/\r?\n/);
  const titleLine = lines.find((line) => /^#\s+/.test(line)) ?? '';
  const title = titleLine.replace(/^#\s+/, '').trim();
  const statusLine = lines.find((line) => /^Status[:：]/.test(line)) ?? '';
  const status = statusLine.replace(/^Status[:：]\s*/, '').trim();
  const sections = [];
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match !== null && match[1] !== undefined) sections.push(match[1]);
  }
  return { title, status, sections, body: text };
}

/**
 * 扫一棵笔记树。
 *
 * 结构固定为 `{lifecycle}/{class}/yyyy-mm-dd-topic.md`；任何不符合深度的
 * 文件都被跳过而不是猜一个分类 —— 看板不该替门禁做判断。
 *
 * @param {string} root 笔记根（`.agents/notes`）。
 * @returns {Array<{ id: string, lifecycle: string, class: string, file: string,
 *   date: string, slug: string, title: string, status: string,
 *   sections: string[], bytes: number, mtimeMs: number, body: string }>} 笔记列表。
 */
export function scanNotes(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const lifecycle of LIFECYCLES) {
    const lifecycleDir = join(root, lifecycle);
    if (!existsSync(lifecycleDir)) continue;
    let classDirs = [];
    try {
      classDirs = readdirSync(lifecycleDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const classDir of classDirs) {
      /* 未知分类不猜：跳过并在结果里不带它，避免看板显示出门禁会拒的东西。 */
      if (!CLASSES.includes(classDir.name)) continue;
      const classPath = join(lifecycleDir, classDir.name);
      let files = [];
      try {
        files = readdirSync(classPath, { withFileTypes: true }).filter((e) => e.isFile());
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.name.endsWith('.md')) continue;
        const full = join(classPath, file.name);
        let stat;
        let text;
        try {
          stat = statSync(full);
          if (stat.size > MAX_BODY_BYTES) continue;
          text = readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        const parsed = parseNote(text);
        const dateMatch = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/.exec(file.name);
        out.push({
          id: `${lifecycle}/${classDir.name}/${file.name}`,
          lifecycle,
          class: classDir.name,
          file: relative(root, full).split('\\').join('/'),
          date: dateMatch?.[1] ?? '',
          slug: dateMatch?.[2] ?? basename(file.name, '.md'),
          title: parsed.title,
          status: parsed.status,
          sections: parsed.sections,
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
          body: parsed.body
        });
      }
    }
  }
  /* 新的在前：看板默认看最近的决策。 */
  out.sort((a, b) => (a.date === b.date ? a.file.localeCompare(b.file) : b.date.localeCompare(a.date)));
  return out;
}

/**
 * 汇总成看板快照。
 *
 * @param {string} root 笔记根。
 * @returns {{ root: string, exists: boolean, total: number,
 *   byLifecycle: Record<string, number>, byClass: Record<string, number>,
 *   notes: ReturnType<typeof scanNotes> }} 快照。
 */
export function buildBoard(root) {
  const notes = scanNotes(root);
  const byLifecycle = {};
  const byClass = {};
  for (const note of notes) {
    byLifecycle[note.lifecycle] = (byLifecycle[note.lifecycle] ?? 0) + 1;
    byClass[note.class] = (byClass[note.class] ?? 0) + 1;
  }
  return { root: resolve(root), exists: existsSync(root), total: notes.length, byLifecycle, byClass, notes };
}
