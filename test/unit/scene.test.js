'use strict';
/**
 * Sahne modeli birim testleri.
 *
 * Kapsam: şema doğrulama, geometri, varlık tekilleştirme, işlem tabanlı
 * geri alma, gruplama, kopyala/yapıştır.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const zlib = require('zlib');

const {
  Scene, validateScene, SceneError, AssetManager, History,
  geometry, units, parseColor, SCHEMA_VERSION
} = require('@fitfak/pdf-scene');

/** Hata KODUNA göre eşleştirir: metin çevrilebilir, kod sözleşmedir. */
const hasCode = (code) => (err) => err && err.code === code;

/* ================================================================== */
/* Birimler                                                            */
/* ================================================================== */

test('birim: mm/px/in punto ya çevrilir', () => {
  assert.strictEqual(units.round(units.toPt('10mm')), 28.346);
  assert.strictEqual(units.toPt('1in'), 72);
  assert.strictEqual(units.toPt('96px'), 72);
  assert.strictEqual(units.toPt('12'), 12);
  assert.strictEqual(units.toPt(12), 12);
  assert.strictEqual(units.toPt('  -3.5 pt '), -3.5);
});

test('birim: bilinmeyen birim ve saçma değer reddedilir', () => {
  assert.throws(() => units.toPt('10parsek'), /Bilinmeyen birim/);
  assert.throws(() => units.toPt('abc'), /çözümlenemedi/);
  assert.throws(() => units.toPt(Infinity), /Sonlu olmayan/);
  assert.throws(() => units.toPt(NaN), /Sonlu olmayan/);
});

test('birim: yuvarlama -0 üretmez', () => {
  assert.strictEqual(Object.is(units.round(-0.0001), -0), false);
  assert.strictEqual(units.round(-0.0001), 0);
});

/* ================================================================== */
/* Şema doğrulama                                                      */
/* ================================================================== */

const minimal = () => ({
  version: SCHEMA_VERSION,
  page: { size: 'A4' },
  pages: [{ id: 'pg1', nodes: [] }]
});

test('şema: en küçük geçerli sahne kabul edilir ve normalleşir', () => {
  const { scene, issues } = validateScene(minimal());
  assert.deepStrictEqual(issues, []);
  assert.strictEqual(scene.page.width, 595.28);
  assert.strictEqual(scene.page.height, 841.89);
  assert.strictEqual(scene.meta.lang, 'tr-TR');
  assert.deepStrictEqual(scene.page.margin, { top: 0, right: 0, bottom: 0, left: 0 });
});

test('şema: sürüm uyuşmazlığı reddedilir', () => {
  const { scene, issues } = validateScene({ ...minimal(), version: 99 });
  assert.strictEqual(scene, null);
  assert.ok(issues.some((i) => i.code === 'ERR_VERSION'));
});

test('şema: bilinmeyen düğüm tipi reddedilir', () => {
  const doc = minimal();
  doc.pages[0].nodes = [{ id: 'a', type: 'iframe', frame: { x: 0, y: 0, width: 1, height: 1 } }];
  const { scene, issues } = validateScene(doc);
  assert.strictEqual(scene, null);
  assert.ok(issues.some((i) => i.code === 'ERR_NODE_TYPE'));
});

test('şema: bilinmeyen alanlar sessizce ATILIR', () => {
  const doc = minimal();
  doc.pages[0].nodes = [{
    id: 'a', type: 'rect', frame: { x: 0, y: 0, width: 10, height: 10 },
    onclick: 'alert(1)', __proto__field: 'x', script: '<script>'
  }];
  const { scene } = validateScene(doc);
  assert.ok(scene);
  const node = scene.pages[0].nodes[0];
  assert.strictEqual(node.onclick, undefined);
  assert.strictEqual(node.script, undefined);
});

test('şema: yinelenen kimlik reddedilir', () => {
  const doc = minimal();
  doc.pages[0].nodes = [
    { id: 'ayni', type: 'rect', frame: { x: 0, y: 0, width: 1, height: 1 } },
    { id: 'ayni', type: 'rect', frame: { x: 0, y: 0, width: 1, height: 1 } }
  ];
  const { scene, issues } = validateScene(doc);
  assert.strictEqual(scene, null);
  assert.ok(issues.some((i) => i.code === 'ERR_DUPLICATE_ID'));
});

test('şema: aşırı yuvalama derinliği reddedilir', () => {
  const doc = minimal();
  let node = { id: 'g0', type: 'group', frame: { x: 0, y: 0, width: 10, height: 10 }, children: [] };
  doc.pages[0].nodes = [node];
  for (let i = 1; i < 60; i++) {
    const child = { id: 'g' + i, type: 'group', frame: { x: 0, y: 0, width: 1, height: 1 }, children: [] };
    node.children.push(child);
    node = child;
  }
  const { scene, issues } = validateScene(doc);
  assert.strictEqual(scene, null);
  assert.ok(issues.some((i) => i.code === 'ERR_DEPTH'));
});

test('şema: var olmayan varlık göndermesi yakalanır', () => {
  const doc = minimal();
  doc.pages[0].nodes = [{
    id: 'im', type: 'image', frame: { x: 0, y: 0, width: 10, height: 10 }, assetId: 'ast_yok'
  }];
  const { scene, issues } = validateScene(doc);
  assert.strictEqual(scene, null);
  assert.ok(issues.some((i) => i.code === 'ERR_ASSET_MISSING'));
});

test('şema: tehlikeli bağlantı şemaları reddedilir', () => {
  const mkDoc = (link) => {
    const doc = minimal();
    doc.pages[0].nodes = [{
      id: 't', type: 'text', frame: { x: 0, y: 0, width: 10, height: 10 },
      runs: [{ text: 'tıkla', link }]
    }];
    return doc;
  };

  for (const bad of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:msgbox',
    '  javascript:alert(1)'
  ]) {
    const { scene, issues } = validateScene(mkDoc(bad));
    assert.strictEqual(scene, null, `${bad} kabul edilmemeliydi`);
    assert.ok(issues.some((i) => i.code === 'ERR_LINK_SCHEME'), bad);
  }

  for (const ok of ['https://ornek.test/a', 'http://ornek.test', 'mailto:a@b.test']) {
    const { scene } = validateScene(mkDoc(ok));
    assert.ok(scene, `${ok} kabul edilmeliydi`);
  }
});

test('şema: NUL baytı içeren metin reddedilir', () => {
  const doc = minimal();
  doc.pages[0].nodes = [{
    id: 't', type: 'text', frame: { x: 0, y: 0, width: 10, height: 10 }, text: 'a\0b'
  }];
  const { scene, issues } = validateScene(doc);
  assert.strictEqual(scene, null);
  assert.ok(issues.some((i) => i.code === 'ERR_NUL'));
});

test('şema: aralık dışı değerler reddedilir', () => {
  const doc = minimal();
  doc.pages[0].nodes = [{
    id: 't', type: 'text', frame: { x: 0, y: 0, width: 10, height: 10 },
    fontSize: 100000, opacity: 5
  }];
  const { scene, issues } = validateScene(doc);
  assert.strictEqual(scene, null);
  assert.strictEqual(issues.filter((i) => i.code === 'ERR_RANGE').length, 2);
});

test('şema: renkler tek biçime getirilir', () => {
  assert.deepStrictEqual(parseColor('#abc'), [0xaa, 0xbb, 0xcc]);
  assert.deepStrictEqual(parseColor('#A1B2C3'), [0xa1, 0xb2, 0xc3]);
  assert.deepStrictEqual(parseColor('rgb(1, 2, 3)'), [1, 2, 3]);
  assert.strictEqual(parseColor('mavi'), null);
  assert.strictEqual(parseColor('#12345'), null);

  const doc = minimal();
  doc.pages[0].nodes = [{
    id: 'r', type: 'rect', frame: { x: 0, y: 0, width: 1, height: 1 }, fill: 'rgb(255,0,128)'
  }];
  const { scene } = validateScene(doc);
  assert.strictEqual(scene.pages[0].nodes[0].fill, '#ff0080');
});

test('şema: sayfasız sahne reddedilir', () => {
  const { scene, issues } = validateScene({ version: SCHEMA_VERSION, page: { size: 'A4' }, pages: [] });
  assert.strictEqual(scene, null);
  assert.ok(issues.some((i) => i.code === 'ERR_EMPTY'));
});

test('şema: hatalar biriktirilir, ilkinde durulmaz', () => {
  const doc = minimal();
  doc.pages[0].nodes = [
    { id: '1gecersiz', type: 'rect', frame: { x: 0, y: 0, width: 1, height: 1 } },
    { id: 'ok', type: 'bilinmeyen', frame: { x: 0, y: 0, width: 1, height: 1 } },
    { id: 'ok2', type: 'text', frame: { x: 0, y: 0, width: 1, height: 1 }, opacity: 9 }
  ];
  const { issues } = validateScene(doc);
  assert.ok(issues.length >= 3, `en az 3 sorun bekleniyordu, ${issues.length} geldi`);
});

/* ================================================================== */
/* Geometri                                                            */
/* ================================================================== */

test('geometri: matris çarpımı ve tersi', () => {
  const m = geometry.multiply(geometry.translate(10, 20), geometry.scale(2));
  const p = geometry.apply(m, 3, 4);
  assert.deepStrictEqual(p, { x: 16, y: 28 });

  const inv = geometry.invert(m);
  const back = geometry.apply(inv, p.x, p.y);
  assert.strictEqual(units.round(back.x), 3);
  assert.strictEqual(units.round(back.y), 4);

  assert.strictEqual(geometry.invert([0, 0, 0, 0, 0, 0]), null, 'tekil matris null dönmeli');
});

test('geometri: döndürülmüş sınır kutusu büyür', () => {
  const b = geometry.rotatedBounds({ x: 0, y: 0, width: 100, height: 100 }, 45);
  assert.ok(b.width > 140 && b.width < 142, `beklenen ~141.42, gelen ${b.width}`);
  assert.strictEqual(units.round(b.width), units.round(b.height));
});

test('geometri: grup içindeki düğümün mutlak çerçevesi', () => {
  const group = { id: 'g', type: 'group', frame: { x: 100, y: 200, width: 50, height: 50 }, rotation: 0 };
  const child = { id: 'c', type: 'rect', frame: { x: 10, y: 5, width: 20, height: 20 }, rotation: 0 };
  const abs = geometry.absoluteFrame([group, child]);
  assert.deepStrictEqual(
    { x: abs.x, y: abs.y, width: abs.width, height: abs.height },
    { x: 110, y: 205, width: 20, height: 20 });
});

test('geometri: düğümün kendi dönmesi x/y ye karışmaz, ayrı döner', () => {
  const node = { id: 'n', type: 'rect', frame: { x: 10, y: 20, width: 30, height: 40 }, rotation: 30 };
  const abs = geometry.absoluteFrame([node]);
  assert.strictEqual(abs.x, 10);
  assert.strictEqual(abs.y, 20);
  assert.strictEqual(abs.rotation, 30);
});

test('geometri: hizalama yeni konum döndürür, düğüme dokunmaz', () => {
  const nodes = [
    { id: 'a', frame: { x: 0, y: 0, width: 100, height: 10 } },
    { id: 'b', frame: { x: 50, y: 20, width: 20, height: 10 } }
  ];
  const res = geometry.align(nodes, 'right');
  assert.strictEqual(res.get('a').x, 0);
  assert.strictEqual(res.get('b').x, 80);
  assert.strictEqual(nodes[1].frame.x, 50, 'geometri saf olmalı');
});

test('geometri: dağıtım eşit ARALIK bırakır', () => {
  const nodes = [
    { id: 'a', frame: { x: 0, y: 0, width: 10, height: 10 } },
    { id: 'b', frame: { x: 20, y: 0, width: 40, height: 10 } },
    { id: 'c', frame: { x: 90, y: 0, width: 10, height: 10 } }
  ];
  const res = geometry.distribute(nodes, 'horizontal');
  const a = res.get('a').x, b = res.get('b').x, c = res.get('c').x;
  assert.strictEqual(a, 0);
  assert.strictEqual(c, 90);
  // aralıklar eşit: (b - (a+10)) === (c - (b+40))
  assert.strictEqual(units.round(b - (a + 10)), units.round(c - (b + 40)));
});

test('geometri: yapışma eşik içinde çalışır, dışında çalışmaz', () => {
  const page = { width: 595.28, height: 841.89, margin: { top: 50, right: 50, bottom: 50, left: 50 } };
  const others = [{ x: 200, y: 100, width: 100, height: 50 }];

  const near = geometry.snap({ x: 202, y: 300, width: 40, height: 20 }, others, page, { threshold: 4 });
  assert.strictEqual(near.x, 200, 'eşik içindeki kenar yapışmalı');
  assert.ok(near.guides.some((g) => g.axis === 'x' && g.at === 200));

  const far = geometry.snap({ x: 240, y: 300, width: 40, height: 20 }, others, page, { threshold: 4 });
  assert.strictEqual(far.x, 240, 'eşik dışında konum değişmemeli');
});

test('geometri: ızgaraya yuvarlama', () => {
  assert.strictEqual(geometry.snapToGrid(13, 5), 15);
  assert.strictEqual(geometry.snapToGrid(12, 5), 10);
  assert.strictEqual(geometry.snapToGrid(12.345, 0), 12.345);
});

/* ================================================================== */
/* Varlıklar                                                           */
/* ================================================================== */

/** Küçük ama GEÇERLİ bir PNG üretir (IHDR boyutları gerçek olsun diye). */
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
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

test('varlık: aynı içerik İKİ KEZ eklenince tek kayıt olur', () => {
  const am = new AssetManager();
  const png = makePng(4, 3);
  const a = am.add(png, { name: 'bir.png' });
  const b = am.add(Buffer.from(png), { name: 'baska-ad.png' });

  assert.strictEqual(a.id, b.id, 'özet aynıysa kimlik de aynı olmalı');
  assert.strictEqual(am.size, 1);
  assert.strictEqual(a.width, 4);
  assert.strictEqual(a.height, 3);
  assert.strictEqual(a.mime, 'image/png');
});

test('varlık: tür BAYTTAN belirlenir, addan değil', () => {
  const am = new AssetManager();
  assert.throws(
    () => am.add(Buffer.from('MZ\x90\x00 bu bir yürütülebilir'), { name: 'resim.png' }),
    hasCode('ERR_ASSET_TYPE'));
});

test('varlık: bildirilen tür baytla çelişirse reddedilir', () => {
  const am = new AssetManager();
  assert.throws(() => am.add(makePng(2, 2), { kind: 'font' }), hasCode('ERR_ASSET_KIND'));
});

test('varlık: boyut ve piksel sınırları uygulanır', () => {
  const small = new AssetManager({ limits: { maxBytes: 32 } });
  assert.throws(() => small.add(makePng(8, 8)), hasCode('ERR_ASSET_TOO_LARGE'));

  const fewPixels = new AssetManager({ limits: { maxPixels: 4 } });
  assert.throws(() => fewPixels.add(makePng(10, 10)), hasCode('ERR_ASSET_PIXELS'));
});

test('varlık: sayı ve toplam boyut sınırları uygulanır', () => {
  const am = new AssetManager({ limits: { maxAssets: 2 } });
  am.add(makePng(1, 1));
  am.add(makePng(1, 2));
  assert.throws(() => am.add(makePng(1, 3)), hasCode('ERR_ASSET_TOO_MANY'));
});

test('varlık: JPEG boyutu SOF işaretçisinden okunur', () => {
  // Küçük ama biçimsel olarak doğru bir JPEG başlığı
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),                                  // SOI
    Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),          // APP0 (boş)
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),                // SOF0
    Buffer.from([0x01, 0x40, 0x02, 0x30]),                      // yükseklik 320, genişlik 560
    Buffer.alloc(8),
    Buffer.from([0xff, 0xd9])                                   // EOI
  ]);
  const am = new AssetManager();
  const a = am.add(jpeg);
  assert.strictEqual(a.mime, 'image/jpeg');
  assert.strictEqual(a.height, 320);
  assert.strictEqual(a.width, 560);
});

test('varlık: prune yalnız kullanılmayanları atar', () => {
  const am = new AssetManager();
  const kept = am.add(makePng(2, 2));
  am.add(makePng(3, 3));
  assert.strictEqual(am.size, 2);
  assert.strictEqual(am.prune([kept.id]), 1);
  assert.strictEqual(am.size, 1);
  assert.ok(am.has(kept.id));
});

/* ================================================================== */
/* Belge işlemleri ve geri alma                                        */
/* ================================================================== */

test('sahne: değişiklik transaction dışında yapılamaz', () => {
  const s = Scene.blank();
  assert.throws(
    () => s.addNode(Scene.createNode('rect', {})),
    /transaction\(\) içinde/);
});

test('sahne: bir sürükleme TEK geri alma adımıdır', () => {
  const s = Scene.blank();
  let id;
  s.transaction('Ekle', () => {
    id = s.addNode(Scene.createNode('rect', { x: 0, y: 0, width: 10, height: 10 })).id;
  });

  // 60 fare olayı — hepsi TEK işlem içinde
  s.transaction('Taşı', () => {
    for (let i = 0; i < 60; i++) s.moveNode(id, 1, 1);
  });

  assert.deepStrictEqual(s.node(id).frame, { x: 60, y: 60, width: 10, height: 10 });
  assert.strictEqual(s.history.undoStack.length, 2, 'ekle + taşı = 2 adım');

  s.undo();
  assert.deepStrictEqual(s.node(id).frame, { x: 0, y: 0, width: 10, height: 10 },
    'tek Ctrl+Z bütün sürüklemeyi geri almalı');
});

test('sahne: aynı mergeKey ile ardışık işlemler birleşir', () => {
  const s = Scene.blank({ });
  let now = 1000;
  s.history.now = () => now;
  s.history.mergeWindowMs = 500;

  let id;
  s.transaction('Ekle', () => { id = s.addNode(Scene.createNode('rect', {})).id; });
  const base = s.history.undoStack.length;

  for (let i = 0; i < 5; i++) {
    now += 50;
    s.transaction('Kaydır', () => s.moveNode(id, 1, 0), { mergeKey: 'nudge:' + id });
  }
  assert.strictEqual(s.history.undoStack.length, base + 1, 'beş ok tuşu tek adım olmalı');

  s.undo();
  assert.strictEqual(s.node(id).frame.x, 0);
});

test('sahne: pencere dışına çıkan işlem birleşmez', () => {
  const s = Scene.blank();
  let now = 1000;
  s.history.now = () => now;
  s.history.mergeWindowMs = 100;

  let id;
  s.transaction('Ekle', () => { id = s.addNode(Scene.createNode('rect', {})).id; });
  s.transaction('Kaydır', () => s.moveNode(id, 1, 0), { mergeKey: 'n' });
  now += 5000;
  s.transaction('Kaydır', () => s.moveNode(id, 1, 0), { mergeKey: 'n' });

  assert.strictEqual(s.history.undoStack.length, 3);
});

test('sahne: boş işlem geri alma yığınına yazılmaz', () => {
  const s = Scene.blank();
  s.transaction('Hiçbir şey', () => {});
  assert.strictEqual(s.history.canUndo, false);

  let id;
  s.transaction('Ekle', () => { id = s.addNode(Scene.createNode('rect', { x: 5, y: 5 })).id; });
  const depth = s.history.undoStack.length;
  s.transaction('Aynı değeri yaz', () => s.updateNode(id, { frame: { x: 5, y: 5 } }));
  assert.strictEqual(s.history.undoStack.length, depth, 'değişmeyen alan adım üretmemeli');
});

test('sahne: işlem içinde hata olursa değişiklikler geri alınır', () => {
  const s = Scene.blank();
  let id;
  s.transaction('Ekle', () => { id = s.addNode(Scene.createNode('rect', {})).id; });

  assert.throws(() => s.transaction('Yarım kalan', () => {
    s.moveNode(id, 100, 100);
    s.addNode(Scene.createNode('rect', {}));
    throw new Error('bir şeyler patladı');
  }), /patladı/);

  assert.strictEqual(s.pages[0].nodes.length, 1, 'eklenen düğüm geri alınmalı');
  assert.deepStrictEqual(s.node(id).frame.x, 0, 'taşıma geri alınmalı');
  assert.strictEqual(s.history.isOpen, false);
});

test('sahne: yeni değişiklik ileri geçmişi siler', () => {
  const s = Scene.blank();
  s.transaction('A', () => s.addNode(Scene.createNode('rect', { id: 'a' })));
  s.transaction('B', () => s.addNode(Scene.createNode('rect', { id: 'b' })));
  s.undo();
  assert.strictEqual(s.history.canRedo, true);
  s.transaction('C', () => s.addNode(Scene.createNode('rect', { id: 'c' })));
  assert.strictEqual(s.history.canRedo, false);
});

test('sahne: z sırası değiştirilir ve geri alınır', () => {
  const s = Scene.blank();
  s.transaction('Ekle', () => {
    for (const id of ['a', 'b', 'c']) s.addNode(Scene.createNode('rect', { id }));
  });
  const order = () => s.pages[0].nodes.map((n) => n.id).join('');

  assert.strictEqual(order(), 'abc');
  s.transaction('Öne al', () => s.reorder('a', 'front'));
  assert.strictEqual(order(), 'bca');
  s.transaction('Bir geri', () => s.reorder('a', 'backward'));
  assert.strictEqual(order(), 'bac');
  s.undo();
  assert.strictEqual(order(), 'bca');
  s.undo();
  assert.strictEqual(order(), 'abc');
});

test('sahne: gruplama koordinatları göreceli yapar, çözme geri alır', () => {
  const s = Scene.blank();
  s.transaction('Ekle', () => {
    s.addNode(Scene.createNode('rect', { id: 'a', x: 100, y: 100, width: 50, height: 50 }));
    s.addNode(Scene.createNode('rect', { id: 'b', x: 200, y: 150, width: 50, height: 50 }));
  });

  let g;
  s.transaction('Gruplandır', () => { g = s.group(['a', 'b']); });

  assert.strictEqual(s.pages[0].nodes.length, 1);
  assert.deepStrictEqual(g.frame, { x: 100, y: 100, width: 150, height: 100 });
  assert.deepStrictEqual(s.node('a').frame, { x: 0, y: 0, width: 50, height: 50 });
  assert.deepStrictEqual(s.node('b').frame, { x: 100, y: 50, width: 50, height: 50 });

  // Mutlak konum korunmuş olmalı
  const abs = s.absoluteFrame('b');
  assert.strictEqual(abs.x, 200);
  assert.strictEqual(abs.y, 150);

  // Grubu taşımak çocukların mutlak konumunu kaydırır
  s.transaction('Grubu taşı', () => s.moveNode(g.id, 10, 20));
  assert.strictEqual(s.absoluteFrame('b').x, 210);
  assert.strictEqual(s.absoluteFrame('b').y, 170);

  s.undo();
  s.transaction('Çöz', () => s.ungroup(g.id));
  assert.strictEqual(s.pages[0].nodes.length, 2);
  assert.deepStrictEqual(s.node('b').frame, { x: 200, y: 150, width: 50, height: 50 });

  s.undo();
  assert.strictEqual(s.pages[0].nodes.length, 1, 'çözme geri alınmalı');
  assert.deepStrictEqual(s.node('b').frame, { x: 100, y: 50, width: 50, height: 50 });
});

test('sahne: gruplama en az iki düğüm ister ve sayfa karıştırmaz', () => {
  const s = Scene.blank();
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('rect', { id: 'a' }));
    s.addPage({ id: 'pg2' });
    s.addNode(Scene.createNode('rect', { id: 'b' }), { pageId: 'pg2' });
  });

  s.transaction('Tek düğüm', () => assert.strictEqual(s.group(['a']), null));
  assert.throws(() => s.transaction('Çapraz', () => s.group(['a', 'b'])), hasCode('ERR_GROUP_PAGES'));
});

test('sahne: kopyala/yapıştır yeni kimlik üretir, varlığı taşır', () => {
  const s = Scene.blank();
  const png = makePng(2, 2);
  const asset = s.assets.add(png, { name: 'logo.png' });

  s.transaction('Ekle', () => {
    s.addNode(Scene.createNode('image', {
      id: 'im', x: 10, y: 10, width: 40, height: 40, assetId: asset.id
    }));
  });

  const clip = s.copy(['im']);
  assert.strictEqual(clip.assets.length, 1);
  assert.ok(clip.assets[0].base64, 'varlık baytları pakete girmeli');

  let pasted;
  s.transaction('Yapıştır', () => { pasted = s.paste(clip); });
  assert.strictEqual(pasted.length, 1);
  assert.notStrictEqual(pasted[0].id, 'im', 'kimlik yeniden üretilmeli');
  assert.strictEqual(pasted[0].assetId, asset.id, 'aynı belgede varlık paylaşılır');
  assert.strictEqual(pasted[0].frame.x, 20, 'yapıştırma kaydırılmalı');
  assert.strictEqual(s.assets.size, 1, 'aynı içerik iki kez gömülmemeli');

  // BAŞKA bir belgeye yapıştırmak baytları taşır
  const other = Scene.blank();
  other.transaction('Yapıştır', () => other.paste(clip));
  assert.strictEqual(other.assets.size, 1);
  assert.ok(other.assets.bytes(asset.id).equals(png));
});

test('sahne: kilitli düğüm taşınmaz', () => {
  const s = Scene.blank();
  s.transaction('Ekle', () => s.addNode(Scene.createNode('rect', { id: 'a', locked: true })));
  s.transaction('Taşı', () => s.moveNode('a', 10, 10));
  assert.strictEqual(s.node('a').frame.x, 0);
});

test('sahne: son sayfa silinemez', () => {
  const s = Scene.blank();
  assert.throws(() => s.transaction('Sil', () => s.removePage('pg1')), hasCode('ERR_LAST_PAGE'));

  s.transaction('Ekle', () => s.addPage({ id: 'pg2' }));
  s.transaction('Sil', () => s.removePage('pg1'));
  assert.strictEqual(s.pages.length, 1);
  s.undo();
  assert.strictEqual(s.pages.length, 2);
  assert.strictEqual(s.pages[0].id, 'pg1', 'sayfa eski yerine dönmeli');
});

test('sahne: sayfaya hizalama kenar boşluklarını kullanır', () => {
  const s = Scene.blank({ margin: { top: 50, right: 50, bottom: 50, left: 50 } });
  s.transaction('Ekle', () => {
    s.addNode(Scene.createNode('rect', { id: 'a', x: 0, y: 0, width: 100, height: 20 }));
    s.addNode(Scene.createNode('rect', { id: 'b', x: 0, y: 0, width: 100, height: 20 }));
  });
  s.transaction('Ortala', () => s.alignToPage(['a', 'b'], 'hcenter'));

  const inner = s.page.width - 100;
  assert.strictEqual(s.node('a').frame.x, units.round(50 + (inner - 100) / 2 - 0));
});

test('sahne: JSON turu belgeyi bozmaz', () => {
  const s = Scene.blank({ title: 'Tur' });
  s.transaction('Kur', () => {
    s.addNode(Scene.createNode('text', { id: 'a', text: 'Türkçe İĞÜŞÖÇ', x: 10, y: 20 }));
    s.addNode(Scene.createNode('signature', {
      id: 'sig', x: 100, y: 700, width: 180, height: 60, fieldName: 'Signature1'
    }));
  });

  const json = JSON.parse(JSON.stringify(s.toJSON()));
  const back = Scene.fromJSON(json);
  assert.deepStrictEqual(back.toJSON(), s.toJSON());
  assert.strictEqual(back.node('a').text, 'Türkçe İĞÜŞÖÇ');
});

test('sahne: bozuk belge yüklenmez (yarım geçerli nesne kurulmaz)', () => {
  assert.throws(() => Scene.fromJSON({ version: 1, page: { size: 'A4' }, pages: 'sayfa değil' }),
    (err) => err instanceof SceneError && err.issues.length > 0);
});

/* ================================================================== */
/* Geçmiş yığını                                                       */
/* ================================================================== */

test('geçmiş: sınır aşılınca en eski adım düşer', () => {
  const h = new History({ limit: 3 });
  for (let i = 0; i < 5; i++) {
    h.begin('adım ' + i);
    h.record(() => {}, () => {});
    h.commit();
  }
  assert.strictEqual(h.undoStack.length, 3);
  assert.strictEqual(h.undoStack[0].label, 'adım 2');
});

test('geçmiş: iç içe işlem tek adım olur', () => {
  const h = new History();
  h.begin('dış');
  h.begin('iç');
  h.record(() => {}, () => {});
  assert.strictEqual(h.commit(), null, 'iç commit kapatmamalı');
  h.record(() => {}, () => {});
  const tx = h.commit();
  assert.ok(tx);
  assert.strictEqual(tx.label, 'dış');
  assert.strictEqual(tx.entries.length, 2);
  assert.strictEqual(h.undoStack.length, 1);
});

test('geçmiş: açık işlem varken undo çağrılamaz', () => {
  const h = new History();
  h.begin('açık');
  assert.throws(() => h.undo(), /açık işlem/);
});
