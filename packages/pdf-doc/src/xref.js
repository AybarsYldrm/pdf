'use strict';
/**
 * Çapraz başvuru (cross-reference) okuyucu.
 *
 * BU DOSYA, PROJEDEKİ EN BÜYÜK OKUMA BOŞLUĞUNU KAPATIR.
 *
 * Eski `pdf_parser.js` yalnız klasik `xref` tablosunu okuyabiliyordu:
 *
 *     if (str.slice(offset, offset + 4) !== 'xref') return;
 *
 * Oysa PDF 1.5'ten (2003) beri yaygın olan biçim **çapraz başvuru akışı**dır
 * (`/Type /XRef`) ve nesnelerin çoğu **nesne akışları** (`/ObjStm`) içinde
 * sıkıştırılmış durur. Word, Chrome "Yazdır→PDF", LibreOffice ve InDesign
 * çıktılarının çoğu böyledir; bu yüzden "kullanıcı PDF yükleyip imzalasın"
 * senaryosu çalışmıyordu.
 *
 * Burada üç yol da desteklenir:
 *   1. klasik `xref` tablosu + `trailer`
 *   2. `/Type /XRef` akışı (Predictor'lı W dizisi)
 *   3. ikisinin karışımı (hibrit dosyalar, `/XRefStm`)
 * ve hiçbiri okunamazsa tüm dosya taranarak kurtarma yapılır.
 */

const { Lexer, Dict, Ref, Name, Stream, PdfSyntaxError } = require('./lexer');
const { decodeStream } = require('./filters');

/** Bir nesnenin nerede olduğunu anlatan giriş. */
const ENTRY_FREE = 0;        // serbest
const ENTRY_NORMAL = 1;      // dosyada offset'te
const ENTRY_COMPRESSED = 2;  // bir /ObjStm içinde

class XRefError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'XRefError';
    this.code = code;
  }
}

class XRef {
  constructor(buf) {
    this.buf = buf;
    /** @type {Map<number, {type:number, offset?:number, gen?:number, objStm?:number, index?:number}>} */
    this.entries = new Map();
    this.trailer = new Dict();
    this.recovered = false;
    this.sections = [];        // okunan xref bölümlerinin konumları
  }

  /* ---------------------------------------------------------------- */
  /* Genel giriş                                                       */
  /* ---------------------------------------------------------------- */

  static parse(buf) {
    const xref = new XRef(buf);
    try {
      const startxref = xref.findStartXref();
      if (startxref == null) throw new XRefError('ERR_NO_STARTXREF', 'startxref bulunamadı');
      xref.readChain(startxref);
      if (!xref.trailer.has('Root')) throw new XRefError('ERR_NO_ROOT', 'Trailer /Root taşımıyor');
    } catch (err) {
      // Bozuk ya da desteklenmeyen bir yapı: tüm dosyayı tarayarak kurtar.
      xref.recover();
    }
    if (!xref.entries.size) xref.recover();
    return xref;
  }

  /** Dosyanın sonundaki `startxref` değerini bulur. */
  findStartXref() {
    const tailStart = Math.max(0, this.buf.length - 2048);
    const tail = this.buf.toString('latin1', tailStart);
    const idx = tail.lastIndexOf('startxref');
    if (idx < 0) return null;
    const m = /startxref\s+(\d+)/.exec(tail.slice(idx));
    if (!m) return null;
    const value = parseInt(m[1], 10);
    return Number.isFinite(value) && value >= 0 && value < this.buf.length ? value : null;
  }

  /** `/Prev` zincirini izleyerek tüm xref bölümlerini okur (yeniden eskiye). */
  readChain(startOffset) {
    const visited = new Set();
    const queue = [startOffset];

    while (queue.length) {
      const offset = queue.shift();
      if (offset == null || visited.has(offset) || offset < 0 || offset >= this.buf.length) continue;
      visited.add(offset);

      const trailer = this.readSection(offset);
      if (!trailer) continue;
      this.sections.push(offset);

      // Trailer alanları: EN YENİ bölüm kazanır (ilk okunan)
      for (const [k, v] of trailer.map) {
        if (!this.trailer.has(k)) this.trailer.set(k, v);
      }

      // Hibrit dosyalar: klasik tablo + ek xref akışı
      const xrefStm = trailer.get('XRefStm');
      if (typeof xrefStm === 'number') queue.push(xrefStm);

      const prev = trailer.get('Prev');
      if (typeof prev === 'number') queue.push(prev);
    }
  }

  /** Tek bir xref bölümünü okur; trailer sözlüğünü döndürür. */
  readSection(offset) {
    const head = this.buf.toString('latin1', offset, offset + 20);
    if (/^\s*xref/.test(head)) return this.readTable(offset);
    return this.readStream(offset);
  }

  /* ---------------------------------------------------------------- */
  /* Klasik xref tablosu                                               */
  /* ---------------------------------------------------------------- */

  readTable(offset) {
    const lexer = new Lexer(this.buf, offset);
    lexer.skipWhitespace();
    lexer.expectKeyword('xref');

    while (true) {
      lexer.skipWhitespace();
      if (this.buf.toString('latin1', lexer.pos, lexer.pos + 7) === 'trailer') {
        lexer.pos += 7;
        const trailer = lexer.parseObject();
        return trailer instanceof Dict ? trailer : new Dict();
      }

      const startToken = lexer.readToken();
      const countToken = lexer.readToken();
      const start = parseInt(startToken, 10);
      const count = parseInt(countToken, 10);
      if (!Number.isFinite(start) || !Number.isFinite(count)) return new Dict();

      for (let i = 0; i < count; i++) {
        lexer.skipWhitespace();
        const offToken = lexer.readToken();
        const genToken = lexer.readToken();
        const typeToken = lexer.readToken();

        const num = start + i;
        if (this.entries.has(num)) continue;                 // daha yeni bölüm kazandı

        if (typeToken === 'n') {
          this.entries.set(num, {
            type: ENTRY_NORMAL,
            offset: parseInt(offToken, 10),
            gen: parseInt(genToken, 10) || 0
          });
        } else if (typeToken === 'f') {
          this.entries.set(num, { type: ENTRY_FREE });
        } else {
          return new Dict();                                  // bozuk tablo
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Çapraz başvuru akışı (PDF 1.5+)                                   */
  /* ---------------------------------------------------------------- */

  readStream(offset) {
    const lexer = new Lexer(this.buf, offset);
    lexer.skipWhitespace();

    // "N G obj" başlığını geç
    lexer.readToken();
    lexer.readToken();
    const objKeyword = lexer.readToken();
    if (objKeyword !== 'obj') {
      throw new XRefError('ERR_XREF_BAD_SECTION', `xref bölümü tanınmadı (konum ${offset})`);
    }

    const obj = lexer.parseObject();
    if (!(obj instanceof Stream)) {
      throw new XRefError('ERR_XREF_NOT_STREAM', 'Beklenen /Type /XRef akışı bulunamadı');
    }

    const dict = obj.dict;
    const type = dict.get('Type');
    if (type instanceof Name && type.name !== 'XRef') {
      throw new XRefError('ERR_XREF_WRONG_TYPE', `/Type /${type.name} — /XRef bekleniyordu`);
    }

    const { data } = decodeStream(
      obj.raw,
      nameList(dict.get('Filter')),
      plainParms(dict.get('DecodeParms'))
    );

    const w = dict.get('W');
    if (!Array.isArray(w) || w.length < 3) {
      throw new XRefError('ERR_XREF_NO_W', 'XRef akışında /W dizisi yok');
    }
    const [w0, w1, w2] = w.map((n) => Number(n) || 0);
    const rowLength = w0 + w1 + w2;
    if (rowLength <= 0) throw new XRefError('ERR_XREF_BAD_W', '/W dizisi geçersiz');

    const size = Number(dict.get('Size')) || 0;
    let index = dict.get('Index');
    if (!Array.isArray(index) || index.length < 2) index = [0, size];

    let pos = 0;
    for (let s = 0; s + 1 < index.length; s += 2) {
      const start = Number(index[s]);
      const count = Number(index[s + 1]);

      for (let i = 0; i < count; i++) {
        if (pos + rowLength > data.length) break;

        // w0 == 0 ise tip alanı yoktur ve varsayılan 1'dir (ISO 32000-1 §7.5.8.2)
        const f1 = w0 === 0 ? 1 : readField(data, pos, w0);
        const f2 = readField(data, pos + w0, w1);
        const f3 = readField(data, pos + w0 + w1, w2);
        pos += rowLength;

        const num = start + i;
        if (this.entries.has(num)) continue;

        if (f1 === 1) this.entries.set(num, { type: ENTRY_NORMAL, offset: f2, gen: f3 });
        else if (f1 === 2) this.entries.set(num, { type: ENTRY_COMPRESSED, objStm: f2, index: f3 });
        else this.entries.set(num, { type: ENTRY_FREE });
      }
    }

    return dict;
  }

  /* ---------------------------------------------------------------- */
  /* Kurtarma                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Tüm dosyayı tarayarak `N G obj` başlıklarını bulur.
   *
   * Bozuk xref'li dosyalar sahada beklenenden yaygındır (kırpılmış indirmeler,
   * kötü üreticiler). Bu yol, çapraz başvuru tablosuna hiç güvenmez.
   */
  recover() {
    this.recovered = true;
    this.entries.clear();

    const text = this.buf.toString('latin1');
    const re = /(?:^|[\s>])(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const num = parseInt(m[1], 10);
      const gen = parseInt(m[2], 10);
      const offset = m.index + (m[0].length - `${m[1]} ${m[2]} obj`.length);
      // Aynı nesne birden çok kez varsa SON tanım geçerlidir (artımlı güncelleme)
      this.entries.set(num, { type: ENTRY_NORMAL, offset, gen });
    }

    // Trailer'ı bul: en sondaki `trailer` sözlüğü ya da /Type /Catalog nesnesi
    if (!this.trailer.has('Root')) {
      const tIdx = text.lastIndexOf('trailer');
      if (tIdx >= 0) {
        try {
          const lexer = new Lexer(this.buf, tIdx + 7);
          const t = lexer.parseObject();
          if (t instanceof Dict) {
            for (const [k, v] of t.map) if (!this.trailer.has(k)) this.trailer.set(k, v);
          }
        } catch { /* yoksay */ }
      }
    }

    if (!this.trailer.has('Root')) {
      // XRef akışlarının trailer'ı akış sözlüğünün kendisidir
      for (const [num, entry] of this.entries) {
        if (entry.type !== ENTRY_NORMAL) continue;
        try {
          const lexer = new Lexer(this.buf, entry.offset);
          lexer.readToken(); lexer.readToken(); lexer.readToken();
          const obj = lexer.parseObject();
          const dict = obj instanceof Stream ? obj.dict : obj;
          if (dict instanceof Dict && dict.has('Root')) {
            for (const [k, v] of dict.map) if (!this.trailer.has(k)) this.trailer.set(k, v);
            break;
          }
        } catch { /* yoksay */ }
      }
    }

    if (!this.trailer.has('Root')) {
      // Son çare: /Type /Catalog taşıyan nesneyi kök kabul et
      for (const [num, entry] of this.entries) {
        if (entry.type !== ENTRY_NORMAL) continue;
        const snippet = this.buf.toString('latin1', entry.offset, entry.offset + 300);
        if (/\/Type\s*\/Catalog/.test(snippet)) {
          this.trailer.set('Root', new Ref(num, entry.gen || 0));
          break;
        }
      }
    }

    if (!this.trailer.has('Size')) {
      const maxNum = this.entries.size ? Math.max(...this.entries.keys()) : 0;
      this.trailer.set('Size', maxNum + 1);
    }
  }

  /* ---------------------------------------------------------------- */

  get size() {
    const s = Number(this.trailer.get('Size'));
    if (Number.isFinite(s) && s > 0) return s;
    return this.entries.size ? Math.max(...this.entries.keys()) + 1 : 1;
  }

  getEntry(num) { return this.entries.get(num); }
}

/** Big-endian alan okuma; genişlik 0 ise varsayılan 0 döner. */
function readField(buf, pos, width) {
  if (width === 0) return 0;
  let v = 0;
  for (let i = 0; i < width; i++) v = v * 256 + buf[pos + i];
  return v;
}

/** `/Filter` değerini düz ad dizisine çevirir. */
function nameList(value) {
  if (!value) return null;
  if (value instanceof Name) return [value.name];
  if (Array.isArray(value)) return value.map((v) => (v instanceof Name ? v.name : String(v)));
  return [String(value)];
}

/** `/DecodeParms` sözlüğünü düz nesneye çevirir. */
function plainParms(value) {
  const one = (d) => {
    if (!(d instanceof Dict)) return null;
    const out = {};
    for (const [k, v] of d.map) out[k] = v instanceof Name ? v.name : v;
    return out;
  };
  if (!value) return null;
  if (Array.isArray(value)) return value.map(one);
  return one(value);
}

module.exports = {
  XRef, XRefError,
  ENTRY_FREE, ENTRY_NORMAL, ENTRY_COMPRESSED,
  nameList, plainParms
};
