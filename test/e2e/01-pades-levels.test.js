'use strict';
/**
 * Uçtan uca PAdES seviye testleri — tamamen çevrimdışı.
 *
 * Yerel CA + OCSP responder + CRL dağıtım noktası + RFC 3161 TSA ayağa kaldırılır;
 * sertifikalara gerçek AIA/CDP uzantıları gömülüdür. Böylece hem imzalama hem de
 * otomatik keşif kodu ağ olmadan, tekrarlanabilir biçimde sınanır.
 */

const test = require('node:test');
const assert = require('node:assert');

const { startTestServices } = require('./pki/services');
const { makeSimplePdf } = require('./helpers/make-pdf');
const { PAdESManager } = require('@fitfak/pades/src/utils/pades_manager');
const { findAllSignatures, readLastTrailer, readObject } = require('@fitfak/pades/src/utils/pdf_parser');
const ext = require('@fitfak/pades/src/cades/x509_ext');

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

test.after(async () => {
  if (svc) await svc.close();
});

/** DSS sözlüğünü ve içindeki dizileri okur. */
function readDss(pdf) {
  const trailer = readLastTrailer(pdf);
  const root = readObject(pdf, trailer.rootObjNum);
  assert.ok(root && root.dictStr, 'Root nesnesi okunamadı');
  const m = /\/DSS\s+(\d+)\s+0\s+R/.exec(root.dictStr);
  if (!m) return null;
  const dss = readObject(pdf, parseInt(m[1], 10));
  assert.ok(dss && dss.dictStr, 'DSS nesnesi okunamadı');

  const countRefs = (key) => {
    const mm = new RegExp('\\/' + key + '\\s*\\[([^\\]]*)\\]').exec(dss.dictStr);
    if (!mm) return 0;
    return (mm[1].match(/\d+\s+0\s+R/g) || []).length;
  };
  const vriMatch = /\/VRI\s*<<([\s\S]*?)>>/.exec(dss.dictStr);
  const vriKeys = vriMatch ? (vriMatch[1].match(/\/([0-9A-F]{40})/g) || []).map((s) => s.slice(1)) : [];

  return {
    dictStr: dss.dictStr,
    certs: countRefs('Certs'),
    crls: countRefs('CRLs'),
    ocsps: countRefs('OCSPs'),
    vriKeys
  };
}

test('B seviyesi: zaman damgasız imza üretilir ve doğrulanabilir yapıdadır', async () => {
  const p = svc.pki.profile('signer');
  const res = await manager.sign({
    mode: 'B',
    pdfBuffer: makeSimplePdf({ title: 'B seviyesi' }),
    keyPem: p.keyPem,
    certPem: p.certPem,
    chainPems: p.chainPems,
    fieldName: 'Sig_B'
  });

  assert.strictEqual(res.achievedLevel, 'pades-b');
  const sigs = findAllSignatures(res.pdf);
  assert.strictEqual(sigs.length, 1, 'tam olarak bir imza olmalı');
  assert.strictEqual(sigs[0].subFilter, 'ETSI.CAdES.detached');
  assert.strictEqual(readDss(res.pdf), null, 'B seviyesinde DSS olmamalı');
});

test('T seviyesi: RFC 3161 imza zaman damgası eklenir', async () => {
  const p = svc.pki.profile('signer');
  const before = svc.tsaCounter();
  const res = await manager.sign({
    mode: 'T',
    pdfBuffer: makeSimplePdf({ title: 'T seviyesi' }),
    keyPem: p.keyPem,
    certPem: p.certPem,
    chainPems: p.chainPems,
    fieldName: 'Sig_T'
  });

  assert.strictEqual(res.achievedLevel, 'pades-t');
  assert.ok(svc.tsaCounter() > before, 'TSA çağrılmış olmalı');
  const sigs = findAllSignatures(res.pdf);
  assert.strictEqual(sigs.length, 1);
  // TSA sertifikası CMS içine gömülmüş olmalı (certReq: true)
  const certs = ext.collectCertificates(sigs[0].cmsDer);
  assert.ok(certs.length >= 3, `CMS içinde en az 3 sertifika beklenir, ${certs.length} bulundu`);
});

test('LT seviyesi: OCSP ve CRL kanıtları DSS içine gömülür', async () => {
  const p = svc.pki.profile('signer');
  const res = await manager.sign({
    mode: 'LT',
    pdfBuffer: makeSimplePdf({ title: 'LT seviyesi' }),
    keyPem: p.keyPem,
    certPem: p.certPem,
    chainPems: p.chainPems,
    fieldName: 'Sig_LT',
    ltv: { prefer: 'both' }   // hem OCSP hem CRL toplansın
  });

  assert.strictEqual(res.achievedLevel, 'pades-lt');

  const dss = readDss(res.pdf);
  assert.ok(dss, 'DSS eklenmiş olmalı');
  assert.ok(dss.certs > 0, 'DSS sertifika içermeli');
  assert.ok(dss.ocsps > 0, `DSS OCSP yanıtı içermeli (bulunan: ${dss.ocsps})`);

  // ── Bu, kapatılan asıl boşluk: CRL'ler artık gerçekten gömülüyor ──
  assert.ok(dss.crls > 0, `DSS CRL içermeli (bulunan: ${dss.crls})`);

  assert.ok(dss.vriKeys.length > 0, 'VRI girdisi olmalı');
  const sigs = findAllSignatures(res.pdf);
  for (const key of sigs[0].vriKeys) {
    assert.ok(dss.vriKeys.includes(key), `imzanın VRI anahtarı DSS'te bulunmalı: ${key}`);
  }
});

test('LT seviyesi: yalnız CRL yayınlayan CA ile de LT elde edilir', async () => {
  const p = svc.pki.profile('crlOnly');
  const certDer = ext.pemToDer(p.certPem);
  assert.strictEqual(ext.extractAIA(certDer).ocsp.length, 0,
    'bu profilin OCSP adresi OLMAMALI (senaryonun anlamı bu)');
  assert.ok(ext.extractCDP(certDer).http.length > 0, 'CDP adresi olmalı');

  const res = await manager.sign({
    mode: 'LT',
    pdfBuffer: makeSimplePdf({ title: 'Yalniz CRL' }),
    keyPem: p.keyPem,
    certPem: p.certPem,
    chainPems: p.chainPems,
    fieldName: 'Sig_CRLOnly'
  });

  assert.strictEqual(res.achievedLevel, 'pades-lt',
    'OCSP olmadan da LT üretilebilmeli');
  const dss = readDss(res.pdf);
  assert.ok(dss.crls > 0, 'CRL gömülmüş olmalı');
});

test('LTA seviyesi: arşiv damgası + damganın kendi doğrulama verisi eklenir', async () => {
  const p = svc.pki.profile('signer');
  const res = await manager.sign({
    mode: 'LTA',
    pdfBuffer: makeSimplePdf({ title: 'LTA seviyesi' }),
    keyPem: p.keyPem,
    certPem: p.certPem,
    chainPems: p.chainPems,
    fieldName: 'Sig_LTA',
    ltv: { prefer: 'both' }
  });

  assert.strictEqual(res.achievedLevel, 'pades-lta');

  const sigs = findAllSignatures(res.pdf);
  const docTs = sigs.filter((s) => s.type === 'DocTimeStamp');
  assert.strictEqual(docTs.length, 1, 'bir belge zaman damgası olmalı');
  assert.strictEqual(docTs[0].subFilter, 'ETSI.RFC3161');

  // ISO 32000-2 §12.8.5 — /Type /DocTimeStamp olmalı (/Sig değil)
  assert.ok(res.pdf.toString('latin1').includes('/Type /DocTimeStamp'),
    'belge zaman damgası sözlüğü /Type /DocTimeStamp taşımalı');

  const dss = readDss(res.pdf);
  // Hem imzanın hem de arşiv damgasının VRI girdisi bulunmalı
  const allKeys = new Set(dss.vriKeys);
  for (const s of sigs) {
    const has = s.vriKeys.some((k) => allKeys.has(k));
    assert.ok(has, `${s.type} için VRI girdisi bulunmalı`);
  }
  assert.ok(dss.crls > 0 || dss.ocsps > 0, 'arşiv turunda da iptal verisi olmalı');
});

test('Çoklu imza: her imza için ayrı VRI girdisi üretilir', async () => {
  const p1 = svc.pki.profile('signer');
  const p2 = svc.pki.profile('signer2');

  const first = await manager.sign({
    mode: 'LT',
    pdfBuffer: makeSimplePdf({ title: 'Coklu imza' }),
    keyPem: p1.keyPem, certPem: p1.certPem, chainPems: p1.chainPems,
    fieldName: 'Sig_Multi_1'
  });
  assert.strictEqual(first.achievedLevel, 'pades-lt');

  const second = await manager.sign({
    mode: 'LT',
    pdfBuffer: first.pdf,
    keyPem: p2.keyPem, certPem: p2.certPem, chainPems: p2.chainPems,
    fieldName: 'Sig_Multi_2'
  });
  assert.strictEqual(second.achievedLevel, 'pades-lt');

  const sigs = findAllSignatures(second.pdf);
  assert.strictEqual(sigs.length, 2, 'iki imza bulunmalı');

  const dss = readDss(second.pdf);
  const keys = new Set(dss.vriKeys);
  for (const s of sigs) {
    assert.ok(s.vriKeys.some((k) => keys.has(k)),
      'her imzanın VRI girdisi DSS içinde olmalı');
  }
  // İki imzanın VRI anahtarları farklı olmalı
  assert.notDeepStrictEqual(sigs[0].vriKeys, sigs[1].vriKeys);
});

test('İptal edilmiş sertifika: strict modda LT reddedilir', async () => {
  const p = svc.pki.profile('revoked');
  svc.revoke(ext.getSerial(ext.pemToDer(p.certPem)).toString('hex'), 1);

  await assert.rejects(
    () => manager.sign({
      mode: 'LT',
      pdfBuffer: makeSimplePdf({ title: 'Iptal' }),
      keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems,
      fieldName: 'Sig_Revoked',
      strict: true,
      ltv: { strict: true }
    }),
    /İptal edilmiş sertifika/,
    'iptal edilmiş sertifika strict modda hata vermeli'
  );
});

test('İptal edilmiş sertifika: gevşek modda uyarı ile devam edilir', async () => {
  const p = svc.pki.profile('revoked');
  svc.revoke(ext.getSerial(ext.pemToDer(p.certPem)).toString('hex'), 1);

  const res = await manager.sign({
    mode: 'LT',
    pdfBuffer: makeSimplePdf({ title: 'Iptal gevsek' }),
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems,
    fieldName: 'Sig_Revoked_Soft'
  });

  assert.ok(res.reasons.some((r) => /İptal edilmiş/.test(r)),
    'rapor iptal durumunu bildirmeli — sessizce geçilmemeli');
});

test('Seviye düşüşü sessiz olmaz: TSA erişilemezse rapor edilir', async () => {
  const badManager = new PAdESManager({
    tsaUrl: 'http://127.0.0.1:1/tsa',   // kapalı port
    tsaOptions: { hashName: 'sha256', certReq: true },
    allowPrivateNetwork: true
  });
  const p = svc.pki.profile('signer');

  const res = await badManager.sign({
    mode: 'LT',
    pdfBuffer: makeSimplePdf({ title: 'TSA yok' }),
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems,
    fieldName: 'Sig_NoTsa'
  });

  assert.strictEqual(res.requestedLevel, 'LT');
  assert.strictEqual(res.achievedLevel, 'pades-b');
  assert.ok(res.reasons.length > 0, 'düşüşün sebebi raporlanmalı');
  assert.ok(/[Zz]aman damgası/.test(res.reasons.join(' ')));
});

test('İmzalama önceki imzayı bozmaz: ilk imzanın ByteRange kapsamı korunur', async () => {
  const p1 = svc.pki.profile('signer');
  const p2 = svc.pki.profile('signer2');

  const first = await manager.sign({
    mode: 'T',
    pdfBuffer: makeSimplePdf({ title: 'Artimli guncelleme' }),
    keyPem: p1.keyPem, certPem: p1.certPem, chainPems: p1.chainPems,
    fieldName: 'Sig_Inc_1'
  });
  const firstSigs = findAllSignatures(first.pdf);
  const firstRange = firstSigs[0].byteRange;
  const firstBytes = first.pdf.slice(0, firstRange[1]);

  const second = await manager.sign({
    mode: 'T',
    pdfBuffer: first.pdf,
    keyPem: p2.keyPem, certPem: p2.certPem, chainPems: p2.chainPems,
    fieldName: 'Sig_Inc_2'
  });

  // İlk imzanın kapsadığı baytlar değişmemiş olmalı (artımlı güncelleme kuralı)
  assert.ok(second.pdf.slice(0, firstRange[1]).equals(firstBytes),
    'ikinci imza, ilk imzanın kapsadığı baytları değiştirmemeli');
  assert.ok(second.pdf.length > first.pdf.length,
    'ikinci imza artımlı olarak eklenmiş olmalı');
});
