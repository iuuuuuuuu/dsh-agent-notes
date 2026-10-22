/**
 * 定位本机可用的 Chrome / Chromium 可执行文件。
 *
 * ## 为什么需要这个模块
 *
 * 8 个渲染探针（`.probe/*.mjs`）原先各自硬编码：
 *
 * ```js
 * const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
 * ```
 *
 * 换机器、换平台就崩 —— **这是它们不能进 `npm test` 的直接原因**。
 * 而「界面改动必须真机所见」是本仓库的硬约束，现在这条约束靠人的记性维持。
 *
 * ## 为什么不用 puppeteer 全部接管
 *
 * 探针是**原生 CDP**（`spawn` Chrome + WebSocket 连 CDP），逻辑完整且已验证
 * 有效（`switch-render.mjs` 470 行：桩 React、`mountFresh()`、盒模型断言）。
 * 全部重写成 puppeteer 是纯浪费，且新写的版本没被充分验证。
 *
 * 所以这里只解决「**找到浏览器**」这一层，探针其余部分不动。
 *
 * ## 查找顺序
 *
 * 1. `$CHROME_PATH` —— 显式指定，永不猜
 * 2. `$PUPPETEER_EXECUTABLE_PATH` —— puppeteer 生态的约定变量
 * 3. `PATH` 里的可执行名
 * 4. 各平台常见安装位置
 * 5. puppeteer 下载缓存（CI 里 `npx puppeteer browsers install chrome` 装到那）
 *
 * ## 找不到时的行为
 *
 * 返回 `undefined` 而**不是抛异常** —— 探针据此跳过并说清原因，而不是
 * 崩在启动阶段。理由见 `explainMissingBrowser()`：渲染探针是可选的，
 * 找不到浏览器不该让 `npm test` 变红，但也不该被静默跳过。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { delimiter, join } from 'node:path';

/** 各平台的常见安装位置。 */
const WELL_KNOWN = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    join(homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe')
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium'
  ]
};

/**
 * 列出 puppeteer 下载缓存里的浏览器可执行文件。
 *
 * CI 上 `npx puppeteer browsers install chrome` 会装到这里。目录结构是
 * `<cache>/chrome/<平台>-<架构>/chrome-<版本>/chrome-<平台>`。
 *
 * @returns {string[]} 候选路径。
 */
function puppeteerCacheCandidates() {
  const roots = [
    process.env.PUPPETEER_CACHE_DIR,
    join(homedir(), '.cache', 'puppeteer')
  ].filter((p) => typeof p === 'string' && p.trim() !== '');

  const out = [];
  for (const root of roots) {
    const chromeDir = join(root, 'chrome');
    if (!existsSync(chromeDir)) continue;
    let entries;
    try {
      entries = readdirSync(chromeDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const platformDir of entries) {
      if (!platformDir.isDirectory()) continue;
      const base = join(chromeDir, platformDir.name);
      let versions;
      try {
        versions = readdirSync(base, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const version of versions) {
        if (!version.isDirectory()) continue;
        const versionDir = join(base, version.name);
        const names = [
          'chrome', 'chrome.exe', 'chrome-mac', 'chrome-mac-x64',
          'chrome-win', 'chrome-win32', 'chrome-win64', 'Chromium'
        ];
        for (const name of names) {
          const candidate = join(versionDir, name);
          if (existsSync(candidate)) out.push(candidate);
        }
      }
    }
  }
  return out;
}

/**
 * 定位可用的浏览器可执行文件。
 *
 * @returns {{ path: string | undefined, source: string }} 路径与来源；
 *   找不到时 path 为 undefined，source 是已查过的地方。
 */
export function findBrowser() {
  /* 记录「试过但没成功」的地方。成功时也**保留**它 ——
     设了不存在的 \`$CHROME_PATH\` 却被静默忽略、而返回值让人以为设置生效了，
     是最难查的一类问题（它表现得像「设置生效了」）。 */
  const tried = [];

  /** 成功时附带「已跳过」的说明。 */
  const withNotes = (path, source) => ({
    path,
    source: tried.length === 0 ? source : source + '\n  已跳过：\n    ' + tried.join('\n    ')
  });

  /* 1. 显式指定 —— 永不猜用户的意图。 */
  for (const [key, value] of [
    ['$CHROME_PATH', process.env.CHROME_PATH],
    ['$PUPPETEER_EXECUTABLE_PATH', process.env.PUPPETEER_EXECUTABLE_PATH]
  ]) {
    if (typeof value === 'string' && value.trim() !== '') {
      const path = value.trim();
      if (existsSync(path)) return withNotes(path, key);
      tried.push(`${key}（已设但文件不存在：${path}）`);
    }
  }

  /* 2. PATH 里的可执行名。 */
  const names = platform() === 'win32'
    ? ['chrome.exe', 'msedge.exe']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return withNotes(candidate, 'PATH');
        }
      } catch {
        /* 权限不足等，跳过。 */
      }
    }
  }

  /* 3. 常见安装位置。 */
  for (const candidate of WELL_KNOWN[platform()] ?? []) {
    if (existsSync(candidate)) return withNotes(candidate, '常见安装位置');
    tried.push(candidate);
  }

  /* 4. puppeteer 下载缓存（CI 用）。 */
  const cached = puppeteerCacheCandidates();
  if (cached.length > 0) return withNotes(cached[0], 'puppeteer 缓存');
  tried.push(`${process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), '.cache', 'puppeteer')}/chrome/**`);

  return { path: undefined, source: tried.join('\n  ') };
}

/**
 * 找不到浏览器时给出可执行的建议，而不是只说「没找到」。
 *
 * @returns {string} 多行说明。
 */
export function explainMissingBrowser() {
  const { source } = findBrowser();
  return [
    '找不到 Chrome / Chromium 可执行文件。',
    '已查找：',
    '  ' + source,
    '',
    '解决方式（任选其一）：',
    '  1. 设 $CHROME_PATH 指向你的浏览器',
    '  2. 设 $PUPPETEER_EXECUTABLE_PATH（puppeteer 生态的约定变量）',
    '  3. 让 puppeteer 下载一个：npx puppeteer browsers install chrome',
    '',
    '渲染探针是**可选的** —— 它们不在 npm test 里，所以找不到浏览器不会让',
    'check 变红。但那意味着「界面改动必须真机所见」这条约束只能靠人工。'
  ].join('\n');
}
