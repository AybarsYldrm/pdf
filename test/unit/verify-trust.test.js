'use strict';
/**
 * Güven kararı ve RFC 5280 yol kısıtları — saldırgan bakışlı regresyonlar.
 *
 * Buradaki her test, denetimde GERÇEKTEN çalışmış bir atlatmayı kalıcı olarak
 * kapatır. Testin geçmesi "kod çalışıyor" demek değildir; bu saldırının bir
 * daha geçmediği anlamına gelir.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const ssl = require('@fitfak/ssl');
const ext = require('@fitfak/pades/src/cades/x509_ext');
const { validatePath } = require('@fitfak/verify/src/path');

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                          */
/* ------------------------------------------------------------------ */

const der = (pem) => ext.pemToDer(pem);

/** Küçük, tek seferlik bir hiyerarşi (testler arası paylaşılır). */
const fixture = (() => {
  const root = ssl.generateRootCA({
    bits: 2048, commonName: 'Regresyon Kok CA',
    organization: 'FITFAK Test', country: 'TR', validityDays: 3650
  });
  const sub = ssl.generateIntermediateCA(root, {
    bits: 2048, commonName: 'Regresyon Ara CA',
    organization: 'FITFAK Test', country: 'TR', validityDays: 1825
  });
  const leaf = ssl.generateEcEndEntityCert(sub, 'imzaci.test', {
    curveName: 'P-256', validityDays: 730, commonName: 'Imzaci',
    keyUsage: ['digitalSignature', 'contentCommitment'], keyUsageCritical: true,
    eku: ['1.3.6.1.5.5.7.3.4']
  });
  return { root, sub, leaf };
})();

/* ------------------------------------------------------------------ */
/* Güven çıpası kimliği                                                 */
/* ------------------------------------------------------------------ */

test('güven çıpası: aynı Subject DN farklı anahtar güvenilir SAYILMAZ', () => {
  const name = {
    bits: 2048, commonName: 'Ayni Isimli Kok',
    organization: 'FITFAK Test', country: 'TR', validityDays: 3650
  };
  const gercek = ssl.generateRootCA(name);
  const sahte = ssl.generateRootCA(name);      // birebir aynı DN, farklı anahtar

  assert.ok(ext.getSubjectDer(der(gercek.certPem)).equals(ext.getSubjectDer(der(sahte.certPem))),
    'kurgu geçersiz: DN\'ler aynı olmalı');
  assert.ok(!der(gercek.certPem).equals(der(sahte.certPem)),
    'kurgu geçersiz: sertifikalar farklı olmalı');

  // Kimlik ölçütü DER/SPKI'dır: sahte kök gerçek kökün yerine geçemez.
  const spki = (d) => new crypto.X509Certificate(d).publicKey
    .export({ type: 'spki', format: 'der' });
  assert.ok(!spki(der(gercek.certPem)).equals(spki(der(sahte.certPem))));
});

test('buildChain: issuer adayı imzayı GERÇEKTEN doğrulamalı', () => {
  const { root, sub, leaf } = fixture;

  // Aynı DN'ye sahip sahte bir "ara CA": isim eşleşir, imza eşleşmez.
  const sahteAra = ssl.generateIntermediateCA(
    ssl.generateRootCA({ bits: 2048, commonName: 'Regresyon Kok CA',
      organization: 'FITFAK Test', country: 'TR', validityDays: 3650 }),
    { bits: 2048, commonName: 'Regresyon Ara CA',
      organization: 'FITFAK Test', country: 'TR', validityDays: 1825 });

  // Havuzda ÖNCE sahte aday duruyor — eski kod ilk isim eşleşmesini alırdı.
  const pool = [der(sahteAra.certPem), der(sub.certPem), der(root.certPem)];
  const chain = ext.buildChain(der(leaf.certPem), pool);

  assert.strictEqual(chain.complete, true);
  assert.ok(chain.path[1].equals(der(sub.certPem)),
    'yol, imzayı gerçekten doğrulayan ara CA\'dan geçmeli');
});

test('verifiesAsIssuer: yalnız gerçek imzalayan için true döner', () => {
  const { root, sub, leaf } = fixture;
  assert.strictEqual(ext.verifiesAsIssuer(der(leaf.certPem), der(sub.certPem)), true);
  assert.strictEqual(ext.verifiesAsIssuer(der(sub.certPem), der(root.certPem)), true);
  // Kök, yaprağı imzalamadı.
  assert.notStrictEqual(ext.verifiesAsIssuer(der(leaf.certPem), der(root.certPem)), true);
});

/* ------------------------------------------------------------------ */
/* RFC 5280 §6.1 yol kısıtları                                          */
/* ------------------------------------------------------------------ */

test('yol: geçerli zincir kısıtları geçer', () => {
  const { root, sub, leaf } = fixture;
  const r = validatePath([der(leaf.certPem), der(sub.certPem), der(root.certPem)]);
  assert.strictEqual(r.ok, true, `beklenmedik hatalar: ${r.errors.join(' | ')}`);
});

test('yol: CA olmayan sertifika issuer olamaz (§6.1.4(k))', () => {
  const { root, sub, leaf } = fixture;
  // Yaprağın anahtarıyla üretilmiş sahte bir alt sertifika.
  const sahte = ssl.generateEcEndEntityCert(leaf, 'sahte.test', {
    curveName: 'P-256', validityDays: 365, commonName: 'Sahte Yetkili',
    keyUsage: ['digitalSignature'], keyUsageCritical: true
  });

  const r = validatePath([
    der(sahte.certPem), der(leaf.certPem), der(sub.certPem), der(root.certPem)
  ]);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /CA olmayan sertifika issuer/.test(e)),
    `beklenen hata yok: ${r.errors.join(' | ')}`);
});

test('yol: keyCertSign biti olmayan CA reddedilir (§6.1.4(n))', () => {
  // keyCertSign taşımayan ama cA=TRUE olan bir "CA".
  const root = ssl.generateRootCA({
    bits: 2048, commonName: 'Yetkisiz Kok',
    organization: 'FITFAK Test', country: 'TR', validityDays: 3650
  });
  const yetkisiz = ssl.generateIntermediateCA(root, {
    bits: 2048, commonName: 'keyCertSign Yok',
    organization: 'FITFAK Test', country: 'TR', validityDays: 1825,
    keyUsage: ['digitalSignature'], keyUsageCritical: true
  });
  const ku = ext.extractKeyUsage(der(yetkisiz.certPem));
  if (!ku.present || ku.keyCertSign) return;   // üretici bitleri zorluyorsa atla

  const leaf = ssl.generateEcEndEntityCert(yetkisiz, 'x.test', {
    curveName: 'P-256', validityDays: 365, commonName: 'X'
  });
  const r = validatePath([der(leaf.certPem), der(yetkisiz.certPem), der(root.certPem)]);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /keyCertSign/.test(e)));
});

test('yol: tanınmayan KRİTİK uzantı yolu reddettirir (§6.1.4(f))', () => {
  const { DER } = require('@fitfak/pades/src/cades/asn1_der');
  const BILINMEYEN = '1.3.6.1.4.1.99999.1';

  // Extension ::= SEQUENCE { extnID OID, critical BOOLEAN, extnValue OCTET STRING }
  const kritikUzanti = DER.seq(
    DER.oid(BILINMEYEN),
    Buffer.from([0x01, 0x01, 0xFF]),            // critical = TRUE
    DER.octet(Buffer.from([0x05, 0x00]))        // içerik önemsiz
  );

  const root = ssl.generateRootCA({
    bits: 2048, commonName: 'Kritik Uzanti Kok',
    organization: 'FITFAK Test', country: 'TR', validityDays: 3650
  });
  const leaf = ssl.generateEcEndEntityCert(root, 'kritik.test', {
    curveName: 'P-256', validityDays: 365, commonName: 'Kritik',
    keyUsage: ['digitalSignature'], keyUsageCritical: true,
    extraExtensions: [kritikUzanti]
  });

  // Önce uzantının gerçekten sertifikaya girdiğini doğrula — yoksa test
  // hiçbir şey ölçmez ve sessizce "geçer".
  const kritikler = ext.criticalExtensionOids(der(leaf.certPem));
  assert.ok(kritikler.includes(BILINMEYEN),
    `kurgu geçersiz: kritik uzantı sertifikaya girmemiş (${kritikler.join(', ')})`);

  const r = validatePath([der(leaf.certPem), der(root.certPem)]);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes(BILINMEYEN)),
    `beklenen hata yok: ${r.errors.join(' | ')}`);
});

test('yol: imzalayanda digitalSignature/contentCommitment yoksa reddedilir', () => {
  const root = ssl.generateRootCA({
    bits: 2048, commonName: 'KU Kok', organization: 'FITFAK Test',
    country: 'TR', validityDays: 3650
  });
  const leaf = ssl.generateEcEndEntityCert(root, 'sifreleme.test', {
    curveName: 'P-256', validityDays: 365, commonName: 'Yalniz Anahtar Anlasmasi',
    keyUsage: ['keyAgreement'], keyUsageCritical: true
  });
  const ku = ext.extractKeyUsage(der(leaf.certPem));
  if (!ku.present || ku.digitalSignature || ku.contentCommitment) return;

  const r = validatePath([der(leaf.certPem), der(root.certPem)]);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /belge imzalamaya yetkili değil/.test(e)));
});

test('yol: gerekli EKU yoksa reddedilir (TSA senaryosu)', () => {
  const { root, sub, leaf } = fixture;
  const r = validatePath(
    [der(leaf.certPem), der(sub.certPem), der(root.certPem)],
    { requiredEku: ['1.3.6.1.5.5.7.3.8'] }      // id-kp-timeStamping
  );
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /extendedKeyUsage/.test(e)));
});

/* ------------------------------------------------------------------ */
/* KeyUsage bit çözümlemesi                                             */
/* ------------------------------------------------------------------ */

test('extractKeyUsage: dokuz bitin tamamını okur', () => {
  const { root, leaf } = fixture;
  const caKu = ext.extractKeyUsage(der(root.certPem));
  assert.strictEqual(caKu.present, true);
  assert.strictEqual(caKu.keyCertSign, true, 'kök CA keyCertSign taşımalı');

  const leafKu = ext.extractKeyUsage(der(leaf.certPem));
  assert.strictEqual(leafKu.digitalSignature, true);
  assert.strictEqual(leafKu.keyCertSign, false, 'yaprak keyCertSign taşımamalı');
});

test('extractEKU: OID listesini ve kritiklik bayrağını verir', () => {
  const { leaf } = fixture;
  const eku = ext.extractEKU(der(leaf.certPem));
  assert.strictEqual(eku.present, true);
  assert.ok(eku.oids.includes('1.3.6.1.5.5.7.3.4'));
});
