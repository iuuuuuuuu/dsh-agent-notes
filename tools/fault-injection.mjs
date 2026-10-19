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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = join(PACKAGE_ROOT, 'skills', 'agent-notes', 'scripts');
const NODE = process.execPath;

let failures = 0;

/**
 * 跑一个 vendored 脚本，返回退出码与输出。
 *
 * @param {string} script 脚本文件名。
 * @param {string} cwd 工作目录。
 * @returns {{ code: number, out: string }} 退出码与合并输出。
 */
function run(script, cwd) {
  const result = spawnSync(NODE, [join(SCRIPTS, script)], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
    windowsHide: true
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
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
 * @returns {{ code: number, out: string }} 退出码与合并输出。
 */
function runCli(root) {
  const result = spawnSync(NODE, [join(PACKAGE_ROOT, 'tools', 'verify-notes.mjs')], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    env: { ...process.env, AGENT_NOTE_ROOT: root },
    windowsHide: true
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * 断言外壳在给定故障下必须失败。
 *
 * @param {string} label 场景说明。
 * @param {string} root 笔记根。
 * @param {RegExp} expectPattern 诊断应匹配的模式。
 */
function expectRedCli(label, root, expectPattern) {
  const { code, out } = runCli(root);
  if (code === 0) {
    console.error(`  ✖ ${label} — 外壳没有变红（exit=0），这是假绿！`);
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
  const { code, out } = runCli(root);
  if (code !== 0) {
    console.error(`  ✖ ${label} — 本应通过却失败（exit=${code}）：${out.trim().split('\n').slice(-3).join(' | ')}`);
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
  const { code, out } = run(script, cwd);
  if (code === 0) {
    console.error(`  ✖ ${label} — 门禁没有变红（exit=0），这是假绿！`);
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
  for (const [label, file] of [
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
    ['双语文档结构一致', 'bilingual-docs.test.mjs'],
    ['发版记账一致', 'release-check.test.mjs']
  ]) {
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
      const cases = (text.match(/^test\(/gm) ?? []).length;
      if (cases === 0) {
        console.error(`  ✖ tools/${file} 里没有 test(...) 用例 —— ${label}的故障注入是空壳`);
        failures += 1;
      } else {
        console.log(`  ✔ ${label}的故障注入在 tools/${file}（${cases} 个用例，由 npm test 执行）`);
      }
    }
  }

  if (failures > 0) {
    console.error(`\n故障注入未通过：${failures} 项。门禁不可信，先修门禁。`);
    process.exit(1);
  }
  console.log('\n故障注入全部通过：每条门禁都能对该拦的故障变红，且无故障时为绿。');
} finally {
  rmSync(work, { recursive: true, force: true });
}
