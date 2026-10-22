/**
 * `tools/text-integrity.mjs` 的行为测试。
 *
 * ## 这个门禁在补什么
 *
 * U+FFFD（替换字符）是**字节损坏**的痕迹，但文件仍然是合法 UTF-8 ——
 * 所以编码检查抓不到它，而 `md-links` 实测报 `errors = 0`。
 * 笔记门禁也不拦：格式完全合法，只是内容坏了。
 *
 * 实测本仓库因此积累了 12 处 U+FFFD，散落在 7 个文件里 —— 包括已合并
 * 进历史的笔记。它们安静地待在段落中间，读者只会以为作者写了个怪字，
 * 不会想到是编码损坏。
 *
 * ## 用临时文件构造，不改真仓库
 *
 * 真仓库只读不写（见 testing/2026-10-19-parallel-tests-must-not-share-real-trees.md）。
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { collectFiles, findProblems, verifyTextIntegrity } from './text-integrity.mjs';

/**
 * U+FFFD 替换字符 —— 用代码点构造，不写字面量。
 *
 * 为什么：本文件会被 `npm run text:integrity` 扫到，而那些字符对门禁而言
 * 就是真损坏。写成字面量会让门禁永远红，且无法区分「测试数据」与「真损坏」。
 * 用代码点构造后测试语义完全不变（生成的就是 U+FFFD），但源码里没有那个字节。
 */
const MOJIBAKE = String.fromCharCode(0xfffd);

/** BEL 控制字符（0x07），同样用代码点构造 —— 理由见上。 */
const BELL = String.fromCharCode(0x07);

const ROOT = join(import.meta.dirname, '..');

/**
 * 在临时目录里造一组文件，跑一次检查。
 *
 * @param {Record<string, string>} files 相对路径 → 内容。
 * @returns {{ ok: boolean, checked: number, errors: string[], dir: string }} 结果。
 */
function inSandbox(files) {
  const dir = mkdtempSync(join(tmpdir(), 'an-text-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      writeFileSync(full, content, 'utf8');
    }
    const result = verifyTextIntegrity(dir);
    return { ok: result.errors.length === 0, ...result, dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('text: 当前仓库没有替换字符或裸控制字符', () => {
  const result = verifyTextIntegrity(ROOT);
  assert.deepEqual(result.errors, [], `不得有字符损坏，实际：${result.errors.join('; ')}`);
  /* 覆盖范围要真实 —— 空集合通过是最隐蔽的假绿。 */
  assert.ok(result.checked > 80, `必须扫到足够多的文件，实际 ${result.checked}`);
});

test('text: 扫描范围覆盖笔记、源码与配置', () => {
  const files = collectFiles(ROOT);
  const joined = files.join('\n');
  assert.match(joined, /AGENTS\.md$/m, '必须扫顶层文档');
  assert.match(joined, /\.agents\/notes\/.+\.md$/m, '必须扫笔记');
  assert.match(joined, /tools\/.+\.mjs$/m, '必须扫工具脚本');
  assert.match(joined, /package\.json$/m, '必须扫配置');

  /* 不该扫的：vendored 上游内容（本仓库无权改）与探针目录。 */
  assert.doesNotMatch(joined, /skills\/agent-notes\//,
    'vendored 上游内容不得被扫 —— 本仓库无权修它');
  assert.doesNotMatch(joined, /\.probe\//, '探针目录不得被扫');
  assert.doesNotMatch(joined, /node_modules\//, 'node_modules 不得被扫');
});

test('text: U+FFFD 必须被拒并指出行号', () => {
  const result = inSandbox({
    'a.md': `# 标题\n\n正常段落。\n\n这里坏了：被截断的文${MOJIBAKE}\n`
  });
  assert.equal(result.ok, false, '含 U+FFFD 必须判失败');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /a\.md/, '必须指出文件');
  assert.match(result.errors[0], /第 5 行/, '必须指出行号');
  assert.match(result.errors[0], /U\+FFFD/, '必须说明是替换字符');
});

test('text: 多处损坏全部报出，不只报第一处', () => {
  const result = inSandbox({
    'a.md': `一${MOJIBAKE}\n二${MOJIBAKE}\n三${MOJIBAKE}\n`
  });
  assert.equal(result.errors.length, 1, '同一文件的多处损坏合并成一条');
  assert.match(result.errors[0], /第 1, 2, 3 行/, '必须列出全部行号');
});

test('text: 裸控制字符必须被拒（换行/制表符不算）', () => {
  /* 控制字符通常是脚本拼接时漏了转义。 */
  const withControl = inSandbox({ 'a.js': `const s = "a${BELL}b";\n` });
  assert.equal(withControl.ok, false, '含裸控制字符必须判失败');

  /* 但制表符与换行是正常文本，不能误报 —— 否则这条门禁会被立刻绕过。 */
  const normal = inSandbox({ 'a.md': '列一\t列二\n第二行\n' });
  assert.equal(normal.ok, true, '制表符与换行不得被误报');
});

test('text: 纯中文与 emoji 必须放行（防止误伤正常内容）', () => {
  const result = inSandbox({
    'a.md': '# 标题：决策笔记\n\n正文里有标点「」与符号 —— 以及 emoji 🎯。\n\n- 列表项\n'
  });
  assert.equal(result.ok, true, '正常中文内容不得被误报');
});

test('text: 空仓库必须判失败（空集合不得当绿）', () => {
  /* 这条用例的前身是「空仓库通过（但 checked 为 0，不算有意义的绿）」——
     它**把假绿记录下来**却没有拦住它：断言写的是 `ok === true`，
     于是「空语料报通过」被钉成了**期望行为**。真实空目录跑出来的
     `checked === 0` + `errors === []`，退出码因此恒为 0。
     语料为空与内容完好在退出码上不可区分，这是最隐蔽的一种假绿。
     现在按 `tools/doc-refs.mjs:364-365` 的同族口径判红。 */
  const result = inSandbox({});
  assert.equal(result.checked, 0, '这里必须是真空目录：collectFiles 一条都没扫到');
  assert.equal(result.ok, false, '空语料必须判失败 —— 空集合不得当绿');
  assert.equal(result.errors.length, 1, `必须恰好一条错误，实际：${result.errors.join('; ')}`);
  assert.match(result.errors[0], /没有扫到任何文本文件/, '必须说明语料为空');
  assert.match(result.errors[0], /空集合不得当绿/, '必须点明这是空集合判据');
});

test('text: 只有非目标后缀的文件也算空语料（不得当绿）', () => {
  /* 语料为空的另一种形态：目录里有文件，但没有一种是 `EXTENSIONS` 认的。
     只判「目录为空」不够 —— 改掉 `EXTENSIONS`（比如某次重构把 `.mjs`
     拼错成 `.ms`）会得到同样的假绿，且目录明明有内容。 */
  const dir = mkdtempSync(join(tmpdir(), 'an-text-nonext-'));
  try {
    writeFileSync(join(dir, 'notes.txt'), '只有 txt。\n', 'utf8');
    writeFileSync(join(dir, 'data.bin'), '二进制。\n', 'utf8');
    const result = verifyTextIntegrity(dir);
    assert.equal(result.checked, 0, '.txt/.bin 都不在扫描范围里');
    assert.match(result.errors.join('\n'), /空集合不得当绿/,
      '没有可扫文件时必须判红，不许拿「目录非空」当绿');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('text: findProblems 返回的行号能定位到实际内容', () => {
  const text = `第一行\n第二行含${MOJIBAKE}损坏\n第三行\n`;
  const { mojibake } = findProblems(text);
  assert.deepEqual(mojibake, [2], '必须报出第 2 行（1 起算）');
});
