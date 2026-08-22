'use strict';
/**
 * PDF → Sahne → PDF → Sahne turu.
 *
 * BU TESTLERİN SORUSU: belgeyi bir tur döndürdüğümüzde elimizde kalan şey,
 * başladığımız şey mi?
 *
 * "Düğüm var" yetmez. Yanlış yerde duran bir dikdörtgen hiç olmayandan
 * kötüdür; baytı olmayan bir görsel gönderisi ise belgeyi derlenemez yapar.
 * Bu yüzden koordinat, ölçü, dönme ve varlık BAYTLARI tek tek karşılaştırılır.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const zlib = require('zlib');

const { Scene, compileToPdf, importFromPdf } = require('@fitfak/pdf-scene');
const { PdfDocument } = require('@fitfak/pdf-doc');

const ROOT = path.resolve(__dirname, '..', '..');
const FONTS = [{ family: 'Ubuntu', src: path.join(ROOT, 'assets', 'Ubuntu-Regular.ttf') }];

const near = (a, b, tol = 0.6) =>
  assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b} değil (fark ${Math.abs(a - b)})`);

/** Düz renkli PNG — dış bağımlılık olmadan gerçek bir görsel. */
function makePng(w, h, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(w * 3 + 1);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2];
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Görsel + kutu + metin taşıyan kaynak sahne. */
function sourceScene() {
  const s = Scene.blank({ title: 'Tur' });
  const asset = s.assets.add(makePng(8, 8, [200, 30, 40]), { name: 'kirmizi.png' });
  s.transaction('kur', () => {
    s.addNode(Scene.createNode('rect', {
      id: 'r1', x: 40, y: 40, width: 200, height: 60, fill: '#1f3a63'
    }));
    s.addNode(Scene.createNode('image', {
      id: 'i1', x: 60, y: 200, width: 120, height: 90, assetId: asset.id, fit: 'fill'
    }));
    s.addNode(Scene.createNode('text', {
      id: 't1', x: 60, y: 400, width: 300, height: 30, text: 'Merhaba', fontSize: 14
    }));
  });
  return s;
}

const nodesOf = (scene, page = 0) => scene.pages[page].nodes;
const firstOf = (scene, type, page = 0) =>
  nodesOf(scene, page).find((n) => n.type === type);

/* ================================================================== */
/* Varlıklar                                                           */
/* ================================================================== */

test('PDF içindeki görsel, sahneye GERÇEK baytlarıyla döner', () => {
  const pdf = compileToPdf(sourceScene(), { fonts: FONTS }).pdf;
  const { scene } = importFromPdf(pdf, { fonts: FONTS });

  const image = firstOf(scene, 'image');
  assert.ok(image, 'görsel düğümü üretilmeli');
  assert.ok(image.assetId, 'düğüm bir varlığa göndermeli');

  // Kimlik gerçek bir varlığa çıkmalı — geçici bir PDF nesne numarasına değil.
  const meta = scene.assets.get(image.assetId);
  assert.ok(meta, `varlık bulunamadı: ${image.assetId}`);
  assert.strictEqual(meta.kind, 'image');

  const bytes = scene.assets.bytes(image.assetId);
  assert.ok(bytes && bytes.length > 0, 'varlığın BAYTLARI da olmalı');
  assert.strictEqual(meta.width, 8);
  assert.strictEqual(meta.height, 8);

  // Ve sahne kendi kendine geçerli olmalı: gönderi kırıksa doğrulayıcı
  // ERR_ASSET_MISSING verir.
  const { issues } = scene.validate();
  assert.deepStrictEqual(issues, []);
});

test('varlık kimliği İÇERİKTEN türer: aynı görsel iki kez gömülmez', () => {
  const s = Scene.blank({ title: 'İki kez' });
  const png = makePng(6, 6, [10, 20, 30]);
  const asset = s.assets.add(png, { name: 'a.png' });
  s.transaction('kur', () => {
    s.addNode(Scene.createNode('image', {
      x: 10, y: 10, width: 40, height: 40, assetId: asset.id
    }));
    s.addNode(Scene.createNode('image', {
      x: 100, y: 10, width: 40, height: 40, assetId: asset.id
    }));
  });

  const pdf = compileToPdf(s, { fonts: FONTS }).pdf;
  const { scene } = importFromPdf(pdf, { fonts: FONTS });

  const images = nodesOf(scene).filter((n) => n.type === 'image');
  assert.strictEqual(images.length, 2);
  assert.strictEqual(images[0].assetId, images[1].assetId,
    'aynı akış tek varlığa çıkmalı');
  assert.strictEqual(scene.assets.size, 1);
});

test('PDF → Sahne → PDF → Sahne turunda görsel KAYBOLMAZ', () => {
  const first = compileToPdf(sourceScene(), { fonts: FONTS }).pdf;

  const round1 = importFromPdf(first, { fonts: FONTS });
  const image1 = firstOf(round1.scene, 'image');
  assert.ok(image1);

  // İkinci tur: içe aktarılan sahne yeniden derlenebilmeli.
  const second = compileToPdf(round1.scene, {
    assets: round1.scene.assets, fonts: FONTS
  });
  assert.ok(!second.warnings.some((w) => w.code === 'WARN_ASSET_MISSING'),
    `varlık kaybı: ${JSON.stringify(second.warnings)}`);

  const round2 = importFromPdf(second.pdf, { fonts: FONTS });
  const image2 = firstOf(round2.scene, 'image');
  assert.ok(image2, 'ikinci turda da görsel olmalı');

  // Baytlar aynı kalmalı: yeniden kodlama olmamalı.
  assert.strictEqual(image2.assetId, image1.assetId);
  assert.deepStrictEqual(
    round2.scene.assets.bytes(image2.assetId),
    round1.scene.assets.bytes(image1.assetId));

  // Ve yeri de aynı kalmalı.
  near(image2.frame.x, image1.frame.x);
  near(image2.frame.y, image1.frame.y);
  near(image2.frame.width, image1.frame.width);
  near(image2.frame.height, image1.frame.height);
});

/* ================================================================== */
/* Geometri turu                                                       */
/* ================================================================== */

const PAPERS = [
  { name: 'A4 dikey', width: 595.28, height: 841.89 },
  { name: 'A4 yatay', width: 841.89, height: 595.28 },
  { name: 'Letter dikey', width: 612, height: 792 },
  { name: 'Letter yatay', width: 792, height: 612 }
];

for (const paper of PAPERS) {
  test(`${paper.name}: koordinat turda KAYMAZ`, () => {
    const s = Scene.blank({
      title: paper.name,
      size: { width: paper.width, height: paper.height },
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });
    s.transaction('kur', () => {
      s.addNode(Scene.createNode('rect', {
        id: 'r1', x: 40, y: 40, width: 120, height: 60, fill: '#1f3a63'
      }));
      s.addNode(Scene.createNode('rect', {
        id: 'r2', x: paper.width - 160, y: paper.height - 100,
        width: 120, height: 60, fill: '#aa2222'
      }));
    });

    const { scene } = importFromPdf(compileToPdf(s, { fonts: FONTS }).pdf, { fonts: FONTS });

    near(scene.pageGeometry(0).width, paper.width);
    near(scene.pageGeometry(0).height, paper.height);

    const paths = nodesOf(scene).filter((n) => n.type === 'path');
    assert.strictEqual(paths.length, 2, 'iki dikdörtgen de gelmeli');

    const sorted = [...paths].sort((a, b) => a.frame.x - b.frame.x);
    near(sorted[0].frame.x, 40);
    near(sorted[0].frame.y, 40);
    near(sorted[0].frame.width, 120);
    near(sorted[0].frame.height, 60);

    near(sorted[1].frame.x, paper.width - 160);
    near(sorted[1].frame.y, paper.height - 100);
  });
}

for (const rotate of [0, 90, 180, 270]) {
  test(`/Rotate ${rotate}: sayfa ölçüsü ve nesne yeri GÖRÜNENE uyar`, () => {
    const s = Scene.blank({
      title: `dönme ${rotate}`, margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });
    s.transaction('kur', () => {
      s.addNode(Scene.createNode('rect', {
        id: 'r1', x: 40, y: 40, width: 200, height: 60, fill: '#1f3a63'
      }));
    });

    const doc = PdfDocument.load(compileToPdf(s, { fonts: FONTS }).pdf);
    doc.rotatePage(0, rotate);
    const { scene, analysis } = importFromPdf(doc.save(), { fonts: FONTS });

    const swapped = rotate === 90 || rotate === 270;
    const box = scene.pageGeometry(0);
    near(box.width, swapped ? 841.89 : 595.28);
    near(box.height, swapped ? 595.28 : 841.89);
    assert.strictEqual(analysis.pages[0].rotate, rotate);

    // Aynı dönmeyi SAHNE tarafında uygulamak aynı sonucu vermeli: iki yol
    // (PDF /Rotate ve Scene.rotatePage) tek bir gerçeğe çıkmalıdır.
    const mirror = Scene.blank({
      title: 'ayna', margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });
    mirror.transaction('kur', () => {
      mirror.addNode(Scene.createNode('rect', {
        id: 'r1', x: 40, y: 40, width: 200, height: 60, fill: '#1f3a63'
      }));
    });
    mirror.transaction('çevir', () => mirror.rotatePage(mirror.pages[0].id, rotate));

    const geometry = require('@fitfak/pdf-scene').geometry;
    const expected = geometry.rotatedBounds(
      mirror.pages[0].nodes[0].frame, mirror.pages[0].nodes[0].rotation);

    const got = nodesOf(scene).find((n) => n.type === 'path');
    assert.ok(got, 'dikdörtgen gelmeli');
    near(got.frame.x, expected.x);
    near(got.frame.y, expected.y);
    near(got.frame.width, expected.width);
    near(got.frame.height, expected.height);
  });
}

test('/Rotate 90: METİN de çizimle AYNI yere düşer', () => {
  // Eski davranışta metin `pageHeight - y` ile yerleştirildiği için dönmüş
  // sayfalarda çizimlerden koparak sayfanın başka bir köşesine düşüyordu.
  const s = Scene.blank({ title: 'metin', margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  s.transaction('kur', () => {
    // Metnin TAM ÜSTÜNE bir çerçeve: ikisi turda birlikte hareket etmeli.
    s.addNode(Scene.createNode('rect', {
      id: 'kutu', x: 60, y: 400, width: 200, height: 20,
      stroke: '#000000', strokeWidth: 1
    }));
    s.addNode(Scene.createNode('text', {
      id: 't1', x: 60, y: 400, width: 200, height: 20, text: 'Hizada', fontSize: 12
    }));
  });

  const doc = PdfDocument.load(compileToPdf(s, { fonts: FONTS }).pdf);
  doc.rotatePage(0, 90);
  const { scene } = importFromPdf(doc.save(), { fonts: FONTS });

  const geometry = require('@fitfak/pdf-scene').geometry;
  const box = nodesOf(scene).find((n) => n.type === 'path');
  const text = nodesOf(scene).find((n) => n.type === 'text');
  assert.ok(box && text, 'hem çerçeve hem metin gelmeli');

  assert.strictEqual(text.rotation, 90, 'metin sayfayla birlikte dönmeli');

  const textBox = geometry.rotatedBounds(text.frame, text.rotation);
  // Metin, kendi çerçevesinin İÇİNDE kalmalı (birkaç punto pay ile).
  near(textBox.x, box.frame.x, 4);
  near(textBox.y, box.frame.y, 4);
});

test('kayık CropBox: içerik sahnenin BAŞLANGICINA taşınır', () => {
  const s = Scene.blank({ title: 'kırpma', margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  s.transaction('kur', () => {
    s.addNode(Scene.createNode('rect', {
      id: 'r1', x: 100, y: 100, width: 120, height: 60, fill: '#1f3a63'
    }));
  });

  const doc = PdfDocument.load(compileToPdf(s, { fonts: FONTS }).pdf);
  // Sayfanın kenarlarından 20/30 punto kırp: görünen alan küçülür ve
  // başlangıç noktası kayar.
  const page = doc.getPage(0);
  const dict = page.dict;
  const { Name } = require('@fitfak/pdf-doc');
  void Name;
  dict.set('CropBox', [20, 30, 575.28, 811.89]);
  doc.setObject(page.ref ? page.ref.num : doc.allocObjNum(), dict);

  const { scene, analysis } = importFromPdf(doc.save(), { fonts: FONTS });
  const box = scene.pageGeometry(0);
  near(box.width, 555.28);
  near(box.height, 781.89);
  assert.strictEqual(analysis.pages[0].cropped, true);

  const rect = nodesOf(scene).find((n) => n.type === 'path');
  assert.ok(rect);
  // Kaynakta (100,100) idi; kırpma kutusu sol-üstü 20 sağa ve 30 aşağı
  // kaydığı için sahnede (80, 70) olmalıdır.
  near(rect.frame.x, 80);
  near(rect.frame.y, 70);
});

/* ================================================================== */
/* Çok ölçülü belge                                                    */
/* ================================================================== */

test('sayfa ölçüleri farklıysa her sayfa KENDİ ölçüsünü korur', () => {
  const s = Scene.blank({ title: 'karma', margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  s.transaction('kur', () => {
    s.addPage({ id: 'pg2', name: 'Yatay', width: 841.89, height: 595.28 });
    s.addNode(Scene.createNode('rect', {
      id: 'r2', x: 700, y: 500, width: 100, height: 60, fill: '#aa2222'
    }), { pageId: 'pg2' });
  });

  const { scene, warnings, analysis } = importFromPdf(
    compileToPdf(s, { fonts: FONTS }).pdf, { fonts: FONTS });

  assert.strictEqual(scene.pages.length, 2);
  near(scene.pageGeometry(0).width, 595.28);
  near(scene.pageGeometry(1).width, 841.89);
  near(scene.pageGeometry(1).height, 595.28);

  assert.ok(warnings.some((w) => w.code === 'WARN_PAGE_SIZE_MIXED'));
  assert.strictEqual(analysis.uniformSize, false);

  // İkinci sayfadaki nesne, yatay kâğıdın SAĞ ALTINDA kalmalı — dikey bir
  // kâğıda sıkıştırılsaydı sayfanın dışına düşerdi.
  const rect = nodesOf(scene, 1).find((n) => n.type === 'path');
  assert.ok(rect, 'ikinci sayfadaki dikdörtgen gelmeli');
  near(rect.frame.x, 700);
  near(rect.frame.y, 500);
});

/* ================================================================== */
/* İmzalı belge                                                        */
/* ================================================================== */

test('imza ALANI olan belge içe aktarılabilir (hasSignatures çağrılmaz)', () => {
  // `hasSignatures` bir özelliktir; işlev gibi çağrılırsa TypeError verir ve
  // imzalı HER belgenin içe aktarımı daha ilk adımda ölür.
  const s = Scene.blank({ title: 'imzalı', margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  s.transaction('kur', () => {
    s.addNode(Scene.createNode('text', {
      id: 't1', x: 40, y: 40, width: 200, height: 20, text: 'Belge', fontSize: 12
    }));
  });

  const doc = PdfDocument.load(compileToPdf(s, { fonts: FONTS }).pdf);
  const { Dict, Name, Str } = require('@fitfak/pdf-doc');

  // İmza DEĞERİ olan bir alan kur: `hasSignatures` bunu true görür.
  const sig = new Dict();
  sig.set('Type', new Name('Annot'));
  sig.set('Subtype', new Name('Widget'));
  sig.set('FT', new Name('Sig'));
  sig.set('T', new Str(Buffer.from('imza1', 'latin1')));
  sig.set('V', new Dict());
  sig.set('Rect', [100, 100, 300, 180]);
  const sigRef = doc.addObject(sig);

  const acro = new Dict();
  acro.set('Fields', [sigRef]);
  const catalog = doc.catalog;
  catalog.set('AcroForm', doc.addObject(acro));
  doc.setObject(doc.trailer.get('Root').num, catalog);

  const bytes = doc.save();
  const reloaded = PdfDocument.load(bytes);
  assert.strictEqual(reloaded.hasSignatures, true, 'kurulum imzalı olmalı');

  let result;
  assert.doesNotThrow(() => { result = importFromPdf(bytes, { fonts: FONTS }); });
  assert.ok(result.warnings.some((w) => w.code === 'WARN_SIGNATURES_DROPPED'),
    'kullanıcı imzaların taşınmadığını BİLMELİ');
  assert.strictEqual(result.analysis.signatures.signed, true);
  assert.strictEqual(result.analysis.signatures.fieldCount, 1);
});

/* ================================================================== */
/* Çözümleme                                                           */
/* ================================================================== */

test('çözümleme belgenin envanterini çıkarır', () => {
  const { analysis } = importFromPdf(
    compileToPdf(sourceScene(), { fonts: FONTS }).pdf, { fonts: FONTS });

  assert.strictEqual(analysis.pageCount, 1);
  assert.strictEqual(analysis.uniformSize, true);
  assert.deepStrictEqual(analysis.sizes, ['A4 dikey']);
  assert.strictEqual(analysis.orientation, 'portrait');
  assert.strictEqual(analysis.encrypted, false);
  assert.ok(analysis.objects.image >= 1, 'görsel sayılmalı');
  assert.ok(analysis.objects.text >= 1, 'metin sayılmalı');
  assert.ok(analysis.objects.path >= 1, 'vektör sayılmalı');
  assert.strictEqual(analysis.form.fieldCount, 0);
  assert.strictEqual(analysis.form.editability, 'none');
  assert.strictEqual(analysis.issues.length, 0);
});

test('çözümleme sayfa başına dökümü verir', () => {
  const s = Scene.blank({ title: 'iki sayfa', margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  s.transaction('kur', () => {
    s.addNode(Scene.createNode('rect', { x: 10, y: 10, width: 50, height: 50, fill: '#000' }));
    s.addPage({ id: 'pg2' });
    s.addNode(Scene.createNode('text', {
      x: 10, y: 10, width: 100, height: 20, text: 'İki', fontSize: 12
    }), { pageId: 'pg2' });
  });

  const { analysis } = importFromPdf(compileToPdf(s, { fonts: FONTS }).pdf, { fonts: FONTS });
  assert.strictEqual(analysis.pages.length, 2);
  assert.ok(analysis.pages[0].imported.path >= 1);
  assert.ok(analysis.pages[1].imported.text >= 1);
  assert.strictEqual(analysis.pages[0].index, 0);
  assert.strictEqual(analysis.pages[1].index, 1);
});
