/**
 * `tools/sync-upstream.mjs` 的参数解析测试。
 *
 * ## 为什么把它拆出来测
 *
 * `parseArgs` 处理的是**外部可传的输入**，它的每条分支（缺值、未知参数、
 * 组合语义）都对应一种用户会犯的错。此前它没有导出、文件导入即执行
 * `main()`，于是这些边界一条都测不了。
 *
 * 抽出 `parseArgs` 并加上「仅直接执行才跑 main」的守卫后，
 * 参数解析可以在不碰网络、不写文件的前提下被完整覆盖。
 *
 * ## 注意：本文件测的是「参数怎么被理解」，不是「合并怎么执行」
 *
 * 后者要真访问 GitHub，写的是**真实的 vendored 目录**，不能并行跑
 * （见 testing/2026-10-19-parallel-tests-must-not-share-real-trees.md）。
 * 那部分由 sync-upstream.test.mjs 现有的 4 个用例覆盖。
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseArgs } from './sync-upstream.mjs';

const ROOT = join(import.meta.dirname, '..');

/** 钉住默认 ref，避免测试依赖 upstream.json 当前的记录值。 */
const REF = 'a'.repeat(40);
const opts = { defaultRef: REF };

test('args: 无参数时全部走默认', () => {
  const args = parseArgs([], opts);
  assert.equal(args.check, false);
  assert.equal(args.yes, false);
  assert.equal(args.latest, false);
  assert.equal(args.auto, false);
  assert.equal(args.branch, 'main', '默认上游分支是 main');
  assert.equal(args.ref, REF, '默认 ref 取自注入值（即 upstream.json 的记录）');
});

test('args: 四个布尔开关各自独立生效', () => {
  /* 逐个单独传，而不是一次全传 —— 一次全传验不出「开关之间互相干扰」。 */
  assert.equal(parseArgs(['--check'], opts).check, true);
  assert.equal(parseArgs(['--yes'], opts).yes, true);
  assert.equal(parseArgs(['--latest'], opts).latest, true);
  assert.equal(parseArgs(['--auto'], opts).auto, true);

  /* 未传的必须仍是 false：漏判会让「只想检查」变成「真的写入」。 */
  const onlyCheck = parseArgs(['--check'], opts);
  assert.equal(onlyCheck.yes, false, '--check 不得隐含 --yes');
  assert.equal(onlyCheck.auto, false, '--check 不得隐含 --auto');

  /* 组合传也要各归各位。 */
  const both = parseArgs(['--check', '--latest'], opts);
  assert.equal(both.check, true);
  assert.equal(both.latest, true);
  assert.equal(both.yes, false);
});

test('args: --branch / --ref 取下一个参数', () => {
  const args = parseArgs(['--branch', 'dev', '--ref', 'main'], opts);
  assert.equal(args.branch, 'dev');
  assert.equal(args.ref, 'main');
});

test('args: --branch / --ref 缺值必须抛错，不许静默用默认值', () => {
  /* 静默回退的后果：`node tools/sync-upstream.mjs --branch` 会去比对 main，
     而用户以为自己在看 dev —— 「检查了但检查错了对象」是最难发现的假绿。 */
  assert.throws(() => parseArgs(['--branch'], opts), /--branch 需要一个值/);
  assert.throws(() => parseArgs(['--ref'], opts), /--ref 需要一个值/);

  /* 参数在末尾但后面还有别的参数时，取的是紧跟其后的那个。 */
  const args = parseArgs(['--branch', 'dev', '--check'], opts);
  assert.equal(args.branch, 'dev', '--branch 必须吃掉紧随的值，不能让 --check 当值');
  assert.equal(args.check, true, '--check 仍应被识别为开关');
});

test('args: 未知参数必须抛错并点名', () => {
  assert.throws(() => parseArgs(['--nope'], opts), /未知参数: --nope/);
  /* 位置参数同样不接受 —— 这个脚本没有位置参数，出现就是打错了。 */
  assert.throws(() => parseArgs(['main'], opts), /未知参数: main/);
});

test('args: --help 走回调，且不吞掉后续参数的解析', () => {
  /* help 的实现做成可注入，是为了测试时不把整个测试进程带走
     （默认实现是 process.exit）。 */
  let called = 0;
  const args = parseArgs(['--help'], { ...opts, onHelp: () => { called += 1; } });
  assert.equal(called, 1, '--help 必须触发一次回调');
  assert.equal(args.check, false, 'help 之后返回的是默认参数');

  const shortFlag = parseArgs(['-h'], { ...opts, onHelp: () => { called += 1; } });
  assert.equal(called, 2, '-h 与 --help 等价');
  assert.equal(typeof shortFlag.ref, 'string');
});

test('args: --check 与 --yes 同传时仍按 check 语义（由 main 的分支顺序保证）', () => {
  /* 解析层如实保留两个开关 —— 「哪个优先」是 main() 的分支顺序决定的，
     不该在解析层偷偷改写（那会让 --yes 消失，用户以为自己没要求写入）。
     这条把「解析层不改写语义」钉住，真正的优先级由 CLI 行为测试覆盖。 */
  const args = parseArgs(['--check', '--yes'], opts);
  assert.equal(args.check, true);
  assert.equal(args.yes, true, '--yes 不得被解析层丢弃');
});

test('args: --help 的真实输出必须列出 parseArgs 支持的每个参数', () => {
  /* 防「加了新参数但忘了写进 --help」。

     **必须跑真实 CLI 拿输出**，不能在测试里解析源码找字符串 ——
     最初就是这么写的，结果故障注入把 printUsage 里的 `--latest` 那行删掉时
     测试仍然全绿：因为整个文件里别处（注释、package.json 脚本）也提到了
     `--latest`，字符串匹配照样找得到。测「A 是否包含 B」时若自己去扫 A，
     扫的通常是整个文件而不是 A 的输出。

     所以这里 spawn 真的 CLI，捕获它的 stdout。 */
  const cli = spawnSync(process.execPath, [join(ROOT, 'tools', 'sync-upstream.mjs'), '--help'], {
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(cli.status, 0, `--help 应正常退出，实际 ${cli.status}`);
  const helpText = String(cli.stdout);

  /* 从 parseArgs 源码里抽出它真正认的开关。 */
  const source = readFileSync(join(ROOT, 'tools', 'sync-upstream.mjs'), 'utf8');
  const body = /export function parseArgs\([\s\S]*?\n\}/.exec(source);
  assert.ok(body !== null, '必须能定位到 parseArgs 函数体');
  const supported = [...new Set([...body[0].matchAll(/arg === '(--[a-z-]+)'/g)].map((m) => m[1]))];
  /* `--help` 在源码里写作 `arg === '--help' || arg === '-h'`，
     上面那条正则抓不到它 —— 显式补上，否则反向断言会把 --help 自己
     判成「出现在 help 里却不支持」。 */
  supported.push('--help');
  supported.sort();

  assert.ok(supported.length >= 4, `前置：至少应识别出 4 个开关，实际 ${supported.length}`);
  /* 逐个开关检查它有没有出现在 help 里 —— **必须只看该开关自己的那一行**。
     最初用的是整段 help 文本的 includes，结果故障注入删掉 `--latest` 的
     专属说明行时测试仍然全绿：因为 `--branch` 那行的说明里顺带提到了
     `--latest/--auto`，字符串照样找得到。整段 includes 会被无关行满足。 */
  const helpLines = helpText.split('\n');
  for (const flag of supported) {
    /* 开关自己的说明行：允许前导空格，以及 `-h, ` 那种并列写法。 */
    const ownLine = helpLines.find((line) =>
      line.trimStart().startsWith(flag)
      || new RegExp(`^\\s*(-h,\\s*)?${flag}\\b`).test(line)
    );
    assert.ok(ownLine !== undefined,
      `${flag} 被 parseArgs 支持，却没在 --help 输出里拥有自己的说明行`);
  }

  /* 反向：help 里也不该出现不存在的参数（打错字会误导用户）。 */
  const inHelp = [...new Set([...helpText.matchAll(/(--[a-z]+)/g)].map((m) => m[1]))].sort();
  for (const flag of inHelp) {
    assert.ok(supported.includes(flag),
      `--help 里出现 ${flag}，但 parseArgs 不认它 —— 会让用户传了却被当成未知参数`);
  }
});
