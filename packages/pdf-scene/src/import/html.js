'use strict';
/**
 * HTML → Sahne içe aktarıcısı.
 *
 * YÖNTEM: yerleşimi YENİDEN HESAPLAMIYORUZ. HTML, mevcut ve sınanmış
 * @fitfak/pdf-html yerleşim motorundan geçirilir; motorun ürettiği
 * KONUMLANDIRILMIŞ çizim listesi sahne düğümlerine çevrilir. İkinci bir
 * yerleşim yazmak, iki motorun zamanla ayrışması ve "önizleme farklı
 * çıkıyor" hatalarının kaynağı olurdu.
 *
 * DÜRÜST SINIR: bu bir DÜZLEŞTİRMEDİR.
 *
 * Akış belgesindeki "paragraf" kavramı sahnede yoktur; sahnede kutu vardır.
 * İçe aktarılan belge tekrar düzenlenebilir ama artık akmaz: metin
 * uzayınca sonraki paragrafı itmez. Bu, serbest yerleşimli bir editöre
 * geçmenin doğal bedelidir ve gizlenmemelidir.
 */

const { Scene } = require('../scene');
const { AssetManager } = require('../assets');
const { round } = require('../units');
const { colorToHex } = require('../validate');

/** Aynı satırdaki parçaları birleştirmek için eşik (punto). */
const LINE_EPSILON = 0.6;

const toHex = (rgb) => colorToHex((rgb || [0, 0, 0]).slice(0, 3).map((n) => Math.round(n)));

/**
 * Aynı satıra ve aynı biçime ait metin parçalarını TEK düğümde toplar.
 *
 * Her çizim parçasına ayrı bir düğüm vermek teknik olarak doğru ama
 * kullanışsız olurdu: bir cümleyi düzenlemek için otuz kutuyu tek tek
 * seçmek gerekirdi.
 */
function mergeTextItems(items) {
  const groups = [];

  for (const item of items) {
    const last = groups[groups.length - 1];
    const sameLine = last &&
      Math.abs(last.y - item.y) <= LINE_EPSILON &&
      last.face === item.face &&
      last.fontSize === item.fontSize &&
      last.colorKey === toHex(item.color) &&
      // Bitişik mi? Araya bir boşluk kadar yer sığıyorsa hâlâ aynı satır
      item.x >= last.right - 0.5 && item.x - last.right <= item.fontSize * 1.2;

    if (sameLine) {
      // Kayıp boşluğu geri koy: çizimde boşluk yoktur, konum farkı vardır
      if (item.x - last.right > item.fontSize * 0.15) last.text += ' ';
      last.text += item.text;
      last.right = item.x + measureWidth(item);
      continue;
    }

    groups.push({
      x: item.x, y: item.y, right: item.x + measureWidth(item),
      text: item.text, face: item.face, fontSize: item.fontSize,
      color: item.color, colorKey: toHex(item.color),
      letterSpacing: item.letterSpacing || 0
    });
  }
  return groups;
}

function measureWidth(item) {
  if (!item.face || !item.face.parser) return item.text.length * item.fontSize * 0.5;
  let w = 0;
  for (const ch of item.text) {
    w += item.face.parser.getGlyphWidth(
      item.face.parser.getGlyphId(ch.codePointAt(0)), item.fontSize);
    w += item.letterSpacing || 0;
  }
  return w;
}

/**
 * HTML'i sahneye aktarır.
 *
 * @param {Object} o `@fitfak/pdf-html`'in `render()` seçenekleri
 *   (html, css, fonts, page, baseDir, assetRoots …) — kum havuzu ayarları
 *   dâhil AYNEN geçer; içe aktarma güvenlik sınırlarını gevşetmez.
 * @returns {{ scene: Scene, warnings: Array }}
 */
function importFromHtml(o = {}) {
  const { render } = require('@fitfak/pdf-html');
  const layout = render({ ...o, layoutOnly: true });

  const warnings = [...(layout.warnings || [])];
  const assets = new AssetManager();

  const marginLeft = layout.page.margin.left;
  const marginTop = layout.page.margin.top;

  const scene = Scene.blank({
    title: (layout.metadata && layout.metadata.title) || '',
    lang: (o.metadata && o.metadata.lang) || 'tr-TR',
    size: { width: layout.page.width, height: layout.page.height },
    margin: layout.page.margin
  });
  scene.assets = assets;

  scene.transaction('HTML içe aktar', () => {
    // Boş başlangıç sayfasını kullanıp gerisini ekliyoruz
    layout.pages.forEach((p, index) => {
      const pageId = index === 0 ? scene.pages[0].id : `pg${index + 1}`;
      if (index > 0) scene.addPage({ id: pageId, name: `Sayfa ${index + 1}` });

      const texts = [];
      for (const item of p.items) {
        // Yerleşim koordinatları içerik kutusuna GÖREdir; sahne sayfaya göre
        const x = round(marginLeft + item.x);
        const y = round(marginTop + item.y);

        if (item.type === 'rect') {
          scene.addNode(Scene.createNode('rect', {
            x, y, width: round(item.width), height: round(item.height),
            fill: toHex(item.fill),
            opacity: item.opacity === undefined ? 1 : item.opacity
          }), { pageId });
          continue;
        }

        if (item.type === 'image') {
          let asset;
          try {
            asset = assets.add(item.image.buffer, { name: String(item.src).slice(0, 120) });
          } catch (err) {
            warnings.push({
              code: err.code || 'ERR_ASSET', type: 'import',
              message: `Görsel aktarılamadı: ${err.message}`
            });
            continue;
          }
          scene.addNode(Scene.createNode('image', {
            x, y, width: round(item.width), height: round(item.height),
            assetId: asset.id, fit: 'fill', alt: item.alt || ''
          }), { pageId });
          continue;
        }

        if (item.type === 'text') {
          texts.push({ ...item, x, y });
        }
      }

      // Metinler en sonda: satır birleştirme sıralı bir liste ister
      texts.sort((a, b) => (a.y - b.y) || (a.x - b.x));
      for (const g of mergeTextItems(texts)) {
        const ascent = ascentOf(g.face, g.fontSize);
        scene.addNode(Scene.createNode('text', {
          x: round(g.x),
          y: round(g.y - ascent),
          width: round(Math.max(4, g.right - g.x + 1)),
          height: round(g.fontSize * 1.4),
          text: g.text,
          fontFamily: (g.face && g.face.family) || 'Ubuntu',
          fontSize: round(g.fontSize),
          color: g.colorKey,
          lineHeight: 1.4,
          letterSpacing: g.letterSpacing || 0,
          bold: !!(g.face && g.face.weight >= 600),
          italic: !!(g.face && g.face.style === 'italic')
        }), { pageId });
      }
    });

    // İmza yuvaları: yerleşim motoru bunları ayrı bildirir
    for (const slot of layout.engine.slots || []) {
      const rect = slot._contentRect;
      if (!rect) continue;
      scene.addNode(Scene.createNode('signature', {
        x: round(marginLeft + rect.x), y: round(marginTop + rect.y),
        width: round(rect.width), height: round(rect.height),
        fieldName: slot.id || '', role: slot.role || '', label: 'İmza'
      }), { pageId: scene.pages[slot.page] ? scene.pages[slot.page].id : scene.pages[0].id });
    }
  });

  scene.history.clear();     // içe aktarma bir geri alma adımı değildir

  warnings.push({
    code: 'WARN_IMPORT_FLATTENED', type: 'import',
    message: 'HTML sahneye DÜZLEŞTİRİLEREK aktarıldı: metin kutuları artık ' +
             'akmaz, uzayan metin sonrakini itmez.'
  });

  return { scene, warnings };
}

function ascentOf(face, fontSize) {
  try {
    const { ascender } = face.parser.hhea;
    const { unitsPerEm } = face.parser.head;
    if (ascender && unitsPerEm) return (ascender / unitsPerEm) * fontSize;
  } catch { /* metrik yok */ }
  return fontSize * 0.8;
}

module.exports = { importFromHtml, mergeTextItems };
