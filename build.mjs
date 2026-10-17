/**
 * 把 src/client.js 包成 DSH 客户端模块信封，写成 lib/client.js。
 *
 * 信封是硬约束（见 @deepseek-ai/dsh-client-modules 的 manifest 契约）：
 * bundle 必须自己调用 window.__ModuleLoader__.load({id, factory})，且 id 与
 * 插件包名一致；模块体内任何副作用都在 factory 闭包里，第一次被 require
 * 时才执行。这与同目录 dsh-turn-stats 的构建方式一致。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const source = readFileSync(join(root, 'src', 'client.js'), 'utf8');

// 源码里写成 function createAgentNotesClient(require) { ... }，取函数体。
const marker = 'function createAgentNotesClient(require) {';
const at = source.indexOf(marker);
if (at === -1) throw new Error('src/client.js: 找不到 createAgentNotesClient(require) 入口');
let body = source.slice(at + marker.length);
const tail = body.lastIndexOf('}');
if (tail === -1) throw new Error('src/client.js: 函数体没有收尾');
body = body.slice(0, tail);

const bundle = [
  `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:function(require){`,
  '"use strict";',
  'var __dshAgentNotes = (function(){',
  body.trim(),
  '})();',
  'return __dshAgentNotes;',
  '}});',
  ''
].join('\n');

mkdirSync(join(root, 'lib'), { recursive: true });
writeFileSync(join(root, 'lib', 'client.js'), bundle, 'utf8');
console.log(`built lib/client.js (${bundle.length} bytes)`);
