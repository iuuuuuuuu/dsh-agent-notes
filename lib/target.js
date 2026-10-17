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

  const own = typeof header?.cwd === 'string' && header.cwd.trim() !== '' ? header.cwd.trim() : undefined;
  if (own !== undefined) return { ok: true, cwd: own, source: 'session' };

  /* 会话没记录 cwd。
   *
   * 曾经的设想是「从同项目其它活跃会话推断」，**实测证明不可行**：
   * 同一项目下的会话 id 是彼此无关的 UUID（实测 209 个会话同在一个项目
   * 目录下，id 形如 059ba98b-… / 06a9f391-…，没有任何共享前缀），
   * 而 `sessions.get()` 又只查活跃会话 —— 目标会话不在活跃列表里时，
   * 没有任何可证信号能把它和某个活跃会话绑定到同一个项目。
   *
   * 唯一「能拿到值」的写法是「随便取一个活跃会话的 cwd」，但那会在多项目
   * 并行时把看板指到别人的仓库上，让看板显示别人的决策笔记。那正是当年
   * 假绿门禁的成因，宁可不修也不这么做。
   *
   * 因此这里保持明确失败，只把诊断写清楚，让调用方知道该传 cwd。
   * 真正该修的是「持久化的 tab 用旧会话 id 请求数据」这个上游行为，
   * 见 .agents/notes 里那篇 bug-fix 笔记的重访信号。 */
  return {
    ok: false,
    reason: NO_CWD,
    detail: '无法确定目标仓库：该会话尚未加载或没有记录工作目录（header.cwd 缺失）。'
      + '这通常发生在持久化的看板 tab 仍用旧会话 id 请求数据时 —— '
      + '切到该会话或重新打开 tab 即可恢复。若需直接调用工具，请显式传入 cwd。'
  };
}
