/**
 * 浏览器端 `src/client.js` 的逻辑测试。
 *
 * ## 为什么能脱离浏览器测
 *
 * `src/client.js` 的入口是 `createAgentNotesClient(require)` —— 它**接受一个
 * `require` 函数**。这个签名本来是给 `build.mjs` 打包用的，但它同时是一个
 * 干净的注入点：在 Node 里喂桩 `require`，就能加载整份客户端逻辑。
 *
 * ## 2026-11-12 的形态变化
 *
 * Owner 要求删掉对话输入区那个「笔记规范」开关，改为「仓库确实在用笔记时
 * 看板 tab 自动出现」。于是：
 *   - 组件从**按钮**变成**无渲染的闸门**（`AgentNotesBoardGate`）；
 *   - 驱动信号从「会话投影 enabled」变成「服务端 `/agent-notes/status`
 *     回答这个仓库有没有笔记体系」。
 *
 * 这组用例因此必须**真的让 fetch 走完**再断言 —— 闸门是异步的，
 * 只渲染一次就断言等于什么都没测（那时 syncBoardTab 还没被调到）。
 *
 * ## 什么必须真浏览器、什么不必
 *
 *   - **纯逻辑**（本文件测）：`apply` 的注册/注销/降级、`syncHost` 的记账、
 *     描述符字段、props 转交、状态请求的判据。
 *   - **真渲染**（CDP 探针 + 截图测）：按钮是否真的消失、看板 tab 是否真的
 *     出现、iframe 是否真的加载出笔记。这些必须亲眼所见。
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SRC = fileURLToPath(new URL('../src/client.js', import.meta.url));
const BOARD_ROUTE = fileURLToPath(new URL('../lib/board-route.js', import.meta.url));

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
 * 造一个可编排的 `fetch` 桩。
 *
 * @param {object | 'throw' | 'http-error'} [reply] 应答。
 *   `{ available: boolean }` → 200 + JSON；`'throw'` → 网络异常；
 *   `'http-error'` → 500。
 * @returns {{ fetch: Function, urls: string[] }} 桩与请求记录。
 */
function makeFetchStub(reply) {
  const urls = [];
  const fetch = (url) => {
    urls.push(String(url));
    /* 允许传函数：同一个 harness 里模拟「切到另一个仓库」时每次应答不同。 */
    const current = typeof reply === 'function' ? reply(url, urls.length - 1) : reply;
    if (current === 'throw') return Promise.reject(new Error('网络炸了'));
    if (current === 'http-error') return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true, available: current?.available !== false })
    });
  };
  return { fetch, urls };
}

/**
 * 加载客户端源码并取出入口。
 *
 * @param {object} [options] 选项。
 * @param {object} [options.react] 复用的 React 桩。
 * @param {string} [options.search] 模拟的 `location.search`。
 * @param {object | 'throw' | 'http-error'} [options.fetchReply] `fetch` 桩的应答。
 * @returns {{client: any, react: any, sandbox: any, fetchLog: object}} 客户端、React 桩、沙箱与请求记录。
 */
function loadClient(options = {}) {
  const react = options.react ?? makeReact();
  const source = readFileSync(SRC, 'utf8');
  const fetchStub = makeFetchStub(options.fetchReply ?? { available: true });
  const sandbox = {
    React: react,
    location: { search: options.search ?? '' },
    /* 样式注入短路：getElementById 返回非 null 即视为已注入。 */
    document: {
      baseURI: options.baseURI ?? 'https://example.test/',
      documentElement: { lang: 'zh' },
      getElementById: () => ({}),
      createElement: () => ({}),
      head: { appendChild() {} }
    },
    window: {},
    fetch: fetchStub.fetch,
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
  return { client: factory(requireStub), react, sandbox, fetchLog: fetchStub };
}

/**
 * 让挂起的微任务跑完（闸门是异步的：fetch → then → syncBoardTab）。
 *
 * @param {number} [rounds] 轮数；fetch + json + then 至少三轮。
 * @returns {Promise<void>} 完成信号。
 */
async function flush(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

/**
 * 造假的 `slots` 服务，记录 register/inject 的每一次调用。
 *
 * @param {{failRegisterFor?: string, throwOnDisposeFor?: string}} [options] 选项。
 * @returns {object} 假服务与调用记录。
 */
function makeSlots(options = {}) {
  const log = {
    registered: [],
    disposed: [],
    injected: [],
    disposers: {},
    injectReturn: {},
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

/**
 * 取得闸门组件 —— 走 `apply` 的真实注册路径。
 *
 * @param {object} [slotsOptions] 传给假 slots 的选项。
 * @param {Record<string, any>} [services] 其它可注入服务。
 * @param {object} [clientOptions] 传给 loadClient 的选项。
 * @returns {object} 组件、记录与作用域。
 */
function harness(slotsOptions = {}, services = {}, clientOptions = {}) {
  const loaded = loadClient(clientOptions);
  const { slots, log } = makeSlots(slotsOptions);
  const { ctx, log: ctxLog } = makeCtx(slots, services);
  loaded.client.apply(ctx);

  const seat = log.registered.find((item) => item.descriptor.name === 'conversation.input.left');
  assert.ok(seat !== undefined, '必须能通过 apply 拿到闸门组件');
  return {
    Component: seat.component,
    log,
    ctxLog,
    react: loaded.react,
    slots,
    ctx,
    fetchLog: loaded.fetchLog
  };
}

/**
 * 渲染一次闸门并把异步判定跑完。
 *
 * @param {Function} Component 闸门组件。
 * @param {object} [props] 额外 props。
 * @returns {Promise<void>} 完成信号。
 */
async function mount(Component, props = {}) {
  Component({ sessionId: 's1', ...props });
  await flush();
}

/* ── apply 的门槛与注册面 ───────────────────────────────────────────── */

test('apply: slots 缺失时直接返回，不注册任何座位', () => {
  const { client } = loadClient();
  const { ctx, log } = makeCtx(undefined);

  assert.doesNotThrow(() => client.apply(ctx));
  assert.deepEqual(log.injected, [], 'slots 不可用时不该去 inject 任何座位');
});

test('apply: 注册输入框闸门座位与 view 座位，闸门不带任何可点元素', () => {
  const { client } = loadClient();
  const { slots, log } = makeSlots();
  const { ctx, log: ctxLog } = makeCtx(slots);

  client.apply(ctx);

  assert.deepEqual(ctxLog.injected, ['betterSidebar'],
    '只会去等 betterSidebar 这一个可选服务');
  assert.deepEqual(log.injected, ['conversation.input.left', 'conversation.view'],
    '两个座位都要 inject');

  const inputSeat = log.registered.find((item) => item.descriptor.name === 'conversation.input.left');
  assert.ok(inputSeat !== undefined, '输入框座位必须真的注册');
  assert.equal(inputSeat.descriptor.id, 'agent-notes');
  assert.equal(typeof inputSeat.component, 'function', '座位必须带组件');
  /* 2026-11-12：原来这里断言「必须注入 bindingOf」（按钮靠它执行命令）。
     按钮已删除，闸门不发命令、不渲染元素，所以**不该**再有 inject 面。 */
  assert.equal(inputSeat.descriptor.inject, undefined,
    '闸门不需要注入面：它不发命令、不画按钮');
});

test('apply: view 座位只登记注册函数，不立即注册（等闸门问出结果）', () => {
  const { client } = loadClient();
  const { slots, log } = makeSlots();
  const { ctx } = makeCtx(slots);

  client.apply(ctx);

  assert.deepEqual(boardRegistrations(log), [],
    'apply 阶段不该直接注册看板 tab（那时还没有会话，问不出结果）');
});

/* ── 闸门驱动看板 tab：真跑组件 + 真跑异步请求 ─────────────────────── */

test('闸门: 服务端说「这个仓库在用笔记」时注册看板 tab，描述符与宿主约定一致', async () => {
  const { Component, log } = harness({}, {}, { fetchReply: { available: true } });
  await mount(Component);

  const boards = boardRegistrations(log);
  assert.equal(boards.length, 1, '开口时必须注册且只注册一次');
  assert.equal(boards[0].descriptor.name, 'conversation.view');
  assert.equal(boards[0].descriptor.order, 60, '排序在轨迹之后');
  assert.equal(typeof boards[0].descriptor.label, 'function', 'label 必须是函数（宿主惰性求值）');
  assert.equal(boards[0].descriptor.label(), '笔记');
});

test('闸门: 服务端说「这个仓库没用笔记」时不注册看板 tab', async () => {
  const { Component, log } = harness({}, {}, { fetchReply: { available: false } });
  await mount(Component);
  assert.deepEqual(boardRegistrations(log), [], 'available:false 时不该出现看板');
});

test('闸门: 请求失败时不猜（保留上次判定，不新增 tab）', async () => {
  /* 2026-11-12 实测修正：原来「失败按可用处理」（失败开放），结果是启动瞬间
     一次请求失败就把看板挂到**所有**仓库上 —— Owner 看到的「没装 skill 也出现
     tab」正是它。现在失败/无网/路由未就绪一律**保留上次判定**：
     首次就失败 ⇒ 什么都没发生 ⇒ 不出现。 */
  const throwCase = harness({}, {}, { fetchReply: 'throw' });
  await mount(throwCase.Component);
  assert.equal(boardRegistrations(throwCase.log).length, 0, '网络异常时不该凭空挂出看板');

  const errCase = harness({}, {}, { fetchReply: 'http-error' });
  await mount(errCase.Component);
  assert.equal(boardRegistrations(errCase.log).length, 0, 'HTTP 错误时不该凭空挂出看板');
});

test('闸门: 判定跟随仓库 —— 切到没装 skill 的仓库要收起 tab', async () => {
  /* 2026-11-12 实测修正：原来「只加不减」，切到没装 skill 的目录 tab 仍在，
     Owner 当场看到的就是这个。现在 true → 挂、false → 收。 */
  const replies = [{ available: true }, { available: false }];
  let call = 0;
  const { Component, log } = harness({}, {}, {
    fetchReply: () => replies[Math.min(call++, replies.length - 1)]
  });
  await mount(Component, { sessionId: 'with-skill' });
  assert.equal(boardRegistrations(log).length, 1, '第一个仓库装了 skill：先挂上');
  assert.deepEqual(log.disposed, [], '这一步不该有注销');

  /* 再渲染一次（模拟切到另一个仓库）：这次服务端说不可用。 */
  await mount(Component, { sessionId: 'without-skill' });
  assert.deepEqual(log.disposed, ['conversation.view:agent-notes-board'],
    '不可用时必须注销 —— 不能只加不减');
});

test('闸门: 渲染结果是 null（输入区不出现任何按钮）', async () => {
  const { Component } = harness({}, {}, { fetchReply: { available: true } });
  assert.equal(Component({ sessionId: 's1' }), null, '闸门必须不渲染任何东西');
  await flush();
});

test('闸门: 重复渲染只注册一次', async () => {
  const { Component, log } = harness({}, {}, { fetchReply: { available: true } });
  await mount(Component);
  await mount(Component);
  await mount(Component);
  assert.equal(boardRegistrations(log).length, 1, '重复渲染只注册一次');
  assert.deepEqual(log.disposed, [], '重复渲染不该触发注销');
});

test('闸门: register 抛错时被吞掉，且下一次会重试（瞬时故障不该变成永久故障）', async () => {
  let fail = true;
  const { slots, log } = makeSlots();
  const originalRegister = slots.register;
  slots.register = function (descriptor, component) {
    if (descriptor.name === 'conversation.view' && fail) {
      log.attempts.push(descriptor.name);
      throw new Error('瞬时故障');
    }
    return originalRegister.call(this, descriptor, component);
  };

  const { client, fetchLog } = loadClient({ fetchReply: { available: true } });
  const { ctx } = makeCtx(slots);
  client.apply(ctx);
  const seat = log.registered.find((i) => i.descriptor.name === 'conversation.input.left');
  assert.ok(seat, '闸门座位必须注册上');

  seat.component({ sessionId: 's1' });
  await flush();
  assert.deepEqual(boardRegistrations(log), [], '第一次确实失败了');

  fail = false;
  seat.component({ sessionId: 's1' });
  await flush();
  assert.equal(boardRegistrations(log).length, 1,
    '瞬时故障恢复后必须重试注册，否则看板永久消失');
  assert.equal(fetchLog.urls.length, 2, '两次渲染各问一次（每次渲染一条请求）');
});

test('闸门: 请求带上会话 id 与 cwd（服务端要靠 cwd 判仓库）', async () => {
  const { Component, fetchLog } = harness({}, {}, { fetchReply: { available: true } });
  Component({ sessionId: 's 1', scope: { sessionId: 's 1', cwd: '/repo with spaces/中文' } });
  await flush();

  assert.equal(fetchLog.urls.length, 1);
  const url = fetchLog.urls[0];
  assert.match(url, /^agent-notes\/status\?/, '必须走相对地址，保留挂载前缀');
  assert.match(url, /session=s%201/, '会话 id 必须编码');
  assert.match(url, /cwd=%2Frepo%20with%20spaces%2F%E4%B8%AD%E6%96%87/, 'cwd 必须完整编码');
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

test('sidebar: 未装 better-sidebar 时静默跳过，不影响 slots 看板', async () => {
  const { Component, log, ctxLog } = harness({}, {}, { fetchReply: { available: true } });
  assert.deepEqual(ctxLog.injected, ['betterSidebar'], '会去等这个服务');
  await mount(Component);
  assert.equal(boardRegistrations(log).length, 1, 'slots 那道仍然要注册');
});

test('sidebar: 装了就把看板 tab 注册到侧边栏，且是单实例', async () => {
  const sidebar = makeBetterSidebar();
  const { Component, log } = harness({}, { betterSidebar: sidebar.service }, { fetchReply: { available: true } });
  await mount(Component);

  assert.equal(sidebar.log.registered.length, 1, '侧边栏也要注册一枚');
  const tab = sidebar.log.registered[0];
  assert.equal(tab.id, 'agent-notes-board');
  assert.equal(tab.single, true, '重复打开应聚焦已有 tab，而不是开一堆');
  assert.equal(tab.order, 60);
  assert.equal(tab.title(), '笔记');
  assert.equal(typeof tab.component, 'function');
  assert.equal(boardRegistrations(log).length, 1, '两个宿主各自独立');
});

test('sidebar: 组件必须把宿主 props 原样转交下去', async () => {
  /* 踩过的真坑：写成零参 `function () { … }` 会把 props 整个丢掉，
     表现为侧边栏 iframe 拼出 `?session=` 空串 → 路由回 409 → 一片空白。 */
  const sidebar = makeBetterSidebar();
  const { Component, react } = harness({}, { betterSidebar: sidebar.service }, { fetchReply: { available: true } });
  await mount(Component);

  const tab = sidebar.log.registered[0];
  const props = { scope: { sessionId: 's-42', cwd: '/repo' }, ctx: {}, visible: true };
  tab.component(props);

  const frame = react.created.filter((el) => el.type === 'iframe').pop();
  assert.ok(frame !== undefined, '看板组件必须真的渲染出 iframe');
  assert.match(frame.props.src, /session=s-42/,
    'props 没转交下去的话这里会是空 session —— 正是 409 的成因');
  assert.match(frame.props.src, /cwd=%2Frepo/, '会话目录也要带上去');
});

test('sidebar: iframe 地址保留页面基址的挂载前缀', async () => {
  for (const baseURI of ['https://example.test/', 'https://example.test/dsh/', 'https://example.test/nested/dsh/']) {
    const sidebar = makeBetterSidebar();
    const { Component, react } = harness({}, { betterSidebar: sidebar.service }, { baseURI, fetchReply: { available: true } });
    await mount(Component);
    const tab = sidebar.log.registered[0];
    assert.ok(tab, '必须先通过真实注册路径取得看板');
    tab.component({ scope: { sessionId: 's /?&中', cwd: '/repo with spaces/中文' }, ctx: {}, visible: true });
    const frame = react.created.filter((el) => el.type === 'iframe').pop();
    assert.ok(frame, '必须实际渲染 iframe');
    const actual = new URL(frame.props.src, baseURI);
    const expected = new URL('agent-notes/ui', baseURI);
    assert.equal(actual.origin, expected.origin, 'iframe 必须保持同源');
    assert.equal(actual.pathname, expected.pathname, `挂载前缀不得丢失：${baseURI}`);
    assert.equal(actual.searchParams.get('session'), 's /?&中', '会话参数必须完整编码并可还原');
    assert.equal(actual.searchParams.get('cwd'), '/repo with spaces/中文', '目录参数必须完整编码并可还原');
    assert.deepEqual([...actual.searchParams.keys()], ['session', 'cwd'], '参数内容不得注入额外查询项');
  }
});

test('sidebar: 服务端说不可用时不注册侧边栏 tab', async () => {
  const sidebar = makeBetterSidebar();
  const { Component } = harness({}, { betterSidebar: sidebar.service }, { fetchReply: { available: false } });
  await mount(Component);
  assert.deepEqual(sidebar.log.registered, [], '不可用时侧边栏也不该出现看板');
});

/* ── 座位生命周期 ──────────────────────────────────────────────────── */

test('座位: view 座位清理时注销看板 tab 并复位注册表', async () => {
  /* HMR / 会话切换会让座位重挂；不复位的话旧 disposer 会在新会话里
     关掉别人的 tab，或者 register 还指着已经失效的 slots。 */
  const { Component, log } = harness({}, {}, { fetchReply: { available: true } });
  await mount(Component);
  assert.equal(boardRegistrations(log).length, 1, '先要真的注册上');

  const cleanup = log.injectReturn['conversation.view'];
  assert.equal(typeof cleanup, 'function', 'view 座位必须返回清理函数');
  cleanup();

  assert.deepEqual(log.disposed, ['conversation.view:agent-notes-board'],
    '座位销毁时要注销看板 tab');
});

test('座位: dispose 抛错时被吞掉，座位清理仍然完成', async () => {
  /* 注销也可能抛错（宿主内部状态已变、tab 已被别人移除等）。
     不吞的话异常会冒进 React 渲染，把界面整片打白。 */
  const { Component, log } = harness({ throwOnDisposeFor: 'conversation.view' }, {}, { fetchReply: { available: true } });
  await mount(Component);
  assert.equal(boardRegistrations(log).length, 1, '先要真的注册上');

  const cleanup = log.injectReturn['conversation.view'];
  assert.doesNotThrow(() => cleanup(), 'dispose 抛错必须被吞掉');
  assert.deepEqual(log.disposed, ['conversation.view:agent-notes-board'], '确实尝试过注销');
});

/* ── 契约漂移 ──────────────────────────────────────────────────────── */

test('契约: 客户端问的状态端点与 lib/board-route.js 的前缀一致', () => {
  /* 客户端写的是相对地址 `agent-notes/status`（为了保留挂载前缀），
     服务端挂在 `${ROUTE_PREFIX}/status`。两边各写一份字面量就必须有门禁盯着，
     否则改了一边只会表现为「看板永远不出现」，而没有任何报错。 */
  const source = readFileSync(SRC, 'utf8');
  const match = /var STATUS_ENDPOINT = '([^']+)'/.exec(source);
  assert.ok(match !== null, '源码里必须有 STATUS_ENDPOINT');

  const route = readFileSync(BOARD_ROUTE, 'utf8');
  const prefix = /export const ROUTE_PREFIX = '([^']+)'/.exec(route);
  assert.ok(prefix !== null, 'board-route.js 里必须有 ROUTE_PREFIX');
  assert.equal(`/${match[1]}`, `${prefix[1]}/status`,
    `客户端端点（${match[1]}）必须等于路由前缀 + /status`);

  assert.match(route, new RegExp(`ROUTE_PREFIX\\}/status`), '路由必须真的处理这个端点');
});

test('契约: 客户端不再通过会话命令写状态，也不再读投影', () => {
  /* 开关删除后，客户端不该偷偷保留「命令通道」这条写入路径 ——
     它会让「界面没有按钮，但某处还能改状态」变成事实。
     也不该再读投影：看板判据已换成磁盘事实。 */
  const source = readFileSync(SRC, 'utf8');
  assert.doesNotMatch(source, /bindingOf|\.command\(/, '客户端不得执行会话命令');
  assert.doesNotMatch(source, /useProjection/, '客户端不得依赖会话投影');
});

test('契约: DEBUG 默认关闭，只在 anDebug=1 时打开', () => {
  const source = readFileSync(SRC, 'utf8');
  assert.match(source, /var DEBUG = false;/, '默认值必须是 false');
  assert.match(source, /indexOf\('anDebug=1'\) !== -1/, '只在 URL 带 anDebug=1 时打开');

  const on = loadClient({ search: '?anDebug=1' });
  assert.equal(typeof on.client.apply, 'function', 'debug 模式下也要能正常加载');
});
