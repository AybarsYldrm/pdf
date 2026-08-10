'use strict';
/**
 * X.509 PKI Motoru
 *   - Kök CA, Ara CA, Son Varlık (EE) sertifikası
 *   - CSR (PKCS#10) — [0] IMPLICIT SET düzeltmesi
 *   - CRL (RFC 5280)
 *   - RSA-2048/3072/4096 + P-256/384/521 anahtarları desteklenir
 */
const {
  SEQ, SET, BIT, OCT, OID, INT, intSmall, NULL, BOOL, CTX, CTXI,
  UTCTime, GenTime, OIDs, KU,
  buildRsaSPKI, buildEcSPKI, buildName,
  computeRsaSKID, computeEcSKID,
  ext, extBasicConstraints, extKeyUsage, extEKU,
  extSKID, extAKID, extSAN, extCDP, extAIA, extCertificatePolicies, ENUM,
  algId, readTLV, readChildren, derIntToBigInt,
} = require('./asn1');

const { generateRsaKeyPair, rsaSign, rsaVerify } = require('./rsa');
const { generateEcKeyPair, ecdsaSign, ecdsaVerify, CURVES } = require('./ec');
const { sha256, sha384, sha512, hashByName } = require('./hash');
const { randomBytes } = require('./random');
const { resolveSubject, getDefaults } = require('./config');
const { resolveDistributionPoints } = require('./_dp');
const { applyProfile } = require('./profiles');

// ─────────────────────────────────────────────────────────────────────────────
// Yardımcı: Rastgele seri numarası (127-bit pozitif tamsayı)
// ─────────────────────────────────────────────────────────────────────────────
function newSerial() {
  const h = randomBytes(16).toString('hex');
  return BigInt('0x' + h) & ((1n << 127n) - 1n);
}

// ─────────────────────────────────────────────────────────────────────────────
// İmzalama soyutlama katmanı
// ─────────────────────────────────────────────────────────────────────────────
/**
 * TBS verisini verilen imzalayıcı anahtarla imzalar.
 * @param {Buffer} tbs
 * @param {{ keyType, hashAlg, n?, d?, curveName?, privateKey? }} signerKey
 */
function _sign(tbs, signerKey) {
  if (signerKey.keyType === 'rsa') {
    // NOT: tüm anahtar nesnesi (n,e,d,p,q,dp,dq,qInv) rsaSign'a AYNEN
    // aktarılır. Tam CRT alanları mevcutsa rsaSign bunları `node:crypto`
    // (OpenSSL, sabit zamanlı) ile imzalamak için kullanır; eksikse eski
    // BigInt tabanlı yola otomatik düşer (bkz. rsa.js).
    return rsaSign(signerKey, tbs, signerKey.hashAlg || 'sha256');
  }
  if (signerKey.keyType === 'ec') {
    return ecdsaSign(signerKey.curveName, signerKey.privateKey, tbs, signerKey.hashAlg);
  }
  throw new Error(`PKI: bilinmeyen anahtar türü ${signerKey.keyType}`);
}

/**
 * TBS verisini verilen anahtarla doğrular.
 * @param {Buffer} tbs
 * @param {Buffer} signature
 * @param {{ keyType, hashAlg, n?, e?, curveName?, publicKey?, publicKeyBuf? }} signerPub
 */
function _verify(tbs, signature, signerPub) {
  if (signerPub.keyType === 'rsa') {
    return rsaVerify({ n: signerPub.n, e: signerPub.e }, tbs, signature, signerPub.hashAlg || 'sha256');
  }
  if (signerPub.keyType === 'ec') {
    const pub = signerPub.publicKey || signerPub.publicKeyBuf;
    return ecdsaVerify(signerPub.curveName, pub, tbs, signature, signerPub.hashAlg);
  }
  throw new Error(`PKI: bilinmeyen anahtar türü ${signerPub.keyType}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sertifika oluşturucu
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {{
 *   serialNum: bigint,
 *   issuerName: Buffer,
 *   subjectName: Buffer,
 *   notBefore: Date, notAfter: Date,
 *   spki: Buffer,           // SubjectPublicKeyInfo
 *   extensions: Buffer[],
 *   signerKey: object,       // { keyType, hashAlg, ... }
 * }} opts
 */
function buildCert(opts) {
  const { serialNum, issuerName, subjectName, spki, extensions, signerKey } = opts;
  // Mimari koruma: notBefore/notAfter sessizce undefined geçilirse UTCTime()
  // içinde anlaşılmaz bir "Cannot read properties of undefined" hatasına
  // düşülüyordu. Açık ve anlaşılır bir hata ile erken durduruyoruz, ve
  // pratik kullanım için makul varsayılanlar sağlıyoruz.
  const notBefore = opts.notBefore || new Date();
  let notAfter = opts.notAfter;
  if (!notAfter) {
    notAfter = new Date(notBefore.getTime() + 365 * 86400000); // varsayılan: 1 yıl
  }
  if (!(notBefore instanceof Date) || isNaN(notBefore.getTime()))
    throw new Error('buildCert: notBefore geçerli bir Date olmalı');
  if (!(notAfter instanceof Date) || isNaN(notAfter.getTime()))
    throw new Error('buildCert: notAfter geçerli bir Date olmalı');
  if (!serialNum && serialNum !== 0n) throw new Error('buildCert: serialNum zorunlu');
  if (!issuerName) throw new Error('buildCert: issuerName zorunlu');
  if (!subjectName) throw new Error('buildCert: subjectName zorunlu');
  if (!spki) throw new Error('buildCert: spki zorunlu');
  if (!signerKey || !signerKey.keyType) throw new Error('buildCert: signerKey.keyType zorunlu');

  const version    = CTX(0, intSmall(2));
  const serial     = INT(serialNum);
  const signAlgId  = algId(signerKey.keyType, signerKey.hashAlg || 'sha256', signerKey.curveName);
  const validity   = SEQ(UTCTime(notBefore), UTCTime(notAfter));
  const extsWrapped = CTX(3, SEQ(...(extensions || [])));

  const tbs = SEQ(version, serial, signAlgId, issuerName, validity, subjectName, spki, extsWrapped);
  const sig  = _sign(tbs, signerKey);

  // EC imzası zaten DER kodlu SEQUENCE; RSA imzası ham byte dizisi.
  // İkisi de BIT STRING içine doğrudan sarmalanır.
  const sigBit = BIT(sig);

  const certDer = SEQ(tbs, signAlgId, sigBit);
  const b64 = certDer.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    pem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    der: certDer,
    tbs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RSA tabanlı CA sertifika fabrikaları
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RSA Kök CA üretir.
 * @param {{ bits?, hashAlg?, verbose? }} [opts]
 */
function generateRootCA(opts = {}) {
  const d = getDefaults();
  const { bits = d.key.rsaBits, hashAlg = d.key.hashAlg, verbose = false, validityDays = d.rootCA.validityDays } = opts;
  if (verbose) console.log(`\n[CA] Kök CA RSA-${bits} anahtar çifti üretiliyor`);
  const key  = generateRsaKeyPair(bits, verbose);
  const skid = computeRsaSKID(key.n, key.e);
  const name = buildName(resolveSubject('rootCA', opts, OIDs));
  const now = opts.notBefore || new Date();
  const exp = opts.notAfter || new Date(now.getTime() + validityDays * 86400000);
  const signerKey = { ...key, keyType: 'rsa', hashAlg };
  const cert = buildCert({
    serialNum: newSerial(), issuerName: name, subjectName: name,
    notBefore: now, notAfter: exp,
    spki: buildRsaSPKI(key.n, key.e),
    extensions: [
      extBasicConstraints(true, 1),
      extKeyUsage([KU.keyCertSign, KU.cRLSign, KU.digitalSignature]),
      extSKID(skid), extAKID(skid),
    ],
    signerKey,
  });
  return { ...key, keyType: 'rsa', hashAlg, skid, name, certPem: cert.pem, certDer: cert.der };
}

/**
 * RSA Ara CA üretir.
 */
function generateIntermediateCA(rootCA, opts = {}) {
  const d = getDefaults();
  const { bits = d.key.rsaBits, hashAlg = d.key.hashAlg, verbose = false, crlUrl = '', aiaUrl = '', validityDays = d.intermediateCA.validityDays } = opts;
  if (verbose) console.log(`\n[CA] Ara CA RSA-${bits} anahtar çifti üretiliyor`);
  const key  = generateRsaKeyPair(bits, verbose);
  const skid = computeRsaSKID(key.n, key.e);
  const name = buildName(resolveSubject('intermediateCA', opts, OIDs));
  const now = opts.notBefore || new Date();
  const exp = opts.notAfter || new Date(now.getTime() + validityDays * 86400000);
  const signerKey = { ...rootCA, keyType: rootCA.keyType, hashAlg: rootCA.hashAlg || 'sha256' };
  const _dpRsaInter = resolveDistributionPoints(opts, { crlSuffix: '/root.crl', caCertSuffix: '/root.crt' });
  const extensions = [
    extBasicConstraints(true, opts.pathLen !== undefined ? opts.pathLen : 0),
    extKeyUsage(opts.keyUsage || [KU.keyCertSign, KU.cRLSign, KU.digitalSignature], true),
    extSKID(skid), extAKID(rootCA.skid),
    ...(_dpRsaInter.cdp.length ? [extCDP(_dpRsaInter.cdp)] : []),
    ...(_dpRsaInter.aia ? [_dpRsaInter.aia] : []),
    ...(opts.policies ? [extCertificatePolicies(opts.policies, !!opts.policiesCritical)] : []),
    ...(opts.extraExtensions || []),
  ];
  const cert = buildCert({
    serialNum: newSerial(), issuerName: rootCA.name, subjectName: name,
    notBefore: now, notAfter: exp,
    spki: buildRsaSPKI(key.n, key.e),
    extensions, signerKey,
  });
  return { ...key, keyType: 'rsa', hashAlg, skid, name, certPem: cert.pem, certDer: cert.der };
}

/**
 * RSA Son Varlık (EE) sertifikası üretir.
 */
function generateEndEntityCert(issuerCA, hostname, opts = {}) {
  opts = applyProfile(opts.profile, opts);
  const d = getDefaults();
  const { bits = d.key.rsaBits, hashAlg = d.key.hashAlg, verbose = false, crlUrl = '', aiaUrl = '', sans = [], validityDays = d.endEntity.validityDays } = opts;
  if (verbose) console.log(`\n[CA] Sunucu (EE) sertifikası üretiliyor: ${hostname}`);
  const key  = generateRsaKeyPair(bits, verbose);
  const skid = computeRsaSKID(key.n, key.e);
  const name = buildName(resolveSubject('endEntity', opts, OIDs, hostname));
  const now = opts.notBefore || new Date();
  const exp = opts.notAfter || new Date(now.getTime() + validityDays * 86400000);
  const sanList = [{ type: 'dns', value: hostname }, ...sans];
  const signerKey = { ...issuerCA, keyType: issuerCA.keyType || 'rsa', hashAlg: issuerCA.hashAlg || 'sha256' };
  const {
    keyUsage = [KU.digitalSignature, KU.keyEncipherment], keyUsageCritical = true,
    eku = [OIDs.serverAuth, OIDs.clientAuth], ekuCritical = false,
    sanCritical = false, policies = null, policiesCritical = false,
    extraExtensions = [],
  } = opts;
  const { cdp, aia } = resolveDistributionPoints(opts, { crlSuffix: '/intermediate.crl', caCertSuffix: '/intermediate.crt' });
  const extensions = [
    extBasicConstraints(false),
    extKeyUsage(keyUsage, keyUsageCritical),
    ...(eku && eku.length ? [extEKU(eku, ekuCritical)] : []),
    extSKID(skid), extAKID(issuerCA.skid),
    extSAN(sanList, sanCritical),
    ...(cdp.length ? [extCDP(cdp)] : []),
    ...(aia ? [aia] : []),
    ...(policies ? [extCertificatePolicies(policies, policiesCritical)] : []),
    ...(opts.ocspNoCheck ? [ext(OIDs.ocspNoCheck, false, NULL())] : []),
    ...extraExtensions,
  ];
  const cert = buildCert({
    serialNum: newSerial(), issuerName: issuerCA.name, subjectName: name,
    notBefore: now, notAfter: exp,
    spki: buildRsaSPKI(key.n, key.e),
    extensions, signerKey,
  });
  return { ...key, keyType: 'rsa', hashAlg, skid, name, certPem: cert.pem, certDer: cert.der };
}

/**
 * EC anahtarlı bir Ara CA üretir; herhangi bir tür (RSA veya EC) Kök CA
 * tarafından imzalanabilir (hibrit zincir desteği).
 * @param {object} issuerCA   generateRootCA / generateEcRootCA çıktısı
 * @param {{ curveName?, hashAlg?, verbose?, crlUrl?, aiaUrl?, validityDays? }} [opts]
 */
function generateEcIntermediateCA(issuerCA, opts = {}) {
  const d = getDefaults();
  const {
    curveName = d.key.curve, hashAlg, verbose = false,
    crlUrl = '', aiaUrl = '', validityDays = d.hybridIntermediateCA.validityDays,
  } = opts;
  if (verbose) console.log(`\n[CA] Hibrit Ara CA (${curveName}) anahtar çifti üretiliyor`);
  const curve = CURVES[curveName];
  if (!curve) throw new Error(`generateEcIntermediateCA: bilinmeyen eğri ${curveName}`);
  const key  = generateEcKeyPair(curveName);
  const skid = computeEcSKID(key.publicKeyBuf);
  const name = buildName(resolveSubject('hybridIntermediateCA', opts, OIDs));
  const now = opts.notBefore || new Date();
  const exp = opts.notAfter || new Date(now.getTime() + validityDays * 86400000);

  // İmzalayan (issuer) RSA veya EC olabilir — issuerCA.keyType belirler.
  const signerKey = issuerCA.keyType === 'rsa'
    ? { ...issuerCA, keyType: 'rsa', hashAlg: issuerCA.hashAlg || 'sha256' }
    : { keyType: 'ec', curveName: issuerCA.curveName, hashAlg: issuerCA.hashAlg, privateKey: issuerCA.privateKey };

  const _dpEcInter = resolveDistributionPoints(opts, { crlSuffix: '/root.crl', caCertSuffix: '/root.crt' });
  const extensions = [
    extBasicConstraints(true, opts.pathLen !== undefined ? opts.pathLen : 0),
    extKeyUsage(opts.keyUsage || [KU.keyCertSign, KU.cRLSign, KU.digitalSignature], true),
    extSKID(skid), extAKID(issuerCA.skid),
    ...(_dpEcInter.cdp.length ? [extCDP(_dpEcInter.cdp)] : []),
    ...(_dpEcInter.aia ? [_dpEcInter.aia] : []),
    ...(opts.policies ? [extCertificatePolicies(opts.policies, !!opts.policiesCritical)] : []),
    ...(opts.extraExtensions || []),
  ];
  const cert = buildCert({
    serialNum: newSerial(), issuerName: issuerCA.name, subjectName: name,
    notBefore: now, notAfter: exp,
    spki: buildEcSPKI(curveName, key.publicKeyBuf),
    extensions, signerKey,
  });
  return {
    ...key, keyType: 'ec', curveName, hashAlg: hashAlg || curve.hashAlg,
    skid, name, certPem: cert.pem, certDer: cert.der,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EC tabanlı CA sertifika fabrikaları
// ─────────────────────────────────────────────────────────────────────────────

/**
 * EC Kök CA üretir.
 * @param {{ curveName?, verbose? }} [opts]
 */
function generateEcRootCA(opts = {}) {
  const d = getDefaults();
  const { curveName = d.key.curve, verbose = false, validityDays = d.ecRootCA.validityDays } = opts;
  if (verbose) console.log(`\n[CA] EC Kök CA (${curveName}) anahtar çifti üretiliyor`);
  const key  = generateEcKeyPair(curveName);
  const skid = computeEcSKID(key.publicKeyBuf);
  const curve = CURVES[curveName];
  const name = buildName(resolveSubject('ecRootCA', { ...opts, curveName }, OIDs));
  const now = opts.notBefore || new Date();
  const exp = opts.notAfter || new Date(now.getTime() + validityDays * 86400000);
  const signerKey = { keyType: 'ec', curveName, hashAlg: curve.hashAlg, privateKey: key.privateKey };
  const cert = buildCert({
    serialNum: newSerial(), issuerName: name, subjectName: name,
    notBefore: now, notAfter: exp,
    spki: buildEcSPKI(curveName, key.publicKeyBuf),
    extensions: [
      extBasicConstraints(true, 1),
      extKeyUsage([KU.keyCertSign, KU.cRLSign, KU.digitalSignature]),
      extSKID(skid), extAKID(skid),
    ],
    signerKey,
  });
  return { ...key, keyType: 'ec', curveName, hashAlg: curve.hashAlg, skid, name, certPem: cert.pem, certDer: cert.der };
}

/**
 * EC Son Varlık (EE) sertifikası üretir.
 */
function generateEcEndEntityCert(issuerCA, hostname, opts = {}) {
  opts = applyProfile(opts.profile, opts);
  const d = getDefaults();
  const { curveName = d.key.curve, verbose = false, crlUrl = '', aiaUrl = '', sans = [], validityDays = d.ecEndEntity.validityDays } = opts;
  if (verbose) console.log(`\n[CA] EC Sunucu (EE) sertifikası üretiliyor: ${hostname}`);
  const key  = generateEcKeyPair(curveName);
  const skid = computeEcSKID(key.publicKeyBuf);
  const curve = CURVES[curveName];
  const name = buildName(resolveSubject('ecEndEntity', opts, OIDs, hostname));
  const now = opts.notBefore || new Date();
  const exp = opts.notAfter || new Date(now.getTime() + validityDays * 86400000);
  const sanList = [{ type: 'dns', value: hostname }, ...sans];
  const signerKey = { ...issuerCA };
  const {
    keyUsage = [KU.digitalSignature], keyUsageCritical = true,
    eku = [OIDs.serverAuth, OIDs.clientAuth], ekuCritical = false,
    sanCritical = false, policies = null, policiesCritical = false,
    extraExtensions = [],
  } = opts;
  const { cdp, aia } = resolveDistributionPoints(opts, { crlSuffix: '/ec-intermediate.crl', caCertSuffix: '/ec-intermediate.crt' });
  const extensions = [
    extBasicConstraints(false),
    extKeyUsage(keyUsage, keyUsageCritical),
    ...(eku && eku.length ? [extEKU(eku, ekuCritical)] : []),
    extSKID(skid), extAKID(issuerCA.skid),
    extSAN(sanList, sanCritical),
    ...(cdp.length ? [extCDP(cdp)] : []),
    ...(aia ? [aia] : []),
    ...(policies ? [extCertificatePolicies(policies, policiesCritical)] : []),
    ...(opts.ocspNoCheck ? [ext(OIDs.ocspNoCheck, false, NULL())] : []),
    ...extraExtensions,
  ];
  const cert = buildCert({
    serialNum: newSerial(), issuerName: issuerCA.name, subjectName: name,
    notBefore: now, notAfter: exp,
    spki: buildEcSPKI(curveName, key.publicKeyBuf),
    extensions, signerKey,
  });
  return { ...key, keyType: 'ec', curveName, hashAlg: curve.hashAlg, skid, name, certPem: cert.pem, certDer: cert.der };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSR (PKCS#10) — [0] IMPLICIT SET BUG DÜZELTİLDİ
// ─────────────────────────────────────────────────────────────────────────────
/**
 * CSR oluşturur.
 * @param {{ keyType, n?, e?, d?, curveName?, privateKey?, publicKeyBuf? }} keyInfo
 * @param {Array} nameAttrs   [[oid, value], ...]
 * @param {Array} [sans]      [{ type, value }, ...]
 * @param {'sha256'|'sha384'|'sha512'} [hashAlg]
 */
function generateCSR(keyInfo, nameAttrs, sans = [], hashAlg) {
  const name = buildName(nameAttrs);
  let spki;
  if (keyInfo.keyType === 'rsa') {
    spki = buildRsaSPKI(keyInfo.n, keyInfo.e);
  } else {
    spki = buildEcSPKI(keyInfo.curveName, keyInfo.publicKeyBuf);
  }

  // Uzantı isteği özelliği (Attribute)
  // RFC 2986: CertificationRequestInfo.attributes = [0] IMPLICIT SET OF Attribute
  // Düzeltme: CTX(0, attr) — fazladan SET katmanı KALDIRILDI (spurious zero bits hatası bu yüzden oluşuyordu)
  const sanExt  = sans.length > 0 ? extSAN(sans) : null;
  const extsSeq = sanExt ? SEQ(sanExt) : SEQ();  // Extensions = SEQUENCE OF Extension

  // Attribute = SEQUENCE { attrType OID, attrValues SET { Extensions } }
  const attr = SEQ(OID(OIDs.extensionReq), SET(extsSeq));

  // [0] IMPLICIT SET OF Attribute → tag 0xa0, içerik = Attribute DER baytları (SET etiketi olmadan)
  const csrInfo = SEQ(intSmall(0), name, spki, CTX(0, attr));

  const ha = hashAlg || (keyInfo.keyType === 'ec' ? CURVES[keyInfo.curveName].hashAlg : 'sha256');
  const signAlgId = algId(keyInfo.keyType, ha, keyInfo.curveName);
  const sig = _sign(csrInfo, { ...keyInfo, hashAlg: ha });
  const sigBit = BIT(sig);

  const csrDer = SEQ(csrInfo, signAlgId, sigBit);
  const b64 = csrDer.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE REQUEST-----\n${b64}\n-----END CERTIFICATE REQUEST-----\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CRL (RFC 5280)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * CRL oluşturur.
 * @param {{ keyType, hashAlg, n?, d?, curveName?, privateKey?, skid, name }} issuerCA
 * @param {{ serial: bigint, date?: Date, reason?: number }[]} revokedList
 */
function generateCRL(issuerCA, revokedList = [], opts = {}) {
  const nextUpdateDays = opts.nextUpdateDays !== undefined ? opts.nextUpdateDays : getDefaults().crl.nextUpdateDays;
  const now  = opts.thisUpdate || new Date();
  const next = opts.nextUpdate || new Date(now.getTime() + nextUpdateDays * 86400000);
  const signAlgId = algId(issuerCA.keyType, issuerCA.hashAlg || 'sha256', issuerCA.curveName);

  const revokedEntries = revokedList.map(r =>
    SEQ(
      INT(r.serial),
      UTCTime(r.date || now),
      // DÜZELTME: CTX(0) sarmalayıcısı kaldırıldı. Doğrudan SEQUENCE olmalı.
      SEQ(SEQ(OID('551d15'), OCT(ENUM(r.reason || 0))))
    )
  );

  const tbs = SEQ(
    intSmall(1),                           // version v2
    signAlgId,
    issuerCA.name,
    UTCTime(now),
    UTCTime(next),
    revokedEntries.length ? SEQ(...revokedEntries) : null,
    CTX(0, SEQ(
      SEQ(OID(OIDs.crlNumber), OCT(INT(newSerial() & 0xffffn))),
      extAKID(issuerCA.skid),
    ))
  );

  const sig    = _sign(tbs, { ...issuerCA });
  const crlDer = SEQ(tbs, signAlgId, BIT(sig));
  // PEM formata çevirip dönüyoruz
  const b64 = crlDer.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN X509 CRL-----\n${b64}\n-----END X509 CRL-----\n`;
}

/**
 * CRL PEM'ini çözümler ve iptal edilen sertifikaların listesini döner.
 * Not: İmza DOĞRULAMASI yapmaz — sadece yapısal alanları okur. İmza
 * doğrulaması için verifyOcspResponse'a benzer ayrı bir akış kullanılabilir
 * veya openssl ile çapraz kontrol edilebilir (bkz. test.js).
 * @param {string} pem
 * @returns {{ revoked: Map<string, {reason:number, date:Date}>, thisUpdate:Date, nextUpdate:Date }}
 */
function parseCRL(pem) {
  const der = Buffer.from(
    pem.split('\n').filter(l => l && !l.startsWith('-----')).join(''),
    'base64',
  );
  const top = readTLV(der, 0);                 // CertificateList SEQUENCE
  const top2 = readChildren(top.content);
  const tbs = top2[0];                         // TBSCertList SEQUENCE
  const tbsChildren = readChildren(tbs.content);

  // TBSCertList ::= SEQUENCE { version, signature, issuer, thisUpdate,
  //                            nextUpdate, revokedCertificates SEQUENCE OF?, crlExtensions [0]? }
  let idx = 0;
  // version INTEGER (v2 = intSmall(1)) — generateCRL her zaman yazıyor
  idx++; // version
  idx++; // signature AlgorithmIdentifier
  idx++; // issuer Name
  const thisUpdateNode = tbsChildren[idx++];
  const nextUpdateNode = tbsChildren[idx++];

  const revoked = new Map();
  // Kalan alanlar: revokedCertificates (SEQUENCE, tag 0x30) ve/veya crlExtensions ([0], tag 0xa0)
  for (; idx < tbsChildren.length; idx++) {
    const node = tbsChildren[idx];
    if (node.tag === 0x30) {
      // revokedCertificates SEQUENCE OF SEQUENCE { userCertificate, revocationDate, crlEntryExtensions? }
      const entries = readChildren(node.content);
      for (const entryNode of entries) {
        const entryChildren = readChildren(entryNode.content);
        const serial = derIntToBigInt(entryChildren[0].content);
        let reason = 0;
        if (entryChildren[2]) {
          // crlEntryExtensions SEQUENCE OF Extension — reasonCode extension'ını ara
          const exts = readChildren(entryChildren[2].content);
          for (const extNode of exts) {
            const extChildren = readChildren(extNode.content);
            if (extChildren[0].content.toString('hex') === '551d15') { // reasonCode OID
              const ocst = extChildren[extChildren.length - 1];
              const enumNode = readTLV(ocst.content, 0);
              reason = enumNode.content[0];
            }
          }
        }
        revoked.set(serial.toString(16), { reason, date: entryChildren[1] });
      }
    }
  }
  return { revoked, thisUpdateNode, nextUpdateNode };
}

// ─────────────────────────────────────────────────────────────────────────────
// OCSP (RFC 6960) — İstek çözümleme + İmzalı Yanıt Üretimi
// ─────────────────────────────────────────────────────────────────────────────
const OCSP_OIDs = {
  basicResponse: '2b0601050507300101',   // id-pkix-ocsp-basic
  nonce:         '2b0601050507300102',   // id-pkix-ocsp-nonce
};

// CertID.hashAlgorithm OID'inden algoritma adına ters eşleştirme.
const HASH_OID_TO_NAME = {
  [OIDs.sha1]:   'sha1',
  [OIDs.sha256]: 'sha256',
  [OIDs.sha384]: 'sha384',
  [OIDs.sha512]: 'sha512',
};
function hashAlgFromOid(oidHex) {
  const name = HASH_OID_TO_NAME[oidHex];
  if (!name) throw new Error(`OCSP: desteklenmeyen hashAlgorithm OID ${oidHex}`);
  return name;
}

/**
 * issuer'ın SPKI BIT STRING içeriğinden (sıkıştırılmamış EC noktası veya
 * RSA SPKI ham anahtar baytları) issuerKeyHash hesaplar.
 * RFC 6960: issuerKeyHash = HASH(issuer public key BIT STRING içeriği,
 * tag/length hariç sadece anahtar baytları — SPKI'nin subjectPublicKey alanı).
 * `hashAlg` burada isteğin CertID.hashAlgorithm alanına göre değişebilir
 * (örn. openssl varsayılan olarak sha1, -sha256 ile sha256 kullanır).
 */
function _ocspIssuerKeyHash(issuerCA, hashAlg) {
  let keyBytes;
  if (issuerCA.keyType === 'rsa') {
    keyBytes = SEQ(INT(issuerCA.n), INT(issuerCA.e));
  } else {
    keyBytes = issuerCA.publicKeyBuf;
  }
  return hashByName(hashAlg, keyBytes);
}

function _ocspIssuerNameHash(issuerCA, hashAlg) {
  return hashByName(hashAlg, issuerCA.name);
}

/**
 * RFC 6960 §4.2.1 — ResponderID.byKey (KeyHash) hesaplaması.
 * Bu alan protokol tarafından SABİT SHA-1 olarak tanımlanmıştır;
 * CertID.hashAlgorithm seçimine bağlı DEĞİLDİR. OpenSSL gibi sıkı
 * doğrulayıcılar, certs[] içindeki adayların SPKI'sini SHA-1 ile
 * hashleyip ResponderID ile eşleştirir; başka bir algoritma kullanmak
 * "signer certificate not found" hatasına yol açar.
 * @param {{ keyType, publicKeyBuf?, n?, e? }} keyOwner
 */
function _ocspResponderKeyHashSha1(keyOwner) {
  let keyBytes;
  if (keyOwner.keyType === 'rsa') {
    keyBytes = SEQ(INT(keyOwner.n), INT(keyOwner.e));
  } else {
    keyBytes = keyOwner.publicKeyBuf;
  }
  return hashByName('sha1', keyBytes);
}

/**
 * Gelen OCSPRequest (DER) içinden istenen sertifika seri numaralarını
 * (CertID listesi) çıkarır. RFC 6960 §4.1.1:
 *   OCSPRequest ::= SEQUENCE { tbsRequest TBSRequest, ... }
 *   TBSRequest  ::= SEQUENCE { version [0] EXPLICIT, requestorName [1]?,
 *                              requestList SEQUENCE OF Request, ... }
 *   Request     ::= SEQUENCE { reqCert CertID, singleRequestExtensions [0]? }
 *   CertID      ::= SEQUENCE { hashAlgorithm, issuerNameHash OCTET STRING,
 *                              issuerKeyHash OCTET STRING, serialNumber INTEGER }
 */
function parseOcspRequest(derBuf) {
  const top = readTLV(derBuf, 0);              // OCSPRequest SEQUENCE
  const tbsNode = readTLV(top.content, 0);      // tbsRequest SEQUENCE
  const tbsChildren = readChildren(tbsNode.content);

  // version [0] EXPLICIT INTEGER DEFAULT v1 — context tag 0xa0 ile başlarsa atla
  let idx = 0;
  if (tbsChildren[idx] && tbsChildren[idx].tag === 0xa0) idx++;
  // requestorName [1] EXPLICIT — context tag 0xa1 ile başlarsa atla
  if (tbsChildren[idx] && tbsChildren[idx].tag === 0xa1) idx++;

  const requestListNode = tbsChildren[idx]; // requestList SEQUENCE OF Request
  if (!requestListNode || requestListNode.tag !== 0x30)
    throw new Error('OCSP: requestList bulunamadı (geçersiz istek)');
  idx++;

  const requests = readChildren(requestListNode.content).map(reqNode => {
    const reqChildren = readChildren(reqNode.content);
    const certIdNode = reqChildren[0]; // CertID SEQUENCE
    const certIdChildren = readChildren(certIdNode.content);
    // CertID ::= SEQUENCE { hashAlgorithm AlgorithmIdentifier, issuerNameHash OCTET STRING,
    //                        issuerKeyHash OCTET STRING, serialNumber INTEGER }
    const hashAlgOidNode = readChildren(certIdChildren[0].content)[0];
    const serialNode = certIdChildren[3];
    return {
      hashAlgOid: hashAlgOidNode.content.toString('hex'),
      issuerNameHash: certIdChildren[1].content,
      issuerKeyHash: certIdChildren[2].content,
      serialNumber: derIntToBigInt(serialNode.content),
    };
  });

  // requestExtensions [2] EXPLICIT Extensions OPTIONAL — RFC 6960 §4.4.1 nonce
  // uzantısını (varsa) çıkar. Nonce, tekrar oynatma (replay) saldırılarına
  // karşı tazelik kanıtı sağlar: istemci rastgele bir nonce gönderir,
  // responder aynısını yanıtta (bkz. generateOcspResponse `opts.nonce`) geri
  // yansıtır ve istemci eşleşmeyi kontrol eder.
  let nonce = null;
  if (tbsChildren[idx] && tbsChildren[idx].tag === 0xa2) {
    const extsSeq = readTLV(tbsChildren[idx].content, 0);
    for (const extNode of readChildren(extsSeq.content)) {
      const extChildren = readChildren(extNode.content);
      if (extChildren[0].content.toString('hex') === OCSP_OIDs.nonce) {
        // extnValue OCTET STRING'in içeriği, Nonce ::= OCTET STRING'in
        // KENDİSİNİN DER kodlamasıdır (bir TLV) — bu yüzden bir kat daha
        // "unwrap" gerekir. (Gerçek bir openssl OCSP isteğiyle
        // `openssl asn1parse` çıktısı karşılaştırılarak doğrulanmıştır.)
        const extnValueNode = extChildren[extChildren.length - 1];
        nonce = readTLV(extnValueNode.content, 0).content;
      }
    }
  }

  return { requests, nonce };
}

/**
 * İstemci tarafında imzasız bir OCSP isteği (OCSPRequest, RFC 6960 §4.1.1)
 * inşa eder. Bu, `parseOcspRequest`'in tam tersidir — bir OCSP responder'a
 * HTTP üzerinden gönderilecek DER gövdesini üretir.
 * @param {object} issuerCA        Sorgulanan sertifikayı imzalayan CA (issuerNameHash/issuerKeyHash için)
 * @param {bigint|bigint[]} serialNumbers  Sorgulanacak seri numarası (veya numaraları)
 * @param {{ hashAlg?: 'sha1'|'sha256'|'sha384'|'sha512', nonce?: Buffer|boolean }} [opts]
 *   `nonce: true` verilirse 16 baytlık rastgele bir nonce otomatik üretilir ve döndürülen
 *   nesnede `nonce` alanı olarak da verilir (yanıt geldiğinde eşleştirmek için).
 * @returns {{ der: Buffer, nonce: Buffer|null }}
 */
function buildOcspRequest(issuerCA, serialNumbers, opts = {}) {
  const hashAlg = opts.hashAlg || 'sha1'; // RFC 6960 uyumlu responder'ların çoğu sha1 CertID bekler (bkz. openssl varsayılanı)
  const hashOid = OIDs[hashAlg];
  if (!hashOid) throw new Error(`buildOcspRequest: bilinmeyen hashAlg ${hashAlg}`);
  const serials = Array.isArray(serialNumbers) ? serialNumbers : [serialNumbers];

  const issuerNameHash = hashByName(hashAlg, issuerCA.name);
  const issuerKeyHash = _ocspIssuerKeyHash(issuerCA, hashAlg);

  const requestList = SEQ(...serials.map(serial => SEQ(
    SEQ(
      SEQ(OID(hashOid), NULL()),
      OCT(issuerNameHash),
      OCT(issuerKeyHash),
      INT(serial),
    ),
  )));

  let nonce = null;
  const extParts = [];
  if (opts.nonce) {
    nonce = Buffer.isBuffer(opts.nonce) ? opts.nonce : randomBytes(16);
    extParts.push(SEQ(OID(OCSP_OIDs.nonce), OCT(OCT(nonce))));
  }
  const reqExtCtx = extParts.length ? CTX(2, SEQ(...extParts)) : null;

  const tbsRequest = SEQ(requestList, reqExtCtx);
  const der = SEQ(tbsRequest);
  return { der, nonce };
}

// RFC 6960 §4.2.1 OCSPResponseStatus. Bunlar İMZASIZ yanıtlardır ve öyle
// olmaları gerekir: imzalayabilmek için önce isteği anlamak gerekir, oysa bu
// yanıtların var olma sebebi isteğin anlaşılamamasıdır.
const OCSP_RESPONSE_STATUS = {
  successful: 0,
  malformedRequest: 1,
  internalError: 2,
  tryLater: 3,
  sigRequired: 5,
  unauthorized: 6,
};

/**
 * İmzasız bir OCSP hata yanıtı üretir (RFC 6960 §4.2.1).
 *
 * Bir responder, ayrıştıramadığı bir isteğe HTTP 500 ile cevap VERMEMELİ:
 * 500, "responder bozuk" demektir ve istemciler bunu geçici bir arıza sayıp
 * yeniden dener, hatta iptal kontrolünü atlar. `malformedRequest` ise
 * "isteğin bozuk" der -- düzeltmesi gereken tarafı doğru gösterir.
 */
function buildOcspErrorResponse(statusName) {
  const code = OCSP_RESPONSE_STATUS[statusName];
  if (code === undefined) throw new Error(`buildOcspErrorResponse: bilinmeyen durum '${statusName}'`);
  if (code === 0) throw new Error('buildOcspErrorResponse: successful bir hata durumu değil');
  // OCSPResponse ::= SEQUENCE { responseStatus ENUMERATED, responseBytes [0] OPTIONAL }
  // Hata yanıtlarında responseBytes YOKTUR.
  return SEQ(ENUM(code));
}

/**
 * RFC 6960 imzalı OCSP yanıtı (BasicOCSPResponse içinde tekil
 * SingleResponse listesi) üretir.
 *
 * @param {{ requests: {serialNumber:bigint}[] }} ocspRequest  parseOcspRequest çıktısı
 * @param {object} issuerCA     Sertifikaları imzalayan CA (issuerNameHash/issuerKeyHash bunun için hesaplanır)
 * @param {object} responderKey OCSP yanıtını imzalayan anahtar { keyType, hashAlg, n?, d?, curveName?, privateKey? }
 * @param {Buffer} responderCertDer  OCSP responder'ın kendi sertifikası (DER) — yanıta gömülür
 * @param {Map<string,{status:'good'|'revoked', reason?:number, revokedAt?:Date}>} statusMap  serial(hex) → durum
 */
function generateOcspResponse(ocspRequest, issuerCA, responderKey, responderCertDer, statusMap, opts = {}) {
  const now = new Date();
  const thisUpdate = now;
  const nextUpdateDays = opts.nextUpdateDays !== undefined ? opts.nextUpdateDays : 7;
  const nextUpdate = new Date(now.getTime() + nextUpdateDays * 86400000);

  // Bilinmeyen bir seri için varsayılan 'unknown'dır, 'good' DEĞİL.
  //
  // Eskiden `statusMap.get(key) || { status: 'good' }` idi: CA'nın hiç
  // üretmediği bir seri sorulduğunda yetkili responder "iptal edilmemiş"
  // diyordu. Uydurma seri numarası taşıyan bir sertifika, bu sayede kendi
  // CA'sından olumlu bir iptal cevabı alabilirdi. RFC 6960 §2.2, responder'ın
  // "sertifikanın durumu hakkında bilgisi yok" demesi gereken durum için
  // `unknown` tanımlar; `good` yalnızca "bu sertifikayı biliyorum ve iptal
  // edilmedi" anlamına gelir.
  //
  // `opts.defaultStatus` ile eski davranışa dönülebilir, ama bunun ne demek
  // olduğunu bilerek yapılması gerekir.
  const defaultStatus = opts.defaultStatus || 'unknown';

  const singleResponses = ocspRequest.requests.map(req => {
    const key = req.serialNumber.toString(16);
    const entry = statusMap.get(key) || { status: defaultStatus };

    // CertID.hashAlgorithm: isteğin kullandığı algoritmayı yansıtıyoruz —
    // sabit bir algoritma dayatmak, farklı istemcilerle (örn. openssl'in
    // varsayılan SHA-1 isteği) issuerNameHash/issuerKeyHash uyuşmazlığına
    // ve dolayısıyla "yanlış sertifika" yanıtına yol açar.
    const reqHashAlg = req.hashAlgOid ? hashAlgFromOid(req.hashAlgOid) : 'sha256';
    const reqHashOid = OIDs[reqHashAlg];
    const issuerNameHash = _ocspIssuerNameHash(issuerCA, reqHashAlg);
    const issuerKeyHash  = _ocspIssuerKeyHash(issuerCA, reqHashAlg);

    const certId = SEQ(
      SEQ(OID(reqHashOid), NULL()),
      OCT(issuerNameHash),
      OCT(issuerKeyHash),
      INT(req.serialNumber),
    );

    let certStatus;
    if (entry.status === 'revoked') {
      // certStatus [1] IMPLICIT RevokedInfo ::= SEQUENCE { revocationTime, revocationReason [0]? }
      // RevokedInfo bir SEQUENCE (constructed) olduğundan [1] tag'i constructed olmalı (0xa1).
      const revInner = entry.reason !== undefined
        ? Buffer.concat([GenTime(entry.revokedAt || now), CTX(0, ENUM(entry.reason))])
        : GenTime(entry.revokedAt || now);
      certStatus = CTX(1, revInner);
    } else if (entry.status === 'unknown') {
      // certStatus [2] IMPLICIT UnknownInfo ::= NULL
      // NULL primitive olduğundan bağlam etiketi de primitive olmalı (0x82).
      certStatus = CTXI(2, Buffer.alloc(0));
    } else {
      // certStatus [0] IMPLICIT NULL = good
      // NULL primitive bir tip olduğundan [0] tag'i de primitive olmalı (0x80, CTXI).
      // CTX (constructed 0xa0) kullanmak OpenSSL gibi sıkı DER ayrıştırıcılarda
      // "type not primitive" hatasına yol açar.
      certStatus = CTXI(0, Buffer.alloc(0));
    }

    return SEQ(certId, certStatus, GenTime(thisUpdate), CTX(0, GenTime(nextUpdate)));
  });

  // ResponderID ::= CHOICE { byName [1] Name, byKey [2] KeyHash }
  // KeyHash, RFC 6960 §4.2.1 uyarınca protokol tarafından SABİT SHA-1 olarak
  // tanımlıdır (CertID.hashAlgorithm veya sertifikanın kendi SKID'inden
  // BAĞIMSIZDIR). Burada responderKey.skid (SHA-256 tabanlı) KULLANILMAZ.
  const responderKeyHash = _ocspResponderKeyHashSha1(responderKey);
  const responderId = CTX(2, OCT(responderKeyHash));

  // responseExtensions [1] EXPLICIT Extensions OPTIONAL — istekte bir nonce
  // (bkz. parseOcspRequest) varsa, RFC 6960 §4.4.1 uyarınca AYNEN geri
  // yansıtılır. Bu, istemcinin yanıtın "taze" (tekrar oynatılmamış)
  // olduğunu doğrulamasını sağlar.
  const respExtCtx = ocspRequest.nonce
    ? CTX(1, SEQ(SEQ(OID(OCSP_OIDs.nonce), OCT(OCT(ocspRequest.nonce)))))
    : null;

  const tbsResponseData = SEQ(
    responderId,
    GenTime(now),
    SEQ(...singleResponses),
    respExtCtx,
  );

  const signAlgId = algId(responderKey.keyType, responderKey.hashAlg || 'sha256', responderKey.curveName);
  const sig = _sign(tbsResponseData, responderKey);
  const sigBit = BIT(sig);

  const certsCtx = responderCertDer ? CTX(0, SEQ(responderCertDer)) : null;
  const basicResponse = SEQ(tbsResponseData, signAlgId, sigBit, certsCtx);

  // OCSPResponse ::= SEQUENCE { responseStatus ENUM(0=successful), responseBytes [0]? }
  const responseBytes = CTX(0, SEQ(
    OID(OCSP_OIDs.basicResponse),
    OCT(basicResponse),
  ));
  const ocspResponseDer = SEQ(ENUM(0), responseBytes);
  return ocspResponseDer;
}

/**
 * OCSP yanıtının imzasını, imzalayanın (responder) public anahtarına göre doğrular.
 * @param {Buffer} ocspResponseDer
 * @param {{ keyType, hashAlg, n?, e?, curveName?, publicKey?, publicKeyBuf? }} responderPub
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifyOcspResponse(ocspResponseDer, responderPub) {
  const top = readTLV(ocspResponseDer, 0);
  const children = readChildren(top.content);
  const status = children[0].content[0];
  if (status !== 0) return { ok: false, reason: 'responseStatus != successful' };

  // responseBytes [0] EXPLICIT SEQUENCE { responseType OID, response OCTET STRING }
  const responseBytesExplicit = readTLV(children[1].content, 0);
  const rbChildren = readChildren(responseBytesExplicit.content);
  const basicResponseOct = rbChildren[1]; // OCTET STRING — içeriği BasicOCSPResponse DER'i

  // BasicOCSPResponse ::= SEQUENCE { tbsResponseData, signatureAlgorithm, signature BIT STRING, certs [0]? }
  const basicResponse = readTLV(basicResponseOct.content, 0);
  const brChildren = readChildren(basicResponse.content);

  const tbsNode = brChildren[0];
  const sigNode = brChildren[2]; // BIT STRING
  const sig = sigNode.content.subarray(1); // ilk bayt = kullanılmayan bit sayacı

  // İmzalanan veri, tbsResponseData'nın TAM TLV baytlarıdır (tag+length+content),
  // SEQUENCE içeriği değil — bu yüzden orijinal buffer'dan totalLen ile dilimliyoruz.
  const tbsFullBytes = basicResponse.content.subarray(0, tbsNode.totalLen);

  const ok = _verify(tbsFullBytes, sig, responderPub);
  return { ok };
}

// ─────────────────────────────────────────────────────────────────────────────
// Genel sertifika fabrikası
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Birleşik sertifika üretim merkezi.
 * @param {{ type: 'rootCA'|'intermediateCA'|'endEntity', keyAlgo: 'rsa'|'ec', ... }} config
 */
function createCertificate(config) {
  const { type, keyAlgo = 'rsa' } = config;

  if (keyAlgo === 'rsa') {
    const rsaOpts = { bits: config.bits || 2048, hashAlg: config.hashAlg || 'sha256', verbose: config.verbose };
    if (type === 'rootCA')         return generateRootCA(rsaOpts);
    if (type === 'intermediateCA') return generateIntermediateCA(config.issuerCA, { ...rsaOpts, crlUrl: config.crlUrl, aiaUrl: config.aiaUrl });
    if (type === 'endEntity')      return generateEndEntityCert(config.issuerCA, config.hostname, { ...rsaOpts, crlUrl: config.crlUrl, aiaUrl: config.aiaUrl, sans: config.sans });
  }

  if (keyAlgo === 'ec') {
    const ecOpts = { curveName: config.curveName || 'P-256', verbose: config.verbose };
    if (type === 'rootCA')         return generateEcRootCA(ecOpts);
    if (type === 'endEntity')      return generateEcEndEntityCert(config.issuerCA, config.hostname, { ...ecOpts, crlUrl: config.crlUrl, aiaUrl: config.aiaUrl, sans: config.sans });
  }

  throw new Error(`createCertificate: geçersiz tür/algoritma: ${type}/${keyAlgo}`);
}

module.exports = {
  generateRootCA, generateIntermediateCA, generateEndEntityCert,
  generateEcRootCA, generateEcIntermediateCA, generateEcEndEntityCert,
  generateCSR, generateCRL, parseCRL,
  generateOcspResponse, parseOcspRequest, verifyOcspResponse, buildOcspRequest,
  buildOcspErrorResponse, OCSP_RESPONSE_STATUS,
  createCertificate, newSerial, buildCert,
};