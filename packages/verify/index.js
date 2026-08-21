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
const { validatePath } = require('./src/path');
const { assessAlgorithms } = require('./src/algorithms');
const {
  analyzeIncrementalChanges, validateByteRange, readDocMdp
} = require('./src/revision');
const { parseCrl, checkCrl } = require('@fitfak/pades/src/cades/crl');

class VerifyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VerifyError';
    this.code = code;
  }
}

/** id-kp-timeStamping — RFC 3161 §2.3, TSA sertifikasında ZORUNLU. */
const OID_TIME_STAMPING = '1.3.6.1.5.5.7.3.8';

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

  // --- EKLENEN KISIM: HTTP İLE ROOT SERTİFİKA ÇEKME VE PARMAK İZİ ---
  const ROOT_URL = 'http://status.trust.fitfak.net/root.crt';
  const EXPECTED_FINGERPRINT = '5A:F0:46:34:20:2D:89:43:49:C5:4E:3A:A1:56:A6:1C:8C:AC:03:BA:B4:AD:10:5B:FB:DD:74:BD:28:E6:9A:17';
  
  let remoteRootDer = null;
  try {
    const http = require('http'); // https yerine http modülü
    
    // Veriyi metin (string) olarak DEĞİL, Buffer olarak topluyoruz ki DER (binary) formatı bozulmasın
    const remoteRootData = await new Promise((resolve, reject) => {
      http.get(ROOT_URL, (res) => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });

    // Buffer verisini işler. Hem PEM hem de DER formatını destekler
    const cert = new crypto.X509Certificate(remoteRootData);
    if (cert.fingerprint256 !== EXPECTED_FINGERPRINT) {
      throw new Error(`Parmak izi eşleşmiyor! Gelen: ${cert.fingerprint256}`);
    }
    
    // safePemToDer kullanmamıza gerek kalmadı, .raw bize doğrudan DER (Buffer) formatını verir
    remoteRootDer = cert.raw;
  } catch (err) {
    throw new VerifyError('ERR_ROOT_FETCH', 'Güvenilir kök sertifika doğrulanamadı: ' + err.message);
  }
  // --- EKLENEN KISIM BİTİŞ ---

  let anchors = opts.trustAnchors && opts.trustAnchors.length 
    ? opts.trustAnchors.map(safePemToDer) 
    : Array.from(tls.rootCertificates).map(safePemToDer);
    
  if (remoteRootDer) {
    anchors.push(remoteRootDer); // Doğrulanmış kök sertifikayı motorun güven havuzuna ekle
  }
  
  const trustAnchors = anchors.filter(Boolean);

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

  let maxCovered = 0;
  for (const sig of signatures) {
    if (!sig.byteRange || sig.byteRange.length < 4) continue;
    const covered = sig.byteRange[2] + sig.byteRange[3];
    if (covered > maxCovered) maxCovered = covered;
  }
  report.documentIntegrity.unsignedBytes = Math.max(0, pdfBuffer.length - maxCovered);

  const revisionDiff = analyzeIncrementalChanges(pdfBuffer, maxCovered);

  const tailIsValidationData = report.documentIntegrity.unsignedBytes === 0 ||
    (revisionDiff.contentChanged === false && revisionDiff.appendedIsStructured !== false);

  report.documentIntegrity.trailingRevisionIsValidationData = tailIsValidationData;
  report.documentIntegrity.modifiedAfterSigning =
    revisionDiff.contentChanged === null ? null : !tailIsValidationData;
  report.documentIntegrity.changes = revisionDiff.changes;
  if (revisionDiff.errors.length) {
    report.warnings.push(...revisionDiff.errors);
  }

  const maxSignatures = Number.isInteger(opts.maxSignatures) && opts.maxSignatures > 0
    ? opts.maxSignatures : 128;
  if (signatures.length > maxSignatures) {
    report.warnings.push(
      `Belgede ${signatures.length} imza alanı var (sınır ${maxSignatures}); ` +
      'doğrulama yapılmadı. Sınırı yükseltmek için maxSignatures verin.');
    return report;
  }

  const diffCache = new Map([[maxCovered, revisionDiff]]);
  const diffFor = (covered) => {
    if (!diffCache.has(covered)) {
      diffCache.set(covered, analyzeIncrementalChanges(pdfBuffer, covered));
    }
    return diffCache.get(covered);
  };

  for (const sig of signatures) {
    report.signatures.push(
      await verifyOneSignature(sig, {
        pdfBuffer, dss, trustAnchors, validationTime, useEmbedded,
        allowNetwork: !!opts.allowNetwork, revisions,
        allowPrivateNetwork: opts.allowPrivateNetwork === true,
        algorithmPolicy: opts.algorithmPolicy,
        requireRevocation: opts.requireRevocation === true,
        allowHosts: opts.allowHosts,
        denyHosts: opts.denyHosts,
        revisionDiff: sig.byteRange && sig.byteRange.length >= 4
          ? diffFor(sig.byteRange[2] + sig.byteRange[3]) : null,
        ignoreTimestampPoe: !!opts.ignoreTimestampPoe,
        allSignatures: signatures,
        strictTimestamps: opts.strictTimestamps !== false
      })
    );
  }

  // DÜZELTİLMİŞ KOD: Sadece asıl imzaları kontrol et
  const originalSignatures = report.signatures.filter(s => s.type === 'signature');
  report.ltv.offlineVerifiable = originalSignatures.length > 0 &&
    originalSignatures.every((s) =>
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
  const [, , s2, l2] = sig.byteRange;
  const covered = s2 + l2;
  entry.coverage = {
    byteRange: sig.byteRange,
    coveredBytes: covered,
    documentBytes: ctx.pdfBuffer.length,
    coversWholeDocument: covered >= ctx.pdfBuffer.length,
    modifiedAfterSigning: null,
    changes: []
  };

  // /ByteRange'in YAPISI de doğrulanmalı. Dört sayının okunabilmesi onların
  // anlamlı olduğunu göstermez: dosyanın başını dışarıda bırakan ya da
  // boşluğu /Contents'ten geniş tutan bir ByteRange, imzasız içeriği imzalı
  // gibi gösterir.
  const brCheck = validateByteRange(sig, ctx.pdfBuffer.length);
  if (!brCheck.ok) {
    entry.indication = INDICATION.FAILED;
    entry.subIndication = 'FORMAT_FAILURE';
    entry.errors.push(...brCheck.errors);
    return entry;
  }

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
    signedAttrsPresent: cmsResult.signedAttrsPresent,
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

  // ── 4b. ZORUNLU imzalı öznitelikler karar verir ──
  if (!cmsResult.signedAttrsPresent) {
    entry.indication = INDICATION.FAILED;
    entry.subIndication = 'SIG_CONSTRAINTS_FAILURE';
    return entry;
  }
  if (cmsResult.contentTypeValid === false) {
    entry.indication = INDICATION.FAILED;
    entry.subIndication = 'SIG_CONSTRAINTS_FAILURE';
    return entry;
  }
  if (cmsResult.signingCertificateValid === false && cmsResult.signingCertificatePresent) {
    entry.indication = INDICATION.FAILED;
    entry.subIndication = 'SIG_CONSTRAINTS_FAILURE';
    return entry;
  }
  if (!cmsResult.signingCertificatePresent) {
    const isPades = typeof sig.subFilter === 'string' && sig.subFilter.startsWith('ETSI.');
    entry.indication = isPades ? INDICATION.FAILED : INDICATION.INDETERMINATE;
    entry.subIndication = 'SIG_CONSTRAINTS_FAILURE';
    if (isPades) return entry;
  }

  // ── 5. Zincir ──
  // --- EKLENEN KISIM: AIA CHASING ---
  const poolForChain = dedupe([...pool, ...ctx.trustAnchors]);
  let chain = ext.buildChain(signerCert, poolForChain, { anchors: ctx.trustAnchors });

  if (!chain.complete && ctx.allowNetwork) {
    const { pkiFetch } = require('@fitfak/netguard'); 
    
    let depth = 0;
    while (!chain.complete && depth < 5) {
      depth++;
      const currentCert = chain.path[chain.path.length - 1];
      const aia = ext.extractAIA(currentCert);
      
      if (!aia || !aia.caIssuers || aia.caIssuers.length === 0) break;

      let fetchedDer = null;
      for (const url of aia.caIssuers) {
        try {
          fetchedDer = await pkiFetch(url, {
            timeoutMs: 3000,
            allowPrivateNetwork: ctx.allowPrivateNetwork,
            allowHosts: ctx.allowHosts,
            denyHosts: ctx.denyHosts
          });
          break; 
        } catch (e) {
          // Bu URL olmadıysa sıradakine geç
        }
      }

      if (fetchedDer) {
        poolForChain.push(fetchedDer); 
        chain = ext.buildChain(signerCert, poolForChain, { anchors: ctx.trustAnchors });
      } else {
        break;
      }
    }
  }
  // --- EKLENEN KISIM BİTİŞ ---

  entry.chain = chain.path.map(describeCert);

  const anchor = chain.path[chain.path.length - 1];
  const trusted = isTrustAnchor(anchor, ctx.trustAnchors);
  entry.isTrustedChain = trusted;

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

  // ── 5b. RFC 5280 §6.1 yol kısıtları ──
  const pathCheck = validatePath(chain.path);
  entry.warnings.push(...pathCheck.warnings);
  if (!pathCheck.ok) {
    entry.indication = INDICATION.FAILED;
    entry.subIndication = 'CHAIN_CONSTRAINTS_FAILURE';
    entry.errors.push(...pathCheck.errors);
    return entry;
  }

  // ── 5c. Algoritma politikası ──
  const algo = assessAlgorithms({
    signerCert,
    digestAlgorithm: hashName,
    signatureAlgorithm: signerInfo.signatureAlgorithm,
    chain: chain.path
  }, ctx.algorithmPolicy);
  entry.algorithms = algo.details;
  entry.warnings.push(...algo.warnings);
  if (!algo.ok) {
    entry.indication = INDICATION.INDETERMINATE;
    entry.subIndication = 'CRYPTO_CONSTRAINTS_FAILURE_NO_POE';
    entry.errors.push(...algo.errors);
    return entry;
  }

  // ── 6. Zaman damgaları ──
  for (const tstDer of cms.extractTimestampTokens(signerInfo)) {
    entry.timestamps.push(verifyTimestamp(tstDer, signerInfo.signature, ctx));
  }
  if (sig.type === 'DocTimeStamp') {
    entry.timestamps.push(verifyTimestamp(sig.cmsDer, null, ctx));
  }

  for (const ts of entry.timestamps) {
    if (ts.valid) continue;
    const why = ts.errors.length ? ts.errors.join('; ') : 'doğrulanamadı';
    entry.warnings.push(`Zaman damgası reddedildi (${ts.type}): ${why}`);
  }

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
    const oncedenVardi = poeAntedatesRevocation(poeTime, revoked);

    if (oncedenVardi) {
      entry.warnings.push(
        `${revoked.subject}: sertifika ${revoked.revocationTime} tarihinde ` +
        `iptal edilmiş, ama imza ${poeTime.toISOString()} itibarıyla vardı ` +
        `(sebep: ${revoked.reason || 'belirtilmemiş'})`);
    } else {
      entry.indication = INDICATION.FAILED;
      entry.subIndication = revoked.isCa ? 'REVOKED_CA_NO_POE' : 'REVOKED_NO_POE';
      entry.errors.push(`İptal edilmiş sertifika: ${revoked.subject}` +
        (revoked.revocationTime ? ` (${revoked.revocationTime})` : '') +
        (revoked.reason ? ` — ${revoked.reason}` : ''));
      return entry;
    }
  }

  const nonRootCount = chain.path.filter((c) => !ext.isSelfSigned(c)).length;
  const covereds = entry.revocation.filter((r) => r.status === 'good').length;
  entry.revocationComplete = !chain.complete ? null : covereds >= nonRootCount;

  if (chain.complete && covereds < nonRootCount) {
    const eksik = entry.revocation
      .filter((r) => r.status !== 'good' && r.status !== 'revoked')
      .map((r) => r.subject).filter(Boolean);
    const mesaj = `Yoldaki ${nonRootCount} sertifikadan ${covereds} tanesi için ` +
      `iptal kanıtı var${eksik.length ? ` — kanıtsız: ${eksik.join(', ')}` : ''}. ` +
      '"Kanıt yok", "iptal edilmemiş" demek DEĞİLDİR.';

    if (ctx.requireRevocation) {
      entry.indication = INDICATION.INDETERMINATE;
      entry.subIndication = 'TRY_LATER';
      entry.errors.push(mesaj);
      return entry;
    }
    entry.warnings.push(mesaj);
  }

  // ── 9. İmzadan sonraki değişiklikler ──
  if (!entry.coverage.coversWholeDocument) {
    const diff = ctx.revisionDiff || analyzeIncrementalChanges(ctx.pdfBuffer, covered);
    const docMdp = readDocMdp(ctx.pdfBuffer, sig);
    entry.coverage.modifiedAfterSigning =
      diff.contentChanged === null ? null
        : (diff.contentChanged || diff.appendedIsStructured === false);
    entry.coverage.changes = diff.changes;
    entry.coverage.certification = docMdp.isCertification
      ? { permissions: docMdp.permissions } : null;

    if (diff.contentChanged === null) {
      entry.indication = INDICATION.INDETERMINATE;
      entry.subIndication = 'SIG_CONSTRAINTS_FAILURE';
      entry.errors.push('İmza sonrası eklenen bölüm çözümlenemedi: ' +
        (diff.errors.join('; ') || 'bilinmeyen sebep'));
      return entry;
    }

    if (entry.coverage.modifiedAfterSigning) {
      const kesin = docMdp.isCertification && docMdp.permissions === 1;
      entry.indication = kesin ? INDICATION.FAILED : INDICATION.INDETERMINATE;
      entry.subIndication = 'DOC_MODIFIED_AFTER_SIGNING';
      entry.errors.push(
        (kesin
          ? 'Sertifikasyon imzası hiçbir değişikliğe izin vermiyor (DocMDP P=1) ama '
          : 'İmzalandıktan sonra belge değiştirilmiş — imza yalnız kapsadığı ' +
            `ilk ${covered} baytı doğrular: `) +
        (diff.changes.join('; ') || 'imza dışı bölüm değişmiş'));
      return entry;
    }

    entry.warnings.push('İmzadan sonra eklenen bölüm belgenin görünen ' +
      'içeriğini değiştirmiyor (doğrulama verisi ya da sonraki imza).');
  } else {
    entry.coverage.modifiedAfterSigning = false;
  }

  // ── 10. Seviye ──
  entry.achievedLevel = determineLevel(entry, sig, ctx);

  // ── 11. Nihai gösterge ──
  if (entry.errors.length) {
    if (entry.indication === INDICATION.PASSED) {
      entry.indication = INDICATION.INDETERMINATE;
    }
    if (!entry.subIndication) entry.subIndication = 'SIG_CONSTRAINTS_FAILURE';
  } else if (entry.indication === INDICATION.INDETERMINATE && !entry.subIndication) {
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
  // content-type burada id-ct-TSTInfo olmalıdır — 'data' değil.
  const res = cms.verifySignerInfo(si, tsaCert, eContentDigest, cms.OIDS.tstInfo);

  entry.cms = {
    signatureValid: res.signatureValid,
    messageDigestMatches: res.messageDigestMatches,
    contentTypeValid: res.contentTypeValid && parsed.eContentType === cms.OIDS.tstInfo,
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
    // RFC 3161 §2.3 bunu ZORUNLU kılar. Uyarıya indirgemek, herhangi bir
    // sertifikayla üretilmiş "zaman damgası"nın geçerli sayılması demektir;
    // arşiv damgasının bütün değeri buradan gelir.
    //
    // `strictTimestamps: false` verilirse TOTAL-FAILED yerine INDETERMINATE
    // döner: kanıt eksiktir ama belge kesin sahte de değildir.
    entry.indication = ctx.strictTimestamps === false
      ? INDICATION.INDETERMINATE
      : INDICATION.FAILED;
    entry.subIndication = 'SIG_CONSTRAINTS_FAILURE';
    entry.errors.push('TSA sertifikasında id-kp-timeStamping EKU yok (RFC 3161 §2.3) — ' +
      'bu sertifika zaman damgası üretmeye yetkili değil');
    return entry;
  }

  // TSA zinciri
  const pool = [...parsed.certificates];
  if (ctx.dss) pool.push(...ctx.dss.certs);
  const chain = ext.buildChain(tsaCert, dedupe([...pool, ...ctx.trustAnchors]),
    { anchors: ctx.trustAnchors });
  entry.chain = chain.path.map(describeCert);
  const anchor = chain.path[chain.path.length - 1];
  entry.isTrustedChain = isTrustAnchor(anchor, ctx.trustAnchors)

  for (let i = 0; i < chain.path.length - 1; i++) {
    if (verifyCertSignature(chain.path[i], chain.path[i + 1])) continue;
    entry.indication = INDICATION.FAILED;
    entry.subIndication = 'CHAIN_CONSTRAINTS_FAILURE';
    entry.errors.push(`TSA zincir imzası geçersiz: ${describeCert(chain.path[i]).cn}`);
    return entry;
  }

  const tsaPath = validatePath(chain.path, { requiredEku: [OID_TIME_STAMPING] });
  entry.warnings.push(...tsaPath.warnings);
  if (!tsaPath.ok) {
    entry.indication = INDICATION.FAILED;
    entry.subIndication = 'CHAIN_CONSTRAINTS_FAILURE';
    entry.errors.push(...tsaPath.errors);
    return entry;
  }

  entry.achievedLevel = 'doc-timestamp';
  entry.indication = INDICATION.PASSED;
  if (!chain.complete || !entry.isTrustedChain) {
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
    imprintMatches: null, ekuValid: null, contentTypeValid: null, errors: []
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
    // RFC 3161 §2.4.2: jetonun içeriği id-ct-TSTInfo olmalıdır. Bunu 'data'
    // beklermiş gibi doğrulamak, kontrolü her jetonda başarısız kılar ve
    // dolayısıyla anlamsızlaştırır.
    const res = cms.verifySignerInfo(si, tsaCert, eContentDigest, cms.OIDS.tstInfo);
    out.contentTypeValid = res.contentTypeValid !== false &&
                           parsed.eContentType === cms.OIDS.tstInfo;
    if (!out.contentTypeValid) {
      out.errors.push('Jetonun içerik türü id-ct-TSTInfo değil — bu bir zaman damgası değil');
    }
    out.valid = res.signatureValid && out.ekuValid !== false && out.contentTypeValid &&
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

/**
 * POE, iptalden ÖNCEYE mi düşüyor?
 *
 * İmzanın iptalden önce var olduğu kanıtlanabiliyorsa, sonradan gelen bir
 * iptal imzayı geçersiz kılmaz (ETSI TS 119 102-1). Bunun İKİ İSTİSNASI var
 * ve ikisi de burada uygulanır:
 *
 *   • keyCompromise / cACompromise: anahtar ne zamandan beri başkasının
 *     elinde olduğu bilinmez, bu yüzden POE koruma sağlamaz.
 *   • invalidityDate uzantısı: CA "bu sertifika şu tarihten İTİBAREN
 *     geçersizdi" diyorsa, kıyas iptal tarihine değil o tarihe yapılır.
 */
function poeAntedatesRevocation(poeTime, revoked) {
  if (!poeTime || !revoked) return false;

  const reason = String(revoked.reason || '').toLowerCase();
  if (reason.includes('compromise')) return false;

  const sinir = revoked.invalidityTime || revoked.revocationTime;
  if (!sinir) return false;                    // zaman bilinmiyorsa koruma yok

  const t = new Date(sinir);
  return Number.isFinite(t.getTime()) && poeTime < t;
}

/** DSS'ten (çevrimdışı) ya da ağdan iptal durumunu belirler. */
async function checkRevocation(path, vriKeys, ctx, checkTime) {
  const results = [];
  /** Eşleşen ama doğrulamayı geçemeyen OCSP yanıtlarının gerekçeleri. */
  const ocspRejections = [];

  for (let i = 0; i < path.length; i++) {
    const cert = path[i];
    if (ext.isSelfSigned(cert)) continue;
    const issuer = path[i + 1];
    if (!issuer) continue;

    const info = describeCert(cert);
    let found = null;

    // 1. DSS'teki CRL'ler (çevrimdışı LTV kanıtı)
    //
    // Reddedilen CRL'ler SESSİZCE geçilmez: kapsam dışı, süresi geçmiş ya
    // da imzası tutmayan bir liste "kanıt yok" demektir ve gerekçesiyle
    // birlikte raporlanır. Aksi hâlde kullanıcı, DSS'te CRL gördüğü için
    // belgenin doğrulanmış olduğunu sanır.
    const crlRejections = [];
    let partialCrl = null;
    if (ctx.useEmbedded && ctx.dss) {
      for (const crlDer of ctx.dss.crls) {
        try {
          const res = checkCrl(cert, issuer, crlDer, {
            validationTime: checkTime,
            toleranceMs: 365 * 86400000,
            // DSS'e gömülü CRL, sertifikanın CDP adresinden başka bir
            // yerden gelmiş olabilir; kapsamın SINIFI (CA/EE, sebepler)
            // yine de denetlenir.
            checkDistributionPoint: false
          });

          const entry = {
            subject: info.cn, source: 'dss-crl', status: res.status,
            isCa: i > 0,
            revocationTime: res.revocationDate ? res.revocationDate.toISOString() : null,
            invalidityTime: res.invalidityDate ? res.invalidityDate.toISOString() : null,
            reason: res.reason || null,
            thisUpdate: res.thisUpdate ? res.thisUpdate.toISOString() : null,
            nextUpdate: res.nextUpdate ? res.nextUpdate.toISOString() : null,
            crlNumber: res.crlNumber || null
          };

          // Bölümlenmiş bir CRL'den gelen "good" TAM cevap değildir:
          // yalnız o listenin kapsadığı sebepler için geçerlidir. Yine de
          // KENARA yazılır — listede daha sonra tam bir CRL çıkarsa o
          // kazanmalı; çıkmazsa bu, "hiç bilgi yok"tan iyi bir gerekçedir.
          if (res.scope && !res.scope.complete && res.status === 'good') {
            entry.status = 'unknown';
            entry.partial = true;
            entry.coveredReasons = res.scope.coveredReasons;
            entry.error = 'CRL yalnız bazı iptal sebeplerini kapsıyor; ' +
              'tam iptal kanıtı sayılmaz';
            crlRejections.push(entry.error);
            partialCrl = partialCrl || entry;
            continue;
          }

          found = entry;
          if (res.status === 'revoked') break;
        } catch (err) {
          crlRejections.push(`${err.code || 'ERR_CRL'}: ${err.message}`);
        }
      }
    }

    // 2. DSS'teki OCSP yanıtları — CertID eşleşmesi ve İMZA doğrulanır
    if (!found && ctx.useEmbedded && ctx.dss && ctx.dss.ocsps.length) {
      const ocspHit = matchOcsp(ctx.dss.ocsps, cert, issuer, {
        at: checkTime,
        extraCerts: [...(ctx.dss.certs || []), ...path],
        rejections: ocspRejections
      });
      if (ocspHit) {
        found = {
          subject: info.cn, source: 'dss-ocsp', status: ocspHit.status,
          isCa: i > 0,
          revocationTime: ocspHit.revocationTime
            ? new Date(ocspHit.revocationTime).toISOString() : null,
          producedAt: ocspHit.producedAt ? ocspHit.producedAt.toISOString() : null,
          thisUpdate: ocspHit.thisUpdate ? ocspHit.thisUpdate.toISOString() : null,
          nextUpdate: ocspHit.nextUpdate ? ocspHit.nextUpdate.toISOString() : null,
          responder: ocspHit.responderCn || null,
          reason: ocspHit.revocationReason
        };
      } else if (ocspRejections.length) {
        // Yanıt VAR ama doğrulanamadı: bu sessizce geçilmemeli
        found = {
          subject: info.cn, source: 'dss-ocsp', status: 'unknown',
          error: ocspRejections[ocspRejections.length - 1]
        };
      }
    }

    // 3. Ağ (yalnız açıkça izin verilirse)
    if (!found && ctx.allowNetwork) {
      try {
        const { collectForCertificate } = require('@fitfak/pades/src/cades/revocation');
        const got = await collectForCertificate(cert, issuer, {
          validationTime: checkTime,
          // Sertifikadan gelen AIA/CDP adresleri özel ağa çıkamaz — açıkça
          // izin verilmedikçe. Bu adresleri imzalayan değil, sertifikayı
          // üreten yazar (bkz. @fitfak/netguard).
          allowPrivateNetwork: ctx.allowPrivateNetwork,
          allowHosts: ctx.allowHosts,
          denyHosts: ctx.denyHosts
        });
        found = { subject: info.cn, isCa: i > 0,
                  source: got.ocspDer ? 'network-ocsp' : 'network-crl',
                  status: got.status };
      } catch (err) {
        found = { subject: info.cn, source: 'network', status: 'unknown', error: err.message };
      }
    }

    // Hiçbir kaynaktan kanıt çıkmadıysa ama REDDEDİLEN kanıtlar varsa,
    // gerekçe raporlanır. "Kanıt yok" ile "kanıt vardı ama geçersizdi"
    // farklı şeylerdir ve kullanıcının ikincisini bilmesi gerekir.
    if (!found && partialCrl) found = partialCrl;
    if (!found && crlRejections.length) {
      found = {
        subject: info.cn, source: 'dss-crl', status: 'unknown',
        error: crlRejections[crlRejections.length - 1]
      };
    }

    results.push(found || { subject: info.cn, source: 'none', status: 'unknown' });
  }
  return results;
}

/**
 * DSS'teki OCSP yanıtlarından bu sertifikaya AİT ve GEÇERLİ olanı bulur.
 *
 * Eskiden burada `der.includes(serial)` vardı: seri numarası baytları yanıtın
 * herhangi bir yerinde geçse yanıt kabul ediliyor, imza hiç doğrulanmıyordu.
 * Bu, iptal edilmiş bir sertifikayı geçerli göstermeye yetiyordu — yani LTV'nin
 * tüm amacını boşa çıkarıyordu. Artık RFC 6960'a göre:
 *
 *   • CertID (issuerNameHash + issuerKeyHash + serialNumber) HESAPLANARAK
 *     eşleştirilir,
 *   • BasicOCSPResponse imzası doğrulanır,
 *   • yanıtlayanın yetkisi (CA'nın kendisi ya da OCSPSigning EKU'lu delege)
 *     sınanır,
 *   • thisUpdate/nextUpdate penceresi kontrol edilir.
 *
 * Bunlardan biri bile başarısızsa yanıt KULLANILMAZ; sessizce "good" denmez.
 */
function matchOcsp(ocsps, certDer, issuerDer, opts = {}) {
  const ocspLib = require('./src/ocsp');
  const rejections = opts.rejections || [];

  for (const der of ocsps) {
    let res;
    try {
      res = ocspLib.verifyOcspResponse(der, certDer, issuerDer, {
        at: opts.at, extraCerts: opts.extraCerts || []
      });
    } catch (err) {
      rejections.push(`OCSP yanıtı işlenemedi: ${err.message}`);
      continue;
    }

    if (!res.matched) continue;                       // başka sertifikanın yanıtı

    if (res.errors.length) {
      rejections.push(res.errors.join('; '));
      continue;                                        // eşleşti ama GÜVENİLMEZ
    }
    return res;
  }
  return null;
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

/**
 * Bu sertifika güven deposundaki bir çıpanın TA KENDİSİ mi?
 *
 * Burada tek geçerli ölçüt kimliktir: aynı DER, ya da (kodlama farklarına
 * karşı) aynı açık anahtar + aynı Subject DN. Ad benzerliği ölçüt DEĞİLDİR.
 *
 * ESKİ DAVRANIŞ BİR ATLATMAYDI. Önceki `isSelfSignedIn()` adı yanıltıcıydı:
 * hiçbir kendinden-imza kontrolü yapmıyor, yalnız Subject DN'leri
 * karşılaştırıyordu. Saldırganın ürettiği, kurbanın kökü ile aynı DN'ye
 * sahip ama tamamen farklı anahtarlı bir kök "güvenilir" sayılıyor ve
 * belge TOTAL-PASSED dönüyordu. DN bir kimlik değil, bir etikettir; kimseyi
 * kimseden ayırt etmez ve saldırgan tarafından serbestçe seçilir.
 */
function isTrustAnchor(certDer, anchors) {
  if (!certDer) return false;
  if (anchors.some((ta) => ta.equals(certDer))) return true;

  // Aynı sertifikanın farklı ama denk DER kodlaması: anahtar + isim eşleşmeli.
  const spki = safe(() => publicKeyDer(certDer));
  const subject = safe(() => ext.getSubjectDer(certDer));
  if (!spki || !subject) return false;

  return anchors.some((a) => {
    const s = safe(() => publicKeyDer(a));
    const n = safe(() => ext.getSubjectDer(a));
    return s && n && s.equals(spki) && n.equals(subject);
  });
}

/** Sertifikanın SubjectPublicKeyInfo DER kodlaması. */
function publicKeyDer(certDer) {
  return new crypto.X509Certificate(certDer)
    .publicKey.export({ type: 'spki', format: 'der' });
}

/** ETSI seviye tespiti. */
/**
 * PAdES temel seviyesini belirler — ETSI EN 319 142-1.
 *
 * Eskiden `pdfBuffer.toString('latin1').includes('/Type /DocTimeStamp')`
 * kullanılıyordu. Bu bir kanıt değil, metin aramasıdır: kullanıcının yazdığı
 * bir paragrafta ya da gömülü bir dosyada o dizge geçse belge B-LTA görünürdü.
 *
 * Artık üç ölçüt de DOĞRULANMIŞ kanıta dayanır:
 *   B-T   → imza zaman damgası kriptografik olarak geçerli
 *   B-LT  → imza yolundaki sertifikalar için DSS'te KULLANILABİLİR iptal
 *           kanıtı var (imzası doğrulanmış OCSP ya da CRL)
 *   B-LTA → belgede gerçekten ayrıştırılmış bir DocTimeStamp imza alanı var
 */
function determineLevel(entry, sig, ctx) {
  const hasTimestamp = entry.timestamps.some((t) => t.valid);

  // "DSS'te bir şey var" yetmez: kanıt bu sertifikaya ait ve GEÇERLİ olmalı.
  // status === 'unknown' olan kayıtlar (doğrulanamayan yanıtlar) sayılmaz.
  const usableRevocation = entry.revocation.filter(
    (r) => r.source && r.source.startsWith('dss') &&
           (r.status === 'good' || r.status === 'revoked'));

  // Zincirdeki kendinden imzalı olmayan her sertifika için kanıt gerekir
  const needed = entry.revocation.length;
  const hasRevocation = needed > 0 && usableRevocation.length === needed;

  // DocTimeStamp: metin araması değil, ayrıştırılmış imza alanı
  const hasDocTs = (ctx.allSignatures || []).some(
    (s) => s.type === 'doc-timestamp' || s.subFilter === 'ETSI.RFC3161');

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

module.exports = {
  verifyPdf, VerifyError, INDICATION, describeCert, readDss, findRevisions,
  // Test edilebilirlik: karar mantığının ağa ve PDF'e ihtiyacı olmadan
  // sınanabilmesi gerekir.
  poeAntedatesRevocation, isTrustAnchor
};
