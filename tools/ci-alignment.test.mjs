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

import { verifyCiAlignment } from './ci-alignment.mjs';

const ROOT = join(import.meta.dirname, '..');

/**
 * 造一份「仓库」，其中 workflow 内容由测试指定。
 *
 * @param {string} workflow CI 内容。
 * @returns {string} 沙箱根。
 */
function sandbox(workflow) {
  const dir = mkdtempSync(join(tmpdir(), 'an-align-'));
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, '.github', 'workflows', 'verify.yml'), workflow, 'utf8');
  /* package.json 必须与真实的一致 —— 判据读的是它的 check 链。 */
  cpSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(join(ROOT, 'tools', 'ci-alignment.mjs'), join(dir, 'tools', 'ci-alignment.mjs'));
  return dir;
}

/**
 * 在沙箱里跑一次对齐检查。
 *
 * @param {string} workflow CI 内容。
 * @returns {{ code: number, out: string }} 结果。
 */
function check(workflow) {
  const dir = sandbox(workflow);
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

test('ci-align: 真实 workflow 此刻是对齐的', () => {
  const result = check(REAL_WORKFLOW);
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
    const result = check(mutated);
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

  const result = check(mutated);
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

  const result = check(allComments);
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

  const result = check(removed);
  assert.equal(result.code, 0,
    `合并到 && 里也应算已覆盖（不应误报缺失）：\n${result.out}`);
});