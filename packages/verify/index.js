'use strict';
/**
 * @fitfak/verify — PDF imza doğrulama motoru.
 *
 * ETSI TS 119 102-1 biçiminde bir doğrulama raporu üretir; Web Studio'daki
 * imza paneli bu raporu render eder. Doğrulama mantığının tamamı burada,
 * arayüzde hiç yoktur.
 *
 * Doğrulama adımları:
 *   1. Revizyon analizi — imzadan sonra belge değiştirilmiş mi?
 *   2. ByteRange kapsamı — imza belgenin tamamını kapsıyor mu?
 *   3. CMS doğrulaması — signedAttrs, message-digest, signing-certificate-v2
 *   4. Zincir kurulumu ve güven çıpasına ulaşma
 *   5. İptal kontrolü — önce DSS (çevrimdışı LTV), sonra ağ (izin verilirse)
 *   6. Zaman damgası doğrulaması ve POE hesabı
 *   7. Seviye tespiti (B-B / B-T / B-LT / B-LTA)
 */

const crypto = require('crypto');
const tls = require('tls');

const {
  findAllSignatures, readLastTrailer, readObject
} = require('@fitfak/pades/src/utils/pdf_parser');
const ext = require('@fitfak/pades/src/cades/x509_ext');
const cms = require('./src/cms');
const { parseCrl, checkCrl } = require('@fitfak/pades/src/cades/crl');

class VerifyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VerifyError';
    this.code = code;
  }
}

/** ETSI TS 119 102-1 ana göstergeleri */
const INDICATION = {
  PASSED: 'TOTAL-PASSED',
  FAILED: 'TOTAL-FAILED',
  INDETERMINATE: 'INDETERMINATE'
};

/**
 * PDF'teki tüm imzaları doğrular.
 *
 * @param {Buffer} pdfBuffer
 * @param {Object} [opts]
 * @param {string[]} [opts.trustAnchors] Güvenilen kök sertifikalar (PEM). Varsayılan: sistem deposu
 * @param {Date}     [opts.validationTime]
 * @param {boolean}  [opts.useEmbeddedRevocation=true] DSS'teki kanıtı tercih et
 * @param {boolean}  [opts.allowNetwork=false] Çevrimdışı doğrulama testleri için false
 * @returns {Promise<Object>} doğrulama raporu
 */
async function verifyPdf(pdfBuffer, opts = {}) {
  if (!Buffer.isBuffer(pdfBuffer)) {
    throw new VerifyError('ERR_VERIFY_INPUT', 'verifyPdf: Buffer bekleniyor');
  }

  const validationTime = opts.validationTime || new Date();
  const useEmbedded = opts.useEmbeddedRevocation !== false;

  const trustAnchors = (opts.trustAnchors && opts.trustAnchors.length
    ? opts.trustAnchors
    : Array.from(tls.rootCertificates)).map(safePemToDer).filter(Boolean);

  const signatures = findAllSignatures(pdfBuffer);
  const revisions = findRevisions(pdfBuffer);
  const dss = readDss(pdfBuffer);

  const report = {
    documentIntegrity: {
      revisions: revisions.length,
      byteLength: pdfBuffer.length,
      signatureCount: signatures.length,
      modifiedAfterSigning: false,
      unsignedBytes: 0
    },
    signatures: [],
    ltv: {
      dssPresent: !!dss,
      certs: dss ? dss.certs.length : 0,
      ocsps: dss ? dss.ocsps.length : 0,
      crls: dss ? dss.crls.length : 0,
      vriKeys: dss ? Object.keys(dss.vri) : [],
      offlineVerifiable: false
    },
    validationTime: validationTime.toISOString(),
    warnings: []
  };

  if (!signatures.length) {
    report.warnings.push('Belgede imza bulunamadı.');
    return report;
  }

  // En geniş ByteRange, belgenin ne kadarının imzalandığını söyler
  let maxCovered = 0;
  for (const sig of signatures) {
    if (!sig.byteRange || sig.byteRange.length < 4) continue;
    const covered = sig.byteRange[2] + sig.byteRange[3];
    if (covered > maxCovered) maxCovered = covered;
  }
  report.documentIntegrity.unsignedBytes = Math.max(0, pdfBuffer.length - maxCovered);

  // Son imzadan sonra bayt olması tek başına "belge değiştirildi" demek DEĞİLDİR:
  // LTV/arşiv verisi (DSS/VRI) imzadan SONRA eklenir ve buna izin verilir.
  // Sadece izin verilmeyen bir değişiklik varsa bayrak kalkar.
  const tail = report.documentIntegrity.unsignedBytes > 0
    ? pdfBuffer.slice(maxCovered).toString('latin1')
    : '';
  const tailIsOnlyValidationData = tail.length === 0 ||
    (/\/DSS\b|\/VRI\b/.test(tail) && !/\/Type\s*\/Page\b/.test(tail));

  report.documentIntegrity.trailingRevisionIsValidationData = tailIsOnlyValidationData;
  report.documentIntegrity.modifiedAfterSigning =
    report.documentIntegrity.unsignedBytes > 0 && !tailIsOnlyValidationData;

  for (const sig of signatures) {
    report.signatures.push(
      await verifyOneSignature(sig, {
        pdfBuffer, dss, trustAnchors, validationTime, useEmbedded,
        allowNetwork: !!opts.allowNetwork, revisions,
        ignoreTimestampPoe: !!opts.ignoreTimestampPoe
      })
    );
  }

  report.ltv.offlineVerifiable = report.signatures.length > 0 &&
    report.signatures.every((s) =>
      s.revocation.length > 0 && s.revocation.every((r) => r.source.startsWith('dss')));

  return report;
}

/* ------------------------------------------------------------------ */
/* Tek imza                                                            */
/* ------------------------------------------------------------------ */

async function verifyOneSignature(sig, ctx) {
  const entry = {
    type: sig.type === 'DocTimeStamp' ? 'doc-timestamp' : 'signature',
    subFilter: sig.subFilter,
    vriKeys: sig.vriKeys,
    indication: INDICATION.INDETERMINATE,
    subIndication: null,
    achievedLevel: null,
    signer: null,
    coverage: null,
    digest: null,
    cms: null,
    chain: [],
    revocation: [],
    timestamps: [],
    errors: [],
    warnings: []
  };

  // ── 1. Kapsam ──
  if (!sig.byteRange || sig.byteRange.length < 4) {
    entry.indication = INDICATION.FAILED;
    entry.subIndication = 'FORMAT_FAILURE';
    entry.errors.push('/ByteRange okunamadı');
    return entry;
  }
  const [s1, l1, s2, l2] = sig.byteRange;
  const covered = s2 + l2;
  entry.coverage = {
    byteRange: sig.byteRange,
    coveredBytes: covered,
    documentBytes: ctx.pdfBuffer.length,
    coversWholeDocument: covered >= ctx.pdfBuffer.length
  };
  if (!entry.coverage.coversWholeDocument) {
    entry.warnings.push(
      `Bu imza belgenin ilk ${covered} baytını kapsıyor; ` +
      `sonrasında ${ctx.pdfBuffer.length - covered} bayt daha var ` +
      `(sonraki imza veya doğrulama verisi olabilir).`);
  }

  // ── 2. Belge zaman damgası mı? ──
  // Bir DocTimeStamp'in CMS'i bir TST'dir: eContentType id-ct-TSTInfo'dur ve
  // message-digest, PDF ByteRange'i değil TSTInfo içeriğini özetler. PDF'in
  // ByteRange özeti ise TSTInfo.messageImprint ile eşleşmelidir. Bu yüzden
  // sıradan imza yolundan geçirilemez.
  if (sig.type === 'DocTimeStamp') {
    return verifyDocTimeStamp(sig, entry, ctx);
  }

  // ── 3. İçerik özeti ──
  let parsed;
  try {
    parsed = cms.parseSignedData(sig.cmsDer);
  } catch (err) {
    entry.indication = INDICATION.FAILED;
    entry.subIndication = 'FORMAT_FAILURE';
    entry.errors.push(`CMS ayrıştırılamadı: ${err.message}`);
    return entry;
  }

  const signerInfo = parsed.signerInfos[0];
  if (!signerInfo) {
    entry.indication = INDICATION.FAILED;
    entry.subIndication = 'FORMAT_FAILURE';
    entry.errors.push('SignerInfo bulunamadı');
    return entry;
  }

  const hashName = signerInfo.digestAlgorithm;
  const contentDigest = computeByteRangeDigest(ctx.pdfBuffer, sig.byteRange, hashName);
  entry.digest = { algorithm: hashName, value: contentDigest.toString('hex') };

  // ── 3. İmzalayan sertifika ──
  const pool = [...parsed.certificates];
  if (ctx.dss) pool.push(...ctx.dss.certs);

  const signerCert = cms.findSignerCertificate(signerInfo, pool);
  if (!signerCert) {
    entry.indication = INDICATION.INDETERMINATE;
    entry.subIndication = 'NO_SIGNING_CERTIFICATE_FOUND';
    entry.errors.push('İmzalayan sertifika CMS içinde ya da DSS\'te bulunamadı');
    return entry;
  }
  entry.signer = describeCert(signerCert);

  // ── 4. CMS doğrulaması ──
  const cmsResult = cms.verifySignerInfo(signerInfo, signerCert, contentDigest);
  entry.cms = {
    signatureValid: cmsResult.signatureValid,
    messageDigestMatches: cmsResult.messageDigestMatches,
    contentTypeValid: cmsResult.contentTypeValid,
    signingCertificateV2Matches: cmsResult.signingCertificateValid,
    signingTime: cmsResult.signingTime ? cmsResult.signingTime.toISOString() : null
  };
  entry.errors.push(...cmsResult.errors);

  if (cmsResult.messageDigestMatches === false) {
    entry.indication = INDICATION.FAILED;
    entry.subIndication = 'HASH_FAILURE';
    return entry;
  }
  if (!cmsResult.signatureValid) {
    entry.indication = INDICATION.FAILED;
    entry.subIndication = 'SIG_CRYPTO_FAILURE';
    return entry;
  }

  // ── 5. Zincir ──
  const chain = ext.buildChain(signerCert, dedupe([...pool, ...ctx.trustAnchors]));
  entry.chain = chain.path.map(describeCert);

  const anchor = chain.path[chain.path.length - 1];
  const trusted = ctx.trustAnchors.some((ta) => ta.equals(anchor)) || isSelfSignedIn(anchor, ctx.trustAnchors);
  entry.chain.trusted = trusted;

  if (!chain.complete) {
    entry.indication = INDICATION.INDETERMINATE;
    entry.subIndication = 'NO_CERTIFICATE_CHAIN_FOUND';
    entry.warnings.push('Sertifika yolu köke ulaşmadı');
  } else if (!trusted) {
    entry.indication = INDICATION.INDETERMINATE;
    entry.subIndication = 'NO_CERTIFICATE_CHAIN_FOUND';
    entry.warnings.push('Zincirin kökü güven deposunda değil');
  }

  // Zincir imzalarını doğrula
  for (let i = 0; i < chain.path.length - 1; i++) {
    if (!verifyCertSignature(chain.path[i], chain.path[i + 1])) {
      entry.indication = INDICATION.FAILED;
      entry.subIndication = 'CHAIN_CONSTRAINTS_FAILURE';
      entry.errors.push(`Zincir imzası geçersiz: ${describeCert(chain.path[i]).cn}`);
      return entry;
    }
  }

  // ── 6. Zaman damgaları ──
  for (const tstDer of cms.extractTimestampTokens(signerInfo)) {
    entry.timestamps.push(verifyTimestamp(tstDer, signerInfo.signature, ctx));
  }
  if (sig.type === 'DocTimeStamp') {
    entry.timestamps.push(verifyTimestamp(sig.cmsDer, null, ctx));
  }

  // POE (Proof of Existence): geçerli bir zaman damgası, imzanın O AN var
  // olduğunu kanıtlar. Sertifika bugün süresi dolmuş olsa bile, damga anında
  // geçerliyse imza geçerli sayılır (ETSI TS 119 102-1). Doğrulama zamanı bu
  // yüzden damga zamanına çekilir.
  const poeSource = ctx.ignoreTimestampPoe ? null : entry.timestamps.find((t) => t.valid && t.genTime);
  const poeTime = poeSource ? new Date(poeSource.genTime) : null;
  entry.poe = poeTime
    ? { time: poeTime.toISOString(), source: poeSource.type, tsa: poeSource.tsa }
    : null;

  // ── 7. Geçerlilik penceresi (POE ile) ──
  const checkTime = poeTime || ctx.validationTime;
  for (const certDer of chain.path) {
    const info = describeCert(certDer);
    if (!info.notBefore || !info.notAfter) continue;
    const nb = new Date(info.notBefore), na = new Date(info.notAfter);
    if (checkTime < nb || checkTime > na) {
      if (poeTime) {
        entry.warnings.push(`${info.cn}: sertifika süresi dolmuş ama zaman damgası POE sağlıyor`);
      } else {
        entry.indication = INDICATION.INDETERMINATE;
        entry.subIndication = 'OUT_OF_BOUNDS_NO_POE';
        entry.warnings.push(`${info.cn}: doğrulama zamanı sertifika geçerlilik aralığı dışında`);
      }
    }
  }

  // ── 8. İptal kontrolü ──
  entry.revocation = await checkRevocation(chain.path, sig.vriKeys, ctx, checkTime);
  const revoked = entry.revocation.find((r) => r.status === 'revoked');
  if (revoked) {
    entry.indication = INDICATION.FAILED;
    entry.subIndication = poeTime ? 'REVOKED_CA_NO_POE' : 'REVOKED_NO_POE';
    entry.errors.push(`İptal edilmiş sertifika: ${revoked.subject}`);
    return entry;
  }

  const nonRootCount = chain.path.filter((c) => !ext.isSelfSigned(c)).length;
  const covereds = entry.revocation.filter((r) => r.status === 'good').length;
  if (chain.complete && covereds < nonRootCount) {
    entry.warnings.push(
      `Yoldaki ${nonRootCount} sertifikadan ${covereds} tanesi için iptal kanıtı var`);
  }

  // ── 9. Seviye ──
  entry.achievedLevel = determineLevel(entry, sig, ctx);

  if (entry.indication === INDICATION.INDETERMINATE && !entry.subIndication) {
    entry.indication = INDICATION.PASSED;
  } else if (!entry.errors.length && entry.subIndication === null) {
    entry.indication = INDICATION.PASSED;
  }

  return entry;
}

/**
 * Belge zaman damgasını (DocTimeStamp) doğrular.
 *
 * Kontroller:
 *   - TST'nin kendi CMS imzası geçerli mi,
 *   - TSA sertifikasında id-kp-timeStamping EKU var mı (RFC 3161 §2.3),
 *   - TSTInfo.messageImprint, PDF'in ByteRange özetiyle eşleşiyor mu.
 */
function verifyDocTimeStamp(sig, entry, ctx) {
  entry.type = 'doc-timestamp';

  let parsed;
  try {
    parsed = cms.parseSignedData(sig.cmsDer);
  } catch (err) {
    entry.indication = INDICATION.FAILED;
    entry.subIndication = 'FORMAT_FAILURE';
    entry.errors.push(`TST ayrıştırılamadı: ${err.message}`);
    return entry;
  }

  const si = parsed.signerInfos[0];
  if (!si || !parsed.eContent) {
    entry.indication = INDICATION.FAILED;
    entry.subIndication = 'FORMAT_FAILURE';
    entry.errors.push('TST yapısı eksik (SignerInfo veya TSTInfo yok)');
    return entry;
  }

  let info;
  try {
    info = parseTstInfo(parsed.eContent);
  } catch (err) {
    entry.indication = INDICATION.FAILED;
    entry.subIndication = 'FORMAT_FAILURE';
    entry.errors.push(`TSTInfo okunamadı: ${err.message}`);
    return entry;
  }

  // PDF ByteRange özeti, damganın imprint'iyle eşleşmeli
  const pdfDigest = computeByteRangeDigest(ctx.pdfBuffer, sig.byteRange, info.hashAlgorithm || 'sha256');
  const imprintMatches = info.imprint ? pdfDigest.equals(info.imprint) : false;
  entry.digest = { algorithm: info.hashAlgorithm, value: pdfDigest.toString('hex') };

  const tsaCert = cms.findSignerCertificate(si, parsed.certificates);
  if (!tsaCert) {
    entry.indication = INDICATION.INDETERMINATE;
    entry.subIndication = 'NO_SIGNING_CERTIFICATE_FOUND';
    entry.errors.push('TSA sertifikası TST içinde bulunamadı');
    return entry;
  }
  entry.signer = describeCert(tsaCert);

  const eContentDigest = crypto.createHash(si.digestAlgorithm || 'sha256')
    .update(parsed.eContent).digest();
  const res = cms.verifySignerInfo(si, tsaCert, eContentDigest);

  // content-type burada id-ct-TSTInfo olmalıdır — 'data' değil.
  entry.cms = {
    signatureValid: res.signatureValid,
    messageDigestMatches: res.messageDigestMatches,
    contentTypeValid: parsed.eContentType === cms.OIDS.tstInfo,
    signingCertificateV2Matches: res.signingCertificateValid
  };

  const { eku } = require('@fitfak/pades/src/cades/x509_extract').parseKeyUsageAndEKU(tsaCert);
  const ekuValid = Array.isArray(eku) && eku.includes('1.3.6.1.5.5.7.3.8');

  entry.timestamps.push({
    type: 'document-timestamp',
    valid: res.signatureValid && imprintMatches && ekuValid,
    genTime: info.genTime ? info.genTime.toISOString() : null,
    tsa: entry.signer.cn,
    hashAlgorithm: info.hashAlgorithm,
    imprintMatches,
    ekuValid,
    serial: info.serial,
    errors: []
  });

  if (!imprintMatches) {
    entry.indication = INDICATION.FAILED;
    entry.subIndication = 'HASH_FAILURE';
    entry.errors.push('Belge zaman damgası, kapsadığı baytlarla eşleşmiyor');
    return entry;
  }
  if (!res.signatureValid) {
    entry.indication = INDICATION.FAILED;
    entry.subIndication = 'SIG_CRYPTO_FAILURE';
    entry.errors.push('Zaman damgası imzası doğrulanamadı');
    return entry;
  }
  if (!ekuValid) {
    entry.warnings.push('TSA sertifikasında id-kp-timeStamping EKU yok (RFC 3161 §2.3)');
  }

  // TSA zinciri
  const pool = [...parsed.certificates];
  if (ctx.dss) pool.push(...ctx.dss.certs);
  const chain = ext.buildChain(tsaCert, dedupe([...pool, ...ctx.trustAnchors]));
  entry.chain = chain.path.map(describeCert);
  const anchor = chain.path[chain.path.length - 1];
  entry.chain.trusted = ctx.trustAnchors.some((ta) => ta.equals(anchor));

  entry.achievedLevel = 'doc-timestamp';
  entry.indication = INDICATION.PASSED;
  if (!chain.complete || !entry.chain.trusted) {
    entry.indication = INDICATION.INDETERMINATE;
    entry.subIndication = 'NO_CERTIFICATE_CHAIN_FOUND';
    entry.warnings.push('TSA zinciri güven çıpasına ulaşmadı');
  }
  return entry;
}

/* ------------------------------------------------------------------ */
/* Yardımcı adımlar                                                    */
/* ------------------------------------------------------------------ */

function computeByteRangeDigest(pdf, byteRange, hashName) {
  const h = crypto.createHash(hashName || 'sha256');
  h.update(pdf.slice(byteRange[0], byteRange[0] + byteRange[1]));
  h.update(pdf.slice(byteRange[2], byteRange[2] + byteRange[3]));
  return h.digest();
}

/** Zaman damgası jetonunu doğrular. */
function verifyTimestamp(tstDer, signatureValue, ctx) {
  const out = {
    type: signatureValue ? 'signature-timestamp' : 'document-timestamp',
    valid: false, genTime: null, tsa: null, hashAlgorithm: null,
    imprintMatches: null, ekuValid: null, errors: []
  };

  try {
    const parsed = cms.parseSignedData(tstDer);
    const si = parsed.signerInfos[0];
    if (!si) { out.errors.push('TST içinde SignerInfo yok'); return out; }

    // TSTInfo'dan genTime ve imprint
    if (parsed.eContent) {
      const info = parseTstInfo(parsed.eContent);
      out.genTime = info.genTime ? info.genTime.toISOString() : null;
      out.hashAlgorithm = info.hashAlgorithm;
      if (signatureValue && info.imprint) {
        const expected = crypto.createHash(info.hashAlgorithm || 'sha256')
          .update(signatureValue).digest();
        out.imprintMatches = expected.equals(info.imprint);
        if (!out.imprintMatches) out.errors.push('TST imprint, imza değeriyle eşleşmiyor');
      }
    }

    const tsaCert = cms.findSignerCertificate(si, parsed.certificates);
    if (!tsaCert) { out.errors.push('TSA sertifikası TST içinde yok'); return out; }
    out.tsa = describeCert(tsaCert).cn;

    // RFC 3161 §2.3: TSA sertifikasında EKU=timeStamping olmalı
    const { eku } = require('@fitfak/pades/src/cades/x509_extract').parseKeyUsageAndEKU(tsaCert);
    out.ekuValid = Array.isArray(eku) && eku.includes('1.3.6.1.5.5.7.3.8');
    if (!out.ekuValid) out.errors.push('TSA sertifikasında id-kp-timeStamping EKU yok');

    // TST'nin kendi CMS imzası
    const eContentDigest = parsed.eContent
      ? crypto.createHash(si.digestAlgorithm || 'sha256').update(parsed.eContent).digest()
      : null;
    const res = cms.verifySignerInfo(si, tsaCert, eContentDigest);
    out.valid = res.signatureValid && out.ekuValid !== false &&
                (out.imprintMatches === null || out.imprintMatches === true);
    out.errors.push(...res.errors);
  } catch (err) {
    out.errors.push(`TST doğrulanamadı: ${err.message}`);
  }
  return out;
}

/** TSTInfo (RFC 3161) içinden genTime ve messageImprint okur. */
function parseTstInfo(der) {
  const { readTLV, oidFromBytes } = require('@fitfak/pades/src/cades/x509_extract');
  const out = { genTime: null, imprint: null, hashAlgorithm: null, serial: null };

  const seq = readTLV(der, 0);
  const parts = cms.children(der, seq);
  // TSTInfo ::= SEQUENCE { version, policy, messageImprint, serialNumber, genTime, ... }
  let idx = 0;
  idx++;                                     // version
  idx++;                                     // policy OID
  const imprintSeq = parts[idx]; idx++;
  const impParts = cms.children(der, imprintSeq);
  const algOid = readTLV(der, impParts[0].start);
  out.hashAlgorithm = cms.DIGEST_BY_OID[oidFromBytes(der.slice(algOid.start, algOid.end))] || 'sha256';
  out.imprint = der.slice(impParts[1].start, impParts[1].end);

  out.serial = der.slice(parts[idx].start, parts[idx].end).toString('hex'); idx++;

  const genTimeTlv = parts[idx];
  if (genTimeTlv && genTimeTlv.tag === 0x18) {
    const s = der.slice(genTimeTlv.start, genTimeTlv.end).toString('latin1');
    out.genTime = new Date(Date.UTC(
      +s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8),
      +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14) || 0
    ));
  }
  return out;
}

/** DSS'ten (çevrimdışı) ya da ağdan iptal durumunu belirler. */
async function checkRevocation(path, vriKeys, ctx, checkTime) {
  const results = [];

  for (let i = 0; i < path.length; i++) {
    const cert = path[i];
    if (ext.isSelfSigned(cert)) continue;
    const issuer = path[i + 1];
    if (!issuer) continue;

    const info = describeCert(cert);
    let found = null;

    // 1. DSS'teki CRL'ler (çevrimdışı LTV kanıtı)
    if (ctx.useEmbedded && ctx.dss) {
      for (const crlDer of ctx.dss.crls) {
        try {
          const res = checkCrl(cert, issuer, crlDer, { validationTime: checkTime, toleranceMs: 365 * 86400000 });
          found = {
            subject: info.cn, source: 'dss-crl', status: res.status,
            reason: res.reason || null,
            thisUpdate: res.thisUpdate ? res.thisUpdate.toISOString() : null,
            nextUpdate: res.nextUpdate ? res.nextUpdate.toISOString() : null
          };
          if (res.status === 'revoked') break;
        } catch { /* bu CRL bu sertifikaya ait değil */ }
      }
    }

    // 2. DSS'teki OCSP yanıtları
    if (!found && ctx.useEmbedded && ctx.dss && ctx.dss.ocsps.length) {
      const ocspHit = matchOcsp(ctx.dss.ocsps, cert, issuer);
      if (ocspHit) {
        found = { subject: info.cn, source: 'dss-ocsp', status: ocspHit.status,
                  producedAt: ocspHit.producedAt };
      }
    }

    // 3. Ağ (yalnız açıkça izin verilirse)
    if (!found && ctx.allowNetwork) {
      try {
        const { collectForCertificate } = require('@fitfak/pades/src/cades/revocation');
        const got = await collectForCertificate(cert, issuer, { validationTime: checkTime });
        found = { subject: info.cn, source: got.ocspDer ? 'network-ocsp' : 'network-crl',
                  status: got.status };
      } catch (err) {
        found = { subject: info.cn, source: 'network', status: 'unknown', error: err.message };
      }
    }

    results.push(found || { subject: info.cn, source: 'none', status: 'unknown' });
  }
  return results;
}

/** DSS'teki OCSP yanıtlarından sertifikaya uyanı bulur (kaba eşleşme). */
function matchOcsp(ocsps, certDer, issuerDer) {
  const { readTLV } = require('@fitfak/pades/src/cades/x509_extract');
  const serial = ext.getSerial(certDer);
  for (const der of ocsps) {
    // Seri numarası yanıtın içinde geçiyorsa bu yanıt bu sertifikaya ait sayılır.
    if (der.includes(serial)) {
      // 'revoked' (tag [1]) işaretini ara: CertStatus ::= CHOICE { good [0] IMPLICIT NULL, revoked [1] ... }
      const revoked = der.includes(Buffer.from([0xA1])) && looksRevoked(der, serial);
      return { status: revoked ? 'revoked' : 'good', producedAt: null };
    }
  }
  return null;
}

function looksRevoked(der, serial) {
  // Basit sezgisel: seri numarasından hemen sonra [1] (0xA1) geliyorsa iptal.
  const idx = der.indexOf(serial);
  if (idx < 0) return false;
  const after = der.slice(idx + serial.length, idx + serial.length + 6);
  return after.length > 0 && after[0] === 0xA1;
}

/** Root'taki /DSS sözlüğünü okur. */
function readDss(pdfBuffer) {
  try {
    const trailer = readLastTrailer(pdfBuffer);
    const root = readObject(pdfBuffer, trailer.rootObjNum);
    if (!root || !root.dictStr) return null;
    const m = /\/DSS\s+(\d+)\s+0\s+R/.exec(root.dictStr);
    if (!m) return null;
    const dssObj = readObject(pdfBuffer, parseInt(m[1], 10));
    if (!dssObj || !dssObj.dictStr) return null;

    const grab = (key) => {
      const mm = new RegExp('\\/' + key + '\\s*\\[([^\\]]*)\\]').exec(dssObj.dictStr);
      if (!mm) return [];
      const refs = mm[1].match(/(\d+)\s+0\s+R/g) || [];
      return refs.map((r) => parseInt(r, 10)).map((n) => readStreamObject(pdfBuffer, n)).filter(Boolean);
    };

    const vri = {};
    const vriMatch = /\/VRI\s*<<([\s\S]*?)>>/.exec(dssObj.dictStr);
    if (vriMatch) {
      const re = /\/([0-9A-F]{40})\s+(\d+)\s+0\s+R/g;
      let mm;
      while ((mm = re.exec(vriMatch[1])) !== null) vri[mm[1]] = parseInt(mm[2], 10);
    }

    return { certs: grab('Certs'), crls: grab('CRLs'), ocsps: grab('OCSPs'), vri };
  } catch {
    return null;
  }
}

/** Bir stream nesnesinin ham içeriğini döndürür. */
function readStreamObject(pdfBuffer, objNum) {
  const s = pdfBuffer.toString('latin1');
  const re = new RegExp(`(?:^|[^0-9])${objNum}\\s+0\\s+obj([\\s\\S]*?)endobj`, 'g');
  let m, last = null;
  while ((m = re.exec(s)) !== null) last = m;
  if (!last) return null;

  const body = last[1];
  const streamIdx = body.indexOf('stream');
  if (streamIdx < 0) return null;
  let start = last.index + last[0].indexOf(body) + streamIdx + 6;
  if (pdfBuffer[start] === 0x0D) start++;
  if (pdfBuffer[start] === 0x0A) start++;

  const lenMatch = /\/Length\s+(\d+)/.exec(body.slice(0, streamIdx));
  if (lenMatch) return pdfBuffer.slice(start, start + parseInt(lenMatch[1], 10));

  const endIdx = pdfBuffer.indexOf('endstream', start);
  return endIdx > start ? pdfBuffer.slice(start, endIdx) : null;
}

/** %%EOF sınırlarından revizyonları çıkarır. */
function findRevisions(pdfBuffer) {
  const s = pdfBuffer.toString('latin1');
  const out = [];
  const re = /%%EOF/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m.index + 5);
  return out;
}

function describeCert(der) {
  try {
    const x = new crypto.X509Certificate(der);
    return {
      cn: extractCN(x.subject),
      subject: x.subject.replace(/\n/g, ', '),
      issuer: x.issuer.replace(/\n/g, ', '),
      serialNumber: x.serialNumber,
      notBefore: new Date(x.validFrom).toISOString(),
      notAfter: new Date(x.validTo).toISOString(),
      isCA: x.ca === true,
      keyType: x.publicKey.asymmetricKeyType,
      fingerprintSha256: x.fingerprint256
    };
  } catch (err) {
    return { cn: null, error: err.message };
  }
}

function extractCN(dn) {
  const m = /(?:^|\n|,\s*)CN=([^\n,]+)/.exec(dn || '');
  return m ? m[1].trim() : null;
}

function verifyCertSignature(childDer, issuerDer) {
  try {
    const child = new crypto.X509Certificate(childDer);
    const issuer = new crypto.X509Certificate(issuerDer);
    return child.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

function isSelfSignedIn(certDer, anchors) {
  if (!certDer) return false;
  const subject = safe(() => ext.getSubjectDer(certDer));
  if (!subject) return false;
  return anchors.some((a) => {
    const s = safe(() => ext.getSubjectDer(a));
    return s && s.equals(subject);
  });
}

/** ETSI seviye tespiti. */
function determineLevel(entry, sig, ctx) {
  const hasTimestamp = entry.timestamps.some((t) => t.valid);
  const hasRevocation = entry.revocation.some((r) => r.source.startsWith('dss'));
  const hasDocTs = ctx.pdfBuffer.toString('latin1').includes('/Type /DocTimeStamp') ||
                   ctx.pdfBuffer.toString('latin1').includes('/SubFilter /ETSI.RFC3161');

  if (!hasTimestamp) return 'B-B';
  if (!hasRevocation) return 'B-T';
  if (!hasDocTs) return 'B-LT';
  return 'B-LTA';
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item) continue;
    const k = item.toString('base64');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function safePemToDer(pem) {
  try { return ext.pemToDer(pem); } catch { return null; }
}

function safe(fn) {
  try { return fn(); } catch { return null; }
}

module.exports = { verifyPdf, VerifyError, INDICATION, describeCert, readDss, findRevisions };
