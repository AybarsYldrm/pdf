'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  KRİPTOGRAFİ & PKI MOTORU — Modül İhracatları                    ║
 * ║  node:crypto tabanlı (OpenSSL) · ML-KEM/ML-DSA hariç sıfır       ║
 * ║  harici bağımlılık                                                ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * SÜRÜM NOTU: Bu sürümde RSA/EC/AES/Hash/HMAC/HKDF gibi TÜM klasik
 * kriptografik ilkeller `node:crypto` (OpenSSL) üzerinden çalışır — önceki
 * saf JavaScript uygulamaları kaldırılmıştır. ML-KEM ve ML-DSA (post-kuantum)
 * Node'un `crypto` modülünde YERLEŞİK OLMADIĞINDAN saf JavaScript olarak
 * KALMAYA devam eder (bkz. src/mlkem.js, src/mldsa.js).
 *
 * AŞAĞIDAKİ TÜM FONKSİYONLARIN İMZALARI (isim, parametre sırası, dönüş
 * şekli) bu paketin önceki sürümüyle AYNIDIR — mevcut entegrasyonlar
 * değişiklik yapmadan çalışmaya devam eder. Yeni yetenekler (CSR
 * ayrıştırma/doğrulama, zincir doğrulama, OCSP/CRL HTTP sunucuları, üst
 * seviye CA yöneticisi, yapılandırma) EKLENTİ olarak sunulur.
 *
 * ── Hızlı Kılavuz ────────────────────────────────────────────────────
 * Hash       : sha1, sha256, sha384, sha512, hashByName
 * MAC/KDF    : hmac, hmac256/384/512, hkdf(Extract/Expand)
 * Simetrik   : gcmEncrypt, gcmDecrypt (AES-128/192/256-GCM)
 * RSA        : generateRsaKeyPair(bits), rsaSign, rsaVerify, rsaOaepEncrypt/Decrypt
 * EC/X25519  : generateEcKeyPair(curve), ecdsaSign/Verify, ecdhCompute, x25519
 * Anahtar PEM: rsaPrivToPem, ecPrivToPem, pemToRsaPriv, pemToEcPriv, certInfoFromPem
 * PKI        : generateRootCA/IntermediateCA/EndEntityCert (+Ec varyantları),
 *              generateCSR, generateCRL/parseCRL,
 *              generateOcspResponse/parseOcspRequest/verifyOcspResponse/buildOcspRequest
 * CSR (yeni) : parseCSR, verifyCSR, issueCertificateFromCSR
 * Zincir(yeni): verifyChain, verifyLink, inspect
 * HTTP (yeni): createOcspResponderHandler, sendOcspRequest,
 *              createCrlServerHandler, fetchCrl
 * CA (yeni)  : CertificateAuthority (üst seviye, kayıt-defterli PKI yöneticisi)
 * Yapılandırma(yeni): configure, getDefaults, resetDefaults
 * OID (yeni) : oid.OIDs / oid.KU / oid.REASON / oid.nameToOid / oid.oidToName
 * PQ (aynen) : mlkem768GenerateKeyPair/Encapsulate/Decapsulate, mldsaKeyGen/Sign/Verify
 */

// ── Temel ────────────────────────────────────────────────────────────────────
const { randomBytes, randomBigIntRange } = require('./src/random');

// ── Hash ─────────────────────────────────────────────────────────────────────
const { sha1, sha256, sha384, sha512, hashByName } = require('./src/hash');

// ── MAC / KDF ─────────────────────────────────────────────────────────────────
const {
  hmac, hmac256, hmac384, hmac512, hkdfExtract, hkdfExpand, hkdf
} = require('./src/hmac');

// ── Simetrik (AES-GCM) ───────────────────────────────────────────────────────
const { gcmEncrypt, gcmDecrypt, aesEncryptBlock, aesExpandKey } = require('./src/aes');

// ── BigInt (genel matematik yardımcıları — geriye dönük uyumluluk için korunmuştur) ──
const { modPow, modInverse, isProbablePrime, generatePrime } = require('./src/bigint');

// ── RSA ───────────────────────────────────────────────────────────────────────
const {
  generateRsaKeyPair, rsaSign, rsaVerify,
  rsaOaepEncrypt, rsaOaepDecrypt, _bufToBigInt, _bigIntToBuf
} = require('./src/rsa');

// ── EC / X25519 ───────────────────────────────────────────────────────────────
const {
  CURVES, getCurve,
  generateEcKeyPair, ecdsaSign, ecdsaVerify, ecdhCompute,
  generateX25519KeyPair, x25519,
  // Dahili yardımcılar (PKI için)
  _pointToUncompressed, _uncompressedToPoint,
  _bigIntToFixedBuf,
  _encodeEcdsaDer, _decodeEcdsaDer,
} = require('./src/ec');

// ── PKI ───────────────────────────────────────────────────────────────────────
const {
  generateRootCA, generateIntermediateCA, generateEndEntityCert,
  generateEcRootCA, generateEcIntermediateCA, generateEcEndEntityCert,
  generateCSR, generateCRL, parseCRL, createCertificate, newSerial,
  generateOcspResponse, parseOcspRequest, verifyOcspResponse, buildOcspRequest,
} = require('./src/pki');

// ── Anahtar Serileştirme (PEM ↔ ham anahtar) ──────────────────────────────────
const {
  rsaPrivToPem, ecPrivToPem, crlToPem,
  pemToEcPriv, pemToRsaPriv, certInfoFromPem,
} = require('./src/keys');

// ── CSR (RFC 2986) ayrıştırma / doğrulama / CA'dan sertifika üretme — YENİ ────
const { parseCSR, verifyCSR, issueCertificateFromCSR } = require('./src/csr');

// ── Sertifika Zinciri Doğrulama — YENİ (node:crypto X509Certificate tabanlı) ──
const { verifyChain, verifyLink, inspect: inspectCert } = require('./src/chain');

// ── OCSP / CRL HTTP (req,res) sunucu ve istemci yardımcıları — YENİ ───────────
const { createOcspResponderHandler, sendOcspRequest } = require('./src/http-ocsp');
const { createCrlServerHandler, fetchCrl } = require('./src/http-crl');

// ── RFC 3161 Zaman Damgası Otoritesi (TSA) — YENİ ────────────────────────────
const {
  createTimestampResponder, buildTimeStampRequest, parseTimeStampReq,
  parseTimeStampResponseStatus, SerialAllocator, TsaError, TSA_OIDS,
  PKI_STATUS, PKI_FAILURE,
} = require('./src/tsa');

// ── Certificate Transparency (RFC 6962) — YENİ ───────────────────────────────
const ctModule = require('./src/ct');

// ── Üst-seviye PKI Yöneticisi — YENİ (kolay hiyerarşi kurulumu) ──────────────
const { CertificateAuthority } = require('./src/ca-manager');

// ── Yapılandırma (varsayılan Subject/DN, geçerlilik süreleri vb.) — YENİ ──────
const { configure, getDefaults, resetDefaults } = require('./src/config');

// ── Hazır Sertifika Profilleri — YENİ (tsa / ocsp-responder / email ...) ──────
const { PROFILES, applyProfile, listProfiles } = require('./src/profiles');

// ── OID Kayıt Defteri — YENİ (genişletilmiş; asn1.js'in kullandığı kaynak) ────
const oid = require('./src/oid');

// ── ML-KEM-768 (post-kuantum KEM — saf JS, node:crypto'da yerleşik DEĞİL) ─────
const {
  mlkem768GenerateKeyPair, mlkemEncapsulate, mlkemDecapsulate, MLKEM768,
  sha3_256, sha3_512, shake128, shake256, keccakF1600,
  ntt, nttInv, baseMul, polyAdd, polySub, compress, decompress,
  byteEncode, byteDecode, sampleCBD, sampleNTT,
  _kPkeKeyGen, _kPkeEncrypt, _kPkeDecrypt
} = require('./src/mlkem');

// ── ML-DSA-65 (post-kuantum imza — saf JS, node:crypto'da yerleşik DEĞİL) ─────
const {
  mldsaKeyGen,
  mldsaSign,
  mldsaVerify,
  MLDSA65,
  // Dahili test yardımcıları
  dntt, dnttInv, dbaseMul, expandA, sampleInBall,
} = require('./src/mldsa');

// ── ASN.1 / DER ───────────────────────────────────────────────────────────────
const asn1 = require('./src/asn1');

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  // Temel
  randomBytes, randomBigIntRange,

  // Hash
  sha1, sha256, sha384, sha512, hashByName,

  // MAC / KDF
  hmac, hmac256, hmac384, hmac512, hkdfExtract, hkdfExpand, hkdf,

  // Simetrik
  gcmEncrypt, gcmDecrypt, aesEncryptBlock, aesExpandKey,

  // RSA (2048 / 3072 / 4096, node:crypto tabanlı)
  generateRsaKeyPair, rsaSign, rsaVerify,
  rsaOaepEncrypt, rsaOaepDecrypt,
  _bufToBigInt, _bigIntToBuf,

  // EC (P-256 / P-384 / P-521, node:crypto tabanlı)
  CURVES, getCurve,
  generateEcKeyPair, ecdsaSign, ecdsaVerify, ecdhCompute,
  generateX25519KeyPair, x25519,
  // Dahili yardımcılar (PKI için)
  _pointToUncompressed, _uncompressedToPoint,
  _bigIntToFixedBuf,
  _encodeEcdsaDer, _decodeEcdsaDer,

  // PKI
  generateRootCA, generateIntermediateCA, generateEndEntityCert,
  generateEcRootCA, generateEcIntermediateCA, generateEcEndEntityCert,
  generateCSR, generateCRL, parseCRL, createCertificate, newSerial,
  generateOcspResponse, parseOcspRequest, verifyOcspResponse, buildOcspRequest,

  // Anahtar Serileştirme (PEM ↔ ham anahtar)
  rsaPrivToPem, ecPrivToPem, crlToPem,
  pemToEcPriv, pemToRsaPriv, certInfoFromPem,

  // CSR — YENİ
  parseCSR, verifyCSR, issueCertificateFromCSR,

  // Sertifika Zinciri Doğrulama — YENİ
  verifyChain, verifyLink, inspectCert,

  // OCSP/CRL HTTP sunucu+istemci yardımcıları — YENİ
  createOcspResponderHandler, sendOcspRequest,
  createCrlServerHandler, fetchCrl,

  // Üst-seviye PKI Yöneticisi — YENİ
  CertificateAuthority,

  // Certificate Transparency (RFC 6962)
  ct: ctModule,
  CertificateTransparencyLog: ctModule.CertificateTransparencyLog,
  createMemoryLogStorage: ctModule.createMemoryLogStorage,
  buildSctListExtension: ctModule.buildSctListExtension,
  buildPoisonExtension: ctModule.buildPoisonExtension,
  CT_OIDS: ctModule.CT_OIDS,

  // RFC 3161 zaman damgası (TSA)
  createTimestampResponder, buildTimeStampRequest, parseTimeStampReq,
  parseTimeStampResponseStatus, SerialAllocator, TsaError, TSA_OIDS,
  PKI_STATUS, PKI_FAILURE,

  // Yapılandırma — YENİ
  configure, getDefaults, resetDefaults,

  // Sertifika Profilleri — YENİ
  PROFILES, applyProfile, listProfiles,

  // OID kodlama/çözme kısayolları — YENİ (noktalı-ondalık ↔ DER hex)
  encodeOid: oid.encodeOid,
  decodeOid: oid.decodeOidHex,
  normalizeOid: oid.normalizeOid,

  //bigint
  modPow, modInverse, isProbablePrime, generatePrime,

  // Mlkem (post-kuantum, saf JS — değişmedi)
  mlkem768GenerateKeyPair, mlkemEncapsulate, mlkemDecapsulate, MLKEM768,
  sha3_256, sha3_512, shake128, shake256, keccakF1600,
  ntt, nttInv, baseMul, polyAdd, polySub, compress, decompress,
  byteEncode, byteDecode, sampleCBD, sampleNTT,
  _kPkeKeyGen, _kPkeEncrypt, _kPkeDecrypt,

  // Mldsa (post-kuantum, saf JS — değişmedi)
  mldsaKeyGen,
  mldsaSign,
  mldsaVerify,
  MLDSA65,
  // Dahili test yardımcıları
  dntt, dnttInv, dbaseMul, expandA, sampleInBall,

  // ASN.1 / DER (ileri düzey kullanım)
  asn1,
  // OID kayıt defteri (ileri düzey kullanım) — YENİ
  oid,

  // ── Düzenli (namespaced) erişim — "güzel indeksleme" ────────────────────
  // Yukarıdaki DÜZ (flat) isimlerin hepsi aynen kullanılabilir durumda
  // kalmaya devam eder; aşağıdaki gruplar sadece keşfedilebilirliği ve
  // yapılandırılabilirliği kolaylaştırmak için EKLENMİŞTİR.
  PKI: {
    generateRootCA, generateIntermediateCA, generateEndEntityCert,
    generateEcRootCA, generateEcIntermediateCA, generateEcEndEntityCert,
    generateCSR, generateCRL, parseCRL, createCertificate, newSerial,
    generateOcspResponse, parseOcspRequest, verifyOcspResponse, buildOcspRequest,
    parseCSR, verifyCSR, issueCertificateFromCSR,
  },
  Chain: { verifyChain, verifyLink, inspect: inspectCert },
  Http: { createOcspResponderHandler, sendOcspRequest, createCrlServerHandler, fetchCrl },
  Keys: { rsaPrivToPem, ecPrivToPem, crlToPem, pemToEcPriv, pemToRsaPriv, certInfoFromPem },
  Config: { configure, getDefaults, resetDefaults },
  Profiles: { PROFILES, applyProfile, listProfiles },
  OID: oid,
  CA: CertificateAuthority,
};
