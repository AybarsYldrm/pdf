'use strict';
/**
 * İptal (revocation) kanıtı toplayıcısı.
 *
 * Bir sertifika yolundaki her sertifika için OCSP ve/veya CRL kanıtı toplar,
 * DOĞRULAR ve DSS'e gömülmeye hazır DER blokları döndürür.
 *
 * Tasarım kuralı: doğrulanamayan bir kanıt asla döndürülmez. LTV'nin tüm değeri,
 * belgeye gömülen verinin güvenilir olmasından gelir.
 */

const { fetchOCSPForCert } = require('./ocsp');
const { fetchAndCheckCrl, CrlError } = require('./crl');
const {
  extractAIA, extractCDP, isSelfSigned, getSubjectDer, derToPem, collectCertificates
} = require('./x509_ext');
const { pemToDer } = require('./x509_extract');

/**
 * OCSP yanıtını Adobe'un beklediği tam OCSPResponse zarfına sarar (RFC 6960).
 * Yanıt zaten tam biçimdeyse dokunulmaz.
 */
function wrapToFullOCSPResponse(basicDer) {
  if (basicDer[0] === 0x30 && basicDer.indexOf(Buffer.from([0x0A, 0x01])) !== -1) {
    return basicDer;
  }
  const encodeLen = (len) => {
    if (len < 128) return Buffer.from([len]);
    let hex = len.toString(16);
    if (hex.length % 2 !== 0) hex = '0' + hex;
    const buf = Buffer.from(hex, 'hex');
    return Buffer.concat([Buffer.from([0x80 | buf.length]), buf]);
  };
  const status = Buffer.from([0x0A, 0x01, 0x00]);                        // successful(0)
  const basicOid = Buffer.from([0x06, 0x09, 0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x01, 0x01]);
  const responseOctet = Buffer.concat([
    Buffer.concat([Buffer.from([0x04]), encodeLen(basicDer.length)]), basicDer
  ]);
  const seqBytes = Buffer.concat([basicOid, responseOctet]);
  const responseBytesSeq = Buffer.concat([
    Buffer.concat([Buffer.from([0x30]), encodeLen(seqBytes.length)]), seqBytes
  ]);
  const explicitTag0 = Buffer.concat([
    Buffer.concat([Buffer.from([0xA0]), encodeLen(responseBytesSeq.length)]), responseBytesSeq
  ]);
  const outerBytes = Buffer.concat([status, explicitTag0]);
  return Buffer.concat([
    Buffer.concat([Buffer.from([0x30]), encodeLen(outerBytes.length)]), outerBytes
  ]);
}

/**
 * Tek bir sertifika için iptal kanıtı toplar.
 *
 * @param {Buffer} certDer
 * @param {Buffer} issuerDer
 * @param {Object} opts
 * @param {'ocsp-first'|'crl-first'|'ocsp-only'|'crl-only'|'both'} [opts.prefer='ocsp-first']
 * @param {string} [opts.ocspUrl] Verilmezse AIA'dan okunur
 * @param {string} [opts.crlUrl]  Verilmezse CDP'den okunur
 * @param {Date}   [opts.validationTime]
 * @param {Object} [opts.headers]
 * @returns {Promise<{ ocspDer: Buffer|null, crlDer: Buffer|null,
 *                     status: 'good'|'revoked'|'unknown',
 *                     sources: Array, errors: Array, extraCerts: Buffer[] }>}
 */
async function collectForCertificate(certDer, issuerDer, opts = {}) {
  const prefer = opts.prefer || 'ocsp-first';
  const out = {
    ocspDer: null, crlDer: null, status: 'unknown',
    sources: [], errors: [], extraCerts: []
  };

  const aiaUrls = opts.ocspUrl ? [opts.ocspUrl] : extractAIA(certDer).ocsp;
  const cdpUrls = opts.crlUrl ? [opts.crlUrl] : extractCDP(certDer).http;

  const wantOcsp = prefer !== 'crl-only' && aiaUrls.length > 0;
  const wantCrl  = prefer !== 'ocsp-only' && cdpUrls.length > 0;

  const tryOcsp = async () => {
    if (!wantOcsp || out.ocspDer) return;
    const certPem = derToPem(certDer);
    const issuerPem = derToPem(issuerDer);
    for (const url of aiaUrls) {
      try {
        const res = await fetchOCSPForCert(certPem, issuerPem, url, { headers: opts.headers || {} });
        if (res.certStatus === 'revoked') {
          out.status = 'revoked';
          out.sources.push({ type: 'ocsp', url, status: 'revoked' });
          return;
        }
        if (res.certStatus !== 'good') {
          out.errors.push({ type: 'ocsp', url, message: `certStatus=${res.certStatus}` });
          continue;
        }
        const full = wrapToFullOCSPResponse(res.basicResponseDer);
        out.ocspDer = full;
        out.status = 'good';
        out.sources.push({ type: 'ocsp', url, status: 'good', producedAt: res.producedAt || null });
        // OCSP yanıtlayıcı sertifikası da zincire ve DSS'e girmelidir
        collectCertificates(full, out.extraCerts);
        return;
      } catch (err) {
        out.errors.push({ type: 'ocsp', url, message: err.message, code: err.code });
      }
    }
  };

  const tryCrl = async () => {
    if (!wantCrl || out.crlDer) return;
    for (const url of cdpUrls) {
      try {
        const res = await fetchAndCheckCrl(certDer, issuerDer, url, {
          validationTime: opts.validationTime,
          headers: opts.headers,
          timeoutMs: opts.timeoutMs
        });
        if (res.status === 'revoked') {
          out.status = 'revoked';
          out.sources.push({ type: 'crl', url, status: 'revoked', reason: res.reason });
          return;
        }
        out.crlDer = res.der;
        if (out.status !== 'revoked') out.status = 'good';
        out.sources.push({
          type: 'crl', url, status: 'good',
          thisUpdate: res.thisUpdate, nextUpdate: res.nextUpdate
        });
        return;
      } catch (err) {
        out.errors.push({ type: 'crl', url, message: err.message, code: err.code });
      }
    }
  };

  if (prefer === 'crl-first' || prefer === 'crl-only') {
    await tryCrl();
    if (prefer === 'crl-first' && out.status !== 'good' && out.status !== 'revoked') await tryOcsp();
    if (prefer === 'crl-first' && opts.both) await tryOcsp();
  } else if (prefer === 'both') {
    await tryOcsp();
    await tryCrl();
  } else {
    await tryOcsp();
    if (out.status !== 'good' && out.status !== 'revoked') await tryCrl();
  }

  return out;
}

/**
 * Bir sertifika YOLUNUN tamamı için iptal kanıtı toplar.
 * Kök (kendinden imzalı) sertifika için kanıt aranmaz — güven çıpasıdır.
 *
 * @param {Buffer[]} path leaf → … → kök sıralı sertifika yolu
 * @param {Object} opts collectForCertificate seçenekleri + { strict?: boolean }
 * @returns {Promise<{ ocspsDer: Buffer[], crlsDer: Buffer[], certsDer: Buffer[],
 *                     entries: Array, complete: boolean, revoked: boolean }>}
 */
async function collectForPath(path, opts = {}) {
  const result = {
    ocspsDer: [], crlsDer: [], certsDer: [], entries: [],
    complete: true, revoked: false
  };
  const seenOcsp = new Set();
  const seenCrl = new Set();

  for (let i = 0; i < path.length; i++) {
    const cert = path[i];
    if (isSelfSigned(cert)) {
      result.entries.push({ index: i, role: 'trust-anchor', status: 'not-required', sources: [] });
      continue;
    }
    const issuer = path[i + 1];
    if (!issuer) {
      result.complete = false;
      result.entries.push({
        index: i, role: 'unknown-issuer', status: 'unknown', sources: [],
        errors: [{ message: 'Yol tamamlanmadı: issuer sertifikası bulunamadı' }]
      });
      continue;
    }

    const got = await collectForCertificate(cert, issuer, opts);
    if (got.ocspDer) {
      const k = got.ocspDer.toString('base64');
      if (!seenOcsp.has(k)) { seenOcsp.add(k); result.ocspsDer.push(got.ocspDer); }
    }
    if (got.crlDer) {
      const k = got.crlDer.toString('base64');
      if (!seenCrl.has(k)) { seenCrl.add(k); result.crlsDer.push(got.crlDer); }
    }
    for (const extra of got.extraCerts) result.certsDer.push(extra);

    if (got.status === 'revoked') result.revoked = true;
    if (got.status !== 'good') result.complete = false;

    result.entries.push({
      index: i,
      role: i === 0 ? 'leaf' : 'ca',
      status: got.status,
      sources: got.sources,
      errors: got.errors
    });
  }

  return result;
}

module.exports = {
  wrapToFullOCSPResponse,
  collectForCertificate,
  collectForPath
};
