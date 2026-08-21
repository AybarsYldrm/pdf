'use strict';
/**
 * OCSP yanıtı ayrıştırma ve DOĞRULAMA — RFC 6960.
 *
 * TEHDİT: Önceki kod, DSS'teki bir yanıtı sertifikayla eşleştirmek için
 *
 *     der.includes(serial)
 *
 * kullanıyordu. Bu bir doğrulama değil, rastlantı aramasıdır:
 *
 *   • Seri numarası baytları yanıtın HERHANGİ bir yerinde (üretici adında,
 *     imza değerinin içinde, uzantı verisinde) geçebilir.
 *   • Saldırgan, iptal edilmiş sertifikasının seri numarasını içeren ama
 *     BAŞKA bir sertifika için "good" diyen gerçek bir OCSP yanıtı gömebilir.
 *     Kısa seri numaralarında bu rastlantıyla bile olur.
 *   • Yanıtın imzası hiç doğrulanmıyordu: elle uydurulmuş bir DER yeterliydi.
 *   • "revoked" tespiti seri numarasından sonraki baytın 0xA1 olmasına
 *     bakıyordu — DER'de bu bayt her yerde geçebilir.
 *
 * Sonuç: **iptal edilmiş bir sertifika geçerli görünüyordu.** LTV'nin tüm
 * amacı budur; dolayısıyla bu bir doğrulama atlatmasıdır.
 *
 * BURADAKİ YAKLAŞIM — her adım açıkça:
 *
 *     OCSPResponse
 *       ├── responseStatus            (successful değilse yanıt yok)
 *       └── ResponseBytes
 *            └── BasicOCSPResponse
 *                 ├── tbsResponseData ──┬── version
 *                 │                     ├── responderID  (byName | byKey)
 *                 │                     ├── producedAt
 *                 │                     └── responses[]
 *                 │                          └── SingleResponse
 *                 │                               ├── CertID
 *                 │                               │    ├── hashAlgorithm
 *                 │                               │    ├── issuerNameHash
 *                 │                               │    ├── issuerKeyHash
 *                 │                               │    └── serialNumber
 *                 │                               ├── certStatus
 *                 │                               ├── thisUpdate
 *                 │                               └── nextUpdate
 *                 ├── signatureAlgorithm
 *                 ├── signature          ← tbsResponseData üzerinde doğrulanır
 *                 └── certs[]            ← yanıtlayan sertifikası
 *
 * CertID eşleşmesi HESAPLANIR: issuerNameHash ve issuerKeyHash, yanıtın
 * bildirdiği hash algoritmasıyla ihraç eden sertifikadan yeniden üretilir ve
 * karşılaştırılır. Yani "bu yanıt gerçekten bu sertifika için mi?" sorusu
 * kriptografik olarak cevaplanır.
 */

const crypto = require('crypto');
const { readTLV, oidFromBytes } = require('@fitfak/pades/src/cades/x509_extract');
const ext = require('@fitfak/pades/src/cades/x509_ext');

/** OCSP yanıt durumları (RFC 6960 §4.2.1). */
const RESPONSE_STATUS = {
  0: 'successful', 1: 'malformedRequest', 2: 'internalError',
  3: 'tryLater', 5: 'sigRequired', 6: 'unauthorized'
};

const HASH_BY_OID = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512'
};

const SIG_ALG_BY_OID = {
  '1.2.840.113549.1.1.5': { hash: 'sha1', type: 'rsa' },
  '1.2.840.113549.1.1.11': { hash: 'sha256', type: 'rsa' },
  '1.2.840.113549.1.1.12': { hash: 'sha384', type: 'rsa' },
  '1.2.840.113549.1.1.13': { hash: 'sha512', type: 'rsa' },
  '1.2.840.10045.4.3.2': { hash: 'sha256', type: 'ec' },
  '1.2.840.10045.4.3.3': { hash: 'sha384', type: 'ec' },
  '1.2.840.10045.4.3.4': { hash: 'sha512', type: 'ec' }
};

const OID_OCSP_SIGNING = '1.3.6.1.5.5.7.3.9';
const OID_OCSP_NOCHECK = '1.3.6.1.5.5.7.48.1.5';

/** Sınırlar — saldırgan denetimindeki yanıtlar için. */
const LIMITS = { maxResponses: 512, maxCerts: 32, maxBytes: 2 * 1024 * 1024 };

class OcspError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OcspError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Ayrıştırma                                                          */
/* ------------------------------------------------------------------ */

/**
 * OCSP yanıtını ayrıştırır.
 *
 * Girdi hem tam `OCSPResponse` hem de çıplak `BasicOCSPResponse` olabilir:
 * DSS'e her iki biçim de gömülebiliyor.
 *
 * @param {Buffer} der
 * @returns {{ responseStatus: string, producedAt: Date|null, responderId: Object,
 *             responses: Array, certs: Buffer[], tbs: Buffer,
 *             signatureAlgorithm: string, signature: Buffer }}
 */
function parseOcspResponse(der) {
  if (!Buffer.isBuffer(der) || der.length < 8) {
    throw new OcspError('ERR_OCSP_EMPTY', 'OCSP yanıtı boş ya da çok kısa');
  }
  if (der.length > LIMITS.maxBytes) {
    throw new OcspError('ERR_OCSP_TOO_LARGE', `OCSP yanıtı çok büyük: ${der.length} bayt`);
  }

  const outer = readTLV(der, 0);
  if (outer.tag !== 0x30) throw new OcspError('ERR_OCSP_MALFORMED', 'OCSP: SEQUENCE bekleniyordu');

  let basicDer = null;
  let responseStatus = 'successful';

  const first = readTLV(der, outer.start);
  if (first.tag === 0x0A) {
    // Tam OCSPResponse: responseStatus ENUMERATED
    const statusValue = der[first.start];
    responseStatus = RESPONSE_STATUS[statusValue] || `unknown(${statusValue})`;
    if (statusValue !== 0) {
      return { responseStatus, responses: [], certs: [], producedAt: null };
    }

    const explicit = readTLV(der, first.next);          // [0] EXPLICIT ResponseBytes
    if ((explicit.tag & 0xE0) !== 0xA0) {
      throw new OcspError('ERR_OCSP_MALFORMED', 'OCSP: ResponseBytes yok');
    }
    const responseBytes = readTLV(der, explicit.start);  // SEQUENCE
    const typeTlv = readTLV(der, responseBytes.start);
    const responseType = oidFromBytes(der.subarray(typeTlv.start, typeTlv.end));
    if (responseType !== '1.3.6.1.5.5.7.48.1.1') {
      throw new OcspError('ERR_OCSP_TYPE', `Desteklenmeyen OCSP yanıt türü: ${responseType}`);
    }
    const octet = readTLV(der, typeTlv.next);
    basicDer = Buffer.from(der.subarray(octet.start, octet.end));
  } else {
    // Çıplak BasicOCSPResponse
    basicDer = Buffer.from(der);
  }

  return { responseStatus, ...parseBasic(basicDer) };
}

/** BasicOCSPResponse ::= SEQUENCE { tbsResponseData, signatureAlgorithm, signature, certs [0]? } */
function parseBasic(der) {
  const outer = readTLV(der, 0);
  if (outer.tag !== 0x30) throw new OcspError('ERR_OCSP_MALFORMED', 'BasicOCSPResponse bozuk');

  const tbsTlv = readTLV(der, outer.start);
  const tbs = Buffer.from(der.subarray(tbsTlv.hdr ? tbsTlv.start - tbsTlv.hdr : 0, tbsTlv.end));

  const algTlv = readTLV(der, tbsTlv.next);
  const algOidTlv = readTLV(der, algTlv.start);
  const signatureAlgorithm = oidFromBytes(der.subarray(algOidTlv.start, algOidTlv.end));

  const sigTlv = readTLV(der, algTlv.next);
  // BIT STRING: ilk bayt kullanılmayan bit sayısı
  const signature = Buffer.from(der.subarray(sigTlv.start + 1, sigTlv.end));

  const certs = [];
  if (sigTlv.next < outer.end) {
    const certsTag = readTLV(der, sigTlv.next);
    if ((certsTag.tag & 0xE0) === 0xA0) {
      const seq = readTLV(der, certsTag.start);
      let p = seq.start;
      while (p < seq.end && certs.length < LIMITS.maxCerts) {
        const c = readTLV(der, p);
        certs.push(Buffer.from(der.subarray(p, c.end)));
        p = c.next;
      }
    }
  }

  return { ...parseResponseData(der, tbsTlv), tbs, signatureAlgorithm, signature, certs };
}

/**
 * ResponseData ::= SEQUENCE {
 *   version [0] EXPLICIT DEFAULT v1, responderID, producedAt,
 *   responses SEQUENCE OF SingleResponse, responseExtensions [1] EXPLICIT? }
 */
function parseResponseData(der, tbsTlv) {
  let p = tbsTlv.start;
  let node = readTLV(der, p);

  let version = 0;
  if ((node.tag & 0xE0) === 0xA0 && (node.tag & 0x1F) === 0) {
    const v = readTLV(der, node.start);
    version = der[v.start] || 0;
    p = node.next;
    node = readTLV(der, p);
  }

  // responderID ::= CHOICE { byName [1] Name, byKey [2] KeyHash }
  const responderId = { byName: null, byKey: null };
  if ((node.tag & 0x1F) === 1) {
    // [1] EXPLICIT Name → içindeki RDNSequence'in TAM TLV'si
    const inner = readTLV(der, node.start);
    responderId.byName = Buffer.from(der.subarray(node.start, inner.end));
  } else if ((node.tag & 0x1F) === 2) {
    const inner = readTLV(der, node.start);          // OCTET STRING
    responderId.byKey = Buffer.from(der.subarray(inner.start, inner.end));
  }
  p = node.next;

  const producedAtTlv = readTLV(der, p);
  const producedAt = parseAsn1Time(der.subarray(producedAtTlv.start, producedAtTlv.end), producedAtTlv.tag);
  p = producedAtTlv.next;

  const responsesSeq = readTLV(der, p);
  const responses = [];
  let q = responsesSeq.start;
  while (q < responsesSeq.end && responses.length < LIMITS.maxResponses) {
    const single = readTLV(der, q);
    responses.push(parseSingleResponse(der, single));
    q = single.next;
  }

  return { version, responderId, producedAt, responses };
}

/**
 * SingleResponse ::= SEQUENCE {
 *   certID, certStatus, thisUpdate, nextUpdate [0] EXPLICIT?, singleExtensions [1]? }
 */
function parseSingleResponse(der, single) {
  let p = single.start;

  const certIdTlv = readTLV(der, p);
  const certId = parseCertId(der, certIdTlv);
  p = certIdTlv.next;

  const statusTlv = readTLV(der, p);
  const tagNo = statusTlv.tag & 0x1F;
  let status = 'unknown';
  let revocationTime = null;
  let revocationReason = null;

  if ((statusTlv.tag & 0xE0) === 0x80 || (statusTlv.tag & 0xE0) === 0xA0) {
    if (tagNo === 0) status = 'good';
    else if (tagNo === 1) {
      status = 'revoked';
      // RevokedInfo ::= SEQUENCE { revocationTime GeneralizedTime,
      //                            revocationReason [0] EXPLICIT CRLReason? }
      try {
        const timeTlv = readTLV(der, statusTlv.start);
        revocationTime = parseAsn1Time(der.subarray(timeTlv.start, timeTlv.end), timeTlv.tag);
        if (timeTlv.next < statusTlv.end) {
          const reasonWrap = readTLV(der, timeTlv.next);
          const reasonTlv = readTLV(der, reasonWrap.start);
          revocationReason = der[reasonTlv.start];
        }
      } catch { /* RevokedInfo okunamadı; iptal bilgisi yine geçerli */ }
    }
    else status = 'unknown';
  }
  p = statusTlv.next;

  const thisUpdateTlv = readTLV(der, p);
  const thisUpdate = parseAsn1Time(der.subarray(thisUpdateTlv.start, thisUpdateTlv.end), thisUpdateTlv.tag);
  p = thisUpdateTlv.next;

  let nextUpdate = null;
  if (p < single.end) {
    const maybe = readTLV(der, p);
    if ((maybe.tag & 0xE0) === 0xA0 && (maybe.tag & 0x1F) === 0) {
      const t = readTLV(der, maybe.start);
      nextUpdate = parseAsn1Time(der.subarray(t.start, t.end), t.tag);
    }
  }

  return { certId, status, revocationTime, revocationReason, thisUpdate, nextUpdate };
}

/**
 * CertID ::= SEQUENCE { hashAlgorithm AlgorithmIdentifier,
 *   issuerNameHash OCTET STRING, issuerKeyHash OCTET STRING, serialNumber INTEGER }
 */
function parseCertId(der, node) {
  let p = node.start;

  const algSeq = readTLV(der, p);
  const algOid = readTLV(der, algSeq.start);
  const hashOid = oidFromBytes(der.subarray(algOid.start, algOid.end));
  p = algSeq.next;

  const nameHashTlv = readTLV(der, p);
  const issuerNameHash = Buffer.from(der.subarray(nameHashTlv.start, nameHashTlv.end));
  p = nameHashTlv.next;

  const keyHashTlv = readTLV(der, p);
  const issuerKeyHash = Buffer.from(der.subarray(keyHashTlv.start, keyHashTlv.end));
  p = keyHashTlv.next;

  const serialTlv = readTLV(der, p);
  const serialNumber = Buffer.from(der.subarray(serialTlv.start, serialTlv.end));

  return {
    hashAlgorithm: HASH_BY_OID[hashOid] || null,
    hashOid,
    issuerNameHash,
    issuerKeyHash,
    serialNumber
  };
}

/* ------------------------------------------------------------------ */
/* Doğrulama                                                           */
/* ------------------------------------------------------------------ */

/**
 * Bir OCSP yanıtının belirli bir sertifika için GEÇERLİ olup olmadığını
 * kriptografik olarak belirler.
 *
 * @param {Buffer} responseDer OCSPResponse ya da BasicOCSPResponse
 * @param {Buffer} certDer     durumu sorulan sertifika
 * @param {Buffer} issuerDer   onu ihraç eden sertifika
 * @param {{ at?: Date, extraCerts?: Buffer[], requireSignature?: boolean,
 *           maxAgeMs?: number }} [opts]
 * @returns {{ matched: boolean, status: string|null, signatureValid: boolean,
 *             responderAuthorized: boolean, timeValid: boolean,
 *             producedAt: Date|null, thisUpdate: Date|null, nextUpdate: Date|null,
 *             revocationTime: Date|null, revocationReason: number|null,
 *             errors: string[], warnings: string[] }}
 */
function verifyOcspResponse(responseDer, certDer, issuerDer, opts = {}) {
  const at = opts.at instanceof Date ? opts.at : new Date();
  const out = {
    matched: false, status: null, signatureValid: false,
    responderAuthorized: false, timeValid: false,
    producedAt: null, thisUpdate: null, nextUpdate: null,
    revocationTime: null, revocationReason: null,
    errors: [], warnings: []
  };

  let parsed;
  try {
    parsed = parseOcspResponse(responseDer);
  } catch (err) {
    out.errors.push(`OCSP yanıtı ayrıştırılamadı: ${err.message}`);
    return out;
  }

  if (parsed.responseStatus !== 'successful') {
    out.errors.push(`OCSP yanıt durumu: ${parsed.responseStatus}`);
    return out;
  }

  /* --- 1. CertID eşleşmesi: yanıt GERÇEKTEN bu sertifika için mi? --- */
  const single = findMatchingResponse(parsed.responses, certDer, issuerDer);
  if (!single) {
    out.errors.push('Yanıtta bu sertifikaya ait CertID yok ' +
      '(issuerNameHash/issuerKeyHash/serialNumber eşleşmedi)');
    return out;
  }

  out.matched = true;
  out.status = single.status;
  out.thisUpdate = single.thisUpdate;
  out.nextUpdate = single.nextUpdate;
  out.producedAt = parsed.producedAt;
  out.revocationTime = single.revocationTime;
  out.revocationReason = single.revocationReason;

  /* --- 2. İmza: yanıtı kim üretti? --------------------------------- */
  const pool = [...(parsed.certs || []), ...(opts.extraCerts || []), issuerDer];
  const responder = findResponderCert(parsed, pool, issuerDer);

  if (!responder) {
    out.errors.push('OCSP yanıtlayan sertifikası bulunamadı');
  } else {
    out.signatureValid = verifySignature(parsed, responder);
    if (!out.signatureValid) out.errors.push('OCSP yanıtının imzası doğrulanamadı');

    /* --- 3. Yetki: bu yanıtlayan bu CA adına konuşabilir mi? ------- */
    const auth = checkResponderAuthorization(responder, issuerDer);
    out.responderAuthorized = auth.authorized;
    out.responderCn = auth.cn;
    if (!auth.authorized) out.errors.push(auth.reason);
    for (const w of auth.warnings) out.warnings.push(w);
  }

  /* --- 4. Zaman geçerliliği ---------------------------------------- */
  out.timeValid = checkTimes(single, at, opts, out);

  return out;
}

/**
 * Yanıtlardan CertID'si eşleşeni bulur.
 *
 * Eşleşme HESAPLANIR: yanıtın bildirdiği hash algoritmasıyla ihraç edenin
 * adı ve açık anahtarı yeniden özetlenip karşılaştırılır. Böylece "seri
 * numarası bir yerlerde geçiyor" gibi rastlantısal eşleşmeler imkânsızdır.
 */
function findMatchingResponse(responses, certDer, issuerDer) {
  const serial = normalizeSerial(ext.getSerial(certDer));
  const issuerSubject = ext.getSubjectDer(issuerDer);
  const issuerSpki = subjectPublicKeyBits(issuerDer);

  for (const single of responses) {
    const id = single.certId;
    if (!id.hashAlgorithm) continue;                      // bilinmeyen özet

    if (!normalizeSerial(id.serialNumber).equals(serial)) continue;

    if (!issuerSubject || !issuerSpki) continue;
    const nameHash = crypto.createHash(id.hashAlgorithm).update(issuerSubject).digest();
    if (!nameHash.equals(id.issuerNameHash)) continue;

    const keyHash = crypto.createHash(id.hashAlgorithm).update(issuerSpki).digest();
    if (!keyHash.equals(id.issuerKeyHash)) continue;

    return single;
  }
  return null;
}

/** Yanıtlayan sertifikasını responderID'ye göre seçer. */
function findResponderCert(parsed, pool, issuerDer) {
  const { byName, byKey } = parsed.responderId || {};

  for (const cert of pool) {
    if (!cert || !cert.length) continue;
    try {
      if (byName) {
        const subject = ext.getSubjectDer(cert);
        if (subject && subject.equals(byName)) return cert;
      } else if (byKey) {
        const spki = subjectPublicKeyBits(cert);
        if (spki && crypto.createHash('sha1').update(spki).digest().equals(byKey)) return cert;
      }
    } catch { /* bozuk sertifika: atla */ }
  }

  // responderID okunamadıysa imzayı havuzdaki adaylarla dene
  for (const cert of pool) {
    if (cert && verifySignature(parsed, cert)) return cert;
  }
  return null;
}

/**
 * RFC 6960 §4.2.2.2 — yanıtlayan yalnız şu durumlarda yetkilidir:
 *   a) CA'nın kendisidir, ya da
 *   b) CA tarafından ihraç edilmiş ve id-kp-OCSPSigning EKU taşıyan bir
 *      "delege yanıtlayan"dır.
 *
 * Bu kontrol olmadan, herhangi bir geçerli sertifikayla imzalanmış bir yanıt
 * kabul edilirdi.
 */
function checkResponderAuthorization(responderDer, issuerDer) {
  const warnings = [];
  let cn = null;
  try { cn = require('@fitfak/pades/src/cades/x509_extract').extractSubjectCN(responderDer); } catch {}

  // (a) CA'nın kendisi
  if (responderDer.equals(issuerDer)) {
    return { authorized: true, cn, reason: null, warnings };
  }

  // (b) Delege yanıtlayan.
  //
  // "İhraç edilmiş" bir isim eşleşmesi DEĞİL, bir imzadır. Yalnız isme
  // bakıldığında saldırgan şunu yapabiliyordu: Issuer alanına CA'nın DN'sini
  // yazdığı, id-kp-OCSPSigning EKU'su taşıyan KENDİ sertifikasını üretir,
  // onunla "good" yanıtı imzalar ve yanıtın içine koyar. Havuz saldırgandan
  // geldiği için sertifika oradadır, isim eşleşir, EKU vardır — ve iptal
  // edilmiş bir sertifika geçerli görünür.
  if (!ext.isIssuerOf(responderDer, issuerDer) ||
      ext.verifiesAsIssuer(responderDer, issuerDer) !== true) {
    return {
      authorized: false, cn, warnings,
      reason: 'OCSP yanıtlayanı ne CA\'nın kendisi ne de CA tarafından ' +
        'imzalanmış bir delege (RFC 6960 §4.2.2.2)'
    };
  }

  let eku = [];
  try {
    eku = require('@fitfak/pades/src/cades/x509_extract').parseKeyUsageAndEKU(responderDer).eku || [];
  } catch { /* okunamadı */ }

  if (!eku.includes(OID_OCSP_SIGNING)) {
    return {
      authorized: false, cn, warnings,
      reason: 'Delege OCSP yanıtlayanında id-kp-OCSPSigning EKU yok (RFC 6960 §4.2.2.2)'
    };
  }

  // id-pkix-ocsp-nocheck yoksa yanıtlayanın kendi iptal durumu sorgulanmalıdır
  if (!hasExtension(responderDer, OID_OCSP_NOCHECK)) {
    warnings.push('Yanıtlayan sertifikasında id-pkix-ocsp-nocheck yok; ' +
      'kendi iptal durumu ayrıca denetlenmeli');
  }

  return { authorized: true, cn, reason: null, warnings };
}

/** BasicOCSPResponse imzasını yanıtlayan sertifikasıyla doğrular. */
function verifySignature(parsed, responderDer) {
  const spec = SIG_ALG_BY_OID[parsed.signatureAlgorithm];
  if (!spec || !parsed.tbs || !parsed.signature) return false;

  try {
    const publicKey = crypto.createPublicKey({
      key: ext.derToPem(responderDer, 'CERTIFICATE'), format: 'pem'
    });
    const verifier = crypto.createVerify(spec.hash);
    verifier.update(parsed.tbs);
    verifier.end();

    return spec.type === 'ec'
      ? verifier.verify({ key: publicKey, dsaEncoding: 'der' }, parsed.signature)
      : verifier.verify(publicKey, parsed.signature);
  } catch {
    return false;
  }
}

/** thisUpdate ≤ doğrulama zamanı ≤ nextUpdate. */
function checkTimes(single, at, opts, out) {
  const skewMs = 5 * 60 * 1000;                    // saat kayması payı

  if (single.thisUpdate && single.thisUpdate.getTime() - skewMs > at.getTime()) {
    out.errors.push(`OCSP yanıtı gelecekte üretilmiş (thisUpdate ${single.thisUpdate.toISOString()})`);
    return false;
  }
  if (single.nextUpdate && single.nextUpdate.getTime() + skewMs < at.getTime()) {
    out.errors.push(`OCSP yanıtı süresi dolmuş (nextUpdate ${single.nextUpdate.toISOString()})`);
    return false;
  }
  if (!single.nextUpdate) {
    // nextUpdate yoksa yanıt "her zaman taze" sayılamaz
    const maxAge = opts.maxAgeMs || 0;
    if (maxAge && single.thisUpdate && at.getTime() - single.thisUpdate.getTime() > maxAge) {
      out.errors.push('OCSP yanıtında nextUpdate yok ve yanıt çok eski');
      return false;
    }
    out.warnings.push('OCSP yanıtında nextUpdate alanı yok');
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                         */
/* ------------------------------------------------------------------ */

/** Sertifikanın SubjectPublicKeyInfo içindeki BIT STRING içeriğini döndürür. */
function subjectPublicKeyBits(certDer) {
  try {
    const cert = readTLV(certDer, 0);
    const tbs = readTLV(certDer, cert.start);

    let p = tbs.start;
    let node = readTLV(certDer, p);
    if ((node.tag & 0xE0) === 0xA0) { p = node.next; node = readTLV(certDer, p); }  // version

    p = node.next;                                   // serialNumber
    node = readTLV(certDer, p); p = node.next;       // signature
    node = readTLV(certDer, p); p = node.next;       // issuer
    node = readTLV(certDer, p); p = node.next;       // validity
    node = readTLV(certDer, p); p = node.next;       // subject

    const spki = readTLV(certDer, p);                // SubjectPublicKeyInfo
    const algSeq = readTLV(certDer, spki.start);
    const bitString = readTLV(certDer, algSeq.next);
    // İlk bayt kullanılmayan bit sayısıdır; hash ondan SONRAKİ baytlar üzerinedir
    return Buffer.from(certDer.subarray(bitString.start + 1, bitString.end));
  } catch {
    return null;
  }
}

/** Sertifikada verilen OID'li uzantı var mı? */
function hasExtension(certDer, oid) {
  try {
    for (const e of ext.parseExtensions ? ext.parseExtensions(certDer) : []) {
      if (e.oid === oid) return true;
    }
  } catch { /* yoksay */ }
  return false;
}

/** Baştaki sıfır baytlarını atar — DER INTEGER'da işaret dolgusu olabilir. */
function normalizeSerial(buf) {
  if (!buf || !buf.length) return Buffer.alloc(0);
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0x00) i++;
  return Buffer.from(buf.subarray(i));
}

/** UTCTime / GeneralizedTime → Date. */
function parseAsn1Time(bytes, tag) {
  const text = Buffer.from(bytes).toString('ascii').trim();
  try {
    if (tag === 0x17) {
      // YYMMDDHHMMSSZ — RFC 5280: 50 ve üstü 19xx, altı 20xx
      const yy = parseInt(text.slice(0, 2), 10);
      const year = yy >= 50 ? 1900 + yy : 2000 + yy;
      return isoDate(year, text.slice(2));
    }
    if (tag === 0x18) {
      return isoDate(parseInt(text.slice(0, 4), 10), text.slice(4));
    }
  } catch { /* düşer */ }
  return null;
}

function isoDate(year, rest) {
  const n = (at, len) => parseInt(rest.slice(at, at + len), 10) || 0;
  const d = new Date(Date.UTC(year, n(0, 2) - 1, n(2, 2), n(4, 2), n(6, 2), n(8, 2)));
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = {
  parseOcspResponse, verifyOcspResponse, findMatchingResponse,
  checkResponderAuthorization, subjectPublicKeyBits, normalizeSerial,
  OcspError, RESPONSE_STATUS, LIMITS
};
