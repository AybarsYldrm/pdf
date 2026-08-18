'use strict';
/**
 * Uçtan uca örnek: HTML/CSS → PDF → görünür damgayla imzala → LTV.
 *
 * Bu örnek, projenin ana akışını gösterir. Dikkat edilecek nokta: imza
 * koordinatları KODDA YAZILI DEĞİL — HTML'deki `data-signer` yuvasından,
 * layout manifest üzerinden geliyor.
 *
 * Çalıştırma:  node examples/03-html-sign.js
 * (Ağ gerekmez: yerel test PKI'ı kullanılır.)
 */

const fs = require('fs');
const path = require('path');

const paper = require('@fitfak/paper');
const { render } = require('@fitfak/pdf-html');
const { PAdESManager } = require('@fitfak/pades/src/utils/pades_manager');
const { fromManifestSlot } = require('@fitfak/pades/src/signature/visible');
const { findAllSignatures } = require('@fitfak/pades/src/utils/pdf_parser');
const p12 = require('@fitfak/pkcs12');

const ROOT = path.join(__dirname, '..');
const FONT = path.join(ROOT, 'assets', 'Ubuntu-Regular.ttf');
const OUT_DIR = path.join(ROOT, 'out');

function docNo() {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `DOC-${t}-${r}`;
}

async function main() {
  const { startTestServices } = require('../test/e2e/pki/services');

  console.log('[1/5] Yerel test PKI ve servisleri başlatılıyor (CA + OCSP + CRL + TSA)…');
  const svc = await startTestServices();

  try {
    const belgeNo = docNo();
    const verifyUrl = `https://dogrula.fitfak.net/d/${belgeNo.replace(/-/g, '')}`;

    console.log(`[2/5] HTML/CSS'ten PDF üretiliyor… (belge no: ${belgeNo})`);
    const html = fs.readFileSync(path.join(__dirname, 'templates', 'resmi-yazi.html'), 'utf8')
      .replace(/DOC-M2K4J7-X9A3B1/g, belgeNo);

    const { pdf, manifest, warnings } = render({
      html,
      css: paper.stack('kurumsal'),
      fonts: [{ family: 'Ubuntu', src: FONT }],
      page: { size: 'A4', margin: '20mm 18mm' },
      metadata: { title: 'Resmî Bilgilendirme Belgesi', author: 'FITFAK', lang: 'tr-TR' },
      baseDir: ROOT
    });

    for (const w of warnings) console.warn(`   ⚠ ${w.type}: ${w.message}`);
    console.log(`   → ${manifest.pageCount} sayfa, ${manifest.signatureSlots.length} imza yuvası`);
    for (const s of manifest.signatureSlots) {
      console.log(`     · ${s.id} (${s.role}) → sayfa ${s.page}, ` +
                  `x=${s.rect.x} y=${s.rect.y} ${s.rect.width}×${s.rect.height}`);
    }

    console.log('[3/5] İmzalayanlar için PFX üretiliyor…');
    const profiles = {
      aybars: svc.pki.profile('signer'),
      ahmet: svc.pki.profile('signer2')
    };
    const pfxByKey = {};
    for (const [key, p] of Object.entries(profiles)) {
      pfxByKey[key] = p12.build({
        privateKeyPem: p.keyPem, certificatePem: p.certPem,
        chainPems: p.chainPems, password: 'ornek', friendlyName: p.name
      });
    }

    console.log('[4/5] Yuvalara göre imzalanıyor…');
    const manager = new PAdESManager({
      tsaUrl: svc.endpoints.tsa,
      tsaOptions: { hashName: 'sha256', certReq: true }
    });

    let current = pdf;
    for (const slot of manifest.signatureSlots) {
      const p = profiles[slot.id];
      if (!p) continue;

      const visible = fromManifestSlot(slot, {
        template: 'dual',            // Code39 (değişmedi) + QR yan yana
        font: FONT,
        vars: {
          signerName: p.name,
          role: slot.role,
          docNo: belgeNo,
          verifyUrl,
          date: new Date()
        }
      });

      const isLast = slot === manifest.signatureSlots[manifest.signatureSlots.length - 1];
      const res = await manager.sign({
        mode: isLast ? 'LTA' : 'LT',
        pdfBuffer: current,
        pfx: pfxByKey[slot.id],
        pfxPassword: 'ornek',
        fieldName: `Sig_${slot.id}`,
        visibleSignature: visible,
        ltv: { prefer: 'both' }
      });

      console.log(`   → ${p.name}: ${res.achievedLevel}` +
                  (res.reasons.length ? ` (${res.reasons.join('; ')})` : ''));
      if (res.ltvReport) {
        const e = res.ltvReport.embedded;
        console.log(`     gömülü: ${e.certs} sertifika · ${e.ocsps} OCSP · ${e.crls} CRL`);
      }
      current = res.pdf;
    }

    console.log('[5/5] Kaydediliyor…');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const outPath = path.join(OUT_DIR, 'imzali-belge.pdf');
    fs.writeFileSync(outPath, current);

    const sigs = findAllSignatures(current);
    console.log(`\n✔ Bitti: ${outPath}`);
    console.log(`  ${(current.length / 1024).toFixed(1)} KB · ` +
                `${sigs.filter((s) => s.type === 'Sig').length} imza · ` +
                `${sigs.filter((s) => s.type === 'DocTimeStamp').length} belge zaman damgası`);
  } finally {
    await svc.close();
  }
}

main().catch((err) => { console.error('\n✖ Hata:', err); process.exit(1); });
