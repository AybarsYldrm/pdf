'use strict';
/**
 * Font ailesi yöneticisi.
 *
 * @fitfak/pdf'in `registerFont(name, path)` API'si aile başına tek yüz
 * destekliyordu; `bold`/`italic` varyantı seçilemiyordu. Burada CSS'in
 * beklediği gibi aile + ağırlık + stil üçlüsüyle yüz seçimi yapılır.
 */

const fs = require('fs');
const path = require('path');
const TtfParser = require('@fitfak/pdf/src/fonts/TtfParser');

/** Genel aile adları için yedek zinciri. */
const GENERIC_FALLBACKS = {
  'sans-serif': ['sans-serif'],
  'serif': ['serif'],
  'monospace': ['monospace'],
  'system-ui': ['sans-serif'],
  'ui-sans-serif': ['sans-serif'],
  'ui-serif': ['serif'],
  'ui-monospace': ['monospace']
};

class FontManager {
  constructor() {
    /** @type {Map<string, Array<{weight:number, style:string, parser:TtfParser, file:string, id:string}>>} */
    this.families = new Map();
    this.byId = new Map();
    this._counter = 0;
  }

  /**
   * Bir font yüzü kaydeder.
   * @param {{ family:string, weight?:number|string, style?:string, src:string }} face
   */
  register(face) {
    if (!face || !face.family || !face.src) {
      throw new Error('FontManager.register: family ve src zorunlu');
    }
    const file = path.resolve(face.src);
    if (!fs.existsSync(file)) {
      throw new Error(`Font dosyası bulunamadı: ${file}`);
    }

    const key = face.family.toLowerCase();
    const weight = normalizeWeight(face.weight);
    const style = (face.style || 'normal').toLowerCase();

    // Aynı dosya birden çok aileye kayıtlıysa ayrıştırıcıyı paylaş
    let parser = null;
    for (const list of this.families.values()) {
      const hit = list.find((f) => f.file === file);
      if (hit) { parser = hit.parser; break; }
    }
    if (!parser) parser = new TtfParser(file);

    const id = `F${++this._counter}`;
    const entry = { weight, style, parser, file, id, family: face.family };

    if (!this.families.has(key)) this.families.set(key, []);
    this.families.get(key).push(entry);
    this.byId.set(id, entry);
    return entry;
  }

  /** Kayıtlı herhangi bir yüz var mı? */
  get isEmpty() { return this.families.size === 0; }

  /**
   * CSS `font-family` listesi + ağırlık + stil için en uygun yüzü seçer.
   *
   * @param {string[]} families
   * @param {number} weight
   * @param {string} style
   * @returns {{parser:TtfParser, id:string, family:string, weight:number, style:string}}
   */
  resolve(families, weight = 400, style = 'normal') {
    const candidates = [];
    for (const fam of families || []) {
      const key = String(fam).toLowerCase();
      if (this.families.has(key)) candidates.push(...this.families.get(key));
      const generic = GENERIC_FALLBACKS[key];
      if (generic) {
        for (const g of generic) {
          if (this.families.has(g)) candidates.push(...this.families.get(g));
        }
      }
    }
    // Hiçbiri yoksa kayıtlı ilk aileye düş
    if (!candidates.length) {
      for (const list of this.families.values()) { candidates.push(...list); break; }
    }
    if (!candidates.length) {
      throw new Error('Hiç font kaydedilmemiş. render({ fonts: [...] }) ile en az bir TTF verin.');
    }

    // Puanlama: stil eşleşmesi ağırlık eşleşmesinden önemlidir
    let best = candidates[0];
    let bestScore = Infinity;
    for (const c of candidates) {
      const styleCost = (c.style === style) ? 0 : (style === 'italic' ? 300 : 200);
      const weightCost = Math.abs(c.weight - weight);
      const score = styleCost + weightCost;
      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  /** Metnin genişliğini pt cinsinden ölçer (harf aralığı dâhil). */
  measure(text, face, fontSize, letterSpacing = 0) {
    if (!text) return 0;
    let w = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0);
      const gid = face.parser.getGlyphId(code);
      w += face.parser.getGlyphWidth(gid, fontSize);
      w += letterSpacing;
    }
    return w > 0 ? w - letterSpacing : 0;
  }

  /** Kullanılan tüm yüzleri döndürür (gömme aşaması için). */
  allFaces() {
    return [...this.byId.values()];
  }
}

function normalizeWeight(w) {
  if (w == null) return 400;
  if (typeof w === 'number') return w;
  const s = String(w).toLowerCase();
  if (s === 'normal') return 400;
  if (s === 'bold') return 700;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? 400 : n;
}

module.exports = { FontManager, GENERIC_FALLBACKS };
