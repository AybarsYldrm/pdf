'use strict';
/**
 * Sahne doğrulama ve normalleştirme.
 *
 * İKİ İŞ, TEK GEÇİŞ: doğrular ve aynı anda **normalleştirilmiş** bir kopya
 * üretir — eksik alanlar varsayılanla doldurulmuş, uzunluklar puntoya
 * çevrilmiş, renkler tek biçime getirilmiş, bilinmeyen alanlar atılmış.
 *
 * Bilinmeyen alanların ATILMASI bilinçli: sahne dosyası güvenilmez girdidir
 * ve derleyicilere tanımadıkları alanları taşımak, ileride birinin onlara
 * anlam yüklemesi demektir. Şemada olmayan alan yoktur.
 *
 * Hata biriktirilir, ilk hatada durulmaz: kullanıcı dosyasındaki beş sorunu
 * beş turda öğrenmek yerine tek seferde görsün.
 */

const {
  SCHEMA_VERSION, PAGE_SIZES, NODE_TYPES, COMMON_FIELDS, LIMITS, STRUCT_ROLES
} = require('./schema');
const units = require('./units');

class SceneError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Array<{path:string, code:string, message:string}>} [issues]
   */
  constructor(code, message, issues = []) {
    super(message);
    this.name = 'SceneError';
    this.code = code;
    this.issues = issues;
  }
}

/* ------------------------------------------------------------------ */
/* Değer doğrulayıcıları                                               */
/* ------------------------------------------------------------------ */

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** `#rgb` / `#rrggbb` / `rgb(r,g,b)` → `[r,g,b]` (0-255). */
function parseColor(value) {
  if (Array.isArray(value)) {
    if (value.length < 3) return null;
    const out = value.slice(0, 3).map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))));
    return out.some((n) => !Number.isFinite(n)) ? null : out;
  }
  if (typeof value !== 'string') return null;

  const s = value.trim();
  if (HEX_RE.test(s)) {
    const h = s.slice(1);
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16)
    ];
  }
  const m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,[^)]*)?\)$/.exec(s);
  if (m) {
    const out = [Number(m[1]), Number(m[2]), Number(m[3])];
    return out.every((n) => n >= 0 && n <= 255) ? out : null;
  }
  return null;
}

/** `[r,g,b]` → `#rrggbb` (dosyada okunabilir kalsın diye). */
function colorToHex(rgb) {
  return '#' + rgb.map((n) => n.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ */
/* Doğrulayıcı                                                         */
/* ------------------------------------------------------------------ */

class Validator {
  constructor(limits = LIMITS) {
    this.limits = { ...LIMITS, ...limits };
    this.issues = [];
    this.ids = new Set();
    this.assetIds = new Set();
    this.nodeCount = 0;
  }

  fail(path, code, message) {
    this.issues.push({ path, code, message });
    return undefined;
  }

  /* --- alan tipleri --- */

  field(path, spec, raw) {
    if (raw === undefined || raw === null) {
      if (spec.required) return this.fail(path, 'ERR_REQUIRED', 'Zorunlu alan eksik');
      if (spec.optional) return undefined;
      return typeof spec.default === 'function' ? spec.default() : spec.default;
    }

    switch (spec.type) {
      case 'string':    return this.str(path, spec, raw);
      case 'number':    return this.num(path, spec, raw);
      case 'length':    return this.len(path, spec, raw);
      case 'boolean':   return typeof raw === 'boolean'
        ? raw : this.fail(path, 'ERR_TYPE', 'true/false bekleniyordu');
      case 'enum':      return spec.values.includes(raw)
        ? raw : this.fail(path, 'ERR_ENUM', `Şunlardan biri olmalı: ${spec.values.join(', ')}`);
      case 'color': {
        const rgb = parseColor(raw);
        return rgb ? colorToHex(rgb) : this.fail(path, 'ERR_COLOR', `Renk çözümlenemedi: ${raw}`);
      }
      case 'assetRef':  return this.assetRef(path, raw);
      case 'runs':      return this.runs(path, raw);
      case 'pathData':  return this.pathData(path, raw);
      default:          return this.fail(path, 'ERR_SCHEMA', `Bilinmeyen alan tipi: ${spec.type}`);
    }
  }

  str(path, spec, raw) {
    if (typeof raw !== 'string') return this.fail(path, 'ERR_TYPE', 'Dizge bekleniyordu');
    if (raw.includes('\0')) return this.fail(path, 'ERR_NUL', 'Metin NUL baytı içeremez');
    const max = spec.maxLength || this.limits.maxNameLength;
    if (raw.length > max) {
      return this.fail(path, 'ERR_TOO_LONG', `En çok ${max} karakter (gelen ${raw.length})`);
    }
    return raw;
  }

  num(path, spec, raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return this.fail(path, 'ERR_TYPE', 'Sonlu sayı bekleniyordu');
    if (spec.min !== undefined && n < spec.min) {
      return this.fail(path, 'ERR_RANGE', `En az ${spec.min} olmalı (gelen ${n})`);
    }
    if (spec.max !== undefined && n > spec.max) {
      return this.fail(path, 'ERR_RANGE', `En çok ${spec.max} olmalı (gelen ${n})`);
    }
    return n;
  }

  len(path, spec, raw) {
    let pt;
    try { pt = units.toPt(raw); }
    catch (err) { return this.fail(path, 'ERR_LENGTH', err.message); }
    return this.num(path, spec, units.round(pt));
  }

  assetRef(path, raw) {
    if (typeof raw !== 'string' || !ID_RE.test(raw)) {
      return this.fail(path, 'ERR_ASSET_REF', 'Varlık kimliği geçersiz');
    }
    // Varlığın GERÇEKTEN var olduğu, sahne tamamı okunduktan sonra denetlenir
    // (düğümler varlık listesinden önce gelebilir).
    return raw;
  }

  /** Zengin metin koşuları: her koşu kendi stilini taşır. */
  runs(path, raw) {
    if (!Array.isArray(raw)) return this.fail(path, 'ERR_TYPE', 'Dizi bekleniyordu');
    if (raw.length > this.limits.maxRuns) {
      return this.fail(path, 'ERR_TOO_MANY', `En çok ${this.limits.maxRuns} koşu`);
    }
    const out = [];
    raw.forEach((run, i) => {
      const p = `${path}[${i}]`;
      if (!run || typeof run !== 'object') { this.fail(p, 'ERR_TYPE', 'Nesne bekleniyordu'); return; }
      const text = this.str(`${p}.text`, { maxLength: 100_000 }, run.text === undefined ? '' : run.text);
      if (text === undefined) return;
      const entry = { text };
      if (run.bold !== undefined) entry.bold = run.bold === true;
      if (run.italic !== undefined) entry.italic = run.italic === true;
      if (run.color !== undefined) {
        const rgb = parseColor(run.color);
        if (!rgb) { this.fail(`${p}.color`, 'ERR_COLOR', `Renk çözümlenemedi: ${run.color}`); return; }
        entry.color = colorToHex(rgb);
      }
      if (run.fontSize !== undefined) {
        const fs = this.len(`${p}.fontSize`, { min: 0.5, max: 1440 }, run.fontSize);
        if (fs === undefined) return;
        entry.fontSize = fs;
      }
      if (run.link !== undefined) {
        const link = this.link(`${p}.link`, run.link);
        if (link === undefined) return;
        entry.link = link;
      }
      out.push(entry);
    });
    return out;
  }

  /**
   * Yol verisi: `[['M',x,y], ['L',x,y], ['C',x1,y1,x2,y2,x,y], ['Z']]`.
   *
   * NEDEN DİZİ, NEDEN SVG DİZGESİ DEĞİL: dizge tutmak bir ayrıştırıcı daha
   * yazmak demektir ve güvenilmez girdiyi ayrıştıran her yeni kod yeni bir
   * yüzeydir. Dizi biçimi JSON'un kendi ayrıştırıcısıyla gelir; burada
   * yalnız komut adı, argüman sayısı ve sayı aralığı denetlenir.
   *
   * Tek eğri tipi kübiktir (`C`). PDF'in `v`/`y` işleçleri ve yay komutları
   * içe aktarmada kübiğe çevrilir: TEK gösterim, tek çizim yolu.
   */
  pathData(path, raw) {
    if (!Array.isArray(raw)) return this.fail(path, 'ERR_TYPE', 'Dizi bekleniyordu');
    if (!raw.length) return this.fail(path, 'ERR_PATH_EMPTY', 'Yol en az bir komut içermeli');
    if (raw.length > this.limits.maxPathCommands) {
      return this.fail(path, 'ERR_TOO_MANY',
        `Yolda en çok ${this.limits.maxPathCommands} komut olabilir (gelen ${raw.length})`);
    }

    const ARITY = { M: 2, L: 2, C: 6, Z: 0 };
    const out = [];

    for (let i = 0; i < raw.length; i++) {
      const cmd = raw[i];
      const p = `${path}[${i}]`;
      if (!Array.isArray(cmd) || !cmd.length) {
        return this.fail(p, 'ERR_TYPE', 'Komut dizisi bekleniyordu');
      }
      const op = cmd[0];
      const arity = ARITY[op];
      if (arity === undefined) {
        return this.fail(`${p}[0]`, 'ERR_PATH_OP',
          `Bilinmeyen yol komutu: ${JSON.stringify(op)} (M, L, C, Z)`);
      }
      if (cmd.length - 1 !== arity) {
        return this.fail(p, 'ERR_PATH_ARITY',
          `${op} komutu ${arity} sayı ister (gelen ${cmd.length - 1})`);
      }

      const entry = [op];
      for (let a = 1; a <= arity; a++) {
        const n = Number(cmd[a]);
        if (!Number.isFinite(n)) {
          return this.fail(`${p}[${a}]`, 'ERR_TYPE', 'Sonlu sayı bekleniyordu');
        }
        if (Math.abs(n) > 100_000) {
          return this.fail(`${p}[${a}]`, 'ERR_RANGE', `Koordinat aralık dışı: ${n}`);
        }
        entry.push(units.round(n));
      }
      out.push(entry);
    }

    // İlk komut yerleşim komutu olmalı: nereden başladığı belli olmayan bir
    // yol, çizerin durumuna bağlı olur ve tur kapanmaz.
    if (out[0][0] !== 'M') {
      return this.fail(`${path}[0]`, 'ERR_PATH_START', 'Yol M komutuyla başlamalı');
    }
    return out;
  }

  /**
   * Bağlantı adresi.
   *
   * `javascript:`, `data:` ve `file:` şemaları reddedilir: bunlar PDF
   * görüntüleyicilerinde kod çalıştırma ya da yerel dosya açma yollarıdır.
   * İzin verilenler açıkça sayılır — yasak listesi tutmak, yarın çıkacak
   * şemayı kaçırmak demektir.
   */
  link(path, raw) {
    if (typeof raw !== 'string') return this.fail(path, 'ERR_TYPE', 'Dizge bekleniyordu');
    const s = raw.trim();
    if (s.length > 2048) return this.fail(path, 'ERR_TOO_LONG', 'Bağlantı çok uzun');
    if (!/^(https?:\/\/|mailto:)/i.test(s)) {
      return this.fail(path, 'ERR_LINK_SCHEME',
        'Yalnız http, https ve mailto bağlantılarına izin verilir');
    }
    return s;
  }

  /* --- çerçeve --- */

  frame(path, raw) {
    if (!raw || typeof raw !== 'object') {
      return this.fail(path, 'ERR_TYPE', '{ x, y, width, height } bekleniyordu');
    }
    const out = {};
    for (const key of ['x', 'y', 'width', 'height']) {
      const v = this.len(`${path}.${key}`,
        { min: key === 'width' || key === 'height' ? 0 : -100_000, max: 100_000 },
        raw[key] === undefined ? 0 : raw[key]);
      if (v === undefined) return undefined;
      out[key] = v;
    }
    return out;
  }

  /* --- düğüm --- */

  node(path, raw, depth) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return this.fail(path, 'ERR_TYPE', 'Düğüm nesnesi bekleniyordu');
    }
    if (depth > this.limits.maxDepth) {
      return this.fail(path, 'ERR_DEPTH', `Yuvalama derinliği ${this.limits.maxDepth} sınırını aştı`);
    }
    if (++this.nodeCount > this.limits.maxNodesTotal) {
      return this.fail(path, 'ERR_TOO_MANY', `Toplam düğüm sayısı ${this.limits.maxNodesTotal} sınırını aştı`);
    }

    const type = raw.type;
    const def = NODE_TYPES[type];
    if (!def) {
      return this.fail(`${path}.type`, 'ERR_NODE_TYPE',
        `Bilinmeyen düğüm tipi: ${JSON.stringify(type)}`);
    }

    const id = raw.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      return this.fail(`${path}.id`, 'ERR_ID', 'Kimlik harfle başlamalı ve [A-Za-z0-9_-] olmalı');
    }
    if (this.ids.has(id)) {
      return this.fail(`${path}.id`, 'ERR_DUPLICATE_ID', `Kimlik yinelendi: ${id}`);
    }
    this.ids.add(id);

    // İmza yuvasında `role` ESKİDEN imzalayanın unvanıydı ("Genel Müdür").
    // Artık `role` her düğümde PDF/UA yapı rolüdür; unvan `signerTitle`a
    // taşındı. Eski belge sessizce "unvanı olmayan yuva"ya dönüşmesin diye
    // durum açıkça bildirilir.
    if (type === 'signature' && typeof raw.role === 'string' &&
        raw.role && !STRUCT_ROLES.includes(raw.role)) {
      return this.fail(`${path}.role`, 'ERR_RENAMED_FIELD',
        'İmza yuvasında `role` artık PDF/UA yapı rolüdür; ' +
        'imzalayanın unvanı için `signerTitle` alanını kullanın');
    }

    const out = { id, type };
    for (const [key, spec] of Object.entries(COMMON_FIELDS)) {
      if (key === 'id' || key === 'type') continue;
      if (key === 'frame') {
        const f = this.frame(`${path}.frame`, raw.frame);
        if (f === undefined) return undefined;
        out.frame = f;
        continue;
      }
      const v = this.field(`${path}.${key}`, spec, raw[key]);
      if (v !== undefined) out[key] = v;
    }

    for (const [key, spec] of Object.entries(def.fields)) {
      const v = this.field(`${path}.${key}`, spec, raw[key]);
      if (v !== undefined) out[key] = v;
      if (spec.type === 'assetRef' && v !== undefined) this.assetIds.add(v);
    }

    if (def.container) {
      const kids = raw.children;
      if (kids !== undefined && !Array.isArray(kids)) {
        return this.fail(`${path}.children`, 'ERR_TYPE', 'Dizi bekleniyordu');
      }
      out.children = [];
      for (const [i, child] of (kids || []).entries()) {
        const c = this.node(`${path}.children[${i}]`, child, depth + 1);
        if (c !== undefined) out.children.push(c);
      }
    }

    return out;
  }

  /* --- varlık --- */

  asset(path, raw) {
    if (!raw || typeof raw !== 'object') {
      return this.fail(path, 'ERR_TYPE', 'Varlık nesnesi bekleniyordu');
    }
    const id = raw.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      return this.fail(`${path}.id`, 'ERR_ID', 'Varlık kimliği geçersiz');
    }
    if (this.ids.has(id)) {
      return this.fail(`${path}.id`, 'ERR_DUPLICATE_ID', `Kimlik yinelendi: ${id}`);
    }
    this.ids.add(id);

    const kind = raw.kind;
    if (!['image', 'font'].includes(kind)) {
      return this.fail(`${path}.kind`, 'ERR_ENUM', "kind 'image' ya da 'font' olmalı");
    }

    const out = { id, kind };
    out.mime = this.str(`${path}.mime`, { maxLength: 128 }, raw.mime || 'application/octet-stream');
    out.sha256 = typeof raw.sha256 === 'string' && /^[0-9a-f]{64}$/.test(raw.sha256)
      ? raw.sha256
      : this.fail(`${path}.sha256`, 'ERR_HASH', '64 karakter küçük harf onaltılık SHA-256 bekleniyordu');
    out.size = this.num(`${path}.size`, { min: 0, max: 1 << 30 }, raw.size === undefined ? 0 : raw.size);
    if (raw.name !== undefined) out.name = this.str(`${path}.name`, { maxLength: 256 }, raw.name);
    if (kind === 'image') {
      out.width = this.num(`${path}.width`, { min: 0, max: 1_000_000 }, raw.width === undefined ? 0 : raw.width);
      out.height = this.num(`${path}.height`, { min: 0, max: 1_000_000 }, raw.height === undefined ? 0 : raw.height);
    }
    return out;
  }

  /* --- sayfa --- */

  page(path, raw, index) {
    if (!raw || typeof raw !== 'object') {
      return this.fail(path, 'ERR_TYPE', 'Sayfa nesnesi bekleniyordu');
    }
    const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : `pg${index + 1}`;
    if (this.ids.has(id)) return this.fail(`${path}.id`, 'ERR_DUPLICATE_ID', `Kimlik yinelendi: ${id}`);
    this.ids.add(id);

    const nodes = raw.nodes;
    if (nodes !== undefined && !Array.isArray(nodes)) {
      return this.fail(`${path}.nodes`, 'ERR_TYPE', 'Dizi bekleniyordu');
    }
    if ((nodes || []).length > this.limits.maxNodesPerPage) {
      return this.fail(`${path}.nodes`, 'ERR_TOO_MANY',
        `Sayfada en çok ${this.limits.maxNodesPerPage} düğüm olabilir`);
    }

    const out = { id, name: this.str(`${path}.name`, { maxLength: 256 }, raw.name || `Sayfa ${index + 1}`) };

    /**
     * SAYFAYA ÖZGÜ ÖLÇÜ — belgenin geneline uymayan sayfalar için.
     *
     * Gerçek belgelerde sayfa boyutu tek değildir: bir sözleşmenin arasına
     * yatay bir tablo, bir raporun sonuna A3 bir kroki girer. Tek bir belge
     * ölçüsü dayatmak, içe aktarılan böyle bir sayfayı ya kırpar ya esnetir.
     *
     * Verilmezse belgenin `page` geometrisi geçerlidir; yani eski sahneler
     * ve elle yazılmış JSON'lar aynı şekilde çalışır.
     */
    if (raw.width !== undefined || raw.height !== undefined) {
      if (raw.width === undefined || raw.height === undefined) {
        // Yarım bir ölçü (yalnız genişlik) belgeninkiyle karışırdı; hangi
        // yüksekliğin geçerli olduğunu okuyan kimse bilemezdi.
        this.fail(`${path}.width`, 'ERR_PAGE_SIZE',
          'Sayfaya özgü ölçüde genişlik ve yükseklik BİRLİKTE verilmelidir');
      } else {
        const w = this.len(`${path}.width`, { min: 1, max: 20_000 }, raw.width);
        const h = this.len(`${path}.height`, { min: 1, max: 20_000 }, raw.height);
        if (w !== undefined && h !== undefined) {
          out.width = units.round(w);
          out.height = units.round(h);
        }
      }
    }

    if (raw.background !== undefined) {
      const rgb = parseColor(raw.background);
      if (!rgb) this.fail(`${path}.background`, 'ERR_COLOR', 'Renk çözümlenemedi');
      else out.background = colorToHex(rgb);
    }
    out.nodes = [];
    for (const [i, n] of (nodes || []).entries()) {
      const node = this.node(`${path}.nodes[${i}]`, n, 1);
      if (node !== undefined) out.nodes.push(node);
    }

    /**
     * OKUMA SIRASI — ekran okuyucunun izleyeceği yol.
     *
     * Serbest yerleşimde çizim sırası (z-index) ile okuma sırası aynı şey
     * DEĞİLDİR: en arkadaki başlık ilk okunmalıdır. Kullanıcı vermezse
     * derleyici görsel bir sıra (yukarıdan aşağı, soldan sağa) hesaplar;
     * burada verilmişse kullanıcının dediği geçerlidir.
     */
    if (raw.readingOrder !== undefined) {
      if (!Array.isArray(raw.readingOrder)) {
        this.fail(`${path}.readingOrder`, 'ERR_TYPE', 'Dizi bekleniyordu');
      } else {
        const known = new Set();
        const collect = (list) => {
          for (const n of list) { known.add(n.id); if (n.children) collect(n.children); }
        };
        collect(out.nodes);

        out.readingOrder = [];
        for (const [i, id] of raw.readingOrder.entries()) {
          if (typeof id !== 'string' || !known.has(id)) {
            this.fail(`${path}.readingOrder[${i}]`, 'ERR_UNKNOWN_NODE',
              `Okuma sırasında bu sayfada olmayan düğüm: ${id}`);
            continue;
          }
          if (out.readingOrder.includes(id)) {
            this.fail(`${path}.readingOrder[${i}]`, 'ERR_DUPLICATE_ID',
              `Okuma sırasında yinelenen düğüm: ${id}`);
            continue;
          }
          out.readingOrder.push(id);
        }
      }
    }

    return out;
  }

  /* --- sayfa geometrisi --- */

  geometry(path, raw) {
    const g = raw && typeof raw === 'object' ? raw : {};
    let width, height;

    if (typeof g.size === 'string') {
      const named = PAGE_SIZES[g.size.toUpperCase()];
      if (!named) return this.fail(`${path}.size`, 'ERR_PAGE_SIZE', `Bilinmeyen sayfa boyutu: ${g.size}`);
      [width, height] = named;
    } else if (g.size && typeof g.size === 'object') {
      width = this.len(`${path}.size.width`, { min: 1, max: 20_000 }, g.size.width);
      height = this.len(`${path}.size.height`, { min: 1, max: 20_000 }, g.size.height);
      if (width === undefined || height === undefined) return undefined;
    } else {
      [width, height] = PAGE_SIZES.A4;
    }

    /**
     * YÖN, VERİLDİYSE ölçüyü çevirir.
     *
     * Verilmediyse ölçüye DOKUNULMAZ ve yön ondan okunur. Aksi hâlde
     * `{ size: { width: 842, height: 595 } }` gibi açık bir yatay ölçü,
     * varsayılan "portrait" tarafından sessizce dikeye çevrilirdi — içe
     * aktarılan her yatay PDF'in başına gelen tam olarak buydu.
     */
    const wanted = g.orientation === 'landscape' || g.orientation === 'portrait'
      ? g.orientation : null;
    if (wanted === 'landscape' && height > width) [width, height] = [height, width];
    if (wanted === 'portrait' && width > height) [width, height] = [height, width];

    const m = g.margin && typeof g.margin === 'object' ? g.margin : {};
    const margin = {};
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const v = this.len(`${path}.margin.${side}`, { min: 0, max: 10_000 },
        m[side] === undefined ? 0 : m[side]);
      margin[side] = v === undefined ? 0 : v;
    }

    return {
      size: typeof g.size === 'string' ? g.size.toUpperCase() : { width: units.round(width), height: units.round(height) },
      // Yön, SONUÇ ölçüsünden okunur: iki alan birbiriyle çelişemesin.
      orientation: width > height ? 'landscape' : 'portrait',
      width: units.round(width),
      height: units.round(height),
      margin
    };
  }
}

/* ------------------------------------------------------------------ */
/* Genel giriş noktası                                                 */
/* ------------------------------------------------------------------ */

/**
 * Sahneyi doğrular ve normalleştirilmiş bir KOPYA döndürür.
 * Girdiye dokunulmaz.
 *
 * @param {Object} input
 * @param {{ limits?: Object, throwOnError?: boolean }} [opts]
 * @returns {{ scene: Object|null, issues: Array }}
 */
function validateScene(input, opts = {}) {
  const v = new Validator(opts.limits);

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const issues = [{ path: '', code: 'ERR_TYPE', message: 'Sahne nesnesi bekleniyordu' }];
    if (opts.throwOnError) throw new SceneError('ERR_SCENE_INVALID', 'Sahne geçersiz', issues);
    return { scene: null, issues };
  }

  const version = input.version === undefined ? SCHEMA_VERSION : input.version;
  if (version !== SCHEMA_VERSION) {
    v.fail('version', 'ERR_VERSION',
      `Desteklenmeyen şema sürümü: ${version} (beklenen ${SCHEMA_VERSION})`);
  }

  const scene = { version: SCHEMA_VERSION };

  scene.id = typeof input.id === 'string' && ID_RE.test(input.id) ? input.id : 'scene';

  /* Üst veri — PDF /Info ve XMP'ye gidecek. */
  const meta = input.meta && typeof input.meta === 'object' ? input.meta : {};
  scene.meta = {
    title:    v.str('meta.title', { maxLength: 512 }, meta.title || '') || '',
    author:   v.str('meta.author', { maxLength: 512 }, meta.author || '') || '',
    subject:  v.str('meta.subject', { maxLength: 1024 }, meta.subject || '') || '',
    lang:     v.str('meta.lang', { maxLength: 32 }, meta.lang || 'tr-TR') || 'tr-TR',
    keywords: Array.isArray(meta.keywords)
      ? meta.keywords.slice(0, 64).map((k, i) => v.str(`meta.keywords[${i}]`, { maxLength: 128 }, String(k)))
        .filter((k) => k !== undefined)
      : []
  };

  const geometry = v.geometry('page', input.page);
  if (geometry) scene.page = geometry;

  /* Varlıklar */
  const assets = Array.isArray(input.assets) ? input.assets : [];
  if (assets.length > v.limits.maxAssets) {
    v.fail('assets', 'ERR_TOO_MANY', `En çok ${v.limits.maxAssets} varlık olabilir`);
  }
  scene.assets = [];
  for (const [i, a] of assets.slice(0, v.limits.maxAssets).entries()) {
    const asset = v.asset(`assets[${i}]`, a);
    if (asset !== undefined) scene.assets.push(asset);
  }

  /* Sayfalar */
  const pages = Array.isArray(input.pages) ? input.pages : [];
  if (!pages.length) v.fail('pages', 'ERR_EMPTY', 'Sahnede en az bir sayfa olmalı');
  if (pages.length > v.limits.maxPages) {
    v.fail('pages', 'ERR_TOO_MANY', `En çok ${v.limits.maxPages} sayfa olabilir`);
  }
  scene.pages = [];
  for (const [i, p] of pages.slice(0, v.limits.maxPages).entries()) {
    const page = v.page(`pages[${i}]`, p, i);
    if (page !== undefined) scene.pages.push(page);
  }

  /* Bütünlük: her varlık göndermesi gerçek bir varlığa çıkmalı */
  const known = new Set(scene.assets.map((a) => a.id));
  for (const ref of v.assetIds) {
    if (!known.has(ref)) {
      v.fail('assets', 'ERR_ASSET_MISSING', `Gönderilen varlık sahnede yok: ${ref}`);
    }
  }

  if (v.issues.length) {
    if (opts.throwOnError) {
      throw new SceneError('ERR_SCENE_INVALID',
        `Sahne geçersiz: ${v.issues.length} sorun (ilki: ${v.issues[0].path} ${v.issues[0].message})`,
        v.issues);
    }
    return { scene: null, issues: v.issues };
  }
  return { scene, issues: [] };
}

module.exports = { validateScene, SceneError, parseColor, colorToHex, ID_RE };
