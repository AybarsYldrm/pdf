'use strict';
/**
 * Hız sınırlayıcı depoları.
 *
 * SORUN: sayaç süreç belleğinde durursa, sunucu iki süreçle çalıştığı anda
 * sınır ikiye katlanır. `cluster` ile dört çekirdek açan bir kurulumda
 * "dakikada 10 imza" fiilen 40 olur. Bir güvenlik denetiminin çarpanla
 * çalışması, olmamasından daha kötüdür: rapor "sınır var" der, gerçek
 * başka söyler.
 *
 * ÇÖZÜM: depo arayüzü ayrılır. Varsayılan bellek deposu tek süreç için
 * yeterlidir; `FileStore` sayaçları dosya sisteminde paylaştırır ve aynı
 * makinedeki bütün süreçler aynı sayacı görür.
 *
 * NEDEN DOSYA, NEDEN REDIS DEĞİL: bu depoda sıfır bağımlılık kuralı var.
 * Redis eklemek, tek bir sayaç için işletme yükü (kurulum, erişim, yedek)
 * getirirdi. Dosya deposu aynı makinedeki süreçleri kapsar — yatay
 * ölçeklenen bir kurulum için arayüz zaten hazırdır, başka bir depo
 * yazmak yeter.
 *
 * KİLİT YOKTUR — VE BUNUN BEDELİ BİLİNİYOR.
 *
 * Her istek dosyanın sonuna 8 baytlık bir zaman damgası ekler (`O_APPEND`
 * ile tek yazma çağrısı). Kilit almak, çekişme anında olay döngüsünü
 * bloklardı. Bedeli şudur: iki süreç aynı anda son kotayı okursa sınır bir
 * istek aşılabilir. N süreçte en fazla N-1 fazla istek demektir; kabul
 * edilmiş ve burada yazılı bir sapmadır.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Bir kaydın bayt uzunluğu (çift duyarlıklı ms zaman damgası). */
const RECORD = 8;

/**
 * Bellek deposu — tek süreç.
 *
 * Davranışı önceki sürümle birebir aynıdır: yeni depo arayüzü mevcut
 * kurulumların davranışını değiştirmez.
 */
class MemoryStore {
  constructor() {
    this.buckets = new Map();
    /** Sınırlayıcının kendisi de sınırlı olmalı: anahtar sayısı patlamasın. */
    this.maxKeys = 10_000;
  }

  /**
   * Pencere içindeki vuruşları döndürür ve (izin veriliyorsa) yenisini yazar.
   * @returns {{ hits: number[], recorded: boolean }}
   */
  record(key, now, cutoff, limit) {
    let hits = this.buckets.get(key);
    if (!hits) {
      if (this.buckets.size >= this.maxKeys) this.sweep(now, now - (now - cutoff));
      hits = [];
      this.buckets.set(key, hits);
    }

    while (hits.length && hits[0] < cutoff) hits.shift();
    if (hits.length >= limit) return { hits, recorded: false };

    hits.push(now);
    return { hits, recorded: true };
  }

  sweep(now, cutoff) {
    for (const [key, hits] of this.buckets) {
      while (hits.length && hits[0] < cutoff) hits.shift();
      if (!hits.length) this.buckets.delete(key);
    }
  }

  clear() { this.buckets.clear(); }

  describe() { return { kind: 'memory', shared: false, keys: this.buckets.size }; }
}

/**
 * Dosya deposu — aynı makinedeki bütün süreçler.
 *
 * Anahtar dosya adına ÇEVRİLMEZ, ÖZETLENİR: anahtar istemciden gelen bir
 * IP ya da belirteç özetidir ve doğrudan yola yazmak dizin dışına çıkma
 * (path traversal) yüzeyi açardı. SHA-256 onaltılık gösterimi yalnız
 * `[0-9a-f]` üretir.
 */
class FileStore {
  /**
   * @param {{ dir: string, maxKeys?: number }} o
   */
  constructor(o) {
    this.dir = o.dir;
    this.maxKeys = o.maxKeys || 10_000;
    /** Depo yazamadığında bellek deposuna düşülür — sessizce değil, sayarak. */
    this.fallback = new MemoryStore();
    this.failures = 0;
    this.lastError = null;

    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  _file(key) {
    const digest = crypto.createHash('sha256').update(key).digest('hex');
    return path.join(this.dir, `${digest}.hit`);
  }

  record(key, now, cutoff, limit) {
    const file = this._file(key);

    let hits;
    try {
      hits = readHits(file, cutoff);
    } catch (err) {
      return this._degrade(err, key, now, cutoff, limit);
    }

    if (hits.length >= limit) return { hits, recorded: false };

    try {
      // `O_APPEND` ile tek yazma: küçük yazmalar POSIX'te bölünmez, yani
      // iki süreç aynı anda yazsa da kayıtlar birbirine karışmaz.
      const buf = Buffer.alloc(RECORD);
      buf.writeDoubleBE(now, 0);
      fs.appendFileSync(file, buf, { mode: 0o600 });
    } catch (err) {
      return this._degrade(err, key, now, cutoff, limit);
    }

    hits.push(now);

    // Sıkıştırma: dosya sınırın dört katına çıktıysa pencere dışı kayıtlar
    // atılır. Yalnız sayaç sınırdan uzakken yapılır — çekişme anında
    // yeniden yazmak, o an eklenen bir vuruşu kaybettirebilir ve kaybedilen
    // vuruş sınırı GEVŞETİR.
    if (hits.length * 4 < limit && fileRecords(file) > limit * 4) {
      compact(file, hits);
    }
    return { hits, recorded: true };
  }

  /** Depo çalışmıyorsa: bellek deposuyla devam, ama sayarak ve bildirerek. */
  _degrade(err, key, now, cutoff, limit) {
    this.failures++;
    this.lastError = err.message;
    if (this.failures === 1) {
      console.warn('[hız sınırı] paylaşımlı depo yazılamıyor, süreç içi ' +
                   `sayaca düşülüyor: ${err.message}`);
    }
    return this.fallback.record(key, now, cutoff, limit);
  }

  sweep(now, cutoff) {
    let names;
    try { names = fs.readdirSync(this.dir); }
    catch { return; }

    for (const name of names) {
      if (!name.endsWith('.hit')) continue;
      const file = path.join(this.dir, name);
      try {
        const stat = fs.statSync(file);
        // Pencereden eski dosyada tek bir geçerli kayıt bile olamaz.
        if (stat.mtimeMs < cutoff) { fs.unlinkSync(file); continue; }
      } catch { /* yarışta silinmiş olabilir */ }
    }
    this.fallback.sweep(now, cutoff);
  }

  clear() {
    this.fallback.clear();
    let names;
    try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      if (name.endsWith('.hit')) {
        try { fs.unlinkSync(path.join(this.dir, name)); } catch { /* yarış */ }
      }
    }
  }

  describe() {
    let keys = 0;
    try { keys = fs.readdirSync(this.dir).filter((n) => n.endsWith('.hit')).length; }
    catch { /* okunamıyorsa 0 */ }
    return {
      kind: 'file', shared: true, dir: this.dir, keys,
      failures: this.failures,
      lastError: this.lastError
    };
  }
}

/** Dosyadaki pencere İÇİ zaman damgalarını okur. */
function readHits(file, cutoff) {
  let data;
  try {
    data = fs.readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const out = [];
  // Yarım kayıt: yazma tam ortasında kesilmişse son parça atılır.
  const count = Math.floor(data.length / RECORD);
  for (let i = 0; i < count; i++) {
    const t = data.readDoubleBE(i * RECORD);
    if (Number.isFinite(t) && t >= cutoff) out.push(t);
  }
  out.sort((a, b) => a - b);
  return out;
}

function fileRecords(file) {
  try { return Math.floor(fs.statSync(file).size / RECORD); }
  catch { return 0; }
}

/** Pencere dışı kayıtları atar (geçici dosya + yeniden adlandırma). */
function compact(file, hits) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const buf = Buffer.alloc(hits.length * RECORD);
    hits.forEach((t, i) => buf.writeDoubleBE(t, i * RECORD));
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* yoksa sorun değil */ }
  }
}

module.exports = { MemoryStore, FileStore, RECORD };
