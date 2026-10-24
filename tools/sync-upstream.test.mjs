/**
 * 上游合并工具的行为测试。
 *
 * 重点不在于「能跑」，而在于**枚举失败必须报错、不能伪装成无需合并**
 * （这条曾经真的踩过：清单解析失败时静默返回空，工具报告「一致」）。
 * 另外验证 --check 零写入、上传清单可解析。
 */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { isEnvironmentUnavailable, retryTransport, classifyFailure, httpStatusError } from './sync-upstream.mjs';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** 快照时跳过的目录：`.git` 与依赖目录不是仓库内容，`.probe` 是探针自己的地盘。 */
const SNAPSHOT_SKIP = new Set(['.git', 'node_modules', '.probe']);

/**
 * 拦截脚本源码：**只替换 `globalThis.fetch`**（外部依赖那一层），
 * 被测逻辑（分类、计数、退出码、写盘闸门）全部真跑。
 *
 * ## 为什么必须拦在 fetch 这一层，而不是去 mock 被测函数
 *
 * 本仓库的纪律是门禁必须驱动真实路径。这里的边界很清楚：`fetch` 是**外部依赖**，
 * jsDelivr 的 503 / 全 404 / 半途断流没法在测试里真实复现（那是 CDN 的行为），
 * 所以把这一层换掉是唯一可行的办法 —— 而换掉之后，从 `classifyFailure`
 * 到 `process.exitCode` 的每一行都仍是生产代码。
 *
 * 清单端点的 JSON 由**本地真实清单**（`tools/upstream-manifest.json`）构造，
 * 保证 `collectPaths()` 枚举出的路径数与真实运行一致（脚本有
 * `paths.length < 10` 的兜底，凭空的形状会让测试在错误的点上失败）。
 * 每次请求往 stderr 打一行 `INTERCEPT-CALL`，用于数「到底请求了几次」——
 * 「5xx 有没有重试」这种断言只能靠计数，改判据而没重试时消息是一样的。
 */
const INTERCEPT_SOURCE = `
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MODE = process.env.INTERCEPT_MODE ?? '503';
const manifestPath = resolve(process.env.INTERCEPT_MANIFEST);
const rels = Object.keys(JSON.parse(readFileSync(manifestPath, 'utf8')).files ?? {});

/* 按 jsDelivr packages 端点的形状造目录树。 */
const root = { type: 'gh', name: 'gh', files: [] };
for (const rel of rels) {
  const segs = ['skills', 'write-notes-like-deepseek', ...rel.split('/')];
  let cursor = root.files;
  for (let index = 0; index < segs.length; index += 1) {
    const leaf = index === segs.length - 1;
    let node = cursor.find((entry) => entry.name === segs[index]
      && (leaf ? entry.type === 'file' : entry.type === 'directory'));
    if (node === undefined) {
      node = leaf
        ? { type: 'file', name: segs[index] }
        : { type: 'directory', name: segs[index], files: [] };
      cursor.push(node);
    }
    if (!leaf) cursor = node.files;
  }
}

let call = 0;
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  call += 1;
  process.stderr.write('INTERCEPT-CALL #' + call + ' ' + url + '\\n');

  if (url.includes('data.jsdelivr.com')) {
    return new Response(JSON.stringify(root), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }

  if (MODE === 'socket') {
    const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    throw new TypeError('terminated', { cause });
  }
  if (MODE === 'all404') return new Response('not found', { status: 404 });
  return new Response('service unavailable', { status: 503 });
};
`;

/**
 * 当前上游清单里的文件条目数。
 *
 * **不要在这个文件里写死 21**：`tools/upstream-manifest.json` 会随上游增删文件而变，
 * 而 `upstream-sync.yml` 的 `--auto` 路径**会改写它**。写死数字的后果是：
 * 上游加一个文件，这些断言就变红 —— 红的原因是「用例写死了数字」而不是门禁坏了，
 * 正是本 PR 要消灭的那种假红。断言的真实意图是「请求数/基线条数 = 清单条目数」。
 *
 * @returns {number} 条目数。
 */
function manifestEntryCount() {
  const file = join(PACKAGE_ROOT, 'tools', 'upstream-manifest.json');
  return Object.keys(JSON.parse(readFileSync(file, 'utf8')).files ?? {}).length;
}

/**
 * 起一次「网络边界被拦住」的真实 CLI 运行。
 *
 * @param {'503' | 'all404' | 'socket'} mode 拦截模式。
 * @param {string[]} [args] CLI 参数。
 * @param {{ sandbox?: boolean }} [options] `sandbox=true` 时在**仓库的隔离副本**里跑
 *   （脚本 + 两份数据文件都是副本）—— 凡是要走写盘路径的用例都必须用它。
 * @returns {{ code: number, out: string, fileCalls: number, manifestCalls: number, sandboxRoot?: string, manifestPath: string }} 结果与请求计数。
 */
function runSyncIntercepted(mode, args = ['--check'], options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-intercept-'));
  let root = PACKAGE_ROOT;
  let script = SCRIPT;
  let manifestFile = join(PACKAGE_ROOT, 'tools', 'upstream-manifest.json');
  try {
    if (options.sandbox === true) {
      /* ★ 隔离副本。**凡是要走写盘路径的用例都必须这样跑**：
         `writeManifest` 的默认落点就是仓库里的两份数据文件，一旦被测的闸门
         自身被改坏（正是变异测试在做的事），对真仓库跑就等于把 21 条基线写没。
         这不是假设 —— 本轮初次写这条用例时就真把 `files` 从 21 条写成 0 条，
         只能从 HEAD 恢复。仓库里 `.agents/notes/implemented/bug-fix/
         2026-10-18-ci-vendored-tampered-by-tests.md` 早记过同一类事故。 */
      mkdirSync(join(dir, 'tools'), { recursive: true });
      copyFileSync(join(PACKAGE_ROOT, 'tools', 'sync-upstream.mjs'), join(dir, 'tools', 'sync-upstream.mjs'));
      copyFileSync(join(PACKAGE_ROOT, 'tools', 'upstream-manifest.json'), join(dir, 'tools', 'upstream-manifest.json'));
      copyFileSync(join(PACKAGE_ROOT, 'upstream.json'), join(dir, 'upstream.json'));
      root = dir;
      script = join(dir, 'tools', 'sync-upstream.mjs');
      manifestFile = join(dir, 'tools', 'upstream-manifest.json');
    }

    const preload = join(dir, 'intercept.mjs');
    writeFileSync(preload, INTERCEPT_SOURCE, 'utf8');
    const result = spawnSync(NODE, ['--import', pathToFileURL(preload).href, script, ...args], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      env: {
        ...process.env,
        INTERCEPT_MODE: mode,
        INTERCEPT_MANIFEST: manifestFile
      }
    });
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const lines = out.split('\n').filter((line) => line.includes('INTERCEPT-CALL'));
    return {
      code: result.status ?? -1,
      out,
      fileCalls: lines.filter((line) => line.includes('fastly.jsdelivr.net')).length,
      manifestCalls: lines.filter((line) => line.includes('data.jsdelivr.com')).length,
      sandboxRoot: options.sandbox === true ? root : undefined,
      manifestPath: manifestFile
    };
  } finally {
    /* 副本要留到断言之后才能删 —— 由调用方在 finally 里删，这里只清 preload 所在目录
       （sandbox 时 preload 与副本同目录，所以 sandbox 的清理交给调用方）。 */
    if (options.sandbox !== true) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 给整棵仓库做内容快照：相对路径 → 大小/mtime/内容摘要。
 *
 * ## 为什么不只盯着 manifest
 *
 * `--check` 的契约是**零写入**，但原来只有一句
 * `assert.equal(after, before)` 盯着 `tools/upstream-manifest.json` 一个文件。
 * 也就是说：`--check` 顺手写 vendored 技能、写 `upstream.json`、写临时状态文件，
 * 原来的用例**全都看不见** —— 而这条契约正是我在决策笔记里自己写下「没有机制化
 * 的验证，现有测试抓不到」的那一条。抓不到的原因不是没有断言，是**断言的范围太窄**。
 *
 * 摘要把 mtime 也算进去：写入相同字节仍然是写入（`--check` 不该碰盘）。
 * 只跳过三个目录，其余**全量**进快照，不做后缀过滤 —— 收窄语料是假绿的常见来源。
 *
 * @param {string} root 仓库根。
 * @returns {Record<string, string>} 相对路径（正斜杠）→ `size:mtimeMs:sha1`。
 */
function snapshotTree(root) {
  /** @type {Record<string, string>} */
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SNAPSHOT_SKIP.has(entry.name)) walk(rel);
        continue;
      }
      const abs = join(root, rel);
      const stat = statSync(abs);
      const digest = createHash('sha1').update(readFileSync(abs)).digest('hex');
      files[rel] = `${stat.size}:${Math.round(stat.mtimeMs)}:${digest}`;
    }
  };
  walk('');
  return files;
}

/**
 * 比较两份快照，返回人类可读的差异行（新增/消失/内容或 mtime 变化）。
 *
 * @param {Record<string, string>} before 前。
 * @param {Record<string, string>} after 后。
 * @returns {string[]} 差异行；空数组表示一致。
 */
function diffSnapshots(before, after) {
  const lines = [];
  for (const path of Object.keys(after)) {
    if (!(path in before)) lines.push(`新增 ${path}`);
    else if (before[path] !== after[path]) lines.push(`变化 ${path}（${before[path]} → ${after[path]}）`);
  }
  for (const path of Object.keys(before)) {
    if (!(path in after)) lines.push(`消失 ${path}`);
  }
  return lines;
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
    Object.assign(new Error('fetch failed'), { cause: { code: 'ENETUNREACH' } }),
    /* 断流族：措辞各不相同，语义都是「请求没做完」。 */
    Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' } }),
    new TypeError('terminated'),
    new Error('socket hang up'),
    new Error('read ECONNRESET'),
    Object.assign(new Error('operation aborted'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }),
    Object.assign(new Error('operation aborted'), { cause: { code: 'UND_ERR_BODY_TIMEOUT' } })
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

test('真实断流：对端读到一半掐断连接，必须判为环境不可用（不是契约破坏）', async () => {
  /* 2026-10-24 实测踩到的漏判：`--check` 报
     「合并失败: terminated」并退 1 —— 而 1 的语义是「上游真有差异」，
     实际是 CDN 把连接掐了，检查压根没做完。
     上面那条表驱动用例覆盖不到它，因为**当时谁也不知道真实错误长什么样**：
     undici 的 shape 是 TypeError('terminated') + cause.code='UND_ERR_SOCKET'。
     所以这里不用手搓错误对象，而是起一个真服务器、真的把 socket 打掉，
     拿到的就是生产环境那个错误。手搓的壳子只能证明「我以为的形状」。 */
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '4096' });
    res.write('partial body');
    setTimeout(() => res.socket.destroy(), 20);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    let caught;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/partial`);
      await response.text();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught !== undefined, '服务器提前掐断连接时 fetch 必须抛错，否则这个用例什么也没验');
    assert.equal(caught.message, 'terminated', `真实错误形状变了，先核对再更新判据（实际: ${caught.message}）`);
    assert.equal(
      isEnvironmentUnavailable(caught), true,
      '断流属于「检查没做完」，必须退 2；退回 1 会把网络问题报成「上游有差异」'
    );
  } finally {
    server.close();
  }
});

test('对照：真实 404 必须留在「检查失败」，别被断流判据一起吞掉', async () => {
  /* 另一半风险：为了让断流退 2，把判据放宽到「任何 fetch 异常」，
     就会连「上游路径真的没了」也报成环境问题 —— 那反而放过了真差异。
     这里用真服务器返回 404，走的是脚本里同一条 `!response.ok` 分支。 */
  const server = createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/missing`);
    assert.equal(response.ok, false);
    /* 与 fetchUpstream 自造的错误同形（那里的 message 就是 `拉取失败 404: <url>`）。 */
    const error = new Error(`拉取失败 ${response.status}: http://127.0.0.1:${port}/missing`);
    assert.equal(
      isEnvironmentUnavailable(error), false,
      '404 是有效检查结果（上游真的没有这个文件），必须留在 exit 1'
    );
  } finally {
    server.close();
  }
});

test('传输层失败会重试：真实套接字被打断两次后第三次成功', async () => {
  /* 2026-10-24 实测：`--check` 顺序取 21 个文件时，jsDelivr 偶发掐断连接
     （UND_ERR_SOCKET / fetch failed），5 轮里 2 轮失败；同一文件单请求 10/10 成功。
     也就是说这条校验会随机红 —— 假红和假绿一样要修。
     这里用真服务器，前两次真的把 socket 打掉，第三次正常返回，
     验的是重试逻辑本身，不是「我以为的错误对象」。 */
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    if (hits <= 2) {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1024' });
      res.write('partial');
      setTimeout(() => res.socket.destroy(), 10);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('recovered body');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const body = await retryTransport(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/flaky`);
      return await response.text();
    }, { attempts: 3, backoffMs: 5 });
    assert.equal(body, 'recovered body', '第三次应拿到完整响应');
    assert.equal(hits, 3, `应正好尝试 3 次，实际 ${hits} 次`);
  } finally {
    server.close();
  }
});

test('重试用尽后仍抛原错误，且仍判为环境不可用（不许变成「检查失败」）', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '4096' });
    res.write('partial');
    setTimeout(() => res.socket.destroy(), 10);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    let attempts = 0;
    await assert.rejects(
      retryTransport(async () => {
        attempts += 1;
        const response = await fetch(`http://127.0.0.1:${port}/always-broken`);
        return await response.text();
      }, { attempts: 3, backoffMs: 5 }),
      (error) => {
        assert.equal(isEnvironmentUnavailable(error), true, '重试失败仍属环境问题，必须退 2');
        return true;
      }
    );
    assert.equal(attempts, 3, `应尝试 3 次，实际 ${attempts} 次`);
  } finally {
    server.close();
  }
});

test('HTTP 状态码失败不重试：404 是明确回答，不是抖动', async () => {
  let attempts = 0;
  await assert.rejects(
    retryTransport(async () => {
      attempts += 1;
      throw new Error('拉取失败 404: https://example.invalid/x');
    }, { attempts: 3, backoffMs: 5 }),
    /404/
  );
  assert.equal(attempts, 1, `非传输层错误只该试 1 次，实际 ${attempts} 次`);
});

test('口径表：认类别不认措辞 —— HTTP 状态、传输层、认不出来的各归其位', () => {
  /* 这张表是 2026-10-24 那次假红的直接对治。旧实现用
     `/\b(401|403|429)\b/` 匹配**消息里的数字**，5xx 整族因此落进
     「检查失败」(exit 1)，把「这次没做成校验」说成「上游有差异」。
     逐格钉住，免得日后又被改回穷举。 */
  const env = (error) => classifyFailure(error).area === 'environment';
  const retry = (error) => classifyFailure(error).retryable;

  /* 环境问题 + 可重试：5xx 与 408 是经典瞬态。 */
  for (const status of [500, 502, 503, 504, 408]) {
    const error = httpStatusError(status, 'file', `拉取失败 ${status}: http://x/y`);
    assert.equal(env(error), true, `${status} 属「这次没做成校验」，必须退 2`);
    assert.equal(retry(error), true, `${status} 是可重试瞬态`);
  }
  /* 环境问题但**不**重试：立刻重试只会加深限流。 */
  for (const status of [401, 403, 429]) {
    const error = httpStatusError(status, 'file', `拉取失败 ${status}: http://x/y`);
    assert.equal(env(error), true, `${status} 属环境问题`);
    assert.equal(retry(error), false, `${status} 不该重试（会加深限流）`);
  }
  /* 其余 4xx 也是「没做成」，但不是抖动，不重试。 */
  for (const status of [400, 405, 451]) {
    const error = httpStatusError(status, 'file', `拉取失败 ${status}: http://x/y`);
    assert.equal(env(error), true, `${status} 不是「上游内容变了」，退 2`);
    assert.equal(retry(error), false, `${status} 不重试`);
  }
  /* 唯一的例外：**清单端点**的 404 说明 ref 不存在，那是真差异。 */
  const missingRef = httpStatusError(404, 'manifest', '清单拉取失败 404: http://x/y');
  assert.equal(classifyFailure(missingRef).area, 'contract',
    '清单端点 404 = ref 不存在，是真差异，必须留在 exit 1 —— 全改 2 会掩盖它');
  assert.equal(retry(missingRef), false);
  /* 文件端点的 404 根本不会走到这里（fetchUpstream 返回 undefined，是有效结果）。 */
  assert.equal(env(httpStatusError(404, 'file', '拉取失败 404: http://x/y')), true,
    '文件端点 404 若真被抛出来，也属「没做成」；正常路径由 fetchUpstream 直接返回 undefined');

  /* 传输层族：前缀与 errno 码，不认措辞。 */
  for (const code of ['UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
    const error = Object.assign(new Error('x'), { cause: { code } });
    assert.equal(env(error), true, `${code} 属环境问题`);
    assert.equal(retry(error), true, `${code} 可重试`);
  }
  assert.equal(retry(new TypeError('terminated')), true, '没有 code 的 terminated 也应重试');
  assert.equal(retry(new Error('read ECONNRESET')), true, 'errno 措辞兜底');

  /* 认不出来时默认站在「真差异」一侧：认不出来不等于没问题。 */
  assert.equal(env(new Error('404 Not Found')), false, '认不出来的默认按真差异处理');
});

test('5xx 是环境问题**且会被重试**：真跑 CLI + 拦网络边界，靠请求计数判定', () => {
  /* 消息断言证明不了重试 —— 不重试时消息一模一样。所以必须数请求次数。
     期望：清单 4 次（collectPaths 每个目录一次）+ 文件端点 3 次（retryTransport 的 3 次尝试）。 */
  const r = runSyncIntercepted('503');
  assert.equal(r.code, 2, `5xx 必须退 2（无法进行），实际 ${r.code}：\n${r.out}`);
  assert.match(r.out, /无法校验上游/, `必须说「无法校验」而不是「合并失败」：\n${r.out}`);
  assert.match(r.out, /503/, '要指出真实状态码');
  assert.doesNotMatch(r.out, /合并失败/, '不得再报成「合并失败」（那是 exit 1 的措辞）');
  assert.equal(r.fileCalls, 3, `文件端点必须重试 3 次，实际 ${r.fileCalls} 次`);
});

test('全 404 不得报「一致」：必须判「没能完成校验」且零写入', () => {
  /* 这是本仓库最忌的「空集合当绿」：21 个文件全部取不到内容，
     旧实现打印「内置副本与上游一致，无需合并」并 exit 0，
     不带 --check 时还把 21 条基线写成 0 条。 */
  const manifest = join(PACKAGE_ROOT, 'tools', 'upstream-manifest.json');
  const before = readFileSync(manifest, 'utf8');
  const r = runSyncIntercepted('all404', ['--check']);
  const after = readFileSync(manifest, 'utf8');

  assert.equal(r.code, 2, `全 404 = 没做成校验，必须退 2，实际 ${r.code}：\n${r.out}`);
  assert.doesNotMatch(r.out, /内置副本与上游一致|无需合并|一致，无漂移/,
    `一个文件都没读到内容时绝不能报「一致」：\n${r.out}`);
  assert.match(r.out, /一个\*\*上游文件都没比对成|都没比对成/, '要说清缺口有多大');
  assert.equal(after, before, '--check 不得改动 manifest');
  assert.equal(r.fileCalls, manifestEntryCount(),
    `清单里的每个文件都要真请求过（说明是真枚举出来的），实际 ${r.fileCalls}`);
});

test('全 404 的**写盘路径**也不许写：零写入比写坏好', () => {
  /* 去掉 --check，走「合并」那条路。旧实现在这里把 manifest 写空，
     且不需要 --yes。判据是比对下限守卫在**写盘之前**抛出。

     ★ 这条用例必须在**隔离副本**里跑（`sandbox: true`）：它刻意触发写盘路径，
     而被测闸门一旦被改坏（变异测试干的正是这件事），对真仓库跑就会把
     21 条基线写成 0 条 —— 初次写这条用例时真的发生了，只能从 HEAD 恢复。
     隔离之后，「闸门坏了」表现为**用例变红**，而不是**仓库被写坏**。 */
  const real = join(PACKAGE_ROOT, 'tools', 'upstream-manifest.json');
  const realBefore = readFileSync(real, 'utf8');
  /* 条目数从清单读，不写死 21：上游增删文件时数字会变，写死会让用例因为
     「数字过时」而红 —— 那是假红，不是门禁坏了。 */
  const realEntryCount = Object.keys(JSON.parse(realBefore).files ?? {}).length;
  const r = runSyncIntercepted('all404', [], { sandbox: true }); // 既无 --check 也无 --yes
  try {
    assert.equal(r.code, 2, `必须退 2（无法进行），实际 ${r.code}：\n${r.out}`);
    assert.doesNotMatch(r.out, /内置副本与上游一致|无需合并/,
      `一个文件都没比对成时绝不能报「一致」：\n${r.out}`);
    assert.doesNotMatch(r.out, /已记录 tools\/upstream-manifest\.json/, '不得打印「已记录」');
    /* 副本里的基线必须一条不动。 */
    const sandboxManifest = JSON.parse(readFileSync(r.manifestPath, 'utf8'));
    assert.equal(Object.keys(sandboxManifest.files ?? {}).length, realEntryCount,
      '一个文件都没比对成时，基线必须一条不动 —— 写一份缩水的清单比不写更糟');
    /* 真仓库也必须没被动过（双保险：防止将来有人把 sandbox 去掉）。 */
    assert.equal(readFileSync(real, 'utf8'), realBefore,
      '这条用例绝不许改动真仓库的基线（需要写盘路径的用例一律 sandbox: true）');
  } finally {
    rmSync(r.sandboxRoot, { recursive: true, force: true });
  }
});

test('同步清单确实存在且覆盖全部上游文件', { timeout: 180_000 }, () => {
  const { code, out } = runSync(['--check']);
  assertCheckPassed(code, out, '--check 在上游一致时');
  assert.match(out, new RegExp(`相同\\s*${manifestEntryCount()}`),
    `应核对到清单里的全部文件，实际输出:\n${out}`);
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

test('--check 不写任何文件（全树快照，不只盯 manifest）', { timeout: 180_000 }, () => {
  const manifest = join(PACKAGE_ROOT, 'tools', 'upstream-manifest.json');
  const beforeManifest = existsSync(manifest) ? readFileSync(manifest, 'utf8') : undefined;
  const before = snapshotTree(PACKAGE_ROOT);
  const { code, out } = runSync(['--check']);
  const after = snapshotTree(PACKAGE_ROOT);
  const afterManifest = existsSync(manifest) ? readFileSync(manifest, 'utf8') : undefined;

  assertCheckPassed(code, out, '--check 不得改动 manifest');
  assert.equal(afterManifest, beforeManifest, '--check 不得改动 manifest');
  const changed = diffSnapshots(before, after);
  assert.deepEqual(changed, [], `--check 是只读检查，盘上不许有任何变化，实际：\n${changed.join('\n')}`);
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
