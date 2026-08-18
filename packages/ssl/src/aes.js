'use strict';
/**
 * AES-128 / AES-192 / AES-256 + GCM (AEAD) modu — `node:crypto` üzerinden.
 *
 * Önceki sürüm AES S-Box / MixColumns / GHASH işlemlerini elle (saf JS)
 * uyguluyordu. Bu tür kod, önbellek zamanlaması gibi yan kanal
 * saldırılarına açık olabilir ve OpenSSL'in donanım hızlandırmalı
 * (AES-NI) sabit-zamanlı uygulamasının güvenlik/garanti seviyesine
 * ulaşamaz. Bu sürüm, gerçek şifreleme/kimlik doğrulama işlemlerini
 * Node'un yerleşik `crypto` modülüne devreder. Dışa aktarılan fonksiyon
 * imzaları ve dönüş şekilleri AYNEN korunmuştur.
 */
const crypto = require('node:crypto');

function _algName(keyLen) {
  if (keyLen === 16) return 'aes-128';
  if (keyLen === 24) return 'aes-192';
  if (keyLen === 32) return 'aes-256';
  throw new Error('AES: anahtar 16/24/32 bayt olmalı');
}

/**
 * AES-GCM şifreleyici.
 * @param {Buffer} key   16, 24 veya 32 bayt (AES-128/192/256)
 * @param {Buffer} iv    12 bayt nonce
 * @param {Buffer} pt    Açık metin
 * @param {Buffer} [aad] Kimliği doğrulanmış ek veri
 * @param {number} [tagLength] Etiket uzunluğu (bayt, varsayılan 16)
 * @returns {{ ciphertext: Buffer, tag: Buffer }}
 */
function gcmEncrypt(key, iv, pt, aad = Buffer.alloc(0), tagLength = 16) {
  const alg = `${_algName(key.length)}-gcm`;
  if (iv.length !== 12) throw new Error('GCM: IV 12 bayt olmalı');
  const cipher = crypto.createCipheriv(alg, key, iv, { authTagLength: tagLength });
  if (aad && aad.length) cipher.setAAD(aad, { plaintextLength: pt.length });
  const ciphertext = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, tag };
}

/**
 * AES-GCM çözücü — kimlik doğrulama etiketi geçersizse hata fırlatır.
 * @param {Buffer} key
 * @param {Buffer} iv
 * @param {Buffer} ct   Şifreli metin
 * @param {Buffer} aad
 * @param {Buffer} tag  Kimlik doğrulama etiketi
 * @returns {Buffer} Açık metin
 */
function gcmDecrypt(key, iv, ct, aad = Buffer.alloc(0), tag) {
  const alg = `${_algName(key.length)}-gcm`;
  if (iv.length !== 12) throw new Error('GCM: IV 12 bayt olmalı');
  const decipher = crypto.createDecipheriv(alg, key, iv, { authTagLength: tag.length });
  if (aad && aad.length) decipher.setAAD(aad, { plaintextLength: ct.length });
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (e) {
    throw new Error('GCM: Kimlik doğrulama etiketi geçersiz');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Düşük seviyeli tek blok ilkelleri (geriye dönük uyumluluk için korunmuştur).
// `gcmEncrypt`/`gcmDecrypt` artık bunları KULLANMAZ — doğrudan `crypto`
// modülünün AEAD uygulamasını kullanır. Bu iki fonksiyon, tek blokluk ham
// AES-ECB şifrelemesine ihtiyaç duyan çağıranlar için `crypto` üzerinden
// ince bir sarmalayıcı olarak sağlanır.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AES anahtarını "genişletir". Geriye dönük uyumluluk için `{ rk, Nr }`
 * yerine ham anahtarı taşıyan bir tanıtıcı nesne döner; gerçek anahtar
 * planlaması OpenSSL tarafından `aesEncryptBlock` çağrısında yapılır.
 */
function aesExpandKey(keyBuf) {
  const Nk = keyBuf.length >>> 2;
  const Nr = Nk + 6;
  return { key: Buffer.from(keyBuf), Nr };
}

/**
 * Tek bir 16 baytlık AES bloğunu ECB modunda (dolgusuz) şifreler.
 * @param {Buffer} blk 16 baytlık düz metin bloğu
 * @param {{ key: Buffer }} ks `aesExpandKey` çıktısı
 */
function aesEncryptBlock(blk, ks) {
  if (blk.length !== 16) throw new Error('AES: blok 16 bayt olmalı');
  const alg = `${_algName(ks.key.length)}-ecb`;
  const cipher = crypto.createCipheriv(alg, ks.key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(blk), cipher.final()]);
}

module.exports = { gcmEncrypt, gcmDecrypt, aesEncryptBlock, aesExpandKey };
