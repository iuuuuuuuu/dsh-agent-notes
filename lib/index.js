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
import { scheduleSkillUpdate } from './self-update.js';
import { buildPolicyText } from './policy.js';
import { buildVersionChangeHint, readPluginVersion } from './version-notice.js';
import { buildDriftHint, inspectProjectSkillCopy } from './project-skill.js';
import { registerCommands } from './commands.js';
import { registerTools } from './tools.js';
import { registerProjection, syncMirror } from './projection.js';
import { registerBoardRoutes } from './board-route.js';
import { resolveTargetCwd } from './target.js';

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
    /* 默认关闭：装上插件不应悄悄改变任何既有会话的行为，需要时手动打开。 */
    enabled: config.enabled ?? false,
    injectPolicy: config.injectPolicy ?? true,
    registerTools: config.registerTools ?? true,
    registerCommands: config.registerCommands ?? true,
    stateFile: config.stateFile,
    notesRoot: config.notesRoot,
    /* 自更新目标目录。测试必须能把它指到沙箱 —— 否则 apply 会去拉真实远端
       并**覆盖真实 skills/agent-notes**（见下方 scheduleSkillUpdate 的注释）。 */
    skillDir: config.skillDir
  };

  const state = createStateStore(ctx, resolved.stateFile);
  const notes = createNotesService(ctx, resolved.notesRoot);

  /* 技能 provider：唯一必需能力，注册失败要响。
     provider 会拿着宿主给的 control，以便技能副本更新后回调 invalidate()
     让宿主丢弃缓存 —— 那是热替换能生效的官方通道。 */
  let provider;
  ctx.skills.registerProvider((control) => {
    provider = createSkillProvider(control);
    return provider;
  });

  /* 技能副本异步自更新：**绝不 await**，网络再慢也不拖慢启动。
     失败静默保留现有副本（技能旧一点，总比技能不可用强）。
     真的写入了新内容才回调 invalidate()，避免每次启动都白刷一次缓存。

     **测试必须传 skillDir 指到沙箱**（实测踩过，代价极高）：
     这是 fire-and-forget，测试进程结束它可能还在跑；默认目标又是**真实的**
     skills/agent-notes。于是 CI 上出现过：检出后 vendored 文件是新的
     （bb76d4d），跑完 npm test 变成旧的（0e6628c），随后 sync-upstream 的
     `--check` 报「变更 6」，门禁整片变红。
     根因是本仓库自己的 `.synced-version` **未被 git 跟踪**，全新 clone 里没有
     它 → 快速路径失效 → 真的去拉 jsDelivr `@main` 的 21 个文件覆盖真实目录；
     而推送瞬间 CDN 上的 `@main` 仍指向上一个 commit，于是新内容被旧内容覆盖。
     本地有 .synced-version 且 @main 已是最新，所以从不复现。 */
  scheduleSkillUpdate({
    ...(typeof resolved.skillDir === 'string' && resolved.skillDir !== ''
      ? { targetDir: resolved.skillDir }
      : {}),
    log: (message) => {
      try { ctx.logger?.info?.(message); } catch { /* 无 logger 时忽略 */ }
    },
    onUpdated: () => {
      if (provider !== undefined && typeof provider.invalidate === 'function') provider.invalidate();
    }
  });

  /**
   * 当前会话的生效开关：会话覆盖优先，否则取全局默认。
   *
   * 显式把 resolved.enabled 传下去，而不是靠 state.effective 的默认参数 ——
   * 两处兜底值一旦漂移（比如以后有人只改了一边），就会出现「命令显示开、
   * 实际不注入」这种难查的不一致。
   */
  const effective = (agent) => state.effective(agent, resolved.enabled);

  registerCommands(ctx, { state, notes, effective, config: resolved });
  registerTools(ctx, { state, notes, effective, config: resolved });

  // 浏览器侧的状态通道：把「本会话是否启用」做成会话投影，供 composer 开关
  // 与对话头部 tag 读取。投影只折叠宿主自己写的 command/run 事件，本插件
  // 不写日志（理由见 lib/projection.js 顶部注释）。
  // 注册走 ctx.inject，生命周期由 Cordis 管理，这里不额外包 effect。
  registerProjection(ctx, state.file);

  // 全局默认的磁盘镜像：投影的 view 是同步纯函数，读不到插件内存，因此把
  // 全局值镜像出去。state.json 仍是唯一权威，镜像只服务显示。
  // 注意：`on --global` 不改本会话状态，视图靠投影里返回新引用被触发重算。
  syncMirror(state.file, state.global());
  state.onChange(() => syncMirror(state.file, state.global()));

  if (resolved.injectPolicy) {
    installPolicy(ctx, { state, effective });
  }

  /* 看板的只读 HTTP 通道。笔记内容在磁盘上、随时会被编辑器改动，而会话投影
     的 view 是同步纯函数（读不到文件系统），所以浏览器要看实时内容只能走 HTTP。
     路由是全局的，但笔记根随会话变化，因此按 `?session=` 解析。
     注册与注销都由 registerBoardRoutes 内部的 ctx.inject 生命周期管理。 */
  registerBoardRoutes(ctx, {
    notesRootFor(sessionId) {
      /* 没有会话上下文时退回「当前进程目录」是不可接受的（那正是之前修过的
         假绿来源），所以拿不到会话就明确返回 undefined，让路由回 409。 */
      if (sessionId === undefined) return undefined;
      const target = resolveTargetCwd(ctx, { agent: { id: sessionId } }, undefined);
      if (!target.ok) return undefined;
      /* 返回**一组**根：笔记常写在某个 git worktree 里，而会话 cwd 可能落在
         另一个工作树上。只看 cwd 会让别处的笔记凭空消失（实测：主仓库零篇、
         wt-port 一篇，看板却显示「还没有 .agents/notes」）。 */
      return notes.roots(target.cwd);
    },
    /**
     * 会话尚未加载时的兜底：用前端带来的会话 cwd 解析。
     *
     * 触发场景（实测）：DSH 重启后，浏览器里持久化的「笔记」tab 会在会话
     * 加载完成前发起请求，`sessions.get(id)` 返回 undefined，看板只能显示
     * 「暂时读不到」。而 cwd 来自宿主的会话列表摘要，不依赖服务端是否已
     * 加载 —— 用它就能直接出数据，用户不需要手动刷新。
     *
     * 注意这不是猜：cwd 是宿主声明的本会话目录（SessionScope.cwd），
     * 与本插件「随便取一个会话的 cwd」那条禁令是两回事。
     */
    notesRootsForCwd(cwd) {
      return notes.roots(cwd);
    }
  });
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
      /* 项目副本落后时追加一段提示，让模型知道「要不要更新项目」并去问用户。
         只在开关打开时才算 —— 关着的时候不该多花一个 token。
         代价是每次挂载都读一遍目录，但只在会话创建/开关切换时发生，可接受。 */
      let driftHint;
      try {
        driftHint = buildDriftHint(inspectProjectSkillCopy(agent?.cwd));
      } catch {
        /* 检测失败就不提示，绝不让它影响规范注入。 */
        driftHint = undefined;
      }
      /* 插件自身版本变化时，也往对话里说一句 —— Owner 2026-10-22 报的正是
         「版本更新了，agent 对话根本不会触发提示」。判据只看本地：
         上次记录的版本 vs 当前 package.json 的版本，不联网。
         记录只在**版本真的变了**时才写（首次运行只记录、不提示）。 */
      let versionHint;
      try {
        const currentVersion = readPluginVersion();
        versionHint = buildVersionChangeHint({
          current: currentVersion,
          lastSeen: state.pluginVersion(),
          changelogPath: 'CHANGELOG.md'
        });
        if (currentVersion !== undefined) state.setPluginVersion(currentVersion);
      } catch {
        /* 读不到版本/写不了状态都不影响规范注入。 */
        versionHint = undefined;
      }
      const dispose = scoped.systemPrompt.section({
        name: `agent-notes:policy:${String(agent.id ?? 'unknown')}`,
        order: scoped.systemPrompt.getSectionOrder?.('AGENT_NOTES_POLICY') ?? 0,
        text: buildPolicyText(driftHint, versionHint)
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

  // 遍历已有会话也要走 ctx.inject：Cordis 的属性访问 ctx.agents 在服务未
  // provide 时**直接抛**（实测 "cannot get property \"agents\" without inject"），
  // 会让整个插件激活失败。事件订阅同理必须先有 agents 服务，所以一起放进
  // inject 回调里 —— 服务就绪时才装，缺了就不装，而不是崩。
  ctx.inject(['agents'], (subCtx) => {
    const agents = subCtx.agents;
    /** 列出当前全部 agent；能力缺失时返回空表。 */
    const listAgents = () => (typeof agents?.list === 'function' ? agents.list() : []);

    for (const agent of listAgents()) sync(agent);

    subCtx.on('agent/created', ({ agent }) => sync(agent));
    subCtx.on('agent/disposed', ({ agent }) => remove(agent));

    // 开关一变，重新对齐所有已知会话。
    state.onChange(() => {
      for (const agent of listAgents()) sync(agent);
    });
  });

  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose();
    installed.clear();
  }, 'agent-notes.policy()');
}
