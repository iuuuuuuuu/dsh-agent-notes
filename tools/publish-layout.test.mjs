/**
 * `tools/publish-layout.mjs`（发布清单一致性）的故障注入。
 *
 * ## 为什么这个文件必须存在
 *
 * 这道判据针对的是一类**仓库里的测试永远抓不到**的缺陷：
 * 仓库里什么都有，仓库里的每一条测试都全绿，而**发出去的包**少了东西。
 *
 * 实测过的两种改坏方式：
 *
 *   1. 从 `files` 里删掉 `"skills"` —— `npm pack --dry-run` 的产物里没有
 *      `skills/`，而 `lib/skill.js:21`、`lib/notes.js:27`、
 *      `lib/self-update.js:212` 都在运行时从包根读 `skills/agent-notes`。
 *      装上去的插件**技能整个消失**，而仓库里的测试全绿（它们测仓库）。
 *   2. 给 `exports` 加一条指向不存在文件的子路径 —— 消费者 import 时
 *      得到 `MODULE_NOT_FOUND`。
 *
 * 所以本文件不测「`coversFile` 函数对不对」，而测「**改坏产物之后，
 * 自检真的会红**」：造一份真包副本，改 `package.json`，真跑一次子进程。
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectExportTargets, coversFile, isPublished } from './publish-layout.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const NODE = process.execPath;

/** 自检要用到的全部路径。少拷一个都会让「绿基线」变成别的原因导致的红。 */
const NEEDED = [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'LICENSE',
  'src',
  'lib',
  'skills',
  'tools/verify-plugin.mjs',
  'tools/publish-layout.mjs',
  'build.mjs',
  'tools/upstream-manifest.json',
  'upstream.json'
];

/**
 * 造一份可自检的包副本。
 *
 * @returns {string} 副本根目录。
 */
function makePackageCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'an-publish-layout-'));
  for (const rel of NEEDED) {
    cpSync(join(PACKAGE_ROOT, ...rel.split('/')), join(dir, ...rel.split('/')), { recursive: true });
  }
  return dir;
}

/**
 * 在副本里跑自检。
 *
 * @param {string} dir 副本根目录。
 * @returns {{ status: number|null, output: string }} 退出码与合并输出。
 */
function runVerify(dir) {
  const result = spawnSync(NODE, [join(dir, 'tools', 'verify-plugin.mjs')], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * 改副本里的 `package.json`。
 *
 * @param {string} dir 副本根目录。
 * @param {(pkg: Record<string, any>) => Record<string, any>} transform 改写函数。
 */
function patchPkg(dir, transform) {
  const file = join(dir, 'package.json');
  const before = readFileSync(file, 'utf8');
  const pkg = transform(JSON.parse(before));
  const after = `${JSON.stringify(pkg, null, 2)}\n`;
  assert.notEqual(after, before, 'patch 没有改动 package.json，这条用例已经失效');
  writeFileSync(file, after, 'utf8');
}

/**
 * 断言自检因某个理由变红。
 *
 * @param {string} dir 副本根目录。
 * @param {RegExp} reason 期望出现在输出里的失败理由。
 */
function expectRed(dir, reason) {
  const { status, output } = runVerify(dir);
  assert.equal(status, 1, `自检应当失败，实际退出码 ${status}。输出:\n${output}`);
  assert.match(output, reason, `失败理由不对。输出:\n${output}`);
}

test('publish-layout: 绿基线必须通过（真子进程）', () => {
  const dir = makePackageCopy();
  try {
    const { status, output } = runVerify(dir);
    assert.equal(status, 0, `原样副本应当通过，实际 ${status}。输出:\n${output}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publish-layout: files 删掉 skills 必须红（产物里技能整个消失）', () => {
  const dir = makePackageCopy();
  try {
    /* 这一条是整道判据存在的理由：仓库里技能文件都还在，仓库里的测试全绿，
       但产物里没有 skills/ —— 装上去插件的技能没了。 */
    patchPkg(dir, (pkg) => {
      pkg.files = pkg.files.filter((entry) => entry !== 'skills');
      return pkg;
    });
    expectRed(dir, /运行时文件 "skills\/agent-notes\/.*" 没有被 files 覆盖/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publish-layout: files 删掉 lib 必须红（插件本体发不出去）', () => {
  const dir = makePackageCopy();
  try {
    patchPkg(dir, (pkg) => {
      pkg.files = pkg.files.filter((entry) => entry !== 'lib');
      return pkg;
    });
    expectRed(dir, /运行时文件 "lib\/.*" 没有被 files 覆盖/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publish-layout: files 条目指向不存在的目录必须红（npm 会静默忽略）', () => {
  const dir = makePackageCopy();
  try {
    patchPkg(dir, (pkg) => {
      pkg.files = [...pkg.files, 'definitely-not-here'];
      return pkg;
    });
    expectRed(dir, /files 条目 "definitely-not-here" 在磁盘上不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publish-layout: exports 指向不存在的文件必须红', () => {
  const dir = makePackageCopy();
  try {
    patchPkg(dir, (pkg) => {
      pkg.exports['./probe-missing'] = { default: './lib/DOES-NOT-EXIST.js' };
      return pkg;
    });
    expectRed(dir, /exports 目标 "\.\/lib\/DOES-NOT-EXIST\.js" 在磁盘上不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publish-layout: exports 指向存在但没被 files 覆盖的文件必须红', () => {
  const dir = makePackageCopy();
  try {
    /* 造一个磁盘上真实存在、但不在 files 里的文件 —— 这正是「装出来之后
       import 失败」的情形：仓库里能 import，产物里不能。 */
    mkdirSync(join(dir, 'extra'), { recursive: true });
    writeFileSync(join(dir, 'extra', 'thing.js'), 'export const x = 1;\n', 'utf8');
    patchPkg(dir, (pkg) => {
      pkg.exports['./extra'] = { default: './extra/thing.js' };
      return pkg;
    });
    expectRed(dir, /exports 目标 "\.\/extra\/thing\.js" 没有被 files 覆盖/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publish-layout: main 没被 files 覆盖必须红', () => {
  const dir = makePackageCopy();
  try {
    patchPkg(dir, (pkg) => {
      pkg.main = './lib/index.js';
      pkg.files = pkg.files.filter((entry) => entry !== 'lib');
      pkg.exports = { '.': { default: './lib/index.js' } };
      return pkg;
    });
    expectRed(dir, /main "\.\/lib\/index\.js" 没有被 files 覆盖/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publish-layout: patch 没被 files 覆盖必须红（宿主加载不到插件）', () => {
  const dir = makePackageCopy();
  try {
    patchPkg(dir, (pkg) => {
      pkg.files = pkg.files.filter((entry) => entry !== 'cordis.patch.yml');
      return pkg;
    });
    expectRed(dir, /dsh\.bundle\.patch "\.\/cordis\.patch\.yml" 没有被 files 覆盖/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publish-layout: 单元判据 —— 目录前缀覆盖与 npm 恒含文件', () => {
  assert.equal(coversFile('lib', 'lib/index.js'), true, '目录条目应覆盖其下的文件');
  assert.equal(coversFile('lib', 'lib'), true, '目录条目应覆盖目录自身');
  assert.equal(coversFile('lib', 'libx/index.js'), false, '目录条目不得覆盖同前缀的兄弟目录');
  assert.equal(coversFile('lib/**', 'lib/sub/deep.js'), true, '`**` 应跨层');
  assert.equal(coversFile('*.js', 'a/b.js'), false, '`*` 不得跨层');
  assert.equal(coversFile('**/*.js', 'a/b.js'), true, '`**/` 前缀应跨层');
  assert.equal(isPublished([], 'package.json'), true, 'package.json 无条件发布');
  assert.equal(isPublished([], 'README.md'), true, 'README 无条件发布');
  assert.equal(isPublished([], 'LICENSE'), true, 'LICENSE 无条件发布');
  assert.equal(isPublished([], 'lib/index.js'), false, '普通文件仍需 files 覆盖');
});

test('publish-layout: 单元判据 —— exports 的每个条件分支都要被收集', () => {
  const targets = collectExportTargets({
    '.': { import: './lib/index.js', default: './lib/index.js' },
    './client': ['./lib/client.js'],
    './pkg': './package.json'
  });
  assert.deepEqual(
    [...new Set(targets)].sort(),
    ['./lib/client.js', './lib/index.js', './package.json'],
    '条件对象的每个分支都是一次可能的解析目标，少收一个就是放过一种坏装包'
  );
});
