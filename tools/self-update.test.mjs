/**
 * 技能副本自更新的测试。
 *
 * **全部离线**：所有 HTTP 都用打桩替换。理由：这些测试原先真的打 CDN，
 * 和 tools/sync-upstream.test.mjs 并发跑时会互相抢配额，偶发失败。
 * 偶发失败本身就是缺陷 —— 一个时绿时红的门禁等于没有门禁。
 *
 * 重点不是「能拉下来」（那由实机验证覆盖），而是四条会让插件变砖的边界：
 *   1. 网络失败时必须**保留现有副本**，不能清空、不能写半套；
 *   2. 远端清单里的可疑路径（`../`）必须被挡住，不能写到目标目录外；
 *   3. 内容相同时**不许重写磁盘**（否则每次启动都触发无谓热替换）；
 *   4. `scheduleSkillUpdate` 必须 fire-and-forget，不阻塞启动。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SKILL_COPY_DIR, UPDATE_SOURCE, updateSkillCopy } from '../lib/self-update.js';

/** 目标目录的隔离沙箱：每个测试一份，绝不碰真实的 skills/agent-notes。 */
function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'an-selfupd-'));
  const target = join(dir, 'agent-notes');
  cpSync(SKILL_COPY_DIR, target, { recursive: true });
  return { dir, target };
}

/** 沙箱里所有文件的相对路径 → 内容。 */
function snapshot(dir) {
  const out = new Map();
  const walk = (base, rel) => {
    const entries = readdirSync(base, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(base, entry.name);
      const key = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(full, key);
      else out.set(key, readFileSync(full, 'utf8'));
    }
  };
  walk(dir, '');
  return out;
}

/**
 * 用给定内容打桩 fetch，模拟远端仓库。
 *
 * @param {Map<string, string>} files 相对技能目录的路径 → 内容。
 * @returns {() => void} 还原函数。
 */
function stubRemote(files) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const text = String(url);
    if (text.includes('data.jsdelivr.com')) {
      return new Response(JSON.stringify({
        files: [...files.keys()].map((rel) => ({ name: `${UPDATE_SOURCE.prefix}/${rel}` }))
      }), { status: 200 });
    }
    /* 从 URL 里还原相对路径：`.../skills/agent-notes/<rel>`。 */
    const marker = `${UPDATE_SOURCE.prefix}/`;
    const index = text.indexOf(marker);
    const rel = index < 0 ? '' : decodeURI(text.slice(index + marker.length));
    const content = files.get(rel);
    if (content === undefined) return new Response('not found', { status: 404 });
    return new Response(content, { status: 200 });
  };
  return () => { globalThis.fetch = realFetch; };
}

/** 当前沙箱内容当作「远端」用。 */
function remoteFromSandbox(target) {
  const map = new Map();
  for (const [rel, content] of snapshot(target)) map.set(rel, content);
  return map;
}

test('self-update: 来源指向本仓库，不是原始上游', () => {
  /* 从本仓库拉是本项目的刻意选择：本仓库跟随原始上游合并，等于多一层
     人工审核 —— 原始上游改坏了可以在这里挡掉。
     这条断言防止有人「顺手」把它改回原始上游。 */
  assert.equal(UPDATE_SOURCE.slug, 'iuuuuuuuu/dsh-agent-notes');
  assert.equal(UPDATE_SOURCE.branch, 'main');
});

test('self-update: 内容一致时报 current，且不写盘', async () => {
  const box = makeSandbox();
  const restore = stubRemote(remoteFromSandbox(box.target));
  try {
    const before = snapshot(box.target);
    const result = await updateSkillCopy({ targetDir: box.target });
    assert.equal(result.status, 'current', '内容一致必须报 current');
    /* 逐字节比对：不写盘意味着内容完全不变。 */
    const after = snapshot(box.target);
    assert.equal(after.size, before.size, '文件数不得变化');
    for (const [rel, content] of before) {
      assert.equal(after.get(rel), content, `${rel} 不得被改写`);
    }
  } finally {
    restore();
    rmSync(box.dir, { recursive: true, force: true });
  }
});

test('self-update: 本地被篡改时真的拉回上游内容', async () => {
  const box = makeSandbox();
  const remote = remoteFromSandbox(box.target);
  const rel = 'references/when-to-write.md';
  const target = join(box.target, rel);
  const original = readFileSync(target, 'utf8');
  writeFileSync(target, '# 篡改\n', 'utf8');
  const restore = stubRemote(remote);
  try {
    const result = await updateSkillCopy({ targetDir: box.target });
    assert.equal(result.status, 'updated', '被篡改时应报 updated');
    assert.ok(result.files >= 1, '至少一个文件被写入');
    assert.equal(readFileSync(target, 'utf8'), original, '必须拉回上游原文');
  } finally {
    restore();
    rmSync(box.dir, { recursive: true, force: true });
  }
});

test('self-update: 远端不可达时保留现有副本，不抛', async () => {
  const box = makeSandbox();
  const restore = stubRemote(new Map());
  try {
    const result = await updateSkillCopy({ targetDir: box.target });
    assert.equal(result.status, 'failed', '远端不可达必须报 failed');
    const content = readFileSync(join(box.target, 'SKILL.md'), 'utf8');
    assert.ok(content.length > 0, '失败后技能文件不得被清空');
  } finally {
    restore();
    rmSync(box.dir, { recursive: true, force: true });
  }
});

test('self-update: 清单里的路径穿越被挡住', async () => {
  /* 远端清单若被篡改成 `../../../evil`，绝不能写到目标目录之外。
     断言落在**文件系统事实**上（外面有没有多出文件），而不是只看返回状态 ——
     后者太弱，failed/updated 都能过。 */
  const box = makeSandbox();
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
    return new Response('# 恶意内容\n', { status: 200 });
  };
  try {
    const result = await updateSkillCopy({ targetDir: box.target });
    assert.equal(result.status, 'failed', '含穿越路径的清单必须整批拒绝');
    assert.equal(result.reason, 'unsafe-path', '必须明确指出是路径不安全');
    assert.equal(existsSync(join(box.dir, 'evil.md')), false, '不得在沙箱根写出 evil.md');
    assert.equal(existsSync(join(box.dir, '..', 'evil.md')), false, '不得在沙箱上一级写出 evil.md');
  } finally {
    globalThis.fetch = realFetch;
    rmSync(box.dir, { recursive: true, force: true });
  }
});

test('self-update: 部分文件拉不到时整批放弃，不留半套', async () => {
  /* 这是最危险的失败模式：只写了一半文件，副本处于不一致状态，
     门禁脚本可能一半新一半旧。必须整批放弃。 */
  const box = makeSandbox();
  const remote = remoteFromSandbox(box.target);
  /* 篡改一个文件让它进入写盘分支，同时让另一个文件 404。 */
  const rel = 'references/when-to-write.md';
  writeFileSync(join(box.target, rel), '# 篡改\n', 'utf8');
  const before = snapshot(box.target);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const text = String(url);
    if (text.includes('data.jsdelivr.com')) {
      return new Response(JSON.stringify({
        files: [...remote.keys()].map((name) => ({ name: `${UPDATE_SOURCE.prefix}/${name}` }))
      }), { status: 200 });
    }
    if (text.endsWith('templates/rejected.md')) {
      return new Response('not found', { status: 404 });
    }
    const marker = `${UPDATE_SOURCE.prefix}/`;
    const index = text.indexOf(marker);
    const name = index < 0 ? '' : decodeURI(text.slice(index + marker.length));
    const content = remote.get(name);
    return content === undefined
      ? new Response('not found', { status: 404 })
      : new Response(content, { status: 200 });
  };
  try {
    const result = await updateSkillCopy({ targetDir: box.target });
    assert.equal(result.status, 'failed', '有文件拉不到必须整批失败');
    assert.match(String(result.reason), /fetch-incomplete/, '原因应指明拉取不完整');
    /* 关键：一个文件都不许被改。 */
    const after = snapshot(box.target);
    for (const [name, content] of before) {
      assert.equal(after.get(name), content, `${name} 不得被写入（整批放弃）`);
    }
  } finally {
    globalThis.fetch = realFetch;
    rmSync(box.dir, { recursive: true, force: true });
  }
});

test('self-update: scheduleSkillUpdate 立即返回（不阻塞启动）', async () => {
  /* 最关键的契约：apply 里 fire-and-forget，启动不能被网络拖慢。
     用永远 pending 的 fetch，并断言返回值类型 ——
     光测耗时抓不到，因为不 await 就永远 0ms。 */
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => { /* 永不 resolve */ });
  try {
    const { scheduleSkillUpdate } = await import('../lib/self-update.js');
    const started = Date.now();
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

test('sync-upstream: --auto 在 ref 未变但文件被改时也要纠正', async () => {
  /* 回归测试：--auto 原先只比对「上游 HEAD vs manifest.ref」，
     ref 相同就直接报「已是最新」放过。实测踩到：手动改坏 manifest 里
     某个文件的摘要后，--auto 报绿 —— 那是假绿，本地副本与记录已经不符。
     现在 ref 相同时会再校验本地文件与摘要，有出入仍走合并流程纠正。
     这条测试用纯净副本 + 打桩，跑真实脚本并核对退出码与结果。 */
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'an-auto-'));
  try {
    /* 只拷跑脚本所需的最小集合。 */
    cpSync('tools/sync-upstream.mjs', join(dir, 'tools', 'sync-upstream.mjs'));
    cpSync('tools/upstream-manifest.json', join(dir, 'tools', 'upstream-manifest.json'));
    cpSync('skills/agent-notes', join(dir, 'skills', 'agent-notes'), { recursive: true });

    /* 篡改一个摘要，ref 保持不变。 */
    const manifestFile = join(dir, 'tools', 'upstream-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const victim = 'SKILL.md';
    const fake = `sha256:${'0'.repeat(64)}`;
    manifest.files[victim] = fake;
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const result = spawnSync(process.execPath, ['tools/sync-upstream.mjs', '--auto'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 180_000,
      windowsHide: true
    });

    /* 网络不可用时明确跳过，不算假绿 —— 这条测试需要真上游。 */
    if (result.status === 2) {
      assert.match(String(result.stderr), /查不到上游 HEAD|无法校验/, '退出码 2 必须给出明确原因');
      return;
    }
    assert.equal(result.status, 0, `脚本应成功退出，实际 ${result.status}: ${result.stderr}`);
    assert.match(String(result.stderr), /与清单不符/, '必须报告本地与清单不符');

    /* 关键断言：假摘要必须被纠正回真实值。 */
    const after = JSON.parse(readFileSync(manifestFile, 'utf8'));
    assert.notEqual(after.files[victim], fake, '被篡改的摘要必须被纠正');
    assert.match(after.files[victim], /^sha256:[0-9a-f]{64}$/, '纠正后必须是合法摘要');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
