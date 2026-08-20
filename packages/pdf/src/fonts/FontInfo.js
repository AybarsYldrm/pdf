'use strict';
/**
 * Font üst verisi okuyucu — `name`, `OS/2` ve `head` tabloları.
 *
 * NİYE AYRI BİR OKUYUCU: `TtfParser` fontu ÇİZMEK için ayrıştırır (glif
 * verisi, cmap, hmtx). Bir dizindeki elli fontu tarayıp "bunlardan hangisi
 * Ubuntu Bold Italic?" diye sormak için o kadar iş gereksizdir. Burası
 * yalnız kimlik bilgisini okur ve hızlıdır.
 *
 * Ağırlık/eğiklik ÜÇ kaynaktan gelir ve hepsi yalan söyleyebilir:
 *   - `name` tablosundaki alt aile adı ("Bold Italic")
 *   - `OS/2.usWeightClass` (100–900) ve `fsSelection` bitleri
 *   - `head.macStyle` bitleri
 * Üçü çeliştiğinde OS/2 tercih edilir (en açık tanımlı olan odur), sonra
 * macStyle, en son ad. Bunu belirtmek önemli: aksi hâlde aynı dosya farklı
 * çalıştırmalarda farklı ağırlıkta görünebilir.
 */

class FontInfoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FontInfoError';
    this.code = code;
  }
}

/** `name` tablosu kimlikleri (OpenType spec). */
const NAME_ID = {
  family: 1,
  subfamily: 2,
  fullName: 4,
  postScriptName: 6,
  typographicFamily: 16,
  typographicSubfamily: 17
};

/* Bayt okuyucuları — `Buffer` metotlarına DEĞİL, dizin erişimine dayanır.
 * Sebep: bu dosya tarayıcı paketine de girer ve orada girdi düz bir
 * `Uint8Array`dir. `buf.toString('latin1', a, b)` orada anlamsız bir dizge
 * döndürür ve font "adsız" sanılır. */
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const i16 = (b, o) => { const v = u16(b, o); return v & 0x8000 ? v - 0x10000 : v; };
const u32 = (b, o) => (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);

/** Tek baytlık (Latin-1) dizge. */
function latin1(b, start, end) {
  let out = '';
  for (let i = start; i < end && i < b.length; i++) out += String.fromCharCode(b[i]);
  return out;
}

/** UTF-16 BÜYÜK uçlu dizge — OpenType `name` tablosunun kullandığı biçim. */
function utf16be(b, start, end) {
  let out = '';
  for (let i = start; i + 1 < end && i + 1 < b.length; i += 2) {
    out += String.fromCharCode((b[i] << 8) | b[i + 1]);
  }
  return out;
}

/** Tablo dizinini okur. */
function readTableDirectory(buf) {
  if (buf.length < 12) throw new FontInfoError('ERR_FONT_TRUNCATED', 'Font çok kısa');

  const tag = u32(buf, 0);
  // 0x00010000 = TrueType, 'OTTO' = CFF, 'true'/'typ1' = eski Mac
  const known = [0x00010000, 0x4f54544f, 0x74727565, 0x74797031];
  if (tag === 0x74746366) {
    throw new FontInfoError('ERR_FONT_COLLECTION',
      'Font koleksiyonu (.ttc) desteklenmiyor; tek yüz içeren dosya verin');
  }
  if (!known.includes(tag)) {
    throw new FontInfoError('ERR_FONT_FORMAT', 'Tanınmayan font biçimi');
  }

  const numTables = u16(buf, 4);
  if (numTables > 512) throw new FontInfoError('ERR_FONT_MALFORMED', 'Aşırı tablo sayısı');

  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16;
    if (p + 16 > buf.length) break;
    const name = latin1(buf, p, p + 4);
    const offset = u32(buf, p + 8);
    const length = u32(buf, p + 12);
    if (offset + length <= buf.length) tables[name] = { offset, length };
  }
  return { tag, tables };
}

/**
 * `name` tablosundan dizgileri okur.
 *
 * Windows (platform 3) UTF-16BE ve Macintosh (platform 1) Roman kayıtları
 * desteklenir. Windows tercih edilir: pratikte en eksiksiz doldurulan odur.
 */
function readNames(buf, table) {
  const out = {};
  if (!table) return out;

  const base = table.offset;
  if (base + 6 > buf.length) return out;

  const count = u16(buf, base + 2);
  const stringOffset = base + u16(buf, base + 4);

  for (let i = 0; i < count; i++) {
    const rec = base + 6 + i * 12;
    if (rec + 12 > buf.length) break;

    const platformId = u16(buf, rec);
    const encodingId = u16(buf, rec + 2);
    const nameId = u16(buf, rec + 6);
    const length = u16(buf, rec + 8);
    const offset = stringOffset + u16(buf, rec + 10);
    if (offset + length > buf.length) continue;

    // Platform 3 (Windows) ve 0 (Unicode) UTF-16BE; 1 (Macintosh) tek bayt.
    let value;
    if (platformId === 3 || platformId === 0) value = utf16be(buf, offset, offset + length);
    else if (platformId === 1) value = latin1(buf, offset, offset + length);
    else continue;

    value = value.replace(/\0/g, '').trim();
    if (!value) continue;

    // Windows kaydı Mac kaydının üzerine yazar
    const preferred = platformId === 3;
    if (out[nameId] === undefined || preferred) out[nameId] = value;
    void encodingId;
  }
  return out;
}

/** Alt aile adından ağırlık/eğiklik çıkarır (en zayıf kaynak). */
function styleFromName(subfamily) {
  const s = String(subfamily || '').toLowerCase();
  const italic = /italic|oblique|eğik/.test(s);

  let weight = 400;
  if (/thin|hairline/.test(s)) weight = 100;
  else if (/extra ?light|ultra ?light/.test(s)) weight = 200;
  else if (/light/.test(s)) weight = 300;
  else if (/medium/.test(s)) weight = 500;
  else if (/semi ?bold|demi ?bold/.test(s)) weight = 600;
  else if (/extra ?bold|ultra ?bold/.test(s)) weight = 800;
  else if (/black|heavy/.test(s)) weight = 900;
  else if (/bold/.test(s)) weight = 700;

  return { weight, italic };
}

/**
 * Font kimliğini okur.
 *
 * @param {Buffer} buf
 * @returns {{ family:string, subfamily:string, fullName:string,
 *             weight:number, italic:boolean, style:'normal'|'italic',
 *             unitsPerEm:number, ascender:number, descender:number,
 *             format:'truetype'|'cff' }}
 */
function readFontInfo(buf) {
  const { tag, tables } = readTableDirectory(buf);
  const names = readNames(buf, tables.name);

  const family = names[NAME_ID.typographicFamily] || names[NAME_ID.family] || '';
  const subfamily = names[NAME_ID.typographicSubfamily] || names[NAME_ID.subfamily] || '';
  if (!family) {
    throw new FontInfoError('ERR_FONT_NO_NAME', 'Font aile adı okunamadı');
  }

  const fromName = styleFromName(subfamily || names[NAME_ID.fullName]);
  let weight = fromName.weight;
  let italic = fromName.italic;

  // head.macStyle — ada göre daha güvenilir
  const head = tables.head;
  let unitsPerEm = 1000;
  if (head && head.offset + 54 <= buf.length) {
    unitsPerEm = u16(buf, head.offset + 18) || 1000;
    const macStyle = u16(buf, head.offset + 44);
    if (macStyle & 0x01) weight = Math.max(weight, 700);
    if (macStyle & 0x02) italic = true;
  }

  // OS/2 — en açık tanımlı kaynak, sonda uygulanır ki üstün gelsin
  const os2 = tables['OS/2'];
  if (os2 && os2.offset + 64 <= buf.length) {
    const usWeightClass = u16(buf, os2.offset + 4);
    if (usWeightClass >= 1 && usWeightClass <= 1000) {
      // Bazı fontlar 1–9 ölçeğini kullanır; 100–900'e taşı
      weight = usWeightClass <= 9 ? usWeightClass * 100 : usWeightClass;
    }
    const fsSelection = u16(buf, os2.offset + 62);
    if (fsSelection & 0x01) italic = true;         // ITALIC
    if (fsSelection & 0x20) weight = Math.max(weight, 700);  // BOLD
    if (fsSelection & 0x40 && !(fsSelection & 0x21)) {       // REGULAR
      italic = false;
    }
  }

  let ascender = Math.round(unitsPerEm * 0.8);
  let descender = -Math.round(unitsPerEm * 0.2);
  const hhea = tables.hhea;
  if (hhea && hhea.offset + 8 <= buf.length) {
    ascender = i16(buf, hhea.offset + 4);
    descender = i16(buf, hhea.offset + 6);
  }

  return {
    family,
    subfamily: subfamily || 'Regular',
    fullName: names[NAME_ID.fullName] || `${family} ${subfamily}`.trim(),
    postScriptName: names[NAME_ID.postScriptName] || '',
    weight,
    italic,
    style: italic ? 'italic' : 'normal',
    unitsPerEm,
    ascender,
    descender,
    format: tag === 0x4f54544f ? 'cff' : 'truetype'
  };
}

module.exports = { readFontInfo, readTableDirectory, styleFromName, FontInfoError, NAME_ID };
