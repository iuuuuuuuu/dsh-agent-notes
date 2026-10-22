/**
 * `tools/doc-refs.mjs` 的行为测试 —— 行内 `文件:行号` 引用能不能解析。
 *
 * ## 这个门禁在补什么
 *
 * 相对链接有 `md-links` 管，但 `\`lib/notes.js:625\`` 这种**行内代码引用不是链接**，
 * mdast 的 link 节点里看不到它。于是它只能靠人眼核对 —— 而实测一轮里就漂了
 * 四处（`README.md:409→410`、`README.en.md:474→477`、不存在的行号范围、
 * 指向已删除字段的 `package.json:89`）。
 *
 * ## 测试策略
 *
 * **真仓库只读**：第一条用例扫真仓库的 `docs/`，确认门禁覆盖得到真实语料；
 * 其余用例全部在 `os.tmpdir()` 下造 fixture（半成品仓库），只测检测逻辑。
 * 这条边界是 `parallel-tests-must-not-share-real-trees` 那篇笔记换来的：
 * 并行跑测试时改真目录会让别的测试读到不一致的内容。
 *
 * 每条用例都在 `try/finally` 里删自己的临时目录。
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { collectInlineRefs, collectSourceScanFiles, verifyDocRefs, verifySourceDocRefs } from './doc-refs.mjs';

/**
 * 造一个 fixture 仓库：`files` 是「相对路径 → 内容」。
 *
 * @param {Record<string, string>} files 文件表。
 * @param {() => void} body 用例体。
 */
function withRepo(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'doc-refs-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('doc-refs: 真仓库的 docs/ 与 .agents/notes/ 全部行内引用可解析', () => {
  const result = verifyDocRefs();
  assert.deepEqual(result.errors, []);
  assert.ok(result.checked >= 1, '至少要扫到一篇文档');
  assert.ok(result.refs >= 10, `引用数应当是一个有意义的语料，实际 ${result.refs}`);
});

test('doc-refs: 行号越界必须红（这是本轮真实漂移的形态）', () => {
  withRepo({
    'lib/small.js': 'const a = 1;\n',
    'docs/x.md': '# x\n\n见 `lib/small.js:2`。\n'
  }, (root) => {
    const result = verifyDocRefs({ root });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /行号越界：`lib\/small\.js:2`，该文件只有 1 行/);
  });
});

test('doc-refs: 行号范围内的引用必须绿（否则上面的红说明不了问题）', () => {
  withRepo({
    'lib/small.js': 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
    'docs/x.md': '# x\n\n见 `lib/small.js:1-2` 与 `lib/small.js:3`。\n'
  }, (root) => {
    assert.deepEqual(verifyDocRefs({ root }).errors, []);
  });
});

test('doc-refs: 指向不存在的文件必须红', () => {
  withRepo({
    'docs/x.md': '# x\n\n见 `tools/gone.mjs:7`。\n'
  }, (root) => {
    const result = verifyDocRefs({ root });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /引用的文件不存在：`tools\/gone\.mjs`/);
  });
});

test('doc-refs: 行号范围倒置必须红', () => {
  withRepo({
    'lib/small.js': '1\n2\n3\n4\n5\n',
    'docs/x.md': '# x\n\n见 `lib/small.js:4-2`。\n'
  }, (root) => {
    const result = verifyDocRefs({ root });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /行号范围倒置/);
  });
});

test('doc-refs: 白名单条目没有理由必须红（防腐之一）', () => {
  withRepo({
    'docs/x.md': '# x\n\n见 `lib/bin.js:1`。\n'
  }, (root) => {
    const result = verifyDocRefs({ root, externalRefs: { 'lib/bin.js': '   ' } });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /白名单条目 `lib\/bin\.js` 没有写理由/);
  });
});

test('doc-refs: 白名单条目有理由时即使文件不存在也放行（对照，证明上面那条不是一律报错）', () => {
  withRepo({
    'docs/x.md': '# x\n\n见 `lib/bin.js:120`。\n'
  }, (root) => {
    const result = verifyDocRefs({
      root,
      externalRefs: { 'lib/bin.js': '上游 CLI 的构建产物，本仓库 lib/ 里没有它' }
    });
    assert.deepEqual(result.errors, []);
  });
});

test('doc-refs: 白名单条目从未命中必须红（死条目不得当校验）', () => {
  /* 复审 r1 的 P2-4 实测：原来那两条白名单在 docs/ 里只以**文件名**出现、
     从不带 `:N`，于是从来没生效过 —— 一个永不命中的条目看起来像校验，
     实际上什么都没拦。只有「理由非空」时它可以在表里永远躺着。 */
  withRepo({
    'docs/x.md': '# x\n\n见 `lib/small.js:1`。\n',
    'lib/small.js': 'const a = 1;\n'
  }, (root) => {
    const result = verifyDocRefs({ root, externalRefs: { 'lib/gone.js': '写了理由但没人引用它' } });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /白名单条目 `lib\/gone\.js` 从未命中任何引用/);
  });
});

test('doc-refs: 引用的路径是名字带点的目录时必须报错而不是抛 EISDIR', () => {
  /* 复审 r1 的 P2-3：只 `existsSync` 就 `readFileSync`，遇到「名字带点的
     目录」（`lib/a.b`）会抛未捕获的 `EISDIR` —— 门禁以**崩溃**而不是
     「一条可读的错」收场，CI 日志里看不出是哪篇文档引错了。 */
  withRepo({
    'docs/x.md': '# x\n\n见 `lib/a.b:1`。\n',
    'lib/a.b/keep.txt': 'x\n'
  }, (root) => {
    const result = verifyDocRefs({ root });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /引用的路径是目录，不是文件：`lib\/a\.b`/);
  });
});

test('doc-refs: 空 docs/ 目录不得当绿', () => {
  withRepo({
    'README.md': '# 只有顶层文档\n\n见 `lib/x.js:1`。\n'
  }, (root) => {
    const result = verifyDocRefs({ root });
    assert.ok(result.errors.some((error) => error.includes('没有扫到任何 `docs/` 或 `.agents/notes/` 文档')));
  });
});

test('doc-refs: docs/ 里一条引用都没有也不得当绿', () => {
  withRepo({
    'docs/x.md': '# x\n\n没有任何行内引用。\n'
  }, (root) => {
    const result = verifyDocRefs({ root });
    assert.ok(result.errors.some((error) => error.includes('没有扫到任何行内')));
  });
});

test('doc-refs: 围栏代码块里的 `path:N` 不算引用', () => {
  withRepo({
    'docs/x.md': '# x\n\n```js\n// 见 `tools/gone.mjs:9`\n```\n\n正文引用 `docs/x.md`（只有文件，不校验行号）。\n'
  }, (root) => {
    /* 围栏里那条被抹掉；只剩「只有文件」的那条 → 引用数 0，报空集合。 */
    const result = verifyDocRefs({ root });
    assert.equal(result.refs, 0);
    assert.ok(result.errors.some((error) => error.includes('没有扫到任何行内')));
  });
});

test('doc-refs: 命令行入口真的会跑（防「静默不跑」）', () => {
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'doc-refs.mjs')], {
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  /* 只断言退出码不够：`invokedDirectly` 判断写错时进程会以 0 退出却**一行不输出**，
     于是门禁「通过」了但什么都没查。第一版用拼 `file://` URL 的写法就属这类风险。 */
  assert.match(result.stdout, /行内引用校验通过：\d+ 个文档、\d+ 条/);
});

test('doc-refs: 上游语料前缀与裸行号不进入校验', () => {
  const content = [
    '# x',
    '',
    '上游 `packages/core/session/src/index.ts:34`；',
    '本地 `apps/cli/src/bin.ts:9`；',
    '上游 A 的 verify 脚本在仓库根 `scripts/verify-plugin-record-callers.ts:37`；',
    '裸行号 `:43` 与 `:59-85`；',
    '只有文件名 `verify-plugin.mjs`。'
  ].join('\n');
  assert.deepEqual(collectInlineRefs(content), []);
});

test('doc-refs: 笔记正文里的行内引用也要校验（本轮扩的语料）', () => {
  /* 扩到笔记的直接理由：`docs/` 只有 57 条引用，笔记里还有 14 条 —— 其中 12 条
     指回本仓、本来可以机械校验，却因为「只扫 docs/」而无人看。 */
  withRepo({
    'lib/small.js': 'const a = 1;\n',
    '.agents/notes/implemented/process/x.md': '# x\n\n见 `lib/small.js:9`。\n'
  }, (root) => {
    const result = verifyDocRefs({ root });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /\.agents\/notes\/implemented\/process\/x\.md:\d+ 行号越界：`lib\/small\.js:9`/);
  });
});

test('doc-refs: archived/ 下的笔记被跳过（封印过的笔记改不动，红了也修不了）', () => {
  withRepo({
    'lib/small.js': 'const a = 1;\n',
    'docs/ok.md': '# ok\n\n见 `lib/small.js:1`。\n',
    '.agents/notes/archived/process/old.md': '# old\n\n见 `lib/small.js:99`。\n'
  }, (root) => {
    const result = verifyDocRefs({ root });
    assert.deepEqual(result.errors, []);
    assert.equal(result.checked, 1, 'archived/ 那篇不该被收进语料');
  });
});

test('doc-refs: 指向 .probe/ 的引用被跳过（探针目录 gitignore，别人 clone 里不存在）', () => {
  withRepo({
    'lib/small.js': 'const a = 1;\n',
    'docs/ok.md': '# ok\n\n见 `lib/small.js:1` 与 `.probe/upstream-a/report.md:3`。\n'
  }, (root) => {
    assert.deepEqual(verifyDocRefs({ root }).errors, []);
  });
});

/* ── 源码侧（上游 A 的 verify-doc-refs 方向） ──────────────────────────────────
 *
 * 上游 A 的 `scripts/verify-doc-refs.ts` 扫**源码**里写下的 `docs/*.md` 与
 * `.agents/notes/*.md` 路径。本仓库原先只做文档侧（行内 `文件:行号`），
 * 源码侧无人看 —— 源码注释里的文档路径断了也没人知道。
 */

test('doc-refs: 源码里引用的文档不存在必须红', () => {
  withRepo({
    'tools/x.mjs': '// 见 docs/missing.md\n',
    'docs/ok.md': '# ok\n\n见 `lib/small.js:1`。\n',
    'lib/small.js': 'const a = 1;\n'
  }, (root) => {
    const result = verifySourceDocRefs({ root, sourceExternalRefs: {} });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /tools\/x\.mjs:1 源码里引用的文档不存在：`docs\/missing\.md`/);
  });
});

test('doc-refs: 源码里引用的文档存在时必须绿（否则上面那条不是一律报错）', () => {
  withRepo({
    'tools/x.mjs': '// 见 docs/ok.md\n',
    'docs/ok.md': '# ok\n\n见 `lib/small.js:1`。\n',
    'lib/small.js': 'const a = 1;\n'
  }, (root) => {
    assert.deepEqual(verifySourceDocRefs({ root, sourceExternalRefs: {} }).errors, []);
  });
});

test('doc-refs: 源码侧白名单必须按文件粒度生效（别的文件引同一路径仍要红）', () => {
  /* 文件级粒度是刻意的：`.agents/notes/AGENTS.md` 这个名字本仓库将来可能
     真的补上，路径级白名单会变成永不触发的死规则。 */
  withRepo({
    'tools/a.mjs': '// 见 .agents/notes/AGENTS.md\n',
    'tools/b.mjs': '// 见 .agents/notes/AGENTS.md\n',
    'docs/ok.md': '# ok\n\n见 `lib/small.js:1`。\n',
    'lib/small.js': 'const a = 1;\n'
  }, (root) => {
    const result = verifySourceDocRefs({
      root,
      sourceExternalRefs: { 'tools/a.mjs::.agents/notes/AGENTS.md': '上游 A 的笔记规范文件' }
    });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /tools\/b\.mjs:1 源码里引用的文档不存在/);
  });
});

test('doc-refs: 源码侧白名单条目没有理由必须红（防腐之一）', () => {
  withRepo({
    'tools/a.mjs': '// 见 .agents/notes/AGENTS.md\n',
    'docs/ok.md': '# ok\n\n见 `lib/small.js:1`。\n',
    'lib/small.js': 'const a = 1;\n'
  }, (root) => {
    const result = verifySourceDocRefs({
      root,
      sourceExternalRefs: { 'tools/a.mjs::.agents/notes/AGENTS.md': '  ' }
    });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /白名单条目 `tools\/a\.mjs::\.agents\/notes\/AGENTS\.md` 没有写理由/);
  });
});

test('doc-refs: 源码侧白名单条目从未命中必须红（死条目不得当校验）', () => {
  withRepo({
    'tools/a.mjs': '// 见 docs/ok.md\n',
    'docs/ok.md': '# ok\n\n见 `lib/small.js:1`。\n',
    'lib/small.js': 'const a = 1;\n'
  }, (root) => {
    const result = verifySourceDocRefs({
      root,
      sourceExternalRefs: { 'tools/a.mjs::.agents/notes/AGENTS.md': '写了理由但没人引用它' }
    });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /源码侧白名单条目 `tools\/a\.mjs::\.agents\/notes\/AGENTS\.md` 从未命中任何引用/);
  });
});

test('doc-refs: 源码侧空语料不得当绿', () => {
  withRepo({
    'docs/ok.md': '# ok\n\n没有源码。\n'
  }, (root) => {
    const result = verifySourceDocRefs({ root, sourceExternalRefs: {} });
    assert.ok(result.errors.some((error) => error.includes('没有扫到任何源码文件')));
  });
});

test('doc-refs: 源码侧扫到文件但一条文档路径都没有也不得当绿', () => {
  withRepo({
    'tools/a.mjs': '// 什么文档都没提\n',
    'docs/ok.md': '# ok\n\n见 `lib/small.js:1`。\n',
    'lib/small.js': 'const a = 1;\n'
  }, (root) => {
    const result = verifySourceDocRefs({ root, sourceExternalRefs: {} });
    assert.ok(result.errors.some((error) => error.includes('源码里没有一条文档路径引用')));
  });
});

test('doc-refs: 源码侧排除测试文件与生成的 client 产物', () => {
  /* 测试夹具里**故意**引用不存在的文档路径来证明门禁会红；把它们扫进来
     就是拿测试数据当仓库语料。`lib/client.js` 是 `src/client.js` 的生成产物，
     扫两遍等于把同一条引用计两次。 */
  withRepo({
    'tools/a.test.mjs': '// 见 docs/missing.md\n',
    'lib/client.js': '// 见 docs/missing-too.md\n',
    'tools/b.mjs': '// 见 docs/ok.md\n',
    'docs/ok.md': '# ok\n\n见 `lib/small.js:1`。\n',
    'lib/small.js': 'const a = 1;\n'
  }, (root) => {
    const result = verifySourceDocRefs({ root, sourceExternalRefs: {} });
    assert.deepEqual(result.errors, []);
    /* 被排除的必须是 `tools/a.test.mjs` 与 `lib/client.js`；剩下的两个
       （`tools/b.mjs` 与 `lib/small.js`）都要扫到。 */
    const scanned = collectSourceScanFiles(root);
    assert.ok(!scanned.includes('tools/a.test.mjs'), '测试文件必须被排除');
    assert.ok(!scanned.includes('lib/client.js'), '生成的 client 产物必须被排除');
    assert.ok(scanned.includes('tools/b.mjs'));
    assert.ok(scanned.includes('lib/small.js'));
  });
});

test('doc-refs: 真仓库的源码侧文档路径引用全部可解析', () => {
  const result = verifySourceDocRefs();
  assert.deepEqual(result.errors, []);
  assert.ok(result.checked >= 10, `至少要扫到十几个源码文件，实际 ${result.checked}`);
  assert.ok(result.refs >= 1, `源码里应当有文档路径引用，实际 ${result.refs}`);
});
