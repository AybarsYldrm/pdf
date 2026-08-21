'use strict';
/**
 * Belge çözümlemesi — "bu PDF'te ne var?"
 *
 * NEDEN VAR: içe aktarma bir DÜZLEŞTİRMEDİR ve her düzleştirme bir şeyler
 * kaybeder. Kullanıcının hangi şeyi kaybettiğini bilme hakkı vardır: form
 * alanları düğüme çevrilmez, mevcut imzalar taşınmaz, çözülemeyen görseller
 * atlanır. Bunları tek tek uyarı yağmuruna çevirmek yerine, belgenin
 * ENVANTERİ çıkarılır ve arayüz bunu tek bir panelde gösterir.
 *
 * NE DEĞİLDİR: bu bir doğrulayıcı değildir. "PDF/A-1b" yazması, belgenin
 * PDF/A-1b uyumlu OLDUĞUNU değil, öyle olduğunu İDDİA ettiğini söyler —
 * gerçek denetim @fitfak/conformance'ın işidir ve ayrı çalıştırılır.
 *
 * ÇALIŞMA KURALI: hiçbir alt çözümleme belgeyi öldürmez. Bozuk bir
 * `/Annots` dizisi yüzünden içe aktarmanın tümden başarısız olması, elde
 * hiçbir şey kalmaması demektir; her adım kendi hatasını yutar ve
 * `issues` listesine yazar.
 */

const pagespace = require('../pagespace');

/** Standart kâğıt ölçüleri (punto) — ada çevirmek için. */
const NAMED_SIZES = [
  { name: 'A3', w: 841.89, h: 1190.55 },
  { name: 'A4', w: 595.28, h: 841.89 },
  { name: 'A5', w: 419.53, h: 595.28 },
  { name: 'A6', w: 297.64, h: 419.53 },
  { name: 'Letter', w: 612, h: 792 },
  { name: 'Legal', w: 612, h: 1008 },
  { name: 'Tabloid', w: 792, h: 1224 }
];

/** Ölçü toleransı (punto) — yuvarlama ve üretici farkları için. */
const SIZE_TOLERANCE = 3;

/**
 * Ölçüyü bilinen bir kâğıt adına çevirir.
 *
 * Yönden bağımsız bakılır: 842×595 de A4'tür, yatay olanı.
 *
 * @returns {{name:string, orientation:'portrait'|'landscape'}|null}
 */
function namedSize(width, height) {
  const orientation = width > height ? 'landscape' : 'portrait';
  const [w, h] = width > height ? [height, width] : [width, height];
  for (const s of NAMED_SIZES) {
    if (Math.abs(w - s.w) <= SIZE_TOLERANCE && Math.abs(h - s.h) <= SIZE_TOLERANCE) {
      return { name: s.name, orientation };
    }
  }
  return null;
}

/** Ölçüyü insanın okuyabileceği bir etikete çevirir. */
function sizeLabel(width, height) {
  const named = namedSize(width, height);
  if (named) return `${named.name} ${named.orientation === 'landscape' ? 'yatay' : 'dikey'}`;
  const mm = (pt) => Math.round((pt / 72) * 25.4);
  return `${mm(width)}×${mm(height)} mm`;
}

/**
 * Belgeyi çözümler.
 *
 * @param {Object} doc PdfDocument
 * @param {{ pages?: Array, stats?: Array, warnings?: Array, truncated?: boolean }} [ctx]
 *   `pages` içe aktarıcının hesapladığı etkin geometriler (yeniden
 *   hesaplamamak için), `stats` sayfa başına üretilen düğüm sayıları.
 * @returns {Object} çözümleme raporu
 */
function analyzeDocument(doc, ctx = {}) {
  const issues = [];
  const guard = (label, fn, fallback) => {
    try { return fn(); } catch (err) {
      issues.push({ code: 'ERR_ANALYSIS_PART', part: label, message: err.message });
      return fallback;
    }
  };

  const pageCount = doc.pageCount;
  const geos = ctx.pages && ctx.pages.length
    ? ctx.pages
    : buildGeometries(doc, pageCount, issues);

  const statsByPage = new Map((ctx.stats || []).map((s) => [s.page, s]));

  const fields = guard('fields', () => doc.listFields(), []);
  const fieldsByPage = new Map();
  for (const f of fields) {
    if (f.page === null || f.page === undefined) continue;
    fieldsByPage.set(f.page, (fieldsByPage.get(f.page) || 0) + 1);
  }

  const annots = guard('annots', () => collectAnnotations(doc, pageCount), {
    total: 0, byPage: new Map(), byType: {}, links: 0
  });

  const pages = geos.map((geo, index) => {
    const named = namedSize(geo.width, geo.height);
    const counts = statsByPage.get(index) || null;
    return {
      index,
      width: geo.width,
      height: geo.height,
      rotate: geo.rotate,
      orientation: geo.width > geo.height ? 'landscape' : 'portrait',
      size: named ? named.name : null,
      label: sizeLabel(geo.width, geo.height),
      cropped: !boxesEqual(geo.cropBox, geo.mediaBox),
      offsetOrigin: Math.abs(geo.cropBox[0]) > 0.5 || Math.abs(geo.cropBox[1]) > 0.5,
      imported: counts ? { text: counts.text, path: counts.path, image: counts.image } : null,
      fields: fieldsByPage.get(index) || 0,
      annotations: annots.byPage.get(index) || 0
    };
  });

  const signatureFields = fields.filter((f) => f.type === 'Sig');

  const totals = pages.reduce((acc, p) => {
    if (p.imported) {
      acc.text += p.imported.text;
      acc.path += p.imported.path;
      acc.image += p.imported.image;
    }
    return acc;
  }, { text: 0, path: 0, image: 0 });

  const sizes = [...new Set(pages.map((p) => p.label))];

  return {
    pageCount,
    importedPages: pages.length,
    truncated: !!ctx.truncated,
    pages,
    /** Belge genelinde tek bir ölçü var mı? */
    uniformSize: sizes.length <= 1,
    sizes,
    orientation: dominant(pages.map((p) => p.orientation)),
    rotated: pages.some((p) => p.rotate !== 0),
    encrypted: !!doc.isEncrypted,
    /** İçe aktarımda üretilen düğüm sayıları — "ne kadarı düzenlenebilir". */
    objects: totals,
    form: {
      present: guard('hasForm', () => !!doc.hasForm, false),
      fieldCount: fields.length,
      /**
       * Form alanları sahne düğümüne ÇEVRİLMEZ; belgede oldukları gibi
       * durur ve içe aktarılan sahnede yoktur. Bunu "salt okunur" diye
       * bildirmek, kullanıcının onları arayıp bulamamasından iyidir.
       */
      editability: fields.length ? 'unsupported' : 'none',
      fields: fields.slice(0, 200).map((f) => ({
        name: f.name, type: f.type, page: f.page,
        readOnly: f.readOnly, required: f.required
      }))
    },
    signatures: {
      signed: guard('hasSignatures', () => !!doc.hasSignatures, false),
      fieldCount: signatureFields.length,
      /** İmzalanmamış boş imza alanları — sahnede yuva olarak kurulabilir. */
      empty: signatureFields.filter((f) => !f.value).length,
      fields: signatureFields.map((f) => ({
        name: f.name, page: f.page, rect: f.rect, signed: !!f.value
      }))
    },
    annotations: {
      total: annots.total,
      links: annots.links,
      byType: annots.byType,
      editability: annots.total ? 'unsupported' : 'none'
    },
    metadata: guard('info', () => readInfo(doc), {}),
    /** İDDİA edilen uyum profili — denetlenmiş değil. */
    claimedProfile: guard('profile', () => readClaimedProfile(doc), null),
    warnings: summarizeWarnings(ctx.warnings || []),
    issues
  };
}

function buildGeometries(doc, pageCount, issues) {
  const out = [];
  for (let i = 0; i < pageCount; i++) {
    try {
      out.push(pagespace.effectiveGeometry(doc.getPageGeometry(i)));
    } catch (err) {
      issues.push({ code: 'ERR_ANALYSIS_PAGE', page: i, message: err.message });
      out.push(pagespace.effectiveGeometry(null));
    }
  }
  return out;
}

const boxesEqual = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.every((v, i) => Math.abs(v - b[i]) < 0.5);

/** Bir listedeki en sık değeri döndürür. */
function dominant(values) {
  const tally = new Map();
  for (const v of values) tally.set(v, (tally.get(v) || 0) + 1);
  let best = null;
  for (const [v, n] of tally) if (!best || n > best[1]) best = [v, n];
  return best ? best[0] : null;
}

/**
 * Sayfa açıklamalarını (annotation) sayar.
 *
 * Widget'lar form alanı olarak zaten sayılır; burada TÜRLERİNE göre bir
 * envanter çıkarılır ki kullanıcı "12 açıklama vardı, nerede?" diye
 * sormasın.
 */
function collectAnnotations(doc, pageCount) {
  const byPage = new Map();
  const byType = {};
  let total = 0;
  let links = 0;

  for (let i = 0; i < pageCount; i++) {
    let list;
    try {
      const { dict } = doc.getPage(i);
      list = doc.resolve(dict.get('Annots'));
    } catch {
      continue;                                  // bozuk sayfa: sayılmaz
    }
    if (!Array.isArray(list)) continue;

    let count = 0;
    for (const ref of list) {
      let a;
      try { a = doc.resolve(ref); } catch { continue; }
      if (!a || !a.get) continue;
      const sub = a.get('Subtype');
      const name = sub && sub.name ? sub.name : 'Bilinmeyen';
      byType[name] = (byType[name] || 0) + 1;
      if (name === 'Link') links++;
      count++;
      total++;
    }
    if (count) byPage.set(i, count);
  }

  return { total, byPage, byType, links };
}

function readInfo(doc) {
  const info = doc.getInfo() || {};
  const pick = (k) => (typeof info[k] === 'string' ? info[k].slice(0, 512) : '');
  return {
    title: pick('Title'),
    author: pick('Author'),
    subject: pick('Subject'),
    keywords: pick('Keywords'),
    creator: pick('Creator'),
    producer: pick('Producer')
  };
}

/**
 * XMP üst verisinden İDDİA edilen uyum profilini okur.
 *
 * Tam bir XMP ayrıştırıcısı yazmak bu katmanın işi değildir; aranan iki
 * alan (`pdfaid:part`, `pdfaid:conformance`) sabit adlarla geçer ve
 * öznitelik ya da eleman biçiminde yazılabilir. Bulunamazsa `null` döner —
 * "yok" demek, "olmayabilir" demekten iyidir.
 */
function readClaimedProfile(doc) {
  const meta = doc.resolve(doc.catalog.get('Metadata'));
  if (!meta || !meta.dict) return null;

  let xmp;
  try {
    xmp = doc.getStreamData(meta).toString('utf8');
  } catch {
    return null;
  }
  if (!xmp || xmp.length > 4_000_000) return null;

  const part = /pdfaid:part\s*=\s*["'](\d+)["']/.exec(xmp) ||
               /<pdfaid:part>\s*(\d+)\s*<\/pdfaid:part>/.exec(xmp);
  if (!part) return null;

  const conf = /pdfaid:conformance\s*=\s*["']([A-Za-z])["']/.exec(xmp) ||
               /<pdfaid:conformance>\s*([A-Za-z])\s*<\/pdfaid:conformance>/.exec(xmp);

  return {
    standard: 'PDF/A',
    part: Number(part[1]),
    level: conf ? conf[1].toLowerCase() : null,
    label: `PDF/A-${part[1]}${conf ? conf[1].toLowerCase() : ''}`,
    // İDDİA. Denetlenmedi.
    verified: false
  };
}

/** Uyarıları koda göre toplar: aynı kod yüz kez değil, bir kez + sayı. */
function summarizeWarnings(warnings) {
  const tally = new Map();
  for (const w of warnings) {
    const entry = tally.get(w.code);
    if (entry) entry.count++;
    else tally.set(w.code, { code: w.code, message: w.message, count: 1 });
  }
  return [...tally.values()];
}

module.exports = { analyzeDocument, namedSize, sizeLabel, NAMED_SIZES };
