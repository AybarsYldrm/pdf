'use strict';
/**
 * @fitfak/pdf-scene — serbest yerleşimli belge modeli.
 *
 * MİMARİ KONUMU
 *
 *   Editör (tarayıcı)  ─┐
 *   İçe aktarma        ─┼─→  SAHNE MODELİ  ─┬─→  Scene → PDF   → PAdES imza
 *   Şablon/kod         ─┘   (düz JSON veri)  └─→  Scene → HTML  → önizleme
 *
 * Sahne modeli, mevcut HTML/CSS → PDF motorunun YERİNE geçmez; onun YANINDA
 * durur. Akış belgeleri (sözleşme, rapor) HTML yolundan geçmeye devam eder;
 * serbest yerleşimli belgeler (sertifika, kartvizit, sunum sayfası) sahne
 * yolundan geçer. İkisi de aynı PDF yazarını ve aynı imza motorunu kullanır.
 *
 * PDF yerleşimi, tarayıcı yerleşimine BAĞLI DEĞİLDİR: sahnedeki koordinatlar
 * doğrudan PDF'e gider. Önizleme HTML'i bir kolaylıktır, gerçeğin kaynağı
 * değildir.
 */

const { Scene, makeId } = require('./src/scene');
const { compileToPdf } = require('./src/compile/pdf');
const { compileToHtml } = require('./src/compile/html');
const { importFromHtml } = require('./src/import/html');
const { importFromPdf } = require('./src/import/pdf');
const { validateScene, SceneError, parseColor, colorToHex } = require('./src/validate');
const { SCHEMA_VERSION, PAGE_SIZES, NODE_TYPES, COMMON_FIELDS, LIMITS } = require('./src/schema');
const { AssetManager, AssetError, sniff } = require('./src/assets');
const { History } = require('./src/history');
const geometry = require('./src/geometry');
const units = require('./src/units');

module.exports = {
  // Belge
  Scene,
  validateScene,
  SceneError,
  makeId,

  // Şema
  SCHEMA_VERSION,
  PAGE_SIZES,
  NODE_TYPES,
  COMMON_FIELDS,
  LIMITS,

  // Varlıklar
  AssetManager,
  AssetError,
  sniff,

  // Derleyiciler
  compileToPdf,
  compileToHtml,

  // İçe aktarıcılar
  importFromHtml,
  importFromPdf,

  // Geri alma
  History,

  // Yardımcılar
  geometry,
  units,
  parseColor,
  colorToHex
};
