'use strict';
/**
 * Sahne metin düzeni.
 *
 * Sahnedeki metin kutusu SERBEST yerleşimlidir: genişliği kullanıcı çizer,
 * satırlar o genişliğe göre sarılır, kutu dolmazsa dikey hizalama devreye
 * girer. Akış belgelerindeki gibi "önceki paragrafa göre" bir konum yoktur.
 *
 * Bu yüzden HTML yerleşim motoruna sokulmaz: orada bir metnin yeri, ondan
 * önce gelen her şeyin yüksekliğine bağlıdır. Sahnede ise koordinat
 * kullanıcının verdiğidir ve öyle kalmalıdır.
 */

/** Font yüzünün gerçek yükselti oranı (hhea). Yoksa makul bir yaklaşım. */
function ascentRatio(face) {
  try {
    const { ascender } = face.parser.hhea;
    const { unitsPerEm } = face.parser.head;
    if (ascender && unitsPerEm) return ascender / unitsPerEm;
  } catch { /* metrik okunamadı */ }
  return 0.8;
}

/**
 * Metni koşulara böler.
 *
 * `runs` verilmişse o kullanılır; yoksa düz `text` tek koşu sayılır. İki
 * yolun da aynı boru hattından geçmesi, biçimlendirmeli ve biçimlendirmesiz
 * metnin farklı davranmasını engeller.
 */
function toRuns(node) {
  if (Array.isArray(node.runs) && node.runs.length) return node.runs;
  return [{ text: node.text || '' }];
}

/**
 * Satırlara böler.
 *
 * Sarma sözcük sınırındadır; tek bir sözcük satıra sığmıyorsa KARAKTER
 * bazında kırılır. Kırmamak, kutunun dışına taşan ve hiçbir zaman
 * görünmeyen metin demektir — sessiz veri kaybı.
 *
 * @returns {{ lines: Array, lineHeight: number, totalHeight: number }}
 */
function layoutText(node, ctx) {
  const { fonts, resolveFace } = ctx;
  const padding = node.padding || 0;
  // Satır sonu kararı KAYAN NOKTA EŞİTLİĞİNE bırakılmaz. Kutu genişliği
  // tam olarak metnin ölçüsü kadarsa (içe aktarılan paragraflarda tipik
  // durum) 149.70000000000002 > 149.7 karşılaştırması sözcüğü alt satıra
  // atardı. 1/100 punto taşma, taşma değildir.
  const EPSILON = 0.01;
  const maxWidth = Math.max(0, node.frame.width - padding * 2) + EPSILON;
  const baseSize = node.fontSize || 11;
  const lineHeight = baseSize * (node.lineHeight || 1.4);
  const spacing = node.letterSpacing || 0;

  const lines = [];
  let current = { pieces: [], width: 0 };

  const pushLine = () => {
    lines.push(current);
    current = { pieces: [], width: 0 };
  };

  for (const run of toRuns(node)) {
    const size = run.fontSize || baseSize;
    const face = resolveFace(node.fontFamily, run.bold ?? node.bold, run.italic ?? node.italic);
    const color = run.color || node.color || '#111111';
    const link = run.link || null;

    // Satır sonları saygı görür: kullanıcı Enter'a bastıysa orada kırılır.
    const paragraphs = String(run.text).split('\n');

    for (let pi = 0; pi < paragraphs.length; pi++) {
      if (pi > 0) pushLine();

      // Boşlukları koru: "a  b" iki boşluk kalmalı, ama sarma sözcükte olsun
      const tokens = paragraphs[pi].match(/\s+|[^\s]+/g) || [];

      for (const token of tokens) {
        let piece = token;
        let width = fonts.measure(piece, face, size, spacing);

        // Satır başındaki boşluk yutulur (sarmadan gelen artık)
        if (/^\s+$/.test(piece) && current.pieces.length === 0) continue;

        if (current.width + width <= maxWidth || current.pieces.length === 0) {
          // Tek başına sığmıyorsa karakter karakter kır
          if (width > maxWidth && current.pieces.length === 0 && piece.length > 1) {
            let buf = '';
            for (const ch of piece) {
              const test = buf + ch;
              if (fonts.measure(test, face, size, spacing) > maxWidth && buf) {
                current.pieces.push({ text: buf, face, size, color, link,
                  width: fonts.measure(buf, face, size, spacing) });
                current.width += fonts.measure(buf, face, size, spacing);
                pushLine();
                buf = ch;
              } else {
                buf = test;
              }
            }
            piece = buf;
            width = fonts.measure(piece, face, size, spacing);
          }
          current.pieces.push({ text: piece, face, size, color, link, width });
          current.width += width;
        } else {
          pushLine();
          if (/^\s+$/.test(piece)) continue;
          current.pieces.push({ text: piece, face, size, color, link, width });
          current.width += width;
        }
      }
    }
  }
  if (current.pieces.length || !lines.length) pushLine();

  // Satır sonundaki boşlukları hizalamadan ÖNCE at: aksi hâlde ortalanmış
  // metin sağa kayık görünür.
  for (const line of lines) {
    while (line.pieces.length && /^\s+$/.test(line.pieces[line.pieces.length - 1].text)) {
      line.width -= line.pieces.pop().width;
    }
  }

  return { lines, lineHeight, totalHeight: lines.length * lineHeight };
}

/**
 * Yerleşimi çizim öğelerine çevirir (sayfa koordinatlarında).
 *
 * @param {Object} node
 * @param {{x:number,y:number}} origin düğümün sayfadaki sol üst köşesi
 * @returns {Array} çizim öğeleri
 */
function textItems(node, origin, ctx) {
  const { lines, lineHeight, totalHeight } = layoutText(node, ctx);
  const padding = node.padding || 0;
  const boxWidth = Math.max(0, node.frame.width - padding * 2);

  // `autoHeight`: kutu metnin kendisidir. Dikey hizalama anlamsızdır ve
  // taşma diye bir şey yoktur — kutu metin kadar uzar.
  const boxHeight = node.autoHeight
    ? totalHeight
    : Math.max(0, node.frame.height - padding * 2);

  let top = origin.y + padding;
  if (!node.autoHeight) {
    if (node.valign === 'middle') top += Math.max(0, (boxHeight - totalHeight) / 2);
    else if (node.valign === 'bottom') top += Math.max(0, boxHeight - totalHeight);
  }

  const items = [];
  const links = [];

  lines.forEach((line, index) => {
    let x = origin.x + padding;
    if (node.align === 'center') x += Math.max(0, (boxWidth - line.width) / 2);
    else if (node.align === 'right') x += Math.max(0, boxWidth - line.width);

    // Satırın en büyük yüzü tabanı belirler: karışık boyutlu koşularda
    // her parça kendi tabanına otursa satır dalgalanırdı.
    const ascent = line.pieces.reduce(
      (max, p) => Math.max(max, ascentRatio(p.face) * p.size), 0) || node.fontSize * 0.8;
    const baseline = top + index * lineHeight + ascent;

    for (const piece of line.pieces) {
      if (piece.text.trim()) {
        items.push({
          type: 'text', x, y: baseline, text: piece.text,
          face: piece.face, fontSize: piece.size, color: piece.color,
          letterSpacing: node.letterSpacing || 0, opacity: node.opacity
        });
      }
      if (piece.link && piece.text.trim()) {
        links.push({
          uri: piece.link,
          rect: { x, y: baseline - ascent, width: piece.width, height: lineHeight }
        });
      }
      x += piece.width;
    }
  });

  return {
    items, links,
    overflow: !node.autoHeight && totalHeight > boxHeight,
    // Ölçülen yükseklik: `autoHeight` düğümlerde çerçeve bununla güncellenir
    // ki seçim kutusu ve etiketleme metnin gerçek alanını göstersin.
    measuredHeight: totalHeight + padding * 2
  };
}

module.exports = { layoutText, textItems, ascentRatio, toRuns };
