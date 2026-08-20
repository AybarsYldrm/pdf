'use strict';
/**
 * Geometri motoru.
 *
 * Editörün ve derleyicilerin ORTAK hesap kitabı. Tarayıcıda da Node'da da
 * aynı sonucu vermek zorundadır: kullanıcı ekranda gördüğü yeri PDF'te de
 * görmelidir. Bu yüzden burada DOM, canvas ya da `getBoundingClientRect`
 * yoktur — yalnız sayı vardır.
 *
 * Koordinat sistemi: sol üst başlangıç, x sağa, y aşağı, birim punto.
 * Açılar DERECE ve saat yönündedir (ekran yönü).
 */

const { round } = require('./units');

/* ------------------------------------------------------------------ */
/* Matris — [a b c d e f], PDF/SVG ile aynı sıra                       */
/* ------------------------------------------------------------------ */

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** m2'yi m1'in ÜSTÜNE uygular (önce m1, sonra m2). */
function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ];
}

const translate = (tx, ty) => [1, 0, 0, 1, tx, ty];
const scale = (sx, sy = sx) => [sx, 0, 0, sy, 0, 0];

function rotate(degrees) {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

/** Noktayı dönüştürür. */
function apply(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/**
 * Matrisin tersi. Tekil matriste `null` döner — çağıran bunu kontrol
 * etmelidir; sessizce birim matris dönmek hatayı gizler ve sonucu yanlış
 * ama "makul" gösterir.
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
/* Dikdörtgen                                                          */
/* ------------------------------------------------------------------ */

const rect = (x, y, width, height) => ({ x, y, width, height });

const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** İki dikdörtgeni kapsayan en küçük dikdörtgen. */
function union(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x, y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y
  };
}

function intersects(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width &&
         a.y < b.y + b.height && b.y < a.y + a.height;
}

function contains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y &&
         inner.x + inner.width <= outer.x + outer.width &&
         inner.y + inner.height <= outer.y + outer.height;
}

const containsPoint = (r, x, y) =>
  x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;

/**
 * Döndürülmüş bir çerçevenin EKSENE HİZALI sınır kutusu.
 *
 * Döndürme sonrası "genişlik hâlâ aynı" varsayımı, hizalama ve seçim
 * kutusunda gözle görülür hatalar üretir; dört köşeyi de döndürüp kapsayanı
 * almak tek doğru yoldur.
 */
function rotatedBounds(frame, rotation) {
  if (!rotation) return { ...frame };
  const c = center(frame);
  const m = rotate(rotation);
  let out = null;
  for (const [px, py] of [
    [frame.x, frame.y],
    [frame.x + frame.width, frame.y],
    [frame.x + frame.width, frame.y + frame.height],
    [frame.x, frame.y + frame.height]
  ]) {
    const p = apply(m, px - c.x, py - c.y);
    const pt = rect(p.x + c.x, p.y + c.y, 0, 0);
    out = union(out, pt);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Sahne ağacı geometrisi                                              */
/* ------------------------------------------------------------------ */

/**
 * Bir düğümün SAYFA koordinatlarındaki çerçevesi.
 *
 * Grup çocuklarının koordinatları grubun sol üstüne göredir; bu yüzden
 * ataların çerçeve kaymaları toplanır. Grup döndürmesi de çocuklara
 * uygulanır — grubu döndürmek çocukları döndürmüyorsa o bir grup değildir.
 *
 * DÜĞÜMÜN KENDİ DÖNMESİ x/y'ye KATILMAZ; ayrı alanda döner. Sebep: dönmüş bir
 * nesnenin "sol üst köşesi" artık eksene hizalı değildir; onu x/y diye
 * vermek, çağıranı yanlış bir dikdörtgene inandırır. Çizen taraf dönmeyi
 * nesnenin kendi merkezi etrafında uygular; eksene hizalı sınır kutusu
 * gerekiyorsa `rotatedBounds` vardır.
 *
 * @param {Object[]} ancestry kökten düğüme ata zinciri (düğüm dâhil)
 * @returns {{x:number,y:number,width:number,height:number,rotation:number}|null}
 */
function absoluteFrame(ancestry) {
  if (!ancestry.length) return null;

  const node = ancestry[ancestry.length - 1];
  let m = IDENTITY;
  let rotation = node.rotation || 0;

  for (const ancestor of ancestry.slice(0, -1)) {
    const f = ancestor.frame;
    if (ancestor.rotation) {
      const c = { x: f.x + f.width / 2, y: f.y + f.height / 2 };
      m = multiply(m, multiply(
        translate(c.x, c.y), multiply(rotate(ancestor.rotation), translate(-c.x, -c.y))));
      rotation += ancestor.rotation;
    }
    // Sonraki halkanın koordinatları BU düğümün sol üstüne göredir
    m = multiply(m, translate(f.x, f.y));
  }

  const p = apply(m, node.frame.x, node.frame.y);
  return {
    x: round(p.x), y: round(p.y),
    width: round(node.frame.width), height: round(node.frame.height),
    rotation: round(((rotation % 360) + 360) % 360)
  };
}

/**
 * Yol verisinin sınır kutusu.
 *
 * Kübik eğrilerde DENETİM noktaları da hesaba katılır. Gerçek eğri denetim
 * noktalarının dışına çıkamaz; kutu bu yüzden bazen gereğinden geniştir ama
 * ASLA dar değildir. Dar bir kutu, çizimin kenardan kırpılması demektir —
 * geniş kutu yalnız birkaç puntoluk boşluktur.
 *
 * @param {Array<Array>} d `[['M',x,y], …]`
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function pathBounds(d) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const cmd of d || []) {
    for (let i = 1; i + 1 < cmd.length; i += 2) {
      const x = cmd[i], y = cmd[i + 1];
      if (typeof x !== 'number' || typeof y !== 'number') continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: round(minX), y: round(minY),
    width: round(maxX - minX), height: round(maxY - minY)
  };
}

/**
 * Yolu kendi sınır kutusundan verilen çerçeveye oturtur.
 *
 * Sıfır genişlikli kutu (dikey çizgi) bölme hatası üretmesin diye ölçek 1
 * kalır ve yalnız kaydırma uygulanır.
 *
 * @returns {Array<Array>} dönüştürülmüş komutlar
 */
function fitPath(d, frame) {
  const box = pathBounds(d);
  const sx = box.width > 0.0001 ? frame.width / box.width : 1;
  const sy = box.height > 0.0001 ? frame.height / box.height : 1;

  return (d || []).map((cmd) => {
    const out = [cmd[0]];
    for (let i = 1; i + 1 < cmd.length; i += 2) {
      if (typeof cmd[i] !== 'number') break;
      out.push(round(frame.x + (cmd[i] - box.x) * sx));
      out.push(round(frame.y + (cmd[i + 1] - box.y) * sy));
    }
    return out;
  });
}

/** Bir düğüm listesinin toplam sınır kutusu (dönme dâhil). */
function boundsOf(nodes) {
  let out = null;
  for (const n of nodes) out = union(out, rotatedBounds(n.frame, n.rotation));
  return out;
}

/* ------------------------------------------------------------------ */
/* Hizalama ve dağıtım                                                 */
/* ------------------------------------------------------------------ */

const ALIGNMENTS = ['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom'];

/**
 * Seçili düğümleri hizalar ve YENİ çerçeveleri döndürür — düğümleri
 * değiştirmez. Değişikliği uygulamak işlem (transaction) katmanının işidir;
 * geometri saf kalırsa test edilmesi de kolaydır.
 *
 * @param {Object[]} nodes
 * @param {string} how ALIGNMENTS'tan biri
 * @param {Object} [bounds] hizalama çerçevesi (yoksa seçimin sınır kutusu)
 * @returns {Map<string, {x:number,y:number}>} düğüm kimliği → yeni konum
 */
function align(nodes, how, bounds) {
  if (!ALIGNMENTS.includes(how)) throw new Error(`Bilinmeyen hizalama: ${how}`);
  const box = bounds || boundsOf(nodes);
  const out = new Map();
  if (!box) return out;

  for (const n of nodes) {
    const f = n.frame;
    let { x, y } = f;
    switch (how) {
      case 'left':    x = box.x; break;
      case 'right':   x = box.x + box.width - f.width; break;
      case 'hcenter': x = box.x + (box.width - f.width) / 2; break;
      case 'top':     y = box.y; break;
      case 'bottom':  y = box.y + box.height - f.height; break;
      case 'vcenter': y = box.y + (box.height - f.height) / 2; break;
    }
    out.set(n.id, { x: round(x), y: round(y) });
  }
  return out;
}

/**
 * Düğümleri eşit ARALIKLA dağıtır.
 *
 * "Eşit aralık" ile "eşit merkez mesafesi" farklıdır; farklı boyutlu
 * nesnelerde gözle bakınca doğru görünen birincisidir.
 */
function distribute(nodes, axis) {
  if (nodes.length < 3) return new Map();
  const horizontal = axis === 'horizontal';
  const sorted = [...nodes].sort((a, b) =>
    horizontal ? a.frame.x - b.frame.x : a.frame.y - b.frame.y);

  const first = sorted[0].frame;
  const last = sorted[sorted.length - 1].frame;
  const start = horizontal ? first.x : first.y;
  const end = horizontal ? last.x + last.width : last.y + last.height;

  const totalSize = sorted.reduce((n, s) =>
    n + (horizontal ? s.frame.width : s.frame.height), 0);
  const gap = (end - start - totalSize) / (sorted.length - 1);

  const out = new Map();
  let cursor = start;
  for (const n of sorted) {
    out.set(n.id, horizontal
      ? { x: round(cursor), y: n.frame.y }
      : { x: n.frame.x, y: round(cursor) });
    cursor += (horizontal ? n.frame.width : n.frame.height) + gap;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Yapışma (snap) ve kılavuzlar                                        */
/* ------------------------------------------------------------------ */

/**
 * Sürüklenen çerçeveyi kılavuzlara YAPIŞTIRIR.
 *
 * Her eksende en yakın adaya bakılır ve yalnız `threshold` içindeyse
 * uygulanır. Eşiği aşan bir "yakınlık" yapışma değil, kullanıcının konumu
 * ele geçirilmesidir.
 *
 * @param {Object} frame sürüklenen çerçeve
 * @param {Object[]} others diğer düğümlerin çerçeveleri
 * @param {Object} page { width, height, margin }
 * @param {{ threshold?: number, edges?: boolean, centers?: boolean }} [opts]
 * @returns {{ x:number, y:number, guides: Array<{axis:'x'|'y', at:number}> }}
 */
function snap(frame, others, page, opts = {}) {
  const threshold = opts.threshold === undefined ? 4 : opts.threshold;
  const useEdges = opts.edges !== false;
  const useCenters = opts.centers !== false;

  const xTargets = [];
  const yTargets = [];

  if (page) {
    const m = page.margin || { top: 0, right: 0, bottom: 0, left: 0 };
    xTargets.push(0, m.left, page.width - m.right, page.width, page.width / 2);
    yTargets.push(0, m.top, page.height - m.bottom, page.height, page.height / 2);
  }
  for (const o of others) {
    if (useEdges) {
      xTargets.push(o.x, o.x + o.width);
      yTargets.push(o.y, o.y + o.height);
    }
    if (useCenters) {
      xTargets.push(o.x + o.width / 2);
      yTargets.push(o.y + o.height / 2);
    }
  }

  // Çerçevenin yapışabilecek kendi noktaları: sol kenar, merkez, sağ kenar
  const xSources = useCenters
    ? [{ off: 0 }, { off: frame.width / 2 }, { off: frame.width }]
    : [{ off: 0 }, { off: frame.width }];
  const ySources = useCenters
    ? [{ off: 0 }, { off: frame.height / 2 }, { off: frame.height }]
    : [{ off: 0 }, { off: frame.height }];

  const best = (sources, targets, base) => {
    let win = null;
    for (const s of sources) {
      for (const t of targets) {
        const delta = t - (base + s.off);
        const dist = Math.abs(delta);
        if (dist <= threshold && (!win || dist < win.dist)) win = { delta, dist, at: t };
      }
    }
    return win;
  };

  const wx = best(xSources, xTargets, frame.x);
  const wy = best(ySources, yTargets, frame.y);

  const guides = [];
  if (wx) guides.push({ axis: 'x', at: round(wx.at) });
  if (wy) guides.push({ axis: 'y', at: round(wy.at) });

  return {
    x: round(frame.x + (wx ? wx.delta : 0)),
    y: round(frame.y + (wy ? wy.delta : 0)),
    guides
  };
}

/** Değeri ızgaraya yuvarlar. `step <= 0` ise dokunmaz. */
const snapToGrid = (value, step) =>
  step > 0 ? round(Math.round(value / step) * step) : round(value);

module.exports = {
  IDENTITY, multiply, translate, scale, rotate, apply, invert,
  rect, center, union, intersects, contains, containsPoint, rotatedBounds,
  absoluteFrame, boundsOf, pathBounds, fitPath,
  ALIGNMENTS, align, distribute,
  snap, snapToGrid
};
