/**
 * `agent_notes_gate` / `agent_notes_status` 两个工具的行为测试。
 *
 * ## 为什么单独测
 *
 * `lib/tools.js`（144 行）此前**零直接测试覆盖**。这两个工具是模型
 * 在对话里真正调用的入口 —— 它们返回的 `passed` 会被模型当作
 * 「门禁通过了吗」的依据，所以**返回值的诚实性**是这里最重要的断言。
 *
 * 策略与 commands.test.mjs 一致：用真实的 notes / state 服务，
 * 只桩 DSH 的 ctx 外壳。
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { registerTools } from '../lib/tools.js';
import { createStateStore } from '../lib/state.js';
import { createNotesService } from '../lib/notes.js';

/**
 * 造一个能承载工具的假 ctx，返回按名字索引的工具表。
 *
 * @param {{enabled?: boolean, notesRoot?: string, sessionCwd?: string}} [options] 选项。
 * @returns {{tools: Record<string, any>, dir: string, state: any, cleanup: () => void}} 结果。
 */
function mount(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'an-tool-'));
  const state = createStateStore({}, join(dir, 'state.json'));
  const notes = createNotesService({}, options.notesRoot);

  const registered = new Map();
  const ctx = {};
  /**
   * `sessions` 服务是 resolveTargetCwd 的唯一 cwd 来源。
   * 实测踩过：不给它，所有工具都返回 NO_SESSION_CWD ——
   * 那**不是缺陷**（插件的设计就是「宁可报错也不猜 process.cwd()」），
   * 而是这个 mock 必须提供的依赖。
   */
  ctx.get = (name) => {
    if (name !== 'sessions') return undefined;
    return {
      get: () => {
        const value = typeof options.sessionCwd === 'function' ? options.sessionCwd() : options.sessionCwd;
        /* 结构必须是 `{ header: { cwd } }` —— 实测踩过：返回 `{ cwd }` 时
           resolveTargetCwd 读不到（它读 `sessions.get(id)?.header`），
           于是报「该会话尚未加载或没有记录工作目录」。 */
        return value === undefined ? undefined : { header: { cwd: value } };
      }
    };
  };
  ctx.sessions = ctx.get('sessions');

  ctx.inject = (deps, callback) => {
    /* `effect` 挂在 subCtx 上（`subCtx.effect(...)`）—— 实测踩过：
       只给顶层 ctx 挂会报 `subCtx.effect is not a function`。 */
    if (deps.includes('tools')) {
      callback({
        tools: {
          register(definition) {
            registered.set(definition.name, definition);
            return () => {};
          }
        },
        effect(fn) {
          fn();
          return () => {};
        }
      });
    }
    return () => {};
  };

  registerTools(ctx, {
    state,
    notes,
    effective: (agent) => state.effective(agent, options.enabled === true),
    config: { registerTools: true, enabled: options.enabled === true }
  });

  return {
    tools: Object.fromEntries(registered),
    dir,
    state,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

/**
 * 造一个带笔记树的最小仓库。
 *
 * @param {string} dir 仓库目录。
 * @param {boolean} [withNotes] 是否放一篇合规笔记。
 */
function seedRepo(dir, withNotes = true) {
  mkdirSync(join(dir, '.git'), { recursive: true });
  if (!withNotes) return;
  const noteDir = join(dir, '.agents', 'notes', 'implemented', 'feature');
  mkdirSync(noteDir, { recursive: true });
  writeFileSync(join(noteDir, '2026-01-01-a.md'), [
    '# Agent Note: a',
    '',
    'Status: implemented',
    '',
    '## Problem',
    '',
    'x',
    '',
    '## Decision',
    '',
    'y',
    '',
    '## Alternatives considered',
    '',
    '无',
    '',
    '## Consequences',
    '',
    'z',
    ''
  ].join('\n'), 'utf8');
}

/**
 * 造 exec 上下文。
 *
 * **注意**：cwd 不从这里传 —— 它由 `sessions` 服务提供（见 mount 的 sessionCwd）。
 * 实测确认：只把 cwd 放在 agent 上，resolveTargetCwd 读不到，会返回 NO_SESSION_CWD。
 *
 * @returns {{agent: {id: string}, signal: AbortSignal}} exec。
 */
function exec() {
  return { agent: { id: 'agent-1' }, signal: new AbortController().signal };
}

test('tools: 注册了两个工具，名字带前缀', () => {
  const box = mount();
  try {
    assert.ok(box.tools.agent_notes_gate !== undefined, '应有 agent_notes_gate');
    assert.ok(box.tools.agent_notes_status !== undefined, '应有 agent_notes_status');
  } finally {
    box.cleanup();
  }
});

test('tools: gate 在没有会话 cwd 时返回 passed:false，不猜 process.cwd()', async () => {
  /* 这是最关键的诚实性断言：拿不到会话 cwd 时**必须**明确失败。
     若它退回 process.cwd()，会在 DSH 自己的进程目录上跑出「真绿」——
     那是比报错严重得多的失效。 */
  const box = mount();
  try {
    const result = await box.tools.agent_notes_gate.execute({}, { agent: { id: 'a' }, signal: undefined });
    assert.equal(result.passed, false, '没有 cwd 必须 passed:false');
    assert.equal(result.notesRoot, null, '不该编造一个 notesRoot');
    assert.equal(result.repoRoot, null, '不该编造一个 repoRoot');
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0, '必须给出可读原因');
  } finally {
    box.cleanup();
  }
});

test('tools: gate 在空笔记树时 passed:false，且 noteCount 如实为 0', async () => {
  /* 空树时 vendored 脚本会 exit 0，外壳必须把「没有可验对象」判成失败。
     noteCount 要如实报 0 —— 否则模型会把「没东西可验」读成「验过了」。 */
  let box;
  box = mount({ sessionCwd: () => box.dir });
  try {
    seedRepo(box.dir, false);
    const result = await box.tools.agent_notes_gate.execute({}, exec());
    assert.equal(result.passed, false, '空笔记树必须 passed:false');
    assert.equal(result.noteCount, 0, 'noteCount 必须如实为 0');
  } finally {
    box.cleanup();
  }
});

test('tools: 只有根层散落 .md 时 noteCount 报 0，散落件单独报', async () => {
  /* 实测踩过的假绿在工具层的**第二处同款**：`noteCount` 原先取
     `inspect().files.length`（含根层散落件），于是「只放一个散落 .md」
     的树会返回 `passed:false` 但 `noteCount:1` —— 两个信号相互矛盾，
     模型读成「有笔记、只是门禁没过」，实际是「一篇笔记都没有」。
     现在与门禁同口径：笔记只数生命周期目录里的，散落件记 `strayCount`。 */
  let box;
  box = mount({ sessionCwd: () => box.dir });
  try {
    seedRepo(box.dir, false);
    const root = join(box.dir, '.agents', 'notes');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '2026-01-01-looks-like-a-note.md'), '# 散落\n', 'utf8');
    const result = await box.tools.agent_notes_gate.execute({}, exec());
    assert.equal(result.passed, false, '零篇笔记不许报通过');
    assert.equal(result.noteCount, 0, '散落件不算笔记，noteCount 必须是 0');
    assert.equal(result.strayCount, 1, '散落件必须单独报出来');
  } finally {
    box.cleanup();
  }
});

test('tools: gate 在合规笔记树上 passed:true，且报出笔记数', async () => {
  let box;
  box = mount({ sessionCwd: () => box.dir });
  try {
    seedRepo(box.dir, true);
    const result = await box.tools.agent_notes_gate.execute({}, exec());
    assert.equal(result.passed, true, `合规树应通过，实际：${JSON.stringify(result).slice(0, 300)}`);
    assert.equal(result.noteCount, 1, '必须报出真实的笔记数');
    assert.ok(Array.isArray(result.results) && result.results.length === 3, '全跑时应有 3 条门禁结果');
    /* 每条都要带真实退出码 —— 没有 exitCode 的「通过」无法验证。 */
    for (const entry of result.results) {
      assert.equal(typeof entry.exitCode, 'number', `${entry.gate} 必须带 exitCode`);
      assert.equal(entry.exitCode, 0, `${entry.gate} 通过时 exitCode 应为 0`);
    }
  } finally {
    box.cleanup();
  }
});

test('tools: gate 指定单个门禁时只跑那一条', async () => {
  let box;
  box = mount({ sessionCwd: () => box.dir });
  try {
    seedRepo(box.dir, true);
    const result = await box.tools.agent_notes_gate.execute({ gate: 'format' }, exec());
    assert.equal(result.results.length, 1, '指定 gate 时只该跑一条');
    assert.equal(result.results[0].gate, 'format', '跑的必须是指定的那条');
  } finally {
    box.cleanup();
  }
});

test('tools: status 返回真实的开关与笔记树概况', async () => {
  let box;
  box = mount({ sessionCwd: () => box.dir });
  try {
    seedRepo(box.dir, true);
    const result = await box.tools.agent_notes_status.execute({}, exec());
    assert.equal(result.cwd, box.dir, 'cwd 必须是会话工作目录');
    assert.equal(result.notesExist, true, '笔记树存在时 notesExist 应为 true');
    assert.equal(result.enabled, false, '默认关闭');
    assert.equal(typeof result.stateFile, 'string', '必须报出状态文件路径');
    /* counts 要能看出有 1 篇 —— 只报 exists 不报数量，模型无法判断规模。 */
    const total = Object.values(result.counts ?? {}).reduce((a, b) => a + b, 0);
    assert.ok(total >= 1, `counts 应反映至少 1 篇笔记，实际：${JSON.stringify(result.counts)}`);
  } finally {
    box.cleanup();
  }
});

test('tools: status 在没有会话 cwd 时如实说「不知道」，不指向 process.cwd()', async () => {
  const box = mount();
  try {
    const result = await box.tools.agent_notes_status.execute({}, { agent: { id: 'a' }, signal: undefined });
    assert.equal(result.cwd, null, 'cwd 必须是 null 而不是某个猜测值');
    assert.equal(result.notesRoot, null, 'notesRoot 必须是 null');
    assert.equal(result.notesExist, false, '不知道时不能说笔记树存在');
    assert.ok(typeof result.cwdUnresolved === 'string', '必须说明为什么解析不出 cwd');
  } finally {
    box.cleanup();
  }
});
