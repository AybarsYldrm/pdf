'use strict';
/**
 * PDF/A denetimi — ISO 19005 (PDF/A-1, -2, -3), "b" (basic) uyum düzeyi.
 *
 * Kapsam dürüstlüğü: bu bir *veraPDF ikamesi* değildir. Belgenin PDF/A
 * olduğunu KANITLAMAZ; PDF/A olmadığını gösteren, pratikte en sık karşılaşılan
 * ihlalleri yakalar. Her bulgu, ihlal edilen maddeyi adıyla söyler ki hangi
 * kuralın sınandığı tartışmaya açık olmasın.
 *
 * Sınananlar:
 *   6.1.2  Dosya başlığı ve ikili yorum satırı
 *   6.1.3  Trailer: /ID zorunlu, /Encrypt yasak
 *   6.1.7  LZWDecode yasak; harici akış (/F) yasak
 *   6.2.2  Cihaza bağlı renk → çıktı amacı (OutputIntent) zorunlu
 *   6.2.11 Bütün fontlar gömülü olmalı
 *   6.3    Şeffaflık (yalnız PDF/A-1'de yasak)
 *   6.5.3  Açıklamalar: /AP zorunlu, /CA = 1, gizli olamaz
 *   6.6.1  Eylemler: /JavaScript, /Launch, /Movie, /Sound, /ResetForm yasak
 *   6.7.2  XMP üst verisi ve pdfaid iddiası
 *   6.7.3  XMP ile /Info tutarlılığı
 */

const { Dict, Name, Str, Stream, Ref } = require('@fitfak/pdf-doc');
const { parseXmp } = require('./xmp');
const { readProfileHeader } = require('./icc');

/** Yasaklı eylem türleri (ISO 19005-2 §6.6.1). */
const FORBIDDEN_ACTIONS = new Set([
  'Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'JavaScript',
  'SetOCGState', 'Rendition', 'Trans', 'GoTo3DView'
]);

/** Gömülü font dosyası taşıyan anahtarlar. */
const FONT_FILE_KEYS = ['FontFile', 'FontFile2', 'FontFile3'];

/** Gömme gerektirmeyen "standart 14" font — PDF/A'da bu istisna YOKTUR. */
const STANDARD_14 = new Set([
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Symbol', 'ZapfDingbats'
]);

/**
 * Bir belgeyi PDF/A açısından denetler.
 *
 * @param {import('@fitfak/pdf-doc').PdfDocument} doc
 * @param {{ part?: 1|2|3, level?: 'a'|'b' }} [opts] beklenen profil;
 *        verilmezse XMP'deki iddia kullanılır.
 * @returns {{ profile: string|null, claimed: string|null, conforms: boolean,
 *             errors: Array, warnings: Array, checked: string[] }}
 */
function checkPdfA(doc, opts = {}) {
  const errors = [];
  const warnings = [];
  const checked = [];

  const fail = (clause, message, detail) =>
    errors.push({ clause, message, ...(detail ? { detail } : {}) });
  const warn = (clause, message, detail) =>
    warnings.push({ clause, message, ...(detail ? { detail } : {}) });
  const did = (clause) => checked.push(clause);

  /* --- iddia edilen profil --------------------------------------- */
  const xmp = readXmp(doc);
  const claimed = xmp && xmp.pdfA ? xmp.pdfA : null;
  const part = opts.part || (claimed ? Number(claimed[0]) : 2);
  const level = (opts.level || (claimed ? claimed[1] : 'b') || 'b').toLowerCase();
  const profile = `${part}${level}`;

  /* --- 6.1.2 başlık ----------------------------------------------- */
  did('6.1.2');
  const head = doc.buf.subarray(0, 1024).toString('latin1');
  if (!/^%PDF-1\.[0-7]/.test(head) && !/^%PDF-2\.0/.test(head)) {
    fail('6.1.2', 'Dosya %PDF-1.x başlığıyla başlamıyor');
  }
  // İkinci satır, en az dördü 128'den büyük olan bir yorum olmalı
  const secondLine = /^%PDF-[\d.]+[\r\n]+%([\s\S]{4})/.exec(head);
  if (!secondLine || [...secondLine[1]].filter((c) => c.charCodeAt(0) > 127).length < 4) {
    fail('6.1.2', 'Başlıktan sonra ikili yorum satırı (%\\xE2\\xE3\\xCF\\xD3) yok — ' +
      'dosya metin olarak aktarılırsa bozulur');
  }

  /* --- 6.1.3 trailer ---------------------------------------------- */
  did('6.1.3');
  if (doc.isEncrypted) {
    fail('6.1.3', 'Belge şifreli; PDF/A şifrelemeye izin vermez');
  }
  if (!doc.trailer.has('ID')) {
    fail('6.1.3', 'Trailer /ID taşımıyor');
  }

  /* --- 6.7.2 XMP üst verisi --------------------------------------- */
  did('6.7.2');
  if (!xmp) {
    fail('6.7.2', 'Belge XMP üst verisi (/Metadata) taşımıyor');
  } else if (!xmp.pdfA) {
    fail('6.7.2', 'XMP içinde pdfaid:part / pdfaid:conformance iddiası yok');
  } else if (opts.part && Number(xmp.pdfA[0]) !== opts.part) {
    fail('6.7.2', `XMP PDF/A-${xmp.pdfA} iddia ediyor, beklenen PDF/A-${profile}`);
  }

  /* --- 6.7.3 XMP ↔ /Info tutarlılığı ------------------------------ */
  did('6.7.3');
  if (xmp) {
    const info = doc.getInfo();
    const pairs = [['Title', xmp.title], ['Author', xmp.creator], ['Subject', xmp.description]];
    for (const [key, xmpValue] of pairs) {
      const infoValue = info[key];
      if (infoValue && xmpValue && String(infoValue) !== String(xmpValue)) {
        fail('6.7.3', `/Info /${key} ile XMP karşılığı uyuşmuyor`,
          { info: String(infoValue), xmp: String(xmpValue) });
      }
      if (infoValue && !xmpValue) {
        warn('6.7.3', `/Info /${key} var ama XMP'de karşılığı yok`);
      }
    }
  }

  /* --- 6.2.2 çıktı amacı ------------------------------------------ */
  did('6.2.2');
  const intents = doc.get(doc.catalog, 'OutputIntents');
  let hasPdfAIntent = false;
  if (Array.isArray(intents)) {
    for (const ref of intents) {
      const intent = doc.resolve(ref);
      if (!(intent instanceof Dict)) continue;
      const s = intent.get('S');
      if (!(s instanceof Name) || s.name !== 'GTS_PDFA1') continue;

      hasPdfAIntent = true;
      const profileStream = doc.resolve(intent.get('DestOutputProfile'));
      if (!(profileStream instanceof Stream)) {
        fail('6.2.2', 'Çıktı amacında /DestOutputProfile yok — ICC profili gömülmemiş');
      } else {
        const icc = safe(() => doc.getStreamData(profileStream));
        const header = icc && readProfileHeader(icc);
        if (!header) {
          fail('6.2.2', 'Gömülü ICC profili geçersiz (acsp imzası yok)');
        } else if (header.size !== icc.length) {
          warn('6.2.2', 'ICC profilinin bildirdiği boyut gerçek boyutla uyuşmuyor',
            { declared: header.size, actual: icc.length });
        }
      }
    }
  }
  if (!hasPdfAIntent) {
    fail('6.2.2', 'PDF/A çıktı amacı (/OutputIntents içinde /S /GTS_PDFA1) yok');
  }

  /* --- 6.2.11 font gömme + 6.1.7 filtreler ------------------------ */
  did('6.2.11');
  did('6.1.7');
  const seen = new Set();
  for (const [num, entry] of doc.xref.entries) {
    if (entry.type === 0 || seen.has(num)) continue;
    seen.add(num);

    const obj = safe(() => doc.getObject(num));
    if (obj instanceof Stream) checkStream(doc, obj, num, fail, warn);
    const dict = obj instanceof Stream ? obj.dict : obj;
    if (!(dict instanceof Dict)) continue;

    const type = dict.get('Type');
    if (type instanceof Name && type.name === 'Font') {
      checkFont(doc, dict, fail, warn);
    }
    checkAction(doc, dict, fail);
    if (type instanceof Name && type.name === 'Annot') {
      checkAnnot(doc, dict, fail, warn);
    }
  }

  /* --- 6.6.1 katalog düzeyi yasaklar ------------------------------- */
  did('6.6.1');
  const names = doc.get(doc.catalog, 'Names');
  if (names instanceof Dict && names.has('JavaScript')) {
    fail('6.6.1', 'Belge JavaScript adı ağacı taşıyor');
  }
  const acro = doc.get(doc.catalog, 'AcroForm');
  if (acro instanceof Dict && acro.get('XFA')) {
    fail('6.6.1', 'XFA formu var; PDF/A dinamik XFA kabul etmez');
  }

  /* --- 6.3 şeffaflık (yalnız PDF/A-1) ------------------------------ */
  if (part === 1) {
    did('6.3');
    for (let i = 0; i < doc.pageCount; i++) {
      const { dict } = doc.getPage(i);
      const res = doc.getPageProperty(dict, 'Resources');
      const gs = res instanceof Dict ? doc.resolve(res.get('ExtGState')) : null;
      if (!(gs instanceof Dict)) continue;
      for (const [, ref] of gs.map) {
        const g = doc.resolve(ref);
        if (!(g instanceof Dict)) continue;
        const ca = g.get('ca');
        const CA = g.get('CA');
        if ((ca !== undefined && Number(ca) !== 1) || (CA !== undefined && Number(CA) !== 1)) {
          fail('6.3', `Sayfa ${i + 1}: şeffaflık kullanılmış; PDF/A-1 buna izin vermez`);
          break;
        }
      }
    }
  }

  return {
    profile: `PDF/A-${part}${level}`,
    claimed: claimed ? `PDF/A-${claimed[0]}${claimed[1].toUpperCase()}` : null,
    conforms: errors.length === 0,
    errors,
    warnings,
    checked: [...new Set(checked)].sort()
  };
}

/* ------------------------------------------------------------------ */
/* Alt denetimler                                                     */
/* ------------------------------------------------------------------ */

function checkStream(doc, stream, num, fail, warn) {
  const filters = nameList(doc.resolve(stream.dict.get('Filter')));
  if (filters.includes('LZWDecode')) {
    fail('6.1.7', `Nesne ${num}: LZWDecode filtresi kullanılmış (PDF/A yasaklar)`);
  }
  if (stream.dict.has('F') && !(stream.dict.get('F') instanceof Ref)) {
    // /F bir dosya belirteci ise akış HARİCİ demektir
    const type = stream.dict.get('Type');
    const isEmbedded = type instanceof Name && type.name === 'EmbeddedFile';
    if (!isEmbedded) {
      fail('6.1.7', `Nesne ${num}: harici akış verisi (/F) kullanılmış`);
    }
  }
}

function checkFont(doc, font, fail, warn) {
  const subtype = font.get('Subtype');
  const kind = subtype instanceof Name ? subtype.name : '';
  const baseFont = font.get('BaseFont');
  const name = baseFont instanceof Name ? baseFont.name : '(adsız)';

  if (kind === 'Type0') {
    const descendants = doc.resolve(font.get('DescendantFonts'));
    const cid = Array.isArray(descendants) ? doc.resolve(descendants[0]) : null;
    if (cid instanceof Dict) checkFontDescriptor(doc, cid, name, fail);
    else fail('6.2.11', `Font ${name}: /DescendantFonts okunamadı`);
    return;
  }
  if (kind === 'Type3') return;             // Type3 gömme gerektirmez (glifler içeride)

  checkFontDescriptor(doc, font, name, fail);
}

function checkFontDescriptor(doc, font, name, fail) {
  const descriptor = doc.resolve(font.get('FontDescriptor'));
  if (!(descriptor instanceof Dict)) {
    const clean = name.replace(/^[A-Z]{6}\+/, '');
    if (STANDARD_14.has(clean)) {
      fail('6.2.11', `Font ${clean}: standart 14 fontu gömülmemiş — ` +
        'PDF/A bu istisnayı tanımaz, font dosyası gömülmelidir');
    } else {
      fail('6.2.11', `Font ${name}: /FontDescriptor yok, gömme doğrulanamıyor`);
    }
    return;
  }
  const embedded = FONT_FILE_KEYS.some((key) => descriptor.has(key));
  if (!embedded) {
    fail('6.2.11', `Font ${name}: gömülü değil (/FontFile* yok)`);
  }
}

function checkAction(doc, dict, fail) {
  const action = doc.resolve(dict.get('A')) || doc.resolve(dict.get('AA'));
  if (!(action instanceof Dict)) return;
  const s = action.get('S');
  if (s instanceof Name && FORBIDDEN_ACTIONS.has(s.name)) {
    fail('6.6.1', `Yasaklı eylem türü: /${s.name}`);
  }
}

function checkAnnot(doc, annot, fail, warn) {
  const subtype = annot.get('Subtype');
  const kind = subtype instanceof Name ? subtype.name : '';
  if (kind === 'Popup' || kind === 'Link') return;      // /AP istisnası

  const flags = Number(doc.resolve(annot.get('F'))) || 0;
  if (flags & 0x02) fail('6.5.3', `${kind} açıklaması gizli (Hidden) işaretli`);
  if (!(flags & 0x04)) fail('6.5.3', `${kind} açıklamasında Print bayrağı yok`);

  const ca = annot.get('CA');
  if (ca !== undefined && Number(ca) !== 1) {
    fail('6.5.3', `${kind} açıklamasında /CA ${ca} — PDF/A yalnız 1.0 kabul eder`);
  }

  if (!annot.has('AP')) {
    fail('6.5.3', `${kind} açıklamasının görünüm akışı (/AP) yok`);
  }
}

/* ------------------------------------------------------------------ */

function readXmp(doc) {
  const stream = doc.get(doc.catalog, 'Metadata');
  if (!(stream instanceof Stream)) return null;
  const data = safe(() => doc.getStreamData(stream));
  return data ? parseXmp(data) : null;
}

function nameList(value) {
  if (value instanceof Name) return [value.name];
  if (Array.isArray(value)) return value.map((v) => (v instanceof Name ? v.name : String(v)));
  return [];
}

function safe(fn) {
  try { return fn(); } catch { return null; }
}

module.exports = { checkPdfA, STANDARD_14, FORBIDDEN_ACTIONS };
