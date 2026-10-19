/**
 * `tools/ci-alignment.mjs` 的行为测试。
 *
 * ## 这个门禁在补什么
 *
 * 实测踩过：连续三轮加了五道门禁（`notices:check` / `md:links` /
 * `docs:bilingual` / `text:integrity` / `release:check`），全都接进了本地
 * `npm run check`，**CI 的 verify job 一道都没跑**。
 *
 * 后果：那五道门禁红过时 CI 毫无反应 —— 本地成了唯一防线，而本地会被人
 * `--no-verify`、也会忘记跑。**门禁存在但没人执行，等于没有。**
 *
 * ## 用临时副本测试，不改真 workflow
 *
 * 真仓库只读不写（见 testing/2026-10-19-parallel-tests-must-not-share-real-trees.md）。
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

import { verifyCiAlignment, verifyAll, extractGateCommands, listWorkflowFiles } from './ci-alignment.mjs';

const ROOT = join(import.meta.dirname, '..');

/**
 * 造一份「仓库」，其中 workflow 内容由测试指定。
 *
 * @param {Record<string, string>} workflows 文件名 → 内容。
 *   缺省时只放真实的 `verify.yml`（保持旧调用方兼容）。
 * @returns {string} 沙箱根。
 */
function sandbox(workflows = { 'verify.yml': undefined }) {
  const dir = mkdtempSync(join(tmpdir(), 'an-align-'));
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  for (const [name, body] of Object.entries(workflows)) {
    const text = body === undefined
      ? readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8')
      : body;
    writeFileSync(join(dir, '.github', 'workflows', name), text, 'utf8');
  }
  /* package.json 必须与真实的一致 —— 判据读的是它的 check 链。 */
  cpSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(join(ROOT, 'tools', 'ci-alignment.mjs'), join(dir, 'tools', 'ci-alignment.mjs'));
  return dir;
}

/**
 * 在沙箱里跑一次对齐检查。
 *
 * @param {Record<string, string>} workflows 传给 `sandbox`。
 * @returns {{ code: number, out: string }} 结果。
 */
function check(workflows) {
  const dir = sandbox(workflows);
  try {
    const r = spawnSync(process.execPath, ['tools/ci-alignment.mjs'], {
      cwd: dir, encoding: 'utf8', windowsHide: true
    });
    return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const REAL_WORKFLOW = readFileSync(
  join(ROOT, '.github', 'workflows', 'verify.yml'), 'utf8'
);
const REAL_SYNC = readFileSync(
  join(ROOT, '.github', 'workflows', 'upstream-sync.yml'), 'utf8'
);
const BOTH = { 'verify.yml': REAL_WORKFLOW, 'upstream-sync.yml': REAL_SYNC };

test('ci-align: 真实 workflow 此刻是对齐的', () => {
  const result = check({ 'verify.yml': REAL_WORKFLOW, 'upstream-sync.yml': REAL_SYNC });
  assert.equal(result.code, 0, `必须对齐：\n${result.out}`);
  assert.match(result.out, /门禁对齐通过/);
});

test('ci-align: 删掉任一内容型门禁的 CI 步骤必须被发现', () => {
  /* 这正是本轮的真实缺陷形态。五道门禁逐一抽掉，每个都必须变红。 */
  const steps = ['notices:check', 'md:links', 'docs:bilingual', 'text:integrity', 'release:check'];

  for (const step of steps) {
    /* 删掉所有 `run: npm run <step>` 的行（含其上的 name 行） */
    const mutated = REAL_WORKFLOW
      .split('\n')
      .filter((line, i, arr) => {
        if (!line.includes(`run: npm run ${step}`)) return true;
        /* 连带删掉紧邻上方的 `- name:` 行 */
        return !(arr[i - 1] !== undefined && arr[i - 1].trimStart().startsWith('- name:'));
      })
      .join('\n');

    assert.notEqual(mutated, REAL_WORKFLOW, `构造没生效：${step}`);
    const result = check({ 'verify.yml': mutated, 'upstream-sync.yml': REAL_SYNC });
    assert.equal(result.code, 1, `删掉 ${step} 的 CI 步骤必须被发现：\n${result.out}`);
    assert.match(result.out, new RegExp(step.replace(/[:]/g, ':')), `报错必须点名 ${step}`);
  }
});

test('ci-align: 注释里提到某个门禁不算数（必须仍报缺失）', () => {
  /* 这条是**门禁自身的盲区** —— 第一版实现扫全文，把步骤换成注释后
     仍判定「已覆盖」而全绿。门禁能抓别人、抓不到自己。 */
  const mutated = REAL_WORKFLOW.replace(
    /      - name: 文本完整性\n        run: npm run text:integrity/,
    '      # 文本完整性（本该有 npm run text:integrity）'
  );
  assert.notEqual(mutated, REAL_WORKFLOW, '构造没生效');

  const result = check({ 'verify.yml': mutated, 'upstream-sync.yml': REAL_SYNC });
  assert.equal(result.code, 1, `注释里提到不得算已覆盖：\n${result.out}`);
  assert.match(result.out, /text:integrity/);
});

test('ci-align: range 型门禁的豁免必须带理由，且能被核对', () => {
  /* `notes:coverage:last` 查 HEAD~1..HEAD，CI 用 event.before 更准 ——
     所以它「不在 CI 里出现」是**有意的**。但这个豁免必须显式登记，
     否则将来有人删掉 CI 那步时，本门禁不会知道少了东西。 */
  const result = verifyCiAlignment();

  assert.deepEqual(result.missing, [], '当前不得有缺失');
  /* 豁免的键必须都有理由（非空字符串），否则是「随便豁免」。 */
  const alternatives = verifyCiAlignment();
  assert.ok(alternatives.steps.length >= 2, '本地链至少要有 range 型门禁才谈得上豁免');
});

test('ci-align: 判据只认 run 行，不认注释与说明文字', () => {
  /* 与上面那条呼应：把实现细节钉住 —— 用一份全是注释的 workflow，
     所有内容型门禁都应被判为缺失。 */
  const allComments = [
    '# 这里提到了 notices:check 与 md:links 与 docs:bilingual',
    '# 还有 text:integrity 与 release:check',
    'jobs:',
    '  verify:',
    '    steps:',
    '      - name: 只有注释',
    '        # run: npm run verify'
  ].join('\n');

  const result = check({ 'verify.yml': allComments, 'upstream-sync.yml': REAL_SYNC });
  assert.equal(result.code, 1, '全是注释时必须判失败');
  /* 至少要报出几个 —— 具体几个取决于本地链有几道豁免。 */
  const missingCount = (result.out.match(/✖ /g) ?? []).length;
  assert.ok(missingCount >= 5, `应报出至少 5 道缺失，实际 ${missingCount}`);
});

test('ci-align: 多步 run 行（a && b）里的门禁也算数', () => {
  /* CI 里可能写成 `npm run a && npm run b` —— 只抓行首那一个会漏。 */
  const mutated = REAL_WORKFLOW.replace(
    /      - name: 包自检\n        run: npm run verify/,
    '      - name: 包自检\n        run: npm run verify && npm run notices:check'
  );
  /* 把原本独立的 notices 步骤删掉，看合并写法能否顶替 */
  const removed = mutated
    .split('\n')
    .filter((line, i, arr) => {
      if (!line.includes('run: npm run notices:check')) return true;
      return !(arr[i - 1] !== undefined && arr[i - 1].trimStart().startsWith('- name:'));
    })
    .join('\n');

  const result = check({ 'verify.yml': removed, 'upstream-sync.yml': REAL_SYNC });
  assert.equal(result.code, 0,
    `合并到 && 里也应算已覆盖（不应误报缺失）：\n${result.out}`);
});

/* ═══════════════════════════════════════════════════════════════════════
 * 以下覆盖本轮新增的两类判据。
 *
 * 病根：`upstream-sync.yml` 里那道「合并后必须通过才允许提交」握
 * `contents: write`、push main、还 push tag —— 而本门禁原本只读 verify.yml，
 * **删掉它整步，整条 check 链仍然 exit 0**。保护发布的那道门禁没人保护。
 * ═══════════════════════════════════════════════════════════════════════ */

test('ci-align: 两个 workflow 都必须被纳入判据（不只 verify.yml）', () => {
  /* 真实仓库此刻必须全绿 —— 先证明判据本身没把现状判红。 */
  const result = check(BOTH);
  assert.equal(result.code, 0, `真实两个 workflow 应通过：\n${result.out}`);

  const files = listWorkflowFiles();
  assert.ok(files.includes('verify.yml') && files.includes('upstream-sync.yml'),
    `应发现两个 workflow，实际 ${files.join(', ')}`);
});

test('ci-align: 删掉 upstream-sync 的发布门禁整步必须变红', () => {
  /* ★ 本轮的核心缺陷形态。那一步直接决定「未经校验的上游内容会不会被推到
     main」。删掉它，旧实现全绿。 */
  const mutated = REAL_SYNC.replace(
    /      - name: 门禁（合并后必须通过才允许提交）[\s\S]*?\n      - name: 提交并推送/,
    '      - name: 提交并推送'
  );
  assert.notEqual(mutated, REAL_SYNC, '构造没生效');

  const result = check({ ...BOTH, 'upstream-sync.yml': mutated });
  assert.equal(result.code, 1, `删掉发布门禁必须变红：\n${result.out}`);
  assert.match(result.out, /upstream-sync\.yml/);
});

test('ci-align: upstream-sync 的必需门禁逐一删都必须变红', () => {
  /* 每删一道就少一道闸，而它握着写权限 —— 逐条钉死，不许有豁免把它蒙过去。 */
  const required = [
    '          npm run verify\n',
    '          npm test\n',
    '          npm run gate:fault-injection\n'
  ];
  for (const line of required) {
    const mutated = REAL_SYNC.replace(line, '');
    assert.notEqual(mutated, REAL_SYNC, `构造没生效：${line.trim()}`);
    const result = check({ ...BOTH, 'upstream-sync.yml': mutated });
    assert.equal(result.code, 1, `删掉 ${line.trim()} 必须变红：\n${result.out}`);
  }
});

test('ci-align: 把 upstream-sync 的四步整体换成 true 必须变红', () => {
  /* 「把一步换成 true」是包含式判据看不见的操作 —— 必须由 subset required 抓住。 */
  const mutated = REAL_SYNC.replace(
    '          npm run verify\n          npm run notes:gate\n          npm test\n          npm run gate:fault-injection',
    '          true'
  );
  assert.notEqual(mutated, REAL_SYNC, '构造没生效');

  const result = check({ ...BOTH, 'upstream-sync.yml': mutated });
  assert.equal(result.code, 1, `把门禁换成 true 必须变红：\n${result.out}`);
});

test('ci-align: 发布门禁被移到 git push 之后必须变红', () => {
  /* 门禁排在发布之后就毫无意义 —— 它已经拦不住任何东西了。 */
  const gate = REAL_SYNC.match(
    /      - name: 门禁（合并后必须通过才允许提交）[\s\S]*?\n(?=      - name: 提交并推送)/
  )[0];
  const mutated = REAL_SYNC
    .replace(gate, '')
    .replace(/(      - name: 提交并推送[\s\S]*?\n\n)/, `$1${gate}\n`);
  assert.notEqual(mutated, REAL_SYNC, '构造没生效');
  assert.ok(mutated.indexOf('git commit') < mutated.indexOf('npm run verify'),
    '构造应把门禁移到 commit 之后');

  const result = check({ ...BOTH, 'upstream-sync.yml': mutated });
  assert.equal(result.code, 1, `门禁排在发布之后必须变红：\n${result.out}`);
});

test('ci-align: verify.yml 的四条安全属性逐一删都必须变红', () => {
  /* 这些是**断言式**判据。包含式检查看不见「把一步换成 true」或
     「把配置项删掉」，而每一条都对应注释里写明的真实故障模式。 */
  const cases = [
    ['          fetch-depth: 0', '          path: .', /full-history-checkout/],
    ['  pull_request:', '  pull_request_disabled:', /triggers-on-pr/],
    ['permissions:\n  contents: read', 'permissions:\n  contents: write', /read-only-permissions/],
    ['          if [ -n "$(git status --porcelain)" ]; then', '          if false; then', /asserts-clean-worktree/]
  ];
  for (const [needle, repl, expected] of cases) {
    const mutated = REAL_WORKFLOW.replace(needle, repl);
    assert.notEqual(mutated, REAL_WORKFLOW, `构造没生效：${needle}`);
    const result = check({ ...BOTH, 'verify.yml': mutated });
    assert.equal(result.code, 1, `删掉「${needle.trim()}」必须变红：\n${result.out}`);
    assert.match(result.out, expected);
  }
});

test('ci-align: 安全属性挪进注释里也算被删（注释不算数）', () => {
  /* 与「注释里提到某个门禁不算数」同源：把 fetch-depth 挪进注释，
     它就不再被执行 —— 但文件里仍然有那串字符。 */
  const mutated = REAL_WORKFLOW.replace('          fetch-depth: 0', '          # fetch-depth: 0');
  assert.notEqual(mutated, REAL_WORKFLOW, '构造没生效');

  const result = check({ ...BOTH, 'verify.yml': mutated });
  assert.equal(result.code, 1, `挪进注释必须变红：\n${result.out}`);
});

test('ci-align: 块标量里的门禁必须被抽到（upstream-sync 用的是 run: | ）', () => {
  /* 这是实现里最容易做错的一处：四道门禁全在 `run: |` 块里，
     只匹配单行 `run:` 的实现抽出来是 **[]**。那样删掉 verify 时
     它会误判为「本来就豁免」而全绿 —— 假绿。 */
  const { scripts, tests } = extractGateCommands(REAL_SYNC);
  assert.ok(scripts.includes('verify'), `应抽到块标量里的 verify，实际 ${scripts.join(', ')}`);
  assert.ok(scripts.includes('notes:gate'), `应抽到 notes:gate，实际 ${scripts.join(', ')}`);
  assert.ok(scripts.includes('gate:fault-injection'), '应抽到 gate:fault-injection');
  assert.ok(tests > 0, '应认得块标量里的裸 npm test');

  /* 单行写法仍然要认 —— 回归。两种都试：`run:` 与 `- run:`（无名字的步骤）。 */
  const inline = extractGateCommands('      - run: npm run verify && npm run md:links');
  assert.deepEqual(inline.scripts.sort(), ['md:links', 'verify'], '`- run:` 单行写法也要抽到');
  const named = extractGateCommands('      - name: x\n        run: npm run verify && npm run md:links');
  assert.deepEqual(named.scripts.sort(), ['md:links', 'verify'], '`name:` + `run:` 也要抽到');
});

test('ci-align: `npm test --if-present` 不算门禁（实测漏过的漏洞）', () => {
  /* 这是我自己独立验出来的漏洞：把 upstream-sync 的 `npm test` 改成
     `npm test --if-present`，本检查仍报「齐全」exit 0。

     而那一步后面就是 `git push main` + `git push origin <tag>` ——
     **测试完全不跑也能发布**。

     `--if-present` 的语义恰恰是「脚本不存在就跳过」，即**没有这道门禁**。
     根因是正则匹配了字面量（`npm test(` + 空格）而没匹配语义。 */
  const { tests } = extractGateCommands('        run: |\n          npm test\n');
  assert.ok(tests > 0, '裸 npm test 应算数');

  for (const variant of [
    'npm test --if-present',
    'npm test --if-present=true',
    'npm test -if-present'
  ]) {
    const r = extractGateCommands('        run: |\n          ' + variant + '\n');
    assert.equal(r.tests, 0, variant + ' 必须判为「没有门禁」—— 它的语义是「不存在就跳过」');
  }

  /* 不能误伤：其它参数不该被当成 if-present。 */
  const withReporter = extractGateCommands('        run: |\n          npm test --reporter=dot\n');
  assert.ok(withReporter.tests > 0, '--reporter=dot 不是 if-present，必须仍然算数');
});

test('ci-align: 登记在册的 workflow 被整个删掉必须判红（不得抛异常）', () => {
  /* 硬约束：门禁以退出码为准，脚本/文件缺失算失败但不得降级为通过。
     这里还要挡一个具体坑：抛异常的退出码也是非零，容易被误当成「红得对」，
     但给出来的是栈而不是判据输出 —— 使用者看不出该修什么。 */
  const dir = sandbox(BOTH);
  try {
    rmSync(join(dir, '.github', 'workflows', 'upstream-sync.yml'));
    const r = spawnSync(process.execPath, ['tools/ci-alignment.mjs'], {
      cwd: dir, encoding: 'utf8', windowsHide: true
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.equal(r.status, 1, `缺 workflow 必须判红：\n${out}`);
    assert.match(out, /workflow-missing/, '必须点名这条判据');
    assert.match(out, /upstream-sync\.yml/);
    assert.ok(!/Error: ENOENT/.test(out), '不得靠抛异常过关');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci-align: 未登记的 workflow 要报出来，但不判失败', () => {
  /* 静默放行正是本门禁最初的病根，所以必须说出来；
     但新增一个纯通知型 workflow 不该被逼着登记一堆它不需要的门禁 ——
     那会让人为了过门禁而乱填豁免，反而稀释这张表的可信度。 */
  const result = check({ ...BOTH, 'zz-new.yml': 'name: x\non: push\njobs: {}\n' });
  assert.equal(result.code, 0, `未登记不应判失败：\n${result.out}`);
  assert.match(result.out, /zz-new\.yml/, '必须点名未登记的文件');
  assert.match(result.out, /未登记/);
});

test('ci-align: verifyAll 报出 unsafe 与 unknown，且真实仓库此刻为空', () => {
  const result = verifyAll();
  assert.deepEqual(result.missing, [], '真实仓库不得有缺失步骤');
  assert.deepEqual(result.unsafe, [], '真实仓库的安全属性必须完好');
  assert.deepEqual(result.unknown, [], '两个 workflow 都应已登记');
  /* subset 口径必须真的在查东西，而不是「因为豁免表而恒绿」。 */
  const sync = result.workflows.find((w) => w.file === 'upstream-sync.yml');
  assert.ok(sync, 'upstream-sync.yml 必须出现在结果里');
  assert.equal(sync.mode, 'subset');
});