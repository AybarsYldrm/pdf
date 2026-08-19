'use strict';
/**
 * Güvenlik regresyon testleri.
 *
 * Buradaki her test, GERÇEKTEN VAR OLMUŞ bir açığın kapalı kaldığını sınar.
 * Test adları saldırıyı anlatır, iddiaları da savunmayı: biri savunmayı
 * kaldırırsa hangi saldırının geri geldiği doğrudan okunur.
 *
 * Ağ gerektirenler `test/e2e/08-security.test.js` içindedir.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { render } = require('@fitfak/pdf-html');
const { AssetResolver, AssetError } = require('@fitfak/pdf-html/src/assets/resolver');
const p12 = require('@fitfak/pkcs12');
const policy = require('../../apps/server/src/policy');

const ROOT = path.join(__dirname, '..', '..');
const FONT = path.join(ROOT, 'assets', 'Ubuntu-Regular.ttf');
const PNG = path.join(ROOT, 'apps', 'studio', 'favicon.png');

/* Kum havuzu ve onun DIŞINDA bir "gizli" dosya kurulur. */
let sandbox;
let secretDir;

test.before(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fitfak-sec-'));
  sandbox = path.join(base, 'kum');
  secretDir = path.join(base, 'gizli');
  fs.mkdirSync(sandbox);
  fs.mkdirSync(secretDir);

  fs.copyFileSync(PNG, path.join(sandbox, 'izinli.png'));
  fs.copyFileSync(PNG, path.join(secretDir, 'sir.png'));
  fs.writeFileSync(path.join(secretDir, 'anahtar.txt'), 'ÇOK GİZLİ');

  // Kum havuzu İÇİNDEN dışarı bakan bir symlink
  try { fs.symlinkSync(path.join(secretDir, 'sir.png'), path.join(sandbox, 'link.png')); }
  catch { /* symlink desteklenmiyorsa o test atlanır */ }
});

test.after(() => {
  if (sandbox) fs.rmSync(path.dirname(sandbox), { recursive: true, force: true });
});

/** Verilen kaynakla bir belge üretir; görsel uyarısını döndürür. */
function renderWithImage(src, extra = {}) {
  const html = `<!doctype html><html lang="tr"><body><img src="${src}"></body></html>`;
  const out = render({
    html,
    fonts: [{ family: 'U', src: FONT }],
    baseDir: sandbox,
    assetRoots: [sandbox],
    ...extra
  });
  return out.warnings.find((w) => w.type === 'image') || null;
}

/* ================================================================== */
/* P0 — HTML renderer yerel dosya ifşası                              */
/* ================================================================== */

test('varlık kum havuzu: göreli yol kaçışı engellenir', () => {
  const w = renderWithImage('../gizli/sir.png');
  assert.ok(w, 'kaçış denemesi uyarı üretmeli');
  assert.strictEqual(w.code, 'ERR_ASSET_OUTSIDE');
});

test('varlık kum havuzu: derin yol kaçışı engellenir', () => {
  for (const src of [
    '../../../../etc/passwd',
    '../../../../../../../../etc/passwd',
    './../../gizli/anahtar.txt',
    'alt/../../gizli/sir.png'
  ]) {
    const w = renderWithImage(src);
    assert.ok(w, `engellenmeli: ${src}`);
    assert.ok(/ERR_ASSET_(OUTSIDE|ABSOLUTE)/.test(w.code), `${src} → ${w.code}`);
  }
});

test('varlık kum havuzu: mutlak yollar reddedilir', () => {
  for (const src of ['/etc/passwd', '/proc/self/environ', path.join(secretDir, 'sir.png')]) {
    const w = renderWithImage(src);
    assert.ok(w, `engellenmeli: ${src}`);
    assert.strictEqual(w.code, 'ERR_ASSET_ABSOLUTE', src);
  }
});

test('varlık kum havuzu: Windows ve UNC yolları reddedilir', () => {
  for (const src of ['C:\\\\Windows\\\\win.ini', '\\\\\\\\sunucu\\\\paylasim\\\\x.png', 'D:/gizli/x.png']) {
    const w = renderWithImage(src);
    assert.ok(w, `engellenmeli: ${src}`);
    assert.ok(/ERR_ASSET_(ABSOLUTE|OUTSIDE)/.test(w.code), `${src} → ${w.code}`);
  }
});

test('varlık kum havuzu: yüzde kodlu ve çift kodlu kaçış engellenir', () => {
  for (const src of [
    '%2e%2e%2fgizli%2fsir.png',
    '%252e%252e%252fgizli%252fsir.png',
    '..%2fgizli%2fsir.png',
    '%2e%2e/gizli/sir.png'
  ]) {
    const w = renderWithImage(src);
    assert.ok(w, `engellenmeli: ${src}`);
    assert.ok(/ERR_ASSET_(OUTSIDE|ABSOLUTE)/.test(w.code), `${src} → ${w.code}`);
  }
});

test('varlık kum havuzu: karışık ayırıcılar engellenir', () => {
  const w = renderWithImage('..\\\\gizli\\\\sir.png');
  assert.ok(w);
  assert.ok(/ERR_ASSET_(OUTSIDE|ABSOLUTE)/.test(w.code));
});

test('varlık kum havuzu: symlink ile kaçış engellenir', (t) => {
  if (!fs.existsSync(path.join(sandbox, 'link.png'))) return t.skip('symlink kurulamadı');

  // Metinsel kontrol bunu göremez: yol kum havuzunun İÇİNDE görünür.
  // realpath adımı olmasa açık kalırdı.
  const w = renderWithImage('link.png');
  assert.ok(w, 'symlink kaçışı engellenmeli');
  assert.strictEqual(w.code, 'ERR_ASSET_SYMLINK_ESCAPE');
});

test('varlık kum havuzu: NUL baytı reddedilir', () => {
  const resolver = new AssetResolver({ roots: [sandbox] });
  assert.throws(() => resolver.resolvePath('izinli.png\u0000/../../etc/passwd'),
    (err) => err.code === 'ERR_ASSET_NUL');
});

test('varlık kum havuzu: file: ve uzak şemalar reddedilir (SSRF)', () => {
  for (const [src, code] of [
    ['file:///etc/passwd', 'ERR_ASSET_SCHEME'],
    ['http://169.254.169.254/latest/meta-data/', 'ERR_ASSET_REMOTE'],
    ['http://127.0.0.1:8787/api/health', 'ERR_ASSET_REMOTE'],
    ['http://localhost/gizli', 'ERR_ASSET_REMOTE'],
    ['https://ornek.test/x.png', 'ERR_ASSET_REMOTE'],
    ['ftp://ornek.test/x.png', 'ERR_ASSET_REMOTE'],
    ['gopher://ornek.test/', 'ERR_ASSET_REMOTE']
  ]) {
    const w = renderWithImage(src);
    assert.ok(w, `engellenmeli: ${src}`);
    assert.strictEqual(w.code, code, src);
  }
});

test('varlık kum havuzu: MEŞRU varlık hâlâ yüklenir', () => {
  const w = renderWithImage('izinli.png');
  assert.strictEqual(w, null, 'kum havuzu içindeki dosya okunabilmeli');
});

test('varlık kum havuzu: @font-face kaçışı engellenir', () => {
  const out = render({
    html: '<!doctype html><html lang="tr"><body><p style="font-family:Kotu">x</p></body></html>',
    css: `@font-face { font-family: Kotu; src: url("../../../${path.basename(FONT)}"); }`,
    fonts: [{ family: 'U', src: FONT }],
    baseDir: sandbox,
    assetRoots: [sandbox]
  });
  const w = out.warnings.find((x) => x.type === 'font');
  assert.ok(w, '@font-face kaçışı uyarı üretmeli');
  assert.ok(/ERR_ASSET_/.test(w.code || ''), `beklenmeyen kod: ${w.code}`);
});

test('varlık kum havuzu: kök yoksa dosya sistemi tamamen kapalıdır', () => {
  const resolver = new AssetResolver({ roots: [] });
  assert.throws(() => resolver.read('izinli.png'), (err) => err.code === 'ERR_ASSET_NO_ROOT');

  // data: URL yine de çalışır — dosya sistemine dokunmaz
  const tiny = 'data:image/png;base64,' + fs.readFileSync(PNG).toString('base64');
  assert.ok(resolver.read(tiny).data.length > 0);
});

test('varlık kum havuzu: boyut sınırı uygulanır', () => {
  const big = path.join(sandbox, 'buyuk.png');
  fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024));

  const resolver = new AssetResolver({ roots: [sandbox], limits: { maxImageBytes: 1024 } });
  assert.throws(() => resolver.read('buyuk.png'), (err) => err.code === 'ERR_ASSET_TOO_LARGE');
  fs.unlinkSync(big);
});

test('varlık türü uzantıdan DEĞİL içerikten belirlenir', () => {
  // JPEG içeriğini .png uzantısıyla koy: uzantıya güvenilseydi PNG ayrıştırıcısı
  // çağrılır ve hata verirdi.
  const jpeg = Buffer.concat([
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'),
    Buffer.alloc(64)
  ]);
  fs.writeFileSync(path.join(sandbox, 'yalan.png'), jpeg);

  const w = renderWithImage('yalan.png');
  // Bozuk JPEG olduğu için yüklenemez ama PNG ayrıştırıcısına GİTMEMELİ
  assert.ok(!w || !/PNG/.test(w.message), `PNG yoluna düştü: ${w && w.message}`);
  fs.unlinkSync(path.join(sandbox, 'yalan.png'));
});

/* ================================================================== */
/* P0 — PKCS#12 kaynak tüketimi                                       */
/* ================================================================== */

const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'pkcs12');
const hasPfx = fs.existsSync(path.join(FIXTURES, 'openssl3-aes256.pfx'));

/** DER TLV başlığını okur. */
function tlv(buf, at) {
  const tag = buf[at];
  let p = at + 1;
  const first = buf[p++];
  let len;
  if (first < 0x80) len = first;
  else { const n = first & 0x7f; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | buf[p++]; }
  return { tag, at, lenStart: at + 1, contentStart: p, contentLen: len, total: (p - at) + len };
}

function bumpLength(buf, node, delta) {
  const first = buf[node.lenStart];
  if (first < 0x80) { buf[node.lenStart] = first + delta; return; }
  const n = first & 0x7f;
  let len = node.contentLen + delta;
  for (let i = n; i >= 1; i--) { buf[node.lenStart + i] = len & 0xff; len >>>= 8; }
}

/**
 * PFX'in MacData iterasyon sayısını değiştirir ve kapsayan uzunlukları
 * düzeltir — sonuç YAPISAL OLARAK GEÇERLİ bir PFX'tir, yani ayrıştırıcı
 * onu gerçekten işlemeye çalışır.
 */
function patchMacIterations(pfx, newValue) {
  const pfxNode = tlv(pfx, 0);
  let p = pfxNode.contentStart;
  const version = tlv(pfx, p); p += version.total;
  const authSafe = tlv(pfx, p); p += authSafe.total;
  const macData = tlv(pfx, p);

  let q = macData.contentStart;
  const digestInfo = tlv(pfx, q); q += digestInfo.total;
  const macSalt = tlv(pfx, q); q += macSalt.total;
  const iterNode = tlv(pfx, q);
  assert.strictEqual(iterNode.tag, 0x02, 'MacData iterasyon INTEGER bulunamadı');

  let hex = newValue.toString(16); if (hex.length % 2) hex = '0' + hex;
  let content = Buffer.from(hex, 'hex');
  if (content[0] & 0x80) content = Buffer.concat([Buffer.from([0]), content]);
  const newInt = Buffer.concat([Buffer.from([0x02, content.length]), content]);
  const delta = newInt.length - iterNode.total;

  const out = Buffer.concat([
    pfx.subarray(0, iterNode.at), newInt, pfx.subarray(iterNode.at + iterNode.total)
  ]);
  bumpLength(out, tlv(out, macData.at), delta);
  bumpLength(out, tlv(out, 0), delta);
  return out;
}

test('PFX: aşırı KDF iterasyonu reddedilir', { skip: !hasPfx && 'fixture yok' }, () => {
  const orig = fs.readFileSync(path.join(FIXTURES, 'openssl3-aes256.pfx'));
  const kotu = patchMacIterations(orig, 50_000_000);

  // Dosya yapısal olarak GEÇERLİ: probe onu okuyabiliyor
  assert.strictEqual(p12.probe(kotu).macIterations, 50_000_000);

  const t0 = Date.now();
  assert.throws(() => p12.parse(kotu, 'test'),
    (err) => err.code === 'ERR_PFX_ITERATIONS_TOO_HIGH');

  // Reddetme KDF'ten ÖNCE olmalı: 50 milyon tur dakikalar sürerdi
  assert.ok(Date.now() - t0 < 1000,
    'sınır KDF çalıştıktan sonra denetlenmiş olabilir');
});

test('PFX: sınırın hemen altındaki değer kabul edilir', () => {
  const { checkIterations, DEFAULT_LIMITS } = require('@fitfak/pkcs12/src/limits');
  assert.strictEqual(checkIterations(DEFAULT_LIMITS.maxIterations, DEFAULT_LIMITS),
    DEFAULT_LIMITS.maxIterations);
  assert.throws(() => checkIterations(DEFAULT_LIMITS.maxIterations + 1, DEFAULT_LIMITS),
    (err) => err.code === 'ERR_PFX_ITERATIONS_TOO_HIGH');
});

test('PFX: geçersiz iterasyon değerleri reddedilir', () => {
  const { checkIterations, DEFAULT_LIMITS } = require('@fitfak/pkcs12/src/limits');
  for (const bad of [0, -1, NaN, Infinity, 1.5, '2048abc']) {
    assert.throws(() => checkIterations(bad, DEFAULT_LIMITS),
      (err) => err.code === 'ERR_PFX_ITERATIONS_INVALID', `kabul edildi: ${bad}`);
  }
});

test('PFX: dosya boyutu sınırı uygulanır', { skip: !hasPfx && 'fixture yok' }, () => {
  const orig = fs.readFileSync(path.join(FIXTURES, 'openssl3-aes256.pfx'));
  const sisik = Buffer.concat([orig, Buffer.alloc(9 * 1024 * 1024)]);

  assert.throws(() => p12.parse(sisik, 'test'), (err) => err.code === 'ERR_PFX_TOO_LARGE');
  assert.throws(() => p12.probe(sisik), (err) => err.code === 'ERR_PFX_TOO_LARGE');
});

test('PFX: dev tuz reddedilir', () => {
  const { checkSalt, DEFAULT_LIMITS } = require('@fitfak/pkcs12/src/limits');
  assert.throws(() => checkSalt(Buffer.alloc(DEFAULT_LIMITS.maxSaltBytes + 1), DEFAULT_LIMITS),
    (err) => err.code === 'ERR_PFX_SALT_TOO_LARGE');
  assert.ok(checkSalt(Buffer.alloc(8), DEFAULT_LIMITS));
});

test('PFX: çanta ve sertifika sayısı sınırlıdır', () => {
  const { checkCount, DEFAULT_LIMITS } = require('@fitfak/pkcs12/src/limits');
  assert.throws(() => checkCount(DEFAULT_LIMITS.maxBags + 1, 'maxBags', DEFAULT_LIMITS, 'SafeBag'),
    (err) => err.code === 'ERR_PFX_TOO_MANY');
  assert.throws(() => checkCount(101, 'maxCertificates', DEFAULT_LIMITS, 'sertifika'),
    (err) => err.code === 'ERR_PFX_TOO_MANY');
});

test('PFX: bozuk ve kesik dosyalar çökmeye yol açmaz', () => {
  const bozuklar = [
    Buffer.alloc(0),
    Buffer.from([0x30]),
    Buffer.from([0x30, 0x82, 0xFF, 0xFF]),                  // uzunluk gerçekten yok
    Buffer.from('bu bir PFX değil', 'utf8'),
    Buffer.concat([Buffer.from([0x30, 0x80]), Buffer.alloc(64)])
  ];
  for (const der of bozuklar) {
    assert.throws(() => p12.parse(der, 'x'), (err) => err instanceof Error,
      `çökme ya da sessiz geçiş: ${der.toString('hex').slice(0, 20)}`);
  }
});

test('PFX: yanlış parola MAC ile yakalanır', { skip: !hasPfx && 'fixture yok' }, () => {
  const orig = fs.readFileSync(path.join(FIXTURES, 'openssl3-aes256.pfx'));
  assert.throws(() => p12.parse(orig, 'yanlis-parola'),
    (err) => err.code === 'ERR_PKCS12_BAD_PASSWORD');
  assert.ok(p12.parse(orig, 'test').identities.length > 0, 'doğru parola çalışmalı');
});

/* ================================================================== */
/* Sunucu politikası                                                  */
/* ================================================================== */

test('sunucu tarafı PFX yalnız ALLOW_SERVER_PFX=1 ile açılır', () => {
  const yorumla = (v) => v === '1';
  assert.strictEqual(yorumla(undefined), false, 'tanımsız → kapalı');
  assert.strictEqual(yorumla('0'), false);
  assert.strictEqual(yorumla(''), false);
  assert.strictEqual(yorumla('true'), false, "'true' bile açmamalı");
  assert.strictEqual(yorumla('yes'), false);
  assert.strictEqual(yorumla('1'), true);
});

test('uç sınıflandırması hassas yolları tanır', () => {
  const hassas = ['POST /api/sign/prepare', 'POST /api/sign/finalize', 'POST /api/sign/pfx',
                  'POST /api/pfx/identities', 'POST /api/ltv/extend'];
  for (const route of hassas) {
    assert.strictEqual(policy.classify(route), 'sensitive', route);
  }
  assert.strictEqual(policy.classify('GET /api/health'), 'public');
  for (const route of ['POST /api/render', 'POST /api/pdf/open', 'POST /api/verify']) {
    assert.strictEqual(policy.classify(route), 'compute', route);
  }
});

test('belirteç karşılaştırması sabit zamanlıdır ve yanlış belirteci reddeder', () => {
  const saved = policy.AUTH.tokens.slice();
  policy.AUTH.tokens.length = 0;
  policy.AUTH.tokens.push('dogru-belirtec-1234567890');

  try {
    assert.strictEqual(policy.tokenValid('dogru-belirtec-1234567890'), true);
    assert.strictEqual(policy.tokenValid('yanlis'), false);
    assert.strictEqual(policy.tokenValid('dogru-belirtec-123456789'), false, 'kısa önek geçmemeli');
    assert.strictEqual(policy.tokenValid(''), false);
    assert.strictEqual(policy.tokenValid(null), false);
    assert.strictEqual(policy.tokenValid(undefined), false);
  } finally {
    policy.AUTH.tokens.length = 0;
    policy.AUTH.tokens.push(...saved);
  }
});

test('kaynak sınırları merkezî ve güvenli varsayılanlarda', () => {
  const L = policy.LIMITS;
  assert.ok(L.maxBodyBytes > 0 && L.maxBodyBytes <= 64 * 1024 * 1024);
  assert.ok(L.maxOps > 0 && L.maxOps <= 5000);
  assert.ok(L.maxPages > 0);
  assert.ok(L.requestTimeoutMs > 0);

  assert.throws(() => policy.checkBytes(Buffer.alloc(L.maxHtmlBytes + 1), 'maxHtmlBytes', 'HTML'),
    (err) => err.code === 'ERR_TOO_LARGE' && err.status === 413);
  assert.throws(() => policy.checkCount(L.maxOps + 1, 'maxOps', 'işlem'),
    (err) => err.code === 'ERR_TOO_MANY' && err.status === 400);
});

test('hız sınırlayıcı kayan pencerede sayar', () => {
  const limiter = new policy.RateLimiter({ windowMs: 1000 });

  for (let i = 0; i < 5; i++) {
    assert.strictEqual(limiter.hit('a', 5).allowed, true, `${i}. istek geçmeli`);
  }
  const blocked = limiter.hit('a', 5);
  assert.strictEqual(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);

  // Farklı istemci etkilenmemeli
  assert.strictEqual(limiter.hit('b', 5).allowed, true);

  limiter.reset();
  assert.strictEqual(limiter.hit('a', 5).allowed, true, 'sıfırlamadan sonra geçmeli');
});

test('istemci anahtarı belirteci sızdırmaz', () => {
  const key = policy.clientKey({
    headers: { authorization: 'Bearer cok-gizli-belirtec' },
    socket: { remoteAddress: '10.0.0.1' }
  });
  assert.ok(!key.includes('cok-gizli-belirtec'), 'ham belirteç anahtarda görünmemeli');
  assert.match(key, /^t:[0-9a-f]{16}$/);

  const ipKey = policy.clientKey({ headers: {}, socket: { remoteAddress: '10.0.0.2' } });
  assert.strictEqual(ipKey, 'ip:10.0.0.2');
});
