/**
 * 项目内技能副本的落后检测。
 *
 * 背景：除了插件自带的 `skills/agent-notes/`，项目仓库里通常还有一份
 * `.agents/skills/agent-notes/`（被项目 git 跟踪，供项目自己的 CI 门禁使用）。
 * 插件自更新**只管自己那份**，项目这份不会被覆盖 —— 它属于项目仓库的正式内容，
 * 插件擅自改写会在用户的仓库里制造未提交改动，并让本地与 CI 跑不同版本。
 *
 * 所以这里只做**检测**：算出项目副本与插件副本的差异，交给调用方去提示。
 * 真正写入由用户主动触发的命令完成（见 commands.js 的 sync-skill）。
 *
 * 零依赖：只用 node 内建。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本包根目录。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 插件自带副本（技能内容的权威来源）。 */
export const BUNDLED_SKILL_DIR = join(PACKAGE_ROOT, 'skills', 'agent-notes');

/** 项目内副本相对项目根的位置。 */
export const PROJECT_SKILL_REL = join('.agents', 'skills', 'agent-notes');

/** 项目内技能目录（其下每个子目录是一份技能副本）。 */
const PROJECT_SKILLS_DIR = join('.agents', 'skills');

/** 本插件仓库自己的技能目录（包源码布局，不是项目副本）。 */
const PACKAGE_SKILL_REL = join('skills', 'agent-notes');

/**
 * 这个仓库在用决策笔记吗？（看板 tab 要不要出现）
 *
 * **判据只有一条：项目里装了这套技能。**
 *
 *   ① \`.agents/skills/\` 下有名字含 \`notes\` 的技能目录
 *      —— \`agent-notes\` 是当前名，\`write-notes-like-deepseek\` 是上游旧名，
 *      两者都是真实的项目副本形态；
 *   ② 或者它就是这个插件的仓库（根目录 \`skills/agent-notes/\`）。
 *
 * ## 为什么不再把 \`.agents/notes\` 当判据（2026-11-12 修）
 *
 * 第一版写成「有笔记树 **或** 有技能副本」，理由是「刚建了笔记树也说明在用」。
 * 实测被 Owner 当场指出：**没有装 skill 的目录也出现了看板 tab**。
 * 判据一旦放宽到「磁盘上碰巧有个 notes 目录」，就等于让任何曾经跑过门禁、
 * 留下 \`.agents/notes\` 的仓库都冒出看板 —— 而它们并没有装这套方法。
 *
 * 所以判据回到 Owner 的原话：**工作目录里存在 agent-notes 的 skill**。
 * 笔记树只是技能产出物，不是安装凭据。
 *
 * @param {string | undefined} projectCwd 会话工作目录。
 * @returns {boolean} 是否装了这套技能。
 */
export function projectUsesNotes(projectCwd) {
  if (typeof projectCwd !== 'string' || projectCwd.trim() === '') return false;
  try {
    if (existsSync(join(projectCwd, PACKAGE_SKILL_REL))) return true;
  } catch {
    /* 读不到继续看项目副本 */
  }
  try {
    for (const entry of readdirSync(join(projectCwd, PROJECT_SKILLS_DIR), { withFileTypes: true })) {
      if (entry.isDirectory() && /notes/i.test(entry.name)) return true;
    }
  } catch {
    /* 没有 .agents/skills：就是没装 */
  }
  return false;
}

/**
 * 递归列出目录下所有文件的相对路径。
 *
 * @param {string} dir 根目录。
 * @param {string} [base] 递归基准（内部用）。
 * @returns {string[]} 相对路径列表（用 `/` 分隔，便于跨平台比较）。
 */
function listFiles(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, base));
    } else if (entry.isFile()) {
      /* 统一成 `/`：Windows 的 `\` 会让相对路径比较失败。 */
      out.push(relative(base, full).split(sep).join('/'));
    }
  }
  return out.sort();
}

/**
 * 读文件内容；读不到返回 undefined。
 *
 * @param {string} file 绝对路径。
 * @returns {string | undefined} 内容。
 */
function readIfExists(file) {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

export function inspectProjectSkillCopy(projectCwd) {
  const projectDir = resolve(projectCwd, PROJECT_SKILL_REL);
  const result = {
    present: false,
    behind: false,
    changed: [],
    missing: [],
    extra: [],
    projectDir
  };
  if (typeof projectCwd !== 'string' || projectCwd === '') return result;
  if (!existsSync(projectDir)) return result;
  /* 目录存在但里面没有 SKILL.md，说明只是个空壳或别的东西，不算「有副本」。 */
  if (!existsSync(join(projectDir, 'SKILL.md'))) return result;
  result.present = true;

  const bundled = new Set(listFiles(BUNDLED_SKILL_DIR));
  const project = new Set(listFiles(projectDir));

  for (const rel of bundled) {
    const want = readIfExists(join(BUNDLED_SKILL_DIR, rel));
    if (!project.has(rel)) {
      result.missing.push(rel);
      continue;
    }
    const have = readIfExists(join(projectDir, rel));
    if (have !== want) result.changed.push(rel);
  }
  for (const rel of project) {
    if (!bundled.has(rel)) result.extra.push(rel);
  }

  result.changed.sort();
  result.missing.sort();
  result.extra.sort();
  /* `extra` 不计入 behind：项目可能自己加了东西，那不是「落后」。 */
  result.behind = result.changed.length > 0 || result.missing.length > 0;
  return result;
}

/**
 * 把检测结果压成一句给模型看的话；无需提示时返回 undefined。
 *
 * 写进系统提示词的东西每一轮都在付费，所以这里只说「落后了、要不要问用户」，
 * 不复述文件清单 —— 细节由命令输出承担。
 *
 * @param {ReturnType<typeof inspectProjectSkillCopy>} info 检测结果。
 * @returns {string | undefined} 提示文本。
 */
export function buildDriftHint(info) {
  if (info === undefined || !info.present || !info.behind) return undefined;
  const total = info.changed.length + info.missing.length;
  return `# 决策笔记：项目副本落后
本项目 \`.agents/skills/agent-notes/\` 与插件内置版本有 ${total} 个文件不一致
（改 ${info.changed.length}、缺 ${info.missing.length}）。
这份副本归项目仓库所有，插件不会擅自改动。**动手前先问用户是否要更新**；
用户同意后运行 \`/agent-notes sync-skill\`（它会打印改动，需再确认才落盘）。`;
}

/** 便于测试：项目副本里若有这些文件说明是完整副本。 */
export const REQUIRED_MARKER = 'SKILL.md';

/**
 * 把插件内置副本写入项目目录。
 *
 * 只写有差异的文件，**不删除**项目里多出来的文件（`extra`）—— 那可能是用户
 * 自己加的，删掉属于破坏性操作，不该由一次同步顺带做掉。
 *
 * @param {string} projectCwd 项目根目录。
 * @param {{ dryRun?: boolean }} [options] dryRun 时只报告不写。
 * @returns {{ written: string[], skipped: string[], kept: string[], projectDir: string }}
 *   written=实际写入（或将要写入）的文件，skipped=内容已一致，kept=留在项目里的额外文件。
 */
export function syncProjectSkillCopy(projectCwd, options = {}) {
  const dryRun = options.dryRun === true;
  const info = inspectProjectSkillCopy(projectCwd);
  const written = [];
  const skipped = [];

  if (!info.present) {
    return { written, skipped, kept: [], projectDir: info.projectDir };
  }

  const diffs = [...info.changed, ...info.missing];
  const identical = [...listFiles(BUNDLED_SKILL_DIR)].filter((rel) => !diffs.includes(rel));

  for (const rel of diffs) {
    const source = join(BUNDLED_SKILL_DIR, rel);
    const content = readIfExists(source);
    if (content === undefined) continue;
    if (!dryRun) {
      const target = join(info.projectDir, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
    }
    written.push(rel);
  }
  skipped.push(...identical);

  return { written, skipped, kept: info.extra, projectDir: info.projectDir };
}
