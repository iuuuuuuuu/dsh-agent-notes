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
 * ## 两类缺口，同一个病根
 *
 * 这道门禁原本只读 `verify.yml` 一个文件，且只做「本地 ⊆ CI」**单向包含**。
 * 于是有两类东西没人管，而它们恰好是**保护发布的那道门禁本身**：
 *
 * 1. `upstream-sync.yml` 完全不在判据里。它握 `contents: write`、
 *    `git push` 到 main、还 `git push origin <tag>`，是真正的发布动作。
 *    实测：把它那道「合并后必须通过才允许提交」整步删掉，
 *    **整条 check 链仍然 exit 0** —— 那道门禁本身没有任何门禁在保护。
 * 2. `verify.yml` 自己的安全属性（能否在 PR 上触发、checkout 深度够不够、
 *    有没有断言「测试没写脏工作区」、权限是否被放宽）也没人问。
 *
 * 病根是同一个：**门禁只校验「自己声明的那份东西」，没人校验「门禁自己的
 * 基础设施」** —— 而后者一旦被删，删掉的那一刻不会有任何声音。
 *
 * ## 判据
 *
 * ### 1. 步骤覆盖（本地 ⊆ CI）
 *
 * 凡是判据只依赖「当前文件内容」的门禁，都必须出现在 CI 里。
 * 凡是判据依赖「本次变更范围」的（`notes:coverage` / `notes-supersession`）
 * 由 CI 用 `github.event.before..HEAD` 单独跑，**刻意不在本地链里用 `:last`**，
 * 所以它们算「已对齐」——通过下方的豁免表识别。
 *
 * 这比「CI 直接跑 npm run check」更严：后者一旦有人改了本地链却忘了同步 CI，
 * CI 仍然全绿；而本门禁会立刻红。
 *
 * ### 2. 两种 workflow，两种覆盖口径
 *
 * - `verify.yml` 是**发布前的主验证**，必须跑齐本地链的每一步（`mode: 'all'`）。
 * - `upstream-sync.yml` 是**自动合并上游后直接发布**，刻意只跑 4 步
 *   （`mode: 'subset'`）。这是**有意的取舍，不是遗漏**，理由分两类：
 *   `doc:budget` / `docs:bilingual` / `release:check` 判的是**人写的文档与
 *   发版记账**，而这个 job 推的是上游内容、不改这些文件，跑它们纯属浪费；
 *   `notes:coverage` / `supersession` 判的是**本次提交的改动范围**，
 *   机器人那个 commit 由本 job 自己生成、不经人审。
 *   取舍成立，但**必须显式登记** —— 否则将来有人从那 4 步里删掉一道时，
 *   没有人知道少了东西（这正是本门禁最初要解决的那类事故）。
 *
 * ### 3. 安全属性（反向：CI 自身的必要属性不能被删）
 *
 * 包含式判据看不见「把一个步骤换成 `true`」。下面几条是**断言式**的：
 * 删掉即红，且每条都对应一个真实故障模式（理由写在 workflow 注释里）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKFLOW_DIR = join(PACKAGE_ROOT, '.github', 'workflows');

/**
 * `continue-on-error` 的**值**：唯一允许字面量 `false`。
 *
 * 这里刻意用「默认拒绝」而不是「列举所有 true 的写法」。第一版列举了
 * `true` / `True` / `"true"` / `${{ true }}`，CodeRabbit 接着就用
 * `${{ true || false }}` 绕过去了 —— 表达式是图灵完整的，列举永远补不完；
 * 而 `${{ matrix.experimental }}` 这类写法本质就是「有时把门禁降级」，
 * 本仓库的政策是门禁不许被降级，任何非 `false` 的值都该让人来解释。
 *
 * 代价：将来真要写条件降级，得先改这条判据 —— 那正是要的摩擦。
 */
const CONTINUE_ON_ERROR_VALUE_OK = /^(?:false|"false"|'false')$/;

/**
 * 候选键：可以带引号，也可以是裸标识符，后面跟冒号。
 *
 * ## 为什么不再用「键名 + 冒号」的正则
 *
 * 那个写法被 CodeRabbit 连着指出五次缺口，每次都是同一个毛病的另一面：
 * 它把「键在源码里长什么样」当成了证据，而 YAML 允许同一个键有很多长相 ——
 * 位置（行首 / 列表项 / flow 映射）、引号（无 / `"…"` / `'…'`）、
 * 以及**双引号里的转义**（`"continue\u002don-error"` 解码后就是同一个键）。
 *
 * 所以这里改成：先把候选键**解码**成真实键名，再与判据要的键名比字符串。
 * 位置、引号、转义这三个维度因此一起消失。
 *
 * 只解码 double-quoted 的转义（YAML 规范里单引号只有 `''` 一种转义，
 * 其余一律字面量）—— 这是有边界的，不是「再来一种正则」。
 *
 * ## 为什么逐行扫、而且要求前面是「键可以出现的位置」
 *
 * 第一版是全文扫的，`["'](?:…|\\|)*?["']` 里的引号跨行匹配。实测立刻炸：
 * `verify.yml` 的 shell 片段里有 `if [ "$A" = "0" ]; then`，`$A` 前面那个
 * `"` 与下一行的 `"` 被配成一对，**跨行吞掉十几行**，中间新插的
 * `continue-on-error: true` 一起消失 —— 判据看不见它，用例红在「本该红」。
 *
 * 所以：引号必须同行闭合，且键前面只能是行首、空白、`{`、`,`、`-`
 * （YAML 里键就是出现在这几种位置）。这不是在补第 N 种写法，而是把
 * 「一个键从这里开始」这条语法约束显式写出来。
 */
const YAML_KEY_ENTRY =
  /(?<=^|[\s{,\-])(?<q>["'])(?<quoted>(?:\\.|(?!\k<q>)[^\\\n])*?)\k<q>[ \t]*:|(?<=^|[\s{,\-])(?<bare>[A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:/gu;

/**
 * 解码 YAML double-quoted 标量里的转义。
 *
 * 只实现「会产生不同键名」的那几种（`\uXXXX`、`\UXXXXXXXX`、`\xXX`）与常见字符转义。
 *
 * `\U`（8 位十六进制）必须一起处理：CodeRabbit 在 PR #31 上指出
 * `"continue\U0000002don-error": true` 会被 YAML 解码成同一个键，而漏掉 `\U`
 * 的结果是**放行** —— 与本门禁「默认拒绝」的方向相反，不能按「解不出来就原样保留」处理。
 *
 * 非法码点（代理区 / 超出 U+10FFFF）会让 `String.fromCodePoint` 抛 `RangeError`，
 * 所以先判范围，超界的那个转义**原样保留**（键名对不上就是不放行，方向一致）。
 *
 * @param {string} raw 引号内的原文。
 * @returns {string} 解码后的键名。
 */
function decodeYamlQuoted(raw) {
  return raw.replace(
    /\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|x([0-9A-Fa-f]{2})|([0nt"\\/]))/g,
    (whole, u, bigU, x, simple) => {
      if (u !== undefined) return String.fromCharCode(parseInt(u, 16));
      if (bigU !== undefined) {
        const codePoint = parseInt(bigU, 16);
        if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return whole;
        return String.fromCodePoint(codePoint);
      }
      if (x !== undefined) return String.fromCharCode(parseInt(x, 16));
      if (simple === 'n') return '\n';
      if (simple === 't') return '\t';
      return simple;
    }
  );
}

/**
 * 切掉 YAML 的行尾注释（`#` 前面必须有空白，否则是值的一部分）。
 *
 * 不切会把合法写法判红：`cancel-in-progress: ${{ … == 'pull_request' }} # 仅取消 PR`
 * 的取消条件没变，但值里带上注释就过不了允许值式（CodeRabbit 在 PR #31 上指出）。
 *
 * @param {string} value 冒号右边到行尾的原文。
 * @returns {string} 去掉行尾注释后的值。
 */
function stripInlineComment(value) {
  const at = value.search(/(?:^|[ \t])#/u);
  if (at === -1) return value;
  return value.slice(0, at);
}

/**
 * 扫出全篇所有键的出现处（键名已解码，值取冒号右边到行尾）。
 *
 * 值用「从 match 结束处往后取到行尾」算出来，而不是被正则一起吃掉 ——
 * 否则 flow 映射里后续的键（`{a: 1, cancel-in-progress: true}`）会被第一个
 * 匹配连值带键一起吞掉，判据就永远看不到它。
 *
 * @param {string} yml workflow 原文。
 * @returns {{key: string, value: string}[]} 键与值。
 */
function yamlKeyEntries(yml) {
  const bare = stripComments(yml);
  const entries = [];
  for (const match of bare.matchAll(YAML_KEY_ENTRY)) {
    const key = match.groups.quoted !== undefined
      ? decodeYamlQuoted(match.groups.quoted)
      : match.groups.bare;
    const tail = bare.slice(match.index + match[0].length);
    entries.push({ key, value: stripInlineComment(tail.slice(0, tail.search(/\n|$/u))) });
  }
  return entries;
}

/**
 * 找出**所有**不合约定的 `continue-on-error` 出现处（空数组才是通过）。
 *
 * 键的写法一律不管（见 `yamlKeyEntries`），只看冒号右边的值是否字面量 `false`。
 *
 * 残留的误判方向：`run:` 里如果出现字符串字面量 `continue-on-error: 某个值`，
 * 会被当成真的键而判红。偏向失败（要人来解释），与政策一致。
 *
 * @param {string} yml workflow 原文。
 * @returns {string[]} 违规的「键: 值」原文。
 */
function offendingContinueOnError(yml) {
  return yamlKeyEntries(yml)
    .filter((entry) => entry.key === 'continue-on-error')
    /* 值先在首个空白/逗号/`}` 处截断（`trim` 后取第一个词，
       否则冒号后的那个空格会被当成「值为空」）。 */
    .map((entry) => ({ ...entry, value: (entry.value.trim().split(/[\s,}#]/u)[0] ?? '') }))
    .filter((entry) => !CONTINUE_ON_ERROR_VALUE_OK.test(entry.value))
    .map((entry) => `continue-on-error: ${entry.value}`);
}

/**
 * `cancel-in-progress` 唯一允许的**值**：等于比较收窄到 `pull_request`。
 *
 * 同样默认拒绝。只要求「这一行里出现 `github.event_name` 与 `pull_request`」
 * 会放过语义相反的 `${{ github.event_name != 'pull_request' }}` —— 它在 push 上
 * 才取消，正好取消掉要保住的那些运行；CodeRabbit 在 PR #30 上指出的就是这个。
 * `&&` / `||` 组合不做语义推导：能自动判对的前提是有解析器，这里没有。
 */
const CANCEL_ONLY_FOR_PR =
  /^\s*\$\{\{\s*github\.event_name\s*==\s*'pull_request'\s*\}\}\s*[,}]*$/;

/**
 * 取出所有 `cancel-in-progress` 的**值**（不含键、位置、引号与转义）。
 *
 * @param {string} yml workflow 原文。
 * @returns {string[]} 各处的值（仅去行尾空白）。
 */
function cancelInProgressValues(yml) {
  return yamlKeyEntries(yml)
    .filter((entry) => entry.key === 'cancel-in-progress')
    .map((entry) => entry.value.trim());
}


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

/**
 * 每个 workflow 的覆盖口径。
 *
 * `mode: 'all'`    —— 必须跑齐本地链的每一步（verify.yml 是发布前的主验证）。
 * `mode: 'subset'` —— 必须跑齐 `required` 里列的那些步（upstream-sync.yml 是
 *                    自动合并上游后直接发布，刻意只跑内容与行为那几道）。
 *
 * ⚠️ **登记豁免不是免责，是给删除行为装上报警器。** 实测正是这里出过事：
 * `upstream-sync.yml` 里那道「合并后必须通过才允许提交」握 `contents: write`、
 * push 到 main 还 push tag，而它一度**没有任何门禁在保护** —— 删掉整步，
 * 整条 check 链仍然 exit 0。
 *
 * @type {{file: string, mode: 'all'|'subset', required: string[], exempt: string[]}[]}
 */
const WORKFLOWS = [
  {
    file: 'verify.yml',
    mode: 'all',
    required: [],
    exempt: []
  },
  {
    file: 'upstream-sync.yml',
    mode: 'subset',
    /* 这 4 步是「合并了上游、准备发布」之前的最后一道闸：内容自洽
       （verify）、笔记格式（notes:gate）、行为（npm test）、门禁会红
       （fault-injection）。任缺其一，自动合并就能把坏内容推到 main。 */
    required: ['verify', 'notes:gate', 'npm test', 'gate:fault-injection'],
    /* 下面这些**刻意不跑**，理由必须写清楚，否则将来没人敢动：
       - notices:check / md:links：判上游 vendored 内容与第三方归属。上游内容
         由 sync-upstream 自己按 ref 与哈希保证，归属声明只针对本仓库引入的依赖。
       - docs:bilingual / docs:links / doc:budget / release:check：判**人写的**
         文档与发版记账。这个 job 不改 README/CHANGELOG，跑它们只会因
         「本来就超预算」误报。
       - ci:align：判的是 verify.yml 的步骤完整性，与本 job 无关。
       - text:integrity：判全仓文本，对上游原文无意义（上游原文可能含它自己的字符）。
       - notes:coverage / supersession：判「本次提交范围」，机器人 commit 不经人审。 */
    exempt: [
      'notices:check',
      'md:links',
      'docs:bilingual',
      'docs:links',
      'text:integrity',
      'release:check',
      'ci:align',
      'doc:budget',
      'notes:coverage:last',
      'notes:supersession:last'
      /* ⚠️ 这里**刻意不含** `npm test`：它在这个 job 里就是 required 的一员。 */
    ]
  }
];

/**
 * workflow 自身必须保持的安全属性。
 *
 * 这些是**断言式**判据：包含式检查看不见「把一步换成 `true`」或「把某个
 * 配置项删掉」。每条都对应一个**已经发生过或注释里写明**的故障模式。
 *
 * `verify` 为真时只在该文件里查；`false` 表示与文件无关。
 *
 * @type {{file: string, key: string, desc: string, test: (yml: string) => boolean}[]}
 */
const SAFETY = [
  {
    file: 'verify.yml',
    key: 'triggers-on-pr',
    desc: '必须在 pull_request 上触发（否则 PR 完全无门禁，本地链成为唯一防线）',
    test: (yml) => /^[^\S\n]*pull_request[^\S\n]*:/m.test(stripComments(yml))
  },
  {
    file: 'verify.yml',
    key: 'full-history-checkout',
    desc: 'checkout 必须 fetch-depth: 0（默认 depth 1 拿不到上一个 commit，'
      + '笔记覆盖门禁会退化成「查不到」而报 2）',
    test: (yml) => /^[^\S\n]*fetch-depth:[^\S\n]*0[^\S\n]*$/m.test(stripComments(yml))
  },
  {
    file: 'verify.yml',
    key: 'read-only-permissions',
    desc: 'permissions 必须是最小读权限（放宽成 write 会让被测代码有机会改仓库）',
    test: (yml) => /^[^\S\n]*contents:[^\S\n]*read[^\S\n]*$/m.test(stripComments(yml))
  },
  {
    file: 'verify.yml',
    key: 'asserts-clean-worktree',
    desc: '必须断言「测试没有写脏工作区」（fire-and-forget 副作用会在测试结束后继续写盘，'
      + '实测发生过：CI 检出后 vendored 是新的，跑完 npm test 变成旧的）',
    test: (yml) => stripComments(yml).includes('git status --porcelain')
  },
  {
    file: 'upstream-sync.yml',
    key: 'gates-before-publish',
    desc: '必须存在那道「合并后必须通过才允许提交」的闸，且它排在 commit/push 之前'
      + '（这个 job 有 contents: write、会 push main 与 tag —— 门禁在发布之后就没有意义了）',
    test: (yml) => {
      const body = stripComments(yml);
      const gateAt = body.search(/npm run verify/);
      const pushAt = body.search(/^\s*git (commit|push)/m);
      return gateAt !== -1 && (pushAt === -1 || gateAt < pushAt);
    }
  },
  {
    file: 'upstream-sync.yml',
    key: 'pushes-are-gated',
    desc: 'git push / git tag 必须处于「合并后必须通过才允许提交」那一步的 if 保护之下',
    test: (yml) => {
      const body = stripComments(yml);
      /* 找「跑门禁」那一步，看它的 if 是否真的挂在 push 那一步上。
         判据从简：门禁与 push 必须同处一个 job 且门禁在先（上面已查顺序），
         这里再查两者都被 `if: steps.sync.outputs.changed` 这类条件约束。 */
      return /\bif:[^\n]*changed/m.test(body) || !/^\s*git push/m.test(body);
    }
  },
  {
    file: 'verify.yml',
    key: 'no-continue-on-error',
    desc: '任何一步都不得带 continue-on-error: true（那等于把门禁静默降级成警告，'
      + 'CI 照样绿 —— 门禁存在但没人执行等于没有）',
    test: (yml) => offendingContinueOnError(yml).length === 0
  },
  {
    file: 'upstream-sync.yml',
    key: 'no-continue-on-error',
    desc: '任何一步都不得带 continue-on-error: true（同上；这个 workflow 有 '
      + 'contents: write 且会 push main/tag，静默降级一道门禁的代价更大）',
    test: (yml) => offendingContinueOnError(yml).length === 0
  },
  {
    file: 'verify.yml',
    key: 'has-concurrency',
    desc: '必须声明 concurrency 块（同一个 PR 上新推的提交会让旧的那次验证'
      + '白跑完并给出过期结论 —— 上游 A 用同一形态）',
    test: (yml) => concurrencyBlock(yml) !== null
  },
  {
    file: 'verify.yml',
    key: 'cancels-only-superseded-pr',
    desc: 'cancel-in-progress 不得无条件为 true：main 上的验证是「这次发布'
      + '过没过门禁」的唯一凭据（branch protection 强制要求），被下一次运行'
      + '取消掉就等于发布没有验证记录。只能按事件收窄到 pull_request。',
    test: (yml) => {
      if (concurrencyBlock(yml) === null) return false;
      /* 键的位置与引号一律不管（同 `offendingContinueOnError` 的教训），只看值。 */
      const values = cancelInProgressValues(yml);
      if (values.length === 0) return false;
      /* 只接受**等于**比较那一种值；`!=`、`&&`、`||`、裸 true 全部拒绝。 */
      return values.every((value) => CANCEL_ONLY_FOR_PR.test(value));
    }
  },
  {
    file: 'verify.yml',
    key: 'no-persisted-credentials',
    desc: '每一处 checkout 都必须 persist-credentials: false：这个 job 会跑仓库里'
      + '的脚本（npm test），脚本若能拿到可写凭据，一次「测试」就可能变成一次 push',
    test: (yml) => {
      const blocks = checkoutBlocks(yml);
      if (blocks.length === 0) return false;
      return blocks.every((block) => /persist-credentials:\s*false/.test(block));
    }
  },
  {
    file: 'upstream-sync.yml',
    key: 'has-concurrency',
    desc: '必须声明 concurrency 块（两个同步任务同时 push main 会打架）',
    test: (yml) => concurrencyBlock(yml) !== null
  },
  {
    file: 'upstream-sync.yml',
    key: 'never-cancels-a-push',
    desc: 'cancel-in-progress 必须为 false：这个 job 会 push main 与 push tag，'
      + '中途取消会留下半推状态（tag 推了 main 没推、或反过来）',
    test: (yml) => {
      const block = concurrencyBlock(yml);
      if (block === null) return false;
      return /cancel-in-progress:\s*false/.test(block);
    }
  },
  {
    file: 'upstream-sync.yml',
    key: 'keeps-credentials-for-push',
    desc: '发布 job 不得关掉 checkout 的凭据：它靠这份凭据 push main 与 push tag。'
      + '上游 A 的只读 workflow 用 persist-credentials: false，照抄过来会让发布失败。',
    test: (yml) => {
      const blocks = checkoutBlocks(yml);
      if (blocks.length === 0) return false;
      return blocks.every((block) => !/persist-credentials:\s*false/.test(block));
    }
  }
];

/**
 * 抽出一个 workflow 里的 `concurrency:` 块。
 *
 * 块标量与普通键值两种写法都要认：
 *
 * ```yaml
 * concurrency:
 *   group: x
 *   cancel-in-progress: true
 * ```
 *
 * @param {string} yml 原文。函数内部自己去掉整行注释。
 * @returns {string|null} 块内容；没有该块时返回 null。
 */
function concurrencyBlock(yml) {
  const lines = stripComments(yml).split('\n');
  const index = lines.findIndex((line) => /^\s*concurrency:\s*$/.test(line));
  if (index === -1) return null;

  const baseIndent = lines[index].length - lines[index].trimStart().length;
  const body = [];
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') { body.push(''); continue; }
    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) break;
    body.push(line);
  }
  return body.join('\n');
}

/**
 * 抽出每一条 `uses: actions/checkout` 步骤的 `with:` 块。
 *
 * 为什么按块收而不是按行找 `persist-credentials:`：判据要问的是
 * 「**这一处** checkout 关掉凭据了吗」，而不是「文件里有没有出现过
 * persist-credentials」。按行找会漏掉「一处关掉、一处没关」的情况 ——
 * 而那正是真实故障形态（复制粘贴加了一处，忘了另一处）。
 *
 * @param {string} yml 原文。函数内部自己去掉整行注释。
 * @returns {string[]} 每个 checkout 步骤的 `with:` 块文本。
 */
function checkoutBlocks(yml) {
  const lines = stripComments(yml).split('\n');
  const blocks = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*-?\s*uses:\s*actions\/checkout/.test(lines[i])) continue;
    const baseIndent = lines[i].length - lines[i].trimStart().length;
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') { body.push(''); continue; }
      const indent = line.length - line.trimStart().length;
      if (indent <= baseIndent) break;
      body.push(line);
    }
    blocks.push(body.join('\n'));
  }

  return blocks;
}

/**
 * 去掉整行注释。
 *
 * 判据必须只看**真正会被执行**的内容 —— 注释里提到 `npm run X` 不算数。
 * 故障注入实测：把某步的 `run: npm run text:integrity` 换成注释时，
 * 扫全文的实现仍判「已覆盖」而全绿。那正是本门禁要抓的那类缺陷自己漏掉了。
 *
 * ⚠️ 只删「整行都是注释」的行。行尾 `; # xxx` 这类不删 —— 多数 YAML 语义上
 * `#` 后确实是注释，但本仓库的判据不依赖它，删错反而会制造假绿。
 *
 * @param {string} yml 原文。
 * @returns {string} 去掉整行注释后的文本。
 */
function stripComments(yml) {
  return yml
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * 抽出一个 workflow 里**真正被执行**的门禁命令。
 *
 * ## 为什么不能只用一条正则
 *
 * 两种写法都要认：
 *
 * ```yaml
 * - name: 包自检
 *   run: npm run verify            # 单行
 * - name: 门禁
 *   run: |                          # 块标量（upstream-sync 用的是这种）
 *     npm run verify
 *     npm test
 * ```
 *
 * 故障注入实测：只匹配 `^\s*run:` 单行的实现，对 `upstream-sync.yml`
 * 抽出的结果是 **`[]`** —— 那 4 步全在 `run: |` 块里。若照搬旧实现去扫
 * 所有 workflow，这个文件会被判成「一道门禁都没跑」，然后因为
 * `notices:check` 等在豁免表里而**恰好蒙对**，看起来是好的 ——
 * 但真删掉那 4 步里的 `verify` 时它会误判为「本来就是豁免的」。假绿。
 *
 * 块标量的续行是**缩进更深**的行，据此收拢。
 *
 * @param {string} yml 原文。
 * @returns {{ scripts: string[], tests: number }} `scripts` 是 `npm run X` 的 X；
 *   `tests` 是裸 `npm test` 的出现次数。
 */
export function extractGateCommands(yml) {
  const scripts = new Set();
  let tests = 0;
  const lines = stripComments(yml).split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    /* `- run: cmd` 与 `- name: x` / `  run: cmd` 都是合法写法 ——
       前者是「这一步只有命令没有名字」，很多精简的 workflow 就这么写。 */
    const inline = /^\s*(?:-\s+)?run:(.*)$/.exec(line);
    if (inline === null) continue;

    /* 单行写法：`run: npm run a && npm run b` */
    const body = [inline[1]];
    /* 块写法：`run: |` / `run: >-` 等，后续缩进更深的行都算这一条命令。 */
    if (inline[1].trim() === '' || /^[|>][-+]?\d*$/.test(inline[1].trim())) {
      const baseIndent = line.length - line.trimStart().length;
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j];
        if (next.trim() === '') { body.push(''); continue; }
        const indent = next.length - next.trimStart().length;
        if (indent <= baseIndent) break;
        body.push(next);
      }
    }
    const text = body.join('\n');
    for (const m of text.matchAll(/npm run ([a-z][a-z0-9:_-]*)/g)) scripts.add(m[1]);
    /* 裸 `npm test`（不带 run）也算一道门禁，但要和 `npm run xxx` 分开算。
     *
     * ⚠️ 必须排除 `--if-present`：它的语义是「脚本不存在就跳过」，
     * 等于**没有这道门禁**。而 upstream-sync 的 npm test 后面就是
     * `git push main` + `git push tag` —— 测试不跑也能发布。
     *
     * 实测踩过：把 `npm test` 改成 `npm test --if-present`，
     * 本检查仍报「齐全」，exit 0。判据匹配了字面量，没匹配语义。 */
    const testMatches = [...text.matchAll(/(?:^|[;&|\n]\s*|\s)npm test(?![\w-])((?:\s+[^\s;&|]+)*)/g)];
    for (const m of testMatches) {
      const flags = m[1] ?? '';
      /* `--if-present` / `--if-present=true` / `-if-present` 都算「可跳过」。 */
      if (/--?if-present/.test(flags)) continue;
      tests += 1;
    }
  }
  return { scripts: [...scripts], tests };
}

/**
 * 执行**主 workflow**（`verify.yml`）的步骤覆盖检查。
 *
 * 保留这个函数名与签名，是为了不破坏既有调用方（测试与历史笔记都提到它）。
 * 它现在只是 `verifyAll()` 里的一段 —— 真正的判据见下面的 `extractGateCommands`
 * 与 `verifyAll`。
 *
 * @returns {{ steps: string[], ciHas: string[], missing: {step: string, why: string}[], extra: string[] }} 结果。
 */
export function verifyCiAlignment() {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  const yml = readFileSync(join(WORKFLOW_DIR, 'verify.yml'), 'utf8');

  const localSteps = pkg.scripts.check
    .split('&&')
    .map((s) => s.trim().replace(/^npm run /, ''))
    .filter((s) => s !== '' && s !== 'npm test');

  /* CI 里真正**执行**的 `npm run X`。
   *
   * 只认会被执行的 `run:` 内容 —— 不能扫全文。
   * 故障注入实测：把某一步的 `run: npm run text:integrity` 换成一行
   * **注释**（`# 文本完整性（这里本该有 npm run text:integrity）`）时，
   * 扫全文的实现仍然判定「已覆盖」而全绿。那正是本门禁要抓的那类缺陷
   * 自己漏掉了 —— 门禁能抓别人，抓不到自己。
   *
   * 所以判据是：`npm run X` 出现在某个 `run:` 的内容里，而不是出现在任何位置。
   */
  /* `run:` 里可能有多个命令：`npm run a && npm run b`。要全部抓到。
   *
   * 第一版用 `/^\s*run:.*?npm run (\w+)/` 之类：其中的 `(?:.*&&\s*)?`
   * 是可选的而 `.*` 又能吃到行尾，于是总是只抓到**最后一个**命令，
   * 前面的被漏掉 —— CI 里用 && 写法的门禁会被误报成「缺失」，
   * 让人去改本来正确的 CI。改成「先取行、再在行内抓全部」。 */
  const { scripts } = extractGateCommands(yml);
  const ciHas = scripts;

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

/**
 * 列出 `.github/workflows/` 下所有 workflow 文件名。
 *
 * 不写死文件名 —— 将来新增第三个 workflow，本门禁会自动把它纳入覆盖范围，
 * 而不是像原来那样悄悄漏掉（那正是本门禁要解决的那类事故的翻版）。
 *
 * @returns {string[]} 文件名，按字典序。
 */
export function listWorkflowFiles() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
}

/**
 * 执行全部检查：步骤覆盖 + 安全属性。
 *
 * @returns {{
 *   steps: string[], ciHas: string[], missing: {step: string, why: string}[], extra: string[],
 *   workflows: {file: string, mode: string, missing: {step: string, why: string}[]}[],
 *   unsafe: {file: string, key: string, desc: string}[],
 *   unknown: string[]
 * }} 结果。
 */
export function verifyAll() {
  const localSteps = verifyCiAlignment().steps;
  const files = listWorkflowFiles();

  /* 没登记的 workflow：不猜它的口径，但要**说出来**。
     静默放行正是本门禁最初的病根（门禁在 CI 里缺席却没人知道）。 */
  const unknown = files.filter((f) => !WORKFLOWS.some((w) => w.file === f));

  const workflows = [];
  const unsafe = [];

  for (const spec of WORKFLOWS) {
    const file = join(WORKFLOW_DIR, spec.file);
    /* ⚠️ 登记在册的 workflow 不见了 —— 必须判失败，且**不能抛异常**。
       抛异常虽然也是非零退出码，但给出的是栈而不是判据输出；
       本仓库的硬约束是「脚本缺失、超时算失败，但不得降级为通过」，
       所以这里显式判红并说清楚是哪一步没得验。 */
    if (!existsSync(file)) {
      unsafe.push({
        file: spec.file,
        key: 'workflow-missing',
        desc: '登记在册的 workflow 文件不存在 —— 无法验证它跑没跑门禁（删掉它会让保护彻底消失）'
      });
      workflows.push({ file: spec.file, mode: spec.mode, missing: [] });
      continue;
    }
    const found = readFileSync(file, 'utf8');
    const { scripts, tests } = extractGateCommands(found);

    /* mode 'all'   —— 本地链每一步都要在（CI_ALTERNATIVES 已登记的除外）。
       mode 'subset' —— 只要 required 里的都在。

       ⚠️ 两种口径的豁免来源**必须分开**，不能共用：
       `CI_ALTERNATIVES['npm test']` 那条说的是「verify.yml 里 npm test 有独立
       的、判据更强的步骤（前后各断言一次 vendored 未被改动）」，而
       upstream-sync.yml 里就是一行裸 `npm test`，没有任何额外断言。
       共用豁免表会让 subset 模式把 `npm test` 永久豁免掉 ——
       故障注入实测：删掉那行 `npm test` 后整条链仍然 exit 0。
       所以 subset 只认自己的 `spec.exempt`。 */
    const have = new Set(scripts);
    if (tests > 0) have.add('npm test');
    const wanted = spec.mode === 'all' ? localSteps : spec.required;
    const exempt = new Set(spec.mode === 'all'
      ? [...spec.exempt, ...Object.keys(CI_ALTERNATIVES)]
      : spec.exempt);

    const wfMissing = [];
    for (const step of wanted) {
      if (have.has(step)) continue;
      if (exempt.has(step)) continue;
      wfMissing.push({
        step,
        why: spec.mode === 'all'
          ? `${spec.file} 里找不到这一步，且没有已记录的等价替代`
          : `${spec.file} 必须跑这一步才允许发布（它有 contents: write 且会 push main/tag）`
      });
    }
    workflows.push({ file: spec.file, mode: spec.mode, missing: wfMissing });

    for (const rule of SAFETY) {
      if (rule.file !== spec.file) continue;
      if (!rule.test(found)) unsafe.push({ file: rule.file, key: rule.key, desc: rule.desc });
    }
  }

  const primary = verifyCiAlignment();
  return {
    steps: primary.steps,
    ciHas: primary.ciHas,
    missing: primary.missing,
    extra: primary.extra,
    workflows,
    unsafe,
    unknown
  };
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

function main() {
  const result = verifyAll();
  const enforced = result.steps.filter((s) => CI_ALTERNATIVES[s] === undefined);

  const wfMissing = result.workflows.flatMap((w) =>
    w.missing.map((m) => ({ ...m, file: w.file })));
  /* 未登记的 workflow 只**报出来**，不判失败。
     判失败的理由不成立：新增一个纯发布/纯通知型 workflow（比如只发 release 通知）
     不该被逼着登记一堆它根本不需要跑的门禁。那会让人为了过门禁而乱填豁免，
     反而稀释这张表的可信度。
     ⚠️ 但也不能静默 —— 静默正是本门禁最初的病根。 */
  const problems = result.missing.length + wfMissing.length + result.unsafe.length;

  if (problems === 0) {
    console.log(
      `门禁对齐通过：本地 check 链的 ${enforced.length} 道内容型门禁都在 verify.yml 里`
      + `${enforced.length === 0 ? '' : `（另有 ${result.steps.length - enforced.length} 道由 CI 用独立判据覆盖）`}。`
    );
    for (const w of result.workflows) {
      console.log(`  ✔ ${w.file}：${w.missing.length === 0 ? '必需门禁齐全' : `${w.missing.length} 处缺失`}`);
    }
    if (result.unsafe.length === 0) console.log(`  ✔ ${SAFETY.length} 条 CI 安全属性均未被删改`);
    if (result.unknown.length > 0) {
      console.log(`  ⚠ 未登记覆盖口径的 workflow：${result.unknown.join(', ')}（不判失败，但需人工确认）`);
    }
    process.exit(0);
  }

  if (result.missing.length > 0) {
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
    console.error('      请在 tools/ci-alignment.mjs 的 CI_ALTERNATIVES 里登记理由。');
  }

  if (wfMissing.length > 0) {
    console.error('');
    console.error(`门禁未对齐：${wfMissing.length} 道 workflow 缺少它必须执行的步骤`);
    for (const { file, step, why } of wfMissing) {
      console.error(`  ✖ ${file}：${step}`);
      console.error(`      ${why}`);
    }
  }

  if (result.unsafe.length > 0) {
    console.error('');
    console.error(`CI 安全属性被删改：${result.unsafe.length} 处`);
    for (const { file, key, desc } of result.unsafe) {
      console.error(`  ✖ ${file}：${key}`);
      console.error(`      ${desc}`);
    }
    console.error('');
    console.error('  这类删除不会被「本地 ⊆ CI」发现 —— 包含式判据看不见「把一步换成 true」。');
  }

  if (result.unknown.length > 0) {
    console.error('');
    console.error(`⚠ 以下 workflow 未登记覆盖口径，本门禁没有检查它：`);
    for (const file of result.unknown) console.error(`  ? ${file}`);
    console.error('  请在 tools/ci-alignment.mjs 的 WORKFLOWS 里登记它该跑哪些步，或写明为何不需要。');
  }

  process.exit(1);
}

const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replace(/\\/g, '/').endsWith('/tools/ci-alignment.mjs');
if (invokedDirectly) main();
