'use strict';
/**
 * @fitfak/stamp birim testleri.
 *
 * EN ÖNEMLİ TEST: `classic` şablonunun eski `generateStamp()` çıktısıyla
 * BİREBİR aynı olması. Kullanıcının açık isteği "Code39 yapısını değiştirmek
 * istemem" idi; bu test, o isteğin makine tarafından zorlanan karşılığıdır.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const zlib = require('zlib');

const legacy = require('@fitfak/pades/src/signature/stamp');
const stamp = require('@fitfak/stamp');

const PADES = path.dirname(require.resolve('@fitfak/pades/package.json'));
const FONT = path.join(PADES, 'src/assets/font.ttf');
const LOGO = path.join(PADES, 'src/assets/caduceus.png');

const BASE_VARS = {
  signerName: 'Aybars YILDIRIM',
  role: 'Düzenleyen',
  org: 'Cumhuriyet Üniversitesi',
  date: new Date('2026-08-18T12:00:00Z'),
  docNo: 'DOC-M2K4J7-X9A3B1',
  verifyUrl: 'https://dogrula.fitfak.net/d/M2K4J7X9A3B1',
  logo: LOGO
};

/* ------------------------------------------------------------------ */
/* Geriye dönük uyum                                                    */
/* ------------------------------------------------------------------ */

test('GERİYE UYUM: classic şablonu eski çıktıyla bit-bit aynı', () => {
  const cases = [
    { seed: 42,   core: 'DOC-TEST-123', name: 'Aybars YILDIRIM' },
    { seed: 7,    core: 'ABC-999',      name: 'Mehmet Ali KAYA' },
    { seed: 999,  core: 'X',            name: 'Zeynep' },
    { seed: 2024, core: 'FITFAK-2026',  name: 'Çağrı Şükrü ÖZTÜRK' }
  ];

  for (const c of cases) {
    const old = legacy.generateStamp({
      fontPath: FONT, pngLogoPath: LOGO,
      personName: c.name, seed: c.seed, barcodeCore: c.core
    });
    const neu = stamp.renderStamp({
      template: 'classic', font: FONT, seed: c.seed,
      vars: { signerName: c.name, docNo: c.core, logo: LOGO }
    }).png;

    assert.ok(old.equals(neu),
      `classic çıktısı değişmiş (seed=${c.seed}, ad="${c.name}") — ` +
      `eski ${old.length} bayt, yeni ${neu.length} bayt`);
  }
});

test('Code39 tablosu tek kaynaktan gelir (kopyalanmamış)', () => {
  assert.strictEqual(stamp.CODE39_MAP, legacy.CODE39_MAP,
    'CODE39_MAP aynı nesne olmalı — kopya varsa zamanla ayrışır');
  assert.strictEqual(Object.keys(stamp.CODE39_MAP).length, 44);
});

/* ------------------------------------------------------------------ */
/* Şablonlar                                                            */
/* ------------------------------------------------------------------ */

for (const name of ['classic', 'qr', 'dual', 'minimal', 'kurumsal']) {
  test(`şablon "${name}" geçerli PNG üretir`, () => {
    const r = stamp.renderStamp({ template: name, font: FONT, seed: 1, vars: BASE_VARS });

    assert.ok(Buffer.isBuffer(r.png));
    assert.strictEqual(r.png.slice(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG imzası');
    assert.ok(r.png.length > 1000, 'PNG boş olmamalı');

    // IHDR boyutları döndürülen ölçülerle uyuşmalı
    const w = r.png.readUInt32BE(16);
    const h = r.png.readUInt32BE(20);
    assert.strictEqual(w, r.width);
    assert.strictEqual(h, r.height);
  });
}

test('handwritten şablonu: imza görseli yoksa da çalışır (koşullu slot)', () => {
  const r = stamp.renderStamp({ template: 'handwritten', font: FONT, vars: BASE_VARS });
  assert.ok(r.png.length > 1000);
});

test('QR slotu: içerik gerçekten kodlanır ve raporlanır', () => {
  const r = stamp.renderStamp({ template: 'qr', font: FONT, seed: 1, vars: BASE_VARS });
  assert.ok(r.rendered.qr, 'QR bilgisi raporlanmalı');
  assert.strictEqual(r.rendered.qr.value, BASE_VARS.verifyUrl);
  assert.ok(r.rendered.qr.size >= 21, 'QR matris boyutu makul olmalı');
});

test('dual şablonu: hem Code39 hem QR içerir', () => {
  const r = stamp.renderStamp({ template: 'dual', font: FONT, seed: 1, vars: BASE_VARS });
  assert.ok(r.rendered.qr, 'QR üretilmeli');
  assert.strictEqual(r.rendered.code39, 'DOC-M2K4J7-X9A3B1', 'Code39 üretilmeli');
});

test('şablon çıktısı belirlenimci: aynı girdi aynı PNG', () => {
  const a = stamp.renderStamp({ template: 'dual', font: FONT, seed: 5, vars: BASE_VARS }).png;
  const b = stamp.renderStamp({ template: 'dual', font: FONT, seed: 5, vars: BASE_VARS }).png;
  assert.ok(a.equals(b));
});

test('farklı tohum farklı doku üretir', () => {
  const a = stamp.renderStamp({ template: 'dual', font: FONT, seed: 1, vars: BASE_VARS }).png;
  const b = stamp.renderStamp({ template: 'dual', font: FONT, seed: 2, vars: BASE_VARS }).png;
  assert.ok(!a.equals(b), 'doku tohumu çıktıyı etkilemeli');
});

/* ------------------------------------------------------------------ */
/* Code39 yardımcıları                                                  */
/* ------------------------------------------------------------------ */

test('sanitizeCode39: alfabe dışı karakterleri temizler', () => {
  assert.strictEqual(stamp.sanitizeCode39('DOC-123', false), 'DOC-123');
  assert.strictEqual(stamp.sanitizeCode39('doc-123', false), 'DOC-123', 'büyük harfe çevirmeli');
  assert.strictEqual(stamp.sanitizeCode39('AB@CD', false), 'AB-CD', 'geçersiz karakter yerine tire');
  assert.strictEqual(stamp.sanitizeCode39('*AB*', false), 'AB', 'yıldız gövdede olamaz');
});

test('code39CheckDigit: mod-43 doğru hesaplanır', () => {
  // Bilinen örnek: "CODE39" → kontrol karakteri
  const cd = stamp.code39CheckDigit('CODE39');
  assert.strictEqual(cd.length, 1);
  assert.ok(stamp.CODE39_MAP[cd], 'kontrol karakteri Code39 alfabesinde olmalı');

  // Toplam mantığı: her karakterin indeks toplamı mod 43
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
  let sum = 0;
  for (const ch of 'CODE39') sum += alphabet.indexOf(ch);
  assert.strictEqual(cd, alphabet[sum % 43]);
});

test('check digit varsayılan olarak KAPALI (eski çıktı korunur)', () => {
  const without = stamp.sanitizeCode39('DOC-1', false);
  const withCd = stamp.sanitizeCode39('DOC-1', true);
  assert.strictEqual(without, 'DOC-1');
  assert.strictEqual(withCd.length, without.length + 1);
});

/* ------------------------------------------------------------------ */
/* Yer tutucular                                                        */
/* ------------------------------------------------------------------ */

test('interpolate: değişkenleri doldurur, eksikleri boşa çevirir', () => {
  assert.strictEqual(stamp.interpolate('{a}-{b}', { a: 'X', b: 'Y' }), 'X-Y');
  assert.strictEqual(stamp.interpolate('{a}-{yok}', { a: 'X' }), 'X-');
  assert.strictEqual(stamp.interpolate('düz metin', {}), 'düz metin');
});

test('bilinmeyen şablon net hata verir', () => {
  assert.throws(
    () => stamp.renderStamp({ template: 'olmayan', font: FONT, vars: {} }),
    (e) => e.code === 'ERR_STAMP_TEMPLATE'
  );
});

test('font verilmezse net hata verir', () => {
  assert.throws(
    () => stamp.renderStamp({ template: 'minimal', vars: {} }),
    (e) => e.code === 'ERR_STAMP_FONT'
  );
});
