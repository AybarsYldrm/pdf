'use strict';
/**
 * @fitfak/pkcs12 birim testleri.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const p12 = require('@fitfak/pkcs12');
const rc2 = require('@fitfak/pkcs12/src/rc2');
const { pkcs12Kdf, toBmpString, ID_KEY_MATERIAL, ID_IV, ID_MAC_KEY } = require('@fitfak/pkcs12/src/kdf');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'pkcs12');
const fixture = (name) => path.join(FIXTURES, name);
const has = (name) => fs.existsSync(fixture(name));

/* ------------------------------------------------------------------ */
/* RC2 — RFC 2268 §5 test vektörleri                                    */
/* ------------------------------------------------------------------ */

test('RC2: RFC 2268 test vektörleri', () => {
  // IV=0 ile CBC'nin ilk bloğu ECB'ye eşittir; encryptCbc dolgu eklediği için
  // ilk 8 baytı karşılaştırıyoruz.
  const vectors = [
    { key: '0000000000000000',                 eff: 63,  pt: '0000000000000000', ct: 'ebb773f993278eff' },
    { key: 'ffffffffffffffff',                 eff: 64,  pt: 'ffffffffffffffff', ct: '278b27e42e2f0d49' },
    { key: '3000000000000000',                 eff: 64,  pt: '1000000000000001', ct: '30649edf9be7d2c2' },
    { key: '88',                               eff: 64,  pt: '0000000000000000', ct: '61a8a244adacccf0' },
    { key: '88bca90e90875a',                   eff: 64,  pt: '0000000000000000', ct: '6ccf4308974c267f' },
    { key: '88bca90e90875a7f0f79c384627bafb2', eff: 64,  pt: '0000000000000000', ct: '1a807d272bbe5db1' },
    { key: '88bca90e90875a7f0f79c384627bafb2', eff: 128, pt: '0000000000000000', ct: '2269552ab0f85ca6' }
  ];

  for (const v of vectors) {
    const out = rc2.encryptCbc(
      Buffer.from(v.pt, 'hex'), Buffer.from(v.key, 'hex'), Buffer.alloc(8), v.eff
    );
    assert.strictEqual(out.slice(0, 8).toString('hex'), v.ct,
      `RC2 vektörü başarısız: key=${v.key} eff=${v.eff}`);
  }
});

test('RC2: CBC gidiş-dönüş', () => {
  const data = Buffer.from('PKCS#12 icin RC2-40 CBC testi — Türkçe karakterler dahil.', 'utf8');
  const key = Buffer.from('0102030405', 'hex');
  const iv = crypto.randomBytes(8);

  const enc = rc2.encryptCbc(data, key, iv, 40);
  const dec = rc2.decryptCbc(enc, key, iv, 40);
  assert.ok(dec.equals(data));
});

test('RC2: yanlış anahtar dolgu hatası verir', () => {
  const data = Buffer.from('gizli veri');
  const iv = crypto.randomBytes(8);
  const enc = rc2.encryptCbc(data, Buffer.from('0102030405', 'hex'), iv, 40);

  assert.throws(
    () => rc2.decryptCbc(enc, Buffer.from('0605040302', 'hex'), iv, 40),
    /dolgu/
  );
});

/* ------------------------------------------------------------------ */
/* KDF                                                                  */
/* ------------------------------------------------------------------ */

test('KDF: parola BMPString olarak (UTF-16BE + çift null) kodlanır', () => {
  // "abc" → 00 61 00 62 00 63 00 00
  assert.strictEqual(toBmpString('abc').toString('hex'), '0061006200630000');
  // Boş parola → yalnız sonlandırıcı
  assert.strictEqual(toBmpString('').toString('hex'), '0000');
  // Türkçe karakter (U+015F ş)
  assert.strictEqual(toBmpString('ş').toString('hex'), '015f0000');
});

test('KDF: id değeri farklı olduğunda farklı malzeme üretir', () => {
  const pwd = toBmpString('test');
  const salt = Buffer.alloc(8, 0xaa);

  const key = pkcs12Kdf(pwd, salt, ID_KEY_MATERIAL, 2048, 24, 'sha1');
  const iv  = pkcs12Kdf(pwd, salt, ID_IV,           2048, 8,  'sha1');
  const mac = pkcs12Kdf(pwd, salt, ID_MAC_KEY,      2048, 20, 'sha1');

  assert.strictEqual(key.length, 24);
  assert.strictEqual(iv.length, 8);
  assert.strictEqual(mac.length, 20);
  assert.notStrictEqual(key.slice(0, 8).toString('hex'), iv.toString('hex'));
});

test('KDF: aynı girdi her zaman aynı çıktıyı verir', () => {
  const pwd = toBmpString('sifre');
  const salt = Buffer.from('0102030405060708', 'hex');
  const a = pkcs12Kdf(pwd, salt, ID_KEY_MATERIAL, 1000, 32, 'sha256');
  const b = pkcs12Kdf(pwd, salt, ID_KEY_MATERIAL, 1000, 32, 'sha256');
  assert.ok(a.equals(b));
});

/* ------------------------------------------------------------------ */
/* Parse                                                                */
/* ------------------------------------------------------------------ */

const cases = [
  { file: 'openssl3-aes256.pfx',  pass: 'test',           scheme: 'pbes2',          keyType: 'rsa' },
  { file: 'ec-aes256.pfx',        pass: 'test',           scheme: 'pbes2',          keyType: 'ec' },
  { file: 'legacy-3des.pfx',      pass: 'test',           scheme: 'pkcs12-3des',    keyType: 'rsa' },
  { file: 'legacy-3des-rc2.pfx',  pass: 'test',           scheme: 'pkcs12-rc2-40',  keyType: 'rsa' },
  { file: 'empty-password.pfx',   pass: '',               scheme: 'pbes2',          keyType: 'rsa' },
  { file: 'unicode-password.pfx', pass: 'şifreÖĞÜ123',    scheme: 'pbes2',          keyType: 'rsa' }
];

for (const c of cases) {
  test(`parse: ${c.file} (${c.scheme})`, { skip: !has(c.file) && 'fixture yok' }, () => {
    const der = fs.readFileSync(fixture(c.file));

    const info = p12.probe(der);
    assert.ok(info.encryptionSchemes.includes(c.scheme),
      `${c.scheme} beklenirdi, bulunan: ${info.encryptionSchemes.join(',')}`);

    const store = p12.parse(der, c.pass);
    assert.strictEqual(store.mac.verified, true, 'MAC doğrulanmalı');
    assert.strictEqual(store.identities.length, 1);

    const id = store.identities[0];
    assert.strictEqual(id.keyInfo.type, c.keyType);
    assert.ok(id.certificatePem.includes('BEGIN CERTIFICATE'));
    assert.strictEqual(id.chainPems.length, 2, 'zincir subCA + root olmalı');

    // Anahtar ile sertifika gerçekten eşleşiyor mu?
    const keyObj = crypto.createPrivateKey(id.privateKeyPem);
    const pub = crypto.createPublicKey(keyObj).export({ format: 'der', type: 'spki' });
    const certPub = new crypto.X509Certificate(id.certificatePem)
      .publicKey.export({ format: 'der', type: 'spki' });
    assert.ok(pub.equals(certPub), 'özel anahtar sertifikayla eşleşmeli');
  });
}

test('parse: MAC olmayan dosya reddedilmez ama işaretlenir',
  { skip: !has('no-mac.pfx') && 'fixture yok' }, () => {
    const store = p12.parse(fs.readFileSync(fixture('no-mac.pfx')), 'test');
    assert.strictEqual(store.mac.present, false);
    assert.strictEqual(store.identities.length, 1);
  });

test('parse: yalnız sertifika içeren dosyada kimlik yok, sertifikalar var',
  { skip: !has('certs-only.pfx') && 'fixture yok' }, () => {
    const store = p12.parse(fs.readFileSync(fixture('certs-only.pfx')), 'test');
    assert.strictEqual(store.identities.length, 0);
    assert.strictEqual(store.otherCertificates.length, 2);
  });

test('parse: yanlış parola ERR_PKCS12_BAD_PASSWORD verir',
  { skip: !has('openssl3-aes256.pfx') && 'fixture yok' }, () => {
    assert.throws(
      () => p12.parse(fs.readFileSync(fixture('openssl3-aes256.pfx')), 'kesinlikle-yanlis'),
      (err) => err.code === 'ERR_PKCS12_BAD_PASSWORD'
    );
  });

test('probe: parola olmadan dosya hakkında bilgi verir',
  { skip: !has('openssl3-aes256.pfx') && 'fixture yok' }, () => {
    const info = p12.probe(fs.readFileSync(fixture('openssl3-aes256.pfx')));
    assert.strictEqual(info.version, 3);
    assert.strictEqual(info.macAlgorithm, 'sha256');
    assert.ok(info.macIterations > 0);
    assert.strictEqual(info.needsPassword, true);
  });

/* ------------------------------------------------------------------ */
/* Build                                                                */
/* ------------------------------------------------------------------ */

test('build: gidiş-dönüş (PBES2) ve MacData üretimi', () => {
  const ssl = require('@fitfak/ssl');
  const ca = ssl.generateEcRootCA({ curveName: 'P-256', commonName: 'Build Test CA' });
  const ee = ssl.generateEcEndEntityCert(ca, 'build.test', {
    curveName: 'P-256', commonName: 'Build Test EE'
  });

  const der = p12.build({
    privateKeyPem: ssl.ecPrivToPem(ee),
    certificatePem: ee.certPem,
    chainPems: [ca.certPem],
    password: 'parola123',
    friendlyName: 'Test Kimlik'
  });

  assert.strictEqual(der[0], 0x30, 'çıktı DER SEQUENCE olmalı');

  const store = p12.parse(der, 'parola123');
  assert.strictEqual(store.mac.present, true, 'MacData yazılmalı (eski pfx.js yazmıyordu)');
  assert.strictEqual(store.mac.verified, true);
  assert.strictEqual(store.identities.length, 1);
  assert.strictEqual(store.identities[0].friendlyName, 'Test Kimlik');
  assert.strictEqual(store.identities[0].chainPems.length, 1);
  assert.strictEqual(store.identities[0].certificatePem.trim(), ee.certPem.trim());
});

test('build: 3DES (eski uyum) modu da okunabilir', () => {
  const ssl = require('@fitfak/ssl');
  const ca = ssl.generateEcRootCA({ curveName: 'P-256', commonName: 'Build 3DES CA' });
  const ee = ssl.generateEcEndEntityCert(ca, 'build3des.test', {
    curveName: 'P-256', commonName: 'Build 3DES EE'
  });

  const der = p12.build({
    privateKeyPem: ssl.ecPrivToPem(ee),
    certificatePem: ee.certPem,
    chainPems: [ca.certPem],
    password: 'p',
    encryption: 'pkcs12-3des',
    mac: { algorithm: 'sha1', iterations: 2048 }
  });

  const info = p12.probe(der);
  assert.ok(info.encryptionSchemes.includes('pkcs12-3des'));
  assert.strictEqual(info.macAlgorithm, 'sha1');

  const store = p12.parse(der, 'p');
  assert.strictEqual(store.mac.verified, true);
  assert.strictEqual(store.identities.length, 1);
});

test('build: MacData kapatılabilir', () => {
  const ssl = require('@fitfak/ssl');
  const ca = ssl.generateEcRootCA({ curveName: 'P-256', commonName: 'NoMac CA' });
  const ee = ssl.generateEcEndEntityCert(ca, 'nomac.test', { curveName: 'P-256' });

  const der = p12.build({
    privateKeyPem: ssl.ecPrivToPem(ee),
    certificatePem: ee.certPem,
    password: 'p',
    mac: false
  });

  const store = p12.parse(der, 'p');
  assert.strictEqual(store.mac.present, false);
});
