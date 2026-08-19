'use strict';
/**
 * Gelen PDF'i imzalanabilir bir biçime getirir.
 *
 * PAdES yazıcısı (`pdf_parser.js`) klasik `trailer << … >>` + `xref` tablosu
 * okur. Word, Chrome, LibreOffice ve pek çok üretici ise PDF 1.5+ ile gelen
 * `/Type /XRef` çapraz başvuru AKIŞLARINI ve `/ObjStm` nesne akışlarını
 * kullanır. Böyle bir dosyayı doğrudan imzalamaya çalışmak
 * "trailer not found" ile düşer.
 *
 * Çözüm, dosyayı yeniden yazmak DEĞİL — sonuna klasik bir çapraz başvuru
 * tablosu taşıyan bir "köprü revizyonu" eklemektir:
 *
 *     [ orijinal bayt dizisi — HİÇ DEĞİŞTİRİLMEZ ]
 *     [ /ObjStm içindeki nesnelerin açık kopyaları ]
 *     [ tüm nesneleri kapsayan klasik xref tablosu ]
 *     [ trailer + startxref + %%EOF                ]
 *
 * Orijinal baytlara dokunulmadığı için belgede zaten var olan imzalar
 * geçerliliğini korur; yeni imza da bu köprünün üzerine artımlı olarak eklenir.
 */

const { readLastTrailer, readObject } = require('./pdf_parser');

/** `@fitfak/pdf-doc` tembel yüklenir: paket yoksa anlaşılır hata verilir. */
function loadPdfDoc() {
  try {
    return require('@fitfak/pdf-doc');
  } catch (err) {
    const e = new Error(
      'Bu PDF çapraz başvuru akışı (/Type /XRef) ya da nesne akışı (/ObjStm) ' +
      'kullanıyor; dönüştürmek için @fitfak/pdf-doc paketi gerekiyor.');
    e.code = 'ERR_PDFDOC_MISSING';
    e.cause = err;
    throw e;
  }
}

/**
 * Belge, PAdES yazıcısının anlayacağı klasik yapıda mı?
 * @param {Buffer} pdfBuffer
 * @returns {boolean} true → dönüştürme gerekir
 */
function needsNormalization(pdfBuffer) {
  try {
    const trailer = readLastTrailer(pdfBuffer);
    if (!trailer || !Number.isFinite(trailer.rootObjNum)) return true;

    const root = readObject(pdfBuffer, trailer.rootObjNum);
    if (!root || !root.dictStr) return true;
    // Kök gerçekten katalog mu? (yanlış nesneyi yakalamış olabiliriz)
    return !/\/Pages\b/.test(root.dictStr);
  } catch {
    return true;
  }
}

/**
 * Belgede şifreleme var mı? (ucuz ön kontrol — kesin karar `PdfDocument`'te)
 *
 * Şifreli bir belgeye PAdES yazıcısıyla imza eklemek sessizce BOZUK çıktı
 * üretir: imza sözlüğündeki dizgiler belgenin anahtarıyla şifrelenmediği için
 * hiçbir okuyucu onları çözemez. Bu yüzden erken yakalamak gerekir.
 */
function looksEncrypted(pdfBuffer) {
  const text = pdfBuffer.toString('latin1');
  const trailers = text.match(/trailer\s*<<[\s\S]*?>>/g);
  if (trailers && trailers.some((t) => /\/Encrypt[\s/[<]/.test(t))) return true;
  // xref akışlı belgelerde trailer, akış sözlüğüdür: /Type /XRef ile birlikte arar
  return /\/Type\s*\/XRef[\s\S]{0,600}?\/Encrypt[\s/[<]/.test(text);
}

/**
 * Gerekiyorsa belgeye klasik xref köprüsü ekler.
 *
 * @param {Buffer} pdfBuffer
 * @param {{ password?: string, decrypt?: boolean }} [opts]
 *        `password` şifreli belgeleri açmak için; `decrypt: true` verilirse
 *        belge şifresiz olarak YENİDEN YAZILIR (imzasız belgelerde geçerli).
 * @returns {{ pdf: Buffer, normalized: boolean, reason?: string, pageCount?: number }}
 */
function normalizePdf(pdfBuffer, opts = {}) {
  if (!Buffer.isBuffer(pdfBuffer)) {
    throw new TypeError('normalizePdf: Buffer bekleniyor');
  }

  const encrypted = looksEncrypted(pdfBuffer);
  if (!encrypted && !needsNormalization(pdfBuffer)) {
    return { pdf: pdfBuffer, normalized: false };
  }

  const { PdfDocument, writeIncremental, writeFull } = loadPdfDoc();

  let doc;
  try {
    doc = new PdfDocument(pdfBuffer, { password: opts.password || '' });
  } catch (err) {
    const e = new Error(`PDF açılamadı: ${err.message}`);
    e.code = err.code || 'ERR_PDF_OPEN';
    throw e;
  }

  if (doc.isEncrypted) {
    if (!opts.decrypt) {
      const e = new Error(
        'Şifreli PDF doğrudan imzalanamaz: imza sözlüğü belgenin anahtarıyla ' +
        'şifrelenemez. Şifreyi kaldırıp öyle imzalayın ' +
        "(normalizePdf(pdf, { decrypt: true }) ya da PdfDocument.save({ full: true })).");
      e.code = 'ERR_PDF_ENCRYPTED';
      throw e;
    }
    // Tam yeniden yazım şifreyi kaldırır; imzalı belgede zaten reddedilir.
    const plain = writeFull(doc, {});
    return finish(plain, PdfDocument, writeIncremental, 'şifreleme kaldırıldı');
  }

  if (!needsNormalization(pdfBuffer)) {
    return { pdf: pdfBuffer, normalized: false };
  }

  return {
    pdf: bridge(writeIncremental, doc),
    normalized: true,
    reason: 'xref akışı / nesne akışı klasik tabloya köprülendi',
    pageCount: doc.pageCount
  };
}

/** Şifresi kaldırılmış belge yine de köprü gerektirebilir. */
function finish(plain, PdfDocument, writeIncremental, reason) {
  if (!needsNormalization(plain)) {
    return { pdf: plain, normalized: true, reason };
  }
  const doc = new PdfDocument(plain);
  return {
    pdf: bridge(writeIncremental, doc),
    normalized: true,
    reason: `${reason} + klasik xref köprüsü`,
    pageCount: doc.pageCount
  };
}

function bridge(writeIncremental, doc) {
  const out = writeIncremental(doc, { rebuildXref: true });
  if (needsNormalization(out)) {
    const e = new Error('PDF klasik xref biçimine dönüştürülemedi.');
    e.code = 'ERR_PDF_NORMALIZE';
    throw e;
  }
  return out;
}

module.exports = { normalizePdf, needsNormalization, looksEncrypted };
