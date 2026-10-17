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
      boardTitle: '笔记',
      boardLoading: '正在读取笔记…',
      boardError: '读不到笔记树',
      boardEmpty: '笔记树存在，但还没有笔记',
      boardNoTree: '这个仓库还没有 .agents/notes',
      boardSearch: '搜索标题 / 分类…',
      boardAll: '全部'
    },
    en: {
      on: 'Agent notes',
      onTip: 'Decision-note policy is on for this session (click to turn off)',
      offTip: 'Decision-note policy is off for this session (click to turn on)',
      unknownTip: 'Decision-note policy state is unknown (click to turn on)',
      busy: 'Switching…',
      failed: 'Switch failed',
      boardTitle: 'Notes',
      boardLoading: 'Reading notes…',
      boardError: 'Cannot read the notes tree',
      boardEmpty: 'The notes tree exists but has no notes yet',
      boardNoTree: 'This repository has no .agents/notes yet',
      boardSearch: 'Search title / class…',
      boardAll: 'All'
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

        /* 笔记看板：铺满 conversation.view 的区域，自身可滚动。 */
        '.an-board{display:flex;flex-direction:column;height:100%;min-height:0;',
        'font-size:13px;color:var(--dsw-alias-text-primary,#0f172a);}',
        '.an-board-bar{display:flex;gap:8px;align-items:center;padding:10px 14px;flex:0 0 auto;',
        'border-bottom:1px solid var(--dsw-alias-border-subtle,#e2e8f0);}',
        '.an-board-search{flex:1 1 auto;min-width:0;height:28px;padding:0 10px;border-radius:6px;',
        'border:1px solid var(--dsw-alias-border-normal,#e2e8f0);background:var(--dsw-alias-bg-surface,#fff);',
        'color:inherit;font-size:12px;outline:none;}',
        '.an-board-search:focus{border-color:var(--dsw-alias-focus-ring,#4d6bfe);}',
        '.an-board-filter{height:28px;border-radius:6px;font-size:12px;padding:0 6px;',
        'border:1px solid var(--dsw-alias-border-normal,#e2e8f0);background:var(--dsw-alias-bg-surface,#fff);',
        'color:inherit;}',
        '.an-board-count{font-size:11px;opacity:.6;flex:0 0 auto;font-variant-numeric:tabular-nums;}',
        '.an-board-list{flex:1 1 auto;overflow-y:auto;padding:6px 8px 24px;}',
        '.an-board-item{border-radius:6px;}',
        '.an-board-item[data-open="1"]{background:var(--dsw-alias-bg-surface-subtle,#f1f5f9);}',
        '.an-board-head{display:flex;gap:8px;align-items:baseline;width:100%;text-align:left;',
        'padding:7px 8px;border:0;background:transparent;cursor:pointer;color:inherit;font:inherit;}',
        '.an-board-head:hover{background:var(--dsw-alias-bg-surface-subtle,#f1f5f9);border-radius:6px;}',
        '.an-board-date{flex:0 0 auto;font-size:11px;opacity:.55;font-variant-numeric:tabular-nums;}',
        '.an-board-class{flex:0 0 auto;font-size:10px;padding:1px 6px;border-radius:999px;',
        'background:var(--dsw-alias-bg-surface-subtle,#f1f5f9);border:1px solid var(--dsw-alias-border-subtle,#e2e8f0);',
        'opacity:.85;}',
        '.an-board-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.an-board-life{flex:0 0 auto;font-size:10px;opacity:.5;}',
        '.an-board-body{margin:0;padding:10px 12px 14px;white-space:pre-wrap;word-break:break-word;',
        'font-family:ui-monospace,"SF Mono",monospace;font-size:11.5px;line-height:1.6;',
        'color:var(--dsw-alias-text-secondary,#475569);}',
        '.an-board-empty{display:flex;flex-direction:column;gap:6px;align-items:center;',
        'justify-content:center;height:100%;opacity:.7;font-size:13px;padding:24px;text-align:center;}',
        '.an-board-hint{font-size:11px;opacity:.7;word-break:break-all;font-family:ui-monospace,monospace;}'
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

  /* ── 笔记看板（conversation.view 的一个 tab）────────────────────────── */

  /**
   * 看板视图：与「轨迹」并排的一个 tab。
   *
   * 数据来源：宿主侧的只读 HTTP 路由 `/agent-notes/board`。为什么不用投影 ——
   * 投影的 view 是同步纯函数，读不到文件系统；而笔记在磁盘上、随时会被
   * 编辑器改动，必须实时读。
   *
   * 行为约定（重要）：
   *   - 拿不到数据时显示**明确原因**，绝不显示「0 篇」冒充空仓库；
   *   - 每次切到该 tab 都重新拉取，不做缓存，避免看到过期内容。
   */
  function AgentNotesBoard(props) {
    injectStyle();
    var useState = React.useState;
    var useEffect = React.useEffect;
    var stateRes = useState({ phase: 'loading' });
    var state = stateRes[0];
    var setState = stateRes[1];
    var selRes = useState(null);
    var selected = selRes[0];
    var setSelected = selRes[1];
    var queryRes = useState('');
    var query = queryRes[0];
    var setQuery = queryRes[1];
    var lifeRes = useState('all');
    var lifecycle = lifeRes[0];
    var setLifecycle = lifeRes[1];

    var sessionId = props.sessionId;

    useEffect(function () {
      var alive = true;
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      setState({ phase: 'loading' });
      var url = '/agent-notes/board?session=' + encodeURIComponent(String(sessionId ?? ''));
      fetch(url, { signal: controller ? controller.signal : undefined })
        .then(function (res) {
          return res.json().then(function (data) { return { status: res.status, data: data }; });
        })
        .then(function (payload) {
          if (!alive) return;
          if (payload.status === 200) {
            setState({ phase: 'ready', board: payload.data });
          } else {
            /* 409 = 会话没有可解析的笔记根；如实显示，不编一个空看板。 */
            setState({ phase: 'error', status: payload.status, message: payload.data?.error ?? 'unknown' });
          }
        })
        .catch(function (err) {
          if (!alive) return;
          setState({ phase: 'error', status: 0, message: String(err?.message ?? err) });
        });
      return function () { alive = false; if (controller) controller.abort(); };
    }, [sessionId]);

    if (state.phase === 'loading') {
      return h('div', { className: 'an-board' }, h('div', { className: 'an-board-empty' }, copy('boardLoading')));
    }
    if (state.phase === 'error') {
      return h('div', { className: 'an-board' },
        h('div', { className: 'an-board-empty' },
          h('div', null, copy('boardError')),
          h('div', { className: 'an-board-hint' }, state.message)));
    }

    var board = state.board ?? { notes: [], total: 0, exists: false, byLifecycle: {} };
    var notes = board.notes ?? [];

    if (!board.exists || notes.length === 0) {
      /* 明确区分「树不存在」与「树存在但没有笔记」，两者都不等于「通过」。 */
      return h('div', { className: 'an-board' },
        h('div', { className: 'an-board-empty' },
          h('div', null, board.exists ? copy('boardEmpty') : copy('boardNoTree')),
          h('div', { className: 'an-board-hint' }, board.root ?? '')));
    }

    var filtered = notes.filter(function (n) {
      if (lifecycle !== 'all' && n.lifecycle !== lifecycle) return false;
      if (query === '') return true;
      var q = query.toLowerCase();
      return (n.title + ' ' + n.slug + ' ' + n.class).toLowerCase().indexOf(q) !== -1;
    });

    var lifecycles = Object.keys(board.byLifecycle ?? {});

    return h('div', { className: 'an-board' },
      h('div', { className: 'an-board-bar' },
        h('input', {
          className: 'an-board-search',
          type: 'search',
          placeholder: copy('boardSearch'),
          value: query,
          onChange: function (e) { setQuery(e.target.value); }
        }),
        h('select', {
          className: 'an-board-filter',
          value: lifecycle,
          onChange: function (e) { setLifecycle(e.target.value); }
        },
          h('option', { value: 'all' }, copy('boardAll') + ' (' + notes.length + ')'),
          lifecycles.map(function (lc) {
            return h('option', { key: lc, value: lc }, lc + ' (' + board.byLifecycle[lc] + ')');
          })
        ),
        h('span', { className: 'an-board-count' }, filtered.length + ' / ' + notes.length)
      ),
      h('div', { className: 'an-board-list' },
        filtered.map(function (n) {
          var open = selected === n.id;
          return h('div', { key: n.id, className: 'an-board-item', 'data-open': open ? '1' : '0' },
            h('button', {
              type: 'button',
              className: 'an-board-head',
              onClick: function () { setSelected(open ? null : n.id); }
            },
              h('span', { className: 'an-board-date' }, n.date),
              h('span', { className: 'an-board-class', 'data-class': n.class }, n.class),
              h('span', { className: 'an-board-title' }, n.title.replace(/^Agent Note[:：]\s*/, '')),
              h('span', { className: 'an-board-life' }, n.lifecycle)
            ),
            open ? h('pre', { className: 'an-board-body' }, n.body) : null
          );
        })
      )
    );
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

    /* 看板 tab：与「轨迹」并排。
       - list 类型 + session 作用域，与现有 tab 共存不冲突；
       - id 不能叫 'trajectory' —— 那是宿主内置轨迹视图的保留 id，且受
         developerTools 开关限制；换个 id 才能对所有用户可见。
       - label 是 tab 上显示的名字，走 slot 的 label 解析。 */
    try {
      slots.inject('conversation.view', function () {
        return slots.register({
          name: 'conversation.view',
          id: 'agent-notes-board',
          label: function () { return copy('boardTitle'); },
          order: 60
        }, AgentNotesBoard);
      });
    } catch (e) { /* 同上 */ }
  }

  return { name: NS, inject: ['slots'], apply: apply };
}
