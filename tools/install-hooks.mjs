#!/usr/bin/env node
/**
 * 安装 git pre-commit 钩子（零依赖，不引入 husky）。
 *
 * ## 为什么需要它
 *
 * 规范里那些「该写笔记」的条目全靠模型自觉，而多轮对话里它一定会忘 ——
 * 本仓库实测漏了 5 次连续改动（都在改 CI 流程）。等到 CI 才发现已经太晚，
 * 那时线索早就凉了。钩子让问题在 `git commit` 那一刻就暴露。
 *
 * ## 为什么不用 husky
 *
 * 这个仓库的硬约束是零运行时依赖加 vendored 内容全部可核对。
 * husky 会带进 node_modules 依赖与 `.husky/` 目录，为一个二十行的钩子
 * 不值得。直接用 `core.hooksPath` 指向仓库内的 `.githooks/` 即可 ——
 * 钩子文件本身进版本库，别人 clone 后跑一次本脚本就生效。
 *
 * ## 用法
 *
 *   node tools/install-hooks.mjs          # 安装
 *   node tools/install-hooks.mjs --undo   # 卸掉（恢复默认 hooksPath）
 *
 * 幂等：重复跑结果一致。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOKS_DIR = join(PACKAGE_ROOT, '.githooks');
const HOOK_FILE = join(HOOKS_DIR, 'commit-msg');
const RELATIVE_HOOKS_PATH = '.githooks';

/**
 * 跑 git 并返回结果。
 *
 * @param {string[]} args git 参数。
 * @returns {{ ok: boolean, out: string, err: string }} 结果。
 */
function git(args) {
  const result = spawnSync('git', args, {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    out: String(result.stdout ?? ''),
    err: String(result.stderr ?? '')
  };
}

/**
 * 判断当前目录是不是 git 仓库根。
 *
 * @returns {boolean} 是则为 true。
 */
function isRepoRoot() {
  const result = git(['rev-parse', '--show-toplevel']);
  if (!result.ok) return false;
  /* Windows 上大小写与斜杠方向都可能不同，末尾还可能多一个分隔符
     （`new URL('..', import.meta.url)` 的 fileURLToPath 就会留一个）。
     统一成「正斜杠 + 无尾斜杠 + 小写」再比。 */
  const normalize = (value) => value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalize(result.out) === normalize(PACKAGE_ROOT);
}

const undo = process.argv.includes('--undo');

if (!isRepoRoot()) {
  console.error('✖ 当前目录不是 git 仓库根，无法安装钩子。');
  console.error(`  PACKAGE_ROOT = ${PACKAGE_ROOT}`);
  process.exit(2);
}

if (undo) {
  const result = git(['config', '--unset', 'core.hooksPath']);
  if (result.ok) console.log('已卸载：core.hooksPath 已恢复默认。');
  else console.log('无需卸载：core.hooksPath 本来就没设置。');
  process.exit(0);
}

/* 钩子正文。刻意用 `#!/bin/sh` 而不是 node：
   Windows 上 git 自带的 sh 一定在，node 的路径却可能不在 PATH 里。
   真正的判定逻辑仍然交给 node 脚本，钩子只做转发。

   为什么挂 commit-msg 而不是 pre-commit：
   `Note-Skip:` 是写在**提交信息**里的放行标记，而 pre-commit 阶段本次提交
   信息还没生成，读不到它 —— 实测那样挂会让「我明明写了 Note-Skip 却被拦」，
   属于把合法出口堵死，人就会转去 --no-verify，门禁等于失效。
   commit-msg 拿得到 `$1`（COMMIT_EDITMSG 路径），暂存区在此时也仍然可查，
   一个钩子同时满足两个条件。 */
const hookBody = `#!/bin/sh
# 由 tools/install-hooks.mjs 生成，请勿手改（改那个脚本）。
#
# 覆盖门禁：该写笔记的改动必须同批带笔记。详见 tools/notes-coverage.mjs。
# 紧急情况可 \`git commit --no-verify\` 跳过 —— 但 CI 会再查一次。
exec node tools/notes-coverage.mjs --message-file "$1"
`;

if (!existsSync(HOOKS_DIR)) mkdirSync(HOOKS_DIR, { recursive: true });

/* 已存在的旧 pre-commit 要清掉：留着会重复检查，且它拦不住 Note-Skip 场景。 */
const legacy = join(HOOKS_DIR, 'pre-commit');
if (existsSync(legacy) && readFileSync(legacy, 'utf8').includes('notes-coverage.mjs')) {
  rmSync(legacy, { force: true });
  console.log('已移除旧的 pre-commit 钩子（改用 commit-msg，以便读到 Note-Skip）。');
}

/* 已存在且内容不同就提示，避免悄悄覆盖别人的自定义钩子。 */
if (existsSync(HOOK_FILE) && readFileSync(HOOK_FILE, 'utf8') !== hookBody) {
  console.log('提示：.githooks/commit-msg 已存在且内容不同，正在覆盖为仓库标准版本。');
}

writeFileSync(HOOK_FILE, hookBody, 'utf8');

/* Windows 上 chmod 基本无效，但仍执行：在 WSL / macOS / Linux 上必须可执行。 */
try {
  chmodSync(HOOK_FILE, 0o755);
} catch {
  /* 失败不影响 Windows；git 在 Windows 上按 shebang 找解释器。 */
}

const setResult = git(['config', 'core.hooksPath', RELATIVE_HOOKS_PATH]);
if (!setResult.ok) {
  console.error('✖ 设置 core.hooksPath 失败：');
  console.error(`  ${setResult.err.trim()}`);
  process.exit(2);
}

console.log(`✔ commit-msg 钩子已安装（core.hooksPath = ${RELATIVE_HOOKS_PATH}）。`);
console.log('  该写笔记却没写的提交会被拦下；紧急情况用 git commit --no-verify 跳过。');
