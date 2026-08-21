'use strict';
/**
 * Ayrıştırıcı sertliği — düşmanca girdiler.
 *
 * Doğrulayıcı, saldırganın ürettiği baytları okumak ZORUNDADIR: bu onun işi.
 * Bir ayrıştırıcının çökmesi ya da sonsuz döngüye girmesi hizmet reddidir;
 * yanlış ayrıştırması ise güvenlik kararını bozar.
 *
 * Ölçüt: her girdi SINIRLI sürede sonlanmalı ve ya bir sonuç ya da açık bir
 * hata dönmeli. "Belki çöker" diye bir kabul yoktur.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const ext = require('@fitfak/pades/src/cades/x509_ext');
const cms = require('@fitfak/verify/src/cms');
const { verifyPdf } = require('@fitfak/verify');

/** Verilen süre içinde sonlanmayı sınar. */
function sinirliSure(ad, fn, sinirMs) {
  const t0 = Date.now();
  fn();
  const sure = Date.now() - t0;
  assert.ok(sure < sinirMs, `${ad}: ${sure}ms sürdü (sınır ${sinirMs}ms)`);
  return sure;
}

/** `derinlik` kat iç içe SEQUENCE — özyinelemeli inici varsa yığını taşırır. */
function derinSeq(derinlik) {
  let buf = Buffer.from([0x05, 0x00]);
  for (let i = 0; i < derinlik; i++) {
    const len = buf.length;
    const hdr = len < 128
      ? Buffer.from([0x30, len])
      : Buffer.concat([Buffer.from([0x30, 0x82]), Buffer.from([len >> 8, len & 0xff])]);
    buf = Buffer.concat([hdr, buf]);
  }
  return buf;
}

/* ── ASN.1 ───────────────────────────────────────────────────────── */

test('derin iç içe SEQUENCE yığını taşırmaz', () => {
  const bomba = derinSeq(5000);
  sinirliSure('parseExtensions', () => ext.parseExtensions(bomba), 3000);
  sinirliSure('collectCertificates', () => ext.collectCertificates(bomba), 3000);
  sinirliSure('isSelfSigned', () => ext.isSelfSigned(bomba), 1000);
});

test('uzunluğunu gövdeden büyük bildiren TLV sonlanır', () => {
  // len = 0x7FFFFFFF ama gövde 1 bayt: sınır dışı okuma ya da devasa
  // ayırma denemesi olmamalı.
  const yalan = Buffer.from([0x30, 0x84, 0x7f, 0xff, 0xff, 0xff, 0x01]);
  sinirliSure('parseExtensions', () => ext.parseExtensions(yalan), 1000);
  sinirliSure('collectCertificates', () => ext.collectCertificates(yalan), 1000);
});

test('sıfır uzunluklu TLV yığını sonsuz döngüye girmez', () => {
  // Konum ilerlemezse döngü hiç bitmez. 200 KB'lık 0x30 dizisi bunu zorlar.
  const yigin = Buffer.alloc(200_000, 0x30);
  sinirliSure('parseExtensions', () => ext.parseExtensions(yigin), 3000);
  sinirliSure('collectCertificates', () => ext.collectCertificates(yigin), 3000);
});

test('rastgele baytlar CMS ayrıştırıcısında açık hataya dönüşür', () => {
  const cop = crypto.randomBytes(512 * 1024);
  assert.throws(() => cms.parseSignedData(cop),
    (err) => err instanceof Error, 'sessizce yanlış sonuç dönmemeli');
});

test('büyük ve tamamen geçersiz havuzla zincir kurulumu sonlanır', () => {
  const cop = derinSeq(3);
  const havuz = Array.from({ length: 5000 }, () => cop);
  sinirliSure('buildChain', () => ext.buildChain(cop, havuz), 5000);
});

test('BOŞ isimler "kendinden imzalı" saymaz', () => {
  // Bozuk DER'de alan konumlandırma başarısız olunca hem subject hem issuer
  // boş tampon dönüyordu; `equals` bunları eşit bulup sertifikayı kendinden
  // imzalı ilan ediyordu. Bunun iki sonucu vardı: zincir çöp bir "kök"te
  // sonlanıyor ve o sertifika iptal denetiminden muaf tutuluyordu.
  const cop = derinSeq(3);
  assert.strictEqual(ext.getIssuerDer(cop).length, 0, 'kurgu: issuer boş olmalı');
  assert.strictEqual(ext.isSelfSigned(cop), false);

  const zincir = ext.buildChain(cop, [cop]);
  assert.strictEqual(zincir.complete, false,
    'çöp bir sertifika zinciri tamamlamış sayılmamalı');
});

/* ── PDF ─────────────────────────────────────────────────────────── */

const sigPdf = (byteRange) => Buffer.from(
  '%PDF-1.7\n1 0 obj\n<< /Type /Sig /SubFilter /ETSI.CAdES.detached ' +
  `/ByteRange ${byteRange} /Contents <3000> >>\nendobj\n` +
  'trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n9\n%%EOF\n', 'latin1');

test('boş ve rastgele girdi çökmeden rapor döner', async () => {
  const bos = await verifyPdf(Buffer.alloc(0), { allowNetwork: false });
  assert.strictEqual(bos.signatures.length, 0);

  const rastgele = await verifyPdf(crypto.randomBytes(2 * 1024 * 1024),
    { allowNetwork: false });
  assert.strictEqual(rastgele.signatures.length, 0);
});

test('bozuk /ByteRange değerleri FORMAT_FAILURE ile reddedilir', async () => {
  const bozuklar = [
    ['[-1 -1 -1 -1]', /negatif/],
    ['[0 999999999999 999999999999 999999999999]', /dosya sonunu aşıyor/],
    ['[0 10 20 30]', /örtüşmüyor/],
    ['[0 10]', /okunamadı|dört sayıdan/]
  ];

  for (const [br, beklenen] of bozuklar) {
    const r = await verifyPdf(sigPdf(br), { allowNetwork: false });
    const s = r.signatures[0];
    assert.ok(s, `${br}: imza girdisi üretilmeli`);
    assert.strictEqual(s.indication, 'TOTAL-FAILED', `${br} kabul edildi`);
    assert.strictEqual(s.subIndication, 'FORMAT_FAILURE');
    assert.ok(beklenen.test(s.errors.join(' ')),
      `${br}: beklenen gerekçe yok — ${s.errors.join(' | ')}`);
  }
});

test('çok sayıda %%EOF revizyon taramasını kilitlemez', async () => {
  const t0 = Date.now();
  await verifyPdf(Buffer.from('%PDF-1.7\n' + '%%EOF\n'.repeat(200_000), 'latin1'),
    { allowNetwork: false });
  const sure = Date.now() - t0;
  assert.ok(sure < 10_000, `${sure}ms sürdü`);
});

test('imza sayısı sınırı: sınırsız iş üretilemez', async () => {
  // Her imza kendi zincirini kurar ve kapsamı farklıysa belgeyi yeniden
  // açtırır. Binlerce imza alanı, doğrulayanın işlemcisini tüketmeye yeter.
  let s = '%PDF-1.7\n';
  for (let i = 0; i < 300; i++) {
    s += `${i} 0 obj\n<< /Type /Sig /SubFilter /ETSI.CAdES.detached ` +
         `/ByteRange [0 ${100 + i} ${200 + i} ${300 + i}] ` +
         `/Contents <${'30'.repeat(4)}${String(i).padStart(4, '0')}> >>\nendobj\n`;
  }
  s += 'trailer\n<< /Size 1 /Root 1 0 R >>\nstartxref\n9\n%%EOF\n';
  const pdf = Buffer.from(s, 'latin1');

  const r = await verifyPdf(pdf, { allowNetwork: false });
  assert.strictEqual(r.signatures.length, 0, 'sınır aşılınca doğrulama yapılmamalı');
  assert.ok(r.warnings.some((w) => /imza alanı var/.test(w)),
    `sınırın aşıldığı bildirilmeli: ${r.warnings.join(' | ')}`);

  // Sınır bilinçli olarak yükseltilebilir.
  const genis = await verifyPdf(pdf, { allowNetwork: false, maxSignatures: 500 });
  assert.strictEqual(genis.signatures.length, 300);
});
