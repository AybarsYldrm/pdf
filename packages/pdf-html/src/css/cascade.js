'use strict';
/**
 * Kurallar (cascade), kalıtım ve hesaplanmış (computed) değerler.
 */

const { matches, parseCss, parseDeclarations, setDeclaration } = require('./parser');
const { toPt, toColor, fontWeightNumber, fontFamilyList } = require('./values');

/** Kalıtımla geçen özellikler (CSS 2.1 + kullandıklarımız). */
const INHERITED = new Set([
  'color', 'font-family', 'font-size', 'font-style', 'font-weight',
  'letter-spacing', 'line-height', 'text-align', 'text-indent',
  'text-transform', 'visibility', 'white-space', 'word-spacing',
  'list-style-type', 'orphans', 'widows', 'quotes', 'direction', 'lang'
]);

/** Tarayıcı varsayılan stil sayfası — baskıya uyarlanmış. */
const UA_STYLESHEET = `
  html, body { display: block; margin: 0; padding: 0; }
  div, section, article, header, footer, main, nav, aside,
  figure, figcaption, form, fieldset, address { display: block; }
  p { display: block; margin-top: 1em; margin-bottom: 1em; }
  h1 { display: block; font-size: 2em;    font-weight: bold; margin-top: 0.67em; margin-bottom: 0.67em; }
  h2 { display: block; font-size: 1.5em;  font-weight: bold; margin-top: 0.83em; margin-bottom: 0.83em; }
  h3 { display: block; font-size: 1.17em; font-weight: bold; margin-top: 1em;    margin-bottom: 1em; }
  h4 { display: block; font-size: 1em;    font-weight: bold; margin-top: 1.33em; margin-bottom: 1.33em; }
  h5 { display: block; font-size: 0.83em; font-weight: bold; margin-top: 1.67em; margin-bottom: 1.67em; }
  h6 { display: block; font-size: 0.67em; font-weight: bold; margin-top: 2.33em; margin-bottom: 2.33em; }
  blockquote { display: block; margin: 1em 40px; }
  pre { display: block; white-space: pre; font-family: monospace; margin: 1em 0; }
  hr { display: block; margin: 0.5em 0; border-top-width: 1px; border-top-style: solid; border-top-color: #999; }
  ul, ol { display: block; margin-top: 1em; margin-bottom: 1em; padding-left: 40px; }
  ul { list-style-type: disc; }
  ol { list-style-type: decimal; }
  li { display: list-item; }
  dl { display: block; margin: 1em 0; }
  dt { display: block; font-weight: bold; }
  dd { display: block; margin-left: 40px; }
  table { display: table; border-collapse: separate; }
  thead { display: table-header-group; }
  tbody { display: table-row-group; }
  tfoot { display: table-footer-group; }
  tr { display: table-row; }
  td, th { display: table-cell; padding: 2px; }
  th { font-weight: bold; text-align: center; }
  caption { display: table-caption; text-align: center; }
  b, strong { font-weight: bold; }
  i, em, cite, var { font-style: italic; }
  small { font-size: 0.83em; }
  big { font-size: 1.17em; }
  code, kbd, samp, tt { font-family: monospace; }
  a { color: #0645ad; text-decoration: underline; }
  img { display: inline-block; }
  br { display: inline; }
  span, label { display: inline; }
  sub { font-size: 0.75em; vertical-align: sub; }
  sup { font-size: 0.75em; vertical-align: super; }
  head, title, meta, link, script, style { display: none; }
  mark { background-color: #ff0; }
  u, ins { text-decoration: underline; }
  s, del, strike { text-decoration: line-through; }
`;

/** Kök varsayılanları (kalıtımın başlangıç değerleri). */
const INITIAL = {
  'color': '#000000',
  'font-family': 'sans-serif',
  'font-size': '12pt',
  'font-style': 'normal',
  'font-weight': 'normal',
  'line-height': '1.4',
  'text-align': 'left',
  'text-transform': 'none',
  'white-space': 'normal',
  'letter-spacing': '0',
  'word-spacing': '0',
  'list-style-type': 'disc',
  'orphans': '2',
  'widows': '2',
  'direction': 'ltr'
};

/**
 * Stil çözücü: DOM'a stil uygular ve hesaplanmış stil üretir.
 */
class StyleResolver {
  /**
   * @param {string[]} cssSources Sırayla uygulanacak CSS metinleri (UA en başta)
   * @param {{ rootFontSize?: number }} [opts]
   */
  constructor(cssSources = [], opts = {}) {
    this.rules = [];
    this.pageRules = [];
    this.fontFaces = [];
    this.rootFontSize = opts.rootFontSize || 12;

    const all = [UA_STYLESHEET, ...cssSources];
    let origin = 0;
    for (const css of all) {
      const parsed = parseCss(css);
      for (const rule of parsed.rules) {
        this.rules.push({ ...rule, origin });
      }
      this.pageRules.push(...parsed.pageRules);
      this.fontFaces.push(...parsed.fontFaces);
      origin++;
    }
  }

  /** @page kurallarını birleştirilmiş bir nesne olarak döndürür. */
  pageStyle(pageSelector = '') {
    const merged = {};
    for (const rule of this.pageRules) {
      const sel = (rule.selector || '').trim();
      if (sel && sel !== pageSelector && !sel.startsWith(':')) continue;
      if (sel.startsWith(':') && sel !== pageSelector) continue;
      for (const [k, v] of Object.entries(rule.declarations)) merged[k] = v.value;
    }
    return merged;
  }

  /**
   * Bir eleman için ham (henüz hesaplanmamış) bildirimleri toplar.
   * Sıralama: origin → özgüllük → kaynak sırası; !important en üstte.
   */
  collect(node) {
    const matched = [];
    for (const rule of this.rules) {
      if (matches(node, rule.parsed)) matched.push(rule);
    }
    matched.sort((a, b) => {
      if (a.origin !== b.origin) return a.origin - b.origin;
      const sa = a.parsed.specificity, sb = b.parsed.specificity;
      for (let i = 0; i < 3; i++) if (sa[i] !== sb[i]) return sa[i] - sb[i];
      return a.order - b.order;
    });

    const decls = {};
    const important = {};
    for (const rule of matched) {
      for (const [prop, entry] of Object.entries(rule.declarations)) {
        if (entry.important) important[prop] = entry.value;
        else decls[prop] = entry.value;
      }
    }

    // style="" özniteliği — normal bildirimlerin üstünde
    if (node.attrs && node.attrs.style) {
      const inline = parseDeclarations(node.attrs.style);
      for (const [prop, entry] of Object.entries(inline)) {
        if (entry.important) important[prop] = entry.value;
        else decls[prop] = entry.value;
      }
    }

    return { ...decls, ...important };
  }

  /**
   * Hesaplanmış stil üretir: kalıtım uygulanır, birimler pt'ye çevrilir,
   * `var(--x)` çözülür.
   *
   * @param {Object} node DOM elemanı
   * @param {Object|null} parentComputed Üst elemanın hesaplanmış stili
   * @returns {Object} computed style
   */
  compute(node, parentComputed) {
    const parent = parentComputed || {};
    const raw = node.type === 'element' ? this.collect(node) : {};

    // 1. CSS değişkenleri (kalıtımla geçer)
    const vars = { ...(parent._vars || {}) };
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('--')) vars[k] = v;
    }

    const resolveVars = (value) => {
      if (typeof value !== 'string' || !value.includes('var(')) return value;
      let out = value;
      for (let i = 0; i < 8 && out.includes('var('); i++) {
        out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (m, name, fallback) => {
          if (vars[name] !== undefined) return vars[name];
          return fallback !== undefined ? fallback.trim() : '';
        });
      }
      return out;
    };

    // 2. Ham değerleri çöz
    const declared = {};
    const deferred = [];
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('--')) continue;
      if (k.startsWith('__deferred__')) {
        deferred.push([k.slice(12), resolveVars(v)]);
        continue;
      }
      declared[k] = resolveVars(v);
    }

    // 2b. var() içerdiği için ertelenmiş kısayolları şimdi aç.
    // Ertelenmiş kısayol, aynı bloktaki açık bildirimlerden ÖNCE gelir
    // (CSS'te de kısayol, kendisinden sonra gelen uzun yazımla ezilir).
    if (deferred.length) {
      const expanded = {};
      for (const [prop, value] of deferred) setDeclaration(expanded, prop, value, false);
      for (const [k, entry] of Object.entries(expanded)) {
        if (declared[k] === undefined) declared[k] = entry.value;
      }
    }

    // 3. Kalıtım
    const computed = { _vars: vars };
    for (const prop of INHERITED) {
      if (declared[prop] !== undefined) computed[prop] = declared[prop];
      else if (parent[prop] !== undefined) computed[prop] = parent[prop];
      else if (INITIAL[prop] !== undefined) computed[prop] = INITIAL[prop];
    }
    for (const [k, v] of Object.entries(declared)) {
      if (!INHERITED.has(k)) computed[k] = v;
    }

    // 4. font-size'ı erken çöz — em hesapları buna dayanır
    const parentFontSize = parent.fontSize || this.rootFontSize;
    const fsCtx = {
      fontSize: parentFontSize,
      rootFontSize: this.rootFontSize,
      percentBase: parentFontSize
    };
    computed.fontSize = declared['font-size'] !== undefined
      ? (toPt(declared['font-size'], fsCtx) ?? parentFontSize)
      : (computed['font-size'] !== undefined
          ? (toPt(computed['font-size'], fsCtx) ?? parentFontSize)
          : parentFontSize);

    // 5. Kullanışlı türetilmiş alanlar
    computed.display = declared.display || (node.type === 'text' ? 'inline' : 'inline');
    computed.fontFamily = fontFamilyList(computed['font-family']);
    computed.fontWeight = fontWeightNumber(computed['font-weight']);
    computed.fontStyle = (computed['font-style'] || 'normal').toLowerCase();
    computed.color = toColor(computed.color) || [0, 0, 0, 1];
    computed.textAlign = (computed['text-align'] || 'left').toLowerCase();
    computed.textTransform = (computed['text-transform'] || 'none').toLowerCase();
    computed.whiteSpace = (computed['white-space'] || 'normal').toLowerCase();
    computed.lineHeight = resolveLineHeight(computed['line-height'], computed.fontSize, this.rootFontSize);
    computed.letterSpacing = toPt(computed['letter-spacing'], { fontSize: computed.fontSize }) || 0;
    computed.wordSpacing = toPt(computed['word-spacing'], { fontSize: computed.fontSize }) || 0;
    computed.textDecoration = (declared['text-decoration'] || '').toLowerCase();
    computed.opacity = declared.opacity !== undefined ? parseFloat(declared.opacity) : 1;
    computed.position = (declared.position || 'static').toLowerCase();
    computed.raw = declared;

    return computed;
  }
}

function resolveLineHeight(value, fontSize, rootFontSize) {
  if (value == null || value === 'normal') return fontSize * 1.4;
  const s = String(value).trim();
  const bare = parseFloat(s);
  if (!Number.isNaN(bare) && /^[\d.]+$/.test(s)) return fontSize * bare;   // çarpan
  const pt = toPt(s, { fontSize, rootFontSize, percentBase: fontSize });
  return pt != null ? pt : fontSize * 1.4;
}

module.exports = { StyleResolver, INHERITED, UA_STYLESHEET, INITIAL, resolveLineHeight };
