/**
 * Görsel editör denetleyicisi.
 *
 * Tuval, özellik paneli, araç çubuğu ve sunucu arasındaki bağ. Modelin
 * kendisi `@fitfak/pdf-scene`ten gelir ve sunucudaki derleyicilerle AYNI
 * kaynaktır — paket `/vendor/scene.esm.js` adresinden anında üretilir.
 *
 * PDF ÜRETİMİ SUNUCUDA yapılır. Tuval bir ÖNİZLEMEDİR; gerçek çıktı
 * sahnenin kendisinden derlenir. Tarayıcının yerleşimini gerçek sayıp
 * PDF'i ona benzetmeye çalışmak, iki motorun sonsuza dek birbirini
 * kovalaması demek olurdu.
 */

import { el, clear, $ } from '../lib/dom.js';
import { SceneCanvas } from './canvas.js';
import { Inspector } from './inspector.js';

/** Yeni nesnelerin varsayılan ölçüleri (punto). */
const PRESETS = {
  text: { width: 220, height: 40, text: 'Metin', fontSize: 12 },
  rect: { width: 160, height: 90, fill: '#1f3a63', radius: 4 },
  ellipse: { width: 120, height: 120, fill: '#e8eef7', stroke: '#1f3a63', strokeWidth: 1 },
  line: { width: 200, height: 0, stroke: '#8b93a7', strokeWidth: 1 },
  qr: { width: 100, height: 100, payload: 'https://trust.fitfak.net' },
  signature: { width: 200, height: 70, label: 'İmza', showFrame: true }
};

export class SceneEditor {
  /**
   * @param {Object} o
   * @param {HTMLElement} o.canvasRoot
   * @param {HTMLElement} o.inspectorRoot
   * @param {HTMLElement} o.toolbarRoot
   * @param {HTMLElement} o.pagesRoot
   * @param {Function} o.onStatus (message, kind) => void
   * @param {Object} o.api sunucu istemcisi
   */
  constructor(o) {
    this.opts = o;
    this.lib = null;         // sahne paketi (tembel yüklenir)
    this.canvas = null;
    this.inspector = null;
    this.clipboard = null;
    this.assets = new Map(); // assetId → { meta, bytes(Uint8Array), url }
    this.dirty = false;
    this.lastPdf = null;
  }

  /* ---------------------------------------------------------------- */
  /* Kurulum                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Sahne paketini yükler ve editörü kurar.
   *
   * Tembel yükleme bilinçli: kullanıcı "Tasarım" sekmesine hiç girmezse
   * 78 KB'lık paket hiç indirilmez.
   */
  async init() {
    if (this.lib) return;
    this.lib = await import('/vendor/scene.esm.js');

    this.canvas = new SceneCanvas(this.opts.canvasRoot, {
      Scene: this.lib.Scene,
      geometry: this.lib.geometry,
      units: this.lib.units
    });
    this.inspector = new Inspector(this.opts.inspectorRoot, this.canvas, {
      // Rol tabloları ŞEMADAN gelir. Panelde ikinci bir liste tutmak,
      // panelin "P" deyip derleyicinin "Figure" ürettiği güne kadar
      // fark edilmez.
      structRoles: this.lib.STRUCT_ROLES,
      roleDefaults: this.lib.DEFAULT_ROLE
    });

    this.canvas.onSelectionChange = () => this.inspector.render();
    // Tuval kendi başına da yakınlaşabilir (parmakla sıkıştırma, Ctrl+tekerlek);
    // kutudaki sayı gerçeği göstermelidir.
    this.canvas.onZoom = (zoom) => {
      if (this._zoomInput) this._zoomInput.value = String(Math.round(zoom * 100));
    };
    this.canvas.onChange = () => this._touched();
    this.canvas.onDoubleClick = (id) => this._editText(id);
    this.inspector.onChange = () => { this._touched(); this._renderPages(); };

    this._buildToolbar();
    this._bindClipboard();

    // Seçilebilir fontları sunucudan öğren: kullanıcı olmayan bir aileyi
    // yazıp belgeyi sessizce başka fontla ürettirmesin.
    try {
      const health = await this.opts.api.health();
      this.inspector.setFontFamilies((health.fonts || []).map((f) => f.family));
    } catch {
      this.inspector.setFontFamilies([]);
    }

    this.newDocument();
  }

  newDocument() {
    const scene = this.lib.Scene.blank({
      title: 'Yeni belge',
      margin: { top: 56.7, right: 51, bottom: 56.7, left: 51 }
    });
    this.assets.clear();
    this.lastPdf = null;
    this.dirty = false;
    this.canvas.attach(scene);
    this.inspector.render();
    this._renderPages();
    this._status('Boş belge hazır');
  }

  /** Sunucudan gelen sahneyi yükler (içe aktarma). */
  loadScene(sceneJson, assetList = []) {
    this._releaseAssets();

    for (const a of assetList) {
      const bytes = base64ToBytes(a.base64);
      const url = a.kind === 'font'
        ? null
        : URL.createObjectURL(new Blob([bytes], { type: a.mime }));
      this.assets.set(a.id, { meta: a, bytes, url });
      if (url) this.canvas.setAssetUrl(a.id, url);
      if (a.kind === 'font') {
        try {
          const info = this.lib.readFontInfo(bytes);
          this.canvas.embeddedFontFamilies.add(info.family);
          this._installFontFace(info.family, bytes);
        } catch { /* bozuk font: derleyici uyaracak */ }
      }
    }

    const scene = this.lib.Scene.fromJSON(sceneJson);
    this.canvas.attach(scene);
    this.inspector.render();
    this._renderPages();
    this.dirty = true;
    this.lastPdf = null;
  }

  get scene() { return this.canvas ? this.canvas.scene : null; }

  /* ---------------------------------------------------------------- */
  /* Araç çubuğu                                                       */
  /* ---------------------------------------------------------------- */

  _buildToolbar() {
    const bar = clear(this.opts.toolbarRoot);

    const add = (type, label) => el('button', {
      class: 'btn btn--sm', type: 'button', text: label,
      title: `${label} ekle`,
      onclick: () => this.addNode(type)
    });

    bar.appendChild(el('div', { class: 'sc-tools' }, [
      add('text', 'Metin'),
      add('rect', 'Kutu'),
      add('ellipse', 'Elips'),
      add('line', 'Çizgi'),
      add('qr', 'Karekod'),
      add('signature', 'İmza yuvası'),
      el('label', { class: 'btn btn--sm sc-tools__file' }, [
        'Görsel',
        el('input', {
          type: 'file', accept: 'image/png,image/jpeg', hidden: true,
          onchange: (e) => { this._addImage(e.target.files[0]); e.target.value = ''; }
        })
      ]),
      el('label', {
        class: 'btn btn--sm sc-tools__file',
        title: 'Kendi fontunuzu belgeye gömün (TTF/OTF)'
      }, [
        'Font',
        el('input', {
          type: 'file', accept: '.ttf,.otf,font/ttf,font/otf', hidden: true,
          onchange: (e) => { this._addFont(e.target.files[0]); e.target.value = ''; }
        })
      ])
    ]));

    bar.appendChild(el('div', { class: 'sc-tools sc-tools--right' }, [
      el('button', {
        class: 'btn btn--sm', type: 'button', text: 'Geri al', title: 'Ctrl+Z',
        onclick: () => { this.scene.undo(); this._refreshAll(); }
      }),
      el('button', {
        class: 'btn btn--sm', type: 'button', text: 'Yinele', title: 'Ctrl+Shift+Z',
        onclick: () => { this.scene.redo(); this._refreshAll(); }
      }),
      el('label', { class: 'check check--inline' }, [
        el('input', {
          type: 'checkbox', checked: true,
          onchange: (e) => { this.canvas.snapEnabled = e.target.checked; }
        }),
        el('span', { text: 'Yapış' })
      ]),
      el('label', { class: 'field field--inline' }, [
        el('span', { class: 'field__label', text: 'Izgara' }),
        el('input', {
          class: 'input input--num', type: 'number', min: 0, max: 72, step: 1, value: '0',
          onchange: (e) => { this.canvas.gridStep = Math.max(0, Number(e.target.value) || 0); }
        })
      ]),
      el('label', { class: 'field field--inline' }, [
        el('span', { class: 'field__label', text: 'Yakınlık' }),
        (this._zoomInput = el('input', {
          class: 'input input--num', type: 'number', min: 15, max: 400, step: 25, value: '100',
          onchange: (e) => this.canvas.setZoom((Number(e.target.value) || 100) / 100)
        }))
      ])
    ]));
  }

  _renderPages() {
    const root = clear(this.opts.pagesRoot);
    if (!this.scene) return;

    this.scene.pages.forEach((page, index) => {
      root.appendChild(el('button', {
        class: 'sc-page' + (index === this.canvas.pageIndex ? ' is-active' : ''),
        type: 'button', text: String(index + 1), title: page.name,
        onclick: () => { this.canvas.setPage(index); this._renderPages(); this.inspector.render(); }
      }));
    });

    root.appendChild(el('button', {
      class: 'sc-page sc-page--add', type: 'button', text: '+', title: 'Sayfa ekle',
      onclick: () => {
        this.scene.transaction('Sayfa ekle', () => this.scene.addPage({}));
        this.canvas.setPage(this.scene.pages.length - 1);
        this._renderPages();
        this._touched();
      }
    }));

    if (this.scene.pages.length > 1) {
      root.appendChild(el('button', {
        class: 'sc-page sc-page--del', type: 'button', text: '−', title: 'Bu sayfayı sil',
        onclick: () => {
          const page = this.canvas.page;
          this.scene.transaction('Sayfa sil', () => this.scene.removePage(page.id));
          this.canvas.setPage(Math.max(0, this.canvas.pageIndex - 1));
          this._renderPages();
          this._touched();
        }
      }));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Nesne ekleme                                                      */
  /* ---------------------------------------------------------------- */

  addNode(type, extra = {}) {
    const page = this.scene.page;
    const preset = PRESETS[type] || {};
    // Yeni nesne sayfanın ORTASINA gelir: köşeye koymak, kullanıcıyı her
    // seferinde sürüklemeye zorlar.
    const width = extra.width || preset.width || 120;
    const height = extra.height || preset.height || 40;

    const node = this.lib.Scene.createNode(type, {
      ...preset, ...extra,
      x: Math.round((page.width - width) / 2),
      y: Math.round((page.height - height) / 2),
      width, height
    });

    this.scene.transaction(`${type} ekle`, () => {
      this.scene.addNode(node, { pageId: this.canvas.page.id });
    });
    this.scene.selection.clear();
    this.scene.selection.add(node.id);
    this._refreshAll();
    return node;
  }

  async _addImage(file) {
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const meta = this.scene.assets.add(bytes, { name: file.name });

      if (!this.assets.has(meta.id)) {
        const url = URL.createObjectURL(new Blob([bytes], { type: meta.mime }));
        this.assets.set(meta.id, { meta, bytes, url });
        this.canvas.setAssetUrl(meta.id, url);
      }

      // En-boy oranını koruyarak makul bir başlangıç boyu
      const maxSide = 200;
      const ratio = meta.width && meta.height ? meta.width / meta.height : 1;
      const width = ratio >= 1 ? maxSide : maxSide * ratio;
      const height = ratio >= 1 ? maxSide / ratio : maxSide;

      this.addNode('image', { assetId: meta.id, width, height, alt: file.name });
      this._status(`${file.name} eklendi`);
    } catch (err) {
      this._status(`Görsel eklenemedi: ${err.message}`, 'error');
    }
  }

  /**
   * Kullanıcının kendi fontunu belgeye gömer.
   *
   * Aile adı DOSYA ADINDAN değil, fontun kendi `name` tablosundan okunur —
   * sunucu da aynı şeyi yapar, iki taraf aynı adı görür.
   */
  async _addFont(file) {
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const meta = this.scene.assets.add(bytes, { name: file.name, kind: 'font' });

      // Aile adı fontun KENDİ `name` tablosundan okunur — sunucu da aynı
      // kodu çalıştırır, iki taraf aynı adı görür. Dosya adına bakmak,
      // tuvalde "Ubuntu" yazan bir düğümün sunucuda bulunamaması demekti.
      const info = this.lib.readFontInfo(bytes);
      this.canvas.embeddedFontFamilies.add(info.family);
      this.assets.set(meta.id, { meta, bytes, url: null });

      // Tuvalde de gerçekten o fontla görünsün
      await this._installFontFace(info.family, bytes);

      this.inspector.render();
      this._touched();
      this._status(`"${info.family}" gömüldü`);
    } catch (err) {
      this._status(`Font eklenemedi: ${err.message}`, 'error');
    }
  }

  /** Fontu tarayıcıya tanıtır ki tuval önizlemesi doğru görünsün. */
  async _installFontFace(family, bytes) {
    if (typeof FontFace === 'undefined' || !document.fonts) return;
    try {
      const face = new FontFace(family, bytes.buffer.slice(
        bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      await face.load();
      document.fonts.add(face);
    } catch {
      // Tarayıcı fontu çizemiyorsa da PDF tarafı çalışmaya devam eder;
      // yalnız önizleme yedek fontla görünür.
      this._status(`"${family}" tuvalde gösterilemiyor ama PDF'e gömülecek`, 'warn');
    }
  }

  /** Çift tıklamada metni düzenlemek için paneldeki alana odaklanır. */
  _editText(nodeId) {
    const node = this.scene.node(nodeId);
    if (!node || node.type !== 'text') return;
    this.scene.selection.clear();
    this.scene.selection.add(nodeId);
    this.inspector.render();
    const area = this.opts.inspectorRoot.querySelector('textarea');
    if (area) { area.focus(); area.select(); }
  }

  /* ---------------------------------------------------------------- */
  /* Pano                                                              */
  /* ---------------------------------------------------------------- */

  _bindClipboard() {
    document.addEventListener('keydown', (e) => {
      if (!this.scene || !this.opts.isActive()) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      // Bir metin kutusunda yazarken pano kısayolları TARAYICININ olsun
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      const key = e.key.toLowerCase();
      if (key === 'c') {
        this.clipboard = this.canvas.copySelection();
        if (this.clipboard) this._status(`${this.clipboard.nodes.length} nesne kopyalandı`);
        e.preventDefault();
      } else if (key === 'x') {
        this.clipboard = this.canvas.copySelection();
        if (this.clipboard) {
          const ids = [...this.scene.selection];
          this.scene.transaction('Kes', () => { for (const id of ids) this.scene.removeNode(id); });
          this._refreshAll();
        }
        e.preventDefault();
      } else if (key === 'v') {
        this.canvas.pasteClip(this.clipboard);
        this._syncAssetUrls();
        this.inspector.render();
        e.preventDefault();
      }
    });
  }

  /** Yapıştırma sonrası yeni varlıklar için görüntüleme adresi üretir. */
  _syncAssetUrls() {
    for (const meta of this.scene.assets.manifest()) {
      if (this.assets.has(meta.id)) continue;
      const bytes = this.scene.assets.bytes(meta.id);
      if (!bytes) continue;

      // Fontlar `<img src>` ile gösterilmez; onlara nesne adresi gerekmez.
      const url = meta.kind === 'image'
        ? URL.createObjectURL(new Blob([bytes], { type: meta.mime }))
        : null;

      this.assets.set(meta.id, { meta, bytes, url });
      if (url) this.canvas.setAssetUrl(meta.id, url);
      if (meta.kind === 'font') {
        try {
          const info = this.lib.readFontInfo(bytes);
          this.canvas.embeddedFontFamilies.add(info.family);
          this._installFontFace(info.family, bytes);
        } catch { /* bozuk font: derleyici uyaracak */ }
      }
    }
    this.canvas.render();
  }

  /* ---------------------------------------------------------------- */
  /* Sunucu                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Sahneyi sunucuda PDF'e derler.
   *
   * Varlık baytları sahnenin dışında, ayrı bir dizide gider: on yerde
   * kullanılan bir görsel bir kez taşınır.
   */
  async renderPdf(options = {}) {
    const payload = {
      scene: this.scene.toJSON(),
      assets: [...this.assets.values()].map(({ meta, bytes }) => ({
        id: meta.id, name: meta.name, base64: bytesToBase64(bytes)
      })),
      // Uyum profili İSTEĞE bağlıdır ve istenmeden iddia edilmez:
      // etiketsiz bir belgeye "PDF/UA" damgası vurmak yalan olurdu.
      conformance: options.conformance || null
    };

    const result = await this.opts.api.sceneRender(payload);
    this.lastPdf = base64ToBytes(result.pdf);
    this.dirty = false;
    return result;
  }

  /* ---------------------------------------------------------------- */
  /* Yardımcılar                                                       */
  /* ---------------------------------------------------------------- */

  _refreshAll() {
    this.canvas.render();
    this.inspector.render();
    this._renderPages();
    this._touched();
  }

  _touched() {
    this.dirty = true;
    const peek = this.scene ? this.scene.history.peek() : null;
    this._status(peek && peek.undo ? `Son işlem: ${peek.undo}` : 'Hazır');
  }

  _status(message, kind = 'ok') {
    if (this.opts.onStatus) this.opts.onStatus(message, kind);
  }

  _releaseAssets() {
    for (const a of this.assets.values()) if (a.url) URL.revokeObjectURL(a.url);
    this.assets.clear();
    this.canvas.embeddedFontFamilies.clear();
  }
}

/* ------------------------------------------------------------------ */
/* Base64 — büyük diziler için parça parça                             */
/* ------------------------------------------------------------------ */

function bytesToBase64(bytes) {
  // `String.fromCharCode(...bytes)` büyük dosyalarda yığını taşırır
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
