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

/**
 * İŞLEYEBİLDİĞİMİZ CRL uzantıları.
 *
 * Listede olmayan bir KRİTİK uzantı, CRL'i anlamadığımız anlamına gelir ve
 * CRL reddedilir (RFC 5280 §6.3.3). Bu liste büyüdükçe daha çok CRL
 * kullanılabilir olur; kısa kalması güvenli taraftır.
 */
const KNOWN_CRL_EXTENSIONS = new Set([
  '2.5.29.20',   // cRLNumber
  '2.5.29.27',   // deltaCRLIndicator
  '2.5.29.28',   // issuingDistributionPoint
  '2.5.29.35',   // authorityKeyIdentifier
  '2.5.29.46',   // freshestCRL
  '2.5.29.55',   // expiredCertsOnCRL
  '1.3.6.1.5.5.7.1.1' // authorityInfoAccess
]);

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
  let baseCrlNumber = null;
  let idp = null;
  let freshestCrl = [];
  const extensions = [];

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
      let lastEntryIssuer = null;
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
        let invalidityDate = null;
        // DOLAYLI (indirect) CRL'lerde girdiler farklı ihraç edenlere ait
        // olabilir. `certificateIssuer` bir kez görüldükten sonra, aksi
        // belirtilene kadar SONRAKİ girdiler için de geçerlidir
        // (RFC 5280 §5.3.3) — bu yüzden döngü dışında taşınır.
        let entryIssuer = lastEntryIssuer;

        if (r < entry.end) {
          const extsSeq = readTLV(crlDer, r);
          if (extsSeq.tag === 0x30) {
            let s = extsSeq.start;
            while (s < extsSeq.end) {
              const ex = readTLV(crlDer, s);
              if (ex.next <= s) break;
              const oTlv = readTLV(crlDer, ex.start);
              const oid = oidFromBytes(crlDer.slice(oTlv.start, oTlv.end));
              let z = oTlv.next;
              let mb = readTLV(crlDer, z);
              if (mb.tag === 0x01) { z = mb.next; mb = readTLV(crlDer, z); }

              if (mb.tag === 0x04) {
                const val = crlDer.slice(mb.start, mb.end);
                if (oid === '2.5.29.21') {                  // reasonCode
                  const en = readTLV(val, 0);
                  if (en.tag === 0x0A) reason = val[en.start];
                } else if (oid === '2.5.29.24') {           // invalidityDate
                  try {
                    const d = readTLV(val, 0);
                    invalidityDate = parseAsn1Time(val.slice(d.start, d.end), d.tag);
                  } catch { /* okunamadı */ }
                } else if (oid === '2.5.29.29') {           // certificateIssuer
                  const names = collectDirectoryNames(val);
                  if (names.length) { entryIssuer = names[0]; lastEntryIssuer = entryIssuer; }
                }
              }
              s = ex.next;
            }
          }
        }
        revoked.set(serialHex, {
          reason, reasonName: CRL_REASONS[reason] || 'unknown',
          revocationDate, invalidityDate,
          certificateIssuer: entryIssuer
        });
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
          let critical = false;
          if (mb.tag === 0x01) { critical = crlDer[mb.start] !== 0; z = mb.next; mb = readTLV(crlDer, z); }
          if (mb.tag === 0x04) {
            const val = crlDer.slice(mb.start, mb.end);
            extensions.push({ oid, critical });

            if (oid === '2.5.29.20') {                    // cRLNumber
              crlNumber = readIntegerHex(val);
            } else if (oid === '2.5.29.27') {             // deltaCRLIndicator
              deltaIndicator = true;
              baseCrlNumber = readIntegerHex(val);
            } else if (oid === '2.5.29.28') {             // issuingDistributionPoint
              idp = parseIdp(val);
            } else if (oid === '2.5.29.46') {             // freshestCRL
              freshestCrl = parseDistributionPointUris(val);
            }
          }
          s = ex.next;
        }
      }
    }
    p = node.next;
  }

  /**
   * TANIMADIĞIMIZ KRİTİK UZANTI = CRL'i anlamıyoruz demektir.
   *
   * RFC 5280 §6.3.3: kritik bir uzantıyı işleyemiyorsak CRL kullanılamaz.
   * "Anlamadım ama devam edeyim" demek, kapsamı daraltan bir uzantıyı
   * görmezden gelip iptal edilmiş bir sertifikaya "temiz" demek olabilir.
   */
  const unknownCritical = extensions
    .filter((e) => e.critical && !KNOWN_CRL_EXTENSIONS.has(e.oid))
    .map((e) => e.oid);

  return {
    version, issuerDer, thisUpdate, nextUpdate, revoked,
    crlNumber, isDelta: !!deltaIndicator, baseCrlNumber,
    idp, freshestCrl, extensions, unknownCritical,
    sigAlgOid, signature, tbsDer, der: crlDer
  };
}

/** INTEGER değerini onaltılık dizgeye çevirir (başındaki sıfırlar atılır). */
function readIntegerHex(val) {
  try {
    const i = readTLV(val, 0);
    return val.slice(i.start, i.end).toString('hex').replace(/^0+(?=.)/, '');
  } catch {
    return null;
  }
}

/**
 * IssuingDistributionPoint (RFC 5280 §5.2.5).
 *
 *   IssuingDistributionPoint ::= SEQUENCE {
 *     distributionPoint          [0] DistributionPointName OPTIONAL,
 *     onlyContainsUserCerts      [1] BOOLEAN DEFAULT FALSE,
 *     onlyContainsCACerts        [2] BOOLEAN DEFAULT FALSE,
 *     onlySomeReasons            [3] ReasonFlags OPTIONAL,
 *     indirectCRL                [4] BOOLEAN DEFAULT FALSE,
 *     onlyContainsAttributeCerts [5] BOOLEAN DEFAULT FALSE }
 *
 * Bu uzantı CRL'in KAPSAMINI daraltır ve KRİTİKTİR. Görmezden gelmek,
 * "yalnız CA sertifikalarını içeren" bir listeye bakıp bir son kullanıcı
 * sertifikasına "iptal edilmemiş" demek olurdu.
 */
function parseIdp(val) {
  const out = {
    uris: [],
    onlyUserCerts: false,
    onlyCaCerts: false,
    onlyAttributeCerts: false,
    onlySomeReasons: null,
    indirect: false
  };

  let seq;
  try { seq = readTLV(val, 0); } catch { return out; }
  if (seq.tag !== 0x30) return out;

  let p = seq.start;
  while (p < seq.end) {
    const node = readTLV(val, p);
    if (node.next <= p) break;
    const tagNo = node.tag & 0x1f;
    const body = val.slice(node.start, node.end);

    switch (tagNo) {
      case 0: out.uris = collectGeneralNameUris(body); break;
      case 1: out.onlyUserCerts = body.length > 0 && body[0] !== 0; break;
      case 2: out.onlyCaCerts = body.length > 0 && body[0] !== 0; break;
      case 3: out.onlySomeReasons = decodeReasonFlags(body); break;
      case 4: out.indirect = body.length > 0 && body[0] !== 0; break;
      case 5: out.onlyAttributeCerts = body.length > 0 && body[0] !== 0; break;
      default: break;
    }
    p = node.next;
  }
  return out;
}

/** ReasonFlags BIT STRING → sebep adları. */
function decodeReasonFlags(body) {
  if (!body.length) return [];
  const unused = body[0];
  const bits = body.slice(1);
  const names = [
    'unused', 'keyCompromise', 'cACompromise', 'affiliationChanged',
    'superseded', 'cessationOfOperation', 'certificateHold',
    'privilegeWithdrawn', 'aACompromise'
  ];
  const out = [];
  const total = bits.length * 8 - unused;
  for (let i = 0; i < total && i < names.length; i++) {
    if (bits[i >> 3] & (0x80 >> (i & 7))) out.push(names[i]);
  }
  return out;
}

/** İç içe GeneralNames yapısından URI'leri (tag [6]) toplar. */
function collectGeneralNameUris(body, depth = 0) {
  const out = [];
  if (depth > 4) return out;
  let p = 0;
  while (p < body.length) {
    let node;
    try { node = readTLV(body, p); } catch { break; }
    if (node.next <= p) break;
    const tagNo = node.tag & 0x1f;
    const constructed = (node.tag & 0x20) !== 0;

    if (!constructed && tagNo === 6) {
      out.push(body.slice(node.start, node.end).toString('latin1'));
    } else if (constructed) {
      out.push(...collectGeneralNameUris(body.slice(node.start, node.end), depth + 1));
    }
    p = node.next;
  }
  return out;
}

/**
 * GeneralNames içindeki directoryName ([4]) girdilerinin ham DER'i.
 *
 * Dolaylı CRL girdilerinde "bu seri kimin?" sorusunun cevabı budur ve
 * BAYT olarak karşılaştırılır; ada dizge olarak bakmak kodlama
 * farklılıklarında yanlış eşleşme üretir.
 */
function collectDirectoryNames(val, depth = 0) {
  const out = [];
  if (depth > 4) return out;
  let p = 0;
  while (p < val.length) {
    let node;
    try { node = readTLV(val, p); } catch { break; }
    if (node.next <= p) break;
    const tagNo = node.tag & 0x1f;
    const constructed = (node.tag & 0x20) !== 0;

    if (constructed && tagNo === 4) {
      // [4] EXPLICIT Name — içindeki RDNSequence
      try {
        const inner = readTLV(val, node.start);
        out.push(val.slice(inner.start - inner.hdr, inner.end));
      } catch { /* bozuk */ }
    } else if (constructed && node.tag === 0x30) {
      out.push(...collectDirectoryNames(val.slice(node.start, node.end), depth + 1));
    }
    p = node.next;
  }
  return out;
}

/** freshestCRL / cRLDistributionPoints içindeki URI'ler. */
function parseDistributionPointUris(val) {
  try {
    const seq = readTLV(val, 0);
    return collectGeneralNameUris(val.slice(seq.start, seq.end));
  } catch {
    return [];
  }
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

  if (crl.isDelta && !opts.allowDelta) {
    throw new CrlError('ERR_CRL_DELTA_UNSUPPORTED',
      'Delta CRL tek başına kullanılamaz; taban CRL ile birlikte ' +
      'checkCrlWithDelta() kullanın');
  }

  // 0. Anlamadığımız kritik uzantı varsa CRL'i KULLANAMAYIZ (RFC 5280 §6.3.3)
  if (crl.unknownCritical.length) {
    throw new CrlError('ERR_CRL_UNKNOWN_CRITICAL_EXTENSION',
      `CRL tanınmayan kritik uzantı taşıyor: ${crl.unknownCritical.join(', ')}`);
  }

  // 1. Issuer adı eşleşmeli.
  //    DOLAYLI CRL'de liste başka bir otorite tarafından yayımlanır; o
  //    durumda ad eşleşmesi girdi düzeyinde (certificateIssuer) yapılır.
  const certIssuer = getIssuerDer(certDer);
  const indirect = !!(crl.idp && crl.idp.indirect);
  if (!indirect && !certIssuer.equals(crl.issuerDer)) {
    throw new CrlError('ERR_CRL_ISSUER_MISMATCH',
      'CRL issuer adı sertifikanın issuer adıyla eşleşmiyor');
  }

  // 2. AKI/SKI tutarlılığı (varsa)
  const aki = extractAKI(certDer);
  const ski = extractSKI(issuerDer);
  if (!indirect && aki.keyId && ski && !aki.keyId.equals(ski)) {
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

  // 5. KAPSAM: bu CRL bu sertifika hakkında konuşuyor mu? (RFC 5280 §5.2.5)
  const scope = checkScope(crl, certDer, opts);
  if (!scope.covers) {
    throw new CrlError('ERR_CRL_OUT_OF_SCOPE', scope.reason);
  }

  // 6. Seri numarası araması
  const serialHex = getSerial(certDer).toString('hex').replace(/^0+(?=.)/, '') || '0';
  const hit = crl.revoked.get(serialHex);

  const base = {
    thisUpdate: crl.thisUpdate,
    nextUpdate: crl.nextUpdate,
    crlNumber: crl.crlNumber,
    scope: {
      partialReasons: scope.partialReasons,
      coveredReasons: crl.idp && crl.idp.onlySomeReasons ? crl.idp.onlySomeReasons : null,
      indirect,
      complete: !scope.partialReasons
    },
    der: crl.der
  };

  if (hit) {
    // Dolaylı CRL'de girdi başka bir ihraç edene aitse bizim sertifikamız değildir
    if (indirect && hit.certificateIssuer && !hit.certificateIssuer.equals(certIssuer)) {
      return { status: 'good', ...base };
    }
    // `removeFromCRL` yalnız DELTA CRL'de anlamlıdır: tam listede bir
    // girdinin "kaldırıldı" demesi çelişkidir ve yok sayılmamalıdır.
    if (hit.reason === 8 && crl.isDelta) {
      return { status: 'good', removedFromCrl: true, ...base };
    }
    if (hit.reason !== 8) {
      return {
        status: 'revoked',
        reason: hit.reasonName,
        reasonCode: hit.reason,
        revocationDate: hit.revocationDate,
        invalidityDate: hit.invalidityDate,
        ...base
      };
    }
  }

  return { status: 'good', ...base };
}

/**
 * CRL'in kapsamı bu sertifikayı içeriyor mu?
 *
 * Kapsam denetimi olmadan, "yalnız CA sertifikalarını içeren" bir listeye
 * bakıp bir son kullanıcı sertifikasına "iptal edilmemiş" demek mümkün olur.
 * Liste doğru, imza doğru, tarih doğru — ama cevap yanlış.
 */
function checkScope(crl, certDer, opts = {}) {
  const idp = crl.idp;
  if (!idp) return { covers: true, partialReasons: false };

  const isCa = isCaCertificate(certDer);

  if (idp.onlyAttributeCerts) {
    return { covers: false, reason: 'CRL yalnız öznitelik sertifikalarını kapsıyor' };
  }
  if (idp.onlyUserCerts && isCa) {
    return { covers: false, reason: 'CRL yalnız son kullanıcı sertifikalarını kapsıyor, bu bir CA' };
  }
  if (idp.onlyCaCerts && !isCa) {
    return { covers: false, reason: 'CRL yalnız CA sertifikalarını kapsıyor, bu bir son kullanıcı' };
  }

  // Dağıtım noktası eşleşmesi: ikisi de biliniyorsa kesişmeleri gerekir.
  // Kesişmiyorsa bu, sertifikanın ait olduğu bölüm DEĞİLDİR.
  if (idp.uris.length && opts.checkDistributionPoint !== false) {
    const certPoints = extractCDP(certDer).http || [];
    if (certPoints.length && !idp.uris.some((u) => certPoints.includes(u))) {
      return {
        covers: false,
        reason: 'CRL dağıtım noktası sertifikanın CDP değerleriyle eşleşmiyor'
      };
    }
  }

  // Bölümlenmiş (partitioned) CRL: yalnız bazı sebepleri kapsar. Buradan
  // gelen "good" TAM bir cevap değildir ve öyle bildirilir.
  return {
    covers: true,
    partialReasons: !!(idp.onlySomeReasons && idp.onlySomeReasons.length)
  };
}

/** basicConstraints.cA bayrağı. */
function isCaCertificate(certDer) {
  try {
    const bc = require('./x509_ext').extractBasicConstraints(certDer);
    return !!(bc && bc.isCA);
  } catch {
    return false;
  }
}

/**
 * Taban CRL + delta CRL birlikte değerlendirilir (RFC 5280 §5.2.4).
 *
 * Delta CRL, tabandan BU YANA olan değişiklikleri taşır. Doğru sıra:
 * önce tabana bak, sonra deltayı ÜZERİNE uygula — delta bir girdiyi
 * `removeFromCRL` ile geri alabilir (örn. certificateHold kaldırıldı).
 *
 * Deltanın tabana AİT olduğu `baseCrlNumber` ile doğrulanır; ilgisiz bir
 * delta uygulamak, iptal bilgisini silmenin kolay yolu olurdu.
 */
function checkCrlWithDelta(certPemOrDer, issuerPemOrDer, baseCrlDer, deltaCrlDer, opts = {}) {
  const baseResult = checkCrl(certPemOrDer, issuerPemOrDer, baseCrlDer, opts);
  if (!deltaCrlDer) return baseResult;

  const base = parseCrl(baseCrlDer);
  const delta = parseCrl(deltaCrlDer);

  if (!delta.isDelta) {
    throw new CrlError('ERR_CRL_NOT_DELTA', 'Verilen ikinci CRL bir delta değil');
  }
  if (!base.crlNumber || !delta.baseCrlNumber) {
    throw new CrlError('ERR_CRL_NUMBER_MISSING',
      'Delta uygulanamıyor: cRLNumber ya da baseCRLNumber eksik');
  }
  // Delta, tabanın numarasından ESKİ bir tabana dayanamaz
  if (BigInt('0x' + delta.baseCrlNumber) > BigInt('0x' + base.crlNumber)) {
    throw new CrlError('ERR_CRL_DELTA_MISMATCH',
      `Delta CRL daha yeni bir tabana ait (base=${base.crlNumber}, ` +
      `delta.base=${delta.baseCrlNumber})`);
  }

  const deltaResult = checkCrl(certPemOrDer, issuerPemOrDer, deltaCrlDer,
    { ...opts, allowDelta: true });

  // Delta, taban sonrası durumdur: bir şey söylüyorsa o geçerlidir.
  const certDer = Buffer.isBuffer(certPemOrDer) ? certPemOrDer : pemToDer(certPemOrDer);
  const serialHex = getSerial(certDer).toString('hex').replace(/^0+(?=.)/, '') || '0';

  if (delta.revoked.has(serialHex)) {
    return { ...deltaResult, source: 'delta', baseCrlNumber: base.crlNumber };
  }
  return { ...baseResult, deltaApplied: true, deltaCrlNumber: delta.crlNumber };
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
  checkCrlWithDelta,
  checkScope,
  decodeReasonFlags,
  KNOWN_CRL_EXTENSIONS,
  fetchAndCheckCrl,
  verifyCrlSignature,
  normalizeCrlBuffer,
  CRL_REASONS
};
