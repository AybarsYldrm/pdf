'use strict';
/**
 * Tarayıcı paketi testleri.
 *
 * İDDİA: editörün kullandığı model ile sunucunun kullandığı model AYNIDIR.
 * Paketleme farklı, kaynak tek. Bu dosya o eşitliği ölçer — paketleyici
 * bozulursa ya da bir modül kayıtsız kalırsa burada patlar.
 *
 * Node, tarayıcının sağladığı her şeyi (atob/btoa, TextEncoder, crypto)
 * zaten sağladığı için paket burada gerçekten çalıştırılabilir.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { buildBrowserBundle, writeBrowserBundle } = require('@fitfak/pdf-scene/browser');
const node = require('@fitfak/pdf-scene');

/** Paketi bir kez kur ve içe aktar. */
let browser;
let bundleFile;

test.before(async () => {
  bundleFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fitfak-scene-')), 'scene.esm.js');
  writeBrowserBundle(bundleFile);
  browser = await import('file://' + bundleFile);
});

test.after(() => {
  try { fs.rmSync(path.dirname(bundleFile), { recursive: true, force: true }); } catch { /* yok */ }
});

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

/* ================================================================== */

test('paket: beklenen adları dışa açar', () => {
  for (const name of [
    'Scene', 'validateScene', 'SceneError', 'AssetManager', 'History',
    'geometry', 'units', 'SCHEMA_VERSION', 'PAGE_SIZES', 'makeId'
  ]) {
    assert.ok(browser[name] !== undefined, `${name} pakette olmalı`);
  }
});

test('paket: şema sürümü Node sürümüyle aynı', () => {
  assert.strictEqual(browser.SCHEMA_VERSION, node.SCHEMA_VERSION);
  assert.deepStrictEqual(browser.PAGE_SIZES, node.PAGE_SIZES);
});

test('paket: SHA-256 uygulaması Node ile BİREBİR aynı sonucu verir', () => {
  // Varlık kimlikleri özetten türer; iki uygulama ayrışırsa aynı görsel
  // tarayıcıda başka, sunucuda başka kimlik alır ve gönderme kırılır.
  const cases = [
    Buffer.alloc(0),
    Buffer.from('a'),
    Buffer.from('Türkçe karakterler: ÇĞİÖŞÜ'),
    Buffer.alloc(55, 0x41),      // blok sınırının hemen altı
    Buffer.alloc(56, 0x42),      // dolgu tam sınırda
    Buffer.alloc(64, 0x43),      // tam bir blok
    Buffer.alloc(200, 0x44),
    crypto.randomBytes(5000)
  ];

  for (const buf of cases) {
    // Paket içindeki özet, AssetManager üzerinden gözlenebilir; boş girdi
    // reddedildiği için doğrudan PNG'ye sarıyoruz.
    const png = Buffer.concat([makePng(2, 2), buf]);
    const expected = crypto.createHash('sha256').update(png).digest('hex');

    const am = new browser.AssetManager();
    const asset = am.add(new Uint8Array(png));
    assert.strictEqual(asset.sha256, expected, `${buf.length} baytlık girdi`);
  }
});

test('paket: varlık kimliği iki tarafta AYNI çıkar', () => {
  const png = makePng(9, 4);
  const a = new browser.AssetManager().add(new Uint8Array(png));
  const b = new node.AssetManager().add(png);

  assert.strictEqual(a.id, b.id);
  assert.strictEqual(a.sha256, b.sha256);
  assert.strictEqual(a.width, b.width);
  assert.strictEqual(a.height, b.height);
  assert.strictEqual(a.mime, b.mime);
});

test('paket: doğrulayıcı iki tarafta AYNI kararı verir', () => {
  const documents = [
    { version: 1, page: { size: 'A4' }, pages: [{ id: 'p1', nodes: [] }] },
    { version: 1, page: { size: 'A4' }, pages: [] },
    { version: 9, page: { size: 'A4' }, pages: [{ id: 'p1', nodes: [] }] },
    {
      version: 1, page: { size: 'A4' },
      pages: [{ id: 'p1', nodes: [{
        id: 'x', type: 'text', frame: { x: 1, y: 2, width: 3, height: 4 },
        runs: [{ text: 'a', link: 'javascript:alert(1)' }]
      }] }]
    },
    {
      version: 1, page: { size: 'A4', margin: { top: '10mm' } },
      pages: [{ id: 'p1', nodes: [{
        id: 'r', type: 'rect', frame: { x: '1cm', y: 2, width: 3, height: 4 }, fill: 'rgb(1,2,3)'
      }] }]
    }
  ];

  for (const doc of documents) {
    const a = browser.validateScene(doc);
    const b = node.validateScene(doc);
    assert.strictEqual(a.scene === null, b.scene === null, JSON.stringify(doc).slice(0, 80));
    assert.deepStrictEqual(a.issues.map((i) => i.code), b.issues.map((i) => i.code));
    if (a.scene) assert.deepStrictEqual(a.scene, b.scene);
  }
});

test('paket: geometri iki tarafta aynı sonucu üretir', () => {
  const nodes = [
    { id: 'a', frame: { x: 0, y: 0, width: 100, height: 10 } },
    { id: 'b', frame: { x: 50, y: 20, width: 20, height: 10 } },
    { id: 'c', frame: { x: 130, y: 40, width: 30, height: 10 } }
  ];

  for (const how of ['left', 'right', 'hcenter', 'top', 'bottom', 'vcenter']) {
    assert.deepStrictEqual(
      [...browser.geometry.align(nodes, how)],
      [...node.geometry.align(nodes, how)], how);
  }
  assert.deepStrictEqual(
    [...browser.geometry.distribute(nodes, 'horizontal')],
    [...node.geometry.distribute(nodes, 'horizontal')]);
  assert.deepStrictEqual(
    browser.geometry.rotatedBounds({ x: 0, y: 0, width: 100, height: 40 }, 37),
    node.geometry.rotatedBounds({ x: 0, y: 0, width: 100, height: 40 }, 37));
});

test('paket: birim dönüşümleri aynı', () => {
  for (const v of ['10mm', '1in', '96px', 12, '2.5cm', '3pc']) {
    assert.strictEqual(browser.units.toPt(v), node.units.toPt(v), String(v));
  }
});

test('paket: belge düzenleme ve geri alma çalışır', () => {
  const s = browser.Scene.blank({ title: 'Tarayıcı' });
  let id;
  s.transaction('Ekle', () => {
    id = s.addNode(browser.Scene.createNode('rect', { x: 5, y: 5, width: 10, height: 10 })).id;
  });
  s.transaction('Taşı', () => { for (let i = 0; i < 40; i++) s.moveNode(id, 1, 0); });

  assert.strictEqual(s.node(id).frame.x, 45);
  s.undo();
  assert.strictEqual(s.node(id).frame.x, 5, 'sürükleme tek adım olmalı');
  s.redo();
  assert.strictEqual(s.node(id).frame.x, 45);
});

test('paket: kopyala/yapıştır base64 turunu bozmadan taşır', () => {
  const png = makePng(6, 3);
  const s = browser.Scene.blank();
  const asset = s.assets.add(new Uint8Array(png));
  s.transaction('Ekle', () => {
    s.addNode(browser.Scene.createNode('image', {
      id: 'im', x: 1, y: 2, width: 30, height: 20, assetId: asset.id
    }));
  });

  const clip = s.copy(['im']);
  const target = browser.Scene.blank();
  target.transaction('Yapıştır', () => target.paste(clip));

  assert.strictEqual(target.assets.size, 1);
  const bytes = target.assets.bytes(asset.id);
  assert.strictEqual(Buffer.from(bytes).toString('hex'), png.toString('hex'));
});

test('paket: tarayıcıda üretilen sahne SUNUCUDA doğrulanır', () => {
  const s = browser.Scene.blank({ title: 'Karşılıklı' });
  s.transaction('Kur', () => {
    s.addNode(browser.Scene.createNode('text', {
      x: 40, y: 60, width: 300, height: 40, text: 'İki tarafta da geçerli'
    }));
    s.addNode(browser.Scene.createNode('signature', {
      x: 40, y: 700, width: 200, height: 60, fieldName: 'Imza1'
    }));
  });

  const { scene: validated, issues } = node.validateScene(s.toJSON());
  assert.deepStrictEqual(issues, []);
  assert.ok(validated);

  // Ve aynı sahne gerçekten PDF'e derlenebilir
  const { pdf } = node.compileToPdf(s.toJSON(), {
    assets: new node.AssetManager(),
    fonts: [{ family: 'Ubuntu', src: path.resolve(__dirname, '../../assets/Ubuntu-Regular.ttf') }]
  });
  assert.ok(pdf.length > 1000);
});

test('paket: derleyiciler ve içe aktarıcılar pakete GİRMEZ', () => {
  // Bunlar font/görsel ayrıştırıcılarına ihtiyaç duyar ve sunucuda çalışır.
  // Pakete sızarlarsa tarayıcı yükü katlanır.
  const source = buildBrowserBundle();
  assert.ok(!source.includes("require('@fitfak/pdf-html"), 'pdf-html pakete girmemeli');
  assert.ok(!/__define\('\.\/compile/.test(source), 'derleyiciler girmemeli');
  assert.ok(!/__define\('\.\/import/.test(source), 'içe aktarıcılar girmemeli');
});

test('paket: her require ÇÖZÜLEBİLİR bir modüle gider', () => {
  // Asıl kural "şu paket girmesin" değil, "hiçbir require boşa çıkmasın".
  // Boşa çıkan bir require tarayıcıda ancak o kod yolu çalışınca patlar —
  // yani en kötü anda.
  const source = buildBrowserBundle();

  const defined = new Set(
    [...source.matchAll(/__define\((?:'([^']+)'|"([^"]+)")/g)].map((m) => m[1] || m[2]));
  assert.ok(defined.size >= 7, `tanımlı modül az: ${defined.size}`);

  const required = new Set(
    [...source.matchAll(/\brequire\((?:'([^']+)'|"([^"]+)")\)/g)].map((m) => m[1] || m[2]));

  for (const id of required) {
    if (id === 'crypto') continue;          // uyumluluk katmanı karşılar
    assert.ok(defined.has(id), `pakette çözülemeyen require: ${id}`);
  }
});

test('paket: çözülemeyen bir modül sessizce yutulmaz', () => {
  const source = buildBrowserBundle();
  // Kayıtsız bir modül istenirse anlaşılır bir hata verilmeli
  assert.match(source, /Paket içinde bulunamayan modül/);
});
