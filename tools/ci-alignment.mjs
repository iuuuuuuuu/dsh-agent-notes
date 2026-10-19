/**
 * 门禁对齐检查：CI 必须跑本地 `check` 链里的每一步。
 *
 * ## 为什么需要这道门禁
 *
 * 实测踩过：连续三轮加了五道门禁（`notices:check` / `md:links` /
 * `docs:bilingual` / `text:integrity` / `release:check`），全都接进了本地
 * `npm run check`，**CI 的 verify job 一道都没跑**。
 *
 * 后果比「CI 慢」严重：那五道门禁红过时 CI 毫无反应 —— 本地成了唯一防线，
 * 而本地会被人 `--no-verify`、也会忘记跑。**门禁存在但没人执行，等于没有。**
 *
 * ## 判据
 *
 * 凡是判据只依赖「当前文件内容」的门禁，都必须出现在 CI 里。
 * 凡是判据依赖「本次变更范围」的（`notes:coverage` / `notes-supersession`）
 * 由 CI 用 `github.event.before..HEAD` 单独跑，**刻意不在本地链里用 `:last`**，
 * 所以它们算「已对齐」——通过下方的豁免表识别。
 *
 * 这比「CI 直接跑 npm run check」更严：后者一旦有人改了本地链却忘了同步 CI，
 * CI 仍然全绿；而本门禁会立刻红。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 豁免：这些步骤在 CI 里有**独立**的实现（判据不同），不算缺失。
 *
 * 键是本地链里的步骤名，值说明 CI 用什么替代。
 */
const CI_ALTERNATIVES = {
  'notes:coverage:last': 'CI 用 `--range "$github.event.before..HEAD"`（覆盖整个 push 的所有提交，更准）',
  'notes:supersession:last': '同上，用 event.before 范围',
  'npm test': 'CI 有独立的「行为测试」步骤，且前后各断言一次 vendored 未被改动'
};

const WORKFLOW = join(PACKAGE_ROOT, '.github', 'workflows', 'verify.yml');

/**
 * 执行检查。
 *
 * @returns {{ steps: string[], ciHas: string[], missing: {step: string, why: string}[], extra: string[] }} 结果。
 */
export function verifyCiAlignment() {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  const yml = readFileSync(WORKFLOW, 'utf8');

  const localSteps = pkg.scripts.check
    .split('&&')
    .map((s) => s.trim().replace(/^npm run /, ''))
    .filter((s) => s !== '' && s !== 'npm test');

  /* CI 里真正**执行**的 `npm run X`。
   *
   * 只认 `- name:` 步骤下的 `run:` 行 —— 不能扫全文。
   * 故障注入实测：把某一步的 `run: npm run text:integrity` 换成一行
   * **注释**（`# 文本完整性（这里本该有 npm run text:integrity）`）时，
   * 扫全文的实现仍然判定「已覆盖」而全绿。那正是本门禁要抓的那类缺陷
   * 自己漏掉了 —— 门禁能抓别人，抓不到自己。
   *
   * 所以判据是：`npm run X` 出现在某个 `run:` 行里，而不是出现在任何位置。
   */
  /* `run:` 行可能有多个命令：`npm run a && npm run b`。要全部抓到。
   *
   * 第一版用 `/^\s*run:.*?npm run (\w+)/` 之类：其中的 `(?:.*&&\s*)?`
   * 是可选的而 `.*` 又能吃到行尾，于是总是只抓到**最后一个**命令，
   * 前面的被漏掉 —— CI 里用 && 写法的门禁会被误报成「缺失」，
   * 让人去改本来正确的 CI。改成「先取行、再在行内抓全部」。 */
  const runLines = [...yml.matchAll(/^\s*run:(.*)$/gm)].map((m) => m[1]);
  const ciHas = [...new Set(
    runLines.flatMap((line) => [...line.matchAll(/npm run ([a-z][a-z0-9:_-]*)/g)].map((m) => m[1]))
  )];

  const missing = [];
  for (const step of localSteps) {
    if (ciHas.includes(step)) continue;
    const why = CI_ALTERNATIVES[step];
    if (why !== undefined) continue;
    missing.push({ step, why: 'CI 里找不到这一步，且没有已记录的等价替代' });
  }

  /* CI 跑了但本地链没有的 —— 只报告，不判失败。
     upstream-drift / sync:check 这类是 CI 专属，本地跑它们要么无意义
     （sync:check 本地必然一致）要么要联网。 */
  const localSet = new Set([...localSteps, ...Object.keys(CI_ALTERNATIVES)]);
  const extra = ciHas.filter((s) => !localSet.has(s));

  return { steps: localSteps, ciHas, missing, extra };
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

function main() {
  const result = verifyCiAlignment();
  const enforced = result.steps.filter((s) => CI_ALTERNATIVES[s] === undefined);

  if (result.missing.length === 0) {
    console.log(
      `门禁对齐通过：本地 check 链的 ${enforced.length} 道内容型门禁都在 CI 里`
      + `${enforced.length === 0 ? '' : `（另有 ${result.steps.length - enforced.length} 道由 CI 用独立判据覆盖）`}。`
    );
    process.exit(0);
  }

  console.error(`门禁未对齐：${result.missing.length} 道本地门禁没有在 CI 里执行`);
  for (const { step, why } of result.missing) {
    console.error(`  ✖ ${step}`);
    console.error(`      ${why}`);
  }
  console.error('');
  console.error('  后果：那道门禁红过时 CI 毫无反应 —— 本地成了唯一防线，');
  console.error('  而本地会被人 --no-verify、也会忘记跑。');
  console.error('');
  console.error('  修：把该步骤加进 .github/workflows/verify.yml 的 verify job。');
  console.error('      若 CI 用的是更强的判据（如用 event.before 覆盖整个 push），');
  console.error(`      请在 tools/ci-alignment.mjs 的 CI_ALTERNATIVES 里登记理由。`);
  process.exit(1);
}

const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replace(/\\/g, '/').endsWith('/tools/ci-alignment.mjs');
if (invokedDirectly) main();