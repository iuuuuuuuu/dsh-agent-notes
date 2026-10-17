/**
 * 回归测试：工具必须作用于**会话的仓库**，不许退回 process.cwd()。
 *
 * 这条缺陷是 Owner 实机发现的：
 *   不传 cwd 时 gate 落到 DSH 自己的 checkout，那里也有 .agents/notes，
 *   于是门禁真跑通并返回绿 —— 测的根本不是用户仓库，属「假绿门禁」。
 *
 * 根因（已核实，不是推测）：
 *   @deepseek-ai/dsh-agent 的 Agent 接口只有 `id` 一个字段，没有 cwd。
 *   旧代码写 `exec.agent.cwd` 恒为 undefined，再静默退回 process.cwd()。
 *
 * 因此这里必须两件事都测：
 *   1. 有会话 cwd 时，用它；
 *   2. 没有会话 cwd 时，**必须失败**，绝不能跑出一个绿。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargetCwd, NO_CWD } from '../lib/target.js';

/** 造一个假的 ctx：只有 get('sessions') 可用，其余抛错（模拟 Cordis 严格属性访问）。 */
function makeCtx(sessions) {
  return {
    get(name) {
      if (name === 'sessions') return sessions;
      throw new Error(`cannot get property "${name}" without inject`);
    }
  };
}

test('target: 显式 cwd 优先，且不需要 sessions 服务', () => {
  const ctx = makeCtx(undefined);
  const target = resolveTargetCwd(ctx, { agent: { id: 's1' } }, '  D:/repo/sub  ');
  assert.equal(target.ok, true);
  assert.equal(target.cwd, 'D:/repo/sub');
  assert.equal(target.source, 'argument');
});

test('target: 省略 cwd 时取会话头里的 cwd（不是 process.cwd）', () => {
  const ctx = makeCtx({
    get(id) {
      assert.equal(id, 's1');
      return { header: { cwd: 'D:/WishProject/sourin-flutter-spike' } };
    }
  });
  const target = resolveTargetCwd(ctx, { agent: { id: 's1' } }, undefined);
  assert.equal(target.ok, true);
  assert.equal(target.cwd, 'D:/WishProject/sourin-flutter-spike');
  assert.equal(target.source, 'session');
  // 关键：绝不能是当前进程目录
  assert.notEqual(target.cwd, process.cwd());
});

test('target: Agent 没有 cwd 字段这件事本身（旧实现取错的地方）', () => {
  // Agent 真实接口只有 id；下面这个 exec 的形状就是真实形状。
  const exec = { agent: { id: 's1' } };
  assert.equal(exec.agent.cwd, undefined, 'Agent 上不该有 cwd —— 旧代码就是错在这里');
  // 但它依然能通过 sessions 拿到正确目录
  const ctx = makeCtx({ get: () => ({ header: { cwd: 'D:/real-repo' } }) });
  assert.equal(resolveTargetCwd(ctx, exec, undefined).cwd, 'D:/real-repo');
});

test('target: 会话没有 cwd 时必须失败，不许退回 process.cwd()', () => {
  const ctx = makeCtx({ get: () => ({ header: {} }) });
  const target = resolveTargetCwd(ctx, { agent: { id: 's1' } }, undefined);
  assert.equal(target.ok, false);
  assert.equal(target.reason, NO_CWD);
  assert.ok(target.detail.includes('显式传入 cwd'), '应给出可执行的建议');
  // 特意确认没有偷偷给出 process.cwd()
  assert.equal(target.cwd, undefined);
});

test('target: 没有 agent 身份时失败，不猜', () => {
  const target = resolveTargetCwd(makeCtx(undefined), {}, undefined);
  assert.equal(target.ok, false);
  assert.equal(target.reason, NO_CWD);
});

test('target: sessions 服务缺失时失败，不崩也不猜', () => {
  const target = resolveTargetCwd(makeCtx(undefined), { agent: { id: 's1' } }, undefined);
  assert.equal(target.ok, false);
  assert.equal(target.reason, NO_CWD);
  assert.ok(target.detail.includes('sessions'), '应说明是服务不可用');
});

test('target: 读取 sessions.get 抛异常时也被兜住，转为明确失败', () => {
  const ctx = makeCtx({
    get() {
      throw new Error('boom');
    }
  });
  const target = resolveTargetCwd(ctx, { agent: { id: 's1' } }, undefined);
  assert.equal(target.ok, false);
  assert.equal(target.reason, NO_CWD);
});
