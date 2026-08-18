'use strict';
/**
 * PKCS#12 anahtar türetme fonksiyonu — RFC 7292 Ek B.
 *
 * DİKKAT: Bu PBKDF2 DEĞİLDİR. Windows sertifika deposu, Java keytool ve
 * OpenSSL'in eski varsayılan `-export` çıktısı bu KDF'i kullanır. Projedeki
 * eski PKCS#12 kodu yalnız PBES2/PBKDF2 desteklediği için bu dosyaları
 * açamıyordu.
 *
 * En sık yapılan hata parolanın kodlanmasıdır: parola BMPString olarak,
 * yani UTF-16 BIG ENDIAN ve SONUNDA ÇİFT NULL bayt ile kodlanmalıdır.
 * Boş parola için sonuç 2 baytlık `00 00` değil, RFC'ye göre BOŞ dizidir —
 * ama uygulamada iki yorum da dolaşımdadır, bu yüzden ikisi de denenebilir
 * (bkz. `passwordVariants`).
 */

const crypto = require('crypto');

const ID_KEY_MATERIAL = 1;  // şifreleme anahtarı
const ID_IV           = 2;  // başlangıç vektörü
const ID_MAC_KEY      = 3;  // MAC anahtarı

/**
 * Parolayı BMPString olarak kodlar (UTF-16BE + çift null sonlandırma).
 * @param {string} password
 * @returns {Buffer}
 */
function toBmpString(password) {
  const str = String(password == null ? '' : password);
  const buf = Buffer.alloc(str.length * 2 + 2);
  for (let i = 0; i < str.length; i++) {
    buf.writeUInt16BE(str.charCodeAt(i), i * 2);
  }
  buf.writeUInt16BE(0, str.length * 2); // sonlandırıcı
  return buf;
}

/**
 * Boş parola için gerçek dünyada iki farklı kodlama görülür. Parse ederken
 * ikisini de denemek, "doğru parolayla açılmıyor" hatalarının önüne geçer.
 * @param {string} password
 * @returns {Buffer[]}
 */
function passwordVariants(password) {
  const primary = toBmpString(password);
  if (password === '' || password == null) {
    return [primary, Buffer.alloc(0)];
  }
  return [primary];
}

/**
 * RFC 7292 Ek B.2 — anahtar türetme.
 *
 * @param {Buffer} passwordBmp BMPString kodlanmış parola
 * @param {Buffer} salt
 * @param {number} id ID_KEY_MATERIAL | ID_IV | ID_MAC_KEY
 * @param {number} iterations
 * @param {number} outLen İstenen bayt sayısı
 * @param {string} hashName 'sha1' | 'sha256' | 'sha384' | 'sha512'
 * @returns {Buffer}
 */
function pkcs12Kdf(passwordBmp, salt, id, iterations, outLen, hashName = 'sha1') {
  const u = crypto.createHash(hashName).update(Buffer.alloc(0)).digest().length; // özet uzunluğu
  const v = (hashName === 'sha384' || hashName === 'sha512') ? 128 : 64;         // blok uzunluğu

  // 1. D (diversifier): v baytlık, tamamı `id`
  const D = Buffer.alloc(v, id);

  // 2. S: salt'ın v'nin katına yuvarlanmış tekrarı
  const S = fill(salt, v);
  // 3. P: parolanın v'nin katına yuvarlanmış tekrarı
  const P = fill(passwordBmp, v);

  const I = Buffer.concat([S, P]);
  const c = Math.ceil(outLen / u);
  const out = Buffer.alloc(c * u);

  for (let i = 0; i < c; i++) {
    // 6a. A_i = H^r(D || I)
    let A = Buffer.concat([D, I]);
    for (let r = 0; r < iterations; r++) {
      A = crypto.createHash(hashName).update(A).digest();
    }
    A.copy(out, i * u);

    if (i === c - 1) break;

    // 6b. B: A'nın v baytına yayılmış hâli
    const B = fill(A, v);

    // 6c. I'nin her v baytlık bloğuna B + 1 eklenir (mod 2^v)
    for (let j = 0; j < I.length; j += v) {
      addInPlace(I, j, v, B);
    }
  }

  return out.slice(0, outLen);
}

/** `src`i, uzunluğu `blockSize`ın katı olacak şekilde tekrarlar. */
function fill(src, blockSize) {
  if (src.length === 0) return Buffer.alloc(0);
  const len = blockSize * Math.ceil(src.length / blockSize);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = src[i % src.length];
  return out;
}

/**
 * I[offset..offset+len) = (I[offset..] + B + 1) mod 2^(8*len)
 * Büyük sayı toplaması; en anlamsız bayttan başlar.
 */
function addInPlace(I, offset, len, B) {
  let carry = 1;
  for (let k = len - 1; k >= 0; k--) {
    const sum = I[offset + k] + B[k] + carry;
    I[offset + k] = sum & 0xff;
    carry = sum >> 8;
  }
}

module.exports = {
  toBmpString,
  passwordVariants,
  pkcs12Kdf,
  ID_KEY_MATERIAL,
  ID_IV,
  ID_MAC_KEY
};
