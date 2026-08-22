'use strict';
/**
 * PDF sayfa uzayı ↔ sahne uzayı — TEK hesap kitabı.
 *
 * NEDEN AYRI BİR DOSYA
 *
 * Bu dönüşüm daha önce üç yerde ayrı ayrı yapılıyordu: çizim toplayıcı
 * `pageMatrix` ile doğru yapıyor, metin içe aktarıcısı `geo.height - y` ile
 * yapıyor, imza yerleştirici üçüncü bir yolu kullanıyordu. `geo.height - y`
 * kırpma kutusunun kaymasını ve `/Rotate`ı GÖRMEZ; bu yüzden yatay ya da
 * döndürülmüş sayfalarda metin, çizimlerden ayrı bir yere düşüyordu.
 *
 * Kural: PDF ile sahne arasındaki HER dönüşüm buradan geçer. Bir dosyada
 * `pageHeight - y` görürseniz o bir hatadır.
 *
 * İKİ UZAY
 *
 *   PDF kullanıcı uzayı : başlangıç sol-ALT, y YUKARI, birim 1/72 inç
 *   Sahne uzayı         : başlangıç sol-ÜST, y AŞAĞI, birim punto
 *
 * Sahne uzayı "kullanıcının GÖRDÜĞÜ" yerleşimdir: `/Rotate` uygulanmış,
 * `/CropBox` başlangıcı sıfırlanmış hâl. Böylece sahnedeki bir sayfa her
 * zaman (0,0)–(width,height) kutusudur ve editörün ikinci bir kaydırma
 * hesabı tutması gerekmez.
 */

const { round } = require('./units');

/* ------------------------------------------------------------------ */
/* Matris                                                              */
/* ------------------------------------------------------------------ */

const IDENTITY = [1, 0, 0, 1, 0, 0];

/**
 * `m2`yi `m1`in üzerine uygular — PDF `cm` semantiği: yeni = m2 × mevcut.
 * (Önce m2, sonra m1 uygulanır.)
 */
function concat(m2, m1) {
  return [
    m2[0] * m1[0] + m2[1] * m1[2],
    m2[0] * m1[1] + m2[1] * m1[3],
    m2[2] * m1[0] + m2[3] * m1[2],
    m2[2] * m1[1] + m2[3] * m1[3],
    m2[4] * m1[0] + m2[5] * m1[2] + m1[4],
    m2[4] * m1[1] + m2[5] * m1[3] + m1[5]
  ];
}

/** Noktayı dönüştürür. */
const applyM = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Yönü (öteleme olmadan) dönüştürür. */
const applyDir = (m, x, y) => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];

/**
 * Matrisin tersi; tekil matriste `null`.
 *
 * Sessizce birim matris dönmek, sonucu yanlış ama "makul" gösterir —
 * çağıran `null` kontrolü yapmalıdır.
 */
function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return null;
  return [
    m[3] / det, -m[1] / det,
    -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det
  ];
}

/* ------------------------------------------------------------------ */
/* Sayfa geometrisi                                                    */
/* ------------------------------------------------------------------ */

const A4 = [0, 0, 595.28, 841.89];

/** Kutuyu [x0,y0,x1,y1] sıralı ve sonlu hâle getirir. */
function normalizeBox(box) {
  if (!Array.isArray(box) || box.length < 4) return null;
  const n = box.slice(0, 4).map(Number);
  if (n.some((v) => !Number.isFinite(v))) return null;
  return [
    Math.min(n[0], n[2]), Math.min(n[1], n[3]),
    Math.max(n[0], n[2]), Math.max(n[1], n[3])
  ];
}

/**
 * Sayfanın ETKİN geometrisi.
 *
 * `@fitfak/pdf-doc`un `getPageGeometry` çıktısını da, elle kurulmuş yalın
 * nesneleri de kabul eder ve eksikleri tamamlar. Böylece çağıranlar
 * "acaba `rawWidth` var mı" diye kontrol etmek zorunda kalmaz.
 *
 * ÖNCELİK: `/CropBox` görünen alandır, `/MediaBox` kâğıdın kendisidir.
 * Görüntüleyiciler CropBox'ı gösterir; sahne de onu gösterir. CropBox
 * MediaBox'ın DIŞINA taşarsa kesişim alınır (ISO 32000-1 §14.11.2):
 * kâğıtta olmayan bir alanı düzenlenebilir göstermek yanıltıcıdır.
 *
 * @param {Object} geo { mediaBox?, cropBox?, rotate?, width?, height? }
 * @returns {{ mediaBox:number[], cropBox:number[], rotate:number,
 *             rawWidth:number, rawHeight:number, width:number, height:number,
 *             swapped:boolean }}
 */
function effectiveGeometry(geo) {
  const g = geo || {};
  // İkisi de VERİLMEMİŞSE A4 varsayılır. Yalnız biri verilmişse diğeri ona
  // eşitlenir: olmayan bir MediaBox uydurup CropBox'ı ona kırpmak, çağıranın
  // verdiği ölçüyü sessizce değiştirmek olurdu.
  let mediaBox = normalizeBox(g.mediaBox);
  let cropBox = normalizeBox(g.cropBox);

  if (!mediaBox && !cropBox) mediaBox = cropBox = A4.slice();
  else if (!mediaBox) mediaBox = cropBox.slice();
  else if (!cropBox) cropBox = mediaBox.slice();
  else {
    const x0 = Math.max(cropBox[0], mediaBox[0]);
    const y0 = Math.max(cropBox[1], mediaBox[1]);
    const x1 = Math.min(cropBox[2], mediaBox[2]);
    const y1 = Math.min(cropBox[3], mediaBox[3]);
    // Kesişim boşsa CropBox anlamsızdır; MediaBox'a düşülür.
    cropBox = (x1 - x0 > 0.5 && y1 - y0 > 0.5) ? [x0, y0, x1, y1] : mediaBox.slice();
  }

  let rotate = Number(g.rotate) || 0;
  rotate = ((Math.round(rotate / 90) * 90) % 360 + 360) % 360;

  const rawWidth = cropBox[2] - cropBox[0];
  const rawHeight = cropBox[3] - cropBox[1];
  const swapped = rotate === 90 || rotate === 270;

  return {
    mediaBox, cropBox, rotate, rawWidth, rawHeight, swapped,
    width: round(swapped ? rawHeight : rawWidth),
    height: round(swapped ? rawWidth : rawHeight)
  };
}

/**
 * PDF kullanıcı uzayı → sahne uzayı matrisi.
 *
 * Üç şeyi BİRLİKTE çözer, çünkü ayrı ayrı uygulamak sıra hatası davetidir:
 *   1. y ekseni: PDF'te yukarı, sahnede aşağı büyür.
 *   2. Kırpma kutusu: sol-alt köşe (0,0) olmayabilir.
 *   3. `/Rotate`: görüntüleyici sayfayı saat yönünde döndürerek gösterir;
 *      sahne KULLANICININ GÖRDÜĞÜ yerleşim olmalıdır.
 *
 * @param {Object} geo ham ya da etkin geometri
 * @returns {number[]} [a b c d e f]
 */
function pageMatrix(geo) {
  const e = geo && geo.swapped !== undefined ? geo : effectiveGeometry(geo);
  const x0 = e.cropBox[0];
  const y0 = e.cropBox[1];
  const w = e.rawWidth;
  const h = e.rawHeight;

  switch (e.rotate) {
    case 90:  return [0, 1, 1, 0, -y0, -x0];
    case 180: return [-1, 0, 0, 1, w + x0, -y0];
    case 270: return [0, -1, -1, 0, h + y0, w + x0];
    default:  return [1, 0, 0, -1, -x0, h + y0];
  }
}

/** Sahne uzayı → PDF kullanıcı uzayı matrisi. */
function inverseMatrix(geo) {
  const m = invert(pageMatrix(geo));
  // pageMatrix her zaman ±1 determinantlıdır; tekil olamaz. Yine de
  // sessizce yanlış sonuç üretmektense açıkça patlamak yeğdir.
  if (!m) throw new Error('Sayfa matrisi tersinir değil');
  return m;
}

/** PDF noktası → sahne noktası. */
function toScene(geo, x, y) {
  const [sx, sy] = applyM(pageMatrix(geo), x, y);
  return { x: round(sx), y: round(sy) };
}

/** Sahne noktası → PDF noktası. */
function toPdf(geo, x, y) {
  const [px, py] = applyM(inverseMatrix(geo), x, y);
  return { x: round(px), y: round(py) };
}

/**
 * Sayfa dönmesinin sahnedeki içeriğe kattığı açı (derece, saat yönü).
 *
 * PDF'te yatay yazılmış bir metin, `/Rotate 90` olan bir sayfada ekranda
 * 90° dönmüş görünür. Sahne "görünen"i taşıdığı için düğüm de dönmelidir.
 */
function contentRotation(geo) {
  const [dx, dy] = applyDir(pageMatrix(geo), 1, 0);
  return normalizeAngle((Math.atan2(dy, dx) * 180) / Math.PI);
}

const normalizeAngle = (deg) => {
  const a = ((deg % 360) + 360) % 360;
  // 89.9999999 gibi kayan nokta artıklarını temizler: dönme alanındaki
  // gürültü, sahne dosyasının her turda başka türlü görünmesi demektir.
  const snapped = Math.round(a);
  return Math.abs(a - snapped) < 1e-6 ? (snapped % 360) : round(a);
};

/**
 * PDF uzayındaki bir OKUMA dikdörtgenini sahne düğümü çerçevesine çevirir.
 *
 * "Okuma dikdörtgeni": metnin kendi yönünde eksene hizalı kutu — sol kenarı
 * satır başı, `top` kenarı ilk satırın tepesi. PDF uzayında y yukarı
 * büyüdüğü için kutu `top`tan AŞAĞI doğru `height` kadar iner.
 *
 * Sahne düğümü ise "dönmemiş çerçeve + kendi merkezi etrafında dönme"
 * olarak tanımlıdır. Dönmüş bir kutunun köşesini doğrudan `x/y` yazmak,
 * dönme uygulanınca nesneyi kaydırır; bu yüzden merkez üzerinden hesaplanır.
 *
 * @param {Object} geo sayfa geometrisi
 * @param {{x:number, top:number, width:number, height:number}} r
 * @param {number} [extraRotation] metnin kendi dönmesi (derece, saat yönü)
 * @returns {{x:number,y:number,width:number,height:number,rotation:number}}
 */
function placeReadingRect(geo, r, extraRotation = 0) {
  const m = pageMatrix(geo);
  const cx = r.x + r.width / 2;
  const cy = r.top - r.height / 2;
  const [sx, sy] = applyM(m, cx, cy);

  const rotation = normalizeAngle(contentRotation(geo) + extraRotation);

  return {
    x: round(sx - r.width / 2),
    y: round(sy - r.height / 2),
    width: round(r.width),
    height: round(r.height),
    rotation
  };
}

/**
 * OKUMA UZAYINDAKİ bir metin kutusunu sahne düğümü çerçevesine çevirir.
 *
 * Okuma uzayı metnin KENDİ eksenleridir: `u` taban çizgisi boyunca (satır
 * yönü), `v` satırdan satıra (aşağı). Dik yazılmış ya da eğik yerleştirilmiş
 * metin de bu uzayda düz görünür; gruplama orada yapılır, dönme yalnız
 * burada bir kez uygulanır.
 *
 * PDF'te y YUKARI büyüdüğü için okuma-aşağı yönü, taban yönünün −90°
 * döndürülmüşüdür: `dir = (ux, uy)` iken aşağı `(uy, −ux)`.
 *
 * @param {Object} geo sayfa geometrisi
 * @param {{ux:number, uy:number}} dir taban çizgisinin PDF uzayındaki birim yönü
 * @param {{u:number, v:number, width:number, height:number}} r
 *   `u` satır başı, `v` kutunun ÜST kenarı, ölçüler okuma yönünde
 * @returns {{x:number,y:number,width:number,height:number,rotation:number}}
 */
function placeTextRect(geo, dir, r) {
  const ux = Number.isFinite(dir && dir.ux) ? dir.ux : 1;
  const uy = Number.isFinite(dir && dir.uy) ? dir.uy : 0;

  // Kutunun merkezi — önce okuma uzayında, sonra PDF uzayında.
  const cu = r.u + r.width / 2;
  const cv = r.v + r.height / 2;
  const px = cu * ux + cv * uy;
  const py = cu * uy - cv * ux;

  const m = pageMatrix(geo);
  const [sx, sy] = applyM(m, px, py);
  const [dx, dy] = applyDir(m, ux, uy);

  // Sahne düğümü "dönmemiş çerçeve + kendi merkezi etrafında dönme"dir.
  // Dönmüş kutunun köşesini doğrudan x/y yazmak, dönme uygulanınca nesneyi
  // kaydırır; bu yüzden merkez üzerinden hesaplanır.
  return {
    x: round(sx - r.width / 2),
    y: round(sy - r.height / 2),
    width: round(r.width),
    height: round(r.height),
    rotation: normalizeAngle((Math.atan2(dy, dx) * 180) / Math.PI)
  };
}

/**
 * Sahnedeki eksene hizalı dikdörtgen → PDF `[x0 y0 x1 y1]` dikdörtgeni.
 *
 * Görünür imza yerleştirmenin, bağlantı kutularının ve form alanlarının
 * ihtiyaç duyduğu dönüşüm. Dönmüş sayfada kutu köşe değiştirir; iki köşeyi
 * de dönüştürüp min/max almak tek doğru yoldur.
 */
function sceneRectToPdf(geo, rect) {
  const m = inverseMatrix(geo);
  const [ax, ay] = applyM(m, rect.x, rect.y);
  const [bx, by] = applyM(m, rect.x + rect.width, rect.y + rect.height);
  return [
    round(Math.min(ax, bx)), round(Math.min(ay, by)),
    round(Math.max(ax, bx)), round(Math.max(ay, by))
  ];
}

/** PDF `[x0 y0 x1 y1]` → sahne `{x,y,width,height}`. */
function pdfRectToScene(geo, box) {
  const b = normalizeBox(box);
  if (!b) return null;
  const m = pageMatrix(geo);
  const [ax, ay] = applyM(m, b[0], b[1]);
  const [bx, by] = applyM(m, b[2], b[3]);
  const x = Math.min(ax, bx);
  const y = Math.min(ay, by);
  return {
    x: round(x), y: round(y),
    width: round(Math.abs(bx - ax)), height: round(Math.abs(by - ay))
  };
}

/**
 * Birim kareyi dönüştüren matristen sahne yerleşimi çıkarır.
 *
 * PDF'te görsel her zaman BİRİM KAREYE çizilir; nereye ve ne kadar
 * büyüklükte düştüğünü matris söyler. Görsel uzayında v=1 görselin ÜST
 * satırıdır — bu yüzden sol üst köşe (0,1) noktasıdır.
 *
 * @param {number[]} m sayfa matrisini de İÇEREN birleşik matris
 * @returns {{x,y,width,height,rotation,skewed:boolean,mirrored:boolean}}
 */
function placeUnitSquare(m) {
  const corner = applyM(m, 0, 1);                   // görselin SOL ÜST köşesi
  const right = [m[0], m[1]];                       // (1,1) − (0,1)
  const down = [-m[2], -m[3]];                      // (0,0) − (0,1)

  const width = Math.hypot(right[0], right[1]);
  const height = Math.hypot(down[0], down[1]);
  const rotation = (Math.atan2(right[1], right[0]) * 180) / Math.PI;

  const cx = corner[0] + (right[0] * 0.5) + (down[0] * 0.5);
  const cy = corner[1] + (right[1] * 0.5) + (down[1] * 0.5);

  // Dik olmayan (eğrilmiş) matrisler dikdörtgen çerçeveye sığmaz; sahnede
  // eğrilme yoktur, bu yüzden yalnız bildirilir.
  const dot = right[0] * down[0] + right[1] * down[1];
  const scaleRef = Math.max(1e-6, width * height);
  const cross = right[0] * down[1] - right[1] * down[0];

  return {
    x: cx - width / 2, y: cy - height / 2, width, height,
    rotation: normalizeAngle(rotation),
    skewed: Math.abs(dot) / scaleRef > 0.01,
    mirrored: cross < 0
  };
}

module.exports = {
  IDENTITY, concat, applyM, applyDir, invert,
  normalizeBox, effectiveGeometry,
  pageMatrix, inverseMatrix, toScene, toPdf,
  contentRotation, normalizeAngle,
  placeReadingRect, placeTextRect, sceneRectToPdf, pdfRectToScene, placeUnitSquare
};
