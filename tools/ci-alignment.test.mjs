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

test('ci-align: 任何一步加 continue-on-error 必须变红（门禁不许被静默降级）', () => {
  /* `continue-on-error: true` 是 CI 配置里最容易手滑加上的字段：加了它，
     那一步失败只会在日志里留一行警告，**job 照样绿**。本仓库的 `ci:align`
     原有 6 条安全属性都不看这个字段 —— 缺口扫描实测：给「文本完整性」步
     加这一行，完整链 exit 0。 */
  const mutated = REAL_WORKFLOW.replace(
    /      - name: 文本完整性\n        run: npm run text:integrity/,
    '      - name: 文本完整性\n        continue-on-error: true\n        run: npm run text:integrity'
  );
  assert.notEqual(mutated, REAL_WORKFLOW, '构造没生效');

  const result = check({ ...BOTH, 'verify.yml': mutated });
  assert.equal(result.code, 1, `加 continue-on-error 必须变红：\n${result.out}`);
  assert.match(result.out, /no-continue-on-error/);
  assert.match(result.out, /verify\.yml/);
});

test('ci-align: upstream-sync 里的 continue-on-error 同样必须变红', () => {
  /* 那个 workflow 有 contents: write 且会 push main/tag —— 静默降级一道门禁
     的代价比 verify.yml 更大，所以两个文件都要判。 */
  const mutated = REAL_SYNC.replace(
    '        run: |\n          npm run verify',
    '        continue-on-error: true\n        run: |\n          npm run verify'
  );
  assert.notEqual(mutated, REAL_SYNC, '构造没生效');

  const result = check({ ...BOTH, 'upstream-sync.yml': mutated });
  assert.equal(result.code, 1, `加 continue-on-error 必须变红：\n${result.out}`);
  assert.match(result.out, /no-continue-on-error/);
  assert.match(result.out, /upstream-sync\.yml/);
});

test('ci-align: 注释里写 continue-on-error 不算（不算数的是被执行的字段）', () => {
  /* 整行注释掉的字段不会被 YAML 执行，不能因为它存在就判红。
     这条同时钉住判据读的是「会被执行的内容」而不是全文。 */
  const mutated = REAL_WORKFLOW.replace(
    '      - name: 文本完整性',
    '      # continue-on-error: true\n      - name: 文本完整性'
  );
  assert.notEqual(mutated, REAL_WORKFLOW, '构造没生效');

  const result = check({ ...BOTH, 'verify.yml': mutated });
  assert.equal(result.code, 0, `注释里出现不该判红：\n${result.out}`);
});

test('ci-align: continue-on-error: false 是允许的（不降级）', () => {
  /* 不能把判据写成「出现 continue-on-error 就红」—— 显式写 false 的人
     表达的是「这道不许降级」，与本门禁的意图一致。 */
  const mutated = REAL_WORKFLOW.replace(
    /      - name: 文本完整性\n        run: npm run text:integrity/,
    '      - name: 文本完整性\n        continue-on-error: false\n        run: npm run text:integrity'
  );
  assert.notEqual(mutated, REAL_WORKFLOW, '构造没生效');

  const result = check({ ...BOTH, 'verify.yml': mutated });
  assert.equal(result.code, 0, `continue-on-error: false 不该判红：\n${result.out}`);
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

/* ═══════════════════════════════════════════════════════════════════════
 * 以下覆盖本轮新增的六条判据（上游 A 的 CI 安全属性）。
 *
 * 病根：`verify.yml` 会跑仓库里的脚本（npm test 会执行 tests/ 与 tools/），
 * 而 `actions/checkout` 默认把 GITHUB_TOKEN 写进 `.git/config` ——
 * 被测代码一旦执行 `git push`，那一次「测试」就变成一次 push。
 * 上游 A 的 9 处 checkout 全部带 `persist-credentials: false`。
 * ═══════════════════════════════════════════════════════════════════════ */

test('ci-align: verify.yml 缺 concurrency 块必须变红', () => {
  /* 同一个 PR 上新推的提交会让旧的那次验证白跑完，并给出一个过期的结论。 */
  const mutated = REAL_WORKFLOW.replace(/^concurrency:\n[\s\S]*?^jobs:/m, 'jobs:');
  assert.notEqual(mutated, REAL_WORKFLOW, '构造没生效');

  const result = check({ ...BOTH, 'verify.yml': mutated });
  assert.equal(result.code, 1, `缺 concurrency 必须变红：\\n${result.out}`);
  assert.match(result.out, /has-concurrency/);
  assert.match(result.out, /verify\.yml/);
});

test('ci-align: verify.yml 无条件 cancel-in-progress: true 必须变红', () => {
  /* ★ 这是**刻意不照抄上游**的地方。上游 A 写的是无条件 true
     （.github/workflows/ci.yml 的 concurrency 块）；我们收窄成按事件判断。
     理由：我们 main 的绿色是 branch protection 强制的**发布凭据**，
     一次 main 验证被下一次运行取消掉，就等于那次发布没有验证记录。 */
  const mutated = REAL_WORKFLOW.replace(
    /^(\s*)cancel-in-progress:.*$/m,
    '$1cancel-in-progress: true'
  );
  assert.notEqual(mutated, REAL_WORKFLOW, '构造没生效');
  assert.match(mutated, /^\s*cancel-in-progress: true$/m,
    '变异必须落在真正的配置行上，而不是注释里');

  const result = check({ ...BOTH, 'verify.yml': mutated });
  assert.equal(result.code, 1, `无条件取消必须变红：\\n${result.out}`);
  assert.match(result.out, /cancels-only-superseded-pr/);
});

test('ci-align: verify.yml 按 pull_request 收窄的取消写法必须通过', () => {
  /* 不能把判据写成「不许有 cancel-in-progress」—— 那会逼人把整块删掉。
     合法形态：只在 PR 上取消（同一个 PR 的旧提交验证作废是合理的）。 */
  const result = check(BOTH);
  assert.equal(result.code, 0, `按事件收窄必须通过：\\n${result.out}`);
  assert.match(REAL_WORKFLOW, /cancel-in-progress:.*pull_request/,
    '真实 workflow 应当按 pull_request 收窄');
});

test('ci-align: 任一 checkout 缺 persist-credentials: false 必须变红', () => {
  /* verify.yml 里有**两处** checkout（verify job 与 upstream-drift job）。
     判据必须逐处查 —— 只查文件里「有没有出现过」会漏掉「一处关一处没关」。 */
  const mutated = REAL_WORKFLOW.replace(
    '          persist-credentials: false',
    '          # persist-credentials: false'
  );
  assert.notEqual(mutated, REAL_WORKFLOW, '构造没生效');

  const result = check({ ...BOTH, 'verify.yml': mutated });
  assert.equal(result.code, 1, `少一处就必须变红：\\n${result.out}`);
  assert.match(result.out, /no-persisted-credentials/);
});

test('ci-align: upstream-sync 必须保留凭据（照抄上游的 false 会让发布失败）', () => {
  /* 反向判据：发布 job 靠这份凭据 push main 与 push tag。
     上游 A 的只读 workflow 用 persist-credentials: false，
     照抄到发布 job 上会让发布静默失败 —— 这就是「照抄」要有的判据。 */
  const mutated = REAL_SYNC.replace(
    '          token: ${{ secrets.GITHUB_TOKEN }}',
    '          token: ${{ secrets.GITHUB_TOKEN }}\n          persist-credentials: false'
  );
  assert.notEqual(mutated, REAL_SYNC, '构造没生效');

  const result = check({ ...BOTH, 'upstream-sync.yml': mutated });
  assert.equal(result.code, 1, `发布 job 关掉凭据必须变红：\\n${result.out}`);
  assert.match(result.out, /keeps-credentials-for-push/);
});

test('ci-align: upstream-sync 的 cancel-in-progress 必须为 false', () => {
  /* 那个 job 会 push main 与 push tag。中途取消会留下半推状态
     （tag 推了 main 没推，或反过来）—— 发布状态是撕裂的。 */
  const mutated = REAL_SYNC.replace(
    '  cancel-in-progress: false',
    '  cancel-in-progress: true'
  );
  assert.notEqual(mutated, REAL_SYNC, '构造没生效');

  const result = check({ ...BOTH, 'upstream-sync.yml': mutated });
  assert.equal(result.code, 1, `发布 job 可取消必须变红：\\n${result.out}`);
  assert.match(result.out, /never-cancels-a-push/);
});

test('ci-align: continue-on-error 的等价写法都要被拦（True / "true" / 行尾注释）', () => {
  /* 本轮 CodeRabbit 在 PR #29 上指出的真实绕过面：原判据只认
     「裸小写 true 且行尾干净」这一种形态，于是下面三种都能静默降级一道门禁。 */
  const forms = [
    'continue-on-error: True',
    'continue-on-error: "true"',
    'continue-on-error: true # 临时放行，稍后修'
  ];

  for (const form of forms) {
    /* 挂在第一条真正跑门禁的步骤上：那一步被降级等于门禁变成警告。 */
    const mutated = REAL_WORKFLOW.replace(
      '      - name: 包自检',
      `      - name: 包自检\n        ${form}`
    );
    assert.notEqual(mutated, REAL_WORKFLOW, '构造没生效');
    const result = check({ ...BOTH, 'verify.yml': mutated });
    assert.equal(result.code, 1, `${form} 必须被发现：\n${result.out}`);
    assert.match(result.out, /no-continue-on-error/);
  }
});

test('ci-align: cancel-in-progress 只要不是按 event_name 收窄就必须红', () => {
  /* 原判据只要求这一行里出现 `pull_request`，于是一行
     `${{ github.ref != 'refs/heads/main' }}  # 见 pull_request 说明`
     也能过关 —— 而它在 main 上照样会取消正在跑的发布验证。 */
  const loose = REAL_WORKFLOW.replace(
    / {2}cancel-in-progress:[^\n]*/,
    "  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }} # 见 pull_request 说明"
  );
  assert.notEqual(loose, REAL_WORKFLOW, '构造没生效');
  const result = check({ ...BOTH, 'verify.yml': loose });
  assert.equal(result.code, 1, `宽松写法必须被拦：\n${result.out}`);
  assert.match(result.out, /cancels-only-superseded-pr/);
});

test('ci-align: 表达式的 continue-on-error 也拦（列举法补不完，默认拒绝）', () => {
  /* 第二版判据列举了 true/True/"true"/${{ true }}；CodeRabbit 在 PR #30 上
     立刻用 `${{ true || false }}` 绕过 —— 它求值为 true，而正则不认识。
     结论：这类判据必须默认拒绝，只放行字面量 false。 */
  const forms = ['${{ true || false }}', '${{ matrix.experimental }}', 'true && true'];

  for (const form of forms) {
    const mutated = REAL_WORKFLOW.replace(
      '      - name: 包自检',
      `      - name: 包自检
        continue-on-error: ${form}`
    );
    assert.notEqual(mutated, REAL_WORKFLOW, '构造没生效');
    const result = check({ ...BOTH, 'verify.yml': mutated });
    assert.equal(result.code, 1, `${form} 必须被发现：${result.out}`);
    assert.match(result.out, /no-continue-on-error/);
  }
});

test('ci-align: 语义相反的 cancel-in-progress 表达式必须红（只认 == 收窄）', () => {
  /* CodeRabbit 在 PR #30 上的第二条：`${{ github.event_name != 'pull_request' }}`
     里两个标识符按顺序出现，旧判据就放过了 —— 而它在 push 上才取消，
     正好取消掉要保住的发布验证。 */
  const inverted = REAL_WORKFLOW.replace(
    / {2}cancel-in-progress:[^\n]*/,
    "  cancel-in-progress: ${{ github.event_name != 'pull_request' }}"
  );
  assert.notEqual(inverted, REAL_WORKFLOW, '构造没生效');
  const result = check({ ...BOTH, 'verify.yml': inverted });
  assert.equal(result.code, 1, `反向表达式必须被拦：${result.out}`);
  assert.match(result.out, /cancels-only-superseded-pr/);
});

test('ci-align: continue-on-error 的位置写法都要被识别（列表项/冒号前空格/flow-style 映射）', () => {
  /* CodeRabbit 在 PR #31 上指出：识别式写成 `^\s*continue-on-error:` 时，
     `- continue-on-error: true`（行内序列表项）与 `continue-on-error : true`
     （冒号前空格）都不会进违规列表 ⇒ 门禁假绿。 */
  const forms = [
    '        - continue-on-error: true',
    '        continue-on-error : true',
    /* flow-style 映射：键不在行首，位置这一维度上的漏法（CodeRabbit PR #31）。 */
    '        - {name: 包自检副本, run: exit 1, continue-on-error: true}',
    /* 引号键：YAML 解析成同一个键，但键名外面多了一层引号（CodeRabbit PR #31）。 */
    '        "continue-on-error": true'
  ];
  for (const form of forms) {
    const mutated = REAL_WORKFLOW.replace('      - name: 包自检', `      - name: 包自检\n${form}`);
    assert.notEqual(mutated, REAL_WORKFLOW, '构造没生效');
    const result = check({ ...BOTH, 'verify.yml': mutated });
    assert.equal(result.code, 1, `${form} 必须被发现：${result.out}`);
    assert.match(result.out, /no-continue-on-error/);
  }
});

test('ci-align: cancel-in-progress 的引号键与 flow 映射也要被认（键的写法不是证据）', () => {
  /* 与 continue-on-error 同一个教训：判据不能要求键在行首、无引号。
     这里用「引号键 + 语义相反的值」一次性证明两件事都成立。 */
  const quoted = REAL_WORKFLOW.replace(
    / {2}cancel-in-progress:[^\n]*/,
    '  "cancel-in-progress": ${{ github.event_name != \'pull_request\' }}'
  );
  assert.notEqual(quoted, REAL_WORKFLOW, '构造没生效');
  const r1 = check({ ...BOTH, 'verify.yml': quoted });
  assert.equal(r1.code, 1, `引号键里的反向值必须被拦：\n${r1.out}`);
  assert.match(r1.out, /cancels-only-superseded-pr/);

  /* 引号键 + 合法值：键的写法不该让它变红。 */
  const ok = REAL_WORKFLOW.replace(
    / {2}cancel-in-progress:[^\n]*/,
    '  "cancel-in-progress": ${{ github.event_name == \'pull_request\' }}'
  );
  const r2 = check({ ...BOTH, 'verify.yml': ok });
  assert.equal(r2.code, 0, `引号键 + 合法值必须通过：\n${r2.out}`);
});

test('ci-align: YAML 转义键（\\u002d 解码成连字符）与裸键是同一个键', () => {
  /* CodeRabbit 在 PR #31 上指出的第五种写法：双引号里的 `\u002d` 解码后就是
     `-`，GitHub Actions 把它当成同一个键。列举写法补不完，所以判据改成
     「先把键名解码，再比字符串」。 */
  const escaped = REAL_WORKFLOW.replace(
    '      - name: 包自检',
    '      - name: 包自检\n        "continue\\u002don-error": true'
  );
  assert.notEqual(escaped, REAL_WORKFLOW, '构造没生效');
  const r1 = check({ ...BOTH, 'verify.yml': escaped });
  assert.equal(r1.code, 1, `转义键必须被解码成同一个键并判红：\n${r1.out}`);
  assert.match(r1.out, /no-continue-on-error/);

  /* 同一个解码规则也要覆盖 cancel-in-progress：`\u002din\u002d` 全是连字符。 */
  const cancelEscaped = REAL_WORKFLOW.replace(
    / {2}cancel-in-progress:[^\n]*/,
    '  "cancel\\u002din\\u002dprogress": ${{ github.event_name != \'pull_request\' }}'
  );
  assert.notEqual(cancelEscaped, REAL_WORKFLOW, '构造没生效');
  const r2 = check({ ...BOTH, 'verify.yml': cancelEscaped });
  assert.equal(r2.code, 1, `转义的 cancel-in-progress 反向值必须判红：\n${r2.out}`);
  assert.match(r2.out, /cancels-only-superseded-pr/);
});

test('ci-align: 未闭合的引号不许把后面的键吞掉（shell 片段里的引号不是 YAML 键引号）', () => {
  /* 实测过的真事故：改成「全文扫带引号的键」后，`verify.yml` 里
     `if [ "$NOTES_SUPERSESSION_BASE" = "000…" ]; then` 的引号与后面某一行的
     引号被配成一对，**跨行吞掉十几行**，中间新插的 continue-on-error 一起消失
     —— 判据看不见它，用例红在「本该红」。
     所以引号必须同行闭合，且键只能起于行首、空白、`{`、`,`、`-`。 */
  const mutated = REAL_WORKFLOW.replace(
    '      - name: 包自检',
    /* 一对一：前面一个**没闭合**的引号，后面几行再来一个引号。
       允许引号跨行配对的实现会从第一个引号一路配到后面的引号，
       把中间的键整段吞掉 —— 这正是改造时的真事故。 */
    '      - name: 包自检\n        run: echo "开头\n        continue-on-error: true\n        run: echo 结尾"'
  );
  assert.notEqual(mutated, REAL_WORKFLOW, '构造没生效');
  const result = check({ ...BOTH, 'verify.yml': mutated });
  assert.equal(result.code, 1, `跨行引号之间的键仍然必须被发现：\n${result.out}`);
  assert.match(result.out, /no-continue-on-error/);
});
