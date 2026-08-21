'use strict';
/**
 * Serileştirilebilir işlem günlüğü.
 *
 * Geri alma yığını KAPANIŞ tutar ve ağdan geçmez. Eşzamanlı düzenleme için
 * değişikliğin KENDİSİ veri olmalıdır. Bu testler iki şeyi zorlar:
 *   1. Her işlem JSON turundan geçip aynı sonucu vermeli.
 *   2. Uygulanamayan işlem SESSİZCE ATLANMAMALI — reddedilmeli.
 */

const test = require('node:test');
const assert = require('node:assert');

const { Scene } = require('@fitfak/pdf-scene');
const ops = require('@fitfak/pdf-scene/src/ops');

const rect = (id, extra = {}) => Scene.createNode('rect', {
  id, x: 10, y: 10, width: 50, height: 50, fill: '#ff0000', ...extra
});

/** İşlemi ağdan geçmiş gibi yapar: JSON'a çevirip geri okur. */
const wire = (list) => JSON.parse(JSON.stringify(list));

/* ================================================================== */
/* Uygulama                                                            */
/* ================================================================== */

test('işlem: düğüm ekleme, güncelleme, silme JSON turundan geçer', () => {
  const scene = Scene.blank({ title: 'İşlem' });

  ops.applyOps(scene, wire([
    { op: 'addNode', node: rect('r1') },
    { op: 'updateNode', nodeId: 'r1', patch: { fill: '#00ff00', frame: { x: 99 } } }
  ]));

  assert.strictEqual(scene.node('r1').fill, '#00ff00');
  assert.strictEqual(scene.node('r1').frame.x, 99);
  assert.strictEqual(scene.node('r1').frame.y, 10, 'çerçeve BİRLEŞTİRİLİR, ezilmez');

  ops.applyOps(scene, wire([{ op: 'removeNode', nodeId: 'r1' }]));
  assert.strictEqual(scene.node('r1'), null);
});

test('işlem: sayfa ve belge düzeyi işlemler', () => {
  const scene = Scene.blank({ title: 'Sayfalar' });

  ops.applyOps(scene, wire([
    { op: 'addPage', options: { id: 'pg2', name: 'İkinci' } },
    { op: 'movePage', pageId: 'pg2', index: 0 },
    { op: 'setMeta', meta: { title: 'Yeni başlık', lang: 'en-GB' } },
    { op: 'setPage', page: { margin: { left: 20 } } }
  ]));

  assert.strictEqual(scene.pages[0].id, 'pg2');
  assert.strictEqual(scene.doc.meta.title, 'Yeni başlık');
  assert.strictEqual(scene.doc.page.margin.left, 20);
  assert.strictEqual(scene.doc.page.margin.top, 56.7, 'diğer kenarlar korunmalı');

  ops.applyOps(scene, wire([{ op: 'removePage', pageId: 'pg2' }]));
  assert.strictEqual(scene.pages.length, 1);
});

test('işlem: z sırası değiştirme', () => {
  const scene = Scene.blank({});
  ops.applyOps(scene, wire([
    { op: 'addNode', node: rect('a') },
    { op: 'addNode', node: rect('b') },
    { op: 'reorder', nodeId: 'a', to: 'front' }
  ]));
  assert.deepStrictEqual(scene.pages[0].nodes.map((n) => n.id), ['b', 'a']);
});

test('işlem: TEK geri alma adımı olur', () => {
  const scene = Scene.blank({});
  ops.applyOps(scene, wire([
    { op: 'addNode', node: rect('a') },
    { op: 'addNode', node: rect('b') },
    { op: 'addNode', node: rect('c') }
  ]));

  scene.undo();
  assert.strictEqual(scene.pages[0].nodes.length, 0,
    'bir grup işlem tek adımda geri alınmalı');
});

/* ================================================================== */
/* Reddetme                                                            */
/* ================================================================== */

test('işlem: bilinmeyen işlem reddedilir', () => {
  const scene = Scene.blank({});
  assert.throws(() => ops.applyOps(scene, [{ op: 'dropDatabase' }]),
    (e) => e.code === 'ERR_OP_UNKNOWN');
});

test('işlem: eksik alan reddedilir', () => {
  const scene = Scene.blank({});
  assert.throws(() => ops.applyOps(scene, [{ op: 'updateNode', nodeId: 'a' }]),
    (e) => e.code === 'ERR_OP_FIELD');
});

test('işlem: SİLİNMİŞ düğüme dokunmak reddedilir', () => {
  // Hayalet nesneyi geri getirmek, kullanıcının sildiğini geri almaktır.
  const scene = Scene.blank({});
  assert.throws(() => ops.applyOps(scene, [{ op: 'updateNode', nodeId: 'yok', patch: {} }]),
    (e) => e.code === 'ERR_OP_MISSING');
});

test('işlem: var olan kimlikle ekleme reddedilir', () => {
  const scene = Scene.blank({});
  ops.applyOps(scene, wire([{ op: 'addNode', node: rect('a') }]));
  assert.throws(() => ops.applyOps(scene, wire([{ op: 'addNode', node: rect('a') }])),
    (e) => e.code === 'ERR_OP_DUPLICATE_ID');
});

test('işlem: bilinmeyen düğüm tipi reddedilir', () => {
  const scene = Scene.blank({});
  assert.throws(() => ops.applyOps(scene, [
    { op: 'addNode', node: { id: 'x', type: 'iframe', frame: { x: 0, y: 0, width: 1, height: 1 } } }
  ]), (e) => e.code === 'ERR_OP_NODE_TYPE');
});

test('işlem: biri başarısız olursa HEPSİ geri sarılır', () => {
  // Yarım uygulanmış bir grup, sunucuyla istemcinin sahnesini ayrıştırır.
  const scene = Scene.blank({});
  assert.throws(() => ops.applyOps(scene, wire([
    { op: 'addNode', node: rect('iyi') },
    { op: 'updateNode', nodeId: 'yok', patch: { fill: '#000000' } }
  ])));
  assert.strictEqual(scene.node('iyi'), null, 'ilk işlem de geri alınmalı');
});

test('işlem: sınırdan fazla işlem reddedilir', () => {
  const scene = Scene.blank({});
  const many = Array.from({ length: ops.MAX_OPS + 1 }, (_, i) => ({
    op: 'addNode', node: rect(`n${i}`)
  }));
  assert.throws(() => ops.applyOps(scene, many), (e) => e.code === 'ERR_OP_TOO_MANY');
});

/* ================================================================== */
/* Çakışma                                                             */
/* ================================================================== */

test('çakışma: aynı düğümün AYNI alanına dokunan işlemler çakışır', () => {
  const a = { op: 'updateNode', nodeId: 'r1', patch: { fill: '#ff0000' } };
  const b = { op: 'updateNode', nodeId: 'r1', patch: { fill: '#00ff00' } };
  assert.strictEqual(ops.overlaps(a, b), true);
});

test('çakışma: FARKLI alanlara dokunan işlemler çakışmaz', () => {
  // Birinin rengi, diğerinin konumu değiştirmesi çakışma değildir.
  const a = { op: 'updateNode', nodeId: 'r1', patch: { fill: '#ff0000' } };
  const b = { op: 'updateNode', nodeId: 'r1', patch: { frame: { x: 5 } } };
  assert.strictEqual(ops.overlaps(a, b), false);
});

test('çakışma: farklı düğümler çakışmaz', () => {
  const a = { op: 'updateNode', nodeId: 'r1', patch: { fill: '#ff0000' } };
  const b = { op: 'updateNode', nodeId: 'r2', patch: { fill: '#00ff00' } };
  assert.strictEqual(ops.overlaps(a, b), false);
});

test('çakışma: silme bütün nesneye dokunur', () => {
  const a = { op: 'updateNode', nodeId: 'r1', patch: { fill: '#ff0000' } };
  const b = { op: 'removeNode', nodeId: 'r1' };
  assert.strictEqual(ops.overlaps(a, b), true);
});

/* ================================================================== */
/* Yeniden kurma                                                       */
/* ================================================================== */

test('günlük: sahne işlemlerden yeniden kurulabilir', () => {
  // Günlük ile sahne ayrışmışsa bir yerde hata var demektir.
  const log = wire([
    { op: 'addNode', node: rect('a', { fill: '#123456' }) },
    { op: 'addNode', node: rect('b', { x: 100 }) },
    { op: 'updateNode', nodeId: 'a', patch: { opacity: 0.5 } },
    { op: 'reorder', nodeId: 'a', to: 'front' },
    { op: 'setMeta', meta: { title: 'Kurulan' } }
  ]);

  const direct = Scene.blank({});
  ops.applyOps(direct, log);
  const rebuilt = ops.replay(Scene, log);

  assert.deepStrictEqual(rebuilt.toJSON().pages, direct.toJSON().pages);
  assert.strictEqual(rebuilt.doc.meta.title, 'Kurulan');
});

test('setPageSize işlemi ağdan geçer ve karşı tarafta aynı kâğıdı kurar', () => {
  const local = Scene.blank();
  const peer = Scene.blank();

  const log = [];
  local.recordOps((op) => log.push(op));

  local.transaction('ölçü', () =>
    local.setPageSize(local.pages[0].id, { width: 841.89, height: 595.28 }));

  assert.deepStrictEqual(log.map((o) => o.op), ['setPageSize']);
  ops.applyOps(peer, log.map((o) => ({ ...o, pageId: peer.pages[0].id })));

  assert.strictEqual(peer.pageGeometry(0).width, 841.89);
  assert.strictEqual(peer.pageGeometry(0).height, 595.28);
});

test('sayfa çevirme ağdan geçerken ÖLÇÜ de gider', () => {
  // Yalnız düğümleri göndermek, karşı tarafta dönmüş içeriği dönmemiş
  // kâğıda basmak olurdu.
  const local = Scene.blank({ margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  const peer = Scene.blank({ margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  const node = { id: 'r1', x: 40, y: 40, width: 200, height: 60 };
  for (const s of [local, peer]) {
    s.transaction('kur', () => s.addNode(Scene.createNode('rect', node)));
  }

  const log = [];
  local.recordOps((op) => log.push(op));
  local.transaction('çevir', () => local.rotatePage(local.pages[0].id, 90));

  assert.deepStrictEqual(log.map((o) => o.op), ['setPageSize', 'replacePage']);
  ops.applyOps(peer, log.map((o) => ({ ...o, pageId: peer.pages[0].id })));

  assert.strictEqual(peer.pageGeometry(0).width, local.pageGeometry(0).width);
  assert.deepStrictEqual(peer.pages[0].nodes[0].frame, local.pages[0].nodes[0].frame);
  assert.strictEqual(peer.pages[0].nodes[0].rotation, 90);
});

test('setPageSize olmayan sayfayı REDDEDER', () => {
  const s = Scene.blank();
  assert.throws(
    () => ops.applyOps(s, [{ op: 'setPageSize', pageId: 'yok', size: { width: 100, height: 100 } }]),
    (err) => err.code === 'ERR_OP_MISSING');
});
