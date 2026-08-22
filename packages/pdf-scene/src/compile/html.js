'use strict';
/**
 * Sahne → HTML derleyicisi (ÖNİZLEME).
 *
 * BU ÇIKTI GERÇEĞİN KAYNAĞI DEĞİLDİR. PDF, sahneden DOĞRUDAN üretilir
 * (compile/pdf.js). Buradaki HTML yalnız tarayıcıda göstermek içindir:
 * editörün tuvali, e-postaya gömülen bir önizleme, hızlı bir bakış.
 *
 * İki şey bu yüzden önemli:
 *   1. Yerleşim MUTLAK konumludur — akış yoktur. Böylece tarayıcının
 *      yerleşim kararları sahnenin koordinatlarını değiştiremez.
 *   2. Hiçbir güvenilmez değer HTML'e DİZGE BİRLEŞTİRİLEREK girmez.
 *      Önce bir eleman ağacı kurulur, sonra TEK bir serileştirici onu
 *      kaçışlayarak yazar. Metnin içinde `<script>` varsa metin olarak
 *      görünür; başka türlüsü mümkün değildir.
 */

const { validateScene, SceneError } = require('../validate');
const geometry = require('../geometry');
const { toRuns } = require('./text');

/* ------------------------------------------------------------------ */
/* Kaçışlama ve serileştirme                                           */
/* ------------------------------------------------------------------ */

const TEXT_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const ATTR_ESCAPES = { ...TEXT_ESCAPES, '"': '&quot;', "'": '&#39;' };

const escapeText = (s) => String(s).replace(/[&<>]/g, (c) => TEXT_ESCAPES[c]);
const escapeAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ATTR_ESCAPES[c]);

/** İçeriği olmayan elemanlar. */
const VOID_TAGS = new Set(['img', 'br', 'hr', 'meta', 'link']);

/**
 * Eleman düğümü kurar.
 *
 * `children` içinde dizge varsa METİNDİR ve kaçışlanır. Ham HTML enjekte
 * etmenin bir yolu YOKTUR — böyle bir kapı açmamak, sonra onu kapatmaya
 * çalışmaktan iyidir.
 */
const el = (tag, attrs = {}, children = []) => ({ tag, attrs, children });

/**
 * Stil sayfası düğümü — İÇERİĞİ KAÇIŞLANMADAN yazılır.
 *
 * Tek istisna budur ve kapsamı kasten dardır: yalnız bu modülün kendi
 * SABİT `BASE_CSS`i buradan geçer. `styleSheet()` çağrısına kullanıcı
 * verisi verilmemelidir; genel bir "ham HTML" kapısı açmamak için ayrı
 * bir düğüm tipi olarak duruyor, `el()`in bir seçeneği olarak değil.
 */
const styleSheet = (css) => ({ tag: 'style', css: String(css) });

function serialize(node, indent = 0) {
  if (node == null || node === false) return '';
  if (typeof node === 'string') return escapeText(node);
  if (node.css !== undefined) {
    const pad = '  '.repeat(indent);
    return `${pad}<style>\n${node.css}\n${pad}</style>`;
  }

  const pad = '  '.repeat(indent);
  const attrs = Object.entries(node.attrs || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');

  if (VOID_TAGS.has(node.tag)) return `${pad}<${node.tag}${attrs}>`;

  const kids = (node.children || []).filter((c) => c != null && c !== false);
  if (!kids.length) return `${pad}<${node.tag}${attrs}></${node.tag}>`;

  // Yalnız metin çocuğu varsa tek satırda kalsın: çıktı okunabilir olsun
  if (kids.length === 1 && typeof kids[0] === 'string') {
    return `${pad}<${node.tag}${attrs}>${escapeText(kids[0])}</${node.tag}>`;
  }
  const inner = kids.map((c) => serialize(c, indent + 1)).join('\n');
  return `${pad}<${node.tag}${attrs}>\n${inner}\n${pad}</${node.tag}>`;
}

/* ------------------------------------------------------------------ */
/* Stil                                                                */
/* ------------------------------------------------------------------ */

/**
 * Stil bildirimi kurar.
 *
 * Değerler ya SAYIDIR (birim burada eklenir) ya da doğrulayıcıdan geçmiş
 * `#rrggbb` renktir. Serbest metin CSS'e girmez; giren tek metin font
 * ailesidir ve o da süzülüp tırnaklanır (`cssFontFamily`).
 */
function style(decls) {
  return Object.entries(decls)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}:${typeof v === 'number' ? `${round3(v)}pt` : v}`)
    .join(';');
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Font ailesini CSS'e güvenli biçimde koyar.
 *
 * `font-family: "…"` içine kaçışlanmamış tırnak koymak, bildirimi kapatıp
 * yenisini açmaya izin verir. Harf, rakam, boşluk, tire ve alt çizgi
 * dışındaki her şey atılır.
 */
function cssFontFamily(family) {
  const clean = String(family || 'Ubuntu').replace(/[^A-Za-z0-9 _-]/g, '').trim();
  return clean ? `"${clean}", sans-serif` : 'sans-serif';
}

/* ------------------------------------------------------------------ */
/* Düğüm → eleman                                                      */
/* ------------------------------------------------------------------ */

/**
 * Yol komutlarını SVG `d` dizgesine çevirir.
 *
 * Sahne ve SVG'nin koordinat yönü AYNIDIR (y aşağı), bu yüzden çevirme
 * gerekmez — PDF tarafındaki `flipY` yalnız orada gereklidir.
 */
function svgPathData(d) {
  const out = [];
  for (const cmd of d) {
    switch (cmd[0]) {
      case 'M': out.push(`M${round3(cmd[1])} ${round3(cmd[2])}`); break;
      case 'L': out.push(`L${round3(cmd[1])} ${round3(cmd[2])}`); break;
      case 'C':
        out.push(`C${round3(cmd[1])} ${round3(cmd[2])} ${round3(cmd[3])} ${round3(cmd[4])} ` +
                 `${round3(cmd[5])} ${round3(cmd[6])}`);
        break;
      case 'Z': out.push('Z'); break;
    }
  }
  return out.join(' ');
}

/** Kesik/noktalı çizgi deseni (SVG). */
function dashArray(node) {
  const w = node.strokeWidth || 1;
  if (node.dash === 'dashed') return `${round3(w * 4)} ${round3(w * 3)}`;
  if (node.dash === 'dotted') return `0 ${round3(w * 2)}`;
  return undefined;
}

function nodeElement(node, ctx) {
  if (node.hidden) return null;

  const f = node.frame;
  const base = {
    position: 'absolute',
    left: f.x, top: f.y, width: f.width, height: f.height,
    opacity: node.opacity !== 1 ? String(node.opacity) : undefined,
    transform: node.rotation ? `rotate(${round3(node.rotation)}deg)` : undefined
  };

  switch (node.type) {
    case 'group':
      return el('div', {
        class: 'sn-group', 'data-id': node.id,
        style: style(base)
      }, (node.children || []).map((c) => nodeElement(c, ctx)).filter(Boolean));

    case 'rect':
      return el('div', {
        class: 'sn-rect', 'data-id': node.id,
        style: style({
          ...base,
          background: node.fill,
          border: node.stroke && node.strokeWidth
            ? `${round3(node.strokeWidth)}pt solid ${node.stroke}` : undefined,
          'border-radius': node.radius ? node.radius : undefined,
          'box-sizing': 'border-box'
        })
      });

    case 'ellipse':
      return el('div', {
        class: 'sn-ellipse', 'data-id': node.id,
        style: style({
          ...base,
          background: node.fill,
          border: node.stroke && node.strokeWidth
            ? `${round3(node.strokeWidth)}pt solid ${node.stroke}` : undefined,
          'border-radius': '50%',
          'box-sizing': 'border-box'
        })
      });

    case 'line': {
      // Çizgi çerçevenin KÖŞEGENİdir; CSS'te dönmüş ince bir kutu olur.
      const len = Math.hypot(f.width, f.height);
      const angle = (Math.atan2(f.height, f.width) * 180) / Math.PI;
      const border = node.dash === 'dashed' ? 'dashed' : node.dash === 'dotted' ? 'dotted' : 'solid';
      return el('div', {
        class: 'sn-line', 'data-id': node.id,
        style: style({
          position: 'absolute', left: f.x, top: f.y, width: len, height: 0,
          'border-top': `${round3(node.strokeWidth)}pt ${border} ${node.stroke}`,
          'transform-origin': '0 0',
          transform: `rotate(${round3(angle + (node.rotation || 0))}deg)`,
          opacity: node.opacity !== 1 ? String(node.opacity) : undefined
        })
      });
    }

    case 'path': {
      // Yol SVG ile çizilir: CSS'te eğri yoktur. `d` yalnız SAYILARDAN
      // kurulur (şema doğrulaması bunu garanti eder), yani dizge
      // birleştirmesi burada güvenlidir.
      const local = geometry.fitPath(node.d, { x: 0, y: 0, width: f.width, height: f.height });
      return el('svg', {
        class: 'sn-path', 'data-id': node.id,
        width: round3(f.width), height: round3(f.height),
        viewBox: `0 0 ${round3(f.width)} ${round3(f.height)}`,
        style: style({ ...base, overflow: 'visible' })
      }, [el('path', {
        d: svgPathData(local),
        fill: node.fill || 'none',
        'fill-rule': node.fillRule === 'evenodd' ? 'evenodd' : undefined,
        stroke: node.stroke || 'none',
        'stroke-width': node.strokeWidth ? round3(node.strokeWidth) : undefined,
        'stroke-dasharray': dashArray(node)
      })]);
    }

    case 'text': {
      const children = [];
      for (const run of toRuns(node)) {
        const runStyle = style({
          'font-weight': (run.bold ?? node.bold) ? '700' : undefined,
          'font-style': (run.italic ?? node.italic) ? 'italic' : undefined,
          color: run.color,
          'font-size': run.fontSize
        });
        // Satır sonları korunur: `white-space: pre-wrap` ile birlikte
        const piece = runStyle
          ? el('span', { style: runStyle }, [run.text])
          : run.text;
        children.push(run.link ? el('a', { href: run.link, rel: 'noopener noreferrer' }, [piece]) : piece);
      }

      return el('div', {
        class: 'sn-text', 'data-id': node.id,
        style: style({
          ...base,
          // `autoHeight`: kutu metin kadar uzar. Sabit yükseklik yazmak,
          // önizlemenin PDF'ten farklı kırpılması demek olurdu.
          height: node.autoHeight ? 'auto' : base.height,
          padding: node.padding || undefined,
          'box-sizing': 'border-box',
          display: 'flex',
          'flex-direction': 'column',
          'justify-content': node.valign === 'middle' ? 'center'
            : node.valign === 'bottom' ? 'flex-end' : 'flex-start',
          'font-family': cssFontFamily(node.fontFamily),
          'font-size': node.fontSize,
          'line-height': String(node.lineHeight),
          color: node.color,
          'text-align': node.align,
          'font-weight': node.bold ? '700' : undefined,
          'font-style': node.italic ? 'italic' : undefined,
          'letter-spacing': node.letterSpacing || undefined,
          'white-space': 'pre-wrap',
          'overflow-wrap': 'break-word'
        })
      }, [el('div', {}, children)]);
    }

    case 'image': {
      const src = ctx.assetUrl(node.assetId);
      if (!src) {
        return el('div', {
          class: 'sn-image sn-missing', 'data-id': node.id,
          style: style({ ...base, border: '0.5pt dashed #c8ccd4', 'box-sizing': 'border-box' })
        }, ['görsel bulunamadı']);
      }
      return el('img', {
        class: 'sn-image', 'data-id': node.id, src, alt: node.alt || '',
        style: style({
          ...base,
          'object-fit': node.fit === 'fill' ? 'fill' : node.fit === 'cover' ? 'cover' : 'contain'
        })
      });
    }

    case 'qr': {
      const src = ctx.qrUrl(node);
      return src
        ? el('img', {
          class: 'sn-qr', 'data-id': node.id, src, alt: 'karekod',
          style: style({ ...base, 'object-fit': 'contain' })
        })
        : el('div', {
          class: 'sn-qr sn-missing', 'data-id': node.id,
          style: style({ ...base, border: '0.5pt dashed #c8ccd4', 'box-sizing': 'border-box' })
        }, ['karekod']);
    }

    case 'signature':
      return el('div', {
        class: 'sn-signature', 'data-id': node.id,
        'data-field': node.fieldName || node.id,
        style: style({
          ...base,
          border: node.showFrame ? '0.5pt dashed #8b93a7' : undefined,
          'border-radius': 2,
          'box-sizing': 'border-box',
          display: 'flex', 'align-items': 'center', 'justify-content': 'center',
          'font-family': cssFontFamily(node.fontFamily),
          'font-size': 8, color: '#8b93a7'
        })
      }, [node.label || 'İmza']);

    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Sayfa iskeleti                                                      */
/* ------------------------------------------------------------------ */

const BASE_CSS = `
*, *::before, *::after { box-sizing: content-box; }
body { margin: 0; background: #eceff4; font-family: system-ui, sans-serif; }
.sn-doc { display: flex; flex-direction: column; align-items: center; gap: 16pt; padding: 16pt; }
.sn-page { position: relative; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.18); overflow: hidden; }
.sn-page > * { margin: 0; }
.sn-text > div { width: 100%; }
.sn-missing { display: flex; align-items: center; justify-content: center;
  font-size: 8pt; color: #8b93a7; }
.sn-guides { position: absolute; inset: 0; pointer-events: none;
  border: 0.5pt dashed rgba(31,58,99,.25); }
@media print {
  body { background: #fff; }
  .sn-doc { gap: 0; padding: 0; }
  .sn-page { box-shadow: none; page-break-after: always; }
  .sn-guides { display: none; }
}
`.trim();

/**
 * Sahneyi HTML'e derler.
 *
 * @param {Object} sceneInput Scene örneği ya da düz sahne nesnesi
 * @param {Object} [o]
 * @param {Object} [o.assets] AssetManager — görselleri data: URL olarak gömmek için
 * @param {Function} [o.assetUrl] (assetId) => url; verilmezse assets'ten data: üretilir
 * @param {boolean} [o.fragment=false] true ise <html> iskeleti olmadan yalnız sayfalar
 * @param {boolean} [o.showMargins=false] kenar boşluğu kılavuzlarını göster
 * @returns {{ html: string, warnings: Array }}
 */
function compileToHtml(sceneInput, o = {}) {
  const isScene = sceneInput && typeof sceneInput.toJSON === 'function';
  const raw = isScene ? sceneInput.toJSON() : sceneInput;
  const assets = o.assets || (isScene ? sceneInput.assets : null);

  const { scene, issues } = validateScene(raw);
  if (!scene) {
    throw new SceneError('ERR_SCENE_INVALID',
      `Sahne derlenemedi: ${issues.length} sorun (ilki: ${issues[0].path} ${issues[0].message})`,
      issues);
  }

  const warnings = [];

  /**
   * Varlık adresi. Varsayılan: `data:` URL.
   *
   * `data:` seçilmesinin sebebi, önizlemenin TEK dosya olmasıdır: bir dosya
   * yolu vermek, HTML'i açan tarafın dosya sistemine erişebilmesini
   * gerektirir ve önizlemeyi taşınamaz kılar.
   */
  const assetUrl = o.assetUrl || ((id) => {
    if (!assets) return null;
    const meta = assets.get(id);
    const bytes = assets.bytes(id);
    if (!meta || !bytes) {
      warnings.push({ code: 'WARN_ASSET_MISSING', message: `Varlık bulunamadı: ${id}` });
      return null;
    }
    return `data:${meta.mime};base64,${bytes.toString('base64')}`;
  });

  const qrCache = new Map();
  const qrUrl = o.qrUrl || ((node) => {
    const key = `${node.payload}|${node.quiet}`;
    if (qrCache.has(key)) return qrCache.get(key);
    let url = null;
    try {
      const { generatePngBuffer } = require('@fitfak/qr');
      url = 'data:image/png;base64,' +
        generatePngBuffer(node.payload, { size: 512, margin: node.quiet }).toString('base64');
    } catch {
      warnings.push({ code: 'WARN_QR_FAILED', message: `Karekod üretilemedi: ${node.id}` });
    }
    qrCache.set(key, url);
    return url;
  });

  const ctx = { assetUrl, qrUrl };
  const m = scene.page.margin;

  const pageEls = scene.pages.map((page, index) => {
    // Sayfaya özgü ölçü varsa o geçerlidir; önizleme PDF ile aynı kâğıdı
    // göstermelidir, yoksa yatay bir sayfa dikey kutuya sıkışmış görünür.
    const geo = geometry.pageGeometry(scene, page);
    return el('section', {
      class: 'sn-page', 'data-page': String(index), 'data-id': page.id,
      'aria-label': page.name,
      style: style({
        width: geo.width, height: geo.height,
        background: page.background || '#ffffff'
      })
    }, [
      o.showMargins ? el('div', {
        class: 'sn-guides',
        style: style({
          position: 'absolute', left: m.left, top: m.top,
          width: geo.width - m.left - m.right,
          height: geo.height - m.top - m.bottom
        })
      }) : null,
      ...page.nodes.map((n) => nodeElement(n, ctx)).filter(Boolean)
    ]);
  });

  const body = el('div', { class: 'sn-doc' }, pageEls);

  if (o.fragment) {
    return { html: `${serialize(styleSheet(BASE_CSS))}\n${serialize(body)}`, warnings };
  }

  const html = [
    '<!doctype html>',
    serialize(el('html', { lang: scene.meta.lang || 'tr-TR' }, [
      el('head', {}, [
        el('meta', { charset: 'utf-8' }),
        el('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
        el('title', {}, [scene.meta.title || 'Belge']),
        styleSheet(BASE_CSS)
      ]),
      el('body', {}, [body])
    ]))
  ].join('\n');

  return { html, warnings };
}

module.exports = {
  compileToHtml, serialize, el, styleSheet,
  escapeText, escapeAttr, cssFontFamily, BASE_CSS
};
