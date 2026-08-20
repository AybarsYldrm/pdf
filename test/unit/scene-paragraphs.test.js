'use strict';
/**
 * İçe aktarmada PARAGRAF yapısı.
 *
 * Her satırı ayrı kutu yapmak kâğıtta doğru görünür ama belgeyi
 * düzenlenemez kılar: bir cümleye kelime eklemek altındaki on kutuyu elle
 * kaydırmayı gerektirir. Bu testler iki şeyi birlikte sorar:
 *   1. Doğru satırlar birleşti mi? (ve YANLIŞ olanlar birleşmedi mi?)
 *   2. Birleşen kutu gerçekten AKIYOR mu — metin uzayınca uzuyor mu?
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { Scene, compileToPdf, compileToHtml } = require('@fitfak/pdf-scene');
const { importFromPdf } = require('@fitfak/pdf-scene/src/import/pdf');
const { importFromHtml } = require('@fitfak/pdf-scene/src/import/html');
const { groupParagraphs } = require('@fitfak/pdf-scene/src/import/paragraphs');

const ROOT = path.resolve(__dirname, '..', '..');
const FONTS = [{ family: 'Ubuntu', src: path.join(ROOT, 'assets', 'Ubuntu-Regular.ttf') }];

/** Satır kaydı kısayolu. */
const line = (x, baseline, width, text, o = {}) => ({
  x, baseline, right: x + width, text,
  fontSize: o.fontSize || 11, styleKey: o.styleKey || 'a'
});

/* ================================================================== */
/* Gruplama kuralları                                                  */
/* ================================================================== */

test('paragraf: ardışık ve aynı hizadaki satırlar birleşir', () => {
  const paras = groupParagraphs([
    line(60, 100, 300, 'Birinci satır'),
    line(60, 115, 300, 'ikinci satır'),
    line(60, 130, 200, 'üçüncü satır.')
  ]);

  assert.strictEqual(paras.length, 1);
  assert.strictEqual(paras[0].text, 'Birinci satır ikinci satır üçüncü satır.');
  assert.strictEqual(paras[0].merged, true);
  assert.strictEqual(paras[0].lineHeight, Math.round((15 / 11) * 100) / 100);
});

test('paragraf: ARALIK büyüyünce yeni paragraf başlar', () => {
  const paras = groupParagraphs([
    line(60, 100, 300, 'Bir'),
    line(60, 115, 300, 'iki'),
    line(60, 160, 300, 'Yeni paragraf')     // 45 punto boşluk
  ]);
  assert.strictEqual(paras.length, 2);
  assert.strictEqual(paras[1].text, 'Yeni paragraf');
});

test('paragraf: aralık DEĞİŞİNCE (sıkışınca) yeni blok sayılır', () => {
  const paras = groupParagraphs([
    line(60, 100, 300, 'Bir'),
    line(60, 115, 300, 'iki'),
    line(60, 123, 300, 'Dipnot gibi sıkışık')
  ]);
  assert.strictEqual(paras.length, 2);
});

test('paragraf: PUNTO değişince birleşmez (başlık gövdeye karışmaz)', () => {
  const paras = groupParagraphs([
    line(60, 100, 300, 'BAŞLIK', { fontSize: 20 }),
    line(60, 118, 300, 'gövde metni', { fontSize: 11 })
  ]);
  assert.strictEqual(paras.length, 2);
});

test('paragraf: BİÇİM değişince birleşmez (renk/aile/kalınlık)', () => {
  const paras = groupParagraphs([
    line(60, 100, 300, 'siyah', { styleKey: 'Ubuntu|400|normal|#111111' }),
    line(60, 115, 300, 'kırmızı', { styleKey: 'Ubuntu|400|normal|#cc0000' })
  ]);
  assert.strictEqual(paras.length, 2);
});

test('paragraf: YAN YANA sütunlar birbirine karışmaz', () => {
  const paras = groupParagraphs([
    line(60, 100, 200, 'Sol sütun bir'),
    line(320, 100, 200, 'Sağ sütun bir'),
    line(60, 115, 200, 'Sol sütun iki'),
    line(320, 115, 200, 'Sağ sütun iki')
  ].sort((a, b) => a.baseline - b.baseline || a.x - b.x));

  // Aynı taban çizgisinde iki satır aynı paragrafa giremez (gap = 0)
  assert.ok(paras.length >= 2);
  assert.ok(!paras.some((p) => /Sol.*Sağ|Sağ.*Sol/.test(p.text)),
    `sütunlar karıştı: ${JSON.stringify(paras.map((p) => p.text))}`);
});

test('paragraf: ilk satır GİRİNTİSİ paragrafı bölmez', () => {
  const paras = groupParagraphs([
    line(84, 100, 276, 'Girintili ilk satır'),
    line(60, 115, 300, 'devamı sola dayalı'),
    line(60, 130, 300, 've devam ediyor')
  ]);
  assert.strictEqual(paras.length, 1);
  assert.strictEqual(paras[0].x, 60, 'paragraf sol kenarı en soldaki satırdır');
});

test('paragraf: ortalanmış blok ORTALANMIŞ olarak tanınır', () => {
  const paras = groupParagraphs([
    line(150, 100, 200, 'Ortalanmış birinci'),
    line(175, 115, 150, 'ikinci'),
    line(160, 130, 180, 'üçüncü')
  ]);
  assert.strictEqual(paras.length, 1);
  assert.strictEqual(paras[0].align, 'center');
});

test('paragraf: sağa dayalı blok SAĞA DAYALI tanınır', () => {
  const paras = groupParagraphs([
    line(100, 100, 300, 'Sağa dayalı bir'),
    line(200, 115, 200, 'iki'),
    line(150, 130, 250, 'üç')
  ]);
  assert.strictEqual(paras[0].align, 'right');
});

test('paragraf: iki yana yaslı blok JUSTIFY tanınır', () => {
  const paras = groupParagraphs([
    line(60, 100, 300, 'Yaslı satır bir'),
    line(60, 115, 300, 'yaslı satır iki'),
    line(60, 130, 120, 'son satır kısa')
  ]);
  assert.strictEqual(paras[0].align, 'justify');
});

test('paragraf: tek satır tek başına kalır ve merged DEĞİLDİR', () => {
  const paras = groupParagraphs([line(60, 100, 300, 'Yalnız')]);
  assert.strictEqual(paras.length, 1);
  assert.strictEqual(paras[0].merged, false);
  assert.strictEqual(paras[0].lineHeight, 1.4);
});

test('paragraf: yukarı giden satır (ters sıra) birleşmez', () => {
  const paras = groupParagraphs([
    line(60, 200, 300, 'Aşağıdaki'),
    line(60, 100, 300, 'Yukarıdaki')
  ]);
  assert.strictEqual(paras.length, 2);
});

/* ================================================================== */
/* autoHeight derleme                                                  */
/* ================================================================== */

function textScene(props) {
  const s = Scene.blank({ title: 'Akış' });
  s.transaction('kur', () => {
    s.addNode(Scene.createNode('text', {
      id: 't', x: 60, y: 60, width: 200, height: 20,
      fontSize: 11, lineHeight: 1.4, ...props
    }));
  });
  return s;
}

test('autoHeight: taşma UYARISI üretilmez, kutu metin kadardır', () => {
  const long = 'Bu metin iki yüz puntoluk kutuya kesinlikle tek satırda sığmaz ' +
               've birkaç satıra yayılır.';

  const fixed = compileToPdf(textScene({ text: long }), { fonts: FONTS });
  assert.ok(fixed.warnings.some((w) => w.code === 'WARN_TEXT_OVERFLOW'),
    'sabit yükseklikte taşma bildirilmeli');

  const auto = compileToPdf(textScene({ text: long, autoHeight: true }), { fonts: FONTS });
  assert.deepStrictEqual(auto.warnings, [], 'akan kutuda taşma diye bir şey yoktur');
});

test('autoHeight: metin uzadıkça çerçeve BÜYÜR', () => {
  const measure = (text) => {
    const scene = textScene({ text, autoHeight: true });
    // Etiketli derleme çerçeveyi ölçülen yükseklikle günceller
    const out = compileToPdf(scene, { fonts: FONTS, conformance: 'pdf/ua' });
    return out.pdf.length;
  };
  const short = measure('Kısa');
  const long = measure('Bu metin çok daha uzundur ve birkaç satıra yayılır, ' +
                       'dolayısıyla kutunun büyümesi gerekir.');
  assert.ok(long > short, 'daha uzun metin daha fazla içerik üretmeli');
});

test('autoHeight: dikey hizalama YOK SAYILIR (kutu zaten metin kadardır)', () => {
  const raw = (props) => compileToPdf(textScene(props), { fonts: FONTS, compress: false })
    .pdf.toString('latin1');

  const top = raw({ text: 'Tek satır', autoHeight: true, valign: 'top', height: 200 });
  const bottom = raw({ text: 'Tek satır', autoHeight: true, valign: 'bottom', height: 200 });

  const tm = (s) => (s.match(/1 0 0 1 [\d.]+ ([\d.]+) Tm/) || [])[1];
  assert.strictEqual(tm(top), tm(bottom), 'iki durumda da metin üstte olmalı');
});

test('autoHeight: HTML önizlemesinde yükseklik `auto` yazılır', () => {
  const { html } = compileToHtml(textScene({ text: 'Akan', autoHeight: true }));
  const match = html.match(/class="sn-text"[^>]*style="([^"]*)"/);
  assert.ok(match, 'metin kutusu bulunamadı');
  assert.match(match[1], /height:auto/);
});

/* ================================================================== */
/* Uçtan uca içe aktarma                                               */
/* ================================================================== */

function paragraphPdf() {
  const s = Scene.blank({ title: 'Paragraflı' });
  s.transaction('kur', () => {
    s.addNode(Scene.createNode('text', {
      id: 'h', x: 60, y: 60, width: 400, height: 30,
      text: 'BAŞLIK BURADA', fontSize: 20
    }));
    s.addNode(Scene.createNode('text', {
      id: 'p1', x: 60, y: 120, width: 400, height: 100, fontSize: 11, lineHeight: 1.5,
      text: 'Bu bir paragraftır ve birden fazla satıra yayılacak kadar uzundur. ' +
            'İçe aktarıldığında tek bir kutuda toplanmalı ki kullanıcı cümle ' +
            'eklediğinde kutu büyüsün.'
    }));
    s.addNode(Scene.createNode('text', {
      id: 'p2', x: 60, y: 300, width: 400, height: 60, fontSize: 11, lineHeight: 1.5,
      text: 'İkinci paragraf ayrı durmalıdır çünkü araya satır aralığından ' +
            'büyük bir boşluk girmiştir.'
    }));
  });
  return compileToPdf(s, { fonts: FONTS }).pdf;
}

test('PDF içe aktarma: paragraflar TEK kutuda toplanır', () => {
  const { scene, warnings } = importFromPdf(paragraphPdf(), { fonts: FONTS });
  const texts = scene.pages[0].nodes.filter((n) => n.type === 'text');

  assert.strictEqual(texts.length, 3, JSON.stringify(texts.map((t) => t.text)));
  assert.match(texts[0].text, /^BAŞLIK BURADA$/);
  assert.match(texts[1].text, /^Bu bir paragraftır.*büyüsün\.$/);
  assert.strictEqual(texts.every((t) => t.autoHeight), true);
  assert.ok(warnings.some((w) => w.code === 'WARN_IMPORT_LINES_MERGED'),
    'satır sonlarının kaybolduğu SÖYLENMELİ');
});

test('PDF içe aktarma: kaynaktaki satır aralığı geri kazanılır', () => {
  const { scene } = importFromPdf(paragraphPdf(), { fonts: FONTS });
  const para = scene.pages[0].nodes.find((n) => /^Bu bir paragraftır/.test(n.text || ''));
  assert.strictEqual(para.lineHeight, 1.5);
});

test('PDF içe aktarma: `paragraphs:false` satır satır bırakır', () => {
  const { scene } = importFromPdf(paragraphPdf(), { fonts: FONTS, paragraphs: false });
  const texts = scene.pages[0].nodes.filter((n) => n.type === 'text');
  assert.ok(texts.length > 3, 'satır satır aktarımda daha çok kutu olmalı');
  assert.strictEqual(texts.some((t) => t.autoHeight), false);
});

test('PDF içe aktarma → derleme → içe aktarma SABİT NOKTADIR', () => {
  // İkinci tur birinciyle aynı çıkmıyorsa satır sonları kayıyor demektir:
  // kullanıcı belgeyi her açıp kapadığında metin biraz daha bozulurdu.
  const first = importFromPdf(paragraphPdf(), { fonts: FONTS }).scene;
  const second = importFromPdf(
    compileToPdf(first, { fonts: FONTS }).pdf, { fonts: FONTS }).scene;

  const shape = (scene) => scene.pages[0].nodes
    .filter((n) => n.type === 'text')
    .map((n) => [n.text, n.frame.x, n.frame.width, n.lineHeight]);

  assert.deepStrictEqual(shape(second), shape(first));
});

test('HTML içe aktarma: paragraflar akan kutulara dönüşür', () => {
  const html = `<article>
    <h1>Kurumsal Belge</h1>
    <p>Bu paragraf birden fazla satıra yayılacak kadar uzundur ve içe
    aktarıldığında tek bir metin kutusunda toplanmalıdır.</p>
    <p>İkinci paragraf ayrı bir düğüm olmalıdır.</p>
  </article>`;

  const { scene, warnings } = importFromHtml({
    html, fonts: FONTS, page: { size: 'A4', margin: '20mm' }
  });
  const texts = scene.pages[0].nodes.filter((n) => n.type === 'text');

  assert.strictEqual(texts.length, 3, JSON.stringify(texts.map((t) => t.text)));
  assert.strictEqual(texts.every((t) => t.autoHeight), true);
  assert.ok(warnings.some((w) => w.code === 'WARN_IMPORT_LINES_MERGED'));
});

test('HTML içe aktarma: başlık ile gövde AYRI düğümlerdir', () => {
  const { scene } = importFromHtml({
    html: '<article><h1>Başlık</h1><p>Gövde metni burada.</p></article>',
    fonts: FONTS, page: { size: 'A4', margin: '20mm' }
  });
  const texts = scene.pages[0].nodes.filter((n) => n.type === 'text');

  assert.strictEqual(texts.length, 2);
  assert.ok(texts[0].fontSize > texts[1].fontSize, 'başlık daha büyük puntoludur');
});
