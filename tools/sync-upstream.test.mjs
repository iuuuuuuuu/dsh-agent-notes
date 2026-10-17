/**
 * 上游合并工具的行为测试。
 *
 * 重点不在于「能跑」，而在于**枚举失败必须报错、不能伪装成无需合并**
 * （这条曾经真的踩过：清单解析失败时静默返回空，工具报告「一致」）。
 * 另外验证 --check 零写入、上传清单可解析。
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(PACKAGE_ROOT, 'tools', 'sync-upstream.mjs');
const NODE = process.execPath;

/**
 * 跑 sync-upstream 并返回结果。
 *
 * @param {string[]} args 参数。
 * @returns {{ code: number, out: string }} 退出码与合并输出。
 */
function runSync(args) {
  const result = spawnSync(NODE, [SCRIPT, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

test('同步清单确实存在且覆盖全部上游文件', { timeout: 180_000 }, () => {
  const { code, out } = runSync(['--check']);
  assert.equal(code, 0, `--check 在上游一致时应 exit 0，实际 ${code}\n${out}`);
  assert.match(out, /相同\s*21/, `应核对到 21 个文件，实际输出:\n${out}`);
  assert.doesNotMatch(out, /只枚举到|找不到目录/, '不应出现枚举失败');
});

test('枚举失败必须报错，不得伪装成「无需合并」', { timeout: 120_000 }, () => {
  // 用一个不存在的 ref，任何清单请求都会失败；工具必须非零退出并说明原因。
  const { code, out } = runSync(['--check', '--ref', 'refs-does-not-exist-zzz']);
  assert.notEqual(code, 0, '清单拉取失败时必须以非零退出');
  assert.match(out, /失败|找不到目录|枚举/, `必须给出可读原因，实际:\n${out}`);
  assert.doesNotMatch(out, /无需合并/, '失败时绝不能报告「无需合并」');
});

test('--check 不写任何文件', { timeout: 180_000 }, () => {
  const manifest = join(PACKAGE_ROOT, 'tools', 'upstream-manifest.json');
  const before = existsSync(manifest) ? readFileSync(manifest, 'utf8') : undefined;
  const { code } = runSync(['--check']);
  const after = existsSync(manifest) ? readFileSync(manifest, 'utf8') : undefined;
  assert.equal(code, 0);
  assert.equal(after, before, '--check 不得改动 manifest');
});

test('上游清单与元数据可解析且记录了 ref', () => {
  const manifestFile = join(PACKAGE_ROOT, 'tools', 'upstream-manifest.json');
  const upstreamFile = join(PACKAGE_ROOT, 'upstream.json');
  assert.equal(existsSync(manifestFile), true, '应有 tools/upstream-manifest.json');
  assert.equal(existsSync(upstreamFile), true, '应有 upstream.json');

  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(typeof manifest.ref, 'string');
  assert.ok(Object.keys(manifest.files).length >= 20, `摘要应覆盖 >= 20 个文件，实际 ${Object.keys(manifest.files).length}`);
  for (const [path, digest] of Object.entries(manifest.files)) {
    assert.match(digest, /^sha256:[0-9a-f]{64}$/, `${path} 的摘要格式不对`);
  }

  const upstream = JSON.parse(readFileSync(upstreamFile, 'utf8'));
  assert.match(upstream.repository, /write-notes-like-deepseek/);
  assert.equal(typeof upstream.syncedAt, 'string');
});
