/**
 * 集成验证：用**真实 Cordis 上下文**挂载本插件，验证宿主契约真的被满足。
 *
 * 与 plugin.test.mjs 的分工：那边测纯函数与外部脚本，这边测「挂到 DSH 上会怎样」。
 * 会真注册 provider、真注册工具、真注册命令、真读写状态文件。
 *
 * 宿主服务用最小真实现（不是 mock 掉行为，而是实现同样的契约）：
 *   skills.registerProvider / tools.register / commands.register / systemPrompt.section
 * 这样能验证：注册参数形状对不对、能力缺失时是否优雅降级、
 * 开关关闭时规范段是否真的不挂。
 *
 * 用真实 DSH 的 cordis 包（profile 里可解析），确保是同一套调度。
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { apply as applyPlugin } from '../lib/index.js';

/**
 * 取真实的 Cordis `Context`。
 *
 * 实测：`@deepseek-ai/cordis` 只在 DSH 自身的 node_modules 里可解析
 * （profile 的 node_modules 是空的，插件侧不可解析）。因此从 DSH 安装位置
 * 解析，用的是**宿主真正在用的那一份** cordis，而不是测试自造品。
 *
 * 不硬编码本机路径：优先 $DSH_DIST，其次从本文件向上探测 node_modules。
 * 取不到时退化为同契约承接器并在测试输出里标注（不伪造同名类冒充）。
 *
 * @returns {any | undefined} 真实的 Cordis Context 类，未找到时为 undefined。
 */
function loadCordisContext() {
  const { existsSync } = createRequire(import.meta.url)('node:fs');
  const { dirname } = createRequire(import.meta.url)('node:path');

  const candidates = [];
  if (typeof process.env.DSH_DIST === 'string' && process.env.DSH_DIST.trim() !== '') {
    candidates.push(process.env.DSH_DIST.trim());
  }
  if (typeof process.env.DSH_PACKAGE_ROOT === 'string' && process.env.DSH_PACKAGE_ROOT.trim() !== '') {
    candidates.push(join(process.env.DSH_PACKAGE_ROOT.trim(), 'lib', 'bin.js'));
  }
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    candidates.push(join(cursor, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  for (const anchor of candidates) {
    if (!existsSync(anchor)) continue;
    try {
      const require = createRequire(anchor);
      const resolved = require.resolve('@deepseek-ai/cordis');
      return createRequire(resolved)('@deepseek-ai/cordis').Context;
    } catch {
      // 换下一个锚点。
    }
  }
  return undefined;
}

const CordisContext = loadCordisContext();

/** 造一个临时状态文件路径。 */
function tempState() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-notes-int-'));
  return { dir, file: join(dir, 'state.json') };
}

/**
 * 用一个承接注册的宿主外壳。
 *
 * 真的 Cordis `Context` 可用时用它（插件会走真实的服务解析与 effect 调度）；
 * 不可用时退化为「同样契约的最小承接器」，并在测试里显式标注模式——
 * 不把自制外壳冒充成 Cordis。
 *
 * @returns {{ ctx: any, mode: 'cordis' | 'harness' }} 上下文与所用模式。
 */
function createHost() {
  if (CordisContext !== undefined) {
    return { ctx: new CordisContext(), mode: 'cordis' };
  }
  return { ctx: {}, mode: 'harness' };
}

/**
 * 用最小真实现装出宿主服务，挂载插件。
 *
 * 宿主服务不是把行为 mock 掉，而是实现同样的契约：注册即登记、section 返回
 * disposer、effect 立即执行。这样才能验证注册参数形状与降级路径。
 *
 * @param {{ stateFile: string, withTools?: boolean, withCommands?: boolean, withPrompt?: boolean }} options 选项。
 * @returns {{ ctx: any, registered: any, mode: string }} 上下文、登记表与模式。
 */
function mount(options) {
  const { ctx, mode } = createHost();
  const registered = {
    providers: [],
    tools: [],
    commands: [],
    sections: [],
    sectionsDisposed: 0,
    effects: [],
    listeners: new Map()
  };

  const services = {
    skills: {
      registerProvider(create) {
        const provider = create({ signal: new AbortController().signal, invalidate() {} });
        registered.providers.push(provider);
        return () => {};
      }
    }
  };

  if (options.withTools !== false) {
    services.tools = {
      register(definition) {
        registered.tools.push(definition);
        return () => {};
      }
    };
  }

  if (options.withCommands !== false) {
    services.commands = {
      register(definition) {
        registered.commands.push(definition);
        return () => {};
      }
    };
  }

  if (options.withPrompt !== false) {
    services.systemPrompt = {
      section(section) {
        registered.sections.push(section);
        return () => {
          registered.sectionsDisposed += 1;
          const index = registered.sections.indexOf(section);
          if (index >= 0) registered.sections.splice(index, 1);
        };
      },
      getSectionOrder() {
        return 0;
      }
    };
  }

  // agents 服务：插件用 ctx.inject(['agents']) 拿它（属性访问 ctx.agents 在
  // Cordis 下会抛，实测踩过）。桩必须提供，否则规范段永远不会挂 —— 那样
  // 测试会红，正好说明这条依赖是真的。
  if (options.withAgents !== false) {
    services.agents = {
      /** 当前已知的 agent 列表；测试用 registered.agentList 注入。 */
      list() {
        return registered.agentList ?? [];
      }
    };
  }

  if (mode === 'cordis') {
    // 真 Cordis 要求先 provide 再 set（未 provide 直接 set 会抛）。
    for (const [key, value] of Object.entries(services)) {
      ctx.provide(key);
      ctx.set(key, value);
    }
    // 真 Cordis 的 inject 在服务齐备时立即回调；缺服务时静默不回调（正是要测的降级路径）。
    ctx.inject = (deps, callback) => {
      if (deps.every((dep) => ctx.get(dep) !== undefined)) return callback(ctx);
      return () => {};
    };
    // 记录监听器，便于测试主动触发 agent/created（否则只能等真实 agent 出现）。
    ctx.on = (event, listener) => {
      const list = registered.listeners.get(event) ?? [];
      list.push(listener);
      registered.listeners.set(event, list);
      return () => {
        const current = registered.listeners.get(event) ?? [];
        const index = current.indexOf(listener);
        if (index >= 0) current.splice(index, 1);
      };
    };
    applyPlugin(ctx, { stateFile: options.stateFile, ...(options.config ?? { enabled: true }) });
    return { ctx, registered, mode };
  }

  // 承接器模式：把服务直接挂到 ctx 上，并提供 inject / effect / on 的同语义实现。
  Object.assign(ctx, services);
  ctx.inject = (deps, callback) => {
    if (deps.every((dep) => ctx[dep] !== undefined)) return callback(ctx);
    return () => {};
  };
  ctx.effect = (callback, label) => {
    const disposer = callback();
    registered.effects.push({ label, disposer });
    return () => disposer?.();
  };
  ctx.on = (event, listener) => {
    const list = registered.listeners.get(event) ?? [];
    list.push(listener);
    registered.listeners.set(event, list);
    return () => {};
  };
  applyPlugin(ctx, { stateFile: options.stateFile, ...(options.config ?? { enabled: true }) });
  return { ctx, registered, mode };
}

/**
 * 触发一个宿主事件（模拟真实生命周期）。
 *
 * @param {any} registered mount 返回的登记表。
 * @param {string} event 事件名。
 * @param {any} payload 事件载荷。
 */
function emit(registered, event, payload) {
  for (const listener of registered.listeners.get(event) ?? []) listener(payload);
}

test('集成：真 Cordis 上下文挂载后，技能 provider 可列出并读取', async () => {
  const { dir, file } = tempState();
  try {
    const { registered, mode } = mount({ stateFile: file });
    console.log(`    （宿主模式: ${mode}${mode === 'harness' ? ' — 未找到真 Cordis，使用同契约承接器' : ' — 使用 DSH 自带的真实 Cordis'}）`);
    assert.equal(registered.providers.length, 1, '必须注册一个技能 provider');

    const provider = registered.providers[0];
    assert.equal(provider.name, 'agent-notes');
    const listed = await provider.list();
    assert.equal(listed.candidates.length, 1, '应列出 agent-notes 技能');
    assert.equal(listed.candidates[0].name, 'agent-notes');
    assert.equal(listed.candidates[0].source, 'bundled');

    const definition = await provider.get(listed.candidates[0]);
    assert.ok(definition.content.length > 500, '技能正文应有实质内容');
    assert.equal(definition.content.startsWith('---'), false, '正文必须剥掉 frontmatter');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('集成：工具与命令真注册，且形状符合宿主契约', () => {
  const { dir, file } = tempState();
  try {
    const { registered } = mount({ stateFile: file });

    const names = registered.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['agent_notes_gate', 'agent_notes_status'], '应注册两个工具');
    for (const tool of registered.tools) {
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.length > 10, `${tool.name} 应有可读描述`);
      assert.equal(typeof tool.parameters, 'object');
      assert.equal(tool.parameters.type, 'object', `${tool.name} 参数应为 object schema`);
      assert.equal(typeof tool.output?.schema, 'object', `${tool.name} 应声明输出 schema`);
      assert.equal(typeof tool.output?.render, 'function', `${tool.name} 应提供 render`);
      assert.equal(typeof tool.execute, 'function');
    }

    assert.equal(registered.commands.length, 1, '应注册一个命令');
    const command = registered.commands[0];
    assert.equal(command.name, 'agent-notes', '命令名不得带前导斜杠');
    assert.equal(typeof command.description, 'string');
    assert.equal(typeof command.handler, 'function');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('集成：/agent-notes 命令真驱动开关并落盘', async () => {
  const { dir, file } = tempState();
  try {
    const { registered } = mount({ stateFile: file });
    const command = registered.commands[0];
    const agent = { id: 'sess-int-1', cwd: dir };

    // 初始应跟随兜底（开）。
    const initial = await command.handler({ agent, rawInput: '', signal: new AbortController().signal });
    assert.equal(initial.kind, 'success');
    assert.match(initial.text, /决策笔记: 开/);

    // 关掉本会话。
    const off = await command.handler({ agent, rawInput: 'off', signal: new AbortController().signal });
    assert.equal(off.kind, 'success');
    assert.match(off.text, /已设「关」/);

    // 真读状态文件确认落盘（不是只看返回值）。
    const state = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(state.sessions['sess-int-1'], false, '会话覆盖必须真写盘');

    // 状态回显应反映关闭。
    const after = await command.handler({ agent, rawInput: 'status', signal: new AbortController().signal });
    assert.match(after.text, /决策笔记: 关/);
    assert.match(after.text, /本会话  : 关/);

    // 全局切换。
    const globalOff = await command.handler({ agent, rawInput: 'on --global', signal: new AbortController().signal });
    assert.match(globalOff.text, /全局默认/);
    const globalState = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(globalState.global, true, '全局默认必须真写盘');

    // reset 清覆盖。
    const reset = await command.handler({ agent, rawInput: 'reset', signal: new AbortController().signal });
    assert.match(reset.text, /清除/);
    const afterReset = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal('sess-int-1' in afterReset.sessions, false, 'reset 必须真写盘');

    // 未知参数必须报错，不得静默成功。
    const bad = await command.handler({ agent, rawInput: 'nonsense', signal: new AbortController().signal });
    assert.equal(bad.kind, 'error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('集成：/agent-notes gate 真跑门禁，坏笔记必须让命令失败', async () => {
  const { dir, file } = tempState();
  try {
    const { registered } = mount({ stateFile: file });
    const command = registered.commands[0];
    const agent = { id: 'sess-gate', cwd: dir };

    // 先建一棵坏树：非法分类目录。
    const badDir = join(dir, '.agents', 'notes', 'implemented', 'refactor');
    mkdirSync(badDir, { recursive: true });
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(badDir, '2026-01-01-bad.md'),
      '# Agent Note: x\n\nStatus: implemented\n\n## Problem\np\n\n## Decision\nd\n\n## Alternatives considered\n- a\n\n## Consequences\n- c\n',
      'utf8');

    const result = await command.handler({ agent, rawInput: 'gate tree', signal: new AbortController().signal });
    assert.equal(result.kind, 'error', '门禁失败时命令必须返回 error');
    assert.match(result.text, /FAIL|exit=1/, '必须暴露失败与退出码');
    assert.match(result.text, /refactor/, '必须暴露具体诊断');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('集成：能力缺失时优雅降级，不崩', async () => {
  const { dir, file } = tempState();
  try {
    // 不给 tools / commands / systemPrompt。
    const { registered } = mount({ stateFile: file, withTools: false, withCommands: false, withPrompt: false });
    // 唯一必需的 skills 仍在，插件应正常挂载。
    assert.equal(registered.providers.length, 1, '缺可选能力时技能仍须注册');
    assert.equal(registered.tools.length, 0);
    assert.equal(registered.commands.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('集成：不配置 enabled 时默认关闭，新会话不挂规范段', () => {
  const { dir, file } = tempState();
  try {
    mkdirSync(dir, { recursive: true });
    // 关键：状态文件里连 global 字段都没有 —— 这正是「装上插件、什么都没设」
    // 的真实形态。旧行为会兜底成开，导致插件悄悄改变既有会话。
    writeFileSync(file, JSON.stringify({ version: 1, sessions: {} }), 'utf8');

    // 不传 enabled，走 apply 的默认值。
    const { registered } = mount({ stateFile: file, config: {} });
    emit(registered, 'agent/created', { agent: { id: 'sess-default', ctx: { systemPrompt: ctxPrompt(registered) } } });
    assert.equal(registered.sections.length, 0, '不配置时必须默认关闭，不得注入规范段');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('集成：显式配 enabled:true 时才默认打开（保留逃生口）', () => {
  const { dir, file } = tempState();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, sessions: {} }), 'utf8');

    const { registered } = mount({ stateFile: file, config: { enabled: true } });
    emit(registered, 'agent/created', { agent: { id: 'sess-on', ctx: { systemPrompt: ctxPrompt(registered) } } });
    assert.equal(registered.sections.length, 1, '显式 enabled:true 时应注入');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('集成：开关关闭时规范段不挂（新会话也不挂）', () => {
  const { dir, file } = tempState();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, global: false, sessions: {} }), 'utf8');

    const { registered } = mount({ stateFile: file });
    // 关键：即使新会话上线，也必须在关闭状态下不挂规范段。
    emit(registered, 'agent/created', { agent: { id: 'sess-off', ctx: { systemPrompt: ctxPrompt(registered) } } });
    assert.equal(registered.sections.length, 0, '全局默认关时新会话也不得挂规范段');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('集成：开关打开时新会话真挂上规范段，且含关键判据', () => {
  const { dir, file } = tempState();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, global: true, sessions: {} }), 'utf8');

    const { registered } = mount({ stateFile: file });
    assert.equal(registered.sections.length, 0, '还没有会话时不应有 section');

    emit(registered, 'agent/created', { agent: { id: 'sess-on', ctx: { systemPrompt: ctxPrompt(registered) } } });

    assert.equal(registered.sections.length, 1, '新会话上线时应挂规范段');
    const section = registered.sections[0];
    assert.equal(typeof section.text, 'string');
    assert.match(section.text, /非平凡/, '规范段必须含判定闸门');
    assert.match(section.text, /agent_notes_gate/, '规范段必须指向真门禁工具');
    assert.match(section.name, /agent-notes:policy/, 'section 名应带插件前缀，避免撞名');

    // 会话销毁必须卸载，不留悬挂 section。
    emit(registered, 'agent/disposed', { agent: { id: 'sess-on', ctx: {} } });
    assert.equal(registered.sections.length, 0, '会话销毁后必须卸载 section');
    assert.equal(registered.sectionsDisposed, 1, '卸载必须真的走 disposer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('集成：会话级覆盖优先于全局，且能反向切换', async () => {
  const { dir, file } = tempState();
  try {
    mkdirSync(dir, { recursive: true });
    // 全局开，但本会话预置为关。
    writeFileSync(file, JSON.stringify({ version: 1, global: true, sessions: { 'sess-override': false } }), 'utf8');

    const { registered } = mount({ stateFile: file });

    // 会话 A（跟随全局）应挂上。
    emit(registered, 'agent/created', { agent: { id: 'sess-follow', ctx: { systemPrompt: ctxPrompt(registered) } } });
    assert.equal(registered.sections.length, 1, '跟随全局的会话应挂');

    // 会话 B（显式关闭）不应挂。
    emit(registered, 'agent/created', { agent: { id: 'sess-override', ctx: { systemPrompt: ctxPrompt(registered) } } });
    assert.equal(registered.sections.length, 1, '显式关闭的会话不该挂 — 覆盖必须生效');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 造一个能承接 section 注册的会话作用域 systemPrompt，并登记到共享表。
 *
 * @param {any} registered 共享登记表。
 * @returns {any} 会话级 systemPrompt 服务。
 */
function ctxPrompt(registered) {
  return {
    section(section) {
      registered.sections.push(section);
      return () => {
        registered.sectionsDisposed += 1;
        const index = registered.sections.indexOf(section);
        if (index >= 0) registered.sections.splice(index, 1);
      };
    },
    getSectionOrder() {
      return 0;
    }
  };
}
