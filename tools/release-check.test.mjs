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
const lockBackup = readFileSync(join(ROOT, 'package-lock.json'), 'utf8');

/**
 * 临时改 CHANGELOG / package.json 的**内容**，跑校验。
 *
 * **不写盘**：`npm test` 是 `node --test tools/*.test.mjs`，各测试文件并行。
 * 写真实的 `package.json` 与 `CHANGELOG.md` 会让 `release:check` 门禁、
 * `version.test.mjs`（它读 `package.json` 的 version）与其它测试在
 * 改到一半时读到中间态。这个纪律来自一次真实的偶发失败。
 *
 * `package-lock.json` 也必须一起给：**门禁现在会核 lock 的版本**，
 * 而「改版本号」这种用例天然要动 lock 的版本。若默认仍读真实 lock，
 * 改版本号的用例会多出一条与本用例无关的 lock 报错，把「这条用例在验什么」
 * 搅浑。所以默认给一份**跟随 pkg 版本**的 lock；只有专门验 lock 的用例
 * 才显式传 `lock`。
 *
 * @param {{changelog?: string, pkg?: object, lock?: object}} edits 要替换的内容。
 * @returns {ReturnType<typeof verifyRelease>} 校验结果。
 */
function withEdits(edits) {
  const pkg = edits.pkg ?? JSON.parse(pkgBackup);
  const lock = edits.lock ?? { version: pkg.version, lockfileVersion: 3, packages: { '': { version: pkg.version } } };
  const contents = new Map([
    ['CHANGELOG.md', edits.changelog ?? changelogBackup],
    ['package.json', JSON.stringify(pkg, null, 2)],
    ['package-lock.json', JSON.stringify(lock, null, 2)]
  ]);
  return verifyRelease({
    read: (name) => contents.get(name) ?? readFileSync(join(ROOT, name), 'utf8')
  });
}

/**
 * 一份**自造的** CHANGELOG 样本，形状固定。
 *
 * ★ 为什么不能依赖真实 CHANGELOG：真实文件的形状随发版动作变化
 *   （发版时 `[Unreleased]` 会被转成版本段，而门禁又要求不留空段）。
 *   依赖它的测试必然在某次发版后红 —— 本次发 0.6.0 时就红了 4 条。
 *
 *   而这 4 条用例真正要验的是「解析器分得清版本段与小节」以及
 *   「缺段 / 空段 / 重复段会报错」，与真实文件长什么样无关。
 */
const CURRENT_VERSION = JSON.parse(pkgBackup).version;

/* ★ 版本段用**读到的真实版本**，不写死 —— 写死 0.5.0 时，
   verifyRelease 会先报「当前版本没有对应段」，那几条用例看到的
   就是这条噪声而不是它要验的东西。跟随真实版本后，
   fixture 不再与版本号耦合，发版后不必再改。 */
const FIXTURE_CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### 新增',
  '',
  '- 攒着还没发的一条。',
  '',
  `## [${CURRENT_VERSION}] - 2026-10-18`,
  '',
  '### 新增',
  '',
  '- 已发布的一条。',
  ''
].join('\n');

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

test('release: package-lock.json 的版本必须与 package.json 一致', () => {
  /* 这个缺口真实发生过：仓库里 package.json 是 0.8.0、package-lock.json
     还停在 0.6.0，而整条门禁链全 0 —— 没有任何一道门禁看 lock。
     后果不是「数字不好看」：npm ci 按 lock 装、npm publish 按 package.json 发，
     装出来的包与发布的包版本号不同，且全程无报错。 */
  const stale = withEdits({ pkg: pkgWith('0.8.0'), lock: { version: '0.6.0' } });
  assert.ok(stale.errors.some((e) => /package-lock\.json/.test(e) && /0\.6\.0/.test(e)),
    `lock 版本落后必须报错，实际：${stale.errors.join('; ')}`);

  const inSync = withEdits({ pkg: pkgWith('0.8.0'), lock: { version: '0.8.0' } });
  assert.ok(!inSync.errors.some((e) => /package-lock\.json/.test(e)),
    `版本一致时不得报 lock 错，实际：${inSync.errors.join('; ')}`);
});

test('release: package-lock.json 读不出来时必须报错而不是放过', () => {
  /* 判不了就不能算通过 —— 门禁的通用纪律：脚本缺失、超时算失败。 */
  const result = verifyRelease({
    read: (name) => {
      if (name === 'package-lock.json') throw new Error('模拟读取失败');
      if (name === 'CHANGELOG.md') return changelogBackup;
      return readFileSync(join(ROOT, name), 'utf8');
    }
  });
  assert.ok(result.errors.some((e) => /package-lock\.json/.test(e) && /读取或解析失败/.test(e)),
    `lock 读不出来必须报错，实际：${result.errors.join('; ')}`);
});

test('release: parseChangelog 能分清版本段与小节', () => {
  const sections = parseChangelog(FIXTURE_CHANGELOG);
  const unreleased = sections.find((s) => s.version === 'Unreleased');
  assert.ok(unreleased !== undefined, '必须识别出 Unreleased 段');
  /* `### 新增` 这类小节不得被当成版本段 —— 否则段落计数会全乱。 */
  assert.ok(!sections.some((s) => s.version.startsWith('#') || s.version === '新增'),
    '三级小节不得被解析成版本段');
  /* 版本段跟随当前版本（fixture 用 \`CURRENT_VERSION\`）——
     写死 '0.5.0' 会让发版后这条用例失败。 */
  assert.ok(sections.some((s) => s.version === CURRENT_VERSION),
    `必须识别出 ${CURRENT_VERSION} 段`);
  /* 字段是 `body`（release-check.mjs:70 的 `{ version, date, body }`）——
     我上一版凭印象写了 `headings`，字段不存在。 */
  assert.ok(unreleased.body.includes('### 新增'),
    'Unreleased 段的小节要落进 body —— 门禁要求它非空，所以样本里给了内容');
  assert.ok(sections.every((s) => s.version === 'Unreleased' || s.date !== null),
    '已发布段都必须有日期');
});

test('release: 版本号没有对应段时必须报错', () => {
  /* 这是最要紧的一条：改了版本、打了 tag，CHANGELOG 里没有段
     —— 用户看到的发布说明是空的。 */
  /* ★ 原来写死 '0.6.0' —— 而 fixture 现在含当前版本 0.6.0，
     那条错就不再发生，用例变成在验「有对应段」而不是「缺对应段」。
     用一个**不可能存在于 fixture 里**的版本号（99.99.99），
     且不随时间失效。 */
  const MISSING = '99.99.99';
  const result = withEdits({ pkg: pkgWith(MISSING), changelog: FIXTURE_CHANGELOG });
  assert.ok(result.errors.length >= 1, '必须报错');
  assert.match(result.errors[0],
    new RegExp(`${MISSING.replace(/\./g, '\\.')}.*没有对应段|没有对应段`),
    '必须点明缺哪个版本');
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
  const lines = FIXTURE_CHANGELOG.split('\n');
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
  const lines = FIXTURE_CHANGELOG.split('\n');
  const range = sectionRange(lines, 'Unreleased');
  const removed = [...lines.slice(0, range.start), ...lines.slice(range.end)].join('\n');

  const result = withEdits({ changelog: removed });
  assert.deepEqual(result.errors, [], '删掉 Unreleased 段必须放行');
});

test('release: 往 [Unreleased] 加内容必须放行（对照）', () => {
  /* ★ 原来靠 `changelogBackup.replace('## [Unreleased]\n', ...)` —— 真实文件
     发版后没有该段时 replace 找不到就是空替换，断言会在「什么都没加」的
     情况下通过 = **假绿**。所以两条对照用例都改用自造 fixture。 */
  const result = withEdits({
    changelog: FIXTURE_CHANGELOG.replace(
      '## [Unreleased]\n',
      '## [Unreleased]\n\n### 修复\n\n- 又一条\n'
    )
  });
  assert.ok(result.errors === undefined || result.errors.length === 0,
    '往 Unreleased 攒内容必须放行');
  assert.notEqual(
    FIXTURE_CHANGELOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n### 修复\n\n- 又一条\n'),
    FIXTURE_CHANGELOG,
    '★ 替换必须真的发生了 —— 否则这条用例在什么都没改的空转里通过 = 假绿'
  );
});

test('release: 升版本号并同步加段必须放行（对照）', () => {
  /* 正当发版：改版本号 + 写版本段，两者一致。这条必须绿 ——
     否则门禁在阻止正确行为，人就会学会绕过它。 */
  /* ★ 用 fixture 而不是真实 CHANGELOG —— 那批用例已经在同一文件里改过了
     （真实文件的形状随发版动作变化，依赖它的测试必然在某次发版后红）。
     且版本号用 \`NEXT\` + 模板插值，**不写死**：写死 '0.6.0' 时
     若 fixture 的版本段是别的值，报的是「没有对应段」，
     验的就不是「同步改版本号与 CHANGELOG」这件事了。 */
  const NEXT = '99.98.97';
  const result = withEdits({
    pkg: pkgWith(NEXT),
    changelog: FIXTURE_CHANGELOG.replace(
      '## [Unreleased]\n',
      `## [Unreleased]\n\n### 修复\n\n- 某个修复\n\n## [${NEXT}] - 2026-10-19\n\n### 新增\n\n- 新东西\n`
    )
  });
  assert.deepEqual(result.errors, [], '同步改版本号与 CHANGELOG 必须放行');
});
