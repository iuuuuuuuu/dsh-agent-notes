/**
 * 发版记账一致性：`package.json` / `git tag` / `CHANGELOG.md` 三者要对得上。
 *
 * ## 为什么需要
 *
 * 仓库里已经有 `bump-version.mjs`（只改版本号）与一条测试守着
 * 「`package.json` 版本 == 最新 `git tag`」。但 **CHANGELOG 完全无人管**：
 *
 *   - 版本号改了、tag 打了，CHANGELOG 里没有对应段 → 用户看到的发布说明是空的；
 *   - CHANGELOG 里写了 `[0.6.0]`，但包还是 `0.5.0` → 说明与实际不符；
 *   - 同一版本出现两个段、或日期格式不统一 → 记账不可信。
 *
 * 这三条都会让「发布流程」变成一件靠人记得的事。本仓库的发版纪律里有一条
 * 是硬要求（**发版必须先获得用户明确许可**），而那类纪律如果没有机制支撑，
 * 迟早会靠不住。
 *
 * ## 检查什么
 *
 * 1. `package.json` 的当前版本**必须**在 CHANGELOG 里有对应段
 *    （`[Unreleased]` 之后的第一个已发布段）；
 * 2. CHANGELOG 里的版本段必须**严格递增**且无重复；
 * 3. 每个版本段必须带 `YYYY-MM-DD` 日期；
 * 4. `[Unreleased]` 是唯一允许没有日期的段；
 * 5. 若存在 `[Unreleased]`，它必须有内容 —— 空段说明「攒着不发」，
 *    而攒着不发本身就该被看见（要么发，要么把内容挪进版本段）。
 *
 * ## 不检查什么
 *
 * **不检查 CHANGELOG 的内容是否准确**（这一版到底改了什么）。
 * 那需要判断「这段文字是否描述了本次变更」，属于语义问题，做不成可靠门禁。
 * 本门禁只保证**结构上对得上**，内容准确性仍靠 review。
 *
 * **不检查 tag 是否已打**。`version.test.mjs` 已经守 `package.json ↔ tag`，
 * 这里重复会变成两套可能互相矛盾的判断。发 tag 是发版流程的动作，
 * 不是 CHANGELOG 的属性。
 *
 * ## 用法
 *
 * ```sh
 * npm run release:check
 * ```
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 读出 CHANGELOG 的版本段结构。
 *
 * 只认行首的 `## [x.y.z] - YYYY-MM-DD` 与 `## [Unreleased]`。
 * `###` 开头的是段内小节，不参与。
 *
 * @param {string} text CHANGELOG 原文。
 * @returns {{ version: string, date: string | null, body: string }[]} 段列表，按文件出现顺序。
 */
export function parseChangelog(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;

  for (const line of lines) {
    const match = /^## \[([^\]]+)\](?: - (\S+))?\s*$/.exec(line);
    if (match === null) {
      if (current !== null) current.body += `${line}\n`;
      continue;
    }
    if (current !== null) sections.push(current);
    current = { version: match[1], date: match[2] ?? null, body: '' };
  }
  if (current !== null) sections.push(current);
  return sections;
}

/**
 * 校验发版记账。
 *
 * @param {{read?: (name: string) => string}} [options] 选项。
 *   `read` 按仓库内相对文件名取内容，供测试把输入指向内存副本。
 *   **真仓库只读不写是硬边界**：`node --test` 并行跑各个测试文件，
 *   改写 `package.json` / `CHANGELOG.md` 会让门禁与其它测试读到中间态
 *   （这条纪律来自一次真实的偶发失败，见 testing 那篇笔记）。
 * @returns {{ version: string, errors: string[] }} 结果。
 */
export function verifyRelease(options = {}) {
  const read = options.read ?? ((name) => readFileSync(join(PACKAGE_ROOT, name), 'utf8'));
  const pkg = JSON.parse(read('package.json'));
  const changelog = read('CHANGELOG.md');
  const sections = parseChangelog(changelog);
  const errors = [];

  const unreleased = sections.find((s) => s.version === 'Unreleased');
  const released = sections.filter((s) => s.version !== 'Unreleased');

  /* 0. `package-lock.json` 的版本必须与 `package.json` 一致。
     lock 文件在 `tools/notes-coverage.mjs` 的 `DEFAULT_EXEMPT_FILES` 里被豁免
     「要不要配笔记」，但那**只**豁免笔记义务，没有任何门禁校验它的版本字段。
     实测这个缺口**已经真实发生过**：仓库里 `package.json` 是 0.8.0、
     `package-lock.json` 还停在 0.6.0，而 13 步门禁链全 0。
     后果不是「数字不好看」：`npm ci` 会按 lock 里的版本装出产物，
     而 `npm publish` 用的是 `package.json` 的版本 —— 两者不一致时，
     装出来的包与发布的包版本号不同，且没有任何报错。 */
  let lockVersion = null;
  try {
    const lock = JSON.parse(read('package-lock.json'));
    lockVersion = typeof lock?.version === 'string' ? lock.version : null;
    if (lockVersion === null) {
      errors.push('package-lock.json 缺少顶层 version 字段 —— 它与 package.json 的版本必须一致');
    } else if (lockVersion !== pkg.version) {
      errors.push(
        `package-lock.json 的版本是 ${lockVersion}，而 package.json 是 ${pkg.version} —— 两者必须一致。`
        + '改版本号后忘了同步 lock 就会发生：npm ci 按 lock 装、npm publish 按 package.json 发，'
        + '装出来的包与发布的包版本号不同。修复：npm install --package-lock-only。'
      );
    }
  } catch (error) {
    errors.push(
      `package-lock.json 读取或解析失败：${error instanceof Error ? error.message : String(error)}`
      + ' —— 它与 package.json 的版本必须一致，判不了就不能算通过。'
    );
  }

  /* 1. 当前版本必须有对应段。没有 = 用户看到的发布说明是空的。 */
  const hasCurrent = released.some((s) => s.version === pkg.version);
  if (!hasCurrent) {
    const newest = released[0];
    errors.push(
      `package.json 版本 ${pkg.version} 在 CHANGELOG.md 里没有对应段`
      + `${newest === undefined ? '（CHANGELOG 里一个已发布段都没有）' : `（最新的是 ${newest.version}）`}。`
      + '发布前必须先把本次变更写进版本段。'
    );
  }

  /* 2. 版本段不得重复 —— 重复说明版本号被复用，语义化版本不允许。 */
  const seen = new Map();
  for (const section of released) {
    if (seen.has(section.version)) {
      errors.push(`CHANGELOG.md 里版本 ${section.version} 出现了两次 —— 语义化版本不允许复用同一个版本号`);
    }
    seen.set(section.version, true);
  }

  /* 3. 版本段必须严格递减（文件里从上到下是最新的在前）。 */
  for (let i = 1; i < released.length; i += 1) {
    const newer = released[i - 1].version;
    const older = released[i].version;
    if (compareSemver(newer, older) <= 0) {
      errors.push(
        `CHANGELOG.md 里版本顺序不对：${newer} 出现在 ${older} 之前，`
        + '但它并不更新（应为最新版本在前、依次递减）'
      );
    }
  }

  /* 4. 每个已发布段必须带合法日期。 */
  for (const section of released) {
    if (section.date === null) {
      errors.push(`CHANGELOG.md 的 [${section.version}] 段缺少日期（应为 ## [${section.version}] - YYYY-MM-DD）`);
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(section.date)) {
      errors.push(`CHANGELOG.md 的 [${section.version}] 日期格式不对：${JSON.stringify(section.date)}（应为 YYYY-MM-DD）`);
    }
  }

  /* 5. [Unreleased] 存在时必须有内容 —— 空段说明「攒着不发」却看不见。 */
  if (unreleased !== undefined) {
    const hasContent = unreleased.body
      .split('\n')
      .some((line) => /^\s*[-*]\s+\S/.test(line));
    if (!hasContent) {
      errors.push(
        'CHANGELOG.md 的 [Unreleased] 段是空的 —— '
        + '要么把内容归入下一个版本段，要么删掉这个空段（空段会让「攒着不发」这件事看不见）'
      );
    }
  }

  return { version: pkg.version, errors };
}

/**
 * 比较两个语义化版本号。
 *
 * 只比三段数字，不处理预发布标识 —— 本仓库的版本都是 `x.y.z`，
 * 而 `version.test.mjs` 已经守着「必须是合法语义化版本」这条。
 *
 * @param {string} a 版本 A。
 * @param {string} b 版本 B。
 * @returns {number} a>b 返回正，a<b 返回负，相等返回 0。
 */
function compareSemver(a, b) {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10));
  const pb = b.split('.').map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

function main() {
  const result = verifyRelease();
  if (result.errors.length === 0) {
    console.log(`发版记账一致：package.json ${result.version} 与 CHANGELOG.md 对得上。`);
    process.exit(0);
  }
  console.error(`发版记账不一致：${result.errors.length} 处`);
  for (const error of result.errors) console.error(`  ✖ ${error}`);
  console.error('  修复：先在 CHANGELOG.md 写下本次变更的版本段，再改版本号 / 打 tag。');
  process.exit(1);
}

const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replace(/\\/g, '/').endsWith('/tools/release-check.mjs');
if (invokedDirectly) main();
