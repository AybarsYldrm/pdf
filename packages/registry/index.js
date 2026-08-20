'use strict';
/**
 * @fitfak/registry — imzalanan belgelerin EKLEMELİ (append-only) kaydı.
 *
 * NEDEN VAR: karekod tarayıcısı elinde yalnız bir ÖZET tutar. Belgenin
 * kendisi orada değildir; imzayı yeniden doğrulayamaz. Kayıt olmadan
 * verilebilecek tek dürüst cevap "bilmiyorum"dur — ve bir doğrulama ürünü
 * için bu, ürünün olmaması demektir.
 *
 * NE KAYDEDİLİR: belgenin özeti, imzalandığı an yapılan doğrulamanın
 * SONUCU (`@fitfak/verify` raporunun özeti), imzalayanın adı, seviye ve
 * zaman. Belgenin kendisi ASLA saklanmaz: kayıt defteri bir arşiv değildir
 * ve içeriğe erişim vermemelidir.
 *
 * NEDEN EKLEMELİ VE ZİNCİRLİ: kayıt silinebiliyorsa kayıt değildir. Her
 * satır bir öncekinin özetini taşır (`prev`) ve satırın tamamı bir anahtarla
 * HMAC'lenir. Böylece:
 *   - bir satırı DEĞİŞTİRMEK HMAC'i bozar,
 *   - bir satırı SİLMEK ya da yerini değiştirmek zinciri kopartır,
 *   - anahtarı bilmeyen biri geçerli satır EKLEYEMEZ.
 *
 * ANAHTAR YOKSA KAYIT DEFTERİ YOKTUR. Anahtarsız yazmak, doğrulanamayan bir
 * kayıt üretmek olurdu; onu "kayıt" diye sunmak da tam olarak kaçındığımız
 * şeydir. Yapılandırılmamışsa defter KAPALIDIR ve öyle olduğunu söyler.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class RegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}

/** Tek kaydın en büyük boyu — sınırsız satır, sınırsız bellek demektir. */
const MAX_RECORD_BYTES = 4096;

/** Okunacak en fazla kayıt (bellek koruması). */
const MAX_RECORDS = 500_000;

/** Kilidin bayat sayılma süresi: süreç çökerse defter kilitli kalmasın. */
const LOCK_STALE_MS = 10_000;

const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Kaydı kanonik biçime çevirir.
 *
 * HMAC'in ne üzerinde hesaplandığı KESİN olmalıdır: alan sırası değişirse
 * aynı kayıt farklı MAC üretir ve eski defter doğrulanamaz hâle gelir.
 * Bu yüzden alanlar burada sabit sırayla, elle yazılır.
 */
function canonical(record) {
  return JSON.stringify([
    record.seq,
    record.documentHash,
    record.docNo || '',
    record.signedAt,
    record.signer || '',
    record.issuer || '',
    record.level || '',
    record.indication || '',
    record.subIndication || '',
    record.signatureCount || 0,
    record.timestamped === true,
    record.prev
  ]);
}

class Registry {
  /**
   * @param {{ dir?: string, key?: string|Buffer, file?: string }} [o]
   *   `dir` verilmezse defter KAPALIDIR. `key` zorunludur: anahtarsız bir
   *   defter doğrulanamaz ve doğrulanamayan kayıt kayıt değildir.
   */
  constructor(o = {}) {
    const dir = (o.dir || '').trim();
    this.enabled = !!dir;
    this.dir = dir;
    this.file = o.file || (dir ? path.join(dir, 'registry.log') : '');

    if (!this.enabled) { this.key = null; return; }

    const key = o.key === undefined ? '' : o.key;
    if (!key || String(key).length < 16) {
      throw new RegistryError('ERR_REGISTRY_KEY',
        'Kayıt defteri için en az 16 karakterlik bir anahtar gerekir ' +
        '(REGISTRY_KEY). Anahtarsız defter doğrulanamaz.');
    }
    this.key = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8');

    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    /** Okuma önbelleği: dosya değişmediyse yeniden ayrıştırma. */
    this._cache = null;
  }

  /* ---------------------------------------------------------------- */
  /* Yazma                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Kayıt ekler.
   *
   * @param {{ documentHash:string, docNo?:string, signer?:string,
   *           issuer?:string, level?:string, indication?:string,
   *           subIndication?:string, signatureCount?:number,
   *           timestamped?:boolean, signedAt?:string }} input
   * @returns {{ seq:number, mac:string }}
   */
  append(input) {
    this._require();

    const documentHash = String(input.documentHash || '').toLowerCase();
    if (!HASH_RE.test(documentHash)) {
      throw new RegistryError('ERR_REGISTRY_HASH',
        'documentHash 64 karakterlik küçük harf SHA-256 olmalı');
    }

    return this._withLock(() => {
      const state = this._read();
      const last = state.records[state.records.length - 1];

      const record = {
        seq: last ? last.seq + 1 : 1,
        documentHash,
        docNo: str(input.docNo, 128),
        signedAt: input.signedAt || new Date().toISOString(),
        signer: str(input.signer, 256),
        issuer: str(input.issuer, 256),
        level: str(input.level, 32),
        indication: str(input.indication, 32),
        subIndication: str(input.subIndication, 64),
        signatureCount: Number(input.signatureCount) || 0,
        timestamped: input.timestamped === true,
        prev: last ? last.mac : ''.padEnd(0)
      };
      record.mac = this._mac(record);

      const line = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
        throw new RegistryError('ERR_REGISTRY_TOO_LARGE',
          `Kayıt ${MAX_RECORD_BYTES} bayt sınırını aştı`);
      }

      fs.appendFileSync(this.file, line, { mode: 0o600 });
      this._cache = null;
      return { seq: record.seq, mac: record.mac };
    });
  }

  /* ---------------------------------------------------------------- */
  /* Okuma                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Özete göre kayıt arar.
   *
   * BULUNAMAYAN KAYIT İÇİN `null` DÖNER — "yok" ile "geçersiz" farklı
   * şeylerdir ve çağıran ikisini karıştırmamalıdır.
   */
  lookup(documentHash) {
    if (!this.enabled) return null;
    const hash = String(documentHash || '').toLowerCase();
    if (!HASH_RE.test(hash)) return null;
    return this._read().byHash.get(hash) || null;
  }

  /** Belge numarasına göre arar (karekod yükü numara taşıyorsa). */
  lookupByDocNo(docNo) {
    if (!this.enabled) return null;
    const key = str(docNo, 128);
    if (!key) return null;
    return this._read().byDocNo.get(key) || null;
  }

  /**
   * Zinciri baştan sona doğrular.
   *
   * @returns {{ ok:boolean, records:number, brokenAt:number|null, reason:string }}
   */
  verifyChain() {
    if (!this.enabled) {
      return { ok: false, records: 0, brokenAt: null, reason: 'Defter kapalı' };
    }
    const state = this._read();
    return {
      ok: state.broken === null,
      records: state.records.length,
      brokenAt: state.broken,
      reason: state.reason
    };
  }

  describe() {
    if (!this.enabled) return { enabled: false, records: 0 };
    const state = this._read();
    return {
      enabled: true,
      records: state.records.length,
      intact: state.broken === null,
      brokenAt: state.broken,
      last: state.records.length
        ? state.records[state.records.length - 1].signedAt : null
    };
  }

  /* ---------------------------------------------------------------- */
  /* İç işler                                                          */
  /* ---------------------------------------------------------------- */

  _require() {
    if (!this.enabled) {
      throw new RegistryError('ERR_REGISTRY_DISABLED',
        'Kayıt defteri yapılandırılmadı (REGISTRY_DIR ve REGISTRY_KEY)');
    }
  }

  _mac(record) {
    return crypto.createHmac('sha256', this.key)
      .update(canonical(record)).digest('hex');
  }

  /**
   * Defteri okur ve zinciri doğrular.
   *
   * ZİNCİR KIRILDIĞI YERDE DURULUR. Kırık noktadan SONRAKİ kayıtlar
   * indekse alınmaz: bir saldırgan defterin ortasını bozup sonuna kendi
   * kaydını eklerse, o kayıt "doğrulanmış" sayılmamalıdır.
   */
  _read() {
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch {
      return { records: [], byHash: new Map(), byDocNo: new Map(), broken: null, reason: '' };
    }

    if (this._cache && this._cache.size === stat.size && this._cache.mtimeMs === stat.mtimeMs) {
      return this._cache.state;
    }

    const text = fs.readFileSync(this.file, 'utf8');
    const lines = text.split('\n').filter(Boolean);

    const records = [];
    const byHash = new Map();
    const byDocNo = new Map();
    let broken = null;
    let reason = '';
    let prev = '';

    for (let i = 0; i < lines.length && i < MAX_RECORDS; i++) {
      let record;
      try {
        record = JSON.parse(lines[i]);
      } catch {
        broken = i + 1; reason = 'Satır ayrıştırılamadı';
        break;
      }

      if (record.prev !== prev) {
        broken = i + 1; reason = 'Zincir kopuk: önceki kaydın özeti tutmuyor';
        break;
      }
      const expected = this._mac(record);
      // Sabit zamanlı karşılaştırma: MAC doğrulamasında erken çıkış,
      // baytı bayta tahmin etme yolu açar.
      const given = Buffer.from(String(record.mac || ''), 'utf8');
      const want = Buffer.from(expected, 'utf8');
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
        broken = i + 1; reason = 'Kayıt değiştirilmiş: HMAC tutmuyor';
        break;
      }

      records.push(record);
      // Aynı belge birden çok kez imzalanabilir: SON kayıt geçerlidir.
      byHash.set(record.documentHash, record);
      if (record.docNo) byDocNo.set(record.docNo, record);
      prev = record.mac;
    }

    if (broken === null && lines.length > MAX_RECORDS) {
      reason = `Defter ${MAX_RECORDS} kayıttan uzun; fazlası okunmadı`;
    }

    const state = { records, byHash, byDocNo, broken, reason };
    this._cache = { size: stat.size, mtimeMs: stat.mtimeMs, state };
    return state;
  }

  /**
   * Yazma kilidi.
   *
   * Hız sınırlayıcının aksine BURADA kilit vardır: yazma seyrektir (imza
   * başına bir kayıt) ve zincir sıraya bağlıdır. İki süreç aynı `prev`
   * değerini okursa zincir çatallanır ve defter bir daha doğrulanamaz.
   */
  _withLock(fn) {
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + LOCK_STALE_MS;

    for (;;) {
      let fd;
      try {
        fd = fs.openSync(lock, 'wx');
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;

        // Bayat kilit: sahibi çöktüyse defter sonsuza dek kilitli kalmasın.
        try {
          const age = Date.now() - fs.statSync(lock).mtimeMs;
          if (age > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; }
        } catch { /* yarışta silinmiş */ }

        if (Date.now() > deadline) {
          throw new RegistryError('ERR_REGISTRY_LOCKED',
            'Kayıt defteri kilidi alınamadı');
        }
        sleep(5);
        continue;
      }

      try {
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return fn();
      } finally {
        try { fs.unlinkSync(lock); } catch { /* zaten yok */ }
      }
    }
  }
}

/** Kısa, güvenli dizge (kayıt satırı sınırsız büyümesin). */
function str(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[ -]/g, ' ').slice(0, max);
}

/** Kısa, eşzamanlı bekleme — kilit döngüsü için (yazma seyrektir). */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Belge özeti — kayıt anahtarının tek üretim yolu. */
function documentHash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * `@fitfak/verify` raporundan kayıt üretir.
 *
 * Rapordan yalnız ÖZET alınır: sertifika içerikleri, imza değerleri ve
 * belgenin kendisi deftere GİRMEZ. Defter bir arşiv değildir.
 */
function recordFromReport(report, o = {}) {
  const signatures = (report && report.signatures) || [];
  // Belge imzası aranır: en son eklenen belge zaman damgası (`doc-timestamp`)
  // imzalayanı değil TSA'yı gösterir; onu "imzalayan" diye yazmak yanlış
  // olurdu.
  const first = signatures.find((s) => s.type !== 'doc-timestamp') || signatures[0] || {};
  const signer = first.signer || {};

  return {
    documentHash: o.documentHash,
    docNo: o.docNo,
    signedAt: o.signedAt || new Date().toISOString(),
    signer: signer.cn || signer.subject || o.signer || '',
    issuer: signer.issuer || '',
    level: first.achievedLevel || o.level || '',
    indication: first.indication || '',
    subIndication: first.subIndication || '',
    signatureCount: signatures.filter((s) => s.type !== 'doc-timestamp').length,
    timestamped: Array.isArray(first.timestamps)
      ? first.timestamps.some((t) => t && t.valid)
      : false
  };
}

module.exports = {
  Registry, RegistryError, documentHash, recordFromReport, canonical,
  MAX_RECORD_BYTES, MAX_RECORDS
};
