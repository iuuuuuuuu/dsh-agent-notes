/**
 * 看板抽屉的 Markdown 表格补丁：把 GFM 管道表格渲染成真 `<table>`。
 *
 * ## 缺口（读代码 + 实测复现）
 *
 * 上游看板的正文渲染是 `skills/agent-notes/assets/agent-notes-board.html:891`
 * 的 `parseMarkdown()`。它只做五件事：转义、围栏代码块、行内 code、`**bold**`、
 * 相对链接，然后把剩下的按空行切段、段内换行变 `<br>`。
 *
 * **它没有表格分支。** 所以笔记正文里的管道表格会原样变成一段文字：
 *
 *     | 场景 | is_decode | is_timeout |
 *     |---|---|---|
 *     | A 读超时 | true | true |
 *
 * 渲染出来是 `<p>| 场景 | is_decode ...<br>|---|---|<br>...</p>` —— 表格语法全废，
 * 只剩一堆竖线。抽屉里显示的正是 problem/decision/alternatives/consequences
 * 四段正文（`agent-notes-board.html:1409-1412`），所以任何写了表格的笔记都会
 * 这样退化。决策笔记里表格极常见（对照表、判据表），这不是边角情况。
 *
 * ## 为什么不改上游 HTML
 *
 * `skills/agent-notes/assets/agent-notes-board.html` 是 vendored 资产，
 * AGENTS.md 硬约束 3 禁止手改（`tools/verify-plugin.mjs` 用清单哈希比对会拦下）。
 * 所以只能落在宿主这一侧：服务端吐页面时追加一段脚本 —— 与
 * `lib/board-responsive.js` 的 `DRAWER_PATCH_JS` / `ARCHIVED_CARD_JS` 同一机制。
 *
 * ## 为什么能覆盖到上游的函数
 *
 * 上游那段脚本是**经典脚本**（`<script>`，不是 module），`function parseMarkdown`
 * 是函数声明 → 它成为全局对象上的**可写属性**，所以后注入的脚本可以
 * `window.parseMarkdown = ...` 接管，而上游自己的调用点写的是裸标识符
 * `parseMarkdown(n.problem)`，走全局对象查找 → 拿到覆盖后的版本。
 *
 * 对照：`const Core = {...}` 这类 `const`/`let` 在顶层只建**脚本作用域绑定**，
 * 不是全局属性，注入脚本触达不到（`ARCHIVED_CARD_JS` 的注释记的正是这条）。
 * 表格补丁能成立，仅仅因为它挂的是函数声明。
 *
 * ## 为什么复用上游函数而不是重写整套行内规则
 *
 * 单元格里的行内标记（`` `code` ``、`**bold**`）必须与正文其余部分**同款**：
 * 转义规则、链接的 `md-deep-link` 类、危险协议过滤都在上游函数里。重写一份
 * 就等于复制一遍规则，两边迟早漂移。
 *
 * 所以补丁只做「切块」：把正文按表格边界切开，表格自己拼 HTML，**其余文本
 * 原封不动交回上游** `original(chunk)`；单元格的行内格式也是先调上游、再把
 * 它包的外层 `<p style="margin-bottom:10px;">…</p>` 剥掉。
 *
 * 边界（重要）：
 *   - 只处理 GFM 管道表格；标题、有序列表、引用等仍走上游原逻辑（未补）；
 *   - 单元格数量不一致时按表头列数截断/补空，不抛错（脏数据不能让整个抽屉白屏）；
 *   - 上游若把 `parseMarkdown` 改名或改成 module，补丁**安静退出**（不接管、
 *     不报错），坏的是表格，不是整个看板。
 */

/** 补丁脚本块的 id，便于排查时确认这段真的注入了。 */
export const MARKDOWN_TABLE_PATCH_ID = 'agent-notes-markdown-table-patch';

/**
 * 运行时补丁源码。
 *
 * 写法约束（模板字符串里）：所有反斜杠都要双写 —— `split('\\n')` 才会在
 * 生成的脚本里变成 `split('\n')`。字符码判断（`92` = `\`）是刻意避开转义的。
 */
export const MARKDOWN_TABLE_JS = `
(function () {
  /* 幂等：同一页面注两次只装一次（注入函数也有守卫，这里是第二道）。 */
  if (window.__agentNotesMarkdownTables === true) return;
  /* 上游改名/改成 module 就安静退出：宁可表格不渲染，也不要抛错白屏。 */
  if (typeof window.parseMarkdown !== 'function') return;
  var original = window.parseMarkdown;

  var P_START = '<p style="margin-bottom:10px;">';

  /* 单元格的行内格式：交给上游渲染，再剥掉它包的那层段落标签。
     这样 code/bold/链接规则与正文完全同款，不存在第二份实现。 */
  function inline(text) {
    var html = original(text);
    if (html.slice(0, P_START.length) === P_START) html = html.slice(P_START.length);
    if (html.slice(-4) === '</p>') html = html.slice(0, -4);
    return html;
  }

  /* 按未转义的 | 切单元格。\\| 是 GFM 的转义竖线，必须留在同一个单元格里。
     手写扫描而不是正则：lookbehind 在老 Safari 上不可用。 */
  function splitCells(line) {
    var out = [];
    var cur = '';
    for (var i = 0; i < line.length; i += 1) {
      var ch = line.charAt(i);
      if (ch.charCodeAt(0) === 92) {
        var next = line.charAt(i + 1);
        if (next === '|') { cur += '|'; i += 1; continue; }
        cur += ch;
        continue;
      }
      if (ch === '|') { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    /* 表格两端的收尾竖线会切出空单元，去掉它们（中间的保留）。 */
    if (out.length > 0 && out[0].trim() === '') out.shift();
    if (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
    return out;
  }

  function isTableRow(line) {
    return line.trim() !== '' && line.indexOf('|') !== -1;
  }

  /* 分隔行：每格都是 ---、:--、--:、:-: 之一。 */
  function isDelimiterRow(line) {
    var cells = splitCells(line);
    if (cells.length === 0) return false;
    for (var i = 0; i < cells.length; i += 1) {
      if (!/^:?-+:?$/.test(cells[i].trim())) return false;
    }
    return true;
  }

  function alignsOf(line) {
    return splitCells(line).map(function (cell) {
      var t = cell.trim();
      var left = t.charAt(0) === ':';
      var right = t.charAt(t.length - 1) === ':';
      if (left && right) return 'center';
      if (right) return 'right';
      if (left) return 'left';
      return '';
    });
  }

  var TD_STYLE = 'padding:6px 10px;border-bottom:1px solid rgba(148,163,184,.35);vertical-align:top;';
  var TH_STYLE = 'padding:6px 10px;border-bottom:2px solid rgba(148,163,184,.55);font-weight:600;white-space:nowrap;';

  function tableHtml(head, aligns, body) {
    var th = '';
    for (var c = 0; c < head.length; c += 1) {
      var align = aligns[c] || '';
      th += '<th style="' + TH_STYLE + (align ? 'text-align:' + align + ';' : '') + '">'
        + inline(head[c].trim()) + '</th>';
    }
    var rows = '';
    for (var r = 0; r < body.length; r += 1) {
      var tds = '';
      /* 按表头列数对齐：多截断、少补空，脏数据不许让渲染抛错。 */
      for (var k = 0; k < head.length; k += 1) {
        var a = aligns[k] || '';
        var cell = body[r][k] === undefined ? '' : body[r][k];
        tds += '<td style="' + TD_STYLE + (a ? 'text-align:' + a + ';' : '') + '">'
          + inline(cell.trim()) + '</td>';
      }
      rows += '<tr>' + tds + '</tr>';
    }
    return '<div class="md-table-wrap" style="overflow-x:auto;margin:0 0 12px;">'
      + '<table class="md-table" style="border-collapse:collapse;width:100%;font-size:12.5px;">'
      + '<thead><tr>' + th + '</tr></thead>'
      + (rows === '' ? '' : '<tbody>' + rows + '</tbody>')
      + '</table></div>';
  }

  function transform(text) {
    var lines = String(text).split('\\n');
    var out = [];
    var buf = [];
    var inFence = false;

    function flush() {
      if (buf.length === 0) return;
      /* 非表格部分原封不动交回上游 —— 段落/换行/列表行为完全不变。 */
      out.push(original(buf.join('\\n')));
      buf = [];
    }

    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      var trimmed = line.trim();

      /* 围栏代码块内部一律不识别表格：代码里的竖线是代码，不是表格。 */
      if (trimmed.slice(0, 3) === '\u0060\u0060\u0060') {
        inFence = !inFence;
        buf.push(line);
        continue;
      }
      if (inFence) { buf.push(line); continue; }

      var next = i + 1 < lines.length ? lines[i + 1] : '';
      if (isTableRow(line) && isDelimiterRow(next)
        && splitCells(line).length === splitCells(next).length) {
        flush();
        var body = [];
        var j = i + 2;
        while (j < lines.length && isTableRow(lines[j])) {
          body.push(splitCells(lines[j]));
          j += 1;
        }
        out.push(tableHtml(splitCells(line), alignsOf(next), body));
        i = j - 1;
        continue;
      }
      buf.push(line);
    }
    flush();
    return out.join('');
  }

  window.parseMarkdown = function (text) {
    /* 没有竖线就一定没有表格：直接还给上游，零额外开销。 */
    if (typeof text !== 'string' || text.indexOf('|') === -1) return original(text);
    return transform(text);
  };
  window.__agentNotesMarkdownTables = true;
})();
`;

/**
 * 往看板 HTML 里注入表格补丁。
 *
 * @param {string} html 服务端准备返回的页面。
 * @returns {string} 注入后的页面；不能注入时原样返回（不可渲染 ≠ 白屏）。
 */
export function injectMarkdownTables(html) {
  if (typeof html !== 'string' || html === '') return html;
  /* 必须匹配完整标签而不是裸 id：笔记正文里可能原样写着这个 id（本仓库的
     决策笔记就会写），只找 id 会把「数据里提过」误判成「已经注入过」。 */
  if (html.indexOf(`<script id="${MARKDOWN_TABLE_PATCH_ID}">`) !== -1) return html;
  const at = html.lastIndexOf('</body>');
  if (at === -1) return html;
  const script = `<script id="${MARKDOWN_TABLE_PATCH_ID}">${MARKDOWN_TABLE_JS}</script>\n`;
  return `${html.slice(0, at)}${script}${html.slice(at)}`;
}
