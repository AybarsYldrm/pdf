/**
 * Sahne tuvali — seçim, taşıma, ölçekleme, yapışma.
 *
 * MİMARİ KURAL: bu dosya SUNUMDUR. Belgeyi değiştiren tek şey `Scene`
 * nesnesinin kendi işlem (transaction) API'sidir; tuval yalnız kullanıcının
 * niyetini o API'ye çevirir ve sonucu çizer. Modelin DOM'a bağlanmaması,
 * aynı belgenin sunucuda da derlenebilmesini sağlayan şeydir.
 *
 * SÜRÜKLEME TEK GERİ ALMA ADIMIDIR: fare basıldığında bir işlem açılır,
 * hareket boyunca aynı işlem yazılır, bırakıldığında kapanır. Her `mousemove`
 * için ayrı adım üretmek, Ctrl+Z'yi kullanılamaz hâle getirirdi.
 *
 * `innerHTML` KULLANILMAZ. Tüm düğümler `dom.js`'in `el()`iyle kurulur ve
 * kullanıcı içeriği yalnız `textContent` ile yazılır.
 */

import { el, clear } from '../lib/dom.js';

/** Boyutlandırma tutamaklarının yönleri. */
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Tutamak yönünün hangi kenarları değiştirdiği. */
const HANDLE_AXES = {
  nw: { x: -1, y: -1 }, n: { x: 0, y: -1 }, ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 }, se: { x: 1, y: 1 }, s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 }, w: { x: -1, y: 0 }
};

const MIN_SIZE = 4;   // punto — altına inince tutamaklar üst üste biner

export class SceneCanvas {
  /**
   * @param {HTMLElement} root
   * @param {Object} deps { Scene, geometry, units }
   */
  constructor(root, deps) {
    this.root = root;
    this.geometry = deps.geometry;
    this.units = deps.units;

    this.scene = null;
    this.pageIndex = 0;
    this.zoom = 1;
    this.gridStep = 0;          // 0 = ızgara kapalı
    this.snapEnabled = true;
    this.assetUrls = new Map();  // assetId → object URL
    /** Belgeye gömülmüş font aileleri (kullanıcının yüklediği). */
    this.embeddedFontFamilies = new Set();

    this.onSelectionChange = () => {};
    this.onChange = () => {};
    this.onDoubleClick = () => {};

    this._drag = null;
    this._els = new Map();       // nodeId → DOM elemanı

    this._buildChrome();
    this._bindEvents();
  }

  /* ---------------------------------------------------------------- */
  /* İskelet                                                           */
  /* ---------------------------------------------------------------- */

  _buildChrome() {
    this.surface = el('div', { class: 'sc-surface', tabindex: '0' });
    this.sheet = el('div', { class: 'sc-sheet' });
    this.overlay = el('div', { class: 'sc-overlay' });
    this.marquee = el('div', { class: 'sc-marquee is-hidden' });

    this.surface.appendChild(this.sheet);
    this.sheet.appendChild(this.overlay);
    this.overlay.appendChild(this.marquee);

    clear(this.root).appendChild(this.surface);
  }

  /* ---------------------------------------------------------------- */
  /* Bağlama                                                           */
  /* ---------------------------------------------------------------- */

  attach(scene) {
    this.scene = scene;
    this.pageIndex = 0;
    this.render();
  }

  get page() {
    return this.scene ? this.scene.pages[this.pageIndex] : null;
  }

  setPage(index) {
    if (!this.scene) return;
    this.pageIndex = Math.max(0, Math.min(this.scene.pages.length - 1, index));
    this.scene.selection.clear();
    this.render();
    this.onSelectionChange();
  }

  setZoom(zoom) {
    this.zoom = Math.max(0.15, Math.min(4, zoom));
    this.render();
  }

  /** Varlık kimliğini gösterilebilir bir adrese çevirir. */
  setAssetUrl(assetId, url) { this.assetUrls.set(assetId, url); }

  /* ---------------------------------------------------------------- */
  /* Çizim                                                             */
  /* ---------------------------------------------------------------- */

  render() {
    if (!this.scene) return;
    const page = this.scene.page;

    this.sheet.style.width = `${page.width * this.zoom}px`;
    this.sheet.style.height = `${page.height * this.zoom}px`;

    // Kenar boşluğu kılavuzu
    if (!this.marginBox) {
      this.marginBox = el('div', { class: 'sc-margin' });
      this.sheet.insertBefore(this.marginBox, this.overlay);
    }
    const m = page.margin;
    Object.assign(this.marginBox.style, {
      left: `${m.left * this.zoom}px`,
      top: `${m.top * this.zoom}px`,
      width: `${(page.width - m.left - m.right) * this.zoom}px`,
      height: `${(page.height - m.top - m.bottom) * this.zoom}px`
    });

    // Düğümler
    for (const node of this._els.keys()) {
      if (!this.scene.node(node)) {
        const dead = this._els.get(node);
        if (dead && dead.parentNode) dead.parentNode.removeChild(dead);
        this._els.delete(node);
      }
    }
    const current = this.page;
    if (!current) return;

    const seen = new Set();
    let order = 0;
    for (const node of current.nodes) {
      order = this._renderNode(node, [], order, seen);
    }
    for (const [id, node] of this._els) {
      if (!seen.has(id) && node.parentNode) {
        node.parentNode.removeChild(node);
        this._els.delete(id);
      }
    }

    this._renderSelection();
  }

  _renderNode(node, ancestry, order, seen) {
    const chain = [...ancestry, node];
    seen.add(node.id);

    const abs = this.geometry.absoluteFrame(chain);
    let box = this._els.get(node.id);
    if (!box) {
      box = el('div', { class: 'sc-node', 'data-id': node.id });
      this._els.set(node.id, box);
    }
    if (box.parentNode !== this.sheet) this.sheet.insertBefore(box, this.overlay);

    box.dataset.type = node.type;
    box.classList.toggle('is-locked', !!node.locked);
    box.classList.toggle('is-hidden-node', !!node.hidden);

    Object.assign(box.style, {
      left: `${abs.x * this.zoom}px`,
      top: `${abs.y * this.zoom}px`,
      width: `${abs.width * this.zoom}px`,
      height: `${abs.height * this.zoom}px`,
      opacity: String(node.hidden ? 0.25 : node.opacity),
      transform: abs.rotation ? `rotate(${abs.rotation}deg)` : '',
      zIndex: String(++order)
    });

    this._paint(box, node, abs);

    if (node.type === 'group') {
      for (const child of node.children || []) {
        order = this._renderNode(child, chain, order, seen);
      }
    }
    return order;
  }

  /** Düğümün görünüşünü kurar — her seferinde baştan, ama YALNIZ içeriği. */
  _paint(box, node, abs) {
    clear(box);
    box.className = `sc-node sc-node--${node.type}` +
      (node.locked ? ' is-locked' : '') + (node.hidden ? ' is-hidden-node' : '');

    switch (node.type) {
      case 'rect':
      case 'ellipse': {
        const shape = el('div', { class: 'sc-shape' });
        Object.assign(shape.style, {
          background: node.fill || 'transparent',
          border: node.stroke && node.strokeWidth
            ? `${Math.max(1, node.strokeWidth * this.zoom)}px solid ${node.stroke}` : 'none',
          borderRadius: node.type === 'ellipse'
            ? '50%' : `${(node.radius || 0) * this.zoom}px`
        });
        box.appendChild(shape);
        break;
      }

      case 'line': {
        const len = Math.hypot(abs.width, abs.height) * this.zoom;
        const angle = (Math.atan2(abs.height, abs.width) * 180) / Math.PI;
        const line = el('div', { class: 'sc-line' });
        Object.assign(line.style, {
          width: `${len}px`,
          borderTop: `${Math.max(1, node.strokeWidth * this.zoom)}px ` +
            `${node.dash === 'solid' ? 'solid' : node.dash} ${node.stroke}`,
          transform: `rotate(${angle}deg)`,
          transformOrigin: '0 0'
        });
        box.appendChild(line);
        break;
      }

      case 'text': {
        const inner = el('div', { class: 'sc-text' });
        Object.assign(inner.style, {
          // Aile adı doğrudan CSS'e girmez; süzülüp tırnaklanır.
          fontFamily: cssFontFamily(node.fontFamily),
          fontSize: `${node.fontSize * this.zoom}px`,
          lineHeight: String(node.lineHeight),
          color: node.color,
          textAlign: node.align,
          fontWeight: node.bold ? '700' : '400',
          fontStyle: node.italic ? 'italic' : 'normal',
          letterSpacing: `${(node.letterSpacing || 0) * this.zoom}px`,
          padding: `${(node.padding || 0) * this.zoom}px`,
          justifyContent: node.valign === 'middle' ? 'center'
            : node.valign === 'bottom' ? 'flex-end' : 'flex-start'
        });
        // Kullanıcı metni YALNIZCA textContent ile yazılır
        inner.appendChild(el('span', { text: textOf(node) }));
        box.appendChild(inner);
        break;
      }

      case 'image': {
        const url = this.assetUrls.get(node.assetId);
        if (url) {
          box.appendChild(el('img', {
            class: 'sc-img', src: url, alt: node.alt || '',
            style: { objectFit: node.fit === 'fill' ? 'fill' : node.fit }
          }));
        } else {
          box.appendChild(el('div', { class: 'sc-placeholder', text: 'görsel' }));
        }
        break;
      }

      case 'qr':
        box.appendChild(el('div', { class: 'sc-placeholder sc-placeholder--qr', text: 'karekod' }));
        break;

      case 'signature':
        box.appendChild(el('div', { class: 'sc-slot' }, [
          el('span', { class: 'sc-slot__label', text: node.label || 'İmza' }),
          node.signerTitle
            ? el('span', { class: 'sc-slot__role', text: node.signerTitle })
            : null
        ]));
        break;

      case 'group':
        box.appendChild(el('div', { class: 'sc-group' }));
        break;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Seçim göstergesi                                                  */
  /* ---------------------------------------------------------------- */

  _renderSelection() {
    for (const [id, box] of this._els) {
      box.classList.toggle('is-selected', this.scene.selection.has(id));
    }

    if (!this.handleLayer) {
      this.handleLayer = el('div', { class: 'sc-handles is-hidden' });
      this.overlay.appendChild(this.handleLayer);
    }

    const ids = [...this.scene.selection];
    if (!ids.length) {
      this.handleLayer.classList.add('is-hidden');
      return;
    }

    const frames = ids.map((id) => this.scene.absoluteFrame(id)).filter(Boolean);
    if (!frames.length) {
      this.handleLayer.classList.add('is-hidden');
      return;
    }
    const box = frames.reduce((acc, f) => this.geometry.union(acc, f), null);

    this.handleLayer.classList.remove('is-hidden');
    Object.assign(this.handleLayer.style, {
      left: `${box.x * this.zoom}px`,
      top: `${box.y * this.zoom}px`,
      width: `${box.width * this.zoom}px`,
      height: `${box.height * this.zoom}px`
    });

    clear(this.handleLayer);
    // Kilitli nesne boyutlandırılamaz: tutamak göstermek yalancı bir vaattir
    const locked = ids.some((id) => { const n = this.scene.node(id); return n && n.locked; });
    if (!locked) {
      for (const dir of HANDLES) {
        this.handleLayer.appendChild(
          el('div', { class: `sc-handle sc-handle--${dir}`, 'data-handle': dir }));
      }
    }
  }

  /** Kılavuz çizgilerini gösterir (yapışma sırasında). */
  _showGuides(guides) {
    if (!this.guideLayer) {
      this.guideLayer = el('div', { class: 'sc-guides' });
      this.overlay.appendChild(this.guideLayer);
    }
    clear(this.guideLayer);
    for (const g of guides || []) {
      this.guideLayer.appendChild(el('div', {
        class: `sc-guide sc-guide--${g.axis}`,
        style: g.axis === 'x'
          ? { left: `${g.at * this.zoom}px` }
          : { top: `${g.at * this.zoom}px` }
      }));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Girdi                                                             */
  /* ---------------------------------------------------------------- */

  _bindEvents() {
    this.surface.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    window.addEventListener('pointermove', (e) => this._onPointerMove(e));
    window.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this.surface.addEventListener('dblclick', (e) => {
      const hit = e.target.closest('.sc-node');
      if (hit) this.onDoubleClick(hit.dataset.id);
    });
    this.surface.addEventListener('keydown', (e) => this._onKeyDown(e));
  }

  /** Ekran noktasını sayfa koordinatına çevirir. */
  _toPage(event) {
    const rect = this.sheet.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / this.zoom,
      y: (event.clientY - rect.top) / this.zoom
    };
  }

  _onPointerDown(event) {
    if (!this.scene || event.button !== 0) return;
    // `preventScroll`: odak vermek tuvali kaydırmamalı. Kullanıcı bir nesneye
    // tıkladığında sayfanın altından zıplaması, sürüklemeyi imkânsız kılar.
    this.surface.focus({ preventScroll: true });

    const handle = event.target.closest('.sc-handle');
    const point = this._toPage(event);

    if (handle) {
      this._beginResize(handle.dataset.handle, point);
      event.preventDefault();
      return;
    }

    const hit = event.target.closest('.sc-node');
    if (!hit) {
      if (!event.shiftKey) this.scene.selection.clear();
      this._beginMarquee(point);
      this._renderSelection();
      this.onSelectionChange();
      return;
    }

    // Grup içindeki bir çocuğa tıklamak GRUBU seçer; Alt ile derine inilir
    const id = event.altKey ? hit.dataset.id : this._outermost(hit.dataset.id);
    const node = this.scene.node(id);
    if (!node) return;

    if (event.shiftKey) {
      if (this.scene.selection.has(id)) this.scene.selection.delete(id);
      else this.scene.selection.add(id);
    } else if (!this.scene.selection.has(id)) {
      this.scene.selection.clear();
      this.scene.selection.add(id);
    }

    this._renderSelection();
    this.onSelectionChange();

    if (!node.locked) this._beginMove(point);
    event.preventDefault();
  }

  /** Düğümün en dıştaki grup atasını bulur. */
  _outermost(nodeId) {
    const hit = this.scene.find(nodeId);
    if (!hit || hit.ancestry.length < 2) return nodeId;
    return hit.ancestry[0].id;
  }

  _beginMove(point) {
    const ids = [...this.scene.selection].filter((id) => {
      const n = this.scene.node(id);
      return n && !n.locked;
    });
    if (!ids.length) return;

    // TEK işlem açılır ve sürükleme boyunca açık kalır
    this.scene.history.begin('Taşı');
    this._drag = {
      kind: 'move', start: point, ids,
      origin: ids.map((id) => ({ id, frame: { ...this.scene.node(id).frame } })),
      moved: false
    };
  }

  _beginResize(dir, point) {
    const ids = [...this.scene.selection].filter((id) => {
      const n = this.scene.node(id);
      return n && !n.locked;
    });
    if (!ids.length) return;

    this.scene.history.begin('Boyutlandır');
    this._drag = {
      kind: 'resize', dir, start: point, ids,
      origin: ids.map((id) => ({ id, frame: { ...this.scene.node(id).frame } })),
      moved: false
    };
  }

  _beginMarquee(point) {
    this._drag = { kind: 'marquee', start: point, moved: false };
    this.marquee.classList.remove('is-hidden');
  }

  _onPointerMove(event) {
    if (!this._drag) return;
    const point = this._toPage(event);
    const dx = point.x - this._drag.start.x;
    const dy = point.y - this._drag.start.y;
    this._drag.moved = Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5;

    if (this._drag.kind === 'marquee') return this._updateMarquee(point);
    if (this._drag.kind === 'move') return this._updateMove(dx, dy, event);
    if (this._drag.kind === 'resize') return this._updateResize(dx, dy, event);
  }

  _updateMove(dx, dy, event) {
    const primary = this._drag.origin[0];
    let offsetX = dx;
    let offsetY = dy;
    let guides = [];

    // Shift: eksene kilitle — küçük bir sapma yüzünden hizayı bozmasın
    if (event.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) offsetY = 0; else offsetX = 0;
    }

    if (this.gridStep > 0) {
      offsetX = this.geometry.snapToGrid(primary.frame.x + offsetX, this.gridStep) - primary.frame.x;
      offsetY = this.geometry.snapToGrid(primary.frame.y + offsetY, this.gridStep) - primary.frame.y;
    } else if (this.snapEnabled && !event.altKey) {
      const moving = new Set(this._drag.ids);
      const others = this._siblingFrames(moving);
      const target = {
        x: primary.frame.x + offsetX, y: primary.frame.y + offsetY,
        width: primary.frame.width, height: primary.frame.height
      };
      const snapped = this.geometry.snap(target, others, this.scene.page, { threshold: 4 / this.zoom });
      offsetX += snapped.x - target.x;
      offsetY += snapped.y - target.y;
      guides = snapped.guides;
    }

    for (const o of this._drag.origin) {
      this.scene.updateNode(o.id, {
        frame: {
          x: this.units.round(o.frame.x + offsetX),
          y: this.units.round(o.frame.y + offsetY)
        }
      });
    }
    this._showGuides(guides);
    this.render();
  }

  _updateResize(dx, dy, event) {
    const axes = HANDLE_AXES[this._drag.dir];

    for (const o of this._drag.origin) {
      let { x, y, width, height } = o.frame;

      if (axes.x > 0) width = Math.max(MIN_SIZE, o.frame.width + dx);
      else if (axes.x < 0) {
        width = Math.max(MIN_SIZE, o.frame.width - dx);
        x = o.frame.x + (o.frame.width - width);
      }

      if (axes.y > 0) height = Math.max(MIN_SIZE, o.frame.height + dy);
      else if (axes.y < 0) {
        height = Math.max(MIN_SIZE, o.frame.height - dy);
        y = o.frame.y + (o.frame.height - height);
      }

      // Shift: en-boy oranını koru
      if (event.shiftKey && axes.x && axes.y && o.frame.height) {
        const ratio = o.frame.width / o.frame.height;
        height = width / ratio;
        if (axes.y < 0) y = o.frame.y + (o.frame.height - height);
      }

      this.scene.updateNode(o.id, {
        frame: {
          x: this.units.round(x), y: this.units.round(y),
          width: this.units.round(width), height: this.units.round(height)
        }
      });
    }
    this.render();
  }

  _updateMarquee(point) {
    const x = Math.min(point.x, this._drag.start.x);
    const y = Math.min(point.y, this._drag.start.y);
    const width = Math.abs(point.x - this._drag.start.x);
    const height = Math.abs(point.y - this._drag.start.y);

    Object.assign(this.marquee.style, {
      left: `${x * this.zoom}px`, top: `${y * this.zoom}px`,
      width: `${width * this.zoom}px`, height: `${height * this.zoom}px`
    });
    this._drag.rect = { x, y, width, height };
  }

  _onPointerUp() {
    if (!this._drag) return;
    const drag = this._drag;
    this._drag = null;
    this._showGuides([]);

    if (drag.kind === 'marquee') {
      this.marquee.classList.add('is-hidden');
      if (drag.rect && drag.moved) this._selectInRect(drag.rect);
      return;
    }

    // İşlem burada kapanır: bütün sürükleme TEK adım olur
    this.scene.history.commit();
    if (drag.moved) this.onChange();
    this._renderSelection();
    this.onSelectionChange();
  }

  _selectInRect(rect) {
    const page = this.page;
    if (!page) return;
    for (const node of page.nodes) {
      const abs = this.scene.absoluteFrame(node.id);
      if (abs && this.geometry.intersects(rect, abs)) this.scene.selection.add(node.id);
    }
    this._renderSelection();
    this.onSelectionChange();
  }

  /** Yapışma hedefi olacak diğer düğümlerin çerçeveleri. */
  _siblingFrames(exclude) {
    const page = this.page;
    if (!page) return [];
    const out = [];
    for (const node of page.nodes) {
      if (exclude.has(node.id) || node.hidden) continue;
      const abs = this.scene.absoluteFrame(node.id);
      if (abs) out.push(abs);
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Klavye                                                            */
  /* ---------------------------------------------------------------- */

  _onKeyDown(event) {
    if (!this.scene) return;
    const ids = [...this.scene.selection];
    const mod = event.ctrlKey || event.metaKey;

    // Ok tuşları: 1pt, Shift ile 10pt. Ardışık basışlar TEK adımda birleşir.
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[event.key] && ids.length) {
      const [ax, ay] = arrows[event.key];
      const step = event.shiftKey ? 10 : 1;
      this.scene.transaction('Kaydır', () => {
        for (const id of ids) this.scene.moveNode(id, ax * step, ay * step);
      }, { mergeKey: 'nudge' });
      this.render();
      this.onChange();
      event.preventDefault();
      return;
    }

    if ((event.key === 'Delete' || event.key === 'Backspace') && ids.length) {
      this.scene.transaction('Sil', () => {
        for (const id of ids) this.scene.removeNode(id);
      });
      this.scene.selection.clear();
      this.render();
      this.onSelectionChange();
      this.onChange();
      event.preventDefault();
      return;
    }

    if (mod && event.key.toLowerCase() === 'z') {
      if (event.shiftKey) this.scene.redo(); else this.scene.undo();
      this.render();
      this.onSelectionChange();
      this.onChange();
      event.preventDefault();
      return;
    }

    if (mod && event.key.toLowerCase() === 'y') {
      this.scene.redo();
      this.render();
      this.onChange();
      event.preventDefault();
      return;
    }

    if (mod && event.key.toLowerCase() === 'a') {
      const page = this.page;
      if (page) for (const node of page.nodes) this.scene.selection.add(node.id);
      this._renderSelection();
      this.onSelectionChange();
      event.preventDefault();
      return;
    }

    if (mod && event.key.toLowerCase() === 'g' && ids.length > 1) {
      this.scene.transaction('Gruplandır', () => this.scene.group(ids));
      this.render();
      this.onSelectionChange();
      this.onChange();
      event.preventDefault();
      return;
    }

    if (mod && event.shiftKey && event.key.toLowerCase() === 'g' && ids.length === 1) {
      this.scene.transaction('Grubu çöz', () => this.scene.ungroup(ids[0]));
      this.render();
      this.onSelectionChange();
      this.onChange();
      event.preventDefault();
      return;
    }

    if (mod && event.key.toLowerCase() === 'd' && ids.length) {
      this.scene.transaction('Çoğalt', () => this.scene.duplicate(ids));
      this.render();
      this.onSelectionChange();
      this.onChange();
      event.preventDefault();
      return;
    }

    if (event.key === 'Escape') {
      this.scene.selection.clear();
      this._renderSelection();
      this.onSelectionChange();
    }
  }

  /** Pano işlemleri — dışarıdan çağrılır (kopyala/kes/yapıştır kısayolları). */
  copySelection() {
    const ids = [...this.scene.selection];
    return ids.length ? this.scene.copy(ids) : null;
  }

  pasteClip(clip) {
    if (!clip) return;
    this.scene.transaction('Yapıştır', () => {
      this.scene.paste(clip, { pageId: this.page.id });
    });
    this.render();
    this.onSelectionChange();
    this.onChange();
  }
}

/**
 * Font ailesini CSS'e güvenli biçimde koyar.
 *
 * `style.fontFamily`e ham dizge yazmak, tırnak kapatıp yeni bildirim açmaya
 * izin verir. Harf, rakam, boşluk, tire ve alt çizgi dışındaki her şey atılır.
 * (Aynı kural sunucudaki HTML derleyicisinde de uygulanır.)
 */
function cssFontFamily(family) {
  const clean = String(family || '').replace(/[^A-Za-z0-9 _-]/g, '').trim();
  return clean ? `"${clean}", sans-serif` : 'sans-serif';
}

/** Düğümün görüntülenecek metni — koşular varsa birleştirilir. */
function textOf(node) {
  if (Array.isArray(node.runs) && node.runs.length) {
    return node.runs.map((r) => r.text).join('');
  }
  return node.text || '';
}
