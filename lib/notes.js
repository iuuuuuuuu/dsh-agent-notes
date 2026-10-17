/**
 * 笔记服务：探测宿主仓库的笔记树、执行真门禁、归档。
 *
 * 门禁的诚实性要求（Owner 硬规则：禁止假绿）：
 *   - `runGate()` 真的 spawn vendored 校验脚本，读它的**进程退出码**；
 *     绝不把「脚本存在」「输出含 ok」当成通过。
 *   - 脚本缺失、node 不可用、超时，一律算**失败**并给出原因，
 *     不能静默降级成通过。
 *   - 返回结构里带 `exitCode` 与 `stdout/stderr` 原文，便于核对。
 *
 * 零依赖：只用 node 内建（child_process / fs / path / url）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本包根目录。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** vendored 校验脚本所在目录。 */
export const SCRIPTS_DIR = join(PACKAGE_ROOT, 'skills', 'agent-notes', 'scripts');

/** 四条门禁：名字 → 脚本文件名。顺序即推荐执行顺序。 */
export const GATES = Object.freeze({
  tree: 'verify-agent-note-tree.ts',
  format: 'verify-agent-note-format.ts',
  archived: 'verify-archived-agent-notes.ts'
});

/** 生命周期目录（与上游封闭集一致）。 */
export const LIFECYCLES = Object.freeze(['proposed', 'implemented', 'rejected', 'archived']);

/** 分类封闭集（与上游一致，硬编码以防上游脚本缺失时无从判断）。 */
export const CLASSES = Object.freeze([
  'feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'
]);

/**
 * 解析宿主仓库的笔记根。
 *
 * 优先显式配置，其次 $AGENT_NOTE_ROOT（与上游脚本同一环境变量），
 * 最后 <cwd>/.agents/notes。
 *
 * @param {string} [configured] 显式覆盖。
 * @param {string} [cwd] 工作目录。
 * @returns {string} 笔记根绝对路径。
 */
export function resolveNotesRoot(configured, cwd = process.cwd()) {
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim());
  const env = process.env.AGENT_NOTE_ROOT;
  if (typeof env === 'string' && env.trim() !== '') return resolve(env.trim());
  return resolve(cwd, '.agents', 'notes');
}

/**
 * 向上找仓库根（含 .git 的目录），找不到则回退到起点。
 *
 * 笔记要跟代码同仓库，因此门禁默认跑在仓库根，而不是某个子目录。
 *
 * @param {string} start 起始目录。
 * @returns {string} 仓库根或起始目录。
 */
export function findRepoRoot(start = process.cwd()) {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = resolve(current, '..');
    if (parent === current) return resolve(start);
    current = parent;
  }
}

/**
 * 判断一个路径是否平台上的 node 可执行文件。
 *
 * @param {string} nodePath 候选路径。
 * @returns {boolean} 是否可用。
 */
function isRunnable(nodePath) {
  try {
    return existsSync(nodePath) && statSync(nodePath).isFile();
  } catch {
    return false;
  }
}

/**
 * 选一个 node 可执行文件。
 *
 * 直接用 process.execPath（当前 harness 进程自己的 node），这是最可靠的选择：
 * 它一定存在，且版本满足脚本要求（本插件要求 node >= 22.19）。
 *
 * @returns {string} node 绝对路径。
 */
export function nodeExecutable() {
  return process.execPath;
}

/**
 * 跑一条门禁，返回真实退出码与输出。
 *
 * @param {string} gateName GATES 里的键。
 * @param {{ cwd?: string, env?: Record<string,string>, timeoutMs?: number }} [options] 执行选项。
 * @returns {Promise<{ gate: string, script: string, passed: boolean, exitCode: number | null, signal: string | null, stdout: string, stderr: string, reason?: string }>}
 */
export async function runGate(gateName, options = {}) {
  const scriptName = GATES[gateName];
  if (scriptName === undefined) {
    return {
      gate: String(gateName),
      script: '',
      passed: false,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      reason: `未知门禁 "${gateName}"（可选：${Object.keys(GATES).join(', ')}）`
    };
  }

  const script = join(SCRIPTS_DIR, scriptName);
  const base = {
    gate: gateName,
    script,
    passed: false,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: ''
  };

  if (!isRunnable(script)) {
    return { ...base, reason: `门禁脚本缺失：${script}` };
  }
  const node = nodeExecutable();
  if (!isRunnable(node)) {
    return { ...base, reason: `node 不可用：${node}` };
  }

  const cwd = options.cwd ?? process.cwd();
  const result = await spawnCapture(node, [script], {
    cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    timeoutMs: options.timeoutMs ?? 120_000
  });

  return {
    ...base,
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.timedOut ? { reason: `门禁超时（${options.timeoutMs ?? 120_000}ms）` } : {}),
    ...(result.exitCode === 0 ? {} : { reason: result.exitCode === null ? '进程未正常结束' : undefined })
  };
}

/**
 * 跑全部门禁。
 *
 * @param {{ cwd?: string, env?: Record<string,string>, timeoutMs?: number }} [options] 执行选项。
 * @returns {Promise<{ passed: boolean, results: any[] }>} 汇总结果；全绿才算通过。
 */
export async function runAllGates(options = {}) {
  const results = [];
  for (const gateName of Object.keys(GATES)) {
    results.push(await runGate(gateName, options));
  }
  return { passed: results.every((entry) => entry.passed), results };
}

/**
 * spawn 一个进程并收集输出，带超时与取消。
 *
 * @param {string} command 可执行文件。
 * @param {string[]} args 参数。
 * @param {{ cwd?: string, env?: any, timeoutMs?: number, signal?: AbortSignal }} options 选项。
 * @returns {Promise<{ exitCode: number | null, signal: string | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function spawnCapture(command, args, options = {}) {
  return new Promise((settle) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      settle({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: String(error?.message ?? error),
        timedOut: false
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let finished = false;

    const finish = (payload) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (options.signal !== undefined) {
        options.signal.removeEventListener?.('abort', onAbort);
      }
      settle(payload);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出。
      }
    }, options.timeoutMs ?? 120_000);
    if (typeof timer.unref === 'function') timer.unref();

    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出。
      }
    };
    if (options.signal !== undefined) options.signal.addEventListener?.('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish({ exitCode: null, signal: null, stdout, stderr: `${stderr}${String(error?.message ?? error)}`, timedOut });
    });
    child.on('close', (code, signal) => {
      finish({ exitCode: code, signal: signal ?? null, stdout, stderr, timedOut });
    });
  });
}

/**
 * 清掉 node 在无 "type":"module" 场景下的重解析告警，保留真实诊断。
 *
 * 这些告警是 node 的 MODULE_TYPELESS_PACKAGE_JSON 噪声，会掩盖真错误；
 * 只过滤告警行，任何 `format:` / `structure:` / `archived:` 前缀的真实
 * 诊断一律保留。
 *
 * @param {string} text 原始输出。
 * @returns {string} 过滤后的输出。
 */
export function stripNodeNoise(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/MODULE_TYPELESS_PACKAGE_JSON|Reparsing as ES module|To eliminate this warning|^\(Use `node --trace-warnings/.test(line))
    .join('\n')
    .trim();
}

/**
 * 列出笔记树内容（用于状态展示与诊断）。
 *
 * @param {string} root 笔记根。
 * @returns {{ root: string, exists: boolean, counts: Record<string, number>, files: string[] }}
 */
export function inspectTree(root) {
  if (!existsSync(root)) return { root, exists: false, counts: {}, files: [] };
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
    }
  }
  const counts = {};
  for (const file of files) {
    const rel = file.slice(root.length + 1).split(/[\\/]/);
    const lifecycle = rel[0] ?? 'unknown';
    counts[lifecycle] = (counts[lifecycle] ?? 0) + 1;
  }
  return { root, exists: true, counts, files: files.sort() };
}

/**
 * 创建笔记服务。
 *
 * @param {any} ctx Cordis 上下文。
 * @param {string} [notesRootOption] 笔记根覆盖。
 * @returns {any} 笔记服务 API。
 */
export function createNotesService(ctx, notesRootOption) {
  return {
    /** 当前解析出的笔记根。 */
    root(cwd) {
      return resolveNotesRoot(notesRootOption, cwd ?? process.cwd());
    },

    /** 仓库根（笔记默认所在）。 */
    repoRoot(cwd) {
      return findRepoRoot(cwd ?? process.cwd());
    },

    /** 探测笔记树。 */
    inspect(cwd) {
      return inspectTree(this.root(cwd));
    },

    /** 跑单条门禁（真退出码）。 */
    runGate(gateName, options = {}) {
      return runGate(gateName, { cwd: this.repoRoot(options.cwd), ...options });
    },

    /** 跑全部门禁。 */
    runAll(options = {}) {
      return runAllGates({ cwd: this.repoRoot(options.cwd), ...options });
    },

    /** 是否已建立笔记树。 */
    isInitialized(cwd) {
      return existsSync(this.root(cwd));
    },

    /**
     * 脚手架：建出标准目录结构（用到的目录即建，不预建空目录）。
     *
     * @param {{ cwd?: string, lifecycles?: string[] }} [options] 选项。
     * @returns {{ created: string[] }} 建出的目录。
     */
    scaffold(options = {}) {
      const root = this.root(options.cwd);
      const wanted = options.lifecycles ?? ['proposed', 'implemented', 'rejected'];
      const created = [];
      for (const lifecycle of wanted) {
        const dir = join(root, lifecycle);
        mkdirSync(dir, { recursive: true });
        created.push(dir);
      }
      return { created };
    }
  };
}

/**
 * 读一条笔记的原文（供工具返回给模型）。
 *
 * @param {string} file 绝对路径。
 * @returns {string | undefined} 内容或 undefined。
 */
export function readNote(file) {
  try {
    if (!existsSync(file)) return undefined;
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}
