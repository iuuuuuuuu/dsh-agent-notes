#!/usr/bin/env node
/**
 * 发布清单（`package.json` 的 `files` / `exports`）与运行时文件的一致性判据。
 *
 * ## 这个文件解决什么
 *
 * 上游 `deepseek-ai/deepseek-harness` 的 `scripts/verify-package-meta.ts:66-74`
 * 有一层「发布选择」判据（`published()`）：**凡是运行时需要的文件，都必须被
 * `files` 覆盖**，否则报 `files must include <file>`（`:201-202`、`:236-237`）。
 *
 * 本仓库原先只有一句 `files 应包含 lib`（`tools/verify-plugin.mjs:83`）。
 * 实测两种改坏方式**全都是绿灯**：
 *
 *   1. 把 `"skills"` 从 `files` 里删掉 → `npm pack --dry-run` 显示**产物里没有
 *      `skills/`**，而 `lib/skill.js:21`、`lib/notes.js:27`、`lib/self-update.js:212`
 *      都在运行时从包根读 `skills/agent-notes` —— 装上去的插件**技能整个消失**，
 *      而仓库里的每一条测试仍然全绿（它们测的是仓库，不是产物）。
 *   2. 给 `exports` 加一条指向不存在文件的子路径 → 消费者
 *      `import '@iuuuuuuuu/agent-notes/probe-missing'` 得到 `MODULE_NOT_FOUND`。
 *
 * 这类缺陷的共同点是：**发布出去的东西和仓库里的东西不是一回事**，
 * 而仓库里的测试全都只测仓库里的东西。所以这道判据必须比对「产物会包含什么」，
 * 而不是「仓库里有什么」。
 *
 * ## 边界
 *
 * - 只做**机械可判定**的部分：路径存不存在、是否被 `files` 覆盖。
 * - 不解析 npm 的完整 `files` 语义（`.npmignore`、`.gitignore` 优先级、
 *   `alwaysIncluded` 的历史行为等）。这里实现的是 npm 文档里那条主规则：
 *   条目是目录就整棵目录进去，条目是 glob 就按 glob 匹配。
 * - npm **总是**发布 `package.json`、`README*`、`LICENSE*`、`NOTICE*`，
 *   无论 `files` 写没写 —— 这几个是豁免，否则会造出假红。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包根（`tools/` 的上一级）。 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** npm 恒定包含的文件（与 `files` 无关）。 */
const ALWAYS_PUBLISHED = /^(package\.json|readme[^/]*|licen[sc]e[^/]*|notice[^/]*)$/i;

/**
 * 归一化路径：统一成 `/`、去掉前导 `./` 与尾部 `/`。
 *
 * @param {string} value 原始路径或模式。
 * @returns {string} 归一化结果。
 */
export function normalizePattern(value) {
  return String(value)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/**
 * 把 glob 模式转成正则。
 *
 * 只支持三种通配：`?`（单个非斜杠字符）、`*`（单层）、`**`（跨层）。
 * 其余字符按字面量处理。
 *
 * @param {string} pattern glob 模式。
 * @returns {RegExp} 匹配整串路径的正则。
 */
function globToRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      source += '[^/]';
      continue;
    }
    if ('\\^$.|+()[]{}'.includes(ch)) {
      source += '\\' + ch;
      continue;
    }
    source += ch;
  }
  return new RegExp('^' + source + '$');
}

/**
 * 一个 `files` 条目是否覆盖某个仓库内相对路径。
 *
 * 规则（与 npm 主语义一致）：
 * - 无通配符的条目按**目录前缀**覆盖：`lib` 覆盖 `lib/index.js`；
 * - 有通配符的条目按 glob 匹配，并且目录形态的 glob 额外覆盖整棵子树。
 *
 * @param {string} pattern `files` 里的一条。
 * @param {string} file 仓库内相对路径。
 * @returns {boolean} 是否覆盖。
 */
export function coversFile(pattern, file) {
  const p = normalizePattern(pattern);
  const f = normalizePattern(file);
  if (p === '' || p === '.') return true;
  if (!/[*?]/.test(p)) return f === p || f.startsWith(p + '/');
  if (globToRegExp(p).test(f)) return true;
  return globToRegExp(`${p}/**`).test(f);
}

/**
 * 某个路径是否会被 `files` 发布出去。
 *
 * @param {string[]} files `package.json` 的 `files` 数组。
 * @param {string} file 仓库内相对路径。
 * @returns {boolean} 是否被发布。
 */
export function isPublished(files, file) {
  const f = normalizePattern(file);
  if (ALWAYS_PUBLISHED.test(f.split('/').pop() ?? '')) return true;
  return (files ?? []).some((pattern) => coversFile(pattern, f));
}

/**
 * 收集 `exports` 里声明的全部字符串目标。
 *
 * `exports` 的值可能是字符串、数组，或条件对象（`{"default": "./x.js"}`）。
 * 条件对象里**每个**分支都是一次可能的解析目标，所以全部都要能落地 ——
 * 少查一个分支，就等于允许「在某些条件下装出来的包是坏的」。
 *
 * @param {unknown} value `exports` 的值。
 * @param {string[]} [out] 收集结果。
 * @returns {string[]} 目标列表。
 */
export function collectExportTargets(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExportTargets(item, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectExportTargets(item, out);
  }
  return out;
}

/**
 * 递归列出目录下的全部文件（仓库相对路径）。
 *
 * @param {string} root 仓库根。
 * @param {string} rel 目录的仓库相对路径。
 * @param {string[]} [out] 收集结果。
 * @returns {string[]} 文件列表。
 */
function listFiles(root, rel, out = []) {
  const dir = join(root, ...rel.split('/'));
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) listFiles(root, child, out);
    else out.push(child);
  }
  return out;
}

/**
 * 运行时真正需要的文件集合。
 *
 * 推导依据（全部来自代码，不是手写的清单）：
 * - `lib/**` —— 插件本体，`package.json` 的 `main` 指向其中一份；
 * - `skills/agent-notes/**` —— vendored 技能，`lib/skill.js:21`、
 *   `lib/notes.js:27`、`lib/self-update.js:212` 都在运行时从包根读它。
 *
 * @param {string} root 仓库根。
 * @returns {string[]} 文件列表。
 */
export function runtimeFiles(root) {
  return [...listFiles(root, 'lib'), ...listFiles(root, 'skills/agent-notes')];
}

/**
 * 校验发布清单与运行时文件是否自洽。
 *
 * @param {{ root: string, pkg: Record<string, any> }} input 输入。
 * @returns {string[]} 问题列表（空数组表示通过）。
 */
export function checkPublishLayout({ root, pkg }) {
  const problems = [];
  const files = Array.isArray(pkg.files) ? pkg.files : [];

  /* 一、每条 `files` 条目必须在磁盘上存在。
     不存在的条目被 npm **静默忽略**：拼错一个目录名，产物就少一整棵树，
     而仓库里什么都不会红。 */
  for (const entry of files) {
    const rel = normalizePattern(entry);
    if (rel === '' || /[*?]/.test(rel)) continue;
    if (!existsSync(join(root, ...rel.split('/')))) {
      problems.push(`files 条目 "${entry}" 在磁盘上不存在 —— npm 会静默忽略它，这一项等于没写`);
    }
  }

  /* 二、`exports` 的每个目标必须存在，且必须会被发布。
     存在但没被发布 ⇒ 安装后 `import` 报 `MODULE_NOT_FOUND`。 */
  for (const target of collectExportTargets(pkg.exports ?? {})) {
    if (!target.startsWith('./')) continue;
    const rel = normalizePattern(target);
    if (!existsSync(join(root, ...rel.split('/')))) {
      problems.push(`exports 目标 "${target}" 在磁盘上不存在`);
      continue;
    }
    if (!isPublished(files, rel)) {
      problems.push(`exports 目标 "${target}" 没有被 files 覆盖 —— 装出来之后 import 会失败`);
    }
  }

  /* 三、`main` 与 patch 都必须会被发布。 */
  if (typeof pkg.main === 'string') {
    const rel = normalizePattern(pkg.main);
    if (!isPublished(files, rel)) {
      problems.push(`main "${pkg.main}" 没有被 files 覆盖 —— 装出来之后 require 会失败`);
    }
  }
  const patch = pkg.dsh?.bundle?.patch;
  if (typeof patch === 'string' && patch.startsWith('./')) {
    const rel = normalizePattern(patch);
    if (!isPublished(files, rel)) {
      problems.push(`dsh.bundle.patch "${patch}" 没有被 files 覆盖 —— 装出来之后宿主加载不到插件`);
    }
  }

  /* 四、运行时需要的每一个文件都必须会被发布。 */
  for (const file of runtimeFiles(root)) {
    if (!isPublished(files, file)) {
      problems.push(`运行时文件 "${file}" 没有被 files 覆盖 —— 装出来之后插件跑不起来`);
    }
  }

  return problems;
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

function main() {
  const root = PACKAGE_ROOT;
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const problems = checkPublishLayout({ root, pkg });
  if (problems.length === 0) {
    console.log('发布清单通过：files / exports / main / patch 与运行时文件一致。');
    process.exit(0);
  }
  console.error(`发布清单校验失败：${problems.length} 处`);
  for (const problem of problems) console.error(`  ✖ ${problem}`);
  process.exit(1);
}

const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replace(/\\/g, '/').endsWith('/tools/publish-layout.mjs');
if (invokedDirectly) main();
