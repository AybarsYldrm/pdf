'use strict';
/**
 * `fitfak-belge` CLI — argüman ayrıştırma ve ağ gerektirmeyen komutlar.
 *
 * İmzalama/doğrulama akışları `test/e2e/07-cli.test.js` içinde, yerel PKI ile
 * sınanır. Burada CLI'ın kendi mantığı vardır: argümanlar, dosya yolları,
 * hata mesajları ve çıkış kodları.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const { parseArgs, COMMANDS } = require('../../bin/fitfak-belge');

const ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(ROOT, 'bin', 'fitfak-belge.js');

let workDir;
test.before(() => { workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitfak-cli-')); });
test.after(() => { if (workDir) fs.rmSync(workDir, { recursive: true, force: true }); });

const at = (name) => path.join(workDir, name);

/** CLI'ı çalıştırır; hata durumunda da çıktıyı döndürür. */
async function run(args) {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI, ...args],
      { encoding: 'utf8', cwd: ROOT, timeout: 60000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

const HTML = `<!doctype html><html lang="tr"><body>
  <h1>CLI Belgesi</h1>
  <p>Türkçe içerik: Ağrı Dağı, İstanbul, Şişli, öğün.</p>
  <table><thead><tr><th>Ürün</th><th>Adet</th></tr></thead>
    <tbody><tr><td>Çelik</td><td>3</td></tr></tbody></table>
</body></html>`;

/* ================================================================== */
/* Argüman ayrıştırıcı                                                */
/* ================================================================== */

test('parseArgs: uzun, kısa, eşitlikli ve konumsal argümanlar', () => {
  const args = parseArgs(
    ['girdi.html', '--out', 'a.pdf', '--title=Başlık', '-o', 'b.pdf', 'ikinci'],
    { alias: { o: 'out' } });

  assert.deepStrictEqual(args._, ['girdi.html', 'ikinci']);
  assert.deepStrictEqual(args.out, ['a.pdf', 'b.pdf'], 'tekrar eden anahtar diziye dönüşmeli');
  assert.strictEqual(args.title, 'Başlık');
});

test('parseArgs: bayraklar değer yutmaz', () => {
  const args = parseArgs(['--offline', 'belge.pdf'], { flags: ['offline'] });
  assert.strictEqual(args.offline, true);
  assert.deepStrictEqual(args._, ['belge.pdf'], 'bayraktan sonraki konumsal argüman korunmalı');
});

test('parseArgs: --no-<bayrak> kapatır', () => {
  const args = parseArgs(['--no-theme'], { flags: ['theme'] });
  assert.strictEqual(args.theme, false);
});

test('parseArgs: -- sonrası her şey konumsaldır', () => {
  const args = parseArgs(['--out', 'x', '--', '--bu-bir-dosya-adi'], {});
  assert.deepStrictEqual(args._, ['--bu-bir-dosya-adi']);
});

test('parseArgs: negatif sayı bayrak sanılmaz', () => {
  const args = parseArgs(['--x', '-12'], {});
  assert.strictEqual(args.x, '-12');
});

test('parseArgs: değersiz anahtar hata verir', () => {
  assert.throws(() => parseArgs(['--out'], {}), /--out bir değer bekliyor/);
});

/* ================================================================== */
/* Yardım ve hata yolları                                             */
/* ================================================================== */

test('yardım metni tüm komutları listeler', async () => {
  const { stdout, code } = await run([]);
  assert.strictEqual(code, 0);
  for (const name of Object.keys(COMMANDS)) {
    assert.match(stdout, new RegExp(`\\b${name}\\b`), `${name} komutu listelenmeli`);
  }
});

test('komut yardımı seçenekleri gösterir', async () => {
  const { stdout } = await run(['sign', '--help']);
  assert.match(stdout, /--pfx/);
  assert.match(stdout, /--level/);
  assert.match(stdout, /fitfak-belge sign/);
});

test('bilinmeyen komut 1 ile çıkar', async () => {
  const { code, stderr } = await run(['boyle-bir-komut-yok']);
  assert.strictEqual(code, 1);
  assert.match(stderr, /Bilinmeyen komut/);
});

test('eksik dosya anlaşılır hata verir', async () => {
  const { code, stderr } = await run(['inspect', at('olmayan.pdf')]);
  assert.strictEqual(code, 1);
  assert.match(stderr, /Dosya bulunamadı/);
});

/* ================================================================== */
/* render                                                             */
/* ================================================================== */

test('render: HTML dosyasından PDF üretir', async () => {
  fs.writeFileSync(at('in.html'), HTML);
  const { code, stderr } = await run([
    'render', at('in.html'), '-o', at('out.pdf'),
    '--title', 'CLI Belgesi', '--author', 'Aybars'
  ]);

  assert.strictEqual(code, 0, stderr);
  const pdf = fs.readFileSync(at('out.pdf'));
  assert.strictEqual(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.match(stderr, /1 sayfa/);
});

test('render: manifest dosyaya yazılabilir', async () => {
  fs.writeFileSync(at('slot.html'), `<!doctype html><html lang="tr"><body>
    <h1>Başlık</h1><div data-signer="imzaci1" data-role="Düzenleyen">&nbsp;</div></body></html>`);

  await run(['render', at('slot.html'), '-o', at('slot.pdf'), '--manifest', at('slot.json')]);

  const manifest = JSON.parse(fs.readFileSync(at('slot.json'), 'utf8'));
  assert.strictEqual(manifest.signatureSlots.length, 1);
  assert.strictEqual(manifest.signatureSlots[0].id, 'imzaci1');
  assert.ok(manifest.signatureSlots[0].rect.width > 0);
});

test('render: uyumluluk profili uygulanır', async () => {
  fs.writeFileSync(at('conf.html'), HTML);
  const { stderr } = await run([
    'render', at('conf.html'), '-o', at('conf.pdf'),
    '--title', 'Uyumlu Belge', '--conformance', 'pdf/a-2b+pdf/ua'
  ]);

  assert.match(stderr, /uyumluluk:/);

  const check = await run(['check', at('conf.pdf')]);
  assert.strictEqual(check.code, 0, check.stdout);
  assert.match(check.stdout, /Sonuç:\s+UYUMLU/);
});

test('render: çıktı verilmezse stdout\'a yazar', async () => {
  fs.writeFileSync(at('stdout.html'), HTML);
  const { stdout } = await run(['render', at('stdout.html')]);
  assert.strictEqual(stdout.slice(0, 5), '%PDF-');
});

/* ================================================================== */
/* check                                                              */
/* ================================================================== */

test('check: uyumsuz belge 2 ile çıkar', async () => {
  fs.writeFileSync(at('plain.html'), HTML);
  await run(['render', at('plain.html'), '-o', at('plain.pdf'), '--title', 'Düz']);

  const { code, stdout } = await run(['check', at('plain.pdf'), '--profile', 'pdf/a-2b']);
  assert.strictEqual(code, 2, 'uyumsuzluk sıfırdan farklı çıkış kodu vermeli');
  assert.match(stdout, /UYUMSUZ/);
  assert.match(stdout, /6\.2\.2/);
});

test('check: --json makine okunur rapor verir', async () => {
  const { stdout } = await run(['check', at('conf.pdf'), '--json']);
  const report = JSON.parse(stdout);

  assert.strictEqual(report.conforms, true);
  assert.ok(report.pdfA && report.pdfUA);
  assert.deepStrictEqual(report.profiles.sort(), ['pdf/a-2b', 'pdf/ua']);
});

/* ================================================================== */
/* inspect / text                                                     */
/* ================================================================== */

test('inspect: yapı özetini yazar', async () => {
  const { stdout, code } = await run(['inspect', at('out.pdf')]);
  assert.strictEqual(code, 0);
  assert.match(stdout, /Sayfa\s+: 1/);
  assert.match(stdout, /Şifreli\s+: hayır/);
  assert.match(stdout, /Title\s+CLI Belgesi/);
});

test('inspect: --json alan ve imza listesini içerir', async () => {
  const { stdout } = await run(['inspect', at('out.pdf'), '--json']);
  const info = JSON.parse(stdout);

  assert.strictEqual(info.pageCount, 1);
  assert.strictEqual(info.encrypted, false);
  assert.strictEqual(info.metadata.Title, 'CLI Belgesi');
  assert.deepStrictEqual(info.signatures, []);
});

test('inspect: şifreli belge parola ister', async () => {
  const fixtures = path.join(ROOT, 'test', 'fixtures', 'pdf');
  if (!fs.existsSync(path.join(fixtures, 'encrypted-rc4-userpwd.pdf'))) {
    require(path.join(fixtures, 'generate.js')).generateAll();
  }
  const file = path.join(fixtures, 'encrypted-rc4-userpwd.pdf');

  const without = await run(['inspect', file]);
  assert.strictEqual(without.code, 1);
  assert.match(without.stderr, /ERR_CRYPT_BAD_PASSWORD/);

  const withPassword = await run(['inspect', file, '--password', 'gizli']);
  assert.strictEqual(withPassword.code, 0);
  assert.match(withPassword.stdout, /Şifreli\s+: evet/);
});

test('text: Türkçe metni doğru çıkarır', async () => {
  const { stdout, code } = await run(['text', at('out.pdf')]);
  assert.strictEqual(code, 0);
  assert.match(stdout, /CLI Belgesi/);
  assert.match(stdout, /Ağrı Dağı, İstanbul, Şişli, öğün/);
  assert.match(stdout, /Ürün Adet/);
});

test('text: --json konum bilgisi verir', async () => {
  const { stdout } = await run(['text', at('out.pdf'), '--json', '--page', '0']);
  const pages = JSON.parse(stdout);

  assert.strictEqual(pages.length, 1);
  assert.ok(pages[0].items.length > 0);
  assert.ok(Number.isFinite(pages[0].items[0].x));
  assert.ok(pages[0].items[0].fontSize > 0);
});

/* ================================================================== */
/* edit                                                               */
/* ================================================================== */

test('edit: sayfa döndürme ve metin ekleme', async () => {
  const { code, stderr } = await run([
    'edit', at('out.pdf'), '-o', at('edited.pdf'),
    '--rotate', '0:90',
    '--text', '0:60:50:9=CLI ile eklendi',
    '--title', 'Düzenlenmiş'
  ]);
  assert.strictEqual(code, 0, stderr);
  assert.match(stderr, /artımlı/);

  const info = JSON.parse((await run(['inspect', at('edited.pdf'), '--json'])).stdout);
  assert.strictEqual(info.pages[0].rotate, 90);
  assert.strictEqual(info.metadata.Title, 'Düzenlenmiş');

  const text = (await run(['text', at('edited.pdf')])).stdout;
  assert.match(text, /CLI ile eklendi/);
});

test('edit: artımlı yazım orijinal baytları korur', async () => {
  const before = fs.readFileSync(at('out.pdf'));
  await run(['edit', at('out.pdf'), '-o', at('inc.pdf'), '--title', 'Yeni']);
  const after = fs.readFileSync(at('inc.pdf'));

  assert.ok(after.length > before.length);
  assert.ok(after.subarray(0, before.length).equals(before));
});

test('edit: görsel yerleştirme', async () => {
  const logo = path.join(ROOT, 'apps', 'studio', 'favicon.png');
  const { code, stderr } = await run([
    'edit', at('out.pdf'), '-o', at('img.pdf'), '--image', `0:400:700:80=${logo}`
  ]);
  assert.strictEqual(code, 0, stderr);
  assert.ok(fs.statSync(at('img.pdf')).size > fs.statSync(at('out.pdf')).size);
});

test('edit: işlem verilmezse hata', async () => {
  const { code, stderr } = await run(['edit', at('out.pdf'), '-o', at('x.pdf')]);
  assert.strictEqual(code, 1);
  assert.match(stderr, /düzenleme işlemi verilmedi/);
});

test('edit: bozuk işlem biçimi anlaşılır hata verir', async () => {
  const { code, stderr } = await run(['edit', at('out.pdf'), '-o', at('x.pdf'), '--text', 'bozuk']);
  assert.strictEqual(code, 1);
  assert.match(stderr, /--text biçimi/);
});

test('edit: form doldurma ve düzleştirme', async () => {
  const fixtures = path.join(ROOT, 'test', 'fixtures', 'pdf');
  if (!fs.existsSync(path.join(fixtures, 'acroform.pdf'))) {
    require(path.join(fixtures, 'generate.js')).generateAll();
  }

  const { code, stderr } = await run([
    'edit', path.join(fixtures, 'acroform.pdf'), '-o', at('form.pdf'),
    '--fill', 'ad=Aybars YILDIRIM', '--fill', 'sehir=Izmir',
    '--fill', 'imza=buraya yazilamaz', '--flatten'
  ]);
  assert.strictEqual(code, 0, stderr);
  assert.match(stderr, /atlandı: imza .*PAdES/,
    'imza alanına yazma denemesi atlanmalı ve gerekçesi bildirilmeli');

  const info = JSON.parse((await run(['inspect', at('form.pdf'), '--json'])).stdout);
  assert.deepStrictEqual(info.fields.map((f) => f.name), ['imza'],
    'düzleştirmeden sonra yalnız imza alanı kalmalı');

  const text = (await run(['text', at('form.pdf')])).stdout;
  assert.match(text, /Aybars YILDIRIM/);
});

/* ================================================================== */
/* stamp                                                              */
/* ================================================================== */

test('stamp: PNG damga üretir', async () => {
  const { code, stderr } = await run([
    'stamp', '-o', at('damga.png'), '--template', 'dual', '--name', 'Aybars YILDIRIM'
  ]);
  assert.strictEqual(code, 0, stderr);

  const png = fs.readFileSync(at('damga.png'));
  assert.strictEqual(png.toString('hex', 0, 8), '89504e470d0a1a0a', 'PNG imzası');
  assert.match(stderr, /damga \d+×\d+/);
});

/* ================================================================== */
/* Yayın hattı                                                        */
/* ================================================================== */

test('publish: paketler bağımlılık sırasına göre dizilir', () => {
  const { loadPackages, topoSort } = require('../../scripts/publish');

  const packages = loadPackages();
  assert.ok(packages.has('@fitfak/pades'));
  assert.ok(packages.has('@fitfak/conformance'));

  const order = topoSort(packages).map((p) => p.name);
  const position = new Map(order.map((name, i) => [name, i]));

  // Her paket, kendisine bağımlı olanlardan ÖNCE gelmeli
  for (const pkg of packages.values()) {
    for (const dep of pkg.deps) {
      if (!packages.has(dep)) continue;
      assert.ok(position.get(dep) < position.get(pkg.name),
        `${dep}, ${pkg.name} paketinden önce yayınlanmalı`);
    }
  }
  assert.strictEqual(order.length, packages.size);
});

test('publish: bağımlılık döngüsü açıkça bildirilir', () => {
  const { topoSort } = require('../../scripts/publish');

  const cyclic = new Map([
    ['@fitfak/a', { name: '@fitfak/a', version: '1.0.0', dir: '', deps: ['@fitfak/b'] }],
    ['@fitfak/b', { name: '@fitfak/b', version: '1.0.0', dir: '', deps: ['@fitfak/a'] }]
  ]);

  assert.throws(() => topoSort(cyclic), /Bağımlılık döngüsü/);
});
