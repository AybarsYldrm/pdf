'use strict';
/**
 * PDF → Sahne içe aktarıcısı.
 *
 * NE YAPAR: var olan bir PDF'in METİNLERİNİ ve sayfa geometrisini okuyup
 * düzenlenebilir sahne düğümlerine çevirir. Metin, @fitfak/pdf-doc'un
 * konumlandırılmış çıkarıcısıyla alınır — yani gerçekten sayfadaki yerinden.
 *
 * Vektör çizimler `path` düğümüne, görsel XObject'leri varlığa + `image`
 * düğümüne çevrilir (bkz. pdfgraphics.js ve pdfimage.js).
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
const { collectGraphics, placeUnitSquare } = require('./pdfgraphics');
const { groupParagraphs } = require('./paragraphs');
const { extractImage } = require('./pdfimage');

/** Aynı satır sayılma eşiği (punto). */
const LINE_EPSILON = 1.5;

/**
 * PDF'i sahneye aktarır.
 *
 * @param {Buffer} pdfBuffer
 * @param {{ password?: string, fontFamily?: string, maxPages?: number,
 *           mergeLines?: boolean,
 *           fonts?: Array<{family:string, src:string|Buffer}> }} [o]
 *   `fonts` verilirse taban çizgisi → kutu üstü dönüşümü GERÇEK font
 *   yükseltisiyle yapılır. Verilmezse 0.8 yaklaşıklığı kullanılır ve
 *   düğümler birkaç punto kayabilir.
 * @returns {{ scene: Scene, warnings: Array }}
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
  if (doc.hasSignatures && doc.hasSignatures()) {
    warnings.push({
      code: 'WARN_SIGNATURES_DROPPED',
      message: 'Kaynak belgede imza var; içe aktarılan sahne YENİ bir belgedir ' +
               've eski imzaları taşımaz.'
    });
  }

  const first = doc.getPageGeometry(0);
  const scene = Scene.blank({
    title: readTitle(doc),
    size: { width: first.width, height: first.height },
    margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });
  scene.assets = new AssetManager();

  const fontFamily = o.fontFamily || 'Ubuntu';
  let sizeMismatch = false;
  let mergedLines = false;

  /**
   * Taban çizgisi → kutu üst kenarı için yükselti oranı.
   *
   * PDF metin öğesi TABAN ÇİZGİSİNDE durur; sahne düğümü ise kutunun ÜST
   * kenarında. Aradaki fark fontun yükseltisidir. Gerçek font verilmişse
   * ölçülür — o zaman sahne→PDF→sahne turu birebir kapanır.
   */
  let ascentRatio = 0.8;
  if (o.fonts && o.fonts.length) {
    try {
      const { FontManager } = require('@fitfak/pdf-html/src/font/manager');
      const fm = new FontManager();
      for (const face of o.fonts) fm.register(face);
      const face = fm.resolve([fontFamily], 400, 'normal');
      const { ascender } = face.parser.hhea;
      const { unitsPerEm } = face.parser.head;
      if (ascender && unitsPerEm) ascentRatio = ascender / unitsPerEm;
    } catch (err) {
      warnings.push({
        code: 'WARN_FONT_METRICS',
        message: `Font ölçüsü okunamadı, yaklaşıklık kullanılıyor: ${err.message}`
      });
    }
  }

  // Düğüm bütçesi: bir harita ya da karmaşık bir grafik on binlerce yol
  // içerebilir. Sahne sınırlarını aşmak yerine sınıra kadar alınır ve
  // kalanın alınmadığı SÖYLENİR.
  const budget = { left: o.maxNodes || 4000 };

  scene.transaction('PDF içe aktar', () => {
    for (let index = 0; index < pageCount; index++) {
      const geo = doc.getPageGeometry(index);
      if (Math.abs(geo.width - first.width) > 1 || Math.abs(geo.height - first.height) > 1) {
        sizeMismatch = true;
      }

      const pageId = index === 0 ? scene.pages[0].id : `pg${index + 1}`;
      if (index > 0) scene.addPage({ id: pageId, name: `Sayfa ${index + 1}` });

      // ÇİZİMLER ÖNCE: metin, kaynak belgelerin ezici çoğunluğunda arka plan
      // dolgularının ve logoların ÜSTÜNDEDİR. Çizim listesindeki gerçek
      // sırayı korumak, metni ayrı bir çıkarıcıdan aldığımız için mümkün
      // değil; bu yüzden kural açıkça seçilmiştir ve belgelenmiştir.
      if (o.graphics !== false) {
        addGraphics(doc, index, geo, scene, pageId, {
          warnings, assets: scene.assets, budget
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
        continue;
      }

      // PDF sol-ALT başlangıçlıdır ve `y` TABAN çizgisidir; sahne sol-ÜST
      // başlangıçlı ve `y` kutunun ÜST kenarıdır.
      const converted = items.map((it) => ({
        text: it.text,
        x: it.x,
        baseline: geo.height - it.y,
        width: it.width || it.text.length * it.fontSize * 0.5,
        fontSize: it.fontSize || 11
      })).filter((it) => it.text && it.text.trim());

      converted.sort((a, b) => (a.baseline - b.baseline) || (a.x - b.x));

      const groups = o.mergeLines === false ? converted.map(single) : mergeLines(converted);

      if (o.paragraphs === false) {
        // Satır satır: kâğıttaki yerleşime en sadık ama DÜZENLENEMEZ hâl.
        for (const g of groups) {
          scene.addNode(Scene.createNode('text', {
            x: round(g.x),
            y: round(g.baseline - g.fontSize * ascentRatio),
            width: round(Math.max(4, g.width)),
            height: round(g.fontSize * 1.4),
            text: g.text,
            fontFamily,
            fontSize: round(g.fontSize),
            lineHeight: 1.4
          }), { pageId });
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
        if (para.merged) mergedLines = true;
        scene.addNode(Scene.createNode('text', {
          x: round(para.x),
          y: round(para.baseline - para.fontSize * ascentRatio),
          width: round(Math.max(4, para.right - para.x)),
          // Yükseklik metinden hesaplanacak; buradaki değer yalnız
          // başlangıçtır ve derleyici onu günceller.
          height: round(para.fontSize * para.lineHeight * para.lines.length),
          text: para.text,
          fontFamily,
          fontSize: round(para.fontSize),
          lineHeight: para.lineHeight,
          align: para.align,
          autoHeight: true
        }), { pageId });
      }
    }
  });

  scene.history.clear();

  if (sizeMismatch) {
    warnings.push({
      code: 'WARN_PAGE_SIZE_MISMATCH',
      message: 'Kaynak belgede sayfa boyutları farklı; sahne TEK boyut taşır ' +
               've ilk sayfanınki kullanıldı.'
    });
  }
  if (mergedLines) {
    warnings.push({
      code: 'WARN_IMPORT_LINES_MERGED',
      message: 'Ardışık satırlar paragrafa toplandı ve kutular metne göre ' +
               'uzuyor; kaynaktaki SABİT satır sonları korunmadı.'
    });
  }
  warnings.push({
    code: 'WARN_IMPORT_FLATTENED',
    message: o.graphics === false
      ? 'Yalnız metin ve sayfa ölçüleri aktarıldı; çizimler istenmedi.'
      : 'Metin, çizim ve görseller aktarıldı; gömülü fontlar aktarılmadı. ' +
        'Paragraflar kendi içinde yeniden akar ama kutular birbirini İTMEZ.'
  });

  return { scene, warnings };
}

/**
 * Sayfanın vektör çizimlerini ve görsellerini sahneye ekler.
 *
 * @param {Object} doc PdfDocument
 * @param {number} index sayfa sırası
 * @param {Object} geo sayfa geometrisi
 * @param {Scene} scene
 * @param {string} pageId
 * @param {{ warnings:Array, assets:AssetManager, budget:{left:number} }} ctx
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
        const added = ctx.assets.add(img.bytes, { name: `gorsel-${index + 1}.${img.mime === 'image/jpeg' ? 'jpg' : 'png'}` });
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

const single = (it) => ({ x: it.x, baseline: it.baseline, width: it.width, text: it.text, fontSize: it.fontSize });

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
