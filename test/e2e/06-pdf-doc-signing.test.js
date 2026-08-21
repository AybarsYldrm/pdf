'use strict';
/**
 * `@fitfak/pdf-doc` ile `@fitfak/pades` arasındaki köprü — uçtan uca.
 *
 * Sınanan iki kabul ölçütü:
 *   1. Modern (PDF 1.5+) bir belge — çapraz başvuru AKIŞI ya da nesne akışı —
 *      dışarıdan yüklendiğinde imzalanabilmeli.
 *   2. İmzalı bir belge artımlı olarak düzenlendiğinde İMZA GEÇERLİ KALMALI.
 *
 * Ağa çıkılmaz: yerel CA + OCSP + CRL + TSA kullanılır.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { startTestServices } = require('./pki/services');
const { PAdESManager } = require('@fitfak/pades/src/utils/pades_manager');
const { findAllSignatures } = require('@fitfak/pades/src/utils/pdf_parser');
const { normalizePdf, needsNormalization, looksEncrypted } = require('@fitfak/pades/src/utils/normalize');
const { PdfDocument } = require('@fitfak/pdf-doc');
const verify = require('@fitfak/verify');

const FIX = path.join(__dirname, '..', 'fixtures', 'pdf');
if (!fs.existsSync(path.join(FIX, 'xref-stream.pdf'))) {
  require(path.join(FIX, 'generate.js')).generateAll();
}
const fixture = (name) => fs.readFileSync(path.join(FIX, name));

let svc;
let manager;
let profile;

test.before(async () => {
  svc = await startTestServices();
  profile = svc.pki.profile('signer');
  manager = new PAdESManager({
    tsaUrl: svc.endpoints.tsa,
    tsaOptions: { hashName: 'sha256', certReq: true }
  });
});

test.after(async () => { if (svc) await svc.close(); });

const signOptions = (extra = {}) => ({
  keyPem: profile.keyPem,
  certPem: profile.certPem,
  chainPems: profile.chainPems,
  ...extra
});

const check = (pdf, opts = {}) =>
  verify.verifyPdf(pdf, { trustAnchors: [profile.rootPem], offline: true, ...opts });

/* ================================================================== */
/* 1. Modern PDF yapıları imzalanabiliyor mu                          */
/* ================================================================== */

test('normalize: klasik yapıdaki belge dokunulmadan geçer', () => {
  const pdf = fixture('classic-xref.pdf');
  assert.strictEqual(needsNormalization(pdf), false);

  const res = normalizePdf(pdf);
  assert.strictEqual(res.normalized, false);
  assert.strictEqual(res.pdf, pdf, 'gereksiz kopya üretilmemeli');
});

test('normalize: xref akışı klasik tabloya köprülenir, orijinal bayt korunur', () => {
  const pdf = fixture('xref-stream.pdf');
  assert.strictEqual(needsNormalization(pdf), true);

  const res = normalizePdf(pdf);
  assert.strictEqual(res.normalized, true);
  assert.ok(res.pdf.subarray(0, pdf.length).equals(pdf),
    'köprü revizyonu orijinal baytların ÜSTÜNE yazılmamalı');
  assert.strictEqual(needsNormalization(res.pdf), false);
  assert.strictEqual(PdfDocument.load(res.pdf).pageCount, 2);
});

test('normalize: nesne akışındaki nesneler açık nesnelere dönüştürülür', () => {
  const pdf = fixture('object-stream.pdf');
  const res = normalizePdf(pdf);

  assert.strictEqual(res.normalized, true);
  const re = PdfDocument.load(res.pdf);
  assert.strictEqual(re.pageCount, 2);

  // Artık hiçbir sayfa /ObjStm içinde olmamalı: klasik xref bunu gösteremez
  for (const ref of re.pageRefs) {
    assert.notStrictEqual(re.xref.getEntry(ref.num).type, 2);
  }
});

test('normalize: şifreli belge açık hatayla reddedilir, istenirse çözülür', () => {
  const pdf = fixture('encrypted-rc4.pdf');
  assert.strictEqual(looksEncrypted(pdf), true);

  assert.throws(() => normalizePdf(pdf), (err) => err.code === 'ERR_PDF_ENCRYPTED');

  // Açıkça istendiğinde şifre kaldırılır
  const res = normalizePdf(pdf, { decrypt: true });
  assert.strictEqual(res.normalized, true);
  const re = PdfDocument.load(res.pdf);
  assert.strictEqual(re.isEncrypted, false);
  assert.match(re.getPageContent(0).toString('latin1'), /BT/);
});

test('şifresi kaldırılan belge imzalanabilir', async () => {
  const plain = normalizePdf(fixture('encrypted-rc4.pdf'), { decrypt: true }).pdf;

  const res = await manager.sign(signOptions({
    mode: 'B', pdfBuffer: plain, fieldName: 'SigDecrypted'
  }));

  const report = await check(res.pdf);
  assert.strictEqual(report.signatures[0].indication, 'TOTAL-PASSED');
});

test('xref akışlı PDF imzalanır ve doğrulanır', async () => {
  const res = await manager.sign(signOptions({
    mode: 'T',
    pdfBuffer: fixture('xref-stream.pdf'),
    fieldName: 'SigXrefStream'
  }));

  assert.strictEqual(res.achievedLevel, 'pades-t');
  assert.strictEqual(findAllSignatures(res.pdf).length, 1);

  const report = await check(res.pdf);
  assert.strictEqual(report.signatures.length, 1);
  assert.strictEqual(report.signatures[0].indication, 'TOTAL-PASSED');
  assert.strictEqual(report.signatures[0].cms.signatureValid, true);
  assert.strictEqual(report.signatures[0].achievedLevel, 'B-T');
});

test('nesne akışlı PDF imzalanır ve sayfaları okunabilir kalır', async () => {
  const original = PdfDocument.load(fixture('object-stream.pdf'));
  const beforeText = original.getPageContent(1).toString('latin1');

  const res = await manager.sign(signOptions({
    mode: 'B',
    pdfBuffer: fixture('object-stream.pdf'),
    fieldName: 'SigObjStm'
  }));

  const report = await check(res.pdf);
  assert.strictEqual(report.signatures[0].indication, 'TOTAL-PASSED');

  const signed = PdfDocument.load(res.pdf);
  assert.strictEqual(signed.pageCount, 2);
  assert.strictEqual(signed.getPageContent(1).toString('latin1'), beforeText,
    'içerik dönüştürme sırasında değişmemeli');
});

test('bozuk xref taşıyan PDF onarılarak imzalanır', async () => {
  const res = await manager.sign(signOptions({
    mode: 'B',
    pdfBuffer: fixture('broken-xref.pdf'),
    fieldName: 'SigBroken'
  }));

  const report = await check(res.pdf);
  assert.strictEqual(report.signatures[0].indication, 'TOTAL-PASSED');
});

/* ================================================================== */
/* 2. İmzalı belge düzenlendikten sonra imza geçerli kalıyor mu       */
/* ================================================================== */

test('imzalı PDF artımlı düzenlenince imza geçerli kalır', async () => {
  const signed = (await manager.sign(signOptions({
    mode: 'T',
    pdfBuffer: fixture('classic-xref-3p.pdf'),
    fieldName: 'Sig1'
  }))).pdf;

  const before = await check(signed);
  assert.strictEqual(before.signatures[0].indication, 'TOTAL-PASSED');
  assert.strictEqual(before.documentIntegrity.modifiedAfterSigning, false);

  // --- imzadan SONRA düzenle ---
  const doc = PdfDocument.load(signed);
  assert.strictEqual(doc.hasSignatures, true);
  doc.addText(0, 'imzadan sonra eklenen not', { x: 50, y: 60, size: 10 });
  doc.insertPage(3, {});
  doc.setMetadata({ subject: 'düzenlendi' });

  const edited = doc.save();
  assert.ok(edited.subarray(0, signed.length).equals(signed),
    'imzanın kapsadığı baytlar bire bir korunmalı');

  const after = await check(edited);
  assert.strictEqual(after.signatures.length, 1);

  // İMZA SAĞLAM, BELGE AYNI DEĞİL — ve gösterge bunu söylemek zorunda.
  //
  // Kriptografi bozulmadı: imza kapsadığı sürüm için hâlâ geçerlidir.
  // Ama okuyucunun gördüğü belge o sürüm değildir. Bunu TOTAL-PASSED
  // saymak imzayı imzalanmamış içeriğe kefil yapardı ve saldırganın
  // eklemesi ile buradaki meşru düzenleme ayırt edilemezdi.
  assert.strictEqual(after.signatures[0].cms.signatureValid, true,
    'imzanın kendisi kriptografik olarak geçerli kalmalı');
  assert.strictEqual(after.signatures[0].cms.messageDigestMatches, true);
  assert.strictEqual(after.signatures[0].indication, 'INDETERMINATE',
    'sonradan değiştirilmiş belge TOTAL-PASSED dönemez');
  assert.strictEqual(after.signatures[0].subIndication, 'DOC_MODIFIED_AFTER_SIGNING');

  // Değişiklik gizlenmemeli: rapor açıkça "sonradan değiştirildi" demeli
  assert.strictEqual(after.documentIntegrity.modifiedAfterSigning, true);
  assert.ok(after.documentIntegrity.unsignedBytes > 0);
  assert.strictEqual(after.signatures[0].coverage.coversWholeDocument, false);
  assert.strictEqual(after.signatures[0].coverage.modifiedAfterSigning, true);
  assert.ok(after.signatures[0].coverage.changes.length > 0,
    'neyin değiştiği raporlanmalı');

  const reloaded = PdfDocument.load(edited);
  assert.strictEqual(reloaded.pageCount, 4);
  assert.strictEqual(reloaded.getInfo().Subject, 'düzenlendi');
});

test('imzalı belgeyi tam yeniden yazmak engellenir', async () => {
  const signed = (await manager.sign(signOptions({
    mode: 'B',
    pdfBuffer: fixture('classic-xref.pdf'),
    fieldName: 'SigFull'
  }))).pdf;

  const doc = PdfDocument.load(signed);
  assert.throws(() => doc.save({ full: true }),
    (err) => err.code === 'ERR_WOULD_BREAK_SIGNATURE');

  // force verilirse yazar — ama imza da geçersizleşir; bu bilinçli bir seçim
  const forced = doc.save({ full: true, force: true });
  const report = await check(forced);
  assert.notStrictEqual(report.signatures[0] && report.signatures[0].indication, 'TOTAL-PASSED');
});

test('düzenlenmiş imzalı belge ikinci kez imzalanabilir, iki imza da geçerli', async () => {
  const first = (await manager.sign(signOptions({
    mode: 'T',
    pdfBuffer: fixture('classic-xref-3p.pdf'),
    fieldName: 'Imza_A'
  }))).pdf;

  const doc = PdfDocument.load(first);
  doc.addText(1, 'ara duzenleme', { x: 40, y: 40 });
  const edited = doc.save();

  const second = (await manager.sign(signOptions({
    mode: 'T',
    pdfBuffer: edited,
    fieldName: 'Imza_B'
  }))).pdf;

  assert.strictEqual(findAllSignatures(second).length, 2);

  const report = await check(second);
  assert.strictEqual(report.signatures.length, 2);

  // İkisinin de KRİPTOGRAFİSİ geçerli — ama ikisi aynı belgeyi imzalamadı.
  for (const sig of report.signatures) {
    assert.strictEqual(sig.cms.signatureValid, true);
  }

  // A imzaladıktan SONRA sayfaya metin eklendi: A'nın imzası artık okuyucunun
  // gördüğü belgeyi doğrulamıyor. B ise düzenlenmiş hâli imzaladı.
  const [ilk, ikinci] = report.signatures;
  assert.strictEqual(ilk.indication, 'INDETERMINATE',
    'ara düzenlemeden önceki imza belgenin şimdiki hâline kefil olamaz');
  assert.strictEqual(ilk.subIndication, 'DOC_MODIFIED_AFTER_SIGNING');
  assert.strictEqual(ikinci.indication, 'TOTAL-PASSED',
    'düzenlenmiş hâli imzalayan ikinci imza geçerli olmalı');
});

test('ardışık imzalama: ARA DÜZENLEME YOKSA iki imza da geçerli kalır', async () => {
  // Bir öncekinin karşıtı: iki imza arasında belge DEĞİŞMEZSE ilk imza da
  // geçerli kalmalı. Yeni bütünlük kontrolü bu meşru akışı bozmamalı.
  const first = (await manager.sign(signOptions({
    mode: 'T',
    pdfBuffer: fixture('classic-xref-3p.pdf'),
    fieldName: 'Ardisik_A'
  }))).pdf;

  const second = (await manager.sign(signOptions({
    mode: 'T',
    pdfBuffer: first,
    fieldName: 'Ardisik_B'
  }))).pdf;

  const report = await check(second);
  assert.strictEqual(report.signatures.length, 2);
  for (const sig of report.signatures) {
    assert.strictEqual(sig.indication, 'TOTAL-PASSED',
      `ara düzenleme yokken imza geçersiz sayıldı: ${sig.subIndication} — ` +
      `${sig.errors.join(' | ')}`);
  }
  assert.strictEqual(report.documentIntegrity.modifiedAfterSigning, false);
});

test('modern PDF LTV ile LT seviyesine çıkarılır', async () => {
  const res = await manager.sign(signOptions({
    mode: 'LT',
    pdfBuffer: fixture('xref-stream.pdf'),
    fieldName: 'SigLt',
    ltv: { autoDiscover: true, prefer: 'ocsp-first' }
  }));

  assert.strictEqual(res.achievedLevel, 'pades-lt', res.reasons.join('; '));

  const report = await check(res.pdf);
  assert.strictEqual(report.signatures[0].indication, 'TOTAL-PASSED');
  assert.ok(['B-LT', 'B-LTA'].includes(report.signatures[0].achievedLevel),
    `beklenmeyen seviye: ${report.signatures[0].achievedLevel}`);
});

/* ================================================================== */
/* 3. Görsel ekleme + imzalama birlikte                               */
/* ================================================================== */

test('görsel eklenip sonra imzalanan belge geçerli', async () => {
  const png = fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'studio', 'favicon.png'));

  const doc = PdfDocument.load(fixture('xref-stream.pdf'));
  doc.addImage(0, png, { x: 400, y: 700, width: 80 });
  doc.addText(0, 'Kase', { x: 400, y: 690, size: 8 });
  const prepared = doc.save();

  const res = await manager.sign(signOptions({
    mode: 'T',
    pdfBuffer: prepared,
    fieldName: 'SigGorsel'
  }));

  const report = await check(res.pdf);
  assert.strictEqual(report.signatures[0].indication, 'TOTAL-PASSED');
  assert.strictEqual(report.documentIntegrity.modifiedAfterSigning, false,
    'imza, görsel eklendikten SONRA atıldığı için tüm belgeyi kapsamalı');

  const signed = PdfDocument.load(res.pdf);
  assert.match(signed.getPageContent(0).toString('latin1'), /\/Im\d+ Do/);
});
