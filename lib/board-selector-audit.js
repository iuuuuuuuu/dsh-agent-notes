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
  for (const arg of js.matchAll(/querySelector(?:All)?\(\s*'([^']*)'/g)) {
    /* 同一个类名可能既被 CSS 选中又被 querySelector 取用：两处都记下来，
       报错时能一眼看出这条依赖有几个使用点（少记一处就少一条线索）。 */
    for (const match of arg[1].matchAll(CLASS_TOKEN)) add(match[1], `querySelector('${arg[1]}')`);
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
  for (const attr of html.matchAll(/class="([^"]*)"/g)) {
    for (const token of attr[1].split(/\s+/)) if (token !== '') present.add(token);
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
