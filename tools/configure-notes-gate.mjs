#!/usr/bin/env node
/**
 * 把一个仓库的「笔记门禁配套」升级到本插件当前这一版。
 *
 * ## 为什么需要这个工具
 *
 * 真实项目的现状是：每个仓库各自拷了一份 vendored 脚本（`.agents/skills/<技能名>/scripts/`
 * 或 `.agents/notes-scripts/`），拷过去之后就再没人同步。实测 5 个在用仓库里有 4 份
 * **仍然是未修复版**的格式门禁，会把行内代码里的 `<!--` 当成 HTML 注释、
 * 把合法笔记判红（那正是 sourin-flutter-spike 踩过并自己打补丁的缺陷）。
 *
 * 手工拷文件解决不了这个问题：下次还是得手工。所以做成一条命令：
 *
 *   node tools/configure-notes-gate.mjs --root <目标仓库> [--dry-run] [--check]
 *
 * ## 它改什么、不改什么
 *
 * - **改**：`scripts/` 下的 vendored 脚本（含执行期补丁后的内容）、`assets/` 下的看板模板、
 *   以及（新建时）`SKILL.md` / `references/` / `templates/`。
 * - **不改**：目标仓库自己的 `.agents/notes/`（那是他的内容）、自己的门禁壳
 *   （`notes-gate.mjs`）、自己的额外脚本（`notes-coverage.mjs` 等）。
 * - **布局沿用目标仓库已有的**：有 `.agents/notes-scripts/` 就用它（assets 放 `.agents/assets/`，
 *   因为 `build-board.ts` 按 `../assets/` 找模板）；否则用官方的
 *   `.agents/skills/agent-notes/`。
 *
 * ## 退出码
 *
 * 0 = 已是最新（或已写入）；1 = `--check` 下发现有差异；2 = 无法进行（参数/IO 问题）。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { patchVendoredScript } from '../lib/vendored-patch.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_SKILL = join(PACKAGE_ROOT, 'skills', 'agent-notes');

/** 判定「这个技能目录是完整的一套」所需的最小文件集。 */
const COMPLETE_SET = [
  'agent-note-tree.ts',
  'verify-agent-note-tree.ts',
  'verify-agent-note-format.ts',
  'verify-archived-agent-notes.ts'
];

/** 会被写进目标仓库的文件（相对 skill 目录）。 */
const SCRIPT_FILES = [
  'scripts/agent-note-tree.ts',
  'scripts/verify-agent-note-tree.ts',
  'scripts/verify-agent-note-format.ts',
  'scripts/verify-archived-agent-notes.ts',
  'scripts/archive-agent-note.ts',
  'scripts/build-board.ts',
  'scripts/check-note-anchors.ts'
];

/**
 * 解析命令行。
 *
 * @param {string[]} argv 参数。
 * @returns {{ root?: string, dryRun: boolean, check: boolean, help: boolean }} 解析结果。
 */
export function parseArgs(argv) {
  const out = { root: undefined, dryRun: false, check: false, force: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.trim() === '') throw new Error('--root 需要一个路径');
      out.root = value.trim();
      i += 1;
    } else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--check') out.check = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return out;
}

/**
 * 决定目标仓库用哪套布局。
 *
 * 沿用已有的：`.agents/notes-scripts/` 优先于官方技能目录 —— 因为用那种布局的仓库
 * 往往把项目专用脚本也放在同一目录（`notes-coverage.mjs` 之类），换目录会让它们失联。
 * `build-board.ts` 按 `../assets/agent-notes-board.html` 找模板，所以 assets 必须是与
 * scripts **同级**的兄弟目录。
 *
 * @param {string} root 目标仓库根。
 * @returns {{ scriptsDir: string, assetsDir: string, layout: string }} 目标目录。
 */
export function resolveLayout(root) {
  const skillsRoot = join(root, '.agents', 'skills');
  /* 1) 已经有一套**完整**的官方/旧技能目录 → 用它。
     实测 WorkbuddySwitchAPi/wt-port 同时存在 `.agents/notes-scripts/`（那边是**刻意的本地
     分叉**：修过「全零 sha 静默通过」）与完整技能目录。这种情况下要更新的是技能目录，
     不能去动分叉区 —— 覆盖别人的修正比「版本旧」糟得多。 */
  if (existsSync(skillsRoot)) {
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const scripts = join(skillsRoot, entry.name, 'scripts');
      const complete = COMPLETE_SET.every((name) => existsSync(join(scripts, name)));
      if (complete) {
        return { scriptsDir: scripts, assetsDir: join(skillsRoot, entry.name, 'assets'), layout: `skills/${entry.name}` };
      }
    }
  }
  /* 2) 只有手工组装的 notes-scripts（assets 必须是与它同级的兄弟目录，
        因为 build-board.ts 按 `../assets/` 找模板）。 */
  const legacy = join(root, '.agents', 'notes-scripts');
  if (existsSync(legacy) && statSync(legacy).isDirectory()) {
    return { scriptsDir: legacy, assetsDir: join(root, '.agents', 'assets'), layout: 'notes-scripts' };
  }
  /* 3) 全新配置。 */
  const official = join(root, '.agents', 'skills', 'agent-notes');
  return {
    scriptsDir: join(official, 'scripts'),
    assetsDir: join(official, 'assets'),
    layout: 'skills/agent-notes'
  };
}

/**
 * 算出一份「应当写入」的文件清单与内容（先算后写，便于 `--check` / `--dry-run`）。
 *
 * @param {string} root 目标仓库根。
 * @returns {{ files: Array<{ path: string, content: Buffer | string, patched: string[] }>, layout: string }} 计划。
 */
export function buildPlan(root, options = {}) {
  const { scriptsDir, assetsDir, layout } = resolveLayout(root);
  const files = [];
  const skipped = [];

  for (const rel of SCRIPT_FILES) {
    const from = join(SOURCE_SKILL, ...rel.split('/'));
    if (!existsSync(from)) continue;
    const name = rel.split('/').pop();
    const original = readFileSync(from, 'utf8');
    const { code, applied, missed } = patchVendoredScript(name, original);

    /* 判定「目标仓库这一份能不能直接覆盖」：
       - 不存在 → 写入（新配置）
       - 与我们要写的逐字相同 → 写入也无副作用
       - **与「未打补丁的原文」逐字相同** → 说明它就是本插件的旧副本，升级是纯修复，可覆盖
       - 其它情况 → **本地改过**，跳过（除非 --force）。实测 WorkbuddySwitchAPi/wt-port 的
         `verify-archived-agent-notes.ts` 就是刻意的本地分叉（修了全零 sha 静默通过），
         覆盖它等于把人家的修正抹掉。 */
    const targetPath = join(scriptsDir, name);
    const existing = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : undefined;
    const isStock = existing === undefined || existing === original || existing === code;
    if (!isStock && options.force !== true) {
      skipped.push({ path: targetPath, reason: '本地改过（与上游/补丁版本都不同），跳过；要覆盖请加 --force' });
      continue;
    }
    if (missed.length > 0) {
      /* 补丁锚点对不上：仍然写入未打补丁的原文，但这里必须让人看见 ——
         否则目标仓库会拿到一份「看起来最新、其实缺了修复」的脚本。 */
      process.stderr.write(
        `[configure-notes-gate] 警告：${name} 的补丁未命中（${missed.join('；')}），将写入未打补丁的原文\n`
      );
    }
    files.push({
      path: targetPath,
      content: applied.length > 0 ? code : original,
      patched: applied
    });
  }

  /* 看板模板：build-board.ts 按 `../assets/agent-notes-board.html` 找它。 */
  const board = join(SOURCE_SKILL, 'assets', 'agent-notes-board.html');
  if (existsSync(board)) files.push({ path: join(assetsDir, 'agent-notes-board.html'), content: readFileSync(board), patched: [] });

  /* 其余配套（SKILL.md / references / templates）只在官方布局下补齐，且**不覆盖已存在的内容** ——
     有些仓库把它们改成了自己的版本。 */
  if (layout === 'skills/agent-notes') {
    const skillRoot = join(root, '.agents', 'skills', 'agent-notes');
    for (const rel of ['SKILL.md']) {
      const from = join(SOURCE_SKILL, rel);
      if (existsSync(from)) files.push({ path: join(skillRoot, rel), content: readFileSync(from), patched: [] });
    }
    for (const dirName of ['references', 'templates']) {
      const srcDir = join(SOURCE_SKILL, dirName);
      if (!existsSync(srcDir)) continue;
      for (const name of readdirSync(srcDir)) {
        const from = join(srcDir, name);
        if (!statSync(from).isFile()) continue;
        files.push({ path: join(skillRoot, dirName, name), content: readFileSync(from), patched: [] });
      }
    }
  }

  return { files, skipped, layout };
}

/**
 * 比较计划与磁盘现状。
 *
 * @param {Array<{ path: string, content: Buffer | string }>} files 计划。
 * @returns {{ changed: string[], same: string[] }} 需要写的与已一致的（绝对路径）。
 */
export function diffPlan(files) {
  const changed = [];
  const same = [];
  for (const file of files) {
    const current = existsSync(file.path) ? readFileSync(file.path) : undefined;
    const want = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    if (current === undefined || !current.equals(want)) changed.push(file.path);
    else same.push(file.path);
  }
  return { changed, same };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`✖ ${error.message}\n`);
    process.exit(2);
  }
  if (args.help || args.root === undefined) {
    process.stdout.write([
      '用法: node tools/configure-notes-gate.mjs --root <目标仓库> [--dry-run] [--check]',
      '',
      '  --dry-run  只打印将要写入/新建的文件，不落盘',
      '  --check    有差异即退出 1（适合放进 CI 防止配套落后）',
      '  --force    连「本地改过」的文件一起覆盖（默认跳过它们）',
      '',
      '布局沿用目标仓库已有的 .agents/notes-scripts/；没有则用 .agents/skills/agent-notes/。',
      '不触碰目标仓库的 .agents/notes/ 与其自己的门禁壳/额外脚本。'
    ].join('\n') + '\n');
    process.exit(args.help ? 0 : 2);
  }

  const root = resolve(args.root);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    process.stderr.write(`✖ 目标仓库不存在或不是目录: ${root}\n`);
    process.exit(2);
  }

  const { files, skipped, layout } = buildPlan(root, { force: args.force === true });
  const { changed, same } = diffPlan(files);

  process.stdout.write(`布局: ${layout}\n`);
  process.stdout.write(`配套文件: ${files.length} 个（一致 ${same.length}，需更新 ${changed.length}）\n`);

  if (args.check) {
    for (const path of changed) process.stdout.write(`  需更新 ${path}\n`);
    process.exit(changed.length > 0 ? 1 : 0);
  }

  if (args.dryRun) {
    for (const path of changed) process.stdout.write(`  将写入 ${path}\n`);
    process.exit(0);
  }

  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    writeFileSync(file.path, content);
  }
  const patched = files.filter((file) => file.patched.length > 0).map((file) => `${file.path}（${file.patched.join('、')}）`);
  for (const line of patched) process.stdout.write(`  已打补丁 ${line}\n`);
  process.stdout.write(`已写入 ${files.length} 个文件。\n`);
  process.exit(0);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
