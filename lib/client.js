window.__ModuleLoader__.load({id:"dsh-agent-notes",factory:function(require){
"use strict";
var __dshAgentNotes = (function(){
'use strict';

  var React = require('react');
  var h = React.createElement;

  var NS = 'agent-notes';

  /**
   * 看板 tab 的注册表：由 apply 填充，由常驻的开关组件驱动。
   *
   * 为什么要这层间接：宿主对 `conversation.view` 只读 id/label，没有条件
   * 隐藏机制；而 apply 阶段还没有任何会话，读不到投影。开关组件挂在输入框
   * 里、每个会话都在、且已经订阅同一个投影，因此由它当信使最自然。
   */
  /**
   * 看板 tab 的注册状态，**每个宿主一份**。
   *
   * 目前有两个宿主：
   *   - `slots`：DSH 内置的 `conversation.view`（对话/轨迹 旁边的 tab）
   *   - `sidebar`：dsh-better-sidebar 的右侧栏（第三方插件提供的 ctx.betterSidebar）
   *
   * 为什么分成多份：两个宿主的可用性彼此独立 —— 装了 better-sidebar 没有
   * 不代表 slots 不可用，反之亦然。用一份状态记账会让「一个注册成功、
   * 另一个还没就绪」互相覆盖，表现为 tab 时有时无。
   *
   * `register` 为 null 表示该宿主还没就绪；此时只记 enabled，等它就绪时
   * 自己按状态补注册（见各自的 ready 逻辑）。
   *
   * @type {Record<string, { register: null | (() => void), dispose: null | (() => void), enabled: boolean | null }>}
   */
  var hosts = {
    slots: { register: null, dispose: null, enabled: null },
    sidebar: { register: null, dispose: null, enabled: null }
  };

  /**
   * 按开关状态增删某个宿主的看板 tab。
   *
   * @param {string} name 宿主名（`slots` / `sidebar`）。
   * @param {boolean} enabled 本会话是否启用笔记规范。
   */
  function syncHost(name, enabled) {
    var host = hosts[name];
    if (host === undefined) return;
    if (host.register === null) {
      /* 宿主未就绪：先记住意图，等它 ready 时自己补。 */
      host.enabled = enabled;
      return;
    }
    if (host.enabled === enabled) return;
    host.enabled = enabled;
    if (enabled) {
      if (host.dispose === null) {
        try { host.dispose = host.register(); } catch (e) { /* 注册失败不得影响开关 */ }
      }
    } else if (host.dispose !== null) {
      try { host.dispose(); } catch (e) { /* 注销失败不得影响开关本身 */ }
      host.dispose = null;
    }
  }

  /**
   * 所有宿主一起按开关状态对齐。
   *
   * @param {boolean} enabled 本会话是否启用笔记规范。
   */
  function syncBoardTab(enabled) {
    syncHost('slots', enabled);
    syncHost('sidebar', enabled);
  }

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

        /* 笔记看板：整块交给官方 HTML。
           高度用 flex 链而不是 height:100% —— 宿主给 .viewArea 的高度来自
           flex 分配（flex:1 1 0 / min-height:0），百分比高度在这种容器里
           解析不出确定值，会让 iframe 退回 300x150 的默认尺寸。 */
        '.an-board{display:flex;flex-direction:column;flex:1 1 0;min-height:0;',
        'width:100%;overflow:hidden;position:relative;}',
        '.an-board-frame{flex:1 1 0;width:100%;min-height:0;border:0;display:block;',
        'background:var(--dsw-alias-bg-surface,#fff);}',
        '.an-board-empty{position:absolute;inset:0;display:flex;align-items:center;',
        'justify-content:center;font-size:13px;opacity:.7;padding:24px;text-align:center;}'
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

    /* 开关状态同时驱动「笔记」tab 的出现/消失。
       宿主对 conversation.view 只读 id/label、没有条件隐藏机制，而 apply
       阶段还拿不到会话投影（那时没有会话），所以只能由这枚常驻在输入框里的
       组件当信使：它每会话都在，且本来就订阅着同一个投影。
       未拿到投影（enabled === null）时按「关」处理，与插件默认关闭一致。 */
    React.useEffect(function () {
      syncBoardTab(enabled === true);
    }, [enabled]);

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
   * **不自绘 UI**：直接 iframe 加载官方成品看板
   * （`skills/agent-notes/assets/agent-notes-board.html`，vendored 上游资产），
   * 宿主侧把实时数据注入它预留的 `window.__INLINE_DATA__` 插槽。
   *
   * 为什么这样做：官方看板是 76K 的成熟 UI（多维筛选、因果链路、看板视图），
   * 自己重画一套只会更丑、且必然与上游越走越远。走 iframe 后视觉与交互
   * 完全跟随上游更新，本插件只负责「把当前仓库的数据喂进去」。
   */
  function AgentNotesBoard(props) {
    injectStyle();
    var useState = React.useState;
    var frameState = useState('loading');
    var phase = frameState[0];
    var setPhase = frameState[1];

    /* 两个宿主传的会话信息形状不同，必须都认：
       - conversation.view（DSH 内置槽位）：顶层 `sessionId`
       - dsh-better-sidebar 的 TabComponentProps：`scope.sessionId`
       只认前者的话，侧边栏里的 iframe 会拼出 `?session=`（空串），
       路由按设计回 409，表现为一片空白 —— 这类「换宿主就空白」的坑
       不能靠肉眼发现，所以两种来源都取，取不到才留空。 */
    var sessionId = props.sessionId;
    if (sessionId === undefined || sessionId === null || sessionId === '') {
      var scope = props.scope;
      if (scope !== undefined && scope !== null) sessionId = scope.sessionId;
    }
    var src = '/agent-notes/ui?session=' + encodeURIComponent(String(sessionId ?? ''));

    /* `data-conversation-composer-overlay` 是宿主认的「本视图自己占满整块」标记。
       带上它，宿主 CSS 会把 .viewArea 变成 flex:1 1 0 + min-height:0 +
       overflow:hidden（见 ConversationRoot.module.css），输入框浮在视图之上。
       不带的话 .viewArea 在 active 阶段是 flex:1 0 auto / min-height:auto ——
       高度由内容撑开，于是 iframe 的 height:100% 解析成 0，退化成 300x150
       的浏览器默认尺寸。轨迹视图用的是同一个标记。 */
    return h('div', {
      className: 'an-board',
      'data-conversation-composer-overlay': ''
    },
      phase === 'error'
        ? h('div', { className: 'an-board-empty' }, copy('boardError'))
        : null,
      h('iframe', {
        className: 'an-board-frame',
        src: src,
        title: copy('boardTitle'),
        /* 看板要跑脚本、读自己的内联数据；不放开则一片空白。
           same-origin 是必需的：它要和宿主同源才能被正确加载。 */
        sandbox: 'allow-scripts allow-same-origin',
        onLoad: function () { setPhase('ready'); },
        onError: function () { setPhase('error'); }
      })
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

    /* 看板 tab：与「轨迹」并排，**只在笔记规范开启时出现**。
       - list 类型 + session 作用域，与现有 tab 共存不冲突；
       - id 不能叫 'trajectory' —— 那是宿主内置轨迹视图的保留 id，且受
         developerTools 开关限制；换个 id 才能对所有用户可见；
       - 这里只把「怎么注册」登记进 boardTab，真正注册/注销由开关组件按
         投影状态驱动（原因见 boardTab 的注释）。 */
    try {
      slots.inject('conversation.view', function () {
        hosts.slots.register = function () {
          return slots.register({
            name: 'conversation.view',
            id: 'agent-notes-board',
            label: function () { return copy('boardTitle'); },
            order: 60
          }, AgentNotesBoard);
        };
        /* 已有关状态就先按它对齐一次（组件可能比座位先就绪）。 */
        if (hosts.slots.enabled === true && hosts.slots.dispose === null) {
          hosts.slots.dispose = hosts.slots.register();
        }
        return function () {
          if (hosts.slots.dispose !== null) {
            try { hosts.slots.dispose(); } catch (e) { /* 忽略 */ }
            hosts.slots.dispose = null;
          }
          hosts.slots.register = null;
          hosts.slots.enabled = null;
        };
      });
    } catch (e) { /* 座位注册失败不得炸掉整个客户端 */ }

    /* dsh-better-sidebar 的右侧栏：同一个看板，换一个宿主。
       该插件提供客户端服务 `ctx.betterSidebar`，用 registerTab 注册 tab 类型，
       返回的是 disposer（cordis 会在 fiber 销毁时自动调用，HMR 安全）。
       服务可能没装/没就绪 —— 用 ctx.inject 等它，拿不到就静默跳过，
       绝不让「没装这个插件」变成笔记功能不可用。 */
    try {
      ctx.inject(['betterSidebar'], function (subCtx) {
        var sidebar = subCtx.betterSidebar;
        if (sidebar === undefined || sidebar === null || typeof sidebar.registerTab !== 'function') return;
        hosts.sidebar.register = function () {
          return sidebar.registerTab({
            id: 'agent-notes-board',
            title: function () { return copy('boardTitle'); },
            description: function () { return copy('boardTitle'); },
            /* 排在文件/搜索等内置之后，不与它们抢位置。 */
            order: 60,
            /* 单实例：重复打开聚焦已有的那个，而不是开一堆。 */
            single: true,
            component: function () { return h(AgentNotesBoard, null); }
          });
        };
        /* 服务比开关先就绪时，按已记住的意图补注册。 */
        if (hosts.sidebar.enabled === true && hosts.sidebar.dispose === null) {
          hosts.sidebar.dispose = hosts.sidebar.register();
        }
        subCtx.effect(function () {
          return function () {
            if (hosts.sidebar.dispose !== null) {
              try { hosts.sidebar.dispose(); } catch (e) { /* 忽略 */ }
              hosts.sidebar.dispose = null;
            }
            hosts.sidebar.register = null;
            hosts.sidebar.enabled = null;
          };
        });
      });
    } catch (e) { /* better-sidebar 不在时不影响其它功能 */ }
  }

  return { name: NS, inject: ['slots'], apply: apply };
})();
return __dshAgentNotes;
}});
