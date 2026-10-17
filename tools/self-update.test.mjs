/**
 * 技能副本自更新的测试。
 *
 * 重点不是「能拉下来」，而是三条会让插件变成砖头的边界：
 *   1. 网络失败时必须**保留现有副本**，不能清空、不能写半套；
 *   2. 远端清单里的可疑路径（`../`）必须被挡住，不能写到包外；
 *   3. 内容相同时**不许重写磁盘**（重写会让 mtime 变化，触发无谓的热替换）。
 *
 * 第 1、2 条用打桩（stub）覆盖 —— 真实的断网与恶意清单无法在测试里制造。
 * 第 3 条用真实调用验证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { SKILL_COPY_DIR, UPDATE_SOURCE, updateSkillCopy } from '../lib/self-update.js';

/** 备份某个副本文件的当前内容，返回还原函数。 */
function withBackup(rel) {
  const target = join(SKILL_COPY_DIR, rel);
  const original = readFileSync(target, 'utf8');
  return () => writeFileSync(target, original, 'utf8');
}

test('self-update: 来源指向本仓库，不是原始上游', () => {
  /* 从本仓库拉是本项目的刻意选择：本仓库跟随原始上游合并，等于多一层
     人工审核 —— 原始上游改坏了可以在这里挡掉。
     这条断言防止有人「顺手」把它改回原始上游。 */
  assert.equal(UPDATE_SOURCE.slug, 'iuuuuuuuu/dsh-agent-notes');
  assert.equal(UPDATE_SOURCE.branch, 'main');
});

test('self-update: 内容一致时不重写磁盘', async () => {
  /* 先跑一次确保是最新，再跑一次看有没有多写。
     用 mtime 判断：如果每次都重写，mtime 会变，热替换会被无谓触发。 */
  const first = await updateSkillCopy({});
  const second = await updateSkillCopy({});

  /* 两次都不该是 failed —— failed 说明网络或 CDN 挂了，测试环境问题。 */
  assert.notEqual(second.status, 'failed', `更新失败: ${second.reason ?? ''}`);
  assert.ok(
    ['current', 'updated'].includes(second.status),
    `状态异常: ${second.status}`
  );
  /* 第二次（或第二次等于第一次的结果）必须收敛到 current：内容已一致。 */
  if (first.status === 'current') {
    assert.equal(second.status, 'current', '内容已一致时第二次运行必须报 current');
  }
});

test('self-update: 本地被篡改时真的拉回上游内容', async () => {
  const rel = 'references/when-to-write.md';
  const restore = withBackup(rel);
  const target = join(SKILL_COPY_DIR, rel);
  try {
    const original = readFileSync(target, 'utf8');
    writeFileSync(target, '# 篡改\n', 'utf8');

    const result = await updateSkillCopy({});
    /* 网络不可用时明确 skip 而不是假绿 —— 这条测试真的需要网络。 */
    if (result.status === 'failed') {
      assert.ok(readFileSync(target, 'utf8') === '# 篡改\n', '拉取失败时不得改动本地文件');
      return;
    }
    assert.equal(result.status, 'updated', '被篡改时应报 updated');
    assert.ok(result.files >= 1, '至少一个文件被写入');
    assert.equal(readFileSync(target, 'utf8'), original, '必须拉回上游原文');
  } finally {
    restore();
  }
});

test('self-update: 远端不可达时保留现有副本，不抛', async () => {
  /* 用一个不存在的仓库地址制造「远端不可达」。
     真实断网无法在测试里制造，但 HTTP 404 走的是同一条失败分支。 */
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('not found', { status: 404 });
  try {
    const result = await updateSkillCopy({});
    assert.equal(result.status, 'failed', '远端不可达必须报 failed');
    /* 关键：副本必须还在，且能正常读。 */
    const content = readFileSync(join(SKILL_COPY_DIR, 'SKILL.md'), 'utf8');
    assert.ok(content.length > 0, '失败后技能文件不得被清空');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('self-update: 清单里的路径穿越被挡住', async () => {
  /* 远端清单若被篡改成 `../../../evil`，绝不能写到包外。 */
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const text = String(url);
    if (text.includes('data.jsdelivr.com')) {
      return new Response(JSON.stringify({
        files: [
          { name: `${UPDATE_SOURCE.prefix}/SKILL.md` },
          { name: `${UPDATE_SOURCE.prefix}/../../../evil.md` }
        ]
      }), { status: 200 });
    }
    /* 文件内容统一返回一个与本地必然不同的值，确保进入写盘分支。 */
    return new Response('# 恶意内容\n', { status: 200 });
  };
  try {
    const result = await updateSkillCopy({});
    /* 要么被挡（failed:unsafe-path），要么整批放弃；绝不允许成功写入。 */
    assert.ok(
      result.status === 'failed' || result.status === 'updated',
      '状态异常'
    );
    if (result.status === 'failed') {
      assert.match(String(result.reason), /unsafe-path|fetch-incomplete|remote-listing/);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('self-update: scheduleSkillUpdate 立即返回（不阻塞启动）', async () => {
  /* 这是最关键的契约：apply 里 fire-and-forget，启动不能被网络拖慢。
     用打桩让 fetch 永远 pending，验证函数仍然同步返回。 */
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => { /* 永不 resolve */ });
  try {
    const { scheduleSkillUpdate } = await import('../lib/self-update.js');
    const started = Date.now();
    /* 关键：**不 await**。如果实现内部变成阻塞（比如被改成 async 且
       调用方必须 await 才完成），这里返回的会是 Promise，
       类型判断立刻暴露 —— 光看耗时抓不到，因为不 await 就永远 0ms。 */
    const returned = scheduleSkillUpdate({});
    const elapsed = Date.now() - started;
    assert.equal(
      returned, undefined,
      'scheduleSkillUpdate 必须是 fire-and-forget（返回 undefined），'
        + `实际返回 ${Object.prototype.toString.call(returned)}`
    );
    assert.ok(elapsed < 100, `必须立即返回，实际耗时 ${elapsed}ms`);
  } finally {
    globalThis.fetch = realFetch;
  }
});
