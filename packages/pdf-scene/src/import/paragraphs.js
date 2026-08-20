'use strict';
/**
 * Satırları PARAGRAFA toplar.
 *
 * SORUN: hem PDF hem HTML içe aktarıcısı, kaynaktan SATIR alır. Her satırı
 * ayrı bir metin kutusu yapmak teknik olarak doğrudur — kâğıtta aynı görünür
 * — ama belgeyi DÜZENLENEMEZ hâle getirir: bir cümleye kelime eklemek,
 * altındaki on kutuyu elle kaydırmayı gerektirir. Kullanıcının gördüğü şey
 * bir paragraftır; modelde de paragraf olmalıdır.
 *
 * ÇÖZÜM: aynı bloktan geldiği anlaşılan ardışık satırlar tek bir metin
 * düğümünde birleşir ve düğüm `autoHeight` olur — metin uzayınca kutu uzar,
 * yeniden akar.
 *
 * NEREDE DURULUR: gruplama TAHMİNDİR ve tahmin yanlış olabilir. Bu yüzden
 * kurallar dar tutulmuştur; şüphede kalınırsa satır AYRI bırakılır. Yanlış
 * birleştirilmiş iki paragrafı ayırmak, ayrı kalmış iki satırı birleştirmekten
 * daha zahmetlidir.
 *
 * SATIR SONLARI KORUNMAZ. Paragraf akmalıdır: satırlar tek boşlukla
 * birleşir. Adres bloğu gibi sabit satırlı metinlerde bu bir kayıptır ve
 * `WARN_IMPORT_LINES_MERGED` ile bildirilir.
 */

/** Sol kenarların "aynı" sayılma toleransı (punto). */
const LEFT_TOLERANCE = 1.5;

/** Punto farkı bu değerden büyükse ayrı bloktur. */
const SIZE_TOLERANCE = 0.6;

/** Satır aralığı bu oranlar arasında olmalı (punto cinsinden çarpan). */
const MIN_GAP_RATIO = 0.6;
const MAX_GAP_RATIO = 2.2;

/** Yerleşmiş satır aralığından sapma payı. */
const GAP_DRIFT = 0.3;

/** İlk satır girintisi (ya da asılı girinti) için üst sınır. */
const MAX_INDENT_RATIO = 4;

/**
 * @typedef {Object} Line
 * @property {number} x        sol kenar
 * @property {number} right    sağ kenar
 * @property {number} baseline taban çizgisi (sahne y'si, aşağı büyür)
 * @property {number} fontSize
 * @property {string} text
 * @property {string} styleKey aynı biçim mi? (renk, aile, kalın, eğik…)
 */

/**
 * Satırları paragraflara toplar.
 *
 * @param {Line[]} lines taban çizgisine göre SIRALI satırlar
 * @returns {Array<{x:number,right:number,baseline:number,fontSize:number,
 *                  lineHeight:number,align:string,lines:Line[],text:string,
 *                  merged:boolean}>}
 */
function groupParagraphs(lines) {
  const out = [];
  let current = null;

  const close = () => {
    if (current) out.push(finish(current));
    current = null;
  };

  for (const line of lines) {
    if (!current) { current = start(line); continue; }

    if (!joins(current, line)) { close(); current = start(line); continue; }

    const gap = line.baseline - current.lastBaseline;
    current.gaps.push(gap);
    current.lines.push(line);
    current.lastBaseline = line.baseline;
    current.x = Math.min(current.x, line.x);
    current.right = Math.max(current.right, line.right);
  }
  close();

  return out;
}

function start(line) {
  return {
    lines: [line], gaps: [],
    x: line.x, right: line.right,
    baseline: line.baseline, lastBaseline: line.baseline,
    fontSize: line.fontSize, styleKey: line.styleKey
  };
}

/**
 * Bu satır o paragrafın devamı mı?
 *
 * Her koşul ayrı bir sebeple vardır ve hiçbiri "genelde işe yarıyor" diye
 * konmamıştır.
 */
function joins(para, line) {
  // 1. Biçim değişikliği blok değişikliğidir: başlıktan gövdeye geçiş.
  if (para.styleKey !== line.styleKey) return false;
  if (Math.abs(para.fontSize - line.fontSize) > SIZE_TOLERANCE) return false;

  // 2. Aşağı doğru gitmeyen satır aynı bloktan olamaz (sütun atlaması).
  const gap = line.baseline - para.lastBaseline;
  if (gap <= 0) return false;
  if (gap < para.fontSize * MIN_GAP_RATIO) return false;
  if (gap > para.fontSize * MAX_GAP_RATIO) return false;

  // 3. Aralık YERLEŞTİYSE ona sadık kalınmalı: aralığın büyümesi yeni
  //    paragraf, küçülmesi altyazı/dipnot demektir.
  if (para.gaps.length) {
    const settled = para.gaps[para.gaps.length - 1];
    if (Math.abs(gap - settled) > settled * GAP_DRIFT) return false;
  }

  // 4. Sütun örtüşmesi: yan yana iki sütunun satırları birbirine karışmasın.
  const overlap = Math.min(para.right, line.right) - Math.max(para.x, line.x);
  const narrower = Math.min(para.right - para.x, line.right - line.x);
  if (narrower > 0 && overlap < narrower * 0.5) return false;

  // 5. Yatay hizalanma. Sol kenarlar tutuyorsa sorun yok. Tutmuyorsa
  //    yalnız İKİ durum kabul edilir: ilk satır girintisi (paragraf başı)
  //    ve ortalanmış/sağa dayalı blok.
  if (Math.abs(line.x - para.x) <= LEFT_TOLERANCE) return true;

  const indentLimit = para.fontSize * MAX_INDENT_RATIO;
  if (para.lines.length === 1 && Math.abs(line.x - para.x) <= indentLimit) return true;

  const centered = Math.abs(
    (line.x + line.right) / 2 - (para.x + para.right) / 2) <= LEFT_TOLERANCE;
  if (centered) return true;

  return Math.abs(line.right - para.right) <= LEFT_TOLERANCE;
}

/** Paragrafı kapatır: hizalama ve satır aralığı hesaplanır. */
function finish(para) {
  const gap = median(para.gaps);
  const lineHeight = gap && para.fontSize
    ? clamp(gap / para.fontSize, 0.8, 4)
    : 1.4;

  return {
    x: para.x,
    right: para.right,
    baseline: para.baseline,
    fontSize: para.fontSize,
    lineHeight: Math.round(lineHeight * 100) / 100,
    align: detectAlign(para),
    lines: para.lines,
    // Satırlar tek boşlukla birleşir: paragraf AKMALIDIR.
    text: para.lines.map((l) => l.text.trim()).filter(Boolean).join(' '),
    merged: para.lines.length > 1
  };
}

/**
 * Hizalamayı satırların kenarlarından çıkarır.
 *
 * Tek satırlık bloklarda hizalama BİLİNEMEZ: kutu metin kadar geniştir,
 * her hizalama aynı görünür. `left` seçilir çünkü kullanıcı kutuyu
 * genişlettiğinde en az şaşırtıcı olan davranıştır.
 */
function detectAlign(para) {
  if (para.lines.length < 2) return 'left';

  const lefts = para.lines.map((l) => l.x);
  const rights = para.lines.map((l) => l.right);
  const centers = para.lines.map((l) => (l.x + l.right) / 2);

  const leftAligned = spread(lefts) <= LEFT_TOLERANCE;
  const rightAligned = spread(rights) <= LEFT_TOLERANCE;
  const centerAligned = spread(centers) <= LEFT_TOLERANCE;

  // Son satır hariç sağ kenarlar tutuyorsa iki yana yaslanmıştır: son
  // satırın kısa olması yaslamanın doğasıdır.
  if (leftAligned && para.lines.length > 2 &&
      spread(rights.slice(0, -1)) <= LEFT_TOLERANCE &&
      rights[rights.length - 1] < rights[0] - LEFT_TOLERANCE) {
    return 'justify';
  }
  if (leftAligned && rightAligned) return 'left';
  if (leftAligned) return 'left';
  if (centerAligned) return 'center';
  if (rightAligned) return 'right';
  return 'left';
}

const spread = (values) => Math.max(...values) - Math.min(...values);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

module.exports = {
  groupParagraphs, detectAlign,
  LEFT_TOLERANCE, SIZE_TOLERANCE, MIN_GAP_RATIO, MAX_GAP_RATIO
};
