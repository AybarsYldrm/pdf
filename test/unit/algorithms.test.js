'use strict';
/**
 * Algoritma politikası — ETSI TS 119 312 ruhunda.
 *
 * Bir imzanın matematiksel olarak doğrulanması güvenilir olduğu anlamına
 * gelmez. Denetimde 1024 bitlik RSA anahtarıyla imzalanmış bir belge, tek
 * bir uyarı bile üretmeden TOTAL-PASSED dönüyordu.
 */

const test = require('node:test');
const assert = require('node:assert');

const ssl = require('@fitfak/ssl');
const ext = require('@fitfak/pades/src/cades/x509_ext');
const {
  assessAlgorithms, describeKey, normalizeDigest, certSignatureDigest
} = require('@fitfak/verify/src/algorithms');

const der = (pem) => ext.pemToDer(pem);

const guclu = (() => {
  const root = ssl.generateRootCA({
    bits: 2048, commonName: 'Guclu Kok', organization: 'T',
    country: 'TR', validityDays: 365
  });
  const leaf = ssl.generateEcEndEntityCert(root, 'guclu.test', {
    curveName: 'P-256', validityDays: 90, commonName: 'Guclu Imzaci'
  });
  return { root, leaf };
})();

/* ------------------------------------------------------------------ */

test('güçlü zincir politikadan geçer', () => {
  const r = assessAlgorithms({
    signerCert: der(guclu.leaf.certPem),
    digestAlgorithm: 'sha256',
    chain: [der(guclu.leaf.certPem), der(guclu.root.certPem)]
  });
  assert.strictEqual(r.ok, true, `beklenmedik hatalar: ${r.errors.join(' | ')}`);
});

test('SHA-1 ile hesaplanmış imza özeti reddedilir', () => {
  const r = assessAlgorithms({
    signerCert: der(guclu.leaf.certPem),
    digestAlgorithm: 'sha1',
    chain: [der(guclu.leaf.certPem), der(guclu.root.certPem)]
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /çakışma direnci/.test(e)),
    `beklenen hata yok: ${r.errors.join(' | ')}`);
});

test('MD5 de reddedilir', () => {
  const r = assessAlgorithms({
    signerCert: der(guclu.leaf.certPem), digestAlgorithm: 'md5'
  });
  assert.strictEqual(r.ok, false);
});

test('1024 bitlik RSA anahtarı reddedilir', () => {
  const zayif = ssl.generateRootCA({
    bits: 1024, commonName: 'Zayif Kok', organization: 'T',
    country: 'TR', validityDays: 365
  });
  const leaf = ssl.generateEndEntityCert(zayif, 'zayif.test', {
    bits: 1024, validityDays: 90, commonName: 'Zayif Imzaci'
  });

  const r = assessAlgorithms({
    signerCert: der(leaf.certPem),
    digestAlgorithm: 'sha256',
    chain: [der(leaf.certPem), der(zayif.certPem)]
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /1024 bitlik RSA/.test(e)),
    `beklenen hata yok: ${r.errors.join(' | ')}`);
  // Hem yaprak hem CA bildirilmeli: biri düzeltilip diğeri kalmasın.
  assert.ok(r.errors.length >= 2, 'zincirdeki CA da bildirilmeli');
});

test('2048 bit kabul edilir ama arşiv için uyarı verilir', () => {
  const r = assessAlgorithms({
    signerCert: der(guclu.root.certPem), digestAlgorithm: 'sha256'
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((w) => /arşiv/.test(w)),
    `2048 bit için arşiv uyarısı beklenirdi: ${r.warnings.join(' | ')}`);
});

test('politika çağıran tarafından sıkılaştırılabilir', () => {
  const r = assessAlgorithms(
    { signerCert: der(guclu.root.certPem), digestAlgorithm: 'sha256' },
    { minRsaBits: 4096 }
  );
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /en az 4096 bit/.test(e)));
});

test('KÖKÜN kendi imzası politikaya girmez', () => {
  // Köke güven imzasından değil, güven deposunda olmasından gelir. Eski
  // SHA-1 kökler bu yüzden bir yolu geçersiz kılmaz — aksi hâlde dünyadaki
  // pek çok meşru kök reddedilirdi.
  const r = assessAlgorithms({
    signerCert: der(guclu.leaf.certPem),
    digestAlgorithm: 'sha256',
    chain: [der(guclu.leaf.certPem), der(guclu.root.certPem)]
  });
  assert.strictEqual(r.ok, true);
});

test('describeKey: RSA ve EC anahtarlarını doğru tanır', () => {
  assert.deepStrictEqual(describeKey(der(guclu.root.certPem)),
    { type: 'rsa', bits: 2048 });

  const ec = describeKey(der(guclu.leaf.certPem));
  assert.strictEqual(ec.type, 'ec');
  assert.strictEqual(ec.bits, 256);
});

test('certSignatureDigest: OID\'den özet adını çıkarır', () => {
  assert.strictEqual(certSignatureDigest(der(guclu.root.certPem)), 'sha256');
  assert.strictEqual(certSignatureDigest(der(guclu.leaf.certPem)), 'sha256');
  assert.strictEqual(certSignatureDigest(Buffer.from([0x30, 0x00])), null);
});

test('normalizeDigest: farklı yazımları tek ada indirger', () => {
  assert.strictEqual(normalizeDigest('RSA-SHA1'), 'sha1');
  assert.strictEqual(normalizeDigest('sha1WithRSAEncryption'), 'sha1');
  assert.strictEqual(normalizeDigest('SHA256'), 'sha256');
  assert.strictEqual(normalizeDigest('ecdsa-with-SHA384'), 'sha384');
  assert.strictEqual(normalizeDigest(null), null);
  assert.strictEqual(normalizeDigest('bilinmeyen'), null);
});
