'use strict';
/**
 * QR tarayıcı sunucusu — ayrı, küçük bir ürün.
 *
 * Belge Studio'dan bağımsızdır: yalnız tarayıcı arayüzünü sunar ve okunan
 * karekodun doğrulama talebini karşılar.
 *
 * Güvenlik notları:
 *   - Gövde boyutu sınırlıdır; sınırsız `body += chunk` bellek tüketirdi.
 *   - İstek ve başlık zaman aşımları vardır (yavaş istemci saldırıları).
 *   - `Content-Type` doğrulanır: yanlış türde gövde ayrıştırılmaz.
 *   - Yalnız yerel arayüze bağlanır; ağa açmak bilinçli bir karar olmalıdır.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { Registry } = require('@fitfak/registry');

const CONFIG = {
  port: Number(process.env.SCANNER_PORT) || 8080,
  host: process.env.SCANNER_HOST || '127.0.0.1',
  maxBodyBytes: Number(process.env.SCANNER_MAX_BODY) || 64 * 1024,
  requestTimeoutMs: Number(process.env.SCANNER_TIMEOUT_MS) || 15_000,
  headersTimeoutMs: Number(process.env.SCANNER_HEADERS_TIMEOUT_MS) || 10_000,
  /**
   * Doğrulama kaydı — İMZALAYAN SUNUCUYLA AYNI DİZİN.
   *
   * Tarayıcı deftere yalnız OKUMAK için bakar; yazan taraf imza sunucusudur.
   * Anahtar burada da gerekir çünkü zincir doğrulaması onsuz yapılamaz —
   * doğrulanmamış bir defteri okuyup "doğrulandı" demek, defterin hiç
   * olmamasından kötüdür.
   */
  registryDir: process.env.REGISTRY_DIR || '',
  registryKey: process.env.REGISTRY_KEY || ''
};

/** Arayüz dosyası — dizindeki gerçek adla eşleşmeli. */
const UI_FILE = path.join(__dirname, 'index.html');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'"
};

/**
 * Doğrulama kaydı — yalnız OKUMA.
 *
 * Yapılandırılmamışsa açık açık "kapalı" denir. Kapalı bir defteri açıkmış
 * gibi göstermek, sahte bir "doğrulandı" cevabı vermenin başka biçimidir.
 */
let _registry = null;

function registry() {
  if (_registry) return _registry;
  try {
    _registry = new Registry({ dir: CONFIG.registryDir, key: CONFIG.registryKey });
  } catch (err) {
    console.warn('[kayıt defteri] açılamadı:', err.message);
    _registry = new Registry({});                       // kapalı defter
  }
  return _registry;
}

/**
 * Bir belgeyi kayıtta arar.
 *
 * ÜÇ AYRI CEVAP VARDIR VE BİRBİRİNE KARIŞTIRILMAMALIDIR:
 *   `unavailable` — defter yok/okunamıyor. Bilgi YOK demektir, "geçersiz"
 *                   demek değildir.
 *   `unverified`  — defter var, bu belge KAYITLI DEĞİL. Belge sahte
 *                   olabilir, ya da bu sunucudan geçmemiş olabilir.
 *   `verified` / `invalid` — kayıt var; imzanın kayıt anındaki doğrulama
 *                   sonucu bildirilir.
 *
 * Kayıt, imzanın ATILDIĞI ANDAKİ doğrulamadır. Belge o günden sonra
 * değiştirilmişse özeti tutmayacağı için zaten bulunamaz; ama sertifika
 * o günden sonra iptal edilmişse bunu kayıt bilmez ve cevap bunu söyler.
 */
function lookup({ hash, docNo }) {
  const now = new Date().toISOString();
  const reg = registry();

  if (!reg.enabled) {
    return {
      status: 'unavailable',
      message: 'Doğrulama kaydı yapılandırılmadı; bu belge hakkında bilgi verilemiyor.',
      documentId: hash || docNo,
      timestamp: now
    };
  }

  const chain = reg.verifyChain();
  if (!chain.ok) {
    // Defterin kendisi bozuksa içindeki hiçbir kayıt kanıt değildir.
    return {
      status: 'unavailable',
      message: `Doğrulama kaydı bütünlüğü bozuk (${chain.reason}); ` +
               'kayıtlara güvenilemez.',
      documentId: hash || docNo,
      timestamp: now
    };
  }

  const record = (hash && reg.lookup(hash)) || (docNo && reg.lookupByDocNo(docNo)) || null;
  if (!record) {
    return {
      status: 'unverified',
      message: 'Bu belge kayıtlı değil.',
      documentId: hash || docNo,
      timestamp: now
    };
  }

  // ÜÇ SONUÇ, ÜÇ ANLAM (ETSI EN 319 102-1): geçti, geçmedi, KARAR VERİLEMEDİ.
  // "Karar verilemedi"ye "geçersiz" demek, güven zinciri eksik olan her
  // belgeyi sahte ilan etmek olurdu.
  const indication = record.indication || '';
  const passed = indication === 'TOTAL-PASSED';
  const failed = indication === 'TOTAL-FAILED';

  return {
    status: passed ? 'verified' : failed ? 'invalid' : 'indeterminate',
    message: passed
      ? 'Belge imzalandığı anda geçerli bir imza taşıyordu.'
      : failed
        ? `İmza kayıt anında GEÇERSİZDİ (${record.subIndication || indication}).`
        : 'İmza kayıt anında doğrulanamadı; karar verilemedi ' +
          `(${record.subIndication || indication || 'bilinmiyor'}).`,
    documentId: record.documentHash,
    docNo: record.docNo || null,
    signer: record.signer || null,
    issuer: record.issuer || null,
    level: record.level || null,
    signedAt: record.signedAt,
    signatureCount: record.signatureCount,
    timestamped: record.timestamped,
    indication: record.indication || null,
    subIndication: record.subIndication || null,
    // Kaydın NE ANLAMA GELDİĞİ cevabın içinde durur: kullanıcı "doğrulandı"
    // damgasının kapsamını tahmin etmek zorunda kalmasın.
    scope: 'Kayıt, imzanın atıldığı andaki doğrulamadır; sertifika o tarihten ' +
           'sonra iptal edilmiş olabilir.',
    timestamp: now
  };
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    ...SECURITY_HEADERS
  });
  res.end(buf);
}

/**
 * Gövdeyi SINIRLI olarak okur.
 * Sınır aşılırsa bağlantı kapatılır: kalanını okumak zaten belleğe yazmak olur.
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Önce yanıtı yaz, SONRA bağlantıyı kes: istemci neden reddedildiğini
        // öğrensin ama kalan baytlar belleğe alınmasın.
        reject(Object.assign(new Error('İstek gövdesi çok büyük'),
          { code: 'ERR_BODY_TOO_LARGE', status: 413, tooLarge: true }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    /* 1. Tarayıcı arayüzü */
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      fs.readFile(UI_FILE, (err, content) => {
        if (err) {
          sendJson(res, 500, { status: 'error', message: 'Arayüz dosyası okunamadı.' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': content.length,
          ...SECURITY_HEADERS
        });
        res.end(content);
      });
      return;
    }

    /* 2. Doğrulama ucu */
    if (req.method === 'POST' && req.url === '/api/verify') {
      const type = String(req.headers['content-type'] || '').split(';')[0].trim();
      if (type !== 'application/json') {
        return sendJson(res, 415, {
          status: 'error',
          message: 'Content-Type application/json olmalı.'
        });
      }

      let body;
      try {
        body = await readBody(req, CONFIG.maxBodyBytes);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, err.status || 400, { status: 'error', message: err.message });
        }
        // Gövde sınırı aşıldıysa kalanı okumayı bırak
        if (err.tooLarge) req.destroy();
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        return sendJson(res, 400, { status: 'error', message: 'Geçersiz JSON gövdesi.' });
      }

      const hash = typeof parsed.hash === 'string' ? parsed.hash.trim() : '';
      const docNo = typeof parsed.docNo === 'string' ? parsed.docNo.trim().slice(0, 128) : '';

      if (hash && !/^[0-9a-fA-F]{32,128}$/.test(hash)) {
        return sendJson(res, 400, {
          status: 'error',
          message: 'hash alanı 32–128 karakter onaltılık bir dizge olmalı.'
        });
      }
      if (!hash && !docNo) {
        return sendJson(res, 400, {
          status: 'error',
          message: 'hash ya da docNo alanlarından biri gerekli.'
        });
      }

      return sendJson(res, 200, lookup({ hash, docNo }));
    }

    sendJson(res, 404, { status: 'error', message: 'Bulunamadı.' });
  });
}

function start() {
  const server = createServer();
  server.requestTimeout = CONFIG.requestTimeoutMs;
  server.headersTimeout = CONFIG.headersTimeoutMs;

  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`\n  QR Tarayıcı`);
    console.log(`  → http://${CONFIG.host}:${CONFIG.port}\n`);
    console.log(`  Gövde sınırı : ${(CONFIG.maxBodyBytes / 1024).toFixed(0)} KB`);
    console.log('  Not: Kameranın mobil tarayıcıda çalışması için sayfaya HTTPS');
    console.log('       ya da localhost üzerinden erişilmelidir.\n');
  });
  return server;
}

if (require.main === module) start();

module.exports = { createServer, start, CONFIG };
