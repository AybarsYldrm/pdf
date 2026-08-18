'use strict';
/**
 * PFX içindeki sertifikaları leaf → kök sırasına dizer.
 *
 * Eski `pfx.js` düz bir `certificates[]` dizisi döndürüyordu; hangi sertifikanın
 * yaprak, hangisinin ara CA olduğu bilinmiyordu. İmzalama için zincirin doğru
 * sırada olması gerekir.
 */

const crypto = require('crypto');

/** Sertifikadan temel meta veriyi çıkarır. */
function extractCertMeta(der) {
  try {
    const x = new crypto.X509Certificate(der);
    return {
      subject: x.subject,
      issuer: x.issuer,
      subjectCN: extractCN(x.subject),
      serial: x.serialNumber,
      notBefore: new Date(x.validFrom),
      notAfter: new Date(x.validTo),
      isCA: x.ca === true,
      raw: x
    };
  } catch (err) {
    return {
      subject: null, issuer: null, subjectCN: null, serial: null,
      notBefore: null, notAfter: null, isCA: false, raw: null,
      error: err.message
    };
  }
}

function extractCN(dn) {
  if (!dn) return null;
  const m = /(?:^|\n|,\s*)CN=([^\n,]+)/.exec(dn);
  return m ? m[1].trim() : null;
}

/**
 * Yaprak sertifikadan başlayarak, havuzdan zinciri kurar.
 *
 * @param {{der:Buffer, meta:Object}} leaf
 * @param {Array<{der:Buffer, meta:Object}>} pool
 * @returns {Array<{der:Buffer, meta:Object}>} leaf HARİÇ, üst sertifikalar sıralı
 */
function matchChain(leaf, pool) {
  const chain = [];
  const used = new Set();
  let current = leaf;

  for (let depth = 0; depth < 12; depth++) {
    if (!current.meta || !current.meta.issuer) break;
    // Kendinden imzalıysa zincir bitti
    if (current.meta.subject && current.meta.subject === current.meta.issuer) break;

    let next = null;
    for (let i = 0; i < pool.length; i++) {
      if (used.has(i)) continue;
      const cand = pool[i];
      if (!cand.meta || !cand.meta.subject) continue;
      if (cand.meta.subject !== current.meta.issuer) continue;
      // Kriptografik doğrulama: aday gerçekten imzalamış mı?
      if (current.meta.raw && cand.meta.raw) {
        try {
          if (!current.meta.raw.verify(cand.meta.raw.publicKey)) continue;
        } catch { /* doğrulanamıyorsa isim eşleşmesiyle yetin */ }
      }
      used.add(i);
      next = cand;
      break;
    }
    if (!next) break;
    chain.push(next);
    current = next;
  }

  return chain;
}

module.exports = { extractCertMeta, matchChain, extractCN };
