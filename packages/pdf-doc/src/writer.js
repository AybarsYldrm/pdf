'use strict';
/**
 * Artımlı güncelleme (incremental update) yazıcısı — ISO 32000-1 §7.5.6.
 *
 * DEĞİŞMEZ KURAL: orijinal baytlara DOKUNULMAZ. Değişiklikler dosyanın sonuna
 * yeni bir revizyon olarak eklenir:
 *
 *     [ orijinal bayt dizisi — HİÇ DEĞİŞTİRİLMEZ ]
 *     [ yeni / güncellenmiş nesneler              ]
 *     [ xref  (/Prev → önceki startxref)          ]
 *     [ trailer                                    ]
 *     [ %%EOF                                      ]
 *
 * Bu sayede belgedeki imzaların ByteRange kapsamı bozulmaz ve geçerli kalırlar.
 * İmzalı bir belgeyi tam yeniden yazmak (rewrite) imzayı geçersiz kılacağı için
 * açıkça engellenir.
 *
 * Not — `doc.changes` içine konan akışlar ÇÖZÜLMÜŞ (filtresiz, şifresiz) kabul
 * edilir; sözlüğünde zaten `/Filter` varsa dokunulmadan yazılır.
 */

const zlib = require('zlib');
const { Dict, Ref, Name, Str, Stream, serialize } = require('./lexer');
const { ENTRY_FREE, ENTRY_NORMAL } = require('./xref');

class WriterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WriterError';
    this.code = code;
  }
}

/**
 * Belgedeki değişiklikleri artımlı revizyon olarak yazar.
 *
 * @param {import('./document').PdfDocument} doc
 * @param {{ compress?: boolean }} [opts]
 * @returns {Buffer} orijinal + yeni revizyon
 */
function writeIncremental(doc, opts = {}) {
  const prevStartXref = doc.xref.findStartXref();

  // Bozuk ya da kurtarılmış xref: `/Prev` ile eski tabloya bağlanamayız, çünkü
  // orada güvenilir konumlar yok. Bu durumda TÜM nesneleri kapsayan tam bir
  // tablo yazarız — orijinal baytlara yine dokunulmaz.
  const rebuild = opts.rebuildXref === true
    || prevStartXref == null
    || doc.xref.recovered
    || doc.offsetsRepaired === true
    || (opts.rebuildXref !== false && hasBadOffsets(doc));

  if (!doc.changes.size && !rebuild) return doc.buf;

  // Yazılacak nesneler: değişenler + (yeniden kurma modunda) konumu
  // doğrulanamayan ya da bir /ObjStm içinde yaşayan nesneler.
  const emit = new Map();
  for (const [num, change] of doc.changes) {
    emit.set(num, change.value === undefined ? null : change.value);
  }

  const carried = new Map();          // objNum → { offset, gen } (orijinalde kalır)
  if (rebuild) {
    for (const [num, entry] of doc.xref.entries) {
      if (entry.type === ENTRY_FREE || emit.has(num)) continue;
      const off = entry.type === ENTRY_NORMAL ? doc.offsetOf(num) : null;
      if (off != null) {
        carried.set(num, { offset: off, gen: entry.gen || 0 });
      } else {
        const value = materialize(doc, num);
        if (value != null) emit.set(num, value);
      }
    }
  }

  const parts = [doc.buf];
  let offset = doc.buf.length;

  // Orijinal dosya satır sonuyla bitmiyorsa ayırıcı ekle
  const last = doc.buf.length ? doc.buf[doc.buf.length - 1] : 0x0a;
  if (last !== 0x0a && last !== 0x0d) {
    parts.push(Buffer.from('\n', 'latin1'));
    offset += 1;
  }

  const written = new Map();          // objNum → { offset, gen }

  const push = (data) => {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    parts.push(b);
    offset += b.length;
  };

  // Nesne numarasına göre sırala (okunabilirlik ve tekrarlanabilirlik)
  const nums = [...emit.keys()].sort((a, b) => a - b);

  for (const num of nums) {
    let value = emit.get(num);

    if (doc.crypt && num !== doc.encryptRefNum) {
      value = encryptObject(doc, value, num, 0);
    }

    written.set(num, { offset, gen: 0 });
    push(`${num} 0 obj\n`);

    if (value instanceof Stream) {
      const { dictText, data } = serializeStream(value, opts);
      push(dictText + '\nstream\n');
      push(data);
      push('\nendstream\n');
    } else {
      push(serialize(value) + '\n');
    }
    push('endobj\n');
  }

  // Yeni Size: en büyük nesne numarası + 1
  const maxNum = Math.max(doc.xref.size - 1, doc.nextObjNum - 1, ...nums, 0);
  const size = maxNum + 1;

  const xrefOffset = offset;

  // Klasik xref tablosu: her okuyucu anlar ve imza doğrulayıcıları (Adobe
  // dâhil) artımlı revizyonlarda bu biçimi bekler.
  push(rebuild
    ? buildFullXrefTable(written, carried, size)
    : buildXrefTable(written));

  const trailer = new Dict();
  trailer.set('Size', size);
  trailer.set('Root', doc.trailer.get('Root'));
  if (doc.trailer.has('Info')) trailer.set('Info', doc.trailer.get('Info'));
  if (doc.trailer.has('Encrypt')) trailer.set('Encrypt', doc.trailer.get('Encrypt'));
  if (doc.trailer.has('ID')) trailer.set('ID', doc.trailer.get('ID'));
  if (!rebuild && prevStartXref != null) trailer.set('Prev', prevStartXref);

  push(`trailer\n${serialize(trailer)}\n`);
  push(`startxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(parts);
}

/** xref'teki konumlar gerçekten nesne başlıklarını gösteriyor mu? */
function hasBadOffsets(doc) {
  for (const [num, entry] of doc.xref.entries) {
    if (entry.type !== ENTRY_NORMAL) continue;
    if (!doc._isHeaderAt(entry.offset, num)) return true;
  }
  return false;
}

/**
 * Bir nesneyi yeniden yazılabilir hâle getirir: akışlar çözülür ve filtreleri
 * temizlenir (yazıcı yeniden sıkıştırır / şifreler).
 */
function materialize(doc, num) {
  let value;
  try {
    value = doc.getObject(num);
  } catch {
    return null;
  }
  if (value === null || value === undefined) return null;

  if (value instanceof Stream) {
    let data;
    try {
      data = doc.getStreamData(value, num);
    } catch {
      return null;
    }
    const dict = new Dict(new Map(value.dict.map));
    dict.delete('Filter');
    dict.delete('DecodeParms');
    dict.delete('DP');
    dict.delete('Length');
    return new Stream(dict, data);
  }
  return value;
}

/** Yazılan nesnelerden klasik xref tablosu kurar (bitişik altbölümler hâlinde). */
function buildXrefTable(written) {
  const nums = [...written.keys()].sort((a, b) => a - b);
  const sections = [];

  let current = null;
  for (const num of nums) {
    if (current && num === current.start + current.entries.length) {
      current.entries.push(written.get(num));
    } else {
      current = { start: num, entries: [written.get(num)] };
      sections.push(current);
    }
  }

  let out = 'xref\n';
  for (const section of sections) {
    out += `${section.start} ${section.entries.length}\n`;
    for (const e of section.entries) out += xrefLine(e.offset, e.gen, 'n');
  }
  return out;
}

/**
 * Tüm nesneleri kapsayan tek parçalı xref tablosu.
 * `/Prev` zinciri güvenilmez olduğunda kullanılır.
 */
function buildFullXrefTable(written, carried, size) {
  let out = `xref\n0 ${size}\n${xrefLine(0, 65535, 'f')}`;

  for (let num = 1; num < size; num++) {
    const e = written.get(num) || carried.get(num);
    out += e ? xrefLine(e.offset, e.gen, 'n') : xrefLine(0, 65535, 'f');
  }
  return out;
}

function xrefLine(offset, gen, kind) {
  return `${String(offset).padStart(10, '0')} ${String(gen & 0xffff).padStart(5, '0')} ${kind} \n`;
}

/** Akış sözlüğünü ve (gerekirse sıkıştırılmış) veriyi hazırlar. */
function serializeStream(stream, opts) {
  let data = stream.raw;
  const dict = new Dict(new Map(stream.dict.map));

  // Zaten filtrelenmiş akışlar olduğu gibi yazılır
  const hasFilter = dict.has('Filter');
  if (!hasFilter && opts.compress !== false && data.length > 256) {
    data = zlib.deflateSync(data, { level: 9 });
    dict.set('Filter', Name.get('FlateDecode'));
  }

  dict.set('Length', data.length);
  return { dictText: serialize(dict), data };
}

/**
 * Şifreli belgelerde yeni nesnelerin dizgi/akış içeriklerini şifreler.
 * Nesne kopyalanır; çağıranın verdiği değer değişmez.
 */
function encryptObject(doc, value, num, gen, depth = 0) {
  if (depth > 64) return value;

  if (value instanceof Str) {
    return new Str(doc.crypt.encrypt(value.bytes, num, gen), value.isHex);
  }
  if (Array.isArray(value)) {
    return value.map((v) => encryptObject(doc, v, num, gen, depth + 1));
  }
  if (value instanceof Stream) {
    const dict = new Dict();
    for (const [k, v] of value.dict.map) {
      dict.set(k, k === 'Length' ? v : encryptObject(doc, v, num, gen, depth + 1));
    }
    // Sıkıştırma şifrelemeden ÖNCE yapılmalı
    let data = value.raw;
    if (!dict.has('Filter') && data.length > 256) {
      data = zlib.deflateSync(data, { level: 9 });
      dict.set('Filter', Name.get('FlateDecode'));
    }
    return new Stream(dict, doc.crypt.encrypt(data, num, gen));
  }
  if (value instanceof Dict) {
    const out = new Dict();
    for (const [k, v] of value.map) out.set(k, encryptObject(doc, v, num, gen, depth + 1));
    return out;
  }
  return value;
}

/**
 * Belgeyi TAM olarak yeniden yazar (artımlı değil).
 *
 * Yalnız imzasız belgelerde kullanılabilir: tam yeniden yazım, mevcut
 * imzaların kapsadığı baytları değiştireceği için imzaları geçersiz kılar.
 * Çıktı her zaman ŞİFRESİZDİR.
 */
function writeFull(doc, opts = {}) {
  if (doc.hasSignatures && !opts.force) {
    throw new WriterError('ERR_WOULD_BREAK_SIGNATURE',
      'Bu belge imzalı: tam yeniden yazım imzaları geçersiz kılar. ' +
      'Artımlı kaydetme kullanın (save() varsayılanı) ya da force:true verin.');
  }

  const parts = [];
  let offset = 0;
  const written = new Map();

  const push = (data) => {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    parts.push(b);
    offset += b.length;
  };

  push('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');

  // Tüm canlı nesneleri topla
  const nums = new Set();
  for (const [num, entry] of doc.xref.entries) {
    if (entry.type !== ENTRY_FREE) nums.add(num);
  }
  for (const num of doc.changes.keys()) nums.add(num);
  if (doc.encryptRefNum != null) nums.delete(doc.encryptRefNum);

  for (const num of [...nums].sort((a, b) => a - b)) {
    const value = doc.changes.has(num) ? doc.changes.get(num).value : doc.getObject(num);
    if (value === null || value === undefined) continue;

    written.set(num, { offset, gen: 0 });
    push(`${num} 0 obj\n`);

    if (value instanceof Stream) {
      // Şifreli belgede ham veri çözülmüş hâle getirilir
      const fromDoc = !doc.changes.has(num);
      const decoded = fromDoc ? doc.getStreamData(value, num) : value.raw;
      const dict = new Dict(new Map(value.dict.map));
      if (fromDoc) {                                  // yeniden sıkıştırılacak
        dict.delete('Filter');
        dict.delete('DecodeParms');
        dict.delete('DP');
      }
      const clone = new Stream(dict, decoded);
      const { dictText, data } = serializeStream(clone, opts);
      push(dictText + '\nstream\n');
      push(data);
      push('\nendstream\n');
    } else {
      push(serialize(value) + '\n');
    }
    push('endobj\n');
  }

  const maxNum = written.size ? Math.max(...written.keys()) : 0;
  const size = maxNum + 1;
  const xrefOffset = offset;

  let xref = `xref\n0 ${size}\n${xrefLine(0, 65535, 'f')}`;
  for (let i = 1; i < size; i++) {
    const e = written.get(i);
    xref += e ? xrefLine(e.offset, e.gen, 'n') : xrefLine(0, 65535, 'f');
  }
  push(xref);

  const trailer = new Dict();
  trailer.set('Size', size);
  trailer.set('Root', doc.trailer.get('Root'));
  if (doc.trailer.has('Info')) trailer.set('Info', doc.trailer.get('Info'));
  if (doc.trailer.has('ID')) trailer.set('ID', doc.trailer.get('ID'));
  // Şifreleme taşınmaz: çıktı şifresizdir
  push(`trailer\n${serialize(trailer)}\n`);
  push(`startxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(parts);
}

module.exports = {
  writeIncremental, writeFull, WriterError,
  buildXrefTable, buildFullXrefTable, serializeStream
};
