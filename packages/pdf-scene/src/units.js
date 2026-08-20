'use strict';
/**
 * Birim dönüşümleri.
 *
 * Sahne modelinin İÇ birimi **punto (pt)** ve tek başınadır: bir sayı görürsen
 * puntodur, başka türlüsü yoktur. Karışık birimleri modelde taşımak, her
 * okuyucuyu dönüştürmeye zorlar ve er geç biri unutur.
 *
 * Dışarıya (editör arayüzü, içe/dışa aktarma) mm/cm/inç/px lazım olduğunda
 * dönüşüm BURADA yapılır — hesaplamanın ortasında değil.
 *
 * px seçimi: CSS'in referans noktası 96 dpi'dır (CSS Values 3 §5.2), PDF'in
 * kullanıcı birimi ise 1/72 inçtir. 1px = 0.75pt bu iki tanımın oranıdır.
 */

const PT_PER = {
  pt: 1,
  px: 72 / 96,          // 0.75
  in: 72,
  mm: 72 / 25.4,        // 2.8346…
  cm: 720 / 25.4,       // 28.346…
  pc: 12                // pika
};

class UnitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnitError';
    this.code = 'ERR_UNIT';
  }
}

/**
 * Bir uzunluğu puntoya çevirir.
 *
 * Kabul edilenler: sayı (zaten pt sayılır), `"12"`, `"12pt"`, `"10mm"`,
 * `"1.5in"`, `"96px"`. Boşluk ve büyük harf serbesttir.
 *
 * @param {number|string} value
 * @returns {number} punto
 */
function toPt(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new UnitError(`Sonlu olmayan uzunluk: ${value}`);
    return value;
  }
  if (typeof value !== 'string') {
    throw new UnitError(`Uzunluk sayı ya da dizge olmalı: ${typeof value}`);
  }

  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-zA-Z]*)\s*$/.exec(value);
  if (!m) throw new UnitError(`Uzunluk çözümlenemedi: "${value}"`);

  const n = Number(m[1]);
  if (!Number.isFinite(n)) throw new UnitError(`Sonlu olmayan uzunluk: "${value}"`);

  const unit = (m[2] || 'pt').toLowerCase();
  const factor = PT_PER[unit];
  if (factor === undefined) throw new UnitError(`Bilinmeyen birim: "${m[2]}"`);
  return n * factor;
}

/** Puntodan hedef birime çevirir. */
function fromPt(pt, unit = 'pt') {
  const factor = PT_PER[String(unit).toLowerCase()];
  if (factor === undefined) throw new UnitError(`Bilinmeyen birim: "${unit}"`);
  return pt / factor;
}

/**
 * Punto değerini yuvarlar.
 *
 * Kayan nokta artıkları (0.30000000000000004) hem dosya farklarını hem
 * karşılaştırmaları kirletir. Üç ondalık, 1/1000 punto ≈ 0.35 mikron —
 * baskıda anlamı olan her şeyden çok daha ince.
 */
function round(pt, digits = 3) {
  const f = 10 ** digits;
  const r = Math.round(pt * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

module.exports = { toPt, fromPt, round, PT_PER, UnitError };
