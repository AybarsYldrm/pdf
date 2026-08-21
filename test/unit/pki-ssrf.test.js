'use strict';
/**
 * PKI getiricilerinde SSRF savunması.
 *
 * AIA, CDP ve OCSP adresleri SERTİFİKANIN İÇİNDEN gelir. O adresi imzalayan
 * değil, sertifikayı üreten yazar; doğrulayıcı açısından imzasız bir alandır.
 * Bu adreslere körü körüne istek atan bir doğrulayıcı, saldırganın iç ağa
 * uzanan eli olur:
 *
 *     AIA: http://169.254.169.254/latest/meta-data/iam/security-credentials/
 *     CDP: http://127.0.0.1:8500/v1/kv/production?raw
 *
 * Buradaki testler engelin AÇIK OLDUĞUNU ve yalnız açıkça istendiğinde
 * gevşediğini doğrular.
 */

const test = require('node:test');
const assert = require('node:assert');

const { fetchCrl } = require('@fitfak/pades/src/cades/crl');
const { requestOCSP } = require('@fitfak/pades/src/cades/ocsp');
const { netOptions, pkiFetch } = require('@fitfak/netguard');

/** İç ağa bakan, gerçek dünyada saldırganın seçeceği adresler. */
const KAPALI_ADRESLER = [
  'http://127.0.0.1:8500/v1/kv/production',
  'http://localhost:6379/',
  'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
  'http://[::1]:8080/admin',
  'http://10.0.0.5/internal',
  'http://192.168.1.1/router',
  'http://172.16.0.10/service'
];

/** Hiç kabul edilmemesi gereken şemalar. */
const KAPALI_SEMALAR = [
  'file:///etc/passwd',
  'ftp://ornek.test/dosya.crl',
  'gopher://ornek.test/1',
  'data:application/pkix-crl;base64,AAAA'
];

/* ------------------------------------------------------------------ */

test('netOptions: özel ağ izni VARSAYILAN OLARAK kapalı', () => {
  assert.strictEqual(netOptions({}).allowPrivate, false);
  assert.strictEqual(netOptions({ allowPrivateNetwork: false }).allowPrivate, false);
  // Yalnız birebir `true` açar: 'true', 1, 'evet' açmamalı.
  assert.strictEqual(netOptions({ allowPrivateNetwork: 'true' }).allowPrivate, false);
  assert.strictEqual(netOptions({ allowPrivateNetwork: 1 }).allowPrivate, false);
  assert.strictEqual(netOptions({ allowPrivateNetwork: true }).allowPrivate, true);
});

for (const url of KAPALI_ADRESLER) {
  test(`CRL: iç ağ adresi reddedilir — ${url}`, async () => {
    await assert.rejects(
      () => fetchCrl(url, { timeoutMs: 2000 }),
      (err) => {
        // Bağlantı KURULMADAN reddedilmeli: ECONNREFUSED görmek, isteğin
        // gerçekten gönderildiği anlamına gelirdi.
        assert.ok(!/ECONNREFUSED|ECONNRESET|ETIMEDOUT/.test(err.message),
          `istek gerçekten gönderilmiş görünüyor: ${err.message}`);
        return true;
      });
  });

  test(`OCSP: iç ağ adresi reddedilir — ${url}`, async () => {
    await assert.rejects(
      () => requestOCSP(url, Buffer.from([0x30, 0x00]), {}, { timeoutMs: 2000 }),
      (err) => {
        assert.ok(!/ECONNREFUSED|ECONNRESET|ETIMEDOUT/.test(err.message),
          `istek gerçekten gönderilmiş görünüyor: ${err.message}`);
        return true;
      });
  });
}

for (const url of KAPALI_SEMALAR) {
  test(`şema reddedilir — ${url.slice(0, 28)}`, async () => {
    await assert.rejects(() => pkiFetch(url, { timeoutMs: 2000 }),
      (err) => err.code === 'ERR_NET_SCHEME' || err.code === 'ERR_NET_BAD_URL');
  });
}

test('adreste kimlik bilgisi taşınamaz', async () => {
  await assert.rejects(
    () => pkiFetch('http://kullanici:parola@ornek.test/x.crl', { timeoutMs: 2000 }),
    (err) => err.code === 'ERR_NET_CREDENTIALS');
});

test('açıkça izin verilirse loopback kullanılabilir (kurum içi PKI)', async () => {
  // Kapalı bir porta bağlanmaya ÇALIŞMASI beklenir: engel kalktığında istek
  // gerçekten gönderilir ve bağlantı reddedilir. Bu, iznin işe yaradığının
  // kanıtıdır — testin ağ bağlantısına ihtiyacı yoktur.
  await assert.rejects(
    () => fetchCrl('http://127.0.0.1:1/yok.crl',
      { timeoutMs: 2000, allowPrivateNetwork: true }),
    (err) => {
      assert.match(err.message, /ECONNREFUSED|ECONNRESET|ETIMEDOUT/,
        `izin verildiği hâlde istek gönderilmemiş: ${err.message}`);
      return true;
    });
});

test('DNS yeniden bağlama: ad bir kez çözülür, güvenli adrese bağlanılır', async () => {
  // Ad çözümlemesi taklit edilir: ilk çağrı iç ağ adresi döndürür.
  // Denetim ADRES üzerinde yapıldığı için istek hiç gönderilmemeli.
  let cagri = 0;
  const lookup = async () => {
    cagri++;
    return [{ address: '169.254.169.254', family: 4 }];
  };

  await assert.rejects(
    () => pkiFetch('http://zararsiz-gorunen-ad.test/x.crl', { timeoutMs: 2000, lookup }),
    (err) => err.code === 'ERR_NET_BLOCKED_ADDRESS');
  assert.strictEqual(cagri, 1, 'ad tam olarak bir kez çözülmeli');
});

test('yönlendirme her halkada YENİDEN denetlenir', async () => {
  // Dışarıdan zararsız görünen bir ad, 30x ile bulut üstveri adresine
  // gönderirse ikinci halka reddedilmeli. Burada birinci halkanın kendisi
  // zaten çözülemediği için istek dışarı çıkmaz; asıl kanıt netguard
  // testlerinde. Burada yalnız sınırın var olduğunu doğruluyoruz.
  await assert.rejects(
    () => pkiFetch('http://ornek.test/x.crl', {
      timeoutMs: 2000,
      maxRedirects: 0,
      lookup: async () => [{ address: '169.254.169.254', family: 4 }]
    }),
    (err) => err.code === 'ERR_NET_BLOCKED_ADDRESS');
});
