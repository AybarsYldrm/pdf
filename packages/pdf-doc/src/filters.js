'use strict';
/**
 * PDF akış filtreleri (ISO 32000-1 §7.4).
 *
 * Bir stream'in ham baytları `/Filter` zinciriyle kodlanmıştır; okumak için
 * ters sırada çözmek gerekir. `/DecodeParms` her filtreye özel parametre taşır.
 */

const zlib = require('zlib');

class FilterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FilterError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Predictor (PNG ve TIFF)                                             */
/* ------------------------------------------------------------------ */

/**
 * Predictor uygulanmış veriyi geri çözer.
 *
 * Predictor 2  → TIFF yatay fark
 * Predictor 10+ → PNG satır filtreleri (None/Sub/Up/Average/Paeth)
 *
 * XRef stream'leri neredeyse her zaman Predictor 12 kullanır; bu yüzden bu
 * fonksiyon olmadan modern PDF'lerin çapraz başvuru tablosu okunamaz.
 */
function applyPredictor(data, params) {
  const predictor = params.Predictor || 1;
  if (predictor <= 1) return data;

  const colors = params.Colors || 1;
  const bpc = params.BitsPerComponent || 8;
  const columns = params.Columns || 1;
  const bpp = Math.ceil((colors * bpc) / 8);          // piksel başına bayt
  const rowLength = Math.ceil((colors * bpc * columns) / 8);

  if (predictor === 2) {
    if (bpc !== 8) {
      throw new FilterError('ERR_PREDICTOR_BPC',
        `TIFF predictor yalnız 8 bit bileşen ile destekleniyor (gelen: ${bpc})`);
    }
    const out = Buffer.from(data);
    for (let row = 0; row + rowLength <= out.length; row += rowLength) {
      for (let i = bpp; i < rowLength; i++) {
        out[row + i] = (out[row + i] + out[row + i - bpp]) & 0xff;
      }
    }
    return out;
  }

  // PNG predictor: her satırın başında 1 baytlık filtre tipi vardır
  const rows = Math.floor(data.length / (rowLength + 1));
  const out = Buffer.alloc(rows * rowLength);
  let prev = Buffer.alloc(rowLength);

  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLength + 1)];
    const src = data.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1));
    const cur = Buffer.alloc(rowLength);

    for (let i = 0; i < rowLength; i++) {
      const raw = src[i] || 0;
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;

      switch (type) {
        case 0: cur[i] = raw; break;                                   // None
        case 1: cur[i] = (raw + left) & 0xff; break;                   // Sub
        case 2: cur[i] = (raw + up) & 0xff; break;                     // Up
        case 3: cur[i] = (raw + ((left + up) >> 1)) & 0xff; break;     // Average
        case 4: cur[i] = (raw + paeth(left, up, upLeft)) & 0xff; break; // Paeth
        default:
          throw new FilterError('ERR_PREDICTOR_TYPE',
            `Bilinmeyen PNG predictor satır tipi: ${type}`);
      }
    }
    cur.copy(out, r * rowLength);
    prev = cur;
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/* ------------------------------------------------------------------ */
/* Filtreler                                                            */
/* ------------------------------------------------------------------ */

function flateDecode(data, params) {
  let out;
  try {
    out = zlib.inflateSync(data);
  } catch (err) {
    // Bozuk/kırpılmış akışlar sahada yaygın: elde edilebileni kurtarmayı dene.
    try {
      out = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch {
      try {
        out = zlib.inflateRawSync(data.subarray(1), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      } catch {
        throw new FilterError('ERR_FLATE', `FlateDecode çözülemedi: ${err.message}`);
      }
    }
  }
  return params ? applyPredictor(out, params) : out;
}

function lzwDecode(data, params) {
  const earlyChange = params && params.EarlyChange === 0 ? 0 : 1;

  const out = [];
  let dict = [];
  const resetDict = () => {
    dict = new Array(256);
    for (let i = 0; i < 256; i++) dict[i] = [i];
    dict.length = 258;                     // 256 = clear, 257 = EOD
  };
  resetDict();

  let codeWidth = 9;
  let prev = null;
  let bitBuffer = 0;
  let bitCount = 0;

  for (let i = 0; i < data.length; i++) {
    bitBuffer = (bitBuffer << 8) | data[i];
    bitCount += 8;

    while (bitCount >= codeWidth) {
      const code = (bitBuffer >> (bitCount - codeWidth)) & ((1 << codeWidth) - 1);
      bitCount -= codeWidth;

      if (code === 256) {                  // clear table
        resetDict();
        codeWidth = 9;
        prev = null;
        continue;
      }
      if (code === 257) {                  // end of data
        bitCount = 0;
        i = data.length;
        break;
      }

      let entry;
      if (code < dict.length && dict[code]) {
        entry = dict[code];
      } else if (prev) {
        entry = prev.concat([prev[0]]);
      } else {
        throw new FilterError('ERR_LZW', 'LZW akışı bozuk (geçersiz kod)');
      }

      out.push(...entry);
      if (prev) dict.push(prev.concat([entry[0]]));
      prev = entry;

      if (dict.length + earlyChange >= (1 << codeWidth) && codeWidth < 12) codeWidth++;
    }
  }

  const buf = Buffer.from(out);
  return params ? applyPredictor(buf, params) : buf;
}

function ascii85Decode(data) {
  const out = [];
  let tuple = 0;
  let count = 0;

  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7E) break;                                   // '~' → EOD
    if (c === 0x20 || c === 0x0A || c === 0x0D || c === 0x09 || c === 0x0C || c === 0x00) continue;

    if (c === 0x7A && count === 0) {                         // 'z' → 4 sıfır bayt
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) {
      throw new FilterError('ERR_ASCII85', `ASCII85 dışı karakter: 0x${c.toString(16)}`);
    }

    tuple = tuple * 85 + (c - 0x21);
    if (++count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
    }
  }

  if (count > 0) {
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    out.push(...bytes.slice(0, count - 1));
  }
  return Buffer.from(out);
}

function asciiHexDecode(data) {
  const out = [];
  let hi = -1;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x3E) break;                                   // '>' → EOD
    const v = hexVal(c);
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else { out.push((hi << 4) | v); hi = -1; }
  }
  if (hi >= 0) out.push(hi << 4);                            // tek kalan yarım bayt
  return Buffer.from(out);
}

function hexVal(c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

function runLengthDecode(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const n = data[i++];
    if (n === 128) break;                                    // EOD
    if (n < 128) {
      for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++]);
    } else {
      const b = data[i++];
      for (let k = 0; k < 257 - n; k++) out.push(b);
    }
  }
  return Buffer.from(out);
}

/** Görüntü filtreleri: çözülmez, olduğu gibi geçirilir. */
const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode', 'CCF']);

const DECODERS = {
  FlateDecode: flateDecode, Fl: flateDecode,
  LZWDecode: lzwDecode, LZW: lzwDecode,
  ASCII85Decode: ascii85Decode, A85: ascii85Decode,
  ASCIIHexDecode: asciiHexDecode, AHx: asciiHexDecode,
  RunLengthDecode: runLengthDecode, RL: runLengthDecode,
  Crypt: (data) => data
};

/**
 * Bir stream'in filtre zincirini çözer.
 *
 * @param {Buffer} data ham stream baytları
 * @param {string|string[]|null} filters `/Filter` değeri
 * @param {Object|Object[]|null} parms `/DecodeParms` değeri
 * @returns {{ data: Buffer, imageFilter: string|null }}
 *   Görüntü filtresine gelindiğinde çözme durur; kalan veri kodlanmış hâliyle
 *   döner ve hangi filtrede durulduğu bildirilir (JPEG'i yeniden kodlamayız).
 */
function decodeStream(data, filters, parms) {
  if (!filters) return { data, imageFilter: null };

  const list = Array.isArray(filters) ? filters : [filters];
  const parmList = Array.isArray(parms) ? parms : [parms];

  let out = data;
  for (let i = 0; i < list.length; i++) {
    const name = String(list[i] || '');
    if (IMAGE_FILTERS.has(name)) return { data: out, imageFilter: name };

    const decoder = DECODERS[name];
    if (!decoder) {
      throw new FilterError('ERR_UNKNOWN_FILTER', `Desteklenmeyen filtre: ${name}`);
    }
    out = decoder(out, parmList[i] || null);
  }
  return { data: out, imageFilter: null };
}

module.exports = {
  FilterError,
  decodeStream,
  applyPredictor,
  flateDecode,
  lzwDecode,
  ascii85Decode,
  asciiHexDecode,
  runLengthDecode,
  IMAGE_FILTERS
};
