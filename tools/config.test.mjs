/**
 * `apply()` 编排层的 config 开关组合测试。
 *
 * ## 为什么单独一份
 *
 * `integration.test.mjs` 验的是「挂到宿主上会怎样」——宿主能力在不在、
 * 注册参数形状对不对。但那些用例几乎都用 `config: { enabled: true }`，
 * **其余四个开关（injectPolicy / registerTools / registerCommands /
 * notesRoot）从未被显式设成 false 或自定义值测过**。
 *
 * 这留下一个真实的失效面：把 `if (resolved.injectPolicy)` 写成
 * `if (resolved.injectPolicy || true)`、或者把 registerTools 的默认值从
 * true 改成 false，现有测试**全绿**——因为它们从来只看「默认路径」，
 * 而默认路径恰好两边都走得通。
 *
 * 本文件因此只做一件事：把每个开关注入成非默认值，断言行为真的变了。
 *
 * ## 复用而非复制
 *
 * 挂载外壳（含真 Cordis 优先、退化成同契约承接器）与 `integration.test.mjs`
 * 共用同一份实现，避免两处外壳各自漂移 —— 那种漂移会让「一份测试绿、
 * 另一份红」变成维护者的日常困惑。
 */
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { mountHarness } from './harness.mjs';

/** 造一个临时目录，测试结束删掉。 */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'an-config-'));
}

test('config: 不传任何配置时，默认关闭且其余四项为真', () => {
  /* 默认值不是随手写的，每一条都有理由：
     - enabled:false —— 装上插件不该悄悄改变既有会话的行为（**最重要的一条**）；
     - injectPolicy:true —— 打开开关时规范段要能用；
     - registerTools / registerCommands:true —— 核心功能，默认该有。

     只断言「provider/tools/commands 被注册了」验不到 enabled 的默认值 ——
     那三样与 enabled 无关。所以这里必须**通过行为**观察：让一个会话创建，
     检查规范段有没有被挂上。默认关闭意味着不挂。 */
  const dir = tempDir();
  try {
    const { registered } = mountHarness({ stateFile: join(dir, 'state.json'), config: {} });

    assert.equal(registered.providers.length, 1, '技能 provider 必须注册（唯一必需能力）');
    assert.ok(registered.tools.length > 0, '默认应注册门禁工具');
    assert.ok(registered.commands.length > 0, '默认应注册 /agent-notes 命令');

    /* 关键：默认关闭 → 新会话不该挂规范段。
       **会话必须带可用的 systemPrompt.section**，否则每条路径都挂不上，
       把默认值从 false 改成 true 也测不出来 —— 那样这条断言等于空的。
       下面第二个用例是它的对照组。 */
    const agentCtx = {
      systemPrompt: {
        section(section) {
          registered.sections.push(section);
          return () => {
            const index = registered.sections.indexOf(section);
            if (index >= 0) registered.sections.splice(index, 1);
          };
        },
        getSectionOrder() { return 0; }
      }
    };
    for (const listener of registered.listeners.get('agent/created') ?? []) {
      listener({ agent: { id: 'session-default', cwd: dir, ctx: agentCtx } });
    }
    assert.deepEqual(registered.sections, [],
      '不配 enabled 时必须默认关闭：新会话不得挂规范段');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: registerTools=false 时不注册任何工具', () => {
  /* 关掉工具是给「只想注入规范、不给模型开 shell 能力」的保守部署用的。
     若这条失效，那种部署会意外获得能执行子进程的工具 —— 是安全层面的回归。 */
  const dir = tempDir();
  try {
    const { registered } = mountHarness({
      stateFile: join(dir, 'state.json'),
      config: { enabled: true, registerTools: false }
    });
    assert.deepEqual(registered.tools, [], 'registerTools:false 必须真的一个工具都不注册');
    assert.ok(registered.commands.length > 0, '命令不受影响（两个开关独立）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: registerCommands=false 时不注册命令，但工具仍在', () => {
  /* 两个开关必须彼此独立。写成一个开关控制两者，会让想关命令的人
     连工具一起关掉，反之亦然。 */
  const dir = tempDir();
  try {
    const { registered } = mountHarness({
      stateFile: join(dir, 'state.json'),
      config: { enabled: true, registerCommands: false }
    });
    assert.deepEqual(registered.commands, [], 'registerCommands:false 必须真的不注册命令');
    assert.ok(registered.tools.length > 0, '工具不受影响');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: injectPolicy=false 时开关打开也不挂规范段', () => {
  /* 这是「只想要门禁工具、不要系统提示词注入」的用法。
     失效的表现很隐蔽：模型会突然开始遵守一套用户以为关掉了的规范。

     **会话必须带可用的 systemPrompt.section** —— 否则每条路径都挂不上，
     injectPolicy 写死成 true 也测不出来（第一版就是这么假的：
     给的是 `ctx: {}`，于是断言在任何实现下都通过）。 */
  const dir = tempDir();
  try {
    const { registered } = mountHarness({
      stateFile: join(dir, 'state.json'),
      config: { enabled: true, injectPolicy: false }
    });

    /** 造一个带 systemPrompt 的会话上下文，挂 section 会被登记。 */
    const agentCtx = {
      systemPrompt: {
        section(section) {
          registered.sections.push(section);
          return () => {
            const index = registered.sections.indexOf(section);
            if (index >= 0) registered.sections.splice(index, 1);
          };
        },
        getSectionOrder() { return 0; }
      }
    };

    for (const listener of registered.listeners.get('agent/created') ?? []) {
      listener({ agent: { id: 'session-x', cwd: dir, ctx: agentCtx } });
    }
    assert.deepEqual(registered.sections, [],
      'injectPolicy:false 时必须挂得上却没挂（否则这条测不出开关）');

    /* 反向验证：这条路径本身是通的 —— 把 injectPolicy 打开后同样的
       会话必须真的挂上。否则上面「没挂」可能只是因为路径根本不通。 */
    const second = mountHarness({
      stateFile: join(dir, 'state-2.json'),
      config: { enabled: true, injectPolicy: true }
    });
    const agentCtx2 = {
      systemPrompt: {
        section(section) {
          second.registered.sections.push(section);
          return () => {
            const index = second.registered.sections.indexOf(section);
            if (index >= 0) second.registered.sections.splice(index, 1);
          };
        },
        getSectionOrder() { return 0; }
      }
    };
    for (const listener of second.registered.listeners.get('agent/created') ?? []) {
      listener({ agent: { id: 'session-y', cwd: dir, ctx: agentCtx2 } });
    }
    assert.equal(second.registered.sections.length, 1,
      '对照组：injectPolicy:true 时同一个会话必须真的挂上规范段');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: 两个注册开关都关时，provider 与投影仍然建立', () => {
  /* 极简部署：只保留「开关状态 + 投影」这条链路，不要工具不要命令。
     这条用来确认关掉那两个开关不会连带把核心链路一起关掉。 */
  const dir = tempDir();
  try {
    const { registered } = mountHarness({
      stateFile: join(dir, 'state.json'),
      config: { enabled: false, registerTools: false, registerCommands: false }
    });
    assert.equal(registered.providers.length, 1, '技能 provider 仍然要注册');
    assert.deepEqual(registered.tools, []);
    assert.deepEqual(registered.commands, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: stateFile 指向自定义路径时，状态真的落在那里', async () => {
  /* 默认路径在 DSH home 下，测试若误用真实路径会污染用户的开关状态。
     这条确认自定义路径真的生效 —— 它是所有测试彼此隔离的基础。 */
  const dir = tempDir();
  try {
    const stateFile = join(dir, 'custom-state.json');
    const { registered } = mountHarness({ stateFile, config: { enabled: true } });

    /* 通过命令改状态，观察落盘位置。
       命令描述符的入口是 handler(invocation)，不是 run(args) —— 猜错过一次。 */
    const command = registered.commands.find((c) => c.name === 'agent-notes');
    assert.ok(command !== undefined, '必须能拿到 /agent-notes 命令');
    assert.equal(typeof command.handler, 'function', '命令必须暴露 handler');
    await command.handler({
      rawInput: 'off',
      agent: { id: 'session-a', ctx: {} }
    });

    assert.ok(existsSync(stateFile), `状态必须写到自定义路径 ${stateFile}`);
    const written = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.ok(typeof written === 'object' && written !== null, '落盘内容是 JSON 对象');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: notesRoot 覆盖时，笔记树真的建在自定义位置', async () => {
  /* notesRoot 是给「笔记不在 <cwd>/.agents/notes」的项目用的逃生口。
     失效的表现是门禁永远说「没有笔记树」，或建到别处去。

     用 init 命令真建一次目录来验证 —— 这是唯一不可伪造的证据：
     命令描述符上不暴露 notes 服务，任何「读某个内部字段」的断言都是在猜。 */
  const dir = tempDir();
  try {
    const customRoot = join(dir, 'my-notes');
    const { registered } = mountHarness({
      stateFile: join(dir, 'state.json'),
      config: { enabled: true, notesRoot: customRoot }
    });

    const command = registered.commands.find((c) => c.name === 'agent-notes');
    assert.ok(command !== undefined, '必须能拿到命令');

    const result = await command.handler({
      rawInput: 'init',
      agent: { id: 'session-n', cwd: dir, ctx: {} }
    });
    assert.equal(result.kind, 'success', `init 应成功，实际：${result.text}`);

    assert.ok(existsSync(customRoot),
      `笔记树必须建在自定义根 ${customRoot}，实际返回：${result.text}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: 所有开关都关掉时也不崩（最保守组合）', () => {
  /* 防御性用例：把能关的都关掉，插件仍要能挂载。
     崩掉会让用户无法通过改配置救回来，只能卸插件。 */
  const dir = tempDir();
  try {
    assert.doesNotThrow(() => {
      mountHarness({
        stateFile: join(dir, 'state.json'),
        config: {
          enabled: false,
          injectPolicy: false,
          registerTools: false,
          registerCommands: false
        }
      });
    }, '全关组合下 apply 不得抛错');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
