/**
 * 看板样式补丁的**选择器对齐**门禁。
 *
 * 为什么要这道门禁（来自一条自己写下的上限）：
 *
 *   `.agents/notes/implemented/feature/2026-10-17-board-narrow-viewport-adaptation.md`
 *   的「代价与已知上限」原文：
 *
 *     「多了一层「上游 HTML + 宿主覆盖 CSS」的耦合。覆盖样式依赖上游的类名
 *      （`.hud-topbar`、`.deck-tabs`、`.hud-grow` 等），**上游改类名时这些选择器
 *      会静默失效** —— 样式不报错，只是不再生效，退回竖排。这是这套方案最脆弱的
 *      地方。」
 *
 * 这个失效面最坏的地方不是「会坏」，而是**坏了没有任何信号**：CSS 里写错的类名
 * 不会报错、不会让任何用例变红，只是窄屏布局悄悄退回竖排。而本仓库的 `npm run sync`
 * 会把 vendored 的看板 HTML 整体换新 —— 上游改一个类名，补丁就静默失效一次。
 *
 * 判据：**我们的 CSS / `querySelector` 里出现的每一个类名，必须在 vendored HTML
 * 里真的存在**（静态 `class="…"`，或 vendored 脚本里 `className = '…'` /
 * `classList.add('…')` 动态加上去的都算）。
 *
 * 反过来，**我们自己创建**的类名不算缺（例如补丁给 KPI 行追加的 `kpi-row-5`、
 * 给卡片设的 `kpi-instrument`）：这些来自本仓库的 `className` 赋值，vendored
 * HTML 里当然没有。所以判据是「必需集合 − vendored 存在集合 − 自建集合」。
 *
 * 为什么不用「能渲染出来就算对」的渲染探针：那种探针要起浏览器、跑几十秒，
 * 而且它验的是**当前这一个视口**的效果；选择器对齐是纯文本可判定的，能在
 * `npm test` 里每次提交都跑。
 */

/**
 * 去掉 HTML 注释（`<!--` 到 `-->`）。
 *
 * 未闭合时按浏览器语义吞到文末 —— 判据必须与浏览器看到的一致，否则注释里的旧
 * 标记会被当成「元素还在」。
 *
 * @param {string} html 页面文本。
 * @returns {string} 去掉注释后的文本。
 */
export function stripHtmlComments(html) {
  const closed = html.replace(/<!--[\s\S]*?-->/g, '');
  const open = closed.indexOf('<!--');
  return open === -1 ? closed : closed.slice(0, open);
}

/** 从文本里抽出 `.foo-bar` 形式的类名（含下划线；不含 `.18s` 这类数字开头）。 */
const CLASS_TOKEN = /\.([a-zA-Z][a-zA-Z0-9_-]*)/g;

/**
 * 抽出一段代码里**选择器位置**的类名。
 *
 * 只认两类证据，避免把 JS 属性访问（`.join`、`.length`）当成类名：
 *   1. CSS 文本（模板字面量里的选择器）；
 *   2. `querySelector('…')` / `querySelectorAll('…')` 的字符串实参。
 *
 * @param {string} css CSS 文本。
 * @param {string} js 模块源码。
 * @returns {Map<string, string>} 类名 → 它出现在哪种证据里（用于报错定位）。
 */
export function collectRequiredClasses(css, js) {
  const sources = new Map();
  const add = (cls, where) => {
    if (!sources.has(cls)) sources.set(cls, new Set());
    sources.get(cls).add(where);
  };
  for (const match of css.matchAll(CLASS_TOKEN)) add(match[1], 'CSS 选择器');
  for (const arg of js.matchAll(/querySelector(?:All)?\(\s*(['"`])([^'"`]*)(['"`])/g)) {
    if (arg[1] !== arg[3]) continue;
    /* 同一个类名可能既被 CSS 选中又被 querySelector 取用：两处都记下来，
       报错时能一眼看出这条依赖有几个使用点（少记一处就少一条线索）。 */
    /* 引号三种写法都认：`querySelector('.x')` / `(".x")` / (\`.x\`)。只认单引号时，
       新写的双引号调用会整条漏掉，而总数下限照样满足 —— 静默放行。 */
    for (const match of arg[2].matchAll(CLASS_TOKEN)) add(match[1], `querySelector(${arg[1]}${arg[2]}${arg[1]})`);
  }
  const required = new Map();
  for (const [cls, wheres] of sources) required.set(cls, [...wheres].join('、'));
  return required;
}

/**
 * 抽出 vendored HTML 里**真实存在**的类名。
 *
 * 三处证据：静态 `class="…"`、`className = '…'`、`classList.add('…')`。
 * 后两者是 vendored 脚本动态创建的（例如 `radar-dot`、`status-badge`），
 * 静态属性里没有但页面上确实有。
 *
 * @param {string} html vendored 看板页面。
 * @returns {Set<string>} 存在着的类名。
 */
export function collectVendoredClasses(html) {
  const present = new Set();
  /* 注释里的标记不算存在：上游若把 `<nav class="deck-tabs">` 整段注释掉再改成
     别的结构，注释里那个 `class="deck-tabs"` 仍在文本上「存在」，但元素已经没了。
     不剥注释就等于给这种改名留了一道后门（实测过：只改名、旧标记留在注释里，
     门禁仍然绿）。未闭合的注释按浏览器语义吞到文末。 */
  const visible = stripHtmlComments(html);
  for (const attr of visible.matchAll(/class=(?:"([^"]*)"|'([^']*)')/g)) {
    for (const token of (attr[1] ?? attr[2]).split(/\s+/)) if (token !== '') present.add(token);
  }
  for (const assign of html.matchAll(/className\s*(?:\+?=)\s*['"`]([^'"`]*)/g)) {
    for (const token of assign[1].split(/\s+/)) {
      /* 模板字面量里可能带 `${…}`，剥掉再判。 */
      const clean = token.replace(/\$\{[^}]*\}/g, '').trim();
      if (clean !== '') present.add(clean);
    }
  }
  for (const add of html.matchAll(/classList\.(?:add|toggle)\(\s*'([^']+)'/g)) {
    for (const token of add[1].split(/\s+/)) if (token !== '') present.add(token);
  }
  return present;
}

/**
 * 抽出**本仓库自己创建**的类名（补丁追加的那些）。
 *
 * @param {string} js 模块源码。
 * @returns {Set<string>} 自建类名。
 */
export function collectSelfCreatedClasses(js) {
  const created = new Set();
  for (const assign of js.matchAll(/className\s*(?:\+?=)\s*'([^']*)'/g)) {
    for (const token of assign[1].split(/\s+/)) if (token !== '') created.add(token);
  }
  /* `className` 上更复杂的赋值（例如「已经带了就不重复加」的三元式）：
     取该语句里出现的**所有**字符串字面量。范围仍限定在 `className …=`
     这一行到语句结束之间，不会把整份源码里的字符串都算成类名。 */
  for (const assign of js.matchAll(/className\s*\+?=[^;\n]*/g)) {
    for (const literal of assign[0].matchAll(/'([^']*)'/g)) {
      for (const token of literal[1].split(/\s+/)) {
        if (token !== '' && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(token)) created.add(token);
      }
    }
  }
  for (const add of js.matchAll(/classList\.(?:add|toggle)\(\s*'([^']+)'/g)) {
    for (const token of add[1].split(/\s+/)) if (token !== '') created.add(token);
  }
  /* 注入的 HTML 片段里写死的 `class="…"` 也是自建的（例如表格补丁生成的
     `md-table-wrap` / `md-table`）—— 样式若哪天改成引 CSS，选择器不应被当成缺失。 */
  for (const attr of js.matchAll(/class="([^"]*)"/g)) {
    for (const token of attr[1].split(/\s+/)) {
      if (token !== '' && !token.includes('$')) created.add(token);
    }
  }
  return created;
}

/**
 * 校验一份补丁模块的选择器是否还落在 vendored HTML 上。
 *
 * @param {{css: string, js: string, html: string}} input 三份文本。
 * @returns {{checked: number, selfCreated: string[], missing: Array<{cls: string, where: string}>}} 结果。
 */
export function checkSelectorAlignment({ css, js, html }) {
  const required = collectRequiredClasses(css, js);
  const present = collectVendoredClasses(html);
  const created = collectSelfCreatedClasses(js);
  const missing = [];
  for (const [cls, where] of required) {
    if (present.has(cls) || created.has(cls)) continue;
    missing.push({ cls, where });
  }
  return {
    checked: required.size,
    selfCreated: [...created].sort(),
    missing: missing.sort((a, b) => a.cls.localeCompare(b.cls))
  };
}

/**
 * 需要对齐的补丁模块（判据的一部分，所以留在 `lib/`）。
 *
 * 不带 CSS 的模块必须写清 `noCssReason` —— 空集合不得当绿，但「这个模块本来就
 * 没有选择器依赖」是合法事实，只是必须**显式声明**，不能靠「抽不到就跳过」蒙过去。
 */
export const BOARD_PATCH_MODULES = [
  { path: 'lib/board-responsive.js' },
  {
    path: 'lib/board-markdown.js',
    noCssReason: '表格样式全部内联写在注入的 HTML 上（见 lib/board-markdown.js 的 <table style=…>），没有 CSS 选择器依赖'
  }
];

/** 选择器类名总数的下限。当前实测 22 个；留 2 个余量，收窄到明显不对就红。 */
export const MIN_SELECTORS = 20;

/**
 * 从模块源码里抽出 CSS 文本：本仓库的约定是「名字里带 CSS 的模板字面量」。
 *
 * @param {string} js 模块源码。
 * @returns {string[]} 每段 CSS 的文本。
 */
export function extractCss(js) {
  return [...js.matchAll(/const\s+[A-Z_]*CSS[A-Z_]*\s*=\s*`([\s\S]*?)`;/g)].map((m) => m[1]);
}

/**
 * 对整批模块下结论（判定逻辑的唯一真源；CLI 只负责读文件与退出码）。
 *
 * @param {{html: string, modules: Array<{rel: string, js: string}>}} input 页面与模块源码。
 * @returns {{ok: boolean, results: object[], problems: string[], total: number}} 结论。
 */
export function judgeBoardSelectors({ html, modules }) {
  const problems = [];
  const results = [];
  for (const module of modules) {
    const declared = BOARD_PATCH_MODULES.find((item) => item.path === module.rel);
    const css = extractCss(module.js).join('\n');
    const result = checkSelectorAlignment({ css, js: module.js, html });
    results.push({ ...result, label: module.rel });
    if (result.checked === 0) {
      if (typeof declared?.noCssReason === 'string' && declared.noCssReason.trim() !== '') continue;
      problems.push(`${module.rel}：没有抽到任何选择器类名，也没有声明 noCssReason（空集合不得当绿）`);
      continue;
    }
    for (const item of result.missing) {
      problems.push(`${module.rel}：选择器 .${item.cls}（${item.where}）在 vendored 看板页面里不存在 —— 上游改名了，这条样式已静默失效`);
    }
  }
  /* 语料下限：一个模块都没对账等于什么都没验。 */
  if (results.length === 0 && problems.length === 0) problems.push('没有校验任何补丁模块（空集合不得当绿）');
  const total = results.reduce((sum, item) => sum + item.checked, 0);
  if (total < MIN_SELECTORS && problems.length === 0) {
    problems.push(`只对账了 ${total} 个选择器类名（下限 ${MIN_SELECTORS}）—— 抽取口径或补丁模块清单被悄悄收窄了`);
  }
  return { ok: problems.length === 0, results, problems, total };
}
