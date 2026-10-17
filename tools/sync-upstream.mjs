#!/usr/bin/env node
/**
 * 上游合并：把 czm15053/write-notes-like-deepseek 的最新内容拉进本包内置副本。
 *
 * 需求（Owner 选项 A）：插件内置内容能拉上游并**展示 diff、确认后覆盖**。
 *
 * 设计：
 *   - 上游内容 vendored 在 skills/agent-notes/，本脚本是唯一写入者。
 *   - `--check` 只报告漂移、零写入（可直接进 CI）。
 *   - 默认模式：先算逐文件 SHA-256 差异 → 打印 diff 摘要 → 需要 `--yes` 才落盘。
 *   - 逐文件摘要写入 tools/upstream-manifest.json，并把 commit 记进 upstream.json，
 *     这样「哪次同步的、同步了什么」可核对，不靠记忆。
 *
 * 安全：只从固定的 HTTPS 源拉取固定路径清单；不执行上游任何脚本，只当字节流。
 * 上游脚本仅在我们自己的门禁里被 node 执行（那是既定设计，不是本脚本引入的）。
 *
 * 用法：
 *   node tools/sync-upstream.mjs            # 报告差异，需要 --yes 才写
 *   node tools/sync-upstream.mjs --check    # 只报告，零写入（CI 用）
 *   node tools/sync-upstream.mjs --yes      # 真的覆盖内置副本
 *   node tools/sync-upstream.mjs --ref <commit-or-branch>
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 上游仓库与默认 ref。
 *
 * ref 默认钉在 commit 而不是分支：jsDelivr 对分支名（如 `main`）的清单缓存
 * 实测会滞后于仓库现状——锚 `@main` 会拿到重构前的旧目录结构，导致路径
 * 匹配失败；锚 commit 才拿到该次提交的真实树。要合并更新内容时，先用
 * `--ref <branch>` 显式覆盖。 */
const UPSTREAM = {
  repository: 'https://github.com/czm15053/write-notes-like-deepseek.git',
  pathPrefix: 'skills/write-notes-like-deepseek',
  defaultRef: '0e8200c0f80d37a1c75e585a65b35401ae198462'
};

/**
 * 通过 jsDelivr CDN 读上游文件。
 *
 * 直连 raw.githubusercontent / github 在本机实测被重置（ECONNRESET），
 * jsDelivr 可稳定访问；它按 commit 或分支提供同一份仓库内容。
 *
 * @param {string} ref 分支或 commit。
 * @param {string} repoPath 仓库内相对路径。
 * @returns {Promise<string | undefined>} 文件文本，404 时 undefined。
 */
async function fetchUpstream(ref, repoPath) {
  const url = `https://fastly.jsdelivr.net/gh/czm15053/write-notes-like-deepseek@${ref}/${UPSTREAM.pathPrefix}/${repoPath}`;
  const response = await fetch(url);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`拉取失败 ${response.status}: ${url}`);
  return await response.text();
}

/**
 * 读取 jsDelivr 的目录清单，避免维护一份手工文件列表。
 *
 * @param {string} ref 分支或 commit。
 * @param {string} dir 仓库内目录（相对 pathPrefix，'' 表示根）。
 * @returns {Promise<string[]>} 该目录下的文件名；目录不存在时抛出（不静默返回空）。
 */
async function listUpstreamDir(ref, dir) {
  const url = `https://data.jsdelivr.com/v1/packages/gh/czm15053/write-notes-like-deepseek@${ref}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`清单拉取失败 ${response.status}: ${url}`);
  const payload = await response.json();

  /** 在 jsDelivr 的树里按路径找节点；根节点自身 type 为 'gh'，只有子层才是 directory。 */
  const find = (node, segments) => {
    if (segments.length === 0) return node;
    const [head, ...rest] = segments;
    const next = (node.files ?? []).find((entry) => entry.name === head);
    return next === undefined ? undefined : find(next, rest);
  };

  const base = UPSTREAM.pathPrefix.split('/').filter(Boolean);
  const segments = dir === '' ? base : [...base, ...dir.split('/').filter(Boolean)];
  const target = find(payload, segments);
  if (target === undefined) {
    // 静默返回空会让「上游路径改了」伪装成「无需合并」，那是假绿；必须响。
    throw new Error(
      `上游清单中找不到目录 "${UPSTREAM.pathPrefix}${dir === '' ? '' : `/${dir}`}"（ref=${ref}）。`
      + '上游目录结构可能已变更，请人工核对后再同步。'
    );
  }
  return (target.files ?? []).filter((entry) => entry.type === 'file').map((entry) => entry.name);
}

/**
 * 计算文本的 SHA-256。
 *
 * @param {string} text 内容。
 * @returns {string} `sha256:<hex>`。
 */
function digest(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * 上游文件 → 本包内目标路径。
 *
 * SKILL.md 落在 skills/agent-notes/，其余子目录原样保留。
 *
 * @param {string} rel 仓库内相对 pathPrefix 的路径。
 * @returns {string} 本包内绝对路径。
 */
function targetPath(rel) {
  return join(PACKAGE_ROOT, 'skills', 'agent-notes', ...rel.split('/'));
}

/**
 * 收集要同步的路径：根文件 + 已知子目录。
 *
 * @param {string} ref 分支或 commit。
 * @returns {Promise<string[]>} 仓库内相对路径列表。
 */
async function collectPaths(ref) {
  const paths = ['SKILL.md'];
  for (const dir of ['references', 'templates', 'scripts', 'assets']) {
    const names = await listUpstreamDir(ref, dir);
    for (const name of names) paths.push(`${dir}/${name}`);
    if (dir === 'assets' && names.length === 0) {
      // 上游 assets 含看板模板；变空说明结构变了，不能当「没有这个目录」放过。
      throw new Error(`上游 ${UPSTREAM.pathPrefix}/assets 为空，看板模板可能已改名或移走。`);
    }
  }
  return paths;
}

/** 解析命令行参数。 */
function parseArgs(argv) {
  const args = { check: false, yes: false, ref: UPSTREAM.defaultRef };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') args.check = true;
    else if (arg === '--yes') args.yes = true;
    else if (arg === '--ref') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--ref 需要一个值');
      args.ref = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法: node tools/sync-upstream.mjs [--check] [--yes] [--ref <branch|commit>]');
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return args;
}

/**
 * 主流程。
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ref = args.ref;
  console.log(`上游: ${UPSTREAM.repository} @ ${ref}`);

  const paths = await collectPaths(ref);
  // 兜底：枚举结果异常少说明清单解析坏了，不能当「无需合并」放过。
  if (paths.length < 10) {
    throw new Error(
      `只枚举到 ${paths.length} 个上游文件（预期 >= 10），清单解析很可能已失效。`
      + `已枚举: ${paths.join(', ')}`
    );
  }
  console.log(`待核对: ${paths.length} 个文件\n`);

  const manifest = { version: 1, ref, files: {} };
  const report = [];

  for (const rel of paths) {
    const remote = await fetchUpstream(ref, rel);
    if (remote === undefined) {
      report.push({ rel, status: 'upstream-missing' });
      continue;
    }
    const local = targetPath(rel);
    const current = existsSync(local) ? readFileSync(local, 'utf8') : undefined;
    const remoteDigest = digest(remote);
    manifest.files[rel] = remoteDigest;

    if (current === undefined) report.push({ rel, status: 'new', remoteDigest });
    else if (digest(current) === remoteDigest) report.push({ rel, status: 'same', remoteDigest });
    else {
      const currentLines = current.split('\n').length;
      const remoteLines = remote.split('\n').length;
      report.push({
        rel,
        status: 'changed',
        remoteDigest,
        localDigest: digest(current),
        localLines: currentLines,
        remoteLines: remoteLines,
        delta: remoteLines - currentLines
      });
    }
  }

  // 本包内有、上游没有的文件（例如我们自己加的东西）。
  for (const entry of report) {
    if (entry.status === 'upstream-missing') console.log(`  ? ${entry.rel} — 上游已无此文件（保留本地）`);
  }

  const changed = report.filter((entry) => entry.status === 'changed');
  const added = report.filter((entry) => entry.status === 'new');
  const same = report.filter((entry) => entry.status === 'same');

  console.log(`相同 ${same.length}｜变更 ${changed.length}｜新增 ${added.length}\n`);
  for (const entry of changed) {
    console.log(`  ~ ${entry.rel}  (行数 ${entry.localLines} → ${entry.remoteLines}，${entry.delta >= 0 ? '+' : ''}${entry.delta})`);
  }
  for (const entry of added) console.log(`  + ${entry.rel}  (新增)`);

  if (changed.length === 0 && added.length === 0) {
    console.log('\n内置副本与上游一致，无需合并。');
    if (!args.check) writeManifest(manifest, ref);
    return;
  }

  if (args.check) {
    console.log('\n--check 模式：未写入任何文件。');
    process.exit(1); // 有漂移即非零，便于 CI 发现
  }

  if (!args.yes) {
    console.log('\n以上为差异预览。确认合并请加 --yes；仅检查加 --check。');
    console.log('提示：合并后务必重跑 node --test tools/plugin.test.mjs 与 node tools/fault-injection.mjs。');
    return;
  }

  for (const entry of [...changed, ...added]) {
    const remote = await fetchUpstream(ref, entry.rel);
    const local = targetPath(entry.rel);
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, remote, 'utf8');
    console.log(`  ✔ 已更新 ${entry.rel}`);
  }
  writeManifest(manifest, ref);
  console.log('\n合并完成。请重跑测试与故障注入确认门禁仍可信。');
}

/**
 * 写 manifest 与 upstream.json 的同步记录。
 *
 * @param {any} manifest 逐文件摘要。
 * @param {string} ref 已同步的分支或 commit。
 */
function writeManifest(manifest, ref) {
  const manifestFile = join(PACKAGE_ROOT, 'tools', 'upstream-manifest.json');
  mkdirSync(dirname(manifestFile), { recursive: true });
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const upstreamFile = join(PACKAGE_ROOT, 'upstream.json');
  const previous = existsSync(upstreamFile) ? JSON.parse(readFileSync(upstreamFile, 'utf8')) : {};
  const next = {
    repository: UPSTREAM.repository,
    path: UPSTREAM.pathPrefix,
    ref,
    syncedAt: new Date().toISOString(),
    fileCount: Object.keys(manifest.files).length,
    ...(previous.commit === undefined ? {} : { commit: previous.commit })
  };
  writeFileSync(upstreamFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`  已记录 tools/upstream-manifest.json 与 upstream.json`);
  void relative;
}

main().catch((error) => {
  console.error(`合并失败: ${error?.message ?? error}`);
  process.exit(1);
});
