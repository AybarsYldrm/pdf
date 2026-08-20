'use strict';
/**
 * PDF içe aktarmada VEKTÖR ve GÖRSEL.
 *
 * Bu testlerin ortak sorusu: "geri getirilen şey, gönderilen şey mi?"
 * Koordinat, renk, dolgu kuralı ve görsel baytları tek tek karşılaştırılır.
 * Bir düğümün "var olması" yetmez — yanlış yerde duran bir dikdörtgen,
 * hiç olmayan bir dikdörtgenden daha kötüdür.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const zlib = require('zlib');

const { Scene, compileToPdf } = require('@fitfak/pdf-scene');
const { importFromPdf } = require('@fitfak/pdf-scene/src/import/pdf');
const gfx = require('@fitfak/pdf-scene/src/import/pdfgraphics');
const { extractImage, writePng } = require('@fitfak/pdf-scene/src/import/pdfimage');
const { PdfDocument, PdfEditor } = require('@fitfak/pdf-doc');

const ROOT = path.resolve(__dirname, '..', '..');
const FONTS = [{ family: 'Ubuntu', src: path.join(ROOT, 'assets', 'Ubuntu-Regular.ttf') }];

/** Düz renkli PNG. */
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

/** Kaynak belge: dikdörtgen, elips, görsel, metin. */
function sourcePdf() {
  const s = Scene.blank({ title: 'Kaynak' });
  const asset = s.assets.add(makePng(4, 4, [200, 30, 40]), { name: 'kirmizi.png' });
  s.transaction('kur', () => {
    s.addNode(Scene.createNode('rect', {
      id: 'r1', x: 40, y: 40, width: 200, height: 60, fill: '#1f3a63'
    }));
    s.addNode(Scene.createNode('ellipse', {
      id: 'e1', x: 300, y: 40, width: 80, height: 80,
      fill: '#00aa55', stroke: '#000000', strokeWidth: 2
    }));
    s.addNode(Scene.createNode('image', {
      id: 'i1', x: 60, y: 200, width: 120, height: 90, assetId: asset.id, fit: 'fill'
    }));
    s.addNode(Scene.createNode('text', {
      id: 't1', x: 60, y: 400, width: 300, height: 30, text: 'Merhaba', fontSize: 14
    }));
  });
  return compileToPdf(s, { fonts: FONTS }).pdf;
}

/* ================================================================== */
/* Sayfa matrisi                                                       */
/* ================================================================== */

test('sayfa matrisi: y ekseni çevrilir, kırpma kutusu kayması düşülür', () => {
  const m = gfx.pageMatrix({ rotate: 0, cropBox: [0, 0, 595, 842], rawWidth: 595, rawHeight: 842 });
  assert.deepStrictEqual(gfx.applyM(m, 0, 842), [0, 0]);        // sol üst
  assert.deepStrictEqual(gfx.applyM(m, 0, 0), [0, 842]);        // sol alt

  const off = gfx.pageMatrix({ rotate: 0, cropBox: [20, 30, 615, 872], rawWidth: 595, rawHeight: 842 });
  assert.deepStrictEqual(gfx.applyM(off, 20, 872), [0, 0]);
});

test('sayfa matrisi: /Rotate 90 kullanıcının GÖRDÜĞÜ yerleşimi verir', () => {
  // 90° dönmüş bir sayfada PDF'in sol-altı, ekranda sol-ÜSTtür.
  const m = gfx.pageMatrix({ rotate: 90, cropBox: [0, 0, 595, 842], rawWidth: 595, rawHeight: 842 });
  assert.deepStrictEqual(gfx.applyM(m, 0, 0), [0, 0]);
  assert.deepStrictEqual(gfx.applyM(m, 595, 0), [0, 595]);
  assert.deepStrictEqual(gfx.applyM(m, 0, 842), [842, 0]);
});

test('birim kare yerleşimi: dönmemiş görsel doğrudan çerçeveye oturur', () => {
  const page = gfx.pageMatrix({ rotate: 0, cropBox: [0, 0, 595, 842], rawWidth: 595, rawHeight: 842 });
  const place = gfx.placeUnitSquare(gfx.concat([100, 0, 0, 50, 20, 700], page));
  assert.deepStrictEqual(
    { x: place.x, y: place.y, width: place.width, height: place.height, rotation: place.rotation },
    { x: 20, y: 92, width: 100, height: 50, rotation: 0 });
  assert.strictEqual(place.skewed, false);
  assert.strictEqual(place.mirrored, false);
});

test('birim kare yerleşimi: dönmüş görselde çerçeve DÖNMEMİŞ hâliyle verilir', () => {
  // Sahne düğümü "dönmemiş çerçeve + merkez etrafında dönme"dir. Dönmüş
  // dikdörtgenin köşesini x/y yazmak nesneyi kaydırırdı.
  const page = gfx.pageMatrix({ rotate: 0, cropBox: [0, 0, 595, 842], rawWidth: 595, rawHeight: 842 });
  const place = gfx.placeUnitSquare(gfx.concat([0, 100, -50, 0, 20, 700], page));

  assert.strictEqual(Math.round(place.width), 100);
  assert.strictEqual(Math.round(place.height), 50);
  assert.strictEqual(Math.round(place.rotation), 270);

  // Merkez, PDF'teki gerçek merkezle aynı olmalı: x ∈ [-30,20], y ∈ [42,142]
  assert.strictEqual(Math.round(place.x + place.width / 2), -5);
  assert.strictEqual(Math.round(place.y + place.height / 2), 92);
});

test('birim kare yerleşimi: eğrilme ve aynalama BİLDİRİLİR', () => {
  const page = gfx.pageMatrix({ rotate: 0, cropBox: [0, 0, 595, 842], rawWidth: 595, rawHeight: 842 });
  assert.strictEqual(gfx.placeUnitSquare(gfx.concat([100, 0, 40, 50, 0, 0], page)).skewed, true);
  // d < 0: görsel dikey aynalanmış demektir (normal matriste d > 0'dır)
  assert.strictEqual(gfx.placeUnitSquare(gfx.concat([100, 0, 0, -50, 0, 100], page)).mirrored, true);
});

/* ================================================================== */
/* Vektör                                                              */
/* ================================================================== */

test('içe aktarma: dikdörtgen dolgusu AYNI yerde ve AYNI renkte döner', () => {
  const { scene, warnings } = importFromPdf(sourcePdf(), { fonts: FONTS });
  const paths = scene.pages[0].nodes.filter((n) => n.type === 'path');

  const rect = paths.find((n) => n.fill === '#1f3a63');
  assert.ok(rect, `dikdörtgen bulunamadı: ${JSON.stringify(paths.map((p) => p.fill))}`);
  assert.deepStrictEqual(rect.frame, { x: 40, y: 40, width: 200, height: 60 });
  assert.strictEqual(warnings.some((w) => w.code === 'WARN_IMPORT_FLATTENED'), true);
});

test('içe aktarma: elips eğrileriyle birlikte gelir (kutuya bozulmaz)', () => {
  const { scene } = importFromPdf(sourcePdf(), { fonts: FONTS });
  const fill = scene.pages[0].nodes.find((n) => n.type === 'path' && n.fill === '#00aa55');

  assert.ok(fill);
  assert.deepStrictEqual(fill.frame, { x: 300, y: 40, width: 80, height: 80 });
  assert.ok(fill.d.some((c) => c[0] === 'C'), 'kübik eğri komutu korunmalı');
  assert.strictEqual(fill.d[fill.d.length - 1][0], 'Z');
});

test('içe aktarma: kontur ayrı düğüm olur ve kalınlığı korunur', () => {
  const { scene } = importFromPdf(sourcePdf(), { fonts: FONTS });
  const stroke = scene.pages[0].nodes.find((n) => n.type === 'path' && n.stroke === '#000000');

  assert.ok(stroke);
  assert.strictEqual(stroke.strokeWidth, 2);
  assert.strictEqual(stroke.fill, undefined, 'kontur düğümünün dolgusu olmamalı');
});

test('içe aktarma: yol verisi düğümün KENDİ uzayındadır', () => {
  const { scene } = importFromPdf(sourcePdf(), { fonts: FONTS });
  const rect = scene.pages[0].nodes.find((n) => n.type === 'path' && n.fill === '#1f3a63');

  // İlk nokta (0,0) civarında olmalı: veri çerçeveye göre saklanır ki
  // düğümü taşımak veriyi yeniden yazmayı gerektirmesin.
  const xs = rect.d.filter((c) => c.length > 1).map((c) => c[1]);
  const ys = rect.d.filter((c) => c.length > 1).map((c) => c[2]);
  assert.strictEqual(Math.min(...xs), 0);
  assert.strictEqual(Math.min(...ys), 0);
  assert.strictEqual(Math.max(...xs), 200);
  assert.strictEqual(Math.max(...ys), 60);
});

test('içe aktarma: `graphics:false` ile çizimler İSTENMEZSE gelmez', () => {
  const { scene, warnings } = importFromPdf(sourcePdf(), { fonts: FONTS, graphics: false });
  assert.strictEqual(scene.pages[0].nodes.some((n) => n.type === 'path'), false);
  assert.match(warnings.find((w) => w.code === 'WARN_IMPORT_FLATTENED').message, /istenmedi/);
});

test('içe aktarma → derleme turu: yol yeniden çizilebilir', () => {
  const { scene } = importFromPdf(sourcePdf(), { fonts: FONTS });
  const { pdf, warnings } = compileToPdf(scene, { fonts: FONTS, compress: false });

  assert.deepStrictEqual(warnings.filter((w) => w.code !== 'WARN_TEXT_OVERFLOW'), []);
  const raw = pdf.toString('latin1');
  assert.match(raw, /0\.122 0\.227 0\.388 rg/, 'dikdörtgen rengi korunmalı');
  assert.match(raw, / c\n/, 'elips eğrileri korunmalı');
});

/* ================================================================== */
/* Görsel                                                              */
/* ================================================================== */

test('içe aktarma: görsel varlık olarak çıkar ve doğru yere konur', () => {
  const { scene } = importFromPdf(sourcePdf(), { fonts: FONTS });
  const image = scene.pages[0].nodes.find((n) => n.type === 'image');

  assert.ok(image, 'görsel düğümü bulunamadı');
  assert.deepStrictEqual(image.frame, { x: 60, y: 200, width: 120, height: 90 });
  assert.strictEqual(image.fit, 'fill');

  const meta = scene.assets.get(image.assetId);
  assert.ok(meta, 'varlık kaydı olmalı');
  assert.strictEqual(meta.width, 4);
  assert.strictEqual(meta.height, 4);
});

test('içe aktarma: görsel PİKSELLERİ korunur (renk kaybolmaz)', () => {
  const { scene } = importFromPdf(sourcePdf(), { fonts: FONTS });
  const image = scene.pages[0].nodes.find((n) => n.type === 'image');
  const bytes = scene.assets.bytes(image.assetId);

  // PNG'yi geri çöz: IDAT içindeki ilk pikselin rengi kaynaktakiyle aynı mı?
  assert.strictEqual(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const idat = findChunk(bytes, 'IDAT');
  const raw = zlib.inflateSync(idat);
  assert.strictEqual(raw[0], 0, 'süzgeç baytı 0 (None) olmalı');
  assert.deepStrictEqual([raw[1], raw[2], raw[3]], [200, 30, 40]);
});

test('görsel çıkarma: JPEG baytları YENİDEN KODLANMAZ', () => {
  // Kayıplı bir görüntüyü ikinci kez kaybettirmemek için DCTDecode akışı
  // olduğu gibi alınır.
  const jpeg = tinyJpeg();
  const doc = PdfDocument.load(pdfWithImage(jpeg, 'jpeg'));
  const stream = firstImageXObject(doc);

  const out = extractImage(doc, stream);
  assert.strictEqual(out.mime, 'image/jpeg');
  assert.strictEqual(Buffer.compare(out.bytes, jpeg), 0, 'baytlar birebir aynı olmalı');
});

test('görsel çıkarma: gri tonlamalı örnekler PNG olur', () => {
  const doc = PdfDocument.load(pdfWithRawImage({
    width: 2, height: 2, colorSpace: 'DeviceGray', bpc: 8,
    samples: Buffer.from([0, 64, 128, 255])
  }));
  const out = extractImage(doc, firstImageXObject(doc));

  assert.strictEqual(out.mime, 'image/png');
  const raw = zlib.inflateSync(findChunk(out.bytes, 'IDAT'));
  // Satır başına bir süzgeç baytı + 2 örnek
  assert.deepStrictEqual([...raw], [0, 0, 64, 0, 128, 255]);
});

test('görsel çıkarma: indeksli palet PNG paletine çevrilir', () => {
  const doc = PdfDocument.load(pdfWithRawImage({
    width: 2, height: 1, bpc: 8,
    colorSpaceRaw: '[/Indexed /DeviceRGB 1 <FF000000FF00>]',
    samples: Buffer.from([0, 1])
  }));
  const out = extractImage(doc, firstImageXObject(doc));

  const plte = findChunk(out.bytes, 'PLTE');
  assert.deepStrictEqual([...plte], [0xff, 0, 0, 0, 0xff, 0]);
  const raw = zlib.inflateSync(findChunk(out.bytes, 'IDAT'));
  assert.deepStrictEqual([...raw], [0, 0, 1]);
});

test('görsel çıkarma: ImageMask ÇEVRİLMEZ ve bunu söyler', () => {
  const doc = PdfDocument.load(pdfWithRawImage({
    width: 8, height: 1, bpc: 1, imageMask: true,
    samples: Buffer.from([0b10101010])
  }));
  assert.throws(() => extractImage(doc, firstImageXObject(doc)),
    (err) => err.code === 'ERR_IMG_STENCIL');
});

test('görsel çıkarma: çözülemeyen filtre SESSİZCE geçilmez', () => {
  const doc = PdfDocument.load(pdfWithRawImage({
    width: 4, height: 4, bpc: 8, colorSpace: 'DeviceRGB',
    filter: '/JPXDecode', samples: Buffer.from([1, 2, 3, 4])
  }));
  assert.throws(() => extractImage(doc, firstImageXObject(doc)),
    (err) => err.code === 'ERR_IMG_FILTER' && /JPX/.test(err.message));
});

test('görsel çıkarma: aşırı büyük görsel piksel sınırında durur', () => {
  const doc = PdfDocument.load(pdfWithRawImage({
    width: 30000, height: 30000, bpc: 8, colorSpace: 'DeviceRGB',
    samples: Buffer.from([0, 0, 0])
  }));
  assert.throws(() => extractImage(doc, firstImageXObject(doc)),
    (err) => err.code === 'ERR_IMG_PIXELS');
});

test('içe aktarma: çözülemeyen görsel düğüm üretmez ama UYARIR', () => {
  const doc = pdfWithRawImage({
    width: 4, height: 4, bpc: 8, colorSpace: 'DeviceRGB',
    filter: '/JPXDecode', samples: Buffer.from([1, 2, 3, 4]), draw: true
  });
  const { scene, warnings } = importFromPdf(doc, { fonts: FONTS });

  assert.strictEqual(scene.pages[0].nodes.some((n) => n.type === 'image'), false);
  assert.ok(warnings.some((w) => w.code === 'WARN_IMPORT_IMAGE_FAILED'),
    JSON.stringify(warnings.map((w) => w.code)));
});

/* ================================================================== */
/* Sınırlar ve dürüstlük                                               */
/* ================================================================== */

test('içe aktarma: düğüm bütçesi dolunca kalanı ALINMADIĞINI söyler', () => {
  const s = Scene.blank({ title: 'Çok çizgi' });
  s.transaction('kur', () => {
    for (let i = 0; i < 40; i++) {
      s.addNode(Scene.createNode('rect', {
        x: 10 + i, y: 10, width: 5, height: 5, fill: '#123456'
      }));
    }
  });
  const pdf = compileToPdf(s, { fonts: FONTS }).pdf;

  const { scene, warnings } = importFromPdf(pdf, { fonts: FONTS, maxNodes: 10 });
  assert.strictEqual(scene.pages[0].nodes.filter((n) => n.type === 'path').length, 10);
  assert.ok(warnings.some((w) => w.code === 'WARN_IMPORT_NODE_BUDGET'));
});

test('içe aktarma: kırpma bölgesi aktarılmaz ve bu BİLDİRİLİR', () => {
  const pdf = pdfWithContent(`q 10 10 100 100 re W n 0 0 1 rg 20 20 50 50 re f Q`);
  const { warnings } = importFromPdf(pdf, { fonts: FONTS });
  assert.ok(warnings.some((w) => w.code === 'WARN_IMPORT_CLIP'),
    JSON.stringify(warnings.map((w) => w.code)));
});

test('içe aktarma: gölgeleme (gradyan) aktarılmaz ve bu BİLDİRİLİR', () => {
  const pdf = pdfWithContent(`q /Sh0 sh Q`);
  const { warnings } = importFromPdf(pdf, { fonts: FONTS });
  assert.ok(warnings.some((w) => w.code === 'WARN_IMPORT_SHADING'));
});

test('içe aktarma: `q`/`Q` ile geri alınan matris yolu KAYDIRMAZ', () => {
  // İç blokta 200 birim kaydırılıp geri alınıyor; ikinci dikdörtgen
  // kaydırılmamış olmalı.
  const pdf = pdfWithContent(
    'q 1 0 0 1 200 0 cm 0 0 1 rg 0 700 50 50 re f Q\n' +
    '1 0 0 rg 0 700 50 50 re f');
  const { scene } = importFromPdf(pdf, { fonts: FONTS });
  const nodes = scene.pages[0].nodes.filter((n) => n.type === 'path');

  const moved = nodes.find((n) => n.fill === '#0000ff');
  const still = nodes.find((n) => n.fill === '#ff0000');
  assert.strictEqual(moved.frame.x, 200);
  assert.strictEqual(still.frame.x, 0);
});

test('içe aktarma: `f*` tek-çift dolgu kuralı korunur', () => {
  const pdf = pdfWithContent('0 0 0 rg 0 700 50 50 re 10 710 30 30 re f*');
  const { scene } = importFromPdf(pdf, { fonts: FONTS });
  const node = scene.pages[0].nodes.find((n) => n.type === 'path');
  assert.strictEqual(node.fillRule, 'evenodd');
});

test('içe aktarma: `v` ve `y` eğrileri kübiğe çevrilir', () => {
  const pdf = pdfWithContent('0 0 0 RG 10 700 m 30 730 50 700 v 70 680 90 700 y S');
  const { scene } = importFromPdf(pdf, { fonts: FONTS });
  const node = scene.pages[0].nodes.find((n) => n.type === 'path');

  const curves = node.d.filter((c) => c[0] === 'C');
  assert.strictEqual(curves.length, 2, 'iki eğri de C olarak gelmeli');
  assert.strictEqual(node.d.every((c) => ['M', 'L', 'C', 'Z'].includes(c[0])), true);
});

test('içe aktarma: ExtGState saydamlığı düğüme taşınır', () => {
  const pdf = pdfWithContent('q /GS0 gs 0 0 0 rg 0 700 50 50 re f Q', {
    extra: '/ExtGState << /GS0 << /Type /ExtGState /ca 0.5 >> >>'
  });
  const { scene } = importFromPdf(pdf, { fonts: FONTS });
  const node = scene.pages[0].nodes.find((n) => n.type === 'path');
  assert.strictEqual(node.opacity, 0.5);
});

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                         */
/* ------------------------------------------------------------------ */

/** PNG parçasını (chunk) bulur. */
function findChunk(png, type) {
  let pos = 8;
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const name = png.toString('ascii', pos + 4, pos + 8);
    if (name === type) return png.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
  }
  return Buffer.alloc(0);
}

/** Belgedeki ilk görsel XObject. */
function firstImageXObject(doc) {
  const page = doc.getPage(0);
  const res = doc.resolve(doc.getPageProperty(page.dict || page, 'Resources'));
  const xo = doc.resolve(doc.get(res, 'XObject'));
  for (const key of xo.map.keys()) {
    const stream = doc.resolve(xo.get(key));
    const sub = doc.get(stream.dict, 'Subtype');
    if (sub && sub.name === 'Image') return stream;
  }
  throw new Error('görsel XObject yok');
}

/** En küçük geçerli JPEG (gri, 1×1). */
function tinyJpeg() {
  return Buffer.from(
    'ffd8ffe000104a46494600010100000100010000ffdb004300ffffffffffffffffffffffffff' +
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' +
    'ffffffffffffffffffffffffffffffffffffffffffffffffffc00011080001000101011100ff' +
    'c4001f0000010501010101010100000000000000000102030405060708090a0bffc400b51000' +
    '02010303020403050504040000017d01020300041105122131410613516107227114328191a1' +
    '082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a43444546' +
    '4748494a535455565758595a636465666768696a737475767778797a838485868788898a9293' +
    '9495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5' +
    'd6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbfe8a' +
    '28a2803fffd9', 'hex');
}

/**
 * Tek görsel XObject taşıyan en küçük PDF.
 * Gerçek bir belgeye ihtiyaç yok; çıkarıcı yalnız akışı ve sözlüğü okur.
 */
function pdfWithImage(bytes, kind) {
  return pdfWithRawImage({
    width: 1, height: 1, bpc: 8, colorSpace: 'DeviceGray',
    filter: kind === 'jpeg' ? '/DCTDecode' : null,
    samples: bytes, rawStream: true
  });
}

/** Verilen sözlükle bir görsel XObject içeren PDF üretir. */
function pdfWithRawImage(o) {
  const stream = o.rawStream ? o.samples : zlib.deflateSync(o.samples);
  const filters = [];
  if (!o.rawStream) filters.push('/FlateDecode');
  if (o.filter) filters.push(o.filter);

  const dict = [
    '/Type /XObject', '/Subtype /Image',
    `/Width ${o.width}`, `/Height ${o.height}`,
    `/BitsPerComponent ${o.bpc}`,
    o.imageMask ? '/ImageMask true' : '',
    o.colorSpaceRaw ? `/ColorSpace ${o.colorSpaceRaw}`
      : (o.colorSpace ? `/ColorSpace /${o.colorSpace}` : ''),
    filters.length === 1 ? `/Filter ${filters[0]}`
      : filters.length ? `/Filter [${filters.join(' ')}]` : '',
    `/Length ${stream.length}`
  ].filter(Boolean).join(' ');
  const dictObj = `<< ${dict} >>`;

  const content = o.draw ? 'q 100 0 0 100 50 600 cm /Im0 Do Q' : 'q Q';
  return buildPdf({
    imageDict: dictObj, imageStream: stream, content,
    resources: '/XObject << /Im0 5 0 R >>'
  });
}

/** Verilen içerik akışına sahip PDF. */
function pdfWithContent(content, o = {}) {
  return buildPdf({ content, resources: o.extra || '' });
}

/**
 * Elle PDF kurar.
 *
 * Neden elle: bu testler PDF'i OKUYAN tarafı sınıyor. Belgeyi yine kendi
 * yazarımızla üretirsek, yazarın ürettiği biçimin dışına hiç çıkamayız —
 * oysa dışarıdan gelen belgeler tam da orada farklıdır.
 */
function buildPdf({ content, resources = '', imageDict = null, imageStream = null }) {
  const objects = [];
  const push = (body) => { objects.push(body); return objects.length; };

  push('<< /Type /Catalog /Pages 2 0 R >>');
  push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] ` +
       `/Resources << ${resources} >> /Contents 4 0 R >>`);
  push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  if (imageDict) push(`${imageDict}\nstream\n STREAM \nendstream`);

  let out = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const offsets = [0];

  objects.forEach((body, i) => {
    offsets.push(out.length);
    let chunk;
    if (imageDict && i === objects.length - 1) {
      const [head, tail] = body.split(' STREAM ');
      chunk = Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n${head}`, 'latin1'),
        imageStream,
        Buffer.from(`${tail}endobj\n`, 'latin1')
      ]);
    } else {
      chunk = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
    }
    out = Buffer.concat([out, chunk]);
  });

  const xrefPos = out.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
          `startxref\n${xrefPos}\n%%EOF\n`;

  return Buffer.concat([out, Buffer.from(xref, 'latin1')]);
}
