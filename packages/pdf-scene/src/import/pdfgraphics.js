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

/** Yuvalanmış form XObject derinliği. */
const MAX_FORM_DEPTH = 8;

/** Sayfa başına toplanacak en fazla çizim. */
const MAX_RECORDS = 20_000;

/** Tek yolda en fazla segment. */
const MAX_SEGMENTS = 20_000;

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** m2'yi m1'in üzerine uygular (PDF `cm` semantiği: yeni = m2 × mevcut). */
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

const applyM = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

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

/**
 * PDF kullanıcı uzayı → sahne uzayı matrisi.
 *
 * Üç şeyi BİRLİKTE çözer, çünkü ayrı ayrı uygulamak sıra hatası davetidir:
 *   1. y ekseni: PDF'te yukarı, sahnede aşağı büyür.
 *   2. Kırpma kutusu: sol-alt köşe (0,0) olmayabilir.
 *   3. `/Rotate`: görüntüleyici sayfayı saat yönünde döndürerek gösterir;
 *      içe aktarılan sahne KULLANICININ GÖRDÜĞÜ yerleşim olmalıdır.
 */
function pageMatrix(geo) {
  const x0 = geo.cropBox ? geo.cropBox[0] : 0;
  const y0 = geo.cropBox ? geo.cropBox[1] : 0;
  const w = geo.rawWidth !== undefined ? geo.rawWidth : geo.width;
  const h = geo.rawHeight !== undefined ? geo.rawHeight : geo.height;

  switch (geo.rotate || 0) {
    case 90:  return [0, 1, 1, 0, -y0, -x0];
    case 180: return [-1, 0, 0, 1, w + x0, -y0];
    case 270: return [0, -1, -1, 0, h + y0, w + x0];
    default:  return [1, 0, 0, -1, -x0, h + y0];
  }
}

/**
 * Birim kareyi dönüştüren matristen sahne yerleşimi çıkarır.
 *
 * PDF'te görsel her zaman BİRİM KAREYE çizilir; nereye ve ne kadar
 * büyüklükte düştüğünü matris söyler. Görsel uzayında v=1 görselin ÜST
 * satırıdır — bu yüzden sol üst köşe (0,1) noktasıdır.
 *
 * @returns {{x,y,width,height,rotation,skewed:boolean,mirrored:boolean}}
 */
function placeUnitSquare(m) {
  const corner = applyM(m, 0, 1);                   // görselin SOL ÜST köşesi
  const right = [m[0], m[1]];                       // (1,1) − (0,1)
  const down = [-m[2], -m[3]];                      // (0,0) − (0,1)

  const width = Math.hypot(right[0], right[1]);
  const height = Math.hypot(down[0], down[1]);
  const rotation = (Math.atan2(right[1], right[0]) * 180) / Math.PI;

  // Sahne düğümü DÖNMEMİŞ bir çerçeve + kendi merkezi etrafında dönme
  // olarak tanımlıdır. Dönmüş dikdörtgenin köşesini doğrudan `x/y` yazmak,
  // dönme uygulanınca nesneyi kaydırırdı; bu yüzden merkez üzerinden
  // dönmemiş çerçeve hesaplanır.
  const cx = corner[0] + (right[0] * 0.5) + (down[0] * 0.5);
  const cy = corner[1] + (right[1] * 0.5) + (down[1] * 0.5);

  // Dik olmayan (eğrilmiş) matrisler dikdörtgen çerçeveye sığmaz; sahnede
  // eğrilme yoktur, bu yüzden yalnız bildirilir.
  const dot = right[0] * down[0] + right[1] * down[1];
  const scaleRef = Math.max(1e-6, width * height);
  const cross = right[0] * down[1] - right[1] * down[0];

  return {
    x: cx - width / 2, y: cy - height / 2, width, height,
    rotation: ((rotation % 360) + 360) % 360,
    skewed: Math.abs(dot) / scaleRef > 0.01,
    mirrored: cross < 0
  };
}

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
