'use strict';
const crypto = require('crypto');
const { pkiFetch } = require('@fitfak/netguard');
const { DER } = require('./asn1_der');
const { readTLV, oidFromBytes, parseCertBasics } = require('./x509_extract');

// --- OID sabitleri (OCSP, RFC 6960) ---
const OCSP_OIDS = {
  sha1: '1.3.14.3.2.26',
  basicOCSPResponse: '1.3.6.1.5.5.7.48.1.1',
  pkixOcspNonce: '1.3.6.1.5.5.7.48.1.2'
};

/** Bir sertifikanın TBSCertificate'ından subject Name (tam DER, tag+len dahil) ve
 *  subjectPublicKey BIT STRING içeriğini (tag/len hariç, "unused bits" baytı dahil) çıkarır. */
function extractSubjectAndSPKI(certDer) {
  const outer = readTLV(certDer, 0); // Certificate ::= SEQUENCE { tbsCertificate, ... }
  let p = outer.start; // tbsCertificate'in TLV başlangıcı (tag dahil)
  const tbs = readTLV(certDer, p); // tbsCertificate SEQUENCE
  p = tbs.start; // tbsCertificate içeriği: version?/serial/sigAlg/issuer/validity/subject/spki...
  let v = readTLV(certDer, p);
  if (v.tag === 0xA0) p = v.next; // version
  p = readTLV(certDer, p).next; // serial
  p = readTLV(certDer, p).next; // signature alg
  p = readTLV(certDer, p).next; // issuer
  p = readTLV(certDer, p).next; // validity
  const subject = readTLV(certDer, p);
  const subjectFullDER = certDer.slice(subject.start - subject.hdr, subject.end);
  p = subject.next;
  const spki = readTLV(certDer, p);
  const spkiAlg = readTLV(certDer, spki.start);
  const spkiKeyBits = readTLV(certDer, spkiAlg.next); // BIT STRING
  // "unused bits" sayacı baytını (ilk bayt) HARİÇ TUT - gerçek dünyadaki OCSP responder'lar
  // (OpenSSL dahil) issuerKeyHash'i salt anahtar bitleri üzerinden hesaplıyor.
  const keyBitsContent = certDer.slice(spkiKeyBits.start + 1, spkiKeyBits.end);
  return { subjectFullDER, keyBitsContent };
}

/** RFC 6960 CertID + tek istekli OCSPRequest DER'i üretir (imzasız, uzantısız - en yaygın uyumlu biçim). */
function buildOCSPRequest(certDer, issuerCertDer, hashName = 'sha1') {
  const { subjectFullDER: issuerNameDer, keyBitsContent } = extractSubjectAndSPKI(issuerCertDer);
  const { serialContent } = parseCertBasics(certDer);

  const issuerNameHash = crypto.createHash(hashName).update(issuerNameDer).digest();
  const issuerKeyHash = crypto.createHash(hashName).update(keyBitsContent).digest();
  const hashOid = hashName === 'sha1' ? OCSP_OIDS.sha1 : (() => { throw new Error('Desteklenmeyen hash: ' + hashName); })();

  const certID = DER.seq(
    DER.algo(hashOid, true),
    DER.octet(issuerNameHash),
    DER.octet(issuerKeyHash),
    DER.intFromBuf(serialContent)
  );
  const request = DER.seq(certID); // Request ::= SEQUENCE { reqCert CertID }
  const requestList = DER.seq(request); // SEQUENCE OF Request
  const tbsRequest = DER.seq(requestList); // TBSRequest ::= SEQUENCE { requestList ... } (version/requestorName/ext atlandı)
  const ocspRequest = DER.seq(tbsRequest); // OCSPRequest ::= SEQUENCE { tbsRequest ... }
  return ocspRequest;
}

/** OCSP yanıtı için üst sınır — bir "durum bildirimi" megabaytlarca olmaz. */
const OCSP_MAX_BYTES = 1024 * 1024;
const OCSP_TIMEOUT_MS = 15_000;

/**
 * OCSP isteğini HTTP POST ile gönderir (application/ocsp-request), ham DER
 * yanıtı döner.
 *
 * ADRES SALDIRGANDAN GELİR: AIA uzantısındaki OCSP URL'ini imzalayan değil,
 * sertifikayı üreten yazar. Eski sürüm bu adrese hiçbir denetim yapmadan
 * istek atıyordu — ne şema kontrolü, ne özel ağ engeli, ne boyut sınırı, ne
 * de ZAMAN AŞIMI vardı: yavaş yanıt veren bir uç doğrulamayı süresiz
 * bekletebiliyordu.
 *
 * @param {string} ocspUrl
 * @param {Buffer} ocspReqDer
 * @param {Object} [extraHeaders]
 * @param {Object} [netOpts] `pkiFetch` seçenekleri (timeoutMs, allowHosts…)
 */
async function requestOCSP(ocspUrl, ocspReqDer, extraHeaders = {}, netOpts = {}) {
  const res = await pkiFetch(ocspUrl, {
    method: 'POST',
    body: ocspReqDer,
    timeoutMs: netOpts.timeoutMs || OCSP_TIMEOUT_MS,
    maxBytes: netOpts.maxBytes || OCSP_MAX_BYTES,
    headers: {
      'Content-Type': 'application/ocsp-request',
      Accept: 'application/ocsp-response',
      ...extraHeaders
    },
    allowHosts: netOpts.allowHosts,
    denyHosts: netOpts.denyHosts,
    lookup: netOpts.lookup,
    allowPrivate: netOpts.allowPrivate === true || netOpts.allowPrivateNetwork === true
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`OCSP HTTP ${res.status}`);
  }
  return res.body;
}

const RESPONSE_STATUS_NAMES = ['successful', 'malformedRequest', 'internalError', 'tryLater', '(unused)', 'sigRequired', 'unauthorized'];

/** OCSPResponse DER'ini ayrıştırır: durum, BasicOCSPResponse (ham DER, DSS'e gömmek için), certStatus, thisUpdate/nextUpdate. */
function parseOCSPResponse(ocspRespDer) {
  const outer = readTLV(ocspRespDer, 0); // OCSPResponse SEQUENCE
  const statusTlv = readTLV(ocspRespDer, outer.start); // ENUMERATED
  const statusVal = ocspRespDer[statusTlv.start] || 0;
  const statusName = RESPONSE_STATUS_NAMES[statusVal] || `unknown(${statusVal})`;

  if (statusVal !== 0) {
    return { responseStatus: statusName, ok: false };
  }

  const respBytes = readTLV(ocspRespDer, statusTlv.next); // [0] EXPLICIT ResponseBytes
  const rb = readTLV(ocspRespDer, respBytes.start); // ResponseBytes SEQUENCE
  let p = rb.start;
  const respTypeTlv = readTLV(ocspRespDer, p);
  const responseType = oidFromBytes(ocspRespDer.slice(respTypeTlv.start, respTypeTlv.end));
  p = respTypeTlv.next;
  const respOctet = readTLV(ocspRespDer, p); // OCTET STRING wrapping BasicOCSPResponse
  const basicResponseDer = Buffer.from(ocspRespDer.slice(respOctet.start, respOctet.end));

  // BasicOCSPResponse içinden certStatus / thisUpdate / nextUpdate çıkar (bilgi amaçlı)
  let parsed = { responseStatus: statusName, ok: true, responseType, basicResponseDer };
  try {
    const basicOuter = readTLV(basicResponseDer, 0); // BasicOCSPResponse SEQUENCE
    const tbsResponseData = readTLV(basicResponseDer, basicOuter.start); // ResponseData SEQUENCE
    let q = tbsResponseData.start;
    let maybe = readTLV(basicResponseDer, q);
    if ((maybe.tag & 0xE0) === 0xA0 && (maybe.tag & 0x1F) === 0) { q = maybe.next; maybe = readTLV(basicResponseDer, q); } // version
    // responderID: CHOICE [1] byName / [2] byKey
    q = maybe.next; // responderID'yi atla
    const producedAt = readTLV(basicResponseDer, q); q = producedAt.next;
    const responses = readTLV(basicResponseDer, q); // SEQUENCE OF SingleResponse
    const single = readTLV(basicResponseDer, responses.start);
    let r = single.start;
    r = readTLV(basicResponseDer, r).next; // certID atla
    const certStatusTlv = readTLV(basicResponseDer, r);
    const certStatusTagNo = certStatusTlv.tag & 0x1F;
    const certStatus = certStatusTagNo === 0 ? 'good' : certStatusTagNo === 1 ? 'revoked' : 'unknown';
    r = certStatusTlv.next;
    const thisUpdateTlv = readTLV(basicResponseDer, r);
    const thisUpdate = basicResponseDer.slice(thisUpdateTlv.start, thisUpdateTlv.end).toString('ascii');
    parsed.certStatus = certStatus;
    parsed.thisUpdate = thisUpdate;
  } catch (e) {
    parsed.parseWarning = 'BasicOCSPResponse ayrıntıları ayrıştırılamadı: ' + e.message;
  }
  return parsed;
}

/** Yüksek seviye yardımcı: verilen sertifika + ihraç eden (issuer) sertifikası için taze bir
 *  OCSP yanıtı alır. DSS'e gömülecek ham BasicOCSPResponse DER'ini ve durum bilgisini döner. */
async function fetchOCSPForCert(certPem, issuerPem, ocspUrl, opts = {}) {
  const { pemToDer } = require('./x509_extract');
  const certDer = pemToDer(certPem);
  const issuerDer = pemToDer(issuerPem);
  const reqDer = buildOCSPRequest(certDer, issuerDer, opts.hashName || 'sha1');
  const respDer = await requestOCSP(ocspUrl, reqDer, opts.headers || {}, opts);
  const parsed = parseOCSPResponse(respDer);
  if (!parsed.ok) {
    throw new Error('OCSP responder hata döndürdü: ' + parsed.responseStatus);
  }
  return parsed; // { responseStatus, basicResponseDer, certStatus, thisUpdate, ... }
}

module.exports = { buildOCSPRequest, requestOCSP, parseOCSPResponse, fetchOCSPForCert };