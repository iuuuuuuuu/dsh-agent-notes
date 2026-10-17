/**
 * 会话级规范文本（L3 注入）。
 *
 * 这段文字只在开关打开时注入，且只注入到**当前会话**的作用域（见 index.js
 * 的 installPolicy）。它刻意写得短：系统提示词里每一行都在每轮付费，
 * 这套方法的细节应该由技能按需加载，常驻部分只放判定闸门。
 *
 * 内容取自已核实的上游判定标准（DSH 的非平凡清单），并加了本插件的落地路径，
 * 让模型知道「写在哪、用什么校验」而不是只知道「要写文档」。
 */

/** 注入的规范段落。 */
const POLICY = `# 决策笔记（Agent Notes）

仓库用 \`{lifecycle}/{class}/yyyy-mm-dd-主题.md\` 记录非平凡改动的原因与放弃的方案。
路径即状态：\`proposed/\`（未落地）\`implemented/\`（已落地）\`rejected/\`（被否）\`archived/\`（封存只读）。
分类封闭集：feature、bug-fix、simplification、architecture、process、testing。

**判定：命中任何一项即为非平凡，必须留笔记** —— 改了行为、架构、跨文件契约、流程/工具链、
测试策略，或落盘 / 网络 / 配置格式；以及其他维护者日后可能重访的决定。判不准时从严。

**机械或局部改动禁止立笔记**（直接改代码）：纯格式化、错别字、无歧义重命名、不改行为的样式调整、
不改行为的依赖补丁、版本打标、常规 CRUD、单模块内看 diff 即懂的修复。

规矩：
- 动手前先检索既有笔记；有归属的**就地更新事实**，不得把一篇笔记改写成另一个决定（理由翻转就新开一篇并互链）。
- 被放弃的方案必写，且**先写它最强的理由再否定**，不许编造没权衡过的选项。
- \`implemented\` 的 \`## Decision\` 用现在时，写已发生的事实；收益与代价都要写。
- 笔记与代码**同一次改动**落盘。

落地路径：加载 \`agent-notes\` 技能获取完整方法与模板；用 \`agent_notes_gate\` 工具跑真门禁
（退出码非 0 即失败），不要凭印象宣称合规。`;

/**
 * 返回注入用的规范文本。
 *
 * @param {string} [driftHint] 项目副本落后时的附加提示（由 project-skill.js 生成）。
 *   为空字符串或 undefined 时只返回主规范。
 * @returns {string} 规范段落。
 */
export function buildPolicyText(driftHint) {
  if (typeof driftHint !== 'string' || driftHint.trim() === '') return POLICY;
  return `${POLICY}\n\n${driftHint.trim()}`;
}

/** 便于测试断言的关键判据。 */
export const POLICY_MARKERS = Object.freeze([
  '非平凡',
  'proposed/',
  'implemented/',
  'agent_notes_gate'
]);
