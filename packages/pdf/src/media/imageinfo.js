'use strict';
/**
 * Görsel başlığı incelemesi — ÇÖZMEDEN önce.
 *
 * NEDEN AYRI BİR ADIM
 *
 * Bir PNG'nin dosya boyutu, çözüldüğünde tutacağı belleği söylemez.
 * 40 KB'lık bir dosya 20 000 × 20 000 piksel bildirebilir; çözüldüğünde
 * 20000 × 20000 × 4 = 1,6 GB eder. "Dosya küçük, demek ki zararsız"
 * varsayımı, sıkıştırma bombalarının tam olarak dayandığı varsayımdır.
 *
 * Bu yüzden sınır BAYT üzerinden değil, başlığın BİLDİRDİĞİ piksel sayısı
 * üzerinden uygulanmalıdır ve bu, ayrıştırıcı çağrılmadan ÖNCE olmalıdır.
 * Başlık yalan söylüyorsa ayrıştırıcı zaten hata verir; doğru söylüyorsa
 * biz zaten reddetmişizdir.
 *
 * Bağımlılık yoktur: hem Node hem tarayıcı tarafı bu dosyayı kullanır.
 */

class ImageInfoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImageInfoError';
    this.code = code;
  }
}

/** PNG renk tipi → örnek (sample) sayısı. */
const PNG_SAMPLES = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const startsWith = (bytes, magic) => {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  return true;
};

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16 = (b, o) => (b[o] << 8) | b[o + 1];

/**
 * PNG IHDR — imzadan hemen sonra gelmek ZORUNDADIR (ISO 15948 §11.2.2).
 * Başka bir yığın önce geliyorsa dosya bozuktur; aramaya devam etmek,
 * saldırgana istediği yeri "başlık" diye gösterme imkânı verir.
 */
function readPng(bytes) {
  if (bytes.length < 33) throw new ImageInfoError('ERR_IMAGE_TRUNCATED', 'PNG başlığı eksik');
  if (u32(bytes, 8) !== 13 ||
      bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    throw new ImageInfoError('ERR_IMAGE_MALFORMED', 'PNG: IHDR ilk yığın değil');
  }

  const width = u32(bytes, 16);
  const height = u32(bytes, 20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const interlace = bytes[28];

  const samples = PNG_SAMPLES[colorType];
  if (!samples) {
    throw new ImageInfoError('ERR_IMAGE_MALFORMED', `PNG: bilinmeyen renk tipi ${colorType}`);
  }
  if (![1, 2, 4, 8, 16].includes(bitDepth)) {
    throw new ImageInfoError('ERR_IMAGE_MALFORMED', `PNG: geçersiz bit derinliği ${bitDepth}`);
  }

  return {
    format: 'png',
    mime: 'image/png',
    width,
    height,
    bitDepth,
    components: samples,
    // Adam7, çözme sırasında yedi geçiş yapar ve ek ara tampon ister.
    interlaced: interlace === 1
  };
}

/**
 * JPEG SOFn — işaretçiler sırayla gezilir.
 *
 * `0xFF` dolgu baytları (fill bytes) yasaldır ve atlanır; SOF dışındaki
 * bölümler uzunluklarına göre atlanır. Uzunluk 2'den küçükse dosya
 * bozuktur — buna izin vermek sonsuz döngü demektir.
 */
function readJpeg(bytes) {
  let p = 2;
  let guard = 0;

  while (p + 1 < bytes.length) {
    if (++guard > 10000) throw new ImageInfoError('ERR_IMAGE_MALFORMED', 'JPEG: çok fazla bölüm');

    if (bytes[p] !== 0xff) { p++; continue; }
    let marker = bytes[p + 1];
    while (marker === 0xff && p + 2 < bytes.length) { p++; marker = bytes[p + 1]; }

    // Bağımsız işaretçiler: uzunluk taşımazlar
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { p += 2; continue; }

    if (p + 3 >= bytes.length) break;
    const length = u16(bytes, p + 2);
    if (length < 2) throw new ImageInfoError('ERR_IMAGE_MALFORMED', 'JPEG: geçersiz bölüm uzunluğu');

    // SOF0..SOF15; DHT(c4), JPG(c8) ve DAC(cc) çerçeve başlığı DEĞİLDİR
    if (marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (p + 9 >= bytes.length) {
        throw new ImageInfoError('ERR_IMAGE_TRUNCATED', 'JPEG: SOF eksik');
      }
      return {
        format: 'jpeg',
        mime: 'image/jpeg',
        bitDepth: bytes[p + 4],
        height: u16(bytes, p + 5),
        width: u16(bytes, p + 7),
        components: bytes[p + 9],
        progressive: marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce,
        interlaced: false
      };
    }

    // SOS'a geldiysek çerçeve başlığı yoktur
    if (marker === 0xda) break;
    p += 2 + length;
  }

  throw new ImageInfoError('ERR_IMAGE_MALFORMED', 'JPEG: çerçeve başlığı (SOF) bulunamadı');
}

/**
 * Görsel başlığını okur.
 *
 * @param {Buffer|Uint8Array} bytes
 * @returns {{ format:'png'|'jpeg', mime:string, width:number, height:number,
 *             bitDepth:number, components:number, pixels:number,
 *             decodedBytes:number, interlaced:boolean, progressive?:boolean }}
 * @throws {ImageInfoError} tanınmayan, bozuk ya da kesik dosyalarda
 */
function inspectImage(bytes) {
  if (!bytes || bytes.length < 16) {
    throw new ImageInfoError('ERR_IMAGE_TRUNCATED', 'Görsel çok kısa');
  }

  let info;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) info = readPng(bytes);
  else if (startsWith(bytes, [0xff, 0xd8, 0xff])) info = readJpeg(bytes);
  else throw new ImageInfoError('ERR_IMAGE_FORMAT', 'Desteklenmeyen görsel biçimi (PNG/JPEG bekleniyordu)');

  if (!info.width || !info.height) {
    throw new ImageInfoError('ERR_IMAGE_MALFORMED', 'Görsel ölçüsü sıfır');
  }

  info.pixels = info.width * info.height;
  // Çözüldüğünde tutacağı yaklaşık bellek. Adam7 için ek geçiş payı eklenir.
  const perPixel = Math.ceil((info.bitDepth * info.components) / 8);
  info.decodedBytes = Math.ceil(info.pixels * perPixel * (info.interlaced ? 1.5 : 1));
  return info;
}

/**
 * Başlığı okur ve sınırları uygular.
 *
 * @param {Buffer|Uint8Array} bytes
 * @param {{ maxPixels?: number, maxDecodedBytes?: number,
 *           maxWidth?: number, maxHeight?: number }} [limits]
 */
function assertImageWithinLimits(bytes, limits = {}) {
  const info = inspectImage(bytes);

  const maxPixels = limits.maxPixels;
  if (maxPixels && info.pixels > maxPixels) {
    throw new ImageInfoError('ERR_IMAGE_PIXELS',
      `Görsel çok büyük: ${info.width}×${info.height} = ${info.pixels} piksel ` +
      `(sınır ${maxPixels}); dosya ${bytes.length} bayt olsa bile çözüldüğünde ` +
      `yaklaşık ${Math.round(info.decodedBytes / 1048576)} MB tutar`);
  }

  const maxDecoded = limits.maxDecodedBytes;
  if (maxDecoded && info.decodedBytes > maxDecoded) {
    throw new ImageInfoError('ERR_IMAGE_DECODED_TOO_LARGE',
      `Görsel çözüldüğünde ${info.decodedBytes} bayt tutar (sınır ${maxDecoded})`);
  }

  if (limits.maxWidth && info.width > limits.maxWidth) {
    throw new ImageInfoError('ERR_IMAGE_DIMENSION',
      `Görsel genişliği ${info.width} > ${limits.maxWidth}`);
  }
  if (limits.maxHeight && info.height > limits.maxHeight) {
    throw new ImageInfoError('ERR_IMAGE_DIMENSION',
      `Görsel yüksekliği ${info.height} > ${limits.maxHeight}`);
  }

  return info;
}

module.exports = { inspectImage, assertImageWithinLimits, ImageInfoError };
