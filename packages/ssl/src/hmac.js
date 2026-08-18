'use strict';
/**
 * HMAC-SHA256/384/512 ve HKDF (RFC 5869) — `node:crypto` üzerinden.
 * Önceki saf JavaScript uygulaması yerine OpenSSL'in denetimden geçmiş
 * HMAC/HKDF uygulaması kullanılır. Dışa aktarılan imzalar değişmedi.
 */
const crypto = require('node:crypto');

const HASH_LEN = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };

/**
 * HMAC hesaplar.
 * @param {'sha1'|'sha256'|'sha384'|'sha512'} alg
 * @param {Buffer} key
 * @param {Buffer} data
 */
function hmac(alg, key, data) {
  if (!HASH_LEN[alg]) throw new Error(`Bilinmeyen HMAC algoritması: ${alg}`);
  return crypto.createHmac(alg, key).update(data).digest();
}

/** Kısa yol: hmac('sha256', ...) */
function hmac256(key, data) { return hmac('sha256', key, data); }
function hmac384(key, data) { return hmac('sha384', key, data); }
function hmac512(key, data) { return hmac('sha512', key, data); }

/**
 * HKDF-Extract (RFC 5869 §2.2)
 */
function hkdfExtract(alg, salt, ikm) {
  if (!salt || salt.length === 0) salt = Buffer.alloc(HASH_LEN[alg] || 32);
  return hmac(alg, salt, ikm);
}

/**
 * HKDF-Expand (RFC 5869 §2.3)
 */
function hkdfExpand(alg, prk, info, len) {
  const hashLen = HASH_LEN[alg];
  if (!hashLen) throw new Error(`Bilinmeyen HKDF algoritması: ${alg}`);
  if (len > 255 * hashLen) throw new Error('HKDF: çok uzun çıktı talep edildi');
  const out = Buffer.alloc(len);
  let prev = Buffer.alloc(0);
  let written = 0;
  for (let ctr = 1; written < len; ctr++) {
    prev = hmac(alg, prk, Buffer.concat([prev, info, Buffer.from([ctr])]));
    const take = Math.min(hashLen, len - written);
    prev.copy(out, written, 0, take);
    written += take;
  }
  return out;
}

/**
 * Tek adım HKDF (RFC 5869) — Node'un yerleşik `crypto.hkdfSync` fonksiyonunu kullanır.
 * @param {'sha256'|'sha384'|'sha512'} alg
 * @param {Buffer} ikm   Giriş anahtar materyali
 * @param {Buffer} salt  (isteğe bağlı)
 * @param {Buffer} info  Bağlam bilgisi
 * @param {number} len   Çıktı bayt sayısı
 */
function hkdf(alg, ikm, salt, info, len) {
  const out = crypto.hkdfSync(
    alg,
    ikm,
    salt || Buffer.alloc(0),
    info || Buffer.alloc(0),
    len,
  );
  return Buffer.from(out);
}

module.exports = { hmac, hmac256, hmac384, hmac512, hkdfExtract, hkdfExpand, hkdf };
