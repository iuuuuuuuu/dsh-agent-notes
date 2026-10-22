#!/usr/bin/env node
/** 只检查脚本语法，不执行模块，也不判断脚本是否被引用。 */
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 递归收集 tools 中的非测试 MJS；不依赖 Git 暂存状态。 */
export function collectToolScripts(root = PACKAGE_ROOT) {
  const files = [];
  const directory = join(root, 'tools');
  if (!existsSync(directory)) return files;
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) {
        files.push(relative(root, path).replaceAll('\\', '/'));
      }
    }
  }
  walk(directory);
  return files.sort();
}

/** 返回判定数据：0 通过、1 语法/语料不通过、2 执行或发现失败。 */
export function checkToolSyntax({ root = PACKAGE_ROOT, runCheck = spawnSync } = {}) {
  const errors = [];
  let checked = 0;
  let unknown = false;
  let scripts;
  try {
    scripts = collectToolScripts(root);
    if (scripts.length === 0) errors.push('没有扫到任何 tools 脚本：空集合不得当绿');
    // build.mjs 是 verify-plugin.mjs 直接导入的根目录构建入口。
    if (existsSync(join(root, 'build.mjs'))) scripts.push('build.mjs');
  } catch (error) {
    return { checked, errors: [`脚本发现失败：${error.message}`], exitCode: 2 };
  }
  for (const file of scripts) {
    try {
      const result = runCheck(process.execPath, ['--check', resolve(root, file)], { encoding: 'utf8' });
      checked += 1;
      if (result.error || result.signal || result.status === null || result.status === undefined) {
        unknown = true;
        errors.push(`${file}: 语法检查未完成：${result.error?.message ?? result.signal ?? '缺少退出码'}`);
      } else if (result.status !== 0) {
        errors.push(`${file}: 语法检查失败（exit ${result.status}）\n${result.stderr ?? ''}`);
      }
    } catch (error) {
      unknown = true;
      errors.push(`${file}: 语法检查执行失败：${error.message}`);
    }
  }
  return { checked, errors, exitCode: unknown ? 2 : errors.length > 0 ? 1 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = checkToolSyntax();
  if (result.errors.length) console.error(result.errors.join('\n'));
  else console.log(`syntax-check: ${result.checked} script(s) passed`);
  process.exitCode = result.exitCode;
}
