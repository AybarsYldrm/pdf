'use strict';
/**
 * Görünür imza yapılandırması — @fitfak/stamp şablonlarını PAdES motoruna bağlar.
 *
 * Eski `signature_config.js` yalnız tek bir sabit görünüm üretebiliyor ve konumu
 * `SIGNATURE_POSITIONS` ortam değişkeninden okuyordu. Bu modül aynı işi açık
 * parametrelerle ve şablon seçimiyle yapar; ortam değişkeni yolu geriye dönük
 * uyum için korunur.
 */

const path = require('path');

const DEFAULT_RECT = { x: 430, y: 130, width: 160, origin: 'bottom-left' };

/**
 * Görünür imza yapılandırması üretir.
 *
 * @param {Object} o
 * @param {string} [o.template='classic'] @fitfak/stamp şablonu
 * @param {Object} [o.vars] Şablon değişkenleri ({signerName}, {docNo}, {verifyUrl}…)
 * @param {string} [o.font] TTF yolu (verilmezse @fitfak/pades'in gömülü fontu)
 * @param {string} [o.logo] Logo PNG yolu (verilmezse gömülü logo)
 * @param {{x:number,y:number,width:number,height?:number,origin?:string}} [o.rect]
 * @param {number} [o.page] Sayfa (şu an yalnız ilk sayfa desteklenir)
 * @param {Buffer} [o.imageBuffer] Hazır PNG — şablon üretimi atlanır
 * @param {number} [o.seed] Doku tohumu (testlerde tekrarlanabilirlik)
 * @returns {{ imageBuffer: Buffer, defaultPosition: Object, rendered: Object }|null}
 */
function buildVisibleSignature(o = {}) {
  const padesRoot = path.dirname(require.resolve('@fitfak/pades/package.json'));
  const font = o.font || path.join(padesRoot, 'src/assets/font.ttf');
  const logo = o.logo || path.join(padesRoot, 'src/assets/caduceus.png');

  let imageBuffer = o.imageBuffer || null;
  let rendered = {};

  if (!imageBuffer) {
    try {
      const { renderStamp } = require('@fitfak/stamp');
      const result = renderStamp({
        template: o.template || 'classic',
        font,
        baseDir: o.baseDir || process.cwd(),
        seed: o.seed,
        size: o.size,
        vars: { logo, ...(o.vars || {}) }
      });
      imageBuffer = result.png;
      rendered = result.rendered;
    } catch (err) {
      // Görünür imza üretilemezse imza GÖRÜNMEZ olarak devam eder — imzanın
      // kriptografik geçerliliği bundan etkilenmez, ama sessiz kalmıyoruz.
      const logger = o.logger || console;
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`[görünür imza] üretilemedi, görünmez imza ile devam ediliyor: ${err.message}`);
      }
      return null;
    }
  }

  const rect = { ...DEFAULT_RECT, ...(o.rect || {}) };

  return {
    imageBuffer,
    // Görünür imzanın hangi sayfaya basılacağı (0 tabanlı)
    page: typeof o.page === 'number' ? o.page : 0,
    defaultPosition: rect,
    coordinateMap: o.coordinateMap || {},
    rendered,
    // Eski sistemin beklediği alanlar (metin motorunu tetiklememek için boş)
    textTemplate: '',
    textLines: [],
    text: '',
    signerName: (o.vars && o.vars.signerName) || '',
    useCertificateCN: false,
    cnFallbackEnabled: false
  };
}

/**
 * Layout manifest'teki bir imza yuvasından doğrudan görünür imza üretir.
 * Sihirli koordinat sayılarını ortadan kaldıran yol budur.
 *
 * @param {Object} slot manifest.signatureSlots[i]
 * @param {Object} opts buildVisibleSignature seçenekleri
 */
function fromManifestSlot(slot, opts = {}) {
  if (!slot || !slot.rect) {
    throw new Error('fromManifestSlot: geçerli bir imza yuvası gerekli');
  }
  return buildVisibleSignature({
    ...opts,
    page: slot.page || 0,
    rect: {
      x: slot.rect.x,
      y: slot.rect.y,
      width: slot.rect.width,
      height: slot.rect.height,
      origin: slot.origin || 'bottom-left'
    },
    vars: { role: slot.role, ...(opts.vars || {}) }
  });
}

module.exports = { buildVisibleSignature, fromManifestSlot, DEFAULT_RECT };
