'use strict';
/**
 * Tarayıcı paketleyicisi.
 *
 * Sahne modelinin çekirdeğini (birimler, şema, doğrulama, geometri, geçmiş,
 * varlıklar, belge) TEK bir ES modülüne toplar. Editör bu paketi yükler ve
 * sunucudaki derleyicilerle AYNI modeli kullanır.
 *
 * NEDEN AYRI BİR KOPYA YAZILMADI: iki model, iki davranış demektir. Tuvalde
 * geçerli sayılan bir belgenin sunucuda reddedilmesi (ya da tersi) en can
 * sıkıcı hata sınıfıdır. Kaynak tek olsun, paketleme farklı olsun.
 *
 * Paketleyici KASTEN küçüktür: bağımlılık eklemeden, yalnız bu paketin
 * kendi dosyalarını, bilinen bir sırayla, tek bir kapsama sarar. Genel
 * amaçlı bir paketleyici değildir ve olmaya çalışmaz.
 *
 * Derleyiciler (Scene → PDF/HTML) ve içe aktarıcılar pakete GİRMEZ:
 * onlar sunucuda çalışır ve font/görsel ayrıştırıcılarına ihtiyaç duyar.
 */

const fs = require('fs');
const path = require('path');
const { SHIM_SOURCE } = require('./src/browser/shim');

/** Bağımlılık sırasına göre — sonrakiler öncekilere gönderebilir. */
const MODULES = ['units', 'schema', 'validate', 'geometry', 'history', 'assets', 'scene'];

/** Paketten dışa açılan adlar. */
const EXPORTS = {
  './scene': ['Scene', 'makeId'],
  './validate': ['validateScene', 'SceneError', 'parseColor', 'colorToHex'],
  './schema': ['SCHEMA_VERSION', 'PAGE_SIZES', 'NODE_TYPES', 'LIMITS'],
  './assets': ['AssetManager', 'AssetError', 'sniff'],
  './history': ['History']
};

/** Ad alanı olarak açılanlar (`geometry.align(...)` gibi). */
const NAMESPACES = { geometry: './geometry', units: './units' };

function readModule(name) {
  return fs.readFileSync(path.join(__dirname, 'src', `${name}.js`), 'utf8');
}

/**
 * ES modülü kaynağını üretir.
 * @returns {string}
 */
function buildBrowserBundle() {
  const parts = [];

  parts.push('/* OTOMATİK ÜRETİLDİ — elle düzenlemeyin.');
  parts.push(' * Kaynak: packages/pdf-scene/src/*.js');
  parts.push(' * Üretici: packages/pdf-scene/browser.js');
  parts.push(' */');
  parts.push(SHIM_SOURCE);

  parts.push(`
/* ---------- Küçük modül kayıt defteri ---------- */
const __defs = {};
const __cache = {};

function __require(id) {
  if (id === 'crypto') return nodeCrypto;
  if (__cache[id]) return __cache[id].exports;
  const def = __defs[id];
  if (!def) throw new Error('Paket içinde bulunamayan modül: ' + id);
  const module = { exports: {} };
  __cache[id] = module;
  def(module, module.exports, __require);
  return module.exports;
}

function __define(id, factory) { __defs[id] = factory; }
`);

  for (const name of MODULES) {
    const source = readModule(name);
    parts.push(`__define('./${name}', function (module, exports, require) {\n${source}\n});`);
  }

  parts.push('\n/* ---------- Dışa açılanlar ---------- */');
  for (const [id, names] of Object.entries(EXPORTS)) {
    const varName = '__' + id.replace(/[^a-z]/gi, '');
    parts.push(`const ${varName} = __require('${id}');`);
    for (const n of names) parts.push(`export const ${n} = ${varName}.${n};`);
  }
  for (const [alias, id] of Object.entries(NAMESPACES)) {
    parts.push(`export const ${alias} = __require('${id}');`);
  }

  return parts.join('\n') + '\n';
}

/** Paketi diske yazar (statik barındırma için). */
function writeBrowserBundle(outFile) {
  const target = outFile || path.join(__dirname, 'dist', 'scene.esm.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buildBrowserBundle(), 'utf8');
  return target;
}

if (require.main === module) {
  const file = writeBrowserBundle();
  const size = fs.statSync(file).size;
  console.log(`sahne tarayıcı paketi: ${file} (${(size / 1024).toFixed(1)} KB)`);
}

module.exports = { buildBrowserBundle, writeBrowserBundle, MODULES };
