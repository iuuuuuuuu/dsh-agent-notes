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

import { collectInlineRefs, verifyDocRefs } from './doc-refs.mjs';

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

test('doc-refs: 真仓库的 docs/ 全部行内引用可解析', () => {
  const result = verifyDocRefs();
  assert.deepEqual(result.errors, []);
  assert.ok(result.checked >= 1, '至少要扫到一个 docs/ 文档');
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
    assert.ok(result.errors.some((error) => error.includes('没有扫到任何 docs/ 文档')));
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
    '裸行号 `:43` 与 `:59-85`；',
    '只有文件名 `verify-plugin.mjs`。'
  ].join('\n');
  assert.deepEqual(collectInlineRefs(content), []);
});
