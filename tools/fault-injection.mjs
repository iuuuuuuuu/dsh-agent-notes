#!/usr/bin/env node
/**
 * 门禁自证：证明门禁真的会红，而不是恒绿。
 *
 * Owner 硬规则：「新门禁先做故障注入证明它会失败，才承认它是绿的」。
 * 本脚本对每条门禁注入它该拦的故障，断言 exit != 0；再清掉故障断言回到 0。
 * 只要有一条门禁对故障无反应，本脚本自身非零退出——它自己也必须能变红。
 *
 * 用法：node tools/fault-injection.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = join(PACKAGE_ROOT, 'skills', 'agent-notes', 'scripts');
const NODE = process.execPath;

let failures = 0;

/**
 * 每个门禁／行为都要有自己的故障注入用例文件。
 *
 * 这是**声明表**，与磁盘上的 `tools/*.test.mjs` 做双向对账：登记了却没有
 * 文件要红，有文件却没登记也要红（见下方反向完整性检查）。
 *
 * @type {ReadonlyArray<readonly [string, string]>}
 */
const FAULT_SUITES = [
  ['覆盖门禁', 'notes-coverage.test.mjs'],
  ['supersession 检查', 'notes-supersession.test.mjs'],
  ['文档预算', 'doc-budget.test.mjs'],
  ['归档入口', 'archive-note.test.mjs'],
  ['脱离 DSH 的跨仓库可用性', 'standalone.test.mjs'],
  ['斜杠命令 agent-notes', 'commands.test.mjs'],
  ['工具 agent_notes_gate / status', 'plugin-tools.test.mjs'],
  ['浏览器端开关与看板 tab', 'client.test.mjs'],
  ['apply 的 config 开关组合', 'config.test.mjs'],
  ['第三方归属声明', 'notices.test.mjs'],
  ['Markdown 相对链接', 'md-links.test.mjs'],
  ['行内 文件:行号 引用', 'doc-refs.test.mjs'],
  ['双语文档结构一致', 'bilingual-docs.test.mjs'],
  ['双语互链指错语言', 'bilingual-links.test.mjs'],
  ['发版记账一致', 'release-check.test.mjs'],
  ['本地钩子安装与卸载', 'install-hooks.test.mjs'],
  ['sync-upstream 参数解析', 'args-parse.test.mjs'],
  ['文本完整性（U+FFFD）', 'text-integrity.test.mjs'],
  ['笔记门禁的跨仓库可用性', 'verify-notes-standalone.test.mjs'],
  ['commit-msg 钩子正文', 'hook-body.test.mjs'],
  ['CI 与本地门禁对齐', 'ci-alignment.test.mjs'],
  ['插件包契约自检', 'verify-plugin.test.mjs'],
  ['发布清单（files/exports）与产物一致性', 'publish-layout.test.mjs'],
  ['门禁语料下限与区域对账', 'corpus-floor.test.mjs'],
  ['工具脚本的独立语法检查', 'syntax-check.test.mjs'],
  ['文件结尾恰好一个换行', 'eol.test.mjs'],
  ['归档基线的历史封印比对', 'archive-baseline.test.mjs'],
  ['归档树布局与封印 schema', 'archive-layout.test.mjs'],
  ['未闭合注释的「缺小节」成因提示', 'masked-comment-hint.test.mjs'],
  ['插件版本变化的一次性提示', 'version-notice.test.mjs'],
  ['笔记树布局（根层与生命周期目录）', 'notes-layout.test.mjs'],
  ['非 Node 项目 / 无 node 环境', 'non-node-project.test.mjs'],
  ['看板数据聚合', 'board.test.mjs'],
  ['看板窄屏抽屉与归档卡补丁', 'board-responsive.test.mjs'],
  ['看板补丁源码语法体检（不 import 模块）', 'board-response-source.test.mjs'],
  ['看板补丁的选择器对齐', 'board-selector-alignment.test.mjs'],
  ['看板正文的表格渲染补丁', 'board-markdown.test.mjs'],
  ['浏览器可执行文件探测', 'find-browser.test.mjs'],
  ['真 Cordis 上下文集成', 'integration.test.mjs'],
  ['链接解析的括号与引用式定义', 'markdown-links.test.mjs'],
  ['空树不得伪装成绿', 'no-fake-green.test.mjs'],
  ['vendored 门禁在空集合上 exit 0 与外壳判红的对照', 'notes-gate-vacuity.test.mjs'],
  ['插件状态持久化', 'plugin.test.mjs'],
  ['项目内技能副本落后提示', 'project-skill.test.mjs'],
  ['开关投影与裸调用', 'projection.test.mjs'],
  ['技能自更新', 'self-update.test.mjs'],
  ['sync-upstream 退出码与清单', 'sync-upstream.test.mjs'],
  ['作用域 cwd 解析', 'target.test.mjs'],
  ['语义化版本递增', 'version.test.mjs']
];

/**
 * 跑一个 vendored 脚本，返回退出码与输出。
 *
 * @param {string} script 脚本文件名。
 * @param {string} cwd 工作目录。
 * @returns {{ code: number, out: string }} 退出码与合并输出。
 */
/**
 * 输出末尾三行，用于把失败现场压成一行。
 *
 * 单独抽出来是因为这类消息原先在模板串里直接写「split 一个换行转义」，
 * 一次跨行编辑就把真实的换行写进了字符串字面量 —— JS 立刻语法错，
 * 而报错位置在门禁脚本自己身上，看上去像被测门禁坏了。
 *
 * @param {string} text 合并后的输出。
 * @returns {string} 末尾三行。
 */
function lastLines(text) {
  return text.trim().split('\n').slice(-3).join(' | ');
}

function run(script, cwd) {
  const result = spawnSync(NODE, [join(SCRIPTS, script)], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
    windowsHide: true
  });
  /* signal 单独带出来：Windows 上子 node 崩溃时 status 是个 NTSTATUS 数值
     （实测 3221226505 = 0xC0000409），不带 signal 会把「崩了」和「按契约变红」
     看成同一件事。这里不因此放行 —— 变红的判定仍要求诊断文案匹配。 */
  return {
    code: result.status ?? -1,
    status: result.status,
    signal: result.signal ?? null,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`
  };
}

/** 一篇合规笔记。 */
const GOOD_NOTE = [
  '# Agent Note: 探针',
  '',
  'Status: implemented',
  '',
  '## Problem',
  '问题。',
  '',
  '## Decision',
  '决定。',
  '',
  '## Alternatives considered',
  '- **备选** — 最强理由；否掉的原因。',
  '',
  '## Consequences',
  '- 代价与收益。',
  ''
].join('\n');

/**
 * 跑本仓库的笔记门禁外壳 `tools/verify-notes.mjs`，返回退出码与输出。
 *
 * 与 `run()` 的区别：外壳作用于**它自己的仓库根**，所以这里只覆盖
 * `$AGENT_NOTE_ROOT` 指向临时树 —— 正好也是 CI 里调用的那条通路。
 *
 * @param {string} root 笔记根。
 * @returns {{ code: number, status: number|null, signal: string|null, out: string }} 退出码、原始 status/signal 与合并输出。
 */
function runCli(root) {
  const result = spawnSync(NODE, [join(PACKAGE_ROOT, 'tools', 'verify-notes.mjs')], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    env: { ...process.env, AGENT_NOTE_ROOT: root },
    windowsHide: true
  });
  /* 与 `run()` 同一口径：status 与 signal 一起带出来。
     漏掉它们时 `expectRedCli` 里 `status === null` 恒假、`signal` 恒 undefined
     ——「外壳半路崩了」会被记成「按契约变红」。复审（`.probe/review-final-2.md`
     的 P1-1）抓到的就是这条死代码。 */
  return {
    code: result.status ?? -1,
    status: result.status,
    signal: result.signal ?? null,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`
  };
}

/**
 * 断言外壳在给定故障下必须失败。
 *
 * @param {string} label 场景说明。
 * @param {string} root 笔记根。
 * @param {RegExp} expectPattern 诊断应匹配的模式。
 */
function expectRedCli(label, root, expectPattern) {
  const { code, status, signal, out } = runCli(root);
  if (code === 0) {
    console.error(`  ✖ ${label} — 外壳没有变红（exit=0），这是假绿！`);
    failures += 1;
    return;
  }
  if (status === null) {
    console.error(`  ✖ ${label} — 子进程未正常结束（signal=${String(signal)}），不能算作门禁变红：${lastLines(out)}`);
    failures += 1;
    return;
  }
  if (!expectPattern.test(out)) {
    console.error(`  ✖ ${label} — 变红了但诊断不指向该故障：${out.trim().split('\n').slice(-3).join(' | ')}`);
    failures += 1;
    return;
  }
  console.log(`  ✔ ${label} — exit=${code}`);
}

/**
 * 断言外壳在无故障时必须通过。
 *
 * @param {string} label 场景说明。
 * @param {string} root 笔记根。
 */
function expectGreenCli(label, root) {
  const { code, signal, out } = runCli(root);
  if (code !== 0) {
    console.error(`  ✖ ${label} — 本应通过却失败（exit=${code}, signal=${String(signal)}）：${out.trim().split('\n').slice(-3).join(' | ')}`);
    failures += 1;
    return;
  }
  console.log(`  ✔ ${label} — exit=0`);
}

/**
 * 断言某条门禁在给定故障下必须失败。
 *
 * @param {string} label 场景说明。
 * @param {string} script 脚本文件名。
 * @param {string} cwd 工作目录。
 * @param {RegExp} expectPattern 诊断应匹配的模式（NULL 表示不校验）。
 */
function expectRed(label, script, cwd, expectPattern) {
  const { code, status, signal, out } = run(script, cwd);
  if (code === 0) {
    console.error(`  ✖ ${label} — 门禁没有变红（exit=0），这是假绿！`);
    failures += 1;
    return;
  }
  /* 崩溃不是证据。子进程被信号杀掉或 spawn 失败时 `status` 为 null，
     它当然「非零」，但那是半路炸了，不是按契约判定失败 —— 若这时输出里
     恰好出现期望的诊断前缀（例如 import 阶段抛栈前已经打印过一行），
     文案匹配会把它记成「正确变红」。把「没正常结束」显式判掉。 */
  if (status === null) {
    console.error(`  ✖ ${label} — 子进程未正常结束（signal=${String(signal)}），不能算作门禁变红：${lastLines(out)}`);
    failures += 1;
    return;
  }
  if (expectPattern !== null && !expectPattern.test(out)) {
    console.error(`  ✖ ${label} — 变红了但诊断不指向该故障：${out.trim().split('\n').slice(-3).join(' | ')}`);
    failures += 1;
    return;
  }
  console.log(`  ✔ ${label} — exit=${code}`);
}

/**
 * 断言门禁在无故障时必须通过。
 *
 * @param {string} label 场景说明。
 * @param {string} script 脚本文件名。
 * @param {string} cwd 工作目录。
 */
function expectGreen(label, script, cwd) {
  const { code, out } = run(script, cwd);
  if (code !== 0) {
    console.error(`  ✖ ${label} — 本应通过却失败（exit=${code}）：${out.trim().split('\n').slice(-3).join(' | ')}`);
    failures += 1;
    return;
  }
  console.log(`  ✔ ${label} — exit=0`);
}

const work = mkdtempSync(join(tmpdir(), 'agent-notes-fault-'));
try {
  const notesRoot = join(work, '.agents', 'notes');
  const impl = join(notesRoot, 'implemented', 'architecture');
  mkdirSync(impl, { recursive: true });
  mkdirSync(join(work, '.git'));
  writeFileSync(join(impl, '2026-01-01-good.md'), GOOD_NOTE, 'utf8');

  console.log('故障注入：先证明门禁是真的');

  console.log('\n[基线] 合规树必须通过');
  expectGreen('tree 绿基线', 'verify-agent-note-tree.ts', work);
  expectGreen('format 绿基线', 'verify-agent-note-format.ts', work);
  expectGreen('archived 绿基线', 'verify-archived-agent-notes.ts', work);

  console.log('\n[tree] 目录与命名');
  const illegalClass = join(notesRoot, 'implemented', 'refactor');
  mkdirSync(illegalClass, { recursive: true });
  writeFileSync(join(illegalClass, '2026-01-02-bad.md'), GOOD_NOTE, 'utf8');
  expectRed('非法分类目录 refactor', 'verify-agent-note-tree.ts', work, /unknown class folder|refactor/);
  rmSync(illegalClass, { recursive: true, force: true });

  writeFileSync(join(impl, 'wrong-name.md'), GOOD_NOTE, 'utf8');
  expectRed('文件名不符合 yyyy-mm-dd', 'verify-agent-note-tree.ts', work, /filename|yyyy-mm-dd/);
  rmSync(join(impl, 'wrong-name.md'), { force: true });

  writeFileSync(join(notesRoot, 'implemented', 'INDEX.md'), '# index\n', 'utf8');
  expectRed('出现 INDEX.md', 'verify-agent-note-tree.ts', work, /INDEX/);
  rmSync(join(notesRoot, 'implemented', 'INDEX.md'), { force: true });

  console.log('\n[format] 头部与骨架');
  writeFileSync(join(impl, '2026-01-05-noalt.md'),
    GOOD_NOTE.replace(/## Alternatives considered[\s\S]*?(?=## Consequences)/, ''), 'utf8');
  expectRed('缺 ## Alternatives considered', 'verify-agent-note-format.ts', work, /Alternatives|备选/);
  rmSync(join(impl, '2026-01-05-noalt.md'), { force: true });

  writeFileSync(join(impl, '2026-01-06-prop.md'),
    GOOD_NOTE.replace('## Decision', '## Proposal'), 'utf8');
  expectRed('implemented 出现 ## Proposal', 'verify-agent-note-format.ts', work, /Proposal|Decision/);
  rmSync(join(impl, '2026-01-06-prop.md'), { force: true });

  writeFileSync(join(impl, '2026-01-07-status.md'),
    GOOD_NOTE.replace('Status: implemented', 'Status: proposed'), 'utf8');
  expectRed('Status 与所在目录不符', 'verify-agent-note-format.ts', work, /Status|status/);
  rmSync(join(impl, '2026-01-07-status.md'), { force: true });

  console.log('\n[archived] 封印只增不改');
  const arch = join(notesRoot, 'archived', 'process');
  mkdirSync(arch, { recursive: true });
  const sealed = join(arch, '2026-01-10-sealed.md');
  writeFileSync(sealed, [
    '# Agent Note: 封存样本',
    '',
    'Status: implemented',
    'Archived: 2026-01-10',
    '',
    '## Problem',
    '问题。',
    '',
    '## Decision',
    '决定。',
    '',
    '## Alternatives considered',
    '- **备选** — 最强理由。',
    '',
    '## Consequences',
    '- 代价。',
    ''
  ].join('\n'), 'utf8');
  const seal = spawnSync(NODE, [join(SCRIPTS, 'verify-archived-agent-notes.ts'), '--write'], {
    cwd: work, encoding: 'utf8', windowsHide: true
  });
  if ((seal.status ?? -1) !== 0 || !existsSync(join(notesRoot, 'archived', 'manifest.json'))) {
    console.error(`  ✖ 封印写入失败：${seal.stdout}${seal.stderr}`);
    failures += 1;
  } else {
    console.log('  ✔ 封印已写入 manifest.json');
    writeFileSync(sealed, `${GOOD_NOTE}\n被篡改的内容\n`, 'utf8');
    expectRed('篡改已封印归档', 'verify-archived-agent-notes.ts', work, /seal mismatch|modified/);

    rmSync(sealed, { force: true });
    expectRed('删除已封印归档', 'verify-archived-agent-notes.ts', work, /no file on disk|missing/);
  }

  console.log('\n[verify-notes] 本仓库门禁外壳：没有可验对象时不许绿');
  /* 这一节存在的理由：vendored 三脚本在空集合上 exit 0，直接接进 CI 就是
     一条恒绿门禁。外壳必须比脚本更严，且必须能对「空」变红。 */
  /* 自证「崩溃不会被记成变红」这条守卫是活的：
     光看源码里写了 `if (status === null)` 不够 —— 只有 runCli 真的把
     status/signal 带出来，它才可能为真。所以先跑一次确定会失败的调用，
     直接查返回对象有没有这两个键。缺键说明守卫是死代码（复审 P1-1）。 */
  const wiring = runCli(join(work, '.agents', 'notes-wiring-probe-absent'));
  if (!Object.hasOwn(wiring, 'status') || !Object.hasOwn(wiring, 'signal')) {
    console.error('  ✖ runCli 没有回传 status/signal —— 「子进程崩溃」的守卫是死代码');
    failures += 1;
  } else {
    console.log(`  ✔ runCli 回传 status=${String(wiring.status)}, signal=${String(wiring.signal)}`);
  }

  const emptyTree = join(work, '.agents', 'notes-empty');
  mkdirSync(emptyTree, { recursive: true });
  expectRedCli('空树（有目录、零篇）', emptyTree, /NO_NOTES_YET|没有可验/);
  expectRedCli('笔记树不存在', join(work, '.agents', 'notes-absent'), /NO_NOTES_TREE|不存在/);

  /* 反向对照：证明上面变红不是因为外壳一律报错 —— 合规树必须真绿。
     先清掉上一节故意留下的坏归档（那里删掉了已封印文件却没重写 manifest），
     否则这里验的就不是「合规树」而是那处残留故障。 */
  rmSync(join(notesRoot, 'archived'), { recursive: true, force: true });
  expectGreenCli('合规树', notesRoot);

  /* 再把违规笔记塞进去，外壳必须跟着脚本一起变红（不是只看篇数）。 */
  const rogue = join(notesRoot, 'implemented', 'architecture', '2026-01-03-rogue.md');
  writeFileSync(rogue, GOOD_NOTE.replace('## Decision', '## Proposal'), 'utf8');
  expectRedCli('implemented 里出现 ## Proposal', notesRoot, /Proposal|Decision/);
  rmSync(rogue, { force: true });

  console.log('\n[自证] 清掉全部故障后必须回到绿');
  rmSync(join(notesRoot, 'archived'), { recursive: true, force: true });
  expectGreen('tree 复原', 'verify-agent-note-tree.ts', work);
  expectGreen('format 复原', 'verify-agent-note-format.ts', work);
  expectGreen('archived 复原', 'verify-archived-agent-notes.ts', work);

  /* 每道新门禁的自证。
     它们的故障注入在各自的 test 文件里，由 npm test 执行。
     这里断言那些测试文件确实存在 —— 否则有人删掉它们，
     总门禁会静默失去这层覆盖而仍然报绿。

     must：新增门禁时必须在这里登记。忘了登记，总门禁会继续报绿，
     而那道门禁的故障注入其实已经没人跑了。 */
  console.log('\n[自证] 每道新门禁都必须带自己的故障注入');
  for (const [label, file] of FAULT_SUITES) {
    const full = join(PACKAGE_ROOT, 'tools', file);
    if (!existsSync(full)) {
      console.error(`  ✖ tools/${file} 不存在 —— ${label}没有故障注入，不可信`);
      failures += 1;
    } else {
      /* 光「文件存在」不够 —— 一个全是恒真断言的测试文件同样存在。
         至少要求它有真正的用例，并且数量不是零。
         本条写于一次真实教训：`client.test.mjs` 第一版 6 个用例全绿，
         但 `apply` 在 slots 缺失时提前 return、`useEffect` 也没被真执行，
         所以断言测的是我自己造的空数组。 */
      const text = readFileSync(full, 'utf8');
      /* 只数行首的 `test(` 会漏掉「写在 for 里、缩进注册」的用例：
         `archive-baseline.test.mjs` 有 4 处缩进注册 + 3 处顶格，行首计数只看到 3，
         报出来的数字比磁盘上的真实结构还少 —— 一个专门用来对账的工具不该自带
         这个偏差。所以按任意位置的 `test(` 计数。 */
      const cases = (text.match(/\btest\(/g) ?? []).length;
      if (cases === 0) {
        console.error(`  ✖ tools/${file} 里没有 test(...) 用例 —— ${label}的故障注入是空壳`);
        failures += 1;
      } else {
        /* 这里报的是**静态计数**，不是真实用例数：`for` 循环里注册的用例，
           一处 `test(` 会被跑成 N 条（`archive-baseline.test.mjs` 静态 5 处、
           实跑 9 条）。写「（N 个用例）」是假数字，所以写「N 处 test 调用」——
           这条自证要的是「不是空壳」，精确用例数由 `npm test` 自己报。 */
        console.log(`  ✔ ${label}的故障注入在 tools/${file}（${cases} 处 test 调用，由 npm test 执行）`);
      }
    }
  }

  /* 反向完整性：声明表是手写的，手写的清单天生会漏。
     本仓库真实发生过一次 —— 新增 `archive-baseline.test.mjs` 与
     `non-node-project.test.mjs` 后忘了登记，总门禁照样全绿。
     正向检查（登记→文件存在）对「文件存在但没登记」完全无感，
     所以这里按磁盘对账：多出来的测试文件必须显式登记，否则红。 */
  const declared = new Set(FAULT_SUITES.map(([, file]) => file));
  const onDisk = readdirSync(join(PACKAGE_ROOT, 'tools')).filter((name) => name.endsWith('.test.mjs'));
  const undeclared = onDisk.filter((name) => !declared.has(name)).sort();
  if (undeclared.length > 0) {
    for (const name of undeclared) {
      console.error(`  ✖ tools/${name} 没在上面登记 —— 它的故障注入不会有人知道，请加一行标签`);
      failures += 1;
    }
  } else {
    console.log(`  ✔ 磁盘上 ${onDisk.length} 个测试文件全部登记，无遗漏`);
  }

  if (failures > 0) {
    console.error(`\n故障注入未通过：${failures} 项。门禁不可信，先修门禁。`);
    process.exit(1);
  }
  console.log('\n故障注入全部通过：每条门禁都能对该拦的故障变红，且无故障时为绿。');
} finally {
  rmSync(work, { recursive: true, force: true });
}
