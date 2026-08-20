'use strict';
/**
 * Font kayıt defteri — sunucunun sunabileceği aileler.
 *
 * NEDEN GEREKLİ
 *
 * İstemcinin verdiği bir font DOSYA YOLU kabul edilemez: bu, belgeden gelen
 * bir yolun dosya sistemine ulaşması demektir (bkz. docs/08-guvenlik.md G-01).
 * O yüzden sunucu, hangi fontları sunacağını KENDİSİ bilir ve istemci yalnız
 * AİLE ADI seçer.
 *
 * Kayıt defteri bir dizini tarar, her dosyanın kimliğini `FontInfo` ile
 * okur ve aile/ağırlık/stil üçlüsüne göre indeksler. Böylece "Ubuntu Bold
 * Italic" istendiğinde doğru DOSYA seçilir — dosya adına bakarak tahmin
 * edilmez.
 *
 * Tarama YİNELEMELİ DEĞİLDİR ve `realpath` ile kökün içinde kaldığı
 * doğrulanır: font dizinine konan bir sembolik bağ, dizin dışındaki bir
 * dosyayı "font" diye sunamaz.
 */

const fs = require('fs');
const path = require('path');
const { readFontInfo, FontInfoError } = require('@fitfak/pdf/src/fonts/FontInfo');

const FONT_EXTENSIONS = new Set(['.ttf', '.otf']);

/** Bir yüzün "ne kadar uygun" olduğunu ölçer; küçük daha iyi. */
function score(face, weight, style) {
  const styleCost = face.style === style ? 0 : (style === 'italic' ? 300 : 200);
  return styleCost + Math.abs(face.weight - weight);
}

class FontRegistry {
  /**
   * @param {{ maxBytes?: number, maxFiles?: number }} [opts]
   */
  constructor(opts = {}) {
    this.maxBytes = opts.maxBytes || 16 * 1024 * 1024;
    this.maxFiles = opts.maxFiles || 256;

    /** @type {Map<string, Array<Object>>} normalleştirilmiş aile → yüzler */
    this.families = new Map();
    /** Taramada atlanan dosyalar ve sebepleri (tanılama için). */
    this.skipped = [];
  }

  get size() {
    let n = 0;
    for (const list of this.families.values()) n += list.length;
    return n;
  }

  get isEmpty() { return this.families.size === 0; }

  /**
   * Bir yüzü elle kaydeder.
   * @param {{ file?:string, bytes?:Buffer, family?:string,
   *           weight?:number, style?:string, origin?:string }} entry
   */
  register(entry) {
    const bytes = entry.bytes || (entry.file ? fs.readFileSync(entry.file) : null);
    if (!bytes) throw new Error('FontRegistry.register: file ya da bytes gerekli');
    if (bytes.length > this.maxBytes) {
      throw new FontInfoError('ERR_FONT_TOO_LARGE',
        `Font çok büyük: ${bytes.length} bayt (sınır ${this.maxBytes})`);
    }

    const info = readFontInfo(bytes);
    const face = {
      family: entry.family || info.family,
      subfamily: info.subfamily,
      weight: entry.weight || info.weight,
      style: entry.style || info.style,
      unitsPerEm: info.unitsPerEm,
      file: entry.file || null,
      // Baytları tutmak, aynı dosyayı iki kez okumamak içindir; dosya
      // yolundan gelenlerde bellek tutulmaz, gerektiğinde okunur.
      bytes: entry.file ? null : bytes,
      origin: entry.origin || (entry.file ? 'directory' : 'inline')
    };

    const key = normalizeFamily(face.family);
    if (!this.families.has(key)) this.families.set(key, []);

    const list = this.families.get(key);
    // Aynı ağırlık+stil ikinci kez gelirse İLK kayıt korunur: tarama sırası
    // dosya sistemine bağlıdır ve son gelenin kazanması sonucu öngörülemez
    // kılar.
    if (!list.some((f) => f.weight === face.weight && f.style === face.style)) {
      list.push(face);
    }
    return face;
  }

  /**
   * Bir dizindeki fontları tarar (yinelemeli DEĞİL).
   * @returns {{ added: number, skipped: number }}
   */
  scanDirectory(dir) {
    let root;
    try {
      root = fs.realpathSync(path.resolve(dir));
    } catch {
      return { added: 0, skipped: 0 };
    }

    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      this.skipped.push({ file: root, reason: err.message });
      return { added: 0, skipped: 0 };
    }

    let added = 0;
    let skipped = 0;

    for (const entry of entries.slice(0, this.maxFiles)) {
      if (!FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

      const file = path.join(root, entry.name);
      let real;
      try {
        real = fs.realpathSync(file);
      } catch {
        skipped++; continue;
      }
      // Sembolik bağ dizin dışına çıkıyorsa font sayılmaz
      if (real !== root && !real.startsWith(root + path.sep)) {
        this.skipped.push({ file, reason: 'kök dışına sembolik bağ' });
        skipped++; continue;
      }
      const stat = fs.statSync(real);
      if (!stat.isFile() || stat.size > this.maxBytes) {
        this.skipped.push({ file, reason: 'dosya değil ya da çok büyük' });
        skipped++; continue;
      }

      try {
        this.register({ file: real, origin: 'directory' });
        added++;
      } catch (err) {
        // Bozuk bir font bütün taramayı düşürmemeli
        this.skipped.push({ file, reason: err.message });
        skipped++;
      }
    }

    return { added, skipped };
  }

  /** Aile adı kayıtlı mı? */
  has(family) { return this.families.has(normalizeFamily(family)); }

  /** Kayıtlı aile adları (özgün yazımlarıyla). */
  familyNames() {
    return [...this.families.values()]
      .map((list) => list[0].family)
      .sort((a, b) => a.localeCompare(b, 'tr'));
  }

  /** Arayüzde göstermek için: aile → varyantlar. */
  describe() {
    return [...this.families.values()].map((list) => ({
      family: list[0].family,
      variants: list
        .map((f) => ({ weight: f.weight, style: f.style, subfamily: f.subfamily }))
        .sort((a, b) => a.weight - b.weight || a.style.localeCompare(b.style))
    })).sort((a, b) => a.family.localeCompare(b.family, 'tr'));
  }

  /**
   * Ailenin BÜTÜN yüzlerini `FontManager.register()` biçiminde döndürür.
   *
   * Kalın/eğik varyantları ayrı ayrı vermek şart: `FontManager` yüz seçimini
   * kendisi yapar ama seçebilmesi için önce onları görmesi gerekir.
   *
   * @param {string[]} families istenen aileler (bulunamayan atlanır)
   * @returns {{ faces: Array, missing: string[] }}
   */
  facesFor(families) {
    const faces = [];
    const missing = [];
    const seen = new Set();

    for (const name of families || []) {
      const key = normalizeFamily(name);
      const list = this.families.get(key);
      if (!list || !list.length) { missing.push(String(name)); continue; }

      for (const face of list) {
        const id = `${key}:${face.weight}:${face.style}`;
        if (seen.has(id)) continue;
        seen.add(id);
        faces.push({
          family: face.family,
          weight: face.weight,
          style: face.style,
          src: face.bytes || face.file
        });
      }
    }
    return { faces, missing };
  }

  /** İstenen aile yoksa geri düşülecek aile (ilk kayıtlı olan). */
  defaultFamily() {
    const first = this.families.values().next().value;
    return first && first.length ? first[0].family : null;
  }

  /** Tek bir yüzü seçer (test ve tanılama için). */
  resolve(family, weight = 400, style = 'normal') {
    const list = this.families.get(normalizeFamily(family));
    if (!list || !list.length) return null;
    return list.reduce((best, f) =>
      (score(f, weight, style) < score(best, weight, style) ? f : best), list[0]);
  }
}

/** Aile adları büyük/küçük harf ve boşluktan bağımsız eşleşir. */
function normalizeFamily(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

module.exports = { FontRegistry, normalizeFamily, FONT_EXTENSIONS };
