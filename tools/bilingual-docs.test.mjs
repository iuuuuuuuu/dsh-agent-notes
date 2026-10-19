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
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { structureOf, verifyBilingual } from './bilingual-docs.mjs';

const ROOT = join(import.meta.dirname, '..');
const ZH = join(ROOT, 'README.md');
const EN = join(ROOT, 'README.en.md');

const zhBackup = readFileSync(ZH, 'utf8');
const enBackup = readFileSync(EN, 'utf8');

/**
 * 临时改一个文件、跑校验、还原。
 *
 * @param {{zh?: string, en?: string}} edits 要写入的内容，不给的保持原样。
 * @returns {ReturnType<typeof verifyBilingual>} 校验结果。
 */
function withEdits(edits) {
  try {
    if (edits.zh !== undefined) writeFileSync(ZH, edits.zh);
    if (edits.en !== undefined) writeFileSync(EN, edits.en);
    return verifyBilingual();
  } finally {
    writeFileSync(ZH, zhBackup);
    writeFileSync(EN, enBackup);
  }
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