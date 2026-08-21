'use strict';
/**
 * Uçtan uca: HTML/CSS → PDF → görünür damgayla imzala → LTV.
 *
 * Bu testin asıl konusu LAYOUT MANIFEST'tir: imza koordinatları artık kodda
 * sabit sayı olarak değil, HTML'deki `data-signer` yuvasından gelir.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { startTestServices } = require('./pki/services');
const { render } = require('@fitfak/pdf-html');
const paper = require('@fitfak/paper');
const { PAdESManager } = require('@fitfak/pades/src/utils/pades_manager');
const { fromManifestSlot } = require('@fitfak/pades/src/signature/visible');
const { findAllSignatures } = require('@fitfak/pades/src/utils/pdf_parser');

const ROOT = path.join(__dirname, '..', '..');
const FONT = path.join(ROOT, 'assets', 'Ubuntu-Regular.ttf');

const DOC_HTML = `
<article class="paper paper--kurumsal">
  <h1>Uçtan Uca Test Belgesi</h1>
  <p>Bu belge HTML/CSS'ten üretildi ve manifest koordinatlarıyla imzalandı.</p>
  <div class="paper-signature-row">
    <div class="paper-sig-slot" data-signer="aybars" data-role="Düzenleyen">
      <span class="paper-sig-slot__role">Düzenleyen</span>
    </div>
    <div class="paper-sig-slot" data-signer="ahmet" data-role="Onaylayan">
      <span class="paper-sig-slot__role">Onaylayan</span>
    </div>
  </div>
</article>`;

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

test('HTML → PDF → imza: koordinatlar manifest\'ten gelir', async () => {
  const { pdf, manifest, warnings } = render({
    html: DOC_HTML,
    css: paper.stack('kurumsal'),
    fonts: [{ family: 'Ubuntu', src: FONT }],
    page: { size: 'A4', margin: '20mm 18mm' },
    metadata: { title: 'Uçtan Uca Test', author: 'FITFAK', lang: 'tr-TR' },
    baseDir: ROOT
  });

  assert.strictEqual(warnings.length, 0, 'render uyarı üretmemeli');
  assert.strictEqual(manifest.signatureSlots.length, 2);

  const slot = manifest.signatureSlots.find((s) => s.id === 'aybars');
  assert.ok(slot, 'aybars yuvası bulunmalı');

  // Görünür imza doğrudan yuvadan kurulur — sihirli sayı yok
  const visible = fromManifestSlot(slot, {
    template: 'minimal',
    font: FONT,
    seed: 7,
    vars: {
      signerName: 'Aybars YILDIRIM',
      docNo: 'DOC-E2E-001',
      date: new Date('2026-08-18T10:00:00Z'),
      verifyUrl: 'https://dogrula.fitfak.net/d/E2E001'
    }
  });
  assert.ok(visible, 'görünür imza üretilmeli');
  assert.strictEqual(visible.defaultPosition.x, slot.rect.x);
  assert.strictEqual(visible.defaultPosition.y, slot.rect.y);
  assert.strictEqual(visible.defaultPosition.width, slot.rect.width);

  const p = svc.pki.profile('signer');
  const res = await manager.sign({
    mode: 'LT',
    pdfBuffer: pdf,
    keyPem: p.keyPem,
    certPem: p.certPem,
    chainPems: p.chainPems,
    fieldName: 'Sig_Manifest',
    visibleSignature: visible,
    ltv: { prefer: 'both' }
  });

  assert.strictEqual(res.achievedLevel, 'pades-lt');
  const sigs = findAllSignatures(res.pdf);
  assert.strictEqual(sigs.length, 1);
  assert.ok(res.pdf.length > pdf.length, 'imzalı PDF daha büyük olmalı');
});

test('HTML → PDF → iki imza: her yuva kendi imzasını alır', async () => {
  const { pdf, manifest } = render({
    html: DOC_HTML,
    css: paper.stack('kurumsal'),
    fonts: [{ family: 'Ubuntu', src: FONT }],
    page: { size: 'A4', margin: '20mm 18mm' },
    baseDir: ROOT
  });

  const profiles = { aybars: svc.pki.profile('signer'), ahmet: svc.pki.profile('signer2') };
  let current = pdf;

  for (const slot of manifest.signatureSlots) {
    const p = profiles[slot.id];
    const visible = fromManifestSlot(slot, {
      template: 'minimal', font: FONT, seed: 3,
      vars: { signerName: p.name, docNo: 'DOC-E2E-002', date: new Date() }
    });

    const res = await manager.sign({
      mode: 'T',
      pdfBuffer: current,
      keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems,
      fieldName: `Sig_${slot.id}`,
      visibleSignature: visible
    });
    assert.strictEqual(res.achievedLevel, 'pades-t');
    current = res.pdf;
  }

  const sigs = findAllSignatures(current);
  assert.strictEqual(sigs.length, 2, 'iki imza da eklenmiş olmalı');

  // İmza yuvaları farklı yerlerde olduğu için görünür imzalar çakışmamalı
  const [a, b] = manifest.signatureSlots;
  assert.notStrictEqual(a.rect.x, b.rect.x);
});

test('PFX ile HTML belgesini imzalama (tam zincir)', async () => {
  const p12 = require('@fitfak/pkcs12');
  const p = svc.pki.profile('signer');

  const pfx = p12.build({
    privateKeyPem: p.keyPem,
    certificatePem: p.certPem,
    chainPems: p.chainPems,
    password: 'e2e',
    friendlyName: p.name
  });

  const { pdf, manifest } = render({
    html: DOC_HTML,
    css: paper.stack('resmi'),
    fonts: [{ family: 'Ubuntu', src: FONT }],
    baseDir: ROOT
  });

  const res = await manager.sign({
    mode: 'LTA',
    pdfBuffer: pdf,
    pfx,
    pfxPassword: 'e2e',
    fieldName: 'Sig_Pfx_Html',
    visibleSignature: fromManifestSlot(manifest.signatureSlots[0], {
      template: 'qr', font: FONT, seed: 1,
      vars: { signerName: p.name, docNo: 'DOC-E2E-003',
              verifyUrl: 'https://dogrula.fitfak.net/d/E2E003', date: new Date() }
    }),
    ltv: { prefer: 'both' }
  });

  assert.strictEqual(res.achievedLevel, 'pades-lta');
  const sigs = findAllSignatures(res.pdf);
  assert.ok(sigs.some((s) => s.type === 'DocTimeStamp'), 'arşiv damgası olmalı');
  assert.ok(sigs.some((s) => s.type === 'Sig'), 'imza olmalı');
});
