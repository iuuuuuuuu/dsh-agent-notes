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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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

function makeBilingualRepo(budgets) {
  const dir = makeRepo(budgets);
  writeFileSync(join(dir, 'README.md'), '短文档', 'utf8');
  writeFileSync(join(dir, 'README.en.md'), 'Short document', 'utf8');
  return dir;
}

test('doc-budget: 双语对完整且预算相同通过', () => {
  const dir = makeBilingualRepo({ 'README.md': 100, 'README.en.md': 100 });
  try {
    assert.equal(run(dir).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doc-budget: 自动放宽后双语预算仍相同', () => {
  const dir = makeBilingualRepo({ 'README.md': 3, 'README.en.md': 3 });
  try {
    writeFileSync(join(dir, 'README.en.md'), 'one two three four five six', 'utf8');
    assert.equal(run(dir).code, 1);
    assert.equal(run(dir, ['--update']).code, 0);
    const { budgets } = JSON.parse(readFileSync(join(dir, 'tools', 'doc-budget.json'), 'utf8'));
    assert.equal(budgets['README.md'], 6);
    assert.equal(budgets['README.en.md'], 6);
    assert.equal(run(dir).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doc-budget: 双语对缺少英文预算必须红且不写清单', () => {
  const dir = makeBilingualRepo({ 'README.md': 100 });
  try {
    const manifest = join(dir, 'tools', 'doc-budget.json');
    const before = readFileSync(manifest);
    for (const args of [[], ['--update']]) {
      const result = run(dir, args);
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /双语文档预算缺少 README\.en\.md/);
      assert.deepEqual(readFileSync(manifest), before);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doc-budget: 双语预算值不同必须红且不写清单', () => {
  const dir = makeBilingualRepo({ 'README.md': 100, 'README.en.md': 101 });
  try {
    const manifest = join(dir, 'tools', 'doc-budget.json');
    const before = readFileSync(manifest);
    for (const args of [[], ['--update']]) {
      const result = run(dir, args);
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /预算值必须相同/);
      assert.deepEqual(readFileSync(manifest), before);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doc-budget: 空预算清单必须失败，包括 --update', () => {
  const dir = makeRepo({});
  try {
    const manifest = join(dir, 'tools', 'doc-budget.json');
    const original = readFileSync(manifest);
    // 固定到过去，避免文件系统时间精度使同内容重写逃过检查。
    const sentinel = new Date('2000-01-01T00:00:00Z');
    utimesSync(manifest, sentinel, sentinel);
    const originalMtime = statSync(manifest).mtimeMs;
    for (const args of [[], ['--update']]) {
      const result = run(dir, args);
      assert.equal(result.code, 2, `空清单不得通过：${JSON.stringify(args)}\n${result.out}`);
      assert.match(result.out, /预算清单至少需要一个预算项/);
      assert.deepEqual(readFileSync(manifest), original, '失败时清单原始内容必须保持不变');
      assert.equal(statSync(manifest).mtimeMs, originalMtime, '失败时不得重写相同内容');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test('doc-budget: 清单里登记的是目录 → 判红，不许抛 EISDIR 崩掉', () => {
  /* 这条形态此前**没有用例**，而它真实可触发：清单里写 `"tools": 100000`
     （目录名而不是文件名）时，旧实现直接 `readFileSync(dir)` 抛未捕获的 `EISDIR`，
     Node 打一整段栈后 exit 1 —— 与「正常判红」退出码完全相同，谁都看不出区别。
     本仓库另一篇笔记（`2026-10-21-crash-is-not-a-red-gate.md`）记的就是这个形态：
     崩溃既不是通过也不是判红，因为没人会去查一句栈。
     现在要求：exit 1、输出里点出这一项是目录、**且不带栈**。 */
  const dir = makeRepo({ 'AGENTS.md': 100, tools: 100000 });
  try {
    writeFileSync(join(dir, 'AGENTS.md'), '短', 'utf8');
    const { code, out } = run(dir);
    assert.equal(code, 1, '登记目录必须判红');
    assert.match(out, /它是目录/, '必须说清「这是目录，不是文件」');
    assert.match(out, /无法当作文件读取/, '必须给出总结句，而不是只列一行');
    assert.doesNotMatch(out, /\n\s+at /, '不许把栈打到屏幕上 —— 崩溃不是判红');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doc-budget: 目录键在 --update 下也必须判红（不许被静默跳过）', () => {
  /* 自审时发现的第二个洞：`--update` 会 `if (row.actual === undefined) continue`，
     于是目录键在 `--update` 下什么都不做、`raised` 为空、**exit 0**。
     「没报错」与「已经修好」外观一致，是最坏的一种绿。
     这里要求 `--update` 也红，且**不写清单**（清单此时是坏的，不该被当成结果保存）。 */
  const dir = makeRepo({ 'AGENTS.md': 100, tools: 100000 });
  try {
    writeFileSync(join(dir, 'AGENTS.md'), '短', 'utf8');
    const before = readFileSync(join(dir, 'tools', 'doc-budget.json'), 'utf8');
    const { code, out } = run(dir, ['--update']);
    assert.equal(code, 1, `--update 遇到目录键必须红，实际 ${code}`);
    assert.match(out, /它是目录/);
    assert.equal(readFileSync(join(dir, 'tools', 'doc-budget.json'), 'utf8'), before,
      '--update 不许把坏清单当成结果写回去');
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

test('doc-budget: --update 只在超预算时放宽，绝不收紧', () => {
  /* 实测踩过的陷阱：原实现无条件把预算设成当前值，于是 2100 → 2080，
     余量归零 —— 再加一个字就红。而它的提示写着「放宽预算需要有理由」，
     叫「放宽」实际做「收紧到极限」，使用者会以为自己在松绑。 */
  const dir = makeRepo({ 'AGENTS.md': 100 });
  try {
    writeFileSync(join(dir, 'AGENTS.md'), '短文档', 'utf8');
    const manifest = join(dir, 'tools', 'doc-budget.json');
    const original = readFileSync(manifest);
    const sentinel = new Date('2000-01-01T00:00:00Z');
    utimesSync(manifest, sentinel, sentinel);
    const originalMtime = statSync(manifest).mtimeMs;
    assert.equal(run(dir, ['--update']).code, 0, '--update 应成功退出');
    const after = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.equal(after.budgets['AGENTS.md'], 100, '在预算内时不得收紧（必须保持 100，不能变成 3）');
    assert.deepEqual(readFileSync(manifest), original, '未超预算时原始内容必须保持不变');
    assert.equal(statSync(manifest).mtimeMs, originalMtime, '未超预算时不得重写相同内容');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doc-budget: --update 在超预算时把预算提到当前值', () => {
  const dir = makeRepo({ 'AGENTS.md': 3 });
  try {
    writeFileSync(join(dir, 'AGENTS.md'), '十个字符的文档内容', 'utf8');
    assert.equal(run(dir).code, 1, '前置：应超预算');
    assert.equal(run(dir, ['--update']).code, 0, '--update 应成功');
    const after = JSON.parse(readFileSync(join(dir, 'tools', 'doc-budget.json'), 'utf8'));
    assert.equal(after.budgets['AGENTS.md'], 9, '应放宽到当前值 9');
    assert.equal(run(dir).code, 0, '放宽后应通过');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doc-budget: --update 不动未超预算的文件', () => {
  /* 一次放宽不该顺手把别的文件也收紧 —— 那会让「我放宽 A」意外
     把 B 的余量清零，下次改 B 就莫名其妙红了。 */
  const dir = makeRepo({ 'A.md': 100, 'B.md': 2 });
  try {
    writeFileSync(join(dir, 'A.md'), '短', 'utf8');
    writeFileSync(join(dir, 'B.md'), '五个字符内容', 'utf8');
    assert.equal(run(dir, ['--update']).code, 0, '--update 应成功');
    const after = JSON.parse(readFileSync(join(dir, 'tools', 'doc-budget.json'), 'utf8'));
    assert.equal(after.budgets['A.md'], 100, 'A 在预算内，不得被改动');
    assert.equal(after.budgets['B.md'], 6, 'B 超预算，应放宽到 6');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
