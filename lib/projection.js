/**
 * 会话投影：把「本会话是否启用笔记规范」变成浏览器可读的状态。
 *
 * 为什么走投影而不是自己写日志：
 *   DSH 给插件写会话记录的公开入口是 `appendPluginRecord`，它由
 *   `@deepseek-ai/dsh-session` 导出 —— 而插件**零 @deepseek-ai 依赖**
 *   （profile 的 node_modules 里根本没有这些包，实测 MODULE_NOT_FOUND）。
 *   退路 `session.append('plugin:…')` 实测会写出 `ignorable=undefined` 的
 *   残废记录（`pluginRecordOf` 读不回），看着成功实则污染日志，因此 **不采用**。
 *
 * 实际通道（已核实宿主源码 dsh-commands/lib/index.js）：
 *   命令执行时 **宿主自己** 在 handler 前后 append `command/run` 与
 *   `command/done`。插件只要正常提供 `/agent-notes` 命令，日志里自然就有
 *   `name: "agent-notes"` + `args: "on|off|reset"`。本模块只做纯折叠，
 *   一行日志都不写 —— 零依赖约束因此不破。
 *
 * 折叠出的最后一条命令即本会话的意图；`reset` 表示回到全局默认。
 * 全局默认由命令 handler 在 **本会话** 也广播一次（见 commands.js），
 * 因此投影只需忠实反映「本会话最后被要求的状态」。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** 投影键：客户端 `useProjection('agentNotes')` 读它。 */
export const PROJECTION_KEY = 'agentNotes';

/** 命令名：投影只认这条命令的事件。 */
export const COMMAND_NAME = 'agent-notes';

/**
 * 投影状态 schema。
 *
 * 纯 JSON、可持久化（DSH 要求 projection state 必须是 plain JSON）。
 *
 * @typedef {object} AgentNotesProjectionState
 * @property {boolean | null} enabled 本会话最后被要求的状态；null = 从未设置。
 * @property {string | null}  lastArg 最后一条命令的参数原文，便于诊断。
 * @property {number}         seq     最后一条相关事件的序号，-1 表示从未。
 */

/**
 * 空状态。
 *
 * @returns {AgentNotesProjectionState} 初始状态。
 */
export function emptyProjectionState() {
  return { enabled: null, lastArg: null, seq: -1 };
}

/**
 * 把一个参数原文解析成**本会话**的开关意图。
 *
 * 必须与 lib/commands.js 的真实语义严格对齐，否则徽标会撒谎。三条要点：
 *
 *   1. 裸调用 `/agent-notes` 等价于 `status` —— **不改状态**，不能当成 reset。
 *   2. `on --global` / `off --global` 只改**全局默认**，不改本会话覆盖；
 *      本会话若原本无覆盖，其显示值随全局走（由镜像与视图负责）。
 *   3. `status` / `gate` / `init` 以及未知参数都不改状态。
 *
 * @param {string} raw 参数原文。
 * @returns {boolean | null | undefined} true=本会话开，false=本会话关，
 *   null=清除本会话覆盖（回到全局），undefined=不改状态。
 */
export function parseSwitchArg(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return undefined; // 裸调用 = status
  const parts = text.split(/\s+/);
  const action = (parts[0] ?? '').toLowerCase();
  const globalFlag = parts.slice(1).some((part) => part.toLowerCase() === '--global');

  if (action === 'reset') return null;
  if (action !== 'on' && action !== 'off') return undefined; // status/gate/init/未知
  if (globalFlag) return undefined; // 只动全局默认，本会话覆盖不变
  return action === 'on';
}

/**
 * 判断一条命令是否在改**全局默认**（而非本会话覆盖）。
 *
 * 必须单独识别：`on --global` 不改本会话状态，但会改变本会话**应显示的
 * 值**（未覆盖时跟随全局），因此投影必须借这次事件强制重算视图。
 *
 * @param {string} raw 参数原文。
 * @returns {boolean} 是否为全局操作。
 */
export function isGlobalSwitch(raw) {
  const parts = String(raw ?? '').trim().split(/\s+/);
  const action = (parts[0] ?? '').toLowerCase();
  if (action !== 'on' && action !== 'off') return false;
  return parts.slice(1).some((part) => part.toLowerCase() === '--global');
}

/**
 * 纯折叠：状态 + 一个已提交事件 → 新状态。
 *
 * 规则（与 DSH 投影契约一致）：
 *   - 无关事件 **必须返回同一个引用**，否则会触发无谓的下游重算；
 *   - 只认 `command/run`，因为只有它带着 `name` 与 `args`；
 *     `command/done` 不带参数，无法判断意图。
 *
 * 注意这里有个**容易漏的正确性点**：`on --global` 不改本会话覆盖，若就地
 * 返回同一个引用，宿主会认为"状态没变"而**跳过视图重算**，徽标就会停在旧
 * 值上直到刷新。因此全局操作也返回一个新引用，仅用于迫使视图重算（视图会
 * 去读全局镜像）。
 *
 * @param {AgentNotesProjectionState} state 折叠到此刻的状态。
 * @param {any} event 一个已提交的会话事件。
 * @returns {AgentNotesProjectionState} 新状态或原引用。
 */
export function applyProjection(state, event) {
  if (event === null || typeof event !== 'object') return state;
  if (event.type !== 'command/run') return state;
  const data = event.data;
  if (data === null || typeof data !== 'object') return state;
  if (data.name !== COMMAND_NAME) return state;

  const raw = typeof data.args === 'string' ? data.args : '';
  const seq = Number.isSafeInteger(event.seq) ? event.seq : state.seq;
  const intent = parseSwitchArg(raw);

  // status / gate / init / 未知参数：不影响显示，保持原引用。
  if (intent === undefined) {
    if (!isGlobalSwitch(raw)) return state;
    // 全局操作：本会话值不变，但要迫使视图重算以读到新的全局镜像。
    return { enabled: state.enabled, lastArg: raw, seq };
  }

  if (intent === state.enabled && raw === state.lastArg) return state;
  return { enabled: intent, lastArg: raw, seq };
}

/**
 * 注册投影。
 *
 * 宿主 API 按鸭子类型使用，服务缺失时静默不注册（例如 headless 组合），
 * 命令与工具仍然可用。
 *
 * 两个**实测踩过的坑**，都只有真机启动才会暴露：
 *   1. Cordis 的**属性访问**在服务未 provide 时直接抛
 *      （"cannot get property \"sessionProjections\" without inject"），
 *      所以 `ctx.sessionProjections ?? 兜底` 拦不住，会让整个插件激活失败。
 *   2. 也不能用 `ctx.get()` 了事：它在服务**尚未就绪**时返回 undefined，
 *      于是投影永远注册不上，徽标恒为「未知」而不报错 —— 属于假绿。
 *
 * 正解是 `ctx.inject([...], cb)`：官方给「可选注册」的形式，会等声明就绪
 * 再回调（与 lib/commands.js、lib/tools.js 同一模式）。
 *
 * @param {any} ctx Cordis 上下文。
 * @param {string} stateFilePath 状态文件绝对路径（镜像据此定位）。
 */
export function registerProjection(ctx, stateFilePath) {
  if (typeof ctx.inject !== 'function') return;

  ctx.inject(['sessionProjections'], (subCtx) => {
    const registry = subCtx.sessionProjections;
    if (registry === undefined || typeof registry.register !== 'function') return;

    // schema 只做形状校验：本投影容忍老状态（无 lastArg/seq）。
    const stateSchema = {    parse(value) {
        if (value === null || typeof value !== 'object') return emptyProjectionState();
        const enabled = value.enabled;
        return {
          enabled: enabled === true ? true : enabled === false ? false : null,
          lastArg: typeof value.lastArg === 'string' ? value.lastArg : null,
          seq: Number.isSafeInteger(value.seq) ? value.seq : -1
        };
      }
    };

    /**
     * 视图缓存。
     *
     * 宿主按 `Object.is` 比较相邻两次 view 结果来抑制发布，因此**同一个 state
     * 引用必须得到同一个视图对象**；否则每次读都当成变化，白白推送。
     *
     * 但缓存的键不能只有 state：全局默认变化时本会话的 state 没动（它本来就
     * 是"未设置"），若只按 state 缓存，徽标就会一直显示旧值。因此把镜像值
     * 一起纳入缓存键。
     */
    let cachedState;
    let cachedGlobal;
    let cachedView;

    const viewSchema = {
      parse(value) {
        if (value === null || typeof value !== 'object') {
          return { enabled: true, global: null, session: false };
        }
        return {
          enabled: value.enabled === true,
          global: typeof value.global === 'boolean' ? value.global : null,
          session: value.session === true
        };
      }
    };

    const definition = {
      key: PROJECTION_KEY,
      stateVersion: 1,
      stateSchema,
      init: () => emptyProjectionState(),
      apply: applyProjection,
      wire: {
        viewSchema,
        /**
         * 状态 → 浏览器视图。
         *
         * 本会话从未显式设置过时（`enabled` 为 null），客户端必须知道**全局
         * 默认**才能显示正确的开/关 —— 而 view 是同步纯函数，看不到插件内存。
         * 因此读全局默认的磁盘镜像（由 syncMirror 维护，state.json 仍是唯一
         * 权威）：读到就用，读不到给 null，绝不猜一个值。
         *
         * @param {AgentNotesProjectionState} state 当前状态。
         * @returns {{ enabled: boolean, global: boolean | null, session: boolean }} 视图。
         */
        view: (state) => {
          const global = readMirror(stateFilePath);
          if (state === cachedState && global === cachedGlobal && cachedView !== undefined) return cachedView;
          cachedState = state;
          cachedGlobal = global;
          cachedView = {
            // 会话未设置 → 跟随全局；全局也没设过 → 默认**关**（与命令侧兜底一致）。
            // 默认关是 Owner 要求：新老会话都要手动开，装上插件不改变既有行为。
            enabled: state.enabled !== null ? state.enabled : (global === null ? false : global),
            global,
            session: state.enabled !== null
          };
          return cachedView;
        }
      }
    };

    subCtx.effect(() => registry.register(definition), 'agent-notes.projection()');
  });
}

/**
 * 把全局默认镜像到磁盘，供投影视图同步读取。
 *
 * 由 lib/index.js 在启动时与全局值变化时调用。写失败不影响开关本身。
 *
 * @param {string} stateFilePath 状态文件绝对路径。
 * @param {boolean | undefined | null} value 全局默认值。
 */
export function syncMirror(stateFilePath, value) {
  writeMirror(stateFilePath, typeof value === 'boolean' ? value : null);
}

/** 侧信道文件名：全局默认的镜像，供投影视图读取。 */
const MIRROR_NAME = 'global.json';

/**
 * 全局默认的镜像路径。
 *
 * 关键：**必须跟着状态文件走**，而不是各自解析一次 DSH home。否则当
 * `config.stateFile` 指向自定义位置时，镜像会写到别处 —— 投影读到的
 * 是一个永远不更新的旧文件，徽标就会一直显示错的值。
 *
 * 因此这里接收状态文件路径，镜像固定落在它旁边的 `global.json`。
 *
 * @param {string | undefined} stateFilePath 状态文件绝对路径。
 * @returns {string} 镜像文件绝对路径。
 */
export function mirrorPath(stateFilePath) {
  if (typeof stateFilePath === 'string' && stateFilePath.trim() !== '') {
    return join(dirname(resolve(stateFilePath.trim())), MIRROR_NAME);
  }
  const base = process.env.DSH_HOME?.trim()
    ? resolve(process.env.DSH_HOME.trim())
    : join(homedir(), '.dsh');
  return join(base, 'agent-notes', MIRROR_NAME);
}

/**
 * 原子写全局默认镜像。
 *
 * @param {string | undefined} stateFilePath 状态文件绝对路径。
 * @param {boolean | null} value 全局默认值；null 表示未设置。
 */
export function writeMirror(stateFilePath, value) {
  const file = mirrorPath(stateFilePath);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ global: value })}\n`, 'utf8');
    renameSync(temp, file);
  } catch {
    // 镜像只是显示优化，写失败不得影响开关本身。
  }
}

/**
 * 同步读全局默认镜像。
 *
 * @param {string | undefined} stateFilePath 状态文件绝对路径。
 * @returns {boolean | null} 镜像值；缺失或损坏时为 null。
 */
export function readMirror(stateFilePath) {
  try {
    const file = mirrorPath(stateFilePath);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed?.global === 'boolean' ? parsed.global : null;
  } catch {
    return null;
  }
}
