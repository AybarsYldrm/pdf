'use strict';
/**
 * SHA-1 / SHA-256 / SHA-384 / SHA-512 — `node:crypto` (OpenSSL) üzerinden.
 *
 * NOT (SHA-1): Yeni imzalar için KULLANILMAMALIDIR (kriptografik olarak
 * kırılmıştır). Burada SADECE RFC 6960 (OCSP) uyumluluğu için bulunur:
 * OCSP ResponderID.byKey (KeyHash) alanı protokol tarafından SABİT SHA-1
 * olarak tanımlanmıştır ve hashAlgorithm seçimine bağlı değildir. Bu
 * kütüphanede SHA-1, imza/sertifika üretiminde ASLA kullanılmaz.
 *
 * Önceki sürüm bu algoritmaları saf JavaScript ile (elle) uyguluyordu.
 * Bu, hem performans hem de güvenlik açısından risklidir: elle yazılmış
 * kriptografik kod, zamanlama yan kanalı ve ince mantık hatalarına açıktır.
 * Bu sürüm, Node.js'in yerleşik `crypto` modülünü (OpenSSL) kullanır —
 * platformun donanım hızlandırmalı, denetimden geçmiş uygulamasından
 * yararlanır. Dışa aktarılan fonksiyon imzaları AYNEN korunmuştur.
 */
const crypto = require('node:crypto');

function _digest(alg, input) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return crypto.createHash(alg).update(buf).digest();
}

function sha1(input)   { return _digest('sha1', input); }
function sha256(input) { return _digest('sha256', input); }
function sha384(input) { return _digest('sha384', input); }
function sha512(input) { return _digest('sha512', input); }

/**
 * Algoritma adına göre hash fonksiyonu seçer.
 * @param {'sha1'|'sha256'|'sha384'|'sha512'} alg
 */
function hashByName(alg, data) {
  if (alg === 'sha1')   return sha1(data);
  if (alg === 'sha256') return sha256(data);
  if (alg === 'sha384') return sha384(data);
  if (alg === 'sha512') return sha512(data);
  throw new Error(`Bilinmeyen hash algoritması: ${alg}`);
}

module.exports = { sha1, sha256, sha384, sha512, hashByName };
