#!/usr/bin/env node
'use strict';
/**
 * Paket yayın hattı.
 *
 * Paketler birbirine bağımlıdır (`pades` → `pdf-doc` → …), bu yüzden rastgele
 * sırada yayınlanamazlar: npm, bağımlılığı henüz kayıtta olmayan bir paketi
 * reddeder. Burada bağımlılık grafiği topolojik olarak sıralanır.
 *
 * İşlem **idempotent**tir: kayıtta zaten aynı sürüm varsa o paket atlanır.
 * Böylece yarıda kalan bir yayın güvenle tekrar çalıştırılabilir.
 *
 * Kullanım:
 *   node scripts/publish.js            # gerçekten yayınlar
 *   node scripts/publish.js --dry-run  # yalnız planı gösterir
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PACKAGES_DIR = path.join(ROOT, 'packages');

const dryRun = process.argv.includes('--dry-run');

/* ------------------------------------------------------------------ */

/** `packages/` altındaki yayınlanabilir paketleri okur. */
function loadPackages() {
  const out = new Map();

  for (const name of fs.readdirSync(PACKAGES_DIR)) {
    const file = path.join(PACKAGES_DIR, name, 'package.json');
    if (!fs.existsSync(file)) continue;

    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (manifest.private) continue;

    out.set(manifest.name, {
      name: manifest.name,
      version: manifest.version,
      dir: path.join(PACKAGES_DIR, name),
      deps: Object.keys({
        ...(manifest.dependencies || {}),
        ...(manifest.peerDependencies || {})
      }).filter((d) => d.startsWith('@fitfak/'))
    });
  }
  return out;
}

/**
 * Bağımlılık grafiğini topolojik sıralar.
 * Döngü varsa açıkça hata verir — sessizce yanlış sıra üretmekten iyidir.
 */
function topoSort(packages) {
  const sorted = [];
  const state = new Map();          // ad → 'visiting' | 'done'

  const visit = (name, trail) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      throw new Error(`Bağımlılık döngüsü: ${[...trail, name].join(' → ')}`);
    }
    const pkg = packages.get(name);
    if (!pkg) return;               // depoda olmayan @fitfak paketi (yayınlanmış varsayılır)

    state.set(name, 'visiting');
    for (const dep of pkg.deps) visit(dep, [...trail, name]);
    state.set(name, 'done');
    sorted.push(pkg);
  };

  for (const name of packages.keys()) visit(name, []);
  return sorted;
}

/** Kayıtta bu sürüm zaten var mı? */
function isPublished(name, version) {
  try {
    const out = execFileSync('npm', ['view', `${name}@${version}`, 'version'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim() === version;
  } catch {
    return false;                   // 404 → yayınlanmamış
  }
}

function publish(pkg) {
  execFileSync('npm', ['publish', '--access', 'public', '--provenance'],
    { cwd: pkg.dir, stdio: 'inherit' });
}

/* ------------------------------------------------------------------ */

function main() {
  const packages = loadPackages();
  const order = topoSort(packages);

  console.log(`Yayın sırası (${order.length} paket):`);
  for (const [i, pkg] of order.entries()) {
    console.log(`  ${i + 1}. ${pkg.name}@${pkg.version}` +
      (pkg.deps.length ? `  ← ${pkg.deps.join(', ')}` : ''));
  }
  console.log('');

  if (dryRun) {
    console.log('--dry-run: hiçbir şey yayınlanmadı.');
    return;
  }

  let published = 0;
  let skipped = 0;

  for (const pkg of order) {
    if (isPublished(pkg.name, pkg.version)) {
      console.log(`atlandı  ${pkg.name}@${pkg.version} (kayıtta zaten var)`);
      skipped++;
      continue;
    }
    console.log(`yayınla  ${pkg.name}@${pkg.version}`);
    publish(pkg);
    published++;
  }

  console.log(`\n${published} paket yayınlandı, ${skipped} paket atlandı.`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`hata: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { loadPackages, topoSort };
