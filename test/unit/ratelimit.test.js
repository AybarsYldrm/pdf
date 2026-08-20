'use strict';
/**
 * Hız sınırlayıcı depoları.
 *
 * SAYAÇ NEREDE DURUYORSA SINIR ORADA GEÇERLİDİR. Süreç belleğinde duran bir
 * sayaç, iki süreçli bir kurulumda sınırı ikiye katlar: rapor "dakikada 20
 * imza" der, gerçek 40'tır. Bu testler paylaşımlı depoyu GERÇEK ayrı
 * süreçlerle sınar — aynı süreçte iki nesne kurmak, dosya paylaşımını
 * kanıtlamazdı.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const policy = require('../../apps/server/src/policy');
const { MemoryStore, FileStore, RECORD } = require('../../apps/server/src/ratestore');

const ROOT = path.resolve(__dirname, '..', '..');
const dirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitfak-rate-'));
  dirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/* ================================================================== */
/* Ortak davranış                                                      */
/* ================================================================== */

for (const kind of ['memory', 'file']) {
  const make = () => (kind === 'memory'
    ? new policy.RateLimiter({ windowMs: 1000, store: new MemoryStore() })
    : new policy.RateLimiter({ windowMs: 1000, store: new FileStore({ dir: tempDir() }) }));

  test(`${kind}: sınıra kadar izin verir, sonra reddeder`, () => {
    const limiter = make();
    assert.strictEqual(limiter.hit('a', 3).allowed, true);
    assert.strictEqual(limiter.hit('a', 3).allowed, true);
    assert.strictEqual(limiter.hit('a', 3).allowed, true);

    const denied = limiter.hit('a', 3);
    assert.strictEqual(denied.allowed, false);
    assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 1000);
  });

  test(`${kind}: anahtarlar birbirini ETKİLEMEZ`, () => {
    const limiter = make();
    limiter.hit('a', 1);
    assert.strictEqual(limiter.hit('a', 1).allowed, false);
    assert.strictEqual(limiter.hit('b', 1).allowed, true);
  });

  test(`${kind}: pencere geçince kota yenilenir`, async () => {
    const limiter = new policy.RateLimiter({
      windowMs: 60,
      store: kind === 'memory' ? new MemoryStore() : new FileStore({ dir: tempDir() })
    });
    assert.strictEqual(limiter.hit('a', 1).allowed, true);
    assert.strictEqual(limiter.hit('a', 1).allowed, false);

    await new Promise((r) => setTimeout(r, 90));
    assert.strictEqual(limiter.hit('a', 1).allowed, true, 'pencere dışı vuruş sayılmamalı');
  });

  test(`${kind}: reddedilen istek sayaca YAZILMAZ`, () => {
    // Yazılsaydı, sürekli deneyen bir istemci pencereyi sonsuza dek
    // uzatır ve kendini kalıcı olarak kilitlerdi.
    const limiter = make();
    limiter.hit('a', 1);
    const first = limiter.hit('a', 1).retryAfterMs;
    const second = limiter.hit('a', 1).retryAfterMs;
    assert.ok(second <= first, 'bekleme süresi her denemede uzamamalı');
  });

  test(`${kind}: reset sayaçları temizler`, () => {
    const limiter = make();
    limiter.hit('a', 1);
    assert.strictEqual(limiter.hit('a', 1).allowed, false);
    limiter.reset();
    assert.strictEqual(limiter.hit('a', 1).allowed, true);
  });
}

/* ================================================================== */
/* Paylaşım                                                            */
/* ================================================================== */

test('dosya deposu: AYRI SÜREÇLER aynı sayacı görür', () => {
  const dir = tempDir();
  const script = path.join(dir, 'hit.js');
  fs.writeFileSync(script, `
    const policy = require(${JSON.stringify(path.join(ROOT, 'apps/server/src/policy'))});
    const limiter = new policy.RateLimiter();
    let allowed = 0;
    for (let i = 0; i < 10; i++) if (limiter.hit('ortak', 12).allowed) allowed++;
    process.stdout.write(String(allowed));
  `);

  const run = () => Number(execFileSync(process.execPath, [script], {
    env: { ...process.env, RATE_LIMIT_DIR: path.join(dir, 'sayac') }
  }).toString());

  const first = run();
  const second = run();

  assert.strictEqual(first, 10, 'ilk süreç kotanın 10 tanesini kullanmalı');
  assert.strictEqual(second, 2, 'ikinci süreç YALNIZ kalan 2 tanesini kullanabilmeli');
});

test('dosya deposu: bellek deposu SÜREÇLER ARASI paylaşmaz (kıyas)', () => {
  // Bu testin amacı sınırın neden paylaşımlı depoya ihtiyaç duyduğunu
  // belgelemektir: aynı senaryo bellek deposunda sınırı ikiye katlar.
  const dir = tempDir();
  const script = path.join(dir, 'hit.js');
  fs.writeFileSync(script, `
    const policy = require(${JSON.stringify(path.join(ROOT, 'apps/server/src/policy'))});
    const limiter = new policy.RateLimiter();
    let allowed = 0;
    for (let i = 0; i < 10; i++) if (limiter.hit('ortak', 12).allowed) allowed++;
    process.stdout.write(String(allowed));
  `);

  const env = { ...process.env };
  delete env.RATE_LIMIT_DIR;
  const run = () => Number(execFileSync(process.execPath, [script], { env }).toString());

  assert.strictEqual(run(), 10);
  assert.strictEqual(run(), 10, 'bellek deposunda her süreç kendi kotasını kullanır');
});

test('dosya deposu: RATE_LIMIT_DIR tanımlıysa kendiliğinden seçilir', () => {
  const dir = path.join(tempDir(), 'otomatik');
  const previous = process.env.RATE_LIMIT_DIR;
  process.env.RATE_LIMIT_DIR = dir;

  try {
    // Yapılandırma modül yüklenirken okunur; taze bir kopya gerekir.
    delete require.cache[require.resolve('../../apps/server/src/policy')];
    const fresh = require('../../apps/server/src/policy');
    const limiter = new fresh.RateLimiter();

    assert.strictEqual(limiter.describe().kind, 'file');
    assert.strictEqual(limiter.describe().shared, true);
    assert.strictEqual(fs.existsSync(dir), true, 'dizin kurulmalı');
  } finally {
    if (previous === undefined) delete process.env.RATE_LIMIT_DIR;
    else process.env.RATE_LIMIT_DIR = previous;
    delete require.cache[require.resolve('../../apps/server/src/policy')];
    require('../../apps/server/src/policy');
  }
});

/* ================================================================== */
/* Dayanıklılık                                                        */
/* ================================================================== */

test('dosya deposu: anahtar dosya adına ÇEVRİLMEZ, özetlenir', () => {
  // Anahtar istemciden gelir. Doğrudan yola yazmak dizin dışına çıkma
  // yüzeyi açardı.
  const dir = tempDir();
  const store = new FileStore({ dir });
  store.record('ip:../../../etc/passwd', Date.now(), 0, 5);

  const names = fs.readdirSync(dir);
  assert.strictEqual(names.length, 1);
  assert.match(names[0], /^[0-9a-f]{64}\.hit$/);
});

test('dosya deposu: yarım yazılmış kayıt sayacı bozmaz', () => {
  const dir = tempDir();
  const store = new FileStore({ dir });
  const now = Date.now();
  store.record('a', now, now - 1000, 5);

  // Yazma tam ortasında kesilmiş gibi 3 bayt ekle
  const file = fs.readdirSync(dir).find((n) => n.endsWith('.hit'));
  fs.appendFileSync(path.join(dir, file), Buffer.from([1, 2, 3]));

  const out = store.record('a', now, now - 1000, 5);
  assert.strictEqual(out.recorded, true);
  assert.strictEqual(out.hits.length, 2, 'yarım kayıt sayılmamalı');
});

test('dosya deposu: bozuk dizinde SESSİZCE serbest bırakmaz, bellek sayacına düşer', () => {
  const dir = tempDir();
  const store = new FileStore({ dir });

  // Dizini dosyaya çevir: artık hiçbir sayaç dosyası yazılamaz.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, 'engel');

  const now = Date.now();
  for (let i = 0; i < 3; i++) store.record('a', now, now - 1000, 3);
  const denied = store.record('a', now, now - 1000, 3);

  assert.strictEqual(denied.recorded, false, 'sınır uygulanmaya devam etmeli');
  assert.ok(store.failures > 0, 'başarısızlık sayılmalı');
  assert.strictEqual(store.describe().kind, 'file');
  assert.ok(store.describe().failures > 0, 'sağlık ucunda görünmeli');
});

test('dosya deposu: eski dosyalar süpürülür', () => {
  const dir = tempDir();
  const store = new FileStore({ dir });
  const old = Date.now() - 10_000;
  store.record('a', old, old - 1000, 5);

  const file = path.join(dir, fs.readdirSync(dir)[0]);
  fs.utimesSync(file, new Date(old), new Date(old));

  store.sweep(Date.now(), Date.now() - 1000);
  assert.strictEqual(fs.existsSync(file), false);
});

test('dosya deposu: dosya sınırın katına çıkınca sıkıştırılır', () => {
  const dir = tempDir();
  const store = new FileStore({ dir });
  const now = Date.now();

  // Pencere dışı 100 kayıt yaz
  const file = path.join(dir, fs.readdirSync(dir)[0] || 'yok');
  store.record('a', now - 10_000, now - 20_000, 100);
  const real = path.join(dir, fs.readdirSync(dir).find((n) => n.endsWith('.hit')));
  const stale = Buffer.alloc(100 * RECORD);
  for (let i = 0; i < 100; i++) stale.writeDoubleBE(now - 10_000, i * RECORD);
  fs.writeFileSync(real, stale);

  // Pencere içi tek vuruş: sayaç 1, dosya 100 kayıt → sıkıştırılmalı
  store.record('a', now, now - 1000, 20);
  assert.ok(fs.statSync(real).size <= 2 * RECORD,
    `sıkıştırılmalıydı: ${fs.statSync(real).size} bayt`);
});

test('sınırlayıcı: sağlık ucu için deposunu TANIMLAR', () => {
  const mem = new policy.RateLimiter({ store: new MemoryStore() });
  assert.deepStrictEqual(mem.describe(), { kind: 'memory', shared: false, keys: 0 });

  const file = new policy.RateLimiter({ store: new FileStore({ dir: tempDir() }) });
  const info = file.describe();
  assert.strictEqual(info.kind, 'file');
  assert.strictEqual(info.shared, true);
  assert.strictEqual(info.failures, 0);
});
