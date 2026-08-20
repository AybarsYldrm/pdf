'use strict';
/**
 * Sahne → PDF derleyicisi.
 *
 * DOĞRUDAN YOL: sahnedeki koordinat, PDF'teki koordinattır.
 *
 * Sahneyi önce HTML'e çevirip yerleşim motorundan geçirmek kolay olurdu ama
 * yanlış olurdu: o zaman kullanıcının tuvalde çizdiği yer ile PDF'teki yer,
 * arada duran akış yerleşiminin insafına kalırdı. Serbest yerleşimli bir
 * editörün tek sözü "gördüğün yere koyarım"dır; araya bir yerleşim motoru
 * girerse bu söz tutulamaz.
 *
 * PDF yazarı (@fitfak/pdf-html'in PdfEmitter'ı) ve font gömme YENİDEN
 * YAZILMAZ; bu iki taş yerinde durur, üzerine sahnenin kendi içerik akışı
 * kurulur. İmzalama da değişmez: bu derleyici imzasız bir PDF üretir,
 * PAdES motoru onu her zamanki gibi imzalar.
 */

const zlib = require('zlib');
const { PdfEmitter, embedFont } = require('@fitfak/pdf-html/src/pdf/emitter');
const PngParser = require('@fitfak/pdf/src/media/PngParser');
const JpegParser = require('@fitfak/pdf/src/media/JpegParser');
const { FontManager } = require('@fitfak/pdf-html/src/font/manager');
const { readFontInfo } = require('@fitfak/pdf/src/fonts/FontInfo');

const { validateScene, SceneError, parseColor } = require('../validate');
const geometry = require('../geometry');
const { textItems } = require('./text');
const { round } = require('../units');

const fmt = (n) => (Math.round(n * 1000) / 1000).toString();
const rgb = (hex) => {
  const c = parseColor(hex) || [0, 0, 0];
  return c.map((n) => n / 255);
};

/* ------------------------------------------------------------------ */
/* Çizim listesi                                                       */
/* ------------------------------------------------------------------ */

/**
 * Sahne düğümlerini düz bir çizim listesine çevirir.
 *
 * Gruplar burada ÇÖZÜLÜR: PDF'te grup diye bir şey yoktur, yalnız çizim
 * sırası vardır. Grubun anlamı editörde kalır.
 */
function collectItems(scene, page, ctx) {
  const items = [];
  const links = [];
  const slots = [];
  const warnings = [];

  const walk = (nodes, ancestry) => {
    for (const node of nodes) {
      if (node.hidden) continue;
      const chain = [...ancestry, node];
      const abs = geometry.absoluteFrame(chain);

      if (node.type === 'group') {
        walk(node.children || [], chain);
        continue;
      }
      emitNode(node, abs, ctx, { items, links, slots, warnings });
    }
  };

  walk(page.nodes, []);
  return { items, links, slots, warnings };
}

function emitNode(node, abs, ctx, out) {
  const common = { opacity: node.opacity, rotation: abs.rotation, cx: abs.x + abs.width / 2, cy: abs.y + abs.height / 2 };

  switch (node.type) {
    case 'rect':
    case 'ellipse': {
      if (node.fill) {
        out.items.push({
          type: node.type === 'ellipse' ? 'ellipse' : 'rect',
          x: abs.x, y: abs.y, width: abs.width, height: abs.height,
          fill: node.fill, radius: node.radius || 0, ...common
        });
      }
      if (node.stroke && node.strokeWidth > 0) {
        out.items.push({
          type: node.type === 'ellipse' ? 'ellipse' : 'rect',
          x: abs.x, y: abs.y, width: abs.width, height: abs.height,
          stroke: node.stroke, strokeWidth: node.strokeWidth,
          radius: node.radius || 0, ...common
        });
      }
      return;
    }

    case 'line': {
      out.items.push({
        type: 'line',
        x1: abs.x, y1: abs.y, x2: abs.x + abs.width, y2: abs.y + abs.height,
        stroke: node.stroke, strokeWidth: node.strokeWidth, dash: node.dash, ...common
      });
      return;
    }

    case 'text': {
      const res = textItems(node, { x: abs.x, y: abs.y }, ctx);
      for (const item of res.items) out.items.push({ ...item, ...common, opacity: node.opacity });
      for (const link of res.links) out.links.push(link);
      if (res.overflow) {
        out.warnings.push({
          code: 'WARN_TEXT_OVERFLOW', nodeId: node.id,
          message: `Metin kutuya sığmıyor: ${node.id}`
        });
      }
      return;
    }

    case 'image': {
      const bytes = ctx.assets.bytes(node.assetId);
      const meta = ctx.assets.get(node.assetId);
      if (!bytes || !meta) {
        out.warnings.push({
          code: 'WARN_ASSET_MISSING', nodeId: node.id,
          message: `Görsel varlığı bulunamadı: ${node.assetId}`
        });
        return;
      }
      // `contain` en-boy oranını korur; kutuya sığdırıp ORTALAR.
      let { x, y, width, height } = abs;
      if (node.fit !== 'fill' && meta.width && meta.height) {
        const ratio = meta.width / meta.height;
        const boxRatio = abs.width / abs.height;
        const cover = node.fit === 'cover';
        if ((ratio > boxRatio) !== cover) { height = abs.width / ratio; }
        else { width = abs.height * ratio; }
        x = abs.x + (abs.width - width) / 2;
        y = abs.y + (abs.height - height) / 2;
      }
      out.items.push({
        type: 'image', assetId: node.assetId,
        x: round(x), y: round(y), width: round(width), height: round(height),
        ...common
      });
      return;
    }

    case 'qr': {
      const png = ctx.renderQr(node);
      if (!png) {
        out.warnings.push({
          code: 'WARN_QR_FAILED', nodeId: node.id,
          message: `Karekod üretilemedi: ${node.id}`
        });
        return;
      }
      const size = Math.min(abs.width, abs.height);
      out.items.push({
        type: 'image', assetId: png,
        x: round(abs.x + (abs.width - size) / 2),
        y: round(abs.y + (abs.height - size) / 2),
        width: round(size), height: round(size), ...common
      });
      return;
    }

    case 'signature': {
      // İmza yuvası ÇİZİLMEZ, BİLDİRİLİR. PAdES motoru bu koordinatlara
      // görünür imza yerleştirir. Yuvanın yerine sahte bir kutu çizmek,
      // imzalanmamış belgeyi imzalıymış gibi gösterirdi.
      out.slots.push({
        id: node.id,
        fieldName: node.fieldName || node.id,
        signer: node.signer || '',
        role: node.role || '',
        label: node.label || '',
        rect: { x: abs.x, y: abs.y, width: abs.width, height: abs.height }
      });
      if (node.showFrame) {
        out.items.push({
          type: 'rect', x: abs.x, y: abs.y, width: abs.width, height: abs.height,
          stroke: '#c8ccd4', strokeWidth: 0.5, dash: 'dashed', radius: 2, ...common
        });
      }
      return;
    }

    default:
      out.warnings.push({
        code: 'WARN_UNKNOWN_NODE', nodeId: node.id,
        message: `Çizilemeyen düğüm tipi: ${node.type}`
      });
  }
}

/* ------------------------------------------------------------------ */
/* İçerik akışı                                                        */
/* ------------------------------------------------------------------ */

/**
 * Yuvarlatılmış dikdörtgen — Bézier yaklaşıklığı (κ = 0.5523).
 *
 * Köşeler saat yönünün TERSİNE dolaşılır (PDF'in sol-alt başlangıcında
 * bu "pozitif" yöndür): sağ-alt → sağ-üst → sol-üst → sol-alt.
 */
function roundedRectPath(x, y, w, h, r) {
  const k = 0.55228475 * r;
  const x0 = x, y0 = y, x1 = x + w, y1 = y + h;
  return [
    `${fmt(x0 + r)} ${fmt(y0)} m`,
    `${fmt(x1 - r)} ${fmt(y0)} l`,
    `${fmt(x1 - r + k)} ${fmt(y0)} ${fmt(x1)} ${fmt(y0 + r - k)} ${fmt(x1)} ${fmt(y0 + r)} c`,
    `${fmt(x1)} ${fmt(y1 - r)} l`,
    `${fmt(x1)} ${fmt(y1 - r + k)} ${fmt(x1 - r + k)} ${fmt(y1)} ${fmt(x1 - r)} ${fmt(y1)} c`,
    `${fmt(x0 + r)} ${fmt(y1)} l`,
    `${fmt(x0 + r - k)} ${fmt(y1)} ${fmt(x0)} ${fmt(y1 - r + k)} ${fmt(x0)} ${fmt(y1 - r)} c`,
    `${fmt(x0)} ${fmt(y0 + r)} l`,
    `${fmt(x0)} ${fmt(y0 + r - k)} ${fmt(x0 + r - k)} ${fmt(y0)} ${fmt(x0 + r)} ${fmt(y0)} c`,
    'h'
  ].join('\n');
}

/** Elips — dört Bézier yayı. */
function ellipsePath(x, y, w, h) {
  const rx = w / 2, ry = h / 2;
  const cx = x + rx, cy = y + ry;
  const kx = 0.55228475 * rx, ky = 0.55228475 * ry;
  return [
    `${fmt(cx - rx)} ${fmt(cy)} m`,
    `${fmt(cx - rx)} ${fmt(cy + ky)} ${fmt(cx - kx)} ${fmt(cy + ry)} ${fmt(cx)} ${fmt(cy + ry)} c`,
    `${fmt(cx + kx)} ${fmt(cy + ry)} ${fmt(cx + rx)} ${fmt(cy + ky)} ${fmt(cx + rx)} ${fmt(cy)} c`,
    `${fmt(cx + rx)} ${fmt(cy - ky)} ${fmt(cx + kx)} ${fmt(cy - ry)} ${fmt(cx)} ${fmt(cy - ry)} c`,
    `${fmt(cx - kx)} ${fmt(cy - ry)} ${fmt(cx - rx)} ${fmt(cy - ky)} ${fmt(cx - rx)} ${fmt(cy)} c`,
    'h'
  ].join('\n');
}

function encodeGlyphs(text, parser) {
  let hex = '';
  for (const ch of text) {
    hex += parser.getGlyphId(ch.codePointAt(0)).toString(16).padStart(4, '0').toUpperCase();
  }
  return hex;
}

/**
 * Sayfa içerik akışı.
 *
 * Sahne koordinatları sol-ÜST başlangıçlıdır, PDF sol-ALT. Çeviri TEK yerde
 * yapılır (`flipY`); her çizim kodunun kendi çevirisini yapması, er geç
 * birinin ters çevirmesi demektir.
 */
function buildContent(items, pageHeight, refs) {
  const parts = [];
  const usedFonts = new Set();
  const usedImages = new Set();
  const flipY = (y) => pageHeight - y;

  for (const item of items) {
    parts.push('q');

    if (item.opacity !== undefined && item.opacity !== 1) {
      parts.push(`/GS${Math.round(item.opacity * 100)} gs`);
    }

    // Dönme: nesnenin KENDİ merkezi etrafında. PDF'te y ters olduğu için
    // açının işareti de terslenir; yoksa ekranda sağa dönen nesne kâğıtta
    // sola dönerdi.
    if (item.rotation) {
      const cx = item.cx, cy = flipY(item.cy);
      const r = (-item.rotation * Math.PI) / 180;
      const cos = Math.cos(r), sin = Math.sin(r);
      parts.push(`1 0 0 1 ${fmt(cx)} ${fmt(cy)} cm`);
      parts.push(`${fmt(cos)} ${fmt(sin)} ${fmt(-sin)} ${fmt(cos)} 0 0 cm`);
      parts.push(`1 0 0 1 ${fmt(-cx)} ${fmt(-cy)} cm`);
    }

    switch (item.type) {
      case 'rect': {
        const y = flipY(item.y + item.height);
        if (item.radius > 0) parts.push(roundedRectPath(item.x, y, item.width, item.height, Math.min(item.radius, item.width / 2, item.height / 2)));
        else parts.push(`${fmt(item.x)} ${fmt(y)} ${fmt(item.width)} ${fmt(item.height)} re`);
        parts.push(paintOp(parts, item));
        break;
      }
      case 'ellipse': {
        const y = flipY(item.y + item.height);
        parts.push(ellipsePath(item.x, y, item.width, item.height));
        parts.push(paintOp(parts, item));
        break;
      }
      case 'line': {
        const [r, g, b] = rgb(item.stroke);
        parts.push(`${fmt(r)} ${fmt(g)} ${fmt(b)} RG`);
        parts.push(`${fmt(item.strokeWidth)} w`);
        if (item.dash === 'dashed') parts.push(`[${fmt(item.strokeWidth * 3)} ${fmt(item.strokeWidth * 2)}] 0 d`);
        else if (item.dash === 'dotted') parts.push(`[0 ${fmt(item.strokeWidth * 2)}] 0 d 1 J`);
        parts.push(`${fmt(item.x1)} ${fmt(flipY(item.y1))} m ${fmt(item.x2)} ${fmt(flipY(item.y2))} l S`);
        break;
      }
      case 'image': {
        const ref = refs.images.get(item.assetId);
        if (ref === undefined) break;
        usedImages.add(ref);
        parts.push(`${fmt(item.width)} 0 0 ${fmt(item.height)} ` +
                   `${fmt(item.x)} ${fmt(flipY(item.y + item.height))} cm`);
        parts.push(`/Im${ref} Do`);
        break;
      }
      case 'text': {
        usedFonts.add(item.face.id);
        const [r, g, b] = rgb(item.color);
        parts.push('BT');
        parts.push(`${fmt(r)} ${fmt(g)} ${fmt(b)} rg`);
        parts.push(`/${item.face.id} ${fmt(item.fontSize)} Tf`);
        if (item.letterSpacing) parts.push(`${fmt(item.letterSpacing)} Tc`);
        parts.push(`1 0 0 1 ${fmt(item.x)} ${fmt(flipY(item.y))} Tm`);
        parts.push(`<${encodeGlyphs(item.text, item.face.parser)}> Tj`);
        parts.push('ET');
        break;
      }
    }

    parts.push('Q');
  }

  return { content: parts.join('\n'), usedFonts, usedImages };
}

/** Dolgu/kontur işlecini seçer ve gerekli renk komutlarını yazar. */
function paintOp(parts, item) {
  if (item.fill && item.stroke) {
    const f = rgb(item.fill), s = rgb(item.stroke);
    parts.push(`${fmt(f[0])} ${fmt(f[1])} ${fmt(f[2])} rg`);
    parts.push(`${fmt(s[0])} ${fmt(s[1])} ${fmt(s[2])} RG`);
    parts.push(`${fmt(item.strokeWidth || 1)} w`);
    return 'B';
  }
  if (item.stroke) {
    const s = rgb(item.stroke);
    parts.push(`${fmt(s[0])} ${fmt(s[1])} ${fmt(s[2])} RG`);
    parts.push(`${fmt(item.strokeWidth || 1)} w`);
    if (item.dash === 'dashed') parts.push(`[${fmt((item.strokeWidth || 1) * 4)} ${fmt((item.strokeWidth || 1) * 3)}] 0 d`);
    return 'S';
  }
  const f = rgb(item.fill || '#000000');
  parts.push(`${fmt(f[0])} ${fmt(f[1])} ${fmt(f[2])} rg`);
  return 'f';
}

/* ------------------------------------------------------------------ */
/* Görsel gömme                                                        */
/* ------------------------------------------------------------------ */

function embedImage(emitter, bytes, mime) {
  if (mime === 'image/jpeg') {
    const parser = new JpegParser(bytes);
    return emitter.addStream({
      Type: '/XObject', Subtype: '/Image',
      Width: parser.width, Height: parser.height,
      ColorSpace: '/DeviceRGB', BitsPerComponent: 8, Filter: '/DCTDecode'
    }, bytes, { compress: false });
  }

  // PngParser kendi renk/saydamlık mantığını taşır (palet, gri tonlama,
  // tRNS). Onu yeniden yazmak yerine, kendi `embedToDocument()` yoluna
  // emitter'a uyan minik bir Document adaptörü veriyoruz.
  const adapter = {
    _lastId: null,
    addStream(data, dict = {}) {
      // PngParser veriyi KENDİSİ deflate edip dict'e /FlateDecode yazar;
      // ikinci kez sıkıştırmak bozuk akış üretir.
      const already = String(dict.Filter || '').includes('FlateDecode');
      this._lastId = emitter.addStream(dict, data, { compress: !already });
      return this._lastId;
    },
    addDictionary(dict) {
      this._lastId = emitter.add({ dict });
      return this._lastId;
    }
  };
  const id = new PngParser(bytes).embedToDocument(adapter);
  return typeof id === 'number' ? id : adapter._lastId;
}

/* ------------------------------------------------------------------ */
/* Genel giriş                                                         */
/* ------------------------------------------------------------------ */

/**
 * Sahneyi PDF'e derler.
 *
 * @param {Object} sceneInput Scene örneği ya da düz sahne nesnesi
 * @param {Object} o
 * @param {Array}  o.fonts    [{ family, weight, style, src }] — src yol ya da Buffer
 * @param {Object} [o.assets] AssetManager (Scene verilirse ondan alınır)
 * @param {boolean} [o.compress=true]
 * @returns {{ pdf: Buffer, manifest: Object, warnings: Array }}
 */
function compileToPdf(sceneInput, o = {}) {
  const isScene = sceneInput && typeof sceneInput.toJSON === 'function';
  const raw = isScene ? sceneInput.toJSON() : sceneInput;
  const assets = o.assets || (isScene ? sceneInput.assets : null);

  const { scene, issues } = validateScene(raw);
  if (!scene) {
    throw new SceneError('ERR_SCENE_INVALID',
      `Sahne derlenemedi: ${issues.length} sorun (ilki: ${issues[0].path} ${issues[0].message})`,
      issues);
  }
  if (!assets) throw new SceneError('ERR_NO_ASSETS', 'Varlık yöneticisi gerekli');

  /* --- fontlar ---------------------------------------------------
   * Üç kaynak: çağıranın verdiği yüzler, sahnenin VARLIK havuzundaki
   * fontlar (kullanıcının yüklediği) ve — hiçbiri yoksa — hata.
   *
   * Varlık fontlarının aile adı DOSYA ADINDAN değil, fontun kendi `name`
   * tablosundan okunur: dosya adı belgeden gelir ve yalan söyleyebilir. */
  const warnings = [];
  const fonts = new FontManager();
  const knownFamilies = new Set();

  for (const face of o.fonts || []) {
    fonts.register(face);
    knownFamilies.add(String(face.family).toLowerCase());
  }

  for (const asset of assets.manifest()) {
    if (asset.kind !== 'font') continue;
    const bytes = assets.bytes(asset.id);
    if (!bytes) continue;
    try {
      const info = readFontInfo(bytes);
      fonts.register({
        family: info.family, weight: info.weight, style: info.style,
        src: bytes, id: asset.id
      });
      knownFamilies.add(info.family.toLowerCase());
    } catch (err) {
      warnings.push({
        code: err.code || 'ERR_FONT_INVALID', assetId: asset.id,
        message: `Gömülü font okunamadı (${asset.name || asset.id}): ${err.message}`
      });
    }
  }

  if (fonts.isEmpty) {
    throw new SceneError('ERR_NO_FONT',
      'En az bir font gerekli: compileToPdf(scene, { fonts: [{ family, src }] }) ' +
      'ya da sahnenin varlık havuzunda bir font');
  }

  const fallbackFamily = (o.fonts && o.fonts[0] && o.fonts[0].family) || 'Ubuntu';
  const reportedFallbacks = new Set();

  /**
   * Yüz seçimi. İstenen aile YOKSA sessizce başkası kullanılmaz; uyarı
   * verilir. Sessiz ikame, belgenin ekranda ve kâğıtta farklı görünmesinin
   * en sık sebebidir ve fark edilmesi en zor olanıdır.
   */
  const resolveFace = (family, bold, italic) => {
    const wanted = String(family || fallbackFamily);
    if (!knownFamilies.has(wanted.toLowerCase()) && !reportedFallbacks.has(wanted)) {
      reportedFallbacks.add(wanted);
      warnings.push({
        code: 'WARN_FONT_FALLBACK', family: wanted,
        message: `"${wanted}" ailesi yüklü değil; yerine kayıtlı bir font kullanıldı. ` +
                 `Satır genişlikleri tasarlandığı gibi çıkmayabilir.`
      });
    }
    return fonts.resolve([wanted, fallbackFamily], bold ? 700 : 400,
      italic ? 'italic' : 'normal');
  };

  /* --- karekodlar: varlık havuzuna PNG olarak eklenir --- */
  const qrCache = new Map();
  const renderQr = (node) => {
    const key = `${node.payload}|${node.ecc}|${node.quiet}|${node.dark}|${node.light}`;
    if (qrCache.has(key)) return qrCache.get(key);
    let id = null;
    try {
      const { generatePngBuffer } = require('@fitfak/qr');
      const png = generatePngBuffer(node.payload, { size: 512, margin: node.quiet });
      if (png) id = assets.add(png, { name: 'qr' }).id;
    } catch { /* karekod üretilemedi: uyarı çağıran tarafta */ }
    qrCache.set(key, id);
    return id;
  };

  const ctx = { fonts, resolveFace, assets, renderQr };

  /* --- çizim listeleri --- */
  const pages = [];
  const manifestPages = [];

  for (const [index, page] of scene.pages.entries()) {
    const collected = collectItems(scene, page, ctx);
    const items = [];

    if (page.background) {
      items.push({
        type: 'rect', x: 0, y: 0,
        width: scene.page.width, height: scene.page.height,
        fill: page.background, opacity: 1, rotation: 0
      });
    }
    items.push(...collected.items);

    pages.push({ index, items, links: collected.links, slots: collected.slots });
    warnings.push(...collected.warnings.map((w) => ({ ...w, page: index })));

    // Yuvalar iki koordinat sisteminde birden bildirilir:
    //   `rect`      PDF (sol-ALT başlangıç) — PAdES `fromManifestSlot` bunu bekler
    //   `sceneRect` sahne (sol-ÜST başlangıç) — editöre geri dönüş için
    // Tek bir sistem seçip diğerini çağırana hesaplatmak, o hesabın er geç
    // bir yerde ters yapılması demektir.
    manifestPages.push({
      index, id: page.id, name: page.name,
      width: scene.page.width, height: scene.page.height,
      slots: collected.slots.map((s) => ({
        ...s,
        page: index,
        origin: 'bottom-left',
        rect: {
          x: s.rect.x,
          y: round(scene.page.height - s.rect.y - s.rect.height),
          width: s.rect.width,
          height: s.rect.height
        },
        sceneRect: s.rect
      }))
    });
  }

  /* --- yaz --- */
  const emitter = new PdfEmitter({ compress: o.compress !== false });

  // Kullanılan kod noktaları — alt küme (subset) için
  const usedByFace = new Map();
  for (const p of pages) {
    for (const item of p.items) {
      if (item.type !== 'text' || !item.face) continue;
      if (!usedByFace.has(item.face.id)) usedByFace.set(item.face.id, { face: item.face, cps: new Set() });
      const e = usedByFace.get(item.face.id);
      for (const ch of item.text) e.cps.add(ch.codePointAt(0));
    }
  }
  const fontRefs = new Map();
  for (const [id, { face, cps }] of usedByFace) {
    cps.add(0x20);
    fontRefs.set(id, embedFont(emitter, face, cps));
  }

  const imageRefs = new Map();
  for (const p of pages) {
    for (const item of p.items) {
      if (item.type !== 'image' || imageRefs.has(item.assetId)) continue;
      const bytes = assets.bytes(item.assetId);
      const meta = assets.get(item.assetId);
      if (!bytes || !meta) continue;
      imageRefs.set(item.assetId, embedImage(emitter, bytes, meta.mime));
    }
  }

  // Saydamlık durumları — yalnız gerçekten kullanılanlar
  const alphas = new Set();
  for (const p of pages) {
    for (const item of p.items) {
      if (item.opacity !== undefined && item.opacity !== 1) {
        alphas.add(Math.round(item.opacity * 100));
      }
    }
  }
  const gsRefs = new Map();
  for (const a of alphas) {
    gsRefs.set(a, emitter.add({ dict: { Type: '/ExtGState', ca: a / 100, CA: a / 100 } }));
  }

  const pagesRootId = emitter.alloc();
  const pageIds = [];

  for (const p of pages) {
    const { content, usedFonts, usedImages } =
      buildContent(p.items, scene.page.height, { images: imageRefs });
    const contentId = emitter.addStream({}, content);

    const fontDict = [...usedFonts].map((id) => `/${id} ${fontRefs.get(id)} 0 R`).join(' ');
    const xobjDict = [...usedImages].map((ref) => `/Im${ref} ${ref} 0 R`).join(' ');
    const gsDict = [...gsRefs].map(([a, ref]) => `/GS${a} ${ref} 0 R`).join(' ');

    const annots = [];
    for (const link of p.links) {
      const y1 = scene.page.height - link.rect.y - link.rect.height;
      annots.push(`${emitter.add({ dict: {
        Type: '/Annot', Subtype: '/Link',
        Rect: `[${fmt(link.rect.x)} ${fmt(y1)} ` +
              `${fmt(link.rect.x + link.rect.width)} ${fmt(y1 + link.rect.height)}]`,
        Border: '[0 0 0]', F: 4,
        A: `<< /Type /Action /S /URI /URI ${PdfEmitter.literalString(link.uri)} >>`
      } })} 0 R`);
    }

    pageIds.push(emitter.add({ dict: {
      Type: '/Page',
      Parent: `${pagesRootId} 0 R`,
      MediaBox: `[0 0 ${fmt(scene.page.width)} ${fmt(scene.page.height)}]`,
      Resources: PdfEmitter.dictToString({
        ProcSet: '[/PDF /Text /ImageC /ImageB]',
        Font: fontDict ? `<< ${fontDict} >>` : undefined,
        XObject: xobjDict ? `<< ${xobjDict} >>` : undefined,
        ExtGState: gsDict ? `<< ${gsDict} >>` : undefined
      }),
      Contents: `${contentId} 0 R`,
      Annots: annots.length ? `[${annots.join(' ')}]` : undefined
    } }));
  }

  emitter.set(pagesRootId, { dict: {
    Type: '/Pages',
    Kids: `[${pageIds.map((id) => `${id} 0 R`).join(' ')}]`,
    Count: pageIds.length
  } });

  const info = {
    Producer: PdfEmitter.textString('fitfak-belge / @fitfak/pdf-scene'),
    Creator: PdfEmitter.textString(o.creator || 'fitfak-belge'),
    CreationDate: PdfEmitter.pdfDate(),
    ModDate: PdfEmitter.pdfDate()
  };
  if (scene.meta.title) info.Title = PdfEmitter.textString(scene.meta.title);
  if (scene.meta.author) info.Author = PdfEmitter.textString(scene.meta.author);
  if (scene.meta.subject) info.Subject = PdfEmitter.textString(scene.meta.subject);
  if (scene.meta.keywords.length) {
    info.Keywords = PdfEmitter.textString(scene.meta.keywords.join(', '));
  }
  const infoId = emitter.add({ dict: info });

  const catalogId = emitter.add({ dict: {
    Type: '/Catalog',
    Pages: `${pagesRootId} 0 R`,
    Lang: PdfEmitter.literalString(scene.meta.lang || 'tr-TR'),
    ViewerPreferences: '<< /DisplayDocTitle true >>'
  } });

  return {
    pdf: emitter.build({ rootObj: catalogId, infoObj: infoId }),
    manifest: {
      pages: manifestPages,
      slots: manifestPages.flatMap((p) => p.slots),
      // `signatureSlots` @fitfak/pdf-html manifestiyle AYNI addır: imzalama
      // tarafı sahneden mi HTML'den mi geldiğini bilmek zorunda kalmasın.
      signatureSlots: manifestPages.flatMap((p) => p.slots),
      pageCount: manifestPages.length,
      page: { width: scene.page.width, height: scene.page.height, margin: scene.page.margin }
    },
    warnings
  };
}

module.exports = { compileToPdf, collectItems, buildContent, ellipsePath };
