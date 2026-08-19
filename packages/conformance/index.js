'use strict';
/**
 * @fitfak/conformance — PDF/A ve PDF/UA uyumluluk denetimi.
 *
 * Bu paket bir belgeyi *denetler*; üretmez. Üretim tarafında
 * `@fitfak/pdf-html` `conformance` seçeneğini alır ve gerekli yapıları
 * (XMP iddiası, çıktı amacı, yapı ağacı) kendisi yazar. Buradaki denetleyici
 * ise "gerçekten yazılmış mı?" sorusunu bağımsız olarak cevaplar.
 *
 * Dürüstlük notu: bu bir veraPDF ikamesi DEĞİLDİR. Uyumu kanıtlamaz;
 * uyumsuzluğun en sık görülen biçimlerini yakalar ve hangi maddeyi
 * denetlediğini adıyla söyler.
 */

const { PdfDocument } = require('@fitfak/pdf-doc');
const { checkPdfA } = require('./src/pdfa');
const { checkPdfUA } = require('./src/pdfua');
const { sRGBProfile, readProfileHeader } = require('./src/icc');
const { buildXmp, parseXmp } = require('./src/xmp');

/**
 * Bir PDF'i istenen profillere göre denetler.
 *
 * @param {Buffer|import('@fitfak/pdf-doc').PdfDocument} input
 * @param {{ profiles?: string[], part?: number, level?: string, password?: string }} [opts]
 *        `profiles` verilmezse belgenin XMP'de İDDİA ETTİĞİ profiller denetlenir.
 * @returns {{ profiles: string[], conforms: boolean, pdfA?: Object, pdfUA?: Object,
 *             summary: { errors: number, warnings: number } }}
 */
function check(input, opts = {}) {
  const doc = input instanceof PdfDocument
    ? input
    : PdfDocument.load(input, { password: opts.password || '' });

  let profiles = opts.profiles;
  if (!profiles || !profiles.length) {
    profiles = detectClaims(doc);
    if (!profiles.length) profiles = ['pdf/a'];      // varsayılan: arşivlenebilirlik
  }

  const wantsA = profiles.some((p) => /pdf\/a/i.test(p));
  const wantsUA = profiles.some((p) => /pdf\/ua/i.test(p));

  const out = { profiles, conforms: true, summary: { errors: 0, warnings: 0 } };

  if (wantsA) {
    const spec = profiles.find((p) => /pdf\/a/i.test(p)) || '';
    const m = /pdf\/a-?(\d)([ab])?/i.exec(spec);
    out.pdfA = checkPdfA(doc, {
      part: opts.part || (m ? Number(m[1]) : undefined),
      level: opts.level || (m && m[2] ? m[2] : undefined)
    });
    out.conforms = out.conforms && out.pdfA.conforms;
    out.summary.errors += out.pdfA.errors.length;
    out.summary.warnings += out.pdfA.warnings.length;
  }

  if (wantsUA) {
    out.pdfUA = checkPdfUA(doc);
    out.conforms = out.conforms && out.pdfUA.conforms;
    out.summary.errors += out.pdfUA.errors.length;
    out.summary.warnings += out.pdfUA.warnings.length;
  }

  return out;
}

/** Belgenin XMP'de iddia ettiği profilleri okur. */
function detectClaims(doc) {
  const { Stream } = require('@fitfak/pdf-doc');
  const stream = doc.get(doc.catalog, 'Metadata');
  if (!(stream instanceof Stream)) return [];

  let xmp;
  try {
    xmp = parseXmp(doc.getStreamData(stream));
  } catch {
    return [];
  }
  if (!xmp) return [];

  const out = [];
  if (xmp.pdfA) out.push(`pdf/a-${xmp.pdfA}`);
  if (xmp.pdfUA) out.push('pdf/ua');
  return out;
}

/**
 * Raporu okunabilir metne çevirir (CLI ve `docs/conformance/` için).
 * @param {Object} report `check()` çıktısı
 */
function formatReport(report) {
  const lines = [];
  const bullet = (kind, item) =>
    `  ${kind}  ${item.clause || item.rule ? `[${item.clause || item.rule}] ` : ''}${item.message}` +
    (item.detail ? `\n        ${JSON.stringify(item.detail)}` : '');

  lines.push(`Profiller: ${report.profiles.join(', ')}`);
  lines.push(`Sonuç:     ${report.conforms ? 'UYUMLU' : 'UYUMSUZ'}` +
    `  (${report.summary.errors} hata, ${report.summary.warnings} uyarı)`);

  if (report.pdfA) {
    lines.push('', `── ${report.pdfA.profile} ──`);
    if (report.pdfA.claimed) lines.push(`  iddia edilen: ${report.pdfA.claimed}`);
    for (const e of report.pdfA.errors) lines.push(bullet('HATA ', e));
    for (const w of report.pdfA.warnings) lines.push(bullet('uyarı', w));
    if (!report.pdfA.errors.length) lines.push('  Denetlenen maddelerde ihlal bulunamadı.');
    lines.push(`  denetlenen maddeler: ${report.pdfA.checked.join(', ')}`);
  }

  if (report.pdfUA) {
    lines.push('', '── PDF/UA-1 ──');
    lines.push(`  iddia edilen: ${report.pdfUA.claimed ? 'evet' : 'hayır'}`);
    for (const e of report.pdfUA.errors) lines.push(bullet('HATA ', e));
    for (const w of report.pdfUA.warnings) lines.push(bullet('uyarı', w));
    if (!report.pdfUA.errors.length) lines.push('  Denetlenen kurallarda ihlal bulunamadı.');

    const s = report.pdfUA.structure;
    lines.push(`  yapı: ${s.elements} eleman, ${s.figures} görsel, ` +
      `${s.links} bağlantı, ${s.tables} tablo`);
    if (s.headings.length) lines.push(`  başlık düzeyleri: ${s.headings.join(' → ')}`);
  }

  return lines.join('\n');
}

module.exports = {
  check, formatReport, detectClaims,
  checkPdfA, checkPdfUA,
  sRGBProfile, readProfileHeader,
  buildXmp, parseXmp
};
