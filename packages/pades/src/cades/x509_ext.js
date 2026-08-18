'use strict';
/**
 * X.509 uzantı çözümleyicisi ve sertifika zinciri kurucusu.
 *
 * Bu modül, projedeki "DER'i latin1'e çevirip URL ara" yaklaşımının yerine geçer.
 * Eski yaklaşımın sorunları:
 *   - `.crl` ile bitmeyen CDP'leri kaçırıyordu,
 *   - `http://ocsp.` ile başlamayan OCSP adreslerini göremiyordu,
 *   - sertifikanın başka bir alanında geçen bir URL'i yanlışlıkla yakalayabiliyordu,
 *   - "digicert geçiyorsa ocsp.digicert.com" gibi taşınabilir olmayan özel durumlar
 *     içeriyordu.
 *
 * Burada uzantılar RFC 5280'e göre gerçekten ayrıştırılır.
 */

const { readTLV, oidFromBytes, pemToDer, parseCertBasics } = require('./x509_extract');

const EXT_OIDS = {
  subjectKeyIdentifier:      '2.5.29.14',
  keyUsage:                  '2.5.29.15',
  subjectAltName:            '2.5.29.17',
  basicConstraints:          '2.5.29.19',
  cRLDistributionPoints:     '2.5.29.31',
  certificatePolicies:       '2.5.29.32',
  authorityKeyIdentifier:    '2.5.29.35',
  extKeyUsage:               '2.5.29.37',
  freshestCRL:               '2.5.29.46',
  authorityInfoAccess:       '1.3.6.1.5.5.7.1.1',
  subjectInfoAccess:         '1.3.6.1.5.5.7.1.11'
};

const AIA_METHOD = {
  ocsp:      '1.3.6.1.5.5.7.48.1',
  caIssuers: '1.3.6.1.5.5.7.48.2'
};

/* ------------------------------------------------------------------ */
/* TBSCertificate alanlarına konumlanma                                */
/* ------------------------------------------------------------------ */

/**
 * TBSCertificate içindeki alanların TLV konumlarını döndürür.
 * @param {Buffer} certDer
 */
function locateTbsFields(certDer) {
  const outer = readTLV(certDer, 0);
  if (outer.tag !== 0x30) throw new Error('x509: dış SEQUENCE bulunamadı');
  const tbs = readTLV(certDer, outer.start);
  if (tbs.tag !== 0x30) throw new Error('x509: tbsCertificate bulunamadı');

  let p = tbs.start;
  let version = null;
  const first = readTLV(certDer, p);
  if (first.tag === 0xA0) { version = first; p = first.next; }

  const serial   = readTLV(certDer, p); p = serial.next;
  const sigAlg   = readTLV(certDer, p); p = sigAlg.next;
  const issuer   = readTLV(certDer, p); p = issuer.next;
  const validity = readTLV(certDer, p); p = validity.next;
  const subject  = readTLV(certDer, p); p = subject.next;
  const spki     = readTLV(certDer, p); p = spki.next;

  let issuerUniqueId = null;
  let subjectUniqueId = null;
  let extensions = null;

  while (p < tbs.end) {
    const t = readTLV(certDer, p);
    if (t.tag === 0xA1) { issuerUniqueId = t; }
    else if (t.tag === 0xA2) { subjectUniqueId = t; }
    else if (t.tag === 0xA3) { extensions = t; break; }
    else break;
    p = t.next;
  }

  return { outer, tbs, version, serial, sigAlg, issuer, validity, subject, spki,
           issuerUniqueId, subjectUniqueId, extensions };
}

/** Bir TLV'nin tag+len+value tamamını (tam DER kodlaması) döndürür. */
function fullTlv(buf, tlv) {
  return buf.slice(tlv.start - tlv.hdr, tlv.end);
}

/** Subject Name'in tam DER kodlaması (tag dahil). Zincir eşlemesinde kullanılır. */
function getSubjectDer(certDer) {
  const f = locateTbsFields(certDer);
  return fullTlv(certDer, f.subject);
}

/** Issuer Name'in tam DER kodlaması (tag dahil). */
function getIssuerDer(certDer) {
  const f = locateTbsFields(certDer);
  return fullTlv(certDer, f.issuer);
}

/** Seri numarasının içerik baytları (INTEGER value, tag/len hariç). */
function getSerial(certDer) {
  const f = locateTbsFields(certDer);
  return certDer.slice(f.serial.start, f.serial.end);
}

/** Sertifika kendi kendini mi imzalamış (subject === issuer)? */
function isSelfSigned(certDer) {
  try {
    return getSubjectDer(certDer).equals(getIssuerDer(certDer));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Uzantılar                                                            */
/* ------------------------------------------------------------------ */

/**
 * Tüm uzantıları çözer.
 * @param {Buffer} certDer
 * @returns {Map<string,{critical:boolean, value:Buffer}>} OID → uzantı
 */
function parseExtensions(certDer) {
  const out = new Map();
  let f;
  try { f = locateTbsFields(certDer); } catch { return out; }
  if (!f.extensions) return out;

  const seq = readTLV(certDer, f.extensions.start);
  if (seq.tag !== 0x30) return out;

  let p = seq.start;
  while (p < seq.end) {
    let ext;
    try { ext = readTLV(certDer, p); } catch { break; }
    if (ext.tag !== 0x30 || ext.next <= p) break;

    let q = ext.start;
    const oidTlv = readTLV(certDer, q);
    if (oidTlv.tag !== 0x06) { p = ext.next; continue; }
    const oid = oidFromBytes(certDer.slice(oidTlv.start, oidTlv.end));
    q = oidTlv.next;

    let critical = false;
    let maybe = readTLV(certDer, q);
    if (maybe.tag === 0x01) {
      critical = certDer[maybe.start] !== 0x00;
      q = maybe.next;
      maybe = readTLV(certDer, q);
    }
    if (maybe.tag !== 0x04) { p = ext.next; continue; }

    out.set(oid, { critical, value: certDer.slice(maybe.start, maybe.end) });
    p = ext.next;
  }
  return out;
}

/** GeneralName [6] uniformResourceIdentifier (IA5String) → string */
function generalNameUri(buf, tlv) {
  if (tlv.tag !== 0x86) return null;
  return buf.slice(tlv.start, tlv.end).toString('latin1');
}

/**
 * Authority Information Access (RFC 5280 §4.2.2.1).
 * @returns {{ ocsp: string[], caIssuers: string[] }}
 */
function extractAIA(certDer) {
  const result = { ocsp: [], caIssuers: [] };
  const ext = parseExtensions(certDer).get(EXT_OIDS.authorityInfoAccess);
  if (!ext) return result;

  const v = ext.value;
  let seq;
  try { seq = readTLV(v, 0); } catch { return result; }
  if (seq.tag !== 0x30) return result;

  let p = seq.start;
  while (p < seq.end) {
    let desc;
    try { desc = readTLV(v, p); } catch { break; }
    if (desc.tag !== 0x30 || desc.next <= p) break;

    let q = desc.start;
    const methodTlv = readTLV(v, q);
    if (methodTlv.tag !== 0x06) { p = desc.next; continue; }
    const method = oidFromBytes(v.slice(methodTlv.start, methodTlv.end));
    q = methodTlv.next;

    const loc = readTLV(v, q);
    const uri = generalNameUri(v, loc);
    if (uri) {
      if (method === AIA_METHOD.ocsp) result.ocsp.push(uri);
      else if (method === AIA_METHOD.caIssuers) result.caIssuers.push(uri);
    }
    p = desc.next;
  }
  return result;
}

/**
 * CRL Distribution Points (RFC 5280 §4.2.1.13).
 *
 * DistributionPoint ::= SEQUENCE {
 *   distributionPoint  [0] DistributionPointName OPTIONAL,
 *   reasons            [1] ReasonFlags OPTIONAL,
 *   cRLIssuer          [2] GeneralNames OPTIONAL }
 * DistributionPointName ::= CHOICE {
 *   fullName           [0] GeneralNames,
 *   nameRelativeToCRLIssuer [1] RelativeDistinguishedName }
 *
 * @param {Buffer} certDer
 * @param {string} [extOid] Varsayılan CDP; freshestCRL için 2.5.29.46 verilebilir.
 * @returns {{ http: string[], ldap: string[], all: string[] }}
 */
function extractCDP(certDer, extOid = EXT_OIDS.cRLDistributionPoints) {
  const result = { http: [], ldap: [], all: [] };
  const ext = parseExtensions(certDer).get(extOid);
  if (!ext) return result;

  const v = ext.value;
  let seq;
  try { seq = readTLV(v, 0); } catch { return result; }
  if (seq.tag !== 0x30) return result;

  const pushUri = (uri) => {
    if (!uri || result.all.includes(uri)) return;
    result.all.push(uri);
    const lower = uri.toLowerCase();
    if (lower.startsWith('http://') || lower.startsWith('https://')) result.http.push(uri);
    else if (lower.startsWith('ldap://') || lower.startsWith('ldaps://')) result.ldap.push(uri);
  };

  let p = seq.start;
  while (p < seq.end) {
    let dp;
    try { dp = readTLV(v, p); } catch { break; }
    if (dp.tag !== 0x30 || dp.next <= p) break;

    let q = dp.start;
    while (q < dp.end) {
      let field;
      try { field = readTLV(v, q); } catch { break; }
      if (field.next <= q) break;

      if (field.tag === 0xA0) {
        // distributionPoint [0] DistributionPointName
        let r = field.start;
        while (r < field.end) {
          let dpn;
          try { dpn = readTLV(v, r); } catch { break; }
          if (dpn.next <= r) break;
          if (dpn.tag === 0xA0) {
            // fullName [0] GeneralNames
            let s = dpn.start;
            while (s < dpn.end) {
              let gn;
              try { gn = readTLV(v, s); } catch { break; }
              if (gn.next <= s) break;
              pushUri(generalNameUri(v, gn));
              s = gn.next;
            }
          }
          r = dpn.next;
        }
      }
      q = field.next;
    }
    p = dp.next;
  }
  return result;
}

/**
 * Authority Key Identifier (RFC 5280 §4.2.1.1).
 * @returns {{ keyId: Buffer|null, serial: Buffer|null, issuerDer: Buffer|null }}
 */
function extractAKI(certDer) {
  const result = { keyId: null, serial: null, issuerDer: null };
  const ext = parseExtensions(certDer).get(EXT_OIDS.authorityKeyIdentifier);
  if (!ext) return result;

  const v = ext.value;
  let seq;
  try { seq = readTLV(v, 0); } catch { return result; }
  if (seq.tag !== 0x30) return result;

  let p = seq.start;
  while (p < seq.end) {
    let f;
    try { f = readTLV(v, p); } catch { break; }
    if (f.next <= p) break;
    if (f.tag === 0x80) result.keyId = v.slice(f.start, f.end);
    else if (f.tag === 0xA1) {
      // authorityCertIssuer [1] GeneralNames — directoryName [4] aranır
      let q = f.start;
      while (q < f.end) {
        let gn;
        try { gn = readTLV(v, q); } catch { break; }
        if (gn.next <= q) break;
        if (gn.tag === 0xA4) result.issuerDer = v.slice(gn.start, gn.end);
        q = gn.next;
      }
    }
    else if (f.tag === 0x82) result.serial = v.slice(f.start, f.end);
    p = f.next;
  }
  return result;
}

/** Subject Key Identifier (RFC 5280 §4.2.1.2). */
function extractSKI(certDer) {
  const ext = parseExtensions(certDer).get(EXT_OIDS.subjectKeyIdentifier);
  if (!ext) return null;
  try {
    const oct = readTLV(ext.value, 0);
    if (oct.tag !== 0x04) return null;
    return ext.value.slice(oct.start, oct.end);
  } catch {
    return null;
  }
}

/** Basic Constraints (RFC 5280 §4.2.1.9). */
function extractBasicConstraints(certDer) {
  const result = { isCA: false, pathLen: null, critical: false };
  const ext = parseExtensions(certDer).get(EXT_OIDS.basicConstraints);
  if (!ext) return result;
  result.critical = ext.critical;
  try {
    const seq = readTLV(ext.value, 0);
    if (seq.tag !== 0x30) return result;
    let p = seq.start;
    while (p < seq.end) {
      const f = readTLV(ext.value, p);
      if (f.next <= p) break;
      if (f.tag === 0x01) result.isCA = ext.value[f.start] !== 0x00;
      else if (f.tag === 0x02) {
        let n = 0;
        for (let i = f.start; i < f.end; i++) n = (n << 8) | ext.value[i];
        result.pathLen = n;
      }
      p = f.next;
    }
  } catch { /* uzantı bozuksa varsayılanla dön */ }
  return result;
}

/* ------------------------------------------------------------------ */
/* Zincir kurulumu                                                      */
/* ------------------------------------------------------------------ */

/**
 * Bir sertifikanın verilen adayın tarafından imzalanmış olup olamayacağına bakar.
 * İsim eşleşmesine ek olarak AKI/SKI kontrolü yapılır (çapraz-imzalı CA'larda
 * yalnız isim eşleşmesi yetmez).
 */
function isIssuerOf(childDer, candidateDer) {
  let childIssuer, candidateSubject;
  try {
    childIssuer = getIssuerDer(childDer);
    candidateSubject = getSubjectDer(candidateDer);
  } catch {
    return false;
  }
  if (!childIssuer.equals(candidateSubject)) return false;

  const aki = extractAKI(childDer);
  const ski = extractSKI(candidateDer);
  if (aki.keyId && ski && !aki.keyId.equals(ski)) return false;

  if (aki.serial) {
    try {
      if (!aki.serial.equals(getSerial(candidateDer))) return false;
    } catch { /* seri okunamadıysa isim eşleşmesiyle yetin */ }
  }
  return true;
}

/**
 * Leaf'ten köke doğru zinciri kurar.
 *
 * @param {Buffer} leafDer
 * @param {Buffer[]} poolDer Aday sertifikalar (CMS'ten, OCSP'den, AIA'dan, kullanıcıdan)
 * @returns {{ path: Buffer[], complete: boolean, anchor: Buffer|null, missingIssuerOf: Buffer|null }}
 *   `path` daima leaf ile başlar. `complete`, kendinden imzalı bir köke ulaşıldığında true olur.
 */
function buildChain(leafDer, poolDer = []) {
  const path = [leafDer];
  const usedHex = new Set([leafDer.toString('hex')]);
  let current = leafDer;

  for (let depth = 0; depth < 16; depth++) {
    if (isSelfSigned(current)) {
      return { path, complete: true, anchor: current, missingIssuerOf: null };
    }
    let issuer = null;
    for (const cand of poolDer) {
      const hex = cand.toString('hex');
      if (usedHex.has(hex)) continue;
      if (isIssuerOf(current, cand)) { issuer = cand; break; }
    }
    if (!issuer) {
      return { path, complete: false, anchor: null, missingIssuerOf: current };
    }
    usedHex.add(issuer.toString('hex'));
    path.push(issuer);
    current = issuer;
  }
  return { path, complete: false, anchor: null, missingIssuerOf: current };
}

/**
 * Bir DER bloğu içindeki tüm X.509 sertifikalarını toplar (CMS, OCSP yanıtı, TST…).
 * `parseCertBasics` başarıyla çalışıyorsa o SEQUENCE bir sertifikadır.
 */
function collectCertificates(derBuffer, into = []) {
  const seen = new Set(into.map((c) => c.toString('hex')));

  const traverse = (start, end, depth) => {
    if (depth > 24) return;
    let pos = start;
    while (pos < end) {
      let tlv;
      try { tlv = readTLV(derBuffer, pos); } catch { return; }
      if (!tlv || tlv.next <= pos || tlv.end > end) return;

      if (tlv.tag === 0x30) {
        const candidate = derBuffer.slice(pos, tlv.end);
        let isCert = false;
        try {
          parseCertBasics(candidate);
          // parseCertBasics gevşek davranabildiği için ek bir yapısal kontrol:
          locateTbsFields(candidate);
          isCert = true;
        } catch { isCert = false; }

        if (isCert) {
          const hex = candidate.toString('hex');
          if (!seen.has(hex)) { seen.add(hex); into.push(candidate); }
        } else {
          traverse(tlv.start, tlv.end, depth + 1);
        }
      } else if (tlv.tag & 0x20) {
        traverse(tlv.start, tlv.end, depth + 1);
      }
      pos = tlv.next;
    }
  };

  traverse(0, derBuffer.length, 0);
  return into;
}

function derToPem(der, label = 'CERTIFICATE') {
  const b64 = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/** Bir PEM yığınındaki tüm sertifikaları ayırır. */
function splitPem(pemText) {
  const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  return String(pemText).match(re) || [];
}

module.exports = {
  EXT_OIDS,
  AIA_METHOD,
  locateTbsFields,
  parseExtensions,
  extractAIA,
  extractCDP,
  extractAKI,
  extractSKI,
  extractBasicConstraints,
  getSubjectDer,
  getIssuerDer,
  getSerial,
  isSelfSigned,
  isIssuerOf,
  buildChain,
  collectCertificates,
  derToPem,
  splitPem,
  pemToDer
};
