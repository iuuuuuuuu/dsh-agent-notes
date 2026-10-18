/**
 * 文档预算门禁的测试。
 *
 * 借鉴 deepseek-harness 的 `doc-budgets.manifest.json`：给「会持续增长」的
 * 散文文件设字数上限。理由不是「简洁好看」，而是这些文件每次改动都会
 * 吸收一句「顺便补上」，而**没有任何东西会阻止它们增长**。
 * 实测本仓库 AGENTS.md 在一天内从 148 词涨到 275 词。
 *
 * 测的重点：
 *   1. 超预算 → **必须红**（这是它存在的唯一理由）；
 *   2. 在预算内 → 绿；
 *   3. 清单缺失/损坏 → 退出码 2，绝不能当成通过。
 */
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(PACKAGE_ROOT, 'tools', 'doc-budget.mjs');
const NODE = process.execPath;

/**
 * 造一个带预算门禁的临时仓库。
 *
 * @param {Record<string, number>} budgets 预算清单。
 * @returns {string} 仓库目录。
 */
function makeRepo(budgets) {
  const dir = mkdtempSync(join(tmpdir(), 'an-budget-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  copyFileSync(SCRIPT, join(dir, 'tools', 'doc-budget.mjs'));
  writeFileSync(join(dir, 'tools', 'doc-budget.json'),
    `${JSON.stringify({ budgets }, null, 2)}\n`, 'utf8');
  return dir;
}

/**
 * 跑门禁，返回退出码与输出。
 *
 * @param {string} dir 仓库目录。
 * @param {string[]} [args] 额外参数。
 * @returns {{ code: number, out: string }} 结果。
 */
function run(dir, args = []) {
  const r = spawnSync(NODE, [join(dir, 'tools', 'doc-budget.mjs'), ...args], {
    cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env }
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('doc-budget: 超预算 → 必须红', () => {
  const dir = makeRepo({ 'AGENTS.md': 10 });
  try {
    /* 20 个中文字符，超过 10 的预算。 */
    writeFileSync(join(dir, 'AGENTS.md'), '这是一个很长的文档内容用来超过预算限制的测试文本', 'utf8');
    const { code, out } = run(dir);
    assert.equal(code, 1, `超预算必须红，实际 exit=${code}\n${out}`);
    assert.match(out, /超/, '诊断必须说明超了多少');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doc-budget: 在预算内 → 绿', () => {
  const dir = makeRepo({ 'AGENTS.md': 100 });
  try {
    writeFileSync(join(dir, 'AGENTS.md'), '短文档', 'utf8');
    assert.equal(run(dir).code, 0, '在预算内必须绿');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doc-budget: 中文按字计，不被 wc -w 低估', () => {
  /* 这是实现的核心：中文没有空格分词，`wc -w` 会把一整段算成 1 个词。
     若按词计数，中文文档的增长永远触发不了预算。 */
  const dir = makeRepo({ 'AGENTS.md': 20 });
  try {
    /* 正好 30 个中文字符，`wc -w` 会报 1。 */
    writeFileSync(join(dir, 'AGENTS.md'), '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十', 'utf8');
    assert.equal(run(dir).code, 1, '30 个中文字符超过 20 预算必须红（不能按词算）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doc-budget: 清单里的文件不存在 → 红', () => {
  /* 文件被删或改名后，预算项会静默失效 —— 那等于那个文件失去保护。
     这里要求它变红，而不是当成「无需检查」。 */
  const dir = makeRepo({ 'AGENTS.md': 100, 'docs/MISSING.md': 100 });
  try {
    writeFileSync(join(dir, 'AGENTS.md'), '短', 'utf8');
    const { code, out } = run(dir);
    assert.equal(code, 1, '清单里有但文件不存在必须红');
    assert.match(out, /不存在/, '必须说明文件缺失');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doc-budget: 清单损坏 → 退出码 2', () => {
  const dir = makeRepo({ 'AGENTS.md': 100 });
  try {
    writeFileSync(join(dir, 'tools', 'doc-budget.json'), '{ 这不是 JSON', 'utf8');
    const { code, out } = run(dir);
    assert.equal(code, 2, `清单损坏必须 exit 2，实际 ${code}`);
    assert.match(out, /无效|解析/, '必须说明「这不是已合规」');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doc-budget: --update 把当前值写回清单', () => {
  const dir = makeRepo({ 'AGENTS.md': 5 });
  try {
    writeFileSync(join(dir, 'AGENTS.md'), '十个字符的文档内容', 'utf8');
    assert.equal(run(dir, ['--update']).code, 0, '--update 应成功');
    const after = JSON.parse(readFileSync(join(dir, 'tools', 'doc-budget.json'), 'utf8'));
    assert.equal(after.budgets['AGENTS.md'], 9, '应写回实际计数（9 个中文字符）');
    /* 写回之后再检查应当绿 —— 证明 --update 真的放宽了预算。 */
    assert.equal(run(dir).code, 0, '放宽后应通过');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
