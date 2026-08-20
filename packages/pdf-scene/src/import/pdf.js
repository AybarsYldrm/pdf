'use strict';
/**
 * PDF → Sahne içe aktarıcısı.
 *
 * NE YAPAR: var olan bir PDF'in METİNLERİNİ ve sayfa geometrisini okuyup
 * düzenlenebilir sahne düğümlerine çevirir. Metin, @fitfak/pdf-doc'un
 * konumlandırılmış çıkarıcısıyla alınır — yani gerçekten sayfadaki yerinden.
 *
 * NE YAPMAZ (ve bunu iddia etmez):
 *   - Vektör çizimleri (yol, eğri, dolgu) düğüme çevrilmez.
 *   - Görseller yalnız `pageAsImage` seçeneğiyle DEĞİL, hiç aktarılmaz;
 *     PDF'ten görsel çıkarmak ayrı bir iştir ve burada yapılmıyor.
 *   - Yazı tipi dosyaları çıkarılmaz; içe aktarılan metin, sahnenin
 *     yapılandırdığı font ailesiyle yeniden çizilir. Bu, satır genişliklerinin
 *     birebir aynı çıkmayabileceği anlamına gelir.
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

  scene.transaction('PDF içe aktar', () => {
    for (let index = 0; index < pageCount; index++) {
      const geo = doc.getPageGeometry(index);
      if (Math.abs(geo.width - first.width) > 1 || Math.abs(geo.height - first.height) > 1) {
        sizeMismatch = true;
      }

      const pageId = index === 0 ? scene.pages[0].id : `pg${index + 1}`;
      if (index > 0) scene.addPage({ id: pageId, name: `Sayfa ${index + 1}` });

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
  warnings.push({
    code: 'WARN_IMPORT_TEXT_ONLY',
    message: 'Yalnız metin ve sayfa ölçüleri aktarıldı; vektör çizimler, ' +
             'görseller ve gömülü fontlar aktarılmadı.'
  });

  return { scene, warnings };
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
