'use strict';
/**
 * x509_ext birim testleri.
 *
 * Bu modül, projedeki "DER içinde string ara" yaklaşımının yerine geçtiği için
 * testler özellikle o yaklaşımın kaçırdığı durumlara odaklanır.
 */

const test = require('node:test');
const assert = require('node:assert');
const ext = require('@fitfak/pades/src/cades/x509_ext');
const { buildTestPki } = require('../e2e/pki/ca');

// PKI üretimi RSA anahtar ürettiği için pahalı; tüm testler tek örneği paylaşır.
const pki = buildTestPki({
  ocsp: 'http://ocsp.example.test/status',      // ".crl"/"ocsp." kalıplarına UYMAYAN adresler:
  crl:  'http://pki.example.test/revocation',   // eski regex yaklaşımı bunları kaçırırdı
  aia:  'http://pki.example.test/revocation'
});

test('AIA: OCSP ve caIssuers adresleri ASN.1 üzerinden doğru çıkarılır', () => {
  const der = ext.pemToDer(pki.signer.certPem);
  const aia = ext.extractAIA(der);

  assert.deepStrictEqual(aia.ocsp, ['http://ocsp.example.test/status']);
  assert.deepStrictEqual(aia.caIssuers, ['http://pki.example.test/revocation/sub.crt']);
});

test('CDP: ".crl" ile bitmeyen dağıtım noktaları da bulunur', () => {
  const der = ext.pemToDer(pki.signer.certPem);
  const cdp = ext.extractCDP(der);

  assert.strictEqual(cdp.http.length, 1);
  assert.strictEqual(cdp.http[0], 'http://pki.example.test/revocation/sub.crl');
  assert.strictEqual(cdp.ldap.length, 0);
});

test('AIA: OCSP adresi olmayan sertifikada boş dizi döner (yanlış eşleşme yok)', () => {
  const der = ext.pemToDer(pki.signerCrlOnly.certPem);
  const aia = ext.extractAIA(der);

  assert.deepStrictEqual(aia.ocsp, [], 'OCSP yokken uydurma adres üretilmemeli');
  assert.ok(aia.caIssuers.length > 0, 'caIssuers ise mevcut olmalı');
  assert.ok(ext.extractCDP(der).http.length > 0, 'CDP mevcut olmalı');
});

test('SKI ve AKI: alt sertifikanın AKI değeri üst sertifikanın SKI değerine eşittir', () => {
  const leaf = ext.pemToDer(pki.signer.certPem);
  const issuer = ext.pemToDer(pki.subCa.certPem);

  const aki = ext.extractAKI(leaf);
  const ski = ext.extractSKI(issuer);

  assert.ok(aki.keyId, 'AKI keyIdentifier bulunmalı');
  assert.ok(ski, 'SKI bulunmalı');
  assert.ok(aki.keyId.equals(ski), 'AKI, üst sertifikanın SKI değeriyle eşleşmeli');
});

test('isSelfSigned: yalnız kök için true döner', () => {
  assert.strictEqual(ext.isSelfSigned(ext.pemToDer(pki.root.certPem)), true);
  assert.strictEqual(ext.isSelfSigned(ext.pemToDer(pki.subCa.certPem)), false);
  assert.strictEqual(ext.isSelfSigned(ext.pemToDer(pki.signer.certPem)), false);
});

test('basicConstraints: CA ve yaprak ayrımı doğru yapılır', () => {
  const ca = ext.extractBasicConstraints(ext.pemToDer(pki.subCa.certPem));
  const leaf = ext.extractBasicConstraints(ext.pemToDer(pki.signer.certPem));

  assert.strictEqual(ca.isCA, true);
  assert.strictEqual(leaf.isCA, false);
});

test('buildChain: karışık havuzdan doğru yolu kurar', () => {
  const leaf = ext.pemToDer(pki.signer.certPem);
  // Havuz kasıtlı olarak karışık ve ilgisiz sertifikalar içeriyor
  const pool = pki.allCertsPem().map(ext.pemToDer).sort(() => Math.random() - 0.5);

  const chain = ext.buildChain(leaf, pool);

  assert.strictEqual(chain.complete, true, 'zincir köke ulaşmalı');
  assert.strictEqual(chain.path.length, 3, 'leaf → subCA → root');
  assert.ok(chain.path[0].equals(leaf));
  assert.ok(ext.isSelfSigned(chain.path[2]), 'son halka kendinden imzalı olmalı');
});

test('buildChain: issuer havuzda yoksa eksik olduğunu bildirir', () => {
  const leaf = ext.pemToDer(pki.signer.certPem);
  const chain = ext.buildChain(leaf, [ext.pemToDer(pki.root.certPem)]);

  assert.strictEqual(chain.complete, false);
  assert.strictEqual(chain.path.length, 1);
  assert.ok(chain.missingIssuerOf, 'hangi sertifikanın issuer\'ı eksik, bildirilmeli');
});

test('isIssuerOf: isim eşleşse bile AKI/SKI uyuşmazlığını yakalar', () => {
  const leaf = ext.pemToDer(pki.signer.certPem);
  const wrongIssuer = ext.pemToDer(pki.root.certPem);

  assert.strictEqual(ext.isIssuerOf(leaf, ext.pemToDer(pki.subCa.certPem)), true);
  assert.strictEqual(ext.isIssuerOf(leaf, wrongIssuer), false);
});

test('collectCertificates: iç içe DER yapılarından sertifikaları toplar', () => {
  // Sertifikaları bir SEQUENCE içine gömüp geri çıkarabiliyor muyuz?
  const certs = [pki.signer.certPem, pki.subCa.certPem, pki.root.certPem].map(ext.pemToDer);
  const inner = Buffer.concat(certs);
  const header = Buffer.concat([
    Buffer.from([0x30, 0x84]),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(inner.length); return b; })()
  ]);
  const wrapped = Buffer.concat([header, inner]);

  const found = ext.collectCertificates(wrapped);
  assert.strictEqual(found.length, 3, 'üç sertifika da bulunmalı');
});

test('splitPem: yığın PEM içindeki tüm sertifikaları ayırır', () => {
  const bundle = [pki.signer.certPem, pki.subCa.certPem, pki.root.certPem].join('\n');
  assert.strictEqual(ext.splitPem(bundle).length, 3);
});

test('getSerial: sertifika seri numarası okunur ve benzersizdir', () => {
  const a = ext.getSerial(ext.pemToDer(pki.signer.certPem)).toString('hex');
  const b = ext.getSerial(ext.pemToDer(pki.signer2.certPem)).toString('hex');

  assert.ok(a.length > 0);
  assert.notStrictEqual(a, b, 'farklı sertifikaların serileri farklı olmalı');
});
