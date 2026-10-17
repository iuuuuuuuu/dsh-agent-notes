/**
 * 开关状态：全局默认 + 会话覆盖，两者都持久化。
 *
 * 需求来自 Owner：与参考插件（切换不持久化、重载按配置初始化）相反，
 * 这里必须 **记录开关状态**。因此状态分两层：
 *
 *   global  —— 全局默认，对所有会话生效，写入状态文件。
 *   sessions—— 按会话 id 的覆盖，写入状态文件，重载后保持。
 *
 * 有效值 = 会话覆盖 ?? 全局默认。存储用原子替换（临时文件 + rename），
 * 与 DSH 自身的 atomic-write 语义一致，避免半写坏文件。
 *
 * 零依赖：只用 node 内建。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** 状态文件 schema 版本；将来迁移时据它判断。 */
const STATE_VERSION = 1;

/**
 * 解析 DSH home。
 *
 * 优先级：显式配置 > $DSH_HOME > ~/.dsh。
 * 与 @deepseek-ai/dsh-home-paths 的规则一致，但本包不能依赖它。
 *
 * @param {string} [configured] 显式覆盖。
 * @returns {string} 绝对路径。
 */
export function resolveDshHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') {
    return expandHome(configured.trim());
  }
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return expandHome(env.trim());
  return join(homedir(), '.dsh');
}

/**
 * 展开 `~` / `~/` 前缀。
 *
 * @param {string} value 待展开路径。
 * @returns {string} 展开后的绝对路径。
 */
export function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return resolve(value);
}

/**
 * 默认状态文件路径。
 *
 * @param {string} [configured] 显式覆盖。
 * @returns {string} 状态文件绝对路径。
 */
export function defaultStateFile(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return expandHome(configured.trim());
  return join(resolveDshHome(), 'agent-notes', 'state.json');
}

/**
 * 读 JSON，失败时给出可读的空状态而不是抛。
 *
 * @param {string} file 文件路径。
 * @param {any} fallback 读取或解析失败时的回退值。
 * @returns {any} 解析结果或回退值。
 */
function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed === null || typeof parsed !== 'object' ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/**
 * 原子写 JSON：先写同目录临时文件，再 rename 覆盖。
 *
 * 同目录保证 rename 落在同一文件系统；Windows 上 rename 覆盖是原子的
 * （Node 用 MoveFileEx REPLACE_EXISTING 语义）。
 *
 * @param {string} file 目标路径。
 * @param {any} value 待写入值。
 */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

/**
 * 创建开关状态存储。
 *
 * @param {any} ctx Cordis 上下文（用于注册 effect 清理）。
 * @param {string} [stateFileOption] 状态文件覆盖。
 * @returns {any} 状态存储 API。
 */
export function createStateStore(ctx, stateFileOption) {
  const file = defaultStateFile(stateFileOption);
  const loaded = readJson(file, {});
  const state = {
    version: STATE_VERSION,
    global: typeof loaded.global === 'boolean' ? loaded.global : undefined,
    sessions: loaded.sessions !== null && typeof loaded.sessions === 'object' && !Array.isArray(loaded.sessions)
      ? { ...loaded.sessions }
      : {}
  };
  const listeners = new Set();

  /** 落盘当前状态。 */
  const persist = () => writeJsonAtomic(file, state);

  /** 通知订阅者。 */
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // 订阅者异常不得影响状态写入本身。
      }
    }
  };

  return {
    /** 状态文件路径，便于诊断与测试断言。 */
    get file() {
      return file;
    },

    /**
     * 会话 id 归一：Agent 对象、字符串 id 或 undefined。
     *
     * @param {any} agent Agent 对象或会话 id。
     * @returns {string | undefined} 归一后的会话 id。
     */
    sessionId(agent) {
      if (agent === undefined || agent === null) return undefined;
      if (typeof agent === 'string') return agent;
      const id = agent.id ?? agent.sessionId;
      return id === undefined || id === null ? undefined : String(id);
    },

    /**
     * 读全局默认（未显式设置过时为 undefined，由调用方给兜底）。
     *
     * @returns {boolean | undefined} 全局默认值。
     */
    global() {
      return state.global;
    },

    /**
     * 读某会话的覆盖值。
     *
     * @param {any} agent Agent 或会话 id。
     * @returns {boolean | undefined} 覆盖值。
     */
    session(agent) {
      const id = this.sessionId(agent);
      if (id === undefined) return undefined;
      const value = state.sessions[id];
      return typeof value === 'boolean' ? value : undefined;
    },

    /**
     * 有效开关：会话覆盖优先，其次全局默认。
     *
     * @param {any} agent Agent 或会话 id。
     * @param {boolean} [fallback] 全局默认也缺失时的兜底。
     * @returns {boolean} 生效值。
     */
    effective(agent, fallback = true) {
      const session = this.session(agent);
      if (session !== undefined) return session;
      const global = state.global;
      return global === undefined ? fallback : global;
    },

    /**
     * 设全局默认。
     *
     * @param {boolean} value 新值。
     * @returns {boolean} 是否发生了改变。
     */
    setGlobal(value) {
      if (state.global === value) return false;
      state.global = value;
      persist();
      notify();
      return true;
    },

    /**
     * 设某会话覆盖；value 为 null 时清除该会话覆盖。
     *
     * @param {any} agent Agent 或会话 id。
     * @param {boolean | null} value 新值或清除。
     * @returns {boolean} 是否发生了改变。
     */
    setSession(agent, value) {
      const id = this.sessionId(agent);
      if (id === undefined) throw new Error('agent-notes: 会话开关需要一个会话 id');
      const current = state.sessions[id];
      if (value === null) {
        if (current === undefined) return false;
        delete state.sessions[id];
      } else {
        if (current === value) return false;
        state.sessions[id] = value;
      }
      persist();
      notify();
      return true;
    },

    /**
     * 订阅状态变化（开关命令与插件外部改动都会触发）。
     *
     * @param {() => void} listener 监听函数。
     * @returns {() => void} 退订函数。
     */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** 当前状态快照，供命令与测试读取。 */
    snapshot() {
      return { version: state.version, global: state.global, sessions: { ...state.sessions } };
    }
  };
}
