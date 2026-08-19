'use strict';
/**
 * Belge düzenleme işlemleri.
 *
 * Hepsi artımlı revizyon olarak kaydedilir; imzalı belgelerde önceki imzalar
 * geçerliliğini korur.
 */

const zlib = require('zlib');
const { Dict, Ref, Name, Str, Stream, serialize, textString } = require('./lexer');

class EditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EditError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Sayfa ağacı yardımcıları                                             */
/* ------------------------------------------------------------------ */

/** Sayfa ağacını düz bir /Kids listesine indirger (düzenlemeyi basitleştirir). */
function flattenPageTree(doc) {
  const refs = doc.pageRefs.slice();
  const pagesRef = doc.catalog.get('Pages');
  const pagesDict = doc.resolve(pagesRef);
  if (!(pagesDict instanceof Dict)) {
    throw new EditError('ERR_NO_PAGE_TREE', 'Sayfa ağacı bulunamadı');
  }

  const pagesNum = pagesRef instanceof Ref ? pagesRef.num : null;
  if (pagesNum == null) {
    throw new EditError('ERR_PAGE_TREE_INLINE', 'Sayfa ağacı kökü referans değil');
  }

  // Miras alınan özellikleri sayfalara indir; sonra ağacı düzleştir
  for (const ref of refs) {
    if (!(ref instanceof Ref)) continue;
    const page = doc.resolve(ref);
    if (!(page instanceof Dict)) continue;

    let changed = false;
    const clone = new Dict(new Map(page.map));
    for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
      if (!clone.has(key)) {
        const inherited = doc.getPageProperty(page, key);
        if (inherited !== undefined) {
          clone.set(key, inherited);
          changed = true;
        }
      }
    }
    if (clone.get('Parent') === undefined || !sameRef(clone.get('Parent'), pagesRef)) {
      clone.set('Parent', new Ref(pagesNum, 0));
      changed = true;
    }
    if (changed) doc.setObject(ref.num, clone);
  }

  return { pagesRef, pagesNum, refs };
}

function sameRef(a, b) {
  return a instanceof Ref && b instanceof Ref && a.num === b.num && a.gen === b.gen;
}

/** Kök /Pages düğümünü verilen sayfa listesine göre yeniden yazar. */
function writePageList(doc, pagesNum, refs) {
  const pagesDict = doc.resolve(new Ref(pagesNum, 0));
  const clone = pagesDict instanceof Dict ? new Dict(new Map(pagesDict.map)) : new Dict();
  clone.set('Type', Name.get('Pages'));
  clone.set('Kids', refs);
  clone.set('Count', refs.length);
  clone.delete('Parent');
  doc.setObject(pagesNum, clone);
  doc._pageRefs = refs.slice();
}

/* ------------------------------------------------------------------ */
/* Sayfa işlemleri                                                      */
/* ------------------------------------------------------------------ */

/** Sayfayı siler. */
function removePage(doc, index) {
  const { pagesNum, refs } = flattenPageTree(doc);
  if (index < 0 || index >= refs.length) {
    throw new EditError('ERR_PAGE_INDEX', `Sayfa ${index} yok (toplam ${refs.length})`);
  }
  if (refs.length === 1) {
    throw new EditError('ERR_LAST_PAGE', 'Belgenin tek sayfası silinemez');
  }
  refs.splice(index, 1);
  writePageList(doc, pagesNum, refs);
  return doc;
}

/** Sayfayı başka konuma taşır. */
function movePage(doc, from, to) {
  const { pagesNum, refs } = flattenPageTree(doc);
  if (from < 0 || from >= refs.length) {
    throw new EditError('ERR_PAGE_INDEX', `Kaynak sayfa ${from} yok`);
  }
  const target = Math.max(0, Math.min(refs.length - 1, to));
  const [ref] = refs.splice(from, 1);
  refs.splice(target, 0, ref);
  writePageList(doc, pagesNum, refs);
  return doc;
}

/** Sayfaları verilen sıraya göre yeniden dizer. */
function reorderPages(doc, order) {
  const { pagesNum, refs } = flattenPageTree(doc);
  if (!Array.isArray(order) || order.length !== refs.length) {
    throw new EditError('ERR_ORDER_LENGTH',
      `Sıra dizisi ${refs.length} öğe içermeli (gelen: ${order && order.length})`);
  }
  const seen = new Set();
  const next = [];
  for (const idx of order) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= refs.length || seen.has(idx)) {
      throw new EditError('ERR_ORDER_INVALID', `Geçersiz sıra değeri: ${idx}`);
    }
    seen.add(idx);
    next.push(refs[idx]);
  }
  writePageList(doc, pagesNum, next);
  return doc;
}

/** Sayfayı döndürür (90'ın katları). */
function rotatePage(doc, index, degrees) {
  const { ref, dict } = doc.getPage(index);
  if (!(ref instanceof Ref)) {
    throw new EditError('ERR_PAGE_INLINE', 'Sayfa nesnesi referans değil, döndürülemez');
  }
  const current = Number(doc.getPageProperty(dict, 'Rotate')) || 0;
  const next = (((current + degrees) % 360) + 360) % 360;
  if (next % 90 !== 0) {
    throw new EditError('ERR_ROTATE_ANGLE', 'Döndürme açısı 90 derecenin katı olmalı');
  }
  const clone = new Dict(new Map(dict.map));
  clone.set('Rotate', next);
  doc.setObject(ref.num, clone);
  doc.cache.delete(ref.num);
  return doc;
}

/** Boş sayfa ekler. */
function insertPage(doc, index, options = {}) {
  const { pagesNum, refs } = flattenPageTree(doc);
  const size = options.size || [0, 0, 595.28, 841.89];

  const page = new Dict();
  page.set('Type', Name.get('Page'));
  page.set('Parent', new Ref(pagesNum, 0));
  page.set('MediaBox', size);
  page.set('Resources', new Dict());
  if (options.rotate) page.set('Rotate', options.rotate);

  const ref = doc.addObject(page);
  const at = Math.max(0, Math.min(refs.length, index));
  refs.splice(at, 0, ref);
  writePageList(doc, pagesNum, refs);
  return ref;
}

/* ------------------------------------------------------------------ */
/* İçerik ekleme                                                        */
/* ------------------------------------------------------------------ */

/**
 * Sayfanın içerik akışının SONUNA yeni komutlar ekler.
 *
 * Mevcut içeriği bozmamak için `q … Q` ile sarmalanır ve dizi biçimine
 * çevrilerek eklenir — orijinal akış nesnesine hiç dokunulmaz.
 */
function appendContent(doc, pageIndex, commands) {
  const { ref, dict } = doc.getPage(pageIndex);
  if (!(ref instanceof Ref)) {
    throw new EditError('ERR_PAGE_INLINE', 'Sayfa nesnesi referans değil');
  }

  const body = Buffer.from('\nq\n' + commands + '\nQ\n', 'latin1');
  const stream = new Stream(new Dict(), body);
  const streamRef = doc.addObject(stream);

  const clone = new Dict(new Map(dict.map));
  const existing = clone.get('Contents');

  if (Array.isArray(existing)) {
    clone.set('Contents', [...existing, streamRef]);
  } else if (existing) {
    clone.set('Contents', [existing, streamRef]);
  } else {
    clone.set('Contents', [streamRef]);
  }

  doc.setObject(ref.num, clone);
  doc.cache.delete(ref.num);
  return streamRef;
}

/**
 * Sayfanın /Resources sözlüğüne bir kaynak ekler ve adını döndürür.
 *
 * /Resources üst düğümden MİRAS alınmış olabilir. O durumda sayfaya boş bir
 * sözlük yazmak mirası gölgeler ve mevcut içerik kaynaklarını kaybeder; bu
 * yüzden önce miras alınan sözlük sayfaya kopyalanır.
 */
function addResource(doc, pageIndex, category, value, prefix = 'R') {
  const { ref, dict } = doc.getPage(pageIndex);
  const clone = new Dict(new Map(dict.map));

  const resources = doc.getPageProperty(dict, 'Resources');
  const resClone = resources instanceof Dict ? new Dict(new Map(resources.map)) : new Dict();

  let group = doc.resolve(resClone.get(category));
  const groupClone = group instanceof Dict ? new Dict(new Map(group.map)) : new Dict();

  // Çakışmayan bir ad bul
  let n = 1;
  let name = `${prefix}${n}`;
  while (groupClone.has(name)) name = `${prefix}${++n}`;

  groupClone.set(name, value);
  resClone.set(category, groupClone);
  clone.set('Resources', resClone);

  doc.setObject(ref.num, clone);
  doc.cache.delete(ref.num);
  return name;
}

/**
 * Sayfaya PNG/JPEG görsel yerleştirir.
 *
 * @param {Object} doc
 * @param {number} pageIndex
 * @param {Buffer} imageBuffer PNG ya da JPEG
 * @param {{x:number, y:number, width:number, height?:number, rotate?:number, opacity?:number}} placement
 *        Koordinatlar PDF kullanıcı uzayındadır (sol-alt orijin).
 */
function addImage(doc, pageIndex, imageBuffer, placement) {
  if (!Buffer.isBuffer(imageBuffer)) {
    throw new EditError('ERR_IMAGE_INPUT', 'addImage: Buffer bekleniyor');
  }
  const info = buildImageXObject(doc, imageBuffer);
  const name = addResource(doc, pageIndex, 'XObject', info.ref, 'Im');

  const w = placement.width;
  const h = placement.height != null
    ? placement.height
    : w * (info.height / info.width);
  const x = placement.x;
  const y = placement.y;

  let cmd = '';
  if (placement.opacity != null && placement.opacity < 1) {
    const gs = new Dict();
    gs.set('Type', Name.get('ExtGState'));
    gs.set('ca', placement.opacity);
    gs.set('CA', placement.opacity);
    const gsName = addResource(doc, pageIndex, 'ExtGState', doc.addObject(gs), 'GS');
    cmd += `/${gsName} gs\n`;
  }

  const rotate = placement.rotate || 0;
  if (rotate) {
    const rad = (rotate * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    // Görselin merkezinde döndür
    const cx = x + w / 2, cy = y + h / 2;
    cmd += `1 0 0 1 ${num(cx)} ${num(cy)} cm\n`;
    cmd += `${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} 0 0 cm\n`;
    cmd += `1 0 0 1 ${num(-w / 2)} ${num(-h / 2)} cm\n`;
    cmd += `${num(w)} 0 0 ${num(h)} 0 0 cm\n/${name} Do`;
  } else {
    cmd += `${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm\n/${name} Do`;
  }

  appendContent(doc, pageIndex, cmd);
  return { name, width: info.width, height: info.height };
}

/** Görselden XObject üretir. */
function buildImageXObject(doc, buffer) {
  const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8;

  if (isJpeg) {
    const JpegParser = require('@fitfak/pdf/src/media/JpegParser');
    const p = new JpegParser(buffer);
    const dict = new Dict();
    dict.set('Type', Name.get('XObject'));
    dict.set('Subtype', Name.get('Image'));
    dict.set('Width', p.width);
    dict.set('Height', p.height);
    dict.set('ColorSpace', Name.get(p.components === 1 ? 'DeviceGray' : 'DeviceRGB'));
    dict.set('BitsPerComponent', 8);
    dict.set('Filter', Name.get('DCTDecode'));
    const stream = new Stream(dict, buffer);
    return { ref: doc.addObject(stream), width: p.width, height: p.height };
  }

  const PngParser = require('@fitfak/pdf/src/media/PngParser');
  const p = new PngParser(buffer);

  // PngParser'ın kendi gömme mantığını kullanıyoruz (RGBA ayrıştırma, palet,
  // tRNS saydamlığı tek yerde kalsın). Adaptör, o motorun dizgi biçimindeki
  // ilkel değerlerini ("/DeviceRGB", "3 0 R") bizim nesnelerimize çevirir.
  const adapter = {
    addStream(data, dict = {}) {
      // PngParser akışları zlib ile sıkıştırıp /FlateDecode yazar; yazıcı
      // /Filter'ı gördüğü için yeniden sıkıştırmaya kalkmaz.
      return doc.addObject(new Stream(toDict(dict), data)).num;
    },
    addDictionary(dict) {
      return doc.addObject(toDict(dict)).num;
    }
  };

  const mainNum = p.embedToDocument(adapter);
  const entry = doc.changes.get(mainNum);
  if (!entry || !(entry.value instanceof Stream)) {
    throw new EditError('ERR_IMAGE_PNG', 'PNG gömülemedi');
  }

  return { ref: new Ref(mainNum, 0), width: p.width, height: p.height };
}

const REF_RE = /^(\d+)\s+(\d+)\s+R$/;

/** Düz JS sözlüğünü PDF Dict'e çevirir ("/Ad" → Name, "3 0 R" → Ref). */
function toDict(obj) {
  const d = new Dict();
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    d.set(k, toValue(v));
  }
  return d;
}

function toValue(v) {
  if (typeof v === 'string') {
    if (v.startsWith('/')) return Name.get(v.slice(1));
    const m = REF_RE.exec(v);
    if (m) return new Ref(parseInt(m[1], 10), parseInt(m[2], 10));
    return new Str(Buffer.from(v, 'latin1'));
  }
  if (Array.isArray(v)) return v.map(toValue);
  return v;
}

/**
 * Türkçe harfler için kod → glif adı sapmaları.
 *
 * Kodlar Windows-1254'ten gelir; ancak WinAnsi (CP1252) tablosunda o kodlarda
 * Ð/ý/Þ gibi BAŞKA glifler durur. `/Differences` ile doğru glif adlarını
 * bağlamazsak okuyucu "Ağrı" yerine "Aðrý" çizer.
 */
const TURKISH_DIFFERENCES = [
  208, Name.get('Gbreve'), 221, Name.get('Idotaccent'), 222, Name.get('Scedilla'),
  240, Name.get('gbreve'), 253, Name.get('dotlessi'), 254, Name.get('scedilla')
];

/**
 * Sayfaya metin ekler.
 *
 * Standart 14 fontla çalışır (gömme gerektirmez). Kodlama WinAnsi tabanlıdır;
 * Türkçe harfler `/Differences` ile doğru gliflere bağlanır.
 */
function addText(doc, pageIndex, text, options = {}) {
  const size = options.size || 12;
  const color = options.color || [0, 0, 0];
  const baseFont = options.font || 'Helvetica';

  const encoding = new Dict();
  encoding.set('Type', Name.get('Encoding'));
  encoding.set('BaseEncoding', Name.get('WinAnsiEncoding'));
  encoding.set('Differences', TURKISH_DIFFERENCES.slice());

  const fontDict = new Dict();
  fontDict.set('Type', Name.get('Font'));
  fontDict.set('Subtype', Name.get('Type1'));
  fontDict.set('BaseFont', Name.get(baseFont));
  fontDict.set('Encoding', encoding);

  const name = addResource(doc, pageIndex, 'Font', doc.addObject(fontDict), 'F');

  const escaped = encodeWinAnsi(String(text));
  const cmd =
    `BT\n${num(color[0])} ${num(color[1])} ${num(color[2])} rg\n` +
    `/${name} ${num(size)} Tf\n` +
    `1 0 0 1 ${num(options.x || 0)} ${num(options.y || 0)} Tm\n` +
    `(${escaped}) Tj\nET`;

  appendContent(doc, pageIndex, cmd);
  return { fontName: name };
}

/** WinAnsiEncoding'e çevirir ve PDF dizgisi için kaçışlar. */
function encodeWinAnsi(s) {
  const MAP = {
    'Ğ': 0xD0, 'ğ': 0xF0, 'İ': 0xDD, 'ı': 0xFD, 'Ş': 0xDE, 'ş': 0xFE,
    'Ü': 0xDC, 'ü': 0xFC, 'Ö': 0xD6, 'ö': 0xF6, 'Ç': 0xC7, 'ç': 0xE7,
    '€': 0x80, '…': 0x85, '“': 0x93, '”': 0x94, '‘': 0x91, '’': 0x92,
    '–': 0x96, '—': 0x97, '•': 0x95
  };
  let out = '';
  for (const ch of s) {
    let code = MAP[ch];
    if (code === undefined) {
      const cp = ch.codePointAt(0);
      code = cp <= 0xFF ? cp : 0x3F;                      // '?' yedek
    }
    if (code === 0x28) out += '\\(';
    else if (code === 0x29) out += '\\)';
    else if (code === 0x5C) out += '\\\\';
    else if (code < 0x20 || code > 0x7E) out += '\\' + code.toString(8).padStart(3, '0');
    else out += String.fromCharCode(code);
  }
  return out;
}

/** Sayfaya bağlantı açıklaması ekler. */
function addLink(doc, pageIndex, rect, uri) {
  const { ref, dict } = doc.getPage(pageIndex);
  const annot = new Dict();
  annot.set('Type', Name.get('Annot'));
  annot.set('Subtype', Name.get('Link'));
  annot.set('Rect', [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height]);
  annot.set('Border', [0, 0, 0]);

  const action = new Dict();
  action.set('Type', Name.get('Action'));
  action.set('S', Name.get('URI'));
  action.set('URI', new Str(Buffer.from(String(uri), 'latin1')));
  annot.set('A', action);

  const annotRef = doc.addObject(annot);

  const clone = new Dict(new Map(dict.map));
  const annots = doc.resolve(clone.get('Annots'));
  clone.set('Annots', Array.isArray(annots) ? [...annots, annotRef] : [annotRef]);

  doc.setObject(ref.num, clone);
  doc.cache.delete(ref.num);
  return annotRef;
}

/** Belge üst verisini (/Info) günceller. */
function setMetadata(doc, metadata) {
  const infoRef = doc.trailer.get('Info');
  const existing = doc.resolve(infoRef);
  const info = existing instanceof Dict ? new Dict(new Map(existing.map)) : new Dict();

  const FIELDS = {
    title: 'Title', author: 'Author', subject: 'Subject',
    keywords: 'Keywords', creator: 'Creator', producer: 'Producer'
  };

  for (const [key, pdfKey] of Object.entries(FIELDS)) {
    if (metadata[key] === undefined) continue;
    const value = Array.isArray(metadata[key]) ? metadata[key].join(', ') : String(metadata[key]);
    info.set(pdfKey, textString(value));
  }
  info.set('ModDate', require('./lexer').pdfDate(new Date()));

  if (infoRef instanceof Ref) {
    doc.setObject(infoRef.num, info);
  } else {
    const ref = doc.addObject(info);
    doc.trailer.set('Info', ref);
  }
  return doc;
}

/* ------------------------------------------------------------------ */
/* Birleştirme ve bölme                                                 */
/* ------------------------------------------------------------------ */

/**
 * Başka bir belgeden sayfaları bu belgeye kopyalar.
 *
 * Nesneler derin kopyalanır ve numaraları yeniden eşlenir.
 */
function importPages(doc, sourceDoc, pageIndexes = null) {
  const indexes = pageIndexes || sourceDoc.pageRefs.map((_, i) => i);
  const { pagesNum, refs } = flattenPageTree(doc);
  const mapping = new Map();                    // kaynak objNum → hedef Ref

  const copyValue = (value, depth = 0) => {
    if (depth > 64) return null;
    if (value instanceof Ref) {
      const key = value.num;
      if (mapping.has(key)) return mapping.get(key);

      const placeholder = new Ref(doc.allocObjNum(), 0);
      mapping.set(key, placeholder);

      const resolved = sourceDoc.getObject(value.num, value.gen);
      const copied = copyValue(resolved, depth + 1);
      doc.setObject(placeholder.num, copied === undefined ? null : copied);
      return placeholder;
    }
    if (Array.isArray(value)) return value.map((v) => copyValue(v, depth + 1));
    if (value instanceof Stream) {
      // Şifreli kaynakta çözülmüş veriyi al ve filtreleri temizle
      const data = sourceDoc.crypt ? sourceDoc.getStreamData(value) : value.raw;
      const dict = new Dict();
      for (const [k, v] of value.dict.map) {
        if (sourceDoc.crypt && (k === 'Filter' || k === 'DecodeParms' || k === 'Length')) continue;
        dict.set(k, copyValue(v, depth + 1));
      }
      return new Stream(dict, data);
    }
    if (value instanceof Dict) {
      const out = new Dict();
      for (const [k, v] of value.map) out.set(k, copyValue(v, depth + 1));
      return out;
    }
    return value;
  };

  const imported = [];
  for (const idx of indexes) {
    const srcRef = sourceDoc.pageRefs[idx];
    if (!srcRef) continue;

    const srcPage = sourceDoc.resolve(srcRef);
    if (!(srcPage instanceof Dict)) continue;

    // Miras alınan alanları açıkça yaz
    const page = new Dict();
    for (const [k, v] of srcPage.map) {
      if (k === 'Parent') continue;
      page.set(k, copyValue(v));
    }
    for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
      if (!page.has(key)) {
        const inherited = sourceDoc.getPageProperty(srcPage, key);
        if (inherited !== undefined) page.set(key, copyValue(inherited));
      }
    }
    page.set('Type', Name.get('Page'));
    page.set('Parent', new Ref(pagesNum, 0));

    const ref = doc.addObject(page);
    imported.push(ref);
  }

  writePageList(doc, pagesNum, [...refs, ...imported]);
  return imported;
}

function num(n) {
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n * 1000) / 1000);
}

module.exports = {
  EditError,
  flattenPageTree, writePageList,
  removePage, movePage, reorderPages, rotatePage, insertPage,
  appendContent, addResource, addImage, addText, addLink,
  setMetadata, importPages, encodeWinAnsi
};
