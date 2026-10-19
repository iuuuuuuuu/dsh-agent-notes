/**
 * 生成并校验 `THIRD_PARTY_NOTICES.md` —— 第三方内容归属声明。
 *
 * ## 为什么必须有这个
 *
 * 本插件的 `skills/agent-notes/` 下 21 个文件是**上游的 vendored 副本**
 * （`upstream.json` 记录来源与钉死的 commit）。MIT 许可证第一条要求：
 * 分发衍生作品时必须**保留原版权声明与许可声明**。
 *
 * 此前本仓库只有一份自己的 `LICENSE`，完全没提上游 —— 那是真实的合规缺口，
 * 不是「等有人需要再说」的优化项。归属声明是完整分发流程的一部分。
 *
 * ## 与上游同名脚本的关系
 *
 * `deepseek-ai/deepseek-harness` 的 `gen-third-party-notices.ts` 扫的是
 * **npm 依赖 + Python 依赖 + vendored 包**（它是个 monorepo，三类都有）。
 * 本插件的第三方内容只有一类：vendored 上游文件。所以这里不复制它那套
 * 多生态解析，只做「vendored 来源 + 本包 devDependencies」两件事 ——
 * 前者是法定义务，后者是事实披露。
 *
 * ## 为什么需要依赖
 *
 * `spdx-expression-parse` 用来校验许可证标识符是否合法。手写正则判断
 * 「MIT」这种简单标识符可行，但 `MIT OR Apache-2.0`、`(MIT AND BSD-2-Clause)`
 * 这类表达式手写必错，而写错的许可证标识符比没有更糟 —— 它会让人以为
 * 自己合规了。这是「用依赖换正确性」的正当场景。
 *
 * ## 用法
 *
 * ```sh
 * npm run notices          # 生成 / 更新 THIRD_PARTY_NOTICES.md
 * npm run notices:check    # 校验已提交的版本是否最新（CI 与 check 用）
 * ```
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import parseSpdx from 'spdx-expression-parse';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(PACKAGE_ROOT, 'THIRD_PARTY_NOTICES.md');

/** 生成物里的固定横幅：提醒读者这是机器生成的，别手改。 */
const BANNER = [
  '<!-- 由 `npm run notices` 生成，请勿手改。',
  '     校验：`npm run notices:check`（已接入 npm run check 与 CI）。 -->'
].join('\n');

/**
 * 读取并校验 SPDX 许可证标识符。
 *
 * @param {string} expression SPDX 表达式，如 `MIT` 或 `MIT OR Apache-2.0`。
 * @param {string} where 出错时用于定位的说明。
 * @returns {string} 规范化后的表达式。
 * @throws {Error} 表达式非法时抛错 —— 宁可生成失败，也不要写出错的许可证。
 */
function requireSpdx(expression, where) {
  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new Error(`${where}: 缺少 license 字段。第三方归属必须声明许可证，不能留空。`);
  }
  try {
    parseSpdx(expression);
  } catch {
    throw new Error(`${where}: 许可证标识符不是合法的 SPDX 表达式：${JSON.stringify(expression)}`);
  }
  return expression.trim();
}

/**
 * 归一化仓库地址为可点击的 https 形式。
 *
 * `upstream.json` 里存的是 `git+https://…git` 或 `https://…git`，
 * 直接贴进 Markdown 不好看也不好点。
 *
 * @param {string} repository 原始仓库地址。
 * @returns {string} 归一化后的 https 地址。
 */
function webUrl(repository) {
  return repository
    .replace(/^git\+/, '')
    .replace(/\.git$/, '');
}

/**
 * 取本包的开发依赖，**含传递依赖**，用于事实披露。
 *
 * 为什么从 devDependencies 出发：本插件的 `dependencies` / `peerDependencies`
 * 必须为空（`verify-plugin.mjs` 拦 `@deepseek-ai/*`，且装成插件时不该向下
 * 拖依赖树）。
 *
 * 为什么要递归：直接依赖会带回自己的依赖（`spdx-expression-parse` 就带了
 * `spdx-exceptions` 与 `spdx-license-ids`）。只列直接依赖的「归属声明」是
 * 不完整的 —— 那些传递依赖同样是被分发到开发者机器上的第三方作品，
 * 它们的许可证同样该被披露。
 *
 * @returns {{ name: string, version: string, license: string, direct: boolean }[]} 依赖清单。
 */
function devDependencies() {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  const declared = pkg.devDependencies ?? {};

  /** 读一个已安装包的元数据；未安装时返回 null。 */
  const metaOf = (name) => {
    try {
      return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'node_modules', name, 'package.json'), 'utf8'));
    } catch { return null; }
  };

  /** 从包的 license 字段取一个可展示的标识符。 */
  const licenseOf = (meta) => {
    if (meta === null) return '（未在包内声明）';
    if (typeof meta.license === 'string') return meta.license;
    if (meta.license !== null && typeof meta.license === 'object' && meta.license.type) {
      return String(meta.license.type);
    }
    /* 老格式：licenses 数组，取第一个的 type。 */
    if (Array.isArray(meta.licenses) && meta.licenses.length > 0) {
      const first = meta.licenses[0];
      if (typeof first === 'string') return first;
      if (first !== null && typeof first === 'object' && first.type) return String(first.type);
    }
    return '（未在包内声明）';
  };

  const rows = [];
  const seen = new Set();

  /**
   * 深度优先收集一个包及其依赖。
   *
   * @param {string} name 包名。
   * @param {boolean} direct 是否顶层直接依赖。
   */
  const walk = (name, direct) => {
    if (seen.has(name)) return;
    seen.add(name);
    const meta = metaOf(name);
    rows.push({
      name,
      version: direct ? String(declared[name] ?? '') : String(meta?.version ?? ''),
      license: licenseOf(meta),
      direct
    });
    if (meta === null) return;
    /* 只跟 dependencies：包的 devDependencies 不随它分发给下游。 */
    for (const child of Object.keys(meta.dependencies ?? {})) walk(child, false);
  };

  for (const name of Object.keys(declared)) walk(name, true);
  rows.sort((a, b) => {
    if (a.direct !== b.direct) return a.direct ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

/**
 * 读取 vendored 上游的来源信息。
 *
 * @returns {{ repository: string, url: string, ref: string, path: string, license: string, fileCount: number }} 来源信息。
 */
function vendoredSource(read) {
  const upstream = JSON.parse(read('upstream.json'));
  const license = requireSpdx(upstream.license, 'upstream.json');
  const manifest = JSON.parse(read('tools/upstream-manifest.json'));
  const fileCount = Object.keys(manifest.files ?? {}).length;
  return {
    repository: upstream.repository,
    url: webUrl(upstream.repository),
    ref: String(manifest.ref ?? upstream.ref),
    path: upstream.path ?? '',
    license,
    fileCount
  };
}

/**
 * 组装声明全文。
 *
 * @param {{read?: (name: string) => string}} [options] 选项。
 *   `read` 按**仓库内的相对文件名**取内容（如 `'upstream.json'`），
 *   供测试把输入指向内存内容。**真仓库只读不写是硬边界**：`node --test`
 *   并行跑各个测试文件，测试改写真实 `upstream.json` 会让
 *   `notices:check` 与其它测试读到改到一半的内容。
 * @returns {string} Markdown 文本。
 */
export function renderNotices(options = {}) {
  /* 形状错误必须显式失败，不许静默退化。
     `renderNotices(readFn)`（把函数直接当参数传）会让 `options.read` 取到
     undefined，于是回落到真仓库读取 —— 不报错，但「注入上游许可证」这个
     意图彻底失效，测试会变成在验真仓库。这是实测踩过的（参数形状与名字
     对不上时，调用点写起来仍然「像对的」）。 */
  if (typeof options === 'function') {
    throw new TypeError(
      'renderNotices(options) 需要一个对象，形如 { read }。'
      + '直接把读取函数当参数传会被静默忽略，注入的数据不会生效。'
    );
  }
  const read = options.read ?? ((name) => readFileSync(join(PACKAGE_ROOT, name), 'utf8'));
  const pkg = JSON.parse(read('package.json'));
  /* 本包自己的许可证也要过 SPDX 校验：写成 `MIT Foo` 这类脏值会让声明
     「看起来合规」，而那比没有声明更糟。 */
  const own = requireSpdx(pkg.license, 'package.json');
  const source = vendoredSource(read);
  const dev = devDependencies();

  const lines = [
    '# 第三方内容归属声明',
    '',
    BANNER,
    '',
    '本仓库分发的内容里包含第三方作品。本文件按 MIT 等许可证的要求，',
    '保留它们的来源、版本与许可声明。',
    '',
    `本插件自身以 **${own}** 许可发布，全文见 [LICENSE](LICENSE)。`,
    '',
    '## 1. vendored 上游内容',
    '',
    `\`skills/agent-notes/\` 下的 ${source.fileCount} 个文件是下列上游内容的副本，`,
    '由 `tools/sync-upstream.mjs` 同步维护（**请勿手改**，改动会被',
    '`tools/verify-plugin.mjs` 的哈希比对拦下）。',
    '',
    '| 项目 | 值 |',
    '|---|---|',
    `| 上游仓库 | <${source.url}> |`,
    `| 同步路径 | \`${source.path}\` |`,
    `| 固定 commit | \`${source.ref}\` |`,
    `| 许可证 | ${source.license} |`,
    `| 文件数 | ${source.fileCount} |`,
    ''
  ];

  /* 上游没有独立 LICENSE 文件这件事要如实写出来：不写的话，
     读者会以为我们核对过那份文件。诚实的披露比看起来整齐更有价值。 */
  lines.push(
    '> **关于上游许可证文件的说明**：上游仓库的 README 声明 MIT 并链接',
    '> `LICENSE`，但该文件在其仓库中并不存在（实测 404）。本仓库按 README 的',
    '> MIT 声明处理，并在此如实记录这一差异 —— 我们无法核对一份不存在的文件。',
    ''
  );

  lines.push(
    '## 2. 开发依赖',
    '',
    '以下依赖**不随本插件发布**，只在开发与校验时使用（`dependencies` 与',
    '`peerDependencies` 为空，`tools/verify-plugin.mjs` 会拦下任何',
    '`@deepseek-ai/*` 运行时依赖）。列出它们是为了让「这个仓库靠什么构建」',
    '可被审计。',
    '',
    '**传递依赖也一并列出**：归属声明只列直接依赖是不完整的 —— 那些被间接',
    '拉进来的包同样落在开发者机器上，许可证同样该被披露。',
    ''
  );

  if (dev.length === 0) {
    lines.push('（无）', '');
  } else {
    lines.push('| 包 | 类型 | 版本 | 许可证 |', '|---|---|---|---|');
    for (const row of dev) {
      lines.push(`| \`${row.name}\` | ${row.direct ? '直接' : '传递'} | \`${row.version}\` | ${row.license} |`);
    }
    lines.push('');
  }

  lines.push(
    '## 3. 本插件自身',
    '',
    `\`${pkg.name}\` 以 ${own} 发布，版权归 dsh-agent-notes contributors，`,
    '全文见 [LICENSE](LICENSE)。',
    ''
  );

  return lines.join('\n');
}

/**
 * 生成并写入 `THIRD_PARTY_NOTICES.md`。
 *
 * @returns {string} 写入的文本。
 */
export function writeNotices() {
  const text = renderNotices();
  writeFileSync(OUT, text);
  return text;
}

/**
 * 校验已提交的声明与当前内容一致。
 *
 * @param {{read?: (name: string) => string, actual?: string | null}} [options] 选项。
 *   `read` 透传给 `renderNotices`；`actual` 直接指定「当前已有的内容」，
 *   供测试注入篡改后的文本而不必写盘。
 * @returns {{ ok: boolean, expected: string, actual: string | null }} 校验结果。
 */
export function checkNotices(options = {}) {
  const expected = renderNotices(options.read === undefined ? {} : { read: options.read });
  const actual = options.actual !== undefined
    ? options.actual
    : (existsSync(OUT) ? readFileSync(OUT, 'utf8') : null);
  return { ok: actual === expected, expected, actual };
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const isMain = process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isMain || argv.includes('--check') || argv.includes('--write')) {
  if (argv.includes('--check')) {
    const result = checkNotices();
    if (result.ok) {
      console.log('第三方声明校验通过：THIRD_PARTY_NOTICES.md 与当前内容一致。');
      process.exit(0);
    }
    console.error('第三方声明与当前内容不一致。');
    if (result.actual === null) {
      console.error('  ✖ THIRD_PARTY_NOTICES.md 不存在 —— 请跑 npm run notices');
    } else {
      /* 只指出前几处差异就够定位；整篇 diff 会把终端刷爆。 */
      const expectedLines = result.expected.split('\n');
      const actualLines = result.actual.split('\n');
      let shown = 0;
      for (let i = 0; i < Math.max(expectedLines.length, actualLines.length) && shown < 5; i += 1) {
        if (expectedLines[i] !== actualLines[i]) {
          console.error(`  ✖ 第 ${i + 1} 行起不一致`);
          console.error(`      期望: ${JSON.stringify(expectedLines[i] ?? '(缺)')}`);
          console.error(`      实际: ${JSON.stringify(actualLines[i] ?? '(缺)')}`);
          shown += 1;
        }
      }
    }
    console.error('  修复：npm run notices');
    process.exit(1);
  }

  writeNotices();
  console.log('已生成 THIRD_PARTY_NOTICES.md');
}
