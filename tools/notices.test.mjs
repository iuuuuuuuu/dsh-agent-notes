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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { checkNotices, renderNotices } from './notices.mjs';

/** 仓库根（本文件在 tools/ 下）。 */
const ROOT = join(import.meta.dirname, '..');

const upstreamPath = join(ROOT, 'upstream.json');
const upstreamBackup = readFileSync(upstreamPath, 'utf8');

/**
 * 造一个只覆盖 `upstream.json` 的读取器，其余文件仍读真仓库。
 *
 * **不写盘**：测试改写真实 `upstream.json` 会让并行跑的其它测试与
 * `notices:check` 门禁读到改到一半的内容。
 *
 * 返回的是 `renderNotices` 的**完整参数对象**（不是裸函数）—— 最初
 * 返回裸 read 函数，调用点写成 `renderNotices(withUpstream(…))` 恰好也能
 * 跑（因为 options.read 是 undefined 时会回落到真仓库），于是「改上游
 * 许可证」这个意图**静默失效**，测试变成了在验真仓库而不是验注入的值。
 * 返回 `{ read }` 让形状与参数名对齐，传错会立刻炸而不是静默退化。
 *
 * @param {Record<string, any>} patch 要合并进 upstream.json 的字段。
 * @returns {{ read: (name: string) => string }} `renderNotices` 的参数对象。
 */
function withUpstream(patch) {
  const merged = { ...JSON.parse(upstreamBackup), ...patch };
  if ('license' in patch && patch.license === undefined) delete merged.license;
  return {
    read: (name) => (name === 'upstream.json'
      ? JSON.stringify(merged, null, 2)
      : readFileSync(join(ROOT, name), 'utf8'))
  };
}

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

/**
 * 造一个只覆盖 `package.json` 的读取器，其余文件仍读真仓库。
 *
 * 用途：往 `dependencies` 里**注入**一个运行时依赖，验证归属声明必须列出它。
 * 这正是本次踩到的坑 —— `notices.mjs` 原本只读 `devDependencies`
 * （注释写着「`dependencies` / `peerDependencies` 为空」），于是真的加了
 * 运行时依赖后，它既不在「随插件发布」清单里也不在「开发依赖」清单里，
 * 而 `notices:check` 照样绿。
 *
 * 同样**不写盘**：改写真 `package.json` 会让并行测试读到改到一半的内容。
 *
 * @param {Record<string, Record<string, string>>} patch 要覆盖的依赖字段。
 * @returns {{ read: (name: string) => string }} `renderNotices` 的参数对象。
 */
function withDependencies(patch) {
  return {
    read: (name) => (name === 'package.json'
      ? JSON.stringify({ ...JSON.parse(readFileSync(join(ROOT, name), 'utf8')), ...patch }, null, 2)
      : readFileSync(join(ROOT, name), 'utf8'))
  };
}

test('notices: 运行时依赖必须出现在「随插件发布」清单里', () => {
  /* 这是真实缺陷的回归用例：加了 `dependencies` 之后，旧实现只扫
     `devDependencies`，那份依赖从声明里整体消失，而 check 报绿。
     MIT 的归属义务不区分依赖来自哪个字段。 */
  const text = renderNotices(withDependencies({
    dependencies: { 'mdast-util-from-markdown': '^2.1.0' }
  }));

  const runtime = text.slice(text.indexOf('## 2. 运行时依赖'), text.indexOf('## 3. 开发依赖'));
  assert.match(runtime, /mdast-util-from-markdown/,
    '运行时依赖必须列在「随插件发布」清单里 —— 只扫 devDependencies 会静默漏掉它');
  /* 真实仓库里确实有它，这句同时是「注入真的生效了」的对照。 */
  assert.ok(text.includes('mdast-util-from-markdown'), '注入必须真的改变了输出');
});

test('notices: 同一依赖被运行时与开发同时声明时，按运行时记', () => {
  /* 配置写重了不该让声明漏项 —— 按更保守的一侧（随插件发布）记，
     读者会以为它被分发出去，那是安全的方向。 */
  const text = renderNotices(withDependencies({
    dependencies: { debug: '^4.0.0' },
    devDependencies: { debug: '^4.0.0' }
  }));

  /* dev 段要从「开发依赖」切到「本插件自身」，否则文末的本包说明也被算进来
     —— 那会让这条断言因为别的内容而红，排查方向全错。 */
  const dev = text.slice(
    text.indexOf('## 3. 开发依赖'),
    text.indexOf('## 4. 本插件自身')
  );
  const devRows = dev.split('\n').filter((line) => line.startsWith('| `'));
  assert.ok(devRows.every((row) => !row.includes('`debug`')),
    `debug 不该同时出现在开发依赖清单里，实际：${devRows.join(' ; ')}`);
});

test('notices: peerDependencies 也算运行时依赖', () => {
  /* peerDependencies 装到使用者机器上的方式与 dependencies 相同，
     归属披露不该漏这一侧。 */
  const text = renderNotices(withDependencies({
    peerDependencies: { 'some-peer': '^1.0.0' }
  }));

  const runtime = text.slice(text.indexOf('## 2. 运行时依赖'), text.indexOf('## 3. 开发依赖'));
  assert.match(runtime, /some-peer/, 'peerDependencies 必须出现在运行时清单');
});

test('notices: 声明里的运行时清单必须覆盖真实 package.json', () => {
  /* 兜底：将来任何人再往 dependencies 加包而忘了跑 npm run notices，
     这条会红 —— 声明与真实清单脱节，正是本次那个假绿的形态。 */
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const text = renderNotices();
  const runtime = text.slice(text.indexOf('## 2. 运行时依赖'), text.indexOf('## 3. 开发依赖'));

  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    assert.match(runtime, new RegExp(`\\\`${name.replace(/[/\\\\]/g, '\\\\$&')}\``),
      `真实声明的运行时依赖 ${name} 必须出现在声明里（跑 npm run notices）`);
    assert.ok(range.trim() !== '', `${name} 的版本约束不能为空`);
  }
});

/**
 * 造一个可自检的 notices 副本（目录结构与真仓库一致）。
 *
 * ★ 两处必需，少了都会让夹具在错误的地方失败：
 *   1. `tools/upstream-manifest.json` 必须在 `tools/` 下 ——
 *      `vendoredSource` 按相对路径读它，拍平会得到伪造的 ENOENT；
 *   2. 必须挂 `node_modules` —— `spdx-expression-parse` 解析不到时
 *      进程以 ERR_MODULE_NOT_FOUND 崩，那是夹具的问题，不是被测退化。
 *
 * @returns {string} 副本根目录。
 */
function stageNotices() {
  const dir = mkdtempSync(join(tmpdir(), 'an-notices-fi-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  for (const rel of ['tools/notices.mjs', 'tools/upstream-manifest.json', 'package.json', 'upstream.json']) {
    cpSync(join(ROOT, rel), join(dir, rel));
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction');
  return dir;
}

/**
 * 在副本里跑一次「注入依赖后的 renderNotices 的结果」，返回输出。
 *
 * @param {string} dir 副本根。
 * @param {(src: string) => string} mutate 对源码的退化改写。
 * @param {Record<string, Record<string, string>>} injected 注入的依赖字段。
 * @returns {{ status: number | null, out: string }} 退出码与合并输出。
 */
function probeRendered(dir, mutate, injected) {
  const noticesPath = join(dir, 'tools', 'notices.mjs');
  writeFileSync(noticesPath, mutate(readFileSync(noticesPath, 'utf8')), 'utf8');
  const probe = join(dir, 'probe.mjs');
  writeFileSync(probe, [
    "import { renderNotices } from './tools/notices.mjs';",
    "import { readFileSync, writeFileSync } from 'node:fs';",
    `const injected = ${JSON.stringify(JSON.stringify(injected))};`,
    'const pkg = JSON.parse(readFileSync("package.json", "utf8"));',
    'const text = renderNotices({',
    '  read: (name) => (name === "package.json"',
    '    ? JSON.stringify({ ...pkg, ...JSON.parse(injected) }, null, 2)',
    '    : readFileSync(name, "utf8"))',
    '});',
    'const rt = text.slice(text.indexOf("## 2."), text.indexOf("## 3."));',
    'writeFileSync("result.txt", rt.includes("faul-dep") ? "HAS" : "MISSING");',
    ''
  ].join('\n'), 'utf8');
  const result = spawnSync(process.execPath, [probe], { cwd: dir, encoding: 'utf8', windowsHide: true });
  let marker = '';
  try { marker = readFileSync(join(dir, 'result.txt'), 'utf8'); } catch { /* 崩了就没有 marker */ }
  return { status: result.status, out: marker || `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

test('notices: 退化成「只扫 devDependencies」时运行时依赖必须漏出（故障注入）', () => {
  /* 这是本次真实缺陷的形态。Owner 硬规则：新门禁必须先证明它会红。
     只断言「现在是对的」不够 —— 那条断言对上文那个假绿同样成立
     （它当年也是绿的，只是验错了对象）。 */
  const dir = stageNotices();
  try {
    const scan = `  for (const group of ['dependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg[group] ?? {})) walk(name, { direct: true, scope: 'runtime' });
  }
`;
    const { out } = probeRendered(
      dir,
      (src) => {
        assert.ok(src.includes(scan), '夹具与实现脱节：找不到运行时依赖扫描段');
        return src.replace(scan, '  /* 退化：只扫 devDependencies */\n');
      },
      { dependencies: { 'faul-dep': '^1.0.0' } }
    );
    assert.equal(out, 'MISSING',
      '退化成「只扫 devDependencies」时，运行时依赖必须从声明里消失 —— 否则说明新用例抓不住它');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notices: npmDependencies 不接注入的 read 时必须暴露问题（故障注入）', () => {
  /* 第二个真实缺陷：依赖清单自己读真 package.json，注入的
     package.json 只被 renderNotices 用了一次。切断注入通道后，
     注入的 peerDependencies 必须消失；就算实现改成显式抛错，
     也同样算拦住 —— 崩掉比静默通过好。 */
  const dir = stageNotices();
  try {
    const { status, out } = probeRendered(
      dir,
      (src) => {
        assert.ok(src.includes('const deps = npmDependencies(read);'),
          '夹具与实现脱节：找不到 npmDependencies(read) 调用');
        return src.replace('const deps = npmDependencies(read);', 'const deps = npmDependencies();');
      },
      { peerDependencies: { 'faul-dep': '^1.0.0' } }
    );
    const caught = out === 'MISSING' || status !== 0;
    assert.ok(caught,
      `切断注入通道后必须暴露问题（漏项或崩溃），实际 status=${status} out=${JSON.stringify(out)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notices: 提交的 THIRD_PARTY_NOTICES.md 与当前内容一致', () => {
  const result = checkNotices();
  assert.equal(result.ok, true,
    '已提交的 THIRD_PARTY_NOTICES.md 必须是最新的 —— 否则跑 npm run notices 后提交');
});

test('notices: 声明被篡改时 check 必须失败（内存注入，不写盘）', () => {
  /* 这是门禁存在的意义：声明可以被手改得看起来合规，但内容与事实不符。

     **必须用内存注入而不是写盘**：npm test 是 node --test tools/*.test.mjs，
     各测试文件并行。测试改写真实的 THIRD_PARTY_NOTICES.md / upstream.json
     期间，notices:check 门禁或别的测试可能读到改到一半的内容。实测这个
     模式在 md-links 上造成 6 次全量跑红 4 次，而单独跑全绿。 */
  const good = renderNotices();
  assert.equal(checkNotices({ actual: good }).ok, true, '未篡改时必须通过');

  const tampered = good.replace('| 许可证 | MIT |', '| 许可证 | Apache-2.0 |');
  assert.notEqual(tampered, good, '篡改必须真的改了内容（否则本用例是假绿）');
  assert.equal(checkNotices({ actual: tampered }).ok, false,
    '篡改许可证后必须判定不一致');
});

test('notices: 声明缺失时 check 必须失败，而不是当作「无内容即通过」', () => {
  /* 空集合通过是最隐蔽的假绿：删掉文件反而变绿，等于鼓励删除。 */
  const result = checkNotices({ actual: null });
  assert.equal(result.ok, false, '文件缺失时必须判定失败');
  assert.equal(result.actual, null, '缺失时 actual 应为 null');
});

test('notices: 非法 SPDX 标识符必须抛错，不许静默写出', () => {
  /* 写错许可证标识符比没有更糟：它会让人以为自己合规了。
     用真实的 spdx-expression-parse 校验，而不是手写正则 —— 手写判断
     `MIT OR Apache-2.0` 这类表达式必错。 */
  assert.throws(() => renderNotices(withUpstream({ license: 'NOT-A-REAL-LICENSE' })),
    /SPDX/, '非法许可证必须抛错并提到 SPDX');
});

test('notices: 缺少 license 字段必须抛错，不许留空', () => {
  /* 留空的许可证等于没声明 —— 而「没声明」在合规上比「声明了但格式不对」更糟。 */
  assert.throws(() => renderNotices(withUpstream({ license: undefined })),
    /license/, '缺少 license 必须抛错');
});

test('notices: 复杂 SPDX 表达式（OR / AND / 括号）必须被接受', () => {
  /* 校验不能只认单个标识符 —— 那样会把合法的双许可作品判成错误，
     逼人简化成不准确的单一许可证。 */
  const text = renderNotices(withUpstream({ license: 'MIT OR Apache-2.0' }));
  assert.match(text, /MIT OR Apache-2\.0/, '表达式必须原样出现在声明里');

  /* 括号表达式同样要接受。 */
  const grouped = renderNotices(withUpstream({ license: '(MIT AND BSD-2-Clause)' }));
  assert.match(grouped, /MIT AND BSD-2-Clause/, '带括号的表达式必须被接受');
});

test('notices: 把读取函数直接当参数传必须报错，不许静默退化', () => {
  /* 实测踩过的坑：`renderNotices(readFn)` 不会报错 —— `options.read` 取到
     undefined，于是静默回落到真仓库。调用点写起来仍然「像对的」，而注入的
     数据完全没生效，测试变成在验真仓库（本文件里真的发生过一次）。

     所以必须显式失败：形状错了就该炸，安静地做另一件事才是危险的。 */
  const backup = readFileSync(upstreamPath, 'utf8');
  const bareRead = (name) => (name === 'upstream.json'
    ? backup
    : readFileSync(join(ROOT, name), 'utf8'));
  assert.throws(() => renderNotices(bareRead), /TypeError|对象/,
    '传裸函数必须报错 —— 静默退化会让注入的数据不生效而不被发现');
});
