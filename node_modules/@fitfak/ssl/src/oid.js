'use strict';
/**
 * Kanonik OID (Object Identifier) kayıt defteri.
 *
 * Önceki sürümde OID tablosu doğrudan asn1.js içine gömülüydü ve yalnızca
 * temel bir küme içeriyordu. Bu modül tek referans kaynağıdır (asn1.js
 * geriye dönük uyumluluk için aynı `OIDs`/`KU` şeklini buradan yeniden
 * ihraç eder) ve sertifika kullanım amaçları (Extended Key Usage), isim
 * kısıtlamaları, sertifika politikaları gibi daha fazla OID içerir.
 */

const OIDs = {
  // ── RSA ──────────────────────────────────────────────────────────────────
  rsaEncryption:            '2a864886f70d010101',
  sha256WithRSAEncryption:  '2a864886f70d01010b',
  sha384WithRSAEncryption:  '2a864886f70d01010c',
  sha512WithRSAEncryption:  '2a864886f70d01010d',
  rsaOaep:                  '2a864886f70d010107',
  rsaPss:                   '2a864886f70d01010a',

  // ── EC ───────────────────────────────────────────────────────────────────
  ecPublicKey:              '2a8648ce3d0201',
  ecdsaWithSHA256:          '2a8648ce3d040302',
  ecdsaWithSHA384:          '2a8648ce3d040303',
  ecdsaWithSHA512:          '2a8648ce3d040304',
  prime256v1:               '2a8648ce3d030107',   // P-256
  secp384r1:                '2b81040022',          // P-384
  secp521r1:                '2b81040023',          // P-521

  // ── EdDSA / X-tipi eğriler (RFC 8410) — meta veri amaçlı ────────────────
  x25519:                   '2b656e',
  x448:                     '2b656f',
  ed25519:                  '2b6570',
  ed448:                    '2b6571',

  // ── Hash ─────────────────────────────────────────────────────────────────
  sha1:                     '2b0e03021a',
  sha256:                   '608648016503040201',
  sha384:                   '608648016503040202',
  sha512:                   '608648016503040203',

  // ── DN (Distinguished Name) bileşenleri ─────────────────────────────────
  commonName:               '550403',
  surname:                  '550404',
  serialNumberAttr:         '550405',   // DN 'serialNumber' attr (sertifika seri no ile KARIŞTIRILMAMALI)
  country:                  '550406',
  locality:                 '550407',
  state:                    '550408',
  streetAddress:            '550409',
  orgName:                  '55040a',
  orgUnit:                  '55040b',
  title:                    '55040c',
  givenName:                '550429',
  pkcs9EmailAddress:        '2a864886f70d010901',

  // ── X.509v3 uzantıları ───────────────────────────────────────────────────
  subjectKeyId:             '551d0e',
  keyUsage:                 '551d0f',
  privateKeyUsagePeriod:    '551d10',
  subjectAltName:           '551d11',
  issuerAltName:            '551d12',
  basicConstraints:         '551d13',
  crlNumber:                '551d14',
  reasonCode:               '551d15',
  nameConstraints:          '551d1e',
  crlDistPoints:            '551d1f',
  certificatePolicies:      '551d20',
  policyMappings:           '551d21',
  authorityKeyId:           '551d23',
  policyConstraints:        '551d24',
  extKeyUsage:              '551d25',
  freshestCRL:              '551d2e',
  inhibitAnyPolicy:         '551d36',
  authorityInfoAccess:      '2b06010505070101',
  subjectInfoAccess:        '2b06010505070b',
  extensionReq:             '2a864886f70d01090e',   // PKCS#9 extensionRequest (CSR attribute)

  // ── AIA erişim yöntemleri ────────────────────────────────────────────────
  ocsp:                     '2b06010505073001',
  caIssuers:                '2b06010505073002',

  // ── Extended Key Usage (genişletilmiş anahtar kullanım amacı) ───────────
  anyExtendedKeyUsage:      '551d2500',
  serverAuth:               '2b06010505070301',
  clientAuth:               '2b06010505070302',
  codeSigning:              '2b06010505070303',
  emailProtection:          '2b06010505070304',
  timeStamping:             '2b06010505070308',
  ocspSigning:              '2b06010505070309',

  // ── OCSP (RFC 6960) ──────────────────────────────────────────────────────
  ocspBasicResponse:        '2b0601050507300101',   // id-pkix-ocsp-basic
  ocspNonce:                '2b0601050507300102',   // id-pkix-ocsp-nonce
  ocspCrlReference:         '2b0601050507300103',
  ocspResponse:             '2b0601050507300104',
  ocspNoCheck:              '2b0601050507300105',
  ocspArchiveCutoff:        '2b0601050507300106',
  ocspServiceLocator:       '2b0601050507300107',
};

// KeyUsage bit konumları (X.509 KeyUsage BIT STRING, RFC 5280 §4.2.1.3)
const KU = {
  digitalSignature: 0, nonRepudiation: 1, keyEncipherment: 2,
  dataEncipherment: 3, keyAgreement: 4, keyCertSign: 5, cRLSign: 6,
  encipherOnly: 7, decipherOnly: 8,
};

// CRL/OCSP iptal nedeni kodları (RFC 5280 §5.3.1 CRLReason)
const REASON = {
  unspecified: 0, keyCompromise: 1, cACompromise: 2, affiliationChanged: 3,
  superseded: 4, cessationOfOperation: 5, certificateHold: 6,
  removeFromCRL: 8, privilegeWithdrawn: 9, aACompromise: 10,
};
const REASON_NAMES = Object.fromEntries(Object.entries(REASON).map(([k, v]) => [v, k]));

// GeneralName CHOICE bağlamsal etiketleri (RFC 5280 §4.2.1.6) — extSAN/extCDP/AIA için
const GENERAL_NAME_TAG = {
  otherName: 0, rfc822Name: 1, dNSName: 2, x400Address: 3,
  directoryName: 4, ediPartyName: 5, uniformResourceIdentifier: 6,
  iPAddress: 7, registeredID: 8,
};

// hex OID → insan-okunur ad (ters eşleştirme, tanı/loglama amaçlı)
const NAME_BY_OID = Object.fromEntries(Object.entries(OIDs).map(([name, hex]) => [hex, name]));

/** OID adı → hex string. Bilinmeyen ad için hata fırlatır. */
function nameToOid(name) {
  const hex = OIDs[name];
  if (!hex) throw new Error(`oid: bilinmeyen OID adı '${name}'`);
  return hex;
}

/** hex OID → bilinen ad (yoksa noktalı-ondalık gösterim). */
function oidToName(hex) {
  return NAME_BY_OID[hex] || decodeOidHex(hex);
}

/** DER OID içeriğini (hex) noktalı-ondalık gösterime çevirir (ör. "2a864886f70d01010b" → "1.2.840.113549.1.1.11"). */
function decodeOidHex(hex) {
  const bytes = Buffer.from(hex, 'hex');
  const parts = [];
  let first = true;
  let val = 0n;
  for (let i = 0; i < bytes.length; i++) {
    val = (val << 7n) | BigInt(bytes[i] & 0x7f);
    if ((bytes[i] & 0x80) === 0) {
      if (first) {
        const b1 = val < 40n ? 0n : (val < 80n ? 1n : 2n);
        parts.push(b1.toString());
        parts.push((val - b1 * 40n).toString());
        first = false;
      } else {
        parts.push(val.toString());
      }
      val = 0n;
    }
  }
  return parts.join('.');
}

/**
 * Noktalı-ondalık OID gösterimini DER içerik baytlarına (hex dizgesi)
 * çevirir — `decodeOidHex`'in TERSİDİR.
 *   encodeOid('1.3.6.1.4.1.65133.1.1') → '2b06010401' + ...
 * @param {string} dotted ör. "1.3.6.1.4.1.65133.1.1"
 * @returns {string} hex dizgesi
 */
function encodeOid(dotted) {
  const parts = String(dotted).trim().split('.').map(p => {
    if (!/^\d+$/.test(p)) throw new Error(`encodeOid: geçersiz OID bileşeni '${p}' (${dotted})`);
    return BigInt(p);
  });
  if (parts.length < 2) throw new Error(`encodeOid: OID en az iki bileşen içermeli: ${dotted}`);
  if (parts[0] > 2n) throw new Error(`encodeOid: ilk bileşen 0, 1 veya 2 olmalı: ${dotted}`);
  if (parts[0] < 2n && parts[1] > 39n) throw new Error(`encodeOid: ikinci bileşen ${parts[0]} kökü için 39'dan büyük olamaz: ${dotted}`);

  const bytes = [];
  // İlk iki bileşen tek bir bayta (base-128) sıkıştırılır: 40*x + y
  const encodeVarint = (v) => {
    const stack = [Number(v & 0x7fn)];
    v >>= 7n;
    while (v > 0n) { stack.unshift(Number((v & 0x7fn) | 0x80n)); v >>= 7n; }
    bytes.push(...stack);
  };
  encodeVarint(parts[0] * 40n + parts[1]);
  for (let i = 2; i < parts.length; i++) encodeVarint(parts[i]);
  return Buffer.from(bytes).toString('hex');
}

/**
 * Bir OID'yi hangi biçimde verilirse verilsin DER hex dizgesine normalize
 * eder. Kabul edilen girdiler:
 *   - Bilinen ad:            'timeStamping', 'serverAuth', 'commonName'
 *   - Noktalı-ondalık:       '1.3.6.1.4.1.65133.1.1'
 *   - Boşluklu/':' ayraçlı hex: '2b 06 01 04 01 83 fc 6d 01 01'
 *   - Düz hex:               '2b06010401 83fc6d0101'
 * Bu sayede uzantı oluşturucularına (extEKU, extCertificatePolicies vb.)
 * elle hex hesaplamadan, okunabilir OID'ler verilebilir.
 * @param {string} input
 * @returns {string} hex dizgesi
 */
function normalizeOid(input) {
  if (typeof input !== 'string') throw new Error(`normalizeOid: dizge bekleniyor, ${typeof input} alındı`);
  const s = input.trim();
  if (OIDs[s]) return OIDs[s];                     // bilinen ad
  if (s.includes('.')) return encodeOid(s);        // noktalı-ondalık
  const cleaned = s.replace(/[\s:_-]/g, '').toLowerCase();
  if (/^[0-9a-f]+$/.test(cleaned) && cleaned.length % 2 === 0) return cleaned; // hex
  throw new Error(`normalizeOid: OID çözümlenemedi: '${input}'`);
}

module.exports = {
  OIDs, KU, REASON, REASON_NAMES, GENERAL_NAME_TAG,
  nameToOid, oidToName, decodeOidHex, encodeOid, normalizeOid,
};
