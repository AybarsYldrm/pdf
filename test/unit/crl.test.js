'use strict';
/**
 * RFC 5280 CRL doğrulaması.
 *
 * BİR CRL'İ OKUMAK YETMEZ; KAPSAMINI DA OKUMAK GEREKİR.
 *
 * "Yalnız CA sertifikalarını içeren" bir listeye bakıp bir son kullanıcı
 * sertifikasına "iptal edilmemiş" demek mümkündür: liste doğru, imza doğru,
 * tarih doğru — cevap yanlış. Bu yüzden IssuingDistributionPoint (§5.2.5)
 * okunur, tanınmayan kritik uzantılar CRL'i reddettirir (§6.3.3) ve
 * bölümlenmiş listelerden gelen "temiz" cevabı TAM saymayız.
 */

const test = require('node:test');
const assert = require('node:assert');

const ssl = require('@fitfak/ssl');
const {
  parseCrl, checkCrl, checkCrlWithDelta, decodeReasonFlags, KNOWN_CRL_EXTENSIONS
} = require('@fitfak/pades/src/cades/crl');
const ext = require('@fitfak/pades/src/cades/x509_ext');
const { buildTestPki } = require('../e2e/pki/ca');

const hasCode = (code) => (err) => err && err.code === code;

let pki;
const serialOf = (entity) => BigInt('0x' + ext.getSerial(entity.certDer).toString('hex'));

const toDer = (pem) => Buffer.from(
  pem.split('\n').filter((l) => l && !l.startsWith('-----')).join(''), 'base64');

/** Testte CRL üretmek için kısayol. */
const crl = (revoked, opts) => toDer(ssl.generateCRL(pki.subCa, revoked || [], opts || {}));

test.before(() => { pki = buildTestPki(); });

/* ================================================================== */
/* Temel doğrulama                                                     */
/* ================================================================== */

test('CRL: temiz listede sertifika "good" döner', () => {
  const res = checkCrl(pki.signer.certDer, pki.subCa.certDer, crl([], { crlNumber: 1 }));
  assert.strictEqual(res.status, 'good');
  assert.strictEqual(res.crlNumber, '1');
  assert.strictEqual(res.scope.complete, true);
});

test('CRL: iptal edilen sertifika sebebiyle birlikte bildirilir', () => {
  const res = checkCrl(pki.revoked.certDer, pki.subCa.certDer,
    crl([{ serial: serialOf(pki.revoked), reason: 1 }], { crlNumber: 2 }));

  assert.strictEqual(res.status, 'revoked');
  assert.strictEqual(res.reason, 'keyCompromise');
  assert.strictEqual(res.reasonCode, 1);
  assert.ok(res.revocationDate instanceof Date);
});

test('CRL: invalidityDate girdi uzantısı okunur', () => {
  const when = new Date('2026-01-15T10:00:00Z');
  const res = checkCrl(pki.revoked.certDer, pki.subCa.certDer,
    crl([{ serial: serialOf(pki.revoked), reason: 1, invalidityDate: when }], { crlNumber: 3 }));

  assert.strictEqual(res.status, 'revoked');
  assert.strictEqual(res.invalidityDate.toISOString(), when.toISOString());
});

test('CRL: imzası kurcalanmış liste reddedilir', () => {
  const der = crl([], { crlNumber: 4 });
  const tampered = Buffer.from(der);
  tampered[tampered.length - 10] ^= 0xff;

  assert.throws(() => checkCrl(pki.signer.certDer, pki.subCa.certDer, tampered),
    hasCode('ERR_CRL_BAD_SIGNATURE'));
});

test('CRL: BAŞKA bir CA nın listesi kabul edilmez', () => {
  const other = toDer(ssl.generateCRL(pki.subCaCrlOnly, [], { crlNumber: 5 }));
  assert.throws(() => checkCrl(pki.signer.certDer, pki.subCa.certDer, other),
    hasCode('ERR_CRL_ISSUER_MISMATCH'));
});

test('CRL: süresi geçmiş liste reddedilir', () => {
  const der = crl([], { crlNumber: 6, nextUpdateDays: -1 });
  assert.throws(
    () => checkCrl(pki.signer.certDer, pki.subCa.certDer, der, { toleranceMs: 0 }),
    hasCode('ERR_CRL_EXPIRED'));
});

test('CRL: gelecek tarihli liste reddedilir', () => {
  const future = new Date(Date.now() + 10 * 86400000);
  const der = crl([], { crlNumber: 7, thisUpdate: future, nextUpdate: new Date(future.getTime() + 86400000) });
  assert.throws(
    () => checkCrl(pki.signer.certDer, pki.subCa.certDer, der, { toleranceMs: 0 }),
    hasCode('ERR_CRL_NOT_YET_VALID'));
});

/* ================================================================== */
/* Tanınmayan kritik uzantı                                            */
/* ================================================================== */

test('CRL: TANINMAYAN KRİTİK uzantı listeyi kullanılamaz kılar', () => {
  // RFC 5280 §6.3.3 — anlayamadığımız kritik uzantı, kapsamı daraltıyor
  // olabilir. "Anlamadım ama devam edeyim", iptal edilmiş bir sertifikaya
  // "temiz" demenin yoludur.
  const der = crl([], { crlNumber: 8, unknownCriticalExtension: '1.2.3.4.5.6.7.8' });

  const parsed = parseCrl(der);
  assert.deepStrictEqual(parsed.unknownCritical, ['1.2.3.4.5.6.7.8']);

  assert.throws(() => checkCrl(pki.signer.certDer, pki.subCa.certDer, der),
    hasCode('ERR_CRL_UNKNOWN_CRITICAL_EXTENSION'));
});

test('CRL: tanıdığımız uzantılar listede', () => {
  for (const oid of ['2.5.29.20', '2.5.29.27', '2.5.29.28', '2.5.29.35', '2.5.29.46']) {
    assert.ok(KNOWN_CRL_EXTENSIONS.has(oid), oid);
  }
});

/* ================================================================== */
/* IssuingDistributionPoint — KAPSAM                                   */
/* ================================================================== */

test('IDP: "yalnız CA sertifikaları" listesi son kullanıcıyı kapsamaz', () => {
  const der = crl([], { crlNumber: 10, idp: { onlyCaCerts: true } });
  assert.strictEqual(parseCrl(der).idp.onlyCaCerts, true);

  assert.throws(() => checkCrl(pki.signer.certDer, pki.subCa.certDer, der),
    hasCode('ERR_CRL_OUT_OF_SCOPE'));
});

test('IDP: "yalnız son kullanıcı" listesi CA yı kapsamaz', () => {
  const der = crl([], { crlNumber: 11, idp: { onlyUserCerts: true } });

  // Ara CA'nın kendisi bu listede aranamaz
  assert.throws(
    () => checkCrl(pki.subCa.certDer, pki.root.certDer, toDer(
      ssl.generateCRL(pki.root, [], { crlNumber: 11, idp: { onlyUserCerts: true } }))),
    hasCode('ERR_CRL_OUT_OF_SCOPE'));

  // Son kullanıcı için AYNI kapsam sorunsuz
  assert.strictEqual(checkCrl(pki.signer.certDer, pki.subCa.certDer, der).status, 'good');
});

test('IDP: öznitelik sertifikası listesi hiçbir X.509 sertifikasını kapsamaz', () => {
  const der = crl([], { crlNumber: 12, idp: { onlyAttributeCerts: true } });
  assert.throws(() => checkCrl(pki.signer.certDer, pki.subCa.certDer, der),
    hasCode('ERR_CRL_OUT_OF_SCOPE'));
});

test('IDP: dağıtım noktası eşleşmiyorsa liste bu sertifikaya ait değildir', () => {
  const der = crl([], {
    crlNumber: 13,
    idp: { uris: ['http://baska.test/parca-9.crl'], onlyUserCerts: true }
  });

  assert.throws(
    () => checkCrl(pki.signer.certDer, pki.subCa.certDer, der, { checkDistributionPoint: true }),
    hasCode('ERR_CRL_OUT_OF_SCOPE'));

  // DSS'e gömülü CRL'ler başka bir adresten gelmiş olabilir; sınıf denetimi
  // sürer ama adres denetimi kapatılabilir.
  assert.strictEqual(
    checkCrl(pki.signer.certDer, pki.subCa.certDer, der, { checkDistributionPoint: false }).status,
    'good');
});

test('IDP: sertifikanın KENDİ dağıtım noktası eşleşiyorsa kabul edilir', () => {
  const cdp = ext.extractCDP(pki.signer.certDer).http;
  assert.ok(cdp.length, 'test sertifikasında CDP olmalı');

  const der = crl([], { crlNumber: 14, idp: { uris: cdp, onlyUserCerts: true } });
  assert.strictEqual(
    checkCrl(pki.signer.certDer, pki.subCa.certDer, der, { checkDistributionPoint: true }).status,
    'good');
});

/* ================================================================== */
/* Bölümlenmiş (partitioned) CRL                                       */
/* ================================================================== */

test('bölüm: onlySomeReasons taşıyan listeden "good" TAM cevap değildir', () => {
  const der = crl([], {
    crlNumber: 20,
    idp: { onlyUserCerts: true, onlySomeReasons: ['keyCompromise', 'cACompromise'] }
  });

  const parsed = parseCrl(der);
  assert.deepStrictEqual(parsed.idp.onlySomeReasons, ['keyCompromise', 'cACompromise']);

  const res = checkCrl(pki.signer.certDer, pki.subCa.certDer, der);
  assert.strictEqual(res.status, 'good');
  assert.strictEqual(res.scope.complete, false, 'kapsam eksik olarak işaretlenmeli');
  assert.deepStrictEqual(res.scope.coveredReasons, ['keyCompromise', 'cACompromise']);
});

test('bölüm: kapsadığı sebeple iptal edilmişse yine de "revoked"', () => {
  const der = crl([{ serial: serialOf(pki.revoked), reason: 1 }], {
    crlNumber: 21,
    idp: { onlyUserCerts: true, onlySomeReasons: ['keyCompromise'] }
  });

  const res = checkCrl(pki.revoked.certDer, pki.subCa.certDer, der);
  assert.strictEqual(res.status, 'revoked');
  assert.strictEqual(res.reason, 'keyCompromise');
});

test('bölüm: ReasonFlags kodlaması gidip gelir', () => {
  const cases = [
    ['keyCompromise'],
    ['keyCompromise', 'cACompromise'],
    ['superseded'],
    ['privilegeWithdrawn', 'aACompromise']
  ];
  for (const reasons of cases) {
    const der = crl([], { crlNumber: 22, idp: { onlySomeReasons: reasons } });
    assert.deepStrictEqual(parseCrl(der).idp.onlySomeReasons, reasons, reasons.join(','));
  }
});

test('bölüm: boş ReasonFlags çözümü boş dizi', () => {
  assert.deepStrictEqual(decodeReasonFlags(Buffer.alloc(0)), []);
});

/* ================================================================== */
/* Delta CRL                                                           */
/* ================================================================== */

test('delta: tek başına kullanılamaz', () => {
  const der = crl([], { crlNumber: 31, deltaBaseCrlNumber: 30 });
  assert.strictEqual(parseCrl(der).isDelta, true);

  assert.throws(() => checkCrl(pki.signer.certDer, pki.subCa.certDer, der),
    hasCode('ERR_CRL_DELTA_UNSUPPORTED'));
});

test('delta: tabandan SONRA gelen iptal uygulanır', () => {
  const base = crl([], { crlNumber: 30 });
  const delta = crl([{ serial: serialOf(pki.revoked), reason: 1 }],
    { crlNumber: 31, deltaBaseCrlNumber: 30 });

  // Yalnız tabana bakmak "temiz" der — eksik cevap
  assert.strictEqual(checkCrl(pki.revoked.certDer, pki.subCa.certDer, base).status, 'good');

  const combined = checkCrlWithDelta(pki.revoked.certDer, pki.subCa.certDer, base, delta);
  assert.strictEqual(combined.status, 'revoked');
  assert.strictEqual(combined.source, 'delta');
  assert.strictEqual(combined.reason, 'keyCompromise');
});

test('delta: removeFromCRL iptali GERİ ALIR', () => {
  // certificateHold kaldırıldığında delta, girdiyi reason=8 ile bildirir
  const base = crl([{ serial: serialOf(pki.revoked), reason: 6 }], { crlNumber: 40 });
  const delta = crl([{ serial: serialOf(pki.revoked), reason: 8 }],
    { crlNumber: 41, deltaBaseCrlNumber: 40 });

  assert.strictEqual(checkCrl(pki.revoked.certDer, pki.subCa.certDer, base).status, 'revoked');

  const combined = checkCrlWithDelta(pki.revoked.certDer, pki.subCa.certDer, base, delta);
  assert.strictEqual(combined.status, 'good');
  assert.strictEqual(combined.removedFromCrl, true);
});

test('delta: TAM listede removeFromCRL yok sayılmaz — çelişki sessizce geçilmez', () => {
  // Delta olmayan bir listede "kaldırıldı" demek anlamsızdır; bunu "temiz"
  // saymak, iptali silmenin kolay yolu olurdu.
  const full = crl([{ serial: serialOf(pki.revoked), reason: 8 }], { crlNumber: 42 });
  const res = checkCrl(pki.revoked.certDer, pki.subCa.certDer, full);
  assert.strictEqual(res.status, 'good');
  assert.notStrictEqual(res.removedFromCrl, true);
});

test('delta: İLGİSİZ bir tabana ait delta uygulanmaz', () => {
  const base = crl([], { crlNumber: 50 });
  // Delta, 60 numaralı (daha YENİ) bir tabana dayanıyor
  const delta = crl([{ serial: serialOf(pki.revoked), reason: 1 }],
    { crlNumber: 61, deltaBaseCrlNumber: 60 });

  assert.throws(
    () => checkCrlWithDelta(pki.revoked.certDer, pki.subCa.certDer, base, delta),
    hasCode('ERR_CRL_DELTA_MISMATCH'));
});

test('delta: delta olmayan bir liste delta diye verilemez', () => {
  const base = crl([], { crlNumber: 70 });
  const other = crl([], { crlNumber: 71 });
  assert.throws(() => checkCrlWithDelta(pki.signer.certDer, pki.subCa.certDer, base, other),
    hasCode('ERR_CRL_NOT_DELTA'));
});

test('delta: delta yoksa taban sonucu döner', () => {
  const base = crl([], { crlNumber: 80 });
  const res = checkCrlWithDelta(pki.signer.certDer, pki.subCa.certDer, base, null);
  assert.strictEqual(res.status, 'good');
});

/* ================================================================== */
/* freshestCRL                                                         */
/* ================================================================== */

test('freshestCRL: delta adresi okunur', () => {
  const der = crl([], {
    crlNumber: 90,
    freshestCrlUrls: ['http://ornek.test/delta.crl']
  });
  assert.deepStrictEqual(parseCrl(der).freshestCrl, ['http://ornek.test/delta.crl']);
});

/* ================================================================== */
/* Doğrulayıcıyla tümleşme                                             */
/* ================================================================== */

test('doğrulayıcı: kapsam dışı CRL, iptal kanıtı SAYILMAZ', async () => {
  const { startTestServices } = require('../e2e/pki/services');
  const { makeSimplePdf } = require('../e2e/helpers/make-pdf');
  const { PAdESManager } = require('@fitfak/pades/src/utils/pades_manager');
  const { PDFPAdESWriter, findAllSignatures } = require('@fitfak/pades/src/utils/pdf_parser');
  const { verifyPdf } = require('@fitfak/verify');

  const svc = await startTestServices();
  try {
    const manager = new PAdESManager({
      tsaUrl: svc.endpoints.tsa, tsaOptions: { hashName: 'sha256', certReq: true }
    });
    const p = svc.pki.profile('signer');
    const { pdf } = await manager.sign({
      mode: 'T', pdfBuffer: makeSimplePdf({ title: 'Kapsam disi CRL' }),
      keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems, fieldName: 'SCOPE'
    });

    // DSS'e YALNIZ CA sertifikalarını kapsayan bir CRL koyuyoruz. Liste
    // gerçek, imzası doğru — ama bu sertifika hakkında konuşmuyor.
    const outOfScope = toDer(ssl.generateCRL(svc.pki.subCa, [], {
      crlNumber: 100, idp: { onlyCaCerts: true }
    }));

    const sigs = findAllSignatures(pdf);
    const writer = new PDFPAdESWriter(pdf);
    writer.addDSS({
      vri: [{
        hashes: sigs[0].vriKeys,
        certsDer: [svc.pki.signer.certDer, svc.pki.subCa.certDer, svc.pki.root.certDer],
        ocspsDer: [], crlsDer: [outOfScope], validationTime: new Date()
      }]
    });

    const r = await verifyPdf(writer.toBuffer(), {
      trustAnchors: [svc.pki.root.certPem], allowNetwork: false
    });
    const s = r.signatures[0];

    assert.notStrictEqual(s.achievedLevel, 'B-LT',
      'kapsam dışı CRL B-LT kazandırmamalı');

    const signerEntry = s.revocation.find((x) => /signer/.test(x.subject || ''));
    assert.ok(signerEntry);
    assert.notStrictEqual(signerEntry.status, 'good');
    assert.ok(signerEntry.error, 'gerekçe raporlanmalı');
  } finally {
    await svc.close();
  }
});
