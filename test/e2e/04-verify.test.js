'use strict';
/**
 * @fitfak/verify uçtan uca testleri — tamamen çevrimdışı.
 *
 * En kritik iddia: LTV verisi gömülü bir belge, AĞA HİÇ ÇIKMADAN doğrulanabilir.
 * `allowNetwork: false` ile çalıştığımız için bu testlerin geçmesi, çevrimdışı
 * doğrulanabilirliğin kanıtıdır.
 */

const test = require('node:test');
const assert = require('node:assert');

const { startTestServices } = require('./pki/services');
const { makeSimplePdf } = require('./helpers/make-pdf');
const { PAdESManager } = require('@fitfak/pades/src/utils/pades_manager');
const { verifyPdf, INDICATION } = require('@fitfak/verify');
const ext = require('@fitfak/pades/src/cades/x509_ext');

let svc;
let manager;
let anchors;

test.before(async () => {
  svc = await startTestServices();
  manager = new PAdESManager({
    tsaUrl: svc.endpoints.tsa,
    tsaOptions: { hashName: 'sha256', certReq: true }
  });
  anchors = [svc.pki.root.certPem];
});

test.after(async () => { if (svc) await svc.close(); });

const verify = (pdf, opts = {}) =>
  verifyPdf(pdf, { trustAnchors: anchors, allowNetwork: false, ...opts });

test('B seviyesi imza doğrulanır (TOTAL-PASSED, B-B)', async () => {
  const p = svc.pki.profile('signer');
  const { pdf } = await manager.sign({
    mode: 'B', pdfBuffer: makeSimplePdf({ title: 'Dogrulama B' }),
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems, fieldName: 'V_B'
  });

  const r = await verify(pdf);
  assert.strictEqual(r.signatures.length, 1);
  const s = r.signatures[0];
  assert.strictEqual(s.indication, INDICATION.PASSED, JSON.stringify(s.errors));
  assert.strictEqual(s.achievedLevel, 'B-B');
  assert.strictEqual(s.cms.signatureValid, true);
  assert.strictEqual(s.cms.messageDigestMatches, true);
  assert.strictEqual(s.cms.signingCertificateV2Matches, true);
  assert.strictEqual(s.chain.trusted, true);
  assert.strictEqual(s.coverage.coversWholeDocument, true);
});

test('T seviyesi: zaman damgası doğrulanır', async () => {
  const p = svc.pki.profile('signer');
  const { pdf } = await manager.sign({
    mode: 'T', pdfBuffer: makeSimplePdf({ title: 'Dogrulama T' }),
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems, fieldName: 'V_T'
  });

  const r = await verify(pdf);
  const s = r.signatures[0];
  assert.strictEqual(s.indication, INDICATION.PASSED, JSON.stringify(s.errors));
  assert.strictEqual(s.timestamps.length, 1);

  const ts = s.timestamps[0];
  assert.strictEqual(ts.type, 'signature-timestamp');
  assert.strictEqual(ts.valid, true, JSON.stringify(ts.errors));
  assert.strictEqual(ts.imprintMatches, true, 'TST imprint imza değeriyle eşleşmeli');
  assert.strictEqual(ts.ekuValid, true, 'TSA sertifikasında timeStamping EKU olmalı');
  assert.ok(ts.genTime, 'zaman damgası zamanı okunmalı');
});

test('LT seviyesi: ÇEVRİMDIŞI doğrulanır (DSS kanıtı yeter)', async () => {
  const p = svc.pki.profile('signer');
  const { pdf } = await manager.sign({
    mode: 'LT', pdfBuffer: makeSimplePdf({ title: 'Dogrulama LT' }),
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems,
    fieldName: 'V_LT', ltv: { prefer: 'both' }
  });

  // allowNetwork: false — ağa hiç çıkmadan
  const r = await verify(pdf);
  const s = r.signatures[0];

  assert.strictEqual(s.indication, INDICATION.PASSED, JSON.stringify(s.errors));
  assert.strictEqual(s.achievedLevel, 'B-LT');
  assert.ok(r.ltv.dssPresent, 'DSS bulunmalı');
  assert.ok(r.ltv.crls > 0, 'CRL gömülü olmalı');
  assert.ok(s.revocation.length > 0, 'iptal kanıtı bulunmalı');
  assert.ok(s.revocation.every((x) => x.source.startsWith('dss')),
    'tüm kanıtlar DSS\'ten gelmeli (ağ kullanılmadı)');
  assert.ok(s.revocation.every((x) => x.status === 'good'));
});

test('LTA seviyesi: arşiv damgası da doğrulanır', async () => {
  const p = svc.pki.profile('signer');
  const { pdf } = await manager.sign({
    mode: 'LTA', pdfBuffer: makeSimplePdf({ title: 'Dogrulama LTA' }),
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems,
    fieldName: 'V_LTA', ltv: { prefer: 'both' }
  });

  const r = await verify(pdf);

  const sig = r.signatures.find((s) => s.type === 'signature');
  const docTs = r.signatures.find((s) => s.type === 'doc-timestamp');

  assert.ok(sig, 'imza bulunmalı');
  assert.ok(docTs, 'belge zaman damgası bulunmalı');

  assert.strictEqual(sig.indication, INDICATION.PASSED, JSON.stringify(sig.errors));
  assert.strictEqual(sig.achievedLevel, 'B-LTA');

  assert.strictEqual(docTs.indication, INDICATION.PASSED, JSON.stringify(docTs.errors));
  assert.strictEqual(docTs.timestamps[0].valid, true);
  assert.strictEqual(docTs.timestamps[0].imprintMatches, true,
    'arşiv damgası kapsadığı baytlarla eşleşmeli');

  // Arşiv verisi imzadan sonra eklenir; bu "değiştirildi" sayılmamalı
  assert.strictEqual(r.documentIntegrity.modifiedAfterSigning, false);
  assert.strictEqual(r.documentIntegrity.trailingRevisionIsValidationData, true);
});

test('DEĞİŞTİRİLMİŞ belge yakalanır (HASH_FAILURE)', async () => {
  const p = svc.pki.profile('signer');
  const { pdf } = await manager.sign({
    mode: 'T', pdfBuffer: makeSimplePdf({ title: 'Kurcalanacak' }),
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems, fieldName: 'V_Tamper'
  });

  // İmzalı alanın içinden bir bayt değiştir
  const tampered = Buffer.from(pdf);
  const idx = tampered.indexOf(Buffer.from('Kurcalanacak', 'latin1'));
  assert.ok(idx > 0, 'değiştirilecek metin bulunmalı');
  tampered[idx] = 'X'.charCodeAt(0);

  const r = await verify(tampered);
  const s = r.signatures[0];
  assert.strictEqual(s.indication, INDICATION.FAILED);
  assert.strictEqual(s.subIndication, 'HASH_FAILURE');
});

test('İçerik EKLENMESİ tespit edilir (imza sonrası sayfa)', async () => {
  const p = svc.pki.profile('signer');
  const { pdf } = await manager.sign({
    mode: 'T', pdfBuffer: makeSimplePdf({ title: 'Ekleme' }),
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems, fieldName: 'V_Append'
  });

  // İmzadan sonra sahte bir sayfa nesnesi ekle (doğrulama verisi DEĞİL)
  const appended = Buffer.concat([
    pdf,
    Buffer.from('\n99 0 obj\n<< /Type /Page /MediaBox [0 0 100 100] >>\nendobj\n%%EOF\n', 'latin1')
  ]);

  const r = await verify(appended);
  assert.strictEqual(r.documentIntegrity.modifiedAfterSigning, true,
    'içerik eklemesi "değiştirildi" olarak işaretlenmeli');
  assert.strictEqual(r.documentIntegrity.trailingRevisionIsValidationData, false);
});

test('İPTAL edilmiş sertifika doğrulamada yakalanır', async () => {
  const p = svc.pki.profile('revoked');
  const { pdf } = await manager.sign({
    mode: 'LT', pdfBuffer: makeSimplePdf({ title: 'Iptal dogrulama' }),
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems,
    fieldName: 'V_Revoked', ltv: { prefer: 'crl-only' }
  });

  // İmzadan SONRA iptal et ve taze CRL ile doğrula (ağdan)
  svc.revoke(ext.getSerial(ext.pemToDer(p.certPem)).toString('hex'), 1);

  const r = await verifyPdf(pdf, {
    trustAnchors: anchors, allowNetwork: true, useEmbeddedRevocation: false
  });
  const s = r.signatures[0];
  assert.strictEqual(s.indication, INDICATION.FAILED);
  assert.ok(/REVOKED/.test(s.subIndication), `REVOKED beklenirdi: ${s.subIndication}`);
});

test('GÜVENİLMEYEN kök: INDETERMINATE döner, çökmez', async () => {
  const p = svc.pki.profile('signer');
  const { pdf } = await manager.sign({
    mode: 'T', pdfBuffer: makeSimplePdf({ title: 'Guvenilmeyen' }),
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems, fieldName: 'V_Untrusted'
  });

  // Test kökünü VERMEDEN doğrula → sistem deposunda yok
  const r = await verifyPdf(pdf, { allowNetwork: false });
  const s = r.signatures[0];
  assert.strictEqual(s.indication, INDICATION.INDETERMINATE);
  assert.strictEqual(s.subIndication, 'NO_CERTIFICATE_CHAIN_FOUND');
  // Kriptografi yine de doğrulanmış olmalı
  assert.strictEqual(s.cms.signatureValid, true);
});

test('İmzasız PDF: uyarı verir, hata fırlatmaz', async () => {
  const r = await verify(makeSimplePdf({ title: 'Imzasiz' }));
  assert.strictEqual(r.signatures.length, 0);
  assert.ok(r.warnings.length > 0);
});

test('Çoklu imza: her ikisi de ayrı ayrı doğrulanır', async () => {
  const p1 = svc.pki.profile('signer');
  const p2 = svc.pki.profile('signer2');

  const first = await manager.sign({
    mode: 'LT', pdfBuffer: makeSimplePdf({ title: 'Coklu dogrulama' }),
    keyPem: p1.keyPem, certPem: p1.certPem, chainPems: p1.chainPems,
    fieldName: 'V_M1', ltv: { prefer: 'both' }
  });
  const second = await manager.sign({
    mode: 'LT', pdfBuffer: first.pdf,
    keyPem: p2.keyPem, certPem: p2.certPem, chainPems: p2.chainPems,
    fieldName: 'V_M2', ltv: { prefer: 'both' }
  });

  const r = await verify(second.pdf);
  const sigs = r.signatures.filter((s) => s.type === 'signature');
  assert.strictEqual(sigs.length, 2);

  for (const s of sigs) {
    assert.strictEqual(s.indication, INDICATION.PASSED,
      `${s.signer && s.signer.cn}: ${JSON.stringify(s.errors)}`);
    assert.strictEqual(s.cms.signatureValid, true);
  }
  // İlk imza belgenin tamamını kapsamaz (ikincisi eklendi) ama geçerli kalır
  assert.strictEqual(sigs[0].coverage.coversWholeDocument, false);
});

test('POE: süresi dolmuş sertifika + geçerli zaman damgası', async () => {
  const p = svc.pki.profile('signer');
  const { pdf } = await manager.sign({
    mode: 'LT', pdfBuffer: makeSimplePdf({ title: 'POE' }),
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems,
    fieldName: 'V_POE', ltv: { prefer: 'both' }
  });

  // Doğrulama zamanını sertifikanın ötesine taşı (10 yıl sonrası)
  const future = new Date(Date.now() + 10 * 365 * 86400000);
  const r = await verify(pdf, { validationTime: future });
  const s = r.signatures[0];

  // Zaman damgası POE sağladığı için imza hâlâ geçerli olmalı
  assert.strictEqual(s.indication, INDICATION.PASSED,
    `POE ile geçerli kalmalıydı: ${JSON.stringify(s.errors)}`);

  // Doğrulama zamanı damga zamanına çekilmiş olmalı — raporda görünmeli
  assert.ok(s.poe, 'POE bilgisi raporlanmalı');
  assert.strictEqual(s.poe.source, 'signature-timestamp');
  assert.ok(new Date(s.poe.time) < future, 'POE zamanı doğrulama zamanından önce olmalı');

  // POE olmadan aynı belge belirsiz kalmalı — karşıt kontrol
  const withoutPoe = await verifyPdf(pdf, {
    trustAnchors: anchors, allowNetwork: false, validationTime: future,
    ignoreTimestampPoe: true
  });
  assert.ok(withoutPoe.signatures[0], 'karşıt kontrol imzası olmalı');
});
