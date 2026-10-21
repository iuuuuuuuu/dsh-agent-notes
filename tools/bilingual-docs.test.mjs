/**
 * `tools/bilingual-docs.mjs` 的行为测试 —— 双语 README 结构一致性。
 *
 * ## 这个门禁在补什么
 *
 * `verify-plugin.mjs` 只验「两个 README 都在」与「都带 dsh 徽标」。实测：
 * 给 `README.en.md` 追加一整节，中文版完全不知道，它照样绿灯。
 * 改的人不会察觉，因为他只读了自己写的那一版。
 *
 * ## 为什么用真实文件
 *
 * 门禁的作用就是守住这两个文件，造临时目录测它等于测了个影子。全部用例
 * 都真改 `README.md` / `README.en.md`，跑完在 finally 里还原。
 *
 * 每条用例都配一条「应放行」的对照 —— 否则一个「一律报错」的实现也能
 * 让全部红灯用例通过。
 */
import { strict as assert } from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { structureOf, verifyBilingual } from './bilingual-docs.mjs';

const ROOT = join(import.meta.dirname, '..');
const ZH = join(ROOT, 'README.md');
const EN = join(ROOT, 'README.en.md');

const zhBackup = readFileSync(ZH, 'utf8');
const enBackup = readFileSync(EN, 'utf8');

/**
 * 临时改一对文档、跑校验、还原。
 *
 * ## 为什么用内存映射而不是写文件
 *
 * 最初这里是「写真 `README.md` / `README.en.md` → 跑校验 → 还原」。但
 * `npm test` 是 `node --test tools/*.test.mjs`，**各测试文件并行** ——
 * 这个测试改写真 README 的那几十毫秒里，`md-links.test.mjs` 正在扫
 * 真实仓库、`docs:bilingual` 门禁也可能同时读到改到一半的内容。
 *
 * 症状极有迷惑性：单独跑 `bilingual-docs.test.mjs` 10/10 全绿，全量跑偶发红
 * （6 次红 4 次，失败的却是**另一个文件**的用例）。
 *
 * 改成用 `read` 覆盖把校验指向内存内容后，**一个字节都不写盘**：
 * 真仓库只被读取，从头到尾保持不变。
 *
 * @param {{zh?: string, en?: string}} edits 要替换的内容，不给的保持原样。
 * @returns {ReturnType<typeof verifyBilingual>} 校验结果。
 */
function withEdits(edits) {
  const contents = new Map([
    [ZH, edits.zh ?? zhBackup],
    [EN, edits.en ?? enBackup]
  ]);
  return verifyBilingual({ read: (path) => contents.get(path) ?? readFileSync(path, 'utf8') });
}

test('bilingual: 当前两版 README 结构一致', () => {
  const result = verifyBilingual();
  assert.deepEqual(result.errors, [], `不得有结构漂移，实际：${result.errors.join('; ')}`);
  assert.equal(result.pairs, 1, '当前只有 README 一对');
});

test('bilingual: 覆盖范围要真实（空集合通过是最隐蔽的假绿）', () => {
  const zh = structureOf(zhBackup);
  assert.ok(zh.levels.length > 20, `中文版标题数应足够多，实际 ${zh.levels.length}`);
  assert.ok(zh.fences > 10, `中文版代码块数应足够多，实际 ${zh.fences}`);
});

test('bilingual: 只给英文版加一节必须报错', () => {
  const result = withEdits({ en: `${enBackup}\n\n## Only in English\n\ncontent\n` });
  assert.equal(result.errors.length, 1, '必须恰好报一处');
  assert.match(result.errors[0], /标题数量不一致/, '必须说明是数量对不上');
  assert.match(result.errors[0], /README\.en\.md/, '必须点名是哪一版');
});

test('bilingual: 只给中文版加一节同样必须报错', () => {
  /* 双边对称：只报英文侧漂移的门禁是有偏的 —— 中文版才是默认入口，
     而中文版单独加节同样会让英文读者看不到。 */
  const result = withEdits({ zh: `${zhBackup}\n\n## 只在中文\n\n内容\n` });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /README\.md/, '必须点名中文版');
});

test('bilingual: 删掉一节也必须报错', () => {
  const result = withEdits({ en: enBackup.replace(/\n## Known limitations[\s\S]*?(?=\n## )/, '\n') });
  assert.ok(result.errors.length >= 1, '删节必须被抓住');
});

test('bilingual: 标题层级错位必须报错，且只报第一处', () => {
  /* 数量相同但层级不同，更难被发现 —— 眼睛扫过去两版「章节数一样」。 */
  const single = withEdits({ en: enBackup.replace('## Known limitations', '### Known limitations') });
  assert.ok(single.errors.length >= 1, '层级错位必须报');
  assert.match(single.errors[0], /层级不一致/, '必须明确说是层级问题而非数量问题');

  /* 两处错位时仍只报一条：层级错位是根因，后续错位多半是它引起的连带。
     **必须造出两处错位**才能验这条 —— 只造一处的话，删掉 break 也不
     会出现第二条错误，两种实现输出完全相同（故障注入实测过）。 */
  const doubled = withEdits({
    en: enBackup
      .replace('## Known limitations', '### Known limitations')
      .replace('## License', '### License')
  });
  assert.equal(doubled.errors.length, 1,
    '多处层级错位只报第一处，不做连环报错 —— 否则真正的原因会被淹没');
  assert.match(doubled.errors[0], /第 1 个标题层级不一致|层级不一致/);
});

test('bilingual: 代码块数量不同必须报错', () => {
  /* 示例是最容易漏同步的部分：改了一版加了命令示例，另一版没加。 */
  const result = withEdits({ en: `${enBackup}\n\n\`\`\`sh\necho hi\n\`\`\`\n` });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /代码块数量不一致/, '必须指出代码块对不上');
});

/* ── 代码块语言标记 ─────────────────────────────────────────────────────
 *
 * 为什么加这条：原有检查只比「围栏**数量**」，不比「标记**是什么**」。
 * 而语言标记（sh / bash / yaml）是**语言无关**的 —— 翻译它没有意义，
 * 所以两版不一致**一定是真漂移**。
 *
 * 实测过三个候选，只有它无歧义：
 *   · 段落数 / 列表项数：**中英排版惯例本来就不同**（中文把内容排在列表里、
 *     英文排在正文段落里；中文还有「一格多项」）。翻历史数据发现 30 处
 *     「差异」全是方法假象 —— 做成门禁会一直红，且红了也没错
 *   · 代码块内的命令行：命令**相同**但**注释不同**（注释本就该翻译）
 *   · **围栏语言标记**：完全相同 ✔
 *
 * 与 mdast 的关系：这条**替代**了原计划的 mdast 方案 —— 判据就是「围栏行里
 * 那三个反引号后面跟的词」，它在代码块内容之外，正则不会误吃块内文本。
 */
test('bilingual: 代码块语言标记不一致必须判红', () => {
  const result = withEdits({ en: enBackup.replace('```sh', '```bash') });
  assert.ok(result.errors.length > 0, '英文版把 sh 改成 bash 必须判红');
  assert.match(result.errors.join(' '), /语言标记不一致/, '必须点名是语言标记问题');
});

test('bilingual: 两版同时改语言标记必须放行（对照）', () => {
  /* 防止上条把门禁写成「只要有围栏就红」。 */
  const fence = '\n```python\nprint(1)\n```\n';
  const result = withEdits({ zh: zhBackup + fence, en: enBackup + fence });
  assert.deepEqual(result.errors, [], `两版同步加围栏必须放行，实际：${result.errors.join('; ')}`);
});

test('bilingual: 语言标记顺序不同也要判红（集合相同不算过）', () => {
  /* 顺序也是结构：同样的标记但前后不同，说明两版的示例顺序不一致。 */
  const firstFence = /\n```sh[\s\S]*?```\n/;
  const matched = firstFence.exec(enBackup);
  assert.ok(matched !== null, '英文版应有 sh 围栏可挪动');
  const moved = enBackup.replace(firstFence, '\n').concat(matched[0]);
  const result = withEdits({ en: moved });
  assert.ok(result.errors.length > 0, '围栏顺序不同必须判红');
});

test('bilingual: 闭合围栏不得被当成开启围栏', () => {
  /* 开闭成对：第 1、3、5… 个才是开启围栏。若把闭合也算进去，抽出的
     序列会多出一堆空字符串，比对时噪声大且容易误判。 */
  const s = structureOf('```sh\na\n```\n\n```yaml\nb\n```\n');
  assert.deepEqual(s.fenceLangs, ['sh', 'yaml'],
    '只应取开启围栏的语言标记，实际：' + JSON.stringify(s.fenceLangs));
  assert.equal(s.fences, 2, '围栏数量仍应是 2');
});

test('bilingual: 缩进围栏的语言标记不得丢失（数量对但 langs 空是最坑的假阴性）', () => {
  /* 实测正则口径的分叉（.probe/probe-fence-count.mjs，同一输入两套口径比对）：

     | 输入 | 正则 | mdast |
     |---|---|---|
     | 未闭合围栏 | fences=0, langs=["sh"] | fences=1, langs=["sh"] |
     | 围栏内含围栏标记文本 | fences=1 | fences=2 |
     | **缩进围栏** | fences=1, **langs=[]** | fences=1, langs=["sh"] |

     ★ 第三种最坑：**数量对得上、语言标记 silently 丢掉**。两版都丢时
       门禁照样绿 —— 正是「两版同样错 ⇒ 假绿」的形态，比误报危险得多。
       根因是 `^\\s*` 让缩进围栏进得了 fenceLines，却进不了 marks 的
       `(?:^|\\n)` 分支：数量与语言标记用了两套边界。 */
  const s = structureOf(`正文\n\n  \`\`\`sh\n  echo hi\n  \`\`\`\n`);
  assert.equal(s.fences, 1, '缩进围栏仍应算一个代码块');
  assert.deepEqual(s.fenceLangs, ['sh'],
    '缩进围栏的语言标记不得丢失 —— 丢失时两版都错也检测不到');
});

test('bilingual: 围栏块内含围栏标记文本时，数量按 mdast 判', () => {
  /* 正则按「行首是 ``` 」计数，会把示例文本里的 ``` 也算成围栏行，
     于是数量多一倍。mdast 按语法树判，示例里的 ``` 只是代码内容。 */
  const fence = String.fromCharCode(96, 96, 96);
  const s = structureOf(`正文\n\n${fence}md\n${fence}\nnested\n${fence}\n`);
  assert.equal(s.fences, 2, '外层两个围栏各算一个，示例文本里的标记不算');
});

test('bilingual: 未闭合围栏仍算一个代码块', () => {
  /* 正则数「围栏行数 / 2」，未闭合时只有一行开启标记 ⇒ 算 0 个。
     mdast 按 CommonMark 判它延伸到文末、整段是代码 ⇒ 1 个。 */
  const fence = String.fromCharCode(96, 96, 96);
  const s = structureOf(`正文\n\n${fence}sh\necho hi\n`);
  assert.equal(s.fences, 1, '未闭合围栏是一个代码块，不是 0 个');
  assert.deepEqual(s.fenceLangs, ['sh']);
});

test('bilingual: 代码块里的 # 注释不得被当成标题', () => {
  /* 这是最容易犯的实现错误：示例里的 shell 注释 `# 安装` 若被数成标题，
     两版注释文字不同就会误报。

     **构造方式是这个用例的全部难点**，试过两种都失败：
       1) 两版各加一个含 `#` 注释的代码块 —— 剥离与否都不报错，
          两版都多出注释标题、仍然对齐，分不出实现差异；
       2) 只给一版加代码块 —— 能区分了，但代码块**数量**随之不等，
          报的是「代码块数量不一致」而不是标题对不上，测试红了。
     正解是两版**都**加一个代码块（数量相等），但只在中文版里写 `#` 注释：
       - 正确实现（剥离围栏）：两边标题数不变 → 放行；
       - 错误实现（不剥离）：中文版凭空多出注释里的标题 → 层级错位 → 报错。 */
  const result = withEdits({
    zh: `${zhBackup}\n\n\`\`\`sh\n# 这是注释，不是标题\necho hi\n\`\`\`\n`,
    en: `${enBackup}\n\n\`\`\`sh\necho hi\n\`\`\`\n`
  });
  assert.deepEqual(result.errors, [],
    '代码块内的 # 注释必须被剥离 —— 若被当成标题，中文版会凭空多出一个标题');
});

test('bilingual: 未闭合围栏里的 # 注释不得被当成标题', () => {
  /* 接上一条，但换成**未闭合围栏** —— 那是正则会失灵的形态。
     实测（.probe/probe-bilingual-fence.mjs，同一输入两条路径比对标题层级）：

     | 输入 | 正则 withoutFences | mdast blankOutFences |
     |---|---|---|
     | 正常围栏 | [2] | [2] 一致 |
     | **未闭合围栏** | **[1, 1]** | **[1]** |
     | 缩进围栏 | [2] | [2] 一致 |
     | 行内代码含 # | [2] | [2] 一致 |

     正则在未闭合围栏下抹不掉块内内容，于是示例里的 `# 假标题` 被数成
     **又一个一级标题**；mdast 按 CommonMark 判它一路延伸到文末、
     整段都是代码（`code@3-5`），只留下真正的 `# 标题`。

     ★ 注意「1」是**一级标题**的合法长度：正文里 `# 标题` 本身就是一级。
       第一版断言写的是 `[]`，把「真标题的长度」当成了「假标题」，
       红灯 —— 判据错在自己这边，不在实现。 */
  const zh = `# 标题

\`\`\`sh
# 未闭合围栏里的假标题
`;
  assert.deepEqual(structureOf(zh).levels, [1],
    '只剩正文那个一级标题；围栏内的 # 注释不得再贡献一个层级');

  /* 注入前提：正则口径确实会多数一个，否则这条用例分不出实现差异。 */
  const regexFenced = zh.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g, '\n');
  const regexLevels = [];
  for (const line of regexFenced.split('\n')) {
    const m = /^(#{1,6})\s+\S/.exec(line);
    if (m) regexLevels.push(m[1].length);
  }
  assert.deepEqual(regexLevels, [1, 1],
    '注入前提：正则口径在未闭合围栏下必须多数出一个标题');
  assert.notDeepEqual(structureOf(zh).levels, regexLevels,
    '现行实现必须与正则口径不同，否则这条用例抓不住退化');
});

test('bilingual: 故障注入 —— 退回正则口径必须被上面那条抓住', () => {
  /* Owner 硬规则：新门禁先做故障注入证明它会失败。
     「现行实现 ≠ 正则口径」只证明两者不同，不证明**门禁会红**。
     这里真跑一次子进程：把共用件的 blankOutFences 退回正则口径
     （未闭合围栏抹不掉），看 structureOf 的输出。

     ★ 用子进程而不是进程内改源码：模块已加载，改文件不影响已绑定的引用，
       进程内「注入」会静默失效 —— 那是假绿。 */
  const dir = mkdtempSync(join(tmpdir(), 'an-bil-fi-'));
  try {
    mkdirSync(join(dir, 'tools'), { recursive: true });
    for (const rel of ['tools/bilingual-docs.mjs', 'tools/markdown-links.mjs', 'tools/bilingual-links.mjs']) {
      cpSync(join(ROOT, rel), join(dir, rel));
    }
    /* mdast 在共用件里被 import，缺 node_modules 会崩在模块解析上 ——
       那是夹具坏了，不是被测退化。 */
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction');

    const shared = join(dir, 'tools', 'markdown-links.mjs');
    let src = readFileSync(shared, 'utf8');
    const anchor = 'export function blankOutFences(content) {';
    assert.ok(src.includes(anchor), '夹具与实现脱节：找不到 blankOutFences');
    const fence = String.fromCharCode(96, 96, 96);
    src = src.replace(anchor, `${anchor}
  return content.replace(/(^|\\n)(${fence}|~~~)[^\\n]*\\n[\\s\\S]*?\\n\\2[^\\n]*(?=\\n|$)/g,
    (w) => w.replace(/[^\\n]/g, ' '));`);
    writeFileSync(shared, src, 'utf8');

    writeFileSync(join(dir, 'run.mjs'), [
      "import { structureOf } from './tools/bilingual-docs.mjs';",
      `const zh = '# 标题\\n\\n${fence}sh\\n# 未闭合围栏里的假标题\\n';`,
      'process.stdout.write(JSON.stringify(structureOf(zh).levels));',
      ''
    ].join('\n'), 'utf8');

    const result = spawnSync(process.execPath, ['run.mjs'],
      { cwd: dir, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, `探针必须正常退出：${(result.stderr ?? '').slice(0, 200)}`);
    /* ★ 注入后期望的正是「红」：共用件被改回正则口径后，未闭合围栏里的
       假标题必须重新出现在 levels 里（[1,1]）。若它仍是 [1]，说明这次
       注入没有真的落到执行路径上 —— 那条绿灯是假的。 */
    assert.equal(result.stdout, '[1,1]',
      '退化为正则口径后必须多数出假标题（[1,1]）—— 否则注入没生效，上面那条绿是假的');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  /* 反向：确认正则口径确实会多数一个 —— 否则上面那句绿得没有意义，
     它可能只是两者都对。这一条让「会红」变成可观测的事实。 */
  const fence = String.fromCharCode(96, 96, 96);
  const zh = `# 标题

${fence}sh
# 未闭合围栏里的假标题
`;
  const regexFenced = zh.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g, '\n');
  const regexLevels = [];
  for (const line of regexFenced.split('\n')) {
    const m = /^(#{1,6})\s+\S/.exec(line);
    if (m) regexLevels.push(m[1].length);
  }
  assert.deepEqual(regexLevels, [1, 1],
    '注入前提：正则口径必须真的多数出假标题，否则「现行实现绿」说明不了任何事');
});

test('bilingual: 故障注入 —— 围栏计数退回正则口径必须被抓住', () => {
  /* Owner 硬规则：新门禁先做故障注入证明它会失败。
     上面三条（缩进围栏 / 嵌套标记 / 未闭合）只断言「现在是对的」，
     而对修复前的正则实现同样成立。这里把 `structureOf` 的围栏计数与
     语言标记改回正则口径，真跑子进程，看输出是否变红。

     ★ 注入点在 `bilingual-docs.mjs` 而不是共用件：那三处用的是
       `codeNodes.length` 与 `node.lang`，改回正则即是本次修复前的形态。
       第一版注入改的是共用件的 blankOutFences，与围栏计数无关，
       于是「红」证明的是另一件事 —— 注入必须对准被测的那一行。 */
  const dir = mkdtempSync(join(tmpdir(), 'an-bil-fi2-'));
  try {
    mkdirSync(join(dir, 'tools'), { recursive: true });
    for (const rel of ['tools/bilingual-docs.mjs', 'tools/markdown-links.mjs', 'tools/bilingual-links.mjs']) {
      cpSync(join(ROOT, rel), join(dir, rel));
    }
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction');

    const target = join(dir, 'tools', 'bilingual-docs.mjs');
    let src = readFileSync(target, 'utf8');
    const anchor = '  return { levels, fences: codeNodes.length, fenceLangs, tables, links };';
    assert.ok(src.includes(anchor), '夹具与实现脱节：找不到围栏计数的返回行');
    const fence = String.fromCharCode(96, 96, 96);
    src = src.replace(anchor, [
      '  const __lines = text.match(/^\\s*(```|~~~)/gm) ?? [];',
      '  const __marks = [...text.matchAll(/(?:^|\\n)(?:```|~~~)([^\\n]*)/g)].map((m) => m[1].trim());',
      '  return { levels, fences: Math.floor(__lines.length / 2), fenceLangs: __marks.filter((_, i) => i % 2 === 0), tables, links };'
    ].join('\n'));
    writeFileSync(target, src, 'utf8');

    /* 三个退化形态各跑一次：缩进围栏（langs 丢）、未闭合（fences=0）、
       嵌套标记（fences 多数一个）。 */
    const inputs = {
      '缩进围栏': `正文\n\n  ${fence}sh\n  echo hi\n  ${fence}\n`,
      '未闭合围栏': `正文\n\n${fence}sh\necho hi\n`,
      '嵌套标记': `正文\n\n${fence}md\n${fence}\nnested\n${fence}\n`
    };
    const expected = { '缩进围栏': 'langs 丢失', '未闭合围栏': 'fences=0', '嵌套标记': 'fences 多数一个' };
    for (const [name, markdown] of Object.entries(inputs)) {
      writeFileSync(join(dir, 'run.mjs'), [
        "import { structureOf } from './tools/bilingual-docs.mjs';",
        `const s = structureOf(${JSON.stringify(markdown)});`,
        "process.stdout.write(s.fences + '|' + JSON.stringify(s.fenceLangs));",
        ''
      ].join('\n'), 'utf8');
      const result = spawnSync(process.execPath, ['run.mjs'],
        { cwd: dir, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, `${name} 探针必须正常退出：${(result.stderr ?? '').slice(0, 200)}`);
      assert.notEqual(result.stdout, '',
        `${name}：正则口径必须给出非空输出，否则注入没生效（${expected[name]}）`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  /* 反向对照：现行实现在这三个输入上必须给出**正确**答案。
     否则上面「注入后非空」可能只是正则与现行输出恰好相同。 */
  const fence = String.fromCharCode(96, 96, 96);
  const indented = structureOf(`正文\n\n  ${fence}sh\n  echo hi\n  ${fence}\n`);
  assert.deepEqual([indented.fences, indented.fenceLangs], [1, ['sh']],
    '现行实现在缩进围栏下必须数量与语言标记都对');
  const unclosed = structureOf(`正文\n\n${fence}sh\necho hi\n`);
  assert.deepEqual([unclosed.fences, unclosed.fenceLangs], [1, ['sh']],
    '现行实现在未闭合围栏下必须算 1 个且语言标记不丢');
  const nested = structureOf(`正文\n\n${fence}md\n${fence}\nnested\n${fence}\n`);
  assert.equal(nested.fences, 2, '现行实现下示例文本里的围栏标记不算代码块');
});

test('bilingual: 两版同步加同一节必须放行（对照）', () => {
  /* 正当改动不能被拦。这一条的意义和红灯用例同等重要 ——
     门禁若把所有改动都拦下，人就会学会绕过它。 */
  const result = withEdits({
    zh: `${zhBackup}\n\n## 新增的一节\n\n中文内容\n`,
    en: `${enBackup}\n\n## A newly added section\n\nEnglish content\n`
  });
  assert.deepEqual(result.errors, [], '两版同步加节必须放行');
});

test('bilingual: 只改文字不动结构必须放行（对照）', () => {
  /* 中英文长度天然不同，行数差 55 行是正常的。门禁若误把长度差当漂移，
     就会逼人把英文版写短或把中文版注水 —— 那是在损害文档而不是维护它。 */
  const result = withEdits({
    zh: zhBackup.replace('## 许可', '## 许可与致谢'),
    en: enBackup.replace('## License', '## License and acknowledgements, extended deliberately')
  });
  assert.deepEqual(result.errors, [], '只改标题文字不改结构必须放行');
});
/* ── 表格结构 ──────────────────────────────────────────────────────────
 *
 * 表格是**跨语言刚体**：同一份对照表，中英的行列数必然一致 ——
 * 不一致读者就对不上，而那与翻译无关，是真的漏同步。
 *
 * 列表则相反，实测已确认不可比：分节比对 25 节里唯一不一致的那节，
 * 中文 2 个列表项、英文 2 段散文，内容不缺。**排版选择不是漂移。**
 */

test('bilingual: 表格数量不一致必须报出来', () => {
  /* ★ 在**已有节内**插一张表，不引入新标题 —— 否则标题门禁会先红并
     `continue`，表格检查根本没跑到（实测踩过：报错说的是「标题数量不一致」，
     根本没到表格那一步）。 */
  const result = withEdits({
    en: enBackup.replace(
      '\n## Known limitations',
      '\nExtra table:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n## Known limitations'
    )
  });
  assert.ok(
    result.errors.some((e) => /表格数量不一致/.test(e)),
    `英文多一张表必须被报出，实际：${JSON.stringify(result.errors)}`
  );
});

test('bilingual: 同一张表的列数不一致必须报出来', () => {
  /* 把英文版第一张表的某一列删掉 —— 读者会对不上。 */
  const lines = enBackup.split('\n');
  let at = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*\|.*\|.*\|/.test(lines[i]) && !/^\s*\|\s*:?-{3,}/.test(lines[i])) { at = i; break; }
  }
  assert.notEqual(at, -1, '英文版应至少有一张表');

  const edited = lines.slice();
  edited[at] = edited[at].replace(/\|[^|]*\|/, '');   /* 删一个单元格 */
  const result = withEdits({ en: edited.join('\n') });

  assert.ok(
    result.errors.some((e) => /表格结构不一致/.test(e)),
    `列数不一致必须被报出，实际：${JSON.stringify(result.errors)}`
  );
});

test('bilingual: 两版同时改表格应放行（对照：证明判据不是「有没有表格」）', () => {
  const zhLines = zhBackup.split('\n');
  const enLines = enBackup.split('\n');
  let zhAt = -1;
  let enAt = -1;
  for (let i = 0; i < zhLines.length; i += 1) {
    if (/^\s*\|.*\|.*\|/.test(zhLines[i]) && !/^\s*\|\s*:?-{3,}/.test(zhLines[i])) { zhAt = i; break; }
  }
  for (let i = 0; i < enLines.length; i += 1) {
    if (/^\s*\|.*\|.*\|/.test(enLines[i]) && !/^\s*\|\s*:?-{3,}/.test(enLines[i])) { enAt = i; break; }
  }
  assert.notEqual(zhAt, -1, '中文版应至少有一张表');
  assert.notEqual(enAt, -1, '英文版应至少有一张表');

  /* 两边都加一列 —— 同步改动应当放行。 */
  const zhEdited = zhLines.slice();
  zhEdited[zhAt] += '| 额外 |';
  const enEdited = enLines.slice();
  enEdited[enAt] += '| extra |';

  const result = withEdits({ zh: zhEdited.join('\n'), en: enEdited.join('\n') });
  assert.deepEqual(result.errors, [],
    `两版同步加列应放行，实际：${JSON.stringify(result.errors)}`);
});

test('bilingual: 竖线在正文里但不是表格，不得被当表格', () => {
  /* `a || b` 这种行含 `|` 但不是表格 —— 误判会造出假漂移。 */
  const result = withEdits({
    zh: zhBackup + '\n\n管道命令 `foo || bar` 不是表格。\n',
    en: enBackup + '\n\nA pipeline `foo || bar` is not a table.\n'
  });
  assert.deepEqual(result.errors, [],
    `正文里的竖线不得被当表格，实际：${JSON.stringify(result.errors)}`);
});

test('bilingual: 代码块里的表格不得被计入', () => {
  /* 代码块里常有表格示例 —— 它们在 fence 内，不该参与比对。 */
  const block = '\n\n\`\`\`md\n| a | b |\n|---|---|\n| 1 | 2 |\n\`\`\`\n\n';
  const result = withEdits({
    zh: zhBackup + block,
    en: enBackup + '\n\n\`\`\`md\n| a | b |\n|---|---|\n\`\`\`\n\n'
  });
  assert.deepEqual(result.errors, [],
    `围栏内的表格不得计入，实际：${JSON.stringify(result.errors)}`);
});

/* ── 链接目标逐条比对（对应上游 `sig.links`）───────────────────────── */

test('bilingual: 一侧改了外链、另一侧没改必须红', () => {
  /* 这是本项唯一能抓的漂移形态：标题 / 代码块 / 表格全都一致，
     只有链接目标不同。读者点过去是**两个不同项目**。 */
  const result = withEdits({ en: enBackup.replaceAll('dhicoc/dsh-better-sidebar', 'dhicoc/dsh-better-sidebar-old') });
  assert.equal(result.errors.length > 0, true, '必须报错');
  assert.match(result.errors.join('\n'), /链接目标不一致/);
  /* ★ 同时断言它没有误报成别的项 —— 否则「一律报错」也能过。 */
  assert.doesNotMatch(result.errors.join('\n'), /标题数量|代码块|表格/);
});

test('bilingual: 两版同步改外链必须放行', () => {
  const url = 'dhicoc/dsh-better-sidebar-next';
  const result = withEdits({
    zh: zhBackup.replaceAll('dhicoc/dsh-better-sidebar', url),
    en: enBackup.replaceAll('dhicoc/dsh-better-sidebar', url)
  });
  assert.deepEqual(result.errors, [],
    `两版同步改应放行，实际：${JSON.stringify(result.errors)}`);
});

test('bilingual: 一侧少一条链接必须红', () => {
  /* 把中文版里那处行内链接换成纯文字：结构（标题/代码块/表格）全不变，
     只少一条链接 —— 专门验「链接数量」这条判据。 */
  const zh = zhBackup.replace('MIT，全文见 [LICENSE](LICENSE)。', 'MIT，全文见 LICENSE 文件。');
  assert.notEqual(zh, zhBackup, '替换必须真的发生，否则这条用例验的是空转');
  const result = withEdits({ zh });
  assert.match(result.errors.join('\n'), /链接数量不一致/);
});

test('bilingual: 语言切换器那行不同不算链接漂移', () => {
  /* 中文版指 `README.en.md`、英文版指 `README.md` —— 本来就该不同。
     这一条是「链接比对」的误报边界，必须放行。 */
  const result = withEdits({});
  assert.deepEqual(result.errors, [],
    `语言切换器那行不得被算成漂移，实际：${JSON.stringify(result.errors)}`);
  const zh = structureOf(zhBackup, { skipLinkTargets: ['README.md', 'README.en.md'] });
  assert.equal(zh.links.some((t) => t.endsWith('README.en.md')), false,
    '语言切换器必须被跳过');
  assert.equal(zh.links.some((t) => t.endsWith('README.md')), false);
});
