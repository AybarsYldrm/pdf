/**
 * Küçük DOM yardımcıları.
 *
 * KURAL: `innerHTML` KULLANILMAZ. Tüm düğümler burada kurulur ve kullanıcı
 * içeriği yalnızca `textContent` ile yazılır. Bu, XSS yüzeyini fiilen sıfırlar.
 */

/**
 * Eleman oluşturur.
 * @param {string} tag
 * @param {Object|null} [attrs] class, id, data-*, on* (olay), style objesi…
 * @param {Array|string|Node} [children]
 */
export function el(tag, attrs = null, children = null) {
  const node = document.createElement(tag);

  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
  }

  append(node, children);
  return node;
}

/**
 * SVG elemanı oluşturur.
 *
 * SVG düğümleri XHTML ad alanında DEĞİLDİR; `createElement('path')` HTML
 * bilinmeyen elemanı üretir ve hiçbir şey çizilmez. Bu yüzden ayrı bir
 * kurucu gerekir. Öznitelikler burada da `setAttribute` ile yazılır —
 * `innerHTML` yok, dizge birleştirme yok.
 */
export function svgEl(tag, attrs = null, children = null) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);

  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else node.setAttribute(key, String(value));
    }
  }

  append(node, children);
  return node;
}

export function append(parent, children) {
  if (children == null) return parent;
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child == null || child === false) continue;
    parent.appendChild(typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child))
      : child);
  }
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Anahtar/değer listesi (<dl>) kurar. */
export function kv(pairs, className = 'kv') {
  const dl = el('dl', { class: className });
  for (const [k, v] of pairs) {
    if (v == null || v === '') continue;
    dl.appendChild(el('dt', { text: k }));
    dl.appendChild(el('dd', { text: String(v) }));
  }
  return dl;
}

/** <select> seçeneklerini yeniler. */
export function setOptions(select, items, selected) {
  clear(select);
  for (const item of items) {
    const value = typeof item === 'string' ? item : item.value;
    const label = typeof item === 'string' ? item : item.label;
    select.appendChild(el('option', { value, selected: value === selected }, label));
  }
  return select;
}
