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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
