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

/** 块标量起始行：`|`/`>`，可带 chomping（`+`/`-`）与缩进指示符，其后只能有空白或注释。 */
const BLOCK_SCALAR = /^([|>])([+-]?)(\d*)\s*(?:#.*)?$/;

/**
 * 切掉行尾注释。
 *
 * YAML 的注释规则是「`#` 前必须有空白，且不在引号内」。这条必须按引号状态扫描，
 * 不能直接 `split('#')` —— `description: "a # b"` 里的 `#` 是值本身。
 *
 * @param {string} text 单行文本。
 * @returns {string} 去掉注释后的文本。
 */
function stripTrailingComment(text) {
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === '') {
      if (char === '"' || char === "'") quote = char;
      else if (char === '#' && (index === 0 || /\s/.test(text[index - 1]))) return text.slice(0, index);
      continue;
    }
    if (quote === '"' && char === '\\') {
      index += 1;
      continue;
    }
    if (char === quote) {
      /* 单引号里 `''` 是转义的单引号，不算闭合。 */
      if (quote === "'" && text[index + 1] === "'") {
        index += 1;
        continue;
      }
      quote = '';
    }
  }
  return text;
}

/**
 * 解掉引号并还原转义。
 *
 * @param {string} text 以引号开头的文本。
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }} 解析结果。
 */
function parseQuoted(text) {
  const quote = text[0];
  let value = '';
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    if (quote === '"' && char === '\\') {
      const next = text[index + 1];
      const escapes = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '0': '\0' };
      value += Object.hasOwn(escapes, next) ? escapes[next] : next;
      index += 1;
      continue;
    }
    if (char === quote) {
      if (quote === "'" && text[index + 1] === "'") {
        value += "'";
        index += 1;
        continue;
      }
      return { ok: true, value };
    }
    value += char;
  }
  return { ok: false, reason: '引号未闭合' };
}

/**
 * 拆出 frontmatter 与正文。
 *
 * 只认首行 `---` 开头的 YAML 头，且只建模 SKILL.md 需要的顶层标量：
 * 普通标量、单双引号、行尾注释、`|`/`>` 块标量。
 *
 * **刻意不引 `yaml` 包**，但也**不假装能解析任意 YAML**：遇到嵌套映射/序列这类
 * 本解析器不建模的写法，记进 `warnings` 交给调用方，而不是静默给出半截值。
 * 宿主 `@deepseek-ai/dsh-skill-filesystem` 用真 YAML 读同一份文件，两边口径
 * 不一致就会让模型看到错的描述 —— 所以宁可显式报告「没解析」。
 *
 * @param {string} raw 原始文件内容。
 * @returns {{ data: Record<string,string>, body: string, warnings: string[] }} 头字段、正文、未解析项。
 */
export function parseFrontmatter(raw) {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  if (lines.length === 0 || lines[0].trim() !== '---') return { data: {}, body: text.trim(), warnings: [] };

  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      closing = index;
      break;
    }
  }
  if (closing < 0) return { data: {}, body: text.trim(), warnings: ['frontmatter 缺少闭合的 ---'] };

  const data = {};
  const warnings = [];
  let index = 1;
  while (index < closing) {
    const line = lines[index];
    const lineNumber = index + 1;
    index += 1;

    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const match = /^([A-Za-z0-9_-]+):(?:[ \t](.*))?$/.exec(line);
    if (match === null) {
      /* 缩进行属于上一个键的嵌套内容；本解析器不建模，明确报告而不是当成新键。 */
      if (/^[ \t]+\S/.test(line)) {
        warnings.push(`第 ${lineNumber} 行是嵌套内容，本解析器不建模（宿主用真 YAML 读，会得到不同结果）`);
      } else {
        warnings.push(`第 ${lineNumber} 行不是 "键: 值" 形状，已跳过`);
      }
      continue;
    }

    const key = match[1];
    const rawValue = stripTrailingComment(match[2] ?? '').trim();

    const block = BLOCK_SCALAR.exec(rawValue);
    if (block !== null) {
      /* 块标量：吃掉后续所有缩进或空行，直到缩进回退。 */
      const bodyLines = [];
      while (index < closing) {
        const next = lines[index];
        if (next.trim() !== '' && !/^[ \t]/.test(next)) break;
        bodyLines.push(next);
        index += 1;
      }
      const indents = bodyLines.filter((l) => l.trim() !== '').map((l) => /^[ \t]*/.exec(l)[0].length);
      const indent = indents.length > 0 ? Math.min(...indents) : 0;
      const content = bodyLines.map((l) => l.slice(indent));
      const folded = block[1] === '>';
      const chomp = block[2];

      /* chomping：`-` 去掉尾部换行，`+` 全保留，默认（clip）保留一个。 */
      if (chomp !== '+') {
        while (content.length > 0 && content[content.length - 1].trim() === '') content.pop();
      }

      let value = folded
        ? content.join(' ').replace(/[ \t]+/g, ' ').trim()
        : content.join('\n');
      if (content.length > 0) value += '\n';
      if (chomp === '-') value = value.replace(/\n+$/, '');
      data[key] = value;
      continue;
    }

    if (rawValue.startsWith('"') || rawValue.startsWith("'")) {
      const quoted = parseQuoted(rawValue);
      if (!quoted.ok) {
        warnings.push(`第 ${lineNumber} 行（${key}）${quoted.reason}`);
        continue;
      }
      data[key] = quoted.value;
      continue;
    }

    /* 普通标量里出现 ": " 会让真 YAML 报错（`notes: write them`），不能当值收下。 */
    if (/: /.test(rawValue)) {
      warnings.push(`第 ${lineNumber} 行（${key}）普通标量里含 ": "，真 YAML 会拒绝`);
      continue;
    }
    data[key] = rawValue;
  }

  return { data, body: lines.slice(closing + 1).join('\n').trim(), warnings };
}

/**
 * 读 vendored 技能的抬头信息。
 *
 * 解析告警写到 stderr 而不是静默丢弃：宿主用真 YAML 读同一份文件，
 * 我们这边「没解析出来」时，模型看到的描述会和文件里写的不是一回事。
 *
 * @returns {{ name: string, description: string, body: string, warnings: string[] }} 元数据与正文。
 */
export function readSkill() {
  const raw = readFileSync(SKILL_FILE, 'utf8');
  const { data, body, warnings } = parseFrontmatter(raw);
  if (warnings.length > 0 && process.env.DSH_AGENT_NOTES_QUIET !== '1') {
    for (const warning of warnings) {
      process.stderr.write(`[agent-notes] SKILL.md frontmatter：${warning}\n`);
    }
  }
  return {
    name: SKILL_NAME,
    description: typeof data.description === 'string' && data.description.trim() !== ''
      ? data.description.trim()
      : '决策笔记方法论：非平凡改动前写下为什么这样改、放弃了什么，并用机械门禁校验。',
    body,
    warnings
  };
}

/**
 * 创建技能 provider。
 *
 * @param {object} control 宿主控制面。只用鸭子类型读取，不 import DSH 类型包。
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
