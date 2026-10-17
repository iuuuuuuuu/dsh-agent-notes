/**
 * dsh-agent-notes — 决策笔记（Agent Notes）作为 DSH 插件。
 *
 * 设计约束（实测得出，不是猜测）：
 *   profile 的 node_modules 里 @deepseek-ai 只解析到 cosmokit/schemastery，
 *   所以本包 **零运行时依赖**：只用 node 内建模块，宿主 API 全部按鸭子类型
 *   使用，缺失的能力降级而不是崩溃。这与同目录的 dsh-reverse-skill 同构。
 *
 * 本模块只负责组装；具体职责分在：
 *   lib/notes.js     —— 笔记树探测、门禁执行、归档
 *   lib/state.js     —— 全局默认 + 会话覆盖的持久化开关状态
 *   lib/skill.js     —— agent-notes 技能 provider（vendored 上游内容）
 *   lib/policy.js    —— 会话级系统提示词注入文本
 *   lib/commands.js  —— /agent-notes 斜杠命令
 *   lib/tools.js     —— 真门禁工具（shell 出 vendored 校验脚本）
 */
import { createNotesService } from './notes.js';
import { createStateStore } from './state.js';
import { createSkillProvider } from './skill.js';
import { buildPolicyText } from './policy.js';
import { registerCommands } from './commands.js';
import { registerTools } from './tools.js';

/** Cordis 插件名。 */
export const name = 'agent-notes';

/**
 * 依赖的服务。
 *
 * 只声明真正必须的：`skills` 用于技能 provider。其余（commands、tools、
 * systemPrompt、agents）通过 ctx.inject 可选获取，缺失时对应能力静默关闭，
 * 这样插件在 headless / minimal 组合里也能加载。
 */
export const inject = ['skills'];

/**
 * 插件配置。
 *
 * @typedef {object} AgentNotesConfig
 * @property {boolean} [enabled]          全局默认开关（新建会话的初值）。
 * @property {boolean} [injectPolicy]     是否注入会话级规范段。
 * @property {boolean} [registerTools]    是否注册门禁工具。
 * @property {boolean} [registerCommands] 是否注册 /agent-notes 命令。
 * @property {string}  [stateFile]        开关状态文件路径（默认 DSH home 下）。
 * @property {string}  [notesRoot]        笔记根覆盖（默认 <cwd>/.agents/notes）。
 */

/**
 * 安装插件。
 *
 * @param {any} ctx Cordis 上下文。
 * @param {AgentNotesConfig} [config] 插件配置。
 */
export function apply(ctx, config = {}) {
  const resolved = {
    enabled: config.enabled ?? true,
    injectPolicy: config.injectPolicy ?? true,
    registerTools: config.registerTools ?? true,
    registerCommands: config.registerCommands ?? true,
    stateFile: config.stateFile,
    notesRoot: config.notesRoot
  };

  const state = createStateStore(ctx, resolved.stateFile);
  const notes = createNotesService(ctx, resolved.notesRoot);

  // 技能 provider：唯一必需能力，注册失败要响。
  ctx.skills.registerProvider(() => createSkillProvider());

  /** 当前会话的生效开关：会话覆盖优先，否则取全局默认。 */
  const effective = (agent) => state.effective(agent);

  registerCommands(ctx, { state, notes, effective, config: resolved });
  registerTools(ctx, { state, notes, effective, config: resolved });

  if (resolved.injectPolicy) {
    installPolicy(ctx, { state, effective });
  }
}

/**
 * 把规范段注入**每个已存在与将来创建的 agent 的会话作用域**。
 *
 * 这是「L3：会话级注入」的核心：用 agent.ctx（会话作用域）注册 section，
 * 因此只影响该会话，不污染全局系统提示词；开关关闭时 section 直接不注册，
 * 连一次查询都不占。
 *
 * @param {any} ctx Cordis 上下文。
 * @param {{ state: any, effective: (agent: any) => boolean }} deps 依赖。
 */
function installPolicy(ctx, { state, effective }) {
  // 按**会话 id** 记账而不是对象身份：状态存储本来就按 id 索引，且
  // agent/created 与 agent/disposed 若送来不同的包装对象，身份键会漏卸载，
  // 留下悬挂的 section。id 缺失时才退回对象身份。
  const installed = new Map();

  /** 取记账键。 */
  const keyOf = (agent) => {
    const id = state.sessionId(agent);
    return id === undefined ? agent : id;
  };

  /** 为一个 agent 建立随开关变化而挂载/卸载的 section。 */
  const sync = (agent) => {
    const key = keyOf(agent);
    const turnOn = effective(agent);
    const current = installed.get(key);
    if (turnOn && current === undefined) {
      const scoped = agent.ctx ?? ctx;
      if (typeof scoped?.systemPrompt?.section !== 'function') return;
      const dispose = scoped.systemPrompt.section({
        name: `agent-notes:policy:${String(agent.id ?? 'unknown')}`,
        order: scoped.systemPrompt.getSectionOrder?.('AGENT_NOTES_POLICY') ?? 0,
        text: buildPolicyText()
      });
      installed.set(key, dispose);
    } else if (!turnOn && current !== undefined) {
      current();
      installed.delete(key);
    }
  };

  /** 卸载某个 agent 的 section。 */
  const remove = (agent) => {
    const key = keyOf(agent);
    let dispose = installed.get(key);
    if (dispose === undefined && typeof agent === 'object' && agent !== null) {
      // 兜底：id 不可用时按对象身份再试一次，避免悬挂。
      dispose = installed.get(agent);
      if (dispose !== undefined) installed.delete(agent);
    }
    if (dispose === undefined) return;
    dispose();
    installed.delete(key);
  };

  const known = typeof ctx.agents?.list === 'function' ? ctx.agents.list() : [];
  for (const agent of known) sync(agent);

  ctx.on('agent/created', ({ agent }) => sync(agent));
  ctx.on('agent/disposed', ({ agent }) => remove(agent));

  // 开关一变，重新对齐所有已知会话。
  state.onChange(() => {
    const live = typeof ctx.agents?.list === 'function' ? ctx.agents.list() : [];
    for (const agent of live) sync(agent);
  });

  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose();
    installed.clear();
  }, 'agent-notes.policy()');
}
