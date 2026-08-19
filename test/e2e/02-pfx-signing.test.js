'use strict';
/**
 * PFX ile imzalama — uçtan uca.
 *
 * Fixture'lar `test/fixtures/pkcs12/generate.sh` ile OpenSSL kullanılarak
 * üretilir; gerçek dünyada karşılaşılan şifreleme şemalarını temsil ederler.
 * Fixture yoksa testler atlanır (CI'da üretim adımı çalıştırılmalı).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { startTestServices } = require('./pki/services');
const { makeSimplePdf } = require('./helpers/make-pdf');
const { PAdESManager } = require('@fitfak/pades/src/utils/pades_manager');
const { Pkcs12Signer, PemSigner, RemoteSigner, resolveSigner } = require('@fitfak/pades/src/signer');
const { findAllSignatures } = require('@fitfak/pades/src/utils/pdf_parser');
const p12 = require('@fitfak/pkcs12');
const ssl = require('@fitfak/ssl');
const crypto = require('crypto');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'pkcs12');
const hasFixtures = fs.existsSync(path.join(FIXTURES, 'openssl3-aes256.pfx'));

let svc;
let manager;

test.before(async () => {
  svc = await startTestServices();
  manager = new PAdESManager({
    tsaUrl: svc.endpoints.tsa,
    tsaOptions: { hashName: 'sha256', certReq: true }
  });
});

test.after(async () => { if (svc) await svc.close(); });

test('PFX ile imzalama: RSA anahtarlı PBES2 dosyası', { skip: !hasFixtures && 'fixture yok' }, async () => {
  const pfx = fs.readFileSync(path.join(FIXTURES, 'openssl3-aes256.pfx'));

  const res = await manager.sign({
    mode: 'T',
    pdfBuffer: makeSimplePdf({ title: 'PFX ile imza' }),
    pfx,
    pfxPassword: 'test',
    fieldName: 'Sig_Pfx'
  });

  assert.strictEqual(res.achievedLevel, 'pades-t');
  const sigs = findAllSignatures(res.pdf);
  assert.strictEqual(sigs.length, 1);
  assert.strictEqual(sigs[0].subFilter, 'ETSI.CAdES.detached');
});

test('PFX ile imzalama: EC anahtarlı dosya', { skip: !hasFixtures && 'fixture yok' }, async () => {
  const pfx = fs.readFileSync(path.join(FIXTURES, 'ec-aes256.pfx'));

  const res = await manager.sign({
    mode: 'T',
    pdfBuffer: makeSimplePdf({ title: 'EC PFX' }),
    pfx,
    pfxPassword: 'test',
    fieldName: 'Sig_PfxEc'
  });

  assert.strictEqual(res.achievedLevel, 'pades-t');
});

test('PFX ile imzalama: eski 3DES/RC2-40 dosyası (saf JS RC2 yolu)',
  { skip: !fs.existsSync(path.join(FIXTURES, 'legacy-3des-rc2.pfx')) && 'fixture yok' }, async () => {
    const pfx = fs.readFileSync(path.join(FIXTURES, 'legacy-3des-rc2.pfx'));

    // Bu dosya, Node'un OpenSSL'inde RC2 legacy provider arkasında olduğu için
    // yalnız kendi RC2 uygulamamızla açılabilir.
    const info = p12.probe(pfx);
    assert.ok(info.encryptionSchemes.some((s) => s.includes('rc2')),
      `RC2 şeması beklenirdi, bulunan: ${info.encryptionSchemes.join(',')}`);

    const res = await manager.sign({
      mode: 'T',
      pdfBuffer: makeSimplePdf({ title: 'Legacy PFX' }),
      pfx,
      pfxPassword: 'test',
      fieldName: 'Sig_PfxLegacy'
    });

    assert.strictEqual(res.achievedLevel, 'pades-t');
  });

test('PFX: yanlış parola net bir hata verir', { skip: !hasFixtures && 'fixture yok' }, () => {
  const pfx = fs.readFileSync(path.join(FIXTURES, 'openssl3-aes256.pfx'));
  assert.throws(
    () => Pkcs12Signer.from(pfx, 'yanlisparola'),
    (err) => err.code === 'ERR_PKCS12_BAD_PASSWORD',
    'MAC doğrulaması yanlış parolayı yakalamalı'
  );
});

test('PFX: kimlik listesi arayüz için okunabilir', { skip: !hasFixtures && 'fixture yok' }, () => {
  const pfx = fs.readFileSync(path.join(FIXTURES, 'openssl3-aes256.pfx'));
  const list = Pkcs12Signer.listIdentities(pfx, 'test');

  assert.strictEqual(list.length, 1);
  assert.ok(list[0].subject, 'subject okunmalı');
  assert.ok(list[0].notAfter instanceof Date, 'geçerlilik tarihi okunmalı');
  assert.strictEqual(list[0].chainLength, 2, 'zincir sıralanmış olmalı (subCA + root)');
  assert.strictEqual(list[0].hasCertificate, true);
});

test('RemoteSigner: özel anahtar imzalama motoruna hiç uğramaz', async () => {
  const p = svc.pki.profile('signer');

  // Anahtarı YALNIZ bu kapanış görüyor — motora sadece bir geri çağırım veriliyor.
  let callbackCalls = 0;
  const signer = new RemoteSigner({
    certPem: p.certPem,
    chainPems: p.chainPems,
    keyInfo: { keyType: 'ec', curve: 'prime256v1' },
    signCallback: async (data, alg) => {
      callbackCalls++;
      assert.ok(Buffer.isBuffer(data), 'imzalanacak veri Buffer olmalı');
      assert.strictEqual(alg.keyType, 'ecdsa');
      const s = crypto.createSign(alg.hash.toUpperCase());
      s.update(data);
      return s.sign({ key: p.keyPem });
    }
  });

  const res = await manager.sign({
    mode: 'T',
    pdfBuffer: makeSimplePdf({ title: 'Uzak imzalayici' }),
    signer,
    fieldName: 'Sig_Remote'
  });

  assert.strictEqual(res.achievedLevel, 'pades-t');
  assert.strictEqual(callbackCalls, 1, 'imza geri çağırımı tam bir kez çalışmalı');
});

test('İki fazlı imzalama: prepare → dışarıda imzala → finalize', async () => {
  const { prepareCAdES, completeCAdES } = require('@fitfak/pades/src/cades/cades_builder');
  const p = svc.pki.profile('signer');
  const tbsHash = crypto.createHash('sha256').update('test verisi').digest();

  // 1. faz — sunucu: imzalanacak veriyi üret
  const prepared = prepareCAdES(tbsHash, p.certPem, p.chainPems);
  assert.ok(Buffer.isBuffer(prepared.dataToSign));
  assert.strictEqual(prepared.keyType, 'ecdsa');
  assert.strictEqual(prepared.hashName, 'sha256');

  // 2. faz — istemci: kendi anahtarıyla imzala
  const s = crypto.createSign('SHA256');
  s.update(prepared.dataToSign);
  const signature = s.sign({ key: p.keyPem });

  // 3. faz — sunucu: CMS'i tamamla
  const completed = completeCAdES(prepared, signature);
  assert.ok(Buffer.isBuffer(completed.cmsBES));
  assert.ok(completed.cmsBES.length > 100);

  // Doğrudan buildCAdES_BES_auto ile aynı sonucu vermeli
  const { buildCAdES_BES_auto } = require('@fitfak/pades/src/cades/cades_builder');
  const direct = buildCAdES_BES_auto(tbsHash, p.keyPem, p.certPem, p.chainPems);
  assert.strictEqual(completed.hashName, direct.hashName);
  assert.strictEqual(completed.keyType, direct.keyType);
});

test('PFX ile LT seviyesi: OCSP/CRL kanıtlarıyla birlikte', { skip: !hasFixtures && 'fixture yok' }, async () => {
  // Fixture PFX'in CA'sı yerel servislerimizde tanımlı olmadığı için, kendi
  // test PKI'ımızdan bir PFX üretip onunla imzalıyoruz — böylece hem PFX yolu
  // hem de LTV toplama birlikte sınanır.
  const p = svc.pki.profile('signer');
  const pfxDer = p12.build({
    privateKeyPem: p.keyPem,
    certificatePem: p.certPem,
    chainPems: p.chainPems,
    password: 'gizli',
    friendlyName: 'Test Imzaci'
  });

  const res = await manager.sign({
    mode: 'LT',
    pdfBuffer: makeSimplePdf({ title: 'PFX + LTV' }),
    pfx: pfxDer,
    pfxPassword: 'gizli',
    fieldName: 'Sig_PfxLtv',
    ltv: { prefer: 'both' }
  });

  assert.strictEqual(res.achievedLevel, 'pades-lt');
  assert.ok(res.ltvReport, 'LTV raporu dönmeli');
  assert.ok(res.ltvReport.embedded.crls > 0, 'CRL gömülmeli');
  assert.ok(res.ltvReport.embedded.ocsps > 0, 'OCSP gömülmeli');
});

test('resolveSigner: signer / pfx / keyPem yollarının hepsini çözer', async () => {
  const p = svc.pki.profile('signer');

  const a = resolveSigner({ keyPem: p.keyPem, certPem: p.certPem, chainPems: p.chainPems });
  assert.ok(a instanceof PemSigner);
  assert.strictEqual((await a.getCertificates()).chainPems.length, 2);

  const pfxDer = p12.build({
    privateKeyPem: p.keyPem, certificatePem: p.certPem,
    chainPems: p.chainPems, password: 'x'
  });
  const b = resolveSigner({ pfx: pfxDer, pfxPassword: 'x' });
  assert.ok(b instanceof Pkcs12Signer);
  assert.strictEqual((await b.getCertificates()).certPem.trim(), p.certPem.trim());

  const c = resolveSigner({ signer: a });
  assert.strictEqual(c, a, 'hazır signer olduğu gibi geçmeli');

  assert.throws(() => resolveSigner({}), (e) => e.code === 'ERR_SIGNER_MISSING');
});
