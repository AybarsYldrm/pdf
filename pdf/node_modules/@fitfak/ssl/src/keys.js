'use strict';
/**
 * Anahtar serileştirme: ham BigInt alanları ↔ PEM.
 *
 * Önceki sürüm, RSA/EC özel anahtarlarını PEM'e çevirmek ve PEM'den geri
 * okumak için elle ASN.1 SEQUENCE/INTEGER inşası ve elle DER ayrıştırması
 * kullanıyordu. Bu sürüm, gerçek PEM kodlama/çözme işini doğrudan
 * `node:crypto`'nun kendi PKCS#1 / SEC1 dışa-aktarım ve içe-aktarımına
 * devreder — hem "crypto modülüne yakınlaştırma" isteğini karşılar hem de
 * anahtar tutarlılığını (ör. n = p·q) OpenSSL'in kendisi doğrulamış olur.
 * Dışa aktarılan fonksiyon imzaları AYNEN korunmuştur.
 */
const crypto = require('node:crypto');
const { readTLV, readChildren, derIntToBigInt } = require('./asn1');
const { CURVES, _bufToBigInt, _pointToUncompressed } = require('./ec');
const { _privateKeyObject: _rsaPrivateKeyObject } = require('./rsa');
const { bigIntToB64Url, b64UrlToBigInt, pemToDer, derToPem } = require('./_codec');

/**
 * RSA Özel Anahtarını (Ham N, E, D vb. değerlerinden) PKCS#1 PEM formatına çevirir.
 * @param {{ n, e, d, p, q, dp, dq, qInv }} key
 */
function rsaPrivToPem(key) {
  const keyObj = _rsaPrivateKeyObject(key);
  return keyObj.export({ format: 'pem', type: 'pkcs1' });
}

/**
 * Eliptik Eğri (EC) Özel Anahtarını SEC1 PEM formatına çevirir.
 * @param {{ curve?, curveName?, privateKey, publicKeyBuf }} key
 */
function ecPrivToPem(key) {
  const cName = key.curve || key.curveName;
  const curve = CURVES[cName];
  if (!curve) throw new Error(`ecPrivToPem: bilinmeyen eğri ${cName}`);
  // Genel anahtar noktası zaten biliniyorsa, tam SEC1 (publicKey alanlı)
  // DER'i inşa etmek için JWK üzerinden gidiyoruz; bilinmiyorsa OpenSSL
  // özel skalerden kendisi türetir (bkz. ec.js:_ecPrivateKeyObject).
  const jwk = {
    kty: 'EC', crv: cName,
    d: bigIntToB64Url(key.privateKey, curve.byteLen),
  };
  if (key.publicKeyBuf) {
    const pt = key.publicKeyBuf.length === curve.byteLen * 2 + 1
      ? { x: _bufToBigInt(key.publicKeyBuf.subarray(1, 1 + curve.byteLen)), y: _bufToBigInt(key.publicKeyBuf.subarray(1 + curve.byteLen)) }
      : null;
    if (pt) {
      jwk.x = bigIntToB64Url(pt.x, curve.byteLen);
      jwk.y = bigIntToB64Url(pt.y, curve.byteLen);
    }
  }
  const keyObj = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  return keyObj.export({ format: 'pem', type: 'sec1' });
}

/**
 * DER formatındaki CRL Buffer'ını PEM formatına sarmalar.
 */
function crlToPem(derBuf) {
  return derToPem(derBuf, 'X509 CRL');
}

/**
 * PKCS#1 "EC PRIVATE KEY" (SEC1) PEM'ini çözümler — `node:crypto` ile.
 * @returns {{ curveName, curve, privateKey: bigint, publicKeyBuf: Buffer }}
 */
function pemToEcPriv(pem) {
  const keyObj = crypto.createPrivateKey({ key: pem, format: 'pem' });
  if (keyObj.asymmetricKeyType !== 'ec')
    throw new Error('pemToEcPriv: PEM bir EC özel anahtarı değil');
  const jwk = keyObj.export({ format: 'jwk' });
  const curveName = jwk.crv;
  const curve = CURVES[curveName];
  if (!curve) throw new Error(`pemToEcPriv: desteklenmeyen eğri ${curveName}`);
  const privateKey = b64UrlToBigInt(jwk.d);
  const publicKeyBuf = _pointToUncompressed(
    { x: b64UrlToBigInt(jwk.x), y: b64UrlToBigInt(jwk.y) },
    curve.byteLen,
  );
  return { curveName, curve: curveName, privateKey, publicKeyBuf };
}

/**
 * PKCS#1 "RSA PRIVATE KEY" PEM'ini çözümler — `node:crypto` ile.
 * @returns {{ n, e, d, p, q, dp, dq, qInv: bigint }}
 */
function pemToRsaPriv(pem) {
  const keyObj = crypto.createPrivateKey({ key: pem, format: 'pem' });
  if (keyObj.asymmetricKeyType !== 'rsa')
    throw new Error('pemToRsaPriv: PEM bir RSA özel anahtarı değil');
  const jwk = keyObj.export({ format: 'jwk' });
  return {
    n: b64UrlToBigInt(jwk.n),
    e: b64UrlToBigInt(jwk.e),
    d: b64UrlToBigInt(jwk.d),
    p: b64UrlToBigInt(jwk.p),
    q: b64UrlToBigInt(jwk.q),
    dp: b64UrlToBigInt(jwk.dp),
    dq: b64UrlToBigInt(jwk.dq),
    qInv: b64UrlToBigInt(jwk.qi),
  };
}

/**
 * X.509 sertifikası PEM'inden OCSP/CRL imzalama için gereken temel alanları
 * çıkarır: issuer/subject Name (DER), SPKI (DER) ve serial number.
 * Not: Bu fonksiyon sertifika imzasını DOĞRULAMAZ — sadece yapısal alanları
 * okur (imza doğrulaması için bkz. `chain.js#verifyChain`).
 *
 * Ek olarak (geriye dönük uyumluluğu bozmayan EKLENTİ alanlar):
 * `node:crypto`'nun `X509Certificate` sınıfı üzerinden validFrom/validTo,
 * subject/issuer okunabilir metinleri ve genel anahtar (KeyObject) da
 * döndürülür.
 */
function certInfoFromPem(pem) {
  const der = Buffer.isBuffer(pem) ? pem : pemToDer(pem);
  const top = readTLV(der, 0);              // Certificate SEQUENCE
  const certChildren = readChildren(top.content);
  const tbs = certChildren[0];               // tbsCertificate SEQUENCE
  const tbsChildren = readChildren(tbs.content);

  // tbsCertificate ::= SEQUENCE { version [0], serialNumber, signature,
  //                               issuer, validity, subject, subjectPublicKeyInfo, ... }
  let idx = 0;
  if (tbsChildren[idx].tag === 0xa0) idx++; // version [0]
  const serialNode = tbsChildren[idx++];
  idx++; // signature AlgorithmIdentifier
  const issuerNode = tbsChildren[idx++];
  idx++; // validity
  const subjectNode = tbsChildren[idx++];
  const spkiNode = tbsChildren[idx++];

  // ÖNEMLİ: her node'un contentOff/totalLen değeri, KENDİSİNİN okunduğu
  // ebeveyn buffer'a (burada tbs.content) göre relatiftir — orijinal `der`
  // buffer'ına göre DEĞİL. Tam TLV baytlarını (tag+length+content) elde
  // etmek için tbs.content üzerinden, node'un kendi başlangıç offset'i
  // (contentOff - headerLen) ile totalLen kullanılarak dilimleme yapılır.
  const fullTlv = (node) => tbs.content.subarray(
    node.contentOff - node.headerLen,
    node.contentOff - node.headerLen + node.totalLen,
  );

  const info = {
    serialNumber: derIntToBigInt(serialNode.content),
    issuerNameDer: fullTlv(issuerNode),
    subjectNameDer: fullTlv(subjectNode),
    spkiDer: fullTlv(spkiNode),
    certDer: der,
  };

  // Ek (additive) alanlar — node:crypto.X509Certificate üzerinden.
  try {
    const x509 = new crypto.X509Certificate(der);
    info.subject = x509.subject;
    info.issuer = x509.issuer;
    info.validFrom = x509.validFrom;
    info.validTo = x509.validTo;
    info.serialNumberHex = x509.serialNumber;
    info.publicKey = x509.publicKey;
    info.ca = x509.ca;
    info.x509 = x509;
  } catch (e) {
    // Yapısal alanlar zaten okunduğu için X509Certificate'in başarısız
    // olması (ör. çok eski/uyumsuz bir kodlama) burada ölümcül değildir.
  }

  return info;
}

module.exports = {
  rsaPrivToPem, ecPrivToPem, crlToPem,
  pemToEcPriv, pemToRsaPriv, certInfoFromPem,
};
