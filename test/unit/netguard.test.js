'use strict';
/**
 * SSRF savunması: adres denetimi ve uzak varlık getirici.
 *
 * Uzak varlık desteği açıldığında sunucu, saldırganın ulaşamadığı yerlere
 * ulaşabilir hâle gelir. Bu testler, o kapının kapalı kaldığını gösterir.
 *
 * Ağ testleri YEREL bir HTTP sunucusuna karşı yapılır; dışarı çıkılmaz.
 * Yerel sunucuya bağlanabilmek için denetim `allowPrivate` ile bilinçli
 * olarak gevşetilir — o bayrak yalnız testlerde ve yalnız kasten verilir.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const {
  inspectAddress, resolveSafeUrl, matchHost, NetGuardError
} = require('@fitfak/netguard');
const { fetchRemoteAsset } = require('@fitfak/netguard');
const { AssetResolver } = require('@fitfak/pdf-html/src/assets/resolver');

const hasCode = (code) => (err) => err && err.code === code;

/* ================================================================== */
/* Adres denetimi                                                      */
/* ================================================================== */

test('adres: bulut üstveri adresi engellenir', () => {
  // Tek başına en çok istismar edilen SSRF hedefi
  const verdict = inspectAddress('169.254.169.254');
  assert.strictEqual(verdict.safe, false);
  assert.match(verdict.reason, /169\.254/);
});

test('adres: özel, geri döngü ve ayrılmış IPv4 blokları engellenir', () => {
  const blocked = [
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.5', '10.255.255.255',
    '172.16.0.1', '172.31.255.254', '192.168.1.1', '169.254.1.1',
    '100.64.0.1', '198.18.0.1', '192.0.2.1', '203.0.113.9',
    '224.0.0.1', '255.255.255.255'
  ];
  for (const ip of blocked) {
    assert.strictEqual(inspectAddress(ip).safe, false, `${ip} engellenmeliydi`);
  }
});

test('adres: genel IPv4 adresleri geçer', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '11.0.0.1']) {
    assert.strictEqual(inspectAddress(ip).safe, true, `${ip} geçmeliydi`);
  }
});

test('adres: 172.16/12 sınırları doğru hesaplanır', () => {
  // Blok 172.16.0.0 – 172.31.255.255'tir; 172.15 ve 172.32 DIŞARIDADIR.
  assert.strictEqual(inspectAddress('172.15.255.255').safe, true);
  assert.strictEqual(inspectAddress('172.16.0.0').safe, false);
  assert.strictEqual(inspectAddress('172.31.255.255').safe, false);
  assert.strictEqual(inspectAddress('172.32.0.0').safe, true);
});

test('adres: IPv6 geri döngü, link-local, ULA ve çoklu gönderim engellenir', () => {
  const blocked = ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1'];
  for (const ip of blocked) {
    assert.strictEqual(inspectAddress(ip).safe, false, `${ip} engellenmeliydi`);
  }
  assert.strictEqual(inspectAddress('2606:4700:4700::1111').safe, true);
});

test('adres: IPv4-EŞLENMİŞ IPv6 savunmayı delemez', () => {
  // `http://[::ffff:127.0.0.1]/` klasik bir atlatma denemesidir
  for (const ip of ['::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:10.0.0.1']) {
    const verdict = inspectAddress(ip);
    assert.strictEqual(verdict.safe, false, `${ip} engellenmeliydi`);
    assert.match(verdict.reason, /eşlenmiş/i);
  }
  assert.strictEqual(inspectAddress('::ffff:8.8.8.8').safe, true);
});

test('adres: 6to4 ve NAT64 içindeki gömülü IPv4 denetlenir', () => {
  // 2002:7f00:0001:: → 127.0.0.1
  assert.strictEqual(inspectAddress('2002:7f00:1::').safe, false);
  // 64:ff9b::a9fe:a9fe → 169.254.169.254
  assert.strictEqual(inspectAddress('64:ff9b::a9fe:a9fe').safe, false);
});

test('adres: IP olmayan girdi güvenli sayılmaz', () => {
  for (const bad of ['', 'localhost', 'ornek.test', '999.1.1.1', 'zzz']) {
    assert.strictEqual(inspectAddress(bad).safe, false, `${bad} güvenli sayılmamalı`);
  }
});

/* ================================================================== */
/* URL denetimi                                                        */
/* ================================================================== */

/** Sahte DNS: ad → adres listesi. */
const fakeLookup = (map) => async (host) => {
  if (!map[host]) { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
  return map[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

test('URL: yalnız http ve https kabul edilir', async () => {
  for (const url of ['ftp://ornek.test/x', 'gopher://ornek.test/', 'file:///etc/passwd']) {
    await assert.rejects(() => resolveSafeUrl(url), hasCode('ERR_NET_SCHEME'));
  }
});

test('URL: kimlik bilgisi taşıyan adres reddedilir', async () => {
  await assert.rejects(
    () => resolveSafeUrl('http://kullanici:parola@ornek.test/x'),
    hasCode('ERR_NET_CREDENTIALS'));
});

test('URL: ad ÇÖZÜLÜR ve dönen adres denetlenir', async () => {
  // Saldırı: masum görünen bir ad, 127.0.0.1'e çözülüyor
  await assert.rejects(
    () => resolveSafeUrl('http://masum.test/logo.png', {
      lookup: fakeLookup({ 'masum.test': ['127.0.0.1'] })
    }),
    hasCode('ERR_NET_BLOCKED_ADDRESS'));

  const ok = await resolveSafeUrl('http://iyi.test/logo.png', {
    lookup: fakeLookup({ 'iyi.test': ['93.184.216.34'] })
  });
  assert.strictEqual(ok.address, '93.184.216.34');
  assert.strictEqual(ok.url.hostname, 'iyi.test');
});

test('URL: adreslerden BİRİ bile kötüyse tamamı reddedilir', async () => {
  // Saldırgan hem iyi hem kötü adres yayınlayıp yarışı kazanmayı umar
  await assert.rejects(
    () => resolveSafeUrl('http://karisik.test/x', {
      lookup: fakeLookup({ 'karisik.test': ['93.184.216.34', '127.0.0.1'] })
    }),
    hasCode('ERR_NET_BLOCKED_ADDRESS'));
});

test('URL: çözülemeyen ad açık hatayla reddedilir', async () => {
  await assert.rejects(
    () => resolveSafeUrl('http://yok.test/x', { lookup: fakeLookup({}) }),
    hasCode('ERR_NET_DNS'));
});

test('URL: doğrudan IP yazmak denetimi atlatmaz', async () => {
  await assert.rejects(() => resolveSafeUrl('http://169.254.169.254/latest/meta-data/'),
    hasCode('ERR_NET_BLOCKED_ADDRESS'));
  await assert.rejects(() => resolveSafeUrl('http://[::1]:8080/admin'),
    hasCode('ERR_NET_BLOCKED_ADDRESS'));
});

test('URL: izin ve yasak listeleri uygulanır', async () => {
  const lookup = fakeLookup({ 'cdn.ornek.test': ['93.184.216.34'], 'baska.test': ['8.8.8.8'] });

  await assert.rejects(
    () => resolveSafeUrl('http://baska.test/x', { lookup, allowHosts: ['*.ornek.test'] }),
    hasCode('ERR_NET_HOST_NOT_ALLOWED'));

  const ok = await resolveSafeUrl('http://cdn.ornek.test/x', {
    lookup, allowHosts: ['*.ornek.test']
  });
  assert.strictEqual(ok.address, '93.184.216.34');

  await assert.rejects(
    () => resolveSafeUrl('http://cdn.ornek.test/x', { lookup, denyHosts: ['cdn.ornek.test'] }),
    hasCode('ERR_NET_HOST_DENIED'));
});

test('URL: joker eşleşmesi alt alanı kapsar, kendisini de', () => {
  assert.strictEqual(matchHost('cdn.ornek.test', '*.ornek.test'), true);
  assert.strictEqual(matchHost('ornek.test', '*.ornek.test'), true);
  assert.strictEqual(matchHost('kotuornek.test', '*.ornek.test'), false);
  assert.strictEqual(matchHost('ORNEK.TEST', 'ornek.test'), true);
});

/* ================================================================== */
/* Getirici — yerel sunucuya karşı                                     */
/* ================================================================== */

/** Küçük ama geçerli bir PNG. */
function png(width = 4, height = 4) {
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

let server;
let base;
const hits = [];

test.before(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url);
    const url = req.url;

    if (url === '/logo.png') {
      const body = png(8, 6);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length });
      return res.end(body);
    }
    if (url === '/yonlendir') {
      return res.writeHead(302, { Location: '/logo.png' }).end();
    }
    if (url === '/kotu-yonlendirme') {
      // Denetimi atlatma denemesi: güvenli bir adresten üstveri adresine
      return res.writeHead(302, { Location: 'http://169.254.169.254/latest/' }).end();
    }
    if (url === '/donen-yonlendirme') {
      return res.writeHead(302, { Location: '/donen-yonlendirme' }).end();
    }
    if (url === '/html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<h1>görsel değil</h1>');
    }
    if (url === '/uzunluksuz') {
      // `Content-Length` YOK (chunked). Ön kontrol yapılamaz; sınırın AKIŞTA
      // uygulanması gerekir — saldırganın tercih ettiği biçim tam da budur.
      res.writeHead(200, { 'Content-Type': 'image/png' });
      for (let i = 0; i < 30; i++) res.write(Buffer.alloc(20_000, 0x41));
      return res.end();
    }
    if (url === '/buyuk') {
      const body = Buffer.alloc(300_000, 0x42);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length });
      return res.end(body);
    }
    if (url === '/yavas') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return;                                  // hiç bitirmiyor
    }
    if (url === '/hata') {
      return res.writeHead(500).end('olmadı');
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => { if (server) await new Promise((r) => server.close(r)); });

/** Yerel sunucuya bağlanabilmek için denetim bilinçli olarak gevşetilir. */
const local = (extra = {}) => ({ allowPrivate: true, ...extra });

test('getirici: geçerli görseli indirir', async () => {
  const out = await fetchRemoteAsset(`${base}/logo.png`, local());
  assert.strictEqual(out.contentType, 'image/png');
  assert.ok(out.data.length > 40);
  assert.strictEqual(out.data.subarray(1, 4).toString('latin1'), 'PNG');
});

test('getirici: yönlendirmeyi takip eder', async () => {
  const out = await fetchRemoteAsset(`${base}/yonlendir`, local());
  assert.strictEqual(out.contentType, 'image/png');
});

test('getirici: yönlendirme DENETİMİ ATLATAMAZ', async () => {
  // Sunucu güvenli, hedefi değil. Her halka sıfırdan denetlenir.
  await assert.rejects(
    () => fetchRemoteAsset(`${base}/kotu-yonlendirme`, { allowPrivate: false }),
    (err) => err.code === 'ERR_NET_BLOCKED_ADDRESS' || err.code === 'ERR_NET_DNS');
});

test('getirici: yönlendirme döngüsü sınırlanır', async () => {
  await assert.rejects(
    () => fetchRemoteAsset(`${base}/donen-yonlendirme`, local({ maxRedirects: 2 })),
    hasCode('ERR_REMOTE_TOO_MANY_REDIRECTS'));
});

test('getirici: beklenmeyen içerik türü reddedilir', async () => {
  await assert.rejects(() => fetchRemoteAsset(`${base}/html`, local()),
    hasCode('ERR_REMOTE_CONTENT_TYPE'));
});

test('getirici: Content-Length YOKKEN sınır akışta uygulanır', async () => {
  // Ön kontrol imkânsız; tek savunma akışı saymaktır.
  await assert.rejects(
    () => fetchRemoteAsset(`${base}/uzunluksuz`, local({ maxBytes: 50_000 })),
    hasCode('ERR_REMOTE_TOO_LARGE'));
});

test('getirici: bildirilen büyük boyut baştan reddedilir', async () => {
  await assert.rejects(
    () => fetchRemoteAsset(`${base}/buyuk`, local({ maxBytes: 1000 })),
    hasCode('ERR_REMOTE_TOO_LARGE'));
});

test('getirici: zaman aşımı uygulanır', async () => {
  await assert.rejects(
    () => fetchRemoteAsset(`${base}/yavas`, local({ timeoutMs: 300 })),
    hasCode('ERR_REMOTE_TIMEOUT'));
});

test('getirici: 200 dışı durum hata verir', async () => {
  await assert.rejects(() => fetchRemoteAsset(`${base}/hata`, local()),
    hasCode('ERR_REMOTE_STATUS'));
});

/* ================================================================== */
/* Kum havuzuyla tümleşme                                              */
/* ================================================================== */

test('kum havuzu: uzak kaynak VARSAYILAN olarak kapalı', async () => {
  const resolver = new AssetResolver({ roots: [] });
  const stats = await resolver.prefetch([`${base}/logo.png`]);
  assert.strictEqual(stats.fetched, 0);
  assert.strictEqual(stats.failed, 1);

  assert.throws(() => resolver.read(`${base}/logo.png`, { kind: 'image' }),
    hasCode('ERR_ASSET_REMOTE'));
});

test('kum havuzu: açıldığında uzak görsel okunabilir ve piksel sınırı işler', async () => {
  const resolver = new AssetResolver({
    roots: [], allowRemote: true, remote: { allowPrivate: true }
  });
  const stats = await resolver.prefetch([`${base}/logo.png`]);
  assert.strictEqual(stats.fetched, 1);

  const out = resolver.read(`${base}/logo.png`, { kind: 'image' });
  assert.strictEqual(out.source, 'remote');
  assert.strictEqual(out.info.width, 8);
  assert.strictEqual(out.info.height, 6);
});

test('kum havuzu: önceden indirilmemiş uzak kaynak açıkça bildirilir', () => {
  const resolver = new AssetResolver({ roots: [], allowRemote: true });
  assert.throws(() => resolver.read('https://ornek.test/x.png', { kind: 'image' }),
    hasCode('ERR_ASSET_REMOTE_NOT_PREFETCHED'));
});

test('kum havuzu: indirme hatası tek varlıkta kalır, belgeyi düşürmez', async () => {
  const resolver = new AssetResolver({
    roots: [], allowRemote: true, remote: { allowPrivate: true }
  });
  const stats = await resolver.prefetch([`${base}/logo.png`, `${base}/hata`]);
  assert.strictEqual(stats.fetched, 1);
  assert.strictEqual(stats.failed, 1);

  assert.doesNotThrow(() => resolver.read(`${base}/logo.png`, { kind: 'image' }));
  assert.throws(() => resolver.read(`${base}/hata`, { kind: 'image' }),
    hasCode('ERR_REMOTE_STATUS'));
});

test('kum havuzu: uzak kaynak sayısı sınırlıdır', async () => {
  const resolver = new AssetResolver({
    roots: [], allowRemote: true, remote: { allowPrivate: true, maxRemote: 1 }
  });
  const stats = await resolver.prefetch([`${base}/logo.png`, `${base}/yonlendir`]);
  assert.strictEqual(stats.fetched, 1);
  assert.strictEqual(stats.failed, 1);
});

/* ================================================================== */
/* renderAsync                                                         */
/* ================================================================== */

test('renderAsync: uzak görsel belgeye gömülür', async () => {
  const path = require('path');
  const { renderAsync, collectRemoteRefs } = require('@fitfak/pdf-html');

  const refs = collectRemoteRefs(
    `<p><img src="${base}/logo.png"></p>`, ['body { background: url(https://a.test/b.png); }']);
  assert.strictEqual(refs.size, 2);

  const out = await renderAsync({
    html: `<p>Uzak görsel:</p><p><img src="${base}/logo.png" width="40" height="30"></p>`,
    fonts: [{ family: 'Ubuntu', src: path.resolve(__dirname, '../../assets/Ubuntu-Regular.ttf') }],
    assetRoots: [path.resolve(__dirname, '../../assets')],
    allowRemoteAssets: true,
    remote: { allowPrivate: true }
  });

  assert.ok(out.pdf.length > 1000);
  const imageWarnings = out.warnings.filter((w) => /ASSET|REMOTE/.test(w.code || ''));
  assert.deepStrictEqual(imageWarnings, [], JSON.stringify(out.warnings));
  assert.match(out.pdf.toString('latin1'), /\/Subtype \/Image/);
});

test('renderAsync: uzak kaynak kapalıyken uyarı verir ama belge üretilir', async () => {
  const path = require('path');
  const { renderAsync } = require('@fitfak/pdf-html');

  const out = await renderAsync({
    html: `<p>metin</p><p><img src="${base}/logo.png"></p>`,
    fonts: [{ family: 'Ubuntu', src: path.resolve(__dirname, '../../assets/Ubuntu-Regular.ttf') }],
    assetRoots: [path.resolve(__dirname, '../../assets')]
  });

  assert.ok(out.pdf.length > 500, 'belge yine de üretilmeli');
  assert.ok(out.warnings.some((w) => w.code === 'WARN_REMOTE_FAILED' || /REMOTE/.test(w.code || '')),
    JSON.stringify(out.warnings));
});
