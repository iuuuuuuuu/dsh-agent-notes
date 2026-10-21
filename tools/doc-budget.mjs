#!/usr/bin/env node
/**
 * 文档预算：给「会持续增长」的散文文件设字数上限。
 *
 * ## 为什么需要（借鉴 deepseek-harness 的 doc-budgets.manifest.json）
 *
 * DSH 给它的 `AGENTS.md` 等 7 个文件各设了字数预算（2080 / 1430 / 2410…）。
 * 理由不是「简洁好看」，而是：**这些文件每一次改动都会增加几句，
 * 而没有任何东西会阻止它们增长**。
 *
 * 实测本仓库：`AGENTS.md` 从 148 词涨到 275 词（不到一天翻倍）。
 * 没有上限时，它会持续吸收每一次「顺便补一句」，
 * 最终变成一份没人读完、也没人敢删的长文档 —— 而删它又需要
 * 「哪些还成立」的判断，成本高到没人做。
 *
 * 预算的作用是把「该不该加这一句」从**模糊的自觉**变成**一次明确的取舍**：
 * 想加，就得先删掉同样多的字。
 *
 * ## 为什么用「词数」而不是行数或字节
 *
 * 中文按字计、英文按词计，`wc -w` 对中文会严重低估（中文没有空格分词）。
 * 所以这里对 CJK 字符逐个计数，对非 CJK 按词计数，两者相加。
 * 这不是精确的语言学度量，但作为**趋势与上限**足够 ——
 * 预算的价值在于「涨了要有人看」，不在于精确到个位。
 *
 * ## 用法
 *
 *   node tools/doc-budget.mjs            # 检查
 *   node tools/doc-budget.mjs --update   # 把当前值写回 manifest（有意放宽时用）
 *
 * 退出码：0=在预算内；1=超预算；2=无法判定。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = join(PACKAGE_ROOT, 'tools', 'doc-budget.json');

/**
 * 统计一段文本的「计费单位」数。
 *
 * CJK 字符逐个计 1；非 CJK 按空白分词计 1。
 * 这样中英混排时两边都不会被系统性低估。
 *
 * @param {string} text 文本。
 * @returns {number} 计费单位数。
 */
function billableUnits(text) {
  /* CJK 统一表意文字 + 扩展 A + 兼容表意文字 + 常用中文标点。 */
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g) ?? [];
  const rest = text
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g, ' ')
    .split(/\s+/)
    .filter((token) => token !== '');
  return cjk.length + rest.length;
}

/**
 * 读取预算清单。
 *
 * @returns {{budgets: Record<string, number>, error?: string}} 清单或错误。
 */
function loadManifest() {
  if (!existsSync(MANIFEST)) {
    return { budgets: undefined, error: `预算清单不存在：${MANIFEST}` };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch (error) {
    return { budgets: undefined, error: `预算清单解析失败：${error.message}` };
  }
  const budgets = raw?.budgets;
  if (budgets === null || typeof budgets !== 'object' || Array.isArray(budgets)) {
    return { budgets: undefined, error: '预算清单缺少 budgets 对象。' };
  }
  if (Object.keys(budgets).length === 0) {
    return { budgets: undefined, error: '预算清单至少需要一个预算项。' };
  }
  for (const [file, limit] of Object.entries(budgets)) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
      return { budgets: undefined, error: `预算项 ${file} 必须是正整数。` };
    }
  }
  return { budgets };
}

const update = process.argv.includes('--update');
const { budgets, error } = loadManifest();
if (budgets === undefined) {
  console.error('✖ 读不到文档预算清单，本次检查无效。退出码 2。');
  console.error(`  ${error}`);
  process.exit(2);
}

const rows = [];
for (const [file, limit] of Object.entries(budgets)) {
  const full = join(PACKAGE_ROOT, file);
  if (!existsSync(full)) {
    rows.push({ file, actual: undefined, limit, status: 'missing' });
    continue;
  }
  const actual = billableUnits(readFileSync(full, 'utf8'));
  rows.push({ file, actual, limit, status: actual > limit ? 'over' : 'ok' });
}

/* 单一真源：`over` 只从 rows 的 status 派生。
   之前这里同时写了 `status: ...` 和 `if (actual > limit) over += 1` ——
   两处独立判定同一件事，故障注入打到其中一处时另一处仍在生效，
   于是「注入后测试仍全绿」，掩盖了真实行为。 */
const over = rows.filter((row) => row.status !== 'ok').length;

if (update) {
  /* 只**放宽**，绝不收紧。
     实测踩过的陷阱：原实现无条件把预算设成当前值，于是 2100 → 2080，
     余量归零 —— 再加一个字就红。而它的提示写着「放宽预算需要有理由」，
     叫「放宽」实际做「收紧到极限」，使用者会以为自己在松绑。
     现在只有真正超预算的文件才被提到当前值；其余原样保留。 */
  const next = { ...budgets };
  const raised = [];
  for (const row of rows) {
    if (row.actual === undefined) continue;
    if (row.actual > row.limit) {
      next[row.file] = row.actual;
      raised.push(`${row.file}: ${row.limit} → ${row.actual}`);
    }
  }

  if (raised.length === 0) {
    console.log('没有文件超出预算，无需放宽。');
    console.log('（--update 只放宽，不会把预算收紧到当前值 —— 那会让余量归零。）');
    process.exit(0);
  }

  writeFileSync(MANIFEST, `${JSON.stringify({ budgets: next }, null, 2)}\n`, 'utf8');
  console.log('已放宽以下预算：');
  for (const line of raised) console.log(`  ${line}`);
  console.log('⚠ 放宽需要有理由 —— 它存在的意义就是让「再加一句」成为一次取舍。');
  process.exit(0);
}

for (const row of rows) {
  if (row.status === 'missing') {
    console.error(`  ✖ ${row.file} — 预算清单里有它，但文件不存在`);
    continue;
  }
  const mark = row.status === 'ok' ? '✔' : '✖';
  const delta = row.actual - row.limit;
  const tail = row.status === 'ok'
    ? `（余 ${row.limit - row.actual}）`
    : `（超 ${delta}）`;
  console.log(`  ${mark} ${row.file}: ${row.actual} / ${row.limit} ${tail}`);
}

if (over > 0) {
  console.error('');
  console.error(`✖ ${over} 个文件超出预算。`);
  console.error('这不是「文档太长不好看」—— 它意味着这些文件正在吸收每一次');
  console.error('「顺便补一句」，而没有任何东西阻止它们变成没人读完的长文。');
  console.error('');
  console.error('两种处理：');
  console.error('  ① 删掉同样多的内容（首选：预算的意义就是逼出这个取舍）');
  console.error('  ② 确实需要更多空间时，明确放宽并说明理由：');
  console.error('     node tools/doc-budget.mjs --update');
  process.exit(1);
}

console.log(`\n文档预算通过：${rows.length} 个文件都在预算内。`);
