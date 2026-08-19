'use strict';
/**
 * PDF nesne çözümleyici (ISO 32000-1 §7.3).
 *
 * Mevcut `pdf_parser.js` PDF'i bir metin gibi görüp regex'le arıyordu; bu,
 * imzalama için yeterliydi ama genel bir belge modeli kurmaya elverişli değil.
 * Burada gerçek bir sözcüksel çözümleyici var: sözlükler, diziler, adlar,
 * dizgiler (literal + onaltılık), sayılar, referanslar ve akışlar.
 *
 * Nesne tipleri JavaScript'e şöyle eşlenir:
 *   null       → null
 *   boolean    → boolean
 *   sayı       → number
 *   ad (/Name) → { name: 'Name' }        (Name sınıfı)
 *   dizgi      → { str: Buffer }         (Str sınıfı — ikili veri korunur)
 *   dizi       → Array
 *   sözlük     → Map benzeri Dict
 *   referans   → { num, gen }            (Ref sınıfı)
 *   akış       → Stream (dict + ham baytlar)
 */

class PdfSyntaxError extends Error {
  constructor(message, offset) {
    super(offset != null ? `${message} (konum ${offset})` : message);
    this.name = 'PdfSyntaxError';
    this.code = 'ERR_PDF_SYNTAX';
    this.offset = offset;
  }
}

class Name {
  constructor(name) { this.name = name; }
  toString() { return '/' + this.name; }
}
const nameCache = new Map();
Name.get = (n) => {
  let v = nameCache.get(n);
  if (!v) { v = new Name(n); nameCache.set(n, v); }
  return v;
};

class Ref {
  constructor(num, gen) { this.num = num; this.gen = gen || 0; }
  toString() { return `${this.num} ${this.gen} R`; }
  get key() { return `${this.num}_${this.gen}`; }
}

class Str {
  constructor(bytes, isHex) { this.bytes = bytes; this.isHex = !!isHex; }
  toString() { return this.bytes.toString('latin1'); }
  /** PDF metin dizgisi olarak çözer (UTF-16BE BOM'lu ya da PDFDocEncoding). */
  toText() {
    const b = this.bytes;
    if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) {
      return Buffer.from(b.subarray(2)).swap16().toString('utf16le');
    }
    if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
      return b.subarray(3).toString('utf8');
    }
    return b.toString('latin1');
  }
}

class Dict {
  constructor(map) { this.map = map || new Map(); }
  get(key) { return this.map.get(key); }
  has(key) { return this.map.has(key); }
  set(key, value) { this.map.set(key, value); return this; }
  delete(key) { return this.map.delete(key); }
  get size() { return this.map.size; }
  keys() { return this.map.keys(); }
  entries() { return this.map.entries(); }
  [Symbol.iterator]() { return this.map[Symbol.iterator](); }
}

class Stream {
  /**
   * @param {Dict} dict
   * @param {Buffer} raw ham (kodlanmış) baytlar
   */
  constructor(dict, raw) { this.dict = dict; this.raw = raw; }
}

/* ------------------------------------------------------------------ */
/* Karakter sınıfları                                                   */
/* ------------------------------------------------------------------ */

const WHITESPACE = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0A, 0x0C, 0x0D, 0x20]) WHITESPACE[c] = 1;

const DELIMITER = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIMITER[c.charCodeAt(0)] = 1;

const isWs = (c) => WHITESPACE[c] === 1;
const isDelim = (c) => DELIMITER[c] === 1;
const isRegular = (c) => c !== undefined && !isWs(c) && !isDelim(c);

/* ------------------------------------------------------------------ */
/* Lexer                                                                */
/* ------------------------------------------------------------------ */

class Lexer {
  /**
   * @param {Buffer} buf
   * @param {number} [pos]
   * @param {Object} [opts] { resolveLength: (obj) => number|null }
   */
  constructor(buf, pos = 0, opts = {}) {
    this.buf = buf;
    this.pos = pos;
    this.opts = opts;
  }

  /** Boşluk ve yorumları atlar. */
  skipWhitespace() {
    const { buf } = this;
    while (this.pos < buf.length) {
      const c = buf[this.pos];
      if (isWs(c)) { this.pos++; continue; }
      if (c === 0x25) {                        // '%' yorum
        while (this.pos < buf.length && buf[this.pos] !== 0x0A && buf[this.pos] !== 0x0D) this.pos++;
        continue;
      }
      break;
    }
  }

  /** Sonraki belirteci (token) düz metin olarak okur. */
  readToken() {
    this.skipWhitespace();
    const start = this.pos;
    while (this.pos < this.buf.length && isRegular(this.buf[this.pos])) this.pos++;
    if (this.pos === start) this.pos++;        // ilerleme garantisi
    return this.buf.toString('latin1', start, this.pos);
  }

  /** Verilen anahtar sözcüğü bekler. */
  expectKeyword(word) {
    this.skipWhitespace();
    if (this.buf.toString('latin1', this.pos, this.pos + word.length) !== word) {
      throw new PdfSyntaxError(`'${word}' bekleniyordu`, this.pos);
    }
    this.pos += word.length;
  }

  /** Sonraki nesneyi çözer. */
  parseObject(depth = 0) {
    if (depth > 64) throw new PdfSyntaxError('Nesne yuvalanması çok derin', this.pos);
    this.skipWhitespace();
    if (this.pos >= this.buf.length) throw new PdfSyntaxError('Beklenmeyen veri sonu', this.pos);

    const { buf } = this;
    const c = buf[this.pos];

    if (c === 0x2F) return this.parseName();                      // /
    if (c === 0x28) return this.parseLiteralString();             // (
    if (c === 0x5B) return this.parseArray(depth);                // [
    if (c === 0x3C) {
      if (buf[this.pos + 1] === 0x3C) return this.parseDictOrStream(depth);   // <<
      return this.parseHexString();                                            // <
    }
    if (c === 0x5D || c === 0x3E) {                               // ] veya >
      throw new PdfSyntaxError('Beklenmeyen kapanış', this.pos);
    }

    // Sayı, boolean, null, referans ya da operatör
    const save = this.pos;
    const token = this.readToken();

    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;

    if (/^[+-]?[\d.]+$/.test(token)) {
      const value = parseFloat(token);
      // "N G R" dizisi bir referanstır
      if (Number.isInteger(value) && value >= 0) {
        const after = this.pos;
        this.skipWhitespace();
        const genStart = this.pos;
        const genToken = this.readToken();
        if (/^\d+$/.test(genToken)) {
          this.skipWhitespace();
          const rStart = this.pos;
          const rToken = this.readToken();
          if (rToken === 'R') return new Ref(value, parseInt(genToken, 10));
          this.pos = rStart;
        }
        this.pos = after;
      }
      return Number.isNaN(value) ? 0 : value;
    }

    // Tanınmayan belirteç: içerik akışı operatörü olabilir
    if (!token) { this.pos = save + 1; return null; }
    return { operator: token };
  }

  parseName() {
    this.pos++;                                                   // '/'
    const { buf } = this;
    let out = '';
    while (this.pos < buf.length && isRegular(buf[this.pos])) {
      let ch = buf[this.pos++];
      if (ch === 0x23 && this.pos + 1 < buf.length) {             // '#' kaçış
        const hex = buf.toString('latin1', this.pos, this.pos + 2);
        const v = parseInt(hex, 16);
        if (!Number.isNaN(v)) { ch = v; this.pos += 2; }
      }
      out += String.fromCharCode(ch);
    }
    return Name.get(out);
  }

  parseLiteralString() {
    this.pos++;                                                   // '('
    const { buf } = this;
    const out = [];
    let depth = 1;

    while (this.pos < buf.length) {
      let c = buf[this.pos++];

      if (c === 0x5C) {                                           // '\' kaçış
        const e = buf[this.pos++];
        switch (e) {
          case 0x6E: out.push(0x0A); break;                       // \n
          case 0x72: out.push(0x0D); break;                       // \r
          case 0x74: out.push(0x09); break;                       // \t
          case 0x62: out.push(0x08); break;                       // \b
          case 0x66: out.push(0x0C); break;                       // \f
          case 0x28: out.push(0x28); break;
          case 0x29: out.push(0x29); break;
          case 0x5C: out.push(0x5C); break;
          case 0x0A: break;                                       // satır devamı
          case 0x0D: if (buf[this.pos] === 0x0A) this.pos++; break;
          default:
            if (e >= 0x30 && e <= 0x37) {                         // sekizlik
              let oct = e - 0x30;
              for (let i = 0; i < 2; i++) {
                const n = buf[this.pos];
                if (n >= 0x30 && n <= 0x37) { oct = oct * 8 + (n - 0x30); this.pos++; }
                else break;
              }
              out.push(oct & 0xff);
            } else {
              out.push(e);
            }
        }
        continue;
      }

      if (c === 0x28) { depth++; out.push(c); continue; }
      if (c === 0x29) {
        depth--;
        if (depth === 0) break;
        out.push(c);
        continue;
      }
      out.push(c);
    }
    return new Str(Buffer.from(out), false);
  }

  parseHexString() {
    this.pos++;                                                   // '<'
    const { buf } = this;
    const out = [];
    let hi = -1;

    while (this.pos < buf.length) {
      const c = buf[this.pos++];
      if (c === 0x3E) break;                                      // '>'
      const v = hexDigit(c);
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else { out.push((hi << 4) | v); hi = -1; }
    }
    if (hi >= 0) out.push(hi << 4);
    return new Str(Buffer.from(out), true);
  }

  parseArray(depth) {
    this.pos++;                                                   // '['
    const arr = [];
    while (true) {
      this.skipWhitespace();
      if (this.pos >= this.buf.length) throw new PdfSyntaxError('Dizi kapanmadı', this.pos);
      if (this.buf[this.pos] === 0x5D) { this.pos++; break; }      // ']'
      const before = this.pos;
      const item = this.parseObject(depth + 1);
      if (this.pos === before) { this.pos++; continue; }           // takılmayı önle
      if (item && item.operator) continue;                        // çöp belirteç
      arr.push(item);
    }
    return arr;
  }

  parseDictOrStream(depth) {
    this.pos += 2;                                                // '<<'
    const map = new Map();

    while (true) {
      this.skipWhitespace();
      if (this.pos >= this.buf.length) throw new PdfSyntaxError('Sözlük kapanmadı', this.pos);
      if (this.buf[this.pos] === 0x3E && this.buf[this.pos + 1] === 0x3E) { this.pos += 2; break; }
      if (this.buf[this.pos] !== 0x2F) {                           // beklenmeyen: atla
        const before = this.pos;
        this.parseObject(depth + 1);
        if (this.pos === before) this.pos++;
        continue;
      }
      const key = this.parseName().name;
      const value = this.parseObject(depth + 1);
      map.set(key, value);
    }

    const dict = new Dict(map);

    // 'stream' anahtar sözcüğü geliyorsa bu bir akıştır
    const save = this.pos;
    this.skipWhitespace();
    if (this.buf.toString('latin1', this.pos, this.pos + 6) === 'stream') {
      this.pos += 6;
      if (this.buf[this.pos] === 0x0D) this.pos++;
      if (this.buf[this.pos] === 0x0A) this.pos++;

      const start = this.pos;
      let length = dict.get('Length');
      if (length instanceof Ref && this.opts.resolveLength) {
        length = this.opts.resolveLength(length);
      }

      let end;
      if (typeof length === 'number' && length >= 0 && start + length <= this.buf.length) {
        end = start + length;
        // /Length yanlışsa (sahada sık) 'endstream'i arayarak düzelt
        const check = this.buf.toString('latin1', end, end + 20);
        if (!/^\s*endstream/.test(check)) {
          const found = findEndstream(this.buf, start);
          if (found >= 0) end = found;
        }
      } else {
        const found = findEndstream(this.buf, start);
        if (found < 0) throw new PdfSyntaxError('endstream bulunamadı', start);
        end = found;
      }

      const raw = this.buf.subarray(start, end);
      this.pos = end;
      this.skipWhitespace();
      if (this.buf.toString('latin1', this.pos, this.pos + 9) === 'endstream') this.pos += 9;

      return new Stream(dict, raw);
    }

    this.pos = save;
    return dict;
  }
}

/** `endstream` konumunu bulur; öncesindeki satır sonunu kırpar. */
function findEndstream(buf, from) {
  const idx = buf.indexOf('endstream', from, 'latin1');
  if (idx < 0) return -1;
  let end = idx;
  if (end > from && buf[end - 1] === 0x0A) end--;
  if (end > from && buf[end - 1] === 0x0D) end--;
  return end;
}

function hexDigit(c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

/* ------------------------------------------------------------------ */
/* Serileştirme                                                         */
/* ------------------------------------------------------------------ */

/** Bir JS nesnesini PDF sözdizimine çevirir. */
function serialize(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (typeof obj === 'number') return formatNumber(obj);
  if (obj instanceof Name) return '/' + escapeName(obj.name);
  if (obj instanceof Ref) return `${obj.num} ${obj.gen} R`;
  if (obj instanceof Str) return serializeString(obj);
  if (Array.isArray(obj)) return '[' + obj.map(serialize).join(' ') + ']';
  if (obj instanceof Dict) {
    const parts = [];
    for (const [k, v] of obj.map) parts.push('/' + escapeName(k) + ' ' + serialize(v));
    return '<< ' + parts.join(' ') + ' >>';
  }
  if (obj instanceof Stream) return serialize(obj.dict);
  if (typeof obj === 'string') return '/' + escapeName(obj);
  throw new PdfSyntaxError('Serileştirilemeyen değer: ' + typeof obj);
}

function formatNumber(n) {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1e6) / 1e6);
}

function escapeName(name) {
  return String(name).replace(/[^\x21-\x7E]|[#()<>[\]{}/%]/g, (c) =>
    '#' + c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase());
}

function serializeString(s) {
  if (s.isHex) return '<' + s.bytes.toString('hex').toUpperCase() + '>';
  let out = '(';
  for (const b of s.bytes) {
    if (b === 0x28) out += '\\(';
    else if (b === 0x29) out += '\\)';
    else if (b === 0x5C) out += '\\\\';
    else if (b === 0x0D) out += '\\r';
    else if (b < 0x20 || b > 0x7E) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out + ')';
}

/** PDF tarih dizgisi üretir. */
function pdfDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return new Str(Buffer.from(
    `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`, 'latin1'));
}

/** UTF-16BE BOM'lu metin dizgisi (Türkçe karakterler için). */
function textString(s) {
  const utf16 = Buffer.from(String(s), 'utf16le').swap16();
  return new Str(Buffer.concat([Buffer.from([0xFE, 0xFF]), utf16]), true);
}

module.exports = {
  Lexer, PdfSyntaxError,
  Name, Ref, Str, Dict, Stream,
  serialize, pdfDate, textString,
  isWs, isDelim, isRegular, findEndstream
};
