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
 * **真仓库只读不写**：`node --test tools/*.test.mjs` 并行跑各个测试文件，
 * 任何测试改写 `AGENTS.md` / `README.md` 这类真实文件，都会让别的测试
 * 读到改到一半的内容（实测 6 次全量跑红 4 次，而单独跑全绿）。
 *
 * 所以分工是：
 *   - 第一条用例用 `verifyMarkdownLinks()` 扫**真仓库**，确认门禁真的覆盖到
 *     全部文档与链接（它只读不写，天然安全）；
 *   - 其余用例把真 README 复制进临时目录，往**复制品**里追加坏链接，
 *     再用 `verifyMarkdownLinksIn()` 校验它 —— 测的是检测逻辑，不是仓库状态。
 *
 * 这条边界不是洁癖：它由一次真实的偶发失败换来的，详见
 * `.agents/notes/implemented/testing/2026-10-19-parallel-tests-must-not-share-real-trees.md`。
 *
 * 每批都用 try/finally 还原，避免失败时把仓库改脏。
 */
import { strict as assert } from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { verifyMarkdownLinks, verifyMarkdownLinksIn } from './md-links.mjs';

const ROOT = join(import.meta.dirname, '..');

/**
 * 在**临时目录**里造一份文档副本，往里追加 Markdown，然后校验它。
 *
 * ## 为什么不用真 AGENTS.md
 *
 * 最初这里是「改真 `AGENTS.md` → 跑校验 → 还原」。但 `npm test` 是
 * `node --test tools/*.test.mjs`，**各测试文件并行**。于是这个测试改写
 * `AGENTS.md` 的那几十毫秒里，`doc-budget.mjs` / `verify-plugin.mjs`
 * （以及别的测试）会读到**改到一半的内容**。
 *
 * 症状极有迷惑性：单独跑 `md-links.test.mjs` 12/12 全绿，全量跑偶发红
 * （6 次红 4 次，失败的是自己文件里的别的用例）。这不是环境问题，是
 * **一个测试在改另一个测试的输入**。
 *
 * 所以这里改用临时目录：把真文档复制一份，往复制品里追加，再校验复制品。
 * 门禁覆盖真仓库这件事由第一条用例负责，那条只读不写。
 *
 * @param {string} markdown 要追加的内容。
 * @returns {ReturnType<typeof verifyMarkdownLinksIn>} 校验结果。
 */
function withAppended(markdown, extraFiles = {}) {
  const staging = mkdtempSync(join(tmpdir(), 'an-mdl-'));
  try {
    for (const [name, content] of Object.entries(extraFiles)) {
      writeFileSync(join(staging, name), content);
    }
    const doc = join(staging, 'probe.md');
    /* 用一份**自足的最小文档**，而不是复制真 README。
     *
     * 复制真 README 会引入它自己的互链（指向 README.en.md），而临时目录里
     * 没有那个文件 —— 于是凭空多报一条「链接目标不存在」，把「必须恰好
     * 报一处」的断言变成 2 !== 1。实测踩过：12 条用例一起红。
     *
     * 保留一小段真内容（标题 + 代码块）是为了仍然覆盖到「真实文档形态」，
     * 而不是只验一段孤立的文本。 */
    writeFileSync(doc, [
      '# 探针文档',
      '',
      '## 一节',
      '',
      '这里有个真实存在的链接：[说明](LICENSE)。',
      '',
      '```sh',
      '# 这是代码块里的注释，不是标题',
      'npm test',
      '```',
      '',
      markdown,
      ''
    ].join('\n'));
    /* 连带把 LICENSE 与 README.md 放进去：上面那条真实链接、以及三条
       专门验「尖括号 / 带标题 / 真实文件」解析的用例都指向它们。
       缺了任何一个，它们就会因自身断链而失败 —— 而那与被测行为无关。 */
    writeFileSync(join(staging, 'LICENSE'), readFileSync(join(ROOT, 'LICENSE')));
    writeFileSync(join(staging, 'README.md'), '# 存在的文件\n\n[回探针](probe.md)\n');
    return verifyMarkdownLinksIn([doc], staging);
  } finally {
    rmSync(staging, { recursive: true, force: true });
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
  assert.match(result.errors[0], /probe\.md/, '必须指出是哪个文档');
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
  /* 文件名在链接里可能被写成 `%E4%B8%AD` 这种百分号编码形式。不解码就报
     「不存在」，而那是一个确实存在的文件 —— 误报会让人以为门禁坏了。

     用**编码形式**指向 staging 里**真实存在**的中文文件名：只有解码正确，
     它才不报错。两者缺一，这条用例就测不到 decodeURI 了。 */
  const result = withAppended('见 [中文](%E4%B8%AD%E6%96%87%E6%96%87%E4%BB%B6.md)。',
    { '中文文件.md': '# 真实存在的中文文件\n' });
  assert.deepEqual(result.errors, [],
    '百分号编码的目标必须被解码后解析（不解码会误报不存在）');
});

test('md-links: 链接指向目录必须报错，不得崩掉整个门禁', () => {
  /* 实测踩过：`[见说明](docs/)` 会让 readFileSync 抛 EISDIR，
     **整个门禁直接崩掉** —— 不是报告问题，是自己挂了。
     崩掉时退出码非 0，看起来像「门禁红了」，实际是「门禁没能运行」。
     那正是本仓库最忌讳的形态：红的含义必须清楚。 */
  const staging = mkdtempSync(join(tmpdir(), 'an-mddir-'));
  try {
    mkdirSync(join(staging, 'docs'), { recursive: true });
    writeFileSync(join(staging, 'docs', 'a.md'), '# a\n', 'utf8');
    mkdirSync(join(staging, 'images'), { recursive: true });

    const doc = join(staging, 'probe.md');
    writeFileSync(doc, '# t\n\n[见说明](docs)\n[又见](docs/)\n![图](images)\n', 'utf8');

    /* 必须正常返回结果，而不是抛异常。 */
    let result;
    assert.doesNotThrow(() => { result = verifyMarkdownLinksIn([doc], staging); },
      '指向目录不得让门禁崩溃 —— 崩掉时退出码非 0，会被误读成「门禁红了」');

    assert.equal(result.errors.length, 3, '三处目录链接都要各报一条');
    for (const error of result.errors) {
      assert.match(error, /链接指向目录而非文件/, `必须说清是目录问题：${error}`);
      assert.match(error, /要指某个文件请写全文件名/, `必须给出怎么改：${error}`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('md-links: 不扫描 vendored 的上游目录', () => {
  /* `skills/agent-notes/` 是上游副本，本仓库无权修它的内部链接；
     扫描它只会产生「改不了的红」。

     **探针必须放进临时目录，绝不能写进 vendored 目录。**
     实测踩过：探针原本写 `skills/agent-notes/md-links-probe.md`，而
     `node --test` **并行**跑各个测试文件 —— `project-skill.test.mjs` 与
     `self-update.test.mjs` 此刻正在 `cpSync` 同一棵 vendored 树，
     凭空多出的探针文件让它们读到不一致的内容，偶发失败（8 次全量跑红 2 次）。
     一个测试去改另一个测试的输入源，这是并发缺陷，不是偶发环境问题。

     改成复制整棵 vendored 树到临时目录后用复制品做探针：「不扫描
     vendored」这条契约照样验到，而不碰真目录。对照用例保证检测器本身
     有效 —— 否则「没报错」可能只是因为它整体坏了。 */
  const staging = mkdtempSync(join(tmpdir(), 'an-mdprobe-'));
  try {
    cpSync(join(ROOT, 'skills', 'agent-notes'), join(staging, 'agent-notes'), { recursive: true });
    writeFileSync(join(staging, 'agent-notes', 'md-links-probe.md'),
      '[断链](definitely-not-here-zzz.md)\n');

    /* 对照：同样的文件被扫描时必须报出断链，证明检测器是好的。 */
    const detected = verifyMarkdownLinksIn([join(staging, 'agent-notes', 'md-links-probe.md')]);
    assert.ok(detected.errors.length >= 1,
      '对照：同一份文件在被显式扫描时必须报出断链 —— 否则本用例是假绿');

    /* 真正的断言：真仓库里放着同样的断链，校验仍须通过。 */
    const result = verifyMarkdownLinks();
    assert.deepEqual(result.errors, [],
      'vendored 目录里的断链不得被报告（本仓库无权修它）');
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});
