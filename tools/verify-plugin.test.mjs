/**
 * `tools/verify-plugin.mjs`（发布前自检）的故障注入。
 *
 * ## 为什么这个文件必须存在
 *
 * 这道门禁**连续几轮都没人给它写测试**，后果是一次真实的线上故障：
 *
 * 包改名成 `@iuuuuuuuu/agent-notes` 后，`cordis.patch.yml` 仍写着旧名
 * `name: "dsh-agent-notes"`。而当时的断言是
 * `check(patch.includes('name: "dsh-agent-notes"') || ...)` ——
 * **它把旧名当成了正确答案**。于是 `npm run check` 全绿、357 个测试全绿，
 * 而宿主加载器拿「行名」当模块 specifier 去解析，向上找不到同名
 * package.json，`resolveMeta` 返回 null，**客户端半边被静默跳过**：
 * 后端工具还能用，界面上的开关和看板 tab 全没了。
 *
 * 教训不是「要记得改那一行」，而是：**一道把 bug 断言成正确的门禁，
 * 比没有门禁更糟** —— 它会让每一次绿灯都变成假绿。所以本文件不验
 * 「verify-plugin 能跑」，而是逐个断言「每一类缺陷都真的会红」。
 *
 * ## 怎么做到「真红」
 *
 * 不 mock。把整个包需要自检的那部分**真拷到临时目录**，改坏一个地方，
 * 真跑一次子进程，读退出码与 stderr。拷贝成本约 500KB，换的是
 * 「断言测的是真脚本」而不是「测我自己造的对象」。
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const NODE = process.execPath;

/** 自检要用到的全部路径。少拷一个都会让「绿基线」变成别的原因导致的红。 */
const NEEDED = [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'README.en.md',
  'src',
  'lib',
  'skills',
  'tools/verify-plugin.mjs',
  'tools/upstream-manifest.json',
  'upstream.json'
];

/**
 * 造一份可自检的包副本。
 *
 * @returns {string} 副本根目录。
 */
function makePackageCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'an-verify-plugin-'));
  for (const rel of NEEDED) {
    cpSync(join(PACKAGE_ROOT, ...rel.split('/')), join(dir, ...rel.split('/')), { recursive: true });
  }
  return dir;
}

/**
 * 在副本里跑自检。
 *
 * @param {string} dir 副本根目录。
 * @returns {{ status: number|null, output: string }} 退出码与合并输出。
 */
function runVerify(dir) {
  const result = spawnSync(NODE, [join(dir, 'tools', 'verify-plugin.mjs')], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * 改副本里的一个文件。
 *
 * @param {string} dir 副本根目录。
 * @param {string} rel 相对路径。
 * @param {(text: string) => string} transform 改写函数。
 */
function patch(dir, rel, transform) {
  const file = join(dir, ...rel.split('/'));
  const before = readFileSync(file, 'utf8');
  const after = transform(before);
  /* anchor 过期时 `String.replace` 会**静默不匹配**：副本其实没被改坏，
     自检照常 exit 0，于是 expectRed 报的是「自检应当失败，实际退出码 0」——
     一条看起来像「门禁没拦住」的假红，真实原因是这条测试自己失效了。
     宁可在这里直接喊出来。 */
  assert.notEqual(after, before, `patch 没有改动 ${rel}（anchor 过期？），这条用例已经失效`);
  writeFileSync(file, after, 'utf8');
}

/**
 * 断言自检因某个理由变红。
 *
 * @param {string} dir 副本根目录。
 * @param {RegExp} reason 期望出现在输出里的失败理由。
 */
function expectRed(dir, reason) {
  const { status, output } = runVerify(dir);
  assert.equal(status, 1, `自检应当失败，实际退出码 ${status}。输出:\n${output}`);
  assert.match(output, reason, `失败理由不对。输出:\n${output}`);
}

test('自检：绿基线必须通过（真子进程）', () => {
  const dir = makePackageCopy();
  try {
    const { status, output } = runVerify(dir);
    assert.equal(status, 0, `原样副本应当通过，实际 ${status}。输出:\n${output}`);
    assert.match(output, /自检通过/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自检：patch 用旧包名必须红 —— 这正是让界面消失的那个改动', () => {
  const dir = makePackageCopy();
  try {
    /* 复现真实故障：把加载名改回改名前的旧名。
       宿主会拿它当模块 specifier 解析，向上找不到同名 package.json
       ⇒ 客户端半边被静默跳过。 */
    patch(dir, 'cordis.patch.yml', (text) =>
      text.replace('name: "@iuuuuuuuu/agent-notes"', 'name: "dsh-agent-notes"'));
    expectRed(dir, /patch 的加载名必须等于包名 @iuuuuuuuu\/agent-notes，实际 dsh-agent-notes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自检：加载名缺失必须红，不得因为「找不到」就放过', () => {
  const dir = makePackageCopy();
  try {
    patch(dir, 'cordis.patch.yml', (text) => text.replace(/^\s+name:.*\n/gm, ''));
    expectRed(dir, /patch 的加载名必须等于包名 .*未找到/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自检：patch 里出现两个 name 行必须红 —— 不知道该信哪一个', () => {
  const dir = makePackageCopy();
  try {
    patch(dir, 'cordis.patch.yml', (text) =>
      `${text}    - id: decoy\n      name: "@iuuuuuuuu/agent-notes"\n`);
    expectRed(dir, /patch 的加载名必须等于包名/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自检：包名被手改必须红（这条断言的意义就是防手改）', () => {
  const dir = makePackageCopy();
  try {
    patch(dir, 'package.json', (text) => text.replace('"@iuuuuuuuu/agent-notes"', '"someone-else"'));
    expectRed(dir, /包名应为 @iuuuuuuuu\/agent-notes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自检：改了 src/client.js 忘了 build 必须红', () => {
  const dir = makePackageCopy();
  try {
    /* 只改源码不动产物 —— 浏览器会跑旧代码，本地测试却全绿，是典型假绿。
       必须改在 `createAgentNotesClient(require) {` 的函数体**内部**：
       重建只截函数体，改在文件尾部（函数体之外）重建结果不变，
       那样注入就落空了 —— 第一版正是这么写的，于是「本该红却绿」。 */
    patch(dir, 'src/client.js', (text) =>
      text.replace(
        'function createAgentNotesClient(require) {',
        'function createAgentNotesClient(require) {\n  /* 改了源码忘了 build */'));
    expectRed(dir, /lib\/client\.js 与 src\/client\.js 不同步/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自检：信封 id 与包名不一致必须红（否则浏览器加载器拒绝这个模块）', () => {
  const dir = makePackageCopy();
  try {
    patch(dir, 'lib/client.js', (text) =>
      text.replace('load({id:"@iuuuuuuuu/agent-notes"', 'load({id:"dsh-agent-notes"'));
    expectRed(dir, /信封 id 必须等于包名/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自检：vendored 内容被手改必须红（上游哈希比对）', () => {
  const dir = makePackageCopy();
  try {
    patch(dir, 'skills/agent-notes/SKILL.md', (text) => `${text}\n手改一行\n`);
    expectRed(dir, /vendored 内容与上游清单不一致/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自检：README 少一个版本必须红（双语契约）', () => {
  const dir = makePackageCopy();
  try {
    rmSync(join(dir, 'README.en.md'), { force: true });
    expectRed(dir, /README\.en\.md（英文）不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自检：@deepseek-ai 藏在 optionalDependencies 里必须红', () => {
  const dir = makePackageCopy();
  try {
    /* optionalDependencies 也会被安装器写进 profile，所以它同样是运行时依赖。
       只查 dependencies + peerDependencies 会漏掉这一格 —— 而「换个字段名
       绕过去」不需要恶意，一个心不在焉的依赖整理就够了。 */
    patch(dir, 'package.json', (text) => {
      const pkg = JSON.parse(text);
      pkg.optionalDependencies = { '@deepseek-ai/cosmokit': '^3.0.0' };
      return JSON.stringify(pkg, null, 2);
    });
    expectRed(dir, /不得声明 @deepseek-ai 依赖/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自检：动态 import 引 @deepseek-ai 必须红（只查 from 会漏）', () => {
  const dir = makePackageCopy();
  try {
    patch(dir, 'lib/index.js', (text) =>
      `${text}\nexport const __probe = () => import('@deepseek-ai/schemastery');\n`);
    expectRed(dir, /引入了不可解析的依赖: @deepseek-ai\/schemastery/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自检：lib 子目录里的 require 必须红（证明递归扫描真的生效）', () => {
  const dir = makePackageCopy();
  try {
    /* 两件事一起证：① `require()` 这种形态也被查；② `lib/sub/` 不再在
       扫描范围之外。旧实现只扫 `lib/*.js` 一层，这个文件对它是隐形的。 */
    const nested = join(dir, 'lib', 'sub');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'helper.js'), "module.exports = require('@deepseek-ai/cosmokit');\n", 'utf8');
    expectRed(dir, /lib\/sub\/helper\.js 引入了不可解析的依赖/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自检：vendored 目录多出清单外文件必须红（否则它永远不受哈希管辖）', () => {
  const dir = makePackageCopy();
  try {
    /* 手拷一个上游文件进来（清单里没有它）—— 单向比对只会说「清单里的都对」，
       这句话为真，却完全没回答「磁盘上有没有别的东西」。 */
    writeFileSync(join(dir, 'skills', 'agent-notes', 'references', 'extra.md'), '# 手拷进来的\n', 'utf8');
    expectRed(dir, /vendored 目录存在清单外的文件.*references\/extra\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自检：manifest 的 ref 与 upstream.json 不一致必须红（清单不能自我授权）', () => {
  const dir = makePackageCopy();
  try {
    /* manifest 是推导产物，upstream.json 是人工维护的意图声明。
       两者分歧意味着「这份清单已不代表那个上游快照」，而原来的自检
       只信 manifest，等于让清单给自己发证。 */
    patch(dir, 'upstream.json', (text) => {
      const intent = JSON.parse(text);
      intent.ref = '0'.repeat(40);
      return JSON.stringify(intent, null, 2);
    });
    expectRed(dir, /upstream\.json\.ref\(0{40}\) 与 upstream-manifest\.json\.ref/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自检：运行期标记 .synced-version 不得被判成清单外文件', () => {
  const dir = makePackageCopy();
  try {
    /* 这台机器上它真实存在（lib/self-update.js 写的，被 .gitignore 忽略）。
       门禁若把它当违规，每台跑过自更新的机器都会红 —— 那种门禁的下场是
       被 --no-verify 永久绕过，比不设还糟。 */
    writeFileSync(join(dir, 'skills', 'agent-notes', '.synced-version'), '0.6.0\n', 'utf8');
    const { status, output } = runVerify(dir);
    assert.equal(status, 0, `运行期标记不应导致失败，实际 ${status}。输出:\n${output}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自检：patch 里内联 !!js 表达式必须红（装在不同机器上会组成不同插件树）', () => {
  const dir = makePackageCopy();
  try {
    /* 上游把这条做成了独立门禁（verify-config-source-ownership）：随包发布的
       Cordis 配置不得内联凭据/端点。本地只有一份 patch，就在这里查。
       没有这条断言时，`config: !!js process.env.X` 会一路绿到用户机器上。 */
    patch(dir, 'cordis.patch.yml', (text) => `${text}      config: !!js process.env.AGENT_NOTES_TOKEN\n`);
    expectRed(dir, /不得使用 !!js 内联表达式/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自检：patch 里读 process.env 也必须红（同上，换成显式取值）', () => {
  const dir = makePackageCopy();
  try {
    patch(dir, 'cordis.patch.yml', (text) => `${text}      endpoint: https://\${process.env.HOST}/x\n`);
    expectRed(dir, /不得内联 process\.env 读取/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自检：白名单条目没有理由必须红（豁免不能是匿名的一行代码）', () => {
  const dir = makePackageCopy();
  try {
    /* 上游 verify-package-readme-limitations.ts:34-45 对白名单做两件事：
       条目必须命中被扫到的对象、理由必须非空。照搬到本地这一条 —— 只写
       `new Set(['.synced-version'])` 时，没有任何东西能拦「豁免被越加越多」。 */
    patch(dir, 'tools/verify-plugin.mjs', (text) => text.replace(
      /'\.synced-version': '[^']*'/,
      "'.synced-version': '   '"
    ));
    expectRed(dir, /没有写理由/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自检：白名单条目在 lib 里没有写者必须红（防腐，不是防手滑）', () => {
  const dir = makePackageCopy();
  try {
    /* 这条守的是「豁免会随代码演进失效」：lib/self-update.js 哪天不再写
       .synced-version，这条豁免仍然会永久放行同名脏文件而不报警。 */
    patch(dir, 'tools/verify-plugin.mjs', (text) => text.replace(
      /^(\s*)'\.synced-version': '[^']*',$/m,
      "$1'.synced-version': 'lib/self-update.js 运行期写入的上游版本标记，不在 upstream-manifest.json 里',\n$1'.gone-artifact': '一个已经不存在的产物',"
    ));
    expectRed(dir, /gone-artifact 在 lib\/ 里找不到任何写者/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
