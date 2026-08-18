'use strict';
/**
 * CRL Dağıtım Noktası (CDP) ve Authority Information Access (AIA)
 * seçeneklerinin çözümlenmesi — dahili yardımcı.
 *
 * SORUN: Önceki sürümde URL'ler `crlUrl + '/root.crl'`,
 * `aiaUrl + '/ocsp'`, `aiaUrl + '/intermediate.crt'` gibi SABİT yol
 * ekleriyle üretiliyordu. Bu, çağıranın gerçek OCSP/CRL adreslerini tam
 * olarak belirlemesini imkânsız kılıyordu (ör. OCSP'niz
 * `https://ocsp.fitfak.com` ise, `aiaUrl` ne verirseniz verin sonuna
 * `/ocsp` ekleniyordu).
 *
 * ÇÖZÜM: Artık URL'ler AÇIKÇA verilebilir:
 *   { ocspUrl: 'http://ocsp.fitfak.com',
 *     caIssuersUrl: 'http://pki.fitfak.com/ca.crt',
 *     crlUrls: ['http://crl.fitfak.com/root.crl'] }
 *
 * GERİYE DÖNÜK UYUMLULUK: Eski `crlUrl` / `aiaUrl` (taban adres + sabit
 * yol eki) davranışı AYNEN korunur; yalnızca yeni alanlar verilmediğinde
 * devreye girer. Böylece mevcut çağrılar kırılmaz.
 */
const { extAIA } = require('./asn1');

const _asList = (v) => (v === undefined || v === null || v === '')
  ? []
  : (Array.isArray(v) ? v : [v]);

/**
 * @param {object} opts  Sertifika fabrikasına verilen seçenekler
 * @param {{ crlSuffix?: string, caCertSuffix?: string }} [legacy]
 *        Eski `crlUrl`/`aiaUrl` taban adresine eklenecek yol ekleri
 *        (yalnızca yeni açık alanlar verilmediğinde kullanılır).
 * @returns {{ cdp: string[], aia: Buffer|null }}
 */
function resolveDistributionPoints(opts = {}, legacy = {}) {
  const { crlSuffix = '/ca.crl', caCertSuffix = '/ca.crt' } = legacy;

  // ── CRL dağıtım noktaları ────────────────────────────────────────────
  let cdp = _asList(opts.crlUrls);
  if (cdp.length === 0 && opts.crlUrl) {
    // Eski davranış: taban adres + sabit yol eki.
    // Ancak çağıran zaten tam bir dosya yolu verdiyse (ör. ".crl" ile
    // bitiyorsa) olduğu gibi kullan — böylece yeni kullanım da doğal olur.
    cdp = _asList(opts.crlUrl).map(u => /\.crl$/i.test(u) ? u : u + crlSuffix);
  }

  // ── AIA (OCSP + caIssuers) ───────────────────────────────────────────
  let ocsp = _asList(opts.ocspUrl);
  let caIssuers = _asList(opts.caIssuersUrl);
  if (ocsp.length === 0 && caIssuers.length === 0 && opts.aiaUrl) {
    // Eski davranış: taban adresten türet.
    const base = String(opts.aiaUrl).replace(/\/+$/, '');
    ocsp = [base + '/ocsp'];
    caIssuers = [base + caCertSuffix];
  }
  const aia = (ocsp.length || caIssuers.length)
    ? extAIA(ocsp, caIssuers, !!opts.aiaCritical)
    : null;

  return { cdp, aia };
}

module.exports = { resolveDistributionPoints };
