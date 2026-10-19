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

/* 挂载外壳与 config.test.mjs 共用同一份实现（tools/harness.mjs）：
   外壳不是被测对象，两处各写一份会让它成为不一致的来源。 */
import { mountHarness as mount, tempState, emit } from './harness.mjs';

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
