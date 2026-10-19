/**
 * `tools/notices.mjs` 的行为测试 —— 第三方归属声明的生成与校验。
 *
 * ## 为什么这个门禁必须存在
 *
 * 本插件分发的是 MIT 作品的衍生：`skills/agent-notes/` 下 21 个文件是上游
 * `czm15053/write-notes-like-deepseek` 的 vendored 副本。MIT 第一条要求
 * 保留原版权与许可声明。此前本仓库只有自己那份 LICENSE，完全没提上游 ——
 * 这是真实的合规缺口，不是「等有人提再说」的优化项。
 *
 * ## 这些用例在防什么
 *
 * 生成器最容易的退化方式是「静默产出空壳」：文件还在、标题还在，但
 * 上游来源或依赖清单变成了空表。那种情况下 `--check` 依然通过，
 * 而声明已经没有内容了。所以这里断言的是**内容事实**，不是文件存在。
 */
import { strict as assert } from 'node:assert';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkNotices, renderNotices } from './notices.mjs';

/** 仓库根（本文件在 tools/ 下）。 */
const ROOT = join(import.meta.dirname, '..');

test('notices: 生成物必须包含 vendored 上游的来源、commit 与许可证', () => {
  const text = renderNotices();

  /* 上游仓库地址必须出现 —— 这是归属声明的核心。没有它，声明只是一张白纸。 */
  assert.match(text, /github\.com\/czm15053\/write-notes-like-deepseek/,
    '必须写明上游仓库地址');

  /* 固定 commit：只说「来自某仓库」不够，要说清哪个版本。 */
  const manifest = JSON.parse(readFileSync(join(ROOT, 'tools', 'upstream-manifest.json'), 'utf8'));
  assert.ok(text.includes(manifest.ref),
    `必须写明同步到的 commit（${manifest.ref}）`);
  assert.match(text, /\|\s*许可证\s*\|\s*MIT\s*\|/, '必须写明上游许可证');

  /* 文件数要与 manifest 一致：对不上说明声明与实际分发内容脱节。 */
  const count = Object.keys(manifest.files ?? {}).length;
  assert.ok(text.includes(`下的 ${count} 个文件`),
    `必须写明 vendored 文件数（${count}）`);

  /* 同步路径也要在：它说明这些文件在仓库里的位置。 */
  assert.ok(text.includes('skills/write-notes-like-deepseek'),
    '必须写明上游的同步路径');
});

test('notices: 必须如实记录上游 LICENSE 文件不存在这件事', () => {
  /* 上游 README 声明 MIT 并链接 LICENSE，但该文件在其仓库中 404。
     不写这段说明，读者会以为我们核对过那份文件。
     诚实的披露比看起来整齐更有价值 —— 这条断言把这份诚实钉住。 */
  const text = renderNotices();
  assert.match(text, /不存在/, '必须说明上游 LICENSE 文件不存在');
  assert.match(text, /404/, '必须给出实测依据（404）');
  assert.match(text, /README/, '必须说明许可证信息的实际来源是 README');
});

test('notices: 依赖清单必须含传递依赖，且许可证来自真实包元数据', () => {
  /* 只列直接依赖的归属声明是不完整的：`spdx-expression-parse` 会带回
     `spdx-exceptions` 与 `spdx-license-ids`，它们同样落在开发者机器上。
     而且这两个包的许可证是 CC-BY-3.0 / CC0-1.0 —— 手写绝猜不出，
     必须真读包元数据。 */
  const text = renderNotices();

  assert.match(text, /spdx-expression-parse/, '必须列出直接开发依赖');
  assert.match(text, /spdx-exceptions/, '必须列出传递依赖 spdx-exceptions');
  assert.match(text, /spdx-license-ids/, '必须列出传递依赖 spdx-license-ids');

  /* 许可证是读出来的，不是写死的。若哪天实现退化成硬编码表格，这条会红。 */
  assert.match(text, /CC-BY-3\.0/, 'spdx-exceptions 的许可证必须从包元数据读取');
  assert.match(text, /CC0-1\.0/, 'spdx-license-ids 的许可证必须从包元数据读取');

  /* 直接/传递要能区分：混在一起会让读者无法判断哪些是自己声明的。 */
  assert.match(text, /\|\s*直接\s*\|/, '必须区分直接依赖');
  assert.match(text, /\|\s*传递\s*\|/, '必须区分传递依赖');
});

test('notices: 提交的 THIRD_PARTY_NOTICES.md 与当前内容一致', () => {
  const result = checkNotices();
  assert.equal(result.ok, true,
    '已提交的 THIRD_PARTY_NOTICES.md 必须是最新的 —— 否则跑 npm run notices 后提交');
});

test('notices: 文件被篡改时 check 必须失败', () => {
  /* 这是门禁存在的意义：声明可以被手改得看起来合规，但内容与事实不符。 */
  const target = join(ROOT, 'THIRD_PARTY_NOTICES.md');
  const backup = readFileSync(target, 'utf8');
  try {
    writeFileSync(target, backup.replace('| 许可证 | MIT |', '| 许可证 | Apache-2.0 |'));
    assert.equal(checkNotices().ok, false, '篡改许可证后必须判定不一致');
  } finally {
    writeFileSync(target, backup);
  }
  assert.equal(checkNotices().ok, true, '还原后必须重新通过');
});

test('notices: 文件缺失时 check 必须失败，而不是当作「无内容即通过」', () => {
  /* 空集合通过是最隐蔽的假绿：删掉文件反而变绿，等于鼓励删除。 */
  const target = join(ROOT, 'THIRD_PARTY_NOTICES.md');
  const backup = readFileSync(target, 'utf8');
  try {
    rmSync(target);
    const result = checkNotices();
    assert.equal(result.ok, false, '文件缺失时必须判定失败');
    assert.equal(result.actual, null, '缺失时 actual 应为 null');
  } finally {
    writeFileSync(target, backup);
  }
});

test('notices: 非法 SPDX 标识符必须抛错，不许静默写出', () => {
  /* 写错许可证标识符比没有更糟：它会让人以为自己合规了。
     用真实的 spdx-expression-parse 校验，而不是手写正则 —— 手写判断
     `MIT OR Apache-2.0` 这类表达式必错。 */
  const upstreamPath = join(ROOT, 'upstream.json');
  const backup = readFileSync(upstreamPath, 'utf8');
  try {
    const parsed = JSON.parse(backup);
    parsed.license = 'NOT-A-REAL-LICENSE';
    writeFileSync(upstreamPath, JSON.stringify(parsed, null, 2));
    assert.throws(() => renderNotices(), /SPDX/, '非法许可证必须抛错并提到 SPDX');
  } finally {
    writeFileSync(upstreamPath, backup);
  }
});

test('notices: 缺少 license 字段必须抛错，不许留空', () => {
  /* 留空的许可证等于没声明 —— 而「没声明」在合规上比「声明了但格式不对」更糟。 */
  const upstreamPath = join(ROOT, 'upstream.json');
  const backup = readFileSync(upstreamPath, 'utf8');
  try {
    const parsed = JSON.parse(backup);
    delete parsed.license;
    writeFileSync(upstreamPath, JSON.stringify(parsed, null, 2));
    assert.throws(() => renderNotices(), /license/, '缺少 license 必须抛错');
  } finally {
    writeFileSync(upstreamPath, backup);
  }
});

test('notices: 复杂 SPDX 表达式（OR / AND / 括号）必须被接受', () => {
  /* 校验不能只认单个标识符 —— 那样会把合法的双许可作品判成错误，
     逼人简化成不准确的单一许可证。 */
  const upstreamPath = join(ROOT, 'upstream.json');
  const backup = readFileSync(upstreamPath, 'utf8');
  try {
    const parsed = JSON.parse(backup);
    parsed.license = 'MIT OR Apache-2.0';
    writeFileSync(upstreamPath, JSON.stringify(parsed, null, 2));
    assert.doesNotThrow(() => renderNotices(), '合法的 OR 表达式必须被接受');
    assert.match(renderNotices(), /MIT OR Apache-2\.0/, '表达式必须原样出现在声明里');
  } finally {
    writeFileSync(upstreamPath, backup);
  }
});
