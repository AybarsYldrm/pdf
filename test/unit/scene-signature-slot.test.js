'use strict';
/**
 * İmza yuvası koordinat zinciri.
 *
 *   Sahne düğümü → derleyici manifesti → PAdES görünür imza dikdörtgeni
 *
 * Bu zincirin herhangi bir halkasında sayfa yüksekliğini yanlış almak,
 * imzanın belgede BAŞKA BİR YERE basılması demektir — ve bu, kâğıda çıktı
 * alınana kadar fark edilmez. Bu yüzden zincir uçtan uca sınanır ve yatay
 * sayfa gibi "genellikle denenmeyen" hâller ayrıca yazılır.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { Scene, compileToPdf, pagespace } = require('@fitfak/pdf-scene');

const ROOT = path.resolve(__dirname, '..', '..');
const FONTS = [{ family: 'Ubuntu', src: path.join(ROOT, 'assets', 'Ubuntu-Regular.ttf') }];

const near = (a, b, tol = 0.01) =>
  assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b} değil (fark ${Math.abs(a - b)})`);

/** Belirtilen ölçüde, tek imza yuvalı bir belge derler. */
function compileWithSlot(size, rect, pageOpts = null) {
  const s = Scene.blank({
    title: 'imza', size, margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });
  s.transaction('kur', () => {
    if (pageOpts) s.addPage(pageOpts);
    s.addNode(Scene.createNode('signature', {
      id: 'sig1', fieldName: 'imza1', signer: 'aybars', signerTitle: 'Düzenleyen',
      x: rect.x, y: rect.y, width: rect.width, height: rect.height
    }), pageOpts ? { pageId: pageOpts.id } : {});
  });
  return { scene: s, result: compileToPdf(s, { fonts: FONTS }) };
}

test('yuva, sahne ve PDF koordinatlarını BİRLİKTE bildirir', () => {
  const rect = { x: 100, y: 60, width: 200, height: 70 };
  const { result } = compileWithSlot({ width: 595.28, height: 841.89 }, rect);

  const slots = result.manifest.signatureSlots;
  assert.strictEqual(slots.length, 1);
  const slot = slots[0];

  assert.strictEqual(slot.fieldName, 'imza1');
  assert.strictEqual(slot.signer, 'aybars');
  assert.strictEqual(slot.role, 'Düzenleyen');
  assert.strictEqual(slot.page, 0);
  assert.strictEqual(slot.origin, 'bottom-left');

  // Sahne dikdörtgeni birebir korunur (sol-ÜST başlangıç).
  assert.deepStrictEqual(slot.sceneRect, rect);

  // PDF dikdörtgeni sol-ALT başlangıçlıdır: y = H − y − h.
  near(slot.rect.x, 100);
  near(slot.rect.y, 841.89 - 60 - 70);
  near(slot.rect.width, 200);
  near(slot.rect.height, 70);
});

test('YATAY sayfada da yuva doğru yere düşer', () => {
  // Yatay ölçü, "portrait" varsayılanı tarafından sessizce çevrilirse yuva
  // sayfanın dışına taşar. Manifest bu yüzden ölçüyü de bildirir.
  const rect = { x: 600, y: 40, width: 180, height: 60 };
  const { result } = compileWithSlot({ width: 841.89, height: 595.28 }, rect);

  const page = result.manifest.pages[0];
  near(page.width, 841.89);
  near(page.height, 595.28);

  const slot = result.manifest.signatureSlots[0];
  near(slot.rect.x, 600);
  near(slot.rect.y, 595.28 - 40 - 60);
  assert.ok(slot.rect.x + slot.rect.width <= page.width + 0.01,
    'yuva sayfanın içinde kalmalı');
});

test('sayfaya özgü ölçüde yuva, O SAYFANIN yüksekliğine göre çevrilir', () => {
  // Belge dikey, ikinci sayfa yatay. Belge yüksekliğini kullanmak, yuvayı
  // 246 punto yukarı kaydırırdı — ve bu ancak imza basıldığında görülürdü.
  const rect = { x: 500, y: 100, width: 200, height: 70 };
  const { result } = compileWithSlot(
    { width: 595.28, height: 841.89 }, rect,
    { id: 'pg2', name: 'Yatay', width: 841.89, height: 595.28 });

  const slots = result.manifest.signatureSlots;
  assert.strictEqual(slots.length, 1);
  const slot = slots[0];

  assert.strictEqual(slot.page, 1);
  near(result.manifest.pages[1].height, 595.28);
  near(slot.rect.y, 595.28 - 100 - 70);
  assert.deepStrictEqual(slot.sceneRect, rect);
});

test('PAdES görünür imzası manifest yuvasını olduğu gibi kullanır', () => {
  const { fromManifestSlot } = require('@fitfak/pades/src/signature/visible');

  const rect = { x: 120, y: 80, width: 200, height: 70 };
  const { result } = compileWithSlot({ width: 595.28, height: 841.89 }, rect);
  const slot = result.manifest.signatureSlots[0];

  const visible = fromManifestSlot(slot, { seed: 1, vars: { signerName: 'AD SOYAD' } });
  assert.ok(visible, 'görünür imza yapılandırması üretilmeli');
  assert.strictEqual(visible.page, 0);

  // Görünür imza motoru sol-ALT başlangıç bekler; manifest onu öyle verir ve
  // arada hiçbir çevirme YAPILMAZ — yapılsaydı iki kez çevrilmiş olurdu.
  const pos = visible.defaultPosition;
  assert.strictEqual(pos.origin, 'bottom-left');
  near(pos.x, slot.rect.x);
  near(pos.y, slot.rect.y);
  near(pos.width, slot.rect.width);
  near(pos.height, slot.rect.height);
});

test('yuva dikdörtgeni sayfa uzayı motoruyla AYNI sonucu verir', () => {
  // Derleyicideki çevirme ile `pagespace.sceneRectToPdf` ayrışırsa, biri
  // düzeltilip öteki unutulduğunda imza kayar. İkisi tek gerçeğe çıkmalı.
  const rect = { x: 100, y: 60, width: 200, height: 70 };
  const { result } = compileWithSlot({ width: 595.28, height: 841.89 }, rect);
  const slot = result.manifest.signatureSlots[0];

  // Sahne bir PDF sayfasına derlenir: dönme yok, başlangıç (0,0).
  const geo = pagespace.effectiveGeometry({ mediaBox: [0, 0, 595.28, 841.89] });
  const box = pagespace.sceneRectToPdf(geo, rect);

  near(slot.rect.x, box[0]);
  near(slot.rect.y, box[1]);
  near(slot.rect.x + slot.rect.width, box[2]);
  near(slot.rect.y + slot.rect.height, box[3]);
});

test('grup içindeki yuva MUTLAK koordinatla bildirilir', () => {
  const s = Scene.blank({
    title: 'grup', margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });
  s.transaction('kur', () => {
    s.addNode(Scene.createNode('group', {
      id: 'g1', x: 50, y: 400, width: 400, height: 100
    }));
    s.addNode(Scene.createNode('signature', {
      id: 'sig1', fieldName: 'imza1', x: 10, y: 15, width: 200, height: 70
    }), { parentId: 'g1' });
  });

  const { manifest } = compileToPdf(s, { fonts: FONTS });
  const slot = manifest.signatureSlots[0];

  // Grup kayması eklenmezse yuva sayfanın sol üstüne yapışırdı.
  assert.deepStrictEqual(slot.sceneRect, { x: 60, y: 415, width: 200, height: 70 });
  near(slot.rect.y, 841.89 - 415 - 70);
});
