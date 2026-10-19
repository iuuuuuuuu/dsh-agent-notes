/**
 * `tools/md-links.mjs` 的行为测试 —— 仓库内 Markdown 相对链接校验。
 *
 * ## 这个门禁在补什么
 *
 * 笔记门禁只验**笔记之间**的链接；`verify-plugin.mjs` 只验双语文档与徽标
 * 存在。两者都不管「README 指向的那个文件还在不在」。断链最容易在这两个
 * 时刻出现：归档/删除笔记时入站链接没人修、重命名文件后忘了改链接。
 *
 * ## 测试策略
 *
 * 全部用例都往**真实的 AGENTS.md** 末尾追加一段 Markdown，跑校验，然后
 * 还原。这样测的是对真实仓库的扫描结果，而不是某个造出来的假目录 ——
 * 后者会掩盖「扫描范围是否真的覆盖到了」这类问题。
 *
 * 每批都用 try/finally 还原，避免失败时把仓库改脏。
 */
import { strict as assert } from 'node:assert';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { verifyMarkdownLinks } from './md-links.mjs';

const ROOT = join(import.meta.dirname, '..');
const AGENTS = join(ROOT, 'AGENTS.md');

/**
 * 在 AGENTS.md 末尾临时追加一段 Markdown，跑校验后还原。
 *
 * @param {string} markdown 要追加的内容。
 * @returns {ReturnType<typeof verifyMarkdownLinks>} 校验结果。
 */
function withAppended(markdown) {
  const backup = readFileSync(AGENTS, 'utf8');
  try {
    writeFileSync(AGENTS, `${backup}\n\n${markdown}\n`);
    return verifyMarkdownLinks();
  } finally {
    writeFileSync(AGENTS, backup);
  }
}

test('md-links: 当前仓库所有相对链接都可达', () => {
  const result = verifyMarkdownLinks();
  assert.deepEqual(result.errors, [], `不得有断链，实际：${result.errors.join('; ')}`);
  /* 覆盖范围要真实：文档数与链接数都不该是 0 —— 空集合通过是最隐蔽的假绿。 */
  assert.ok(result.checked > 20, `必须扫描到足够多的文档，实际 ${result.checked}`);
  assert.ok(result.links > 30, `必须检查到足够多的链接，实际 ${result.links}`);
});

test('md-links: 指向不存在文件时报告错误并指出位置', () => {
  const result = withAppended('见 [缺失](does-not-exist-zzz.md)。');
  assert.equal(result.errors.length, 1, '必须恰好报告一处');
  assert.match(result.errors[0], /AGENTS\.md/, '必须指出是哪个文档');
  assert.match(result.errors[0], /does-not-exist-zzz\.md/, '必须指出是哪个目标');
});

test('md-links: 图片语法 `![alt](目标)` 的目标也在检查范围内', () => {
  /* 注意这条的实际语义：`![x](y)` 里 `[x](y)` 部分本身就能被行内链接
     正则匹配到，所以即使实现不专门处理 `!` 前缀，图片目标仍会被检查。
     这条断言的真正价值是**锁住这个事实** —— 若将来正则改成要求
     `!` 必须以特定方式出现（例如只认 `!\[`），图片就会漏检。
     断言的是行为（图片目标不存在必须报错），不是实现细节。 */
  const result = withAppended('![截图](missing-image-zzz.png)');
  assert.equal(result.errors.length, 1, '图片目标不存在必须报错');
  assert.match(result.errors[0], /missing-image-zzz\.png/, '报错必须指名该图片');
});

test('md-links: 尖括号目标必须去掉尖括号后再解析', () => {
  /* `[a](<b.md>)` 是 CommonMark 处理含空格路径的写法。
     若实现不剥尖括号，`<b.md>` 会被当成字面文件名（含 `<` 与 `>`），
     于是「文件明明存在却被报不存在」。
     用**真实存在的文件**构造：只有这样，剥不剥尖括号才有可观测差异 ——
     用不存在的文件时，两种实现都会报错，测试区分不出对错。 */
  const result = withAppended('见 [说明](<README.md>)。');
  assert.deepEqual(result.errors, [],
    '尖括号内的真实文件必须被正确解析（不剥尖括号会误报不存在）');

  /* 反向：尖括号内的不存在文件仍要报错，证明剥完还在检查。 */
  const missing = withAppended('见 [缺失](<bracketed-missing-zzz.md>)。');
  assert.equal(missing.errors.length, 1, '尖括号内的不存在文件必须报错');
});

test('md-links: 带标题的目标 `(目标 "标题")` 只取目标部分', () => {
  /* `[a](b.md "标题")` 里 `"标题"` 不是路径的一部分。
     不剥离的话会把整串当路径，真实存在的文件也会被判不存在。 */
  const real = withAppended('见 [说明](README.md "标题")。');
  assert.deepEqual(real.errors, [], '带标题的真实文件必须被正确解析');

  const missing = withAppended('见 [缺失](titled-missing-zzz.md "标题")。');
  assert.equal(missing.errors.length, 1, '带标题的不存在文件必须报错');
});

test('md-links: 越出仓库范围的路径必须拒绝', () => {
  /* `[a](../../../etc/passwd)` 若只检查 existsSync，在 Linux 上会真的存在 ——
     那会被当成合法链接。文档链接不该指向仓库之外。 */
  const result = withAppended('见 [越界](../../../etc/passwd)。');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /越出仓库范围/, '必须明确指出是越界而不是不存在');
});

test('md-links: 存在的链接必须放行（对照，证明上面几条不是一律报错）', () => {
  const result = withAppended('见 [说明](README.md)。');
  assert.deepEqual(result.errors, [], '存在的链接不得报错');
});

test('md-links: 围栏代码块内的链接不算真链接', () => {
  /* 文档里常有「链接长这样」的示例（本仓库笔记里就有）。
     不跳过会产生大量误报，而误报多的门禁会被绕过 —— 那比没有门禁更糟。 */
  const result = withAppended('```md\n[示例](in-code-block-zzz.md)\n```');
  assert.deepEqual(result.errors, [], '代码块里的链接必须被跳过');
});

test('md-links: 行内代码里的链接不算真链接', () => {
  const result = withAppended('链接长这样 `[示例](inline-code-zzz.md)`。');
  assert.deepEqual(result.errors, [], '行内代码里的链接必须被跳过');
});

test('md-links: 绝对 URL 与页内锚点不检查', () => {
  /* 它们不指向本仓库的文件，检查它们既无意义又会因网络不可达而误报。 */
  const absolute = withAppended('见 [外部](https://example.com/nope.md)。');
  assert.deepEqual(absolute.errors, [], '绝对 URL 必须放行');

  const anchor = withAppended('见 [上面](#命令)。');
  assert.deepEqual(anchor.errors, [], '页内锚点必须放行');
});

test('md-links: 百分号编码的目标必须先解码再解析', () => {
  /* 中文文件名在链接里可能被写成 `%E4%B8%AD` 形式。不解码就报「不存在」，
     而那是一个真实存在的笔记 —— 误报会让人以为门禁坏了。
     用编码形式指向**真实存在**的笔记：只有解码正确，它才不报错。 */
  const encoded = '.agents/notes/implemented/process/2026-10-18-notes-%63overage-gate.md';
  /* `%63` 是字母 c。未解码时路径 `...%63overage...` 不存在；
     解码后 `...coverage...` 存在。这是可观测差异的前提。 */
  const result = withAppended(`见 [中文](${encoded})。`);
  assert.deepEqual(result.errors, [],
    '百分号编码的目标必须被解码后解析（不解码会误报不存在）');
});

test('md-links: 不扫描 vendored 的上游目录', () => {
  /* `skills/agent-notes/` 是上游副本，本仓库无权修它的内部链接；
     扫描它只会产生「改不了的红」。
     断言方式：往 vendored 目录里放一个断链文件，校验仍须通过。
     只断言「当前错误里没有 vendored 前缀」是不够的 —— 那在当前没有
     断链的情况下恒真。 */
  const probe = join(ROOT, 'skills', 'agent-notes', 'md-links-probe.md');
  try {
    writeFileSync(probe, '[断链](definitely-not-here-zzz.md)\n');
    const result = verifyMarkdownLinks();
    assert.deepEqual(result.errors, [],
      'vendored 目录里的断链不得被报告（本仓库无权修它）');
  } finally {
    rmSync(probe, { force: true });
  }
});
