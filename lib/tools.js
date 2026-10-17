/**
 * 门禁工具：让模型能真跑校验，而不是凭印象宣称合规。
 *
 * 诚实性（Owner 硬规则「禁止假绿门禁」）：
 *   - 工具的返回值里带 `exitCode`、`passed`、stdout/stderr 原文。
 *   - 判定只用**退出码**；脚本缺失/超时算失败，不降级为通过。
 *   - 不吞异常：执行器抛出被捕获后转成 `passed: false` + 原因，
 *     绝不返回「看起来通过」。
 *
 * 工具用原始对象注册（不用 defineTool）：本包零 @deepseek-ai 运行时依赖，
 * DSH 接受裸 ToolDefinition（MCP 工具就是这么进来的）。
 */
import { GATES, stripNodeNoise } from './notes.js';

/** 工具名前缀，避免与宿主或其他插件撞名。 */
const PREFIX = 'agent_notes';

/**
 * 构造一个工具结果渲染器：把规范 JSON 值渲染成模型可见的文本块。
 *
 * @returns {(args: unknown, value: any) => Array<{ type: 'text', text: string }>} 渲染函数。
 */
function textRender() {
  return (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

/**
 * 注册门禁工具。
 *
 * @param {any} ctx Cordis 上下文。
 * @param {{ state: any, notes: any, effective: Function, config: any }} deps 依赖。
 */
export function registerTools(ctx, { state, notes, effective, config }) {
  if (config.registerTools === false) return;

  ctx.inject(['tools'], (subCtx) => {
    const runtime = subCtx.tools;
    if (runtime === undefined || typeof runtime.register !== 'function') return;

    subCtx.effect(() => runtime.register({
      name: `${PREFIX}_gate`,
      description:
        '运行决策笔记（Agent Notes）的机械门禁并返回真实退出码。用 tree 校验目录/分类/文件名与笔记间相对链接，'
        + 'format 校验头部、必备小节、备选方案与 implemented 禁用提案标题，archived 校验归档封印只增不改。'
        + '省略 gate 则全跑。以进程退出码为准；脚本缺失或超时一律算失败，不要把它当作“格式建议”。',
      parameters: {
        type: 'object',
        properties: {
          gate: { type: 'string', enum: ['tree', 'format', 'archived'], description: '要跑的门禁；省略表示全跑' },
          cwd: { type: 'string', description: '仓库内任意工作目录，默认取当前会话目录' }
        },
        additionalProperties: false
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: textRender() },

      /**
       * @param {any} args 模型参数。
       * @param {any} exec 执行上下文（含 signal）。
       * @returns {Promise<any>} 门禁结果。
       */
      async execute(args = {}, exec) {
        const cwd = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd.trim() : exec?.agent?.cwd;
        const gateName = typeof args.gate === 'string' ? args.gate : undefined;
        const collected = [];

        const ordered = gateName === undefined ? Object.keys(GATES) : [gateName];
        for (const entry of ordered) {
          const result = await notes.runGate(entry, { cwd, signal: exec?.signal });
          collected.push({
            gate: result.gate,
            passed: result.passed,
            exitCode: result.exitCode,
            signal: result.signal,
            ...(result.reason === undefined ? {} : { reason: result.reason }),
            stdout: stripNodeNoise(result.stdout ?? ''),
            stderr: stripNodeNoise(result.stderr ?? '')
          });
          // 取消时立即停手，不要继续跑后面的门禁。
          if (exec?.signal?.aborted === true) break;
        }

        return {
          passed: collected.length > 0 && collected.every((entry) => entry.passed),
          notesRoot: notes.root(cwd),
          repoRoot: notes.repoRoot(cwd),
          results: collected
        };
      }
    }), 'agent-notes.tool.gate()');

    subCtx.effect(() => runtime.register({
      name: `${PREFIX}_status`,
      description:
        '返回决策笔记的开关状态（全局默认 / 本会话覆盖 / 生效值）与笔记树概况，'
        + '用于在写笔记或跑门禁之前确认自己处于什么状态。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: textRender() },

      /** @returns {Promise<any>} 状态快照。 */
      async execute(_args, exec) {
        const cwd = exec?.agent?.cwd;
        const tree = notes.inspect(cwd);
        return {
          enabled: effective(exec?.agent),
          global: state.global() ?? null,
          session: state.session(exec?.agent) ?? null,
          stateFile: state.file,
          notesRoot: tree.root,
          notesExist: tree.exists,
          counts: tree.counts
        };
      }
    }), 'agent-notes.tool.status()');
  });
}
