'use strict';
/**
 * PDF içerik akışı → yerleştirilmiş çizim kayıtları.
 *
 * İçerik akışı bir ÇİZİM PROGRAMIDIR: "matrisi şu yap, şu yolu kur, boya".
 * Sahne ise NESNE listesidir. Bu dosya programı çalıştırıp — ama yalnız
 * geometri ve renk açısından — ortaya çıkan nesneleri toplar.
 *
 * TASARIM: burada hiçbir sahne düğümü ÜRETİLMEZ. Çıktı yalın kayıtlardır;
 * düğüme çevirme işi `pdf.js` içe aktarıcısınındır. Böylece bu dosya
 * sahne şemasından bağımsız kalır ve tek başına test edilebilir.
 *
 * DESTEKLENMEYENİ SESSİZCE ATLAMAZ: gölgeleme (`sh`), desen (`Pattern`),
 * satır içi görsel (`BI`) ve çözülemeyen görseller uyarı olarak bildirilir.
 * "Bir şeyler eksik ama ne olduğu belli değil" en kötü sonuçtur.
 */

const { tokenizeContent } = require('@fitfak/pdf-doc');
const pagespace = require('../pagespace');

/** Yuvalanmış form XObject derinliği. */
const MAX_FORM_DEPTH = 8;

/** Sayfa başına toplanacak en fazla çizim. */
const MAX_RECORDS = 20_000;

/** Tek yolda en fazla segment. */
const MAX_SEGMENTS = 20_000;

// Matris ve sayfa uzayı hesabı `../pagespace`tedir: PDF ile sahne arasındaki
// dönüşümün TEK bir uygulaması olsun diye. Burada yeniden yazmak, iki
// uygulamanın zamanla ayrışması demektir.
const { IDENTITY, concat, applyM } = pagespace;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const hex2 = (v) => {
  const n = Math.max(0, Math.min(255, Math.round(v * 255)));
  return n.toString(16).padStart(2, '0');
};

const grayHex = (g) => `#${hex2(g)}${hex2(g)}${hex2(g)}`;
const rgbHex = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** CMYK → RGB (profilsiz, PDF görüntüleyicilerinin yaptığı basit dönüşüm). */
const cmykHex = (c, m, y, k) => rgbHex(
  (1 - Math.min(1, c + k)), (1 - Math.min(1, m + k)), (1 - Math.min(1, y + k))
);

/* ------------------------------------------------------------------ */
/* Grafik durumu                                                       */
/* ------------------------------------------------------------------ */

const initialState = () => ({
  ctm: IDENTITY,
  fill: '#000000',
  stroke: '#000000',
  lineWidth: 1,
  fillAlpha: 1,
  strokeAlpha: 1,
  fillComponents: 1,      // seçili renk uzayının bileşen sayısı (`sc`/`scn` için)
  strokeComponents: 1,
  // Separation/DeviceN'de sayı bir YOĞUNLUKTUR: 0 mürekkep yok (beyaz),
  // 1 tam mürekkep. DeviceGray'de tersi: 0 siyah, 1 beyaz. Bunu ayırt
  // etmeden tek bileşenli rengi çevirmek, siyahı beyaza döndürür.
  fillTint: false,
  strokeTint: false,
  fillPattern: false,
  strokePattern: false,
  dash: 'solid'
});

/**
 * Sayfanın (ya da bir form XObject'in) içerik akışını yürütür.
 *
 * @param {Object} doc PdfDocument
 * @param {Buffer} content çözülmüş içerik akışı
 * @param {Object} resources kaynak sözlüğü
 * @param {Object} o { ctm, depth, out, warnings, seenForms }
 */
function runContent(doc, content, resources, o) {
  const { out, warnings } = o;
  let gs = { ...initialState(), ctm: o.ctm };
  const stack = [];

  // Kurulan yol PDF kullanıcı uzayındadır; boyama işlecinde dönüştürülür.
  let path = [];
  let segments = 0;
  let start = null;
  let cur = null;
  let pendingClip = false;

  const warnOnce = (code, message) => {
    if (!warnings.some((w) => w.code === code)) warnings.push({ code, message });
  };

  const flush = (fill, stroke, evenOdd, close) => {
    if (close && cur && start) path.push(['Z']);
    if (!path.length || out.length >= MAX_RECORDS) { path = []; cur = start = null; return; }

    // Yol, çizildiği ANDAKİ matrisle sahne uzayına taşınır. Sonradan
    // taşımak, `q/Q` ile geri alınan matrisi kaçırmak demektir. Sayfa
    // matrisi (y çevirme, kırpma kutusu kayması, sayfa dönmesi) zaten
    // başlangıç CTM'sinin içindedir.
    const d = [];
    for (const cmd of path) {
      switch (cmd[0]) {
        case 'M': case 'L': {
          const [x, y] = applyM(gs.ctm, cmd[1], cmd[2]);
          d.push([cmd[0], x, y]);
          break;
        }
        case 'C': {
          const [x1, y1] = applyM(gs.ctm, cmd[1], cmd[2]);
          const [x2, y2] = applyM(gs.ctm, cmd[3], cmd[4]);
          const [x3, y3] = applyM(gs.ctm, cmd[5], cmd[6]);
          d.push(['C', x1, y1, x2, y2, x3, y3]);
          break;
        }
        case 'Z': d.push(['Z']); break;
      }
    }

    // Çizgi kalınlığı da matristen etkilenir: 1 birim genişlik, 0.5 ölçekli
    // bir matriste 0.5 punto çizer.
    const scale = Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2])) || 1;

    out.push({
      kind: 'path', d,
      fill: fill && !gs.fillPattern ? gs.fill : null,
      stroke: stroke && !gs.strokePattern ? gs.stroke : null,
      strokeWidth: stroke ? Math.max(0.05, gs.lineWidth * scale) : 0,
      fillRule: evenOdd ? 'evenodd' : 'nonzero',
      dash: gs.dash,
      opacity: fill ? gs.fillAlpha : gs.strokeAlpha
    });

    if ((fill && gs.fillPattern) || (stroke && gs.strokePattern)) {
      warnOnce('WARN_IMPORT_PATTERN',
        'Desen/gölgeleme ile boyanmış alanlar düz renksiz aktarıldı.');
    }

    path = [];
    cur = start = null;
  };

  for (const { op, args } of tokenizeContent(content)) {
    if (out.length >= MAX_RECORDS) break;

    switch (op) {
      /* --- durum --- */
      case 'q': stack.push({ ...gs }); break;
      case 'Q': if (stack.length) gs = stack.pop(); break;
      case 'cm':
        if (args.length >= 6) {
          gs.ctm = concat(args.slice(-6).map(num), gs.ctm);
        }
        break;
      case 'w': gs.lineWidth = Math.abs(num(args[args.length - 1])); break;
      case 'd':
        // Kesik çizgi deseni: sahnede üç seçenek var, PDF'te sonsuz. Boş
        // dizi düz çizgidir; gerisi "kesik" sayılır.
        gs.dash = Array.isArray(args[0]) && args[0].length ? 'dashed' : 'solid';
        break;
      case 'gs': {
        const ext = lookup(doc, resources, 'ExtGState', args[args.length - 1]);
        if (ext && ext.map) {
          const ca = doc.get(ext, 'ca');
          const CA = doc.get(ext, 'CA');
          if (typeof ca === 'number') gs.fillAlpha = Math.max(0, Math.min(1, ca));
          if (typeof CA === 'number') gs.strokeAlpha = Math.max(0, Math.min(1, CA));
          const lw = doc.get(ext, 'LW');
          if (typeof lw === 'number') gs.lineWidth = Math.abs(lw);
        }
        break;
      }

      /* --- renk --- */
      case 'g':  gs.fill = grayHex(num(args[0])); gs.fillPattern = false; gs.fillTint = false; gs.fillComponents = 1; break;
      case 'G':  gs.stroke = grayHex(num(args[0])); gs.strokePattern = false; gs.strokeTint = false; gs.strokeComponents = 1; break;
      case 'rg': gs.fill = rgbHex(num(args[0]), num(args[1]), num(args[2])); gs.fillPattern = false; gs.fillComponents = 3; break;
      case 'RG': gs.stroke = rgbHex(num(args[0]), num(args[1]), num(args[2])); gs.strokePattern = false; gs.strokeComponents = 3; break;
      case 'k':  gs.fill = cmykHex(num(args[0]), num(args[1]), num(args[2]), num(args[3])); gs.fillPattern = false; gs.fillComponents = 4; break;
      case 'K':  gs.stroke = cmykHex(num(args[0]), num(args[1]), num(args[2]), num(args[3])); gs.strokePattern = false; gs.strokeComponents = 4; break;

      case 'cs': case 'CS': {
        const info = namedColorSpace(doc, resources, args[args.length - 1]);
        if (op === 'cs') {
          gs.fillComponents = info.components;
          gs.fillPattern = info.pattern;
          gs.fillTint = info.tint;
          // Renk uzayı değişince renk BAŞLANGIÇ değerine döner (PDF 8.6.8);
          // eski uzaydan kalan rengi taşımak yanlış renk üretir.
          if (!info.pattern) gs.fill = info.tint ? '#ffffff' : '#000000';
        } else {
          gs.strokeComponents = info.components;
          gs.strokePattern = info.pattern;
          gs.strokeTint = info.tint;
          if (!info.pattern) gs.stroke = info.tint ? '#ffffff' : '#000000';
        }
        break;
      }

      case 'sc': case 'scn': case 'SC': case 'SCN': {
        const isFill = op === 'sc' || op === 'scn';
        const nums = args.filter((a) => typeof a === 'number').map(num);
        const color = colorFromComponents(nums, isFill ? gs.fillTint : gs.strokeTint);
        if (color) {
          if (isFill) { gs.fill = color; gs.fillPattern = false; }
          else { gs.stroke = color; gs.strokePattern = false; }
          if (nums.length === 1 && (isFill ? gs.fillTint : gs.strokeTint)) {
            warnOnce('WARN_IMPORT_TINT',
              'Separation/DeviceN renkleri dönüşüm işlevi olmadan gri yaklaşıklıkla alındı.');
          }
        } else if (args.some((a) => a && a.name)) {
          // Desen adı geldi: rengi bilmiyoruz, uydurmuyoruz.
          if (isFill) gs.fillPattern = true; else gs.strokePattern = true;
        }
        break;
      }

      /* --- yol kurma --- */
      case 'm':
        if (segments++ < MAX_SEGMENTS) {
          cur = start = [num(args[0]), num(args[1])];
          path.push(['M', cur[0], cur[1]]);
        }
        break;
      case 'l':
        if (cur && segments++ < MAX_SEGMENTS) {
          cur = [num(args[0]), num(args[1])];
          path.push(['L', cur[0], cur[1]]);
        }
        break;
      case 'c':
        if (cur && segments++ < MAX_SEGMENTS) {
          path.push(['C', num(args[0]), num(args[1]), num(args[2]), num(args[3]),
            num(args[4]), num(args[5])]);
          cur = [num(args[4]), num(args[5])];
        }
        break;
      case 'v':
        // `v`: ilk denetim noktası GEÇERLİ noktadır.
        if (cur && segments++ < MAX_SEGMENTS) {
          path.push(['C', cur[0], cur[1], num(args[0]), num(args[1]),
            num(args[2]), num(args[3])]);
          cur = [num(args[2]), num(args[3])];
        }
        break;
      case 'y':
        // `y`: ikinci denetim noktası BİTİŞ noktasıdır.
        if (cur && segments++ < MAX_SEGMENTS) {
          path.push(['C', num(args[0]), num(args[1]), num(args[2]), num(args[3]),
            num(args[2]), num(args[3])]);
          cur = [num(args[2]), num(args[3])];
        }
        break;
      case 'h':
        if (start) { path.push(['Z']); cur = start.slice(); }
        break;
      case 're': {
        if (segments >= MAX_SEGMENTS) break;
        segments += 4;
        const x = num(args[0]), y = num(args[1]), w = num(args[2]), h = num(args[3]);
        path.push(['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']);
        cur = start = [x, y];
        break;
      }

      /* --- kırpma --- */
      case 'W': case 'W*':
        // Kırpma bölgesi sahnede yoktur. Yolu kırpma olarak kullanıp
        // ÇİZMEMEK doğru olandır; kırpılan içeriği kırpılmamış göstermek
        // ise fazladan çizim demektir ve bildirilir.
        pendingClip = true;
        break;

      /* --- boyama --- */
      case 'n':
        if (pendingClip) {
          warnOnce('WARN_IMPORT_CLIP',
            'Kırpma bölgeleri aktarılmadı; kırpılmış çizimler tam görünebilir.');
          pendingClip = false;
        }
        path = []; cur = start = null;
        break;
      case 'f': case 'F': flush(true, false, false, true); pendingClip = false; break;
      case 'f*': flush(true, false, true, true); pendingClip = false; break;
      case 'S': flush(false, true, false, false); pendingClip = false; break;
      case 's': flush(false, true, false, true); pendingClip = false; break;
      case 'B': flush(true, true, false, false); pendingClip = false; break;
      case 'B*': flush(true, true, true, false); pendingClip = false; break;
      case 'b': flush(true, true, false, true); pendingClip = false; break;
      case 'b*': flush(true, true, true, true); pendingClip = false; break;

      case 'sh':
        warnOnce('WARN_IMPORT_SHADING',
          'Gölgeleme (gradyan) dolguları aktarılmadı.');
        break;

      /* --- XObject --- */
      case 'Do': {
        const name = args[args.length - 1];
        const xobj = lookup(doc, resources, 'XObject', name);
        if (!xobj || !xobj.dict) break;

        const subtype = doc.get(xobj.dict, 'Subtype');
        const kind = subtype && subtype.name;

        if (kind === 'Image') {
          out.push({ kind: 'image', stream: xobj, ctm: gs.ctm, opacity: gs.fillAlpha });
        } else if (kind === 'Form') {
          if (o.depth >= MAX_FORM_DEPTH) {
            warnOnce('WARN_IMPORT_FORM_DEPTH', 'İç içe form XObject sınırı aşıldı.');
            break;
          }
          // Aynı formu kendi içinde çağıran belgeler vardır (bozuk ya da
          // kötü niyetli); yığında olanı tekrar açmayız.
          const key = xobj._sceneKey || (xobj._sceneKey = Symbol('form'));
          if (o.seenForms.has(key)) {
            warnOnce('WARN_IMPORT_FORM_CYCLE', 'Kendini çağıran form XObject atlandı.');
            break;
          }
          o.seenForms.add(key);
          try {
            const matrix = doc.get(xobj.dict, 'Matrix');
            const formCtm = Array.isArray(matrix) && matrix.length === 6
              ? concat(matrix.map(num), gs.ctm)
              : gs.ctm;
            const formRes = doc.resolve(doc.get(xobj.dict, 'Resources')) || resources;
            runContent(doc, doc.getStreamData(xobj), formRes, {
              ...o, ctm: formCtm, depth: o.depth + 1
            });
          } catch (err) {
            warnOnce('WARN_IMPORT_FORM_FAILED',
              `Bir form XObject okunamadı: ${err.message}`);
          } finally {
            o.seenForms.delete(key);
          }
        }
        break;
      }

      default:
        break;                       // metin işleçleri: extractTextItems'ın işi
    }
  }
}

// `pageMatrix` ve `placeUnitSquare` sayfa uzayı modülünündür; buradan yalnız
// yeniden dışa açılırlar (eski çağıranlar kırılmasın diye).
const { pageMatrix, placeUnitSquare } = pagespace;

/** Kaynak sözlüğünden adlandırılmış bir nesneyi çözer. */
function lookup(doc, resources, category, name) {
  if (!resources || !name || !name.name) return null;
  const group = doc.resolve(doc.get(resources, category));
  if (!group || !group.get) return null;
  return doc.resolve(group.get(name.name));
}

/** `cs`/`CS` ile seçilen renk uzayının bileşen sayısı ve desen olup olmadığı. */
function namedColorSpace(doc, resources, name) {
  const n = name && name.name;
  if (n === 'Pattern') return { components: 0, pattern: true, tint: false };
  if (n === 'DeviceGray' || n === 'G' || n === 'CalGray') return { components: 1, pattern: false, tint: false };
  if (n === 'DeviceRGB' || n === 'RGB' || n === 'CalRGB') return { components: 3, pattern: false, tint: false };
  if (n === 'DeviceCMYK' || n === 'CMYK') return { components: 4, pattern: false, tint: false };

  const cs = lookup(doc, resources, 'ColorSpace', name);
  const value = Array.isArray(cs) ? cs : null;
  if (value && value.length) {
    const family = doc.resolve(value[0]);
    const fname = family && family.name;
    if (fname === 'Pattern') return { components: 0, pattern: true, tint: false };
    if (fname === 'ICCBased') {
      const stream = doc.resolve(value[1]);
      const count = stream && stream.dict ? Number(doc.get(stream.dict, 'N')) : 3;
      return { components: count === 1 || count === 4 ? count : 3, pattern: false, tint: false };
    }
    if (fname === 'Indexed' || fname === 'I') return { components: 1, pattern: false, tint: false };
    if (fname === 'Separation') return { components: 1, pattern: false, tint: true };
    if (fname === 'DeviceN') {
      const names = doc.resolve(value[1]);
      return { components: Array.isArray(names) ? names.length : 1, pattern: false, tint: true };
    }
  }
  return { components: 3, pattern: false, tint: false };
}

/**
 * `sc`/`scn` bileşenlerinden renk.
 *
 * Bileşen sayısı renk uzayını ele verir: 1 gri, 3 RGB, 4 CMYK. Separation ve
 * DeviceN'de bileşen bir YOĞUNLUKTUR ve gerçek rengi ancak dönüşüm işlevi
 * verir; tek bileşenli durumda "koyuluk" varsayımı yapılır ve bu, kaynaktaki
 * renkten sapabilir.
 */
function colorFromComponents(nums, tint) {
  if (nums.length === 1) {
    const v = Math.max(0, Math.min(1, nums[0]));
    return grayHex(tint ? 1 - v : v);
  }
  if (nums.length === 3) return rgbHex(nums[0], nums[1], nums[2]);
  if (nums.length === 4) return cmykHex(nums[0], nums[1], nums[2], nums[3]);
  return null;
}

/**
 * Bir sayfanın çizimlerini toplar.
 *
 * @param {Object} doc PdfDocument
 * @param {number} pageIndex
 * @param {{ height:number }} geo sayfa geometrisi (y çevirmek için)
 * @returns {{ records: Array, warnings: Array }}
 */
function collectGraphics(doc, pageIndex, geo) {
  const out = [];
  const warnings = [];

  let content;
  try {
    content = doc.getPageContent(pageIndex);
  } catch (err) {
    return { records: [], warnings: [{ code: 'WARN_PAGE_UNREADABLE', page: pageIndex,
      message: `Sayfa ${pageIndex + 1} çizimleri okunamadı: ${err.message}` }] };
  }

  // `getPage` sarmalayıcı döndürür; kaynak sözlüğü onun `dict`indedir.
  // Sarmalayıcıyı doğrudan geçirmek sessizce `undefined` verir ve belgedeki
  // bütün görseller kaybolur.
  const page = doc.getPage(pageIndex);
  const resources = doc.resolve(doc.getPageProperty(page.dict || page, 'Resources'));

  try {
    runContent(doc, content, resources, {
      ctm: pageMatrix(geo), depth: 0, out, warnings, seenForms: new Set()
    });
  } catch (err) {
    warnings.push({
      code: 'WARN_PAGE_GRAPHICS_FAILED', page: pageIndex,
      message: `Sayfa ${pageIndex + 1} çizimleri yarıda kesildi: ${err.message}`
    });
  }

  if (out.length >= MAX_RECORDS) {
    warnings.push({
      code: 'WARN_IMPORT_TRUNCATED', page: pageIndex,
      message: `Sayfa ${pageIndex + 1} çok sayıda çizim içeriyor; ilk ${MAX_RECORDS} tanesi alındı.`
    });
  }

  return { records: out, warnings };
}

module.exports = {
  collectGraphics, runContent, concat, applyM, pageMatrix, placeUnitSquare,
  MAX_FORM_DEPTH, MAX_RECORDS, MAX_SEGMENTS
};
