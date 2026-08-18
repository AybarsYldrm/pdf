'use strict';
/**
 * RSA anahtar üretimi, PKCS#1 v1.5 imza ve RSA-OAEP şifreleme.
 *
 * Bu modül artık gerçek kriptografik işlemler (anahtar üretimi, imzalama,
 * şifre çözme) için Node.js'in yerleşik `crypto` modülünü (OpenSSL)
 * kullanır. Önceki sürüm, asal sayı üretimini ve modüler üssü elle
 * (saf JavaScript BigInt ile) yapıyordu; bu hem çok daha yavaştır hem de
 * yan-kanal saldırılarına (zamanlama vb.) karşı OpenSSL'in sabit-zamanlı
 * uygulaması kadar dayanıklı değildir.
 *
 * Dışa aktarılan fonksiyonların İMZALARI ve GİRİŞ/ÇIKIŞ şekilleri (ham
 * BigInt alanlarından oluşan anahtar nesneleri: {n,e,d,p,q,dp,dq,qInv})
 * AYNEN korunmuştur — bu paketi tüketen servisler değişiklik yapmadan
 * çalışmaya devam eder.
 *
 * Geriye dönük uyumluluk notu: `rsaSign`/`rsaOaepDecrypt` çağrılırken tam
 * CRT alanları (p,q,dp,dq,qInv) sağlanmazsa, bu fonksiyonlar eski saf
 * BigInt tabanlı (modPow) yola OTOMATİK olarak düşer — böylece yalnızca
 * {n,d} içeren eski tarz anahtarlarla çağrılan kod kırılmaz. Ancak bu
 * kütüphanenin ürettiği (generateRsaKeyPair) anahtarlar HER ZAMAN tam CRT
 * alanlarını içerir ve dolayısıyla HER ZAMAN `crypto` tabanlı (hızlı,
 * sertleştirilmiş) yolu kullanır.
 */
const crypto = require('node:crypto');
const { modPow } = require('./bigint');
const { hashByName } = require('./hash');
const { SEQ, INT, intSmall } = require('./asn1');
const { bigIntToB64Url, b64UrlToBigInt } = require('./_codec');

// ─────────────────────────────────────────────────────────────────────────────
// Ham BigInt ↔ Buffer yardımcıları (dışa aktarılır — imza değişmedi)
// ─────────────────────────────────────────────────────────────────────────────
function _bufToBigInt(buf) {
  let v = 0n;
  for (const b of buf) v = (v << 8n) | BigInt(b);
  return v;
}

function _bigIntToBuf(v, len) {
  let hex = v.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.from(hex.padStart(len * 2, '0'), 'hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Anahtar üretimi — node:crypto (OS düzeyinde CSPRNG + OpenSSL asal üretimi)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * RSA anahtar çifti üretir. Anahtar `node:crypto` (OpenSSL) ile üretilir;
 * JWK dışa aktarımı üzerinden ham BigInt alanlarına dönüştürülür.
 * @param {number} [bits=2048]  Modulus bit uzunluğu (önerilen: 2048/3072/4096)
 * @param {boolean} [verbose]
 * @returns {{ n, e, d, p, q, dp, dq, qInv, bits }}
 */
function generateRsaKeyPair(bits = 2048, verbose = false) {
  if (!Number.isInteger(bits) || bits < 512 || bits > 16384 || bits % 8 !== 0)
    throw new Error('RSA: bits 512-16384 arası, 8 ile bölünebilir bir tam sayı olmalı (önerilen: 2048, 3072, 4096)');
  if (verbose) process.stdout.write(`[RSA] ${bits}-bit anahtar üretiliyor (node:crypto)...`);
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: bits,
    publicExponent: 65537,
  });
  const jwk = privateKey.export({ format: 'jwk' });
  const key = {
    n: b64UrlToBigInt(jwk.n),
    e: b64UrlToBigInt(jwk.e),
    d: b64UrlToBigInt(jwk.d),
    p: b64UrlToBigInt(jwk.p),
    q: b64UrlToBigInt(jwk.q),
    dp: b64UrlToBigInt(jwk.dp),
    dq: b64UrlToBigInt(jwk.dq),
    qInv: b64UrlToBigInt(jwk.qi),
    bits,
  };
  if (verbose) console.log(' tamam');
  return key;
}

// ─────────────────────────────────────────────────────────────────────────────
// KeyObject yeniden inşası (ham BigInt alanlarından)
// ─────────────────────────────────────────────────────────────────────────────
function _hasFullCrt(key) {
  const qi = key.qInv !== undefined ? key.qInv : key.qi;
  return key.p !== undefined && key.q !== undefined &&
         key.dp !== undefined && key.dq !== undefined && qi !== undefined;
}

/** Tam CRT alanlarından PKCS#1 DER özel anahtarı → crypto.KeyObject */
function _privateKeyObject(key) {
  const qi = key.qInv !== undefined ? key.qInv : key.qi;
  const der = SEQ(
    intSmall(0), INT(key.n), INT(key.e), INT(key.d),
    INT(key.p), INT(key.q), INT(key.dp), INT(key.dq), INT(qi),
  );
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs1' });
}

/** {n,e} alanlarından SPKI/JWK genel anahtarı → crypto.KeyObject */
function _publicKeyObject(key) {
  const jwk = { kty: 'RSA', n: bigIntToB64Url(key.n), e: bigIntToB64Url(key.e) };
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

const _NODE_DIGEST = { sha1: 'sha1', sha256: 'sha256', sha384: 'sha384', sha512: 'sha512' };

// ─────────────────────────────────────────────────────────────────────────────
// PKCS#1 v1.5 dolgusu — YALNIZCA eski (legacy) modPow yolu için kullanılır
// ─────────────────────────────────────────────────────────────────────────────
const PKCS1_DIGEST_INFO = {
  sha256: Buffer.from('3031300d060960864801650304020105000420', 'hex'),
  sha384: Buffer.from('3041300d060960864801650304020205000430', 'hex'),
  sha512: Buffer.from('3051300d060960864801650304020305000440', 'hex'),
};

function _pkcs1v15Pad(hashAlg, msgHash, emLen) {
  const prefix = PKCS1_DIGEST_INFO[hashAlg];
  if (!prefix) throw new Error(`PKCS#1: bilinmeyen hash: ${hashAlg}`);
  const T = Buffer.concat([prefix, msgHash]);
  const psLen = emLen - T.length - 3;
  if (psLen < 8) throw new Error('PKCS#1: modulus çok kısa');
  const PS = Buffer.alloc(psLen, 0xff);
  return Buffer.concat([Buffer.from([0x00, 0x01]), PS, Buffer.from([0x00]), T]);
}

/** @deprecated Yalnızca tam CRT alanları eksikse dahili geri düşüş (fallback) olarak kullanılır. */
function _legacySign(key, data, hashAlg) {
  const mHash = hashByName(hashAlg, data);
  const emLen = Math.ceil(key.n.toString(2).length / 8);
  const em = _pkcs1v15Pad(hashAlg, mHash, emLen);
  const m = _bufToBigInt(em);
  const sig = modPow(m, key.d, key.n);
  return _bigIntToBuf(sig, emLen);
}

/** @deprecated Yalnızca tam CRT alanları eksikse dahili geri düşüş (fallback) olarak kullanılır. */
function _legacyOaepDecrypt(privKey, ciphertext, label) {
  const { sha256 } = require('./hash');
  const hLen = 32;
  const emLen = Math.ceil(privKey.n.toString(2).length / 8);
  const c = _bufToBigInt(ciphertext);
  const m = modPow(c, privKey.d, privKey.n);
  const EM = _bigIntToBuf(m, emLen);
  if (EM[0] !== 0x00) throw new Error('OAEP: çözme başarısız');
  const lHash = sha256(label);
  const maskedSeed = EM.subarray(1, 1 + hLen);
  const maskedDB = EM.subarray(1 + hLen);
  const seedMask = _mgf1(maskedDB, hLen);
  const seed = Buffer.allocUnsafe(hLen);
  for (let i = 0; i < hLen; i++) seed[i] = maskedSeed[i] ^ seedMask[i];
  const dbMask = _mgf1(seed, maskedDB.length);
  const DB = Buffer.allocUnsafe(maskedDB.length);
  for (let i = 0; i < maskedDB.length; i++) DB[i] = maskedDB[i] ^ dbMask[i];
  let diff = 0;
  for (let i = 0; i < hLen; i++) diff |= DB[i] ^ lHash[i];
  let sepIdx = hLen;
  while (sepIdx < DB.length && DB[sepIdx] === 0x00) sepIdx++;
  if (sepIdx >= DB.length || DB[sepIdx] !== 0x01 || diff !== 0)
    throw new Error('OAEP: çözme başarısız');
  return DB.subarray(sepIdx + 1);
}

function _mgf1(seed, len) {
  const { sha256 } = require('./hash');
  const out = Buffer.alloc(len);
  let written = 0;
  for (let ctr = 0; written < len; ctr++) {
    const ctrBuf = Buffer.alloc(4);
    ctrBuf.writeUInt32BE(ctr, 0);
    const hash = sha256(Buffer.concat([seed, ctrBuf]));
    const take = Math.min(32, len - written);
    hash.copy(out, written, 0, take);
    written += take;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// İmzalama ve doğrulama
// ─────────────────────────────────────────────────────────────────────────────
/**
 * RSA PKCS#1 v1.5 imzası.
 * Tam CRT alanları (p,q,dp,dq,qInv) mevcutsa `node:crypto` (OpenSSL, sabit
 * zamanlı) kullanılır; değilse eski BigInt tabanlı yola düşer (yalnızca
 * geriye dönük uyumluluk için).
 * @param {{ n, d, e?, p?, q?, dp?, dq?, qInv? }} key
 * @param {Buffer} data       İmzalanacak veri
 * @param {'sha256'|'sha384'|'sha512'} [hashAlg]
 */
function rsaSign(key, data, hashAlg = 'sha256') {
  const digest = _NODE_DIGEST[hashAlg];
  if (digest && _hasFullCrt(key) && key.e !== undefined) {
    const keyObj = _privateKeyObject(key);
    return crypto.sign(digest, data, { key: keyObj, padding: crypto.constants.RSA_PKCS1_PADDING });
  }
  // Geriye dönük uyumluluk: yalnızca {n,d} sağlanmış eski tarz anahtar
  return _legacySign(key, data, hashAlg);
}

/**
 * RSA PKCS#1 v1.5 doğrulama. Her zaman `node:crypto` kullanır (yalnızca
 * genel anahtar {n,e} gereklidir — geriye dönük uyumluluk sorunu yoktur).
 * @param {{ n, e }} key
 * @param {Buffer} data
 * @param {Buffer} signature
 * @param {'sha256'|'sha384'|'sha512'} [hashAlg]
 */
function rsaVerify(key, data, signature, hashAlg = 'sha256') {
  const digest = _NODE_DIGEST[hashAlg] || 'sha256';
  const pubObj = _publicKeyObject(key);
  try {
    return crypto.verify(digest, data, { key: pubObj, padding: crypto.constants.RSA_PKCS1_PADDING }, signature);
  } catch (e) {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RSA-OAEP şifreleme (SHA-256 MGF) — node:crypto
// ─────────────────────────────────────────────────────────────────────────────
/**
 * RSA-OAEP şifreleyici (SHA-256). Genel anahtar işlemi olduğundan her
 * zaman `node:crypto` kullanır.
 * @param {{ n, e }} pubKey
 * @param {Buffer} data
 * @param {Buffer} [label]
 */
function rsaOaepEncrypt(pubKey, data, label = Buffer.alloc(0)) {
  const pubObj = _publicKeyObject(pubKey);
  return crypto.publicEncrypt({
    key: pubObj,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
    oaepLabel: label.length ? label : undefined,
  }, data);
}

/**
 * RSA-OAEP çözücü (SHA-256). Tam CRT alanları varsa `node:crypto`
 * kullanılır; değilse eski BigInt tabanlı yola düşer.
 * @param {{ n, d, e?, p?, q?, dp?, dq?, qInv? }} privKey
 * @param {Buffer} ciphertext
 * @param {Buffer} [label]
 */
function rsaOaepDecrypt(privKey, ciphertext, label = Buffer.alloc(0)) {
  if (_hasFullCrt(privKey) && privKey.e !== undefined) {
    const keyObj = _privateKeyObject(privKey);
    return crypto.privateDecrypt({
      key: keyObj,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
      oaepLabel: label.length ? label : undefined,
    }, ciphertext);
  }
  return _legacyOaepDecrypt(privKey, ciphertext, label);
}

module.exports = {
  generateRsaKeyPair, rsaSign, rsaVerify,
  rsaOaepEncrypt, rsaOaepDecrypt,
  _bufToBigInt, _bigIntToBuf,
  // Dahili yardımcılar (keys.js / chain.js için — korunmuştur)
  _privateKeyObject, _publicKeyObject, _hasFullCrt,
};
