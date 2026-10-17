/**
 * 版本号与版本探针的测试。
 *
 * 背景：这个仓库要被 dsh 市场 / 官方插件源 / 第三方识别到「有更新」，
 * 它们看的是**版本号**。内容变了但版本号不动，对它们来说等于没更新。
 * 同时版本号又是自更新的快速探针 —— 只查一个 package.json 就够判断，
 * 不必每次拉 21 个技能文件（实测 2028ms -> 79ms）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bump } from './bump-version.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('version: bump 三种递增都符合语义化版本', () => {
  assert.equal(bump('0.2.0', 'patch'), '0.2.1');
  assert.equal(bump('0.2.0', 'minor'), '0.3.0');
  assert.equal(bump('0.2.0', 'major'), '1.0.0');
  /* 进位必须把低位清零，否则市场会看到 1.9.9 -> 1.10.9 这种诡异版本。 */
  assert.equal(bump('0.2.9', 'minor'), '0.3.0', 'minor 必须把 patch 归零');
  assert.equal(bump('1.9.9', 'patch'), '1.9.10', 'patch 不得动高位');
  assert.equal(bump('1.9.9', 'major'), '2.0.0', 'major 必须把 minor/patch 归零');
});

test('version: 非法版本号必须抛错，不许猜', () => {
  /* 猜一个默认值会让版本号静默跑偏，宁可让 CI 变红。 */
  assert.throws(() => bump('abc', 'patch'), /格式不合法/);
  assert.throws(() => bump('1.2', 'patch'), /格式不合法/);
  assert.throws(() => bump('', 'patch'), /格式不合法/);
});

test('version: package.json 的版本号是合法的语义化版本', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+/, `版本号不合法: ${pkg.version}`);
});

test('version: 自更新用版本号做探针，且本地记录文件不进版本库', () => {
  /* 探针机制的两个关键点，改动时不能丢：
     1. self-update 读的是 package.json 的 version（不是 API 的 commit SHA，
        那条路实测 jsDelivr 返回 null、GitHub API 被限流）；
     2. 记录文件必须在 .gitignore 里，否则每次同步都会把本地状态提交进去。 */
  const source = readFileSync(join(ROOT, 'lib', 'self-update.js'), 'utf8');
  assert.match(source, /package\.json/, '探针必须读 package.json');
  assert.match(source, /resolveRemoteVersion/, '必须有版本解析函数');
  assert.match(source, /SYNCED_VERSION_FILE/, '必须记录已同步版本');

  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /\.synced-version/, '.synced-version 必须被 gitignore');
});

test('version: package.json 版本与最新 git tag 必须一致', async () => {
  /* 市场与插件读的是 package.json 的 version，用户看的是 git tag。
     两者不一致时，「发布了 v0.2.0」与「插件自称 0.1.0」会同时成立，
     市场和第三方就无法确定该拿哪一版。
     没有 tag（新仓库）时跳过 —— 那是正常状态，不是缺陷。 */
  const { spawnSync } = await import('node:child_process');
  const tags = spawnSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true
  });
  /* git 不可用（比如从 tarball 安装）时跳过，不误报。 */
  if (tags.status !== 0) return;
  const list = String(tags.stdout).trim().split(/\r?\n/).filter((line) => line !== '');
  if (list.length === 0) return;

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(
    `v${pkg.version}`,
    list[0],
    `package.json 版本 (${pkg.version}) 必须与最新 tag (${list[0]}) 一致`
  );
});
