/**
 * 测试共用的宿主挂载外壳。
 *
 * 为什么独立成文件：integration.test.mjs 与 config.test.mjs 都需要
 * 「造宿主 → 挂载插件 → 拿到登记表」。两处各写一份的话，一旦外壳漂移，
 * 会出现「一份测试绿、另一份红」的困惑 —— 而外壳本身不是被测对象，
 * 不该成为不一致来源。
 *
 * 外壳策略：优先用真实的 Cordis Context（profile 里可解析时），
 * 确保走的是宿主同一套调度；解析不到时退化为**同契约**的最小承接器，
 * 并在 mode 里如实标注，不把自制品冒充成 Cordis。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { apply as applyPlugin } from '../lib/index.js';

/** mount 造出来的技能沙箱，进程退出时统一删除。 */
const SKILL_SANDBOXES = [];
process.on('exit', () => {
  for (const dir of SKILL_SANDBOXES) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});

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
  /* 自更新目标必须指到沙箱（实测踩过，代价极高）：
     apply() 里 scheduleSkillUpdate 是 fire-and-forget，默认目标是**真实的**
     skills/agent-notes。CI 上曾因此把刚检出的新版 vendored 文件覆盖成旧版
     （本仓库的 .synced-version 未被 git 跟踪，全新 clone 没有它 → 快速路径
     失效 → 真去拉 jsDelivr @main 的 21 个文件；而推送瞬间 CDN 上的 @main
     仍指向上一个 commit），导致后续 sync-upstream 的 --check 报「变更 6」。
     这里每个测试一份沙箱，不依赖时序巧合。 */
  const skillSandbox = mkdtempSync(join(tmpdir(), 'an-int-skill-'));
  /* 进程退出时统一清理：这些沙箱是 mount 内部造出来的，测试拿不到它，
     没法各自 finally 删；攒到退出时删，避免 /tmp 里堆垃圾。 */
  SKILL_SANDBOXES.push(skillSandbox);
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
    applyPlugin(ctx, {
      stateFile: options.stateFile,
      skillDir: skillSandbox,
      ...(options.config ?? { enabled: true })
    });
    return { ctx, registered, mode, skillSandbox };
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
  applyPlugin(ctx, {
    stateFile: options.stateFile,
    skillDir: skillSandbox,
    ...(options.config ?? { enabled: true })
  });
  return { ctx, registered, mode, skillSandbox };
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


export { mount as mountHarness, tempState, emit };
