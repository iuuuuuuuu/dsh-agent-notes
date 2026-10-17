/**
 * 技能 provider：把 vendored 的 Agent Notes 方法论暴露成 DSH 技能。
 *
 * 与官方 @deepseek-ai/dsh-skill-badge 同构：`list()` 返回候选，`get()` 读正文。
 * 区别是我们读的是本包 `skills/agent-notes/` 下的 vendored 内容，因此
 * references/ 与 templates/ 的相对引用天然可解析（resourceBase 指向该目录）。
 *
 * 正文要剥掉 YAML frontmatter：DSH 的 SkillDefinition.content 约定是
 * 「去掉 provider 私有元数据之后的 Markdown 正文」。
 *
 * 零依赖：frontmatter 只在首尾 `---` 之间，手写极小解析，不引 yaml 包。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本包根目录。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** vendored 技能目录。 */
export const SKILL_DIR = join(PACKAGE_ROOT, 'skills', 'agent-notes');

/** 技能入口文件。 */
export const SKILL_FILE = join(SKILL_DIR, 'SKILL.md');

/** 注册到 ctx.skills 的 provider 名。 */
export const PROVIDER_NAME = 'agent-notes';

/**
 * 对外暴露的技能名。
 *
 * 插件、命令、工具统一用 `agent-notes`，避免同一个东西三个名字。
 */
export const SKILL_NAME = 'agent-notes';

/** bundled 层秩：与上游 skill-filesystem 的 BUNDLED_SKILL_RANK 一致，
 *  让项目级/用户级同名技能可以覆盖本插件。 */
const BUNDLED_SKILL_RANK = 600;

/**
 * 拆出 frontmatter 与正文。
 *
 * 只认首行 `---` 开头的 YAML 头；不做通用 YAML 解析，只按 `key:` 取顶层标量，
 * 这对 SKILL.md 的 `name` / `description` 足够，且不会因引号风格差异崩。
 *
 * @param {string} raw 原始文件内容。
 * @returns {{ data: Record<string,string>, body: string }} 头字段与正文。
 */
export function parseFrontmatter(raw) {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  if (lines.length === 0 || lines[0].trim() !== '---') return { data: {}, body: text.trim() };

  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      closing = index;
      break;
    }
  }
  if (closing < 0) return { data: {}, body: text.trim() };

  const data = {};
  for (const line of lines.slice(1, closing)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[match[1]] = value;
  }
  return { data, body: lines.slice(closing + 1).join('\n').trim() };
}

/**
 * 读 vendored 技能的抬头信息。
 *
 * @returns {{ name: string, description: string, body: string }} 技能元数据与正文。
 */
export function readSkill() {
  const raw = readFileSync(SKILL_FILE, 'utf8');
  const { data, body } = parseFrontmatter(raw);
  return {
    name: SKILL_NAME,
    description: typeof data.description === 'string' && data.description.trim() !== ''
      ? data.description.trim()
      : '决策笔记方法论：非平凡改动前写下为什么这样改、放弃了什么，并用机械门禁校验。',
    body
  };
}

/**
 * 创建技能 provider。
 *
 * @returns {{ name: string, list: Function, get: Function }} provider 实例。
 */
export function createSkillProvider(control) {
  const candidate = () => {
    const info = readSkill();
    return {
      name: SKILL_NAME,
      description: info.description,
      /** 面向模型与用户都可调用：技能既能被模型按需加载，也能被 / 调用。 */
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'bundled',
      provider: PROVIDER_NAME,
      rank: BUNDLED_SKILL_RANK,
      path: SKILL_FILE,
      locator: SKILL_FILE,
      resourceBase: { kind: 'directory', path: dirname(SKILL_FILE) }
    };
  };

  return {
    name: PROVIDER_NAME,

    /** 列出候选；技能文件缺失时返回空目录而不是抛（插件仍可加载）。 */
    async list() {
      if (!existsSync(SKILL_FILE)) return { candidates: [], complete: true };
      return { candidates: [candidate()], complete: true };
    },

    /** 读完整技能定义，正文已剥掉 frontmatter。 */
    async get() {
      if (!existsSync(SKILL_FILE)) return undefined;
      const info = readSkill();
      return {
        ...candidate(),
        description: info.description,
        content: info.body,
        metadata: { upstream: 'czm15053/write-notes-like-deepseek' }
      };
    },

    /**
     * 让宿主丢弃缓存的技能目录并通知消费者重新取。
     *
     * 这是自更新的热替换通道：文件被换掉后调一次，模型下次加载就拿新内容。
     * `control` 由宿主在注册时给入，且只在本次注册仍有效时可调 —— 这里
     * 再加一层保护，避免注册已销毁时调用。
     */
    invalidate() {
      if (control === undefined || typeof control.invalidate !== 'function') return;
      try {
        control.invalidate();
      } catch {
        /* 注册已失效时宿主会拒绝；不影响已经写好的文件。 */
      }
    }
  };
}
