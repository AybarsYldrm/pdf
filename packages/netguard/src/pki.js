'use strict';
/**
 * PKI getiricileri için SSRF savunmalı istek.
 *
 * `remote.js` görsel/font indirmeye göre ayarlıdır: içerik türü izin listesi,
 * yalnız GET. PKI'da durum farklıdır — OCSP ve TSA POST ister, dönen içerik
 * `application/ocsp-response` ya da çıplak DER olabilir, ve yönlendirme genelde
 * istenmez. Bu yüzden ayrı bir yüz, AYNI karar noktasıyla: `resolveSafeUrl`.
 *
 * Adresler saldırganın verdiği belgeden gelir. Bir sertifikanın AIA/CDP
 * uzantısına yazılan URL'i imzalayan değil, sertifikayı üreten seçer; imzasız
 * bir alan gibi düşünülmelidir. Bu adrese körü körüne istek atan bir
 * doğrulayıcı, saldırganın ağ içine uzanan eli olur:
 *
 *     AIA: http://169.254.169.254/latest/meta-data/iam/security-credentials/
 *     CDP: http://[::1]:8500/v1/kv/production?raw
 */

const http = require('http');
const https = require('https');
const { resolveSafeUrl, NetGuardError } = require('./netguard');

const DEFAULTS = {
  timeoutMs: 15_000,
  maxBytes: 8 * 1024 * 1024,
  maxRedirects: 2
};

/**
 * Doğrulanmış bir adrese HTTP isteği atar.
 *
 * @param {string} rawUrl
 * @param {Object} [opts]
 * @param {'GET'|'POST'} [opts.method='GET']
 * @param {Buffer} [opts.body] POST gövdesi
 * @param {Object} [opts.headers]
 * @param {number} [opts.timeoutMs] TOPLAM süre (yönlendirmeler dahil)
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.maxRedirects]
 * @param {string[]} [opts.allowHosts] / [opts.denyHosts] / [opts.lookup]
 * @param {boolean} [opts.allowPrivate] YALNIZ testlerde — özel ağ engelini kaldırır
 * @returns {Promise<{ status:number, headers:Object, body:Buffer, url:string }>}
 */
async function pkiFetch(rawUrl, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const deadline = Date.now() + o.timeoutMs;

  let target = rawUrl;
  for (let hop = 0; hop <= o.maxRedirects; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new NetGuardError('ERR_NET_TIMEOUT', `İstek zaman aşımına uğradı (${rawUrl})`);
    }

    // HER halka SIFIRDAN denetlenir: güvenli bir adres 30x ile
    // 169.254.169.254'e gönderebilir.
    const safe = await resolveSafeUrl(target, o);
    const res = await once(safe, o, remaining);

    if (res.redirect) {
      if (hop === o.maxRedirects) {
        throw new NetGuardError('ERR_NET_TOO_MANY_REDIRECTS',
          `Çok fazla yönlendirme (${o.maxRedirects})`);
      }
      target = new URL(res.redirect, safe.url).toString();
      // Yönlendirilen istek gövde taşımaz: POST'un hedefi değişmişse artık
      // aynı istek değildir.
      o.method = 'GET';
      o.body = undefined;
      continue;
    }
    return { ...res, url: safe.url.toString() };
  }
  throw new NetGuardError('ERR_NET_TOO_MANY_REDIRECTS', 'Yönlendirme sınırı aşıldı');
}

function once(safe, o, timeoutMs) {
  return new Promise((resolve, reject) => {
    const isTls = safe.url.protocol === 'https:';
    const agent = isTls ? https : http;
    const body = o.body && o.body.length ? Buffer.from(o.body) : null;

    const req = agent.request({
      // Ada değil, DOĞRULANMIŞ ADRESE bağlanıyoruz: DNS yeniden bağlama
      // (rebinding) ile denetimden sonra hedefin değişmesi engellenir.
      host: safe.address,
      port: safe.url.port || (isTls ? 443 : 80),
      path: safe.url.pathname + safe.url.search,
      method: o.method || 'GET',
      servername: isTls ? safe.url.hostname : undefined,
      headers: {
        Host: safe.url.host,
        'User-Agent': 'fitfak-belge/1.0 (+pki-fetch)',
        'Accept-Encoding': 'identity',       // sıkıştırma bombası açmayalım
        ...(body ? { 'Content-Length': String(body.length) } : {}),
        ...(o.headers || {})
      },
      timeout: timeoutMs
    }, (res) => {
      const status = res.statusCode || 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: res.headers.location });
      }

      // `Content-Length`e GÜVENİLMEZ: yalan olabilir. Sınır akışta uygulanır.
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > o.maxBytes) {
        res.destroy();
        return reject(new NetGuardError('ERR_NET_TOO_LARGE',
          `Yanıt çok büyük: ${declared} bayt (sınır ${o.maxBytes})`));
      }

      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > o.maxBytes) {
          res.destroy();
          reject(new NetGuardError('ERR_NET_TOO_LARGE',
            `Yanıt boyut sınırını aştı (${o.maxBytes} bayt)`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', (err) =>
        reject(new NetGuardError('ERR_NET_IO', `Yanıt okunamadı: ${err.message}`)));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new NetGuardError('ERR_NET_TIMEOUT', 'İstek zaman aşımına uğradı'));
    });
    req.on('error', (err) => {
      if (err instanceof NetGuardError) return reject(err);
      reject(new NetGuardError('ERR_NET_IO', `Bağlanılamadı: ${err.message}`));
    });

    if (body) req.write(body);
    req.end();
  });
}

/**
 * Ağ denetimi seçeneklerini bir seçenek nesnesinden AYIKLAR.
 *
 * Katmanlar arasında elle taşınan bir seçenek er geç bir yerde düşer ve
 * savunma sessizce kapanır. Tek bir ayıklayıcı, "hangi alanlar aktarılmalı"
 * sorusunun tek yanıtı olsun diye vardır.
 *
 * `allowPrivateNetwork` VARSAYILAN OLARAK KAPALIDIR: 127.0.0.1, localhost,
 * ::1, 169.254.169.254 ve özel ağlar engellidir. Kurum içi bir PKI'ın CDP/OCSP
 * adresleri iç ağa bakıyorsa bu bilinçli olarak açılmalıdır.
 */
function netOptions(opts = {}) {
  return {
    allowHosts: opts.allowHosts,
    denyHosts: opts.denyHosts,
    lookup: opts.lookup,
    allowPrivate: opts.allowPrivateNetwork === true
  };
}

module.exports = { pkiFetch, netOptions };
