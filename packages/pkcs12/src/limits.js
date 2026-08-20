'use strict';
/**
 * PKCS#12 ayrıştırma sınırları — kaynak tüketimi saldırılarına karşı.
 *
 * TEHDİT: PFX dosyası **saldırgan denetimindedir**. `/api/pfx/identities` ve
 * `/api/sign/pfx` uçları onu doğrudan alır; masaüstünde de kullanıcı bilmeden
 * kötü niyetli bir dosya açabilir.
 *
 * RFC 7292'de iterasyon sayısı için ÜST SINIR YOKTUR. Dosyada
 *
 *     iterationCount = 2_000_000_000
 *
 * yazıyorsa ayrıştırıcı iki milyar tur SHA-1 çalıştırır: tek bir istek
 * işlemciyi dakikalarca kilitler, birkaç istek sunucuyu tamamen durdurur.
 * Parola doğru olmasa bile bu iş KDF sırasında, yani doğrulamadan ÖNCE yapılır.
 *
 * Aynı biçimde: dev bir tuz, milyonlarca SafeBag, derin yuvalanmış ASN.1
 * (özyinelemeli ayrıştırıcıda yığın taşması) ve şişirilmiş sertifika listeleri
 * de bellek/işlemci tüketir.
 *
 * Sınırlar cömerttir: gerçek dosyalar bunların çok altındadır. OpenSSL
 * varsayılanı 2048, Windows 2000–6000, bazı HSM dışa aktarımları 50 000
 * iterasyon kullanır.
 */

class Pkcs12LimitError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'Pkcs12LimitError';
    this.code = code;
    if (detail) this.detail = detail;
  }
}

const DEFAULT_LIMITS = {
  /** Dosyanın tamamı. Gerçek PFX'ler birkaç KB'dir. */
  maxBytes: 8 * 1024 * 1024,

  /** KDF tur sayısı. 10 milyon ~ birkaç saniye; üstü kabul edilmez. */
  maxIterations: 10_000_000,

  /** Tuz uzunluğu — RFC 7292 sekiz bayt önerir. */
  maxSaltBytes: 1024,

  /** SafeBag sayısı (anahtar + sertifika + CRL girdileri). */
  maxBags: 1000,

  /** Zincirdeki sertifika sayısı. */
  maxCertificates: 100,

  /** ASN.1 yuvalanma derinliği — özyinelemeli ayrıştırıcıyı korur. */
  maxDepth: 40,

  /** Bir bag'deki öznitelik sayısı. */
  maxAttributes: 64,

  /** Şifreli içerik bloğu. */
  maxEncryptedBytes: 8 * 1024 * 1024
};

/** Etkin sınırları hesaplar (çağıran gevşetebilir ama bilerek yapmalıdır). */
function resolveLimits(overrides) {
  if (!overrides) return DEFAULT_LIMITS;
  const out = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in DEFAULT_LIMITS)) continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) out[key] = n;
  }
  return out;
}

/**
 * KDF tur sayısını doğrular.
 *
 * ASN.1'den gelen değer `BigInt` üzerinden `Number`a çevrilirken taşabilir;
 * bu yüzden sonlu ve pozitif olması ayrıca sınanır.
 */
function checkIterations(value, limits = DEFAULT_LIMITS, where = 'KDF') {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Pkcs12LimitError('ERR_PFX_ITERATIONS_INVALID',
      `${where}: geçersiz iterasyon sayısı (${String(value).slice(0, 40)})`);
  }
  if (n > limits.maxIterations) {
    throw new Pkcs12LimitError('ERR_PFX_ITERATIONS_TOO_HIGH',
      `${where}: iterasyon sayısı sınırı aşıyor — ${n} > ${limits.maxIterations}. ` +
      'Bu dosya işlemciyi kilitlemek için hazırlanmış olabilir.',
      { iterations: n, limit: limits.maxIterations });
  }
  return n;
}

function checkSalt(salt, limits = DEFAULT_LIMITS) {
  const length = salt ? salt.length : 0;
  if (length > limits.maxSaltBytes) {
    throw new Pkcs12LimitError('ERR_PFX_SALT_TOO_LARGE',
      `Tuz çok uzun: ${length} bayt (sınır ${limits.maxSaltBytes})`);
  }
  return salt;
}

function checkSize(buffer, limits = DEFAULT_LIMITS) {
  const length = buffer ? buffer.length : 0;
  if (length > limits.maxBytes) {
    throw new Pkcs12LimitError('ERR_PFX_TOO_LARGE',
      `PFX çok büyük: ${length} bayt (sınır ${limits.maxBytes})`);
  }
  return buffer;
}

function checkCount(actual, limitKey, limits = DEFAULT_LIMITS, label = 'öğe') {
  const limit = limits[limitKey];
  if (actual > limit) {
    throw new Pkcs12LimitError('ERR_PFX_TOO_MANY',
      `Çok fazla ${label}: ${actual} (sınır ${limit})`);
  }
  return actual;
}

function checkDepth(depth, limits = DEFAULT_LIMITS) {
  if (depth > limits.maxDepth) {
    throw new Pkcs12LimitError('ERR_PFX_TOO_DEEP',
      `ASN.1 yuvalanması çok derin: ${depth} (sınır ${limits.maxDepth})`);
  }
  return depth;
}

module.exports = {
  DEFAULT_LIMITS, Pkcs12LimitError, resolveLimits,
  checkIterations, checkSalt, checkSize, checkCount, checkDepth
};
