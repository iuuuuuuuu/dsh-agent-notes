/**
 * 「插件版本变了」这件事，怎么让对话里的人知道。
 *
 * Owner 2026-10-22 的原话：**版本更新时 agent 对话根本不会触发提示** ——
 * 插件升到新版本后，模型与用户都不知道发生了什么、该不该动项目里的技能副本。
 * 所以这里做一条**只出现一次**的提示：记住「上次在这个项目里见到的插件版本」，
 * 下次挂载时若与当前版本不同，就把差异写成一句话塞进规范正文。
 *
 * 三条诚实性约束（都来自本仓库的假绿教训）：
 *   ① **不联网**。版本比对只用本地 `package.json` 与本地记录，
 *      不去查 npm/GitHub —— 联网判定会让门禁与提示在离线时行为不同，
 *      而「提示没出现」和「版本没变」在日志里长得一模一样。
 *   ② **首次运行不提示**。没有上次记录 ≠ 发生了更新；
 *      把「第一次」说成「更新了」是伪造事实。
 *   ③ **读不到版本就不猜**。版本号形态不认识时返回 undefined，
 *      宁可静默，也不编一个版本号出来。
 *
 * 零依赖：只用 node 内建。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 本包根目录。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 语义化版本（只要 `x.y.z` 打头的就认，允许 `-rc.1` 这类后缀）。 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * 当前插件版本。
 *
 * 读不到或形态不认识时为 undefined —— 调用方据此**不提示**。
 * 刻意不写死常量：写死的版本号一定会与 `package.json` 漂移，
 * 而漂移的版本号比没有版本号更误导。
 *
 * @returns {string | undefined} 版本号。
 */
export function readPluginVersion() {
  try {
    const raw = readFileSync(`${PACKAGE_ROOT}package.json`, 'utf8');
    const version = JSON.parse(raw)?.version;
    return typeof version === 'string' && VERSION_RE.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 比较两个版本号里 `x.y.z` 三段的大小。
 *
 * 只比数字三段：预发布后缀（`-rc.1`）在这一条提示里不参与排序 ——
 * 这条提示只回答「是不是变了」，不回答「谁更新」。
 *
 * @param {string} a 版本号。
 * @param {string} b 版本号。
 * @returns {number} a<b 为负，相等为 0，a>b 为正。
 */
export function compareCore(a, b) {
  const pick = (v) => String(v).split(/[-+]/, 1)[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y, z] = pick(a);
  const [p, q, r] = pick(b);
  for (const [l, r2] of [[x, p], [y, q], [z, r]]) {
    if (l !== r2) return l - r2;
  }
  return 0;
}

/**
 * 生成「插件版本已变化」的提示正文。
 *
 * @param {{ current?: string, lastSeen?: string, changelogPath?: string }} input
 *   current=当前版本，lastSeen=上次在该项目见到的版本（没有就是首次运行）。
 * @returns {string | undefined} 提示文本；没有可说的就返回 undefined。
 */
export function buildVersionChangeHint(input = {}) {
  const current = input.current;
  const lastSeen = input.lastSeen;
  if (typeof current !== 'string' || !VERSION_RE.test(current)) return undefined;
  if (typeof lastSeen !== 'string' || lastSeen.trim() === '') return undefined; // 首次运行不算更新
  if (lastSeen === current) return undefined;
  if (!VERSION_RE.test(lastSeen)) return undefined; // 旧记录可能是脏的，不据此下结论

  const cmp = compareCore(current, lastSeen);
  const direction = cmp > 0 ? '更新' : cmp < 0 ? '回退' : '变更';
  const changelog = typeof input.changelogPath === 'string' && input.changelogPath !== ''
    ? input.changelogPath
    : undefined;

  const lines = [
    '# 决策笔记：插件版本已' + direction,
    `本机插件版本从 \`${lastSeen}\` 变为 \`${current}\`（${direction}）。`
  ];
  if (cmp < 0) {
    lines.push('**回退**可能是刻意的（排查问题时降级），也可能是装错了包 —— 向用户确认一次再继续。');
  }
  lines.push(
    changelog === undefined
      ? '变更内容见包的 `CHANGELOG.md`。'
      : `变更内容见 \`${changelog}\`。`
  );
  lines.push(
    '项目里的 `.agents/skills/agent-notes/` 是项目自己的副本，**不会**随插件自动更新；',
    '需要时先问用户，同意后运行 `/agent-notes sync-skill`。',
    '这段提示每个版本只出现一次，说完就不必再提。'
  );
  return lines.join('\n');
}
