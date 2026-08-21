'use strict';
/**
 * Uzak varlık getirici — SSRF savunmalı.
 *
 * `netguard` KARAR verir, burası isteği atar. Ayrım bilinçli: karar mantığı
 * ağ olmadan test edilebilsin.
 *
 * Getirme kuralları:
 *   - Yalnız http/https, kimlik bilgisi taşıyan adres yok
 *   - Ad BİR KEZ çözülür ve GÜVENLİ IP'ye bağlanılır (DNS rebinding kapalı)
 *   - `Host` başlığı elle korunur; TLS'te `servername` ile SNI doğru kalır
 *   - Yönlendirmeler ELLE takip edilir ve her halka SIFIRDAN denetlenir
 *   - Boyut sınırı akış sırasında uygulanır: `Content-Length`e güvenilmez
 *   - Zaman aşımı toplam süreye uygulanır, yalnız bağlantıya değil
 *   - İçerik türü izin listesine göre doğrulanır
 *
 * ÖNEMLİ: uzak varlık desteği VARSAYILAN OLARAK KAPALIDIR. Açmak bilinçli
 * bir karardır ve `allowHosts` ile daraltılması önerilir.
 */

const http = require('http');
const https = require('https');
const { resolveSafeUrl, NetGuardError } = require('./netguard');

const DEFAULT_OPTIONS = {
  maxBytes: 16 * 1024 * 1024,
  timeoutMs: 10_000,
  maxRedirects: 3,
  allowedTypes: ['image/png', 'image/jpeg', 'font/ttf', 'font/otf',
                 'application/font-sfnt', 'application/octet-stream']
};

class RemoteFetchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RemoteFetchError';
    this.code = code;
  }
}

/**
 * Uzak kaynağı indirir.
 *
 * @param {string} rawUrl
 * @param {Object} [opts] DEFAULT_OPTIONS üzerine yazılır; ayrıca
 *   `allowHosts`, `denyHosts`, `lookup`, `allowPrivate` (yalnız test).
 * @returns {Promise<{ data: Buffer, contentType: string, url: string }>}
 */
async function fetchRemoteAsset(rawUrl, opts = {}) {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const deadline = Date.now() + o.timeoutMs;

  let target = rawUrl;
  for (let hop = 0; hop <= o.maxRedirects; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new RemoteFetchError('ERR_REMOTE_TIMEOUT', 'Uzak kaynak zaman aşımına uğradı');
    }

    // HER halka sıfırdan denetlenir: güvenli bir adres, 30x ile
    // 169.254.169.254'e gönderebilir.
    const safe = await resolveSafeUrl(target, o);
    const response = await requestOnce(safe, o, remaining);

    if (response.redirect) {
      if (hop === o.maxRedirects) {
        throw new RemoteFetchError('ERR_REMOTE_TOO_MANY_REDIRECTS',
          `Çok fazla yönlendirme (${o.maxRedirects})`);
      }
      target = new URL(response.redirect, safe.url).toString();
      continue;
    }

    return { data: response.data, contentType: response.contentType, url: safe.url.toString() };
  }

  throw new RemoteFetchError('ERR_REMOTE_TOO_MANY_REDIRECTS', 'Yönlendirme sınırı aşıldı');
}

/** Tek bir HTTP isteği — yönlendirmeyi TAKİP ETMEZ, bildirir. */
function requestOnce(safe, o, timeoutMs) {
  return new Promise((resolve, reject) => {
    const isTls = safe.url.protocol === 'https:';
    const agent = isTls ? https : http;
    const port = safe.url.port || (isTls ? 443 : 80);

    const req = agent.request({
      // Ada değil, DOĞRULANMIŞ ADRESE bağlanıyoruz.
      host: safe.address,
      port,
      path: safe.url.pathname + safe.url.search,
      method: 'GET',
      // Sanal sunucular ve TLS sertifikası doğru adı görmeli
      servername: isTls ? safe.url.hostname : undefined,
      headers: {
        Host: safe.url.host,
        Accept: o.allowedTypes.join(', '),
        'User-Agent': 'fitfak-belge/1.0 (+asset-fetch)',
        'Accept-Encoding': 'identity'      // sıkıştırma bombası açmayalım
      },
      timeout: timeoutMs
    }, (res) => {
      const status = res.statusCode || 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();                       // gövdeyi at
        return resolve({ redirect: res.headers.location });
      }
      if (status !== 200) {
        res.resume();
        return reject(new RemoteFetchError('ERR_REMOTE_STATUS',
          `Uzak kaynak HTTP ${status} döndürdü`));
      }

      const contentType = String(res.headers['content-type'] || '')
        .split(';')[0].trim().toLowerCase();
      if (contentType && !o.allowedTypes.includes(contentType)) {
        res.resume();
        return reject(new RemoteFetchError('ERR_REMOTE_CONTENT_TYPE',
          `Beklenmeyen içerik türü: ${contentType}`));
      }

      // `Content-Length`e GÜVENİLMEZ: yalan olabilir. Sınır akışta uygulanır.
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > o.maxBytes) {
        res.destroy();
        return reject(new RemoteFetchError('ERR_REMOTE_TOO_LARGE',
          `Uzak kaynak çok büyük: ${declared} bayt (sınır ${o.maxBytes})`));
      }

      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > o.maxBytes) {
          res.destroy();
          reject(new RemoteFetchError('ERR_REMOTE_TOO_LARGE',
            `Uzak kaynak çok büyük (sınır ${o.maxBytes} bayt)`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ data: Buffer.concat(chunks), contentType }));
      res.on('error', (err) =>
        reject(new RemoteFetchError('ERR_REMOTE_IO', `Uzak kaynak okunamadı: ${err.message}`)));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new RemoteFetchError('ERR_REMOTE_TIMEOUT', 'Uzak kaynak zaman aşımına uğradı'));
    });
    req.on('error', (err) => {
      if (err instanceof RemoteFetchError || err instanceof NetGuardError) return reject(err);
      reject(new RemoteFetchError('ERR_REMOTE_IO', `Uzak kaynağa erişilemedi: ${err.message}`));
    });
    req.end();
  });
}

module.exports = { fetchRemoteAsset, RemoteFetchError, DEFAULT_OPTIONS };
