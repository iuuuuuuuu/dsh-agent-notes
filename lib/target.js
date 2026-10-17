/**
 * 解析工具调用真正该作用于哪个仓库根。
 *
 * 为什么单独抽出来（实测踩过的坑）：
 *
 * Agent 接口**只有 `id` 一个字段**（见 @deepseek-ai/dsh-agent 的 types.d.ts），
 * 根本没有 `cwd`。过去工具里写 `exec.agent.cwd` 永远拿到 `undefined`，于是
 * 静默回退到 `process.cwd()` —— 那是 **DSH 自己的进程目录**（例如
 * `C:\...\dependencies\dsh`），不是用户当前会话的仓库。后果很严重：
 *
 *   - 笔记树指错地方，用户仓库里明明有笔记却"0 篇"；
 *   - 更糟的是那个目录通常也有 `.agents/notes`（DSH 自己的开发笔记），
 *     于是门禁**真的跑通了并返回绿** —— 测的根本不是用户的仓库。
 *     这属于「假绿门禁」，是明令禁止的形态。
 *
 * 正确来源是会话头：`ctx.sessions.get(agent.id).header.cwd`（`SessionHeader.cwd`
 * 是"会话创建时的绝对工作目录"）。拿不到时**必须明确失败**，不许猜、不许
 * 退回 `process.cwd()` —— 宁可报错，也不给一个看着成功实则测错对象的绿。
 */

/** 拿不到仓库根时的统一原因码，便于模型和测试识别。 */
export const NO_CWD = 'NO_SESSION_CWD';

/**
 * 从工具执行上下文里解析出会话的 cwd。
 *
 * @param {any} ctx      Cordis 上下文（用于取 sessions 服务）。
 * @param {any} exec     工具执行上下文。
 * @param {string} [explicit] 模型显式传入的 cwd（优先级最高）。
 * @returns {{ ok: true, cwd: string, source: string } | { ok: false, reason: string, detail: string }}
 *   解析结果。失败时带可读 detail，供工具直接回报给模型。
 */
export function resolveTargetCwd(ctx, exec, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return { ok: true, cwd: explicit.trim(), source: 'argument' };
  }

  const agentId = exec?.agent?.id;
  if (agentId === undefined) {
    return {
      ok: false,
      reason: NO_CWD,
      detail: '无法确定目标仓库：执行上下文里没有 agent 身份，也没有显式传 cwd。'
        + '请显式传入 cwd（仓库内任意目录），否则测的不是你的仓库。'
    };
  }

  /* sessions 服务必须用 ctx.get 取：未声明的属性访问在 Cordis 下会直接抛
     （"cannot get property X without inject"），`ctx.sessions ?? x` 拦不住。 */
  let sessions;
  try {
    sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
  } catch (e) {
    sessions = undefined;
  }
  if (sessions === undefined || typeof sessions.get !== 'function') {
    return {
      ok: false,
      reason: NO_CWD,
      detail: '无法确定目标仓库：sessions 服务不可用，读不到会话的工作目录。请显式传入 cwd。'
    };
  }

  let header;
  try {
    header = sessions.get(agentId)?.header;
  } catch (e) {
    header = undefined;
  }

  const cwd = typeof header?.cwd === 'string' && header.cwd.trim() !== '' ? header.cwd.trim() : undefined;
  if (cwd === undefined) {
    return {
      ok: false,
      reason: NO_CWD,
      detail: '无法确定目标仓库：会话没有记录工作目录（header.cwd 缺失）。'
        + '请显式传入 cwd（仓库内任意目录），否则测的不是你的仓库。'
    };
  }

  return { ok: true, cwd, source: 'session' };
}
