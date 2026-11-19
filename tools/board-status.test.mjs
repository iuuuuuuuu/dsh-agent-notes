/** 真 HTTP + 插件入口验证：status 与 board 必须看同一个会话、同一组笔记根。 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mountHarness } from './harness.mjs';

function writeNote(root) {
  const dir = join(root, 'implemented', 'bug-fix');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '2026-11-19-existing.md');
  writeFileSync(file, '# Agent Note: 已有笔记\n\nStatus: implemented\n\n## Problem\n旧项目只保留脚本。\n');
  return file;
}

async function listen(t, dir, config = {}) {
  const sessions = new Map([
    ['notes-session', { header: { cwd: join(dir, 'notes-project') } }],
    ['plain-session', { header: { cwd: join(dir, 'plain-project') } }]
  ]);
  for (const session of sessions.values()) mkdirSync(session.header.cwd, { recursive: true });
  const { registered } = mountHarness({
    stateFile: join(dir, 'state.json'), sessions, withWebServer: true,
    config: { ...config, injectPolicy: false }
  });
  assert.equal(registered.routes.length, 1, '必须走 apply 挂出的路由，不另造判据');
  const server = createServer(registered.routes[0].handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return async (path) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/agent-notes/${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  };
}

test('status: 旧式 notes-scripts 项目显示；空目录不显示；会话 cwd 优先于客户端参数', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'an-live-status-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const call = await listen(t, dir);
  const notes = join(dir, 'notes-project', '.agents', 'notes');
  const empty = join(dir, 'plain-project', '.agents', 'notes');
  mkdirSync(join(dir, 'notes-project', '.agents', 'notes-scripts'), { recursive: true });
  mkdirSync(empty, { recursive: true });
  const file = writeNote(notes);

  assert.equal((await call('status?session=notes-session')).available, true);
  assert.equal((await call('status?session=plain-session')).available, false);
  assert.equal((await call('board?session=notes-session')).total, 1);
  assert.equal((await call('status?session=plain-session&cwd=' + encodeURIComponent(join(dir, 'notes-project')))).available,
    false, '不能用别的 cwd 覆盖已知会话');
  assert.equal((await call('status?session=not-loaded&cwd=' + encodeURIComponent(join(dir, 'notes-project')))).available,
    true, '本会话未加载时可以用客户端声明的绝对 cwd');
  assert.equal((await call('status?session=unknown')).available, false, '不能猜活跃会话或进程目录');
  assert.equal((await call('status?cwd=.')).available, false);
  rmSync(file);
  assert.equal((await call('status?session=notes-session')).available, false, '删除最后一篇后要重新判定');
  writeNote(notes);
  assert.equal((await call('status?session=notes-session')).available, true, '同会话写回首篇无需重启');
});

test('status: 配置覆盖的笔记根与 board 一致，不因默认目录空而隐藏', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'an-custom-status-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const notesRoot = join(dir, 'custom-notes');
  const call = await listen(t, dir, { notesRoot });
  assert.equal((await call('status?session=notes-session')).available, false);
  writeNote(notesRoot);
  assert.equal((await call('status?session=notes-session')).available, true);
  assert.equal((await call('board?session=notes-session')).total, 1);
});
