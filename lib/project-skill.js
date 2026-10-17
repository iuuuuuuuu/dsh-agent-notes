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

/**
 * 检测项目副本相对插件副本的差异。
 *
 * @param {string} projectCwd 项目根目录（会话 cwd）。
 * @returns {{
 *   present: boolean,
 *   behind: boolean,
 *   changed: string[],
 *   missing: string[],
 *   extra: string[],
 *   projectDir: string
 * }} 检测结果：
 *   - `present` 项目里是否有这份副本（没有就不该提示，用户可能故意不复制）
 *   - `behind` 是否需要更新
 *   - `changed` 内容不同的文件
 *   - `missing` 插件有、项目缺的文件
 *   - `extra` 项目有、插件没有的文件（可能用户自己加的，不自动删）
 */
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
