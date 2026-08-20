'use strict';
/**
 * Font kimliği okuma ve kayıt defteri.
 *
 * İKİ İDDİA:
 *   1. Bir fontun ailesi/ağırlığı/eğikliği DOSYA ADINDAN değil, fontun
 *      kendi tablolarından okunur. Dosya adı belgeden gelir ve yalan
 *      söyleyebilir.
 *   2. İstemci font DOSYA YOLU veremez; yalnız AİLE ADI seçer. Kayıt
 *      defteri dizin dışına çıkamaz.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readFontInfo, styleFromName } = require('@fitfak/pdf/src/fonts/FontInfo');
const { FontRegistry, normalizeFamily } = require('@fitfak/pdf-html/src/font/registry');

const ROOT = path.resolve(__dirname, '..', '..');
const UBUNTU = path.join(ROOT, 'assets', 'Ubuntu-Regular.ttf');
const OPENSANS = path.join(ROOT, 'packages', 'pades', 'src', 'assets', 'font.ttf');

const hasCode = (code) => (err) => err && err.code === code;

/* ================================================================== */
/* Font kimliği                                                        */
/* ================================================================== */

test('font: aile ve varyant fontun KENDİ tablolarından okunur', () => {
  const info = readFontInfo(fs.readFileSync(UBUNTU));
  assert.strictEqual(info.family, 'Ubuntu');
  assert.strictEqual(info.subfamily, 'Regular');
  assert.strictEqual(info.weight, 400);
  assert.strictEqual(info.italic, false);
  assert.strictEqual(info.style, 'normal');
  assert.strictEqual(info.unitsPerEm, 1000);
  assert.ok(info.ascender > 0 && info.descender < 0);
  assert.strictEqual(info.format, 'truetype');
});

test('font: kalın varyant OS/2 den doğru okunur', () => {
  const info = readFontInfo(fs.readFileSync(OPENSANS));
  assert.strictEqual(info.family, 'Open Sans Condensed');
  assert.strictEqual(info.weight, 700);
  assert.strictEqual(info.style, 'normal');
  assert.strictEqual(info.unitsPerEm, 2048);
});

test('font: DOSYA ADI yalan söylerse font kazanır', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitfak-fontname-'));
  try {
    // Ubuntu Regular'ı "Helvetica-Black-Italic.ttf" diye adlandırıyoruz
    const lying = path.join(dir, 'Helvetica-Black-Italic.ttf');
    fs.copyFileSync(UBUNTU, lying);

    const registry = new FontRegistry();
    registry.scanDirectory(dir);

    assert.deepStrictEqual(registry.familyNames(), ['Ubuntu']);
    const face = registry.resolve('Ubuntu', 400, 'normal');
    assert.strictEqual(face.weight, 400, 'ad "Black" diyor, font 400 diyor');
    assert.strictEqual(face.style, 'normal', 'ad "Italic" diyor, font değil');
    assert.strictEqual(registry.has('Helvetica'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('font: ad tabanlı çıkarım yalnız YEDEK olarak kullanılır', () => {
  assert.deepStrictEqual(styleFromName('Bold Italic'), { weight: 700, italic: true });
  assert.deepStrictEqual(styleFromName('SemiBold'), { weight: 600, italic: false });
  assert.deepStrictEqual(styleFromName('ExtraLight Oblique'), { weight: 200, italic: true });
  assert.deepStrictEqual(styleFromName('Regular'), { weight: 400, italic: false });
  assert.deepStrictEqual(styleFromName(''), { weight: 400, italic: false });
});

test('font: düz Uint8Array girdisi de okunur (tarayıcı yolu)', () => {
  // Tarayıcıda girdi `Buffer` DEĞİL, düz `Uint8Array`dir. Okuyucu `Buffer`
  // metotlarına dayanırsa orada sessizce çöp okur ve font "adsız" sanılır.
  const bytes = new Uint8Array(fs.readFileSync(UBUNTU));
  assert.strictEqual(Buffer.isBuffer(bytes), false);

  const info = readFontInfo(bytes);
  assert.strictEqual(info.family, 'Ubuntu');
  assert.deepStrictEqual(info, readFontInfo(fs.readFileSync(UBUNTU)));
});

test('font: okuma girdiyi DEĞİŞTİRMEZ', () => {
  const original = fs.readFileSync(UBUNTU);
  const copy = Buffer.from(original);
  readFontInfo(copy);
  assert.ok(copy.equals(original), 'font baytları okunurken bozulmamalı');
});

test('font: bozuk ve desteklenmeyen dosyalar açık kodla reddedilir', () => {
  assert.throws(() => readFontInfo(Buffer.alloc(4)), hasCode('ERR_FONT_TRUNCATED'));
  assert.throws(() => readFontInfo(Buffer.alloc(64, 0x41)), hasCode('ERR_FONT_FORMAT'));

  // 'ttcf' — font koleksiyonu
  const ttc = Buffer.alloc(64);
  ttc.write('ttcf', 0, 'latin1');
  assert.throws(() => readFontInfo(ttc), hasCode('ERR_FONT_COLLECTION'));
});

/* ================================================================== */
/* Kayıt defteri                                                       */
/* ================================================================== */

test('kayıt: dizin taranır, aileler indekslenir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitfak-fontdir-'));
  try {
    fs.copyFileSync(UBUNTU, path.join(dir, 'a.ttf'));
    fs.copyFileSync(OPENSANS, path.join(dir, 'b.ttf'));
    fs.writeFileSync(path.join(dir, 'okuma.txt'), 'font değil');

    const registry = new FontRegistry();
    const stats = registry.scanDirectory(dir);

    assert.strictEqual(stats.added, 2);
    assert.deepStrictEqual(registry.familyNames(), ['Open Sans Condensed', 'Ubuntu']);
    assert.strictEqual(registry.size, 2);

    const described = registry.describe();
    assert.strictEqual(described.length, 2);
    assert.deepStrictEqual(described[0].variants, [
      { weight: 700, style: 'normal', subfamily: 'Bold' }
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('kayıt: aile adı büyük/küçük harf ve boşluktan bağımsız eşleşir', () => {
  assert.strictEqual(normalizeFamily('  Open   Sans  '), 'open sans');
  const registry = new FontRegistry();
  registry.register({ file: UBUNTU });
  assert.strictEqual(registry.has('UBUNTU'), true);
  assert.strictEqual(registry.has(' ubuntu '), true);
  assert.strictEqual(registry.has('Ubuntuu'), false);
});

test('kayıt: dizin DIŞINA sembolik bağ font sayılmaz', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitfak-fontlink-'));
  try {
    // Kum havuzunun içinde, dışarıyı gösteren bir bağ
    fs.symlinkSync(UBUNTU, path.join(dir, 'kacak.ttf'));

    const registry = new FontRegistry();
    const stats = registry.scanDirectory(dir);

    assert.strictEqual(stats.added, 0, 'dışarıyı gösteren bağ yüklenmemeli');
    assert.strictEqual(stats.skipped, 1);
    assert.ok(registry.skipped.some((s) => /sembolik/.test(s.reason)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('kayıt: bozuk bir font bütün taramayı düşürmez', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitfak-fontbad-'));
  try {
    fs.copyFileSync(UBUNTU, path.join(dir, 'iyi.ttf'));
    fs.writeFileSync(path.join(dir, 'bozuk.ttf'), Buffer.alloc(200, 0x41));

    const registry = new FontRegistry();
    const stats = registry.scanDirectory(dir);

    assert.strictEqual(stats.added, 1);
    assert.strictEqual(stats.skipped, 1);
    assert.strictEqual(registry.has('Ubuntu'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('kayıt: boyut sınırı uygulanır', () => {
  const registry = new FontRegistry({ maxBytes: 1000 });
  assert.throws(() => registry.register({ file: UBUNTU }), hasCode('ERR_FONT_TOO_LARGE'));
});

test('kayıt: facesFor bulunamayan aileleri BİLDİRİR, sessizce geçmez', () => {
  const registry = new FontRegistry();
  registry.register({ file: UBUNTU });

  const { faces, missing } = registry.facesFor(['Ubuntu', 'Helvetica', 'Yok']);
  assert.strictEqual(faces.length, 1);
  assert.strictEqual(faces[0].family, 'Ubuntu');
  assert.deepStrictEqual(missing, ['Helvetica', 'Yok']);
});

test('kayıt: aynı ağırlık+stil ikinci kez gelirse İLK kayıt korunur', () => {
  const registry = new FontRegistry();
  const first = registry.register({ file: UBUNTU });
  registry.register({ bytes: fs.readFileSync(UBUNTU) });

  assert.strictEqual(registry.size, 1);
  assert.strictEqual(registry.resolve('Ubuntu', 400, 'normal').origin, first.origin);
});

test('kayıt: en yakın varyant seçilir', () => {
  const registry = new FontRegistry();
  registry.register({ file: UBUNTU });                                   // 400 normal
  registry.register({ file: OPENSANS, family: 'Ubuntu', weight: 700, style: 'normal' });
  registry.register({ file: OPENSANS, family: 'Ubuntu', weight: 400, style: 'italic' });

  assert.strictEqual(registry.resolve('Ubuntu', 700, 'normal').weight, 700);
  assert.strictEqual(registry.resolve('Ubuntu', 400, 'italic').style, 'italic');
  // 600 istendiğinde 700, 400'e göre daha yakındır
  assert.strictEqual(registry.resolve('Ubuntu', 600, 'normal').weight, 700);
});

/* ================================================================== */
/* Derleyiciyle tümleşme                                               */
/* ================================================================== */

test('derleyici: bilinmeyen aile SESSİZCE ikame edilmez, uyarılır', () => {
  const { Scene, compileToPdf } = require('@fitfak/pdf-scene');
  const s = Scene.blank();
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('text', {
      x: 20, y: 20, width: 300, height: 40,
      text: 'Bu metin hangi fontla çizildi?', fontFamily: 'Helvetica Neue'
    }));
  });

  const { pdf, warnings } = compileToPdf(s, { fonts: [{ family: 'Ubuntu', src: UBUNTU }] });
  assert.ok(pdf.length > 1000, 'belge yine de üretilmeli');

  const fallback = warnings.find((w) => w.code === 'WARN_FONT_FALLBACK');
  assert.ok(fallback, `uyarı bekleniyordu: ${JSON.stringify(warnings)}`);
  assert.strictEqual(fallback.family, 'Helvetica Neue');
});

test('derleyici: aynı eksik aile bir KEZ uyarılır', () => {
  const { Scene, compileToPdf } = require('@fitfak/pdf-scene');
  const s = Scene.blank();
  s.transaction('Kur', () => {
    for (let i = 0; i < 5; i++) {
      s.addNode(Scene.createNode('text', {
        x: 20, y: 20 + i * 30, width: 300, height: 25,
        text: 'satır ' + i, fontFamily: 'Yok'
      }));
    }
  });

  const { warnings } = compileToPdf(s, { fonts: [{ family: 'Ubuntu', src: UBUNTU }] });
  assert.strictEqual(warnings.filter((w) => w.code === 'WARN_FONT_FALLBACK').length, 1);
});

test('derleyici: kullanıcının YÜKLEDİĞİ font varlık havuzundan gömülür', () => {
  const { Scene, compileToPdf } = require('@fitfak/pdf-scene');
  const s = Scene.blank();

  const asset = s.assets.add(fs.readFileSync(OPENSANS), { name: 'ozel.ttf' });
  assert.strictEqual(asset.kind, 'font');

  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('text', {
      x: 20, y: 20, width: 400, height: 40,
      text: 'Yüklenen fontla yazıldı', fontSize: 16,
      // Aile adı fontun KENDİ tablosundan gelir, dosya adından değil
      fontFamily: 'Open Sans Condensed'
    }));
  });

  const { pdf, warnings } = compileToPdf(s, { fonts: [{ family: 'Ubuntu', src: UBUNTU }] });
  assert.ok(!warnings.some((w) => w.code === 'WARN_FONT_FALLBACK'),
    `yüklenen font bulunmalıydı: ${JSON.stringify(warnings)}`);

  const { PdfDocument } = require('@fitfak/pdf-doc');
  const doc = PdfDocument.load(pdf);
  const text = doc.extractText(0);
  assert.match(String(text.text !== undefined ? text.text : text), /Yüklenen fontla yazıldı/);
});

test('derleyici: bozuk gömülü font belgeyi düşürmez, uyarır', () => {
  const { Scene, compileToPdf, AssetManager } = require('@fitfak/pdf-scene');

  // Varlık yöneticisi geçerli TTF imzası ister; imzayı taşıyıp gövdeyi
  // bozuyoruz — böylece "font sanılan ama okunamayan" durum oluşuyor.
  const broken = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.alloc(200, 0x41)]);
  const assets = new AssetManager();
  assets.add(broken, { name: 'bozuk.ttf' });

  const doc = Scene.blank().toJSON();
  doc.assets = assets.manifest();
  doc.pages[0].nodes = [{
    id: 't', type: 'text', frame: { x: 10, y: 10, width: 200, height: 30 }, text: 'metin'
  }];

  const { pdf, warnings } = compileToPdf(doc, {
    assets, fonts: [{ family: 'Ubuntu', src: UBUNTU }]
  });
  assert.ok(pdf.length > 500);
  assert.ok(warnings.some((w) => /font/i.test(w.message)), JSON.stringify(warnings));
});
