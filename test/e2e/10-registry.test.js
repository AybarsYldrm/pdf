'use strict';
/**
 * İMZA → KAYIT → TARAYICI zinciri.
 *
 * Karekod tarayıcısı belgeyi görmez, yalnız bir özet görür. Doğrulamanın
 * gerçekten yapılıp yapılmadığı bu zincirin ucundan anlaşılır: imzalanan
 * belge deftere yazılmalı, tarayıcı onu bulmalı, DEĞİŞTİRİLEN belge
 * bulunamamalıdır.
 *
 * Testler defteri gerçek bir dizinde kurar ve iki AYRI sunucuyu (imza ve
 * tarayıcı) aynı deftere bağlar — tek süreçte paylaşılan bir nesneyi
 * sınamak, dosya üzerinden paylaşımın çalıştığını göstermezdi.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startTestServices } = require('./pki/services');
const p12 = require('@fitfak/pkcs12');
const { documentHash } = require('@fitfak/registry');

let svc;
let api;
let scanner;
let registryDir;

const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');

const HTML = `<article class="paper paper--kurumsal">
  <h1>Kayıt Defteri Testi</h1>
  <p>İmzalanan belge deftere yazılmalı.</p>
</article>`;

test.before(async () => {
  registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitfak-reg-e2e-'));
  process.env.REGISTRY_DIR = registryDir;
  process.env.REGISTRY_KEY = 'e2e-kayit-anahtari-123456';

  svc = await startTestServices();
  process.env.TSA_URL = svc.endpoints.tsa;

  // Sunucu doğrulamayı KENDİ güven çapalarıyla yapar. Çapa verilmezse sonuç
  // "karar verilemedi" olur — bu da doğru davranıştır ve ayrıca sınanır.
  const anchor = path.join(registryDir, 'kok.pem');
  fs.writeFileSync(anchor, svc.pki.root.certPem);
  process.env.TRUST_ANCHORS = anchor;

  // Modüller ortam değişkenlerini yüklenirken okur; taze kopyalar gerekir.
  for (const mod of ['../../apps/server/server', '../../apps/server/src/policy',
    '../../apps/scanner/server']) {
    delete require.cache[require.resolve(mod)];
  }

  const serverMod = require('../../apps/server/server');
  serverMod.CONFIG.tsaUrl = svc.endpoints.tsa;
  serverMod.CONFIG.allowServerSidePfx = true;
  const server = serverMod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  api = { mod: serverMod, server, base: `http://127.0.0.1:${server.address().port}` };

  const scannerMod = require('../../apps/scanner/server');
  const scannerServer = scannerMod.createServer();
  await new Promise((r) => scannerServer.listen(0, '127.0.0.1', r));
  scanner = {
    mod: scannerMod, server: scannerServer,
    base: `http://127.0.0.1:${scannerServer.address().port}`
  };
});

test.after(async () => {
  if (api) await new Promise((r) => api.server.close(r));
  if (scanner) await new Promise((r) => scanner.server.close(r));
  if (svc) await svc.close();
  if (registryDir) fs.rmSync(registryDir, { recursive: true, force: true });

  delete process.env.REGISTRY_DIR;
  delete process.env.REGISTRY_KEY;
  for (const mod of ['../../apps/server/server', '../../apps/server/src/policy',
    '../../apps/scanner/server']) {
    delete require.cache[require.resolve(mod)];
  }
});

test.beforeEach(() => { api.mod.rateLimiter.reset(); });

async function call(base, pathname, body) {
  const res = await fetch(base + pathname, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}

/** Sunucu tarafı PFX yoluyla imzalar ve imzalı PDF'i döndürür. */
async function signDocument(docNo) {
  const profile = svc.pki.profile('signer');
  const pfx = p12.build({
    privateKeyPem: profile.keyPem, certificatePem: profile.certPem,
    chainPems: profile.chainPems, password: 'kayit', friendlyName: profile.name
  });

  const rendered = await call(api.base, '/api/render', { html: HTML, theme: 'kurumsal' });
  const signed = await call(api.base, '/api/sign/pfx', {
    pdf: rendered.body.pdf,
    pfx: b64(pfx),
    password: 'kayit',
    level: 'LT',
    visible: { template: 'minimal', signerName: profile.name, docNo }
  });

  assert.strictEqual(signed.status, 200, JSON.stringify(signed.body.error));
  return { pdf: unb64(signed.body.pdf), response: signed.body };
}

const verify = (query) => call(scanner.base, '/api/verify', query);

/* ================================================================== */

test('imza atılınca belge deftere YAZILIR', async () => {
  const { pdf, response } = await signDocument('DOC-KAYIT-1');

  assert.ok(response.registry, 'yanıt kayıt bilgisini taşımalı');
  assert.strictEqual(response.registry.documentHash, documentHash(pdf),
    'kayıt anahtarı imzalı belgenin özeti olmalı');
  assert.ok(response.registry.seq >= 1);
});

test('tarayıcı kayıtlı belgeyi ÖZETİYLE bulur', async () => {
  const { pdf } = await signDocument('DOC-KAYIT-2');

  const r = await verify({ hash: documentHash(pdf) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'verified', JSON.stringify(r.body));
  assert.match(r.body.signer || '', /YILDIRIM|signer|İmza/i);
  assert.ok(r.body.signedAt, 'imza zamanı bildirilmeli');
  assert.ok(r.body.scope, 'kaydın KAPSAMI cevabın içinde olmalı');
});

test('tarayıcı belge NUMARASIYLA da bulur (karekod adres taşır)', async () => {
  await signDocument('DOC-KAYIT-3');

  const r = await verify({ docNo: 'DOC-KAYIT-3' });
  assert.strictEqual(r.body.status, 'verified', JSON.stringify(r.body));
  assert.strictEqual(r.body.docNo, 'DOC-KAYIT-3');
});

test('DEĞİŞTİRİLMİŞ belge kayıtta bulunamaz', async () => {
  const { pdf } = await signDocument('DOC-KAYIT-4');

  // Tek bayt değişir: özet değişir, kayıt tutmaz.
  const tampered = Buffer.from(pdf);
  tampered[Math.floor(tampered.length / 2)] ^= 0x01;

  const r = await verify({ hash: documentHash(tampered) });
  assert.strictEqual(r.body.status, 'unverified',
    'değiştirilmiş belge "doğrulandı" dememeli');
});

/* ================================================================== */
/* Karekod nakli (QR transplant)                                       */
/* ================================================================== */

test('dosyanın kendisi verilirse özet HESAPLANIR (binding: computed)', async () => {
  const { pdf } = await signDocument('DOC-BAG-1');

  const r = await verify({ pdf: b64(pdf) });
  assert.strictEqual(r.body.status, 'verified', JSON.stringify(r.body));
  assert.strictEqual(r.body.binding, 'computed',
    'dosya görüldüyse bağ hesaplanmış olmalı');
  assert.strictEqual(r.body.documentId, documentHash(pdf));
});

test('yalnız kimlikle sorgu "claimed" olarak işaretlenir', async () => {
  const { pdf } = await signDocument('DOC-BAG-2');

  const r = await verify({ hash: documentHash(pdf) });
  assert.strictEqual(r.body.status, 'verified');
  assert.strictEqual(r.body.binding, 'claimed',
    'dosya görülmediyse cevap ELDEKİ belge hakkında değildir');
  assert.match(r.body.scope, /karekod başka bir belgeden/i,
    'bu sınır cevabın içinde yazmalı');
});

test('KAREKOD NAKLİ: gerçek karekod sahte belgeye yapıştırılamaz', async () => {
  // Saldırı: gerçek, imzalı bir belgenin karekodu kesilip sahte bir belgeye
  // yapıştırılır. Yalnız kimliğe bakan bir tarayıcı "doğrulandı" der — üstelik
  // gerçek imzalayanın adıyla. Bunu kapatan tek şey, özetin ELDEKİ DOSYADAN
  // hesaplanmasıdır.
  const { pdf: gercek } = await signDocument('DOC-NAKIL');
  const sahte = Buffer.concat([gercek, Buffer.from('\n% sahte belge\n', 'latin1')]);

  const r = await verify({
    hash: documentHash(gercek),        // karekodun taşıdığı kimlik: GERÇEK
    pdf: b64(sahte)                    // elde tutulan dosya: SAHTE
  });

  assert.strictEqual(r.body.status, 'invalid', JSON.stringify(r.body));
  assert.strictEqual(r.body.binding, 'mismatch');
  assert.match(r.body.message, /uyuşmuyor/i);
  assert.strictEqual(r.body.documentId, documentHash(sahte),
    'cevap ELDEKİ dosyanın kimliğini bildirmeli');
  assert.strictEqual(r.body.claimedId, documentHash(gercek));
});

test('kayıtsız belge için "kayıtlı değil" denir, "geçersiz" denmez', async () => {
  const r = await verify({ hash: crypto.randomBytes(32).toString('hex') });
  assert.strictEqual(r.body.status, 'unverified');
  assert.match(r.body.message, /kayıtlı değil/i);
});

test('sağlık ucu defterin durumunu BİLDİRİR', async () => {
  const r = await call(api.base, '/api/health');
  assert.strictEqual(r.body.registry.enabled, true);
  assert.strictEqual(r.body.registry.intact, true);
  assert.ok(r.body.registry.records >= 1);
});

test('defter KURCALANIRSA tarayıcı hiçbir kaydı onaylamaz', async () => {
  const { pdf } = await signDocument('DOC-KAYIT-5');
  const hash = documentHash(pdf);

  // Önce bulunuyor
  assert.strictEqual((await verify({ hash })).body.status, 'verified');

  const file = path.join(registryDir, 'registry.log');
  const original = fs.readFileSync(file, 'utf8');
  try {
    const lines = original.trim().split('\n');
    const forged = JSON.parse(lines[0]);
    forged.signer = 'Sahtekâr';
    fs.writeFileSync(file, [JSON.stringify(forged), ...lines.slice(1)].join('\n') + '\n');

    const r = await verify({ hash });
    assert.strictEqual(r.body.status, 'unavailable',
      'defter bozuksa hiçbir kayıt kanıt değildir');
    assert.match(r.body.message, /bütünlüğü bozuk/i);
  } finally {
    fs.writeFileSync(file, original);
  }
});

test('güven çapası yoksa "doğrulandı" değil "karar verilemedi" denir', async () => {
  // Doğrulama zinciri kurulamadığında imza SAHTE değildir; bilinmiyordur.
  // İkisini aynı kefeye koymak, eksik yapılandırmayı sahtecilik ilan eder.
  const policy = require('../../apps/server/src/policy');
  const original = policy.trustAnchors;
  policy.trustAnchors = () => [];

  try {
    const { pdf } = await signDocument('DOC-CAPASIZ');
    const r = await verify({ hash: documentHash(pdf) });
    assert.strictEqual(r.body.status, 'indeterminate', JSON.stringify(r.body));
    assert.match(r.body.message, /karar verilemedi/i);
  } finally {
    policy.trustAnchors = original;
  }
});

test('defter tarayıcı tarafından YAZILAMAZ (yalnız okuma)', async () => {
  // Tarayıcı ucu yalnız sorgular; hiçbir girdi deftere kayıt EKLEYEMEZ.
  const before = fs.readFileSync(path.join(registryDir, 'registry.log'), 'utf8');
  await verify({ hash: 'a'.repeat(64) });
  await verify({ docNo: 'UYDURMA' });
  const after = fs.readFileSync(path.join(registryDir, 'registry.log'), 'utf8');

  assert.strictEqual(after, before, 'sorgu defteri değiştirmemeli');
});
