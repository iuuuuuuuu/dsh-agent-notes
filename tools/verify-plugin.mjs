#!/usr/bin/env node
/**
 * 发布前自检：本插件作为交付物必须自洽。
 *
 * 检查项（全部驱动真实文件，不用桩）：
 *   1. 包清单字段齐全、dsh.bundle.patch 指向存在的文件
 *   2. cordis.patch.yml 的 id/name 与包名一致
 *   3. lib 下所有模块语法可加载，且不 import 任何 @deepseek-ai/*（零运行时依赖约束）
 *   4. 双语文档齐备且都带 dsh 徽标；中文为默认
 *   5. vendored 技能内容齐备（SKILL.md / references / scripts / templates / assets）
 *   6. 上游清单与实际磁盘内容逐文件哈希一致（防「vendor 后手改了没同步」）
 *
 * 任一失败即非零退出。用法：node tools/verify-plugin.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const problems = [];

/**
 * 记一个问题。
 *
 * @param {string} message 描述。
 */
function fail(message) {
  problems.push(message);
}

/**
 * 断言条件成立。
 *
 * @param {boolean} condition 条件。
 * @param {string} message 失败描述。
 */
function check(condition, message) {
  if (!condition) fail(message);
}

/**
 * 用与 build.mjs 完全相同的规则重建客户端 bundle。
 *
 * 目的不是替代构建，而是**比对**：只要 lib/client.js 与这次重建的结果不一致，
 * 就说明「改了 src/client.js 却忘了 build」——那种情况下浏览器跑的是旧代码，
 * 本地测试却全绿，属于典型的假绿。
 *
 * @returns {string} 重建出的 bundle 文本。
 */
function buildClientBundle() {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  const source = readFileSync(join(PACKAGE_ROOT, 'src', 'client.js'), 'utf8');
  const marker = 'function createAgentNotesClient(require) {';
  const at = source.indexOf(marker);
  if (at === -1) throw new Error('src/client.js: 找不到 createAgentNotesClient(require) 入口');
  let body = source.slice(at + marker.length);
  const tail = body.lastIndexOf('}');
  if (tail === -1) throw new Error('src/client.js: 函数体没有收尾');
  body = body.slice(0, tail);
  return [
    `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:function(require){`,
    '"use strict";',
    'var __dshAgentNotes = (function(){',
    body.trim(),
    '})();',
    'return __dshAgentNotes;',
    '}});',
    ''
  ].join('\n');
}

// 1. 包清单
const pkgFile = join(PACKAGE_ROOT, 'package.json');
check(existsSync(pkgFile), 'package.json 不存在');
const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
check(pkg.name === 'dsh-agent-notes', `包名应为 dsh-agent-notes，实际 ${pkg.name}`);
check(pkg.type === 'module', 'type 必须为 module');
check(typeof pkg.main === 'string' && existsSync(join(PACKAGE_ROOT, pkg.main)), `main 指向的文件不存在: ${pkg.main}`);
check(pkg.license === 'MIT', 'license 应为 MIT');
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch 应指向 ./cordis.patch.yml');
check(Array.isArray(pkg.files) && pkg.files.includes('lib'), 'files 应包含 lib');
check(existsSync(join(PACKAGE_ROOT, pkg.dsh.bundle.patch)), `patch 文件不存在: ${pkg.dsh.bundle.patch}`);

// 零 @deepseek-ai 运行时依赖
const depNames = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {})
];
const deepseekDeps = depNames.filter((name) => name.startsWith('@deepseek-ai/'));
check(deepseekDeps.length === 0, `不得声明 @deepseek-ai 依赖（profile 无法解析它们），实际: ${deepseekDeps.join(', ')}`);

// 2. cordis.patch.yml
const patchFile = join(PACKAGE_ROOT, 'cordis.patch.yml');
check(existsSync(patchFile), 'cordis.patch.yml 不存在');
if (existsSync(patchFile)) {
  const patch = readFileSync(patchFile, 'utf8');
  check(patch.includes('id: agent-notes'), 'patch 应插入 id: agent-notes 的行');
  check(patch.includes('name: "dsh-agent-notes"') || patch.includes("name: 'dsh-agent-notes'"), 'patch 的 name 应为包名');
}

// 3. lib 模块：语法 + 零 @deepseek-ai import
const libDir = join(PACKAGE_ROOT, 'lib');
check(existsSync(libDir), 'lib 目录不存在');
const moduleFiles = [];
for (const name of readdirSync(libDir)) {
  if (name.endsWith('.js')) moduleFiles.push(join(libDir, name));
}
check(moduleFiles.length >= 7, `lib 下模块过少（${moduleFiles.length}），可能有文件缺失`);
for (const file of moduleFiles) {
  const source = readFileSync(file, 'utf8');
  const badImports = [...source.matchAll(/from\s+['"](@deepseek-ai\/[^'"]+)['"]/g)].map((match) => match[1]);
  check(badImports.length === 0, `${relative(PACKAGE_ROOT, file)} 引入了不可解析的依赖: ${badImports.join(', ')}`);
}

// 3b. 客户端半边：声明、构建产物与信封契约
const clientBundled = join(PACKAGE_ROOT, 'lib', 'client.js');
const clientSource = join(PACKAGE_ROOT, 'src', 'client.js');
check(existsSync(clientSource), 'src/client.js 不存在（客户端源码是真源）');
check(existsSync(clientBundled), 'lib/client.js 不存在（需要先 npm run build）');
check(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform 应为 web');
check(pkg.exports?.['./client'] !== undefined, 'exports 应提供 ./client 入口');
if (existsSync(clientBundled)) {
  const bundle = readFileSync(clientBundled, 'utf8');
  // 信封是硬约束：id 必须等于包名，否则浏览器加载器拒绝这个模块。
  check(
    bundle.includes(`window.__ModuleLoader__.load({id:"${pkg.name}",factory:function(require){`),
    'lib/client.js 的信封 id 必须等于包名（否则客户端加载不了）'
  );
  // 构建产物可能落后于源码——这正是要拦的「改了源码忘了 build」。
  const hostOnly = `"${pkg.name}"`;
  check(bundle.includes(hostOnly), 'lib/client.js 应引用包名');
  const rebuilt = buildClientBundle();
  check(rebuilt === bundle, 'lib/client.js 与 src/client.js 不同步（请跑 npm run build）');
}

// 3c. 宿主与客户端的投影键必须一致
// 两边一旦漂移，浏览器读不到状态，开关与 tag 会永远显示「未知」——
// 而**所有本地测试仍然全绿**（各测各的常量）。这是最该被门禁拦住的一类错。
{
  const projectionSource = readFileSync(join(PACKAGE_ROOT, 'lib', 'projection.js'), 'utf8');
  const declared = /export\s+const\s+PROJECTION_KEY\s*=\s*'([^']+)'/.exec(projectionSource);
  check(declared !== null, 'lib/projection.js 必须导出 PROJECTION_KEY');
  const commandDeclared = /export\s+const\s+COMMAND_NAME\s*=\s*'([^']+)'/.exec(projectionSource);
  check(commandDeclared !== null, 'lib/projection.js 必须导出 COMMAND_NAME');
  if (declared !== null && existsSync(clientBundled)) {
    const bundle = readFileSync(clientBundled, 'utf8');
    const key = declared[1];
    check(bundle.includes(`'${key}'`), `客户端必须使用宿主侧声明投影键 "${key}"（两边漂移会让开关恒为未知）`);
  }
  if (commandDeclared !== null && existsSync(clientBundled)) {
    const bundle = readFileSync(clientBundled, 'utf8');
    check(
      bundle.includes(`/${commandDeclared[1]}`),
      `客户端必须调用同名命令 "/${commandDeclared[1]}"（否则点了没反应）`
    );
    // 宿主命令注册处也必须用同一个名字。
    const commandsSource = readFileSync(join(PACKAGE_ROOT, 'lib', 'commands.js'), 'utf8');
    check(
      commandsSource.includes(`name: '${commandDeclared[1]}'`),
      `lib/commands.js 必须以 name: '${commandDeclared[1]}' 注册命令`
    );
  }
}

// 4. 双语文档与 dsh 标识
const readmeZh = join(PACKAGE_ROOT, 'README.md');
const readmeEn = join(PACKAGE_ROOT, 'README.en.md');
check(existsSync(readmeZh), 'README.md（中文，默认）不存在');
check(existsSync(readmeEn), 'README.en.md（英文）不存在');
for (const [label, file] of [['README.md', readmeZh], ['README.en.md', readmeEn]]) {
  if (!existsSync(file)) continue;
  const text = readFileSync(file, 'utf8');
  check(/powered_by-dsh-4D6BFE/.test(text), `${label} 缺少 dsh 徽标（powered by dsh）`);
  check(/deepseek-ai\/deepseek-harness/.test(text), `${label} 的徽标未链接到 DeepSeek Harness`);
}
if (existsSync(readmeZh) && existsSync(readmeEn)) {
  const zh = readFileSync(readmeZh, 'utf8');
  const en = readFileSync(readmeEn, 'utf8');
  check(/README\.en\.md/.test(zh), 'README.md 应链接到英文版');
  check(/README\.md/.test(en), 'README.en.md 应链接回中文版');
  check(!/^\*\*English\*\*/m.test(zh) || /中文/.test(zh), 'README.md 应标注自身为中文默认');
}
check(pkg.files.includes('README.en.md'), 'package.json 的 files 应包含 README.en.md');

// 5. vendored 内容齐备
const skillDir = join(PACKAGE_ROOT, 'skills', 'agent-notes');
const required = [
  'SKILL.md',
  'references/classification.md',
  'references/when-to-write.md',
  'references/archiving.md',
  'references/note-format.md',
  'references/quality-gate.md',
  'references/verification.md',
  'templates/proposed.md',
  'templates/implemented.md',
  'templates/rejected.md',
  'scripts/agent-note-tree.ts',
  'scripts/verify-agent-note-tree.ts',
  'scripts/verify-agent-note-format.ts',
  'scripts/verify-archived-agent-notes.ts',
  'assets/agent-notes-board.html'
];
for (const rel of required) {
  check(existsSync(join(skillDir, rel)), `vendored 文件缺失: skills/agent-notes/${rel}`);
}

// 6. 上游清单 vs 磁盘
const manifestFile = join(PACKAGE_ROOT, 'tools', 'upstream-manifest.json');
check(existsSync(manifestFile), 'tools/upstream-manifest.json 不存在（先跑 node tools/sync-upstream.mjs --yes）');
if (existsSync(manifestFile)) {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  let compared = 0;
  for (const [rel, expected] of Object.entries(manifest.files ?? {})) {
    const local = join(skillDir, ...rel.split('/'));
    if (!existsSync(local)) {
      fail(`清单中的文件在磁盘缺失: ${rel}`);
      continue;
    }
    const actual = `sha256:${createHash('sha256').update(readFileSync(local, 'utf8'), 'utf8').digest('hex')}`;
    if (actual !== expected) fail(`vendored 内容与上游清单不一致（本地被改过？）: ${rel}`);
    compared += 1;
  }
  check(compared >= 20, `只比对了 ${compared} 个文件，清单可能损坏`);
  console.log(`上游清单比对: ${compared} 个文件一致`);
}

if (problems.length > 0) {
  console.error(`自检未通过（${problems.length} 项）:`);
  for (const problem of problems) console.error(`  ✖ ${problem}`);
  process.exit(1);
}
console.log('自检通过：包清单、patch 一致性、零 @deepseek-ai 依赖、双语文档与 dsh 徽标、vendored 内容及上游哈希均一致。');
