'use strict';
/**
 * RC2 blok şifresi — RFC 2268. Saf JavaScript.
 *
 * NEDEN GEREKLİ: Windows sertifika deposunun ürettiği .pfx dosyaları sertifika
 * çantasını genellikle `pbeWithSHAAnd40BitRC2-CBC` ile şifreler. Modern
 * OpenSSL'de (dolayısıyla Node 20+) RC2 "legacy provider" arkasındadır ve
 * `crypto.createDecipheriv('rc2-40-cbc', ...)` hata verir. Bu yüzden RC2'yi
 * kendimiz uyguluyoruz — aksi hâlde en yaygın PFX türlerinden biri açılamaz.
 *
 * Yalnız çözme (decrypt) değil şifreleme (encrypt) de sağlanır; build() eski
 * uyumluluk modu isterse kullanılır.
 */

const PITABLE = Buffer.from([
  0xd9, 0x78, 0xf9, 0xc4, 0x19, 0xdd, 0xb5, 0xed, 0x28, 0xe9, 0xfd, 0x79, 0x4a, 0xa0, 0xd8, 0x9d,
  0xc6, 0x7e, 0x37, 0x83, 0x2b, 0x76, 0x53, 0x8e, 0x62, 0x4c, 0x64, 0x88, 0x44, 0x8b, 0xfb, 0xa2,
  0x17, 0x9a, 0x59, 0xf5, 0x87, 0xb3, 0x4f, 0x13, 0x61, 0x45, 0x6d, 0x8d, 0x09, 0x81, 0x7d, 0x32,
  0xbd, 0x8f, 0x40, 0xeb, 0x86, 0xb7, 0x7b, 0x0b, 0xf0, 0x95, 0x21, 0x22, 0x5c, 0x6b, 0x4e, 0x82,
  0x54, 0xd6, 0x65, 0x93, 0xce, 0x60, 0xb2, 0x1c, 0x73, 0x56, 0xc0, 0x14, 0xa7, 0x8c, 0xf1, 0xdc,
  0x12, 0x75, 0xca, 0x1f, 0x3b, 0xbe, 0xe4, 0xd1, 0x42, 0x3d, 0xd4, 0x30, 0xa3, 0x3c, 0xb6, 0x26,
  0x6f, 0xbf, 0x0e, 0xda, 0x46, 0x69, 0x07, 0x57, 0x27, 0xf2, 0x1d, 0x9b, 0xbc, 0x94, 0x43, 0x03,
  0xf8, 0x11, 0xc7, 0xf6, 0x90, 0xef, 0x3e, 0xe7, 0x06, 0xc3, 0xd5, 0x2f, 0xc8, 0x66, 0x1e, 0xd7,
  0x08, 0xe8, 0xea, 0xde, 0x80, 0x52, 0xee, 0xf7, 0x84, 0xaa, 0x72, 0xac, 0x35, 0x4d, 0x6a, 0x2a,
  0x96, 0x1a, 0xd2, 0x71, 0x5a, 0x15, 0x49, 0x74, 0x4b, 0x9f, 0xd0, 0x5e, 0x04, 0x18, 0xa4, 0xec,
  0xc2, 0xe0, 0x41, 0x6e, 0x0f, 0x51, 0xcb, 0xcc, 0x24, 0x91, 0xaf, 0x50, 0xa1, 0xf4, 0x70, 0x39,
  0x99, 0x7c, 0x3a, 0x85, 0x23, 0xb8, 0xb4, 0x7a, 0xfc, 0x02, 0x36, 0x5b, 0x25, 0x55, 0x97, 0x31,
  0x2d, 0x5d, 0xfa, 0x98, 0xe3, 0x8a, 0x92, 0xae, 0x05, 0xdf, 0x29, 0x10, 0x67, 0x6c, 0xba, 0xc9,
  0xd3, 0x00, 0xe6, 0xcf, 0xe1, 0x9e, 0xa8, 0x2c, 0x63, 0x16, 0x01, 0x3f, 0x58, 0xe2, 0x89, 0xa9,
  0x0d, 0x38, 0x34, 0x1b, 0xab, 0x33, 0xff, 0xb0, 0xbb, 0x48, 0x0c, 0x5f, 0xb9, 0xb1, 0xcd, 0x2e,
  0xc5, 0xf3, 0xdb, 0x47, 0xe5, 0xa5, 0x9c, 0x77, 0x0a, 0xa6, 0x20, 0x68, 0xfe, 0x7f, 0xc1, 0xad
]);

const ROT = [1, 2, 3, 5];

/**
 * Anahtar genişletme (RFC 2268 §2).
 * @param {Buffer} key
 * @param {number} effectiveBits Etkin anahtar bit uzunluğu (T1). Varsayılan: 8*key.length
 * @returns {Uint16Array} 64 adet 16-bit alt anahtar
 */
function expandKey(key, effectiveBits) {
  const T = key.length;
  if (T < 1 || T > 128) throw new Error('RC2: anahtar uzunluğu 1..128 bayt olmalı');
  const T1 = effectiveBits || (T * 8);
  const T8 = Math.ceil(T1 / 8);
  const TM = 0xff >> ((8 - (T1 % 8)) % 8);

  const L = Buffer.alloc(128);
  key.copy(L, 0);

  for (let i = T; i < 128; i++) {
    L[i] = PITABLE[(L[i - 1] + L[i - T]) & 0xff];
  }
  L[128 - T8] = PITABLE[L[128 - T8] & TM];
  for (let i = 127 - T8; i >= 0; i--) {
    L[i] = PITABLE[L[i + 1] ^ L[i + T8]];
  }

  const K = new Uint16Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = L[2 * i] | (L[2 * i + 1] << 8);
  }
  return K;
}

const rotl16 = (x, n) => ((x << n) | (x >>> (16 - n))) & 0xffff;
const rotr16 = (x, n) => ((x >>> n) | (x << (16 - n))) & 0xffff;

/** Tek 8 baytlık bloğu şifreler (yerinde). */
function encryptBlock(R, K) {
  let j = 0;
  const mixRound = () => {
    for (let i = 0; i < 4; i++) {
      R[i] = (R[i] + K[j++] + (R[(i + 3) % 4] & R[(i + 2) % 4]) +
              ((~R[(i + 3) % 4] & 0xffff) & R[(i + 1) % 4])) & 0xffff;
      R[i] = rotl16(R[i], ROT[i]);
    }
  };
  const mashRound = () => {
    for (let i = 0; i < 4; i++) {
      R[i] = (R[i] + K[R[(i + 3) % 4] & 63]) & 0xffff;
    }
  };

  for (let r = 0; r < 5; r++) mixRound();
  mashRound();
  for (let r = 0; r < 6; r++) mixRound();
  mashRound();
  for (let r = 0; r < 5; r++) mixRound();
}

/** Tek 8 baytlık bloğu çözer (yerinde). */
function decryptBlock(R, K) {
  let j = 63;
  const rMixRound = () => {
    for (let i = 3; i >= 0; i--) {
      R[i] = rotr16(R[i], ROT[i]);
      R[i] = (R[i] - K[j--] - (R[(i + 3) % 4] & R[(i + 2) % 4]) -
              ((~R[(i + 3) % 4] & 0xffff) & R[(i + 1) % 4])) & 0xffff;
    }
  };
  const rMashRound = () => {
    for (let i = 3; i >= 0; i--) {
      R[i] = (R[i] - K[R[(i + 3) % 4] & 63]) & 0xffff;
    }
  };

  for (let r = 0; r < 5; r++) rMixRound();
  rMashRound();
  for (let r = 0; r < 6; r++) rMixRound();
  rMashRound();
  for (let r = 0; r < 5; r++) rMixRound();
}

function bytesToWords(buf, off, R) {
  R[0] = buf[off]     | (buf[off + 1] << 8);
  R[1] = buf[off + 2] | (buf[off + 3] << 8);
  R[2] = buf[off + 4] | (buf[off + 5] << 8);
  R[3] = buf[off + 6] | (buf[off + 7] << 8);
}

function wordsToBytes(R, out, off) {
  for (let i = 0; i < 4; i++) {
    out[off + i * 2]     = R[i] & 0xff;
    out[off + i * 2 + 1] = (R[i] >>> 8) & 0xff;
  }
}

/**
 * RC2-CBC çözme + PKCS#7 dolgu kaldırma.
 * @param {Buffer} data
 * @param {Buffer} key
 * @param {Buffer} iv 8 bayt
 * @param {number} [effectiveBits] Varsayılan: 8*key.length
 * @returns {Buffer}
 */
function decryptCbc(data, key, iv, effectiveBits) {
  if (data.length === 0 || data.length % 8 !== 0) {
    throw new Error('RC2-CBC: şifreli metin 8 baytın katı olmalı');
  }
  if (iv.length !== 8) throw new Error('RC2-CBC: IV 8 bayt olmalı');

  const K = expandKey(key, effectiveBits);
  const out = Buffer.alloc(data.length);
  const R = new Uint16Array(4);
  let prev = Buffer.from(iv);

  for (let off = 0; off < data.length; off += 8) {
    const cipherBlock = data.slice(off, off + 8);
    bytesToWords(cipherBlock, 0, R);
    decryptBlock(R, K);
    const plain = Buffer.alloc(8);
    wordsToBytes(R, plain, 0);
    for (let i = 0; i < 8; i++) plain[i] ^= prev[i];
    plain.copy(out, off);
    prev = cipherBlock;
  }

  // PKCS#7 dolgu
  const pad = out[out.length - 1];
  if (pad < 1 || pad > 8 || pad > out.length) {
    throw new Error('RC2-CBC: geçersiz dolgu (parola yanlış olabilir)');
  }
  for (let i = out.length - pad; i < out.length; i++) {
    if (out[i] !== pad) throw new Error('RC2-CBC: geçersiz dolgu (parola yanlış olabilir)');
  }
  return out.slice(0, out.length - pad);
}

/**
 * RC2-CBC şifreleme + PKCS#7 dolgu.
 */
function encryptCbc(plain, key, iv, effectiveBits) {
  if (iv.length !== 8) throw new Error('RC2-CBC: IV 8 bayt olmalı');
  const K = expandKey(key, effectiveBits);
  const padLen = 8 - (plain.length % 8);
  const padded = Buffer.concat([plain, Buffer.alloc(padLen, padLen)]);
  const out = Buffer.alloc(padded.length);
  const R = new Uint16Array(4);
  let prev = Buffer.from(iv);

  for (let off = 0; off < padded.length; off += 8) {
    const block = Buffer.from(padded.slice(off, off + 8));
    for (let i = 0; i < 8; i++) block[i] ^= prev[i];
    bytesToWords(block, 0, R);
    encryptBlock(R, K);
    const cipherBlock = Buffer.alloc(8);
    wordsToBytes(R, cipherBlock, 0);
    cipherBlock.copy(out, off);
    prev = cipherBlock;
  }
  return out;
}

module.exports = { expandKey, decryptCbc, encryptCbc, PITABLE };
