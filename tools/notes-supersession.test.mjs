/**
 * Supersession 检查的测试。
 *
 * 这条门禁借鉴 `deepseek-ai/deepseek-harness` 的硬规则：
 * **Every new Agent Note triggers a supersession check.**
 * 本插件原先完全没有这个机制 —— 实测 11 篇笔记只有 3 篇有互链，
 * 不是因为作者懒，而是**没有任何东西提醒他去看**。
 *
 * 测的重点是三件事：
 *   1. 新增笔记没声明关系 → **必须红**（这是门禁存在的唯一理由）；
 *   2. 三种合法路径（相对链接 / Independent 声明 / proposed·rejected 豁免）→ 必须绿；
 *   3. 无法判定时退出码 2，绝不能当成通过。
 *
 * 每条断言都跑真实子进程、拿真实退出码。
 */
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(PACKAGE_ROOT, 'tools', 'notes-supersession.mjs');
const NODE = process.execPath;

/**
 * 造一个带门禁脚本的临时 git 仓库。
 *
 * @returns {string} 仓库目录。
 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'an-supersede-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 'probe@example.test');
  git('config', 'user.name', 'probe');
  git('config', 'commit.gpgsign', 'false');
  /* 关掉行尾转换：测试断言的是「git diff 的内容」，而行尾转换会污染它。
     并行时 git 对同一批文件做 stat 检查会互相失效 → 打出 CRLF warning →
     warning 混进 diff 输出 → 解析失败（表现为文件级 test failed，没有断言）。
     这不是为本机绕过：CI 是 ubuntu（autocrlf 本就 false），
     加上这行是让所有平台看到同一份 diff。 */
  git('config', 'core.autocrlf', 'false');
  mkdirSync(join(dir, 'tools'), { recursive: true });
  /* 直接拷脚本：测的必须是 pre-commit / CI 会跑的那份代码。 */
  execFileSync(NODE, ['-e', `
    const {copyFileSync}=require('node:fs');
    copyFileSync(${JSON.stringify(SCRIPT)}, ${JSON.stringify(join(dir, 'tools', 'notes-supersession.mjs'))});
  `], { windowsHide: true });
  /* 一篇既有笔记，供链接引用。 */
  mkdirSync(join(dir, '.agents', 'notes', 'implemented', 'process'), { recursive: true });
  writeFileSync(
    join(dir, '.agents', 'notes', 'implemented', 'process', '2026-01-01-old.md'),
    '# Agent Note: old\n\nStatus: implemented\n\n## Problem\nx\n', 'utf8'
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

/**
 * 跑门禁，返回退出码与输出。
 *
 * @param {string} dir 仓库目录。
 * @param {string[]} [args] 额外参数。
 * @returns {{ code: number, out: string }} 结果。
 */
function run(dir, args = []) {
  const r = spawnSync(NODE, [join(dir, 'tools', 'notes-supersession.mjs'), ...args], {
    cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env }
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * 在仓库里造一篇新增笔记并暂存。
 *
 * @param {string} dir 仓库目录。
 * @param {string} rel 相对路径。
 * @param {string} body 正文。
 */
function stageNote(dir, rel, body) {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body, 'utf8');
  execFileSync('git', ['add', rel], { cwd: dir, encoding: 'utf8', windowsHide: true });
}

test('supersession: 新增笔记没声明关系 → 必须红', () => {
  const dir = makeRepo();
  try {
    stageNote(dir, '.agents/notes/implemented/process/2026-02-01-new.md',
      '# Agent Note: new\n\nStatus: implemented\n\n## Problem\nx\n');
    const { code, out } = run(dir);
    assert.equal(code, 1, `新增笔记没声明关系时必须拦下，实际 exit=${code}\n${out}`);
    assert.match(out, /没有声明|关系/, '诊断必须说明缺什么');
    assert.match(out, /Independent:/, '必须给出「确实无关」的做法');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supersession: 用相对链接指向既有笔记 → 通过', () => {
  const dir = makeRepo();
  try {
    stageNote(dir, '.agents/notes/implemented/process/2026-02-01-new.md',
      '# Agent Note: new\n\nStatus: implemented\n\n'
      + '见 [2026-01-01-old.md](2026-01-01-old.md)。\n');
    assert.equal(run(dir).code, 0, '有相对链接就该放行');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supersession: markdown 的三种合法链接写法都要认', () => {
  /* 实测确认过：原正则只认 `[a](b.md)`，漏掉后两种合法写法 ——
     于是「写了链接却被判没有」，而提示让人去加链接，他明明已经加了。
     这类误报最伤信任：人会开始怀疑门禁在乱报。 */
  const forms = [
    ['普通', '[2026-01-01-old.md](2026-01-01-old.md)'],
    ['尖括号包裹（路径含空格时必须这样写）', '[x](<2026-01-01-old.md>)'],
    ['带标题', '[x](2026-01-01-old.md "旧笔记")'],
    ['带锚点', '[x](2026-01-01-old.md#problem)']
  ];
  for (const [label, link] of forms) {
    const dir = makeRepo();
    try {
      stageNote(dir, '.agents/notes/implemented/process/2026-02-01-new.md',
        `# Agent Note: new\n\nStatus: implemented\n\n见 ${link}。\n`);
      assert.equal(run(dir).code, 0, `${label} 的写法应被认作相对链接`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('supersession: 外部 URL 不算「与既有笔记的关系」', () => {
  /* 反向：链接到外网不该被当成「查过既有笔记」。
     否则一句 `见 [文档](https://example.com/x.md)` 就能过门禁。 */
  const dir = makeRepo();
  try {
    stageNote(dir, '.agents/notes/implemented/process/2026-02-01-new.md',
      '# Agent Note: new\n\nStatus: implemented\n\n见 [外部](https://example.com/x.md)。\n');
    assert.equal(run(dir).code, 1, '外部 URL 不能充当与既有笔记的关系');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supersession: Independent 声明带理由 → 通过', () => {
  const dir = makeRepo();
  try {
    stageNote(dir, '.agents/notes/implemented/process/2026-02-01-new.md',
      '# Agent Note: new\n\nStatus: implemented\n\n'
      + 'Independent: 讲的是构建缓存，与现有任何决定无关\n');
    assert.equal(run(dir).code, 0, '有非空 Independent 理由就该放行');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supersession: Independent 空理由 → 拒绝', () => {
  /* 空理由会让这个出口退化成「一键跳过」，跟直接 --no-verify 没区别。
     要求理由非空，是因为写理由这个动作本身会促使人真去查一遍既有笔记。

     实现上这由正则里的 `\S` 保证（冒号后必须至少有一个非空白字符），
     不靠额外的 trim 判断 —— 那个判断实测是死代码（永远走不到），
     故障注入时它没被执行到，正是「测试在测别的东西」的证据。 */
  const dir = makeRepo();
  try {
    stageNote(dir, '.agents/notes/implemented/process/2026-02-01-new.md',
      '# Agent Note: new\n\nStatus: implemented\n\nIndependent:   \n');
    const { code, out } = run(dir);
    assert.equal(code, 1, '空理由必须拒绝');
    /* 断言它走的是「未声明」这条路径，而不是别的失败原因 ——
       否则测试可能在测一个碰巧也返回 1 的其它分支。 */
    assert.match(out, /既没有|Independent/, '拒绝原因必须是「未声明」，不能是其它失败');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supersession: 只有冒号没有内容 → 拒绝', () => {
  /* 与上一条同源，但覆盖 `Independent:` 后面连空格都没有的写法。
     这条容易在正则调整时被漏掉：`\s*` 会吃掉换行，若写成
     `^Independent:\s*(\S.*)$` 之外的形态就可能误匹配到下一行正文。 */
  const dir = makeRepo();
  try {
    stageNote(dir, '.agents/notes/implemented/process/2026-02-01-new.md',
      '# Agent Note: new\n\nStatus: implemented\n\nIndependent:\n## Problem\nx\n');
    assert.equal(run(dir).code, 1, '只有冒号必须拒绝');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supersession: proposed / rejected 豁免', () => {
  /* 想法阶段与否定阶段还没成为「已落地的决定」，不该被迫挂靠。
     若强制它们也声明关系，人就倾向于跳过 proposed 直接写 implemented，
     反而破坏了「先提想法」的流程。 */
  const dir = makeRepo();
  try {
    stageNote(dir, '.agents/notes/proposed/feature/2026-02-01-idea.md',
      '# Agent Note: idea\n\nStatus: proposed\n');
    assert.equal(run(dir).code, 0, 'proposed 应豁免');

    stageNote(dir, '.agents/notes/rejected/feature/2026-02-02-no.md',
      '# Agent Note: no\n\nStatus: rejected — 不划算\n');
    assert.equal(run(dir).code, 0, 'rejected 应豁免');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supersession: 修改既有笔记不触发检查', () => {
  /* 修改既有笔记本来就有归属，不该再要求它声明关系 ——
     否则每次改一行事实都要重走一遍 supersession 流程。 */
  const dir = makeRepo();
  try {
    const old = join(dir, '.agents', 'notes', 'implemented', 'process', '2026-01-01-old.md');
    writeFileSync(old, '# Agent Note: old\n\nStatus: implemented\n\n## Problem\n改写过的正文\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    assert.equal(run(dir).code, 0, '修改既有笔记不该被要求声明关系');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supersession: 区间模式按新增文件判定', () => {
  const dir = makeRepo();
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    const base = git('rev-parse', 'HEAD').trim();
    stageNote(dir, '.agents/notes/implemented/process/2026-02-01-new.md',
      '# Agent Note: new\n\nStatus: implemented\n\n## Problem\nx\n');
    git('commit', '-q', '--no-verify', '-m', 'add note without relation');

    const { code } = run(dir, ['--range', `${base}..HEAD`]);
    assert.equal(code, 1, '区间里新增的笔记同样必须声明关系');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supersession: 无法判定时必须退出码 2', () => {
  const r = spawnSync(NODE, [SCRIPT, '--range', 'deadbeefdeadbeef..HEAD'], {
    cwd: PACKAGE_ROOT, encoding: 'utf8', windowsHide: true
  });
  assert.equal(r.status, 2, `无法判定时必须 exit 2，实际 ${r.status}`);
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assert.match(out, /无效|无法/, '必须说明「这不是已合规」');
});
