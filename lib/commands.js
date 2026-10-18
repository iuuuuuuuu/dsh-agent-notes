/**
 * `/agent-notes` 斜杠命令：开关、状态、门禁、脚手架。
 *
 * 命令直接对 UI 返回文本，**不发给模型**（DSH 的 CommandResult 语义），
 * 所以开关操作零 token 成本。
 *
 * 语法（与 /goal 的手感对齐）：
 *   /agent-notes                     查看状态
 *   /agent-notes on | off            本会话开关（持久化，重载后保持）
 *   /agent-notes on --global         全局默认（影响所有未覆盖的会话）
 *   /agent-notes off --global
 *   /agent-notes reset               清除本会话覆盖，回到全局默认
 *   /agent-notes gate [tree|format|archived]   跑真门禁
 *   /agent-notes init                在仓库里建出笔记树骨架
 *   /agent-notes sync-skill [--yes]  同步项目副本（--yes 才落盘）
 */

/* sync-skill 分支用到这两个函数。
 * **它们曾经没有导入** —— 于是 `/agent-notes sync-skill` 一执行就抛
 * `inspectProjectSkillCopy is not defined`，被 catch 包成「执行失败」。
 * 这个命令从上线起就是坏的，而没有任何测试覆盖它。
 * 补上导入是修 bug，不是重构。 */
import { inspectProjectSkillCopy, syncProjectSkillCopy } from './project-skill.js';

/** 用法文本，出错时原样返回。 */
const USAGE = [
  '用法: /agent-notes [on|off|reset|status|gate [tree|format|archived]|init] [--global]',
  '  on / off         开关本会话的决策笔记（持久化，重载后保持）',
  '  on --global      改全局默认（影响所有未单独覆盖的会话）',
  '  reset            清除本会话覆盖，回到全局默认',
  '  status           查看开关与笔记树状态',
  '  gate [name]      跑真门禁（tree / format / archived，缺省全跑）',
  '  init             在当前仓库建出 .agents/notes 骨架',
  '  sync-skill       检查项目副本是否落后（加 --yes 才落盘）'
].join('\n');

/**
 * 把开关状态渲染成人类可读文本。
 *
 * @param {{ state: any, notes: any, agent: any }} deps 依赖。
 * @returns {string} 状态文本。
 */
function renderStatus({ state, notes, agent, fallbackEnabled }) {
  const sessionId = state.sessionId(agent);
  const global = state.global();
  const session = state.session(agent);
  const effective = state.effective(agent, fallbackEnabled);
  const tree = notes.inspect(agent?.cwd);

  const lines = [
    `决策笔记: ${effective ? '开' : '关'}`,
    `  全局默认: ${global === undefined ? `未设置（插件默认 ${fallbackEnabled ? '开' : '关'}）` : global ? '开' : '关'}`,
    `  本会话  : ${session === undefined ? '未覆盖（跟随全局）' : session ? '开' : '关'}${sessionId === undefined ? '  [无会话 id]' : ''}`
  ];
  lines.push(`  笔记树  : ${tree.exists ? `${tree.root}（${Object.entries(tree.counts).map(([k, v]) => `${k} ${v}`).join('、') || '空'}）` : `未建立 — ${tree.root}`}`);
  lines.push(`  状态文件: ${state.file}`);
  return lines.join('\n');
}

/**
 * 跑门禁并渲染结果。
 *
 * 关键：**以子进程退出码为准**。输出里的 "ok" 不作为通过依据；失败时把
 * 子进程 stderr 原文附上，让用户能自己核对而不是听汇报。
 *
 * @param {{ notes: any, agent: any }} deps 依赖。
 * @param {string | undefined} gateName 门禁名，缺省全跑。
 * @returns {Promise<{ kind: 'success'|'error', text: string }>} 命令结果。
 */
async function renderGate({ notes, agent }, gateName) {
  if (gateName !== undefined && !['tree', 'format', 'archived'].includes(gateName)) {
    return { kind: 'error', text: `未知门禁 "${gateName}"。\n${USAGE}` };
  }

  const root = notes.root(agent?.cwd);
  if (!root) return { kind: 'error', text: '无法解析笔记根' };

  const results = gateName === undefined
    ? (await notes.runAll({ cwd: agent?.cwd })).results
    : [await notes.runGate(gateName, { cwd: agent?.cwd })];

  const passed = results.every((entry) => entry.passed);
  const body = results.map((entry) => {
    const head = `[${entry.passed ? 'PASS' : 'FAIL'}] ${entry.gate} (exit=${entry.exitCode ?? 'null'})`;
    const text = [entry.stdout, entry.stderr]
      .filter((part) => typeof part === 'string' && part.trim() !== '')
      .join('\n')
      .trim();
    const reason = entry.reason ? `  ${entry.reason}` : '';
    return text === '' ? `${head}${reason}` : `${head}${reason}\n${text}`;
  }).join('\n\n');

  return {
    kind: passed ? 'success' : 'error',
    text: `决策笔记门禁（${results.length} 条）:\n${body}`
  };
}

/**
 * 注册 `/agent-notes` 命令。
 *
 * @param {any} ctx Cordis 上下文。
 * @param {{ state: any, notes: any, effective: Function, config: any }} deps 依赖。
 */
export function registerCommands(ctx, { state, notes, effective, config }) {
  if (config.registerCommands === false) return;

  ctx.inject(['commands'], (subCtx) => {
    const runtime = subCtx.commands;
    if (runtime === undefined || typeof runtime.register !== 'function') return;

    subCtx.effect(() => runtime.register({
      name: 'agent-notes',
      description: '决策笔记开关与门禁：本会话/全局开关、跑校验、建笔记树',
      input: { hint: 'on|off|reset|status|gate|init [--global]' },

      /**
       * @param {any} invocation 命令调用信息。
       * @returns {Promise<{ kind: 'success'|'error', text: string }>} 结果。
       */
      async handler(invocation) {
        const raw = String(invocation.rawInput ?? '').trim();
        const agent = invocation.agent;
        const parts = raw === '' ? [] : raw.split(/\s+/);
        const action = (parts[0] ?? 'status').toLowerCase();
        const globalFlag = parts.includes('--global');
        /* 兜底是**关**：只有显式配 enabled: true 才算默认开。
           这样装上插件不会悄悄打开任何会话，需要时手动 /agent-notes on。 */
        const fallbackEnabled = config.enabled === true;

        try {
          switch (action) {
            case 'status': {
              return { kind: 'success', text: renderStatus({ state, notes, agent, fallbackEnabled }) };
            }

            case 'on':
            case 'off': {
              const value = action === 'on';
              if (globalFlag) {
                const changed = state.setGlobal(value);
                const sessionNote = state.session(agent) === undefined
                  ? '本会话跟随该默认'
                  : '本会话已有独立覆盖，不受影响';
                return {
                  kind: 'success',
                  text: `全局默认已设为「${value ? '开' : '关'}」${changed ? '' : '（原本就是该值）'}。影响所有未单独覆盖的会话；${sessionNote}。`
                };
              }
              const changed = state.setSession(agent, value);
              return {
                kind: 'success',
                text: `本会话决策笔记已设「${value ? '开' : '关'}」${changed ? '' : '（原本就是该值）'}，已持久化，重载后保持。`
              };
            }

            case 'reset': {
              const changed = state.setSession(agent, null);
              return {
                kind: 'success',
                text: changed
                  ? `已清除本会话覆盖，现跟随全局默认（${state.effective(agent, fallbackEnabled) ? '开' : '关'}）。`
                  : '本会话本来就没有覆盖，无需清除。'
              };
            }

            case 'gate': {
              const gateName = parts[1] !== undefined && !parts[1].startsWith('--') ? parts[1].toLowerCase() : undefined;
              return await renderGate({ notes, agent }, gateName);
            }

            case 'init': {
              const created = notes.scaffold({ cwd: agent?.cwd });
              return {
                kind: 'success',
                text: `已建出笔记树骨架:\n${created.created.map((dir) => `  ${dir}`).join('\n')}\n\n接着按 SKILL.md 写第一篇笔记；门禁用 /agent-notes gate 跑。`
              };
            }

            case 'sync-skill': {
              /* 项目副本归项目仓库所有，插件不擅自改 —— 所以分两步：
                 不带 --yes 只报告差异，带 --yes 才落盘。 */
              const cwd = agent?.cwd;
              if (typeof cwd !== 'string' || cwd === '') {
                return { kind: 'error', text: '拿不到当前会话的工作目录，无法定位项目副本。' };
              }
              const info = inspectProjectSkillCopy(cwd);
              if (!info.present) {
                return {
                  kind: 'success',
                  text: `本项目没有 \`.agents/skills/agent-notes/\` 副本，无需同步。\n`
                    + `（插件自带的技能不受影响；这份副本只服务于项目自己的 CI 门禁。）`
                };
              }
              if (!info.behind) {
                return {
                  kind: 'success',
                  text: `项目副本已与插件内置版本一致（${info.changed.length} 改 / ${info.missing.length} 缺）。`
                    + (info.extra.length > 0 ? `\n项目里另有 ${info.extra.length} 个内置版本没有的文件，不会被动。` : '')
                };
              }

              const dryRun = !parts.includes('--yes');
              const result = syncProjectSkillCopy(cwd, { dryRun });
              const lines = [
                `插件内置 → 项目副本：${result.written.length} 个文件有差异`,
                dryRun ? '  预览（未写入）' : '  已写入',
                '',
                ...result.written.map((rel) => `  ${rel}`)
              ];
              if (result.kept.length > 0) {
                lines.push('', `保留（内置版本没有，可能是项目自己加的）: ${result.kept.length} 个`);
              }
              lines.push(
                '',
                '这套脚本是项目 CI 门禁实际执行的文件（ci.yml → npm run verify-notes → scripts/*.ts），',
                '所以同步它就等于更新了 CI 用的校验逻辑，**不需要改 ci.yml**。',
                '脚本零外部依赖，只用 node 内置模块。'
              );
              if (dryRun) {
                lines.push('', '以上是预览，未写入。加 --yes 真的落盘：', '  /agent-notes sync-skill --yes');
              } else {
                lines.push('', '已写入。别忘了 commit —— 这份副本被项目 git 跟踪。');
              }
              return { kind: 'success', text: lines.join('\n') };
            }

            default:
              return { kind: 'error', text: `未知参数 "${action}"。\n${USAGE}` };
          }
        } catch (error) {
          return { kind: 'error', text: `执行失败: ${String(error?.message ?? error)}` };
        }
      }
    }), 'agent-notes.command()');
  });
}
