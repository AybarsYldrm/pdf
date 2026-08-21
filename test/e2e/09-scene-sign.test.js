'use strict';
/**
 * Sahne → PDF → PAdES uçtan uca testleri.
 *
 * İDDİA: sahne modeli imzalama motorunu DEĞİŞTİRMEZ. Sahneden üretilen PDF,
 * HTML'den üretilen PDF ile aynı yoldan geçer; aynı seviyelere ulaşır, aynı
 * doğrulayıcıdan geçer, imza yuvası koordinatları manifestten okunur.
 *
 * İkinci iddia: içe aktarma turu kapanır. Sahne → PDF → sahne dönüşü
 * koordinatları korur.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { Scene, compileToPdf, importFromPdf, importFromHtml } = require('@fitfak/pdf-scene');
const { PAdESManager } = require('@fitfak/pades/src/utils/pades_manager');
const { fromManifestSlot } = require('@fitfak/pades/src/signature/visible');
const { verifyPdf, INDICATION } = require('@fitfak/verify');
const paper = require('@fitfak/paper');

const { startTestServices } = require('./pki/services');

const ROOT = path.resolve(__dirname, '..', '..');
const FONTS = [{ family: 'Ubuntu', src: path.join(ROOT, 'assets', 'Ubuntu-Regular.ttf') }];

let svc;
let manager;

test.before(async () => {
  svc = await startTestServices();
  manager = new PAdESManager({
    tsaUrl: svc.endpoints.tsa,
    tsaOptions: { hashName: 'sha256', certReq: true },
    allowPrivateNetwork: true
  });
});

test.after(async () => { if (svc) await svc.close(); });

/** İmza yuvası taşıyan örnek bir sertifika sahnesi. */
function certificateScene() {
  const s = Scene.blank({ title: 'Katılım Belgesi', margin: { top: 40, right: 40, bottom: 40, left: 40 } });
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('rect', {
      id: 'ust', x: 40, y: 40, width: 515, height: 80, fill: '#1f3a63', radius: 6
    }));
    s.addNode(Scene.createNode('text', {
      id: 'baslik', x: 60, y: 55, width: 475, height: 50,
      text: 'KATILIM BELGESİ', fontSize: 24, color: '#ffffff',
      align: 'center', valign: 'middle'
    }));
    s.addNode(Scene.createNode('text', {
      id: 'govde', x: 60, y: 180, width: 475, height: 120,
      text: 'Sayın Aybars YILDIRIM, 19 Ağustos 2026 tarihinde düzenlenen ' +
            'Belge Güvenliği çalıştayına katılmıştır.',
      fontSize: 12, lineHeight: 1.6
    }));
    s.addNode(Scene.createNode('signature', {
      id: 'yuva', x: 330, y: 640, width: 200, height: 70,
      fieldName: 'Imza_Yetkili', signer: 'Aybars YILDIRIM', signerTitle: 'Düzenleyen'
    }));
  });
  return s;
}

test('sahne → PDF → B-B imza doğrulanır', async () => {
  const { pdf, manifest } = compileToPdf(certificateScene(), { fonts: FONTS });
  assert.strictEqual(manifest.signatureSlots.length, 1);

  const p = svc.pki.profile('signer');
  const signed = await manager.sign({
    mode: 'B', pdfBuffer: pdf,
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems,
    fieldName: 'Imza_Yetkili'
  });

  const r = await verifyPdf(signed.pdf, {
    trustAnchors: [svc.pki.root.certPem], allowNetwork: false
  });
  const s = r.signatures[0];
  assert.strictEqual(s.indication, INDICATION.PASSED, JSON.stringify(s.errors));
  assert.strictEqual(s.achievedLevel, 'B-B');
  assert.strictEqual(s.coverage.coversWholeDocument, true);
});

test('sahne → PDF → B-LTA: en yüksek seviye sahne yolundan da erişilir', async () => {
  const { pdf } = compileToPdf(certificateScene(), { fonts: FONTS });

  const p = svc.pki.profile('signer');
  const signed = await manager.sign({
    mode: 'LTA', pdfBuffer: pdf,
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems,
    fieldName: 'Imza_LTA', ltv: { prefer: 'both' }
  });

  const r = await verifyPdf(signed.pdf, {
    trustAnchors: [svc.pki.root.certPem], allowNetwork: false
  });
  const sig = r.signatures.find((x) => x.type !== 'doc-timestamp');
  assert.strictEqual(sig.indication, INDICATION.PASSED, JSON.stringify(sig.errors));
  assert.strictEqual(sig.achievedLevel, 'B-LTA');
  assert.strictEqual(r.ltv.dssPresent, true);
});

test('imza yuvası koordinatları GÖRÜNÜR imzayı doğru yere koyar', async () => {
  const { pdf, manifest } = compileToPdf(certificateScene(), { fonts: FONTS });
  const slot = manifest.signatureSlots[0];

  // Sahne (sol-üst) → PDF (sol-alt) çevrimi manifestte hazır bekliyor
  assert.deepStrictEqual(slot.sceneRect, { x: 330, y: 640, width: 200, height: 70 });
  assert.strictEqual(slot.origin, 'bottom-left');
  assert.strictEqual(slot.rect.y, +(841.89 - 640 - 70).toFixed(3));

  const visible = fromManifestSlot(slot, {
    template: 'minimal',
    font: path.join(ROOT, 'assets', 'Ubuntu-Regular.ttf'),
    baseDir: ROOT,
    vars: { signerName: slot.signer, role: slot.role, date: new Date() }
  });
  assert.strictEqual(visible.page, 0);
  assert.deepStrictEqual(
    { x: visible.defaultPosition.x, y: visible.defaultPosition.y },
    { x: slot.rect.x, y: slot.rect.y });

  const p = svc.pki.profile('signer');
  const signed = await manager.sign({
    mode: 'T', pdfBuffer: pdf,
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems,
    fieldName: slot.fieldName, visibleSignature: visible
  });

  const r = await verifyPdf(signed.pdf, {
    trustAnchors: [svc.pki.root.certPem], allowNetwork: false
  });
  assert.strictEqual(r.signatures[0].indication, INDICATION.PASSED,
    JSON.stringify(r.signatures[0].errors));
  assert.strictEqual(r.signatures[0].achievedLevel, 'B-T');
});

test('çok sayfalı sahne imzalanır ve bütün sayfalar korunur', async () => {
  const s = Scene.blank({ title: 'Çok Sayfa' });
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('text', { x: 60, y: 60, width: 400, height: 30, text: 'Sayfa bir' }));
    s.addPage({ id: 'pg2' });
    s.addNode(Scene.createNode('text', { x: 60, y: 60, width: 400, height: 30, text: 'Sayfa iki' }),
      { pageId: 'pg2' });
    s.addPage({ id: 'pg3' });
    s.addNode(Scene.createNode('text', { x: 60, y: 60, width: 400, height: 30, text: 'Sayfa üç' }),
      { pageId: 'pg3' });
  });

  const { pdf } = compileToPdf(s, { fonts: FONTS });
  const p = svc.pki.profile('signer');
  const signed = await manager.sign({
    mode: 'T', pdfBuffer: pdf,
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems, fieldName: 'Cok'
  });

  const r = await verifyPdf(signed.pdf, {
    trustAnchors: [svc.pki.root.certPem], allowNetwork: false
  });
  assert.strictEqual(r.signatures[0].indication, INDICATION.PASSED);

  const { PdfDocument } = require('@fitfak/pdf-doc');
  const doc = PdfDocument.load(signed.pdf);
  assert.strictEqual(doc.pageCount, 3);
});

test('imzalı belgeye dokunulursa doğrulama BAŞARISIZ olur', async () => {
  const { pdf } = compileToPdf(certificateScene(), { fonts: FONTS });
  const p = svc.pki.profile('signer');
  const signed = await manager.sign({
    mode: 'B', pdfBuffer: pdf,
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems, fieldName: 'Bozulacak'
  });

  // İmzanın KAPSADIĞI aralıktan bir baytı değiştiriyoruz.
  // Metni arayıp bulamayız: içerik akışı sıkıştırılmış ve harfler glif
  // kimliğine çevrilmiştir. Bunun yerine /ByteRange'in birinci parçasının
  // ortasını hedefliyoruz — orası kesinlikle imza kapsamındadır.
  const raw = signed.pdf.toString('latin1');
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(raw);
  assert.ok(m, '/ByteRange bulunmalı');
  const start = Number(m[1]);
  const length = Number(m[2]);
  const at = start + Math.floor(length / 2);

  const tampered = Buffer.from(signed.pdf);
  tampered[at] = tampered[at] ^ 0xff;

  const r = await verifyPdf(tampered, {
    trustAnchors: [svc.pki.root.certPem], allowNetwork: false
  });
  assert.strictEqual(r.signatures[0].indication, INDICATION.FAILED);
});

test('sahne → PDF → sahne turu koordinatları korur', () => {
  const s = Scene.blank({ title: 'Tur' });
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('text', {
      x: 72, y: 144, width: 300, height: 24, text: 'Konum korunmalı', fontSize: 13
    }));
    s.addNode(Scene.createNode('text', {
      x: 72, y: 300, width: 300, height: 24, text: 'İkinci kutu ÇĞİÖŞÜ', fontSize: 13
    }));
  });

  const { pdf } = compileToPdf(s, { fonts: FONTS });
  const { scene, warnings } = importFromPdf(pdf, { fonts: FONTS });

  const nodes = scene.pages[0].nodes;
  assert.strictEqual(nodes.length, 2);
  assert.deepStrictEqual(nodes.map((n) => [n.frame.x, n.frame.y]), [[72, 144], [72, 300]]);
  assert.strictEqual(nodes[1].text, 'İkinci kutu ÇĞİÖŞÜ');

  // İçe aktarmanın SINIRI açıkça bildirilir
  assert.ok(warnings.some((w) => w.code === 'WARN_IMPORT_FLATTENED'));
});

test('HTML → sahne → PDF → imza zinciri çalışır', async () => {
  const HTML = `<article class="paper paper--kurumsal">
    <h1>İçe Aktarılan Belge</h1>
    <p>Bu belge önce HTML'di, sonra sahne oldu, sonra imzalandı.</p>
    <div class="paper-signature-row">
      <div class="paper-sig-slot" data-signer="aybars" data-role="Düzenleyen">İmza</div>
    </div>
  </article>`;

  const { scene, warnings } = importFromHtml({
    html: HTML,
    css: paper.stack('kurumsal'),
    fonts: FONTS,
    baseDir: ROOT,
    assetRoots: [path.join(ROOT, 'assets')]
  });

  // Düzleştirme bir sınırdır ve söylenir
  assert.ok(warnings.some((w) => w.code === 'WARN_IMPORT_FLATTENED'));
  assert.ok(scene.pages[0].nodes.length > 0);
  assert.ok(scene.pages[0].nodes.some((n) => n.type === 'text' && /İçe Aktarılan/.test(n.text)));

  const { pdf, manifest } = compileToPdf(scene, { fonts: FONTS });
  assert.ok(manifest.signatureSlots.length >= 1, 'HTML yuvası sahneye taşınmalı');

  const p = svc.pki.profile('signer');
  const signed = await manager.sign({
    mode: 'T', pdfBuffer: pdf,
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems,
    fieldName: 'Ice_Aktarilan'
  });

  const r = await verifyPdf(signed.pdf, {
    trustAnchors: [svc.pki.root.certPem], allowNetwork: false
  });
  assert.strictEqual(r.signatures[0].indication, INDICATION.PASSED,
    JSON.stringify(r.signatures[0].errors));
});

test('sahne PDF si aynı belgede iki imzayı taşır', async () => {
  const s = Scene.blank({ title: 'Çift İmza' });
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('text', { x: 60, y: 60, width: 400, height: 30, text: 'Çift imzalı' }));
    s.addNode(Scene.createNode('signature', {
      x: 60, y: 640, width: 180, height: 60, fieldName: 'Imza_A', signerTitle: 'Hazırlayan'
    }));
    s.addNode(Scene.createNode('signature', {
      x: 330, y: 640, width: 180, height: 60, fieldName: 'Imza_B', signerTitle: 'Onaylayan'
    }));
  });

  const { pdf, manifest } = compileToPdf(s, { fonts: FONTS });
  assert.strictEqual(manifest.signatureSlots.length, 2);

  const a = svc.pki.profile('signer');
  const first = await manager.sign({
    mode: 'T', pdfBuffer: pdf,
    keyPem: a.keyPem, certPem: a.certPem, chainPems: a.chainPems, fieldName: 'Imza_A'
  });

  const b = svc.pki.profile('signer2');
  const second = await manager.sign({
    mode: 'T', pdfBuffer: first.pdf,
    keyPem: b.keyPem, certPem: b.certPem, chainPems: b.chainPems, fieldName: 'Imza_B'
  });

  const r = await verifyPdf(second.pdf, {
    trustAnchors: [svc.pki.root.certPem], allowNetwork: false
  });
  assert.strictEqual(r.signatures.length, 2);
  for (const sig of r.signatures) {
    assert.strictEqual(sig.indication, INDICATION.PASSED, JSON.stringify(sig.errors));
  }
  // İlk imza artık belgenin tamamını kapsamaz ama GEÇERLİDİR
  assert.strictEqual(r.signatures[1].coverage.coversWholeDocument, true);
});
