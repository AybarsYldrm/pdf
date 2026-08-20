'use strict';
/**
 * PDF görsel XObject'i → sahne varlığı (PNG ya da JPEG).
 *
 * PDF'te görsel "dosya" değildir: örnek dizisi + renk uzayı + bit derinliği
 * + isteğe bağlı maskedir. Sahne ise varlıkları GERÇEK dosya baytı olarak
 * tutar (SHA-256 ile tekilleştirilir, tarayıcıda gösterilir, yeniden gömülür).
 * Bu dosya iki dünya arasındaki çeviridir.
 *
 * NE ÇEVRİLİR:
 *   - DCTDecode (JPEG): baytlar OLDUĞU GİBİ alınır. Yeniden kodlamak, kayıplı
 *     bir görüntüyü ikinci kez kaybettirmek olurdu.
 *   - Flate/LZW ile sıkıştırılmış 8 bitlik DeviceRGB / DeviceGray / Indexed
 *     örnekler: PNG olarak yeniden kodlanır (kayıpsız).
 *   - `/SMask` varsa alfa kanalı olarak PNG'ye katılır: saydam logolar
 *     kenarlarında beyaz kutu ile görünmesin.
 *
 * NE ÇEVRİLMEZ (ve neden sessiz kalınmaz):
 *   - JPXDecode (JPEG 2000), JBIG2Decode, CCITTFaxDecode: bu çözücüleri
 *     yazmak ayrı birer projedir. Bilinmeyen bir görseli "boş kutu" olarak
 *     yerleştirmek yerine düğüm hiç üretilmez ve uyarı verilir.
 *   - `/ImageMask` (stencil): renk bilgisi taşımaz, o anki dolgu rengiyle
 *     boyanır. Bunu bağımsız bir varlığa çevirmek yanlış renk üretirdi.
 *   - DeviceN, Separation, ICCBased(N≠1,3), Lab: renk dönüşümü profil
 *     gerektirir. ICCBased yalnız bileşen sayısına göre (1=gri, 3=RGB)
 *     yaklaşık alınır ve bu bildirilir.
 */

const zlib = require('zlib');

class PdfImageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PdfImageError';
    this.code = code;
  }
}

/** Tek görselde izin verilen en büyük piksel sayısı (sıkıştırma bombası). */
const MAX_PIXELS = 40_000_000;

/* ------------------------------------------------------------------ */
/* PNG yazımı                                                          */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Ham örneklerden PNG kurar.
 *
 * @param {{width:number, height:number, colorType:number, bitDepth:number,
 *          samples:Buffer, palette?:Buffer}} img
 * @returns {Buffer}
 */
function writePng(img) {
  const { width, height, colorType, bitDepth, samples } = img;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);

  // PNG her satırın başına bir süzgeç baytı ister. Süzgeç 0 (None) seçildi:
  // amaç en küçük dosya değil, doğru dosya.
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0;
    samples.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;

  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr)
  ];
  if (colorType === 3) parts.push(chunk('PLTE', img.palette));
  parts.push(chunk('IDAT', zlib.deflateSync(raw, { level: 6 })));
  parts.push(chunk('IEND', Buffer.alloc(0)));

  return Buffer.concat(parts);
}

/* ------------------------------------------------------------------ */
/* Renk uzayı                                                          */
/* ------------------------------------------------------------------ */

/**
 * Renk uzayını çözer.
 *
 * @returns {{ kind:'gray'|'rgb'|'cmyk'|'indexed', components:number,
 *             palette?:Buffer, base?:Object, hiVal?:number, approx?:string }}
 */
function resolveColorSpace(doc, cs, depth = 0) {
  if (depth > 8) throw new PdfImageError('ERR_IMG_CS_DEPTH', 'Renk uzayı çok derin');
  const value = doc.resolve(cs);

  if (value && value.name) {
    switch (value.name) {
      case 'DeviceGray': case 'G': case 'CalGray': return { kind: 'gray', components: 1 };
      case 'DeviceRGB': case 'RGB': case 'CalRGB': return { kind: 'rgb', components: 3 };
      case 'DeviceCMYK': case 'CMYK': return { kind: 'cmyk', components: 4 };
      default:
        throw new PdfImageError('ERR_IMG_COLORSPACE', `Renk uzayı desteklenmiyor: ${value.name}`);
    }
  }

  if (Array.isArray(value) && value.length) {
    const family = doc.resolve(value[0]);
    const name = family && family.name;

    if (name === 'ICCBased') {
      const stream = doc.resolve(value[1]);
      const n = stream && stream.dict ? Number(doc.get(stream.dict, 'N')) : 0;
      if (n === 1) return { kind: 'gray', components: 1, approx: 'ICCBased(1)→gri' };
      if (n === 3) return { kind: 'rgb', components: 3, approx: 'ICCBased(3)→sRGB' };
      if (n === 4) return { kind: 'cmyk', components: 4, approx: 'ICCBased(4)→CMYK' };
      throw new PdfImageError('ERR_IMG_COLORSPACE', `ICCBased/${n} desteklenmiyor`);
    }

    if (name === 'Indexed' || name === 'I') {
      const base = resolveColorSpace(doc, value[1], depth + 1);
      const hiVal = Number(doc.resolve(value[2])) || 0;
      let table = doc.resolve(value[3]);
      if (table && table.dict) table = doc.getStreamData(table);
      else if (table && table.bytes) table = Buffer.from(table.bytes);
      else if (typeof table === 'string') table = Buffer.from(table, 'latin1');
      if (!Buffer.isBuffer(table)) {
        throw new PdfImageError('ERR_IMG_PALETTE', 'Renk tablosu okunamadı');
      }
      return { kind: 'indexed', components: 1, base, hiVal, table };
    }

    // DeviceN / Separation: dönüşüm işlevi (tint transform) çalıştırmayı
    // gerektirir. İşlev yorumlayıcısı yazmadan bunu tahmin etmek, yanlış
    // renk üretmektir.
    throw new PdfImageError('ERR_IMG_COLORSPACE',
      `Renk uzayı desteklenmiyor: ${name || 'bilinmeyen'}`);
  }

  throw new PdfImageError('ERR_IMG_COLORSPACE', 'Renk uzayı okunamadı');
}

/** CMYK → RGB (basit, profilsiz). Kesin renk için ICC gerekir. */
function cmykToRgb(samples, pixels) {
  const out = Buffer.alloc(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    const c = samples[i * 4] / 255, m = samples[i * 4 + 1] / 255;
    const y = samples[i * 4 + 2] / 255, k = samples[i * 4 + 3] / 255;
    out[i * 3] = Math.round(255 * (1 - Math.min(1, c + k)));
    out[i * 3 + 1] = Math.round(255 * (1 - Math.min(1, m + k)));
    out[i * 3 + 2] = Math.round(255 * (1 - Math.min(1, y + k)));
  }
  return out;
}

/** Bit derinliğini 8'e açar (1/2/4 bit gri ve indeksli görseller için). */
function expandBits(data, width, height, bitDepth, componentsPerPixel) {
  const out = Buffer.alloc(width * height * componentsPerPixel);
  const perRow = Math.ceil((width * componentsPerPixel * bitDepth) / 8);
  const max = (1 << bitDepth) - 1;
  let o = 0;

  for (let y = 0; y < height; y++) {
    let bit = 0;
    const row = y * perRow;
    for (let i = 0; i < width * componentsPerPixel; i++) {
      const byte = data[row + (bit >> 3)] || 0;
      const shift = 8 - bitDepth - (bit & 7);
      const value = (byte >> shift) & max;
      out[o++] = value;
      bit += bitDepth;
    }
  }
  return { data: out, max };
}

/* ------------------------------------------------------------------ */
/* Ana giriş                                                           */
/* ------------------------------------------------------------------ */

/**
 * Görsel XObject'i dosya baytlarına çevirir.
 *
 * @param {Object} doc PdfDocument
 * @param {Object} stream görsel XObject akışı
 * @returns {{ bytes: Buffer, mime: string, width: number, height: number,
 *             note?: string }}
 * @throws {PdfImageError} çevrilemeyen görsellerde — çağıran uyarıya çevirir
 */
function extractImage(doc, stream) {
  const dict = stream.dict;
  const width = Number(doc.get(dict, 'Width') || doc.get(dict, 'W')) || 0;
  const height = Number(doc.get(dict, 'Height') || doc.get(dict, 'H')) || 0;

  if (!width || !height) throw new PdfImageError('ERR_IMG_SIZE', 'Görsel ölçüsü okunamadı');
  if (width * height > MAX_PIXELS) {
    throw new PdfImageError('ERR_IMG_PIXELS',
      `Görsel ${width}×${height} piksel; sınır ${MAX_PIXELS}`);
  }

  if (doc.get(dict, 'ImageMask') === true || doc.get(dict, 'IM') === true) {
    throw new PdfImageError('ERR_IMG_STENCIL',
      'Şablon maskesi (ImageMask) bağımsız bir görsele çevrilemez');
  }

  const data = doc.getStreamData(stream);
  const filter = stream._imageFilter;

  // JPEG: olduğu gibi. Yeniden kodlamak ikinci bir kayıp demektir.
  if (filter === 'DCTDecode' || filter === 'DCT') {
    return { bytes: Buffer.from(data), mime: 'image/jpeg', width, height };
  }
  if (filter) {
    throw new PdfImageError('ERR_IMG_FILTER', `Görsel filtresi desteklenmiyor: ${filter}`);
  }

  const bitDepth = Number(doc.get(dict, 'BitsPerComponent') || doc.get(dict, 'BPC')) || 8;
  if (![1, 2, 4, 8].includes(bitDepth)) {
    throw new PdfImageError('ERR_IMG_DEPTH', `${bitDepth} bitlik örnek desteklenmiyor`);
  }

  const cs = resolveColorSpace(doc, doc.get(dict, 'ColorSpace') || doc.get(dict, 'CS'));
  const note = cs.approx;
  const pixels = width * height;

  let samples;
  let colorType;
  let palette;
  let outDepth = 8;

  if (cs.kind === 'indexed') {
    // İndeksli görseli PNG paletine çevirmek en sadık yoldur: örnekler
    // aynen kalır, renkler PLTE'ye taşınır.
    if (cs.base.kind === 'cmyk') {
      const entries = Math.min(cs.hiVal + 1, Math.floor(cs.table.length / 4));
      palette = cmykToRgb(cs.table, entries);
    } else if (cs.base.kind === 'gray') {
      const entries = Math.min(cs.hiVal + 1, cs.table.length);
      palette = Buffer.alloc(entries * 3);
      for (let i = 0; i < entries; i++) {
        palette[i * 3] = palette[i * 3 + 1] = palette[i * 3 + 2] = cs.table[i];
      }
    } else {
      const entries = Math.min(cs.hiVal + 1, Math.floor(cs.table.length / 3));
      palette = cs.table.subarray(0, entries * 3);
    }
    if (!palette.length) throw new PdfImageError('ERR_IMG_PALETTE', 'Renk tablosu boş');

    colorType = 3;
    outDepth = bitDepth;              // PNG 1/2/4/8 bitlik paleti destekler
    const rowBytes = Math.ceil((width * bitDepth) / 8);
    samples = Buffer.alloc(rowBytes * height);
    data.copy(samples, 0, 0, Math.min(data.length, samples.length));
  } else if (cs.kind === 'gray') {
    colorType = 0;
    if (bitDepth === 8) {
      samples = Buffer.alloc(pixels);
      data.copy(samples, 0, 0, Math.min(data.length, pixels));
    } else {
      outDepth = bitDepth;
      const rowBytes = Math.ceil((width * bitDepth) / 8);
      samples = Buffer.alloc(rowBytes * height);
      data.copy(samples, 0, 0, Math.min(data.length, samples.length));
    }
  } else if (cs.kind === 'rgb') {
    colorType = 2;
    if (bitDepth !== 8) {
      const { data: wide, max } = expandBits(data, width, height, bitDepth, 3);
      samples = Buffer.alloc(pixels * 3);
      for (let i = 0; i < pixels * 3; i++) samples[i] = Math.round((wide[i] / max) * 255);
    } else {
      samples = Buffer.alloc(pixels * 3);
      data.copy(samples, 0, 0, Math.min(data.length, pixels * 3));
    }
  } else {                                   // cmyk
    if (bitDepth !== 8) {
      throw new PdfImageError('ERR_IMG_DEPTH', 'CMYK yalnız 8 bitlik örneklerle desteklenir');
    }
    colorType = 2;
    const src = Buffer.alloc(pixels * 4);
    data.copy(src, 0, 0, Math.min(data.length, pixels * 4));
    samples = cmykToRgb(src, pixels);
  }

  // Alfa: yumuşak maske (SMask) varsa kanala katılır.
  const smask = doc.resolve(doc.get(dict, 'SMask'));
  if (smask && smask.dict && (colorType === 2 || colorType === 0)) {
    const alpha = readSoftMask(doc, smask, width, height);
    if (alpha) {
      if (colorType === 2) {
        const rgba = Buffer.alloc(pixels * 4);
        for (let i = 0; i < pixels; i++) {
          rgba[i * 4] = samples[i * 3];
          rgba[i * 4 + 1] = samples[i * 3 + 1];
          rgba[i * 4 + 2] = samples[i * 3 + 2];
          rgba[i * 4 + 3] = alpha[i];
        }
        samples = rgba;
        colorType = 6;
      } else if (outDepth === 8) {
        const ga = Buffer.alloc(pixels * 2);
        for (let i = 0; i < pixels; i++) {
          ga[i * 2] = samples[i];
          ga[i * 2 + 1] = alpha[i];
        }
        samples = ga;
        colorType = 4;
      }
    }
  }

  return {
    bytes: writePng({ width, height, colorType, bitDepth: outDepth, samples, palette }),
    mime: 'image/png', width, height, note
  };
}

/**
 * Yumuşak maskeyi görselin ölçüsünde alfa kanalına çevirir.
 *
 * Maske farklı çözünürlükte olabilir; en yakın komşu ile ölçeklenir.
 * Doğrusal aradeğerleme daha yumuşak olurdu ama alfa kanalında fark
 * gözle görülmez ve bu yol öngörülebilirdir.
 *
 * @returns {Buffer|null} `width*height` baytlık alfa ya da çözülemezse null
 */
function readSoftMask(doc, smask, width, height) {
  try {
    const mw = Number(doc.get(smask.dict, 'Width')) || 0;
    const mh = Number(doc.get(smask.dict, 'Height')) || 0;
    if (!mw || !mh || mw * mh > MAX_PIXELS) return null;

    const raw = doc.getStreamData(smask);
    if (smask._imageFilter) return null;              // JPEG maske: çözülemez

    const depth = Number(doc.get(smask.dict, 'BitsPerComponent')) || 8;
    if (![1, 2, 4, 8].includes(depth)) return null;

    const gray = depth === 8 ? raw : expandBits(raw, mw, mh, depth, 1).data;
    const scale = depth === 8 ? 1 : 255 / ((1 << depth) - 1);
    const out = Buffer.alloc(width * height, 255);
    for (let y = 0; y < height; y++) {
      const sy = Math.min(mh - 1, Math.floor((y * mh) / height));
      for (let x = 0; x < width; x++) {
        const sx = Math.min(mw - 1, Math.floor((x * mw) / width));
        const v = gray[sy * mw + sx];
        out[y * width + x] = v === undefined ? 255 : Math.round(v * scale);
      }
    }
    return out;
  } catch {
    return null;                                       // maske okunamadı: opak
  }
}

module.exports = { extractImage, writePng, PdfImageError, MAX_PIXELS };
