/**
 * 把 src/client.js 包成 DSH 客户端模块信封，写成 lib/client.js。
 *
 * 信封是硬约束（见 @deepseek-ai/dsh-client-modules 的 manifest 契约）：
 * bundle 必须自己调用 window.__ModuleLoader__.load({id, factory})，且 id 与
 * 插件包名一致；模块体内任何副作用都在 factory 闭包里，第一次被 require
 * 时才执行。这与同目录 dsh-turn-stats 的构建方式一致。
 *
 * ## 为什么要导出函数
 *
 * 原来这个文件只做一件事：算出 bundle 然后写盘。`tools/verify-plugin.mjs`
 * 为了比对「`lib/client.js` 是否与重建结果一致」，**把这段逻辑原样复制了
 * 一份**（当时写作「用与 build.mjs 完全相同的规则重建客户端 bundle」）。
 *
 * 两份实现意味着：改了一处忘了改另一处，门禁会比对**自己那份**与磁盘上的
 * `lib/client.js`，于是照样全绿 —— 门禁正在验证一份和构建脚本可能已经分叉
 * 的实现。实测过这个形态：把 `build.mjs` 写坏（改掉信封 id 的写法），
 * 整条 check 链仍然 exit 0。
 *
 * 正确形态是**消除重复**，不是再加一道「跑一遍 build.mjs」的检查 ——
 * 后者会写盘，而 CI 末尾有「测试不得改动工作区」的断言。
 * 所以这里导出纯函数，写盘只发生在**直接执行本文件**时。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * 算出客户端 bundle 的文本。
 *
 * 纯函数：不读盘以外的东西，也不写盘 —— 这样 `tools/verify-plugin.mjs`
 * 能 import 它做**比对**，而不会顺手改坏工作区。
 *
 * @param {string} [baseDir] 仓库根（默认本文件所在目录）。
 * @returns {string} bundle 文本。
 */
export function buildClientBundle(baseDir = root) {
  const pkg = JSON.parse(readFileSync(join(baseDir, 'package.json'), 'utf8'));
  const source = readFileSync(join(baseDir, 'src', 'client.js'), 'utf8');

  // 源码里写成 function createAgentNotesClient(require) { ... }，取函数体。
  const marker = 'function createAgentNotesClient(require) {';
  const at = source.indexOf(marker);
  if (at === -1) throw new Error('src/client.js: 找不到 createAgentNotesClient(require) 入口');
  let body = source.slice(at + marker.length);
  const tail = body.lastIndexOf('}');
  if (tail === -1) throw new Error('src/client.js: 函数体没有收尾');
  body = body.slice(0, tail);

  return [
    `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:function(require){`,
    '"use strict";',
    'var __dshAgentNotes = (function(){',
    body.trim(),
    '})();',
    'return __dshAgentNotes;',
    '}});',
    ''
  ].join('\n');
}

/**
 * 重建并写入 `lib/client.js`。
 *
 * @param {string} [baseDir] 仓库根（默认本文件所在目录）。
 * @returns {number} 写入的字节数。
 */
export function build(baseDir = root) {
  const bundle = buildClientBundle(baseDir);
  mkdirSync(join(baseDir, 'lib'), { recursive: true });
  writeFileSync(join(baseDir, 'lib', 'client.js'), bundle, 'utf8');
  return bundle.length;
}

/* 只在被当作脚本直接执行时写盘 —— 被 import 时保持纯净，便于比对。 */
const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replace(/\\/g, '/').endsWith('/build.mjs');
if (invokedDirectly) {
  console.log(`built lib/client.js (${build()} bytes)`);
}
