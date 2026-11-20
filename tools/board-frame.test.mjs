/** 真 Chromium 回归：运行原版空帧监视函数，不 mock DOMParser/iframe/fetch。 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { findBrowser } from './find-browser.mjs';
import { DRAWER_PATCH_JS } from '../lib/board-responsive.js';

const SOURCE = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
const RETURN = "return { name: NS, inject: ['slots'], apply: apply };";
assert.equal(SOURCE.split(RETURN).length, 2, '测试只能暴露原闭包函数，不能重写恢复逻辑');
const TEST_SOURCE = SOURCE.replace(RETURN, 'return { watchBoardFrame: watchBoardFrame };');

test('board frame: 真实浏览器区分空文档与已渲染看板，恢复后仍保留正确数据端点', { timeout: 60000 }, async (t) => {
  const executablePath = findBrowser().path ?? chromium.executablePath();
  assert.ok(existsSync(executablePath), '必须安装真实 Chromium：npx playwright-core install chromium，或设置 CHROME_PATH');
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ path: url.pathname, session: url.searchParams.get('session'), cwd: url.searchParams.get('cwd') });
    if (url.pathname.endsWith('/parent')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html><head></head><body></body></html>'); return; }
    if (url.pathname.endsWith('/data')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ revision: 'fixture', notes: [{ id: 'one' }] })); return;
    }
    if (url.pathname.endsWith('/slow.png')) { return; }
    if (url.pathname.endsWith('/fixture.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('window.fixtureLoaded = true;'); return;
    }
    if (url.pathname.endsWith('/ui')) {
      const key = url.searchParams.get('session');
      if (key === 'error') { res.writeHead(503, { 'content-type': 'text/html' }); res.end('<h1>unavailable</h1>'); return; }
      if (key === 'empty') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(''); return; }
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><head><title>fixture board</title><script src="fixture.js"></script></head>'
          + '<body><h1>真实笔记看板</h1>' + (key === 'loading' ? '<img src="slow.png">' : '')
          + '<script>window.__INLINE_DATA__=[{id:"one"}];window.ingestDataset=function(){};</script><script>'
          + DRAWER_PATCH_JS + '</script></body></html>');
      };
      if (key === 'delayed') setTimeout(send, 800); else send();
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/nested/dsh/`;
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    async function setup(key) {
      const page = await browser.newPage();
      page.setDefaultTimeout(12000);
      await page.goto(base + 'parent');
      await page.addScriptTag({ content: TEST_SOURCE + '\nwindow.watch = createAgentNotesClient(function(){return {createElement:function(){}};}).watchBoardFrame;' });
      const src = 'agent-notes/ui?session=' + key + '&cwd=' + encodeURIComponent('/repo with spaces/中文');
      await page.evaluate(async () => {
        const frame = document.createElement('iframe');
        frame.sandbox = 'allow-scripts allow-same-origin';
        const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
        document.body.append(frame);
        await loaded;
        window.frame = frame;
        window.phases = [];
      });
      return { page, src, start: () => page.evaluate(src => { window.stop = window.watch(window.frame, src, phase => window.phases.push(phase)); }, src) };
    }
    await t.test('正常导航不重复拉 HTML，也不替换已经显示的文档', async () => {
      const { page, src, start } = await setup('healthy');
      try {
        await page.evaluate(src => new Promise(resolve => { frame.addEventListener('load', resolve, { once: true }); frame.src = src; }), src);
        await start();
        await page.waitForFunction(() => phases.includes('ready'));
        assert.equal(await page.evaluate(() => frame.hasAttribute('srcdoc')), false);
        assert.equal(requests.filter(r => r.path.endsWith('/ui') && r.session === 'healthy').length, 1);
        await page.evaluate(() => stop());
      } finally { await page.close(); }
    });
    await t.test('非关键资源未加载完不遮挡已渲染的正文', async () => {
      const { page, src, start } = await setup('loading');
      try {
        await page.evaluate(src => { frame.src = src; }, src);
        await page.waitForFunction(() => frame.contentDocument?.readyState === 'interactive');
        await start();
        await page.waitForFunction(() => phases.includes('ready'));
        assert.equal(await page.evaluate(() => frame.contentDocument.readyState), 'interactive');
        assert.equal(await page.evaluate(() => frame.hasAttribute('srcdoc')), false);
        assert.equal(requests.filter(r => r.path.endsWith('/ui') && r.session === 'loading').length, 1);
        await page.evaluate(() => stop());
      } finally { await page.close(); }
    });
    await t.test('原生 about:blank 成功触发 load 但正文为空，必须由父页恢复', async () => {
      const { page, src, start } = await setup('blank');
      try {
        await start();
        await page.waitForFunction(() => phases.includes('ready'));
        const actual = await page.evaluate(() => ({
          url: frame.contentDocument.URL, base: frame.contentDocument.baseURI,
          count: frame.contentWindow.__INLINE_DATA__.length,
          script: frame.contentWindow.fixtureLoaded,
          data: frame.contentWindow.__agentNotesLive
        }));
        assert.equal(actual.url, 'about:srcdoc');
        assert.equal(actual.base, new URL(src, base + 'parent').href);
        assert.equal(actual.count, 1);
        assert.equal(actual.script, true, '脚本应按恢复后的 base URI 加载');
        assert.equal(await page.evaluate(() => {
          frame.contentWindow.history.replaceState(null, '', '#timeline');
          return frame.contentWindow.location.href;
        }), 'about:srcdoc#timeline', '片段历史必须归属恢复文档，不被 HTTP base 改写');
        assert.equal(await page.evaluate(() => {
          frame.contentWindow.history.replaceState(null, '', '#note=one');
          return frame.contentWindow.location.hash;
        }), '#note=one');
        assert.ok(actual.data.polls > 0);
        const dataRequest = requests.find(r => r.path === '/nested/dsh/agent-notes/data' && r.session === 'blank');
        assert.equal(dataRequest?.cwd, '/repo with spaces/中文', 'srcdoc 不能把 /data 错指向 about: 或丢掉 cwd');
        await page.evaluate(() => stop());
      } finally { await page.close(); }
    });
    await t.test('HTTP 失败与空 HTML 只报错误，不冒充 ready 或无限恢复', async () => {
      for (const key of ['error', 'empty']) {
        const { page, start } = await setup(key);
        try {
          await start();
          await page.waitForFunction(() => phases.includes('error'));
          assert.equal(await page.evaluate(() => phases.includes('ready')), false);
          assert.equal(requests.filter(r => r.path.endsWith('/ui') && r.session === key).length, 1);
          await page.evaluate(() => stop());
        } finally { await page.close(); }
      }
    });
    await t.test('用户重试重新启动恢复；停止后迟到响应不写入文档', async () => {
      const { page, src, start } = await setup('error');
      try {
        await start();
        await page.waitForFunction(() => phases.includes('error'));
        await page.evaluate(src => { stop(); window.stop = watch(frame, src.replace('session=error', 'session=retry'), phase => phases.push(phase)); }, src);
        await page.waitForFunction(() => phases.includes('ready'));
        await page.evaluate(() => stop());
      } finally { await page.close(); }
      const delayed = await setup('delayed');
      try {
        await delayed.start();
        while (!requests.some(r => r.session === 'delayed')) await new Promise(resolve => setTimeout(resolve, 30));
        await delayed.page.evaluate(() => stop());
        await delayed.page.waitForTimeout(1100);
        assert.equal(await delayed.page.evaluate(() => frame.hasAttribute('srcdoc')), false);
        assert.equal(await delayed.page.evaluate(() => phases.includes('ready')), false);
      } finally { await delayed.page.close(); }
    });
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
