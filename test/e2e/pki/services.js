'use strict';
/**
 * Çevrimdışı test servisleri: OCSP responder, CRL dağıtım noktası, RFC 3161 TSA.
 *
 * Tümü `@fitfak/ssl` üzerine kuruludur; ek bağımlılık yoktur ve ağa çıkmaz.
 * Portlar önce 0 ile bağlanıp öğrenilir, sertifikalar SONRA o adreslerle
 * üretilir — böylece AIA/CDP uzantıları gerçek çalışan servisleri gösterir ve
 * otomatik keşif kodu gerçekten sınanmış olur.
 */

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const ssl = require('@fitfak/ssl');
const { buildTestPki } = require('./ca');

/** Boş bir porta bağlanıp portu öğrenen yardımcı. */
function listenEphemeral(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

/**
 * Tüm test servislerini başlatır ve bir PKI ile birlikte döndürür.
 *
 * @returns {Promise<{ pki, endpoints, revoke(serialHex), close(): Promise<void>,
 *                     crlCounter: () => number, ocspCounter: () => number }>}
 */
async function startTestServices() {
  // Handler'lar PKI kurulduktan sonra atanır; sunucular ise portu öğrenmek için
  // önce başlar. Bu kutu o boşluğu köprüler.
  const holder = { ocsp: null, crl: null, tsa: null };
  const counters = { ocsp: 0, crl: 0, tsa: 0 };

  const ocspServer = http.createServer((req, res) => {
    counters.ocsp++;
    if (holder.ocsp) return holder.ocsp(req, res);
    res.writeHead(503).end();
  });
  const crlServer = http.createServer((req, res) => {
    counters.crl++;
    if (holder.crl) return holder.crl(req, res);
    res.writeHead(503).end();
  });
  const tsaServer = http.createServer((req, res) => {
    counters.tsa++;
    if (holder.tsa) return holder.tsa(req, res);
    res.writeHead(503).end();
  });

  const [ocspPort, crlPort, tsaPort] = await Promise.all([
    listenEphemeral(ocspServer),
    listenEphemeral(crlServer),
    listenEphemeral(tsaServer)
  ]);

  const endpoints = {
    ocsp: `http://127.0.0.1:${ocspPort}/ocsp`,
    crl:  `http://127.0.0.1:${crlPort}`,
    aia:  `http://127.0.0.1:${crlPort}`,
    tsa:  `http://127.0.0.1:${tsaPort}/tsa`
  };

  const pki = buildTestPki(endpoints);

  // ── İptal kayıt defteri ────────────────────────────────────────────
  /** @type {Map<string,{reason:number, date:Date}>} serialHex(lowercase, no leading zeros) */
  const revoked = new Map();
  const normSerial = (hex) => String(hex).toLowerCase().replace(/^0+/, '') || '0';

  const revoke = (serialHex, reason = 1) => {
    revoked.set(normSerial(serialHex), { reason, date: new Date() });
  };

  // ── OCSP ───────────────────────────────────────────────────────────
  holder.ocsp = ssl.createOcspResponderHandler({
    issuerCA: pki.subCa,
    responderKey: pki.subCa,          // CA doğrudan imzalıyor (en yaygın ve en kolay doğrulanan biçim)
    responderCertDer: pki.subCa.certDer,
    nextUpdateDays: 7,
    getStatus: (serialNumber) => {
      const hex = normSerial(serialNumber.toString(16));
      const hit = revoked.get(hex);
      if (hit) return { status: 'revoked', reason: hit.reason, revokedAt: hit.date };
      return { status: 'good' };
    }
  });

  // ── CRL ────────────────────────────────────────────────────────────
  // Yol bazlı: /root.crl (kök CA'nın yayınladığı), /sub.crl, /subcrlonly.crl
  // Ayrıca /root.crt, /sub.crt gibi AIA caIssuers indirmeleri de buradan servis edilir.
  const crlFor = (issuerCA) => {
    const list = [...revoked.entries()].map(([hex, v]) => ({
      serial: BigInt('0x' + hex), reason: v.reason, date: v.date
    }));
    const pem = ssl.generateCRL(issuerCA, list, { nextUpdateDays: 7 });
    return Buffer.from(
      pem.split('\n').filter((l) => l && !l.startsWith('-----')).join(''), 'base64'
    );
  };

  holder.crl = (req, res) => {
    const url = (req.url || '').split('?')[0];
    const send = (buf, type) => {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length });
      res.end(buf);
    };
    try {
      if (url === '/root.crl')            return send(crlFor(pki.root), 'application/pkix-crl');
      if (url === '/sub.crl')             return send(crlFor(pki.subCa), 'application/pkix-crl');
      if (url === '/subcrlonly.crl')      return send(crlFor(pki.subCaCrlOnly), 'application/pkix-crl');
      if (url === '/root.crt')            return send(pki.root.certDer, 'application/pkix-cert');
      if (url === '/sub.crt')             return send(pki.subCa.certDer, 'application/pkix-cert');
      if (url === '/subcrlonly.crt')      return send(pki.subCaCrlOnly.certDer, 'application/pkix-cert');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('CRL hatası: ' + err.message);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('bulunamadı');
  };

  // ── TSA ────────────────────────────────────────────────────────────
  const serialFile = path.join(os.tmpdir(), `fitfak-tsa-serial-${process.pid}-${Date.now()}.bin`);
  const tsaResponder = ssl.createTimestampResponder({
    keyPem: ssl.ecPrivToPem(pki.tsa),
    certChainPem: [pki.tsa.certPem, pki.subCa.certPem, pki.root.certPem].join('\n'),
    policyOid: '1.3.6.1.4.1.65133.1.4',
    serialFile,
    accuracy: { seconds: 1 }
  });
  holder.tsa = tsaResponder.httpHandler();

  const close = () => Promise.all([
    new Promise((r) => ocspServer.close(r)),
    new Promise((r) => crlServer.close(r)),
    new Promise((r) => tsaServer.close(r))
  ]).then(() => {
    try { fs.unlinkSync(serialFile); } catch { /* zaten yok */ }
  });

  return {
    pki,
    endpoints,
    revoke,
    revokedMap: revoked,
    close,
    counters,
    ocspCounter: () => counters.ocsp,
    crlCounter: () => counters.crl,
    tsaCounter: () => counters.tsa
  };
}

module.exports = { startTestServices };
