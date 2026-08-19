'use strict';
/**
 * @fitfak/pdf-html — HTML + CSS → PDF derleyicisi.
 *
 * Çıktı iki parçadır:
 *   1. PDF Buffer
 *   2. LAYOUT MANIFEST — sayfa ölçüleri, bağlantılar, anahat ve en önemlisi
 *      İMZA YUVALARI. HTML'deki `data-signer` taşıyan elemanların nihai
 *      koordinatları buraya yazılır; imza motoru bunu doğrudan tüketir.
 *      Böylece imza konumu için sihirli sayı yazmaya gerek kalmaz.
 */

const fs = require('fs');
const path = require('path');

const { parseHtml, walk } = require('./src/html/parser');
const { StyleResolver } = require('./src/css/cascade');
const { LayoutEngine } = require('./src/layout/engine');
const { FlowLayout } = require('./src/layout/flow');
const { PdfEmitter, embedFont } = require('./src/pdf/emitter');
const { assignMcids, writeStructTree } = require('./src/pdf/tagged');
const { FontManager } = require('./src/font/manager');
const { toPt, toColor } = require('./src/css/values');

const PAGE_SIZES = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  A6: [297.64, 419.53],
  LETTER: [612, 792],
  LEGAL: [612, 1008],
  TABLOID: [792, 1224]
};

class HtmlRenderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HtmlRenderError';
    this.code = code;
  }
}

/**
 * HTML + CSS'i PDF'e derler.
 *
 * @param {Object} o
 * @param {string} o.html
 * @param {string|string[]} [o.css] Ek stil sayfaları (sırayla uygulanır)
 * @param {Array<{family:string,weight?:number|string,style?:string,src:string}>} o.fonts
 * @param {{size?:string, orientation?:string, margin?:string|Object, width?:number, height?:number}} [o.page]
 * @param {Object} [o.metadata] { title, author, subject, keywords, lang, creator }
 * @param {string} [o.baseDir] Göreli görsel/font yolları için taban dizin
 * @param {boolean} [o.compress=true]
 * @param {boolean} [o.strict=false] true → desteklenmeyen CSS hata verir
 * @returns {{ pdf: Buffer, manifest: Object, warnings: Array }}
 */
function render(o = {}) {
  if (!o.html) throw new HtmlRenderError('ERR_HTML_MISSING', 'render(): html zorunlu');

  const baseDir = o.baseDir || process.cwd();
  const warnings = [];

  /* 1. HTML → DOM ------------------------------------------------- */
  const { root: dom, styles: inlineStyles, title: docTitle } = parseHtml(o.html);

  /* 2. CSS toplama ------------------------------------------------ */
  const cssSources = [];
  const userCss = Array.isArray(o.css) ? o.css : (o.css ? [o.css] : []);
  for (const css of userCss) cssSources.push(css);
  cssSources.push(...inlineStyles);

  const resolver = new StyleResolver(cssSources, { rootFontSize: o.rootFontSize || 12 });

  /* 3. Sayfa ölçüleri --------------------------------------------- */
  const page = resolvePageGeometry(o.page, resolver);

  /* 4. Fontlar ---------------------------------------------------- */
  const fonts = new FontManager();
  for (const face of (o.fonts || [])) {
    fonts.register({ ...face, src: path.isAbsolute(face.src) ? face.src : path.join(baseDir, face.src) });
  }
  // @font-face kuralları
  for (const ff of resolver.fontFaces) {
    const family = stripQuotes(valueOf(ff['font-family']));
    const srcRaw = valueOf(ff.src);
    if (!family || !srcRaw) continue;
    const m = /url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(srcRaw);
    if (!m) continue;
    const src = path.isAbsolute(m[1]) ? m[1] : path.join(baseDir, m[1]);
    if (!fs.existsSync(src)) {
      warnings.push({ type: 'font', message: `@font-face kaynağı bulunamadı: ${src}` });
      continue;
    }
    try {
      fonts.register({ family, weight: valueOf(ff['font-weight']), style: valueOf(ff['font-style']), src });
    } catch (err) {
      warnings.push({ type: 'font', message: err.message });
    }
  }
  if (fonts.isEmpty) {
    throw new HtmlRenderError('ERR_NO_FONT',
      'Hiç font verilmedi. render({ fonts: [{ family, src }] }) ile en az bir TTF gerekli.');
  }

  /* 5. Görsel yükleyici ------------------------------------------- */
  const imageCache = new Map();
  const loadImage = (src) => {
    if (imageCache.has(src)) return imageCache.get(src);
    const file = path.isAbsolute(src) ? src : path.join(baseDir, src);
    if (!fs.existsSync(file)) throw new Error(`bulunamadı: ${file}`);
    const buf = fs.readFileSync(file);
    const lower = file.toLowerCase();
    let parsed;
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
      const JpegParser = require('@fitfak/pdf/src/media/JpegParser');
      const p = new JpegParser(buf);
      parsed = { kind: 'jpeg', width: p.width, height: p.height, buffer: buf, parser: p };
    } else {
      const PngParser = require('@fitfak/pdf/src/media/PngParser');
      const p = new PngParser(buf);
      parsed = { kind: 'png', width: p.width, height: p.height, buffer: buf, parser: p };
    }
    imageCache.set(src, parsed);
    return parsed;
  };

  /* 6. Yerleşim --------------------------------------------------- */
  const engine = new LayoutEngine({ resolver, fonts, page, loadImage, warnings });
  const boxTree = engine.buildBoxes(dom, null);
  if (!boxTree) throw new HtmlRenderError('ERR_EMPTY', 'Belge boş — çizilecek içerik yok.');

  const flow = new FlowLayout(engine);
  const { pages } = flow.run(boxTree);

  /* 7. Uyumluluk profili ------------------------------------------ */
  const conformance = resolveConformance(o.conformance, warnings, o.metadata || {});

  /* 8. PDF üretimi ------------------------------------------------ */
  const result = emitPdf({
    pages, page, fonts, engine, flow, conformance,
    metadata: { title: docTitle, ...(o.metadata || {}) },
    compress: o.compress !== false, loadImage
  });

  /* 9. Manifest --------------------------------------------------- */
  const manifest = buildManifest({ pages, page, engine });

  return { pdf: result, manifest, warnings, conformance };
}

/* ------------------------------------------------------------------ */
/* Uyumluluk profili                                                   */
/* ------------------------------------------------------------------ */

/**
 * `conformance` seçeneğini normalleştirir.
 *
 *   'pdf/a-2b'          → PDF/A-2b
 *   'pdf/ua'            → etiketli PDF + PDF/UA iddiası
 *   'pdf/a-2b+pdf/ua'   → ikisi birden (PDF/A-2a benzeri erişilebilir arşiv)
 *   { pdfA:'2b', pdfUA:true, tagged:true }
 *
 * PDF/UA iddia edildiğinde etiketleme ZORUNLU açılır: etiketsiz bir belgede
 * `pdfuaid:part 1` yazmak yanlış beyandır.
 */
function resolveConformance(value, warnings, metadata) {
  if (!value) return null;

  let pdfA = null;
  let pdfUA = false;

  if (typeof value === 'string') {
    const text = value.toLowerCase();
    const m = /pdf\/a-?(\d)([ab])?/.exec(text);
    if (m) pdfA = `${m[1]}${m[2] || 'b'}`;
    if (/pdf\/ua/.test(text)) pdfUA = true;
    if (!pdfA && !pdfUA) {
      warnings.push({ type: 'conformance', message: `Bilinmeyen uyumluluk profili: ${value}` });
      return null;
    }
  } else if (typeof value === 'object') {
    pdfA = value.pdfA ? String(value.pdfA).replace(/^pdf\/a-?/i, '') : null;
    pdfUA = !!value.pdfUA;
  }

  if (pdfA && !['1b', '2b', '3b', '2a', '3a'].includes(pdfA)) {
    warnings.push({ type: 'conformance', message: `Desteklenmeyen PDF/A düzeyi: ${pdfA}; 2b kullanılıyor` });
    pdfA = '2b';
  }

  // 'a' düzeyi (erişilebilir arşiv) etiketleme gerektirir
  const tagged = pdfUA || (pdfA ? pdfA.endsWith('a') : false);

  if ((pdfUA || tagged) && !metadata.title) {
    warnings.push({
      type: 'conformance',
      message: 'PDF/UA belge başlığı (metadata.title) ister; başlıksız belge doğrulamayı geçmez.'
    });
  }

  return { pdfA, pdfUA, tagged };
}

/* ------------------------------------------------------------------ */
/* Sayfa geometrisi                                                    */
/* ------------------------------------------------------------------ */

function resolvePageGeometry(pageOpt = {}, resolver) {
  const pageCss = resolver ? resolver.pageStyle() : {};

  let size = (pageOpt.size || pageCss.size || 'A4').toString().trim();
  let orientation = (pageOpt.orientation || '').toLowerCase();

  const sizeParts = size.split(/\s+/);
  if (sizeParts.length > 1) {
    const maybeOrient = sizeParts[sizeParts.length - 1].toLowerCase();
    if (maybeOrient === 'landscape' || maybeOrient === 'portrait') {
      orientation = orientation || maybeOrient;
      size = sizeParts.slice(0, -1).join(' ');
    }
  }

  let width = pageOpt.width;
  let height = pageOpt.height;

  if (width == null || height == null) {
    const named = PAGE_SIZES[size.toUpperCase()];
    if (named) { [width, height] = named; }
    else {
      // "210mm 297mm" biçimi
      const dims = size.split(/\s+/).map((s) => toPt(s));
      if (dims.length === 2 && dims[0] && dims[1]) { width = dims[0]; height = dims[1]; }
      else { [width, height] = PAGE_SIZES.A4; }
    }
  }

  if (orientation === 'landscape' && width < height) [width, height] = [height, width];
  if (orientation === 'portrait' && width > height) [width, height] = [height, width];

  // @page bildirimleri parse sırasında açıldığı için `margin` kısayolu yerine
  // dört kenar ayrı ayrı gelir; ikisini de destekliyoruz.
  let marginSource = pageOpt.margin;
  if (marginSource === undefined) {
    if (pageCss['margin-top'] !== undefined) {
      marginSource = {
        top: pageCss['margin-top'], right: pageCss['margin-right'],
        bottom: pageCss['margin-bottom'], left: pageCss['margin-left']
      };
    } else if (pageCss.margin !== undefined) {
      marginSource = pageCss.margin;
    }
  }
  const margin = resolveMargin(marginSource);

  return { width, height, margin };
}

function resolveMargin(value) {
  const def = { top: 56.7, right: 51, bottom: 56.7, left: 51 };  // ~20mm/18mm
  if (value == null) return def;
  if (typeof value === 'object') {
    return {
      top: toPt(value.top) ?? def.top,
      right: toPt(value.right) ?? def.right,
      bottom: toPt(value.bottom) ?? def.bottom,
      left: toPt(value.left) ?? def.left
    };
  }
  const parts = String(value).trim().split(/\s+/).map((v) => toPt(v) ?? 0);
  if (parts.length === 1) return { top: parts[0], right: parts[0], bottom: parts[0], left: parts[0] };
  if (parts.length === 2) return { top: parts[0], right: parts[1], bottom: parts[0], left: parts[1] };
  if (parts.length === 3) return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[1] };
  return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[3] };
}

/* ------------------------------------------------------------------ */
/* PDF çıktısı                                                         */
/* ------------------------------------------------------------------ */

function emitPdf({ pages, page, fonts, engine, metadata, compress, loadImage, flow, conformance }) {
  const emitter = new PdfEmitter({ compress });
  const tagged = !!(conformance && conformance.tagged && flow);
  if (tagged) assignMcids(pages);

  // Kullanılan kod noktalarını yüz başına topla
  const usedByFace = new Map();
  for (const p of pages) {
    for (const item of p.items) {
      if (item.type !== 'text' || !item.face) continue;
      if (!usedByFace.has(item.face.id)) usedByFace.set(item.face.id, { face: item.face, cps: new Set() });
      const entry = usedByFace.get(item.face.id);
      for (const ch of item.text) entry.cps.add(ch.codePointAt(0));
    }
  }

  // Fontları göm
  const fontRefs = new Map();
  for (const [id, { face, cps }] of usedByFace) {
    cps.add(0x20);
    fontRefs.set(id, embedFont(emitter, face, cps));
  }

  // Görselleri göm
  const imageRefs = new Map();
  for (const p of pages) {
    for (const item of p.items) {
      if (item.type !== 'image' || imageRefs.has(item.src)) continue;
      imageRefs.set(item.src, embedImage(emitter, item.image));
    }
  }

  const pagesRootId = emitter.alloc();
  const pageIds = [];
  const marginLeft = page.margin.left;
  const marginTop = page.margin.top;

  // Açıklamalar için /StructParent anahtarları sayfa anahtarlarından SONRA gelir
  const annotParents = new Map();
  let nextAnnotKey = pages.length;

  for (const p of pages) {
    const { content, usedFonts, usedImages } =
      buildContentStream(p, page, marginLeft, marginTop, imageRefs, tagged);
    const contentId = emitter.addStream({}, content);

    const fontDict = [...usedFonts].map((id) => `/${id} ${fontRefs.get(id)} 0 R`).join(' ');
    const xobjDict = [...usedImages].map((ref) => `/Im${ref} ${ref} 0 R`).join(' ');

    const resources = {
      ProcSet: '[/PDF /Text /ImageC /ImageB]',
      Font: fontDict ? `<< ${fontDict} >>` : undefined,
      XObject: xobjDict ? `<< ${xobjDict} >>` : undefined
    };

    // Bağlantı açıklamaları
    const annots = [];
    for (const link of engine.links) {
      if (link.page !== p.index) continue;
      const r = link.rect;
      const x1 = marginLeft + r.x;
      const y1 = page.height - marginTop - r.y - r.height;

      const dict = {
        Type: '/Annot', Subtype: '/Link',
        Rect: `[${fmt(x1)} ${fmt(y1)} ${fmt(x1 + r.width)} ${fmt(y1 + r.height)}]`,
        Border: '[0 0 0]',
        // PDF/A: her açıklama /F içinde Print(4) taşımalı, Hidden olmamalı
        F: 4,
        A: `<< /Type /Action /S /URI /URI ${PdfEmitter.literalString(link.uri)} >>`
      };

      // PDF/UA: bağlantının erişilebilir bir açıklaması olmalı
      if (tagged) {
        dict.Contents = PdfEmitter.textString(link.uri);
        dict.StructParent = nextAnnotKey;
      }

      const annotId = emitter.add({ dict });
      annots.push(`${annotId} 0 R`);

      if (tagged && link.structNode) {
        link.structNode.k.push({ objr: annotId, page: p.index });
        annotParents.set(link.structNode, nextAnnotKey);
      }
      if (tagged) nextAnnotKey++;
    }

    const pageDict = {
      Type: '/Page',
      Parent: `${pagesRootId} 0 R`,
      MediaBox: `[0 0 ${fmt(page.width)} ${fmt(page.height)}]`,
      Resources: PdfEmitter.dictToString(resources),
      Contents: `${contentId} 0 R`,
      Annots: annots.length ? `[${annots.join(' ')}]` : undefined
    };
    if (tagged) pageDict.StructParents = p.index;

    const pageId = emitter.add({ dict: pageDict });
    pageIds.push(pageId);
  }

  emitter.set(pagesRootId, { dict: {
    Type: '/Pages',
    Kids: `[${pageIds.map((id) => `${id} 0 R`).join(' ')}]`,
    Count: pageIds.length
  } });

  // Anahat (bookmark)
  let outlinesId;
  if (engine.outline.length) {
    outlinesId = buildOutline(emitter, engine.outline, pageIds, page);
  }

  // Metadata
  const infoDict = {
    Producer: PdfEmitter.textString('fitfak-belge / @fitfak/pdf-html'),
    Creator: PdfEmitter.textString(metadata.creator || 'fitfak-belge'),
    CreationDate: PdfEmitter.pdfDate(),
    ModDate: PdfEmitter.pdfDate()
  };
  if (metadata.title) infoDict.Title = PdfEmitter.textString(metadata.title);
  if (metadata.author) infoDict.Author = PdfEmitter.textString(metadata.author);
  if (metadata.subject) infoDict.Subject = PdfEmitter.textString(metadata.subject);
  if (metadata.keywords) {
    infoDict.Keywords = PdfEmitter.textString(
      Array.isArray(metadata.keywords) ? metadata.keywords.join(', ') : metadata.keywords);
  }
  const infoId = emitter.add({ dict: infoDict });

  // XMP UTF-8'dir. Buffer olarak veriyoruz: emitter dizgileri latin1 yazar ve
  // Türkçe karakterler orada bozulur (dc:title ile /Info tutarsız kalırdı).
  const xmpId = emitter.addStream(
    { Type: '/Metadata', Subtype: '/XML' },
    Buffer.from(buildXmp(metadata, conformance), 'utf8'),
    { compress: false }              // PDF/A: XMP akışı sıkıştırılmamalı
  );

  const catalogDict = {
    Type: '/Catalog',
    Pages: `${pagesRootId} 0 R`,
    Metadata: `${xmpId} 0 R`,
    Lang: PdfEmitter.literalString(metadata.lang || 'tr-TR'),
    ViewerPreferences: '<< /DisplayDocTitle true >>'
  };
  if (outlinesId) {
    catalogDict.Outlines = `${outlinesId} 0 R`;
    catalogDict.PageMode = '/UseOutlines';
  }

  // Etiketli PDF: yapı ağacı + "işaretlenmiştir" bayrağı
  if (tagged) {
    const structTreeRootId = writeStructTree(
      emitter, flow.struct.prune(), pageIds, annotParents);
    catalogDict.StructTreeRoot = `${structTreeRootId} 0 R`;
    catalogDict.MarkInfo = '<< /Marked true >>';
  }

  // PDF/A: cihazdan bağımsız renk için çıktı amacı (output intent) zorunlu
  if (conformance && conformance.pdfA) {
    catalogDict.OutputIntents = `[${writeOutputIntent(emitter)}]`;
  }

  const catalogId = emitter.add({ dict: catalogDict });

  return emitter.build({ rootObj: catalogId, infoObj: infoId });
}

/** sRGB çıktı amacı — ICC profili gömülür (PDF/A zorunluluğu). */
function writeOutputIntent(emitter) {
  const { sRGBProfile } = require('@fitfak/conformance');
  const icc = sRGBProfile();
  const iccId = emitter.addStream({ N: 3 }, icc);

  const intentId = emitter.add({ dict: {
    Type: '/OutputIntent',
    S: '/GTS_PDFA1',
    OutputConditionIdentifier: PdfEmitter.literalString('sRGB IEC61966-2.1'),
    Info: PdfEmitter.literalString('sRGB IEC61966-2.1'),
    RegistryName: PdfEmitter.literalString('http://www.color.org'),
    DestOutputProfile: `${iccId} 0 R`
  } });
  return `${intentId} 0 R`;
}

/** Bir sayfanın içerik akışını üretir. */
function buildContentStream(pageData, page, marginLeft, marginTop, imageRefs, tagged = false) {
  const parts = [];
  const usedFonts = new Set();
  const usedImages = new Set();

  // Yerleşim koordinatları (sol-üst orijin) → PDF (sol-alt orijin)
  const toPdfY = (y) => page.height - marginTop - y;

  let currentFill = null;
  const setFill = (color) => {
    const key = color.slice(0, 3).join(',');
    if (currentFill === key) return;
    currentFill = key;
    parts.push(`${fmt(color[0] / 255)} ${fmt(color[1] / 255)} ${fmt(color[2] / 255)} rg`);
  };

  // İşaretli içerik: etiketli PDF'te her çizim ya bir yapı elemanına aittir
  // (`/Rol <</MCID n>> BDC`) ya da yapaydır (`/Artifact BMC`). İkisi de değilse
  // PDF/UA doğrulayıcısı "etiketlenmemiş içerik" der.
  const openMark = (item) => {
    if (!tagged) return;
    if (item.mcid === undefined) { parts.push('/Artifact BMC'); return; }
    const role = item.struct && item.struct.role ? item.struct.role : 'P';
    parts.push(`/${role} << /MCID ${item.mcid} >> BDC`);
  };
  const closeMark = () => { if (tagged) parts.push('EMC'); };

  for (const item of pageData.items) {
    const alpha = item.opacity !== undefined && item.opacity !== 1 ? item.opacity : 1;

    if (item.type === 'rect') {
      const x = marginLeft + item.x;
      const y = toPdfY(item.y + item.height);
      openMark(item);
      parts.push('q');
      setFill(item.fill);
      currentFill = null;   // q/Q renk durumunu geri alır
      parts.push(`${fmt(item.fill[0] / 255)} ${fmt(item.fill[1] / 255)} ${fmt(item.fill[2] / 255)} rg`);
      parts.push(`${fmt(x)} ${fmt(y)} ${fmt(item.width)} ${fmt(item.height)} re f`);
      parts.push('Q');
      closeMark();
      continue;
    }

    if (item.type === 'image') {
      const ref = imageRefs.get(item.src);
      if (ref === undefined) continue;
      const x = marginLeft + item.x;
      const y = toPdfY(item.y + item.height);
      usedImages.add(ref);
      openMark(item);
      parts.push('q');
      parts.push(`${fmt(item.width)} 0 0 ${fmt(item.height)} ${fmt(x)} ${fmt(y)} cm`);
      parts.push(`/Im${ref} Do`);
      parts.push('Q');
      closeMark();
      continue;
    }

    if (item.type === 'text') {
      const x = marginLeft + item.x;
      const y = toPdfY(item.y);
      usedFonts.add(item.face.id);

      const hex = encodeGlyphs(item.text, item.face.parser);
      openMark(item);
      parts.push('BT');
      parts.push(`${fmt(item.color[0] / 255)} ${fmt(item.color[1] / 255)} ${fmt(item.color[2] / 255)} rg`);
      currentFill = null;
      parts.push(`/${item.face.id} ${fmt(item.fontSize)} Tf`);
      if (item.letterSpacing) parts.push(`${fmt(item.letterSpacing)} Tc`);
      parts.push(`1 0 0 1 ${fmt(x)} ${fmt(y)} Tm`);
      parts.push(`<${hex}> Tj`);
      if (item.letterSpacing) parts.push('0 Tc');
      parts.push('ET');
      closeMark();
      continue;
    }
  }

  return { content: parts.join('\n'), usedFonts, usedImages };
}

function encodeGlyphs(text, parser) {
  let hex = '';
  for (const ch of text) {
    const gid = parser.getGlyphId(ch.codePointAt(0));
    hex += gid.toString(16).padStart(4, '0').toUpperCase();
  }
  return hex;
}

/**
 * Görseli PDF XObject olarak gömer.
 *
 * PngParser'ın renk ayrıştırma mantığını yeniden yazmıyoruz: kendi
 * `embedToDocument()` yolunu, bizim emitter'ımıza uyan minik bir Document
 * adaptörüyle kullanıyoruz. Böylece RGBA/palet/gri tonlama dönüşümleri ve
 * tRNS saydamlığı tek yerde kalır.
 */
function embedImage(emitter, image) {
  if (image.kind === 'jpeg') {
    return emitter.addStream({
      Type: '/XObject', Subtype: '/Image',
      Width: image.width, Height: image.height,
      ColorSpace: '/DeviceRGB', BitsPerComponent: 8,
      Filter: '/DCTDecode'
    }, image.buffer, { compress: false });
  }

  const adapter = {
    _lastId: null,
    addStream(data, dict = {}) {
      // PngParser veriyi KENDİSİ deflate edip dict'e /FlateDecode yazıyor;
      // emitter'ın tekrar sıkıştırması bozuk akış üretir.
      const alreadyCompressed = String(dict.Filter || '').includes('FlateDecode');
      const id = emitter.addStream(dict, data, { compress: !alreadyCompressed });
      this._lastId = id;
      return id;
    },
    addDictionary(dict) {
      const id = emitter.add({ dict });
      this._lastId = id;
      return id;
    }
  };

  try {
    const id = image.parser.embedToDocument(adapter);
    if (typeof id === 'number') return id;
    if (adapter._lastId != null) return adapter._lastId;
  } catch (err) {
    // Aşağıdaki yedek yola düşülür
  }

  // Yedek: gri bir yer tutucu — sessizce siyah kutu bırakmaktan iyidir
  const placeholder = Buffer.alloc(image.width * image.height * 3, 0xEE);
  return emitter.addStream({
    Type: '/XObject', Subtype: '/Image',
    Width: image.width, Height: image.height,
    ColorSpace: '/DeviceRGB', BitsPerComponent: 8
  }, placeholder);
}

function buildOutline(emitter, outline, pageIds, page) {
  const rootId = emitter.alloc();
  const items = outline.map(() => emitter.alloc());

  for (let i = 0; i < outline.length; i++) {
    const entry = outline[i];
    const pageRef = pageIds[Math.min(entry.page, pageIds.length - 1)];
    const y = page.height - page.margin.top - entry._contentY;
    emitter.set(items[i], { dict: {
      Title: PdfEmitter.textString(entry.title),
      Parent: `${rootId} 0 R`,
      Prev: i > 0 ? `${items[i - 1]} 0 R` : undefined,
      Next: i < items.length - 1 ? `${items[i + 1]} 0 R` : undefined,
      Dest: `[${pageRef} 0 R /XYZ 0 ${fmt(y)} null]`
    } });
  }

  emitter.set(rootId, { dict: {
    Type: '/Outlines',
    First: items.length ? `${items[0]} 0 R` : undefined,
    Last: items.length ? `${items[items.length - 1]} 0 R` : undefined,
    Count: items.length
  } });
  return rootId;
}

function buildXmp(metadata, conformance = null) {
  const esc = (s) => String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

  // Uyumluluk kimlikleri: doğrulayıcılar belgenin hangi profili İDDİA ettiğini
  // buradan okur. Yanlış iddia etmek, iddia etmemekten kötüdür.
  let claims = '';
  if (conformance && conformance.pdfA) {
    // '2b' / '2-b' / 'pdf/a-2b' → part=2, level=B
    const m = /(\d)\s*-?\s*([ab])?/i.exec(String(conformance.pdfA));
    const part = m ? m[1] : '2';
    const level = (m && m[2] ? m[2] : 'b').toUpperCase();
    claims += `\n   <pdfaid:part>${esc(part)}</pdfaid:part>` +
              `\n   <pdfaid:conformance>${esc(level)}</pdfaid:conformance>`;
  }
  if (conformance && conformance.pdfUA) {
    claims += `\n   <pdfuaid:part>1</pdfuaid:part>`;
  }

  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"
    xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(metadata.title)}</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>${esc(metadata.author)}</rdf:li></rdf:Seq></dc:creator>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${esc(metadata.subject)}</rdf:li></rdf:Alt></dc:description>
   <dc:language><rdf:Bag><rdf:li>${esc(metadata.lang || 'tr-TR')}</rdf:li></rdf:Bag></dc:language>
   <xmp:CreatorTool>fitfak-belge / @fitfak/pdf-html</xmp:CreatorTool>
   <xmp:CreateDate>${new Date().toISOString()}</xmp:CreateDate>
   <pdf:Producer>fitfak-belge</pdf:Producer>${claims}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/* ------------------------------------------------------------------ */
/* Manifest                                                            */
/* ------------------------------------------------------------------ */

function buildManifest({ pages, page, engine }) {
  const toPdf = (rect) => ({
    x: +(page.margin.left + rect.x).toFixed(2),
    // PDF kullanıcı uzayı: sol-alt orijin
    y: +(page.height - page.margin.top - rect.y - rect.height).toFixed(2),
    width: +rect.width.toFixed(2),
    height: +rect.height.toFixed(2)
  });

  return {
    pages: pages.map((p) => ({
      index: p.index,
      width: +page.width.toFixed(2),
      height: +page.height.toFixed(2),
      rotate: 0,
      margin: {
        top: +page.margin.top.toFixed(2), right: +page.margin.right.toFixed(2),
        bottom: +page.margin.bottom.toFixed(2), left: +page.margin.left.toFixed(2)
      }
    })),
    signatureSlots: engine.slots.map((s) => ({
      id: s.id,
      role: s.role,
      page: s.page,
      rect: toPdf(s._contentRect),
      origin: 'bottom-left'
    })),
    links: engine.links.map((l) => ({ page: l.page, uri: l.uri, rect: toPdf(l.rect) })),
    outline: engine.outline.map((h) => ({
      level: h.level, title: h.title, page: h.page,
      y: +(page.height - page.margin.top - h._contentY).toFixed(2)
    })),
    pageCount: pages.length
  };
}

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                         */
/* ------------------------------------------------------------------ */

function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  return (Math.round(n * 1000) / 1000).toString();
}

function valueOf(entry) {
  return entry && typeof entry === 'object' ? entry.value : entry;
}

function stripQuotes(s) {
  return s ? String(s).trim().replace(/^["']|["']$/g, '') : s;
}

/** PDF'i doğrudan dosyaya yazar. */
function renderToFile(options, outPath) {
  const result = render(options);
  fs.writeFileSync(outPath, result.pdf);
  return result;
}

module.exports = {
  render,
  renderToFile,
  HtmlRenderError,
  PAGE_SIZES,
  resolvePageGeometry,
  // alt modüller (ileri kullanım ve testler)
  parseHtml,
  StyleResolver,
  FontManager,
  PdfEmitter
};
