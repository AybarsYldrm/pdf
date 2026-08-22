'use strict';
/**
 * PDF → Sahne içe aktarıcısı.
 *
 * NE YAPAR: var olan bir PDF'in METİNLERİNİ, çizimlerini, görsellerini ve
 * sayfa geometrisini okuyup düzenlenebilir sahne düğümlerine çevirir. Metin,
 * @fitfak/pdf-doc'un konumlandırılmış çıkarıcısıyla alınır — yani gerçekten
 * sayfadaki yerinden.
 *
 * KOORDİNAT: PDF ile sahne arasındaki HER dönüşüm `../pagespace` üzerinden
 * yapılır. Daha önce metin `pageHeight - y` ile, çizimler sayfa matrisiyle
 * yerleştiriliyordu; `pageHeight - y` ne `/CropBox` kaymasını ne `/Rotate`ı
 * görür, bu yüzden yatay ve döndürülmüş sayfalarda metin çizimlerden ayrı
 * bir yere düşerdi. Artık ikisi de aynı matristen geçer.
 *
 * SAYFA ÖLÇÜSÜ: her sahne sayfası KENDİ ölçüsünü taşır. Çok ölçülü belgeler
 * (araya giren yatay tablo, sondaki A3 kroki) artık ilk sayfanın ölçüsüne
 * sıkıştırılmaz.
 *
 * NE YAPMAZ (ve bunu iddia etmez):
 *   - Yazı tipi dosyaları çıkarılmaz; içe aktarılan metin, sahnenin
 *     yapılandırdığı font ailesiyle yeniden çizilir. Bu, satır genişliklerinin
 *     birebir aynı çıkmayabileceği anlamına gelir.
 *   - Kırpma bölgeleri, gölgeleme (gradyan) ve desen dolguları aktarılmaz;
 *     her biri ayrı uyarı üretir.
 *   - JPEG 2000, JBIG2 ve CCITT ile kodlanmış görseller çözülmez.
 *   - Metin, çizimlerin ÜSTÜNE konur. Kaynak belgede metnin üzerine çizilmiş
 *     bir örtü varsa sıra değişir.
 *   - Form alanları ve açıklamalar (annotation) çizim olarak değil, ANALİZ
 *     olarak bildirilir; sahne düğümüne çevrilmez.
 *   - Var olan imzalar KORUNMAZ. Sahne yeni bir belge üretir; eski imzalar
 *     yeni belgeyi kapsamaz. İmzalı bir PDF'i düzenlemek isteyen
 *     @fitfak/pdf-doc'un ARTIMLI düzenleme yolunu kullanmalıdır.
 *
 * Bu sınırlar, "PDF'i tam destekliyoruz" demenin bedelidir; demiyoruz.
 */

const { Scene } = require('../scene');
const { AssetManager } = require('../assets');
const { round } = require('../units');
const { SceneError } = require('../validate');
const geometry = require('../geometry');
const pagespace = require('../pagespace');
const { collectGraphics, placeUnitSquare } = require('./pdfgraphics');
const { groupParagraphs } = require('./paragraphs');
const { extractImage } = require('./pdfimage');
const { analyzeDocument } = require('./pdfanalyze');

/** Aynı satır sayılma eşiği (punto). */
const LINE_EPSILON = 1.5;

/** Taban çizgisi yönü bu açıdan fazla ayrışıyorsa ayrı bir okuma yönüdür. */
const DIRECTION_EPSILON = 1;

/**
 * PDF'i sahneye aktarır.
 *
 * @param {Buffer} pdfBuffer
 * @param {{ password?: string, fontFamily?: string, maxPages?: number,
 *           mergeLines?: boolean, graphics?: boolean, paragraphs?: boolean,
 *           maxNodes?: number,
 *           fonts?: Array<{family:string, src:string|Buffer}> }} [o]
 *   `fonts` verilirse taban çizgisi → kutu üstü dönüşümü GERÇEK font
 *   yükseltisiyle yapılır. Verilmezse 0.8 yaklaşıklığı kullanılır ve
 *   düğümler birkaç punto kayabilir.
 * @returns {{ scene: Scene, warnings: Array, analysis: Object }}
 */
function importFromPdf(pdfBuffer, o = {}) {
  const { PdfDocument, extractTextItems } = require('@fitfak/pdf-doc');

  let doc;
  try {
    doc = PdfDocument.load(pdfBuffer, { password: o.password || '' });
  } catch (err) {
    throw new SceneError(err.code || 'ERR_PDF_OPEN', `PDF açılamadı: ${err.message}`);
  }

  const warnings = [];
  const maxPages = o.maxPages || 500;
  const pageCount = Math.min(doc.pageCount, maxPages);
  if (doc.pageCount > pageCount) {
    warnings.push({
      code: 'WARN_PAGES_TRUNCATED',
      message: `${doc.pageCount} sayfanın ilk ${pageCount} tanesi aktarıldı`
    });
  }

  // `hasSignatures` bir ÖZELLİKTİR, işlev değil. Çağırmak
  // "doc.hasSignatures is not a function" ile patlar ve İMZALI HER BELGENİN
  // içe aktarımını daha ilk adımda öldürürdü.
  if (doc.hasSignatures) {
    warnings.push({
      code: 'WARN_SIGNATURES_DROPPED',
      message: 'Kaynak belgede imza var; içe aktarılan sahne YENİ bir belgedir ' +
               've eski imzaları taşımaz.'
    });
  }

  const geos = [];
  for (let i = 0; i < pageCount; i++) {
    geos.push(pagespace.effectiveGeometry(safeGeometry(doc, i, warnings)));
  }
  const first = geos[0] || pagespace.effectiveGeometry(null);

  const scene = Scene.blank({
    title: readTitle(doc),
    size: { width: first.width, height: first.height },
    // İçe aktarılan belgede "kenar boşluğu" diye bir şey yoktur: nesneler
    // mutlak koordinatlarla gelir. Sahte bir boşluk göstermek, kullanıcıyı
    // olmayan bir yerleşim kuralına inandırırdı.
    margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });
  scene.assets = new AssetManager();

  const fontFamily = o.fontFamily || 'Ubuntu';
  let mergedLines = false;
  let mixedSizes = false;
  let rotatedText = false;

  const ascentRatio = readAscentRatio(o, fontFamily, warnings);

  // Düğüm bütçesi: bir harita ya da karmaşık bir grafik on binlerce yol
  // içerebilir. Sahne sınırlarını aşmak yerine sınıra kadar alınır ve
  // kalanın alınmadığı SÖYLENİR.
  const budget = { left: o.maxNodes || 4000 };
  const stats = [];

  scene.transaction('PDF içe aktar', () => {
    for (let index = 0; index < pageCount; index++) {
      const geo = geos[index];
      if (Math.abs(geo.width - first.width) > 1 || Math.abs(geo.height - first.height) > 1) {
        mixedSizes = true;
      }

      const pageId = index === 0 ? scene.pages[0].id : `pg${index + 1}`;
      if (index === 0) {
        // İlk sayfa belgenin ölçüsünü belirler; yine de KENDİ ölçüsünü de
        // taşısın ki sonradan belge ölçüsü değişince kayması gerekmesin.
        scene.pages[0].width = geo.width;
        scene.pages[0].height = geo.height;
      } else {
        scene.addPage({
          id: pageId, name: `Sayfa ${index + 1}`,
          width: geo.width, height: geo.height
        });
      }

      const counts = { text: 0, path: 0, image: 0 };

      // ÇİZİMLER ÖNCE: metin, kaynak belgelerin ezici çoğunluğunda arka plan
      // dolgularının ve logoların ÜSTÜNDEDİR. Çizim listesindeki gerçek
      // sırayı korumak, metni ayrı bir çıkarıcıdan aldığımız için mümkün
      // değil; bu yüzden kural açıkça seçilmiştir ve belgelenmiştir.
      if (o.graphics !== false) {
        addGraphics(doc, index, geo, scene, pageId, {
          warnings, assets: scene.assets, budget, counts
        });
      }

      let items;
      try {
        items = extractTextItems(doc, index);
      } catch (err) {
        warnings.push({
          code: 'WARN_PAGE_UNREADABLE', page: index,
          message: `Sayfa ${index + 1} metni okunamadı: ${err.message}`
        });
        stats.push({ page: index, ...counts });
        continue;
      }

      const added = addText(items, geo, scene, pageId, {
        fontFamily, ascentRatio, mergeLines: o.mergeLines !== false,
        paragraphs: o.paragraphs !== false, budget
      });
      counts.text = added.count;
      if (added.merged) mergedLines = true;
      if (added.rotated) rotatedText = true;

      stats.push({ page: index, ...counts });
    }
  });

  scene.history.clear();

  if (mixedSizes) {
    warnings.push({
      code: 'WARN_PAGE_SIZE_MIXED',
      message: 'Kaynak belgede sayfa boyutları farklı; her sayfa KENDİ ' +
               'ölçüsüyle aktarıldı, belge ölçüsü ilk sayfanınkidir.'
    });
  }
  if (mergedLines) {
    warnings.push({
      code: 'WARN_IMPORT_LINES_MERGED',
      message: 'Ardışık satırlar paragrafa toplandı ve kutular metne göre ' +
               'uzuyor; kaynaktaki SABİT satır sonları korunmadı.'
    });
  }
  if (rotatedText) {
    warnings.push({
      code: 'WARN_IMPORT_TEXT_ROTATED',
      message: 'Döndürülmüş metinler dönme açılarıyla aktarıldı; kutu ölçüleri ' +
               'okuma yönünde tutulur.'
    });
  }
  warnings.push({
    code: 'WARN_IMPORT_FLATTENED',
    message: o.graphics === false
      ? 'Yalnız metin ve sayfa ölçüleri aktarıldı; çizimler istenmedi.'
      : 'Metin, çizim ve görseller aktarıldı; gömülü fontlar aktarılmadı. ' +
        'Paragraflar kendi içinde yeniden akar ama kutular birbirini İTMEZ.'
  });

  let analysis;
  try {
    analysis = analyzeDocument(doc, { pages: geos, stats, warnings, truncated: doc.pageCount > pageCount });
  } catch (err) {
    analysis = null;
    warnings.push({
      code: 'WARN_ANALYSIS_FAILED',
      message: `Belge çözümlemesi tamamlanamadı: ${err.message}`
    });
  }

  return { scene, warnings, analysis };
}

/** Sayfa geometrisi okunamazsa belge tümden ölmesin. */
function safeGeometry(doc, index, warnings) {
  try {
    return doc.getPageGeometry(index);
  } catch (err) {
    warnings.push({
      code: 'WARN_PAGE_GEOMETRY', page: index,
      message: `Sayfa ${index + 1} ölçüsü okunamadı, A4 varsayıldı: ${err.message}`
    });
    return null;
  }
}

/**
 * Taban çizgisi → kutu üst kenarı için yükselti oranı.
 *
 * PDF metin öğesi TABAN ÇİZGİSİNDE durur; sahne düğümü ise kutunun ÜST
 * kenarında. Aradaki fark fontun yükseltisidir. Gerçek font verilmişse
 * ölçülür — o zaman sahne→PDF→sahne turu birebir kapanır.
 */
function readAscentRatio(o, fontFamily, warnings) {
  if (!o.fonts || !o.fonts.length) return 0.8;
  try {
    const { FontManager } = require('@fitfak/pdf-html/src/font/manager');
    const fm = new FontManager();
    for (const face of o.fonts) fm.register(face);
    const face = fm.resolve([fontFamily], 400, 'normal');
    const { ascender } = face.parser.hhea;
    const { unitsPerEm } = face.parser.head;
    if (ascender && unitsPerEm) return ascender / unitsPerEm;
  } catch (err) {
    warnings.push({
      code: 'WARN_FONT_METRICS',
      message: `Font ölçüsü okunamadı, yaklaşıklık kullanılıyor: ${err.message}`
    });
  }
  return 0.8;
}

/* ------------------------------------------------------------------ */
/* Metin                                                               */
/* ------------------------------------------------------------------ */

/**
 * Sayfanın metnini sahneye ekler.
 *
 * OKUMA UZAYI: satır ve paragraf gruplaması, metnin KENDİ yönünde yapılır.
 * Her öğe taban çizgisi yönüne (`u`) ve ona dik aşağı yöne (`v`)
 * izdüşürülür. Böylece hem yatay hem dik yazılmış metin aynı kodla
 * gruplanır ve sayfa dönmesi hesabı işin dışında kalır — dönme yalnız
 * yerleştirme anında, sayfa matrisiyle bir kez uygulanır.
 *
 * @returns {{count:number, merged:boolean, rotated:boolean}}
 */
function addText(items, geo, scene, pageId, o) {
  const buckets = new Map();

  for (const it of items) {
    if (!it.text || !it.text.trim()) continue;

    // Yön birim vektördür; eski çıkarıcılar vermezse yatay varsayılır.
    const dx = Number.isFinite(it.dirX) ? it.dirX : 1;
    const dy = Number.isFinite(it.dirY) ? it.dirY : 0;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;

    const angle = Math.round(
      (Math.atan2(uy, ux) * 180) / Math.PI / DIRECTION_EPSILON) * DIRECTION_EPSILON;

    // Görünen punto: `Tm` ile ölçeklenmiş metni ham `Tf` değeriyle almak,
    // 2× büyütülmüş bir başlığı normal punto sanmaktır.
    const size = it.height > 0.1 ? it.height : (it.fontSize || 11);

    let bucket = buckets.get(angle);
    if (!bucket) {
      bucket = { ux, uy, lines: [] };
      buckets.set(angle, bucket);
    }

    // Okuma uzayına izdüşüm: u satır boyunca, v satırdan satıra (AŞAĞI).
    // PDF'te y yukarı büyüdüğü için aşağı yön (uy, -ux)'tir.
    bucket.lines.push({
      text: it.text,
      x: it.x * bucket.ux + it.y * bucket.uy,
      baseline: it.x * bucket.uy - it.y * bucket.ux,
      width: it.width > 0 ? it.width : it.text.length * size * 0.5,
      fontSize: size
    });
  }

  let count = 0;
  let merged = false;
  let rotated = false;

  for (const bucket of buckets.values()) {
    bucket.lines.sort((a, b) => (a.baseline - b.baseline) || (a.x - b.x));
    const groups = o.mergeLines ? mergeLines(bucket.lines) : bucket.lines.map(single);

    const place = (r) => {
      const frame = pagespace.placeTextRect(geo, bucket, r);
      if (frame.rotation) rotated = true;
      return frame;
    };

    if (!o.paragraphs) {
      // Satır satır: kâğıttaki yerleşime en sadık ama DÜZENLENEMEZ hâl.
      for (const g of groups) {
        if (o.budget.left <= 0) break;
        const frame = place({
          u: g.x, v: g.baseline - g.fontSize * o.ascentRatio,
          width: Math.max(4, g.width), height: g.fontSize * 1.4
        });
        scene.addNode(Scene.createNode('text', {
          ...frame,
          text: g.text, fontFamily: o.fontFamily,
          fontSize: round(g.fontSize), lineHeight: 1.4
        }), { pageId });
        o.budget.left--;
        count++;
      }
      continue;
    }

    const paragraphs = groupParagraphs(groups.map((g) => ({
      x: g.x, right: g.x + Math.max(4, g.width),
      baseline: g.baseline, fontSize: g.fontSize, text: g.text,
      // PDF metin çıkarıcısı yüz bilgisi vermez; punto tek ayırıcıdır.
      styleKey: 'pdf'
    })));

    for (const para of paragraphs) {
      if (o.budget.left <= 0) break;
      if (para.merged) merged = true;
      const frame = place({
        u: para.x,
        v: para.baseline - para.fontSize * o.ascentRatio,
        width: Math.max(4, para.right - para.x),
        // Yükseklik metinden hesaplanacak; buradaki değer yalnız
        // başlangıçtır ve derleyici onu günceller.
        height: para.fontSize * para.lineHeight * para.lines.length
      });
      scene.addNode(Scene.createNode('text', {
        ...frame,
        text: para.text, fontFamily: o.fontFamily,
        fontSize: round(para.fontSize), lineHeight: para.lineHeight,
        align: para.align, autoHeight: true
      }), { pageId });
      o.budget.left--;
      count++;
    }
  }

  return { count, merged, rotated };
}

/* ------------------------------------------------------------------ */
/* Çizimler ve görseller                                               */
/* ------------------------------------------------------------------ */

/**
 * Sayfanın vektör çizimlerini ve görsellerini sahneye ekler.
 *
 * @param {Object} doc PdfDocument
 * @param {number} index sayfa sırası
 * @param {Object} geo sayfa geometrisi
 * @param {Scene} scene
 * @param {string} pageId
 * @param {{ warnings:Array, assets:AssetManager, budget:{left:number},
 *           counts:Object }} ctx
 */
function addGraphics(doc, index, geo, scene, pageId, ctx) {
  const { records, warnings } = collectGraphics(doc, index, geo);
  for (const w of warnings) ctx.warnings.push({ ...w, page: index });

  /** Aynı görsel akışı iki kez çözülmesin: PDF'ler logoyu her sayfada çağırır. */
  const imageCache = new Map();
  let dropped = 0;

  for (const rec of records) {
    if (ctx.budget.left <= 0) { dropped++; continue; }

    if (rec.kind === 'path') {
      const box = geometry.pathBounds(rec.d);
      // Sıfır alanlı ve konturu olmayan yol görünmez: eklemek yalnız
      // katman listesini şişirir.
      if (!rec.stroke && (box.width < 0.01 || box.height < 0.01)) continue;
      if (!rec.fill && !rec.stroke) continue;

      // Veri düğümün KENDİ uzayına taşınır; çerçeve sınır kutusudur.
      const local = rec.d.map((cmd) => {
        const out = [cmd[0]];
        for (let i = 1; i + 1 < cmd.length; i += 2) {
          out.push(round(cmd[i] - box.x), round(cmd[i + 1] - box.y));
        }
        return out;
      });

      scene.addNode(Scene.createNode('path', {
        x: box.x, y: box.y, width: box.width, height: box.height,
        d: local,
        fill: rec.fill || undefined,
        stroke: rec.stroke || undefined,
        strokeWidth: rec.stroke ? round(rec.strokeWidth) : 0,
        fillRule: rec.fillRule,
        dash: rec.dash,
        opacity: rec.opacity === undefined ? 1 : round(rec.opacity)
      }), { pageId });
      ctx.budget.left--;
      if (ctx.counts) ctx.counts.path++;
      continue;
    }

    if (rec.kind !== 'image') continue;

    const place = placeUnitSquare(rec.ctm);
    if (place.width < 0.01 || place.height < 0.01) continue;
    if (place.skewed) {
      warnOnce(ctx.warnings, 'WARN_IMPORT_MATRIX_SKEW',
        'Eğrilmiş (skew) matrisle yerleştirilmiş görseller dik çerçeveye oturtuldu.');
    }
    if (place.mirrored) {
      warnOnce(ctx.warnings, 'WARN_IMPORT_MIRRORED',
        'Aynalanmış görseller aynalanmadan yerleştirildi; sahne modelinde ' +
        'yansıtma yoktur.');
    }

    let assetId = imageCache.get(rec.stream);
    if (assetId === undefined) {
      try {
        const img = extractImage(doc, rec.stream);
        // Varlık kimliği BAYTLARDAN türer (SHA-256). Geçici bir PDF nesne
        // numarası ya da XObject adı kullanmak, aynı görselin her sayfada
        // yeniden gömülmesi ve sahne→PDF turunda gönderinin kırılması
        // demek olurdu.
        const added = ctx.assets.add(img.bytes, {
          name: `gorsel-${index + 1}.${img.mime === 'image/jpeg' ? 'jpg' : 'png'}`
        });
        assetId = added.id;
        if (img.note) {
          warnOnce(ctx.warnings, 'WARN_IMPORT_COLOR_APPROX',
            `Bazı görsellerin rengi yaklaşık çevrildi (${img.note}).`);
        }
      } catch (err) {
        assetId = null;
        warnOnce(ctx.warnings, err.code === 'ERR_IMG_STENCIL'
          ? 'WARN_IMPORT_STENCIL' : 'WARN_IMPORT_IMAGE_FAILED',
          `Bir görsel aktarılamadı: ${err.message}`);
      }
      imageCache.set(rec.stream, assetId);
    }
    if (!assetId) continue;

    scene.addNode(Scene.createNode('image', {
      x: round(place.x), y: round(place.y),
      width: round(place.width), height: round(place.height),
      assetId, fit: 'fill',
      rotation: round(place.rotation),
      opacity: rec.opacity === undefined ? 1 : round(rec.opacity)
    }), { pageId });
    ctx.budget.left--;
    if (ctx.counts) ctx.counts.image++;
  }

  if (dropped) {
    ctx.warnings.push({
      code: 'WARN_IMPORT_NODE_BUDGET', page: index,
      message: `Sayfa ${index + 1}: düğüm bütçesi dolduğu için ${dropped} çizim alınmadı.`
    });
  }
}

/** Aynı uyarıyı yüzlerce kez üretmemek için. */
function warnOnce(list, code, message) {
  if (!list.some((w) => w.code === code)) list.push({ code, message });
}

const single = (it) => ({
  x: it.x, baseline: it.baseline, width: it.width, text: it.text, fontSize: it.fontSize
});

/** Aynı taban çizgisindeki bitişik parçaları tek metin düğümünde toplar. */
function mergeLines(items) {
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    const sameLine = last &&
      Math.abs(last.baseline - it.baseline) <= LINE_EPSILON &&
      Math.abs(last.fontSize - it.fontSize) < 0.6 &&
      it.x >= last.x + last.width - 1 &&
      it.x - (last.x + last.width) <= it.fontSize * 1.5;

    if (sameLine) {
      if (it.x - (last.x + last.width) > it.fontSize * 0.15) last.text += ' ';
      last.text += it.text;
      last.width = it.x + it.width - last.x;
      continue;
    }
    out.push(single(it));
  }
  return out;
}

function readTitle(doc) {
  try {
    const info = doc.getInfo();
    return (info && typeof info.Title === 'string') ? info.Title.slice(0, 512) : '';
  } catch {
    return '';
  }
}

module.exports = { importFromPdf, mergeLines };
