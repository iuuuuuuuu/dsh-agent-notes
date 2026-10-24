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
import { resolveTargetCwd } from './target.js';

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
        + '省略 gate 则全跑。以进程退出码为准；脚本缺失或超时一律算失败，不要把它当作“格式建议”。'
        + '默认作用于当前会话的仓库根；若会话没有工作目录，会明确返回 passed:false 而不会猜一个。',
      parameters: {
        type: 'object',
        properties: {
          gate: { type: 'string', enum: ['tree', 'format', 'archived'], description: '要跑的门禁；省略表示全跑' },
          cwd: { type: 'string', description: '仓库内任意目录；省略则用当前会话的工作目录' }
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
        /* cwd 必须来自会话头，不能退回 process.cwd() —— 那是 DSH 自己的进程
           目录，会在错的仓库上跑出真绿（详见 lib/target.js 的说明）。 */
        const target = resolveTargetCwd(ctx, exec, args.cwd);
        const gateName = typeof args.gate === 'string' ? args.gate : undefined;

        if (!target.ok) {
          /* 明确失败：不许降级成「跑了但没测到」的绿色。 */
          return {
            passed: false,
            reason: target.reason,
            detail: target.detail,
            notesRoot: null,
            repoRoot: null,
            results: []
          };
        }

        const { cwd } = target;
        const collected = [];
        /* 先数清笔记数：0 篇时下面的门禁会以 NO_NOTES_TREE 失败，
           这个数字要如实回给模型，不能让它以为「跑过了」。
           只数生命周期目录里的 `.md`（`noteFiles`），与门禁输出的
           `ok: N note(s)` 同口径；根层散落件另记 `strayCount`。
           实测踩过：用 `files.length` 时，笔记树下只放一个散落 `.md`
           会报 `noteCount: 1` 而 `passed: false` —— 两个数字各说各话，
           模型分不清是「有笔记但不合规」还是「根本没有笔记」。 */
        const tree = notes.inspect(cwd);
        const noteCount = tree.noteFiles?.length ?? 0;
        const strayCount = tree.strayFiles?.length ?? 0;

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
          /* 明确报出校验了多少篇笔记：0 篇时 passed 一定是 false（空树不算通过），
             这个数字让模型不会把「没东西可验」误读成「验过了」。
             `strayCount` 单独报：它们未计入独立笔记数。这里面混合了散落件、
             目录说明与翻译旁挂 —— 有的确实不受校验（散落件），有的另受别的检查
             （归档旁挂的封印、生命周期根层说明文件的形状），
             所以不能一概说成「不被任何一道门禁校验」。
             差额必须当场解释，否则「磁盘上有几篇」永远没人对账。 */
          noteCount,
          strayCount,
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
        /* 与 gate 同源取 cwd；拿不到时如实报告「不知道」，不指向 process.cwd()。 */
        const target = resolveTargetCwd(ctx, exec, undefined);
        const tree = target.ok
          ? notes.inspect(target.cwd)
          : { root: null, exists: false, counts: {} };
        return {
          enabled: effective(exec?.agent),
          global: state.global() ?? null,
          session: state.session(exec?.agent) ?? null,
          stateFile: state.file,
          cwd: target.ok ? target.cwd : null,
          ...(target.ok ? {} : { cwdUnresolved: target.detail }),
          notesRoot: tree.root,
          notesExist: tree.exists,
          counts: tree.counts
        };
      }
    }), 'agent-notes.tool.status()');
  });
}
