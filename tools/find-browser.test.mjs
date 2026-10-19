/**
 * `tools/find-browser.mjs` 的行为测试。
 *
 * ## 为什么测试要真启动浏览器
 *
 * 「找到路径」不等于「能用」—— 可能版本太老、缺共享库、headless 行为不同。
 * 而本模块的用途是「让渲染探针能自动跑」，如果浏览器起不来，模块就是装饰。
 *
 * **不许 mock**：`spawnSync` 被换掉的话，这个测试就变成了「验证 mock 自己」，
 * 那是最典型的假绿 —— 而本仓库踩过 5 轮「测试替掉被测逻辑」的坑。
 *
 * 所以这里**真启动一次 headless Chrome**，读回 DOM。
 *
 * ## 无浏览器时的行为
 *
 * 若本机没有 Chrome（CI 里若不装），测试必须**显式跳过并说明**，
 * 而不是静默通过 —— 静默通过正是本仓库最忌讳的形态。
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { explainMissingBrowser, findBrowser } from './find-browser.mjs';

test('find-browser: 显式指定的路径最优先（且永不猜）', () => {
  /* `$CHROME_PATH` 是「用户明说了要用哪个」，必须排在所有自动探测之前。
     若不优先，用户设的路径会被自动探测覆盖 —— 那等于显式设置无效。 */
  const fake = join(tmpdir(), 'fake-browser-for-test');
  const previous = process.env.CHROME_PATH;
  process.env.CHROME_PATH = fake;
  try {
    const result = findBrowser();
    /* 设了但文件不存在 → 不该用它，但要在「已查找」里说明。 */
    assert.notEqual(result.path, fake, '不存在的显式路径不得被当成可用');
    assert.match(result.source, /\$CHROME_PATH/, '必须说明「已设但文件不存在」');
  } finally {
    if (previous === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = previous;
  }
});

test('find-browser: 找不到时返回 undefined 并列出查过的地方', () => {
  /* 返回 undefined 而不抛异常 —— 探针据此跳过。
     但要说清查过哪些，否则排查无从下手。 */
  const previousChrome = process.env.CHROME_PATH;
  const previousPuppeteer = process.env.PUPPETEER_EXECUTABLE_PATH;
  process.env.CHROME_PATH = '';
  process.env.PUPPETEER_EXECUTABLE_PATH = '';
  try {
    const result = findBrowser();
    /* 本机有 Chrome 时它会找到 —— 那本身没问题，只验「有或无都说得清」。 */
    if (result.path === undefined) {
      assert.ok(result.source.length > 20, '找不到时必须列出查过的地方');
      assert.match(result.source, /chrome|Chrome/, '至少应提到 chrome 相关位置');
    }
  } finally {
    if (previousChrome === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = previousChrome;
    if (previousPuppeteer === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = previousPuppeteer;
  }
});

test('find-browser: explainMissingBrowser 给出可执行的解决方式', () => {
  const text = explainMissingBrowser();
  assert.match(text, /CHROME_PATH|PUPPETEER_EXECUTABLE_PATH|puppeteer browsers install/,
    '必须给出至少一种可执行的解决方式');
});

test('find-browser: 找到的浏览器必须真能启动（不 mock）', { timeout: 90_000 }, (t) => {
  /* 这一条是整个模块的意义 —— 「找到路径」不等于「能用」。
     不 mock spawnSync：那会让测试变成「验证 mock 自己」，是本仓库反复
     踩过的假绿形态。 */
  const { path: browser } = findBrowser();

  if (browser === undefined) {
    t.skip('本机没有 Chrome/Chromium —— 渲染探针本就是可选的');
    return;
  }

  const r = spawnSync(browser, [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--dump-dom',
    'data:text/html,<title>find-browser-probe</title>'
  ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });

  assert.equal(r.status, 0, `浏览器应能启动，实际退出码 ${r.status}：\n${r.stderr ?? ''}`);
  assert.match(`${r.stdout ?? ''}`, /find-browser-probe/,
    `应能用 --dump-dom 读到页面内容，实际输出：\n${(r.stdout ?? '').slice(0, 300)}`);
});

test('find-browser: 能打开本地文件（探针的真实用法）', { timeout: 90_000 }, (t) => {
  /* 探针不是访问 data: URL，而是打开本地 html。两者行为不同：
     file:// 协议有独立的权限模型（--allow-file-access-from-files）。 */
  const { path: browser } = findBrowser();
  if (browser === undefined) {
    t.skip('本机没有 Chrome/Chromium');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'an-fb-'));
  try {
    const file = join(dir, 'probe.html');
    writeFileSync(file, '<!DOCTYPE html><title>local-probe</title><p>本地内容</p>', 'utf8');

    const r = spawnSync(browser, [
      '--headless', '--disable-gpu', '--no-sandbox',
      '--allow-file-access-from-files',
      '--dump-dom',
      'file:///' + file.replace(/\\/g, '/')
    ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });

    assert.equal(r.status, 0, `打开本地文件应成功，实际 ${r.status}：\n${r.stderr ?? ''}`);
    assert.match(`${r.stdout ?? ''}`, /本地内容/, '应读到本地文件的内容');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});