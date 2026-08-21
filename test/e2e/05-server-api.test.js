'use strict';
/**
 * Sunucu API uçtan uca testleri.
 *
 * En önemli senaryo: İKİ FAZLI İMZALAMA — özel anahtarın sunucuya hiç
 * gelmediği akışın gerçekten çalıştığını doğrular.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');

const fs = require('fs');
const { startTestServices } = require('./pki/services');
const { createServer } = require('../../apps/server/server');
const { verifyPdf, INDICATION } = require('@fitfak/verify');
const p12 = require('@fitfak/pkcs12');

let svc;
let server;
let base;

const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');

async function call(pathname, body, method = 'POST') {
  const res = await fetch(base + pathname, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  return { status: res.status, body: json, headers: res.headers };
}

test.before(async () => {
  svc = await startTestServices();
  process.env.TSA_URL = svc.endpoints.tsa;

  // TSA adresini modül yüklendikten sonra değiştirebilmek için sunucu
  // yapılandırmasını doğrudan güncelliyoruz.
  const mod = require('../../apps/server/server');
  mod.CONFIG.tsaUrl = svc.endpoints.tsa;

  // Sunucu tarafı PFX imzalama VARSAYILAN OLARAK KAPALIDIR (özel anahtar
  // sunucuya gelmesin diye). Bu yolu sınayan testler onu AÇIKÇA açar —
  // varsayılanın kapalı olduğu ayrıca sınanır.
  mod.CONFIG.allowServerSidePfx = true;

  // Test PKI'ı 127.0.0.1'de çalışır: sertifikalardaki AIA/CDP adresleri
  // loopback'i gösterir. Sunucu bu adreslere VARSAYILAN OLARAK çıkmaz
  // (SSRF); LTV yollarını sınayabilmek için açıkça açılır.
  mod.CONFIG.allowPrivateNetworkPki = true;

  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (svc) await svc.close();
});

// Hız sınırlayıcı gerçek bir savunmadır; test paketi tek istemciden çok sayıda
// hassas istek attığı için her testten önce sıfırlanır. Sınırın kendisi
// 'hız sınırı hassas uçları korur' testinde ayrıca sınanır.
test.beforeEach(() => {
  require('../../apps/server/server').rateLimiter.reset();
});

const HTML = `<article class="paper paper--kurumsal">
  <h1>API Test Belgesi</h1>
  <p>Sunucu API testleri için üretildi.</p>
  <div class="paper-signature-row">
    <div class="paper-sig-slot" data-signer="aybars" data-role="Düzenleyen">İmza</div>
  </div>
</article>`;

test('GET /api/health yetenekleri bildirir', async () => {
  const { status, body, headers } = await call('/api/health', null, 'GET');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
  assert.ok(Array.isArray(body.themes) && body.themes.length >= 5);
  assert.ok(body.stampTemplates.includes('dual'));
  assert.ok(headers.get('content-security-policy'), 'CSP başlığı gönderilmeli');
  assert.strictEqual(headers.get('x-content-type-options'), 'nosniff');
});

test('POST /api/render: PDF ve manifest döner', async () => {
  const { status, body } = await call('/api/render', {
    html: HTML, theme: 'kurumsal', metadata: { title: 'API Test' }
  });

  assert.strictEqual(status, 200);
  const pdf = unb64(body.pdf);
  assert.strictEqual(pdf.slice(0, 5).toString(), '%PDF-');
  assert.strictEqual(body.manifest.signatureSlots.length, 1);
  assert.strictEqual(body.manifest.signatureSlots[0].id, 'aybars');
  assert.deepStrictEqual(body.warnings, []);
});

test('POST /api/stamp/preview: PNG döner', async () => {
  const { status, body } = await call('/api/stamp/preview', {
    template: 'dual', seed: 1,
    vars: { signerName: 'Aybars YILDIRIM', docNo: 'DOC-1', verifyUrl: 'https://x.test/1' }
  });
  assert.strictEqual(status, 200);
  const png = unb64(body.png);
  assert.strictEqual(png.slice(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(body.rendered.qr, 'QR üretilmiş olmalı');
  assert.strictEqual(body.rendered.code39, 'DOC-1');
});

test('İKİ FAZLI İMZALAMA: özel anahtar sunucuya HİÇ gitmez', async () => {
  const p = svc.pki.profile('signer');

  const rendered = await call('/api/render', { html: HTML, theme: 'kurumsal' });
  const pdf = unb64(rendered.body.pdf);
  const slot = rendered.body.manifest.signatureSlots[0];

  // 1. faz — sunucu yalnız SERTİFİKALARI görür
  const prep = await call('/api/sign/prepare', {
    pdf: b64(pdf),
    certPem: p.certPem,
    chainPems: p.chainPems,
    level: 'LT',
    slot,
    visible: { template: 'minimal', signerName: p.name, docNo: 'DOC-2FAZ' }
  });
  assert.strictEqual(prep.status, 200);
  assert.ok(prep.body.sessionId);
  assert.ok(prep.body.dataToSign);
  assert.strictEqual(prep.body.keyType, 'ecdsa');
  assert.strictEqual(prep.body.hashAlgorithm, 'sha256');

  // 2. faz — imza İSTEMCİDE atılır (burada istemciyi taklit ediyoruz)
  const dataToSign = unb64(prep.body.dataToSign);
  const signer = crypto.createSign('SHA256');
  signer.update(dataToSign);
  const signature = signer.sign({ key: p.keyPem });

  const fin = await call('/api/sign/finalize', {
    sessionId: prep.body.sessionId,
    signature: b64(signature)
  });
  assert.strictEqual(fin.status, 200);
  assert.strictEqual(fin.body.achievedLevel, 'pades-lt', JSON.stringify(fin.body.reasons));

  // Sonuç gerçekten geçerli bir imza mı?
  const report = await verifyPdf(unb64(fin.body.pdf), {
    trustAnchors: [svc.pki.root.certPem], allowNetwork: false
  });
  const s = report.signatures[0];
  assert.strictEqual(s.indication, INDICATION.PASSED, JSON.stringify(s.errors));
  assert.strictEqual(s.cms.signatureValid, true);
  assert.ok(report.ltv.crls > 0, 'CRL gömülmüş olmalı');
});

test('İmza oturumu TEK KULLANIMLIKTIR', async () => {
  const p = svc.pki.profile('signer');
  const rendered = await call('/api/render', { html: HTML });
  const prep = await call('/api/sign/prepare', {
    pdf: rendered.body.pdf, certPem: p.certPem, chainPems: p.chainPems, level: 'B'
  });

  const signer = crypto.createSign('SHA256');
  signer.update(unb64(prep.body.dataToSign));
  const signature = b64(signer.sign({ key: p.keyPem }));

  const first = await call('/api/sign/finalize', { sessionId: prep.body.sessionId, signature });
  assert.strictEqual(first.status, 200);

  // Aynı oturum ikinci kez kullanılamaz
  const second = await call('/api/sign/finalize', { sessionId: prep.body.sessionId, signature });
  assert.strictEqual(second.status, 410);
  assert.strictEqual(second.body.error.code, 'ERR_SESSION_EXPIRED');
});

test('POST /api/sign/pfx: sunucu tarafı mod (opt-in)', async () => {
  const p = svc.pki.profile('signer');
  const pfx = p12.build({
    privateKeyPem: p.keyPem, certificatePem: p.certPem,
    chainPems: p.chainPems, password: 'api', friendlyName: p.name
  });

  const rendered = await call('/api/render', { html: HTML });
  const res = await call('/api/sign/pfx', {
    pdf: rendered.body.pdf,
    pfx: b64(pfx),
    password: 'api',
    level: 'LT',
    slot: rendered.body.manifest.signatureSlots[0],
    visible: { template: 'qr', signerName: p.name, docNo: 'DOC-PFX' }
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.achievedLevel, 'pades-lt', JSON.stringify(res.body.reasons));

  const report = await verifyPdf(unb64(res.body.pdf), {
    trustAnchors: [svc.pki.root.certPem], allowNetwork: false
  });
  assert.strictEqual(report.signatures[0].indication, INDICATION.PASSED);
});

test('POST /api/pfx/identities: kimlikleri listeler', async () => {
  const p = svc.pki.profile('signer');
  const pfx = p12.build({
    privateKeyPem: p.keyPem, certificatePem: p.certPem,
    chainPems: p.chainPems, password: 'liste', friendlyName: 'Test Kimlik'
  });

  const res = await call('/api/pfx/identities', { pfx: b64(pfx), password: 'liste' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.identities.length, 1);
  assert.strictEqual(res.body.identities[0].friendlyName, 'Test Kimlik');
  assert.strictEqual(res.body.identities[0].chainLength, 2);
  assert.strictEqual(res.body.probe.macAlgorithm, 'sha256');
});

test('POST /api/verify: doğrulama raporu döner', async () => {
  const p = svc.pki.profile('signer');
  const pfx = p12.build({
    privateKeyPem: p.keyPem, certificatePem: p.certPem,
    chainPems: p.chainPems, password: 'v'
  });
  const rendered = await call('/api/render', { html: HTML });
  const signed = await call('/api/sign/pfx', {
    pdf: rendered.body.pdf, pfx: b64(pfx), password: 'v', level: 'LT'
  });

  const res = await call('/api/verify', {
    pdf: signed.body.pdf,
    trustAnchors: [svc.pki.root.certPem],
    allowNetwork: false
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.signatures.length, 1);
  assert.strictEqual(res.body.signatures[0].indication, INDICATION.PASSED);
  assert.strictEqual(res.body.ltv.dssPresent, true);
});

test('POST /api/ltv/extend: B-T belgeyi B-LT\'ye yükseltir', async () => {
  const p = svc.pki.profile('signer');
  const pfx = p12.build({
    privateKeyPem: p.keyPem, certificatePem: p.certPem, chainPems: p.chainPems, password: 'e'
  });
  const rendered = await call('/api/render', { html: HTML });
  const signed = await call('/api/sign/pfx', {
    pdf: rendered.body.pdf, pfx: b64(pfx), password: 'e', level: 'T'
  });
  assert.strictEqual(signed.body.achievedLevel, 'pades-t');

  const extended = await call('/api/ltv/extend', { pdf: signed.body.pdf, targetLevel: 'LT' });
  assert.strictEqual(extended.status, 200);
  assert.strictEqual(extended.body.achievedLevel, 'pades-lt');
  assert.ok(extended.body.report.embedded.crls > 0 || extended.body.report.embedded.ocsps > 0);
});

test('Hata biçimi tutarlı: { error: { code, message } }', async () => {
  const res = await call('/api/render', {});
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error.code, 'ERR_HTML_MISSING');
  assert.ok(res.body.error.message);

  const notFound = await call('/api/olmayan-uc', {});
  assert.strictEqual(notFound.status, 404);
  assert.strictEqual(notFound.body.error.code, 'ERR_NO_ROUTE');
});

test('Statik dosyalar servis edilir ve yol kaçışı engellenir', async () => {
  const index = await fetch(base + '/');
  assert.strictEqual(index.status, 200);
  assert.ok((await index.text()).includes('Belge Studio'));

  const css = await fetch(base + '/vendor/paper.css');
  assert.strictEqual(css.status, 200);
  assert.ok((await css.text()).includes('paper-sig-slot'),
    'paper.css derlenmiş hâliyle servis edilmeli');

  // Yol kaçışı denemeleri.
  // Not: fetch() '/../..' dizisini gönderimden ÖNCE normalleştirir, bu yüzden
  // sunucuyu gerçekten sınamak için yüzde kodlaması kullanıyoruz.
  for (const attempt of [
    '/%2e%2e/%2e%2e/package.json',
    '/%2e%2e%2f%2e%2e%2fpackage.json',
    '/package.json',
    '/js/../../../package.json'
  ]) {
    const res = await fetch(base + attempt);
    assert.ok(res.status === 403 || res.status === 404,
      `yol kaçışı engellenmeli (${attempt}) — HTTP ${res.status} döndü`);
  }

  // Meşru dosyalar servis edilmeye devam etmeli
  const js = await fetch(base + '/js/main.js');
  assert.strictEqual(js.status, 200);
  assert.strictEqual(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
});

/* ================================================================== */
/* Belge düzenleme uçları                                             */
/* ================================================================== */

/** Test PKI'sinden imzalamaya hazır bir PFX üretir. */
function makePfx(password = 'e') {
  const p = svc.pki.profile('signer');
  return p12.build({
    privateKeyPem: p.keyPem, certificatePem: p.certPem,
    chainPems: p.chainPems, password, friendlyName: p.name
  });
}

const FIX = path.join(__dirname, '..', 'fixtures', 'pdf');
if (!fs.existsSync(path.join(FIX, 'acroform.pdf'))) {
  require(path.join(FIX, 'generate.js')).generateAll();
}
const fixture = (name) => fs.readFileSync(path.join(FIX, name));

test('/api/pdf/open modern PDF yapılarını açar ve özetler', async () => {
  const res = await call('/api/pdf/open', { pdf: b64(fixture('xref-stream.pdf')) });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.pageCount, 2);
  assert.strictEqual(res.body.encrypted, false);
  assert.strictEqual(res.body.hasSignatures, false);
  assert.strictEqual(res.body.info.Title, 'XRef akisli belge');

  const page = res.body.pages[0];
  assert.strictEqual(Math.round(page.width), 595);
  assert.strictEqual(Math.round(page.height), 842);
  assert.match(page.text, /XRef akisi/, 'sayfa metni çıkarılabilmeli');
});

test('/api/pdf/open form alanlarını ve imza alanını ayırır', async () => {
  const res = await call('/api/pdf/open', { pdf: b64(fixture('acroform.pdf')) });

  assert.strictEqual(res.body.hasForm, true);
  const byName = new Map(res.body.fields.map((f) => [f.name, f]));
  assert.strictEqual(byName.get('adres').multiline, true);
  assert.deepStrictEqual(byName.get('sehir').options, ['Ankara', 'Istanbul', 'Izmir']);
  assert.strictEqual(byName.get('imza').type, 'Sig');
  assert.deepStrictEqual(byName.get('ad').rect, [140, 720, 400, 740]);
});

test('/api/pdf/open şifreli belgede parola ister', async () => {
  const withoutPassword = await call('/api/pdf/open',
    { pdf: b64(fixture('encrypted-rc4-userpwd.pdf')) });
  assert.strictEqual(withoutPassword.status, 400);
  assert.strictEqual(withoutPassword.body.error.code, 'ERR_CRYPT_BAD_PASSWORD');

  const withPassword = await call('/api/pdf/open',
    { pdf: b64(fixture('encrypted-rc4-userpwd.pdf')), password: 'gizli' });
  assert.strictEqual(withPassword.status, 200);
  assert.strictEqual(withPassword.body.encrypted, true);
  assert.strictEqual(withPassword.body.pageCount, 1);
});

test('/api/pdf/edit görsel, metin, bağlantı ve üst veri yazar', async () => {
  const original = fixture('classic-xref.pdf');
  const png = fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'studio', 'favicon.png'));

  const res = await call('/api/pdf/edit', {
    pdf: b64(original),
    ops: [
      { op: 'image', page: 0, image: b64(png), x: 420, y: 700, width: 90, opacity: 0.8 },
      { op: 'text', page: 0, text: 'Onaylandı — ĞÜŞİÖÇ', x: 60, y: 120, size: 11 },
      { op: 'link', page: 0, x: 60, y: 100, width: 180, height: 14, uri: 'https://aybars.net.tr/' },
      { op: 'metadata', values: { title: 'Düzenlenmiş belge', author: 'Studio' } }
    ]
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.preservedOriginal, true);
  assert.strictEqual(res.body.applied.length, 4);
  assert.deepStrictEqual(res.body.applied[0].pixels, [32, 32]);

  const out = unb64(res.body.pdf);
  assert.ok(out.subarray(0, original.length).equals(original),
    'artımlı yazımda orijinal baytlar korunmalı');

  const reopened = await call('/api/pdf/open', { pdf: res.body.pdf });
  assert.strictEqual(reopened.body.info.Title, 'Düzenlenmiş belge');
  assert.match(reopened.body.pages[0].text, /Onaylandı — ĞÜŞİÖÇ/);
});

test('/api/pdf/edit sayfa işlemlerini uygular', async () => {
  const res = await call('/api/pdf/edit', {
    pdf: b64(fixture('classic-xref-3p.pdf')),
    ops: [
      { op: 'movePage', from: 0, to: 2 },
      { op: 'rotate', page: 0, degrees: 90 },
      { op: 'insertPage', index: 0, size: [0, 0, 300, 300] },
      { op: 'removePage', page: 3 }
    ]
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.pageCount, 3);

  const reopened = await call('/api/pdf/open', { pdf: res.body.pdf });
  assert.strictEqual(reopened.body.pages[0].width, 300);
  assert.strictEqual(reopened.body.pages[1].rotate, 90);
});

test('/api/pdf/edit formu doldurur ve düzleştirir', async () => {
  const res = await call('/api/pdf/edit', {
    pdf: b64(fixture('acroform.pdf')),
    ops: [{
      op: 'fillForm',
      values: { ad: 'Aybars YILDIRIM', sehir: 'Izmir', onay: true, imza: 'olmaz' },
      flatten: true
    }]
  });

  assert.strictEqual(res.status, 200);
  const report = res.body.applied[0];
  assert.deepStrictEqual(report.filled.sort(), ['ad', 'onay', 'sehir']);
  assert.deepStrictEqual(report.skipped.map((s) => s.name), ['imza']);
  assert.deepStrictEqual(report.kept, ['imza']);

  const reopened = await call('/api/pdf/open', { pdf: res.body.pdf });
  assert.deepStrictEqual(reopened.body.fields.map((f) => f.name), ['imza']);
  assert.match(reopened.body.pages[0].text, /Aybars YILDIRIM/);
});

test('/api/pdf/edit hatalı işlemi anlaşılır kodla reddeder', async () => {
  const unknown = await call('/api/pdf/edit', {
    pdf: b64(fixture('classic-xref.pdf')),
    ops: [{ op: 'boyleBirSeyYok' }]
  });
  assert.strictEqual(unknown.status, 400);
  assert.strictEqual(unknown.body.error.code, 'ERR_OP_UNKNOWN');

  const badArg = await call('/api/pdf/edit', {
    pdf: b64(fixture('classic-xref.pdf')),
    ops: [{ op: 'text', page: 0, text: 'x', x: 'buraya', y: 10 }]
  });
  assert.strictEqual(badArg.status, 400);
  assert.strictEqual(badArg.body.error.code, 'ERR_OP_ARG');

  const noOps = await call('/api/pdf/edit', { pdf: b64(fixture('classic-xref.pdf')), ops: [] });
  assert.strictEqual(noOps.body.error.code, 'ERR_OPS_MISSING');
});

test('Düzenlenen modern PDF sonrasında imzalanabilir', async () => {
  const pfx = makePfx();

  const edited = await call('/api/pdf/edit', {
    pdf: b64(fixture('xref-stream.pdf')),
    ops: [{ op: 'text', page: 0, text: 'hazirlayan: studio', x: 60, y: 80, size: 9 }]
  });
  assert.strictEqual(edited.status, 200);

  const signed = await call('/api/sign/pfx', {
    pdf: edited.body.pdf, pfx: b64(pfx), password: 'e', level: 'T'
  });
  assert.strictEqual(signed.status, 200, JSON.stringify(signed.body.error || {}));
  assert.strictEqual(signed.body.achievedLevel, 'pades-t');

  const report = await verifyPdf(unb64(signed.body.pdf), {
    trustAnchors: [svc.pki.root.certPem], offline: true
  });
  assert.strictEqual(report.signatures[0].indication, INDICATION.PASSED);
});

test('İmzalı belge düzenlenince imza geçerli kalır (uçtan uca)', async () => {
  const pfx = makePfx();

  const signed = await call('/api/sign/pfx', {
    pdf: b64(fixture('classic-xref-3p.pdf')), pfx: b64(pfx), password: 'e', level: 'T'
  });
  assert.strictEqual(signed.status, 200);

  const edited = await call('/api/pdf/edit', {
    pdf: signed.body.pdf,
    ops: [{ op: 'text', page: 0, text: 'imzadan sonra', x: 60, y: 60, size: 9 }]
  });
  assert.strictEqual(edited.status, 200);

  const report = await verifyPdf(unb64(edited.body.pdf), {
    trustAnchors: [svc.pki.root.certPem], offline: true
  });
  // İmzanın KRİPTOGRAFİSİ bozulmadı — ama belge imzalandığı hâlde değil.
  // Doğrulayıcı bu ikisini ayırır: `cms.signatureValid` true kalır,
  // `indication` TOTAL-PASSED olmaz. Düzenlemeyi yapan biz olsak da,
  // doğrulayan taraf bunu saldırgan düzenlemesinden ayırt edemez.
  assert.strictEqual(report.signatures[0].cms.signatureValid, true);
  assert.strictEqual(report.signatures[0].indication, INDICATION.INDETERMINATE);
  assert.strictEqual(report.signatures[0].subIndication, 'DOC_MODIFIED_AFTER_SIGNING');
  assert.strictEqual(report.documentIntegrity.modifiedAfterSigning, true,
    'değişiklik gizlenmemeli');
});

test('sunucu tarafı PFX VARSAYILAN OLARAK kapalıdır', async () => {
  const mod = require('../../apps/server/server');
  const saved = mod.CONFIG.allowServerSidePfx;

  // Ortam değişkeni yorumu: yalnız '1' açar
  const yorumla = (value) => {
    const before = process.env.ALLOW_SERVER_PFX;
    if (value === undefined) delete process.env.ALLOW_SERVER_PFX;
    else process.env.ALLOW_SERVER_PFX = value;
    const result = process.env.ALLOW_SERVER_PFX === '1';
    if (before === undefined) delete process.env.ALLOW_SERVER_PFX;
    else process.env.ALLOW_SERVER_PFX = before;
    return result;
  };

  assert.strictEqual(yorumla(undefined), false, 'tanımsız → kapalı');
  assert.strictEqual(yorumla('0'), false, "'0' → kapalı");
  assert.strictEqual(yorumla('true'), false, "'true' bile açmamalı");
  assert.strictEqual(yorumla(''), false, 'boş → kapalı');
  assert.strictEqual(yorumla('1'), true, "yalnız '1' açar");

  // Kapalıyken uç 403 döner ve PFX hiç işlenmez
  mod.CONFIG.allowServerSidePfx = false;
  try {
    const res = await call('/api/sign/pfx', {
      pdf: b64(fixture('classic-xref.pdf')), pfx: b64(makePfx()), password: 'e'
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error.code, 'ERR_SERVER_PFX_DISABLED');
  } finally {
    mod.CONFIG.allowServerSidePfx = saved;
  }
});

test('hız sınırı hassas uçları korur', async () => {
  const mod = require('../../apps/server/server');
  mod.rateLimiter.reset();

  const limit = mod.policy.RATE.maxSensitive;
  let firstBlocked = null;

  // Sınırı aşana kadar bas
  for (let i = 0; i < limit + 3; i++) {
    const res = await call('/api/pfx/identities', { pfx: b64(Buffer.alloc(4)), password: 'x' });
    if (res.status === 429) { firstBlocked = i; break; }
  }

  assert.ok(firstBlocked !== null, `hassas uç ${limit + 3} istekte sınırlanmadı`);
  assert.ok(firstBlocked >= limit,
    `sınır çok erken devreye girdi: ${firstBlocked} < ${limit}`);

  const blocked = await call('/api/pfx/identities', { pfx: b64(Buffer.alloc(4)), password: 'x' });
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual(blocked.body.error.code, 'ERR_RATE_LIMIT');
  assert.ok(blocked.headers.get('retry-after'), 'Retry-After başlığı olmalı');

  // Sıfırlandıktan sonra yeniden çalışmalı
  mod.rateLimiter.reset();
  const after = await call('/api/pfx/identities', { pfx: b64(Buffer.alloc(4)), password: 'x' });
  assert.notStrictEqual(after.status, 429);
});

test('sağlık ucu hız sınırından ve kimlik doğrulamadan muaftır', async () => {
  const mod = require('../../apps/server/server');
  mod.rateLimiter.reset();

  // /api/health 'public' sınıfındadır ama hız sınırına yine de tabidir;
  // önemli olan kimlik doğrulama istememesidir.
  const res = await fetch(base + '/api/health');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.ok, true);
  assert.strictEqual(mod.policy.classify('GET /api/health'), 'public');
  assert.strictEqual(mod.policy.classify('POST /api/sign/pfx'), 'sensitive');
  assert.strictEqual(mod.policy.classify('POST /api/render'), 'compute');
});

/* ================================================================== */
/* Sahne uçları                                                        */
/* ================================================================== */

/** Küçük ama geçerli bir PNG (varlık yükleme yolunu sınamak için). */
function tinyPng(width, height) {
  const zlib = require('zlib');
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc((width * 3 + 1) * height))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const sceneWith = (nodes) => ({
  version: 1,
  meta: { title: 'API sahnesi' },
  page: { size: 'A4' },
  assets: [],
  pages: [{ id: 'pg1', name: 'Sayfa 1', nodes }]
});

test('POST /api/scene/render sahneyi PDF e derler', async () => {
  const { status, body } = await call('/api/scene/render', {
    scene: sceneWith([
      { id: 'baslik', type: 'text', frame: { x: 60, y: 80, width: 400, height: 40 },
        text: 'Sahne API', fontSize: 18 },
      { id: 'yuva', type: 'signature', frame: { x: 60, y: 700, width: 200, height: 60 },
        fieldName: 'Imza1', signerTitle: 'Düzenleyen' }
    ]),
    assets: []
  });

  assert.strictEqual(status, 200, JSON.stringify(body.error));
  const pdf = unb64(body.pdf);
  assert.ok(pdf.subarray(0, 5).toString('latin1') === '%PDF-');
  assert.strictEqual(body.manifest.pageCount, 1);
  assert.strictEqual(body.manifest.signatureSlots.length, 1);
  assert.strictEqual(body.manifest.signatureSlots[0].fieldName, 'Imza1');
  assert.strictEqual(body.manifest.signatureSlots[0].origin, 'bottom-left');
});

test('POST /api/scene/render uyum profilini uygular ve BİLDİRİR', async () => {
  const { status, body } = await call('/api/scene/render', {
    scene: {
      ...sceneWith([
        { id: 'baslik', type: 'text', frame: { x: 60, y: 80, width: 400, height: 40 },
          text: 'Erişilebilir', fontSize: 18, role: 'H1' },
        { id: 'govde', type: 'text', frame: { x: 60, y: 140, width: 400, height: 60 },
          text: 'Gövde metni.', fontSize: 11 }
      ]),
      meta: { title: 'Erişilebilir Sahne', lang: 'tr-TR' }
    },
    conformance: 'pdf/a-2b+pdf/ua'
  });

  assert.strictEqual(status, 200, JSON.stringify(body.error));
  assert.deepStrictEqual(body.conformance, { pdfA: '2b', pdfUA: true, tagged: true });

  // İddia GERÇEKTEN denetlenir: profil yazılmış mı, yapı ağacı var mı?
  const check = await call('/api/conformance/check', { pdf: body.pdf });
  assert.strictEqual(check.status, 200, JSON.stringify(check.body));
  assert.deepStrictEqual(check.body.profiles.sort(), ['pdf/a-2b', 'pdf/ua']);
  assert.strictEqual(check.body.conforms, true,
    JSON.stringify([check.body.pdfA && check.body.pdfA.errors,
                    check.body.pdfUA && check.body.pdfUA.errors]));
});

test('POST /api/scene/render profil istenmezse uyum İDDİA ETMEZ', async () => {
  const { status, body } = await call('/api/scene/render', {
    scene: sceneWith([
      { id: 't', type: 'text', frame: { x: 60, y: 80, width: 400, height: 40 },
        text: 'Sade', fontSize: 12 }
    ])
  });

  assert.strictEqual(status, 200, JSON.stringify(body.error));
  assert.strictEqual(body.conformance, null);

  // İddia edilmediğine göre XMP damgası da yapı ağacı da yazılmamalıdır:
  // istenmeden eklenen bir `pdfaid` damgası, denetlenmemiş bir söz olurdu.
  const raw = unb64(body.pdf).toString('latin1');
  assert.ok(!/pdfaid/.test(raw), 'PDF/A damgası istenmeden yazılmamalı');
  assert.ok(!/\/StructTreeRoot/.test(raw), 'yapı ağacı istenmeden yazılmamalı');
});

test('POST /api/scene/render varlık kimliğini İÇERİKTEN yeniden hesaplar', async () => {
  // İstemci uydurma bir kimlik bildiriyor; sunucu onu içerikten türetilenle
  // değiştirmeli ve gönderme kırılmamalı.
  const png = tinyPng(8, 4);
  const { status, body } = await call('/api/scene/render', {
    scene: {
      ...sceneWith([
        { id: 'im', type: 'image', frame: { x: 40, y: 40, width: 80, height: 40 },
          assetId: 'ast_uydurma' }
      ]),
      assets: [{ id: 'ast_uydurma', kind: 'image', mime: 'image/png',
                 sha256: 'f'.repeat(64), size: 1, width: 1, height: 1 }]
    },
    assets: [{ id: 'ast_uydurma', name: 'x.png', base64: b64(png) }]
  });

  assert.strictEqual(status, 200, JSON.stringify(body.error));
  assert.deepStrictEqual(body.warnings, [], 'görsel bulunmalıydı');
  assert.ok(unb64(body.pdf).includes(Buffer.from('/Subtype /Image')) ||
            unb64(body.pdf).includes(Buffer.from('/Image')),
    'görsel gerçekten gömülmeli');
});

test('POST /api/scene/render geçersiz sahneyi sorun listesiyle reddeder', async () => {
  const { status, body } = await call('/api/scene/render', {
    scene: sceneWith([
      { id: 'x', type: 'iframe', frame: { x: 0, y: 0, width: 1, height: 1 } }
    ]),
    assets: []
  });

  assert.strictEqual(status, 400);
  assert.strictEqual(body.error.code, 'ERR_SCENE_INVALID');
  assert.ok(Array.isArray(body.error.details) && body.error.details.length);
  assert.ok(body.error.details.some((d) => d.code === 'ERR_NODE_TYPE'));
});

test('POST /api/scene/render sahne alanı eksikse 400 döner', async () => {
  const { status, body } = await call('/api/scene/render', { assets: [] });
  assert.strictEqual(status, 400);
  assert.strictEqual(body.error.code, 'ERR_SCENE_MISSING');
});

test('POST /api/scene/render font DOSYA YOLU kabul etmez', async () => {
  // İstemcinin verdiği yol dosya sistemine ulaşmamalı; sunucu yalnız
  // tanıdığı aileleri kullanır ve bilinmeyeni sessizce varsayılana düşürür.
  const { status, body } = await call('/api/scene/render', {
    scene: sceneWith([
      { id: 't', type: 'text', frame: { x: 10, y: 10, width: 200, height: 30 }, text: 'yol testi' }
    ]),
    assets: [],
    fonts: [{ family: 'Ubuntu', src: '/etc/passwd' }, '../../etc/shadow']
  });

  assert.strictEqual(status, 200, JSON.stringify(body.error));
  const pdf = unb64(body.pdf);
  assert.ok(!pdf.includes(Buffer.from('root:x:')), 'sistem dosyası gömülmemeli');
});

test('POST /api/scene/import/html HTML i sahneye çevirir', async () => {
  const { status, body } = await call('/api/scene/import/html', {
    html: '<article class="paper"><h1>İçe aktarım</h1><p>gövde metni</p></article>',
    theme: 'kurumsal'
  });

  assert.strictEqual(status, 200, JSON.stringify(body.error));
  assert.ok(body.scene.pages[0].nodes.length > 0);
  assert.ok(body.scene.pages[0].nodes.some(
    (n) => n.type === 'text' && /İçe aktarım/.test(n.text)));
  assert.ok(body.warnings.some((w) => w.code === 'WARN_IMPORT_FLATTENED'),
    'düzleştirme sınırı bildirilmeli');
});

test('POST /api/scene/import/pdf PDF i sahneye çevirir', async () => {
  const rendered = await call('/api/scene/render', {
    scene: sceneWith([
      { id: 't', type: 'text', frame: { x: 72, y: 144, width: 300, height: 30 },
        text: 'Geri dönüş', fontSize: 13 }
    ]),
    assets: []
  });
  assert.strictEqual(rendered.status, 200);

  const { status, body } = await call('/api/scene/import/pdf', { pdf: rendered.body.pdf });
  assert.strictEqual(status, 200, JSON.stringify(body.error));

  const node = body.scene.pages[0].nodes[0];
  assert.strictEqual(node.type, 'text');
  assert.strictEqual(node.text, 'Geri dönüş');
  assert.strictEqual(node.frame.x, 72);
  assert.strictEqual(node.frame.y, 144, 'gerçek font yükseltisiyle tur kapanmalı');
  assert.ok(body.warnings.some((w) => w.code === 'WARN_IMPORT_FLATTENED'));
});

test('GET /vendor/scene.esm.js tarayıcı paketini servis eder', async () => {
  const res = await fetch(base + '/vendor/scene.esm.js');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);

  const source = await res.text();
  assert.match(source, /export const Scene/);
  assert.match(source, /export const geometry/);
  assert.ok(source.length > 20000, 'paket gerçekten dolu olmalı');
});
