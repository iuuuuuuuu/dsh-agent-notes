/**
 * `tools/release-check.mjs` 的行为测试 —— 发版记账一致性。
 *
 * ## 这个门禁在补什么
 *
 * 已有 `bump-version.mjs` 与一条测试守着「`package.json` 版本 == 最新 git tag」。
 * 但 **CHANGELOG 完全无人管**：改了版本号、打了 tag，CHANGELOG 里没有对应段，
 * 用户看到的发布说明就是空的。
 *
 * ## 为什么这类门禁值得做
 *
 * 本仓库的发版纪律里有一条硬要求：**发版必须先获得用户明确许可**。
 * 那类纪律如果没有机制支撑，迟早会靠不住 —— 这是靠人记得的事，不是靠流程。
 * 把「版本 / tag / CHANGELOG 三者对得上」变成机器可判定的一刻，
 * 纪律才有落点。
 *
 * ## 每条红灯都配对照
 *
 * 否则一个「一律报错」的实现也能让全部红灯用例通过。
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseChangelog, verifyRelease } from './release-check.mjs';

const ROOT = join(import.meta.dirname, '..');
const CHANGELOG = join(ROOT, 'CHANGELOG.md');
const PKG = join(ROOT, 'package.json');

const changelogBackup = readFileSync(CHANGELOG, 'utf8');
const pkgBackup = readFileSync(PKG, 'utf8');

/**
 * 临时改 CHANGELOG / package.json 的**内容**，跑校验。
 *
 * **不写盘**：`npm test` 是 `node --test tools/*.test.mjs`，各测试文件并行。
 * 写真实的 `package.json` 与 `CHANGELOG.md` 会让 `release:check` 门禁、
 * `version.test.mjs`（它读 `package.json` 的 version）与其它测试在
 * 改到一半时读到中间态。这个纪律来自一次真实的偶发失败。
 *
 * @param {{changelog?: string, pkg?: object}} edits 要替换的内容。
 * @returns {ReturnType<typeof verifyRelease>} 校验结果。
 */
function withEdits(edits) {
  const contents = new Map([
    ['CHANGELOG.md', edits.changelog ?? changelogBackup],
    ['package.json', JSON.stringify(edits.pkg ?? JSON.parse(pkgBackup), null, 2)]
  ]);
  return verifyRelease({
    read: (name) => contents.get(name) ?? readFileSync(join(ROOT, name), 'utf8')
  });
}

/** 取出当前 package.json 的可改副本。 */
function pkgWith(version) {
  const pkg = JSON.parse(pkgBackup);
  pkg.version = version;
  return pkg;
}

/** 找出指定版本段在行数组中的起止。 */
function sectionRange(lines, version) {
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  return { start, end: end === -1 ? lines.length : end };
}

test('release: 当前仓库的版本 / CHANGELOG 对得上', () => {
  const result = verifyRelease();
  assert.deepEqual(result.errors, [], `记账必须一致，实际：${result.errors.join('; ')}`);
  const pkg = JSON.parse(pkgBackup);
  assert.equal(result.version, pkg.version, '报告的版本应与 package.json 一致');
});

test('release: parseChangelog 能分清版本段与小节', () => {
  const sections = parseChangelog(changelogBackup);
  const unreleased = sections.find((s) => s.version === 'Unreleased');
  assert.ok(unreleased !== undefined, '必须识别出 Unreleased 段');
  /* `### 新增` 这类小节不得被当成版本段 —— 否则段落计数会全乱。 */
  assert.ok(!sections.some((s) => s.version.startsWith('#') || s.version === '新增'),
    '三级小节不得被解析成版本段');
  assert.ok(sections.some((s) => s.version === '0.5.0'), '必须识别出 0.5.0 段');
  assert.ok(sections.every((s) => s.version === 'Unreleased' || s.date !== null),
    '已发布段都必须有日期');
});

test('release: 版本号没有对应段时必须报错', () => {
  /* 这是最要紧的一条：改了版本、打了 tag，CHANGELOG 里没有段
     —— 用户看到的发布说明是空的。 */
  const result = withEdits({ pkg: pkgWith('0.6.0') });
  assert.ok(result.errors.length >= 1, '必须报错');
  assert.match(result.errors[0], /0\.6\.0.*没有对应段|没有对应段/, '必须点明缺哪个版本');
});

test('release: 同一版本出现两次必须报错', () => {
  /* 语义化版本不允许复用同一个版本号 —— 复用意味着两批不同的内容
     挂在同一个发布说明下。 */
  const result = withEdits({
    changelog: changelogBackup.replace('## [0.4.1] - 2026-10-18', '## [0.5.0] - 2026-10-18')
  });
  assert.ok(result.errors.some((e) => /出现了两次/.test(e)), `必须报重复，实际：${result.errors.join('; ')}`);
});

test('release: 版本顺序不是最新在前时必须报错', () => {
  /* 构造必须整段对调。靠字符串 replace 会互相干扰（第一次把 0.4.1 改成
     0.4.0，第二次再找 0.4.0 就命中刚改出来的那个），结果根本没打乱顺序
     —— 那是用例的错，不是门禁的错。探针里因此红过一次。 */
  const lines = changelogBackup.split('\n');
  const a = sectionRange(lines, '0.5.0');
  const b = sectionRange(lines, '0.4.1');
  const swapped = [
    ...lines.slice(0, a.start),
    ...lines.slice(b.start, b.end),
    ...lines.slice(a.start, a.end),
    ...lines.slice(b.end)
  ].join('\n');

  const result = withEdits({ changelog: swapped });
  assert.ok(result.errors.some((e) => /版本顺序不对/.test(e)), `必须报顺序，实际：${result.errors.join('; ')}`);
});

test('release: 版本段缺日期或日期格式不对都必须报错', () => {
  const noDate = withEdits({
    changelog: changelogBackup.replace('## [0.4.1] - 2026-10-18', '## [0.4.1]')
  });
  assert.ok(noDate.errors.some((e) => /缺少日期/.test(e)), '缺日期必须报');

  const badFormat = withEdits({
    changelog: changelogBackup.replace('## [0.4.1] - 2026-10-18', '## [0.4.1] - 2026/10/18')
  });
  assert.ok(badFormat.errors.some((e) => /日期格式不对/.test(e)), '日期格式不对必须报');
});

test('release: [Unreleased] 段为空时必须报错', () => {
  /* 空段说明「攒着不发」，而这件事此前完全看不见 —— 攒到什么时候都没人知道。 */
  const lines = changelogBackup.split('\n');
  const range = sectionRange(lines, 'Unreleased');
  const emptied = [
    ...lines.slice(0, range.start + 1),
    '',
    ...lines.slice(range.end)
  ].join('\n');

  const result = withEdits({ changelog: emptied });
  assert.ok(result.errors.some((e) => /\[Unreleased\] 段是空的/.test(e)),
    `空 Unreleased 必须报，实际：${result.errors.join('; ')}`);
});

test('release: 删掉 [Unreleased] 段必须放行（对照）', () => {
  /* 没有未发布内容时不留空段，是正确的做法 —— 不该被当成错误。 */
  const lines = changelogBackup.split('\n');
  const range = sectionRange(lines, 'Unreleased');
  const removed = [...lines.slice(0, range.start), ...lines.slice(range.end)].join('\n');

  const result = withEdits({ changelog: removed });
  assert.deepEqual(result.errors, [], '删掉 Unreleased 段必须放行');
});

test('release: 往 [Unreleased] 加内容必须放行（对照）', () => {
  const result = withEdits({
    changelog: changelogBackup.replace('## [Unreleased]\n', '## [Unreleased]\n\n### 修复\n\n- 某个修复\n')
  });
  assert.deepEqual(result.errors, [], '往 Unreleased 攒内容必须放行');
});

test('release: 升版本号并同步加段必须放行（对照）', () => {
  /* 正当发版：改版本号 + 写版本段，两者一致。这条必须绿 ——
     否则门禁在阻止正确行为，人就会学会绕过它。 */
  const result = withEdits({
    pkg: pkgWith('0.6.0'),
    changelog: changelogBackup.replace(
      '## [Unreleased]\n',
      '## [Unreleased]\n\n### 修复\n\n- 某个修复\n\n## [0.6.0] - 2026-10-19\n\n### 新增\n\n- 新东西\n'
    )
  });
  assert.deepEqual(result.errors, [], '同步改版本号与 CHANGELOG 必须放行');
});