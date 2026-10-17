/**
 * 投影与客户端契约测试。
 *
 * 重点不是「跑通」，而是把两类**会让徽标撒谎**的错误钉死：
 *   1. 语义错位：裸调用 `/agent-notes`（查状态）被当成 reset，
 *      `on --global` 被当成本会话覆盖 —— 徽标就会显示错的开/关。
 *   2. 引用错位：无关事件返回新引用（白白重算）或全局操作返回原引用
 *      （视图不重算、徽标停在旧值）。
 *
 * 另外校验客户端 bundle 的信封契约：id 必须等于包名，
 * 否则浏览器加载器会拒绝这个模块。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROJECTION_KEY, COMMAND_NAME, emptyProjectionState, parseSwitchArg,
  isGlobalSwitch, applyProjection, mirrorPath, writeMirror, readMirror
} from '../lib/projection.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 造一个 command/run 事件。 */
function runEvent(args, seq = 1) {
  return { type: 'command/run', seq, data: { name: COMMAND_NAME, args } };
}

test('投影：开启命令把状态置为开', () => {
  const next = applyProjection(emptyProjectionState(), runEvent('on', 7));
  assert.equal(next.enabled, true, 'on 必须置为开');
  assert.equal(next.seq, 7, 'seq 应记录事件位置');
});

test('投影：关闭命令把状态置为关', () => {
  const next = applyProjection(emptyProjectionState(), runEvent('off', 3));
  assert.equal(next.enabled, false, 'off 必须置为关');
});

test('投影：裸调用是查状态，绝不能当成 reset', () => {
  // 先开，再裸调用；裸调用不得改变已开的状态。
  const opened = applyProjection(emptyProjectionState(), runEvent('on', 1));
  const afterBare = applyProjection(opened, runEvent('', 2));
  assert.equal(afterBare, opened, '裸调用必须返回原引用（不改状态）');
  assert.equal(afterBare.enabled, true, '裸调用后仍应为开');

  assert.equal(parseSwitchArg(''), undefined, '空参数不解析成开关意图');
});

test('投影：on --global 不动本会话覆盖，但必须触发视图重算', () => {
  assert.equal(parseSwitchArg('on --global'), undefined, '--global 不是本会话意图');
  assert.equal(isGlobalSwitch('on --global'), true, 'on --global 是全局操作');

  const base = applyProjection(emptyProjectionState(), runEvent('on', 1));
  const afterGlobal = applyProjection(base, runEvent('off --global', 2));
  assert.notEqual(afterGlobal, base, '全局操作必须返回新引用，否则视图不重算');
  assert.equal(afterGlobal.enabled, true, '本会话覆盖不受 --global 影响');
});

test('投影：status/gate/init 与无关命令都不改状态', () => {
  const base = applyProjection(emptyProjectionState(), runEvent('on', 1));
  for (const args of ['status', 'gate', 'gate tree', 'init', 'bogus']) {
    assert.equal(applyProjection(base, runEvent(args, 2)), base, `${args} 不得改状态`);
  }
  const other = { type: 'command/run', seq: 3, data: { name: 'permission', args: 'off' } };
  assert.equal(applyProjection(base, other), base, '别的命令不得改状态');
});

test('投影：只认 command/run，不认 command/done', () => {
  const base = emptyProjectionState();
  const done = { type: 'command/done', seq: 2, data: { name: COMMAND_NAME, kind: 'success' } };
  assert.equal(applyProjection(base, done), base, 'command/done 不带 args，不能据它改状态');
});

test('投影：重复同一命令返回原引用（不触发无谓重算）', () => {
  const once = applyProjection(emptyProjectionState(), runEvent('on', 1));
  const twice = applyProjection(once, runEvent('on', 2));
  assert.equal(twice, once, '同参数重复必须返回原引用');
});

test('投影：reset 清除本会话覆盖', () => {
  const opened = applyProjection(emptyProjectionState(), runEvent('on', 1));
  const reset = applyProjection(opened, runEvent('reset', 2));
  assert.equal(reset.enabled, null, 'reset 后回到「未设置」');
});

test('投影：坏事件不抛（日志里可能有各种形状）', () => {
  const base = emptyProjectionState();
  for (const bad of [null, undefined, 42, 'x', {}, { type: 'command/run' }, { type: 'command/run', data: null }]) {
    assert.equal(applyProjection(base, bad), base, `坏输入 ${JSON.stringify(bad)} 必须原样返回`);
  }
});

test('镜像：写入后可读回，且与状态文件同目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'an-mirror-'));
  try {
    const stateFile = join(dir, 'state.json');
    assert.equal(mirrorPath(stateFile), join(dir, 'global.json'), '镜像必须落在状态文件旁边');
    writeMirror(stateFile, true);
    assert.equal(readMirror(stateFile), true, '写 true 应读回 true');
    writeMirror(stateFile, false);
    assert.equal(readMirror(stateFile), false, '写 false 应读回 false');
    writeMirror(stateFile, null);
    assert.equal(readMirror(stateFile), null, 'null 表示未设置');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('镜像：损坏文件读成 null，不抛（显示乐观，但不崩）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'an-mirror-bad-'));
  try {
    const stateFile = join(dir, 'state.json');
    writeFileSync(mirrorPath(stateFile), '{ 这不是 JSON', 'utf8');
    assert.equal(readMirror(stateFile), null, '损坏时应为 null');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('客户端 bundle：信封契约（id 必须等于包名）', () => {
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.ok(
    bundle.includes(`window.__ModuleLoader__.load({id:"${pkg.name}",factory:function(require){`),
    `bundle 必须以 load({id:"${pkg.name}"}) 开头，否则浏览器加载器会拒绝`
  );
  assert.ok(bundle.trimEnd().endsWith('}});'), 'bundle 必须闭合 load 调用');
});

test('客户端 bundle：注册进 composer 工具行与输入框上方 dock', () => {
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  assert.ok(bundle.includes('conversation.input.left'), '必须注册 composer 工具行左侧（截图里「完全权限」那排）');
  assert.ok(bundle.includes('conversation.input.dock'), '生效 tag 必须注册进输入框上方 dock');
  // 不用 header.utilities：它被 DSH 包在 `!hideChrome` 里，空会话（新会话）
  // 时整个工具区不渲染 —— 而新会话恰恰最需要看到是否生效。实测踩过。
  // 只匹配**实际的注册调用**：注释里会提到这个名字来解释为何不用它。
  assert.ok(!/inject\(\s*['"]conversation\.session\.header\.utilities['"]/.test(bundle),
    '不应注册 header.utilities（空会话下被 hideChrome 隐藏）');
  // input.dock 是 list 类型，IG5 也注册在那里；list 允许多条目共存，
  // 因此共用是安全的（IG5 order 31，本插件 order 40）。
  assert.ok(bundle.includes('order: 40'), '应以 order 40 排在 IG5 徽标之后');
});

test('客户端 bundle：用官方命令通道写状态，不自己写日志', () => {
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  assert.ok(bundle.includes('.command('), '必须通过 SessionFace.command 提交斜杠命令');
  assert.ok(bundle.includes('/agent-notes'), '提交的应是 /agent-notes 命令');
  // 投影键必须与宿主侧一致，否则读不到状态、徽标恒为「未知」。
  assert.ok(bundle.includes(`'${PROJECTION_KEY}'`), `客户端必须读投影键 ${PROJECTION_KEY}`);
});
