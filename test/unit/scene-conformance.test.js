'use strict';
/**
 * Sahne yolunda PDF/A ve PDF/UA.
 *
 * SERBEST YERLEŞİMDE OKUMA SIRASI KENDİLİĞİNDEN OLUŞMAZ. Akış belgesinde
 * "önce yazılan önce okunur"; sahnede kullanıcı nesneleri istediği sırayla
 * ekler. Çizim sırasını okuma sırası saymak, ekran okuyucunun belgeyi
 * tersten okuması demektir.
 *
 * Bu testler hem yapının GERÇEKTEN yazıldığını (bağımsız denetleyiciyle)
 * hem de eksik bilginin SESSİZCE geçilmediğini gösterir.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const zlib = require('zlib');

const { Scene, compileToPdf } = require('@fitfak/pdf-scene');
const tagging = require('@fitfak/pdf-scene/src/compile/tagging');
const conformance = require('@fitfak/conformance');
const { PdfDocument } = require('@fitfak/pdf-doc');

const ROOT = path.resolve(__dirname, '..', '..');
const FONTS = [{ family: 'Ubuntu', src: path.join(ROOT, 'assets', 'Ubuntu-Regular.ttf') }];

function makePng(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc((width * 3 + 1) * height))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Erişilebilir bir örnek belge. */
function accessibleScene() {
  const s = Scene.blank({ title: 'Erişilebilir Sahne', lang: 'tr-TR' });
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('rect', {
      id: 'zemin', x: 40, y: 40, width: 515, height: 60, fill: '#1f3a63'
    }));
    s.addNode(Scene.createNode('text', {
      id: 'h1', x: 60, y: 55, width: 470, height: 40,
      text: 'Ana Başlık', fontSize: 22, color: '#ffffff', role: 'H1'
    }));
    s.addNode(Scene.createNode('text', {
      id: 'p1', x: 60, y: 140, width: 470, height: 60,
      text: 'Gövde metni burada duruyor.', fontSize: 11
    }));
  });
  return s;
}

/* ================================================================== */
/* Okuma sırası                                                        */
/* ================================================================== */

test('sıra: görsel sıra yukarıdan aşağı, soldan sağa hesaplanır', () => {
  const placed = [
    { id: 'sagUst', frame: { x: 300, y: 40, width: 100, height: 20 } },
    { id: 'solUst', frame: { x: 50, y: 42, width: 100, height: 20 } },
    { id: 'alt', frame: { x: 50, y: 200, width: 100, height: 20 } },
    { id: 'orta', frame: { x: 50, y: 120, width: 100, height: 20 } }
  ];
  assert.deepStrictEqual(tagging.visualOrder(placed),
    ['solUst', 'sagUst', 'orta', 'alt']);
});

test('sıra: ÇİZİM sırası okuma sırası DEĞİLDİR', () => {
  // Kullanıcı önce gövdeyi, sonra başlığı eklemiş olabilir
  const s = Scene.blank({ title: 'Ters', lang: 'tr-TR' });
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('text', {
      id: 'govde', x: 60, y: 300, width: 400, height: 40, text: 'Gövde'
    }));
    s.addNode(Scene.createNode('text', {
      id: 'baslik', x: 60, y: 60, width: 400, height: 40, text: 'Başlık', role: 'H1'
    }));
  });

  const page = s.toJSON().pages[0];
  const placed = page.nodes.map((n) => ({ ...n, frame: n.frame }));
  const plan = tagging.planPage(page, placed);

  assert.deepStrictEqual(plan.order, ['baslik', 'govde'],
    'sonradan eklenen başlık, konumu gereği ÖNCE okunmalı');
  assert.strictEqual(plan.guessed, true, 'tahmin olduğu bildirilmeli');
});

test('sıra: kullanıcının verdiği sıra tahmine ÜSTÜN gelir', () => {
  const s = Scene.blank({ title: 'Elle sıra', lang: 'tr-TR' });
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('text', { id: 'a', x: 60, y: 60, width: 200, height: 30, text: 'A' }));
    s.addNode(Scene.createNode('text', { id: 'b', x: 60, y: 200, width: 200, height: 30, text: 'B' }));
  });

  const doc = s.toJSON();
  doc.pages[0].readingOrder = ['b', 'a'];
  const scene = Scene.fromJSON(doc);
  const page = scene.toJSON().pages[0];

  const plan = tagging.planPage(page, page.nodes);
  assert.deepStrictEqual(plan.order, ['b', 'a']);
  assert.strictEqual(plan.guessed, false);
});

test('sıra: eksik bırakılan düğümler sona eklenir ve BİLDİRİLİR', () => {
  const s = Scene.blank({ title: 'Eksik sıra', lang: 'tr-TR' });
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('text', { id: 'a', x: 60, y: 60, width: 200, height: 30, text: 'A' }));
    s.addNode(Scene.createNode('text', { id: 'b', x: 60, y: 200, width: 200, height: 30, text: 'B' }));
  });

  const doc = s.toJSON();
  doc.pages[0].readingOrder = ['b'];              // 'a' unutulmuş
  const page = Scene.fromJSON(doc).toJSON().pages[0];

  const plan = tagging.planPage(page, page.nodes);
  assert.deepStrictEqual(plan.order, ['b', 'a']);
  assert.ok(plan.warnings.some((w) => w.code === 'WARN_READING_ORDER_INCOMPLETE'));
});

test('sıra: var olmayan düğüm belirtmek şema hatasıdır', () => {
  const s = Scene.blank();
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('text', { id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'A' }));
  });
  const doc = s.toJSON();
  doc.pages[0].readingOrder = ['a', 'hayalet'];

  const { validateScene } = require('@fitfak/pdf-scene');
  const { scene, issues } = validateScene(doc);
  assert.strictEqual(scene, null);
  assert.ok(issues.some((i) => i.code === 'ERR_UNKNOWN_NODE'));
});

test('rol: süs nesneleri artifact, metin P, görsel Figure', () => {
  assert.strictEqual(tagging.roleOf({ type: 'rect' }), 'artifact');
  assert.strictEqual(tagging.roleOf({ type: 'line' }), 'artifact');
  assert.strictEqual(tagging.roleOf({ type: 'signature' }), 'artifact');
  assert.strictEqual(tagging.roleOf({ type: 'text' }), 'P');
  assert.strictEqual(tagging.roleOf({ type: 'image' }), 'Figure');
  // Kullanıcının açık seçimi kazanır
  assert.strictEqual(tagging.roleOf({ type: 'text', role: 'H2' }), 'H2');
  assert.strictEqual(tagging.roleOf({ type: 'rect', role: 'Figure' }), 'Figure');
});

/* ================================================================== */
/* Üretilen belge                                                      */
/* ================================================================== */

test('PDF/UA: sahneden üretilen belge bağımsız denetimden GEÇER', () => {
  const { pdf } = compileToPdf(accessibleScene(), { fonts: FONTS, conformance: 'pdf/ua' });

  const report = conformance.check(pdf, { profiles: ['pdf/ua'] });
  assert.strictEqual(report.conforms, true,
    JSON.stringify(report.pdfUA && report.pdfUA.errors));
});

test('PDF/A-2b: sahneden üretilen belge bağımsız denetimden GEÇER', () => {
  const { pdf } = compileToPdf(accessibleScene(), { fonts: FONTS, conformance: 'pdf/a-2b' });

  const report = conformance.check(pdf, { profiles: ['pdf/a-2b'] });
  assert.strictEqual(report.conforms, true,
    JSON.stringify(report.pdfA && report.pdfA.errors));
});

test('PDF/A + PDF/UA birlikte iddia edilip birlikte sağlanır', () => {
  const out = compileToPdf(accessibleScene(), { fonts: FONTS, conformance: 'pdf/a-2b+pdf/ua' });
  assert.deepStrictEqual(out.conformance, { pdfA: '2b', pdfUA: true, tagged: true });

  // Belge kendi iddiasını taşıyor mu? (profil verilmeden denetlenir)
  const report = conformance.check(out.pdf);
  assert.deepStrictEqual(report.profiles.sort(), ['pdf/a-2b', 'pdf/ua']);
  assert.strictEqual(report.conforms, true,
    JSON.stringify([report.pdfA && report.pdfA.errors, report.pdfUA && report.pdfUA.errors]));
});

test('etiketli belgede yapı ağacı ve işaretli içerik gerçekten var', () => {
  const { pdf } = compileToPdf(accessibleScene(), {
    fonts: FONTS, conformance: 'pdf/ua', compress: false
  });
  const raw = pdf.toString('latin1');

  assert.match(raw, /\/MarkInfo << \/Marked true >>/);
  assert.match(raw, /\/StructTreeRoot/);
  assert.match(raw, /\/ParentTree/);
  assert.match(raw, /\/S \/H1/, 'başlık rolü yazılmalı');
  assert.match(raw, /\/S \/P/, 'paragraf rolü yazılmalı');
  assert.match(raw, /\/Artifact BMC/, 'süs nesneleri artifact olmalı');
  assert.match(raw, /\/H1 << \/MCID \d+ >> BDC/);
  assert.match(raw, /\/StructParents 0/);
});

test('etiketsiz (profilsiz) belge yapı ağacı TAŞIMAZ', () => {
  const { pdf, conformance: c } = compileToPdf(accessibleScene(), { fonts: FONTS });
  assert.strictEqual(c, null);

  const raw = pdf.toString('latin1');
  assert.ok(!/\/StructTreeRoot/.test(raw));
  assert.ok(!/BDC/.test(raw), 'işaretli içerik istenmeden yazılmamalı');
});

test('PDF/UA: alternatif metni olmayan görsel BİLDİRİLİR', () => {
  const s = Scene.blank({ title: 'Alt eksik', lang: 'tr-TR' });
  const asset = s.assets.add(makePng(8, 8), { name: 'logo.png' });
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('image', {
      id: 'im', x: 60, y: 60, width: 80, height: 80, assetId: asset.id
    }));
  });

  const { pdf, warnings } = compileToPdf(s, { fonts: FONTS, conformance: 'pdf/ua' });
  assert.ok(warnings.some((w) => w.code === 'WARN_MISSING_ALT'),
    `uyarı bekleniyordu: ${JSON.stringify(warnings)}`);

  // Denetleyici de aynı eksiği yakalamalı — uyarı "sözde" olmamalı
  const report = conformance.check(pdf, { profiles: ['pdf/ua'] });
  assert.strictEqual(report.conforms, false);
  assert.ok(report.pdfUA.errors.some((e) => /Alt/i.test(e.message)));
});

test('PDF/UA: alternatif metni olan görsel denetimden geçer', () => {
  const s = Scene.blank({ title: 'Alt var', lang: 'tr-TR' });
  const asset = s.assets.add(makePng(8, 8), { name: 'logo.png' });
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('image', {
      id: 'im', x: 60, y: 60, width: 80, height: 80,
      assetId: asset.id, alt: 'Kurum logosu'
    }));
  });

  const { pdf, warnings } = compileToPdf(s, { fonts: FONTS, conformance: 'pdf/ua' });
  assert.ok(!warnings.some((w) => w.code === 'WARN_MISSING_ALT'));

  const report = conformance.check(pdf, { profiles: ['pdf/ua'] });
  assert.strictEqual(report.conforms, true, JSON.stringify(report.pdfUA.errors));
  assert.match(pdf.toString('latin1').replace(/\s+/g, ' '), /\/Alt/);
});

test('PDF/UA: karekod için alternatif metin içerikten türetilir', () => {
  const s = Scene.blank({ title: 'Karekod', lang: 'tr-TR' });
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('qr', {
      id: 'qr', x: 60, y: 60, width: 100, height: 100,
      payload: 'https://trust.fitfak.net/dogrula/ABC'
    }));
  });

  const { pdf, warnings } = compileToPdf(s, { fonts: FONTS, conformance: 'pdf/ua' });
  assert.ok(!warnings.some((w) => w.code === 'WARN_MISSING_ALT'),
    'karekodun içeriği zaten alternatif metindir');

  const report = conformance.check(pdf, { profiles: ['pdf/ua'] });
  assert.strictEqual(report.conforms, true, JSON.stringify(report.pdfUA.errors));
});

test('PDF/UA: başlıksız belge uyarılır', () => {
  const s = Scene.blank({ lang: 'tr-TR' });     // başlık YOK
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('text', { x: 60, y: 60, width: 200, height: 30, text: 'metin' }));
  });

  const { warnings } = compileToPdf(s, { fonts: FONTS, conformance: 'pdf/ua' });
  assert.ok(warnings.some((w) => w.code === 'WARN_NO_TITLE'));
});

test('PDF/A-1: saydamlık düzleştirilir ve bildirilir', () => {
  const s = Scene.blank({ title: 'Saydam', lang: 'tr-TR' });
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('rect', {
      x: 60, y: 60, width: 100, height: 100, fill: '#ff0000', opacity: 0.5
    }));
  });

  const out = compileToPdf(s, { fonts: FONTS, conformance: 'pdf/a-1b', compress: false });
  assert.ok(out.warnings.some((w) => w.code === 'WARN_PDFA1_TRANSPARENCY'));

  const raw = out.pdf.toString('latin1');
  assert.ok(!/\/ExtGState/.test(raw), 'PDF/A-1 belgesinde saydamlık kalmamalı');

  const report = conformance.check(out.pdf, { profiles: ['pdf/a-1b'] });
  assert.strictEqual(report.conforms, true, JSON.stringify(report.pdfA.errors));
});

test('PDF/A-2: saydamlık KORUNUR (yasak değildir)', () => {
  const s = Scene.blank({ title: 'Saydam 2', lang: 'tr-TR' });
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('rect', {
      x: 60, y: 60, width: 100, height: 100, fill: '#ff0000', opacity: 0.5
    }));
  });

  const out = compileToPdf(s, { fonts: FONTS, conformance: 'pdf/a-2b', compress: false });
  assert.ok(!out.warnings.some((w) => w.code === 'WARN_PDFA1_TRANSPARENCY'));
  assert.match(out.pdf.toString('latin1'), /\/ExtGState/);
});

test('bilinmeyen profil sessizce yutulmaz', () => {
  const { warnings, conformance: c } = compileToPdf(accessibleScene(), {
    fonts: FONTS, conformance: 'pdf/x-4'
  });
  assert.strictEqual(c, null);
  assert.ok(warnings.some((w) => w.code === 'WARN_UNKNOWN_PROFILE'));
});

test('çok sayfalı etiketli belge her sayfayı ayrı bölüm yapar', () => {
  const s = Scene.blank({ title: 'Çok sayfa', lang: 'tr-TR' });
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('text', { x: 60, y: 60, width: 300, height: 30, text: 'Sayfa bir', role: 'H1' }));
    s.addPage({ id: 'pg2' });
    s.addNode(Scene.createNode('text', { x: 60, y: 60, width: 300, height: 30, text: 'Sayfa iki', role: 'H1' }),
      { pageId: 'pg2' });
  });

  const { pdf } = compileToPdf(s, { fonts: FONTS, conformance: 'pdf/ua', compress: false });
  const raw = pdf.toString('latin1');

  assert.strictEqual((raw.match(/\/S \/Sect/g) || []).length, 2);
  assert.match(raw, /\/StructParents 0/);
  assert.match(raw, /\/StructParents 1/);

  const doc = PdfDocument.load(pdf);
  assert.strictEqual(doc.pageCount, 2);

  const report = conformance.check(pdf, { profiles: ['pdf/ua'] });
  assert.strictEqual(report.conforms, true, JSON.stringify(report.pdfUA.errors));
});

test('başlık düzeyi atlamak denetimde yakalanır', () => {
  // H1'den sonra H3 — ekran okuyucu için kopuk bir ağaç
  const s = Scene.blank({ title: 'Atlanan düzey', lang: 'tr-TR' });
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('text', { x: 60, y: 60, width: 300, height: 30, text: 'Bir', role: 'H1' }));
    s.addNode(Scene.createNode('text', { x: 60, y: 120, width: 300, height: 30, text: 'Üç', role: 'H3' }));
  });

  const { pdf } = compileToPdf(s, { fonts: FONTS, conformance: 'pdf/ua' });
  const report = conformance.check(pdf, { profiles: ['pdf/ua'] });
  assert.strictEqual(report.conforms, false);
  assert.ok(report.pdfUA.errors.some((e) => /atlanmış/i.test(e.message)));
});
