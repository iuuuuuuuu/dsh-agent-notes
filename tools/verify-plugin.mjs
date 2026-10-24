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

import { checkPublishLayout } from './publish-layout.mjs';
import { buildClientBundle } from '../build.mjs';

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
 * 客户端 bundle 的比对基准。
 *
 * 直接用 `build.mjs` 导出的纯函数，而不是在这里**再抄一份**重建逻辑。
 * 抄一份的后果实测过：把 `build.mjs` 写坏（改掉信封 id 的写法），
 * 这道门禁仍拿自己那份实现去比对磁盘上的 `lib/client.js`，于是照样全绿 ——
 * 门禁正在验证一份和构建脚本可能已经分叉的副本。
 *
 * 目的不是替代构建，而是**比对**：只要 lib/client.js 与这次重建的结果不一致，
 * 就说明「改了 src/client.js 却忘了 build」——那种情况下浏览器跑的是旧代码，
 * 本地测试却全绿，属于典型的假绿。
 *
 * @returns {string} 重建出的 bundle 文本。
 */
function rebuildClientBundle() {
  return buildClientBundle(PACKAGE_ROOT);
}

// 1. 包清单
const pkgFile = join(PACKAGE_ROOT, 'package.json');
check(existsSync(pkgFile), 'package.json 不存在');
const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
// 安装补丁的加载名、包清单名称和客户端信封 id 必须一致。
check(pkg.name === '@iuuuuuuuu/agent-notes', `包名应为 @iuuuuuuuu/agent-notes，实际 ${pkg.name}`);
check(pkg.type === 'module', 'type 必须为 module');
check(typeof pkg.main === 'string' && existsSync(join(PACKAGE_ROOT, pkg.main)), `main 指向的文件不存在: ${pkg.main}`);
check(pkg.license === 'MIT', 'license 应为 MIT');
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch 应指向 ./cordis.patch.yml');
check(Array.isArray(pkg.files) && pkg.files.includes('lib'), 'files 应包含 lib');
check(existsSync(join(PACKAGE_ROOT, pkg.dsh.bundle.patch)), `patch 文件不存在: ${pkg.dsh.bundle.patch}`);

/* 1b. 发布清单与运行时文件必须自洽。
   「仓库里什么都有」与「装出来之后什么都有」是两件事 —— 实测把 `"skills"`
   从 `files` 里删掉，仓库里每条测试仍然全绿，而产物里根本没有 `skills/`，
   插件装上去技能整个消失。所以这里比对的是**产物会包含什么**。 */
for (const problem of checkPublishLayout({ root: PACKAGE_ROOT, pkg })) {
  fail(problem);
}

// 零 @deepseek-ai 运行时依赖
// optionalDependencies 也算运行时依赖：它在安装时真的会被写进 profile，
// 所以「只查 dependencies + peerDependencies」会漏掉这一格。
// devDependencies 故意不查：它不进安装产物，查了会把 legit 的工具链依赖
// （spdx-expression-parse）误报成违规。
const depNames = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {})
];
const deepseekDeps = depNames.filter((name) => name.startsWith('@deepseek-ai/'));
check(deepseekDeps.length === 0, `不得声明 @deepseek-ai 依赖（profile 无法解析它们），实际: ${deepseekDeps.join(', ')}`);

// 2. cordis.patch.yml
const patchFile = join(PACKAGE_ROOT, 'cordis.patch.yml');
check(existsSync(patchFile), 'cordis.patch.yml 不存在');
if (existsSync(patchFile)) {
  const patch = readFileSync(patchFile, 'utf8');
  check(patch.includes('id: agent-notes'), 'patch 应插入 id: agent-notes 的行');

  /* 配置里的「凭据 / 端点内联」：这份 patch 会随包发布并被宿主直接加载。
     `!!js` 表达式和 `process.env` 读取既不可审计也不可复现 —— 装在不同机器
     上会组成不同的插件树，而 manifest 里看不出来。上游把这条做成了独立门禁
     （verify-config-source-ownership），本地只有一份 patch，就在这里查。 */
  check(!/!!js\b/.test(patch), 'cordis.patch.yml 不得使用 !!js 内联表达式（改为静态值）');
  check(!/process\.env/.test(patch), 'cordis.patch.yml 不得内联 process.env 读取');

  const loaderNames = [...patch.matchAll(/^\s+name:\s*["']([^"']+)["']\s*$/gm)].map((match) => match[1]);
  check(loaderNames.length === 1 && loaderNames[0] === pkg.name, `patch 的加载名必须等于包名 ${pkg.name}，实际 ${loaderNames.join(', ') || '未找到'}`);
}

// 3. lib 模块：语法 + 零 @deepseek-ai 引用
const libDir = join(PACKAGE_ROOT, 'lib');
check(existsSync(libDir), 'lib 目录不存在');
/**
 * 递归收集目录下的文件。
 *
 * 原来只扫 `lib/*.js` 一层：一旦有人把模块挪进 `lib/sub/`，那个文件就
 * 完全不在检查范围内 —— 这是「门禁只覆盖了一半，另一半没人知道」的经典形态。
 *
 * @param {string} dir 起始目录。
 * @param {(name: string) => boolean} [accept] 文件名过滤器，缺省全收。
 * @returns {string[]} 绝对路径列表。
 */
function collectFiles(dir, accept = () => true) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectFiles(full, accept));
    else if (accept(entry.name)) found.push(full);
  }
  return found;
}
const moduleFiles = collectFiles(libDir, (name) => name.endsWith('.js'));
check(moduleFiles.length >= 7, `lib 下模块过少（${moduleFiles.length}），可能有文件缺失`);
for (const file of moduleFiles) {
  const source = readFileSync(file, 'utf8');
  /* 四种引用形态都要查，缺一种就是一道后门：
     - 静态 `import ... from 'x'` / `export ... from 'x'`
     - 副作用 `import 'x'`
     - 动态 `import('x')`
     - CommonJS `require('x')`（宿主可能用 require 加载，混进 lib 就解析不到）
     只查 `from` 会漏掉后三种 —— 而它们恰恰是最不容易被肉眼发现的。 */
  const patterns = [
    /\bfrom\s*['"](@deepseek-ai\/[^'"]+)['"]/g,
    /\bimport\s*['"](@deepseek-ai\/[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](@deepseek-ai\/[^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"](@deepseek-ai\/[^'"]+)['"]\s*\)/g
  ];
  const badImports = [...new Set(patterns.flatMap((re) => [...source.matchAll(re)].map((match) => match[1])))];
  /* 失败信息里的路径统一用 `/`：Windows 上 `relative()` 给的是反斜杠，
     同一处缺陷在不同平台会打出两种文本，人肉比对与断言都会因此打架。 */
  check(badImports.length === 0, `${relative(PACKAGE_ROOT, file).split('\\').join('/')} 引入了不可解析的依赖: ${badImports.join(', ')}`);
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
  const rebuilt = rebuildClientBundle();
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

/* 5b. 生命周期白名单：插件侧必须与 vendored 逐字一致。
 *
 * 两份名单天然共存：vendored 是只读哈希受管副本，`lib/notes-layout.js`
 * 不能 import 它的常量（.ts + 哈希门禁）。于是上游改了 `ROOT_ALLOWLIST`、
 * 插件这边没跟，就会出现「同一棵树 vendored 全绿、插件判红」——
 * 而这正是本轮修掉的那个假红，只是换了个触发条件。
 *
 * CodeRabbit 在 PR #44 上点名过这一点：「仅把检查加入 sync:check 不足以覆盖常规门禁」。
 * 所以放进 `npm run verify`（在 `npm run check` 链里）。
 */
function readListFromSource(text, pattern, label) {
  const m = pattern.exec(text);
  if (m === null) return undefined;
  const names = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]);
  if (names.length === 0) fail(`${label}：括号里一个名字都没解析到`);
  return names.sort();
}
const treeSrc = readFileSync(join(skillDir, 'scripts', 'agent-note-tree.ts'), 'utf8');
const layoutSrc = readFileSync(join(PACKAGE_ROOT, 'lib', 'notes-layout.js'), 'utf8');
const vendoredAllow = readListFromSource(
  treeSrc, /ROOT_ALLOWLIST\s*=\s*new Set\(\s*\[([^\]]*)\]\s*\)/, 'vendored ROOT_ALLOWLIST'
);
const pluginAllow = readListFromSource(
  layoutSrc, /LIFECYCLE_ROOT_GUIDES\s*=\s*Object\.freeze\(\s*\[([^\]]*)\]\s*\)/, 'lib/notes-layout.js LIFECYCLE_ROOT_GUIDES'
);
check(vendoredAllow !== undefined, '解析不到 vendored 的 ROOT_ALLOWLIST —— 上游可能改了写法，请更新这条门禁');
check(pluginAllow !== undefined, '解析不到 lib/notes-layout.js 的 LIFECYCLE_ROOT_GUIDES');
if (vendoredAllow !== undefined && pluginAllow !== undefined) {
  check(
    vendoredAllow.join(',') === pluginAllow.join(','),
    `生命周期根层白名单不一致：vendored=[${vendoredAllow.join(', ')}]，`
    + `插件=[${pluginAllow.join(', ')}] —— 会让同一棵树出现「vendored 绿 / 插件红」`
  );
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

  /* 清单是「自我信任根」的补丁：manifest 自己写着 ref，谁也没核对过它。
     上游换了 commit、而有人只跑了 `sync-upstream --yes` 之外的路径手改
     manifest，这里就会红。upstream.json 是人工维护的意图声明，manifest 是
     推导产物 —— 两者不一致说明「推导产物已不再代表那个意图」。 */
  const intentFile = join(PACKAGE_ROOT, 'upstream.json');
  check(existsSync(intentFile), 'upstream.json 不存在（上游意图声明）');
  if (existsSync(intentFile)) {
    const intent = JSON.parse(readFileSync(intentFile, 'utf8'));
    check(
      typeof intent.ref === 'string' && intent.ref === manifest.ref,
      `upstream.json.ref(${intent.ref}) 与 upstream-manifest.json.ref(${manifest.ref}) 不一致 —— 清单不再代表那个上游快照`
    );
    const manifestCount = Object.keys(manifest.files ?? {}).length;
    check(
      intent.fileCount === manifestCount,
      `upstream.json.fileCount(${intent.fileCount}) 与清单条目数(${manifestCount}) 不一致`
    );
  }

  /* 磁盘多出来的文件：单向比对永远发现不了。
     手拷进来一个上游文件、或者上游删了而本地留着，都会让「vendored 内容
     等于上游」这句话失效，且该文件从此**不再受哈希管辖**（清单里没有它）。

     唯一的例外是运行期状态标记 `.synced-version`：它由 `lib/self-update.js`
     在宿主里写入、被 `.gitignore` 忽略，从来不是上游内容。把它当违规会让
     每一台跑过一次自更新的机器都变红 —— 那种门禁最后一定被 --no-verify 绕过，
     所以这里显式放行，并保留「清单外还有没有别的东西」这层检查。 */
  /* ★ 白名单本身必须防腐（上游 `verify-package-readme-limitations.ts:24,34-45`
     就是这么做的：条目必须命中一个被扫到的包、理由必须非空，否则报
     「renamed or removed? update …」）。只写 `new Set(['.synced-version'])` 的话，
     等哪天真没有写者了，这条豁免会永久静默地放行同名脏文件，而没人会发现。
     所以改成「名字 → 理由」映射，并要求**名字在 lib/ 源码里真的有写者**。 */
  const RUNTIME_ARTIFACTS = {
    '.synced-version': 'lib/self-update.js 运行期写入的上游版本标记，不在 upstream-manifest.json 里',
  };
  for (const [name, reason] of Object.entries(RUNTIME_ARTIFACTS)) {
    check(typeof reason === 'string' && reason.trim().length > 0,
      `运行期产物白名单条目 ${name} 没有写理由（它凭什么豁免哈希管辖？）`);
    const hasWriter = moduleFiles.some((file) => readFileSync(file, 'utf8').includes(name));
    check(hasWriter,
      `运行期产物白名单条目 ${name} 在 lib/ 里找不到任何写者 —— 是不是已废弃？请同步删除这条豁免`);
  }
  const declared = new Set(Object.keys(manifest.files ?? {}));
  const orphans = collectFiles(skillDir)
    .map((abs) => relative(skillDir, abs).split('\\').join('/'))
    .filter((rel) => !declared.has(rel) && !(rel in RUNTIME_ARTIFACTS));
  check(orphans.length === 0, `vendored 目录存在清单外的文件（不受哈希管辖）: ${orphans.join(', ')}`);

  console.log(`上游清单比对: ${compared} 个文件一致`);
}

if (problems.length > 0) {
  console.error(`自检未通过（${problems.length} 项）:`);
  for (const problem of problems) console.error(`  ✖ ${problem}`);
  process.exit(1);
}
console.log('自检通过：包清单、patch 一致性、零 @deepseek-ai 依赖、双语文档与 dsh 徽标、vendored 内容及上游哈希均一致。');
