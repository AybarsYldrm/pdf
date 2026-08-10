'use strict';
/**
 * CRL Dağıtım Noktası (CRL Distribution Point) — HTTP (req,res) sunucu
 * yardımcıları.
 *
 * Önceki sürümde CRL üretimi (`generateCRL`/`parseCRL`) VARDI, ama bunu
 * bir HTTP CRL dağıtım noktası olarak sunan bir katman YOKTU. CRL'ler
 * genellikle DER (application/pkix-crl) olarak dağıtılır; bu modül hem
 * `Buffer`/DER hem de otomatik yeniden üretim (ör. `issuerCA` +
 * `getRevokedList` ile her istekte veya periyodik olarak) senaryolarını
 * destekleyen bir `(req, res) => {}` işleyicisi üretir.
 */
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const crypto = require('node:crypto');
const { generateCRL } = require('./pki');
const { pemToDer } = require('./_codec');

/**
 * Bir CRL HTTP dağıtım noktası işleyicisi üretir.
 *
 * İki kullanım biçimi desteklenir:
 *  1) Statik/önceden üretilmiş: `options.crlDer` (Buffer) veya `options.crlPem` (string) verilir.
 *  2) Dinamik: `options.issuerCA` + `options.getRevokedList()` verilir; her
 *     istekte (veya `options.cacheMs` süresince önbelleklenerek) taze bir
 *     CRL üretilir.
 *
 * @param {{
 *   crlDer?: Buffer, crlPem?: string,
 *   issuerCA?: object, getRevokedList?: () => Array<{serial,date?,reason?}> | Promise<...>,
 *   cacheMs?: number,
 * }} options
 * @returns {(req, res) => Promise<void>}
 */
function createCrlServerHandler(options = {}) {
  let cached = null;
  let cachedAt = 0;
  const cacheMs = options.cacheMs !== undefined ? options.cacheMs : 60000;

  async function _getCrlDer() {
    if (options.crlDer) return options.crlDer;
    if (options.crlPem) return pemToDer(options.crlPem);
    if (!options.issuerCA || !options.getRevokedList)
      throw new Error('createCrlServerHandler: crlDer/crlPem YA DA issuerCA+getRevokedList sağlanmalı');

    const now = Date.now();
    if (cached && (now - cachedAt) < cacheMs) return cached;
    const revokedList = await options.getRevokedList();
    const pem = generateCRL(options.issuerCA, revokedList);
    cached = pemToDer(pem);
    cachedAt = now;
    return cached;
  }

  return async function crlHandler(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
      }
      const der = await _getCrlDer();
      const etag = `"${crypto.createHash('sha256').update(der).digest('hex').slice(0, 32)}"`;

      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/pkix-crl',
        'Content-Length': der.length,
        'ETag': etag,
        'Cache-Control': `public, max-age=${Math.floor(cacheMs / 1000)}`,
      });
      res.end(req.method === 'HEAD' ? undefined : der);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`CRL hatası: ${err.message}`);
      }
    }
  };
}

/**
 * İstemci tarafı: bir CRL dağıtım noktasından (CDP URL'inden) CRL indirir.
 * @param {string} url
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Buffer>} CRL DER
 */
function fetchCrl(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const transport = u.protocol === 'https:' ? https : http;
    const request = transport.get(u, { timeout: opts.timeoutMs || 10000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`CRL indirilemedi: HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('CRL isteği zaman aşımına uğradı')));
  });
}

module.exports = { createCrlServerHandler, fetchCrl };
