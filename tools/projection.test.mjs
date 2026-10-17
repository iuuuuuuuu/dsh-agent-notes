/**
 * 投影与客户端契约测试。
 *
 * 重点不是「跑通」，而是把两类**会让徽标撒谎**的错误钉死：
 *   1. 语义错位：裸调用 `/agent-notes`（查状态）被当成 reset，
 *      `on --global` 被当成本会话覆盖 —— 徽标就会显示错的开/关。
 *   2. 引用错位：无关事件返回新引用（白白重算）或全局操作返回原引用
 *      （视图不重算、徽标停在旧值）。
 *
 * 另外校验客户端 bundle 的信封契约：id 必须等于包名，
 * 否则浏览器加载器会拒绝这个模块。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROJECTION_KEY, COMMAND_NAME, emptyProjectionState, parseSwitchArg,
  isGlobalSwitch, applyProjection, mirrorPath, writeMirror, readMirror
} from '../lib/projection.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 造一个 command/run 事件。 */
function runEvent(args, seq = 1) {
  return { type: 'command/run', seq, data: { name: COMMAND_NAME, args } };
}

test('投影：开启命令把状态置为开', () => {
  const next = applyProjection(emptyProjectionState(), runEvent('on', 7));
  assert.equal(next.enabled, true, 'on 必须置为开');
  assert.equal(next.seq, 7, 'seq 应记录事件位置');
});

test('投影：关闭命令把状态置为关', () => {
  const next = applyProjection(emptyProjectionState(), runEvent('off', 3));
  assert.equal(next.enabled, false, 'off 必须置为关');
});

test('投影：裸调用是查状态，绝不能当成 reset', () => {
  // 先开，再裸调用；裸调用不得改变已开的状态。
  const opened = applyProjection(emptyProjectionState(), runEvent('on', 1));
  const afterBare = applyProjection(opened, runEvent('', 2));
  assert.equal(afterBare, opened, '裸调用必须返回原引用（不改状态）');
  assert.equal(afterBare.enabled, true, '裸调用后仍应为开');

  assert.equal(parseSwitchArg(''), undefined, '空参数不解析成开关意图');
});

test('投影：on --global 不动本会话覆盖，但必须触发视图重算', () => {
  assert.equal(parseSwitchArg('on --global'), undefined, '--global 不是本会话意图');
  assert.equal(isGlobalSwitch('on --global'), true, 'on --global 是全局操作');

  const base = applyProjection(emptyProjectionState(), runEvent('on', 1));
  const afterGlobal = applyProjection(base, runEvent('off --global', 2));
  assert.notEqual(afterGlobal, base, '全局操作必须返回新引用，否则视图不重算');
  assert.equal(afterGlobal.enabled, true, '本会话覆盖不受 --global 影响');
});

test('投影：status/gate/init 与无关命令都不改状态', () => {
  const base = applyProjection(emptyProjectionState(), runEvent('on', 1));
  for (const args of ['status', 'gate', 'gate tree', 'init', 'bogus']) {
    assert.equal(applyProjection(base, runEvent(args, 2)), base, `${args} 不得改状态`);
  }
  const other = { type: 'command/run', seq: 3, data: { name: 'permission', args: 'off' } };
  assert.equal(applyProjection(base, other), base, '别的命令不得改状态');
});

test('投影：只认 command/run，不认 command/done', () => {
  const base = emptyProjectionState();
  const done = { type: 'command/done', seq: 2, data: { name: COMMAND_NAME, kind: 'success' } };
  assert.equal(applyProjection(base, done), base, 'command/done 不带 args，不能据它改状态');
});

test('投影：重复同一命令返回原引用（不触发无谓重算）', () => {
  const once = applyProjection(emptyProjectionState(), runEvent('on', 1));
  const twice = applyProjection(once, runEvent('on', 2));
  assert.equal(twice, once, '同参数重复必须返回原引用');
});

test('投影：reset 清除本会话覆盖', () => {
  const opened = applyProjection(emptyProjectionState(), runEvent('on', 1));
  const reset = applyProjection(opened, runEvent('reset', 2));
  assert.equal(reset.enabled, null, 'reset 后回到「未设置」');
});

test('投影：坏事件不抛（日志里可能有各种形状）', () => {
  const base = emptyProjectionState();
  for (const bad of [null, undefined, 42, 'x', {}, { type: 'command/run' }, { type: 'command/run', data: null }]) {
    assert.equal(applyProjection(base, bad), base, `坏输入 ${JSON.stringify(bad)} 必须原样返回`);
  }
});

test('镜像：写入后可读回，且与状态文件同目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'an-mirror-'));
  try {
    const stateFile = join(dir, 'state.json');
    assert.equal(mirrorPath(stateFile), join(dir, 'global.json'), '镜像必须落在状态文件旁边');
    writeMirror(stateFile, true);
    assert.equal(readMirror(stateFile), true, '写 true 应读回 true');
    writeMirror(stateFile, false);
    assert.equal(readMirror(stateFile), false, '写 false 应读回 false');
    writeMirror(stateFile, null);
    assert.equal(readMirror(stateFile), null, 'null 表示未设置');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('镜像：损坏文件读成 null，不抛（显示乐观，但不崩）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'an-mirror-bad-'));
  try {
    const stateFile = join(dir, 'state.json');
    writeFileSync(mirrorPath(stateFile), '{ 这不是 JSON', 'utf8');
    assert.equal(readMirror(stateFile), null, '损坏时应为 null');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('客户端 bundle：信封契约（id 必须等于包名）', () => {
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.ok(
    bundle.includes(`window.__ModuleLoader__.load({id:"${pkg.name}",factory:function(require){`),
    `bundle 必须以 load({id:"${pkg.name}"}) 开头，否则浏览器加载器会拒绝`
  );
  assert.ok(bundle.trimEnd().endsWith('}});'), 'bundle 必须闭合 load 调用');
});

test('客户端 bundle：注册 composer 开关 + 看板 tab，且不碰已废弃的槽位', () => {
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  assert.ok(bundle.includes('conversation.input.left'), '必须注册 composer 工具行左侧（截图里「完全权限」那排）');
  assert.ok(bundle.includes('conversation.view'), '必须注册看板 tab（与「轨迹」并排）');
  // 曾经还注册过输入框上方的 dock tag，按 Owner 要求已移除：
  // 工具行那一枚胶囊已足够表达启用状态，上方再来一条是冗余视觉噪声。
  assert.ok(!/inject\(\s*['"]conversation\.input\.dock['"]/.test(bundle),
    '不应注册 input.dock（上方冗余 tag 已按 Owner 要求移除）');
  assert.ok(!/inject\(\s*['"]conversation\.session\.header\.utilities['"]/.test(bundle),
    '不应注册 header.utilities（空会话下被 hideChrome 隐藏）');
  // 恰好两个 UI 入口：开关 + 看板。多出来就意味着又冒了第三个，需要显式确认。
  const registrations = bundle.match(/slots\.inject\(/g) ?? [];
  assert.equal(registrations.length, 2, `应注册两个槽位（开关 + 看板），实际 ${registrations.length} 个`);
  // 看板 tab 的 id 不能叫 trajectory —— 那是宿主内置轨迹视图的保留 id，
  // 且受 developerTools 开关限制，撞了会互相顶掉。
  assert.ok(!/id:\s*['"]trajectory['"]/.test(bundle), '不得占用宿主保留的 trajectory id');
  assert.ok(bundle.includes('agent-notes-board'), '看板 tab 应有自己的 id');
});

test('客户端 bundle：移除 tag 后不得留下孤儿引用', () => {
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  // 样式、文案、组件都该清干净。留着就是死代码，将来会误导维护者。
  for (const orphan of ['an-tag', 'tagSession', 'tagGlobal', 'AgentNotesTag']) {
    assert.ok(!bundle.includes(orphan), `残留孤儿引用: ${orphan}`);
  }
});

test('客户端 bundle：用官方命令通道写状态，不自己写日志', () => {
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  assert.ok(bundle.includes('.command('), '必须通过 SessionFace.command 提交斜杠命令');
  assert.ok(bundle.includes('/agent-notes'), '提交的应是 /agent-notes 命令');
  // 投影键必须与宿主侧一致，否则读不到状态、徽标恒为「未知」。
  assert.ok(bundle.includes(`'${PROJECTION_KEY}'`), `客户端必须读投影键 ${PROJECTION_KEY}`);
});

test('客户端 bundle：看板同时接入 dsh-better-sidebar 的右侧栏', () => {
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

  /* 两个宿主并存：DSH 内置的 conversation.view，以及第三方插件
     dsh-better-sidebar 提供的 ctx.betterSidebar。 */
  assert.ok(bundle.includes('betterSidebar'), '必须通过 ctx.betterSidebar 接入右侧栏');
  assert.ok(bundle.includes('registerTab'), '必须调用 registerTab 注册 tab 类型');

  /* 服务是**可选**依赖：没装 dsh-better-sidebar 时笔记功能必须照常可用。
     所以只能用 ctx.inject 等待，绝不能写进插件级 inject 数组 ——
     那会让整个插件在缺该服务时根本不加载。 */
  assert.match(
    bundle,
    /inject\(\s*\[\s*['"]betterSidebar['"]\s*\]/,
    '必须用 ctx.inject 把 betterSidebar 当可选依赖等待'
  );
  const pluginInject = /inject:\s*\[([^\]]*)\]/.exec(bundle);
  assert.ok(pluginInject !== null, '应能读到插件级 inject 声明');
  assert.ok(
    !pluginInject[1].includes('betterSidebar'),
    'betterSidebar 不得进插件级 inject —— 缺该服务时整个插件会不加载'
  );

  /* 两个宿主各有独立的状态记账：一个就绪、另一个没就绪时不能互相覆盖，
     否则表现为 tab 时有时无。
     不能只断言字符串存在 —— 那样把两个宿主都指向同一个状态也能通过（实测：
     注入 `name = 'slots'` 让两者共用状态，光靠 includes 一条都没红）。
     所以直接**执行** syncHost，观察它是否真的按宿主分开记账。 */
  /* bundle 是客户端模块，外面包着 window.__ModuleLoader__.load({id, factory})。
     hosts/syncHost 都在闭包里、工厂只 return {name, inject, apply}，
     所以只能走真实路径：调 apply，喂假的 ctx/slots，观察注册与注销行为。
     这比断言字符串强得多 —— 注入「两个宿主共用状态」时它会真的红。 */
  let captured = null;
  const fakeWindow = {
    __ModuleLoader__: { load: (entry) => { captured = entry.factory; } }
  };
  const factoryFn = new Function('window', 'document', 'module', 'exports', 'require', bundle);
  factoryFn(fakeWindow, { createElement: () => null, documentElement: {} }, {}, {}, (name) => {
    if (name === 'react') {
      return {
        createElement: () => null,
        useState: () => [null, () => {}],
        useEffect: () => {},
        useRef: () => ({ current: null }),
        useMemo: (fn) => fn(),
        useSyncExternalStore: (sub, get) => get()
      };
    }
    return {};
  });
  assert.ok(captured !== null, '应能捕获到客户端模块工厂');
  const mod = captured(() => ({}));
  assert.equal(typeof mod.apply, 'function', '工厂应返回 apply');

  /* 记录两个宿主各自的注册/注销。slots 宿主通过 slots.inject 回调提供座位，
     better-sidebar 宿主通过 ctx.inject(['betterSidebar']) 提供。 */
  const seatRegistrations = [];
  const fakeSlots = {
    inject(name, cb) {
      if (name === 'conversation.view') cb();
      return () => {};
    },
    register(options, component) {
      seatRegistrations.push(options.id);
      let disposed = false;
      return () => { disposed = true; };
    }
  };
  const sidebarRegistrations = [];
  const fakeSidebar = {
    registerTab(descriptor) {
      sidebarRegistrations.push(descriptor.id);
      return () => { sidebarRegistrations.disposed = true; };
    }
  };
  const fakeCtx = {
    inject(deps, cb) {
      /* 只模拟 betterSidebar 就绪；其它依赖一律不回调（模拟缺服务）。 */
      if (Array.isArray(deps) && deps.includes('betterSidebar')) cb({ betterSidebar: fakeSidebar, effect: (fn) => { fn(); } });
      return () => {};
    },
    effect() {},
    get() { return undefined; }
  };

  mod.apply(fakeCtx);
  /* 开关默认关闭：两侧都不该注册任何 tab。 */
  assert.equal(seatRegistrations.length, 0, '开关关闭时不应注册 conversation.view tab');
  assert.equal(sidebarRegistrations.length, 0, '开关关闭时不应注册侧边栏 tab');

  /* 再单独验证 syncHost 的分宿主记账 —— 从源码里取出来执行。
     为什么不从 bundle 拿：它被闭包包住，工厂只 return {name, inject, apply}。
     从 src 取能直接观察状态机，且不污染生产代码表面。 */
  const src = readFileSync(join(ROOT, 'src', 'client.js'), 'utf8');
  const start = src.indexOf('var hosts = {');
  const end = src.indexOf('/* 与 lib/projection.js 的 PROJECTION_KEY 必须一致。 */');
  assert.ok(start > 0 && end > start, '应能从源码定位 hosts 与 syncHost');
  const block = src.slice(start, end);
  const build = new Function(`${block}; return { hosts, syncHost, syncBoardTab };`);
  const { hosts, syncHost, syncBoardTab } = build();

  /* slots 就绪、sidebar 未就绪：开。 */
  let slotsOn = 0;
  hosts.slots.register = () => { slotsOn += 1; return () => { slotsOn -= 1; }; };
  hosts.sidebar.register = null;
  syncBoardTab(true);
  assert.equal(slotsOn, 1, 'slots 就绪时应注册');
  assert.equal(hosts.sidebar.enabled, true, 'sidebar 未就绪时应记住意图，不能丢');
  assert.equal(hosts.slots.enabled, true, 'slots 状态不得被 sidebar 覆盖');

  /* 关：slots 注销，sidebar 只改意图。 */
  syncBoardTab(false);
  assert.equal(slotsOn, 0, '关闭后 slots 应注销');
  assert.equal(hosts.sidebar.enabled, false, 'sidebar 应记住关闭意图');
  assert.equal(hosts.slots.enabled, false, '两个宿主各自记账，都要变成 false');

  /* 补一次：sidebar 后来就绪，应立刻按记住的意图注册。 */
  let sidebarOn = 0;
  hosts.sidebar.register = () => { sidebarOn += 1; return () => { sidebarOn -= 1; }; };
  syncHost('sidebar', true);
  assert.equal(sidebarOn, 1, 'sidebar 就绪后应按意图注册');
  assert.equal(slotsOn, 0, 'sidebar 注册不得顺带把 slots 也打开 —— 两者独立');
  /* 侧边栏 tab 用单实例：重复打开聚焦已有的，不开一堆。 */
  assert.match(bundle, /single:\s*true/, '侧边栏 tab 应声明 single: true');
});

test('客户端 bundle：看板要认两种宿主的会话字段', () => {
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  /* 两个宿主传的会话信息形状不同：
       - conversation.view：顶层 sessionId
       - better-sidebar 的 TabComponentProps：scope.sessionId
     只认前者时，侧边栏里 iframe 的 src 会变成 `?session=`（空串），
     路由按设计回 409，表现为整块空白。这类问题在单测里看不出、
     在浏览器里也容易被当成「没数据」，所以钉死两种来源都要读。 */
  assert.match(bundle, /props\.sessionId/, '必须读顶层 sessionId（内置槽位）');
  assert.match(bundle, /props\.scope/, '必须读 scope（better-sidebar）');
  assert.match(bundle, /scope\.sessionId/, '必须从 scope 里取 sessionId');
});
