'use strict';
/**
 * PDF/UA-1 denetimi — ISO 14289-1 (evrensel erişilebilirlik).
 *
 * PDF/UA'nın özü tek cümle: **belge yapısı, görsel görünüşten bağımsız olarak
 * makine tarafından okunabilmelidir.** Ekran okuyucu sayfadaki metin kutularını
 * değil, yapı ağacını (`/StructTreeRoot`) gezer.
 *
 * Sınananlar (Matterhorn Protokolü'nün en sık düşülen maddeleri):
 *   01  Etiketlenmemiş içerik / eksik `/MarkInfo`
 *   06  Belge başlığı (`/Title` + `/DisplayDocTitle`)
 *   09  Başlık düzeylerinin atlanması (H1 → H3)
 *   11  Doğal dil (`/Lang`)
 *   13  Görsellerde alternatif metin (`/Alt`)
 *   14  Bağlantılarda erişilebilir açıklama
 *   15  Tablo yapısı (TR / TH / TD, başlık kapsamı)
 *   19  XMP `pdfuaid:part` iddiası
 *   31  Font gömme (metin gerçekten okunabilmeli)
 */

const { Dict, Name, Str, Stream, Ref } = require('@fitfak/pdf-doc');
const { parseXmp } = require('./xmp');

const HEADING = /^H([1-6])$/;

/**
 * Bir belgeyi PDF/UA-1 açısından denetler.
 *
 * @param {import('@fitfak/pdf-doc').PdfDocument} doc
 * @returns {{ conforms: boolean, claimed: boolean, errors: Array,
 *             warnings: Array, structure: Object }}
 */
function checkPdfUA(doc) {
  const errors = [];
  const warnings = [];

  const fail = (rule, message, detail) =>
    errors.push({ rule, message, ...(detail ? { detail } : {}) });
  const warn = (rule, message, detail) =>
    warnings.push({ rule, message, ...(detail ? { detail } : {}) });

  // Yapı ağacı hiç yoksa da rapor üretilebilsin diye erken kurulur
  const stats = { elements: 0, roles: new Map(), headings: [], figures: 0, links: 0, tables: 0 };

  /* --- 19: XMP iddiası --------------------------------------------- */
  const xmp = readXmp(doc);
  const claimed = !!(xmp && xmp.pdfUA);
  if (!xmp) warn('19', 'Belge XMP üst verisi taşımıyor');
  else if (!xmp.pdfUA) warn('19', 'XMP içinde pdfuaid:part iddiası yok');

  /* --- 01: işaretli belge ve yapı ağacı ---------------------------- */
  const markInfo = doc.get(doc.catalog, 'MarkInfo');
  const marked = markInfo instanceof Dict && markInfo.get('Marked') === true;
  if (!marked) fail('01', '/MarkInfo << /Marked true >> yok — belge etiketli değil');

  const structRoot = doc.get(doc.catalog, 'StructTreeRoot');
  if (!(structRoot instanceof Dict)) {
    fail('01', '/StructTreeRoot yok — yapı ağacı olmadan PDF/UA mümkün değil');
    return finish();
  }
  if (!doc.resolve(structRoot.get('ParentTree'))) {
    fail('01', '/StructTreeRoot içinde /ParentTree yok');
  }

  /* --- 11: doğal dil ----------------------------------------------- */
  const lang = doc.get(doc.catalog, 'Lang');
  if (!(lang instanceof Str) || !lang.toText().trim()) {
    fail('11', 'Katalogda /Lang yok — ekran okuyucu hangi dilde okuyacağını bilemez');
  }

  /* --- 06: belge başlığı ------------------------------------------- */
  const info = doc.getInfo();
  if (!info.Title || !String(info.Title).trim()) {
    fail('06', '/Info /Title boş — belge başlığı zorunludur');
  }
  const prefs = doc.get(doc.catalog, 'ViewerPreferences');
  if (!(prefs instanceof Dict) || prefs.get('DisplayDocTitle') !== true) {
    fail('06', '/ViewerPreferences << /DisplayDocTitle true >> yok — ' +
      'okuyucu pencere başlığında dosya adını gösterir');
  }

  /* --- yapı ağacını gez -------------------------------------------- */
  const roleMap = readRoleMap(doc, structRoot);

  walk(doc, structRoot.get('K'), null, 0, {
    stats, roleMap, fail, warn,
    seen: new Set()
  });

  /* --- 09: başlık düzeyi atlanmış mı ------------------------------- */
  let previous = 0;
  for (const level of stats.headings) {
    if (previous && level > previous + 1) {
      fail('09', `Başlık düzeyi atlanmış: H${previous} sonrası H${level}`);
      break;
    }
    previous = Math.max(previous, level);
  }
  if (stats.headings.length && stats.headings[0] !== 1) {
    warn('09', `Belge H${stats.headings[0]} ile başlıyor; H1 beklenir`);
  }

  /* --- 31: font gömme ---------------------------------------------- */
  for (const problem of unembeddedFonts(doc)) {
    fail('31', `Font ${problem} gömülü değil — metin güvenilir biçimde okunamaz`);
  }

  /* --- 01: etiketlenmemiş içerik ----------------------------------- */
  for (let i = 0; i < doc.pageCount; i++) {
    const { dict } = doc.getPage(i);
    if (dict.get('StructParents') === undefined) {
      warn('01', `Sayfa ${i + 1}: /StructParents yok — işaretli içerik geri izlenemez`);
    }
    const untagged = countUntaggedOperators(doc, i);
    if (untagged > 0) {
      fail('01', `Sayfa ${i + 1}: ${untagged} çizim işlemi ne etikete ne de ` +
        'yapay içeriğe (/Artifact) bağlı');
    }
  }

  function finish() {
    return {
      conforms: errors.length === 0,
      claimed,
      errors,
      warnings,
      structure: {
        elements: stats.elements,
        roles: Object.fromEntries(stats.roles),
        headings: stats.headings,
        figures: stats.figures,
        links: stats.links,
        tables: stats.tables
      }
    };
  }

  return finish();
}

/* ------------------------------------------------------------------ */

/** Yapı ağacını gezip kural ihlallerini toplar. */
function walk(doc, node, parentRole, depth, ctx) {
  if (depth > 64) return;
  const value = doc.resolve(node);

  if (Array.isArray(value)) {
    for (const kid of value) walk(doc, kid, parentRole, depth + 1, ctx);
    return;
  }
  if (!(value instanceof Dict)) return;      // MCID sayısı ya da null

  const type = value.get('Type');
  if (type instanceof Name && (type.name === 'MCR' || type.name === 'OBJR')) return;

  const key = node instanceof Ref ? node.key : null;
  if (key) {
    if (ctx.seen.has(key)) return;
    ctx.seen.add(key);
  }

  const s = value.get('S');
  const rawRole = s instanceof Name ? s.name : null;
  if (!rawRole) return;

  const role = ctx.roleMap.get(rawRole) || rawRole;
  ctx.stats.elements++;
  ctx.stats.roles.set(role, (ctx.stats.roles.get(role) || 0) + 1);

  const heading = HEADING.exec(role);
  if (heading) ctx.stats.headings.push(Number(heading[1]));

  /* --- 13: Figure /Alt --------------------------------------------- */
  if (role === 'Figure') {
    ctx.stats.figures++;
    if (!hasText(doc, value, 'Alt') && !hasText(doc, value, 'ActualText')) {
      ctx.fail('13', 'Figure elemanında /Alt (alternatif metin) yok');
    }
  }

  /* --- 14: Link erişilebilir açıklama ------------------------------ */
  if (role === 'Link') {
    ctx.stats.links++;
    const annot = findObjr(doc, value);
    const described = hasText(doc, value, 'Alt') ||
      (annot && annot.has('Contents') && String(doc.resolve(annot.get('Contents')) || '').trim());
    if (!described) {
      ctx.fail('14', 'Link elemanında ne /Alt ne de açıklamanın /Contents değeri var');
    }
    if (!annot) {
      ctx.warn('14', 'Link elemanı bir açıklamaya (/OBJR) bağlı değil');
    }
  }

  /* --- 15: tablo yapısı -------------------------------------------- */
  if (role === 'Table') {
    ctx.stats.tables++;
    const roles = collectDescendantRoles(doc, value, ctx.roleMap, 0);
    if (!roles.has('TR')) {
      ctx.fail('15', 'Table elemanı hiç TR (satır) içermiyor');
    }
    if (!roles.has('TH')) {
      ctx.warn('15', 'Tabloda başlık hücresi (TH) yok — ekran okuyucu sütunları adlandıramaz');
    }
  }
  if (role === 'TH') {
    const a = doc.resolve(value.get('A'));
    const scope = a instanceof Dict ? a.get('Scope') : null;
    if (!(scope instanceof Name)) {
      ctx.warn('15', 'TH hücresinde /A << /O /Table /Scope … >> yok');
    }
  }

  /* --- LI yapısı ---------------------------------------------------- */
  if (role === 'LI') {
    const roles = collectDescendantRoles(doc, value, ctx.roleMap, 0);
    if (!roles.has('LBody') && !roles.has('Lbl')) {
      ctx.warn('15', 'LI elemanı Lbl/LBody içermiyor');
    }
  }

  walk(doc, value.get('K'), role, depth + 1, ctx);
}

function collectDescendantRoles(doc, node, roleMap, depth, out = new Set()) {
  if (depth > 8) return out;
  const kids = doc.resolve(node.get('K'));
  const list = Array.isArray(kids) ? kids : [kids];

  for (const kid of list) {
    const value = doc.resolve(kid);
    if (!(value instanceof Dict)) continue;
    const s = value.get('S');
    if (s instanceof Name) {
      out.add(roleMap.get(s.name) || s.name);
      collectDescendantRoles(doc, value, roleMap, depth + 1, out);
    }
  }
  return out;
}

function findObjr(doc, node, depth = 0) {
  if (depth > 4) return null;
  const kids = doc.resolve(node.get('K'));
  const list = Array.isArray(kids) ? kids : [kids];

  for (const kid of list) {
    const value = doc.resolve(kid);
    if (!(value instanceof Dict)) continue;
    const type = value.get('Type');
    if (type instanceof Name && type.name === 'OBJR') {
      const obj = doc.resolve(value.get('Obj'));
      return obj instanceof Dict ? obj : null;
    }
  }
  return null;
}

function hasText(doc, dict, key) {
  const value = doc.resolve(dict.get(key));
  if (value instanceof Str) return value.toText().trim().length > 0;
  return typeof value === 'string' && value.trim().length > 0;
}

function readRoleMap(doc, structRoot) {
  const map = new Map();
  const roleMap = doc.resolve(structRoot.get('RoleMap'));
  if (roleMap instanceof Dict) {
    for (const [from, to] of roleMap.map) {
      if (to instanceof Name) map.set(from, to.name);
    }
  }
  return map;
}

/**
 * Sayfadaki çizim işlemlerinden kaçının işaretlenmemiş olduğunu sayar.
 *
 * `BDC`/`BMC` ile açılan bir blok içindeyken her şey etiketlidir. Blok dışında
 * kalan metin gösterimi (`Tj`, `TJ`) ve XObject çizimi (`Do`) PDF/UA'da
 * "etiketlenmemiş içerik"tir.
 */
function countUntaggedOperators(doc, pageIndex) {
  const { tokenizeContent } = require('@fitfak/pdf-doc');

  let data;
  try {
    data = doc.getPageContent(pageIndex);
  } catch {
    return 0;
  }

  let depth = 0;
  let untagged = 0;

  for (const { op } of tokenizeContent(data)) {
    if (op === 'BDC' || op === 'BMC') { depth++; continue; }
    if (op === 'EMC') { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"' || op === 'Do') untagged++;
  }
  return untagged;
}

function unembeddedFonts(doc) {
  const problems = [];
  const seen = new Set();

  for (const [num, entry] of doc.xref.entries) {
    if (entry.type === 0) continue;
    let obj;
    try { obj = doc.getObject(num); } catch { continue; }
    if (!(obj instanceof Dict)) continue;

    const type = obj.get('Type');
    if (!(type instanceof Name) || type.name !== 'Font') continue;

    const subtype = obj.get('Subtype');
    if (subtype instanceof Name && subtype.name === 'Type3') continue;

    const baseFont = obj.get('BaseFont');
    const name = baseFont instanceof Name ? baseFont.name : `(nesne ${num})`;
    if (seen.has(name)) continue;
    seen.add(name);

    let descriptor = doc.resolve(obj.get('FontDescriptor'));
    if (!(descriptor instanceof Dict) && subtype instanceof Name && subtype.name === 'Type0') {
      const descendants = doc.resolve(obj.get('DescendantFonts'));
      const cid = Array.isArray(descendants) ? doc.resolve(descendants[0]) : null;
      descriptor = cid instanceof Dict ? doc.resolve(cid.get('FontDescriptor')) : null;
    }

    const embedded = descriptor instanceof Dict &&
      ['FontFile', 'FontFile2', 'FontFile3'].some((k) => descriptor.has(k));
    if (!embedded) problems.push(name);
  }
  return problems;
}

function readXmp(doc) {
  const stream = doc.get(doc.catalog, 'Metadata');
  if (!(stream instanceof Stream)) return null;
  try {
    return parseXmp(doc.getStreamData(stream));
  } catch {
    return null;
  }
}

module.exports = { checkPdfUA };
