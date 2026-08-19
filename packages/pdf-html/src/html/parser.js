'use strict';
/**
 * HTML → DOM ayrıştırıcı.
 *
 * Tam bir HTML5 ayrıştırıcı değildir; belge üretimi için gereken alt kümeyi
 * doğru şekilde işler: void elementler, öznitelik biçimleri, HTML varlıkları,
 * yorumlar, `<style>`/`<script>` ham metin içerikleri ve kapatılmamış
 * etiketlerin makul biçimde kapatılması.
 */

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);

/** Bir etiket açıldığında otomatik kapanan etiketler (basitleştirilmiş). */
const AUTO_CLOSE = {
  li: new Set(['li']),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd']),
  p:  new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'table',
               'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre']),
  td: new Set(['td', 'th', 'tr']),
  th: new Set(['td', 'th', 'tr']),
  tr: new Set(['tr']),
  thead: new Set(['tbody', 'tfoot']),
  tbody: new Set(['tbody', 'tfoot']),
  option: new Set(['option'])
};

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', shy: '­',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', deg: '°',
  euro: '€', pound: '£', sect: '§', para: '¶',
  times: '×', divide: '÷', plusmn: '±', frac12: '½'
};

/** HTML varlıklarını çözer. */
function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10FFFF) {
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      return match;
    }
    const named = ENTITIES[body] || ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

/**
 * @typedef {Object} DomNode
 * @property {'element'|'text'|'document'} type
 * @property {string} [tag]
 * @property {Object} [attrs]
 * @property {string} [text]
 * @property {DomNode[]} children
 * @property {DomNode|null} parent
 */

function createElement(tag, attrs) {
  return { type: 'element', tag, attrs: attrs || {}, children: [], parent: null };
}

function createText(text) {
  return { type: 'text', text, children: [], parent: null };
}

function appendChild(parent, child) {
  child.parent = parent;
  parent.children.push(child);
  return child;
}

/**
 * HTML metnini DOM ağacına çevirir.
 * @param {string} html
 * @returns {{ root: DomNode, styles: string[], title: string|null }}
 */
function parseHtml(html) {
  const root = { type: 'document', tag: '#document', attrs: {}, children: [], parent: null };
  const stack = [root];
  const styles = [];
  let title = null;

  const src = String(html);
  let pos = 0;

  const top = () => stack[stack.length - 1];

  const pushText = (raw) => {
    if (!raw) return;
    const decoded = decodeEntities(raw);
    if (!decoded) return;
    appendChild(top(), createText(decoded));
  };

  while (pos < src.length) {
    const lt = src.indexOf('<', pos);

    if (lt < 0) {
      pushText(src.slice(pos));
      break;
    }
    if (lt > pos) pushText(src.slice(pos, lt));

    // Yorum
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      pos = end < 0 ? src.length : end + 3;
      continue;
    }
    // DOCTYPE / işleme yönergesi
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const end = src.indexOf('>', lt);
      pos = end < 0 ? src.length : end + 1;
      continue;
    }
    // Kapanış etiketi
    if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt);
      if (end < 0) { pos = src.length; break; }
      const tag = src.slice(lt + 2, end).trim().toLowerCase().split(/\s/)[0];
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      pos = end + 1;
      continue;
    }

    // Açılış etiketi
    const tagMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(src.slice(lt));
    if (!tagMatch) {          // '<' düz metin olarak geçmiş
      pushText('<');
      pos = lt + 1;
      continue;
    }

    const tag = tagMatch[1].toLowerCase();
    const { attrs, end, selfClosing } = parseAttributes(src, lt + 1 + tag.length);

    // Otomatik kapatma kuralları
    const closes = AUTO_CLOSE[top().tag];
    if (closes && closes.has(tag)) stack.pop();

    const el = createElement(tag, attrs);
    appendChild(top(), el);

    if (VOID_ELEMENTS.has(tag) || selfClosing) {
      pos = end;
      continue;
    }

    if (RAW_TEXT_ELEMENTS.has(tag)) {
      const closeIdx = src.toLowerCase().indexOf(`</${tag}`, end);
      const raw = closeIdx < 0 ? src.slice(end) : src.slice(end, closeIdx);
      if (tag === 'style') styles.push(raw);
      else appendChild(el, createText(raw));       // script içeriği çalıştırılmaz
      pos = closeIdx < 0 ? src.length : src.indexOf('>', closeIdx) + 1;
      continue;
    }

    stack.push(el);
    pos = end;

    if (tag === 'title') {
      const closeIdx = src.toLowerCase().indexOf('</title', pos);
      if (closeIdx > 0) title = decodeEntities(src.slice(pos, closeIdx)).trim();
    }
  }

  return { root, styles, title };
}

/** `<tag` sonrasından itibaren öznitelikleri okur. */
function parseAttributes(src, from) {
  const attrs = {};
  let i = from;
  let selfClosing = false;

  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (i >= src.length) break;

    if (src[i] === '>') { i++; break; }
    if (src[i] === '/' && src[i + 1] === '>') { selfClosing = true; i += 2; break; }

    const nameMatch = /^[^\s=/>]+/.exec(src.slice(i));
    if (!nameMatch) { i++; continue; }
    const name = nameMatch[0].toLowerCase();
    i += nameMatch[0].length;

    while (i < src.length && /\s/.test(src[i])) i++;

    if (src[i] !== '=') {
      attrs[name] = '';
      continue;
    }
    i++; // '='
    while (i < src.length && /\s/.test(src[i])) i++;

    let value = '';
    const quote = src[i];
    if (quote === '"' || quote === "'") {
      i++;
      const end = src.indexOf(quote, i);
      value = end < 0 ? src.slice(i) : src.slice(i, end);
      i = end < 0 ? src.length : end + 1;
    } else {
      const m = /^[^\s>]*/.exec(src.slice(i));
      value = m ? m[0] : '';
      i += value.length;
    }
    attrs[name] = decodeEntities(value);
  }

  return { attrs, end: i, selfClosing };
}

/** Ağaçta derinlik öncelikli dolaşım. */
function walk(node, visit, depth = 0) {
  if (visit(node, depth) === false) return;
  for (const child of node.children) walk(child, visit, depth + 1);
}

/** Basit seçiciyle ilk eşleşen elemanı bulur (tag / .class / #id). */
function querySelector(root, selector) {
  let found = null;
  walk(root, (node) => {
    if (found || node.type !== 'element') return;
    if (matchesSimple(node, selector)) { found = node; return false; }
  });
  return found;
}

function matchesSimple(node, selector) {
  if (selector.startsWith('.')) {
    const classes = (node.attrs.class || '').split(/\s+/);
    return classes.includes(selector.slice(1));
  }
  if (selector.startsWith('#')) return node.attrs.id === selector.slice(1);
  return node.tag === selector.toLowerCase();
}

module.exports = {
  parseHtml, decodeEntities, walk, querySelector, matchesSimple,
  VOID_ELEMENTS, RAW_TEXT_ELEMENTS, createElement, createText, appendChild
};
