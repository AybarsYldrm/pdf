'use strict';
/**
 * SAHTE zaman damgası üreteci — YALNIZCA TESTLER İÇİN.
 *
 * NEDEN VAR:
 *   `@fitfak/ssl`'in gerçek TSA sunucusu (`createTimestampResponder`), RFC 3161
 *   §2.3 gereği `id-kp-timeStamping` EKU'su olmayan bir sertifikayla ÇALIŞMAYI
 *   REDDEDER. Bu doğru davranıştır — ama doğrulayıcının aynı kuralı zorladığını
 *   sınamayı imkânsız kılar: kendi sunucumuz asla kuralsız jeton üretmez.
 *
 *   Gerçek dünyada ise yanlış yapılandırılmış TSA'lar vardır ve saldırgan
 *   elindeki HERHANGİ bir sertifikayla "zaman damgası" üretip belgeye
 *   iliştirebilir. Doğrulayıcının bunu reddetmesi, arşiv damgasının bütün
 *   değerinin dayandığı noktadır.
 *
 *   Bu yüzden burada saldırganı taklit ediyoruz: kuralları kasten çiğneyen,
 *   yapısal olarak GEÇERLİ bir RFC 3161 jetonu üretiyoruz.
 *
 * ÜRETİM KODUNDA KULLANILMAZ. `test/e2e` dışına taşınmamalıdır.
 */

const crypto = require('crypto');
const { DER } = require('@fitfak/pades/src/cades/asn1_der');
const ext = require('@fitfak/pades/src/cades/x509_ext');

const OID = {
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  sha256: '2.16.840.1.101.3.4.2.1',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  testPolicy: '1.3.6.1.4.1.65133.1.4'
};

/** GeneralizedTime (YYYYMMDDHHMMSSZ). */
function genTime(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const s = `${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
            `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return DER.tag(0x18, Buffer.from(s, 'ascii'));
}

/**
 * TSTInfo ::= SEQUENCE { version, policy, messageImprint, serialNumber, genTime, ... }
 */
function buildTstInfo(imprint, when, serial) {
  return DER.seq(
    DER.intFromBuf(Buffer.from([0x01])),
    DER.oid(OID.testPolicy),
    DER.seq(DER.algo(OID.sha256, true), DER.octet(imprint)),
    DER.intFromBuf(serial),
    genTime(when)
  );
}

/** SigningCertificateV2 (ESSCertIDv2, varsayılan SHA-256). */
function signingCertV2Attr(certDer) {
  const hash = crypto.createHash('sha256').update(certDer).digest();
  const essCertIdV2 = DER.seq(DER.octet(hash));
  return DER.seq(DER.oid(OID.signingCertificateV2), DER.set(DER.seq(DER.seq(essCertIdV2))));
}

/**
 * Sahte ama YAPISAL OLARAK GEÇERLİ bir RFC 3161 jetonu üretir.
 *
 * @param {Object} params
 * @param {Buffer} params.imprint      damgalanan özet (imza değerinin SHA-256'sı)
 * @param {Buffer} params.certDer      jetonu imzalayan sertifika (EKU'su ne olursa olsun)
 * @param {string} params.keyPem       o sertifikanın özel anahtarı
 * @param {Buffer[]} [params.chainDer] jetona gömülecek ek sertifikalar
 * @param {Date}   [params.when]       genTime
 * @returns {Buffer} ContentInfo(SignedData) DER — PAdES'in beklediği jeton biçimi
 */
function forgeTimestampToken({ imprint, certDer, keyPem, chainDer = [], when = new Date() }) {
  const serial = crypto.randomBytes(8);
  const tstInfo = buildTstInfo(imprint, when, serial);

  // eContent [0] EXPLICIT OCTET STRING
  const eContentOct = DER.octet(tstInfo);
  const eci = DER.seq(DER.oid(OID.tstInfo), DER.ctxExplicit(0, eContentOct));

  // İmzalı öznitelikler: contentType + messageDigest + signingCertificateV2
  const attrs = [
    DER.seq(DER.oid(OID.contentType), DER.set(DER.oid(OID.tstInfo))),
    DER.seq(DER.oid(OID.messageDigest),
      DER.set(DER.octet(crypto.createHash('sha256').update(tstInfo).digest()))),
    signingCertV2Attr(certDer)
  ];

  // İmza SET OF üzerinden atılır; CMS'te [0] IMPLICIT taşınır (RFC 5652 §5.4)
  const signedAttrsForSigning = DER.set(...attrs);
  const signedAttrsInCms = DER.retagImplicit(signedAttrsForSigning, 0xA0);

  const key = crypto.createPrivateKey(keyPem);
  const isEc = key.asymmetricKeyType === 'ec';
  const signature = crypto.sign('sha256', signedAttrsForSigning, key);
  const sigAlg = isEc
    ? DER.seq(DER.oid(OID.ecdsaWithSha256))
    : DER.algo(OID.sha256WithRsa, true);

  const sid = DER.seq(
    DER.any(ext.getIssuerDer(certDer)),
    DER.intFromBuf(ext.getSerial(certDer))
  );

  const signerInfo = DER.seq(
    DER.intFromBuf(Buffer.from([0x01])),
    sid,
    DER.algo(OID.sha256, true),
    signedAttrsInCms,
    sigAlg,
    DER.octet(signature)
  );

  const certs = DER.retagImplicit(
    DER.set(...[certDer, ...chainDer].map((d) => DER.any(d))), 0xA0);

  const signedData = DER.seq(
    DER.intFromBuf(Buffer.from([0x03])),          // version 3 (eContentType != data)
    DER.set(DER.algo(OID.sha256, true)),
    eci,
    certs,
    DER.set(signerInfo)
  );

  return DER.seq(DER.oid(OID.signedData), DER.ctxExplicit(0, signedData));
}

module.exports = { forgeTimestampToken };
