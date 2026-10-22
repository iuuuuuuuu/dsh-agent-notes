import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectToolScripts, checkToolSyntax } from './syntax-check.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-syntax-check-'));
  try { return run(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
function put(root, name, content) {
  const path = join(root, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

test('递归检查非测试脚本，不执行模块，不检查测试脚本', () => fixture(root => {
  put(root, 'tools/good.mjs', 'throw new Error("must not execute");\n');
  put(root, 'tools/nested/good.mjs', 'export const value = 1;\n');
  put(root, 'tools/ignored.test.mjs', 'export function broken( {');
  assert.deepEqual(collectToolScripts(root), ['tools/good.mjs', 'tools/nested/good.mjs']);
  const result = checkToolSyntax({ root });
  assert.equal(result.exitCode, 0, result.errors.join('\n'));
  assert.equal(result.checked, 2);
}));

test('语法错误必须判红并指出文件', () => fixture(root => {
  put(root, 'tools/bad.mjs', 'export function zzProbe( {');
  const result = checkToolSyntax({ root });
  assert.equal(result.exitCode, 1);
  assert.equal(result.checked, 1);
  assert.match(result.errors.join('\n'), /tools\/bad\.mjs/);
}));

test('缺少 tools 目录时空集合必须判红', () => fixture(root => {
  const result = checkToolSyntax({ root });
  assert.equal(result.exitCode, 1);
  assert.equal(result.checked, 0);
  assert.match(result.errors.join('\n'), /空集合不得当绿/);
}));

test('只有测试脚本仍属于空语料', () => fixture(root => {
  put(root, 'tools/only.test.mjs', 'export {};');
  const result = checkToolSyntax({ root });
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join('\n'), /空集合不得当绿/);
}));

test('根目录 build.mjs 也必须通过语法检查', () => fixture(root => {
  put(root, 'tools/good.mjs', 'export {};');
  put(root, 'build.mjs', 'export function broken( {');
  const result = checkToolSyntax({ root });
  assert.equal(result.exitCode, 1);
  assert.equal(result.checked, 2);
  assert.match(result.errors.join('\n'), /build\.mjs/);
}));

test('build.mjs 不得掩盖空 tools 语料', () => fixture(root => {
  put(root, 'build.mjs', 'export {};');
  const result = checkToolSyntax({ root });
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join('\n'), /空集合不得当绿/);
}));

test('检查进程启动失败返回无法判定状态', () => fixture(root => {
  put(root, 'tools/good.mjs', 'export {};');
  const result = checkToolSyntax({ root, runCheck: () => ({ error: new Error('spawn failed'), status: null }) });
  assert.equal(result.exitCode, 2);
  assert.match(result.errors.join('\n'), /tools\/good\.mjs.*spawn failed/);
}));

test('检查进程被信号终止返回无法判定状态', () => fixture(root => {
  put(root, 'tools/good.mjs', 'export {};');
  const result = checkToolSyntax({ root, runCheck: () => ({ signal: 'SIGTERM', status: null }) });
  assert.equal(result.exitCode, 2);
}));
