'use strict';
/**
 * CRL (Certificate Revocation List) indirme, ayrıştırma ve DOĞRULAMA.
 *
 * LTV için kritik: doğrulanmamış bir CRL'i DSS'e gömmek, belgeye güvenilmez veri
 * koymak demektir. Bu modül gömülmeden önce şunları kontrol eder:
 *   - CRL'i gerçekten beklenen issuer mı imzalamış (kriptografik doğrulama),
 *   - issuer adı sertifikanın issuer'ı ile eşleşiyor mu,
 *   - thisUpdate ≤ doğrulama zamanı ≤ nextUpdate,
 *   - sertifikanın seri numarası iptal listesinde mi.
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const { readTLV, oidFromBytes, pemToDer } = require('./x509_extract');
const { getIssuerDer, getSerial, extractCDP, extractAKI, extractSKI } = require('./x509_ext');

const SIG_ALG_TO_HASH = {
  '1.2.840.113549.1.1.5':  { hash: 'sha1',   type: 'rsa' },
  '1.2.840.113549.1.1.11': { hash: 'sha256', type: 'rsa' },
  '1.2.840.113549.1.1.12': { hash: 'sha384', type: 'rsa' },
  '1.2.840.113549.1.1.13': { hash: 'sha512', type: 'rsa' },
  '1.2.840.113549.1.1.10': { hash: null,     type: 'rsa-pss' },
  '1.2.840.10045.4.1':     { hash: 'sha1',   type: 'ec' },
  '1.2.840.10045.4.3.2':   { hash: 'sha256', type: 'ec' },
  '1.2.840.10045.4.3.3':   { hash: 'sha384', type: 'ec' },
  '1.2.840.10045.4.3.4':   { hash: 'sha512', type: 'ec' }
};

const CRL_REASONS = [
  'unspecified', 'keyCompromise', 'cACompromise', 'affiliationChanged',
  'superseded', 'cessationOfOperation', 'certificateHold', 'unknown',
  'removeFromCRL', 'privilegeWithdrawn', 'aACompromise'
];

class CrlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CrlError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* İndirme                                                              */
/* ------------------------------------------------------------------ */

/**
 * Bir CDP adresinden CRL indirir. DER veya PEM kabul eder, DER döndürür.
 * @param {string} url
 * @param {{ timeoutMs?: number, maxBytes?: number, headers?: Object }} [opts]
 * @returns {Promise<Buffer>}
 */
function fetchCrl(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || 15000;
  const maxBytes = opts.maxBytes || 8 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch {
      return reject(new CrlError('ERR_CRL_BAD_URL', `Geçersiz CRL adresi: ${url}`));
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return reject(new CrlError('ERR_CRL_UNSUPPORTED_SCHEME',
        `Desteklenmeyen CRL şeması: ${u.protocol} (yalnız http/https)`));
    }

    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.get(u, {
      timeout: timeoutMs,
      headers: { Accept: 'application/pkix-crl, application/x-pkcs7-crl, */*', ...(opts.headers || {}) }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new CrlError('ERR_CRL_HTTP', `CRL indirilemedi: HTTP ${res.statusCode} (${url})`));
      }
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > maxBytes) {
          req.destroy();
          return reject(new CrlError('ERR_CRL_TOO_LARGE', `CRL boyut sınırını aştı (${maxBytes} bayt)`));
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(normalizeCrlBuffer(buf));
      });
    });
    req.on('error', (err) => reject(new CrlError('ERR_CRL_NETWORK', `CRL isteği başarısız: ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new CrlError('ERR_CRL_TIMEOUT', `CRL isteği zaman aşımına uğradı (${timeoutMs} ms)`));
    });
  });
}

/** PEM ise DER'e çevirir, zaten DER ise dokunmaz. */
function normalizeCrlBuffer(buf) {
  if (buf.length && buf[0] === 0x30) return buf;
  const text = buf.toString('latin1');
  const m = /-----BEGIN X509 CRL-----([\s\S]*?)-----END X509 CRL-----/.exec(text);
  if (m) return Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  throw new CrlError('ERR_CRL_BAD_FORMAT', 'CRL ne DER ne de PEM biçiminde');
}

/* ------------------------------------------------------------------ */
/* Ayrıştırma                                                           */
/* ------------------------------------------------------------------ */

function parseAsn1Time(buf, tag) {
  const s = buf.toString('latin1');
  let year, rest;
  if (tag === 0x17) { // UTCTime YYMMDDHHMMSSZ
    const yy = parseInt(s.slice(0, 2), 10);
    year = yy >= 50 ? 1900 + yy : 2000 + yy;
    rest = s.slice(2);
  } else { // GeneralizedTime YYYYMMDDHHMMSSZ
    year = parseInt(s.slice(0, 4), 10);
    rest = s.slice(4);
  }
  const mo = parseInt(rest.slice(0, 2), 10) - 1;
  const d  = parseInt(rest.slice(2, 4), 10);
  const h  = parseInt(rest.slice(4, 6), 10);
  const mi = parseInt(rest.slice(6, 8), 10);
  const se = parseInt(rest.slice(8, 10), 10) || 0;
  return new Date(Date.UTC(year, mo, d, h, mi, se));
}

/**
 * CertificateList'i ayrıştırır.
 *
 * CertificateList ::= SEQUENCE {
 *   tbsCertList          TBSCertList,
 *   signatureAlgorithm   AlgorithmIdentifier,
 *   signatureValue       BIT STRING }
 *
 * @param {Buffer} crlDer
 */
function parseCrl(crlDer) {
  const outer = readTLV(crlDer, 0);
  if (outer.tag !== 0x30) throw new CrlError('ERR_CRL_PARSE', 'CRL: dış SEQUENCE yok');

  const tbs = readTLV(crlDer, outer.start);
  if (tbs.tag !== 0x30) throw new CrlError('ERR_CRL_PARSE', 'CRL: tbsCertList yok');
  const tbsDer = crlDer.slice(tbs.start - tbs.hdr, tbs.end);

  const sigAlgSeq = readTLV(crlDer, tbs.next);
  const sigAlgOidTlv = readTLV(crlDer, sigAlgSeq.start);
  const sigAlgOid = oidFromBytes(crlDer.slice(sigAlgOidTlv.start, sigAlgOidTlv.end));

  const sigBits = readTLV(crlDer, sigAlgSeq.next);
  if (sigBits.tag !== 0x03) throw new CrlError('ERR_CRL_PARSE', 'CRL: signatureValue yok');
  const signature = crlDer.slice(sigBits.start + 1, sigBits.end); // unused-bits baytını atla

  // ── TBSCertList içi ──
  let p = tbs.start;
  let version = 1;
  let t = readTLV(crlDer, p);
  if (t.tag === 0x02) { // version (v2 → 1)
    version = crlDer[t.start] + 1;
    p = t.next;
    t = readTLV(crlDer, p);
  }
  // signature AlgorithmIdentifier
  p = t.next;
  const issuer = readTLV(crlDer, p);
  const issuerDer = crlDer.slice(issuer.start - issuer.hdr, issuer.end);
  p = issuer.next;

  const thisUpdateTlv = readTLV(crlDer, p);
  const thisUpdate = parseAsn1Time(crlDer.slice(thisUpdateTlv.start, thisUpdateTlv.end), thisUpdateTlv.tag);
  p = thisUpdateTlv.next;

  let nextUpdate = null;
  let revoked = new Map();
  let crlNumber = null;
  let deltaIndicator = null;

  if (p < tbs.end) {
    const maybeNext = readTLV(crlDer, p);
    if (maybeNext.tag === 0x17 || maybeNext.tag === 0x18) {
      nextUpdate = parseAsn1Time(crlDer.slice(maybeNext.start, maybeNext.end), maybeNext.tag);
      p = maybeNext.next;
    }
  }

  while (p < tbs.end) {
    const node = readTLV(crlDer, p);
    if (node.next <= p) break;

    if (node.tag === 0x30) {
      // revokedCertificates
      let q = node.start;
      while (q < node.end) {
        const entry = readTLV(crlDer, q);
        if (entry.next <= q) break;
        let r = entry.start;
        const serialTlv = readTLV(crlDer, r);
        const serialHex = crlDer.slice(serialTlv.start, serialTlv.end).toString('hex').replace(/^0+/, '') || '0';
        r = serialTlv.next;
        const dateTlv = readTLV(crlDer, r);
        const revocationDate = parseAsn1Time(crlDer.slice(dateTlv.start, dateTlv.end), dateTlv.tag);
        r = dateTlv.next;

        let reason = 0;
        if (r < entry.end) {
          const extsSeq = readTLV(crlDer, r);
          if (extsSeq.tag === 0x30) {
            let s = extsSeq.start;
            while (s < extsSeq.end) {
              const ex = readTLV(crlDer, s);
              if (ex.next <= s) break;
              const oTlv = readTLV(crlDer, ex.start);
              const oid = oidFromBytes(crlDer.slice(oTlv.start, oTlv.end));
              if (oid === '2.5.29.21') { // reasonCode
                let z = oTlv.next;
                let mb = readTLV(crlDer, z);
                if (mb.tag === 0x01) { z = mb.next; mb = readTLV(crlDer, z); }
                if (mb.tag === 0x04) {
                  const en = readTLV(crlDer, mb.start);
                  if (en.tag === 0x0A) reason = crlDer[en.start];
                }
              }
              s = ex.next;
            }
          }
        }
        revoked.set(serialHex, { reason, reasonName: CRL_REASONS[reason] || 'unknown', revocationDate });
        q = entry.next;
      }
    } else if (node.tag === 0xA0) {
      // crlExtensions
      const seq = readTLV(crlDer, node.start);
      if (seq.tag === 0x30) {
        let s = seq.start;
        while (s < seq.end) {
          const ex = readTLV(crlDer, s);
          if (ex.next <= s) break;
          const oTlv = readTLV(crlDer, ex.start);
          const oid = oidFromBytes(crlDer.slice(oTlv.start, oTlv.end));
          let z = oTlv.next;
          let mb = readTLV(crlDer, z);
          if (mb.tag === 0x01) { z = mb.next; mb = readTLV(crlDer, z); }
          if (mb.tag === 0x04) {
            const val = crlDer.slice(mb.start, mb.end);
            if (oid === '2.5.29.20') { // cRLNumber
              try {
                const i = readTLV(val, 0);
                crlNumber = val.slice(i.start, i.end).toString('hex');
              } catch { /* yoksay */ }
            } else if (oid === '2.5.29.27') { // deltaCRLIndicator
              deltaIndicator = true;
            }
          }
          s = ex.next;
        }
      }
    }
    p = node.next;
  }

  return {
    version, issuerDer, thisUpdate, nextUpdate, revoked,
    crlNumber, isDelta: !!deltaIndicator,
    sigAlgOid, signature, tbsDer, der: crlDer
  };
}

/* ------------------------------------------------------------------ */
/* Doğrulama                                                            */
/* ------------------------------------------------------------------ */

/**
 * CRL imzasını issuer sertifikasına karşı doğrular.
 * @param {ReturnType<typeof parseCrl>} crl
 * @param {Buffer} issuerCertDer
 */
function verifyCrlSignature(crl, issuerCertDer) {
  const algo = SIG_ALG_TO_HASH[crl.sigAlgOid];
  if (!algo) {
    throw new CrlError('ERR_CRL_UNSUPPORTED_ALG',
      `CRL imza algoritması desteklenmiyor: ${crl.sigAlgOid}`);
  }
  if (algo.type === 'rsa-pss') {
    throw new CrlError('ERR_CRL_UNSUPPORTED_ALG', 'CRL için RSASSA-PSS henüz desteklenmiyor');
  }

  const x509 = new crypto.X509Certificate(issuerCertDer);
  const verifier = crypto.createVerify(algo.hash);
  verifier.update(crl.tbsDer);
  verifier.end();
  return verifier.verify(x509.publicKey, crl.signature);
}

/**
 * Bir sertifikanın iptal durumunu CRL'e göre belirler ve CRL'i tam olarak doğrular.
 *
 * @param {Buffer|string} certPemOrDer
 * @param {Buffer|string} issuerPemOrDer
 * @param {Buffer} crlDer
 * @param {{ validationTime?: Date, requireNextUpdate?: boolean, toleranceMs?: number }} [opts]
 * @returns {{ status:'good'|'revoked', reason?:string, revocationDate?:Date,
 *             thisUpdate:Date, nextUpdate:Date|null, crlNumber:string|null, der:Buffer }}
 */
function checkCrl(certPemOrDer, issuerPemOrDer, crlDer, opts = {}) {
  const certDer = Buffer.isBuffer(certPemOrDer) ? certPemOrDer : pemToDer(certPemOrDer);
  const issuerDer = Buffer.isBuffer(issuerPemOrDer) ? issuerPemOrDer : pemToDer(issuerPemOrDer);
  const now = opts.validationTime || new Date();
  const tolerance = opts.toleranceMs !== undefined ? opts.toleranceMs : 5 * 60 * 1000;

  const crl = parseCrl(crlDer);

  if (crl.isDelta) {
    throw new CrlError('ERR_CRL_DELTA_UNSUPPORTED',
      'Delta CRL doğrudan kullanılamaz; tam CRL gereklidir');
  }

  // 1. Issuer adı, sertifikanın issuer'ı ile eşleşmeli
  const certIssuer = getIssuerDer(certDer);
  if (!certIssuer.equals(crl.issuerDer)) {
    throw new CrlError('ERR_CRL_ISSUER_MISMATCH',
      'CRL issuer adı sertifikanın issuer adıyla eşleşmiyor');
  }

  // 2. AKI/SKI tutarlılığı (varsa)
  const aki = extractAKI(certDer);
  const ski = extractSKI(issuerDer);
  if (aki.keyId && ski && !aki.keyId.equals(ski)) {
    throw new CrlError('ERR_CRL_ISSUER_KEY_MISMATCH',
      'CRL issuer sertifikası, sertifikanın AKI değeriyle uyuşmuyor');
  }

  // 3. Kriptografik imza doğrulaması
  if (!verifyCrlSignature(crl, issuerDer)) {
    throw new CrlError('ERR_CRL_BAD_SIGNATURE', 'CRL imzası doğrulanamadı');
  }

  // 4. Geçerlilik penceresi
  if (crl.thisUpdate.getTime() - tolerance > now.getTime()) {
    throw new CrlError('ERR_CRL_NOT_YET_VALID',
      `CRL henüz geçerli değil (thisUpdate=${crl.thisUpdate.toISOString()})`);
  }
  if (crl.nextUpdate) {
    if (crl.nextUpdate.getTime() + tolerance < now.getTime()) {
      throw new CrlError('ERR_CRL_EXPIRED',
        `CRL süresi dolmuş (nextUpdate=${crl.nextUpdate.toISOString()})`);
    }
  } else if (opts.requireNextUpdate) {
    throw new CrlError('ERR_CRL_NO_NEXT_UPDATE', 'CRL nextUpdate alanı taşımıyor');
  }

  // 5. Seri numarası araması
  const serialHex = getSerial(certDer).toString('hex').replace(/^0+/, '') || '0';
  const hit = crl.revoked.get(serialHex);

  const base = {
    thisUpdate: crl.thisUpdate,
    nextUpdate: crl.nextUpdate,
    crlNumber: crl.crlNumber,
    der: crl.der
  };

  if (hit && hit.reason !== 8 /* removeFromCRL */) {
    return { status: 'revoked', reason: hit.reasonName, revocationDate: hit.revocationDate, ...base };
  }
  return { status: 'good', ...base };
}

/**
 * Sertifikanın CDP'sinden CRL'i bulur, indirir, doğrular.
 *
 * @param {Buffer|string} certPemOrDer
 * @param {Buffer|string} issuerPemOrDer
 * @param {string} [url] Verilmezse CDP uzantısından okunur
 * @param {Object} [opts] fetchCrl + checkCrl seçenekleri
 */
async function fetchAndCheckCrl(certPemOrDer, issuerPemOrDer, url = null, opts = {}) {
  const certDer = Buffer.isBuffer(certPemOrDer) ? certPemOrDer : pemToDer(certPemOrDer);

  let urls = url ? [url] : extractCDP(certDer).http;
  if (!urls.length) {
    throw new CrlError('ERR_CRL_NO_CDP', 'Sertifikada HTTP CRL dağıtım noktası yok');
  }

  let lastErr = null;
  for (const u of urls) {
    try {
      const der = await fetchCrl(u, opts);
      const result = checkCrl(certDer, issuerPemOrDer, der, opts);
      return { ...result, url: u };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

module.exports = {
  CrlError,
  fetchCrl,
  parseCrl,
  checkCrl,
  fetchAndCheckCrl,
  verifyCrlSignature,
  normalizeCrlBuffer,
  CRL_REASONS
};
