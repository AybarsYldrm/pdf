'use strict';
/**
 * Varlık yöneticisi.
 *
 * NEDEN KİMLİK, NEDEN YOL DEĞİL
 *
 * Sahne düğümleri dosya yolu tutsaydı üç şey birden bozulurdu:
 *   1. Sahne dosyası taşınamazdı (yol makineye özgüdür),
 *   2. belge içeriği dosya sistemine dokunabilirdi (bkz. G-01),
 *   3. aynı görsel on kez kullanılınca on kez gömülürdü.
 *
 * Bunun yerine her varlık BİR KEZ kaydedilir, SHA-256 özetiyle tekilleştirilir
 * ve düğümler yalnız `assetId` tutar.
 *
 * TEKİLLEŞTİRME ÖZETLE YAPILIR, ADLA DEĞİL: aynı adlı iki farklı dosya
 * karışmaz, farklı adlı iki aynı dosya bir kez gömülür.
 */

const crypto = require('crypto');

const DEFAULT_LIMITS = {
  maxAssets: 512,
  maxBytes: 16 * 1024 * 1024,        // tek varlık
  maxTotalBytes: 128 * 1024 * 1024,  // toplam
  maxPixels: 50_000_000
};

class AssetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AssetError';
    this.code = code;
  }
}

/** Bilinen imzalar — uzantıya değil, BAYTA bakılır. */
const SIGNATURES = [
  { mime: 'image/png',  kind: 'image', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', kind: 'image', magic: [0xff, 0xd8, 0xff] },
  { mime: 'font/ttf',   kind: 'font',  magic: [0x00, 0x01, 0x00, 0x00] },
  { mime: 'font/otf',   kind: 'font',  magic: [0x4f, 0x54, 0x54, 0x4f] },   // 'OTTO'
  { mime: 'font/ttf',   kind: 'font',  magic: [0x74, 0x72, 0x75, 0x65] }    // 'true'
];

/**
 * Türü baytlardan belirler.
 *
 * Uzantıya ya da istemcinin bildirdiği MIME'a güvenmek, `.png` adlı bir
 * yürütülebiliri "görsel" saymak demektir. Bayt imzası yalan söylemez.
 */
function sniff(bytes) {
  for (const sig of SIGNATURES) {
    if (bytes.length < sig.magic.length) continue;
    let ok = true;
    for (let i = 0; i < sig.magic.length; i++) {
      if (bytes[i] !== sig.magic[i]) { ok = false; break; }
    }
    if (ok) return { mime: sig.mime, kind: sig.kind };
  }
  return null;
}

/** PNG/JPEG boyutlarını başlıktan okur (tam çözmeden). */
function readImageSize(bytes, mime) {
  if (mime === 'image/png') {
    // IHDR her zaman ilk yığındır: 8 bayt imza + 4 uzunluk + 4 tip
    if (bytes.length < 24) return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mime === 'image/jpeg') {
    let p = 2;
    while (p + 9 < bytes.length) {
      if (bytes[p] !== 0xff) { p++; continue; }
      const marker = bytes[p + 1];
      // SOF0..SOF15, DHT/DAC/RST hariç
      if (marker >= 0xc0 && marker <= 0xcf &&
          marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(p + 5), width: bytes.readUInt16BE(p + 7) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { p += 2; continue; }
      const len = bytes.readUInt16BE(p + 2);
      if (len < 2) return null;
      p += 2 + len;
    }
  }
  return null;
}

class AssetManager {
  /**
   * @param {{ limits?: Object, assets?: Array, bytes?: Map<string, Buffer> }} [opts]
   */
  constructor(opts = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
    /** @type {Map<string, Object>} kimlik → üst veri */
    this.byId = new Map();
    /** @type {Map<string, string>} sha256 → kimlik (tekilleştirme dizini) */
    this.byHash = new Map();
    /** @type {Map<string, Buffer>} kimlik → baytlar */
    this.blobs = new Map();
    this.totalBytes = 0;

    for (const a of opts.assets || []) {
      this.byId.set(a.id, a);
      this.byHash.set(a.sha256, a.id);
      const buf = opts.bytes && opts.bytes.get(a.id);
      if (buf) { this.blobs.set(a.id, buf); this.totalBytes += buf.length; }
    }
  }

  /**
   * Varlık ekler. Aynı içerik daha önce eklendiyse YENİ kayıt açılmaz,
   * var olanın kimliği döner.
   *
   * @param {Buffer|Uint8Array} bytes
   * @param {{ name?: string, kind?: string }} [meta]
   * @returns {Object} varlık üst verisi
   */
  add(bytes, meta = {}) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (!buf.length) throw new AssetError('ERR_ASSET_EMPTY', 'Varlık boş');
    if (buf.length > this.limits.maxBytes) {
      throw new AssetError('ERR_ASSET_TOO_LARGE',
        `Varlık çok büyük: ${buf.length} bayt (sınır ${this.limits.maxBytes})`);
    }

    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const existing = this.byHash.get(sha256);
    if (existing) return this.byId.get(existing);

    if (this.byId.size >= this.limits.maxAssets) {
      throw new AssetError('ERR_ASSET_TOO_MANY',
        `En çok ${this.limits.maxAssets} varlık eklenebilir`);
    }
    if (this.totalBytes + buf.length > this.limits.maxTotalBytes) {
      throw new AssetError('ERR_ASSET_TOTAL_TOO_LARGE',
        `Toplam varlık boyutu sınırı aşıldı (${this.limits.maxTotalBytes} bayt)`);
    }

    const type = sniff(buf);
    if (!type) {
      throw new AssetError('ERR_ASSET_TYPE',
        'Desteklenmeyen varlık türü (PNG, JPEG, TTF ya da OTF bekleniyordu)');
    }
    if (meta.kind && meta.kind !== type.kind) {
      throw new AssetError('ERR_ASSET_KIND',
        `Beklenen tür ${meta.kind}, gelen ${type.kind}`);
    }

    const asset = {
      id: 'ast_' + sha256.slice(0, 16),
      kind: type.kind,
      mime: type.mime,
      sha256,
      size: buf.length
    };
    if (meta.name) asset.name = String(meta.name).slice(0, 256);

    if (type.kind === 'image') {
      const dim = readImageSize(buf, type.mime);
      asset.width = dim ? dim.width : 0;
      asset.height = dim ? dim.height : 0;
      if (asset.width * asset.height > this.limits.maxPixels) {
        throw new AssetError('ERR_ASSET_PIXELS',
          `Görsel çok büyük: ${asset.width}×${asset.height} ` +
          `(sınır ${this.limits.maxPixels} piksel)`);
      }
    }

    this.byId.set(asset.id, asset);
    this.byHash.set(sha256, asset.id);
    this.blobs.set(asset.id, buf);
    this.totalBytes += buf.length;
    return asset;
  }

  get(id) { return this.byId.get(id) || null; }
  bytes(id) { return this.blobs.get(id) || null; }
  has(id) { return this.byId.has(id); }
  get size() { return this.byId.size; }

  /** Sahneye yazılacak üst veri listesi (baytlar ayrı taşınır). */
  manifest() {
    return [...this.byId.values()].map((a) => ({ ...a }));
  }

  /**
   * Hiçbir düğümün göndermediği varlıkları atar.
   *
   * Editörde bir görseli silmek varlığı silmez; aksi hâlde geri alma
   * (undo) baytları bulamazdı. Temizlik AÇIK bir eylemdir.
   *
   * @param {Set<string>|string[]} usedIds
   * @returns {number} atılan varlık sayısı
   */
  prune(usedIds) {
    const used = usedIds instanceof Set ? usedIds : new Set(usedIds);
    let removed = 0;
    for (const id of [...this.byId.keys()]) {
      if (used.has(id)) continue;
      const a = this.byId.get(id);
      const buf = this.blobs.get(id);
      if (buf) this.totalBytes -= buf.length;
      this.byId.delete(id);
      this.byHash.delete(a.sha256);
      this.blobs.delete(id);
      removed++;
    }
    return removed;
  }
}

module.exports = { AssetManager, AssetError, DEFAULT_LIMITS, sniff, readImageSize };
