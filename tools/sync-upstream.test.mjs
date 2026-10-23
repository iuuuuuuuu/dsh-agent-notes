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

import { isEnvironmentUnavailable } from './sync-upstream.mjs';
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

/**
 * 断言 `--check` 通过，并在**环境不可用**时给出能指路的失败信息。
 *
 * ## 为什么不能简单 assert.equal(code, 0)
 *
 * `sync-upstream.mjs` 现在区分两种非零退出：
 *   - exit 1 = 检查失败（上游真有差异）
 *   - exit 2 = **无法进行**（网络不可用或被限流）
 *
 * 实测踩过：断网时旧实现返回 1，测试报
 * 「--check 在上游一致时应 exit 0，实际 1 / 合并失败: fetch failed」——
 * **断言在说契约被破坏，实际是网络不行**，那是误导性诊断。
 *
 * ## 为什么不用 test.skip()
 *
 * 跳过是**假绿的温床** —— 它会让「这条契约现在没人验」静悄悄过去。
 * 这里选择：仍然失败，但把失败信息说清楚。环境不可用不是通过。
 *
 * @param {number} code 退出码。
 * @param {string} out 输出。
 * @param {string} what 期望的契约描述。
 */
function assertCheckPassed(code, out, what) {
  if (code === 2) {
    assert.fail(
      '**环境不可用**，不是契约被破坏 —— 上面的 exit 2 表示网络不可用或被限流，'
      + '这次检查压根没做成。\n'
      + '（这是真实结论：本次运行没有验证「' + what + '」这条契约。）\n'
      + '原始输出:\n' + out
    );
  }
  assert.equal(code, 0, what + ' 应 exit 0，实际 ' + code + '\n' + out);
}

test('退出码必须区分「环境不可用」(2) 与「检查失败」(1)', () => {
  /* 实测踩过：断网时旧实现返回 1，与「上游真有差异」无法区分。于是测试报
     「--check 在上游一致时应 exit 0，实际 1 / 合并失败: fetch failed」——
     **断言在说契约被破坏，实际是网络不行**。

     修法是 isEnvironmentUnavailable() 把网络类错误映射到 exit 2。
     这里验那个判定函数，不真去断网 —— 真断网会让测试依赖环境，
     而且本地未必能断得掉。 */

  /* 网络类：必须判为「环境不可用」。 */
  const envErrors = [
    new TypeError('fetch failed'),
    new Error('getaddrinfo ENOTFOUND github.com'),
    new Error('request timed out ETIMEDOUT'),
    new Error('connect ECONNREFUSED'),
    new Error('unable to verify the first certificate'),
    new Error('rate limit exceeded (429)'),
    Object.assign(new Error('fetch failed'), { cause: { code: 'ENETUNREACH' } })
  ];
  for (const error of envErrors) {
    assert.equal(
      isEnvironmentUnavailable(error), true,
      '「' + (error.message ?? '') + '」应判为环境不可用'
    );
  }

  /* 检查失败类：必须留在 exit 1。 */
  const checkErrors = [
    new Error('404 Not Found'),
    new Error('ref refs-does-not-exist-zzz 不存在'),
    new Error('合并冲突：3 个文件')
  ];
  for (const error of checkErrors) {
    assert.equal(
      isEnvironmentUnavailable(error), false,
      '「' + (error.message ?? '') + '」是有效检查结果，不该判为环境问题'
    );
  }
});

test('同步清单确实存在且覆盖全部上游文件', { timeout: 180_000 }, () => {
  const { code, out } = runSync(['--check']);
  assertCheckPassed(code, out, '--check 在上游一致时');
  assert.match(out, /相同\s*21/, `应核对到 21 个文件，实际输出:\n${out}`);
  assert.doesNotMatch(out, /只枚举到|找不到目录/, '不应出现枚举失败');
});

test('枚举失败必须报错，不得伪装成「无需合并」', { timeout: 120_000 }, () => {
  // 用一个不存在的 ref，任何清单请求都会失败；工具必须非零退出并说明原因。
  // 失败原因有两种**都合法**：HTTP 4xx（ref/契约问题，exit 1）与网络不可达
  // （环境问题，exit 2）。断言同时接受两种，只拒绝「把失败说成没问题」——
  // 原来只匹配 /失败|找不到目录|枚举/，断网时这条会红而工具行为是对的（假红）。
  // 断网那次是实测踩到的：把 HTTPS_PROXY 指向死端口即可复现。
  const { code, out } = runSync(['--check', '--ref', 'refs-does-not-exist-zzz']);
  assert.ok(code === 1 || code === 2, `失败时必须按约定退 1 或 2，实际 ${code}`);
  /* 只认两种**具体原因句**，不认「失败」这种宽词：把枚举失败改成静默返回空之后，
     工具会换一句「上游 …assets 为空」的失败信息（exit 1、也带 ref），宽词照样匹配 ——
     实测过，宽词版本对这个变异 5/5 全绿，等于没测。 */
  assert.match(out, /清单拉取失败|无法校验上游/, `必须报出失败的具体原因，实际:\n${out}`);
  assert.match(out, /refs-does-not-exist-zzz/, `失败原因要能定位到那次请求，实际:\n${out}`);
  assert.doesNotMatch(out, /无需合并|已是最新|一致，无漂移/, '失败时绝不能报告「无需合并」');
});

test('--check 不写任何文件', { timeout: 180_000 }, () => {
  const manifest = join(PACKAGE_ROOT, 'tools', 'upstream-manifest.json');
  const before = existsSync(manifest) ? readFileSync(manifest, 'utf8') : undefined;
  const { code, out } = runSync(['--check']);
  const after = existsSync(manifest) ? readFileSync(manifest, 'utf8') : undefined;
  assertCheckPassed(code, out, '--check 不得改动 manifest');
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
