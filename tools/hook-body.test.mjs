/**
 * commit-msg 钩子正文的行为测试。
 *
 * ## 为什么钩子正文要单独测
 *
 * 它是「门禁的门禁」——决定提交那一刻跑哪些门禁。若它：
 *
 *   - 少跑一道：实测踩过。`text-integrity` 一直在、本地也一直拦得住，
 *     但**靠人记得跑**，实测 5 次乱码里每一次都是「门禁红了但我没跑」。
 *     放进钩子就从「记得跑」变成「跑不掉」。
 *   - 多跑一道慢的：每次提交等半分钟，人就会转去 `--no-verify`，
 *     门禁彻底失效。所以必须是**快子集**，不含 `npm test`。
 *   - 路径写错：钩子静默失败，人以为有门禁而其实没有。
 *
 * 这些都无法靠「读一眼 shell 脚本」确认 —— 必须**验证正文里的命令真的
 * 指向存在的文件**，且**顺序合理**（便宜的在前，早失败）。
 *
 * ## 强调的一点
 *
 * 这份测试验的是「钩子**写了什么**」，不是「钩子跑起来会拦什么」。
 * 后者要真提交一次（见 `.probe/tmp/verify-hook-real.mjs`，不入库）——
 * 因为在临时沙箱里造出与真实仓库等价的 `node_modules`、`upstream.json`、
 * 完整笔记树等等，代价远大于收益，而对照组失败还会被误读成「钩子不对」。
 */
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { HOOK_BODY } from './hook-body.mjs';

const ROOT = join(import.meta.dirname, '..');

/** 从钩子正文里抽出所有 `node tools/xxx` 命令。 */
function hookCommands() {
  return [...HOOK_BODY.matchAll(/^node (tools\/[\w.-]+)(?:\s+(.*))?$/gm)]
    .map((match) => ({ script: match[1], args: (match[2] ?? '').trim() }));
}

test('hook: 正文以 sh 的 shebang 开头', () => {
  /* 刻意用 sh 而不是 node：Windows 上 git 自带的 sh 一定在，
     node 的路径未必在 PATH 里。钩子只做转发，判定逻辑交给 node 脚本。 */
  assert.match(HOOK_BODY, /^#!\/bin\/sh/, '必须用 sh 的 shebang');
  assert.match(HOOK_BODY, /^set -e$/m,
    '必须 set -e —— 否则第一道失败后仍会继续跑完并返回 0');
});

test('hook: 每条命令都指向真实存在的脚本（路径写错=门禁静默失效）', () => {
  const commands = hookCommands();
  assert.ok(commands.length >= 5, `钩子应跑多道门禁，实际只有 ${commands.length} 条`);
  for (const { script, args } of commands) {
    assert.ok(existsSync(join(ROOT, script)),
      `${script} 不存在 —— 钩子会静默失败，人以为有门禁而其实没有。`
      + `${args === '' ? '' : `（参数 ${args}）`}`);
  }
});

test('hook: 必含字符完整性 —— 实测 5 次乱码都因「没跑」而漏过', () => {
  /* 这道进钩子的理由不是「它重要」，而是**它已经漏过**：
     门禁一直在、本地也一直报红，但提交前没人记得跑它。
     放进钩子才把它从「记得跑」变成「跑不掉」。 */
  const scripts = hookCommands().map((c) => c.script);
  assert.ok(scripts.includes('tools/text-integrity.mjs'),
    '字符完整性必须在钩子里 —— 它是实测漏过最多的那道');
});

test('hook: 必含门禁对齐 —— 接不进 CI 的门禁等于没有', () => {
  /* 上一轮的真实缺陷：连续三轮加的五道门禁全在本地 check 链里，
     CI 一道都没跑。钩子是提交前的最后一道即时反馈。 */
  const scripts = hookCommands().map((c) => c.script);
  assert.ok(scripts.includes('tools/ci-alignment.mjs'),
    '门禁对齐必须在钩子里 —— CI 漏接门禁时这里要能发现');
});

test('hook: 不含慢门禁（npm test 等），否则会被 --no-verify 绕过', () => {
  /* 283 个用例约 34 秒。每次提交都等这么久，人就会转去 --no-verify ——
     那时门禁彻底失效，比没有门禁更糟（因为它还给人「有门禁」的错觉）。
     完整套件由 CI 兜底，那才是权威。

     **只判命令、不扫全文**：注释里写着「为什么不跑 npm run check」，
     而第一版断言扫全文，于是把自己那段解释当成了违规 —— 同类错误第三次：
     验证 A 时若连 A 的说明文字一起匹配，就分不清「A 存在」与「提到 A」。 */
  const commandLines = HOOK_BODY
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'));
  const commands = commandLines.filter((line) => line.trimStart().startsWith('node '));

  assert.ok(commands.length >= 5, `钩子应跑多道门禁，实际只有 ${commands.length} 条`);
  for (const line of commands) {
    assert.doesNotMatch(line, /npm\s+test|node --test/,
      `钩子不得跑完整测试套件：${line.trim()}`);
    assert.doesNotMatch(line, /npm run check/,
      `钩子不得跑完整 check（它含 npm test）：${line.trim()}`);
  }
});

test('hook: 覆盖门禁必须传 --message-file "$1"（否则堵死 Note-Skip 出口）', () => {
  /* `Note-Skip:` 写在提交信息里，pre-commit 阶段读不到 —— 实测那样挂会
     让人「明明写了 Note-Skip 还是被拦」，属于堵死合法出口，转去 --no-verify。 */
  const coverage = hookCommands().find((c) => c.script === 'tools/notes-coverage.mjs');
  assert.ok(coverage !== undefined, '必须跑覆盖门禁');
  assert.match(coverage.args, /--message-file\s+"\$1"/,
    '覆盖门禁必须用 --message-file "$1" 拿到本次提交信息');
});

test('hook: 覆盖与 supersession 两道都必须在（缺一即漏检）', () => {
  const scripts = hookCommands().map((c) => c.script);
  assert.ok(scripts.includes('tools/notes-coverage.mjs'), '必须有覆盖门禁');
  assert.ok(scripts.includes('tools/notes-supersession.mjs'), '必须有 supersession 检查');
});

test('hook: 便宜的检查在前，早失败省时间', () => {
  /* 字符完整性是毫秒级，npm test 是 34 秒。把快的放前面，
     一个明显坏掉的提交能在一秒内被拦下，而不是等半分钟。 */
  const scripts = hookCommands().map((c) => c.script);
  const integrity = scripts.indexOf('tools/text-integrity.mjs');
  const links = scripts.indexOf('tools/md-links.mjs');
  assert.ok(integrity >= 0 && links >= 0, '前两道应是毫秒级的检查');
  assert.ok(integrity < links, '字符完整性应排在 Markdown 链接之前（更便宜）');
});

test('hook: 必须说明绕过方式与 CI 兜底', () => {
  /* 钩子可被 --no-verify 绕过，这是为让 Note-Skip 合法出口不被堵死而
     有意做的取舍。必须写在正文里 —— 否则用它绕过的人不知道还有 CI。 */
  assert.match(HOOK_BODY, /--no-verify/, '必须说明怎么绕过');
  assert.match(HOOK_BODY, /CI/, '必须说明 CI 才是权威那道');
});

test('hook: 每道门禁前有 echo 标记，便于定位是哪一道拦的', () => {
  /* 钩子失败时 git 只给一个退出码。没有标记就得逐条手跑才知道是谁拦的 ——
     而「本地全绿、CI 变红」那类问题正是靠这个省掉一轮往返。 */
  const echoes = (HOOK_BODY.match(/^echo "▸/gm) ?? []).length;
  const commands = hookCommands().length;
  assert.equal(echoes, commands,
    `每条命令前都要有 echo 标记：实际 ${echoes} 个标记 / ${commands} 条命令`);
});