'use strict';
/**
 * CSR (PKCS#10, RFC 2986) — Ayrıştırma, öz-imza doğrulama ve CA tarafında
 * sertifika üretimi.
 *
 * Önceki sürüm yalnızca `generateCSR` (CSR ÜRETME) içeriyordu; bir CSR'yi
 * OKUMAK, imzasını DOĞRULAMAK ve ondan bir CA'nın sertifika ÜRETMESİ eksikti.
 * Bu modül bu boşluğu kapatır. `./pki`'den `buildCert`/`newSerial` kullanır
 * (tek yönlü bağımlılık — `pki.js` bu modülü GERİ import ETMEZ, döngüsel
 * bağımlılık yoktur).
 */
const crypto = require('node:crypto');
const {
  readTLV, readChildren, derIntToBigInt, OIDs, oidToName,
  extSAN, extBasicConstraints, extKeyUsage, extEKU,
  extSKID, extAKID, extCDP, extAIA, extCertificatePolicies,
  computeRsaSKID, computeEcSKID, KU, buildName, normalizeOid,
} = require('./asn1');
const { resolveDistributionPoints: _resolveDistributionPoints } = require('./_dp');
const { applyProfile } = require('./profiles');
const { ext, NULL } = require('./asn1');
const { CURVES, ecdsaVerify } = require('./ec');
const { rsaVerify } = require('./rsa');
const { pemToDer } = require('./_codec');
const { buildCert, newSerial } = require('./pki');

const HASH_OID_TO_NAME = {
  [OIDs.sha256WithRSAEncryption]: 'sha256',
  [OIDs.sha384WithRSAEncryption]: 'sha384',
  [OIDs.sha512WithRSAEncryption]: 'sha512',
  [OIDs.ecdsaWithSHA256]: 'sha256',
  [OIDs.ecdsaWithSHA384]: 'sha384',
  [OIDs.ecdsaWithSHA512]: 'sha512',
};

function _parseSpki(spkiNode) {
  const [algNode, pubBitNode] = readChildren(spkiNode.content);
  const algChildren = readChildren(algNode.content);
  const algOid = algChildren[0].content.toString('hex');
  const pubBits = pubBitNode.content.subarray(1); // ilk bayt: kullanılmayan bit sayacı

  if (algOid === OIDs.rsaEncryption) {
    const rsaSeq = readTLV(pubBits, 0);
    const [nNode, eNode] = readChildren(rsaSeq.content);
    return { keyType: 'rsa', n: derIntToBigInt(nNode.content), e: derIntToBigInt(eNode.content) };
  }
  if (algOid === OIDs.ecPublicKey) {
    const curveOidHex = algChildren[1].content.toString('hex');
    const curveName = Object.keys(CURVES).find(cn => CURVES[cn].oidCurve === curveOidHex);
    if (!curveName) throw new Error(`parseCSR: bilinmeyen EC eğrisi OID ${curveOidHex}`);
    return { keyType: 'ec', curveName, publicKeyBuf: Buffer.from(pubBits) };
  }
  throw new Error(`parseCSR: desteklenmeyen genel anahtar algoritması OID ${algOid} (${oidToName(algOid)})`);
}

// DN bileşeni OID'lerinin kısa adları. Bir kayıt otoritesi (RA) bir CSR'nin
// TALEP ETTİĞİ kimliği, verdiği YETKİYLE karşılaştırabilmek için subject'i
// çözümlenmiş halde görmek zorundadır — ham `subjectNameDer` ile bu
// karşılaştırma yapılamaz.
const DN_OID_TO_SHORT = {
  [OIDs.commonName]:        'CN',
  [OIDs.country]:           'C',
  [OIDs.locality]:          'L',
  [OIDs.state]:             'ST',
  [OIDs.streetAddress]:     'STREET',
  [OIDs.orgName]:           'O',
  [OIDs.orgUnit]:           'OU',
  [OIDs.surname]:           'SN',
  [OIDs.givenName]:         'GN',
  [OIDs.title]:             'T',
  [OIDs.serialNumberAttr]:  'serialNumber',
  [OIDs.pkcs9EmailAddress]: 'emailAddress',
};

/**
 * RDNSequence'i çözümler.
 *   Name ::= RDNSequence
 *   RDNSequence ::= SEQUENCE OF RelativeDistinguishedName
 *   RelativeDistinguishedName ::= SET OF AttributeTypeAndValue
 *   AttributeTypeAndValue ::= SEQUENCE { type OBJECT IDENTIFIER, value ANY }
 *
 * @returns {{ attrs: Array<[string,string]>, subject: Object }}
 *   `attrs` DER sırasını korur (aynı tipin birden çok kez geçmesi mümkündür);
 *   `subject` kolay karşılaştırma için kısa-adlı bir nesnedir. Aynı tip birden
 *   fazla kez geçerse `subject` İLK değeri tutar ama `attrs` hepsini taşır —
 *   böylece "iki CN'li CSR" gibi kaçamaklar çağıran tarafından görülebilir.
 */
function _parseName(nameNode) {
  const attrs = [];
  const subject = {};
  for (const rdnNode of readChildren(nameNode.content)) {
    if (rdnNode.tag !== 0x31) continue; // SET OF bekleniyor
    for (const atvNode of readChildren(rdnNode.content)) {
      if (atvNode.tag !== 0x30) continue; // SEQUENCE bekleniyor
      const parts = readChildren(atvNode.content);
      if (parts.length < 2) continue;
      const oidHex = parts[0].content.toString('hex');
      // DirectoryString varyantları (UTF8String/PrintableString/IA5String/...)
      // hepsi düz metindir; BMPString/UniversalString UTF-16/32 olduğundan
      // ayrıca ele alınır.
      const valueNode = parts[1];
      let value;
      // NOT: swap16() yerinde (in-place) çalışır ve `content` kaynak DER
      // buffer'ının bir subarray'idir — kopyalamadan çevirmek CSR'nin kendi
      // baytlarını bozar ve ardından gelen imza doğrulamasını sessizce
      // başarısız kılardı.
      if (valueNode.tag === 0x1e && valueNode.content.length % 2 === 0) {
        value = Buffer.from(valueNode.content).swap16().toString('utf16le'); // BMPString
      } else {
        value = valueNode.content.toString('utf8');
      }
      attrs.push([oidHex, value]);
      const short = DN_OID_TO_SHORT[oidHex];
      const key = short || oidToName(oidHex) || oidHex;
      if (!(key in subject)) subject[key] = value;
    }
  }
  return { attrs, subject };
}

/** CSR attributes ([0] IMPLICIT SET OF Attribute) içinden istenen SAN listesini çıkarır. */
function _extractRequestedSans(attrsCtxNode) {
  if (!attrsCtxNode) return [];
  // [0] IMPLICIT SET OF Attribute — içerik doğrudan Attribute SEQUENCE'lerinin ardışık dizisidir.
  const attrs = readChildren(attrsCtxNode.content);
  for (const attrNode of attrs) {
    const [oidNode, valuesSetNode] = readChildren(attrNode.content);
    if (oidNode.content.toString('hex') !== OIDs.extensionReq) continue;
    const extsSeq = readTLV(valuesSetNode.content, 0); // SET içindeki Extensions SEQUENCE
    const extNodes = readChildren(extsSeq.content);
    const sans = [];
    for (const extNode of extNodes) {
      const extChildren = readChildren(extNode.content);
      const extOid = extChildren[0].content.toString('hex');
      if (extOid !== OIDs.subjectAltName) continue;
      const octNode = extChildren[extChildren.length - 1];
      const gnSeq = readTLV(octNode.content, 0);
      for (const gn of readChildren(gnSeq.content)) {
        if (gn.tag === 0x82) sans.push({ type: 'dns', value: gn.content.toString('ascii') });
        else if (gn.tag === 0x81) sans.push({ type: 'email', value: gn.content.toString('ascii') });
        else if (gn.tag === 0x86) sans.push({ type: 'uri', value: gn.content.toString('ascii') });
        else if (gn.tag === 0x87) sans.push({ type: 'ip', value: Array.from(gn.content).join('.') });
      }
    }
    return sans;
  }
  return [];
}

/**
 * CSR'yi (PEM veya DER) ayrıştırır. İmzayı DOĞRULAMAZ — bkz. `verifyCSR`.
 * @param {string|Buffer} pemOrDer
 * @returns {{
 *   subjectNameDer: Buffer,
 *   subject: Object,         // çözümlenmiş DN: { CN, O, OU, C, emailAddress, ... }
 *   subjectAttrs: Array,     // ham [oidHex, değer] çiftleri, DER sırasında
 *   publicKey: object,       // { keyType, n?, e?, curveName?, publicKeyBuf? }
 *   sans: Array,             // istenen subjectAltName girdileri (varsa)
 *   hashAlg: string, sigOid: string,
 *   tbs: Buffer, signature: Buffer,
 *   der: Buffer,
 * }}
 */
function parseCSR(pemOrDer) {
  const der = Buffer.isBuffer(pemOrDer) ? pemOrDer : pemToDer(pemOrDer);

  // CSR'ler DIŞARIDAN gelir: bir kayıt otoritesi, adını hiç duymadığı bir
  // istemcinin gönderdiği baytları ayrıştırır. O yüzden yapı, alanlara
  // DOKUNMADAN önce doğrulanmalı. Aksi halde bozuk bir girdi
  // "Cannot read properties of undefined" ile düşer: çağıran taraf bunu bir
  // ayrıştırma hatası olarak ayırt edemez ve sunucu 400 yerine 500 döner --
  // yani istemcinin hatası bizim hatamız gibi görünür.
  const bad = (why) => new Error(`parseCSR: geçersiz CSR (${why})`);

  let top;
  try { top = readTLV(der, 0); } catch (e) { throw bad(`DER okunamadı: ${e.message}`); }
  if (top.tag !== 0x30) throw bad('en dış yapı SEQUENCE değil');

  let children;
  try { children = readChildren(top.content); } catch (e) { throw bad(`DER okunamadı: ${e.message}`); }
  // CertificationRequest ::= SEQUENCE { certificationRequestInfo, signatureAlgorithm, signature }
  if (children.length < 3) throw bad('CertificationRequest üç alan içermiyor');
  const [infoNode, sigAlgNode, sigBitNode] = children;
  if (infoNode.tag !== 0x30) throw bad('certificationRequestInfo SEQUENCE değil');
  if (sigAlgNode.tag !== 0x30) throw bad('signatureAlgorithm SEQUENCE değil');
  if (sigBitNode.tag !== 0x03) throw bad('signature BIT STRING değil');

  let infoChildren;
  try { infoChildren = readChildren(infoNode.content); } catch (e) { throw bad(`DER okunamadı: ${e.message}`); }
  // CertificationRequestInfo ::= SEQUENCE { version, subject, subjectPKInfo, attributes [0] }
  if (infoChildren.length < 3) throw bad('certificationRequestInfo eksik alan içeriyor');
  const subjectNode = infoChildren[1];
  const spkiNode = infoChildren[2];
  if (spkiNode.tag !== 0x30) throw bad('subjectPublicKeyInfo SEQUENCE değil');
  const attrsCtxNode = infoChildren.find(n => n.tag === 0xa0);

  let sigAlgChildren;
  try { sigAlgChildren = readChildren(sigAlgNode.content); } catch (e) { throw bad(`DER okunamadı: ${e.message}`); }
  if (sigAlgChildren.length === 0 || sigAlgChildren[0].tag !== 0x06) {
    throw bad('signatureAlgorithm bir OID ile başlamıyor');
  }
  if (sigBitNode.content.length < 1) throw bad('imza boş');
  const sigOid = sigAlgChildren[0].content.toString('hex');
  const hashAlg = HASH_OID_TO_NAME[sigOid];
  if (!hashAlg) throw new Error(`parseCSR: desteklenmeyen imza algoritması OID ${sigOid} (${oidToName(sigOid)})`);

  const publicKey = _parseSpki(spkiNode);
  const sans = _extractRequestedSans(attrsCtxNode);
  const { attrs: subjectAttrs, subject } = _parseName(subjectNode);

  // ÖNEMLİ: node.contentOff/totalLen, o node'un okunduğu EBEVEYN buffer'a
  // görelidir — `der`'e göre DEĞİL (bkz. keys.js#certInfoFromPem'deki aynı not).
  const fullTlv = (parentContent, node) => parentContent.subarray(
    node.contentOff - node.headerLen,
    node.contentOff - node.headerLen + node.totalLen,
  );

  const tbsFull = fullTlv(top.content, infoNode);
  const signature = sigBitNode.content.subarray(1);

  return {
    subjectNameDer: fullTlv(infoNode.content, subjectNode),
    spkiDer: fullTlv(infoNode.content, spkiNode),
    // `subject` çözümlenmiş kısa-adlı biçim ({CN, O, ...}), `subjectAttrs` ise
    // DER sırasını koruyan ham [oidHex, değer] çiftleri. Bir kayıt otoritesi,
    // CSR'nin TALEP ETTİĞİ kimliği verdiği yetkiyle ancak bunlar üzerinden
    // karşılaştırabilir.
    subject, subjectAttrs,
    publicKey, sans, hashAlg, sigOid,
    tbs: tbsFull, signature, der,
  };
}

/**
 * CSR'nin öz-imzasını (CSR sahibinin, kendi özel anahtarıyla attığı imza)
 * doğrular. Bu, CSR'nin talep edilen genel anahtarla eşleştiğini ve
 * içeriğin değiştirilmediğini kanıtlar (ama başvuranın kimliğini KANITLAMAZ
 * — bu, ayrı bir kayıt/doğrulama sürecinin işidir).
 * @param {ReturnType<typeof parseCSR>|string|Buffer} csr  parseCSR çıktısı veya doğrudan PEM/DER
 * @returns {boolean}
 */
function verifyCSR(csr) {
  const c = (csr && csr.tbs) ? csr : parseCSR(csr);
  if (c.publicKey.keyType === 'rsa') {
    return rsaVerify({ n: c.publicKey.n, e: c.publicKey.e }, c.tbs, c.signature, c.hashAlg);
  }
  if (c.publicKey.keyType === 'ec') {
    return ecdsaVerify(c.publicKey.curveName, c.publicKey.publicKeyBuf, c.tbs, c.signature, c.hashAlg);
  }
  return false;
}

/**
 * CA olarak bir CSR'den son-varlık (end-entity) sertifikası üretir.
 * Öz-imzayı ÖNCE doğrular (aksi belirtilmedikçe) — geçersizse hata fırlatır.
 *
 * @param {string|Buffer|ReturnType<typeof parseCSR>} csrInput
 * @param {object} issuerCA   generateRootCA/generateIntermediateCA/generateEcRootCA çıktısı
 * @param {{
 *   validityDays?: number, notBefore?: Date, notAfter?: Date,
 *   hashAlg?: string, serialNum?: bigint,
 *   includeCsrSans?: boolean, sans?: Array,
 *   keyUsage?: number[], keyUsageCritical?: boolean,
 *   eku?: string[], ekuCritical?: boolean,      // EKU OID'leri ad/noktalı-ondalık/hex olabilir
 *   sanCritical?: boolean,
 *   policies?: string|object|Array,             // bkz. asn1#extCertificatePolicies (CPS + notice)
 *   policiesCritical?: boolean,
 *   isCA?: boolean, pathLen?: number,
 *   ocspUrl?: string|string[],                  // AÇIK OCSP adresi (önerilen)
 *   caIssuersUrl?: string|string[],             // AÇIK caIssuers adresi (önerilen)
 *   crlUrls?: string|string[],                  // AÇIK CRL adres(ler)i (önerilen)
 *   crlUrl?: string, aiaUrl?: string,           // ESKİ taban-adres biçimi (hâlâ desteklenir)
 *   extraExtensions?: Buffer[],
 *   skipSignatureCheck?: boolean,
 *   subjectOverride?: Object|Array,   // CSR'nin subject'i YERİNE bunu yaz (aşağıya bkz.)
 * }} [opts]
 *
 * `subjectOverride` — varsayılan davranış CSR'nin kendi subject'ini AYNEN
 * sertifikaya yazmaktır. Bu, CSR'yi üretenin kimliği ile sertifikada yazan
 * kimliğin aynı olduğu senaryolar için doğrudur; ancak bir kayıt otoritesi
 * (RA) adına imzalarken YANLIŞTIR: orada "kim olduğun" başvurudan değil,
 * verilen yetkiden gelir. Bu seçenek verildiğinde subject tamamen buradan
 * kurulur, böylece CSR'ye yazılan ad sertifikaya sızamaz.
 * Nesne ({CN:'x', O:'y'}) ya da [[oid, değer], ...] biçimi kabul edilir.
 */
function issueCertificateFromCSR(csrInput, issuerCA, opts = {}) {
  const csr = (csrInput && csrInput.tbs) ? csrInput : parseCSR(csrInput);
  if (!opts.skipSignatureCheck && !verifyCSR(csr)) {
    throw new Error('issueCertificateFromCSR: CSR öz-imzası geçersiz — istek reddedildi');
  }
  // Profil (ör. 'tsa', 'ocsp-responder') varsa doğru KeyUsage/EKU/critical
  // kombinasyonunu uygular; çağıranın açık seçenekleri profili ezer.
  opts = applyProfile(opts.profile, opts);

  const {
    validityDays = 365, hashAlg = issuerCA.hashAlg || 'sha256',
    includeCsrSans = true, sans = [],
    keyUsage = csr.publicKey.keyType === 'rsa'
      ? [KU.digitalSignature, KU.keyEncipherment]
      : [KU.digitalSignature],
    eku = [OIDs.serverAuth, OIDs.clientAuth],
    ekuCritical = false, keyUsageCritical = true, sanCritical = false,
    policies = null, policiesCritical = false,
    isCA = false, pathLen,
    extraExtensions = [],
  } = opts;

  const now = opts.notBefore || new Date();
  const exp = opts.notAfter || new Date(now.getTime() + validityDays * 86400000);

  const skid = csr.publicKey.keyType === 'rsa'
    ? computeRsaSKID(csr.publicKey.n, csr.publicKey.e)
    : computeEcSKID(csr.publicKey.publicKeyBuf);

  const allSans = includeCsrSans ? [...csr.sans, ...sans] : sans;
  const signerKey = { ...issuerCA, hashAlg };
  const { cdp, aia } = _resolveDistributionPoints(opts);

  const extensions = [
    extBasicConstraints(isCA, pathLen),
    extKeyUsage(keyUsage, keyUsageCritical),
    ...(eku && eku.length ? [extEKU(eku, ekuCritical)] : []),
    extSKID(skid), extAKID(issuerCA.skid),
    ...(allSans.length ? [extSAN(allSans, sanCritical)] : []),
    ...(cdp.length ? [extCDP(cdp)] : []),
    ...(aia ? [aia] : []),
    ...(policies ? [extCertificatePolicies(policies, policiesCritical)] : []),
    ...(opts.ocspNoCheck ? [ext(OIDs.ocspNoCheck, false, NULL())] : []),
    ...extraExtensions,
  ];

  const cert = buildCert({
    serialNum: opts.serialNum !== undefined ? opts.serialNum : newSerial(),
    issuerName: issuerCA.name,
    subjectName: opts.subjectOverride
      ? buildName(_subjectToPairs(opts.subjectOverride))
      : csr.subjectNameDer,
    notBefore: now, notAfter: exp,
    spki: csr.spkiDer,
    extensions, signerKey,
  });

  return {
    pem: cert.pem, der: cert.der,
    publicKey: csr.publicKey, skid,
  };
}

/**
 * `subjectOverride` girdisini buildName'in beklediği [[oidHex, değer], ...]
 * biçimine çevirir. Kısa adlar (CN/O/OU/C/ST/L/emailAddress...) ve doğrudan
 * OID'ler kabul edilir. DN sırası anlamlıdır (C, O, OU, CN geleneksel sıradır),
 * bu yüzden nesne biçiminde verilenler kanonik bir sıraya oturtulur.
 */
const DN_SHORT_TO_OID = Object.fromEntries(
  Object.entries(DN_OID_TO_SHORT).map(([oidHex, short]) => [short, oidHex]),
);
const DN_CANONICAL_ORDER = ['C', 'ST', 'L', 'STREET', 'O', 'OU', 'T', 'SN', 'GN', 'serialNumber', 'CN', 'emailAddress'];

function _subjectToPairs(input) {
  if (Array.isArray(input)) {
    return input.map(([key, value]) => [DN_SHORT_TO_OID[key] || normalizeOid(String(key)), String(value)]);
  }
  const keys = Object.keys(input);
  keys.sort((a, b) => {
    const ia = DN_CANONICAL_ORDER.indexOf(a);
    const ib = DN_CANONICAL_ORDER.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  return keys
    .filter((k) => input[k] !== undefined && input[k] !== null && input[k] !== '')
    .map((k) => [DN_SHORT_TO_OID[k] || normalizeOid(k), String(input[k])]);
}

module.exports = { parseCSR, verifyCSR, issueCertificateFromCSR, _subjectToPairs };
