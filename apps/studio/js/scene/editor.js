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
import { CollabClient } from './collab.js';

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
    /**
     * VARLIK BAYTLARININ TEK SAHİBİ `scene.assets`tir (AssetManager).
     *
     * Burada yalnız GÖSTERİM adresleri tutulur: `<img src>` bir Uint8Array
     * alamaz, nesne adresi ister. Baytları ikinci bir haritada da tutmak
     * iki gerçek kaynağı demekti ve öyleydi: içe aktarılan sahnede baytlar
     * yalnız editörün haritasındaydı, `scene.assets` boştu — kopyala/yapıştır
     * varlığı bulamıyor, dışa aktarma varlığı kaybediyordu.
     *
     * @type {Map<string, string>} assetId → object URL
     */
    this.assetUrls = new Map();
    /**
     * Gösterime HAZIRLANMIŞ varlıklar.
     *
     * Fontlar nesne adresi almaz (bir `<img src>` değildir) ama yine de bir
     * kez işlenmelidir: `FontFace` kurulumu ve aile adı okuma. Yalnız
     * `assetUrls`e bakmak, her eşitlemede her fontu yeniden çözmek demekti.
     *
     * @type {Set<string>}
     */
    this._preparedAssets = new Set();
    this.dirty = false;
    this.lastPdf = null;
    /** Son içe aktarmanın belge çözümlemesi (varsa). */
    this.analysis = null;

    /**
     * Ortak düzenleme.
     *
     * Kapalıyken hiçbir maliyeti yoktur: kaydedici kurulmaz, istek gitmez.
     * Açıldığında sahnenin ürettiği işlemler sunucuya, sunucudan gelenler
     * sahneye akar.
     */
    this.collab = null;
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
    this.canvas.onPageChange = () => {
      this._renderPages();
      if (this.onPageChange) this.onPageChange(this.currentPage);
    };
    this.canvas.onChange = () => this._touched();
    this.canvas.onDoubleClick = (id) => this._editText(id);
    this.inspector.onChange = () => { this._touched(); this._renderPages(); };

    this.collab = new CollabClient({
      api: this.opts.api,
      onRemote: (ops) => this._applyRemote(ops),
      onPeers: (peers) => this._renderPeers(peers),
      onStatus: (message, kind) => this._status(message, kind),
      onConflict: (overwritten) => this._reportConflict(overwritten)
    });

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
    this._releaseAssets();
    this.analysis = null;
    this.lastPdf = null;
    this.dirty = false;
    this.canvas.attach(scene);
    this.inspector.render();
    this._renderPages();
    this._status('Boş belge hazır');
  }

  /**
   * Sunucudan gelen sahneyi yükler (içe aktarma).
   *
   * Varlıklar sahnenin KENDİ yöneticisine yazılır; editör yalnız gösterim
   * adreslerini üretir. Kimlik baytlardan türediği için sunucunun verdiği
   * kimlikle burada hesaplanan aynı çıkar — çıkmazsa düğüm göndermeleri
   * kırılırdı ve bu sessizce geçilmez.
   *
   * @param {Object} sceneJson
   * @param {Array} [assetList] `{ id, mime, kind, base64 }`
   * @param {{ analysis?: Object }} [meta]
   */
  loadScene(sceneJson, assetList = [], meta = {}) {
    this._releaseAssets();

    const assets = new this.lib.AssetManager();
    const mismatched = [];

    for (const a of assetList || []) {
      if (!a || !a.base64) continue;
      try {
        const added = assets.add(base64ToBytes(a.base64), { name: a.name });
        if (a.id && a.id !== added.id) mismatched.push(a.id);
      } catch (err) {
        this._status(`Varlık yüklenemedi (${a.name || a.id}): ${err.message}`, 'warn');
      }
    }

    const scene = this.lib.Scene.fromJSON(sceneJson, { assets });
    this.canvas.attach(scene);
    this._syncAssetUrls();

    if (mismatched.length) {
      this._status(
        `${mismatched.length} varlığın kimliği içerikle uyuşmadı; görselleri gözden geçirin`,
        'warn');
    }

    this.analysis = meta.analysis || null;
    this.inspector.render();
    this._renderPages();
    this.dirty = true;
    this.lastPdf = null;
    if (this.onAnalysis) this.onAnalysis(this.analysis);
  }

  get scene() { return this.canvas ? this.canvas.scene : null; }

  /** Üzerinde çalışılan sayfa. */
  get currentPage() { return this.canvas ? this.canvas.page : null; }

  /** Tuval + panel + sayfa şeridini birlikte tazeler (dışarıya açık). */
  refresh() { this._refreshAll(); }

  /**
   * Bir görsel dosyasını sahneye ekler (dosya seçici ya da sürükle-bırak).
   * Tek giriş noktası: iki ayrı yol iki ayrı davranış demektir.
   */
  addImageFile(file) { return this._addImage(file); }

  /**
   * Varlıkları taşınabilir biçimde dışa verir (`{ id, name, mime, base64 }`).
   *
   * Sunucuya gönderim ve dosyaya kaydetme AYNI listeyi kullanır; ikisi
   * ayrışırsa biri çalışır öteki sessizce eksik kalır.
   */
  exportAssets() {
    if (!this.scene) return [];
    const store = this.scene.assets;
    return store.manifest().map((meta) => {
      const bytes = store.bytes(meta.id);
      return bytes ? {
        id: meta.id, name: meta.name, kind: meta.kind, mime: meta.mime,
        base64: bytesToBase64(bytes)
      } : null;
    }).filter(Boolean);
  }

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
      (this._shareBtn = el('button', {
        class: 'btn btn--sm', type: 'button', text: 'Paylaş',
        title: 'Belgeyi ortak düzenlemeye aç',
        onclick: () => this._toggleShare()
      })),
      el('button', {
        class: 'btn btn--sm', type: 'button', text: 'Katıl',
        title: 'Var olan bir ortak oturuma katıl',
        onclick: () => this._promptJoin()
      }),
      (this._peersEl = el('span', { class: 'sc-peers' })),
      el('div', { class: 'sc-zoom' }, [
        el('button', {
          class: 'btn btn--icon', type: 'button', text: '−', title: 'Uzaklaştır',
          onclick: () => this.setZoom(this.canvas.zoom - 0.1)
        }),
        (this._zoomInput = el('input', {
          class: 'input input--num', type: 'number', min: 15, max: 400, step: 5, value: '100',
          title: 'Yakınlık (%)',
          onchange: (e) => this.setZoom((Number(e.target.value) || 100) / 100)
        })),
        el('button', {
          class: 'btn btn--icon', type: 'button', text: '+', title: 'Yakınlaştır',
          onclick: () => this.setZoom(this.canvas.zoom + 0.1)
        }),
        el('button', {
          class: 'btn btn--sm', type: 'button', text: 'Sayfa', title: 'Sayfayı sığdır',
          onclick: () => this.fitPage()
        }),
        el('button', {
          class: 'btn btn--sm', type: 'button', text: 'En', title: 'Genişliğe sığdır',
          onclick: () => this.fitPage('width')
        }),
        el('button', {
          class: 'btn btn--sm', type: 'button', text: '%100', title: 'Gerçek boyut',
          onclick: () => this.setZoom(1)
        })
      ])
    ]));
  }

  /**
   * YAKINLIK yalnız GÖSTERİMDİR.
   *
   * Belge koordinatlarına dokunmaz: %200'de sürüklenen bir nesne de puntoyla
   * aynı yere gider. İkisini karıştırmak, yakınlaştırınca belgesi bozulan
   * editörlerin klasik hatasıdır.
   */
  setZoom(zoom) {
    this.canvas.setZoom(zoom);
    if (this._zoomInput) this._zoomInput.value = String(Math.round(this.canvas.zoom * 100));
  }

  /**
   * Sayfayı görünür alana sığdırır.
   * @param {'page'|'width'} [mode]
   */
  fitPage(mode = 'page') {
    const box = this.canvas.pageBox;
    const host = this.opts.canvasRoot;
    if (!box.width || !host || !host.clientWidth) return;

    // Kaydırma çubuğu ve kenar boşluğu için pay: tam sığdırmak, sayfayı
    // her seferinde bir kıl payı taşırır ve kaydırma çubuğu belirir.
    const pad = 48;
    const byWidth = (host.clientWidth - pad) / box.width;
    const byHeight = (host.clientHeight - pad) / box.height;
    this.setZoom(mode === 'width' ? byWidth : Math.min(byWidth, byHeight));
  }

  async _toggleShare() {
    try {
      if (this.collab.active) return await this.unshareDocument();
      const name = window.prompt('Adınız (katılımcı listesinde görünecek):', 'Katılımcı');
      if (name === null) return;
      const id = await this.shareDocument(name);
      // Kimlik kopyalanabilir olmalı: kullanıcı bunu karşı tarafa iletecek.
      window.prompt('Oturum kimliği (karşı tarafa iletin):', id);
    } catch (err) {
      this._status(`Paylaşım açılamadı: ${err.message}`, 'err');
    }
  }

  async _promptJoin() {
    const id = window.prompt('Oturum kimliği:');
    if (!id) return;
    const name = window.prompt('Adınız:', 'Katılımcı');
    if (name === null) return;
    try {
      await this.joinDocument(id.trim(), name);
    } catch (err) {
      this._status(`Oturuma katılınamadı: ${err.message}`, 'err');
    }
  }

  /**
   * Sayfa şeridi — küçük ölçekli GERÇEK önizleme.
   *
   * Numara yazan bir düğme, on sayfalı bir belgede hangi sayfanın hangisi
   * olduğunu söylemez. Her sayfa kendi en-boy oranıyla ve üzerindeki
   * nesnelerin kaba yerleşimiyle çizilir; bu, tam bir render değildir ve
   * olmaya çalışmaz — amaç TANIMAKTIR.
   */
  _renderPages() {
    const root = clear(this.opts.pagesRoot);
    if (!this.scene) return;

    this.scene.pages.forEach((page, index) => {
      const box = this.lib.geometry.pageGeometry(this.scene.doc, page);
      const active = index === this.canvas.pageIndex;

      const thumb = el('div', { class: 'sc-thumb__sheet' });
      const scale = 46 / Math.max(box.width, box.height);
      Object.assign(thumb.style, {
        width: `${Math.round(box.width * scale)}px`,
        height: `${Math.round(box.height * scale)}px`
      });

      // Nesnelerin kaba izdüşümü — en fazla 60 tanesi; bir haritada
      // 4000 kutu çizmek şeridi kilitler.
      for (const node of (page.nodes || []).slice(0, 60)) {
        if (node.hidden) continue;
        const f = node.frame;
        thumb.appendChild(el('i', {
          class: `sc-thumb__n sc-thumb__n--${node.type}`,
          style: `left:${f.x * scale}px;top:${f.y * scale}px;` +
                 `width:${Math.max(1, f.width * scale)}px;` +
                 `height:${Math.max(1, f.height * scale)}px`
        }));
      }

      root.appendChild(el('button', {
        class: 'sc-thumb' + (active ? ' is-active' : ''),
        type: 'button',
        title: `${page.name} · ${Math.round(box.width)}×${Math.round(box.height)} pt`,
        'aria-current': active ? 'page' : null,
        onclick: () => this.setPage(index)
      }, [thumb, el('span', { class: 'sc-thumb__no', text: String(index + 1) })]));
    });

    root.appendChild(el('button', {
      class: 'sc-thumb sc-thumb--add', type: 'button', text: '+', title: 'Sayfa ekle',
      onclick: () => {
        // Yeni sayfa, üzerinde çalışılan sayfayla AYNI ölçüde gelir:
        // yatay bir sayfanın ardına dikey bir sayfa koymak sürpriz olurdu.
        const box = this.canvas.pageBox;
        this.scene.transaction('Sayfa ekle', () =>
          this.scene.addPage({ width: box.width, height: box.height }));
        this.setPage(this.scene.pages.length - 1);
        this._touched();
      }
    }));
  }

  /**
   * Sayfayı değiştirir.
   *
   * Şeridi ve paneli tazeleme işi tuvalin `onPageChange` geri çağrısındadır;
   * burada bir kez daha yapmak, aynı DOM'u iki kez kurmak olurdu.
   */
  setPage(index) {
    this.canvas.setPage(index);
    this.inspector.render();
  }

  /* ---------------------------------------------------------------- */
  /* Nesne ekleme                                                      */
  /* ---------------------------------------------------------------- */

  addNode(type, extra = {}) {
    // ÇALIŞILAN sayfanın ölçüsü — belgeninki değil. Çok ölçülü bir belgede
    // belge ölçüsüne göre ortalamak, nesneyi yatay sayfanın dışına atardı.
    const page = this.canvas.pageBox;
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
      this._syncAssetUrls();

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

  /**
   * `scene.assets` içindeki HER varlık için gösterim adresi olmasını sağlar.
   *
   * İçe aktarma, yapıştırma, ortak düzenleme — hepsi sahneye varlık
   * ekleyebilir. Tek bir eşitleyici olması, "hangi yol adres üretmeyi
   * unuttu" sorusunu ortadan kaldırır.
   */
  _syncAssetUrls() {
    if (!this.scene) return;
    for (const meta of this.scene.assets.manifest()) {
      if (this._preparedAssets.has(meta.id)) continue;
      const bytes = this.scene.assets.bytes(meta.id);
      if (!bytes) continue;
      this._preparedAssets.add(meta.id);

      // Fontlar `<img src>` ile gösterilmez; onlara nesne adresi gerekmez.
      if (meta.kind === 'image') {
        const url = URL.createObjectURL(new Blob([bytes], { type: meta.mime }));
        this.assetUrls.set(meta.id, url);
        this.canvas.setAssetUrl(meta.id, url);
      } else if (meta.kind === 'font') {
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
  /* Ortak düzenleme                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Sahneyi ortak oturuma bağlar.
   *
   * Sahnenin ürettiği işlemler kaydediciye düşer ve oradan sunucuya gider.
   * `suspended` bayrağı, UZAKTAN gelen bir işlemi uygularken üretilen
   * işlemlerin geri gönderilmesini engeller — yoksa iki istemci aynı
   * değişikliği sonsuza dek birbirine yollardı.
   */
  _bindCollab() {
    if (!this.scene) return;
    this.scene.recordOps((op) => this.collab.send([op]));
  }

  async shareDocument(name) {
    await this.collab.start(this.scene.toJSON(), name);
    this._bindCollab();
    this._renderPeers(this.collab.peers);
    return this.collab.sessionId;
  }

  async joinDocument(sessionId, name) {
    const res = await this.collab.join(sessionId, name);

    // Katılan taraf SUNUCUDAKİ belgeyi alır: yerel belgeyi korumak, iki
    // ayrı belgenin aynı oturumda düzenlenmesi demek olurdu.
    this._releaseAssets();
    const scene = this.lib.Scene.fromJSON(res.scene);
    this.canvas.attach(scene);
    this._syncAssetUrls();
    this._bindCollab();
    this._refreshAll();
    return res;
  }

  async unshareDocument() {
    if (this.scene) this.scene.recordOps(null);
    await this.collab.stop();
    this._renderPeers([]);
  }

  /** Uzak işlemleri uygular — GERİ ALMA YIĞINI TEMİZ KALIR. */
  _applyRemote(ops) {
    if (!this.scene || !ops.length) return;
    const depth = this.scene.history.undoStack.length;

    try {
      this.lib.applyOps(this.scene, ops, 'Uzak değişiklik');
    } catch (err) {
      this._status(`Uzak değişiklik uygulanamadı: ${err.message}`, 'err');
      return;
    }

    // Başkasının yazdığını Ctrl+Z ile geri almak en şaşırtıcı davranıştır.
    this.scene.history.undoStack.length = depth;
    this._syncAssetUrls();
    this._refreshAll();
  }

  _renderPeers(peers) {
    if (!this._peersEl) return;
    this._peersEl.textContent = peers.length
      ? `${peers.length} kişi: ${peers.map((p) => p.name).join(', ')}`
      : '';
    if (this._shareBtn) {
      this._shareBtn.textContent = this.collab.active ? 'Paylaşımı bitir' : 'Paylaş';
    }
  }

  _reportConflict(overwritten) {
    const ids = [...new Set(overwritten.map((o) => o.op.nodeId || o.op.op))];
    this._status(
      `Değişikliğiniz başkasının düzenlemesinin üzerine yazıldı (${ids.join(', ')})`,
      'warn');
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
      // Baytlar SAHNENİN yöneticisinden okunur. Editörün ayrı bir kopyasına
      // bakmak, içe aktarılan belgelerde boş liste göndermek demekti:
      // görseller çıktıda kayboluyordu.
      assets: this.exportAssets(),
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
    // Sayfa silinmiş ya da taşınmış olabilir; sıra sınırların dışında
    // kalırsa tuval boş görünür ve kullanıcı belgesini kaybettiğini sanır.
    if (this.scene) {
      this.canvas.pageIndex =
        Math.max(0, Math.min(this.scene.pages.length - 1, this.canvas.pageIndex));
    }
    this.canvas.render();
    this.inspector.render();
    this._renderPages();
    if (this.onPageChange) this.onPageChange(this.currentPage);
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

  /**
   * Gösterim kaynaklarını bırakır.
   *
   * Nesne adresleri elle iptal edilmezse sayfa kapanana kadar bellekte
   * kalır: on belge açan bir kullanıcı on belgenin görsellerini taşır.
   */
  _releaseAssets() {
    for (const url of this.assetUrls.values()) URL.revokeObjectURL(url);
    this.assetUrls.clear();
    this._preparedAssets.clear();
    if (this.canvas) {
      this.canvas.assetUrls.clear();
      this.canvas.embeddedFontFamilies.clear();
    }
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
