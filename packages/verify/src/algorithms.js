'use strict';
/**
 * Kriptografik algoritma politikası — ETSI TS 119 312 / SOG-IS ruhunda.
 *
 * Bir imzanın MATEMATİKSEL olarak doğrulanması, GÜVENİLİR olduğu anlamına
 * gelmez. SHA-1 çakışma direncini 2017'de kaybetti (SHAttered) ve 2020'de
 * seçilmiş ön ekli çakışma pratikleşti. Belge imzasında bunun karşılığı
 * şudur: saldırgan zararsız bir belgeyi imzalatır, AYNI ÖZETİ veren zararlı
 * bir belge üretir ve imzayı ona taşır. İmza her iki belgede de "geçerli"
 * doğrular. RSA-1024 de bugünün hesap gücüyle kırılabilir kabul edilir.
 *
 * Bu politika olmadan doğrulayıcı 1024 bitlik anahtarla, SHA-1 ile imzalanmış
 * bir belgeye SESSİZCE TOTAL-PASSED diyordu.
 *
 * NEREDE UYGULANMAZ: OCSP CertID'deki SHA-1 (RFC 6960 varsayılanı) bir imza
 * değil, bir arama anahtarıdır; orada çakışma direnci gerekmez. Kendinden
 * imzalı kök sertifikanın kendi imzası da doğrulama kararına girmez — köke
 * güven, imzasından değil güven deposunda olmasından gelir; eski SHA-1 kökler
 * bu yüzden reddedilmez.
 */

const crypto = require('crypto');

/** Çakışma direnci kırılmış ya da yeterince güvenli sayılmayan özetler. */
const BROKEN_DIGESTS = new Set(['md2', 'md4', 'md5', 'sha1', 'ripemd160']);

/** Varsayılan eşikler. */
const DEFAULT_POLICY = {
  /** İmza özeti için kabul edilmeyen algoritmalar. */
  brokenDigests: BROKEN_DIGESTS,
  /** RSA / DSA için en küçük modül uzunluğu (bit). */
  minRsaBits: 2048,
  /** EC için en küçük eğri uzunluğu (bit). */
  minEcBits: 256,
  /**
   * Uyarı eşiği: bu değerin altındaki RSA anahtarları kabul edilir ama
   * "uzun ömürlü arşiv için yetersiz" diye bildirilir (ETSI TS 119 312).
   */
  warnRsaBits: 3072
};

/**
 * İmza ve zincir için algoritma politikasını uygular.
 *
 * @param {Object} input
 * @param {Buffer} input.signerCert İmzalayan sertifika (DER)
 * @param {string} [input.digestAlgorithm] CMS özet algoritması ('sha256'…)
 * @param {Object} [input.signatureAlgorithm] `{ type, hash }`
 * @param {Buffer[]} [input.chain] Yol — [leaf, …, anchor]
 * @param {Object} [policy] DEFAULT_POLICY üzerine yazılır
 * @returns {{ ok:boolean, errors:string[], warnings:string[], details:Object }}
 */
function assessAlgorithms(input, policy = {}) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const errors = [];
  const warnings = [];
  const details = {};

  /* ── 1. İmza özeti ─────────────────────────────────────────────── */
  const digest = normalizeDigest(
    input.digestAlgorithm ||
    (input.signatureAlgorithm && input.signatureAlgorithm.hash));
  details.digestAlgorithm = digest;

  if (digest && p.brokenDigests.has(digest)) {
    errors.push(`İmza özeti ${digest.toUpperCase()} ile hesaplanmış — ` +
      'bu algoritmanın çakışma direnci kırıldı; aynı özeti veren başka bir ' +
      'belge üretilebileceği için imza belgeye bağlanamaz (ETSI TS 119 312)');
  }

  /* ── 2. İmzalayanın anahtarı ───────────────────────────────────── */
  const key = describeKey(input.signerCert);
  details.signerKey = key;

  if (key) {
    const verdict = assessKey(key, p);
    errors.push(...verdict.errors.map((e) => `İmzalayan sertifika: ${e}`));
    warnings.push(...verdict.warnings.map((w) => `İmzalayan sertifika: ${w}`));
  }

  /* ── 3. Zincirdeki CA'lar ──────────────────────────────────────── */
  const chain = Array.isArray(input.chain) ? input.chain : [];
  for (let i = 1; i < chain.length; i++) {
    const caKey = describeKey(chain[i]);
    if (!caKey) continue;
    const cn = subjectCn(chain[i]) || `#${i}`;
    const verdict = assessKey(caKey, p);
    errors.push(...verdict.errors.map((e) => `${cn}: ${e}`));
    warnings.push(...verdict.warnings.map((w) => `${cn}: ${w}`));
  }

  // Zincirdeki İMZALARIN özetleri. Kökün kendi imzası dışarıdadır: ona güven
  // imzasından değil, güven deposunda bulunmasından gelir.
  for (let i = 0; i < chain.length - 1; i++) {
    const alg = certSignatureDigest(chain[i]);
    if (!alg || !p.brokenDigests.has(alg)) continue;
    errors.push(`${subjectCn(chain[i]) || `#${i}`}: sertifika ` +
      `${alg.toUpperCase()} ile imzalanmış — sahte sertifika üretilebilir`);
  }

  return { ok: errors.length === 0, errors, warnings, details };
}

/** Bir anahtarın gücünü değerlendirir. */
function assessKey(key, p) {
  const errors = [];
  const warnings = [];

  if (key.type === 'rsa' || key.type === 'rsa-pss' || key.type === 'dsa') {
    if (!key.bits) return { errors, warnings };
    if (key.bits < p.minRsaBits) {
      errors.push(`${key.bits} bitlik ${key.type.toUpperCase()} anahtarı ` +
        `politikanın altında (en az ${p.minRsaBits} bit)`);
    } else if (key.bits < p.warnRsaBits) {
      warnings.push(`${key.bits} bitlik ${key.type.toUpperCase()} anahtarı ` +
        `uzun ömürlü arşiv için yetersiz sayılıyor (önerilen ${p.warnRsaBits} bit)`);
    }
  } else if (key.type === 'ec') {
    if (key.bits && key.bits < p.minEcBits) {
      errors.push(`${key.curve || key.bits + ' bit'} eğrisi politikanın ` +
        `altında (en az ${p.minEcBits} bit)`);
    }
  }
  return { errors, warnings };
}

/** Sertifikanın açık anahtarını tanımlar. */
function describeKey(certDer) {
  if (!certDer) return null;
  try {
    const x = new crypto.X509Certificate(certDer);
    const d = x.publicKey.asymmetricKeyDetails || {};
    const type = x.publicKey.asymmetricKeyType;

    if (type === 'ec') {
      return { type: 'ec', curve: d.namedCurve || null, bits: curveBits(d.namedCurve) };
    }
    return {
      type: type || 'unknown',
      bits: d.modulusLength || d.divisorLength || null
    };
  } catch {
    return null;
  }
}

const CURVE_BITS = {
  prime256v1: 256, secp256r1: 256, secp256k1: 256,
  secp384r1: 384, secp521r1: 521,
  brainpoolP256r1: 256, brainpoolP384r1: 384, brainpoolP512r1: 512,
  secp224r1: 224, prime192v1: 192, secp192r1: 192
};

function curveBits(name) {
  if (!name) return null;
  if (CURVE_BITS[name]) return CURVE_BITS[name];
  const m = /(\d{3})/.exec(name);
  return m ? Number(m[1]) : null;
}

/**
 * İmza algoritması OID'i → özet adı.
 *
 * Node'un X509Certificate'ı imza algoritmasını dışa açmaz, bu yüzden OID
 * DER'den okunur: Certificate ::= SEQUENCE { tbsCertificate,
 * signatureAlgorithm AlgorithmIdentifier, signatureValue }.
 */
const SIG_OID_DIGEST = {
  '1.2.840.113549.1.1.2':  'md2',      // md2WithRSA
  '1.2.840.113549.1.1.4':  'md5',      // md5WithRSA
  '1.2.840.113549.1.1.5':  'sha1',     // sha1WithRSA
  '1.2.840.113549.1.1.11': 'sha256',
  '1.2.840.113549.1.1.12': 'sha384',
  '1.2.840.113549.1.1.13': 'sha512',
  '1.2.840.113549.1.1.14': 'sha224',
  '1.2.840.113549.1.1.10': null,       // RSASSA-PSS: özet parametrededir
  '1.2.840.10045.4.1':     'sha1',     // ecdsa-with-SHA1
  '1.2.840.10045.4.3.1':   'sha224',
  '1.2.840.10045.4.3.2':   'sha256',
  '1.2.840.10045.4.3.3':   'sha384',
  '1.2.840.10045.4.3.4':   'sha512',
  '1.2.840.10040.4.3':     'sha1',     // dsa-with-sha1
  '2.16.840.1.101.3.4.3.2': 'sha256',  // dsa-with-sha256
  '1.3.14.3.2.29':         'sha1'      // sha1WithRSASignature (eski)
};

/** Sertifikanın KENDİ imzasında kullanılan özet algoritması. */
function certSignatureDigest(certDer) {
  try {
    const { readTLV, oidFromBytes } = require('@fitfak/pades/src/cades/x509_extract');
    const outer = readTLV(certDer, 0);
    const tbs = readTLV(certDer, outer.start);
    const algSeq = readTLV(certDer, tbs.next);
    if (algSeq.tag !== 0x30) return null;
    const oidTlv = readTLV(certDer, algSeq.start);
    if (oidTlv.tag !== 0x06) return null;
    const oid = oidFromBytes(certDer.slice(oidTlv.start, oidTlv.end));
    return Object.prototype.hasOwnProperty.call(SIG_OID_DIGEST, oid)
      ? SIG_OID_DIGEST[oid] : null;
  } catch {
    return null;
  }
}

/** 'RSA-SHA1', 'sha1WithRSAEncryption', 'SHA256' → 'sha1' / 'sha256' */
function normalizeDigest(name) {
  if (!name) return null;
  const s = String(name).toLowerCase();
  for (const d of ['sha512', 'sha384', 'sha256', 'sha224', 'sha3-512', 'sha3-256',
                   'sha1', 'md5', 'md4', 'md2', 'ripemd160']) {
    if (s.includes(d)) return d;
  }
  return null;
}

function subjectCn(certDer) {
  try {
    const m = /CN=([^\n,]+)/.exec(new crypto.X509Certificate(certDer).subject || '');
    return m ? m[1].trim() : null;
  } catch { return null; }
}

module.exports = {
  assessAlgorithms, describeKey, normalizeDigest, certSignatureDigest,
  DEFAULT_POLICY, BROKEN_DIGESTS
};
