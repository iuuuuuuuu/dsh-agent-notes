#!/usr/bin/env node
/**
 * 递增 package.json 的版本号。
 *
 * 为什么需要：这个仓库要被 dsh 市场 / 官方插件源 / 第三方识别到「有更新」，
 * 而它们看的是**版本号**。内容变了但版本号不动，对它们来说等于没更新。
 *
 * 用法：
 *   node tools/bump-version.mjs patch     # 0.2.0 -> 0.2.1（修 bug）
 *   node tools/bump-version.mjs minor     # 0.2.0 -> 0.3.0（新功能）
 *   node tools/bump-version.mjs major     # 0.2.0 -> 1.0.0（破坏性变更）
 *   node tools/bump-version.mjs           # 默认 patch
 *
 * 只改 package.json 的 version 字段，不碰其它内容；不动 git、不打 tag ——
 * 这些由调用方（workflow / 人）决定，保持脚本单一职责。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE_FILE = join(PACKAGE_ROOT, 'package.json');

/**
 * 按语义化版本递增。
 *
 * @param {string} version 当前版本，如 `0.2.0`。
 * @param {'major'|'minor'|'patch'} kind 递增哪一段。
 * @returns {string} 新版本。
 */
export function bump(version, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) throw new Error(`版本号格式不合法: ${version}`);
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (kind === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (kind === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

/** 是否是合法的递增类型。 */
const KINDS = new Set(['major', 'minor', 'patch']);

/* 作为脚本直接运行时才写盘；被 import 时只导出 bump（便于测试）。 */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const kind = (process.argv[2] ?? 'patch').toLowerCase();
  if (!KINDS.has(kind)) {
    console.error(`未知的递增类型: ${kind}（可选 major / minor / patch）`);
    process.exit(1);
  }
  const raw = readFileSync(PACKAGE_FILE, 'utf8');
  const pkg = JSON.parse(raw);
  const before = pkg.version;
  const after = bump(before, kind);
  /* 保留原文件的缩进风格，只替换 version 那一行，避免整文件重排造成噪音 diff。 */
  const next = raw.replace(/"version":\s*"[^"]+"/, `"version": "${after}"`);
  if (next === raw) {
    console.error('✖ 没找到 version 字段，未写入。');
    process.exit(1);
  }
  writeFileSync(PACKAGE_FILE, next, 'utf8');
  console.log(`${before} -> ${after}（${kind}）`);
}
