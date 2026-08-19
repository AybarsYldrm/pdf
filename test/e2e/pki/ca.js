'use strict';
/**
 * Çevrimdışı test PKI'ı.
 *
 * Gerçek AIA ve CDP uzantıları taşıyan (yerel adresleri gösteren) bir sertifika
 * hiyerarşisi üretir; böylece otomatik keşif kodu gerçekten sınanır.
 *
 *   Root CA (RSA-2048, kendinden imzalı)
 *     ├── Sub CA  (RSA-2048)          AIA→root.crt, CDP→root.crl
 *     │     ├── Signer   (EC P-256)   AIA→ocsp + sub.crt, CDP→sub.crl
 *     │     ├── TSA      (EC P-256)   EKU: id-kp-timeStamping (critical)
 *     │     ├── OCSP     (EC P-256)   EKU: id-kp-OCSPSigning
 *     │     └── Revoked  (EC P-256)   iptal senaryosu için
 *     └── Sub CA CRL-only             yalnız CDP (AIA/OCSP yok)
 *           └── Signer CRL-only
 */

const ssl = require('@fitfak/ssl');

const OID_OCSP_SIGNING   = '1.3.6.1.5.5.7.3.9';
const OID_TIME_STAMPING  = '1.3.6.1.5.5.7.3.8';
const OID_EMAIL_PROTECT  = '1.3.6.1.5.5.7.3.4';
const OID_CLIENT_AUTH    = '1.3.6.1.5.5.7.3.2';

/** Varsayılan yerel servis adresleri. Portlar testte üzerine yazılabilir. */
const DEFAULT_ENDPOINTS = {
  ocsp:  'http://127.0.0.1:8081/ocsp',
  crl:   'http://127.0.0.1:8082',
  aia:   'http://127.0.0.1:8082',
  tsa:   'http://127.0.0.1:8083/tsa'
};

/**
 * Tüm hiyerarşiyi üretir.
 * @param {Object} [endpoints] DEFAULT_ENDPOINTS üzerine yazılacak adresler
 */
function buildTestPki(endpoints = {}) {
  const ep = { ...DEFAULT_ENDPOINTS, ...endpoints };

  const now = new Date();
  const days = (n) => new Date(now.getTime() + n * 86400000);

  // ── Kök ────────────────────────────────────────────────────────────
  const root = ssl.generateRootCA({
    bits: 2048,
    commonName: 'FITFAK Test Root CA',
    organization: 'FITFAK Test',
    country: 'TR',
    validityDays: 3650
  });

  // ── OCSP'li ara CA ─────────────────────────────────────────────────
  const subCa = ssl.generateIntermediateCA(root, {
    bits: 2048,
    commonName: 'FITFAK Test Issuing CA',
    organization: 'FITFAK Test',
    country: 'TR',
    validityDays: 1825,
    crlUrls: [`${ep.crl}/root.crl`],
    caIssuersUrl: [`${ep.aia}/root.crt`]
  });

  // ── Yalnız CRL yayınlayan ara CA (OCSP yok) ────────────────────────
  const subCaCrlOnly = ssl.generateIntermediateCA(root, {
    bits: 2048,
    commonName: 'FITFAK Test CRL-Only CA',
    organization: 'FITFAK Test',
    country: 'TR',
    validityDays: 1825,
    crlUrls: [`${ep.crl}/root.crl`],
    caIssuersUrl: [`${ep.aia}/root.crt`]
  });

  const eeCommon = {
    curveName: 'P-256',
    validityDays: 730,
    keyUsage: ['digitalSignature', 'contentCommitment'],
    keyUsageCritical: true,
    eku: [OID_EMAIL_PROTECT, OID_CLIENT_AUTH],
    crlUrls: [`${ep.crl}/sub.crl`],
    ocspUrl: [ep.ocsp],
    caIssuersUrl: [`${ep.aia}/sub.crt`]
  };

  const signer = ssl.generateEcEndEntityCert(subCa, 'signer.test.fitfak.net', {
    ...eeCommon,
    commonName: 'Aybars YILDIRIM'
  });

  const signer2 = ssl.generateEcEndEntityCert(subCa, 'signer2.test.fitfak.net', {
    ...eeCommon,
    commonName: 'Ahmet YILMAZ'
  });

  const revoked = ssl.generateEcEndEntityCert(subCa, 'revoked.test.fitfak.net', {
    ...eeCommon,
    commonName: 'Iptal Edilmis Imzaci'
  });

  // Yalnız CRL: AIA/OCSP verilmez, sadece CDP
  const signerCrlOnly = ssl.generateEcEndEntityCert(subCaCrlOnly, 'crlonly.test.fitfak.net', {
    curveName: 'P-256',
    validityDays: 730,
    commonName: 'CRL Only Imzaci',
    keyUsage: ['digitalSignature', 'contentCommitment'],
    keyUsageCritical: true,
    eku: [OID_EMAIL_PROTECT],
    crlUrls: [`${ep.crl}/subcrlonly.crl`],
    caIssuersUrl: [`${ep.aia}/subcrlonly.crt`]
  });

  // TSA — EKU yalnız timeStamping ve critical olmalı (RFC 3161 §2.3)
  const tsa = ssl.generateEcEndEntityCert(subCa, 'tsa.test.fitfak.net', {
    curveName: 'P-256',
    validityDays: 730,
    commonName: 'FITFAK Test TSA',
    keyUsage: ['digitalSignature'],
    keyUsageCritical: true,
    eku: [OID_TIME_STAMPING],
    ekuCritical: true,
    crlUrls: [`${ep.crl}/sub.crl`],
    ocspUrl: [ep.ocsp],
    caIssuersUrl: [`${ep.aia}/sub.crt`]
  });

  // OCSP yanıtlayıcı
  const ocspResponder = ssl.generateEcEndEntityCert(subCa, 'ocsp.test.fitfak.net', {
    curveName: 'P-256',
    validityDays: 365,
    commonName: 'FITFAK Test OCSP Responder',
    keyUsage: ['digitalSignature'],
    keyUsageCritical: true,
    eku: [OID_OCSP_SIGNING],
    ekuCritical: false
  });

  const toPem = (entity) => entity.certPem;

  return {
    endpoints: ep,
    root,
    subCa,
    subCaCrlOnly,
    signer,
    signer2,
    revoked,
    signerCrlOnly,
    tsa,
    ocspResponder,

    /** İmzalama için hazır profil paketi */
    profile(name = 'signer') {
      const map = {
        signer:       { entity: signer,       issuer: subCa,        name: 'Aybars YILDIRIM' },
        signer2:      { entity: signer2,      issuer: subCa,        name: 'Ahmet YILMAZ' },
        revoked:      { entity: revoked,      issuer: subCa,        name: 'Iptal Edilmis Imzaci' },
        crlOnly:      { entity: signerCrlOnly, issuer: subCaCrlOnly, name: 'CRL Only Imzaci' }
      };
      const p = map[name];
      if (!p) throw new Error(`bilinmeyen profil: ${name}`);
      return {
        name: p.name,
        keyPem: ssl.ecPrivToPem(p.entity),
        certPem: p.entity.certPem,
        chainPems: [p.issuer.certPem, root.certPem],
        issuerPem: p.issuer.certPem,
        rootPem: root.certPem
      };
    },

    allCertsPem: () => [
      root, subCa, subCaCrlOnly, signer, signer2, revoked, signerCrlOnly, tsa, ocspResponder
    ].map(toPem)
  };
}

module.exports = { buildTestPki, OID_OCSP_SIGNING, OID_TIME_STAMPING, DEFAULT_ENDPOINTS };
