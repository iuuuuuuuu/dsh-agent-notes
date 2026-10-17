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
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 用 `git ls-remote` 查上游分支的真实 HEAD。
 *
 * 为什么不用 GitHub API：未认证请求 60 次/小时就 403，定时任务天天跑必撞墙。
 * `git ls-remote` 走 git 协议，无此限制，且给的就是分支当前指向的 commit。
 *
 * 拿到 commit 而不是分支名很重要：jsDelivr 对**分支名**的清单缓存会滞后，
 * 锚 commit 才拿到该次提交的真实树。
 *
 * @param {string} branch 分支名。
 * @returns {string | undefined} commit SHA；失败 undefined。
 */
function resolveRemoteHead(branch) {
  try {
    const result = spawnSync('git', ['ls-remote', UPSTREAM.repository, branch], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
    /* 输出形如 `<sha>\trefs/heads/main`；只取第一行的第一列。 */
    const first = result.stdout.trim().split(/\r?\n/)[0] ?? '';
    const sha = first.split(/\s+/)[0] ?? '';
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** 上游仓库与默认 ref。
 *
 * ref 默认钉在 commit 而不是分支：jsDelivr 对分支名（如 `main`）的清单缓存
 * 实测会滞后于仓库现状——锚 `@main` 会拿到重构前的旧目录结构，导致路径
 * 匹配失败；锚 commit 才拿到该次提交的真实树。要合并更新内容时，先用
 * `--ref <branch>` 显式覆盖。 */
const UPSTREAM = {
  repository: 'https://github.com/czm15053/write-notes-like-deepseek.git',
  /** GitHub API 用 owner/repo；与上面 URL 同源，改一处必须同步另一处。 */
  slug: 'czm15053/write-notes-like-deepseek',
  pathPrefix: 'skills/write-notes-like-deepseek',
  defaultRef: '0e8200c0f80d37a1c75e585a65b35401ae198462'
};

/**
 * 判断内置副本是否落后于上游默认分支。
 *
 * **为什么需要这个**：`--check` 只比对 `defaultRef` 钉住的那个 commit，
 * 它永远返回「一致」—— 哪怕上游已经发了 100 个新提交。那是假绿：
 * 检查存在、恒绿、不验证任何东西。
 *
 * **为什么不用 GitHub API 查 HEAD**：实测未认证请求 60 次/小时就 403
 * （rate limit exceeded），CI 里天天跑必然撞墙。查不到时又不能当成
 * 「已是最新」，那等于换个姿势假绿。
 *
 * **为什么不用 jsDelivr 清单 API**：它对分支名的缓存实测滞后——锚 `@main`
 * 会拿到重构前的旧目录结构。但它的**文件读取**是准的（已验证 @main 与
 * 钉住 commit 的同一文件逐字相同），所以这里走「按已知清单逐个取文件内容
 * 比对」：清单来自本地 manifest，不依赖远端枚举。
 *
 * 任一侧取不到就明确返回 undefined —— 由调用方报错，绝不静默放行。
 *
 * @param {string} branch 分支名。
 * @returns {Promise<{changed: string[], missing: string[], checked: number} | undefined>}
 *   changed=内容与本地不同的文件；missing=上游已删除的文件。
 */
async function compareWithBranch(branch = 'main') {
  const manifest = readManifest();
  if (manifest === undefined) return undefined;
  const rels = Object.keys(manifest.files ?? {});
  if (rels.length === 0) return undefined;

  const changed = [];
  const missing = [];
  let checked = 0;
  for (const rel of rels) {
    const remote = await fetchUpstream(branch, rel);
    if (remote === undefined) {
      missing.push(rel);
      continue;
    }
    checked += 1;
    if (digest(remote) !== manifest.files[rel]) changed.push(rel);
  }
  return { changed, missing, checked };
}

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
  const args = { check: false, yes: false, latest: false, auto: false, branch: 'main', ref: UPSTREAM.defaultRef };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') args.check = true;
    else if (arg === '--yes') args.yes = true;
    else if (arg === '--latest') args.latest = true;
    else if (arg === '--auto') args.auto = true;
    else if (arg === '--branch') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--branch 需要一个值');
      args.branch = value;
      index += 1;
    } else if (arg === '--ref') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--ref 需要一个值');
      args.ref = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法: node tools/sync-upstream.mjs [--check] [--yes] [--latest] [--auto] [--branch <name>] [--ref <branch|commit>]');
      console.log('  --check        只报告内置副本与该 ref 的差异，零写入');
      console.log('  --latest       与上游默认分支逐文件比对，判断是否落后（防假绿）');
      console.log('  --auto         查上游 HEAD 并合并到它（CI 用；隐含 --yes）');
      console.log('  --branch <n>   配合 --latest/--auto 指定上游分支，默认 main');
      console.log('  --yes          真的覆盖内置副本并记录清单');
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return args;
}

/**
 * 校验内置副本与清单记录的摘要是否一致（纯本地，不联网）。
 *
 * 用途：`--auto` 发现 ref 未变时，不能就此断定「没事」—— ref 只记录
 * 上次同步的目标 commit，本地文件仍可能被改过或被别的工具覆盖。
 *
 * @returns {{ mismatched: string[], missing: string[] } | undefined}
 *   有出入的文件；清单缺失或不可读时 undefined（调用方据此报错，不当成「无差异」）。
 */
function checkLocalAgainstManifest() {
  const manifest = readManifest();
  if (manifest === undefined) return undefined;
  const mismatched = [];
  const missing = [];
  for (const [rel, expected] of Object.entries(manifest.files ?? {})) {
    const local = targetPath(rel);
    if (!existsSync(local)) {
      missing.push(rel);
      continue;
    }
    const actual = `sha256:${createHash('sha256').update(readFileSync(local, 'utf8'), 'utf8').digest('hex')}`;
    if (actual !== expected) mismatched.push(rel);
  }
  return { mismatched, missing };
}

/**
 * 主流程。
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  let ref = args.ref;

  /* `--auto`：查上游真实 HEAD 并设为目标 ref，隐含 --yes。
     这是给 CI 用的 —— 定时任务不知道上游新 commit 是什么，必须自己查。
     用 git ls-remote 而不是 GitHub API：后者未认证 60 次/小时就 403。
     先查一次 HEAD：若与已同步的 ref 相同，就能直接说「无事可做」，
     省掉逐个拉 21 个文件的开销。 */
  if (args.auto) {
    const head = resolveRemoteHead(args.branch);
    if (head === undefined) {
      console.error('✖ 查不到上游 HEAD（git ls-remote 失败）。');
      console.error('  这不是「已是最新」—— 本次无法判断，退出码 2。');
      process.exit(2);
    }
    const manifest = readManifest();
    const synced = manifest?.ref;
    console.log(`上游 HEAD: ${head}`);
    console.log(`已同步:   ${typeof synced === 'string' ? synced : '（无记录）'}`);
    if (synced === head) {
      /* ref 相同只说明「上次同步的目标」没变，**不代表本地文件没被改过**。
         实测踩到：手动改坏 manifest 里某个文件的摘要后，--auto 直接报
         「已是最新」放过 —— 那是假绿。所以再校验一遍本地文件与清单是否一致，
         有出入就仍然走合并流程把它纠正回来。 */
      const drift = await checkLocalAgainstManifest();
      if (drift === undefined) {
        console.error('✖ 无法校验内置副本与清单是否一致。');
        process.exit(2);
      }
      if (drift.mismatched.length === 0 && drift.missing.length === 0) {
        console.log('\n✔ 已是最新，且内置副本与清单一致，无需合并。');
        process.exit(0);
      }
      const total = drift.mismatched.length + drift.missing.length;
      console.error(`\n⚠ ref 未变但本地有 ${total} 个文件与清单不符，重新合并以纠正：`);
      for (const rel of drift.mismatched) console.error(`  内容不同  ${rel}`);
      for (const rel of drift.missing) console.error(`  文件缺失  ${rel}`);
    }
    ref = head;
    args.yes = true;
  }

  /* `--latest`：判断内置副本是否落后于上游默认分支。
     与 `--check` 是两件事 —— `--check` 只回答「副本与该 ref 是否逐字相同」，
     它永远回答「相同」，因为 ref 就是上次同步时钉下的那个 commit。
     真正该问的是「上游有没有新提交」，那只能查远端 HEAD。 */
  if (args.latest) {
    const branch = args.branch;
    const result = await compareWithBranch(branch);
    if (result === undefined) {
      console.error('✖ 无法核对上游（清单缺失、网络不可达或被限流）。');
      console.error('  这不是「已是最新」—— 本次检查无效，请稍后重试。');
      process.exit(2);
    }
    console.log(`上游默认分支: ${branch}`);
    console.log(`已核对 ${result.checked} 个文件（基准: tools/upstream-manifest.json）`);
    const changedCount = result.changed.length;
    const missingCount = result.missing.length;
    if (changedCount === 0 && missingCount === 0) {
      console.log('\n✔ 内置副本与上游一致，无漂移。');
      process.exit(0);
    }
    console.error(`\n✖ 内置副本已落后于上游：${changedCount} 个文件内容变了，${missingCount} 个文件上游已删除。`);
    for (const rel of result.changed) console.error(`  变更  ${rel}`);
    for (const rel of result.missing) console.error(`  删除  ${rel}`);
    console.error(`\n合并方式: node tools/sync-upstream.mjs --ref ${branch} --yes`);
    console.error('合并后必须重跑: npm run check');
    process.exit(1);
  }

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
 * 读已记录的逐文件摘要清单。
 *
 * 清单是「上次同步时每个上游文件的摘要」，也是 `--latest` 的比对基准 ——
 * 有了它就不必远端枚举目录（jsDelivr 对分支的清单缓存会滞后）。
 *
 * @returns {{ version: number, ref: string, files: Record<string, string> } | undefined}
 *   清单；缺失或损坏时 undefined（调用方据此明确报错，不当成「无差异」）。
 */
function readManifest() {
  const manifestFile = join(PACKAGE_ROOT, 'tools', 'upstream-manifest.json');
  if (!existsSync(manifestFile)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifestFile, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return undefined;
    if (parsed.files === null || typeof parsed.files !== 'object') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
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
