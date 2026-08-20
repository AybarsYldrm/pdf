'use strict';
/**
 * Sahne derleyicileri: Scene → PDF ve Scene → HTML.
 *
 * En önemli iddia: SAHNEDEKİ KOORDİNAT, PDF'TEKİ KOORDİNATTIR. Testler bunu
 * üretilen içerik akışından okuyarak doğrular; "PDF üretildi, demek ki doğru"
 * demez.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { Scene, units } = require('@fitfak/pdf-scene');
const { compileToPdf, collectItems, buildContent } = require('@fitfak/pdf-scene/src/compile/pdf');
const { compileToHtml, serialize, el, escapeText, cssFontFamily } =
  require('@fitfak/pdf-scene/src/compile/html');
const { PdfDocument } = require('@fitfak/pdf-doc');

const ROOT = path.resolve(__dirname, '..', '..');
const FONT = path.join(ROOT, 'assets', 'Ubuntu-Regular.ttf');
const FONTS = [{ family: 'Ubuntu', src: FONT }];

const hasCode = (code) => (err) => err && err.code === code;

/** `extractText` düz dizge döndürür; testler bunu tek yerden okusun. */
const pageText = (doc, index) => {
  const out = doc.extractText(index);
  return String(out && out.text !== undefined ? out.text : out || '');
};

/** Metin düzeni için gereken en küçük derleme bağlamı. */
function textCtx(scene) {
  const { FontManager } = require('@fitfak/pdf-html/src/font/manager');
  const fonts = new FontManager();
  fonts.register({ family: 'Ubuntu', src: FONT });
  return {
    fonts, assets: scene.assets, renderQr: () => null,
    resolveFace: (family, bold, italic) =>
      fonts.resolve([family || 'Ubuntu'], bold ? 700 : 400, italic ? 'italic' : 'normal')
  };
}

/** Küçük ama geçerli bir PNG. */
function makePng(width, height, rgbFill = [0, 0, 0]) {
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
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = y * (width * 3 + 1) + 1 + x * 3;
      raw[off] = rgbFill[0]; raw[off + 1] = rgbFill[1]; raw[off + 2] = rgbFill[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ================================================================== */
/* Scene → PDF                                                         */
/* ================================================================== */

test('PDF: basit sahne derlenir ve okunabilir bir belge olur', () => {
  const s = Scene.blank({ title: 'Derleme Testi' });
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('text', {
      x: 60, y: 80, width: 400, height: 40, text: 'Merhaba Sahne', fontSize: 20
    }));
  });

  const { pdf, warnings } = compileToPdf(s, { fonts: FONTS });
  assert.deepStrictEqual(warnings, []);
  assert.ok(pdf.subarray(0, 8).toString('latin1').startsWith('%PDF-1.'));

  const doc = PdfDocument.load(pdf);
  assert.strictEqual(doc.pageCount, 1);
  const geo = doc.getPageGeometry(0);
  assert.strictEqual(geo.width, 595.28);
  assert.strictEqual(geo.height, 841.89);
});

test('PDF: metin ÇIKARILABİLİR ve Türkçe karakterler korunur', () => {
  const s = Scene.blank();
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('text', {
      x: 60, y: 80, width: 460, height: 60,
      text: 'Şükrü Çağrı İĞÜÖ — ölçüm', fontSize: 14
    }));
  });

  const { pdf } = compileToPdf(s, { fonts: FONTS });
  const doc = PdfDocument.load(pdf);
  const text = pageText(doc, 0);
  assert.match(text, /Şükrü Çağrı İĞÜÖ — ölçüm/);
});

test('PDF: sahne koordinatı PDF koordinatına birebir çevrilir', () => {
  // Sahne sol-ÜST başlangıçlı, PDF sol-ALT. 100pt yükseklikli bir dikdörtgeni
  // y=200'e koyarsak PDF'te alt kenarı 841.89 - 300 = 541.89 olmalıdır.
  const s = Scene.blank();
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('rect', {
      id: 'kutu', x: 50, y: 200, width: 120, height: 100, fill: '#ff0000'
    }));
  });

  const scene = s.toJSON();
  const { items } = collectItems(scene, scene.pages[0], { assets: s.assets });
  const { content } = buildContent(items, scene.page.height, { images: new Map() });

  assert.match(content, /50 541\.89 120 100 re/,
    `içerik akışında beklenen dikdörtgen yok:\n${content}`);
  assert.match(content, /1 0 0 rg/, 'kırmızı dolgu yazılmalı');
});

test('PDF: grup çocuğu mutlak koordinata çevrilir', () => {
  const s = Scene.blank();
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('rect', { id: 'a', x: 100, y: 100, width: 50, height: 50, fill: '#000000' }));
    s.addNode(Scene.createNode('rect', { id: 'b', x: 200, y: 100, width: 50, height: 50, fill: '#000000' }));
    s.group(['a', 'b']);
  });

  const scene = s.toJSON();
  const { items } = collectItems(scene, scene.pages[0], { assets: s.assets });
  assert.strictEqual(items.length, 2, 'grup çözülüp iki dikdörtgen çıkmalı');
  assert.deepStrictEqual(items.map((i) => i.x).sort((p, q) => p - q), [100, 200]);
});

test('PDF: gizli düğüm çizilmez', () => {
  const s = Scene.blank();
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('rect', { id: 'gorunur', x: 0, y: 0, width: 10, height: 10, fill: '#000000' }));
    s.addNode(Scene.createNode('rect', { id: 'gizli', x: 0, y: 0, width: 10, height: 10, fill: '#000000', hidden: true }));
  });
  const scene = s.toJSON();
  const { items } = collectItems(scene, scene.pages[0], { assets: s.assets });
  assert.strictEqual(items.length, 1);
});

test('PDF: uzun metin sarılır ve kutuya sığmazsa uyarı verir', () => {
  const s = Scene.blank();
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('text', {
      x: 50, y: 50, width: 200, height: 20,           // tek satırlık kutu
      text: 'Bu cümle iki yüz puntoluk dar bir kutuya kesinlikle tek satırda sığmaz.',
      fontSize: 12
    }));
  });

  const { warnings } = compileToPdf(s, { fonts: FONTS });
  assert.ok(warnings.some((w) => w.code === 'WARN_TEXT_OVERFLOW'),
    `taşma uyarısı bekleniyordu: ${JSON.stringify(warnings)}`);
});

test('PDF: imza yuvası ÇİZİLMEZ, manifestte bildirilir', () => {
  const s = Scene.blank();
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('signature', {
      id: 'sig', x: 80, y: 700, width: 200, height: 60,
      fieldName: 'Imza_Yetkili', signer: 'Aybars', signerTitle: 'Düzenleyen', showFrame: false
    }));
  });

  const { manifest } = compileToPdf(s, { fonts: FONTS });
  assert.strictEqual(manifest.slots.length, 1);
  // sahne koordinatı korunur, PDF koordinatı da hesaplanır
  assert.deepStrictEqual(manifest.slots[0].sceneRect, { x: 80, y: 700, width: 200, height: 60 });
  assert.deepStrictEqual(manifest.slots[0].rect,
    { x: 80, y: units.round(841.89 - 700 - 60), width: 200, height: 60 });
  assert.strictEqual(manifest.slots[0].origin, 'bottom-left');
  assert.strictEqual(manifest.slots[0].fieldName, 'Imza_Yetkili');
  assert.strictEqual(manifest.slots[0].signer, 'Aybars');
  assert.strictEqual(manifest.slots[0].page, 0);
});

test('PDF: görsel gömülür ve tekilleştirilir', () => {
  const s = Scene.blank();
  const png = makePng(20, 10, [200, 30, 30]);
  const asset = s.assets.add(png, { name: 'logo.png' });

  s.transaction('Kur', () => {
    for (let i = 0; i < 3; i++) {
      s.addNode(Scene.createNode('image', {
        x: 50, y: 50 + i * 60, width: 100, height: 50, assetId: asset.id
      }));
    }
  });

  const { pdf, warnings } = compileToPdf(s, { fonts: FONTS });
  assert.deepStrictEqual(warnings, []);
  // Aynı varlık üç kez kullanıldı ama tek XObject gömülmeli
  const doc = PdfDocument.load(pdf);
  assert.strictEqual(doc.pageCount, 1);
  const imageCount = (pdf.toString('latin1').match(/\/Subtype\s*\/Image/g) || []).length;
  assert.strictEqual(imageCount, 1, 'aynı görsel bir kez gömülmeli');
});

test('PDF: contain en-boy oranını korur', () => {
  const s = Scene.blank();
  const asset = s.assets.add(makePng(200, 100));   // 2:1
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('image', {
      id: 'im', x: 0, y: 0, width: 100, height: 100, assetId: asset.id, fit: 'contain'
    }));
  });

  const scene = s.toJSON();
  const { items } = collectItems(scene, scene.pages[0], { assets: s.assets });
  const img = items.find((i) => i.type === 'image');
  assert.strictEqual(img.width, 100);
  assert.strictEqual(img.height, 50, '2:1 görsel 100×100 kutuda 100×50 olmalı');
  assert.strictEqual(img.y, 25, 'dikey ortalanmalı');
});

test('PDF: eksik varlık uyarı üretir, çökmez', () => {
  const scene = Scene.blank().toJSON();
  scene.assets = [{
    id: 'ast_hayalet', kind: 'image', mime: 'image/png',
    sha256: 'a'.repeat(64), size: 10, width: 5, height: 5
  }];
  scene.pages[0].nodes = [{
    id: 'im', type: 'image', frame: { x: 0, y: 0, width: 10, height: 10 }, assetId: 'ast_hayalet'
  }];

  const { AssetManager } = require('@fitfak/pdf-scene');
  const { warnings } = compileToPdf(scene, { fonts: FONTS, assets: new AssetManager() });
  assert.ok(warnings.some((w) => w.code === 'WARN_ASSET_MISSING'));
});

test('PDF: çok sayfalı sahne çok sayfalı PDF üretir', () => {
  const s = Scene.blank();
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('text', { x: 50, y: 50, width: 200, height: 20, text: 'Bir' }));
    s.addPage({ id: 'pg2' });
    s.addNode(Scene.createNode('text', { x: 50, y: 50, width: 200, height: 20, text: 'İki' }),
      { pageId: 'pg2' });
    s.addPage({ id: 'pg3' });
    s.addNode(Scene.createNode('text', { x: 50, y: 50, width: 200, height: 20, text: 'Üç' }),
      { pageId: 'pg3' });
  });

  const { pdf, manifest } = compileToPdf(s, { fonts: FONTS });
  assert.strictEqual(manifest.pages.length, 3);
  const doc = PdfDocument.load(pdf);
  assert.strictEqual(doc.pageCount, 3);
  assert.match(pageText(doc, 2), /Üç/);
});

test('PDF: fontsuz derleme açıkça reddedilir', () => {
  assert.throws(() => compileToPdf(Scene.blank(), { fonts: [] }), hasCode('ERR_NO_FONT'));
});

test('PDF: geçersiz sahne derlenmez', () => {
  assert.throws(
    () => compileToPdf({ version: 1, page: { size: 'A4' }, pages: [] }, { fonts: FONTS, assets: {} }),
    hasCode('ERR_SCENE_INVALID'));
});

test('PDF: bağlantı taşıyan metin /Link açıklaması üretir', () => {
  const s = Scene.blank();
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('text', {
      x: 50, y: 50, width: 300, height: 30,
      runs: [{ text: 'Sitemiz: ' }, { text: 'ornek.test', link: 'https://ornek.test/x' }]
    }));
  });
  const { pdf } = compileToPdf(s, { fonts: FONTS, compress: false });
  const raw = pdf.toString('latin1');
  assert.match(raw, /\/Subtype \/Link/);
  assert.match(raw, /https:\/\/ornek\.test\/x/);
});

test('PDF: saydamlık ExtGState olarak yazılır', () => {
  const s = Scene.blank();
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('rect', { x: 0, y: 0, width: 10, height: 10, fill: '#000000', opacity: 0.5 }));
  });
  const raw = compileToPdf(s, { fonts: FONTS, compress: false }).pdf.toString('latin1');
  assert.match(raw, /\/ExtGState/);
  assert.match(raw, /\/ca 0\.5/);
});

test('PDF: aynı sahne iki kez derlenince aynı çizim listesi çıkar', () => {
  const s = Scene.blank();
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('rect', { x: 10, y: 20, width: 30, height: 40, fill: '#123456' }));
    s.addNode(Scene.createNode('text', { x: 10, y: 80, width: 200, height: 40, text: 'Kararlılık' }));
  });

  const scene = s.toJSON();
  const ctx = () => {
    const { FontManager } = require('@fitfak/pdf-html/src/font/manager');
    const fonts = new FontManager();
    fonts.register({ family: 'Ubuntu', src: FONT });
    return {
      fonts, assets: s.assets, renderQr: () => null,
      resolveFace: () => fonts.resolve(['Ubuntu'], 400, 'normal')
    };
  };

  const a = buildContent(collectItems(scene, scene.pages[0], ctx()).items, scene.page.height, { images: new Map() });
  const b = buildContent(collectItems(scene, scene.pages[0], ctx()).items, scene.page.height, { images: new Map() });
  assert.strictEqual(a.content, b.content);
});

/* ================================================================== */
/* Scene → HTML                                                        */
/* ================================================================== */

test('HTML: serileştirici metni kaçışlar', () => {
  assert.strictEqual(escapeText('<script>&"x"'), '&lt;script&gt;&amp;"x"');
  const out = serialize(el('div', { title: '"><img onerror=x>' }, ['<b>kalın</b>']));
  assert.strictEqual(out,
    '<div title="&quot;&gt;&lt;img onerror=x&gt;">&lt;b&gt;kalın&lt;/b&gt;</div>');
});

test('HTML: belge metni HTML olarak YORUMLANMAZ', () => {
  const s = Scene.blank({ title: '<script>t</script>' });
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('text', {
      x: 0, y: 0, width: 200, height: 40,
      text: '<script>alert(1)</script><img src=x onerror=alert(2)>'
    }));
    s.addNode(Scene.createNode('image', {
      x: 0, y: 50, width: 20, height: 20, assetId: 'ast_yok', alt: '"><script>alert(3)</script>'
    }));
  });

  // `ast_yok` gerçek olmadığı için sahneyi doğrudan kuruyoruz
  const raw = s.toJSON();
  raw.pages[0].nodes[1].assetId = undefined;
  raw.pages[0].nodes.splice(1, 1);

  const { html } = compileToHtml(raw, { assets: s.assets });
  assert.ok(!/<script/i.test(html), 'script etiketi çıktıya girmemeli');
  assert.ok(!/<img[^>]*onerror/i.test(html), 'olay işleyicisi ETİKET olarak girmemeli');
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/, 'metin olarak kaçışlanmalı');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('HTML: font ailesi CSS bildirimini kapatamaz', () => {
  assert.strictEqual(cssFontFamily('Ubuntu'), '"Ubuntu", sans-serif');
  assert.strictEqual(cssFontFamily('X"; background:url(evil); font-family:"Y'),
    '"X backgroundurlevil font-familyY", sans-serif');
  assert.strictEqual(cssFontFamily('}'), 'sans-serif');
  // Boş aile varsayılana düşer; süzgeçten hiçbir şey kalmayan aile ise jeneriğe.
  assert.strictEqual(cssFontFamily(''), '"Ubuntu", sans-serif');
});

test('HTML: sayfa boyutu ve düğüm konumları puntoyla yazılır', () => {
  const s = Scene.blank();
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('rect', {
      id: 'kutu', x: 12.5, y: 34.25, width: 100, height: 50, fill: '#00ff00'
    }));
  });
  const { html } = compileToHtml(s);
  assert.match(html, /width:595\.28pt/);
  assert.match(html, /height:841\.89pt/);
  assert.match(html, /left:12\.5pt/);
  assert.match(html, /top:34\.25pt/);
  assert.match(html, /background:#00ff00/);
});

test('HTML: görseller data: URL olarak gömülür (tek dosya)', () => {
  const s = Scene.blank();
  const asset = s.assets.add(makePng(4, 4));
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('image', { x: 0, y: 0, width: 40, height: 40, assetId: asset.id }));
  });
  const { html } = compileToHtml(s);
  assert.match(html, /src="data:image\/png;base64,/);
});

test('HTML: parça (fragment) kipinde iskelet üretilmez', () => {
  const { html } = compileToHtml(Scene.blank(), { fragment: true });
  assert.ok(!/<!doctype/i.test(html));
  assert.ok(!/<html/i.test(html));
  assert.match(html, /class="sn-doc"/);
});

test('HTML: gizli düğüm çıktıya girmez', () => {
  const s = Scene.blank();
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('rect', { id: 'gizli', hidden: true, fill: '#abcdef' }));
  });
  const { html } = compileToHtml(s);
  assert.ok(!/abcdef/.test(html));
});

test('HTML ve PDF aynı düğüm kümesini kapsar', () => {
  const s = Scene.blank();
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('rect', { id: 'r1', x: 10, y: 10, width: 50, height: 20, fill: '#111111' }));
    s.addNode(Scene.createNode('text', { id: 't1', x: 10, y: 40, width: 200, height: 30, text: 'Ortak' }));
    s.addNode(Scene.createNode('ellipse', { id: 'e1', x: 10, y: 80, width: 40, height: 40, fill: '#222222' }));
  });

  const { html } = compileToHtml(s);
  for (const id of ['r1', 't1', 'e1']) {
    assert.match(html, new RegExp(`data-id="${id}"`), `${id} HTML'de olmalı`);
  }

  const scene = s.toJSON();
  const { items } = collectItems(scene, scene.pages[0], textCtx(s));
  assert.ok(items.some((i) => i.type === 'rect'));
  assert.ok(items.some((i) => i.type === 'ellipse'));
});
