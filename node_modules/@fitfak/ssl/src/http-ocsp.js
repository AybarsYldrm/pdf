'use strict';
/**
 * OCSP Responder — HTTP (req,res) sunucu yardımcıları (RFC 6960 §A.1).
 *
 * Önceki sürümde OCSP isteği ayrıştırma (`parseOcspRequest`) ve imzalı
 * yanıt üretme (`generateOcspResponse`) VARDI, ama bunları gerçek bir HTTP
 * sunucusuna (Node'un `http`/`https` modülü `req`/`res` nesneleriyle)
 * bağlayan bir katman YOKTU. Bu modül tam olarak bu boşluğu doldurur:
 * hem GET (Base64/URL-kodlu, RFC 6960 Ek A) hem de POST (ham DER gövde)
 * biçimlerini destekleyen bir `(req, res) => {}` işleyicisi üretir —
 * `http.createServer`, Express, Fastify vb. ile doğrudan kullanılabilir.
 */
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const { parseOcspRequest, generateOcspResponse } = require('./pki');

function _readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Bir OCSP responder HTTP işleyicisi üretir.
 *
 * @param {{
 *   issuerCA: object,                 // Sorgulanan sertifikaları imzalayan CA
 *   responderKey: object,             // Yanıtı imzalayan anahtar (genellikle issuerCA'nın kendisi veya delege edilmiş bir OCSP responder sertifikası)
 *   responderCertDer?: Buffer,        // Yanıta gömülecek responder sertifikası (DER)
 *   getStatus: (serialNumber: bigint) => ({status:'good'|'revoked', reason?:number, revokedAt?:Date}) | Promise<...>,
 *   nextUpdateDays?: number,
 *   onError?: (err, req, res) => void,
 * }} options
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => Promise<void>}
 */
function createOcspResponderHandler(options) {
  const { issuerCA, responderKey, responderCertDer, getStatus, nextUpdateDays } = options;
  if (typeof getStatus !== 'function') throw new Error('createOcspResponderHandler: options.getStatus fonksiyonu zorunlu');

  return async function ocspHandler(req, res) {
    try {
      let reqDer;
      if (req.method === 'POST') {
        reqDer = await _readBody(req);
      } else if (req.method === 'GET') {
        // RFC 6960 Ek A.1.1: GET {url}/{base64-of-DER, URL güvenli değişimli}
        const path = decodeURIComponent(req.url.replace(/^\/+/, ''));
        reqDer = Buffer.from(path.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      } else {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
      }

      const ocspRequest = parseOcspRequest(reqDer);

      // Her istenen seri numarası için durumu topla (asenkron getStatus destekli).
      const statusMap = new Map();
      for (const r of ocspRequest.requests) {
        const st = await getStatus(r.serialNumber);
        statusMap.set(r.serialNumber.toString(16), st || { status: 'good' });
      }

      const respDer = generateOcspResponse(
        ocspRequest, issuerCA, responderKey, responderCertDer, statusMap,
        { nextUpdateDays },
      );

      res.writeHead(200, {
        'Content-Type': 'application/ocsp-response',
        'Content-Length': respDer.length,
        'Cache-Control': 'max-age=0, no-cache',
      });
      res.end(respDer);
    } catch (err) {
      if (options.onError) options.onError(err, req, res);
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`OCSP hatası: ${err.message}`);
      }
    }
  };
}

/**
 * İstemci tarafı: bir OCSP isteğini (DER) HTTP/HTTPS üzerinden bir
 * responder'a gönderir ve ham yanıt DER'ini döner. `pki.verifyOcspResponse`
 * ile birlikte kullanılabilir.
 * @param {string} responderUrl
 * @param {Buffer} requestDer
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Buffer>}
 */
function sendOcspRequest(responderUrl, requestDer, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(responderUrl);
    const transport = u.protocol === 'https:' ? https : http;
    const request = transport.request(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ocsp-request',
        'Content-Length': requestDer.length,
      },
      timeout: opts.timeoutMs || 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`OCSP responder HTTP ${res.statusCode}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('OCSP isteği zaman aşımına uğradı')));
    request.end(requestDer);
  });
}

module.exports = { createOcspResponderHandler, sendOcspRequest };
