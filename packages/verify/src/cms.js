'use strict';
/**
 * CMS SignedData ayrıştırma ve doğrulama (RFC 5652).
 *
 * PAdES imzası, PDF'in /Contents alanında duran bir detached CMS'tir.
 * Burada o yapı sökülür ve kriptografik olarak doğrulanır.
 */

const crypto = require('crypto');
const { readTLV, oidFromBytes } = require('@fitfak/pades/src/cades/x509_extract');
const { collectCertificates, derToPem } = require('@fitfak/pades/src/cades/x509_ext');

const OIDS = {
  signedData: '1.2.840.113549.1.7.2',
  data: '1.2.840.113549.1.7.1',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  signingCertificate: '1.2.840.113549.1.9.16.2.12',
  signatureTimeStampToken: '1.2.840.113549.1.9.16.2.14',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  sigPolicyId: '1.2.840.113549.1.9.16.2.15'
};

const DIGEST_BY_OID = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512'
};

const SIG_ALG_BY_OID = {
  '1.2.840.113549.1.1.1':  { type: 'rsa' },
  '1.2.840.113549.1.1.5':  { type: 'rsa', hash: 'sha1' },
  '1.2.840.113549.1.1.11': { type: 'rsa', hash: 'sha256' },
  '1.2.840.113549.1.1.12': { type: 'rsa', hash: 'sha384' },
  '1.2.840.113549.1.1.13': { type: 'rsa', hash: 'sha512' },
  '1.2.840.113549.1.1.10': { type: 'rsa-pss' },
  '1.2.840.10045.2.1':     { type: 'ec' },
  '1.2.840.10045.4.3.2':   { type: 'ec', hash: 'sha256' },
  '1.2.840.10045.4.3.3':   { type: 'ec', hash: 'sha384' },
  '1.2.840.10045.4.3.4':   { type: 'ec', hash: 'sha512' }
};

/** Bir SEQUENCE/SET içeriğindeki üst düzey TLV'leri okur. */
function children(buf, tlv) {
  const out = [];
  let p = tlv.start;
  while (p < tlv.end) {
    const t = readTLV(buf, p);
    if (t.next <= p) break;
    out.push(t);
    p = t.next;
  }
  return out;
}

/**
 * CMS SignedData'yı ayrıştırır.
 * @param {Buffer} der
 */
function parseSignedData(der) {
  const outer = readTLV(der, 0);
  if (outer.tag !== 0x30) throw new Error('CMS: dış SEQUENCE yok');

  const [oidTlv, contentTlv] = children(der, outer);
  const contentType = oidFromBytes(der.slice(oidTlv.start, oidTlv.end));
  if (contentType !== OIDS.signedData) {
    throw new Error(`CMS: beklenen signedData, bulunan ${contentType}`);
  }

  const sd = readTLV(der, contentTlv.start);
  const parts = children(der, sd);

  // SignedData ::= SEQUENCE { version, digestAlgorithms, encapContentInfo,
  //                           certificates [0]?, crls [1]?, signerInfos }
  let idx = 0;
  const version = der[parts[idx].start];
  idx++;

  const digestAlgorithms = children(der, parts[idx]).map((t) => {
    const a = readTLV(der, t.start);
    return oidFromBytes(der.slice(a.start, a.end));
  });
  idx++;

  const encapInfo = parts[idx]; idx++;
  const encapChildren = children(der, encapInfo);
  const eContentType = oidFromBytes(der.slice(encapChildren[0].start, encapChildren[0].end));
  let eContent = null;
  if (encapChildren[1]) {
    const inner = readTLV(der, encapChildren[1].start);
    eContent = der.slice(inner.start, inner.end);
  }

  let certificates = [];
  let crls = [];
  while (idx < parts.length && (parts[idx].tag === 0xA0 || parts[idx].tag === 0xA1)) {
    const section = der.slice(parts[idx].start, parts[idx].end);
    if (parts[idx].tag === 0xA0) certificates = collectCertificates(section);
    else crls = children(der, parts[idx]).map((t) => der.slice(t.start - t.hdr, t.end));
    idx++;
  }

  const signerInfos = children(der, parts[idx]).map((t) => parseSignerInfo(der, t));

  return { version, digestAlgorithms, eContentType, eContent, certificates, crls, signerInfos };
}

function parseSignerInfo(der, tlv) {
  const parts = children(der, tlv);
  let idx = 0;

  const version = der[parts[idx].start]; idx++;

  // sid: issuerAndSerialNumber (SEQUENCE) veya subjectKeyIdentifier ([0])
  const sidTlv = parts[idx]; idx++;
  let issuerDer = null, serial = null, ski = null;
  if (sidTlv.tag === 0x30) {
    const sidParts = children(der, sidTlv);
    issuerDer = der.slice(sidParts[0].start - sidParts[0].hdr, sidParts[0].end);
    serial = der.slice(sidParts[1].start, sidParts[1].end);
  } else if (sidTlv.tag === 0x80) {
    ski = der.slice(sidTlv.start, sidTlv.end);
  }

  const digestAlgTlv = parts[idx]; idx++;
  const digestOid = oidFromBytes(
    der.slice(readTLV(der, digestAlgTlv.start).start, readTLV(der, digestAlgTlv.start).end)
  );

  let signedAttrs = null;
  let signedAttrsDer = null;
  if (parts[idx] && parts[idx].tag === 0xA0) {
    const t = parts[idx];
    // İmza doğrulamasında [0] IMPLICIT yerine SET OF kodlaması kullanılır
    const body = der.slice(t.start, t.end);
    signedAttrsDer = Buffer.concat([Buffer.from([0x31]), encodeLength(body.length), body]);
    signedAttrs = parseAttributes(der, t);
    idx++;
  }

  const sigAlgTlv = parts[idx]; idx++;
  const sigAlgOid = oidFromBytes(
    der.slice(readTLV(der, sigAlgTlv.start).start, readTLV(der, sigAlgTlv.start).end)
  );

  const sigTlv = parts[idx]; idx++;
  const signature = der.slice(sigTlv.start, sigTlv.end);

  let unsignedAttrs = null;
  if (parts[idx] && parts[idx].tag === 0xA1) {
    unsignedAttrs = parseAttributes(der, parts[idx]);
  }

  return {
    version, issuerDer, serial, ski,
    digestAlgorithm: DIGEST_BY_OID[digestOid] || digestOid,
    digestOid,
    signedAttrs, signedAttrsDer,
    signatureAlgorithm: SIG_ALG_BY_OID[sigAlgOid] || { type: 'unknown', oid: sigAlgOid },
    sigAlgOid,
    signature,
    unsignedAttrs
  };
}

/** Attribute SET'ini { oid: [değerDER] } haritasına çevirir. */
function parseAttributes(der, tlv) {
  const map = {};
  for (const attr of children(der, tlv)) {
    const parts = children(der, attr);
    if (!parts.length) continue;
    const oid = oidFromBytes(der.slice(parts[0].start, parts[0].end));
    const values = parts[1] ? children(der, parts[1]).map((v) => der.slice(v.start - v.hdr, v.end)) : [];
    map[oid] = values;
  }
  return map;
}

function encodeLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  let hex = len.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const b = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.from([0x80 | b.length]), b]);
}

/**
 * SignerInfo'yu doğrular.
 *
 * @param {Object} signerInfo parseSignerInfo çıktısı
 * @param {Buffer} signerCertDer İmzalayan sertifika
 * @param {Buffer} contentDigest İmzalanan içeriğin özeti (detached: ByteRange özeti)
 * @returns {{ signatureValid:boolean, messageDigestMatches:boolean|null,
 *             contentTypeValid:boolean|null, signingCertificateValid:boolean|null,
 *             errors:string[] }}
 */
/**
 * @param {Object} signerInfo
 * @param {Buffer} signerCertDer
 * @param {Buffer|null} contentDigest
 * @param {string} [expectedContentType] beklenen `content-type` özniteliği.
 *   Belge imzalarında `id-data`, RFC 3161 zaman damgalarında `id-ct-TSTInfo`
 *   olmalıdır. Sabit `id-data` varsaymak, zaman damgalarında bu kontrolü
 *   anlamsız bir hataya çevirir ve gerçekten yanlış türde bir jetonu
 *   ayırt edilemez kılar.
 */
function verifySignerInfo(signerInfo, signerCertDer, contentDigest,
                          expectedContentType = OIDS.data) {
  const result = {
    signedAttrsPresent: !!signerInfo.signedAttrs,
    signatureValid: false,
    messageDigestMatches: null,
    contentTypeValid: null,
    signingCertificateValid: null,
    signingCertificatePresent: false,
    signingTime: null,
    errors: []
  };

  // 0. signedAttrs'ın KENDİSİ zorunludur.
  //
  // Yoksa aşağıdaki üç kontrol de sessizce atlanır ve imza doğrudan belge
  // özetinin üzerine düşer. O noktada imza artık ne bir sertifikaya, ne bir
  // içerik türüne, ne de bir amaca bağlıdır: aynı anahtarla başka bir
  // protokolde üretilmiş ham bir imza (challenge-response, ham özet imzalayan
  // bir HSM ucu) doğrudan PDF'e taşınabilir. ISO 32000 ve ETSI EN 319 142-1
  // imzalı öznitelikleri zorunlu kılar.
  if (!signerInfo.signedAttrs) {
    result.errors.push('imzalı öznitelikler (signedAttrs) yok — ' +
      'imza belgeye değil yalnız ham özete bağlı (RFC 5652 §5.3, ETSI EN 319 142-1)');
  }

  // 1. message-digest özniteliği içerik özetiyle eşleşmeli
  if (signerInfo.signedAttrs) {
    const mdValues = signerInfo.signedAttrs[OIDS.messageDigest];
    if (!mdValues || !mdValues.length) {
      result.errors.push('message-digest imzalı özniteliği yok (RFC 5652 zorunlu kılar)');
      result.messageDigestMatches = false;
    } else {
      const t = readTLV(mdValues[0], 0);
      const attrDigest = mdValues[0].slice(t.start, t.end);
      result.messageDigestMatches = contentDigest ? attrDigest.equals(contentDigest) : null;
      if (result.messageDigestMatches === false) {
        result.errors.push('message-digest, belge özetiyle eşleşmiyor — içerik değiştirilmiş olabilir');
      }
    }

    // 2. content-type özniteliği
    const ctValues = signerInfo.signedAttrs[OIDS.contentType];
    if (!ctValues || !ctValues.length) {
      result.contentTypeValid = false;
      result.errors.push('content-type imzalı özniteliği yok');
    } else {
      const t = readTLV(ctValues[0], 0);
      const oid = oidFromBytes(ctValues[0].slice(t.start, t.end));
      result.contentTypeValid = (oid === expectedContentType);
      if (!result.contentTypeValid) {
        result.errors.push(
          `content-type beklenmedik: ${oid} (beklenen ${expectedContentType})`);
      }
    }

    // 3. signing-certificate-v2 (ESS) — imzalayan sertifikayı bağlar
    const scValues = signerInfo.signedAttrs[OIDS.signingCertificateV2] ||
                     signerInfo.signedAttrs[OIDS.signingCertificate];
    if (scValues && scValues.length) {
      result.signingCertificatePresent = true;
      result.signingCertificateValid = verifySigningCertificate(scValues[0], signerCertDer);
      if (!result.signingCertificateValid) {
        result.errors.push('signing-certificate-v2 özeti, imzalayan sertifikayla eşleşmiyor');
      }
    } else {
      result.signingCertificateValid = false;
      result.errors.push('signing-certificate-v2 özniteliği yok (PAdES bunu zorunlu kılar)');
    }

    // 4. signing-time (bilgi amaçlı — güvenilir zaman TST'dedir)
    const stValues = signerInfo.signedAttrs[OIDS.signingTime];
    if (stValues && stValues.length) {
      try { result.signingTime = parseAsn1Time(stValues[0]); } catch { /* okunamadı */ }
    }
  }

  // 5. Asıl imza doğrulaması
  const toVerify = signerInfo.signedAttrsDer || contentDigest;
  if (!toVerify) {
    result.errors.push('imzalanacak veri bulunamadı');
    return result;
  }

  try {
    const x509 = new crypto.X509Certificate(signerCertDer);
    const alg = signerInfo.signatureAlgorithm;
    const hash = alg.hash || signerInfo.digestAlgorithm || 'sha256';

    if (alg.type === 'rsa-pss') {
      result.signatureValid = crypto.verify(
        hash, toVerify, { key: x509.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING },
        signerInfo.signature
      );
    } else {
      const verifier = crypto.createVerify(hash);
      verifier.update(toVerify);
      verifier.end();
      result.signatureValid = verifier.verify(x509.publicKey, signerInfo.signature);
    }
    if (!result.signatureValid) result.errors.push('CMS imzası doğrulanamadı');
  } catch (err) {
    result.errors.push(`imza doğrulama hatası: ${err.message}`);
  }

  return result;
}

/** ESSCertIDv2 özetini imzalayan sertifikayla karşılaştırır. */
function verifySigningCertificate(attrDer, certDer) {
  try {
    // SigningCertificateV2 ::= SEQUENCE { certs SEQUENCE OF ESSCertIDv2 }
    const outer = readTLV(attrDer, 0);
    const certsSeq = readTLV(attrDer, outer.start);
    const first = readTLV(attrDer, certsSeq.start);
    const parts = children(attrDer, first);

    let hashName = 'sha256';
    let hashIdx = 0;
    if (parts[0] && parts[0].tag === 0x30) {
      const algOid = readTLV(attrDer, parts[0].start);
      hashName = DIGEST_BY_OID[oidFromBytes(attrDer.slice(algOid.start, algOid.end))] || 'sha256';
      hashIdx = 1;
    }
    const hashTlv = parts[hashIdx];
    if (!hashTlv || hashTlv.tag !== 0x04) return false;
    const expected = attrDer.slice(hashTlv.start, hashTlv.end);
    const actual = crypto.createHash(hashName).update(certDer).digest();
    return expected.equals(actual);
  } catch {
    return false;
  }
}

function parseAsn1Time(der) {
  const t = readTLV(der, 0);
  const s = der.slice(t.start, t.end).toString('latin1');
  let year, rest;
  if (t.tag === 0x17) {
    const yy = parseInt(s.slice(0, 2), 10);
    year = yy >= 50 ? 1900 + yy : 2000 + yy;
    rest = s.slice(2);
  } else {
    year = parseInt(s.slice(0, 4), 10);
    rest = s.slice(4);
  }
  return new Date(Date.UTC(
    year, parseInt(rest.slice(0, 2), 10) - 1, parseInt(rest.slice(2, 4), 10),
    parseInt(rest.slice(4, 6), 10), parseInt(rest.slice(6, 8), 10),
    parseInt(rest.slice(8, 10), 10) || 0
  ));
}

/** SignerInfo'nun sid alanına uyan sertifikayı havuzdan bulur. */
function findSignerCertificate(signerInfo, certificates) {
  const { getIssuerDer, getSerial, extractSKI, getSubjectDer } = require('@fitfak/pades/src/cades/x509_ext');

  for (const cert of certificates) {
    try {
      if (signerInfo.ski) {
        const ski = extractSKI(cert);
        if (ski && ski.equals(signerInfo.ski)) return cert;
        continue;
      }
      if (!signerInfo.issuerDer || !signerInfo.serial) continue;
      const issuer = getIssuerDer(cert);
      const serial = getSerial(cert);
      const wanted = stripLeadingZeros(signerInfo.serial);
      if (issuer.equals(signerInfo.issuerDer) && stripLeadingZeros(serial).equals(wanted)) {
        return cert;
      }
    } catch { /* bozuk sertifika atlanır */ }
  }
  return null;
}

function stripLeadingZeros(buf) {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  return buf.slice(i);
}

/** İmzasız özniteliklerden zaman damgası jetonlarını çıkarır. */
function extractTimestampTokens(signerInfo) {
  if (!signerInfo.unsignedAttrs) return [];
  const values = signerInfo.unsignedAttrs[OIDS.signatureTimeStampToken];
  return values || [];
}

module.exports = {
  OIDS, DIGEST_BY_OID, SIG_ALG_BY_OID,
  parseSignedData, parseSignerInfo, verifySignerInfo, verifySigningCertificate,
  findSignerCertificate, extractTimestampTokens, parseAsn1Time, children
};
