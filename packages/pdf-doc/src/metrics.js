'use strict';
/**
 * Standart 14 fontun yerleşik genişlikleri (AFM, 1/1000 em).
 *
 * Bu fontlar PDF'e gömülmez ve `/Widths` dizisi de çoğu zaman yazılmaz —
 * okuyucunun metrikleri bilmesi beklenir. Metin çıkarımında konum ve kelime
 * araları bu genişliklere dayandığı için tabloyu burada tutuyoruz.
 *
 * ASCII aralığı tam; aksanlı harfler için taban harfin genişliği kullanılır
 * (Á → A). Latin alfabesinde bu yaklaşım pratikte birebir tutar.
 */

/** '32:278 33:278 …' yerine sırayla 32'den başlayan genişlik listesi. */
function widths(list) {
  const out = new Map();
  list.split(/\s+/).filter(Boolean).forEach((w, i) => out.set(32 + i, Number(w)));
  return out;
}

const HELVETICA = widths(`
  278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278
  556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556
  1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778
  667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556
  333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556
  556 556 333 500 278 556 500 722 500 500 500 334 260 334 584
`);

const HELVETICA_BOLD = widths(`
  278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278
  556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611
  975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778
  667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556
  333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611
  611 611 389 556 333 611 556 778 556 556 500 389 280 389 584
`);

const TIMES = widths(`
  250 333 408 500 500 833 778 180 333 333 500 564 250 333 250 278
  500 500 500 500 500 500 500 500 500 500 278 278 564 564 564 444
  921 722 667 667 722 611 556 722 722 333 389 722 611 889 722 722
  556 722 667 556 611 722 722 944 722 722 611 333 278 333 469 500
  333 444 500 444 500 444 333 500 500 278 278 500 278 778 500 500
  500 500 333 389 278 500 500 722 500 500 444 480 200 480 541
`);

const TIMES_BOLD = widths(`
  250 333 555 500 500 1000 833 278 333 333 500 570 250 333 250 278
  500 500 500 500 500 500 500 500 500 500 333 333 570 570 570 500
  930 722 667 722 722 667 611 778 778 389 500 778 667 944 722 778
  611 778 722 556 667 722 722 1000 722 722 667 333 278 333 581 500
  333 500 556 444 556 444 333 500 556 278 333 556 278 833 556 500
  556 556 444 389 333 556 500 722 500 500 444 394 220 394 520
`);

const COURIER = new Map();                       // eşit genişlikli
for (let c = 32; c < 256; c++) COURIER.set(c, 600);

/** Font adından metrik tablosunu seçer. */
function metricsFor(baseFont) {
  const name = String(baseFont || '').replace(/^[A-Z]{6}\+/, '');   // alt küme öneki
  const lower = name.toLowerCase();

  const bold = /bold|black|heavy|semibold/.test(lower);

  if (/courier|mono/.test(lower)) return COURIER;
  if (/times|serif|roman|georgia|garamond|book/.test(lower)) return bold ? TIMES_BOLD : TIMES;
  if (/symbol|zapf|dingbat/.test(lower)) return null;
  return bold ? HELVETICA_BOLD : HELVETICA;       // varsayılan: Helvetica ailesi
}

/**
 * Yerleşik genişlik. Aksanlı harfler taban harfe indirgenir.
 *
 * @param {Map<number, number>} table `metricsFor` çıktısı
 * @param {number} code karakter kodu
 * @param {string} [text] kodun çözülmüş Unicode karşılığı
 */
function builtinWidth(table, code, text) {
  if (!table) return null;
  if (table.has(code)) return table.get(code);

  const ch = text && text.length ? text[0] : String.fromCharCode(code);
  const base = ch.normalize('NFD')[0];
  const baseCode = base.charCodeAt(0);
  if (table.has(baseCode)) return table.get(baseCode);

  // Türkçe'ye özgü, NFD'nin ayrıştıramadığı harfler
  const FALLBACK = { 'ı': 'i', 'İ': 'I', 'Ğ': 'G', 'ğ': 'g', 'Ş': 'S', 'ş': 's', '₺': 'T' };
  const mapped = FALLBACK[ch];
  if (mapped && table.has(mapped.charCodeAt(0))) return table.get(mapped.charCodeAt(0));

  return table.get(0x6E) || 500;                  // 'n' ortalama bir genişliktir
}

module.exports = { metricsFor, builtinWidth, HELVETICA, HELVETICA_BOLD, TIMES, TIMES_BOLD, COURIER };
