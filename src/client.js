/**
 * dsh-agent-notes 浏览器半边：composer 工具行里的「笔记规范」开关。
 *
 * 位置：`conversation.input.left` —— 输入框工具行左侧，紧挨着
 *       「完全权限」（`conversation.input.permission`）那一排。
 *
 * 数据链路（全部走官方通道，不自造）：
 *   读：props.useProjection('agentNotes')  ← 宿主投影，来自会话日志里的
 *                                          command/run 事件（宿主自己写的）
 *   写：sessions.binding(id).session.command('/agent-notes on|off')
 *
 * 因此本组件**不持有状态**：显示值完全由日志推出，刷新、重连、切换会话
 * 都自动正确，多标签页也不会漂移。
 *
 * 信封约束：bundle 必须自己调 window.__ModuleLoader__.load({id, factory})，
 * id 与包名一致；一切副作用都在 factory 闭包内，首次 require 时才执行。
 * 这是由 build.mjs 生成的，源码里写成 createAgentNotesClient(require) 便于包。
 */

function createAgentNotesClient(require) {
  'use strict';

  var React = require('react');
  var h = React.createElement;

  var NS = 'agent-notes';
  /* 与 lib/projection.js 的 PROJECTION_KEY 必须一致。 */
  var PROJECTION_KEY = 'agentNotes';
  var COMMAND = '/agent-notes';

  /**
   * 诊断模式：URL 带 `?anDebug=1` 时，两个组件把内部状态画到 DOM 上。
   *
   * 真机排查必需品，不是遗留物：浏览器里下不了断点，而这里到处是 try/catch
   * 降级（为了不让插件炸掉宿主 UI），异常会被静默吞掉 —— 没有这个开关就只能
   * 靠猜。实测靠它定位了三个真缺陷（sessions 服务缓存过早、槽位被 hideChrome
   * 隐藏、投影键漂移）。默认关闭，正常使用完全无感。
   */
  var DEBUG = false;
  try {
    if (typeof location !== 'undefined' && String(location.search || '').indexOf('anDebug=1') !== -1) DEBUG = true;
  } catch (e) { /* 非浏览器：保持关闭 */ }

  /* 文案：中英各一份，跟随宿主 locale 能力；取不到时回退中文。 */
  var COPY = {
    zh: {
      on: '笔记规范',
      onTip: '本会话已启用决策笔记规范（点击关闭）',
      offTip: '本会话未启用决策笔记规范（点击开启）',
      unknownTip: '笔记规范状态未知（点击开启）',
      busy: '切换中…',
      failed: '切换失败',
      tag: '笔记规范',
      tagSession: '本会话',
      tagGlobal: '全局',
      tagSessionTip: '本会话已启用决策笔记规范；写入决策笔记前会跑真门禁。',
      tagGlobalTip: '笔记规范由全局默认启用（本会话未单独设置）。'
    },
    en: {
      on: 'Agent notes',
      onTip: 'Decision-note policy is on for this session (click to turn off)',
      offTip: 'Decision-note policy is off for this session (click to turn on)',
      unknownTip: 'Decision-note policy state is unknown (click to turn on)',
      busy: 'Switching…',
      failed: 'Switch failed',
      tag: 'Agent notes',
      tagSession: 'this session',
      tagGlobal: 'global',
      tagSessionTip: 'The decision-note policy is on for this session; real gates run before a note is written.',
      tagGlobalTip: 'The decision-note policy is on by global default (not set for this session).'
    }
  };

  /** 当前语言文案；locale 能力缺失时用中文。 */
  function copy(key) {
    var table = COPY.zh;
    try {
      if (typeof document !== 'undefined' && String(document.documentElement.lang || '').toLowerCase().indexOf('en') === 0) {
        table = COPY.en;
      }
    } catch (e) { /* 非浏览器环境：用中文 */ }
    return table[key] !== undefined ? table[key] : COPY.zh[key];
  }

  /* ── 样式：只注入一次；颜色全用宿主 CSS 变量，跟随主题 ───────────────── */
  var STYLE_ID = 'agent-notes-style';
  function injectStyle() {
    try {
      if (typeof document === 'undefined') return;
      if (document.getElementById(STYLE_ID) !== null) return;
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = [
        '.an-switch{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;',
        'border:1px solid var(--dsw-alias-border-secondary,#e5e7eb);border-radius:999px;',
        'background:transparent;color:var(--dsw-alias-text-secondary,#6b7280);',
        'font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;',
        'transition:border-color .15s,color .15s,background .15s;}',
        '.an-switch:hover{border-color:var(--dsw-alias-border-primary,#d1d5db);color:var(--dsw-alias-text-primary,#111827);}',
        '.an-switch:focus-visible{outline:2px solid var(--dsw-alias-focus-ring,#4d6bfe);outline-offset:1px;}',
        '.an-switch[data-busy="1"]{opacity:.6;cursor:progress;}',
        /* 开：用品牌蓝；关：沿用次要色。色变量取不到时给明确兜底色。 */
        '.an-switch[data-on="1"]{border-color:var(--dsw-alias-state-success-primary,#10b981);',
        'color:var(--dsw-alias-state-success-primary,#10b981);}',
        '.an-switch[data-on="1"] .an-dot{background:var(--dsw-alias-state-success-primary,#10b981);}',
        '.an-switch[data-on="0"] .an-dot{background:var(--dsw-alias-text-tertiary,#9ca3af);}',
        '.an-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;}',
        /* 对话头部状态 tag：只在开启时渲染，绿点 + 范围标注。 */
        '.an-tag{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;',
        'border:1px solid var(--dsw-alias-state-success-primary,#10b981);border-radius:999px;',
        'color:var(--dsw-alias-state-success-primary,#10b981);font-size:11px;line-height:1;',
        'white-space:nowrap;}',
        '.an-tag-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:0 0 auto;}',
        '.an-tag-scope{opacity:.75;font-size:10px;}'
      ].join('');
      document.head.appendChild(style);
    } catch (e) { /* 样式失败不影响功能 */ }
  }

  /* ── 组件 ──────────────────────────────────────────────────────────── */
  /**
   * 开关按钮。
   *
   * @param {object} props 槽位 props + 座位注入面。
   * @returns {object | null} 元素或 null（能力缺失时不渲染）。
   */
  function AgentNotesSwitch(props) {
    injectStyle();
    var bindingOf = props.bindingOf;
    var useState = React.useState;
    var busyState = useState(false);
    var busy = busyState[0];
    var setBusy = busyState[1];
    var failState = useState(null);
    var failed = failState[0];
    var setFailed = failState[1];

    /* 投影：本会话是否启用。用 try 包住——能力缺失时不能崩掉整个输入框。 */
    var projection = null;
    try {
      if (typeof props.useProjection === 'function') {
        projection = props.useProjection(PROJECTION_KEY);
      }
    } catch (e) { projection = null; }

    var sessionId = props.sessionId;
    var enabled = projection !== null && projection !== undefined && typeof projection.enabled === 'boolean'
      ? projection.enabled
      : null;

    /**
     * 切换：直接走官方命令通道。
     *
     * 不自己写日志 —— 宿主在命令前后自动 append command/run 与 command/done，
     * 投影折叠它，useProjection 再把新值推回来。这就是「不持有状态」的由来。
     *
     * @param {MouseEvent} event 点击事件。
     */
    function toggle(event) {
      event.preventDefault();
      if (busy) return;
      /* 未知视为「关」，点一下就变成明确的开——比拒绝操作更符合直觉。 */
      var next = enabled === true ? 'off' : 'on';
      if (typeof bindingOf !== 'function') { setFailed(copy('failed')); return; }
      var face = bindingOf(sessionId);
      if (face === null || face === undefined || typeof face.command !== 'function') {
        setFailed(copy('failed'));
        return;
      }
      setBusy(true);
      setFailed(null);
      Promise.resolve(face.command(COMMAND + ' ' + next))
        .then(function (result) {
          if (result === null || result === undefined || result.ok !== true) {
            setFailed(copy('failed'));
          } else if (result.value && result.value.matched === false) {
            setFailed(copy('failed'));
          }
        })
        .catch(function () { setFailed(copy('failed')); })
        .then(function () { setBusy(false); });
    }

    var tip = busy
      ? copy('busy')
      : failed !== null
        ? copy('failed')
        : enabled === true ? copy('onTip') : enabled === false ? copy('offTip') : copy('unknownTip');

    /* 诊断模式：把开关读到的投影值也画出来，便于判断「投影是否可达」。 */
    var label = DEBUG
      ? 'proj=' + (projection === null ? 'null' : JSON.stringify(projection))
      : copy('on');

    return h('button', {
      type: 'button',
      className: 'an-switch',
      'data-on': enabled === true ? '1' : '0',
      'data-busy': busy ? '1' : '0',
      title: tip,
      'aria-label': tip,
      'aria-pressed': enabled === true ? 'true' : 'false',
      onMouseDown: function (e) { e.preventDefault(); },
      onClick: toggle
    },
      h('span', { className: 'an-dot', 'aria-hidden': 'true' }),
      h('span', null, label)
    );
  }

  /* ── 对话头部状态 tag ──────────────────────────────────────────────── */
  /**
   * 对话头部右侧的状态 tag：一眼看到本会话是否启用了笔记规范。
   *
   * 关着时**不渲染**任何东西，不给头部添噪声；开着时显示一枚小标记。
   *
   * @param {object} props 槽位 props + 注入面。
   * @returns {object | null} 元素或 null。
   */
  function AgentNotesTag(props) {
    injectStyle();
    var projection = null;
    try {
      if (typeof props.useProjection === 'function') projection = props.useProjection(PROJECTION_KEY);
    } catch (e) { projection = null; }

    /* 诊断开关：URL 带 ?anDebug=1 时把内部状态画到 DOM 上。
       真机排查用（浏览器里下不了断点），默认关闭，不污染正常 UI。
       注意：本槽位被 DSH 包在 `!hideChrome` 里，而 hideChrome 在**空会话**
       时为 true —— 所以会话还没内容时这里根本不会被调用，属正常设计。 */
    if (DEBUG) {
      return h('span', { className: 'an-tag', 'data-debug': '1' },
        'proj=' + (projection === null ? 'null' : JSON.stringify(projection)) +
        ' hook=' + (typeof props.useProjection) +
        ' keys=' + Object.keys(props).join(','));
    }

    if (projection === null || projection === undefined) return null;
    /* 只认明确开启；未知不冒充「已生效」。 */
    if (projection.enabled !== true) return null;

    var scope = projection.session === true ? copy('tagSession') : copy('tagGlobal');
    var tip = projection.session === true ? copy('tagSessionTip') : copy('tagGlobalTip');
    return h('span', {
      className: 'an-tag',
      'data-scope': projection.session === true ? 'session' : 'global',
      title: tip,
      role: 'status'
    },
      h('span', { className: 'an-tag-dot', 'aria-hidden': 'true' }),
      h('span', null, copy('tag')),
      h('span', { className: 'an-tag-scope' }, scope)
    );
  }

  /* ── 插件生命周期 ──────────────────────────────────────────────────── */
  /**
   * 安全取服务。
   *
   * 客户端也跑在 Cordis 上，**未声明的属性访问会直接抛**
   * （宿主侧实测 "cannot get property ... without inject"），所以不能写
   * `ctx.slots === undefined` 这种判断 —— 它本身就是那个会抛的操作。
   *
   * @param {object} ctx 客户端根上下文。
   * @param {string} name 服务名。
   * @returns {any} 服务实例或 undefined。
   */
  function service(ctx, name) {
    try {
      if (ctx === null || ctx === undefined) return undefined;
      if (typeof ctx.get === 'function') return ctx.get(name);
    } catch (e) { /* 未 provide：按缺失处理 */ }
    return undefined;
  }

  function apply(ctx) {
    var slots = service(ctx, 'slots');
    if (slots === undefined || typeof slots.register !== 'function') return;

    /**
     * 会话面查找：把 sessionId 映射成可执行命令的 SessionFace。
     *
     * **必须在点击时惰性解析，不能在 apply 时缓存**：apply 跑的那一刻
     * sessions 服务往往还没就绪，缓存下来就永久是 undefined，于是按钮点了
     * 只会显示「切换失败」—— 实测踩过这个坑（真机点一下就复现）。
     * 每次点击现取，服务晚到也能正常工作。
     *
     * @param {string} sessionId 会话 id。
     * @returns {any} SessionFace 或 null。
     */
    function bindingOf(sessionId) {
      try {
        var sessions = service(ctx, 'sessions');
        if (sessions === undefined || typeof sessions.binding !== 'function') return null;
        var binding = sessions.binding(sessionId);
        return binding !== undefined && binding !== null ? binding.session : null;
      } catch (e) { return null; }
    }

    /* slots.inject 会等座位声明就绪（哪怕声明者此刻还没加载），
       所以不能「先探测再注册」——那等于永不注册。与 dsh-turn-stats 同法。 */
    try {
      slots.inject('conversation.input.left', function () {
        return slots.register({
          name: 'conversation.input.left',
          id: NS,
          /* 排在权限/计划之后、靠左的一侧；官方左侧条目用正序。 */
          order: 40,
          inject: function () {
            return { bindingOf: bindingOf };
          }
        }, AgentNotesSwitch);
      });
    } catch (e) { /* 座位注册失败不得炸掉整个客户端 */ }

    /* 生效 tag：放在 **输入框上方** 的 dock 里。
       为什么不用 conversation.session.header.utilities：那个槽位被 DSH 包在
       `!hideChrome` 里，而 hideChrome 在**空会话**时为 true —— 新会话（正是
       最需要看状态的时候）根本不会渲染它。实测确认后改到这里：
       ConversationContent 把 input.dock 渲染在 {inputBar} 之前，即输入框上方，
       且不依赖 hideChrome。
       该槽位是 list 类型，IG5 也在用（它注册的是 input.dock），list 允许多条目
       共存，不会互相顶掉。 */
    try {
      slots.inject('conversation.input.dock', function () {
        return slots.register({
          name: 'conversation.input.dock',
          id: NS,
          /* 排在 IG5 徽标（order 31）之后，视觉上靠右一些。 */
          order: 40
        }, AgentNotesTag);
      });
    } catch (e) { /* 同上 */ }
  }

  return { name: NS, inject: ['slots'], apply: apply };
}
