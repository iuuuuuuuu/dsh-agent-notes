/**
 * 双语 README 的结构一致性校验。
 *
 * ## 为什么需要
 *
 * `README.md`（中文，默认入口）与 `README.en.md`（英文）互链，但**没有任何
 * 门禁检查它们是否还讲同一件事**。实测：给英文版追加一整节内容，中文版
 * 完全不知道，`npm run verify` 照样绿灯 —— 它只验「两个文件都在」与
 * 「都带 dsh 徽标」。
 *
 * 这类漂移的代价是隐蔽的：英文读者看到某个功能，中文读者完全看不到，而
 * 没有任何测试会红。改的人也不会察觉，因为他只读了自己写的那一版。
 *
 * ## 比什么，为什么不比字数
 *
 * 比**结构**：标题的层级序列 + 围栏代码块的数量。
 *
 * 不比字数是因为中英长度天然不同（实测 416 行 vs 471 行，而标题数、
 * 代码块数、表格行数完全一致）—— 字数差是**正常**的，拿它当判据只会
 * 产出大量误报，而误报多的门禁会被绕过。
 *
 * 比结构能抓住的漂移形态：
 *   - 给一版加了节（最常见：新增功能只更新了顺手改的那一版）；
 *   - 删了一版的节；
 *   - 改了层级导致对应关系错位。
 *
 * ## 为什么不校验「每节的内容对应」
 *
 * 逐节比对正文需要判断「这两段讲的是同一件事」，那要么靠翻译对齐（要
 * 语言模型），要么靠人工维护锚点映射表。后者会变成另一件必须同步维护的
 * 东西——而它漂移时同样没人发现。
 *
 * 结构性漂移是**可机械判定**的，正文语义漂移不是。所以本门禁只做前者，
 * 并把后者记在重访信号里：若将来真的出现「结构一致但内容讲的不是同一件事」，
 * 应当引入翻译配对检查（上游 `verify-translation-pairing` 走的就是那条路），
 * 而不是给本门禁打补丁。
 *
 * ## 用法
 *
 * ```sh
 * npm run docs:bilingual
 * ```
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 配对的双语文档：主文件与其对应版本。 */
const PAIRS = [
  { key: 'README', primary: 'README.md', secondary: 'README.en.md' }
];

/**
 * 抽出一份 Markdown 的结构指纹。
 *
 * 只取与语言无关的部分：
 *   - 标题的**层级**（`#` 的个数），不含标题文字（文字必然是两种语言）；
 *   - 围栏代码块的数量；
 *   - **围栏代码块的语言标记，按出现顺序**（`sh` / `bash` / `yaml` / 空）。
 *
 * ## 为什么加语言标记
 *
 * 前两项只比「有几个」，不比「是什么」。而语言标记（```js / ```bash / 空）
 * 是**语言无关**的：翻译它没有任何意义。所以两版不一致**一定是真漂移**。
 *
 * 实测三个候选，只有它无歧义：
 *
 * | 候选 | 为什么不适合当门禁 |
 * |---|---|
 * | 段落数 / 列表项数 | **中英排版惯例本来就不同** —— 中文把内容排在列表里、英文排在正文段落里；中文还有「一格多项」（顿号分项）。实测 30 处「差异」全是方法假象，做成门禁会一直红且红了也没错 |
 * | 代码块内的命令行 | 命令**相同**，但**注释不同**（`查看开关与笔记树状态` vs `Show switch and note-tree status`）。注释本就该翻译 |
 * | **围栏语言标记** | **完全相同** ✅ 不承载语义，不一致即漂移 |
 *
 * 所以选了它 —— 而且**不需要 mdast**：判据就是「围栏行里 ``` 后面那个词」，
 * 它在代码块内容之外，正则不会误吃块内的东西。
 *
 * @param {string} text Markdown 原文。
 * @returns {{ levels: number[], fences: number, fenceLangs: string[] }} 结构指纹。
 */
export function structureOf(text) {
  /* 标题：去掉围栏代码块后再数，否则代码示例里的 `# 注释` 会被当标题。 */
  const withoutFences = text.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g, '\n');
  const levels = [];
  for (const line of withoutFences.split('\n')) {
    const match = /^(#{1,6})\s+\S/.exec(line);
    if (match !== null) levels.push(match[1].length);
  }
  /* 代码块：数围栏行数的一半（开 + 闭）。 */
  const fenceLines = text.match(/^\s*(```|~~~)/gm) ?? [];

  /* 语言标记：只取**开启**围栏的那些（开闭成对，奇偶位置 0/2/4… 是开）。
     取全部会让闭合围栏的「空标记」混进来，比对时噪声更大。 */
  const marks = [...text.matchAll(/(?:^|\n)(?:```|~~~)([^\n]*)/g)].map((m) => m[1].trim());
  const fenceLangs = marks.filter((_, i) => i % 2 === 0);

  return { levels, fences: Math.floor(fenceLines.length / 2), fenceLangs };
}

/**
 * 把层级序列渲染成可读形式，便于报错时定位。
 *
 * @param {number[]} levels 层级序列。
 * @returns {string} 形如 `1,2,3,3,2` 的串。
 */
function render(levels) {
  return levels.join(',');
}

/**
 * 校验所有配对的双语文档。
 *
 * @param {{pairs?: typeof PAIRS, read?: (path: string) => string}} [options] 选项。
 *   `read` 用于把校验指向别处（测试的临时副本）。**真仓库只读不写是硬边界**：
 *   `node --test` 并行跑各个测试文件，改写真实 README 会让别的测试读到
 *   改到一半的内容（实测 6 次全量跑红 4 次，单独跑全绿）。
 * @returns {{ pairs: number, errors: string[], warnings: string[] }} 结果。
 */
export function verifyBilingual(options = {}) {
  const list = options.pairs ?? PAIRS;
  const read = options.read ?? ((path) => readFileSync(path, 'utf8'));
  const errors = [];
  const warnings = [];

  for (const pair of list) {
    const primaryPath = join(PACKAGE_ROOT, pair.primary);
    const secondaryPath = join(PACKAGE_ROOT, pair.secondary);
    const primary = structureOf(read(primaryPath));
    const secondary = structureOf(read(secondaryPath));

    /* 标题层级必须逐条对应。长度不同说明有一版多了/少了节。 */
    if (primary.levels.length !== secondary.levels.length) {
      errors.push(
        `${pair.key}: 标题数量不一致 —— ${pair.primary} 有 ${primary.levels.length} 个，`
        + `${pair.secondary} 有 ${secondary.levels.length} 个。`
        + '新增或删除章节时两版必须同步。'
      );
      /* 数量不同时再报层级会刷屏，只报一处并提示怎么办。 */
      continue;
    }

    for (let i = 0; i < primary.levels.length; i += 1) {
      if (primary.levels[i] !== secondary.levels[i]) {
        errors.push(
          `${pair.key}: 第 ${i + 1} 个标题层级不一致 —— `
          + `${pair.primary} 是 h${primary.levels[i]}，${pair.secondary} 是 h${secondary.levels[i]}。`
        );
        /* 只报第一处层级错位：它是根因，后面的错位多半是它引起的连带。 */
        break;
      }
    }

    /* 代码块数量对不上，说明示例没同步 —— 那是最容易漏的一类。 */
    if (primary.fences !== secondary.fences) {
      errors.push(
        `${pair.key}: 代码块数量不一致 —— ${pair.primary} 有 ${primary.fences} 个，`
        + `${pair.secondary} 有 ${secondary.fences} 个。`
      );
      /* 数量不同就不必再比语言标记 —— 报一处并提示怎么办。 */
      continue;
    }

    /* 语言标记顺序必须一致。它是**语言无关**的（翻译 ```sh 没有意义），
       所以不一致一定是真漂移 —— 与段落数/列表项数不同，那些是中英排版
       惯例的正常差异，做成门禁会一直红且红了也没错。 */
    if (JSON.stringify(primary.fenceLangs) !== JSON.stringify(secondary.fenceLangs)) {
      errors.push(
        `${pair.key}: 代码块语言标记不一致 —— `
        + `${pair.primary} 是 [${primary.fenceLangs.join(', ')}]，`
        + `${pair.secondary} 是 [${secondary.fenceLangs.join(', ')}]。`
        + '语言标记不承载语义（翻译 ```sh 没有意义），不一致即为漏同步。'
      );
    }
  }

  return { pairs: list.length, errors, warnings };
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

function main() {
  const result = verifyBilingual();
  if (result.errors.length === 0) {
    console.log(`双语文档一致性通过：${result.pairs} 对文件的结构（标题层级与代码块数）完全对应。`);
    process.exit(0);
  }
  console.error(`双语文档一致性失败：${result.errors.length} 处`);
  for (const error of result.errors) console.error(`  ✖ ${error}`);
  console.error('  修复：让两版结构对应，或若确实有意只改一版，说明理由并同步另一版。');
  process.exit(1);
}

const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replace(/\\/g, '/').endsWith('/tools/bilingual-docs.mjs');
if (invokedDirectly) main();