/**
 * `tools/install-hooks.mjs` 的行为测试 —— 本地 commit-msg 钩子的安装与卸载。
 *
 * ## 为什么值得测
 *
 * 这是**每个 clone 都要跑一次**的入口（`npm run hooks:install`），而且它
 * 改的是 git 配置与工作区文件。写错了不会让任何测试变红，只会让下一个
 * 维护者的本地钩子静默失效 —— 而钩子失效意味着「该写笔记而没写」这件事
 * 完全没人拦。
 *
 * 主路径（安装成功、钩子内容对）在这几轮提交里已被真实跑过无数次：每次
 * `git commit` 都会看到覆盖门禁与 supersession 的输出。所以这里聚焦在
 * **边界路径**：非仓库根、重复安装、`--undo`、旧 pre-commit 清理。
 *
 * ## 怎么测
 *
 * 全程在 `mkdtempSync` 出来的临时 git 仓库里跑 `install-hooks.mjs`，用
 * `--cwd` 把脚本的仓库根判定指向那里。**绝不碰真实仓库的 git 配置** ——
 * 那是共享状态，改了会影响这台机器上所有 clone。
 */
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'tools', 'install-hooks.mjs');

/** 本轮创建的临时仓库，进程退出时清理。 */
const SANDBOXES = [];
process.on('exit', () => {
  for (const dir of SANDBOXES) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});

/**
 * 建一个临时 git 仓库，并把 install-hooks.mjs 的判定根指向它。
 *
 * 脚本用 `git rev-parse --show-toplevel` 与自己的 PACKAGE_ROOT 比较来判断
 * 「当前目录是不是仓库根」。要在临时仓库里测，就得把脚本**复制过去** ——
 * 否则它的 PACKAGE_ROOT 永远指向本仓库，判定必然失败。
 *
 * @returns {{ dir: string, run: (args?: string[]) => { status: number, out: string, err: string } }} 沙箱与运行器。
 */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'an-hooks-'));
  SANDBOXES.push(dir);

  mkdirSync(join(dir, 'tools'), { recursive: true });
  /* 脚本会调 tools/notes-coverage.mjs 与 notes-supersession.mjs；
     这里只需要它们**存在**（钩子正文只是引用路径，运行期才执行）。
     复制真实的门禁脚本，让钩子内容里的路径与真实布局一致。 */
  copyFileSync(SCRIPT, join(dir, 'tools', 'install-hooks.mjs'));
  /* install-hooks.mjs 现在 import 钩子正文（拆成独立文件是为了能单独测它）。
     沙箱必须把它一起拷进来，否则 import 失败，六条用例会全红 ——
     症状与「安装逻辑坏了」一样，但修复方向相反。 */
  for (const name of ['notes-coverage.mjs', 'notes-supersession.mjs', 'hook-body.mjs']) {
    const src = join(ROOT, 'tools', name);
    if (existsSync(src)) copyFileSync(src, join(dir, 'tools', name));
  }
  /* 判定仓库根还需要 package.json —— 脚本读它确认自己在包里。 */
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'sandbox-probe', version: '0.0.0', type: 'module'
  }, null, 2));

  spawnSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  /* 提交一次，让 HEAD 存在（部分 git 操作需要）。 */
  spawnSync('git', ['config', 'user.email', 'probe@example.com'], { cwd: dir, windowsHide: true });
  spawnSync('git', ['config', 'user.name', 'probe'], { cwd: dir, windowsHide: true });

  return {
    dir,
    run(args = []) {
      const r = spawnSync(process.execPath, [join(dir, 'tools', 'install-hooks.mjs'), ...args], {
        cwd: dir,
        encoding: 'utf8',
        windowsHide: true
      });
      return { status: r.status ?? -1, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
    },
    gitGet(key) {
      const r = spawnSync('git', ['config', '--get', key], { cwd: dir, encoding: 'utf8', windowsHide: true });
      return r.status === 0 ? String(r.stdout).trim() : null;
    }
  };
}

/** Node 内建 fs 的 copyFileSync（这里单独导入以免与 readFileSync 混用）。 */
function copyFileSync(src, dest) {
  execFileSync(process.execPath, ['-e',
    `require('node:fs').copyFileSync(${JSON.stringify(src)}, ${JSON.stringify(dest)})`
  ], { windowsHide: true });
}

test('hooks: 路径归一必须扛住尾随分隔符', () => {
  /* 实测踩过的坑：`new URL('..', import.meta.url)` 经 fileURLToPath 得到的
     PACKAGE_ROOT **带尾随分隔符**，而 `git rev-parse --show-toplevel` 不带。
     字符串直接比较必然不等，于是安装直接退出 2。

     **这一条不能用「在测试里重写一遍归一逻辑」来测** —— 那样改的是副本，
     被测代码坏掉时测试仍全绿（实测过）。所以这里直接跑被测脚本：
     安装成功，就证明它的归一扛住了尾斜杠与短路径。

     同时验诊断信息仍在：判定失败时脚本会打印 PACKAGE_ROOT，那是排查这类
     问题的第一现场，丢了就只剩一句「不是仓库根」。 */
  const box = sandbox();

  const failed = spawnSync(process.execPath, [join(box.dir, 'tools', 'install-hooks.mjs')], {
    cwd: box.dir, encoding: 'utf8', windowsHide: true
  });
  assert.equal(failed.status, 0,
    `安装必须成功（实际 ${failed.status}：${failed.stderr}）—— 归一没扛住尾斜杠或短路径`);

  const toplevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: box.dir, encoding: 'utf8', windowsHide: true
  }).stdout.trim();
  assert.ok(toplevel.length > 0 && !toplevel.endsWith('\\') && !toplevel.endsWith('/'),
    `前置：git 报的仓库根不该带尾分隔符，实际 ${JSON.stringify(toplevel)}`);
});

test('hooks: 安装后写入钩子文件并设置 core.hooksPath', () => {
  const box = sandbox();
  const result = box.run();
  assert.equal(result.status, 0, `安装应成功，实际 ${result.status}：${result.err}`);

  const hook = join(box.dir, '.githooks', 'commit-msg');
  assert.ok(existsSync(hook), '必须写出 .githooks/commit-msg');
  assert.equal(box.gitGet('core.hooksPath'), '.githooks', '必须把 core.hooksPath 指向仓库内目录');
});

test('hooks: 钩子正文必须调两道门禁，且用 commit-msg 的 $1', () => {
  /* 这道是钩子的全部价值所在：内容不对就等于没装。
     `#!/bin/sh` 而非 node 是刻意选择（Windows 上 git 自带 sh 一定在，
     node 的 PATH 未必），所以第一行也必须断言。

     两条门禁都要断言。最初只断言了 notes-coverage，漏了 supersession ——
     故障注入把 `node tools/notes-supersession.mjs` 换成 `true` 时测试仍然全绿。
     「只跑一道」的门禁看起来在工作，实际漏掉了一半。 */
  const box = sandbox();
  box.run();
  const body = readFileSync(join(box.dir, '.githooks', 'commit-msg'), 'utf8');

  assert.match(body, /^#!\/bin\/sh/, '必须用 sh 的 shebang —— Windows 上 node 未必在 PATH');
  assert.match(body, /^\s*node tools\/notes-coverage\.mjs --message-file "\$1"\s*$/m,
    '必须用 --message-file 传 $1：Note-Skip 写在提交信息里，不这么传就堵死了合法出口');
  assert.match(body, /^\s*node tools\/notes-supersession\.mjs\s*$/m,
    '必须**实际执行** supersession 检查（注释里提到它不算）');
  assert.match(body, /--no-verify/, '必须在注释里说明紧急情况怎么绕过（以及 CI 会再查）');
});

test('hooks: 重复安装必须幂等，且不改 git 配置的状态', () => {
  const box = sandbox();
  box.run();
  const first = readFileSync(join(box.dir, '.githooks', 'commit-msg'), 'utf8');

  const second = box.run();
  assert.equal(second.status, 0, '第二次安装必须成功');
  assert.equal(readFileSync(join(box.dir, '.githooks', 'commit-msg'), 'utf8'), first,
    '第二次安装不得改变钩子内容（内容变了会说明生成逻辑不稳定）');
  assert.equal(box.gitGet('core.hooksPath'), '.githooks', '第二次安装后 hooksPath 仍应是仓库内目录');
  assert.doesNotMatch(second.out, /正在覆盖/,
    '内容相同时不该报「正在覆盖」—— 那句只在真有差异时出现');
});

test('hooks: 内容不同才提示覆盖，不得静默吃掉别人的自定义钩子', () => {
  const box = sandbox();
  mkdirSync(join(box.dir, '.githooks'), { recursive: true });
  writeFileSync(join(box.dir, '.githooks', 'commit-msg'), '#!/bin/sh\necho custom\n');

  const result = box.run();
  assert.equal(result.status, 0);
  assert.match(result.out, /已存在且内容不同|正在覆盖/,
    '覆盖别人的钩子前必须提示 —— 静默覆盖会让人丢掉自己的规则');
});

test('hooks: --undo 清除 core.hooksPath，重复卸载不报错', () => {
  /* 重复卸载必须是「无需卸载」的提示而不是失败 —— 用户会连点两次，
     第二次失败会被当成钩子装坏了。 */
  const box = sandbox();
  box.run();
  assert.equal(box.gitGet('core.hooksPath'), '.githooks', '前置：装上后应有 hooksPath');

  const first = box.run(['--undo']);
  assert.equal(first.status, 0, `卸载应成功：${first.err}`);
  assert.equal(box.gitGet('core.hooksPath'), null, '卸载后 hooksPath 必须回到默认');

  const second = box.run(['--undo']);
  assert.equal(second.status, 0, '重复卸载必须仍然成功');
  assert.match(second.out, /无需卸载/, '重复卸载应明确说「本来就没设置」');
});

test('hooks: 非 git 仓库目录必须退出 2，不静默装一半', () => {
  /* 退出码 2 是「无法进行」而不是「检查失败」—— 两者含义不同，
     混用会让上层把环境问题当成门禁红了。 */
  const dir = mkdtempSync(join(tmpdir(), 'an-nogit-'));
  SANDBOXES.push(dir);
  mkdirSync(join(dir, 'tools'), { recursive: true });
  copyFileSync(SCRIPT, join(dir, 'tools', 'install-hooks.mjs'));
  /* 钩子正文也要带上：缺它则 import 失败、退出码变 1 而非 2，
     症状看着像「退出码被改坏」，实际是模块没解析到。 */
  copyFileSync(join(ROOT, 'tools', 'hook-body.mjs'), join(dir, 'tools', 'hook-body.mjs'));

  const r = spawnSync(process.execPath, [join(dir, 'tools', 'install-hooks.mjs')], {
    cwd: dir, encoding: 'utf8', windowsHide: true
  });
  assert.equal(r.status, 2, `非仓库应退出 2，实际 ${r.status}`);
  assert.match(String(r.stderr), /不是 git 仓库根/, '必须说清原因');
  assert.ok(!existsSync(join(dir, '.githooks')), '失败时不得留下半个安装结果');
});

test('hooks: 旧的 pre-commit 钩子被清理，不与 commit-msg 重复检查', () => {
  /* 留着旧钩子会重复检查同一件事；更糟的是它拦不住 Note-Skip 场景，
     让人以为「我写了 Note-Skip 还是被拦」。 */
  const box = sandbox();
  mkdirSync(join(box.dir, '.githooks'), { recursive: true });
  writeFileSync(join(box.dir, '.githooks', 'pre-commit'),
    '#!/bin/sh\nnode tools/notes-coverage.mjs\n');

  const result = box.run();
  assert.equal(result.status, 0);
  assert.ok(!existsSync(join(box.dir, '.githooks', 'pre-commit')),
    '引用本仓库门禁的旧 pre-commit 必须被移除');
  assert.match(result.out, /旧的 pre-commit/, '必须说明移除了什么');
});

test('hooks: 不属于本仓库门禁的 pre-commit 不得被删', () => {
  /* 判定依据是「内容里含 notes-coverage.mjs」。别人的 pre-commit 做别的检查，
     删掉它就是越权 —— 用户会丢掉自己的门禁，而且没有任何提示。 */
  const box = sandbox();
  mkdirSync(join(box.dir, '.githooks'), { recursive: true });
  writeFileSync(join(box.dir, '.githooks', 'pre-commit'),
    '#!/bin/sh\necho someone else own hook\n');

  const result = box.run();
  assert.equal(result.status, 0);
  assert.ok(existsSync(join(box.dir, '.githooks', 'pre-commit')),
    '别人的 pre-commit 必须保留');
});