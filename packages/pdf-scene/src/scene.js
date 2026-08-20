'use strict';
/**
 * Sahne belgesi — düzenlenebilir model.
 *
 * `validate.js` şemayı bilir, `geometry.js` matematiği bilir; burası ise
 * BELGEYİ bilir: sayfalar, düğüm ağacı, z sırası, gruplar, seçim ve geri
 * alma. Editör arayüzü (tuval, paneller, kısayollar) bu sınıfın üstüne
 * kurulur ve DOM'a yalnız orada dokunulur.
 *
 * Bütün değiştiriciler işlem (transaction) içinde çalışır: her adım kendi
 * ters işlemini kaydeder, böylece geri alma anlık görüntü kopyalamadan
 * çalışır (bkz. history.js).
 */

const crypto = require('crypto');
const { validateScene, SceneError } = require('./validate');
const { SCHEMA_VERSION, NODE_TYPES, PAGE_SIZES, COMMON_FIELDS } = require('./schema');
const geometry = require('./geometry');
const { History } = require('./history');
const { AssetManager } = require('./assets');
const { round } = require('./units');

/** Çakışmayan kısa kimlik. */
function makeId(prefix = 'nd') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

/** Derin kopya — sahne düz veridir, structuredClone gerekmez. */
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

class Scene {
  /**
   * @param {Object} [doc] normalleştirilmiş sahne (yoksa boş A4 belgesi)
   * @param {{ assets?: AssetManager, history?: Object }} [opts]
   */
  constructor(doc, opts = {}) {
    this.doc = doc || Scene.blank().doc;
    this.assets = opts.assets || new AssetManager();
    this.history = new History(opts.history);
    /** @type {Set<string>} seçili düğüm kimlikleri */
    this.selection = new Set();
    this._listeners = new Set();
    /**
     * İşlem kaydedici — ortak düzenleme için.
     *
     * Kurulmuşsa her değişiklik SERİLEŞTİRİLEBİLİR bir işleme çevrilip
     * buraya verilir. Geri alma yığını kapanış tutar ve ağdan geçmez;
     * ağdan geçen şey bu işlemlerdir (bkz. ops.js).
     */
    this._recorder = null;
  }

  /* ---------------------------------------------------------------- */
  /* Kurulum                                                           */
  /* ---------------------------------------------------------------- */

  /** Boş bir belge. */
  static blank(opts = {}) {
    const { scene, issues } = validateScene({
      version: SCHEMA_VERSION,
      id: opts.id || 'scene',
      meta: { title: opts.title || '', lang: opts.lang || 'tr-TR' },
      page: {
        size: opts.size || 'A4',
        orientation: opts.orientation || 'portrait',
        margin: opts.margin || { top: 56.7, right: 51, bottom: 56.7, left: 51 }
      },
      assets: [],
      pages: [{ id: 'pg1', name: 'Sayfa 1', nodes: [] }]
    });
    if (!scene) throw new SceneError('ERR_SCENE_INVALID', 'Boş sahne kurulamadı', issues);
    return new Scene(scene);
  }

  /**
   * JSON'dan yükler. Doğrulama BAŞARISIZSA nesne kurulmaz — yarı geçerli bir
   * belgeyle çalışmak, hatayı derleyiciye ertelemekten başka bir şey değildir.
   */
  static fromJSON(input, opts = {}) {
    const { scene, issues } = validateScene(input, { limits: opts.limits });
    if (!scene) {
      throw new SceneError('ERR_SCENE_INVALID',
        `Sahne yüklenemedi: ${issues.length} sorun (ilki: ${issues[0].path} ${issues[0].message})`,
        issues);
    }
    return new Scene(scene, opts);
  }

  toJSON() {
    return clone({ ...this.doc, assets: this.assets.size ? this.assets.manifest() : this.doc.assets });
  }

  /* ---------------------------------------------------------------- */
  /* Olaylar                                                           */
  /* ---------------------------------------------------------------- */

  /** Değişiklik dinleyicisi ekler; kaldıran işlevi döndürür. */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(event) {
    for (const fn of this._listeners) {
      try { fn(event); } catch { /* dinleyici hatası belgeyi bozmasın */ }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Gezinme                                                           */
  /* ---------------------------------------------------------------- */

  get pages() { return this.doc.pages; }
  get page() { return this.doc.page; }

  pageAt(index) { return this.doc.pages[index] || null; }
  pageById(id) { return this.doc.pages.find((p) => p.id === id) || null; }

  /** Düğümü, kapsayıcısını ve ata zincirini bulur. */
  find(nodeId) {
    for (const page of this.doc.pages) {
      const hit = this._search(page.nodes, nodeId, page, []);
      if (hit) return hit;
    }
    return null;
  }

  _search(list, id, page, ancestry) {
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      if (node.id === id) return { node, list, index: i, page, ancestry: [...ancestry, node] };
      if (node.children) {
        const hit = this._search(node.children, id, page, [...ancestry, node]);
        if (hit) return hit;
      }
    }
    return null;
  }

  node(nodeId) {
    const hit = this.find(nodeId);
    return hit ? hit.node : null;
  }

  /** Sayfadaki bütün düğümler (gruplar dâhil), çizim sırasıyla. */
  flatten(page) {
    const out = [];
    const walk = (list) => {
      for (const n of list) {
        out.push(n);
        if (n.children) walk(n.children);
      }
    };
    walk(page.nodes);
    return out;
  }

  /** Düğümün sayfa koordinatlarındaki çerçevesi (grup kaymaları dâhil). */
  absoluteFrame(nodeId) {
    const hit = this.find(nodeId);
    return hit ? geometry.absoluteFrame(hit.ancestry) : null;
  }

  /* ---------------------------------------------------------------- */
  /* İşlem sarmalayıcı                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Bir dizi değişikliği TEK geri alma adımı yapar.
   *
   * @param {string} label kullanıcıya gösterilecek ad ("Metin taşı")
   * @param {Function} fn değişiklikleri yapan işlev
   * @param {{ mergeKey?: string }} [opts]
   */
  transaction(label, fn, opts = {}) {
    this.history.begin(label, opts.mergeKey || null);
    let result;
    try {
      result = fn(this);
    } catch (err) {
      this.history.rollback();
      throw err;
    }
    const tx = this.history.commit();
    if (tx) this._emit({ type: 'change', label });
    return result;
  }

  /**
   * İşlem kaydediciyi kurar.
   *
   * `null` verilerek kapatılır. UZAKTAN gelen işlemler uygulanırken
   * kapatılmalıdır: yoksa gelen işlem geri gönderilir ve iki istemci
   * sonsuza dek birbirine aynı değişikliği yollar.
   */
  recordOps(fn) { this._recorder = fn; }

  _record(op) {
    if (this._recorder) this._recorder(op);
  }

  /** Sayfanın tamamını işlem olarak kaydeder (gruplama gibi toptan işler). */
  _recordPage(page) {
    if (this._recorder && page) {
      this._recorder({ op: 'replacePage', pageId: page.id, nodes: clone(page.nodes) });
    }
  }

  /** Bir adımı uygular ve tersini kaydeder. */
  _step(apply, revert) {
    if (!this.history.isOpen) {
      throw new Error('Sahne değişiklikleri transaction() içinde yapılmalı');
    }
    apply();
    this.history.record(apply, revert);
  }

  /**
   * GERİ ALMA VE ORTAK DÜZENLEME.
   *
   * Geri alma, kaydedilmiş TERS İŞLEMLERİ doğrudan çalıştırır; sahne
   * yöntemlerinden geçmez, dolayısıyla kendiliğinden işlem üretmez. Ortak
   * oturumda bu, geri alanın belgesiyle diğerlerininkinin ayrışması
   * demektir.
   *
   * Çözüm: geri alma/yineleme sonrası DEĞİŞEN sayfalar toptan bildirilir.
   * Bedeli açıktır ve gizlenmiyor: aynı sayfada aynı anda çalışan birinin
   * son değişikliği bu yazımla kaybolabilir. Geri alma seyrek ve bilinçli
   * bir eylemdir; sessizce ayrışmış iki belge ise fark edilene kadar
   * büyüyen bir hatadır.
   */
  undo() {
    return this._timeTravel(() => this.history.undo(), 'undo');
  }

  redo() {
    return this._timeTravel(() => this.history.redo(), 'redo');
  }

  _timeTravel(run, kind) {
    const before = this._recorder ? this._snapshot() : null;
    const tx = run();
    if (!tx) return tx;

    if (before) {
      for (const page of this.doc.pages) {
        const previous = before.pages.get(page.id);
        const current = JSON.stringify(page.nodes);
        // Sayfa yeni ortaya çıktıysa ya da içeriği değiştiyse bildirilir.
        if (previous !== current) {
          this._record({ op: 'replacePage', pageId: page.id, nodes: clone(page.nodes) });
        }
      }
      if (before.meta !== JSON.stringify(this.doc.meta)) {
        this._record({ op: 'setMeta', meta: clone(this.doc.meta) });
      }
      if (before.page !== JSON.stringify(this.doc.page)) {
        this._record({ op: 'setPage', page: clone(this.doc.page) });
      }
    }

    this._emit({ type: kind, label: tx.label });
    return tx;
  }

  _snapshot() {
    return {
      pages: new Map(this.doc.pages.map((p) => [p.id, JSON.stringify(p.nodes)])),
      meta: JSON.stringify(this.doc.meta),
      page: JSON.stringify(this.doc.page)
    };
  }

  /* ---------------------------------------------------------------- */
  /* Düğüm işlemleri                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Yeni düğüm oluşturur (belgeye EKLEMEZ).
   * Varsayılanlar şemadan gelir; tip başına ikinci bir varsayılan listesi
   * tutmak, ikisinin ayrışması demektir.
   */
  static createNode(type, props = {}) {
    const def = NODE_TYPES[type];
    if (!def) throw new SceneError('ERR_NODE_TYPE', `Bilinmeyen düğüm tipi: ${type}`);

    const node = {
      id: props.id || makeId(),
      type,
      frame: {
        x: round(props.x !== undefined ? props.x : (props.frame ? props.frame.x : 0)),
        y: round(props.y !== undefined ? props.y : (props.frame ? props.frame.y : 0)),
        width: round(props.width !== undefined ? props.width : (props.frame ? props.frame.width : 120)),
        height: round(props.height !== undefined ? props.height : (props.frame ? props.frame.height : 40))
      }
    };

    // Ortak alanlar ŞEMADAN gelir, burada elle sayılmaz. Elle sayılırsa
    // şemaya eklenen bir alan (örn. `role`) burada sessizce düşer ve
    // kullanıcının verdiği değer kaybolur.
    for (const [key, spec] of Object.entries(COMMON_FIELDS)) {
      if (key === 'id' || key === 'type' || key === 'frame') continue;
      node[key] = props[key] !== undefined ? props[key] : spec.default;
    }

    for (const [key, spec] of Object.entries(def.fields)) {
      if (props[key] !== undefined) node[key] = props[key];
      else if (spec.default !== undefined) node[key] = spec.default;
    }
    if (def.container) node.children = props.children || [];
    return node;
  }

  /**
   * Düğüm ekler.
   * @param {Object} node
   * @param {{ pageId?: string, parentId?: string, index?: number }} [where]
   */
  addNode(node, where = {}) {
    const target = this._containerFor(where);
    const index = where.index === undefined ? target.list.length : where.index;
    const inserted = clone(node);

    this._step(
      () => target.list.splice(index, 0, inserted),
      () => {
        const i = target.list.indexOf(inserted);
        if (i >= 0) target.list.splice(i, 1);
      }
    );
    this._record({
      op: 'addNode', node: clone(inserted),
      pageId: where.pageId, parentId: where.parentId, index: where.index
    });
    return inserted;
  }

  removeNode(nodeId) {
    const hit = this.find(nodeId);
    if (!hit) return null;
    const { node, list, index } = hit;

    this._step(
      () => { const i = list.indexOf(node); if (i >= 0) list.splice(i, 1); },
      () => list.splice(Math.min(index, list.length), 0, node)
    );
    this.selection.delete(nodeId);
    this._record({ op: 'removeNode', nodeId });
    return node;
  }

  /**
   * Düğüm alanlarını günceller.
   *
   * Yalnız GERÇEKTEN değişen alanlar kaydedilir: aynı değeri yeniden yazmak
   * geri alma yığınına anlamsız adımlar doldurur.
   */
  updateNode(nodeId, patch) {
    const hit = this.find(nodeId);
    if (!hit) return null;
    const node = hit.node;

    const before = {};
    const after = {};
    let changed = false;

    for (const [key, value] of Object.entries(patch)) {
      if (key === 'id' || key === 'type' || key === 'children') continue;
      const prev = node[key];
      const next = key === 'frame' ? { ...prev, ...value } : value;
      if (JSON.stringify(prev) === JSON.stringify(next)) continue;
      before[key] = clone(prev);
      after[key] = clone(next);
      changed = true;
    }
    if (!changed) return node;

    this._step(
      () => Object.assign(node, clone(after)),
      () => {
        for (const [k, v] of Object.entries(before)) {
          if (v === undefined) delete node[k];
          else node[k] = clone(v);
        }
      }
    );
    this._record({ op: 'updateNode', nodeId, patch: clone(after) });
    return node;
  }

  /** Düğümü taşır (sürükleme). `mergeKey` sayesinde tek adım olur. */
  moveNode(nodeId, dx, dy) {
    const node = this.node(nodeId);
    if (!node || node.locked) return null;
    return this.updateNode(nodeId, {
      frame: { x: round(node.frame.x + dx), y: round(node.frame.y + dy) }
    });
  }

  /* --- z sırası --- */

  /**
   * Düğümü kendi kardeşleri arasında yeniden sıralar.
   * @param {'front'|'back'|'forward'|'backward'|number} to
   */
  reorder(nodeId, to) {
    const hit = this.find(nodeId);
    if (!hit) return null;
    const { node, list, index } = hit;

    let target;
    if (typeof to === 'number') target = to;
    else if (to === 'front') target = list.length - 1;
    else if (to === 'back') target = 0;
    else if (to === 'forward') target = index + 1;
    else if (to === 'backward') target = index - 1;
    else throw new SceneError('ERR_REORDER', `Bilinmeyen sıralama: ${to}`);

    target = Math.max(0, Math.min(list.length - 1, target));
    if (target === index) return node;

    this._step(
      () => { list.splice(list.indexOf(node), 1); list.splice(target, 0, node); },
      () => { list.splice(list.indexOf(node), 1); list.splice(index, 0, node); }
    );
    this._record({ op: 'reorder', nodeId, to: target });
    return node;
  }

  /* --- gruplama --- */

  /**
   * Seçili düğümleri gruplar.
   *
   * Grup çerçevesi çocukların sınır kutusudur; çocuk koordinatları grubun
   * sol üstüne GÖRE yeniden yazılır. Bu dönüşüm olmadan grubu taşımak
   * çocukları iki kez kaydırırdı.
   */
  group(nodeIds, opts = {}) {
    const hits = nodeIds.map((id) => this.find(id)).filter(Boolean);
    if (hits.length < 2) return null;

    const page = hits[0].page;
    if (hits.some((h) => h.page !== page)) {
      throw new SceneError('ERR_GROUP_PAGES', 'Farklı sayfalardaki düğümler gruplanamaz');
    }
    if (hits.some((h) => h.list !== hits[0].list)) {
      throw new SceneError('ERR_GROUP_PARENTS', 'Yalnız aynı kapsayıcıdaki düğümler gruplanabilir');
    }

    const list = hits[0].list;
    const nodes = hits.map((h) => h.node);
    const box = geometry.boundsOf(nodes);
    const insertAt = Math.min(...hits.map((h) => h.index));

    const group = Scene.createNode('group', {
      id: opts.id,
      name: opts.name || 'Grup',
      x: box.x, y: box.y, width: box.width, height: box.height
    });

    // Çizim sırası korunsun: kardeş sırasına göre
    const ordered = [...nodes].sort((a, b) => list.indexOf(a) - list.indexOf(b));
    const originals = ordered.map((n) => ({ node: n, index: list.indexOf(n), frame: { ...n.frame } }));

    this._step(
      () => {
        for (const n of ordered) list.splice(list.indexOf(n), 1);
        group.children = ordered;
        for (const n of ordered) {
          n.frame = { ...n.frame, x: round(n.frame.x - box.x), y: round(n.frame.y - box.y) };
        }
        list.splice(Math.min(insertAt, list.length), 0, group);
      },
      () => {
        const gi = list.indexOf(group);
        if (gi >= 0) list.splice(gi, 1);
        group.children = [];
        for (const o of originals.slice().sort((a, b) => a.index - b.index)) {
          o.node.frame = { ...o.frame };
          list.splice(Math.min(o.index, list.length), 0, o.node);
        }
      }
    );

    // Gruplama düğüm ağacını TOPTAN yeniden kurar; ortak düzenlemede
    // bunu tek bir `replacePage` olarak taşımak, aradaki her ara durumun
    // geçerli olmasını beklemekten sağlamdır.
    this._recordPage(page);
    this.selection = new Set([group.id]);
    return group;
  }

  /** Grubu çözer; çocuklar grubun yerine, mutlak koordinatlarla döner. */
  ungroup(groupId) {
    const hit = this.find(groupId);
    if (!hit || hit.node.type !== 'group') return null;
    const { node: group, list, index } = hit;

    const children = group.children.slice();
    const childFrames = children.map((c) => ({ ...c.frame }));
    const box = { ...group.frame };

    this._step(
      () => {
        const gi = list.indexOf(group);
        if (gi >= 0) list.splice(gi, 1);
        children.forEach((c) => {
          c.frame = { ...c.frame, x: round(c.frame.x + box.x), y: round(c.frame.y + box.y) };
        });
        list.splice(Math.min(index, list.length), 0, ...children);
        group.children = [];
      },
      () => {
        for (const c of children) {
          const i = list.indexOf(c);
          if (i >= 0) list.splice(i, 1);
        }
        children.forEach((c, i) => { c.frame = { ...childFrames[i] }; });
        group.children = children;
        list.splice(Math.min(index, list.length), 0, group);
      }
    );

    this._recordPage(hit.page);
    this.selection = new Set(children.map((c) => c.id));
    return children;
  }

  /* ---------------------------------------------------------------- */
  /* Sayfa işlemleri                                                   */
  /* ---------------------------------------------------------------- */

  addPage(opts = {}) {
    const page = {
      id: opts.id || makeId('pg'),
      name: opts.name || `Sayfa ${this.doc.pages.length + 1}`,
      nodes: opts.nodes || []
    };
    if (opts.background) page.background = opts.background;
    const index = opts.index === undefined ? this.doc.pages.length : opts.index;

    this._step(
      () => this.doc.pages.splice(index, 0, page),
      () => { const i = this.doc.pages.indexOf(page); if (i >= 0) this.doc.pages.splice(i, 1); }
    );
    this._record({ op: 'addPage', options: { ...opts, id: page.id, name: page.name, index } });
    return page;
  }

  removePage(pageId) {
    const index = this.doc.pages.findIndex((p) => p.id === pageId);
    if (index < 0) return null;
    if (this.doc.pages.length === 1) {
      throw new SceneError('ERR_LAST_PAGE', 'Son sayfa silinemez');
    }
    const page = this.doc.pages[index];
    this._step(
      () => { const i = this.doc.pages.indexOf(page); if (i >= 0) this.doc.pages.splice(i, 1); },
      () => this.doc.pages.splice(Math.min(index, this.doc.pages.length), 0, page)
    );
    this._record({ op: 'removePage', pageId });
    return page;
  }

  movePage(pageId, toIndex) {
    const from = this.doc.pages.findIndex((p) => p.id === pageId);
    if (from < 0) return null;
    const to = Math.max(0, Math.min(this.doc.pages.length - 1, toIndex));
    if (to === from) return null;
    const page = this.doc.pages[from];

    this._step(
      () => { this.doc.pages.splice(from, 1); this.doc.pages.splice(to, 0, page); },
      () => { this.doc.pages.splice(to, 1); this.doc.pages.splice(from, 0, page); }
    );
    this._record({ op: 'movePage', pageId, index: to });
    return page;
  }

  /* ---------------------------------------------------------------- */
  /* Belge düzeyi                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Belge üst verisini günceller (başlık, dil, yazar…).
   *
   * Yalnız ŞEMADA olan alanlar yazılır: `doc.meta`ya serbest anahtar
   * eklemek, doğrulamadan geçmeyen bir belge üretirdi.
   */
  setMeta(patch) {
    return this._merge(this.doc.meta, patch,
      ['title', 'author', 'subject', 'lang', 'keywords'], 'Belge bilgisi');
  }

  /** Sayfa geometrisini günceller (boyut, yön, kenar boşluğu). */
  setPage(patch) {
    return this._merge(this.doc.page, patch,
      ['size', 'orientation', 'width', 'height', 'margin'], 'Sayfa düzeni');
  }

  /** Ortak birleştirme: eski değerleri saklayıp geri alınabilir yazar. */
  _merge(target, patch, allowed, label) {
    if (!patch || typeof patch !== 'object') return target;

    const before = {};
    const after = {};
    let changed = false;

    for (const key of allowed) {
      if (patch[key] === undefined) continue;
      const next = key === 'margin' && patch.margin && typeof patch.margin === 'object'
        ? { ...target.margin, ...patch.margin }
        : patch[key];
      if (JSON.stringify(target[key]) === JSON.stringify(next)) continue;
      before[key] = clone(target[key]);
      after[key] = clone(next);
      changed = true;
    }
    if (!changed) return target;

    this._step(
      () => Object.assign(target, clone(after)),
      () => {
        for (const [k, v] of Object.entries(before)) {
          if (v === undefined) delete target[k];
          else target[k] = clone(v);
        }
      }
    );
    this._record(target === this.doc.meta
      ? { op: 'setMeta', meta: clone(after) }
      : { op: 'setPage', page: clone(after) });
    return target;
  }

  /**
   * Sayfanın düğüm listesini TOPTAN değiştirir.
   *
   * Gruplama ve grup çözme, düğüm ağacını tek adımda yeniden kurar;
   * bunu "şu düğümü ekle, şunu çıkar" dizisine bölmek, aradaki her ara
   * durumun geçerli olmasını gerektirirdi. Ortak düzenlemede bu işlem
   * TEK bir `replacePage` olarak taşınır.
   */
  replacePageNodes(pageId, nodes) {
    const page = this.pageById(pageId);
    if (!page) return null;
    const before = clone(page.nodes);
    const after = clone(nodes);

    this._step(
      () => { page.nodes = clone(after); },
      () => { page.nodes = clone(before); }
    );
    this._record({ op: 'replacePage', pageId, nodes: clone(after) });
    return page;
  }

  /* ---------------------------------------------------------------- */
  /* Kopyala / yapıştır                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Seçimi taşınabilir bir pakete çevirir.
   *
   * Kullanılan varlıkların BAYTLARI da pakete girer: aynı belgede yapıştırmak
   * için gerekmez ama başka bir belgeye yapıştırmak için şarttır. Yalnız
   * kimlik taşımak, karşı tarafta bozuk gönderme bırakırdı.
   */
  copy(nodeIds = [...this.selection]) {
    const nodes = nodeIds.map((id) => this.find(id)).filter(Boolean).map((h) => clone(h.node));
    const used = new Set();
    const collect = (list) => {
      for (const n of list) {
        if (n.assetId) used.add(n.assetId);
        if (n.children) collect(n.children);
      }
    };
    collect(nodes);

    return {
      kind: 'fitfak-scene-clip',
      version: SCHEMA_VERSION,
      nodes,
      assets: [...used].map((id) => {
        const meta = this.assets.get(id);
        const bytes = this.assets.bytes(id);
        return meta ? { ...meta, base64: bytes ? bytes.toString('base64') : null } : null;
      }).filter(Boolean)
    };
  }

  /**
   * Paketi yapıştırır. Kimlikler YENİDEN üretilir — aksi hâlde aynı belgeye
   * yapıştırmak kimlik çakışması yaratırdı.
   */
  paste(clip, opts = {}) {
    if (!clip || clip.kind !== 'fitfak-scene-clip') {
      throw new SceneError('ERR_CLIP', 'Tanınmayan pano içeriği');
    }
    const offset = opts.offset === undefined ? 10 : opts.offset;
    const idMap = new Map();

    // Varlıklar önce: düğümler onlara gönderiyor
    for (const a of clip.assets || []) {
      if (this.assets.has(a.id)) { idMap.set(a.id, a.id); continue; }
      if (!a.base64) continue;                    // baytsız varlık yapıştırılamaz
      const added = this.assets.add(Buffer.from(a.base64, 'base64'), { name: a.name });
      idMap.set(a.id, added.id);
    }

    const rewrite = (node) => {
      const out = clone(node);
      out.id = makeId();
      if (out.assetId) out.assetId = idMap.get(out.assetId) || out.assetId;
      if (out.children) out.children = out.children.map(rewrite);
      return out;
    };

    const pasted = [];
    for (const n of clip.nodes || []) {
      const copy = rewrite(n);
      copy.frame = { ...copy.frame, x: round(copy.frame.x + offset), y: round(copy.frame.y + offset) };
      pasted.push(this.addNode(copy, { pageId: opts.pageId, parentId: opts.parentId }));
    }
    this.selection = new Set(pasted.map((n) => n.id));
    return pasted;
  }

  /** Düğümleri yerinde çoğaltır. */
  duplicate(nodeIds = [...this.selection], offset = 10) {
    return this.paste(this.copy(nodeIds), { offset });
  }

  /* ---------------------------------------------------------------- */
  /* Hizalama / dağıtım (geometri motorunu belgeye uygular)            */
  /* ---------------------------------------------------------------- */

  align(nodeIds, how) {
    const nodes = nodeIds.map((id) => this.node(id)).filter((n) => n && !n.locked);
    if (nodes.length < 2) return;
    for (const [id, pos] of geometry.align(nodes, how)) this.updateNode(id, { frame: pos });
  }

  /** Sayfaya göre hizalar (tek nesne için de anlamlıdır). */
  alignToPage(nodeIds, how) {
    const nodes = nodeIds.map((id) => this.node(id)).filter((n) => n && !n.locked);
    if (!nodes.length) return;
    const m = this.doc.page.margin;
    const box = {
      x: m.left, y: m.top,
      width: this.doc.page.width - m.left - m.right,
      height: this.doc.page.height - m.top - m.bottom
    };
    for (const [id, pos] of geometry.align(nodes, how, box)) this.updateNode(id, { frame: pos });
  }

  distribute(nodeIds, axis) {
    const nodes = nodeIds.map((id) => this.node(id)).filter((n) => n && !n.locked);
    for (const [id, pos] of geometry.distribute(nodes, axis)) this.updateNode(id, { frame: pos });
  }

  /* ---------------------------------------------------------------- */
  /* Yardımcılar                                                       */
  /* ---------------------------------------------------------------- */

  _containerFor(where) {
    if (where.parentId) {
      const hit = this.find(where.parentId);
      if (!hit) throw new SceneError('ERR_NO_PARENT', `Kapsayıcı bulunamadı: ${where.parentId}`);
      if (!hit.node.children) {
        throw new SceneError('ERR_NOT_CONTAINER', `${hit.node.type} kapsayıcı değil`);
      }
      return { list: hit.node.children, page: hit.page };
    }
    const page = where.pageId ? this.pageById(where.pageId) : this.doc.pages[0];
    if (!page) throw new SceneError('ERR_NO_PAGE', `Sayfa bulunamadı: ${where.pageId}`);
    return { list: page.nodes, page };
  }

  /** Sahnenin GERÇEKTEN kullandığı varlık kimlikleri. */
  usedAssetIds() {
    const used = new Set();
    for (const page of this.doc.pages) {
      for (const n of this.flatten(page)) if (n.assetId) used.add(n.assetId);
    }
    return used;
  }

  /** Belgeyi baştan doğrular — içe aktarma ve dış düzenlemelerden sonra. */
  validate() {
    return validateScene(this.toJSON());
  }
}

module.exports = { Scene, makeId, PAGE_SIZES };
