'use strict';
/**
 * PDF sayfa uzayı ↔ sahne uzayı.
 *
 * Bu dosyanın tek sorusu var: "PDF'te şurada duran şey, sahnede de orada mı
 * duruyor?" Cevap `/MediaBox`, `/CropBox` ve `/Rotate`ın HER birleşiminde
 * aynı olmalıdır. Bir tanesinde bile kayarsa, kullanıcı belgeyi açtığında
 * nesnelerin yerinden oynadığını görür — ve haklıdır.
 */

const test = require('node:test');
const assert = require('node:assert');

const ps = require('@fitfak/pdf-scene/src/pagespace');

/** Punto altı farklar baskıda görünmez; testte de takılmamalı. */
const near = (a, b, tol = 0.01) =>
  assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b} değil (fark ${Math.abs(a - b)})`);

const nearPoint = (got, [x, y], tol = 0.01) => {
  near(got[0], x, tol);
  near(got[1], y, tol);
};

/* ================================================================== */
/* Etkin geometri                                                      */
/* ================================================================== */

test('etkin geometri: kutu verilmezse A4 varsayılır', () => {
  const g = ps.effectiveGeometry(null);
  near(g.width, 595.28);
  near(g.height, 841.89);
  assert.strictEqual(g.rotate, 0);
});

test('etkin geometri: yalnız CropBox verilirse MediaBox ona eşitlenir', () => {
  // MediaBox uydurup CropBox'ı ona kırpmak, çağıranın verdiği ölçüyü
  // sessizce değiştirmek olurdu.
  const g = ps.effectiveGeometry({ cropBox: [0, 0, 595, 842] });
  near(g.rawWidth, 595);
  near(g.rawHeight, 842);
  assert.deepStrictEqual(g.mediaBox, [0, 0, 595, 842]);
});

test('etkin geometri: CropBox MediaBox ile KESİŞTİRİLİR', () => {
  const g = ps.effectiveGeometry({
    mediaBox: [0, 0, 595, 842],
    cropBox: [-50, -50, 900, 900]
  });
  assert.deepStrictEqual(g.cropBox, [0, 0, 595, 842]);
});

test('etkin geometri: boş kesişimde MediaBox geçerlidir', () => {
  const g = ps.effectiveGeometry({
    mediaBox: [0, 0, 595, 842],
    cropBox: [2000, 2000, 2100, 2100]
  });
  assert.deepStrictEqual(g.cropBox, [0, 0, 595, 842]);
});

test('etkin geometri: /Rotate 90 ve 270 en-boyu TAKAS eder', () => {
  for (const rotate of [90, 270]) {
    const g = ps.effectiveGeometry({ mediaBox: [0, 0, 595, 842], rotate });
    near(g.width, 842);
    near(g.height, 595);
    assert.strictEqual(g.swapped, true);
  }
  for (const rotate of [0, 180]) {
    const g = ps.effectiveGeometry({ mediaBox: [0, 0, 595, 842], rotate });
    near(g.width, 595);
    near(g.height, 842);
    assert.strictEqual(g.swapped, false);
  }
});

test('etkin geometri: negatif ve 90 katı olmayan dönme normalleştirilir', () => {
  assert.strictEqual(ps.effectiveGeometry({ rotate: -90 }).rotate, 270);
  assert.strictEqual(ps.effectiveGeometry({ rotate: 450 }).rotate, 90);
  assert.strictEqual(ps.effectiveGeometry({ rotate: 89 }).rotate, 90);
  assert.strictEqual(ps.effectiveGeometry({ rotate: NaN }).rotate, 0);
});

/* ================================================================== */
/* Sayfa matrisi — dört köşe                                           */
/* ================================================================== */

/**
 * Her dönmede PDF'in DÖRT köşesinin sahnede nereye düştüğü sabittir.
 * Tek bir köşeyi doğrulamak, işaret hatasını yakalamaya yetmez.
 */
const CORNERS = {
  0:   { bottomLeft: [0, 842], topLeft: [0, 0], topRight: [595, 0], bottomRight: [595, 842] },
  90:  { bottomLeft: [0, 0], topLeft: [842, 0], topRight: [842, 595], bottomRight: [0, 595] },
  180: { bottomLeft: [595, 0], topLeft: [595, 842], topRight: [0, 842], bottomRight: [0, 0] },
  270: { bottomLeft: [842, 595], topLeft: [0, 595], topRight: [0, 0], bottomRight: [842, 0] }
};

for (const rotate of [0, 90, 180, 270]) {
  test(`sayfa matrisi: /Rotate ${rotate} dört köşeyi doğru yerleştirir`, () => {
    const geo = ps.effectiveGeometry({ mediaBox: [0, 0, 595, 842], rotate });
    const m = ps.pageMatrix(geo);
    const c = CORNERS[rotate];

    nearPoint(ps.applyM(m, 0, 0), c.bottomLeft);
    nearPoint(ps.applyM(m, 0, 842), c.topLeft);
    nearPoint(ps.applyM(m, 595, 842), c.topRight);
    nearPoint(ps.applyM(m, 595, 0), c.bottomRight);
  });
}

test('sayfa matrisi: kırpma kutusu kayması düşülür', () => {
  const geo = ps.effectiveGeometry({
    mediaBox: [0, 0, 700, 1000], cropBox: [20, 30, 615, 872]
  });
  near(geo.width, 595);
  near(geo.height, 842);
  const m = ps.pageMatrix(geo);
  // Kırpma kutusunun SOL ÜST köşesi sahnenin (0,0)'ıdır.
  nearPoint(ps.applyM(m, 20, 872), [0, 0]);
  nearPoint(ps.applyM(m, 615, 30), [595, 842]);
});

test('sayfa matrisi: kayık başlangıç + /Rotate 90 birlikte doğru', () => {
  const geo = ps.effectiveGeometry({
    mediaBox: [0, 0, 700, 1000], cropBox: [20, 30, 615, 872], rotate: 90
  });
  near(geo.width, 842);
  near(geo.height, 595);
  const m = ps.pageMatrix(geo);
  // 90° dönmüş sayfada kırpma kutusunun SOL ALT köşesi ekranın sol üstüdür.
  nearPoint(ps.applyM(m, 20, 30), [0, 0]);
  nearPoint(ps.applyM(m, 20, 872), [842, 0]);
  nearPoint(ps.applyM(m, 615, 30), [0, 595]);
});

/* ================================================================== */
/* Gidiş-dönüş                                                         */
/* ================================================================== */

test('sahne → PDF → sahne turu her dönmede kapanır', () => {
  const boxes = [
    { mediaBox: [0, 0, 595.28, 841.89] },
    { mediaBox: [0, 0, 612, 792] },
    { mediaBox: [0, 0, 792, 612] },
    { mediaBox: [0, 0, 700, 1000], cropBox: [20, 30, 615, 872] }
  ];

  for (const box of boxes) {
    for (const rotate of [0, 90, 180, 270]) {
      const geo = ps.effectiveGeometry({ ...box, rotate });
      for (const [x, y] of [[0, 0], [10, 20], [geo.width, geo.height], [123.4, 567.8]]) {
        const pdf = ps.toPdf(geo, x, y);
        const back = ps.toScene(geo, pdf.x, pdf.y);
        near(back.x, x, 0.005);
        near(back.y, y, 0.005);
      }
    }
  }
});

test('sahne dikdörtgeni → PDF dikdörtgeni: dönmede köşeler yeniden sıralanır', () => {
  const geo = ps.effectiveGeometry({ mediaBox: [0, 0, 595, 842], rotate: 90 });
  const rect = { x: 100, y: 50, width: 200, height: 60 };
  const pdf = ps.sceneRectToPdf(geo, rect);

  // Dönmüş sayfada sahnedeki genişlik, PDF'te YÜKSEKLİK olur.
  assert.ok(pdf[0] < pdf[2] && pdf[1] < pdf[3], 'kutu sıralı olmalı');
  near(pdf[2] - pdf[0], 60);
  near(pdf[3] - pdf[1], 200);

  // Ve geri döndüğünde aynı yere düşer.
  const back = ps.pdfRectToScene(geo, pdf);
  near(back.x, rect.x);
  near(back.y, rect.y);
  near(back.width, rect.width);
  near(back.height, rect.height);
});

/* ================================================================== */
/* Metin yerleştirme                                                   */
/* ================================================================== */

test('metin kutusu: dönmemiş sayfada taban çizgisi doğru kutuya çevrilir', () => {
  const geo = ps.effectiveGeometry({ mediaBox: [0, 0, 595, 842] });
  // Taban çizgisi y=700, yükselti 10 → kutunun üstü PDF'te y=710.
  const frame = ps.placeTextRect(geo, { ux: 1, uy: 0 },
    { u: 50, v: -710, width: 100, height: 14 });

  assert.deepStrictEqual(frame, { x: 50, y: 132, width: 100, height: 14, rotation: 0 });
});

test('metin kutusu: sayfa dönmesi düğüme DÖNME olarak yansır', () => {
  const geo = ps.effectiveGeometry({ mediaBox: [0, 0, 595, 842], rotate: 90 });
  const frame = ps.placeTextRect(geo, { ux: 1, uy: 0 },
    { u: 50, v: -710, width: 100, height: 14 });

  assert.strictEqual(frame.rotation, 90);
  // Okuma yönündeki ölçüler KORUNUR: kutu döner, metin sıkışmaz.
  near(frame.width, 100);
  near(frame.height, 14);
});

test('metin kutusu: dik yazılmış metin dönmemiş sayfada da döner', () => {
  const geo = ps.effectiveGeometry({ mediaBox: [0, 0, 595, 842] });
  // Taban çizgisi PDF uzayında yukarı bakıyor (90° saat yönünün TERSİ);
  // ekranda bu, saat yönünde 270°'tir.
  const frame = ps.placeTextRect(geo, { ux: 0, uy: 1 },
    { u: 50, v: -100, width: 80, height: 12 });
  assert.strictEqual(frame.rotation, 270);
});

test('birim kare: dönmemiş görsel doğrudan çerçeveye oturur', () => {
  const geo = ps.effectiveGeometry({ mediaBox: [0, 0, 595, 842] });
  const m = ps.concat([100, 0, 0, 50, 20, 700], ps.pageMatrix(geo));
  const place = ps.placeUnitSquare(m);

  near(place.x, 20);
  near(place.y, 842 - 750);
  near(place.width, 100);
  near(place.height, 50);
  assert.strictEqual(place.rotation, 0);
  assert.strictEqual(place.mirrored, false);
});

test('birim kare: aynalanmış ve eğrilmiş matrisler BİLDİRİLİR', () => {
  const geo = ps.effectiveGeometry({ mediaBox: [0, 0, 595, 842] });
  const mirrored = ps.placeUnitSquare(
    ps.concat([-100, 0, 0, 50, 120, 700], ps.pageMatrix(geo)));
  assert.strictEqual(mirrored.mirrored, true);

  const skewed = ps.placeUnitSquare(
    ps.concat([100, 30, 0, 50, 20, 700], ps.pageMatrix(geo)));
  assert.strictEqual(skewed.skewed, true);
});

test('tersi olmayan matris sessizce birim matrise düşmez', () => {
  assert.strictEqual(ps.invert([0, 0, 0, 0, 0, 0]), null);
});
