'use strict';
/**
 * Yerleşim (layout) motoru.
 *
 * DOM + hesaplanmış stil → kutu ağacı → sayfalanmış çizim listesi.
 *
 * Desteklenen yerleşim modelleri:
 *   - block  : dikey akış, margin çakışması (collapsing), auto genişlik
 *   - inline : satır kutuları, gerçek font metrikleriyle sözcük sarma
 *   - flex   : row/column, justify-content, align-items, gap, flex-grow
 *   - table  : sütun genişliği dağıtımı, thead sayfa başına tekrar
 *   - absolute/fixed : içeren bloğa göre konumlandırma
 */

const { toPt, toColor, isPercent } = require('../css/values');

const BLOCK_DISPLAYS = new Set([
  'block', 'flow-root', 'list-item', 'table', 'flex', 'grid',
  'table-row-group', 'table-header-group', 'table-footer-group',
  'table-row', 'table-cell', 'table-caption'
]);

class LayoutEngine {
  /**
   * @param {Object} o
   * @param {Object} o.resolver StyleResolver
   * @param {Object} o.fonts FontManager
   * @param {Object} o.page { width, height, margin:{top,right,bottom,left} }
   * @param {Function} o.loadImage (src) => { width, height, ... }
   * @param {Array} o.warnings
   */
  constructor({ resolver, fonts, page, loadImage, warnings }) {
    this.resolver = resolver;
    this.fonts = fonts;
    this.page = page;
    this.loadImage = loadImage;
    this.warnings = warnings || [];
    this.slots = [];        // layout manifest: imza yuvaları
    this.links = [];
    this.outline = [];
    this._listCounters = new Map();
  }

  /* ---------------------------------------------------------------- */
  /* Kutu ağacı                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * DOM'dan kutu ağacı kurar; her kutuya hesaplanmış stil iliştirir.
   */
  buildBoxes(node, parentComputed = null) {
    if (node.type === 'text') {
      const text = node.text;
      if (!text) return null;
      return { kind: 'text', text, style: parentComputed, node };
    }
    if (node.type !== 'element' && node.type !== 'document') return null;

    const computed = node.type === 'document'
      ? this.resolver.compute({ type: 'element', tag: 'html', attrs: {}, children: [], parent: null }, null)
      : this.resolver.compute(node, parentComputed);

    if (computed.display === 'none') return null;

    const box = {
      kind: 'box',
      tag: node.tag,
      attrs: node.attrs || {},
      style: computed,
      node,
      children: []
    };

    for (const child of node.children) {
      const childBox = this.buildBoxes(child, computed);
      if (childBox) box.children.push(childBox);
    }
    return box;
  }

  /* ---------------------------------------------------------------- */
  /* Ölçüler                                                           */
  /* ---------------------------------------------------------------- */

  /** Kutu kenar ölçülerini (margin/padding/border) pt olarak çözer. */
  edges(style, containerWidth) {
    const ctx = { fontSize: style.fontSize, rootFontSize: this.resolver.rootFontSize, percentBase: containerWidth };
    const get = (prop, fallback = 0) => {
      const v = style.raw ? style.raw[prop] : undefined;
      if (v === undefined) return fallback;
      const pt = toPt(v, ctx);
      return pt == null ? fallback : pt;
    };
    return {
      margin: {
        top: get('margin-top'), right: get('margin-right'),
        bottom: get('margin-bottom'), left: get('margin-left')
      },
      padding: {
        top: get('padding-top'), right: get('padding-right'),
        bottom: get('padding-bottom'), left: get('padding-left')
      },
      border: {
        top: get('border-top-width'), right: get('border-right-width'),
        bottom: get('border-bottom-width'), left: get('border-left-width')
      }
    };
  }

  /** `width`/`height` çözümü; `auto` için null döner. */
  resolveSize(style, prop, containerSize) {
    const v = style.raw ? style.raw[prop] : undefined;
    if (v === undefined || v === 'auto') return null;
    const ctx = {
      fontSize: style.fontSize,
      rootFontSize: this.resolver.rootFontSize,
      percentBase: containerSize
    };
    return toPt(v, ctx);
  }

  /* ---------------------------------------------------------------- */
  /* Satır içi yerleşim                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Bir bloğun satır içi çocuklarını satırlara böler.
   * @returns {{ lines: Array, height: number }}
   */
  layoutInline(children, availableWidth, parentStyle) {
    const items = [];
    this.collectInline(children, items, parentStyle);

    const lines = [];
    let line = { items: [], width: 0, height: 0, baseline: 0 };
    const pushLine = () => {
      if (!line.items.length) return;
      lines.push(line);
      line = { items: [], width: 0, height: 0, baseline: 0 };
    };

    for (const item of items) {
      if (item.type === 'break') { pushLine(); continue; }

      if (item.type === 'image') {
        if (line.width + item.width > availableWidth && line.items.length) pushLine();
        line.items.push({ ...item, x: line.width });
        line.width += item.width;
        line.height = Math.max(line.height, item.height);
        line.baseline = Math.max(line.baseline, item.height);
        continue;
      }

      const style = item.style;
      const face = this.fonts.resolve(style.fontFamily, style.fontWeight, style.fontStyle);
      const preserve = style.whiteSpace === 'pre' || style.whiteSpace === 'pre-wrap';
      const text = applyTextTransform(item.text, style.textTransform);

      const tokens = preserve
        ? text.split(/(\n)/).filter((t) => t !== '')
        : tokenizeWords(text);

      for (const token of tokens) {
        if (token === '\n') { pushLine(); continue; }
        const isSpace = /^\s+$/.test(token);
        if (isSpace && !preserve && !line.items.length) continue;   // satır başındaki boşluk yutulur

        const w = this.fonts.measure(token, face, style.fontSize, style.letterSpacing)
                  + (isSpace ? style.wordSpacing : 0);

        if (!isSpace && line.width + w > availableWidth + 0.01 && line.items.length) {
          // Satır sonundaki boşluğu at
          while (line.items.length && line.items[line.items.length - 1].isSpace) {
            const removed = line.items.pop();
            line.width -= removed.width;
          }
          pushLine();
        }

        // Tek bir sözcük bile sığmıyorsa zorla kır
        if (!isSpace && w > availableWidth && !line.items.length) {
          const pieces = this.breakWord(token, face, style, availableWidth);
          for (let pi = 0; pi < pieces.length; pi++) {
            const piece = pieces[pi];
            line.items.push({
              type: 'text', text: piece.text, width: piece.width, style, face,
              x: line.width, isSpace: false, href: item.href
            });
            line.width += piece.width;
            line.height = Math.max(line.height, style.lineHeight);
            line.baseline = Math.max(line.baseline, style.fontSize * 0.8);
            if (pi < pieces.length - 1) pushLine();
          }
          continue;
        }

        line.items.push({
          type: 'text', text: token, width: w, style, face,
          x: line.width, isSpace, href: item.href
        });
        line.width += w;
        line.height = Math.max(line.height, style.lineHeight);
        line.baseline = Math.max(line.baseline, style.fontSize * 0.8);
      }
    }
    pushLine();

    // Sondaki boşlukları temizle
    for (const l of lines) {
      while (l.items.length && l.items[l.items.length - 1].isSpace) {
        const removed = l.items.pop();
        l.width -= removed.width;
      }
    }

    const height = lines.reduce((sum, l) => sum + (l.height || parentStyle.lineHeight), 0);
    return { lines, height };
  }

  /** Sığmayan tek sözcüğü parçalara böler. */
  breakWord(word, face, style, maxWidth) {
    const pieces = [];
    let current = '';
    let currentW = 0;
    for (const ch of word) {
      const cw = this.fonts.measure(ch, face, style.fontSize, style.letterSpacing);
      if (currentW + cw > maxWidth && current) {
        pieces.push({ text: current, width: currentW });
        current = ch; currentW = cw;
      } else {
        current += ch; currentW += cw;
      }
    }
    if (current) pieces.push({ text: current, width: currentW });
    return pieces;
  }

  /** Satır içi kutuları düzleştirerek toplar. */
  collectInline(children, out, parentStyle, href = null) {
    for (const child of children) {
      if (child.kind === 'text') {
        const style = child.style || parentStyle;
        const preserve = style.whiteSpace === 'pre' || style.whiteSpace === 'pre-wrap';
        const text = preserve ? child.text : child.text.replace(/\s+/g, ' ');
        if (text) out.push({ type: 'text', text, style, href });
        continue;
      }
      if (child.tag === 'br') { out.push({ type: 'break' }); continue; }

      if (child.tag === 'img') {
        const img = this.tryLoadImage(child);
        if (img) out.push({ type: 'image', ...img, style: child.style, href });
        continue;
      }

      const nextHref = child.tag === 'a' && child.attrs.href ? child.attrs.href : href;
      this.collectInline(child.children, out, child.style, nextHref);
    }
  }

  tryLoadImage(box) {
    const src = box.attrs.src;
    if (!src) return null;
    try {
      const img = this.loadImage(src);
      const styleW = this.resolveSize(box.style, 'width', 0);
      const styleH = this.resolveSize(box.style, 'height', 0);
      const attrW = box.attrs.width ? toPt(box.attrs.width) : null;
      const attrH = box.attrs.height ? toPt(box.attrs.height) : null;

      let w = styleW ?? attrW;
      let h = styleH ?? attrH;
      const ratio = img.height / img.width;
      if (w != null && h == null) h = w * ratio;
      else if (h != null && w == null) w = h / ratio;
      else if (w == null && h == null) { w = img.width * 0.75; h = img.height * 0.75; }

      return { image: img, width: w, height: h, src };
    } catch (err) {
      this.warnings.push({ type: 'image', message: `Görsel yüklenemedi: ${src} (${err.message})` });
      return null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                         */
/* ------------------------------------------------------------------ */

function tokenizeWords(text) {
  return text.match(/\s+|[^\s]+/g) || [];
}

function applyTextTransform(text, transform) {
  switch (transform) {
    case 'uppercase': return text.toLocaleUpperCase('tr-TR');
    case 'lowercase': return text.toLocaleLowerCase('tr-TR');
    case 'capitalize': return text.replace(/(^|\s)(\S)/g, (m, sp, c) => sp + c.toLocaleUpperCase('tr-TR'));
    default: return text;
  }
}

function isBlockDisplay(display) {
  return BLOCK_DISPLAYS.has(display);
}

module.exports = { LayoutEngine, isBlockDisplay, tokenizeWords, applyTextTransform, BLOCK_DISPLAYS };
