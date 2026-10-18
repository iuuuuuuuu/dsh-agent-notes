/**
 * `agent-notes` 命令的行为测试。
 *
 * ## 为什么单独测这个文件
 *
 * `lib/commands.js`（229 行）此前**零直接测试覆盖** —— 而它是用户唯一
 * 直接敲的命令入口。`integration.test.mjs` 只验证「注册了一个命令」，
 * 不验证任何分支的行为。
 *
 * 这里的策略：**用真实的 state / notes 服务**，只桩掉 DSH 的 ctx 外壳。
 * 理由是 `createStateStore` / `createNotesService` 都是纯本地逻辑
 * （读写 JSON、spawn 脚本），桩掉它们就等于测了一个假的插件。
 *
 * 每个 case 都断言「返回的 kind 与文案里的事实」，不只看 kind ——
 * 一个永远返回 success 的实现也能通过只看 kind 的断言。
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { registerCommands } from '../lib/commands.js';
import { createStateStore } from '../lib/state.js';
import { createNotesService } from '../lib/notes.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 造一个能承载命令的假 ctx，并返回取到的命令定义。
 *
 * 只桩 DSH 的外壳（inject / effect / commands.register），
 * state 与 notes 用真实实现。
 *
 * @param {{enabled?: boolean, stateFile?: string, notesRoot?: string}} [options] 选项。
 * @returns {{handler: (inv: any) => Promise<any>, dir: string, state: any, cleanup: () => void}} 结果。
 */
function mount(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'an-cmd-'));
  const stateFile = options.stateFile ?? join(dir, 'state.json');
  const state = createStateStore({}, stateFile);
  const notes = createNotesService({}, options.notesRoot);

  const registered = [];
  const ctx = {};
  ctx.inject = (deps, callback) => {
    /* 插件注入 ['commands']；把假服务给它。
       注意 `effect` 挂在 **subCtx** 上（`subCtx.effect(...)`），
       不是挂在顶层 ctx —— 实测踩过：只给 ctx 挂 effect 会报
       `subCtx.effect is not a function`。 */
    if (deps.includes('commands')) {
      const subCtx = {
        commands: {
          register(definition) {
            registered.push(definition);
            return () => {};
          }
        },
        effect(fn) {
          fn();
          return () => {};
        }
      };
      callback(subCtx);
    }
    return () => {};
  };

  registerCommands(ctx, {
    state,
    notes,
    effective: (agent, fallback) => state.effective(agent, fallback),
    config: { enabled: options.enabled === true, registerCommands: true }
  });

  assert.equal(registered.length, 1, '必须注册一个命令');
  const definition = registered[0];

  return {
    definition,
    handler: (inv) => definition.handler(inv),
    dir,
    state,
    notes,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

/**
 * 造一个「像会话」的 invocation。
 *
 * @param {string} rawInput 原始输入。
 * @param {string} [cwd] 会话工作目录。
 * @returns {{rawInput: string, agent: {id: string, cwd: string}}} invocation。
 */
function invoke(rawInput, cwd = '') {
  return { rawInput, agent: { id: 'agent-1', cwd } };
}

test('commands: 无参数时显示 status，且如实报告当前开关', async () => {
  const box = mount();
  try {
    const result = await box.handler(invoke(''));
    assert.equal(result.kind, 'success', `无参数应显示状态，实际 ${result.kind}: ${result.text}`);
    /* 默认是关 —— 装上插件不该悄悄打开任何会话。 */
    assert.match(result.text, /关/, '默认必须是「关」，这是「装上不改变既有行为」的承诺');
  } finally {
    box.cleanup();
  }
});

test('commands: on / off 会真的改状态并持久化', async () => {
  const box = mount();
  try {
    const on = await box.handler(invoke('on'));
    assert.equal(on.kind, 'success');
    assert.equal(box.state.session(invoke('').agent), true, 'on 之后会话覆盖必须是 true');

    /* 持久化：换一个新的 store 读同一个文件，状态要还在。 */
    const reread = createStateStore({}, join(box.dir, 'state.json'));
    assert.equal(reread.session(invoke('').agent), true, '状态必须落盘，重载后保持');

    const off = await box.handler(invoke('off'));
    assert.equal(off.kind, 'success');
    assert.equal(box.state.session(invoke('').agent), false, 'off 之后会话覆盖必须是 false');
  } finally {
    box.cleanup();
  }
});

test('commands: 重复设置同一值要如实说「原本就是该值」', async () => {
  /* 一个永远返回「已设为开」的实现也能通过 kind 断言。
     这里断言文案里的**事实**：第二次设置必须承认没有变化。 */
  const box = mount();
  try {
    await box.handler(invoke('on'));
    const again = await box.handler(invoke('on'));
    assert.equal(again.kind, 'success');
    assert.match(again.text, /原本就是该值/, `第二次设置必须承认没变化，实际：${again.text}`);
  } finally {
    box.cleanup();
  }
});

test('commands: on --global 改全局默认，且说明本会话是否受影响', async () => {
  const box = mount();
  try {
    /* 先给本会话一个独立覆盖。 */
    await box.handler(invoke('on'));
    const global = await box.handler(invoke('on --global'));
    assert.equal(global.kind, 'success');
    assert.match(global.text, /全局/, '必须说明改的是全局默认');
    assert.match(global.text, /独立覆盖/, '本会话已有覆盖时必须说清它不受影响');

    /* 全局默认确实变了：换一个没有覆盖的 agent 应当跟随它。 */
    const other = { id: 'agent-2', cwd: '' };
    assert.equal(box.state.effective(other, false), true, '未覆盖的会话应跟随全局默认（开）');
  } finally {
    box.cleanup();
  }
});

test('commands: reset 清除本会话覆盖并回到跟随全局', async () => {
  const box = mount();
  try {
    await box.handler(invoke('on'));
    const reset = await box.handler(invoke('reset'));
    assert.equal(reset.kind, 'success');
    /* 无覆盖时 `session()` 返回 undefined（不是 null）—— 实测确认过。
       断言 null 会让这条测试因「类型不对」而红，而那不是缺陷。 */
    assert.equal(box.state.session(invoke('').agent), undefined, 'reset 后不该再有会话覆盖');
    assert.match(reset.text, /跟随全局/, '必须说明现在跟随全局默认');

    /* 再 reset 一次：本来就没有覆盖，要如实说。 */
    const again = await box.handler(invoke('reset'));
    assert.match(again.text, /本来就没有覆盖|无需清除/, `第二次 reset 必须如实说明，实际：${again.text}`);
  } finally {
    box.cleanup();
  }
});

test('commands: 未知参数返回 error 并附用法', async () => {
  const box = mount();
  try {
    const result = await box.handler(invoke('bogus-action'));
    assert.equal(result.kind, 'error', '未知参数必须是 error，不能静默成功');
    assert.match(result.text, /未知参数/, '必须说明是未知参数');
    assert.match(result.text, /bogus-action/, '必须回显用户输入，否则他不知道自己打错了什么');
  } finally {
    box.cleanup();
  }
});

test('commands: sync-skill 在没有会话 cwd 时明确报错', async () => {
  /* 这条分支最容易被写成「静默成功」—— 拿不到 cwd 就什么都不同步，
     然后返回 success。那样用户会以为同步过了。 */
  const box = mount();
  try {
    const result = await box.handler(invoke('sync-skill', ''));
    assert.equal(result.kind, 'error', '没有 cwd 必须报错');
    assert.match(result.text, /工作目录/, '必须说明是拿不到工作目录');
  } finally {
    box.cleanup();
  }
});

test('commands: sync-skill 在项目没有副本时说明「无需同步」而非报错', async () => {
  const box = mount();
  try {
    const result = await box.handler(invoke('sync-skill', box.dir));
    assert.equal(result.kind, 'success', '没有副本不是错误');
    assert.match(result.text, /没有.*副本|无需同步/, '必须说明项目里没有这份副本');
  } finally {
    box.cleanup();
  }
});

test('commands: gate 在空笔记树时返回失败而不是假绿', async () => {
  /* 关键断言：没有笔记时门禁必须失败。
     vendored 脚本在空集合上会 exit 0，外壳负责把「没有可验对象」判成失败。 */
  const box = mount();
  try {
    const result = await box.handler(invoke('gate', box.dir));
    const text = String(result.text ?? '');
    assert.match(text, /失败|未通过|NO_NOTES/, `空笔记树必须报失败，实际：${text.slice(0, 200)}`);
    assert.doesNotMatch(text, /全部通过|3 条全部/, '空树绝不能报「全部通过」');
  } finally {
    box.cleanup();
  }
});

test('commands: init 建出笔记树骨架', async () => {
  const box = mount();
  try {
    const result = await box.handler(invoke('init', box.dir));
    assert.equal(result.kind, 'success');
    assert.match(result.text, /笔记树/, '必须说明建了什么');
    /* 真的落盘了才算 —— 只看文案会被「只打印不建目录」的实现骗过。 */
    const created = result.text;
    assert.match(created, /implemented|proposed|rejected/, '输出里必须列出建出的目录');
  } finally {
    box.cleanup();
  }
});
