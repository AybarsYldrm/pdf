'use strict';
/**
 * Güvenlik regresyon testleri — AĞ/PKİ gerektirenler.
 *
 * Ağ gerektirmeyen kardeşi `test/unit/security.test.js` içindedir (dosya
 * yolu kum havuzu, PKCS#12 kaynak sınırları, sunucu politikası).
 *
 * Buradaki her test bir SALDIRIYI canlandırır ve savunmanın çalıştığını
 * gösterir. Testin adı saldırıyı, gövdesi ise saldırganın gerçekte ne
 * yapabileceğini anlatır. "Şu fonksiyon true dönüyor" testi değildir:
 * sahte OCSP yanıtları gerçekten üretilir, sahte zaman damgası gerçekten
 * imzalanır, DSS gerçekten zehirlenir.
 *
 * Kapsam:
 *   A. OCSP (RFC 6960) — yanlış sertifika, yanlış ihraç eden, bozuk imza,
 *      yetkisiz yanıtlayan, süresi geçmiş/gelecek tarihli yanıt
 *   B. DSS/LTV zehirlenmesi — sahte kanıt seviye yükseltmez
 *   C. RFC 3161 — timeStamping EKU'su olmayan TSA reddedilir
 *   D. HTTP sertleştirme — gövde sınırı, içerik türü, hız sınırı, kimlik
 *   E. Tarayıcı sunucusu — gövde sınırı, içerik türü, girdi doğrulama
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');

const ssl = require('@fitfak/ssl');
const ext = require('@fitfak/pades/src/cades/x509_ext');
const { DER } = require('@fitfak/pades/src/cades/asn1_der');
const { PAdESManager } = require('@fitfak/pades/src/utils/pades_manager');
const { PDFPAdESWriter, findAllSignatures } = require('@fitfak/pades/src/utils/pdf_parser');
const { verifyPdf, INDICATION } = require('@fitfak/verify');
const ocspLib = require('@fitfak/verify/src/ocsp');

const { startTestServices } = require('./pki/services');
const { makeSimplePdf } = require('./helpers/make-pdf');
const { forgeTimestampToken } = require('./helpers/rogue-tsa');

let svc;      // çevrimdışı PKI + OCSP/CRL/TSA servisleri
let pki;
let api;      // { base, server, mod } — apps/server
let scanner;  // { base, server, mod } — apps/scanner

// Tek bir kurulum kancası: node:test birden çok `before` kancasının
// sırasını garanti etmez, sıralı bağımlılıklar bu yüzden tek yerde kurulur.
test.before(async () => {
  svc = await startTestServices();
  pki = svc.pki;

  const serverMod = require('../../apps/server/server');
  serverMod.CONFIG.tsaUrl = svc.endpoints.tsa;
  const server = serverMod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  api = { mod: serverMod, server, base: `http://127.0.0.1:${server.address().port}` };

  const scannerMod = require('../../apps/scanner/server');
  const scannerServer = scannerMod.createServer();
  await new Promise((r) => scannerServer.listen(0, '127.0.0.1', r));
  scanner = {
    mod: scannerMod, server: scannerServer,
    base: `http://127.0.0.1:${scannerServer.address().port}`
  };
});

test.after(async () => {
  if (api) await new Promise((r) => api.server.close(r));
  if (scanner) await new Promise((r) => scanner.server.close(r));
  if (svc) await svc.close();
});

// Hız sınırlayıcı gerçek bir savunmadır ve test paketi tek istemciden çok
// istek atar; kendi testi dışında yolumuza çıkmaması için sıfırlanır.
test.beforeEach(() => { if (api) api.mod.rateLimiter.reset(); });

/* ================================================================== */
/* A. OCSP — RFC 6960                                                  */
/* ================================================================== */

const serialOf = (entity) => BigInt('0x' + ext.getSerial(entity.certDer).toString('hex'));
const statusMap = (serial, entry) => new Map([[serial.toString(16), entry]]);

/**
 * İstenen CA/yanıtlayan/durum ile GERÇEK, imzalı bir OCSP yanıtı üretir.
 * Saldırgan da tam olarak bunu yapabilir: elindeki herhangi bir anahtarla
 * yapısal olarak kusursuz bir yanıt imzalayabilir.
 */
function makeOcsp(issuerCA, responder, serials, map, opts = {}) {
  const { der } = ssl.buildOcspRequest(issuerCA, serials, { hashAlg: opts.hashAlg || 'sha256' });
  const request = ssl.parseOcspRequest(der);
  return ssl.generateOcspResponse(
    request, issuerCA, responder, responder.certDer, map, opts);
}

const checkOcsp = (der, cert, issuer, opts) =>
  ocspLib.verifyOcspResponse(der, cert.certDer, issuer.certDer, opts);

test('OCSP: meşru "good" yanıtı kabul edilir (olumlu kontrol)', () => {
  const s = serialOf(pki.signer);
  const r = checkOcsp(makeOcsp(pki.subCa, pki.subCa, [s], statusMap(s, { status: 'good' })),
    pki.signer, pki.subCa);

  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.status, 'good');
  assert.strictEqual(r.signatureValid, true);
  assert.strictEqual(r.responderAuthorized, true);
  assert.strictEqual(r.timeValid, true);
  assert.deepStrictEqual(r.errors, []);
});

test('OCSP: "revoked" yanıtı iptali bildirir', () => {
  const s = serialOf(pki.revoked);
  const r = checkOcsp(
    makeOcsp(pki.subCa, pki.subCa, [s], statusMap(s, { status: 'revoked', reason: 1 })),
    pki.revoked, pki.subCa);

  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.status, 'revoked');
  assert.strictEqual(r.signatureValid, true);
  assert.ok(r.revocationTime instanceof Date);
});

test('OCSP: BAŞKA sertifika için üretilmiş yanıt eşleşmez', () => {
  // Saldırı: kendi sertifikası iptal edilmiş bir imzacı, iptal edilmemiş
  // BAŞKA bir sertifika için alınmış geçerli bir "good" yanıtını sunar.
  // Yanıt gerçekten CA tarafından imzalanmıştır — tek kusuru başka bir
  // sertifikaya ait olmasıdır. `der.includes(serial)` bunu yakalayamaz.
  const other = serialOf(pki.signer2);
  const forged = makeOcsp(pki.subCa, pki.subCa, [other], statusMap(other, { status: 'good' }));

  const r = checkOcsp(forged, pki.signer, pki.subCa);
  assert.strictEqual(r.matched, false, 'yanlış sertifikanın yanıtı eşleşmemeli');
  assert.strictEqual(r.status, null);
  assert.ok(r.errors.some((e) => /CertID/.test(e)));
});

test('OCSP: seri numarası aynı, İHRAÇ EDEN farklı → eşleşmez', () => {
  // CertID yalnız seri numarasından ibaret değildir: issuerNameHash ve
  // issuerKeyHash de eşleşmelidir. Aksi hâlde başka bir CA'nın aynı seri
  // numarasını taşıyan sertifikası için alınmış yanıt kabul edilirdi.
  const s = serialOf(pki.signer);
  const forged = makeOcsp(pki.subCaCrlOnly, pki.subCaCrlOnly, [s],
    statusMap(s, { status: 'good' }));

  const r = checkOcsp(forged, pki.signer, pki.subCa);
  assert.strictEqual(r.matched, false);
});

test('OCSP: imzası kurcalanmış yanıt reddedilir', () => {
  const s = serialOf(pki.signer);
  const good = makeOcsp(pki.subCa, pki.subCa, [s], statusMap(s, { status: 'good' }));

  // İmza değerinin TAM yerini bulup tek bir baytı çeviriyoruz: yapı bozulmaz,
  // CertID eşleşmeye devam eder, yalnız imza tutmaz.
  const parsed = ocspLib.parseOcspResponse(good);
  const at = good.indexOf(parsed.signature);
  assert.ok(at > 0, 'imza değeri yanıt içinde bulunmalı');
  const tampered = Buffer.from(good);
  tampered[at + 6] ^= 0xff;

  const r = checkOcsp(tampered, pki.signer, pki.subCa);
  assert.strictEqual(r.matched, true, 'CertID hâlâ eşleşir — sorun imzadadır');
  assert.strictEqual(r.signatureValid, false);
  assert.ok(r.errors.some((e) => /imza/i.test(e)));
});

test('OCSP: içeriği kurcalanmış yanıt (tbs) reddedilir', () => {
  const s = serialOf(pki.signer);
  const good = makeOcsp(pki.subCa, pki.subCa, [s], statusMap(s, { status: 'good' }));
  const parsed = ocspLib.parseOcspResponse(good);

  // producedAt içindeki bir rakamı değiştiriyoruz: DER geçerli kalır,
  // ama imza artık bu içeriği kapsamaz.
  let rel = -1;
  for (let i = 0; i < parsed.tbs.length - 1; i++) {
    if (parsed.tbs[i] === 0x18 && parsed.tbs[i + 1] === 15) { rel = i; break; }
  }
  assert.ok(rel > 0, 'producedAt GeneralizedTime bulunmalı');
  const abs = good.indexOf(parsed.tbs) + rel + 2 + 3;
  const tampered = Buffer.from(good);
  tampered[abs] = tampered[abs] === 0x39 ? 0x38 : tampered[abs] + 1;

  const r = checkOcsp(tampered, pki.signer, pki.subCa);
  assert.strictEqual(r.signatureValid, false);
});

test('OCSP: YETKİSİZ yanıtlayan (OCSPSigning EKU yok) reddedilir', () => {
  // Saldırgan, aynı CA'dan alınmış SIRADAN bir son kullanıcı sertifikasıyla
  // yanıt imzalıyor. İmza matematiksel olarak geçerli, zincir de sağlam —
  // ama RFC 6960 §4.2.2.2 böyle bir yanıtlayanı yetkili saymaz.
  const s = serialOf(pki.signer);
  const forged = makeOcsp(pki.subCa, pki.signer2, [s], statusMap(s, { status: 'good' }));

  const r = checkOcsp(forged, pki.signer, pki.subCa);
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.signatureValid, true, 'imza gerçekten geçerli — tehlike de bu');
  assert.strictEqual(r.responderAuthorized, false);
  assert.ok(r.errors.some((e) => /OCSPSigning|yetkili/i.test(e)));
});

test('OCSP: yetkili DELEGE yanıtlayan (OCSPSigning EKU var) kabul edilir', () => {
  const s = serialOf(pki.signer);
  const r = checkOcsp(
    makeOcsp(pki.subCa, pki.ocspResponder, [s], statusMap(s, { status: 'good' })),
    pki.signer, pki.subCa);

  assert.strictEqual(r.responderAuthorized, true);
  assert.strictEqual(r.signatureValid, true);
  assert.strictEqual(r.status, 'good');
});

test('OCSP: süresi geçmiş yanıt (nextUpdate geçmişte) zaman geçerliliğini kaybeder', () => {
  const s = serialOf(pki.signer);
  const r = checkOcsp(
    makeOcsp(pki.subCa, pki.subCa, [s], statusMap(s, { status: 'good' }), { nextUpdateDays: -1 }),
    pki.signer, pki.subCa);

  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.timeValid, false);
  assert.ok(r.errors.some((e) => /süre/i.test(e)));
});

test('OCSP: gelecek tarihli yanıt (thisUpdate ileride) reddedilir', () => {
  const s = serialOf(pki.signer);
  const der = makeOcsp(pki.subCa, pki.subCa, [s], statusMap(s, { status: 'good' }));

  // Doğrulama zamanını üç gün geriye alıyoruz: yanıt "henüz üretilmemiş".
  const r = checkOcsp(der, pki.signer, pki.subCa, { at: new Date(Date.now() - 3 * 86400000) });
  assert.strictEqual(r.timeValid, false);
  assert.ok(r.errors.some((e) => /gelecek/i.test(e)));
});

test('OCSP: bilinmeyen seri "unknown" döner, "good" DEĞİL', () => {
  // Uydurma seri numarası taşıyan bir sertifika, kendi CA'sından olumlu
  // cevap alamamalıdır (RFC 6960 §2.2).
  const s = serialOf(pki.signer);
  const r = checkOcsp(makeOcsp(pki.subCa, pki.subCa, [s], new Map()), pki.signer, pki.subCa);
  assert.strictEqual(r.status, 'unknown');
});

test('OCSP: seri numarasını İÇEREN çöp veri kabul edilmez', () => {
  // Eski sezgisel yöntem (`der.includes(serial)`) tam olarak bunu geçirirdi.
  const junk = Buffer.concat([
    Buffer.from('OCSP RESPONSE GOOD ', 'ascii'),
    ext.getSerial(pki.signer.certDer),
    Buffer.alloc(64, 0x41)
  ]);
  const r = checkOcsp(junk, pki.signer, pki.subCa);
  assert.strictEqual(r.matched, false);
  assert.strictEqual(r.status, null);
  assert.ok(r.errors.some((e) => /ayrıştırılamadı/i.test(e)));
});

test('OCSP: hata durumlu yanıt (tryLater) "good" sayılmaz', () => {
  const der = ssl.buildOcspErrorResponse
    ? ssl.buildOcspErrorResponse('tryLater')
    : DER.seq(DER.tag(0x0a, Buffer.from([3])));
  const r = checkOcsp(der, pki.signer, pki.subCa);
  assert.strictEqual(r.matched, false);
  assert.strictEqual(r.status, null);
});

/* ================================================================== */
/* B. DSS / LTV zehirlenmesi                                           */
/* ================================================================== */

test('DSS: sahte OCSP kanıtı gömülü belge B-LT seviyesine YÜKSELMEZ', async () => {
  // Saldırı senaryosu: elinde B-T seviyesinde bir belge olan biri, DSS'e
  // BAŞKA bir sertifika için alınmış geçerli imzalı bir "good" OCSP yanıtı
  // koyar ve belgeyi "uzun vadeli doğrulanabilir" diye sunar.
  const manager = new PAdESManager({
    tsaUrl: svc.endpoints.tsa, tsaOptions: { hashName: 'sha256', certReq: true },
    allowPrivateNetwork: true
  });
  const p = pki.profile('signer');
  const { pdf } = await manager.sign({
    mode: 'T', pdfBuffer: makeSimplePdf({ title: 'DSS zehirleme' }),
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems, fieldName: 'DSS_POISON'
  });

  const other = serialOf(pki.signer2);
  const forged = makeOcsp(pki.subCa, pki.subCa, [other], statusMap(other, { status: 'good' }));

  const sigs = findAllSignatures(pdf);
  const writer = new PDFPAdESWriter(pdf);
  writer.addDSS({
    vri: [{
      hashes: sigs[0].vriKeys,
      certsDer: [pki.signer.certDer, pki.subCa.certDer, pki.root.certDer],
      ocspsDer: [forged], crlsDer: [], validationTime: new Date()
    }]
  });
  const poisoned = writer.toBuffer();

  const r = await verifyPdf(poisoned, { trustAnchors: [pki.root.certPem], allowNetwork: false });
  const s = r.signatures[0];

  assert.strictEqual(r.ltv.dssPresent, true, 'DSS gerçekten gömülü');
  assert.notStrictEqual(s.achievedLevel, 'B-LT',
    'sahte kanıt B-LT seviyesi kazandırmamalı');
  assert.strictEqual(s.achievedLevel, 'B-T');
  for (const rev of s.revocation) {
    assert.notStrictEqual(rev.status, 'good',
      `${rev.subject}: sahte kanıt "good" saydırmamalı`);
  }
});

test('DSS: MEŞRU kanıtla imzalanan belge B-LT olur (olumlu kontrol)', async () => {
  const manager = new PAdESManager({
    tsaUrl: svc.endpoints.tsa, tsaOptions: { hashName: 'sha256', certReq: true },
    allowPrivateNetwork: true
  });
  const p = pki.profile('signer');
  const { pdf } = await manager.sign({
    mode: 'LT', pdfBuffer: makeSimplePdf({ title: 'Mesru LT' }),
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems,
    fieldName: 'DSS_OK', ltv: { prefer: 'both' }
  });

  const r = await verifyPdf(pdf, { trustAnchors: [pki.root.certPem], allowNetwork: false });
  assert.strictEqual(r.signatures[0].achievedLevel, 'B-LT');
});

/* ================================================================== */
/* C. RFC 3161 — TSA yetkisi                                           */
/* ================================================================== */

/** Kural tanımayan bir TSA'yı taklit eden HTTP sunucusu. */
async function startRogueTsa(certDer, keyPem, chainDer) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body;
      try {
        const tsq = ssl.parseTimeStampReq(Buffer.concat(chunks));
        const token = forgeTimestampToken({
          imprint: tsq.hashedMessage, certDer, keyPem, chainDer
        });
        body = DER.seq(DER.seq(DER.intFromBuf(Buffer.from([0]))), token);
      } catch (err) {
        res.writeHead(500).end(err.message);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/timestamp-reply', 'Content-Length': body.length
      });
      res.end(body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/tsa` };
}

test('TSA: kendi sunucumuz timeStamping EKU olmayan sertifikayla ÇALIŞMAYI reddeder', () => {
  // Savunmanın ilk katmanı: yanlış yapılandırılmış bir TSA hiç ayağa kalkmasın.
  assert.throws(
    () => ssl.createTimestampResponder({
      keyPem: ssl.ecPrivToPem(pki.signer2),
      certChainPem: [pki.signer2.certPem, pki.subCa.certPem].join('\n'),
      policyOid: '1.3.6.1.4.1.65133.1.4'
    }),
    /timeStamping|1\.3\.6\.1\.5\.5\.7\.3\.8/
  );
});

test('TSA: EKU\'suz sertifikayla üretilmiş imza damgası GEÇERSİZ sayılır', async () => {
  // İkinci katman: dışarıdan gelen damgayı doğrulayıcı reddetmeli.
  // Sahte jeton yapısal olarak kusursuzdur — imprint tutar, imza doğrulanır,
  // zincir köke kadar gider. Tek kusuru: sertifika damga atmaya yetkili değil.
  const { server, url } = await startRogueTsa(
    pki.signer2.certDer, ssl.ecPrivToPem(pki.signer2),
    [pki.subCa.certDer, pki.root.certDer]);

  try {
    const manager = new PAdESManager({ tsaUrl: url, tsaOptions: { hashName: 'sha256', certReq: true } });
    const p = pki.profile('signer');
    const { pdf } = await manager.sign({
      mode: 'T', pdfBuffer: makeSimplePdf({ title: 'Sahte TSA' }),
      keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems, fieldName: 'ROGUE_TS'
    });

    const r = await verifyPdf(pdf, { trustAnchors: [pki.root.certPem], allowNetwork: false });
    const s = r.signatures[0];
    const ts = s.timestamps[0];

    assert.ok(ts, 'damga belgeye gerçekten iliştirilmiş');
    assert.strictEqual(ts.imprintMatches, true, 'sahte damga imprint bakımından tutarlı');
    assert.strictEqual(ts.ekuValid, false);
    assert.strictEqual(ts.valid, false, 'EKU yoksa damga geçerli sayılmamalı');

    // Kanıt değeri sıfır: POE yok, seviye B-T'ye çıkmıyor.
    assert.strictEqual(s.poe, null, 'geçersiz damga POE üretmemeli');
    assert.strictEqual(s.achievedLevel, 'B-B', 'sahte damga B-T kazandırmamalı');
    assert.ok(s.warnings.some((w) => /Zaman damgası reddedildi/.test(w)),
      'reddedilen damga raporda görünmeli');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('TSA: EKU\'suz ARŞİV damgası TOTAL-FAILED verir (uyarı değil)', async () => {
  const { server, url } = await startRogueTsa(
    pki.signer2.certDer, ssl.ecPrivToPem(pki.signer2),
    [pki.subCa.certDer, pki.root.certDer]);

  try {
    const manager = new PAdESManager({ tsaUrl: url, tsaOptions: { hashName: 'sha256', certReq: true } });
    const p = pki.profile('signer');
    const { pdf } = await manager.sign({
      mode: 'LTA', pdfBuffer: makeSimplePdf({ title: 'Sahte arsiv damgasi' }),
      keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems,
      fieldName: 'ROGUE_LTA', ltv: { prefer: 'both' }
    });

    const r = await verifyPdf(pdf, { trustAnchors: [pki.root.certPem], allowNetwork: false });
    const docTs = r.signatures.find((s) => s.type === 'doc-timestamp');

    assert.ok(docTs, 'belge zaman damgası bulunmalı');
    assert.strictEqual(docTs.indication, INDICATION.FAILED,
      'yetkisiz arşiv damgası uyarıyla geçirilmemeli');
    assert.strictEqual(docTs.subIndication, 'SIG_CONSTRAINTS_FAILURE');
    assert.ok(docTs.errors.some((e) => /timeStamping/.test(e)));

    const sig = r.signatures.find((s) => s.type !== 'doc-timestamp');
    assert.notStrictEqual(sig.achievedLevel, 'B-LTA');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('TSA: MEŞRU damga geçerli sayılır (olumlu kontrol)', async () => {
  const manager = new PAdESManager({
    tsaUrl: svc.endpoints.tsa, tsaOptions: { hashName: 'sha256', certReq: true },
    allowPrivateNetwork: true
  });
  const p = pki.profile('signer');
  const { pdf } = await manager.sign({
    mode: 'T', pdfBuffer: makeSimplePdf({ title: 'Gercek TSA' }),
    keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems, fieldName: 'REAL_TS'
  });

  const r = await verifyPdf(pdf, { trustAnchors: [pki.root.certPem], allowNetwork: false });
  const ts = r.signatures[0].timestamps[0];
  assert.strictEqual(ts.ekuValid, true);
  assert.strictEqual(ts.contentTypeValid, true);
  assert.strictEqual(ts.valid, true);
  assert.strictEqual(r.signatures[0].achievedLevel, 'B-T');
});

/* ================================================================== */
/* D. HTTP sertleştirme — apps/server                                  */
/* ================================================================== */

/** Ham gövde ve başlıkla istek atar (fetch'in normalize etmediği hâller için). */
async function raw(pathname, { method = 'POST', headers = {}, body } = {}) {
  const res = await fetch(api.base + pathname, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* JSON olmayabilir */ }
  return { status: res.status, json, text, headers: res.headers };
}

test('HTTP: gövde sınırı aşılınca 413 döner ve istek okunmaz', async () => {
  const original = api.mod.CONFIG.maxBodyBytes;
  api.mod.CONFIG.maxBodyBytes = 2048;
  try {
    const big = JSON.stringify({ html: 'x'.repeat(64 * 1024) });
    const r = await raw('/api/render', {
      headers: { 'Content-Type': 'application/json' }, body: big
    });
    assert.strictEqual(r.status, 413);
    assert.strictEqual(r.json.error.code, 'ERR_BODY_TOO_LARGE');
  } finally {
    api.mod.CONFIG.maxBodyBytes = original;
  }
});

test('HTTP: yanlış Content-Type 415 ile reddedilir', async () => {
  // Tarayıcılar text/plain gövdeli POST'u "basit istek" sayar ve ön kontrol
  // yapmadan gönderir; JSON şartı bu yolu kapatır.
  const r = await raw('/api/render', {
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ html: '<p>merhaba</p>' })
  });
  assert.strictEqual(r.status, 415);
  assert.strictEqual(r.json.error.code, 'ERR_CONTENT_TYPE');
});

test('HTTP: Content-Type hiç yoksa da reddedilir', async () => {
  const r = await raw('/api/render', {
    headers: { 'Content-Type': '' },
    body: JSON.stringify({ html: '<p>merhaba</p>' })
  });
  assert.strictEqual(r.status, 415);
});

test('HTTP: bozuk JSON 400 döner (yığın izi sızmaz)', async () => {
  const r = await raw('/api/render', {
    headers: { 'Content-Type': 'application/json' },
    body: '{"html": '
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error.code, 'ERR_BAD_JSON');
  assert.ok(!/at Object|node:internal/.test(r.text), 'yığın izi sızmamalı');
});

test('HTTP: aşırı büyük HTML 413 ile reddedilir', async () => {
  const policy = api.mod.policy;
  const original = policy.LIMITS.maxHtmlBytes;
  policy.LIMITS.maxHtmlBytes = 1024;
  try {
    const r = await raw('/api/render', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '<p>' + 'a'.repeat(4096) + '</p>' })
    });
    assert.strictEqual(r.status, 413);
    assert.strictEqual(r.json.error.code, 'ERR_TOO_LARGE');
  } finally {
    policy.LIMITS.maxHtmlBytes = original;
  }
});

test('HTTP: aşırı uzun ops dizisi 400 ile reddedilir', async () => {
  const ops = Array.from({ length: api.mod.policy.LIMITS.maxOps + 1 },
    () => ({ type: 'setMetadata', title: 'x' }));
  const r = await raw('/api/pdf/edit', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pdf: makeSimplePdf({ title: 'ops' }).toString('base64'), ops })
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error.code, 'ERR_TOO_MANY');
});

test('HTTP: çok fazla font 400 ile reddedilir', async () => {
  const fonts = Array.from({ length: api.mod.policy.LIMITS.maxFonts + 1 },
    (_, i) => ({ family: 'F' + i, src: 'yok.ttf' }));
  const r = await raw('/api/render', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<p>x</p>', fonts })
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error.code, 'ERR_TOO_MANY');
});

test('HTTP: hız sınırı hassas uçları korur (429 + Retry-After)', async () => {
  const limit = api.mod.policy.RATE.maxSensitive;
  let last = null;
  for (let i = 0; i < limit + 2; i++) {
    last = await raw('/api/sign/pfx', {
      headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    if (last.status === 429) break;
  }
  assert.strictEqual(last.status, 429);
  assert.strictEqual(last.json.error.code, 'ERR_RATE_LIMIT');
  assert.ok(Number(last.headers.get('retry-after')) >= 0);
});

test('HTTP: belirteç tanımlıysa hassas uçlar 401 döner, sağlık ucu açık kalır', async () => {
  const AUTH = api.mod.policy.AUTH;
  const before = AUTH.tokens.slice();
  AUTH.tokens = ['dogru-belirtec'];
  try {
    const denied = await raw('/api/sign/prepare', {
      headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.strictEqual(denied.status, 401);
    assert.strictEqual(denied.json.error.code, 'ERR_UNAUTHORIZED');

    const wrong = await raw('/api/sign/prepare', {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer yanlis' },
      body: '{}'
    });
    assert.strictEqual(wrong.status, 401);

    const health = await raw('/api/health', { method: 'GET' });
    assert.strictEqual(health.status, 200);

    // Doğru belirteç 401 vermemeli (istek gövdesi eksik olduğu için 400 beklenir)
    const ok = await raw('/api/sign/prepare', {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dogru-belirtec' },
      body: '{}'
    });
    assert.notStrictEqual(ok.status, 401);
  } finally {
    AUTH.tokens = before;
  }
});

test('HTTP: sunucu tarafı PFX imzalama VARSAYILAN olarak kapalıdır', () => {
  // Not: bu dosya `allowServerSidePfx` değerini hiç değiştirmez; okunan
  // değer ortamdan gelen varsayılandır (ALLOW_SERVER_PFX === '1' değilse kapalı).
  assert.strictEqual(api.mod.CONFIG.allowServerSidePfx, process.env.ALLOW_SERVER_PFX === '1');
  assert.strictEqual(api.mod.CONFIG.allowServerSidePfx, false);
});

test('HTTP: statik sunucu depo dışına çıkamaz', async () => {
  for (const attempt of [
    '/../package.json',
    '/..%2fpackage.json',
    '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '/vendor/../../package.json'
  ]) {
    const r = await raw(attempt, { method: 'GET' });
    assert.ok(r.status === 403 || r.status === 404,
      `${attempt} → ${r.status} (403/404 bekleniyordu)`);
    assert.ok(!/"workspaces"/.test(r.text), `${attempt}: package.json sızdı`);
  }
});

test('HTTP: bilinmeyen uç 404, yanlış yöntem 405 döner', async () => {
  const notFound = await raw('/api/olmayan', {
    headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.strictEqual(notFound.status, 404);

  const badMethod = await raw('/', { method: 'DELETE' });
  assert.strictEqual(badMethod.status, 405);
});

test('HTTP: /api/render belge kaynaklı dosya yollarını okumaz', async () => {
  // Sunucu, varlık kökünü `ASSET_ROOT`a (varsayılan `assets/`) sabitler.
  // Belgeden gelen `../` bu kökün dışına çıkamaz.
  const r = await raw('/api/render', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      html: '<p><img src="../../package.json" alt="x"></p><p>metin</p>',
      theme: 'kurumsal'
    })
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const codes = (r.json.warnings || []).map((w) => w.code);
  assert.ok(codes.some((c) => /^ERR_ASSET_/.test(c)),
    `varlık reddedilmeliydi: ${JSON.stringify(r.json.warnings)}`);

  // PDF üretildi ama dosya içeriği İÇİNE GİRMEDİ
  const pdf = Buffer.from(r.json.pdf, 'base64');
  assert.ok(!pdf.includes(Buffer.from('workspaces')), 'depo içeriği PDF\'e sızmamalı');
});

/* ================================================================== */
/* E. Tarayıcı sunucusu — apps/scanner                                 */
/* ================================================================== */

async function scan(pathname, opts = {}) {
  const res = await fetch(scanner.base + pathname, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML olabilir */ }
  return { status: res.status, json, text };
}

test('Tarayıcı: arayüz dosyası gerçekten servis edilir', async () => {
  const r = await scan('/', { method: 'GET' });
  assert.strictEqual(r.status, 200, 'index.html adı sunucuyla eşleşmeli');
  assert.ok(/<html/i.test(r.text));
});

test('Tarayıcı: yanlış Content-Type 415 döner', async () => {
  const r = await scan('/api/verify', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}'
  });
  assert.strictEqual(r.status, 415);
});

test('Tarayıcı: bozuk JSON 400 döner', async () => {
  const r = await scan('/api/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{'
  });
  assert.strictEqual(r.status, 400);
});

test('Tarayıcı: geçersiz hash biçimi reddedilir', async () => {
  for (const hash of ['', 'kısa', '../../etc/passwd', 'z'.repeat(64), 'a'.repeat(200)]) {
    const r = await scan('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash })
    });
    assert.strictEqual(r.status, 400, `"${hash}" kabul edilmemeliydi`);
  }
});

test('Tarayıcı: gövde sınırı aşılınca 413 döner', async () => {
  const original = scanner.mod.CONFIG.maxBodyBytes;
  scanner.mod.CONFIG.maxBodyBytes = 512;
  try {
    const r = await scan('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash: 'a'.repeat(8192) })
    });
    assert.strictEqual(r.status, 413);
  } finally {
    scanner.mod.CONFIG.maxBodyBytes = original;
  }
});

test('Tarayıcı: kayıt defteri kapalıyken SAHTE onay vermez', async () => {
  // Bu test defteri YAPILANDIRILMAMIŞ tarayıcıyla çalışır: cevap
  // "kullanılamıyor"dur, "geçersiz" ya da "doğrulandı" değil.
  const hash = crypto.randomBytes(32).toString('hex');
  const r = await scan('/api/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash })
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.status, 'unavailable',
    'kayıt yokken "doğrulandı" demek, hiç cevap vermemekten kötüdür');
  assert.strictEqual(r.json.documentId, hash);
});
