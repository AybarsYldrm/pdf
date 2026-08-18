'use strict';
/**
 * CSS ayrıştırıcı ve kurallar (cascade) motoru.
 *
 * Desteklenen seçiciler: tag, .class, #id, *, [attr], [attr="v"], [attr^="v"],
 * A B (torun), A > B (çocuk), A, B (liste), :first-child, :last-child,
 * :nth-child(n | odd | even), :not(basit-seçici)
 *
 * Desteklenen @kurallar: @page, @media print/screen/all, @font-face
 * CSS değişkenleri (--x + var(--x, fallback)) ve !important desteklenir.
 */

const { expandBox, expandBorder, expandFont } = require('./values');

/* ------------------------------------------------------------------ */
/* Ayrıştırma                                                           */
/* ------------------------------------------------------------------ */

/**
 * CSS metnini kural listesine çevirir.
 * @param {string} css
 * @returns {{ rules: Array, pageRules: Array, fontFaces: Array }}
 */
function parseCss(css) {
  const rules = [];
  const pageRules = [];
  const fontFaces = [];

  const src = stripComments(String(css));
  let pos = 0;

  const parseBlock = (from, mediaOk) => {
    let i = from;
    while (i < src.length) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (i >= src.length) break;
      if (src[i] === '}') return i + 1;

      // @kural
      if (src[i] === '@') {
        const atMatch = /^@([a-zA-Z-]+)([^{;]*)/.exec(src.slice(i));
        if (!atMatch) { i++; continue; }
        const name = atMatch[1].toLowerCase();
        const params = atMatch[2].trim();
        let j = i + atMatch[0].length;

        if (src[j] === ';') { i = j + 1; continue; }   // @import vb. — yoksayılır
        if (src[j] !== '{') { i = j + 1; continue; }

        const blockEnd = findBlockEnd(src, j);
        const inner = src.slice(j + 1, blockEnd);

        if (name === 'page') {
          pageRules.push({ selector: params, declarations: parseDeclarations(inner) });
        } else if (name === 'font-face') {
          fontFaces.push(parseDeclarations(inner));
        } else if (name === 'media') {
          // Baskı ortamı: print ve all uygulanır, screen atlanır.
          const q = params.toLowerCase();
          const applies = !q.includes('screen') || q.includes('print') || q.includes('all');
          if (applies && mediaOk) parseBlock(j + 1, false);
        }
        i = blockEnd + 1;
        continue;
      }

      // Normal kural
      const braceIdx = src.indexOf('{', i);
      if (braceIdx < 0) break;
      const selectorText = src.slice(i, braceIdx).trim();
      const blockEnd = findBlockEnd(src, braceIdx);
      const declarations = parseDeclarations(src.slice(braceIdx + 1, blockEnd));

      if (selectorText) {
        for (const sel of splitSelectors(selectorText)) {
          const parsed = parseSelector(sel);
          if (parsed) rules.push({ selector: sel, parsed, declarations, order: rules.length });
        }
      }
      i = blockEnd + 1;
    }
    return i;
  };

  parseBlock(pos, true);
  return { rules, pageRules, fontFaces };
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** `{` konumundan eşleşen `}` konumunu bulur. */
function findBlockEnd(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

/** Virgülle ayrılmış seçicileri böler (parantez içindekilere dokunmadan). */
function splitSelectors(text) {
  const out = [];
  let depth = 0, current = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

/** Bildirim bloğunu ayrıştırır ve kısayolları açar. */
function parseDeclarations(text) {
  const decls = {};
  let depth = 0, current = '';
  const flush = () => {
    const d = current.trim();
    current = '';
    if (!d) return;
    const colon = d.indexOf(':');
    if (colon < 0) return;

    const prop = d.slice(0, colon).trim().toLowerCase();
    let value = d.slice(colon + 1).trim();
    let important = false;
    if (/!\s*important$/i.test(value)) {
      important = true;
      value = value.replace(/!\s*important$/i, '').trim();
    }
    setDeclaration(decls, prop, value, important);
  };

  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ';' && depth === 0) { flush(); continue; }
    current += ch;
  }
  flush();
  return decls;
}

/** Kısayol (shorthand) olarak tanınan özellikler. */
const SHORTHANDS = new Set([
  'margin', 'padding', 'border-width', 'border-color', 'border-style',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-radius', 'background', 'font', 'flex', 'gap', 'grid-gap'
]);

/** Kısayol özelliklerini açarak bildirimi yazar. */
function setDeclaration(decls, prop, value, important) {
  const put = (p, v) => { decls[p] = { value: v, important }; };

  // CSS değişkenleri olduğu gibi saklanır
  if (prop.startsWith('--')) { put(prop, value); return; }

  // İçinde var() geçen KISAYOLLARI şimdi açamayız: değişkenin değeri ancak
  // kurallar zinciri çözüldükten sonra bilinir. Ham hâliyle saklayıp
  // cascade.compute() içinde, var() yerine konduktan SONRA açıyoruz.
  // (Bu olmadan `border-left: var(--w) solid var(--c)` sessizce kayboluyordu.)
  if (SHORTHANDS.has(prop) && String(value).includes('var(')) {
    put('__deferred__' + prop, value);
    return;
  }

  switch (prop) {
    case 'margin': {
      const b = expandBox(value);
      put('margin-top', b.top); put('margin-right', b.right);
      put('margin-bottom', b.bottom); put('margin-left', b.left);
      return;
    }
    case 'padding': {
      const b = expandBox(value);
      put('padding-top', b.top); put('padding-right', b.right);
      put('padding-bottom', b.bottom); put('padding-left', b.left);
      return;
    }
    case 'border-width': {
      const b = expandBox(value);
      put('border-top-width', b.top); put('border-right-width', b.right);
      put('border-bottom-width', b.bottom); put('border-left-width', b.left);
      return;
    }
    case 'border-color': {
      const b = expandBox(value);
      put('border-top-color', b.top); put('border-right-color', b.right);
      put('border-bottom-color', b.bottom); put('border-left-color', b.left);
      return;
    }
    case 'border-style': {
      const b = expandBox(value);
      put('border-top-style', b.top); put('border-right-style', b.right);
      put('border-bottom-style', b.bottom); put('border-left-style', b.left);
      return;
    }
    case 'border': case 'border-top': case 'border-right':
    case 'border-bottom': case 'border-left': {
      const parts = expandBorder(value);
      const sides = prop === 'border'
        ? ['top', 'right', 'bottom', 'left']
        : [prop.split('-')[1]];
      for (const side of sides) {
        if (parts.width != null) put(`border-${side}-width`, parts.width);
        if (parts.style != null) put(`border-${side}-style`, parts.style);
        if (parts.color != null) put(`border-${side}-color`, parts.color);
        if (parts.style === 'none' || parts.style === 'hidden') put(`border-${side}-width`, '0');
      }
      return;
    }
    case 'border-radius': {
      const b = expandBox(value);
      put('border-top-left-radius', b.top);
      put('border-top-right-radius', b.right);
      put('border-bottom-right-radius', b.bottom);
      put('border-bottom-left-radius', b.left);
      return;
    }
    case 'background': {
      // Yalnız renk ve url() desteklenir
      const urlMatch = /url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(value);
      if (urlMatch) put('background-image', urlMatch[1]);
      const colorPart = value.replace(/url\([^)]*\)/gi, '').trim();
      if (colorPart) put('background-color', colorPart.split(/\s+/)[0]);
      return;
    }
    case 'font': {
      const f = expandFont(value);
      for (const [k, v] of Object.entries(f)) put(k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), v);
      return;
    }
    case 'flex': {
      const parts = value.trim().split(/\s+/);
      put('flex-grow', parts[0] || '0');
      if (parts[1] !== undefined) put('flex-shrink', parts[1]);
      if (parts[2] !== undefined) put('flex-basis', parts[2]);
      return;
    }
    case 'gap': {
      const parts = value.trim().split(/\s+/);
      put('row-gap', parts[0]);
      put('column-gap', parts[1] !== undefined ? parts[1] : parts[0]);
      return;
    }
    case 'grid-gap': {
      const parts = value.trim().split(/\s+/);
      put('row-gap', parts[0]);
      put('column-gap', parts[1] !== undefined ? parts[1] : parts[0]);
      return;
    }
    default:
      put(prop, value);
  }
}

/* ------------------------------------------------------------------ */
/* Seçiciler                                                            */
/* ------------------------------------------------------------------ */

/**
 * Bir seçiciyi bileşenlerine ayırır.
 * @returns {{ parts: Array, specificity: [number,number,number] }|null}
 */
function parseSelector(selector) {
  const tokens = selector.trim().split(/\s*(>)\s*|\s+/).filter(Boolean);
  const parts = [];
  let combinator = 'descendant';

  for (const token of tokens) {
    if (token === '>') { combinator = 'child'; continue; }
    const simple = parseSimpleSelector(token);
    if (!simple) return null;
    simple.combinator = combinator;
    parts.push(simple);
    combinator = 'descendant';
  }
  if (!parts.length) return null;

  // Özgüllük: (id, class+attr+pseudo, tag)
  let a = 0, b = 0, c = 0;
  for (const p of parts) {
    if (p.id) a++;
    b += p.classes.length + p.attrs.length + p.pseudos.length;
    if (p.tag && p.tag !== '*') c++;
  }
  return { parts, specificity: [a, b, c] };
}

function parseSimpleSelector(token) {
  const out = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
  let rest = token;

  const tagMatch = /^([a-zA-Z][a-zA-Z0-9-]*|\*)/.exec(rest);
  if (tagMatch) { out.tag = tagMatch[1].toLowerCase(); rest = rest.slice(tagMatch[0].length); }

  while (rest.length) {
    if (rest[0] === '#') {
      const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
      if (!m) return null;
      out.id = m[1]; rest = rest.slice(m[0].length);
    } else if (rest[0] === '.') {
      const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
      if (!m) return null;
      out.classes.push(m[1]); rest = rest.slice(m[0].length);
    } else if (rest[0] === '[') {
      const m = /^\[([a-zA-Z0-9_-]+)(?:([~^$*|]?=)["']?([^"'\]]*)["']?)?\]/.exec(rest);
      if (!m) return null;
      out.attrs.push({ name: m[1].toLowerCase(), op: m[2] || null, value: m[3] || null });
      rest = rest.slice(m[0].length);
    } else if (rest[0] === ':') {
      const m = /^::?([a-zA-Z-]+)(?:\(([^)]*)\))?/.exec(rest);
      if (!m) return null;
      out.pseudos.push({ name: m[1].toLowerCase(), arg: m[2] || null });
      rest = rest.slice(m[0].length);
    } else {
      return null;
    }
  }
  return out;
}

/** Bir DOM elemanı seçiciyle eşleşiyor mu? */
function matches(node, parsed) {
  if (node.type !== 'element') return false;
  const parts = parsed.parts;
  let idx = parts.length - 1;
  if (!matchesSimple(node, parts[idx])) return false;
  idx--;

  let current = node;
  while (idx >= 0) {
    const part = parts[idx + 1];
    if (part.combinator === 'child') {
      current = current.parent;
      if (!current || current.type !== 'element' || !matchesSimple(current, parts[idx])) return false;
    } else {
      let ancestor = current.parent;
      let found = false;
      while (ancestor && ancestor.type === 'element') {
        if (matchesSimple(ancestor, parts[idx])) { found = true; break; }
        ancestor = ancestor.parent;
      }
      if (!found) return false;
      current = ancestor;
    }
    idx--;
  }
  return true;
}

function matchesSimple(node, simple) {
  if (simple.tag && simple.tag !== '*' && node.tag !== simple.tag) return false;
  if (simple.id && node.attrs.id !== simple.id) return false;

  if (simple.classes.length) {
    const classes = (node.attrs.class || '').split(/\s+/).filter(Boolean);
    for (const c of simple.classes) if (!classes.includes(c)) return false;
  }

  for (const attr of simple.attrs) {
    const v = node.attrs[attr.name];
    if (v === undefined) return false;
    if (!attr.op) continue;
    switch (attr.op) {
      case '=':  if (v !== attr.value) return false; break;
      case '^=': if (!v.startsWith(attr.value)) return false; break;
      case '$=': if (!v.endsWith(attr.value)) return false; break;
      case '*=': if (!v.includes(attr.value)) return false; break;
      case '~=': if (!v.split(/\s+/).includes(attr.value)) return false; break;
      case '|=': if (v !== attr.value && !v.startsWith(attr.value + '-')) return false; break;
      default: break;
    }
  }

  for (const pseudo of simple.pseudos) {
    if (!matchesPseudo(node, pseudo)) return false;
  }
  return true;
}

function matchesPseudo(node, pseudo) {
  const siblings = node.parent
    ? node.parent.children.filter((c) => c.type === 'element')
    : [node];
  const index = siblings.indexOf(node);

  switch (pseudo.name) {
    case 'first-child': return index === 0;
    case 'last-child':  return index === siblings.length - 1;
    case 'only-child':  return siblings.length === 1;
    case 'nth-child': {
      const arg = (pseudo.arg || '').trim().toLowerCase();
      const n = index + 1;
      if (arg === 'odd')  return n % 2 === 1;
      if (arg === 'even') return n % 2 === 0;
      const m = /^(?:(-?\d*)n)?\s*([+-]\s*\d+)?$/.exec(arg);
      if (m && (m[1] !== undefined || m[2] !== undefined)) {
        const a = m[1] === undefined ? 0 : (m[1] === '' ? 1 : (m[1] === '-' ? -1 : parseInt(m[1], 10)));
        const b = m[2] ? parseInt(m[2].replace(/\s+/g, ''), 10) : 0;
        if (a === 0) return n === b;
        return (n - b) % a === 0 && (n - b) / a >= 0;
      }
      const literal = parseInt(arg, 10);
      return !Number.isNaN(literal) && n === literal;
    }
    case 'not': {
      if (!pseudo.arg) return true;
      const inner = parseSimpleSelector(pseudo.arg.trim());
      return inner ? !matchesSimple(node, inner) : true;
    }
    // Görsel/etkileşim sözde sınıfları baskıda anlamsızdır — eşleşmez.
    case 'hover': case 'focus': case 'active': case 'visited':
      return false;
    default:
      return true;
  }
}

module.exports = {
  parseCss, parseSelector, matches, matchesSimple, parseDeclarations,
  splitSelectors, stripComments, setDeclaration, SHORTHANDS
};
