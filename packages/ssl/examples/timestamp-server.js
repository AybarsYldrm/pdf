'use strict';

/**
 * time.trust.fitfak.net — RFC 3161 zaman damgası sunucusu.
 *
 * Düz HTTP, port 80. Bu bir eksiklik değil, gerekliliktir: RFC 3161 istemcileri
 * (openssl ts, Adobe, imzalama araçları) TSA'ya HTTP üzerinden ulaşır ve token
 * zaten kendi içinde imzalıdır -- gizliliği taşıma katmanından değil, CMS
 * imzasından alır. TLS eklemek, damganın kanıt değerine hiçbir şey katmaz ve
 * sertifika süresi dolduğunda damgalama tümüyle durur.
 *
 * status.trust.fitfak.net (OCSP/CRL) ile AYNI IP üzerinde, ayrı bir hostname
 * olarak çalışır; ikisi de aynı sebeple düz HTTP'dir.
 *
 * Çalıştırma:
 *   FITFAK_TSA_KEY=./certs/timestamp.key \
 *   FITFAK_TSA_CERT=./certs/timestamp.crt \
 *   node examples/timestamp-server.js
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { createTimestampResponder } = require('../src/tsa');

const CFG = {
  host: process.env.FITFAK_TSA_HOST || '31.58.245.241',
  port: Number(process.env.FITFAK_TSA_PORT || 80),
  keyPath: process.env.FITFAK_TSA_KEY || './certs/timestamp.key',
  certPath: process.env.FITFAK_TSA_CERT || './certs/timestamp.crt',
  serialFile: process.env.FITFAK_TSA_SERIAL || './.tsa/serial.bin',
  policyOid: process.env.FITFAK_TSA_POLICY || '1.3.6.1.4.1.65133.1.4',
  contact: 'network@fitfak.net',
};

function main() {
  for (const [label, file] of [['anahtar', CFG.keyPath], ['sertifika', CFG.certPath]]) {
    if (!fs.existsSync(file)) {
      console.error(`[tsa] TSA ${label} dosyası bulunamadı: ${file}`);
      console.error('[tsa] Üretmek için: profile:"tsa" ile issueCertificateFromCSR (bkz. test-tsa.js)');
      process.exit(1);
    }
  }

  // EKU=timeStamping kontrolü burada, açılışta yapılır ve eksikse süreç başlamaz.
  const tsa = createTimestampResponder({
    keyPem: fs.readFileSync(CFG.keyPath, 'utf8'),
    certChainPem: fs.readFileSync(CFG.certPath, 'utf8'),
    policyOid: CFG.policyOid,
    serialFile: path.resolve(CFG.serialFile),
    accuracy: { seconds: 1 },
  });

  const timestamp = tsa.httpHandler();

  const server = http.createServer((req, res) => {
    if (req.method === 'POST') return timestamp(req, res);

    if (req.method === 'GET' || req.method === 'HEAD') {
      const body = `FITFAK Time Stamping Authority (RFC 3161)

POST application/timestamp-query  ->  application/timestamp-reply

Policy : ${CFG.policyOid}
Time   : ${new Date().toISOString()}
Contact: ${CFG.contact}
`;
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }

    res.writeHead(405, { allow: 'GET, HEAD, POST', 'content-type': 'text/plain; charset=utf-8' });
    res.end('RFC 3161: POST application/timestamp-query\n');
  });

  server.listen(CFG.port, CFG.host, () => {
    console.log(`[tsa] dinliyor: http://${CFG.host}:${CFG.port}  policy=${CFG.policyOid}`);
  });

  // Damga üretimi sırasında ölmek, ayrılmış ama kullanılmamış seri bırakır --
  // zararsızdır (seriler atlanabilir, tekrar edemez). Yine de açık bağlantıların
  // yanıtlarını tamamlamasına izin veriyoruz.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(`\n[tsa] ${signal} alındı, kapanıyor...`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

main();
