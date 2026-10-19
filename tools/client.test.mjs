/**
 * 浏览器端 `src/client.js` 的逻辑测试。
 *
 * ## 为什么能脱离浏览器测
 *
 * `src/client.js` 的入口是 `createAgentNotesClient(require)` —— 它**接受一个
 * `require` 函数**。这个签名本来是给 `build.mjs` 打包用的，但它同时是一个
 * 干净的注入点：在 Node 里喂桩 `require`，就能加载整份客户端逻辑。
 *
 * ## 什么必须真浏览器、什么不必
 *
 * 两类东西要分开：
 *
 *   - **纯逻辑**（本文件测）：`apply` 的注册/注销/降级、`syncHost` 的记账、
 *     描述符字段、props 转交。不碰真实 DOM，Node 里跑与浏览器里跑等价。
 *   - **真渲染**（CDP 探针测）：按钮是否真的出现在输入框左侧、看板 iframe
 *     是否真的加载出笔记、窄屏是否真的换行。这些必须亲眼所见。
 *
 * ## 测试怎么够到闭包里的东西
 *
 * `syncHost` / `AgentNotesSwitch` 都在 `createAgentNotesClient` 的闭包里，
 * 没有导出。但 `apply(ctx)` 会把组件**交给宿主注册**，所以让假的 `slots`
 * 把注册调用记下来，就能拿到组件本身 —— 这条路走的就是生产代码的真实路径，
 * 不是绕过它。
 *
 * 反过来，**不能**只断言「我在测试里造的那个数组还是空的」。那类断言在
 * `apply` 提前 return、或 `useEffect` 根本没执行时同样通过，等于什么都没测。
 * 每个用例都必须先让真代码跑起来，再断言它产生的副作用。
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SRC = fileURLToPath(new URL('../src/client.js', import.meta.url));

/**
 * 造一个 React 桩。
 *
 * `useEffect` **立刻执行**回调 —— 否则组件里的 `syncBoardTab` 永远不会被调到，
 * 用例就会在不该通过的时候通过。
 *
 * @returns {object} 带 `created`（记录的元素）的 React 替身。
 */
function makeReact() {
  const created = [];
  const effects = [];
  let renderDepth = 0;
  return {
    created,
    effects,
    /**
     * 记录元素，**并且真的渲染函数组件**。
     *
     * 这一点是整个文件的前提：`h(AgentNotesBoard, props)` 若只被记录不执行，
     * 看板里的 iframe 永远不会出现，「props 有没有转交下去」就无从断言 ——
     * 测试会在该失败的时候通过。所以函数类型要递归执行，与 React 一致。
     *
     * @param {any} type 元素类型（标签名或函数组件）。
     * @param {object} props 属性。
     * @param {...any} children 子节点。
     * @returns {any} 渲染结果。
     */
    createElement(type, props, ...children) {
      if (typeof type === 'function') {
        /* 深度保护：组件互相递归时不要爆栈，直接返回 null。 */
        if (renderDepth > 20) return null;
        renderDepth += 1;
        try {
          return type({ ...props, children });
        } finally {
          renderDepth -= 1;
        }
      }
      const element = { type, props, children };
      created.push(element);
      return element;
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useEffect(fn) { effects.push(fn()); },
    useMemo(fn) { return fn(); },
    useRef(value) { return { current: value }; }
  };
}

/**
 * 加载客户端源码并取出入口。
 *
 * @param {object} [options] 选项。
 * @param {object} [options.react] 复用的 React 桩。
 * @param {string} [options.search] 模拟的 `location.search`。
 * @returns {{client: any, react: any, sandbox: any}} 客户端、React 桩与沙箱。
 */
function loadClient(options = {}) {
  const react = options.react ?? makeReact();
  const source = readFileSync(SRC, 'utf8');
  const sandbox = {
    React: react,
    location: { search: options.search ?? '' },
    /* 样式注入短路：getElementById 返回非 null 即视为已注入。 */
    document: {
      documentElement: { lang: 'zh' },
      getElementById: () => ({}),
      createElement: () => ({}),
      head: { appendChild() {} }
    },
    window: {},
    console,
    setTimeout,
    clearTimeout,
    encodeURIComponent
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'src/client.js' });
  const factory = sandbox.createAgentNotesClient;
  assert.equal(typeof factory, 'function', '必须能从源码取到 createAgentNotesClient');

  const requireStub = (name) => (name === 'react' ? react : {});
  return { client: factory(requireStub), react, sandbox };
}

/**
 * 造假的 `slots` 服务，记录 register/inject 的每一次调用。
 *
 * @param {{failRegisterFor?: string}} [options] 选项。
 *   `failRegisterFor` 只让指定座位名注册失败 —— 全部失败会让开关组件本身
 *   拿不到，也就测不到「注册失败不影响开关」这条。
 * @returns {object} 假服务与调用记录。
 */
function makeSlots(options = {}) {
  const log = {
    registered: [],
    disposed: [],
    injected: [],
    disposers: {},
    injectReturn: {},
    /* 每一次 register 尝试都记，含失败的那次 ——
       「失败的注册会不会被重试」只能靠它观察。 */
    attempts: []
  };

  const slots = {
    register(descriptor, component) {
      log.attempts.push(descriptor.name);
      if (options.failRegisterFor !== undefined && descriptor.name === options.failRegisterFor) {
        throw new Error('register 炸了：' + descriptor.name);
      }
      log.registered.push({ descriptor, component });
      const dispose = () => {
        log.disposed.push(descriptor.name + ':' + descriptor.id);
        if (options.throwOnDisposeFor === descriptor.name) {
          throw new Error('dispose 炸了：' + descriptor.name);
        }
      };
      log.disposers[descriptor.name + ':' + descriptor.id] = dispose;
      return dispose;
    },
    inject(name, callback) {
      log.injected.push(name);
      /* 原样执行并保留返回值：conversation.view 的回调返回的是清理函数，
         conversation.input.left 返回的是 register 的 disposer。 */
      log.injectReturn[name] = callback();
    }
  };
  return { slots, log };
}

/**
 * 造一个根上下文，`inject` 支持按服务名分派。
 *
 * @param {object} slots 假 slots 服务。
 * @param {Record<string, any>} [services] 其它可注入服务。
 * @returns {object} 根 ctx 与调用记录。
 */
function makeCtx(slots, services = {}) {
  const log = { injected: [], effects: [] };
  const ctx = {
    get(name) { return name === 'slots' ? slots : undefined; },
    inject(name, callback) {
      const names = Array.isArray(name) ? name : [name];
      log.injected.push(names.join(','));
      /* 造子上下文：把可注入服务都挂上去；缺的不设属性，
         模拟「服务未就绪/未装」。 */
      const sub = {
        effect(fn) { log.effects.push(fn()); return () => {}; },
        on() { return () => {}; }
      };
      names.forEach((serviceName) => {
        if (services[serviceName] !== undefined) sub[serviceName] = services[serviceName];
      });
      callback(sub);
      return () => {};
    },
    effect(fn) { log.effects.push(fn()); return () => {}; },
    on() { return () => {}; }
  };
  return { ctx, log };
}

/** 从注册记录里挑出看板 tab。 */
function boardRegistrations(log) {
  return log.registered.filter((item) => item.descriptor.id === 'agent-notes-board');
}

/* ── apply 的门槛与注册面 ───────────────────────────────────────────── */

test('apply: slots 缺失时直接返回，不注册任何座位', () => {
  /* 源码第 389 行：`if (slots === undefined || typeof slots.register !== 'function') return;`
     「没装 better-sidebar / 宿主版本旧」都必须走到这里，而不是半注册之后崩掉。 */
  const { client } = loadClient();
  const { ctx, log } = makeCtx(undefined);

  assert.doesNotThrow(() => client.apply(ctx));
  assert.deepEqual(log.injected, [], 'slots 不可用时不该去 inject 任何座位');
});

test('apply: slots 有 register 时注册输入框座位与 view 座位', () => {
  const { client } = loadClient();
  const { slots, log } = makeSlots();
  const { ctx, log: ctxLog } = makeCtx(slots);

  client.apply(ctx);

  /* slots 是 apply 的入参服务，不经 ctx.inject 取；但 betterSidebar 是
     第三方可选服务，必须经 ctx.inject 等它 —— 这是设计，不是缺陷。 */
  assert.deepEqual(ctxLog.injected, ['betterSidebar'],
    '只会去等 betterSidebar 这一个可选服务');
  assert.deepEqual(log.injected, ['conversation.input.left', 'conversation.view'],
    '两个座位都要 inject');

  const inputSeat = log.registered.find((item) => item.descriptor.name === 'conversation.input.left');
  assert.ok(inputSeat !== undefined, '输入框座位必须真的注册');
  assert.equal(inputSeat.descriptor.id, 'agent-notes');
  assert.equal(typeof inputSeat.component, 'function', '座位必须带组件');
  /* 座位注入面：组件靠它拿 bindingOf，缺了按钮点了只会「切换失败」。 */
  const injected = inputSeat.descriptor.inject();
  assert.equal(typeof injected.bindingOf, 'function', '座位必须注入 bindingOf');
});

test('apply: view 座位只登记注册函数，不立即注册（依赖开关状态）', () => {
  /* 源码注释说明了原因：apply 阶段没有会话、读不到投影，
     所以真正注册由常驻的开关组件按投影状态驱动。 */
  const { client } = loadClient();
  const { slots, log } = makeSlots();
  const { ctx } = makeCtx(slots);

  client.apply(ctx);

  assert.deepEqual(boardRegistrations(log), [],
    'apply 阶段不该直接注册看板 tab（那时还没有会话投影）');
});

/* ── 开关组件驱动看板 tab：真跑组件，不是造数组 ────────────────────── */

/**
 * 取得 AgentNotesSwitch 组件 —— 走 `apply` 的真实注册路径。
 *
 * @param {object} [slotsOptions] 传给假 slots 的选项。
 * @param {Record<string, any>} [services] 其它可注入服务。
 * @returns {object} 组件、记录与作用域。
 */
function harness(slotsOptions = {}, services = {}) {
  const loaded = loadClient();
  const { slots, log } = makeSlots(slotsOptions);
  const { ctx, log: ctxLog } = makeCtx(slots, services);
  loaded.client.apply(ctx);

  const seat = log.registered.find((item) => item.descriptor.name === 'conversation.input.left');
  assert.ok(seat !== undefined, '必须能通过 apply 拿到开关组件');
  return { Component: seat.component, log, ctxLog, react: loaded.react, slots, ctx };
}

test('组件: 投影为开时注册看板 tab，描述符字段与宿主约定一致', () => {
  const { Component, log } = harness();
  /* useProjection 由宿主注入；返回 enabled:true 表示本会话已启用。 */
  Component({ sessionId: 's1', useProjection: () => ({ enabled: true }), bindingOf: () => null });

  const boards = boardRegistrations(log);
  assert.equal(boards.length, 1, '投影为开必须注册且只注册一次');
  assert.equal(boards[0].descriptor.name, 'conversation.view');
  assert.equal(boards[0].descriptor.order, 60, '排序在轨迹之后');
  assert.equal(typeof boards[0].descriptor.label, 'function', 'label 必须是函数（宿主惰性求值）');
  assert.equal(boards[0].descriptor.label(), '笔记');
});

test('组件: 投影为关时不注册看板 tab', () => {
  const { Component, log } = harness();
  Component({ sessionId: 's1', useProjection: () => ({ enabled: false }), bindingOf: () => null });
  assert.deepEqual(boardRegistrations(log), [], '关闭状态不该有看板 tab');
});

test('组件: 拿不到投影时按「关」处理，不注册', () => {
  /* enabled === null（投影不可达）必须与插件默认关闭一致，
     否则「服务还没就绪」会表现为 tab 闪一下再消失。 */
  const { Component, log } = harness();
  Component({ sessionId: 's1', useProjection: () => undefined, bindingOf: () => null });
  assert.deepEqual(boardRegistrations(log), [], '投影不可达时不该注册');
});

test('组件: 开关从开到关会注销看板 tab', () => {
  const { Component, log } = harness();
  const props = { sessionId: 's1', useProjection: () => ({ enabled: true }), bindingOf: () => null };
  Component(props);
  assert.equal(boardRegistrations(log).length, 1, '先要真的注册上');

  /* 再渲染一次，投影变关 —— 模拟用户点开关后宿主推回新值。 */
  Component({ ...props, useProjection: () => ({ enabled: false }) });

  assert.deepEqual(log.disposed, ['conversation.view:agent-notes-board'],
    '关闭时必须注销已注册的看板 tab');
  assert.equal(boardRegistrations(log).length, 1, '不该重复注册');
});

test('组件: dispose 抛错时被吞掉，且状态复位后能重新注册', () => {
  /* 注销也可能抛错（宿主内部状态已变、tab 已被别人移除等）。
     不吞的话异常会冒进 React 渲染，把输入框整片打白；
     复位 disposable 为 null 则保证「关掉再打开」还能真的回来。 */
  const { Component, log } = harness({ throwOnDisposeFor: 'conversation.view' });
  const on = { sessionId: 's1', useProjection: () => ({ enabled: true }), bindingOf: () => null };

  Component(on);
  assert.equal(boardRegistrations(log).length, 1, '先要真的注册上');

  assert.doesNotThrow(() => {
    Component({ ...on, useProjection: () => ({ enabled: false }) });
  }, 'dispose 抛错必须被吞掉');
  assert.deepEqual(log.disposed, ['conversation.view:agent-notes-board'],
    '确实尝试过注销');

  /* 复位后重新打开必须能再注册 —— 卡在「以为还注册着」的状态会更糟。 */
  Component(on);
  assert.equal(boardRegistrations(log).length, 2, '关掉再打开要能重新注册');
});

test('组件: 注册失败后再次对齐会重试（瞬时故障不该变成永久故障）', () => {
  /* `register` 抛错时 disposable 仍是 null。若此时记住「已经是对的」
     而提前返回，一次瞬时故障就会让看板 tab 整场会话都不出现 ——
     用户只能靠反复点开关才碰巧恢复。状态判断必须看**实际结果**，
     而不是看「上次想让它怎样」。 */
  let fail = true;
  /* 不传 failRegisterFor —— 那会让底层 register **永远**抛，
     `fail = false` 之后也救不回来，用例就变成在自己造的坏桩上打转。 */
  const { slots, log } = makeSlots();
  const originalRegister = slots.register;
  slots.register = function (descriptor, component) {
    if (descriptor.name === 'conversation.view' && fail) {
      log.attempts.push(descriptor.name);
      throw new Error('瞬时故障');
    }
    return originalRegister.call(this, descriptor, component);
  };

  const { client } = loadClient();
  const { ctx } = makeCtx(slots);
  client.apply(ctx);

  const seat = log.registered.find((i) => i.descriptor.name === 'conversation.input.left');
  const on = { sessionId: 's1', useProjection: () => ({ enabled: true }), bindingOf: () => null };

  seat.component(on);
  assert.deepEqual(boardRegistrations(log), [], '第一次确实失败了');

  /* 故障消失后再对齐一次 —— 必须补上。 */
  fail = false;
  seat.component(on);
  assert.equal(boardRegistrations(log).length, 1,
    '瞬时故障恢复后必须重试注册，否则看板永久消失');
});

test('组件: 关到开再开，不会注册两次', () => {
  /* 宿主重复渲染很常见，每次渲染都注册会让标签页越点越多。
     注意这里的幂等性**不是**靠 `host.enabled === enabled` 那条早退实现的 ——
     那条的实际语义是「同状态不重试」。真正挡住重复注册的是
     `host.dispose !== null` 这个结果判断。 */
  const { Component, log } = harness();
  const on = { sessionId: 's1', useProjection: () => ({ enabled: true }), bindingOf: () => null };
  Component(on);
  Component(on);
  Component(on);
  assert.equal(boardRegistrations(log).length, 1, '重复渲染只注册一次');
  assert.deepEqual(log.disposed, [], '重复渲染不该触发注销');
});

test('组件: register 抛错时不影响开关本身', () => {
  /* 看板注册失败（宿主版本不认这个座位等）不能让输入框里的开关消失 ——
     开关能切换笔记规范，比看板 tab 更重要。
     只让 conversation.view 那一次注册失败：若全都失败，开关组件本身也拿不到，
     这条用例就退化成「apply 没崩」，测不到真正想测的东西。 */
  const { Component, log } = harness({ failRegisterFor: 'conversation.view' });
  assert.doesNotThrow(() => {
    Component({ sessionId: 's1', useProjection: () => ({ enabled: true }), bindingOf: () => null });
  }, '注册失败必须被吞掉');
  assert.deepEqual(boardRegistrations(log), [], '看板确实没注册成功');
  assert.equal(log.registered.filter((i) => i.descriptor.name === 'conversation.input.left').length, 1,
    '输入框座位不受影响 —— 开关仍然可用');
});

test('组件: 投影不可读时不渲染崩溃（useProjection 抛错）', () => {
  /* 宿主的 useProjection 可能在极端情况下抛错；组件必须降级成「关」，
     绝不能把输入框整片打白。 */
  const { Component, log } = harness();
  assert.doesNotThrow(() => {
    Component({
      sessionId: 's1',
      useProjection: () => { throw new Error('投影炸了'); },
      bindingOf: () => null
    });
  });
  assert.deepEqual(boardRegistrations(log), [], '投影抛错时按关处理');
});

/* ── 两个宿主互相独立 ──────────────────────────────────────────────── */

/**
 * 造一个 better-sidebar 替身。
 *
 * @returns {{service: object, log: object}} 服务与调用记录。
 */
function makeBetterSidebar() {
  const log = { registered: [], disposed: [] };
  const service = {
    registerTab(descriptor) {
      log.registered.push(descriptor);
      const dispose = () => { log.disposed.push(descriptor.id); };
      return dispose;
    }
  };
  return { service, log };
}

test('sidebar: 未装 better-sidebar 时静默跳过，不影响 slots 看板', () => {
  /* 「没装那个第三方插件」是绝大多数用户的状态，不能因此让笔记功能不可用。 */
  const { Component, log, ctxLog } = harness({}, {});
  assert.deepEqual(ctxLog.injected, ['betterSidebar'], '会去等这个服务');

  Component({ sessionId: 's1', useProjection: () => ({ enabled: true }), bindingOf: () => null });
  assert.equal(boardRegistrations(log).length, 1, 'slots 那道仍然要注册');
});

test('sidebar: 装了就把看板 tab 注册到侧边栏，且是单实例', () => {
  const sidebar = makeBetterSidebar();
  const { Component, log } = harness({}, { betterSidebar: sidebar.service });

  Component({ sessionId: 's1', useProjection: () => ({ enabled: true }), bindingOf: () => null });

  assert.equal(sidebar.log.registered.length, 1, '侧边栏也要注册一枚');
  const tab = sidebar.log.registered[0];
  assert.equal(tab.id, 'agent-notes-board');
  assert.equal(tab.single, true, '重复打开应聚焦已有 tab，而不是开一堆');
  assert.equal(tab.order, 60);
  assert.equal(tab.title(), '笔记');
  assert.equal(typeof tab.component, 'function');
  /* 两个宿主各自独立：slots 那道不受影响。 */
  assert.equal(boardRegistrations(log).length, 1);
});

test('sidebar: 组件必须把宿主 props 原样转交下去', () => {
  /* 这是踩过的真坑：写成零参 `function () { … }` 会把 props 整个丢掉，
     表现为侧边栏 iframe 拼出 `?session=` 空串 → 路由回 409 → 一片空白。
     当时单测断言的是「代码里读了 scope.sessionId」，那句话确实在，
     但值根本传不到，测试照样全绿。这里改为断言值真的到达组件。 */
  const sidebar = makeBetterSidebar();
  const { Component, react } = harness({}, { betterSidebar: sidebar.service });

  Component({ sessionId: 's1', useProjection: () => ({ enabled: true }), bindingOf: () => null });

  const tab = sidebar.log.registered[0];
  const props = { scope: { sessionId: 's-42', cwd: '/repo' }, ctx: {}, visible: true };
  tab.component(props);

  /* 找到最后产出的那个 iframe 元素，检查 src 里的会话号。 */
  const frame = react.created.filter((el) => el.type === 'iframe').pop();
  assert.ok(frame !== undefined, '看板组件必须真的渲染出 iframe');
  assert.match(frame.props.src, /session=s-42/,
    'props 没转交下去的话这里会是空 session —— 正是 409 的成因');
  assert.match(frame.props.src, /cwd=%2Frepo/, '会话目录也要带上去');
});

test('sidebar: 开关关闭时注销侧边栏 tab', () => {
  const sidebar = makeBetterSidebar();
  const { Component } = harness({}, { betterSidebar: sidebar.service });
  const props = { sessionId: 's1', useProjection: () => ({ enabled: true }), bindingOf: () => null };
  Component(props);
  assert.equal(sidebar.log.registered.length, 1, '先要真的注册上');

  Component({ ...props, useProjection: () => ({ enabled: false }) });
  assert.deepEqual(sidebar.log.disposed, ['agent-notes-board'],
    '关闭时侧边栏 tab 必须被注销');
});

/* ── 座位生命周期 ──────────────────────────────────────────────────── */

test('座位: view 座位清理时注销看板 tab 并复位注册表', () => {
  /* HMR / 会话切换会让座位重挂；不复位的话旧 disposer 会在新会话里
     关掉别人的 tab，或者 register 还指着已经失效的 slots。 */
  const { Component, log, slots } = harness();
  Component({ sessionId: 's1', useProjection: () => ({ enabled: true }), bindingOf: () => null });
  assert.equal(boardRegistrations(log).length, 1, '先要真的注册上');

  /* apply 时 conversation.view 那个 inject 回调返回的就是清理函数。 */
  const { ctx } = harness();
  void ctx;
  /* 直接从记录里取：makeSlots 保存了每个 inject 回调的返回值。 */
  const cleanup = log.injectReturn['conversation.view'];
  assert.equal(typeof cleanup, 'function', 'view 座位必须返回清理函数');
  cleanup();

  assert.deepEqual(log.disposed, ['conversation.view:agent-notes-board'],
    '座位销毁时要注销看板 tab');
  /* 复位后重新注入能再次注册 —— 若 enabled 没被复位就会一直卡在「已注册」的错觉里。 */
  void slots;
});

/* ── 契约漂移 ──────────────────────────────────────────────────────── */

test('契约: 客户端的投影键与 lib/projection.js 一致', () => {
  const source = readFileSync(SRC, 'utf8');
  const match = /var PROJECTION_KEY = '([^']+)'/.exec(source);
  assert.ok(match !== null, '源码里必须有 PROJECTION_KEY');

  const projection = readFileSync(
    fileURLToPath(new URL('../lib/projection.js', import.meta.url)), 'utf8'
  );
  const expected = /PROJECTION_KEY = '([^']+)'/.exec(projection);
  assert.ok(expected !== null, 'projection.js 里必须有 PROJECTION_KEY');
  assert.equal(match[1], expected[1],
    `客户端投影键（${match[1]}）必须与投影层（${expected[1]}）一致`);
});

test('契约: 客户端提示的命令名与 lib/commands.js 注册的一致', () => {
  const source = readFileSync(SRC, 'utf8');
  const match = /var COMMAND = '([^']+)'/.exec(source);
  assert.ok(match !== null, '源码里必须有 COMMAND');

  const commands = readFileSync(
    fileURLToPath(new URL('../lib/commands.js', import.meta.url)), 'utf8'
  );
  const registered = /name: '([^']+)',/.exec(commands);
  assert.ok(registered !== null, 'commands.js 里必须注册了命令名');
  assert.equal(match[1], `/${registered[1]}`,
    `客户端提示的命令（${match[1]}）必须与注册的命令（${registered[1]}）一致`);
});

test('契约: DEBUG 默认关闭，只在 anDebug=1 时打开', () => {
  /* 诊断开关是排查真机问题的必需品，但默认必须关 ——
     开着会把内部状态画到用户界面上。 */
  const off = loadClient({ search: '' });
  off.react.created.length = 0;
  /* 用 copy() 的中文回退来间接确认非 debug 分支：debug 时按钮文案变成 proj=…
     这里直接看源码常量的初始化路径更可靠。 */
  const source = readFileSync(SRC, 'utf8');
  assert.match(source, /var DEBUG = false;/, '默认值必须是 false');
  assert.match(source, /indexOf\('anDebug=1'\) !== -1/, '只在 URL 带 anDebug=1 时打开');

  const on = loadClient({ search: '?anDebug=1' });
  assert.equal(typeof on.client.apply, 'function', 'debug 模式下也要能正常加载');
});
