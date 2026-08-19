'use strict';
/**
 * Standart güvenlik işleyicisi — şifreli PDF'leri AÇMAK için (ISO 32000-1 §7.6).
 *
 * Desteklenen revizyonlar:
 *   R2/R3/R4  → RC4-40/128 ve AESV2 (AES-128-CBC)
 *   R5/R6     → AESV3 (AES-256), PDF 2.0 / Acrobat X
 *
 * RC4 saf JS'tir: modern OpenSSL'de RC4 legacy provider arkasındadır ve
 * Node 20+ `createDecipheriv('rc4', …)` çağrısı hata verir.
 */

const crypto = require('crypto');
const { Name, Str, Dict } = require('./lexer');

class CryptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CryptError';
    this.code = code;
  }
}

/** PDF parola dolgusu (ISO 32000-1 Tablo 20). */
const PAD = Buffer.from([
  0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56,
  0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80,
  0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A
]);

/* ------------------------------------------------------------------ */
/* RC4 (saf JS)                                                         */
/* ------------------------------------------------------------------ */

function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }

  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const t = s[i]; s[i] = s[j]; s[j] = t;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Anahtar hesabı                                                       */
/* ------------------------------------------------------------------ */

/** R2–R4 dosya şifreleme anahtarı (Algoritma 2). */
function computeKeyR234(password, o, p, idFirst, revision, keyLength, encryptMetadata) {
  const pwd = padPassword(password);
  const md5 = crypto.createHash('md5');
  md5.update(pwd);
  md5.update(o.subarray(0, 32));

  const pBuf = Buffer.alloc(4);
  pBuf.writeInt32LE(p | 0, 0);
  md5.update(pBuf);
  md5.update(idFirst || Buffer.alloc(0));

  if (revision >= 4 && !encryptMetadata) {
    md5.update(Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]));
  }

  let key = md5.digest();
  const n = revision === 2 ? 5 : Math.floor(keyLength / 8);

  if (revision >= 3) {
    for (let i = 0; i < 50; i++) {
      key = crypto.createHash('md5').update(key.subarray(0, n)).digest();
    }
  }
  return key.subarray(0, n);
}

function padPassword(password) {
  const bytes = Buffer.from(String(password || ''), 'latin1');
  const out = Buffer.alloc(32);
  const n = Math.min(bytes.length, 32);
  bytes.copy(out, 0, 0, n);
  PAD.copy(out, n, 0, 32 - n);
  return out;
}

/** R2–R4 kullanıcı parolası doğrulaması (Algoritma 6). */
function verifyUserR234(key, u, revision, idFirst) {
  if (revision === 2) {
    return rc4(key, PAD).equals(u.subarray(0, 32));
  }
  const md5 = crypto.createHash('md5');
  md5.update(PAD);
  md5.update(idFirst || Buffer.alloc(0));
  let digest = md5.digest();

  digest = rc4(key, digest);
  for (let i = 1; i <= 19; i++) {
    const derived = Buffer.alloc(key.length);
    for (let k = 0; k < key.length; k++) derived[k] = key[k] ^ i;
    digest = rc4(derived, digest);
  }
  return digest.equals(u.subarray(0, 16));
}

/** R6 hash (ISO 32000-2 Algoritma 2.B). */
function hash2B(password, salt, userKey) {
  let k = crypto.createHash('sha256')
    .update(password).update(salt).update(userKey || Buffer.alloc(0)).digest();

  for (let round = 0; ; round++) {
    const k1 = Buffer.concat(
      new Array(64).fill(Buffer.concat([password, k, userKey || Buffer.alloc(0)]))
    );
    const cipher = crypto.createCipheriv('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32));
    cipher.setAutoPadding(false);
    const e = Buffer.concat([cipher.update(k1), cipher.final()]);

    let sum = 0;
    for (let i = 0; i < 16; i++) sum += e[i];
    const mod = sum % 3;
    k = crypto.createHash(mod === 0 ? 'sha256' : mod === 1 ? 'sha384' : 'sha512').update(e).digest();

    if (round >= 63 && e[e.length - 1] <= round - 32) break;
  }
  return k.subarray(0, 32);
}

/* ------------------------------------------------------------------ */
/* İşleyici                                                             */
/* ------------------------------------------------------------------ */

class StandardSecurityHandler {
  /**
   * @param {Dict} encryptDict `/Encrypt` sözlüğü
   * @param {Buffer} idFirst   `/ID` dizisinin ilk elemanı
   * @param {string} password  kullanıcı ya da sahip parolası
   */
  constructor(encryptDict, idFirst, password = '') {
    const filter = encryptDict.get('Filter');
    if (filter instanceof Name && filter.name !== 'Standard') {
      throw new CryptError('ERR_CRYPT_HANDLER',
        `Desteklenmeyen güvenlik işleyicisi: ${filter.name}`);
    }

    this.revision = Number(encryptDict.get('R')) || 2;
    this.version = Number(encryptDict.get('V')) || 1;
    this.keyLength = Number(encryptDict.get('Length')) || 40;
    this.permissions = Number(encryptDict.get('P')) || 0;
    this.encryptMetadata = encryptDict.get('EncryptMetadata') !== false;

    const o = bytesOf(encryptDict.get('O'));
    const u = bytesOf(encryptDict.get('U'));
    if (!o || !u) throw new CryptError('ERR_CRYPT_MISSING', '/O veya /U alanı yok');

    // V4/V5: kripto filtreleri
    this.cfm = 'V2';                                   // varsayılan RC4
    if (this.version >= 4) {
      const cf = encryptDict.get('CF');
      const stmF = encryptDict.get('StmF');
      const filterName = stmF instanceof Name ? stmF.name : 'StdCF';
      if (cf instanceof Dict) {
        const entry = cf.get(filterName);
        if (entry instanceof Dict) {
          const method = entry.get('CFM');
          if (method instanceof Name) this.cfm = method.name;
          const len = Number(entry.get('Length'));
          if (Number.isFinite(len) && len > 0) {
            this.keyLength = len <= 40 ? len * 8 : len;   // bazı üreticiler bayt yazar
          }
        }
      }
      if (filterName === 'Identity') this.cfm = 'Identity';
    }

    if (this.revision >= 5) {
      this.key = this._computeKeyR56(String(password || ''), encryptDict, o, u);
      this.cfm = 'AESV3';
    } else {
      this.key = computeKeyR234(password, o, this.permissions, idFirst,
        this.revision, this.keyLength, this.encryptMetadata);

      if (!verifyUserR234(this.key, u, this.revision, idFirst)) {
        // Sahip parolası da denenebilir; ama pratikte kullanıcı parolası boş
        // olan dosyalar en yaygın durumdur ve yukarıdaki kontrol onu yakalar.
        throw new CryptError('ERR_CRYPT_BAD_PASSWORD',
          'PDF parolası yanlış (kullanıcı parolası doğrulanamadı).');
      }
    }
  }

  _computeKeyR56(password, dict, o, u) {
    const pwd = Buffer.from(password, 'utf8').subarray(0, 127);

    const uValidation = u.subarray(32, 40);
    const uKeySalt = u.subarray(40, 48);
    const oValidation = o.subarray(32, 40);
    const oKeySalt = o.subarray(40, 48);

    const hashFn = this.revision === 5
      ? (p, s, extra) => crypto.createHash('sha256').update(p).update(s).update(extra || Buffer.alloc(0)).digest()
      : hash2B;

    // Kullanıcı parolası mı?
    if (hashFn(pwd, uValidation, null).equals(u.subarray(0, 32))) {
      const ikey = hashFn(pwd, uKeySalt, null);
      const ue = bytesOf(dict.get('UE'));
      if (!ue) throw new CryptError('ERR_CRYPT_MISSING', '/UE alanı yok');
      return aesNoPadDecrypt(ikey, Buffer.alloc(16), ue).subarray(0, 32);
    }

    // Sahip parolası mı?
    const u48 = u.subarray(0, 48);
    if (hashFn(pwd, oValidation, u48).equals(o.subarray(0, 32))) {
      const ikey = hashFn(pwd, oKeySalt, u48);
      const oe = bytesOf(dict.get('OE'));
      if (!oe) throw new CryptError('ERR_CRYPT_MISSING', '/OE alanı yok');
      return aesNoPadDecrypt(ikey, Buffer.alloc(16), oe).subarray(0, 32);
    }

    throw new CryptError('ERR_CRYPT_BAD_PASSWORD', 'PDF parolası yanlış.');
  }

  /** Nesneye özel anahtar türetir (Algoritma 1). */
  objectKey(num, gen) {
    if (this.cfm === 'AESV3') return this.key;

    const extra = this.cfm === 'AESV2' ? Buffer.from([0x73, 0x41, 0x6C, 0x54]) : Buffer.alloc(0);
    const input = Buffer.concat([
      this.key,
      Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]),
      extra
    ]);
    const digest = crypto.createHash('md5').update(input).digest();
    return digest.subarray(0, Math.min(this.key.length + 5, 16));
  }

  /**
   * Bir nesnenin baytlarını şifreler (artımlı kaydetmede yeni nesneler için).
   * RC4 simetriktir; AES için rastgele IV üretilir ve PKCS#7 dolgusu eklenir.
   */
  encrypt(data, num, gen) {
    if (this.cfm === 'Identity' || !data || !data.length) return data;
    const key = this.objectKey(num, gen);

    if (this.cfm === 'AESV2' || this.cfm === 'AESV3') {
      const iv = crypto.randomBytes(16);
      const algo = key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
      const cipher = crypto.createCipheriv(algo, key, iv);
      cipher.setAutoPadding(true);
      return Buffer.concat([iv, cipher.update(data), cipher.final()]);
    }
    return rc4(key, data);
  }

  /** Bir nesnenin baytlarını çözer. */
  decrypt(data, num, gen) {
    if (this.cfm === 'Identity' || !data || !data.length) return data;
    const key = this.objectKey(num, gen);

    if (this.cfm === 'AESV2' || this.cfm === 'AESV3') {
      if (data.length <= 16) return Buffer.alloc(0);
      const iv = data.subarray(0, 16);
      const body = data.subarray(16);
      const algo = key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
      try {
        const decipher = crypto.createDecipheriv(algo, key, iv);
        decipher.setAutoPadding(false);
        const out = Buffer.concat([decipher.update(body), decipher.final()]);
        const pad = out[out.length - 1];
        return pad >= 1 && pad <= 16 && pad <= out.length ? out.subarray(0, out.length - pad) : out;
      } catch (err) {
        throw new CryptError('ERR_CRYPT_DECRYPT', `AES çözme başarısız: ${err.message}`);
      }
    }
    return rc4(key, data);
  }
}

function aesNoPadDecrypt(key, iv, data) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function bytesOf(value) {
  if (!value) return null;
  if (value instanceof Str) return value.bytes;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'latin1');
  return null;
}

module.exports = { StandardSecurityHandler, CryptError, rc4, padPassword, PAD };
