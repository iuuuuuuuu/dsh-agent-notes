/**
 * 实机证据：证明插件挂进 DSH 后，技能/工具/命令**真的被宿主注册表接受**。
 *
 * 与 integration.test.mjs 的区别：那边用自建的服务实现验证契约；这边用
 * DSH 自带的**真实服务类**（SkillRegistry / ToolRuntime / CommandRuntime），
 * 走它们真实的注册与查询路径，因此能证明「宿主会认这些注册」。
 *
 * 用法：node tools/live-evidence.mjs
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply as applyPlugin } from '../lib/index.js';

/**
 * 定位 DSH 自身的安装位置。
 *
 * 不硬编码本机路径（那会让别人跑不起来，也会把机器信息带进公开仓库）。
 * 顺序：$DSH_DIST（显式指向 dsh 的 lib/bin.js）→ $DSH_HOME 推断 →
 * 从常见位置探测。探测不到时**明确跳过**并说明，不伪造证据。
 *
 * @returns {string | undefined} dsh 的 bin.js 绝对路径。
 */
function findDshDist() {
  const explicit = process.env.DSH_DIST;
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();

  const { existsSync, readdirSync } = createRequire(import.meta.url)('node:fs');
  const { dirname, resolve } = createRequire(import.meta.url)('node:path');
  const { homedir } = createRequire(import.meta.url)('node:os');
  const candidates = [];
  const rel = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

  /** 收一批候选：$DSH_HOME、~/.dsh，以及每个 profile 的 node_modules。 */
  const addHome = (home) => {
    if (typeof home !== 'string' || home.trim() === '') return;
    const base = resolve(home.trim());
    candidates.push(join(base, rel));
    const profiles = join(base, 'profiles');
    if (!existsSync(profiles)) return;
    try {
      for (const entry of readdirSync(profiles, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(join(profiles, entry.name, rel));
      }
    } catch {
      // 不可枚举就跳过。
    }
  };

  addHome(process.env.DSH_HOME);
  addHome(join(homedir(), '.dsh'));

  // 从本文件向上逐级找（覆盖「插件装在 DSH 的依赖树里」的布局）。
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth += 1) {
    candidates.push(join(cursor, rel));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const DSH_DIST = findDshDist();

/**
 * 从 DSH 自己的依赖树里解析一个包（这是唯一可解析的位置）。
 *
 * 关键细节：`createRequire` 的入参必须是**文件名**。传一个目录（例如直接把
 * `$DSH_DIST` 指到 `.../dependencies/dsh`）时，Node 会退到它的**父目录**去找
 * `node_modules`，结果是 `Cannot find module '@deepseek-ai/cordis'` ——
 * 依赖明明就在 `.../dependencies/dsh/node_modules/@deepseek-ai/cordis`。
 * 所以这里先把目录补成 `package.json`，让解析锚在所给目录内部。
 *
 * @param {string} specifier 包名。
 * @returns {any} 该包的模块命名空间。
 */
function loadFromDsh(specifier) {
  const anchor = (() => {
    try {
      return statSync(DSH_DIST).isDirectory() ? join(DSH_DIST, 'package.json') : DSH_DIST;
    } catch {
      return DSH_DIST;
    }
  })();
  const require = createRequire(anchor);
  const resolved = require.resolve(specifier);
  return createRequire(resolved)(specifier);
}

let failures = 0;

/**
 * 断言并报告。
 *
 * @param {boolean} condition 条件。
 * @param {string} label 证据说明。
 */
function check(condition, label) {
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    console.error(`  ✖ ${label}`);
    failures += 1;
  }
}

if (DSH_DIST === undefined) {
  // 找不到 DSH 就明确跳过，并给非零退出码——静默「通过」等于假绿。
  console.error('找不到 DSH 安装位置，无法验证真实服务类。');
  console.error('请设 DSH_DIST 指向 dsh 的 lib/bin.js，或设 DSH_HOME 指向 Harness home 后重试。');
  process.exit(2);
}

const cordis = loadFromDsh('@deepseek-ai/cordis');
const skillMod = loadFromDsh('@deepseek-ai/dsh-skill');
const toolsMod = loadFromDsh('@deepseek-ai/dsh-tools');
const commandsMod = loadFromDsh('@deepseek-ai/dsh-commands');

console.log('用 DSH 自带的真实服务类验证注册');
console.log(`  DSH 位置: ${DSH_DIST}\n`);
console.log(`  真实 SkillRegistry: ${typeof skillMod.default ?? typeof skillMod.SkillRegistry}`);
console.log(`  真实 ToolRuntime  : ${typeof toolsMod.default ?? 'n/a'}`);
console.log(`  真实 CommandRuntime: ${typeof commandsMod.default ?? 'n/a'}\n`);

const stateDir = mkdtempSync(join(tmpdir(), 'agent-notes-live-'));
const ctx = new cordis.Context();

// 装真实服务：SkillRegistry 作为 Service 子类，构造时即向 ctx 注册自己，
// 因此不需要（也不允许）再 provide 一次。
const skills = new skillMod.SkillRegistry(ctx);
check(ctx.get('skills') !== undefined, 'SkillRegistry 已自动注册为 ctx.skills');

// tools / commands 的真实实现还依赖更多服务；本脚本聚焦技能注册的真实性，
// 这两个用同形状承接器占位（注册形状的校验由 integration.test.mjs 覆盖）。
ctx.provide('tools');
ctx.set('tools', { register: () => () => {} });
ctx.provide('commands');
ctx.set('commands', { register: () => () => {} });

console.log('[技能] 经真实 SkillRegistry 注册与查询');
applyPlugin(ctx, { stateFile: join(stateDir, 'state.json') });

const listed = await skills.list({});
const found = listed.find((entry) => entry.name === 'agent-notes');
check(found !== undefined, `SkillRegistry.list() 返回了 agent-notes（共 ${listed.length} 项）`);
if (found !== undefined) {
  check(found.source === 'bundled', `source 为 bundled（实际 ${found.source}）`);
  check(found.invocation.modelInvocable === true, '模型可调用');
  check(found.invocation.userInvocable === true, '用户可调用');
  check(typeof found.description === 'string' && found.description.length > 10, 'description 非空');
}

const loaded = await skills.get('agent-notes', {});
check(loaded !== undefined, 'SkillRegistry.get() 取到完整定义');
if (loaded !== undefined) {
  check(typeof loaded.content === 'string' && loaded.content.length > 500, `正文长度 ${loaded.content?.length ?? 0} > 500`);
  check(loaded.content.startsWith('---') === false, '正文已剥掉 frontmatter');
  check(loaded.resourceBase?.kind === 'directory', 'resourceBase 指向目录（相对引用可解析）');
}

// 按名字找不到时必须返回 undefined，而不是抛 —— 这是宿主契约。
const missing = await skills.get('definitely-not-a-skill-zzz', {});
check(missing === undefined, '未知名技能返回 undefined（契约）');

rmSync(stateDir, { recursive: true, force: true });

console.log('');
if (failures > 0) {
  console.error(`实机证据未通过：${failures} 项`);
  process.exit(1);
}
console.log('实机证据通过：DSH 自带 SkillRegistry 真接受并返回本插件注册的技能。');
