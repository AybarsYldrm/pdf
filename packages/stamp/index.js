'use strict';
/**
 * @fitfak/stamp — Slot tabanlı görsel damga motoru.
 *
 * TASARIM KURALI: Code39 yapısına DOKUNULMAZ.
 * Code39 tablosu ve kodlayıcısı `@fitfak/pades/src/signature/stamp.js`'ten
 * doğrudan içe aktarılır — kopyalanmaz. Böylece iki uygulama ayrışamaz.
 * `templates.classic`, eski `generateStamp()` ile piksel-piksel aynı çıktıyı
 * verir; bu bir testle güvence altına alınmıştır.
 *
 * QR, Code39'un YERİNE değil YANINA gelir: yeni bir slot tipidir.
 */

const fs = require('fs');
const path = require('path');

const legacy = require('@fitfak/pades/src/signature/stamp');
const { QR } = require('@fitfak/qr');

const {
  CODE39_MAP, encodeCode39Data, makeBarcodeCore,
  parseTTF, drawTextTTF, measureTextTTF, loadPngRGBA, blitRGBA, downsample,
  makePRNG, makeFastSeed, applyGrainTransparentTop,
  makeIHDR, makeIDAT, makeIEND, normalizeUpperTR
} = legacy;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

class StampError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StampError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Tuval                                                                */
/* ------------------------------------------------------------------ */

/** Şeffaf RGBA tuval. */
function createCanvas(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

function fillRect(canvas, x, y, w, h, color) {
  const [r, g, b, a] = color;
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(canvas.width, Math.round(x + w));
  const y1 = Math.min(canvas.height, Math.round(y + h));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const i = (py * canvas.width + px) * 4;
      canvas.data[i] = r; canvas.data[i + 1] = g; canvas.data[i + 2] = b; canvas.data[i + 3] = a;
    }
  }
}

/** Kaynak RGBA tamponu hedef tuvale kopyalar. */
function copyInto(dst, src, srcW, srcH, dx, dy) {
  for (let y = 0; y < srcH; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < srcW; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const si = (y * srcW + x) * 4;
      const di = (ty * dst.width + tx) * 4;
      const a = src[si + 3];
      if (a === 0) continue;
      if (a === 255) {
        src.copy(dst.data, di, si, si + 4);
      } else {
        const alpha = a / 255, inv = 1 - alpha;
        dst.data[di]     = Math.round(src[si]     * alpha + dst.data[di]     * inv);
        dst.data[di + 1] = Math.round(src[si + 1] * alpha + dst.data[di + 1] * inv);
        dst.data[di + 2] = Math.round(src[si + 2] * alpha + dst.data[di + 2] * inv);
        dst.data[di + 3] = Math.max(dst.data[di + 3], a);
      }
    }
  }
}

function encodePng(canvas) {
  return Buffer.concat([
    PNG_SIGNATURE,
    makeIHDR(canvas.width, canvas.height),
    makeIDAT(canvas.data, canvas.width, canvas.height),
    makeIEND()
  ]);
}

/* ------------------------------------------------------------------ */
/* Slot çizicileri                                                      */
/* ------------------------------------------------------------------ */

const renderers = {
  /** Düz renk dikdörtgeni */
  band(canvas, slot, ctx) {
    const [x, y, w, h] = slot.rect;
    fillRect(canvas, x, y, w, h, slot.color ? [...slot.color, 255] : [35, 35, 35, 255]);
  },

  /** Çizgi */
  rule(canvas, slot, ctx) {
    const [x, y, w, h] = slot.rect;
    fillRect(canvas, x, y, w, Math.max(1, slot.thickness || h || 1),
      slot.color ? [...slot.color, 255] : [200, 200, 200, 255]);
  },

  /** Kâğıt dokusu (eski davranışla birebir aynı PRNG) */
  grain(canvas, slot, ctx) {
    const [x, y, w, h] = slot.rect;
    const sub = createCanvas(w, h);
    const prng = makePRNG(ctx.seed === undefined ? makeFastSeed() : (ctx.seed >>> 0));
    applyGrainTransparentTop(sub.data, w, h, prng);
    copyInto(canvas, sub.data, w, h, x, y);
  },

  /** TTF ile raster metin */
  text(canvas, slot, ctx) {
    const [x, y, w, h] = slot.rect;
    const value = interpolate(slot.value, ctx.vars);
    if (!value) return;

    const font = ctx.font;
    const color = slot.color ? [...slot.color, 255] : [35, 35, 35, 255];
    const transform = slot.transform === 'upper-tr' ? normalizeUpperTR : (s) => s;
    const text = transform(value);

    const sub = createCanvas(w, h);
    const fontPx = slot.fontSize || Math.floor(h * 0.32);
    const lines = slot.wrap === false ? [text] : layoutLines(text, font, fontPx, w * 0.88);
    const lineGap = fontPx * (slot.lineGap !== undefined ? slot.lineGap : 0.45);
    const blockH = lines.length * fontPx + (lines.length - 1) * lineGap;

    let blockY0;
    if (slot.verticalAlign === 'top') blockY0 = 0;
    else if (slot.verticalAlign === 'bottom') blockY0 = h - blockH;
    else blockY0 = Math.floor(h / 2 - blockH / 2);

    for (let i = 0; i < lines.length; i++) {
      const lineW = measureTextTTF(lines[i], font, fontPx);
      let lx;
      if (slot.align === 'left') lx = 0;
      else if (slot.align === 'right') lx = w - lineW;
      else lx = Math.floor((w - lineW) / 2);
      const baseline = Math.floor(blockY0 + i * (fontPx + lineGap) + fontPx);
      drawTextTTF(sub.data, w, lines[i], lx, baseline, font, fontPx, color);
    }
    copyInto(canvas, sub.data, w, h, x, y);
  },

  /** PNG görsel */
  image(canvas, slot, ctx) {
    const [x, y, w, h] = slot.rect;
    const src = interpolate(slot.src, ctx.vars);
    if (!src) return;

    const img = loadImageRGBA(src, ctx.baseDir);
    const scale = Math.min(w / img.width, h / img.height);
    const drawW = Math.floor(img.width * scale);
    const drawH = Math.floor(img.height * scale);
    const ox = x + Math.floor((w - drawW) / 2);
    const oy = y + Math.floor((h - drawH) / 2);

    blitRGBA(canvas.data, canvas.width, img.data, img.width, img.height, ox, oy, scale,
      slot.colorMultiply || [1, 1, 1, 1]);
  },

  /**
   * Code39 barkodu — DEĞİŞTİRİLMEZ.
   * Kodlama, `@fitfak/pades/src/signature/stamp.js`'teki tablodan gelir.
   */
  code39(canvas, slot, ctx) {
    const [x, y, w, h] = slot.rect;
    const value = interpolate(slot.value, ctx.vars) || makeBarcodeCore();
    const core = sanitizeCode39(value, slot.checkDigit === true);
    const bits = encodeCode39Data(core);

    const sub = createCanvas(w, h);
    fillRect(sub, 0, 0, w, h, [255, 255, 255, 255]);

    const quietX = slot.quietZone !== undefined ? slot.quietZone : 6;
    const usableW = w - quietX * 2;
    let moduleW = Math.floor(usableW / bits.length);
    if (moduleW < 2) moduleW = 2;
    const barcodeW = moduleW * bits.length;
    const startX = Math.floor((w - barcodeW) / 2);

    for (let i = 0; i < bits.length; i++) {
      if (bits[i] !== '1') continue;
      const bx = startX + i * moduleW;
      for (let dx = 0; dx < moduleW; dx++) {
        const px = bx + dx;
        if (px < 0 || px >= w) continue;
        for (let py = 0; py < h; py++) {
          const idx = (py * w + px) * 4;
          sub.data[idx] = 0; sub.data[idx + 1] = 0; sub.data[idx + 2] = 0; sub.data[idx + 3] = 255;
        }
      }
    }
    copyInto(canvas, sub.data, w, h, x, y);
    ctx.rendered.code39 = core;
  },

  /**
   * QR kodu — YENİ.
   * `@fitfak/qr`'ın matrisi doğrudan tuvale çizilir; PNG üretip geri çözmek
   * gibi bir tur atılmaz, böylece modüller tam piksel hizasında kalır.
   */
  qr(canvas, slot, ctx) {
    const [x, y, w, h] = slot.rect;
    const value = interpolate(slot.value, ctx.vars);
    if (!value) return;

    const model = QR.build(String(value), slot.version || 0, slot.ecLevel || 'M');
    const quiet = slot.quietZone !== undefined ? slot.quietZone : 4;
    const totalModules = model.size + quiet * 2;

    const side = Math.min(w, h);
    const cell = Math.max(1, Math.floor(side / totalModules));
    const drawSide = cell * totalModules;
    const ox = x + Math.floor((w - drawSide) / 2);
    const oy = y + Math.floor((h - drawSide) / 2);

    const bg = slot.background === 'transparent' ? null : (slot.background || [255, 255, 255]);
    const fg = slot.color || [0, 0, 0];

    if (bg) fillRect(canvas, ox, oy, drawSide, drawSide, [...bg, 255]);

    for (let my = 0; my < model.size; my++) {
      for (let mx = 0; mx < model.size; mx++) {
        if (!model.matrix[my][mx].val) continue;
        fillRect(canvas,
          ox + (mx + quiet) * cell,
          oy + (my + quiet) * cell,
          cell, cell, [...fg, 255]);
      }
    }
    ctx.rendered.qr = { value: String(value), version: model.version, size: model.size };
  },

  /**
   * Alt tuval grubu — içindeki slotları `supersample` katı büyüklükte çizip
   * küçülterek kenar yumuşatma (anti-aliasing) sağlar.
   *
   * Eski `generateStamp` sol paneli 4× süperörnekleme ile çiziyordu; metin
   * kenarlarının yumuşaklığı buradan gelir. Yeni şablonlar aynı kaliteyi bu
   * slotla elde eder.
   */
  group(canvas, slot, ctx) {
    const [x, y, w, h] = slot.rect;
    const ss = slot.supersample || 1;

    const sub = createCanvas(w * ss, h * ss);
    if (slot.background && slot.background !== 'transparent') {
      fillRect(sub, 0, 0, w * ss, h * ss, [...slot.background, 255]);
    }

    for (const child of slot.slots) {
      const renderer = renderers[child.type];
      if (!renderer) throw new StampError('ERR_STAMP_SLOT', `Bilinmeyen slot tipi: ${child.type}`);
      if (child.when && !ctx.vars[child.when]) continue;
      renderer(sub, scaleSlot(child, ss), ctx);
    }

    const flat = ss === 1 ? sub.data : downsample(sub.data, w * ss, h * ss, w, h, ss);
    copyInto(canvas, flat, w, h, x, y);
  },

  /**
   * Kullanıcının kendi imza görseli (el yazısı).
   * Otomatik kırpma + beyaz→şeffaf dönüşümü uygulanır.
   */
  handwritten(canvas, slot, ctx) {
    const [x, y, w, h] = slot.rect;
    const src = interpolate(slot.src, ctx.vars);
    if (!src) return;

    let img = loadImageRGBA(src, ctx.baseDir);
    if (slot.whiteToAlpha !== false) img = whiteToAlpha(img, slot.threshold || 235);
    if (slot.autoCrop !== false) img = autoCrop(img);
    if (slot.inkColor) img = tint(img, slot.inkColor);

    const scale = Math.min(w / img.width, h / img.height);
    const drawW = Math.floor(img.width * scale);
    const drawH = Math.floor(img.height * scale);
    const ox = x + Math.floor((w - drawW) / 2);
    const oy = y + Math.floor((h - drawH) / 2);

    blitRGBA(canvas.data, canvas.width, img.data, img.width, img.height, ox, oy, scale, [1, 1, 1, 1]);
  }
};

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                          */
/* ------------------------------------------------------------------ */

/** Bir slotun ölçülerini `ss` katına büyütür (group süperörneklemesi için). */
function scaleSlot(slot, ss) {
  if (ss === 1) return slot;
  const out = { ...slot, rect: slot.rect.map((v) => Math.round(v * ss)) };
  if (typeof slot.fontSize === 'number') out.fontSize = slot.fontSize * ss;
  if (typeof slot.thickness === 'number') out.thickness = slot.thickness * ss;
  if (typeof slot.quietZone === 'number') out.quietZone = slot.quietZone * ss;
  if (Array.isArray(slot.slots)) out.slots = slot.slots.map((c) => scaleSlot(c, ss));
  return out;
}

/** `{degisken}` yer tutucularını doldurur. */
function interpolate(template, vars) {
  if (template == null) return null;
  if (typeof template !== 'string') return template;
  return template.replace(/\{(\w+)\}/g, (m, key) => {
    const v = vars[key];
    if (v == null) return '';
    if (v instanceof Date) return v.toLocaleString('tr-TR', { hour12: false });
    return String(v);
  });
}

/** Metni verilen genişliğe sığdıracak şekilde satırlara böler. */
function layoutLines(text, font, fontPx, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];

  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? current + ' ' + word : word;
    if (measureTextTTF(candidate, font, fontPx) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Code39 alfabesine uymayan karakterleri temizler; istenirse mod-43 ekler. */
function sanitizeCode39(value, addCheckDigit) {
  const upper = String(value).toUpperCase();
  let core = '';
  for (const ch of upper) {
    if (ch === '*') continue;                 // başlangıç/bitiş işareti gövdede olamaz
    core += CODE39_MAP[ch] ? ch : '-';
  }
  if (addCheckDigit) core += code39CheckDigit(core);
  return core;
}

const CODE39_CHECK_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';

/** Code39 mod-43 kontrol karakteri (varsayılan olarak KAPALI). */
function code39CheckDigit(core) {
  let sum = 0;
  for (const ch of core) {
    const idx = CODE39_CHECK_ALPHABET.indexOf(ch);
    if (idx < 0) throw new StampError('ERR_CODE39_CHAR', `Code39 alfabesinde olmayan karakter: ${ch}`);
    sum += idx;
  }
  return CODE39_CHECK_ALPHABET[sum % 43];
}

/** Göreli yolu taban dizine göre çözer. */
function resolvePath(p, baseDir) {
  if (!p) return p;
  if (Buffer.isBuffer(p)) return p;
  return path.isAbsolute(p) ? p : path.join(baseDir || process.cwd(), p);
}

/** Buffer olarak verilen fontu geçici dosyaya yazar (eski API yol bekliyor). */
function writeTempFont(buf) {
  const os = require('os');
  const tmp = path.join(os.tmpdir(), `fitfak-stamp-font-${process.pid}-${Date.now()}.ttf`);
  fs.writeFileSync(tmp, buf);
  return tmp;
}

const imageCache = new Map();

/** PNG'i RGBA olarak yükler (yol ya da Buffer). */
function loadImageRGBA(src, baseDir) {
  if (Buffer.isBuffer(src)) return decodePngBuffer(src);

  const resolved = path.isAbsolute(src) ? src : path.join(baseDir || process.cwd(), src);
  if (imageCache.has(resolved)) return imageCache.get(resolved);
  if (!fs.existsSync(resolved)) {
    throw new StampError('ERR_STAMP_IMAGE_NOT_FOUND', `Görsel bulunamadı: ${resolved}`);
  }
  const img = loadPngRGBA(resolved);
  imageCache.set(resolved, img);
  return img;
}

/** Buffer'daki PNG'i geçici dosyaya yazmadan çözmek için küçük sarmalayıcı. */
function decodePngBuffer(buf) {
  const os = require('os');
  const tmp = path.join(os.tmpdir(), `fitfak-stamp-${process.pid}-${Date.now()}.png`);
  fs.writeFileSync(tmp, buf);
  try {
    return loadPngRGBA(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* zaten silinmiş */ }
  }
}

/** Beyaza yakın pikselleri şeffaflaştırır (taranmış imzalar için). */
function whiteToAlpha(img, threshold) {
  const out = Buffer.from(img.data);
  for (let i = 0; i < out.length; i += 4) {
    const r = out[i], g = out[i + 1], b = out[i + 2];
    if (r >= threshold && g >= threshold && b >= threshold) {
      out[i + 3] = 0;
    }
  }
  return { width: img.width, height: img.height, data: out };
}

/** Şeffaf kenar boşluklarını kırpar. */
function autoCrop(img) {
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return img; // tamamen şeffaf

  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    img.data.copy(out, y * w * 4, ((minY + y) * img.width + minX) * 4,
      ((minY + y) * img.width + minX + w) * 4);
  }
  return { width: w, height: h, data: out };
}

/** Görselin opak piksellerini tek renge boyar (mürekkep rengi). */
function tint(img, color) {
  const out = Buffer.from(img.data);
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) continue;
    out[i] = color[0]; out[i + 1] = color[1]; out[i + 2] = color[2];
  }
  return { width: img.width, height: img.height, data: out };
}

/* ------------------------------------------------------------------ */
/* Şablonlar                                                            */
/* ------------------------------------------------------------------ */

const templates = require('./src/templates');

/* ------------------------------------------------------------------ */
/* Ana giriş                                                            */
/* ------------------------------------------------------------------ */

/**
 * Damga PNG'i üretir.
 *
 * @param {Object} o
 * @param {Object|string} o.template `templates` içinden bir ad ya da şablon nesnesi
 * @param {Object} o.vars `{signerName}` gibi yer tutucuların değerleri
 * @param {string} o.font TTF dosya yolu
 * @param {string} [o.baseDir] Göreli görsel yolları için taban dizin
 * @param {number} [o.seed] Doku PRNG tohumu (testlerde tekrarlanabilirlik için)
 * @param {string} [o.outPath] Verilirse PNG diske de yazılır
 * @returns {{ png: Buffer, width: number, height: number, rendered: Object }}
 */
function renderStamp(o = {}) {
  const tpl = typeof o.template === 'string' ? templates[o.template] : o.template;
  if (!tpl) {
    throw new StampError('ERR_STAMP_TEMPLATE',
      `Bilinmeyen şablon: ${o.template}. Mevcut: ${Object.keys(templates).join(', ')}`);
  }
  if (!o.font) throw new StampError('ERR_STAMP_FONT', 'renderStamp: font (TTF yolu) zorunlu');

  // `classic` şablonu, eski `generateStamp()` çıktısıyla BİREBİR aynı kalmalıdır.
  // Bunu yeniden uygulayarak değil, doğrudan ESKİ KODU ÇAĞIRARAK garanti ediyoruz:
  // tek satır bile ayrışamaz. Yeni slot motoru diğer şablonlar içindir.
  if (tpl.legacy) {
    const vars = o.vars || {};
    const png = legacy.generateStamp({
      fontPath: Buffer.isBuffer(o.font) ? writeTempFont(o.font) : o.font,
      pngLogoPath: resolvePath(interpolate('{logo}', vars) || vars.logo, o.baseDir),
      personName: vars.signerName || '',
      outPath: o.outPath || null,
      finalW: (o.size && o.size.width) || tpl.size.width,
      finalH: (o.size && o.size.height) || tpl.size.height,
      leftW: tpl.leftW,
      rightW: tpl.rightW,
      SS: tpl.supersample || 4,
      seed: o.seed,
      barcodeCore: vars.docNo ? sanitizeCode39(vars.docNo, false) : undefined
    });
    return {
      png,
      width: (o.size && o.size.width) || tpl.size.width,
      height: (o.size && o.size.height) || tpl.size.height,
      rendered: { code39: vars.docNo ? sanitizeCode39(vars.docNo, false) : '(otomatik)' }
    };
  }

  const fontBuf = Buffer.isBuffer(o.font) ? o.font : fs.readFileSync(o.font);
  const font = parseTTF(fontBuf);

  const width = (o.size && o.size.width) || tpl.size.width;
  const height = (o.size && o.size.height) || tpl.size.height;
  const canvas = createCanvas(width, height);

  if (tpl.background && tpl.background !== 'transparent') {
    fillRect(canvas, 0, 0, width, height, [...tpl.background, 255]);
  }

  const ctx = {
    vars: o.vars || {},
    font,
    baseDir: o.baseDir || process.cwd(),
    seed: o.seed,
    rendered: {}
  };

  for (const slot of tpl.slots) {
    const renderer = renderers[slot.type];
    if (!renderer) {
      throw new StampError('ERR_STAMP_SLOT', `Bilinmeyen slot tipi: ${slot.type}`);
    }
    if (slot.when && !ctx.vars[slot.when]) continue; // koşullu slot
    renderer(canvas, slot, ctx);
  }

  const png = encodePng(canvas);
  if (o.outPath) fs.writeFileSync(o.outPath, png);

  return { png, width, height, rendered: ctx.rendered };
}

module.exports = {
  StampError,
  renderStamp,
  templates,
  // düşük seviye — özel şablonlar ve testler için
  createCanvas,
  fillRect,
  copyInto,
  encodePng,
  renderers,
  interpolate,
  sanitizeCode39,
  code39CheckDigit,
  CODE39_MAP
};
