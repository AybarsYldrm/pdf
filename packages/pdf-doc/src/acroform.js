'use strict';
/**
 * Etkileşimli formlar (AcroForm) — ISO 32000-1 §12.7.
 *
 * Okuma, doldurma ve düzleştirme (flatten). Doldurma sırasında görünüm akışı
 * (`/AP /N`) yeniden üretilir; aksi hâlde `/NeedAppearances` bayrağına muhtaç
 * kalırdık ve pek çok okuyucu alanı boş gösterirdi.
 *
 * İmza alanlarına (`/FT /Sig`) DOKUNULMAZ: onları PAdES motoru yönetir.
 */

const { Dict, Ref, Name, Str, Stream, textString } = require('./lexer');
const { addResource, appendContent } = require('./edit');
const { encodeWinAnsi } = require('./edit');

class FormError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FormError';
    this.code = code;
  }
}

/* Alan bayrakları (Tablo 226–228) */
const FLAG_READONLY = 1 << 0;
const FLAG_REQUIRED = 1 << 1;
const FLAG_MULTILINE = 1 << 12;
const FLAG_PASSWORD = 1 << 13;
const FLAG_RADIO = 1 << 15;
const FLAG_PUSHBUTTON = 1 << 16;
const FLAG_COMBO = 1 << 17;

/* ------------------------------------------------------------------ */
/* Okuma                                                              */
/* ------------------------------------------------------------------ */

/** `/AcroForm` sözlüğü (yoksa null). */
function getAcroForm(doc) {
  const acro = doc.resolve(doc.catalog.get('AcroForm'));
  return acro instanceof Dict ? acro : null;
}

/**
 * Belgedeki tüm form alanlarını düz liste hâlinde döndürür.
 *
 * @returns {Array<{ name: string, type: string, value: *, options: string[],
 *                   readOnly: boolean, required: boolean, multiline: boolean,
 *                   page: number|null, rect: number[]|null, ref: Ref }>}
 */
function listFields(doc) {
  const acro = getAcroForm(doc);
  if (!acro) return [];

  const roots = doc.resolve(acro.get('Fields'));
  if (!Array.isArray(roots)) return [];

  const pageOf = buildPageIndex(doc);
  const out = [];
  const seen = new Set();

  const walk = (ref, inherited, depth) => {
    if (depth > 32) return;
    const key = ref instanceof Ref ? ref.key : null;
    if (key) {
      if (seen.has(key)) return;
      seen.add(key);
    }

    const field = doc.resolve(ref);
    if (!(field instanceof Dict)) return;

    const partial = field.get('T');
    const localName = partial instanceof Str ? partial.toText() : null;
    const fullName = localName
      ? (inherited.name ? `${inherited.name}.${localName}` : localName)
      : inherited.name;

    const ft = field.get('FT');
    const type = ft instanceof Name ? ft.name : inherited.type;
    const flags = Number(field.get('Ff'));
    const effectiveFlags = Number.isFinite(flags) ? flags : inherited.flags;

    const kids = doc.resolve(field.get('Kids'));
    // Kids gerçek alt ALAN mı yoksa yalnız görünüm (widget) mu?
    const kidsAreFields = Array.isArray(kids) && kids.some((kid) => {
      const k = doc.resolve(kid);
      return k instanceof Dict && k.has('T');
    });

    if (kidsAreFields) {
      for (const kid of kids) {
        walk(kid, { name: fullName, type, flags: effectiveFlags }, depth + 1);
      }
      return;
    }

    if (!fullName) return;

    const widget = Array.isArray(kids) && kids.length ? doc.resolve(kids[0]) : field;
    const widgetRef = Array.isArray(kids) && kids.length ? kids[0] : ref;

    out.push({
      name: fullName,
      type: type || 'Tx',
      value: readValue(doc, field, inherited),
      defaultValue: readRaw(doc, field.get('DV')),
      options: readOptions(doc, field),
      readOnly: !!(effectiveFlags & FLAG_READONLY),
      required: !!(effectiveFlags & FLAG_REQUIRED),
      multiline: !!(effectiveFlags & FLAG_MULTILINE),
      password: !!(effectiveFlags & FLAG_PASSWORD),
      radio: !!(effectiveFlags & FLAG_RADIO),
      pushButton: !!(effectiveFlags & FLAG_PUSHBUTTON),
      combo: !!(effectiveFlags & FLAG_COMBO),
      page: widgetRef instanceof Ref ? (pageOf.get(widgetRef.key) ?? null) : null,
      rect: readRect(doc, widget),
      ref: ref instanceof Ref ? ref : null,
      widgets: Array.isArray(kids) && kids.length ? kids.filter((k) => k instanceof Ref) : [ref]
    });
  };

  for (const ref of roots) walk(ref, { name: '', type: null, flags: 0 }, 0);
  return out;
}

/** Widget referansı → sayfa dizini. */
function buildPageIndex(doc) {
  const map = new Map();
  for (let i = 0; i < doc.pageCount; i++) {
    const { dict } = doc.getPage(i);
    const annots = doc.resolve(dict.get('Annots'));
    if (!Array.isArray(annots)) continue;
    for (const a of annots) if (a instanceof Ref) map.set(a.key, i);
  }
  return map;
}

function readRect(doc, widget) {
  if (!(widget instanceof Dict)) return null;
  const rect = doc.resolve(widget.get('Rect'));
  if (!Array.isArray(rect) || rect.length < 4) return null;
  const n = rect.map((v) => Number(doc.resolve(v)) || 0);
  return [Math.min(n[0], n[2]), Math.min(n[1], n[3]), Math.max(n[0], n[2]), Math.max(n[1], n[3])];
}

function readRaw(doc, value) {
  const v = doc.resolve(value);
  if (v instanceof Str) return v.toText();
  if (v instanceof Name) return v.name;
  if (Array.isArray(v)) return v.map((item) => readRaw(doc, item));
  return v === undefined ? null : v;
}

function readValue(doc, field, inherited) {
  if (field.has('V')) return readRaw(doc, field.get('V'));
  const parent = doc.resolve(field.get('Parent'));
  if (parent instanceof Dict && parent.has('V')) return readRaw(doc, parent.get('V'));
  return inherited && inherited.value !== undefined ? inherited.value : null;
}

function readOptions(doc, field) {
  const opt = doc.resolve(field.get('Opt'));
  if (!Array.isArray(opt)) return [];
  return opt.map((item) => {
    const v = doc.resolve(item);
    if (Array.isArray(v)) return readRaw(doc, v[1]);      // [dışa aktarım, görünen]
    return readRaw(doc, v);
  }).filter((v) => typeof v === 'string');
}

/* ------------------------------------------------------------------ */
/* Doldurma                                                           */
/* ------------------------------------------------------------------ */

/**
 * Form alanlarını doldurur.
 *
 * @param {Object} doc
 * @param {Object<string, string|boolean|number>} values alan adı → değer
 * @param {{ strict?: boolean, appearances?: boolean, readOnly?: boolean }} [opts]
 *        `strict` → bilinmeyen ad hata verir; `appearances:false` → görünüm
 *        üretme, yalnız `/NeedAppearances` işaretle.
 * @returns {{ filled: string[], skipped: Array<{name:string, reason:string}> }}
 */
function fillForm(doc, values, opts = {}) {
  const acro = getAcroForm(doc);
  if (!acro) throw new FormError('ERR_NO_ACROFORM', 'Belgede form (AcroForm) yok');

  const fields = new Map(listFields(doc).map((f) => [f.name, f]));
  const filled = [];
  const skipped = [];

  for (const [name, value] of Object.entries(values)) {
    const field = fields.get(name);
    if (!field) {
      if (opts.strict) throw new FormError('ERR_FIELD_NOT_FOUND', `Form alanı yok: ${name}`);
      skipped.push({ name, reason: 'alan yok' });
      continue;
    }
    if (field.type === 'Sig') {
      skipped.push({ name, reason: 'imza alanı — PAdES motoruna aittir' });
      continue;
    }
    if (field.readOnly && !opts.readOnly) {
      skipped.push({ name, reason: 'salt okunur' });
      continue;
    }

    setFieldValue(doc, field, value, opts);
    filled.push(name);
  }

  // /NeedAppearances: görünüm üretmediysek okuyucudan istemek zorundayız
  const acroClone = new Dict(new Map(acro.map));
  acroClone.set('NeedAppearances', opts.appearances === false);
  writeAcroForm(doc, acroClone);

  return { filled, skipped };
}

function writeAcroForm(doc, acroDict) {
  const ref = doc.catalog.get('AcroForm');
  if (ref instanceof Ref) {
    doc.setObject(ref.num, acroDict);
    return;
  }
  const catalog = new Dict(new Map(doc.catalog.map));
  catalog.set('AcroForm', doc.addObject(acroDict));
  const rootRef = doc.trailer.get('Root');
  doc.setObject(rootRef.num, catalog);
  doc.catalog = catalog;
}

function setFieldValue(doc, field, value, opts) {
  const dict = doc.resolve(field.ref);
  const clone = new Dict(new Map(dict.map));

  if (field.type === 'Btn') {
    const on = pickOnState(doc, field, value);
    clone.set('V', Name.get(on));
    doc.setObject(field.ref.num, clone);
    doc.cache.delete(field.ref.num);

    for (const wref of field.widgets) {
      if (!(wref instanceof Ref)) continue;
      const w = doc.resolve(wref);
      if (!(w instanceof Dict)) continue;
      const wc = new Dict(new Map(w.map));
      // Radyo grubunda yalnız eşleşen widget seçili olur
      const states = appearanceStates(doc, w);
      wc.set('AS', Name.get(states.includes(on) ? on : 'Off'));
      doc.setObject(wref.num, wc);
      doc.cache.delete(wref.num);
    }
    return;
  }

  const text = value === null || value === undefined ? '' : String(value);
  clone.set('V', textString(text));
  if (field.type === 'Ch') clone.set('I', []);
  doc.setObject(field.ref.num, clone);
  doc.cache.delete(field.ref.num);

  if (opts.appearances === false) return;

  for (const wref of field.widgets) {
    if (!(wref instanceof Ref)) continue;
    buildTextAppearance(doc, wref, field, text);
  }
}

/** Onay/radyo düğmesi için "açık" durumun adını bulur. */
function pickOnState(doc, field, value) {
  const states = [];
  for (const wref of field.widgets) {
    const w = doc.resolve(wref);
    if (w instanceof Dict) states.push(...appearanceStates(doc, w));
  }

  if (typeof value === 'string' && states.includes(value)) return value;
  if (value === false || value === 'Off' || value === 0) return 'Off';

  const on = states.find((s) => s !== 'Off');
  return on || 'Yes';
}

function appearanceStates(doc, widget) {
  const ap = doc.resolve(widget.get('AP'));
  if (!(ap instanceof Dict)) return [];
  const normal = doc.resolve(ap.get('N'));
  if (!(normal instanceof Dict)) return [];
  return [...normal.map.keys()];
}

/**
 * Metin alanı için `/AP /N` görünüm akışı üretir.
 *
 * `/DA` (default appearance) dizgisinden font ve renk okunur; yoksa
 * Helvetica'ya düşülür. Metin dikeyde ortalanır, `/Q` ile hizalanır.
 */
function buildTextAppearance(doc, widgetRef, field, text) {
  const widget = doc.resolve(widgetRef);
  if (!(widget instanceof Dict)) return;

  const rect = readRect(doc, widget) || [0, 0, 100, 20];
  const width = rect[2] - rect[0];
  const height = rect[3] - rect[1];
  if (width <= 0 || height <= 0) return;

  const da = readDefaultAppearance(doc, widget, field);
  const padding = 2;

  let size = da.size;
  if (!size) {                                   // 0 = otomatik boyut
    size = field.multiline ? 10 : Math.min(12, Math.max(4, height - 2 * padding - 2));
  }

  const lines = field.multiline ? String(text).split(/\r\n|\r|\n/) : [String(text)];
  const leading = size * 1.18;

  const quadding = Number(doc.resolve(widget.get('Q'))) || 0;
  const escapeAndPlace = (line, index) => {
    const encoded = encodeWinAnsi(line);
    const y = field.multiline
      ? height - padding - leading * (index + 1) + leading * 0.25
      : (height - size) / 2 + size * 0.22;

    let x = padding;
    if (quadding) {
      const approx = line.length * size * 0.5;    // kaba genişlik tahmini
      x = quadding === 1
        ? Math.max(padding, (width - approx) / 2)
        : Math.max(padding, width - approx - padding);
    }
    return `${fmt(x)} ${fmt(y)} Td (${encoded}) Tj`;
  };

  const body = lines.map((line, i) =>
    (i === 0 ? escapeAndPlace(line, i) : `${fmt(0)} ${fmt(-leading)} Td (${encodeWinAnsi(line)}) Tj`)
  ).join('\n');

  const content =
    '/Tx BMC\nq\n' +
    `1 1 ${fmt(width - 2)} ${fmt(height - 2)} re W n\n` +
    `BT\n${da.color}\n/${da.fontName} ${fmt(size)} Tf\n${body}\nET\nQ\nEMC`;

  const streamDict = new Dict();
  streamDict.set('Type', Name.get('XObject'));
  streamDict.set('Subtype', Name.get('Form'));
  streamDict.set('BBox', [0, 0, width, height]);
  streamDict.set('Resources', da.resources);

  const streamRef = doc.addObject(new Stream(streamDict, Buffer.from(content, 'latin1')));

  const clone = new Dict(new Map(widget.map));
  const ap = new Dict();
  ap.set('N', streamRef);
  clone.set('AP', ap);
  doc.setObject(widgetRef.num, clone);
  doc.cache.delete(widgetRef.num);
}

/** `/DA` dizgisini çözer: font adı, boyut, renk operatörleri ve kaynaklar. */
function readDefaultAppearance(doc, widget, field) {
  const acro = getAcroForm(doc);
  const pick = (dict) => {
    const v = dict instanceof Dict ? doc.resolve(dict.get('DA')) : null;
    return v instanceof Str ? v.toString() : null;
  };
  const da = pick(widget) || pick(doc.resolve(field.ref)) || pick(acro) || '';

  const fontMatch = /\/([^\s/]+)\s+([\d.]+)\s+Tf/.exec(da);
  const colorMatch = /((?:[\d.]+\s+){1,4})(g|rg|k)\b/.exec(da);

  const dr = acro ? doc.resolve(acro.get('DR')) : null;
  let resources = dr instanceof Dict ? dr : null;
  let fontName = fontMatch ? fontMatch[1] : null;

  // Belirtilen font DR içinde yoksa gömmesiz bir Helvetica kur
  const drFonts = resources ? doc.resolve(resources.get('Font')) : null;
  if (!fontName || !(drFonts instanceof Dict) || !drFonts.has(fontName)) {
    const helv = new Dict();
    helv.set('Type', Name.get('Font'));
    helv.set('Subtype', Name.get('Type1'));
    helv.set('BaseFont', Name.get('Helvetica'));

    const encoding = new Dict();
    encoding.set('Type', Name.get('Encoding'));
    encoding.set('BaseEncoding', Name.get('WinAnsiEncoding'));
    encoding.set('Differences', [
      208, Name.get('Gbreve'), 221, Name.get('Idotaccent'), 222, Name.get('Scedilla'),
      240, Name.get('gbreve'), 253, Name.get('dotlessi'), 254, Name.get('scedilla')
    ]);
    helv.set('Encoding', encoding);

    const fonts = new Dict();
    fonts.set('HelvTr', doc.addObject(helv));
    const res = new Dict();
    res.set('Font', fonts);
    resources = res;
    fontName = 'HelvTr';
  }

  return {
    fontName,
    size: fontMatch ? Number(fontMatch[2]) : 0,
    color: colorMatch ? `${colorMatch[1].trim()} ${colorMatch[2]}` : '0 g',
    resources
  };
}

function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n * 1000) / 1000);
}

/* ------------------------------------------------------------------ */
/* Düzleştirme                                                        */
/* ------------------------------------------------------------------ */

/**
 * Form alanlarını kalıcı sayfa içeriğine dönüştürür ve etkileşimi kaldırır.
 *
 * İmza alanları korunur (düzleştirilmesi imzayı anlamsız kılar); `only` ile
 * yalnız belirli alanlar düzleştirilebilir.
 *
 * @param {{ only?: string[], keepSignatures?: boolean }} [opts]
 * @returns {{ flattened: string[], kept: string[] }}
 */
function flattenForm(doc, opts = {}) {
  const acro = getAcroForm(doc);
  if (!acro) return { flattened: [], kept: [] };

  const only = opts.only ? new Set(opts.only) : null;
  const keepSignatures = opts.keepSignatures !== false;

  const flattened = [];
  const kept = [];
  const removedWidgets = new Set();

  for (const field of listFields(doc)) {
    if (only && !only.has(field.name)) { kept.push(field.name); continue; }
    if (field.type === 'Sig' && keepSignatures) { kept.push(field.name); continue; }

    let drew = false;
    for (const wref of field.widgets) {
      if (!(wref instanceof Ref)) continue;
      if (drawWidget(doc, wref)) {
        removedWidgets.add(wref.key);
        drew = true;
      }
    }
    (drew ? flattened : kept).push(field.name);
  }

  // Düzleştirilen widget'ları sayfalardan çıkar
  if (removedWidgets.size) {
    for (let i = 0; i < doc.pageCount; i++) {
      const { ref, dict } = doc.getPage(i);
      const annots = doc.resolve(dict.get('Annots'));
      if (!Array.isArray(annots)) continue;

      const remaining = annots.filter((a) => !(a instanceof Ref) || !removedWidgets.has(a.key));
      if (remaining.length === annots.length) continue;

      const clone = new Dict(new Map(dict.map));
      if (remaining.length) clone.set('Annots', remaining);
      else clone.delete('Annots');
      doc.setObject(ref.num, clone);
      doc.cache.delete(ref.num);
    }
  }

  // /Fields listesini güncelle
  const remainingNames = new Set(kept);
  const roots = doc.resolve(acro.get('Fields'));
  if (Array.isArray(roots)) {
    const next = roots.filter((r) => {
      const f = doc.resolve(r);
      if (!(f instanceof Dict)) return false;
      const t = f.get('T');
      const name = t instanceof Str ? t.toText() : null;
      return !name || remainingNames.has(name) || [...remainingNames].some((k) => k.startsWith(`${name}.`));
    });

    const clone = new Dict(new Map(acro.map));
    clone.set('Fields', next);
    clone.set('NeedAppearances', false);
    writeAcroForm(doc, clone);
  }

  return { flattened, kept };
}

/** Widget'ın görünüm akışını sayfa içeriğine kopyalar. */
function drawWidget(doc, widgetRef) {
  const widget = doc.resolve(widgetRef);
  if (!(widget instanceof Dict)) return false;

  const rect = readRect(doc, widget);
  if (!rect) return false;

  // Gizli / basılmaz açıklamaları çizme (bayrak 2 = Hidden, 6 = NoView)
  const flags = Number(doc.resolve(widget.get('F'))) || 0;
  if (flags & 0x02 || flags & 0x20) return true;   // yine de kaldırılır

  let appearance = doc.resolve(widget.get('AP'));
  appearance = appearance instanceof Dict ? doc.resolve(appearance.get('N')) : null;

  if (appearance instanceof Dict && !(appearance instanceof Stream)) {
    const state = widget.get('AS');
    appearance = state instanceof Name ? doc.resolve(appearance.get(state.name)) : null;
  }
  if (!(appearance instanceof Stream)) return true;   // çizecek görünüm yok

  const pageIndex = findWidgetPage(doc, widgetRef);
  if (pageIndex == null) return false;

  const bbox = doc.resolve(appearance.dict.get('BBox')) || [0, 0, rect[2] - rect[0], rect[3] - rect[1]];
  const matrix = doc.resolve(appearance.dict.get('Matrix')) || [1, 0, 0, 1, 0, 0];

  // BBox'u Matrix ile dönüştür, sonra Rect'e ölçekle (ISO 32000-1 §12.5.5)
  const corners = [
    [bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]
  ].map(([x, y]) => [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5]
  ]);

  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const bw = Math.max(...xs) - Math.min(...xs);
  const bh = Math.max(...ys) - Math.min(...ys);

  const sx = bw > 0 ? (rect[2] - rect[0]) / bw : 1;
  const sy = bh > 0 ? (rect[3] - rect[1]) / bh : 1;
  const tx = rect[0] - Math.min(...xs) * sx;
  const ty = rect[1] - Math.min(...ys) * sy;

  // Görünüm akışını sayfaya XObject olarak bağla (içeriği kopyalamaktan güvenli)
  const name = addResource(doc, pageIndex, 'XObject', widgetAppearanceRef(doc, widget), 'Fx');
  appendContent(doc, pageIndex,
    `${fmt(sx)} 0 0 ${fmt(sy)} ${fmt(tx)} ${fmt(ty)} cm\n/${name} Do`);
  return true;
}

/** Görünüm akışının referansını verir (gerekirse yeniden bağlar). */
function widgetAppearanceRef(doc, widget) {
  const ap = doc.resolve(widget.get('AP'));
  let normal = ap instanceof Dict ? ap.get('N') : null;

  const resolved = doc.resolve(normal);
  if (resolved instanceof Dict && !(resolved instanceof Stream)) {
    const state = widget.get('AS');
    normal = state instanceof Name ? resolved.get(state.name) : null;
  }
  if (normal instanceof Ref) return normal;

  const stream = doc.resolve(normal);
  return stream instanceof Stream ? doc.addObject(stream) : null;
}

function findWidgetPage(doc, widgetRef) {
  const widget = doc.resolve(widgetRef);
  const p = widget instanceof Dict ? widget.get('P') : null;
  if (p instanceof Ref) {
    const idx = doc.pageRefs.findIndex((r) => r instanceof Ref && r.key === p.key);
    if (idx >= 0) return idx;
  }
  return buildPageIndex(doc).get(widgetRef.key) ?? null;
}

module.exports = {
  getAcroForm, listFields, fillForm, flattenForm, FormError,
  FLAG_READONLY, FLAG_REQUIRED, FLAG_MULTILINE, FLAG_RADIO, FLAG_PUSHBUTTON, FLAG_COMBO
};
