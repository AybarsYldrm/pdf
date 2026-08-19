'use strict';
/**
 * @fitfak/paper — Baskıya öncelikli CSS tasarım sistemi.
 *
 * KİLİT FİKİR: Aynı CSS hem PDF motoruna hem tarayıcıya verilir. Önizleme bu
 * yüzden gerçekten WYSIWYG olur. Yan etkisi de değerlidir: tasarım sistemi,
 * motorun desteklediği CSS alt kümesinin sözleşmesi hâline gelir — `paper.css`
 * yalnız motorun bildiği özellikleri kullanır.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const DIST = path.join(__dirname, 'dist');

const THEMES = ['kurumsal', 'resmi', 'akademik', 'minimal', 'sertifika'];

const read = (p) => fs.readFileSync(p, 'utf8');

/** Belirteçler + sıfırlama + tipografi. */
function base() {
  return read(path.join(SRC, 'tokens.css')) + '\n' + read(path.join(SRC, 'base.css'));
}

/** Bileşen katmanı. */
function components() {
  return read(path.join(SRC, 'components.css'));
}

/**
 * Bir temanın CSS'i.
 * @param {string} name kurumsal | resmi | akademik | minimal | sertifika
 */
function theme(name) {
  if (!THEMES.includes(name)) {
    throw new Error(`Bilinmeyen tema: ${name}. Mevcut: ${THEMES.join(', ')}`);
  }
  return read(path.join(SRC, 'themes', `${name}.css`));
}

/**
 * Belirli bir tema için hazır CSS yığını.
 * @param {string} [themeName='kurumsal']
 * @returns {string[]} render({ css: ... }) için sıralı dizi
 */
function stack(themeName = 'kurumsal') {
  return [base(), components(), theme(themeName)];
}

/** Tüm temaları içeren birleşik CSS (tarayıcı için tek dosya). */
function bundle() {
  return [
    '/* @fitfak/paper — derlenmiş paket. Kaynak: packages/paper/src/ */',
    base(),
    components(),
    ...THEMES.map((t) => theme(t))
  ].join('\n\n');
}

/** `dist/paper.css` dosyasını üretir. */
function build() {
  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  const out = path.join(DIST, 'paper.css');
  fs.writeFileSync(out, bundle(), 'utf8');
  return out;
}

module.exports = { base, components, theme, stack, bundle, build, THEMES, SRC, DIST };

if (require.main === module) {
  const out = build();
  const size = fs.statSync(out).size;
  console.log(`@fitfak/paper derlendi: ${out} (${(size / 1024).toFixed(1)} KB)`);
}
