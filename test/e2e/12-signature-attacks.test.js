'use strict';
/**
 * İmza doğrulayıcısına yönelik saldırılar — uçtan uca regresyonlar.
 *
 * Buradaki her senaryo denetim sırasında GERÇEKTEN çalıştı: hepsi
 * TOTAL-PASSED dönüyordu. Testler o kapıların kapalı kaldığını doğrular.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const ssl = require('@fitfak/ssl');
const { DER } = require('@fitfak/pades/src/cades/asn1_der');
const { parseCertBasics, pemToDer } = require('@fitfak/pades/src/cades/x509_extract');
const { PAdESManager } = require('@fitfak/pades/src/utils/pades_manager');
const { verifyPdf, INDICATION } = require('@fitfak/verify');
const { buildTestPki } = require('./pki/ca');
const { makeSimplePdf } = require('./helpers/make-pdf');

/** Ağa hiç çıkmayan bir yönetici — TSA adresi kasten ulaşılamaz. */
const OFFLINE_TSA = 'http://127.0.0.1:1/none';

const OID = {
  signedData: '1.2.840.113549.1.7.2',
  data: '1.2.840.113549.1.7.1',
  sha256: '2.16.840.1.101.3.4.2.1',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  tstInfo: '1.2.840.113549.1.9.16.1.4'
};

let pki;
test.before(() => { pki = buildTestPki(); });

/** Test PKI'ıyla düzgün imzalanmış bir temel belge. */
async function signBaseline(opts = {}) {
  const pm = new PAdESManager({ tsaUrl: OFFLINE_TSA });
  return pm.sign({
    mode: 'B',
    pdfBuffer: makeSimplePdf(opts.pdf || { title: 'Odeme Emri', lines: ['Tutar: 1.000 TL'] }),
    keyPem: ssl.ecPrivToPem(pki.signer),
    certPem: pki.signer.certPem,
    chainPems: [pki.subCa.certPem, pki.root.certPem],
    visibleSignature: null
  });
}

/* ================================================================== */
/* 1. Güven çıpası — Subject DN çakışması                              */
/* ================================================================== */

test('sahte kök: kurbanın kökü ile aynı DN\'ye sahip kök güvenilir sayılmaz', async () => {
  const isim = {
    bits: 2048, commonName: 'FITFAK Test Root CA',
    organization: 'FITFAK Test', country: 'TR', validityDays: 3650
  };
  const sahteKok = ssl.generateRootCA(isim);
  const sahteImzaci = ssl.generateEcEndEntityCert(sahteKok, 'kurban.example', {
    curveName: 'P-256', validityDays: 365, commonName: 'Kurban Kurumu',
    keyUsage: ['digitalSignature', 'contentCommitment'], keyUsageCritical: true,
    eku: ['1.3.6.1.5.5.7.3.4']
  });

  const pm = new PAdESManager({ tsaUrl: OFFLINE_TSA });
  const signed = await pm.sign({
    mode: 'B',
    pdfBuffer: makeSimplePdf({ title: 'Sahte belge' }),
    keyPem: ssl.ecPrivToPem(sahteImzaci),
    certPem: sahteImzaci.certPem,
    chainPems: [sahteKok.certPem],
    visibleSignature: null
  });

  const report = await verifyPdf(signed.pdf, {
    trustAnchors: [pki.root.certPem], allowNetwork: false
  });
  const s = report.signatures[0];

  assert.notStrictEqual(s.indication, INDICATION.PASSED,
    'aynı DN\'li sahte kök güvenilir sayılmamalı');
  assert.strictEqual(s.chain.trusted, false);
});

/* ================================================================== */
/* 2. basicConstraints — son varlık sertifikası CA gibi kullanılamaz   */
/* ================================================================== */

test('EE-as-CA: CA olmayan sertifikayla üretilmiş alt sertifika reddedilir', async () => {
  // Saldırganın elindeki meşru ama CA OLMAYAN sertifika.
  const ee = pki.signer2;
  assert.strictEqual(
    require('@fitfak/pades/src/cades/x509_ext')
      .extractBasicConstraints(pemToDer(ee.certPem)).isCA,
    false, 'kurgu geçersiz: bu sertifika CA olmamalı');

  const sahte = ssl.generateEcEndEntityCert(ee, 'ceo.kurban.example', {
    curveName: 'P-256', validityDays: 365, commonName: 'Kurban A.S. Genel Mudur',
    keyUsage: ['digitalSignature', 'contentCommitment'], keyUsageCritical: true,
    eku: ['1.3.6.1.5.5.7.3.4']
  });

  const pm = new PAdESManager({ tsaUrl: OFFLINE_TSA });
  const signed = await pm.sign({
    mode: 'B',
    pdfBuffer: makeSimplePdf({ title: 'Sahte yetki belgesi' }),
    keyPem: ssl.ecPrivToPem(sahte),
    certPem: sahte.certPem,
    chainPems: [ee.certPem, pki.subCa.certPem, pki.root.certPem],
    visibleSignature: null
  });

  const report = await verifyPdf(signed.pdf, {
    trustAnchors: [pki.root.certPem], allowNetwork: false
  });
  const s = report.signatures[0];

  assert.strictEqual(s.indication, INDICATION.FAILED);
  assert.strictEqual(s.subIndication, 'CHAIN_CONSTRAINTS_FAILURE');
  assert.ok(s.errors.some((e) => /CA olmayan sertifika issuer/.test(e)),
    `beklenen hata yok: ${s.errors.join(' | ')}`);
});

/* ================================================================== */
/* 3. CMS zorunlu imzalı öznitelikleri                                 */
/* ================================================================== */

/** İmzalı öznitelikleri kasten bozuk bir CMS üretir. */
function craftCms(variant, certDer, keyPem, contentDigest, chainDer) {
  const { issuerFullDER, serialContent } = parseCertBasics(certDer);
  const sid = DER.seq(DER.any(issuerFullDER), DER.intFromBuf(serialContent));

  let signedAttrsForCms = Buffer.alloc(0);
  let toSign;

  if (variant === 'no-attrs') {
    toSign = contentDigest;                       // imza doğrudan ham özette
  } else {
    const ctOid = variant === 'bad-content-type' ? OID.tstInfo : OID.data;
    const setOfAttrs = DER.set(
      DER.seq(DER.oid(OID.contentType), DER.set(DER.oid(ctOid))),
      DER.seq(DER.oid(OID.messageDigest), DER.set(DER.octet(contentDigest)))
      // signing-certificate-v2 KASTEN yok
    );
    toSign = setOfAttrs;
    signedAttrsForCms = DER.retagImplicit(setOfAttrs, 0xA0);
  }

  const signer = crypto.createSign('sha256');
  signer.update(toSign);
  signer.end();

  const signerInfo = DER.seq(
    DER.intFromBuf(Buffer.from([0x01])), sid,
    DER.algo(OID.sha256, true),
    DER.any(signedAttrsForCms),
    DER.algo(OID.ecdsaSha256, true),
    DER.octet(signer.sign(keyPem))
  );

  const sd = DER.seq(
    DER.intFromBuf(Buffer.from([0x01])),
    DER.set(DER.algo(OID.sha256, true)),
    DER.seq(DER.oid(OID.data)),
    DER.retagImplicit(DER.set(...[certDer, ...chainDer].map((d) => DER.any(d))), 0xA0),
    DER.set(signerInfo)
  );
  return DER.seq(DER.oid(OID.signedData), DER.ctxExplicit(0, sd));
}

/** /Contents onaltılığını aynı uzunlukta koruyarak değiştirir. */
function swapContents(pdf, newCms) {
  const s = pdf.toString('latin1');
  const i = s.lastIndexOf('/Contents <');
  assert.ok(i >= 0, '/Contents bulunamadı');
  const start = i + '/Contents <'.length;
  const end = s.indexOf('>', start);
  const hex = newCms.toString('hex').toUpperCase();
  assert.ok(hex.length <= end - start, 'kurgulanan CMS boşluğa sığmıyor');
  const out = Buffer.from(pdf);
  out.write(hex + '0'.repeat(end - start - hex.length), start, 'latin1');
  return out;
}

function byteRangeDigest(pdf) {
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(pdf.toString('latin1'));
  const [, a, b, c, d] = m.map(Number);
  return crypto.createHash('sha256')
    .update(pdf.slice(a, a + b)).update(pdf.slice(c, c + d)).digest();
}

for (const variant of ['no-attrs', 'bad-content-type', 'no-signing-cert']) {
  test(`CMS öznitelikleri: "${variant}" TOTAL-PASSED dönmemeli`, async () => {
    const base = await signBaseline();
    const cms = craftCms(
      variant, pemToDer(pki.signer.certPem), ssl.ecPrivToPem(pki.signer),
      byteRangeDigest(base.pdf),
      [pemToDer(pki.subCa.certPem), pemToDer(pki.root.certPem)]
    );

    const report = await verifyPdf(swapContents(base.pdf, cms), {
      trustAnchors: [pki.root.certPem], allowNetwork: false
    });
    const s = report.signatures[0];

    // İmzanın kendisi kriptografik olarak geçerli — reddin sebebi bu değil.
    assert.strictEqual(s.cms.signatureValid, true,
      'kurgu geçersiz: imza zaten doğrulanmıyorsa test bir şey ölçmez');
    assert.strictEqual(s.indication, INDICATION.FAILED,
      `${variant} kabul edildi: ${JSON.stringify(s.cms)}`);
    assert.strictEqual(s.subIndication, 'SIG_CONSTRAINTS_FAILURE');
  });
}

/* ================================================================== */
/* 4. Fail-open: hata varsa gösterge PASSED olamaz                     */
/* ================================================================== */

test('nihai gösterge: errors[] doluyken imza TOTAL-PASSED olamaz', async () => {
  const base = await signBaseline();
  const report = await verifyPdf(base.pdf, {
    trustAnchors: [pki.root.certPem], allowNetwork: false
  });

  for (const s of report.signatures) {
    if (s.indication !== INDICATION.PASSED) continue;
    assert.strictEqual(s.errors.length, 0,
      `TOTAL-PASSED ama hata listesi dolu: ${s.errors.join(' | ')}`);
  }
});

/* ================================================================== */
/* 5. İmzadan sonra artımlı güncelleme ile içerik değiştirme           */
/* ================================================================== */

/** İmzalı PDF'e, sayfanın içerik akışını yeniden tanımlayan bir ek koyar. */
function appendEvilUpdate(pdf, { dssBait }) {
  const s = pdf.toString('latin1');
  const cm = /\/Type\s*\/Page\b[\s\S]{0,400}?\/Contents\s+(\d+)\s+0\s+R/.exec(s);
  assert.ok(cm, 'kurgu geçersiz: sayfa içerik akışı bulunamadı');
  const contentObj = Number(cm[1]);

  const trailer = s.slice(s.lastIndexOf('trailer'));
  const size = Number((/\/Size\s+(\d+)/.exec(trailer) || [])[1] || 32);
  const root = Number((/\/Root\s+(\d+)\s+0\s+R/.exec(trailer) || [])[1] || 1);
  const prev = Number((/startxref\s+(\d+)\s+%%EOF\s*$/.exec(s.trimEnd() + '\n') || [])[1] || 0);

  const evil = 'BT /F1 18 Tf 56 780 Td (ODEME EMRI: 10.000.000 TL) Tj ET\n';

  const parts = [];
  let off = pdf.length;
  const add = (t) => { parts.push(Buffer.from(t, 'latin1')); off += Buffer.byteLength(t, 'latin1'); };

  if (!s.endsWith('\n')) add('\n');
  const contentOffset = off;
  add(`${contentObj} 0 obj\n<< /Length ${Buffer.byteLength(evil, 'latin1')} >>\n` +
      `stream\n${evil}\nendstream\nendobj\n`);

  const xrefStart = off;
  add(`xref\n0 1\n0000000000 65535 f \n${contentObj} 1\n` +
      `${String(contentOffset).padStart(10, '0')} 00000 n \n`);
  // `/DSS` yemi: eski sezgisel kontrol tail'de bu dizgeyi arıyordu.
  add(`trailer\n<< /Size ${size} /Root ${root} 0 R /Prev ${prev}` +
      `${dssBait ? ' /DSS << /Certs [] >>' : ''} >>\n`);
  add(`startxref\n${xrefStart}\n%%EOF\n`);

  return Buffer.concat([pdf, ...parts]);
}

for (const dssBait of [false, true]) {
  const label = dssBait ? '/DSS yemiyle' : 'düz';
  test(`artımlı güncelleme (${label}): değiştirilmiş belge TOTAL-PASSED dönmez`, async () => {
    const base = await signBaseline();
    const report = await verifyPdf(appendEvilUpdate(base.pdf, { dssBait }), {
      trustAnchors: [pki.root.certPem], allowNetwork: false
    });
    const s = report.signatures[0];

    // İmzanın kendisi bozulmadı — reddin sebebi kriptografi değil.
    assert.strictEqual(s.cms.signatureValid, true);
    assert.strictEqual(s.cms.messageDigestMatches, true);

    assert.notStrictEqual(s.indication, INDICATION.PASSED,
      'sayfa içeriği değiştirilmiş belge geçerli sayılmamalı');
    assert.strictEqual(s.subIndication, 'DOC_MODIFIED_AFTER_SIGNING');
    assert.strictEqual(report.documentIntegrity.modifiedAfterSigning, true,
      `/DSS yemi bütünlük bayrağını söndürmemeli (yem: ${dssBait})`);
    assert.ok(s.coverage.changes.some((c) => /içerik akışı değiştirildi/.test(c)),
      `değişikliğin ne olduğu raporlanmalı: ${JSON.stringify(s.coverage.changes)}`);
  });
}

test('/ByteRange: dosyanın başını dışarıda bırakan imza reddedilir', async () => {
  const base = await signBaseline();
  const s = base.pdf.toString('latin1');
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)([^\]]*)\]/.exec(s);
  assert.ok(m, '/ByteRange bulunamadı');

  // s1'i 0'dan büyük yap: ilk baytlar imza kapsamı dışında kalır.
  // Dosya uzunluğu KORUNMALI, yoksa bütün ofsetler kayar ve test başka bir
  // şeyi ölçmeye başlar; kısa kalan yer boşlukla doldurulur.
  const [, , l1, s2, l2] = m;
  const govde = `/ByteRange [8 ${Number(l1) - 8} ${s2} ${l2}`;
  assert.ok(govde.length + 1 <= m[0].length, 'kurgu sığmıyor');
  const yeni = govde + ' '.repeat(m[0].length - govde.length - 1) + ']';

  const tampered = Buffer.from(base.pdf);
  tampered.write(yeni, m.index, 'latin1');

  const report = await verifyPdf(tampered, {
    trustAnchors: [pki.root.certPem], allowNetwork: false
  });
  const sig = report.signatures[0];

  assert.strictEqual(sig.indication, INDICATION.FAILED);
  assert.strictEqual(sig.subIndication, 'FORMAT_FAILURE');
  assert.ok(sig.errors.some((e) => /dosyanın başından başlamıyor/.test(e)),
    `beklenen hata yok: ${sig.errors.join(' | ')}`);
});

test('/ByteRange: boşluk /Contents\'ten genişse reddedilir', async () => {
  const base = await signBaseline();
  const s = base.pdf.toString('latin1');
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)([^\]]*)\]/.exec(s);
  const [, s1, l1, s2, l2] = m.map((v, i) => (i === 0 || i === 5 ? v : Number(v)));

  // l1'i kısaltıp l2'yi eşit uzat: boşluk /Contents'ten 16 bayt geniş olur
  // ama kapsanan toplam bayt sayısı değişmez.
  const yeni = `/ByteRange [${s1} ${l1 - 16} ${s2} ${l2}${m[5]}]`;
  if (yeni.length !== m[0].length) return;         // hizalama tutmadıysa atla

  const tampered = Buffer.from(base.pdf);
  tampered.write(yeni, m.index, 'latin1');

  const report = await verifyPdf(tampered, {
    trustAnchors: [pki.root.certPem], allowNetwork: false
  });
  const sig = report.signatures[0];

  assert.notStrictEqual(sig.indication, INDICATION.PASSED,
    '/Contents dışına taşan boşluk kabul edilmemeli');
});

test('temel akış: düzgün imza hâlâ TOTAL-PASSED dönüyor', async () => {
  const base = await signBaseline();
  const report = await verifyPdf(base.pdf, {
    trustAnchors: [pki.root.certPem], allowNetwork: false
  });
  const s = report.signatures[0];

  assert.strictEqual(s.indication, INDICATION.PASSED,
    `düzgün imza reddedildi: ${s.subIndication} — ${s.errors.join(' | ')}`);
  assert.strictEqual(s.chain.trusted, true);
  assert.strictEqual(s.cms.signedAttrsPresent, true);
  assert.strictEqual(s.cms.signingCertificateV2Matches, true);
});
