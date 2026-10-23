/**
 * 「检查模式零写入」的**机制化**验证。
 *
 * 2026-10-19 那篇同步笔记里留过一条自己写下的上限：
 *
 *   「`--check` 的「零写入」目前靠**分支顺序**与**新加的条件判断**共同保证，
 *     没有机制化的验证。若将来有人在 `--check` 路径里插入写盘，现有测试抓不到。」
 *
 * 这里把它变成可验的属性：写盘函数默认被闸门关着，只有被 `withWrites()` 包住
 * 才允许落盘。于是「在零写入路径上插一笔写盘」不是静默成功，而是**抛错**。
 *
 * 为什么不直接跑 `node tools/sync-upstream.mjs --check` 再比文件哈希：
 *   `--check` 要 `git ls-remote` 并下载上游原始文件（真网络）。把它塞进
 *   `npm test` 会让本地门禁依赖外网，断网时那条用例只能变成「不可判定」——
 *   比没有更糟（要么假绿、要么假红）。所以验的是**生产代码里的同一个函数**：
 *   `writeManifest` 就是 `--check` 路径之外那段真会落盘的代码，不是替身。
 *
 * 这条验证的边界（写清楚，不含糊）：它证明「闸门默认关闭、被拦下时不落盘、
 * 窗口外重新关闭」，**不**证明「上游真漂移时 `--check` 全流程零写入」——
 * 后者需要一次真同步，属人工/联网验证，见决策笔记的 Verification 一节。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { withWrites, writeManifest } from './sync-upstream.mjs';

const CLI = fileURLToPath(new URL('./sync-upstream.mjs', import.meta.url));

/**
 * 跑一次真实 CLI（不是 import 后调函数）。
 *
 * @param {string[]} argv 参数。
 * @returns {{status: number|null, out: string}} 退出码与合并输出。
 */
function runCli(argv) {
  const result = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const MANIFEST_FILE = fileURLToPath(new URL('./upstream-manifest.json', import.meta.url));
const UPSTREAM_FILE = fileURLToPath(new URL('../upstream.json', import.meta.url));

test('sync-upstream: 闸门关着时写 manifest 必须抛错（默认拒绝，不是默认放行）', () => {
  assert.throws(
    () => writeManifest({ files: {} }, 'refs/heads/main'),
    /零写入模式/,
    '没有 withWrites() 包裹时必须抛错 —— 否则「--check 悄悄写盘」没有任何信号'
  );
});

test('sync-upstream: 被拦下时磁盘上的 manifest 与 upstream.json 逐字不变（先拦后写）', () => {
  const beforeManifest = readFileSync(MANIFEST_FILE, 'utf8');
  const beforeUpstream = readFileSync(UPSTREAM_FILE, 'utf8');
  assert.throws(() => writeManifest({ files: { 'x.md': 'sha256:00' } }, 'refs/heads/mutant'), /零写入模式/);
  assert.equal(readFileSync(MANIFEST_FILE, 'utf8'), beforeManifest, 'manifest 必须逐字不变');
  assert.equal(readFileSync(UPSTREAM_FILE, 'utf8'), beforeUpstream, 'upstream.json 必须逐字不变');
});

test('sync-upstream: withWrites 透出返回值、异常照常冒泡，且退出后闸门立刻关回', () => {
  assert.equal(withWrites('取返回值', () => 42), 42, '返回值必须原样透出');

  assert.throws(
    () => withWrites('抛异常', () => {
      throw new Error('boom');
    }),
    /boom/,
    'withWrites 不许吞掉 fn 的异常（否则写盘失败会被当成成功）'
  );

  /* 关键：走的是**异常路径**，闸门仍必须关回去 —— 靠 finally，不靠「正常
     路径记得关」。少了 finally，一次写盘失败就会让闸门永久开着。 */
  assert.throws(
    () => writeManifest({ files: {} }, 'refs/heads/main'),
    /零写入模式/,
    '异常之后闸门必须仍是关的'
  );
});

/* ── 下面两条补的是**另一条自己写下的上限** ─────────────────────────────
   2026-10-19 那篇笔记：「给脚本加「仅直接执行」守卫引入了新的风险面 —— 若守卫
   判定写错，脚本会什么都不做并静默退出 0。已通过实测三个 CLI 入口来覆盖，
   但那是手工的，不在 `npm test` 里。」
   守卫写错的症状与「零写入」同一类：**静默、无信号**。所以这两条不再手工。 */

test('sync-upstream CLI: --help 必须真的执行到（守卫写错会静默 exit 0 且什么都不打印）', () => {
  const { status, out } = runCli(['--help']);
  assert.equal(status, 0, `--help 应 exit 0，实际 ${status}；输出：${out}`);
  assert.match(out, /用法:/, '--help 必须打印用法 —— 没有输出说明「仅直接执行」守卫判定写错，脚本什么都没做');
  assert.match(out, /--check/, '用法里必须列出 --check（零写入那条）');
});

test('sync-upstream CLI: 参数错误必须走到主流程并判红（证明守卫没把一切都吞掉）', () => {
  const { status, out } = runCli(['--branch']);
  assert.notEqual(status, 0, '--branch 缺值必须非零退出，不许静默成功');
  assert.match(out, /--branch 需要一个值/, `错误说明必须点出缺的是哪个值；实际输出：${out}`);
});
