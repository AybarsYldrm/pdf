'use strict';
/**
 * Yapılandırılabilir varsayılanlar.
 *
 * Önceki sürümde CA/EE özneleri (Subject DN), geçerlilik süreleri gibi
 * değerler her fabrika fonksiyonunun içine gömülüydü (ör. sabit
 * "Kurumsal Kripto Otoritesi" dizgesi). Bu modül, bu değerleri TEK bir
 * yerden değiştirilebilir hale getirir: `configure()` ile global olarak,
 * ya da her çağrıda `opts.subject` / `opts.validityDays` gibi alanlarla
 * yerel olarak override edilebilir (pki.js bunu destekler).
 *
 * Varsayılan değerler, orijinal davranışı KORUMAK için önceki sürümdeki
 * sabit dizgelerle AYNIDIR — bu modülü hiç kullanmayan/bilmeyen kod için
 * hiçbir davranış değişikliği yoktur.
 */

const DEFAULTS = Object.freeze({
  // Varsayılan Ayırt Edici İsim (DN) alanları — [oidAdı, değer] çiftleri.
  // `oidAdı`, ./oid.js içindeki OIDs tablosundaki anahtarlara karşılık gelir.
  rootCA: {
    country: 'TR',
    organization: 'Kurumsal Kripto Otoritesi',
    commonName: 'Kurumsal Kök CA v1',
    validityDays: 3652.5, // ~10 yıl
  },
  ecRootCA: {
    country: 'TR',
    organization: 'Kurumsal EC Kripto Otoritesi',
    commonName: (curveName) => `Kurumsal EC Kök CA (${curveName})`,
    validityDays: 3652.5,
  },
  intermediateCA: {
    country: 'TR',
    organization: 'Kurumsal Kripto Otoritesi',
    commonName: 'Kurumsal Ara CA v1',
    validityDays: 5 * 365.25,
  },
  hybridIntermediateCA: {
    country: 'TR',
    organization: 'Kurumsal Kripto Otoritesi',
    commonName: 'Kurumsal Hibrit Ara CA v1',
    validityDays: 5 * 365.25,
  },
  endEntity: {
    country: 'TR',
    organization: 'Kurumsal Güvenlik',
    validityDays: 365,
  },
  ecEndEntity: {
    country: 'TR',
    organization: 'Kurumsal EC Güvenlik',
    validityDays: 365,
  },
  // CRL varsayılanları
  crl: {
    nextUpdateDays: 7,
  },
  // OCSP yanıt varsayılanları
  ocsp: {
    nextUpdateDays: 7,
  },
  // Anahtar varsayılanları
  key: {
    rsaBits: 2048,
    curve: 'P-256',
    hashAlg: 'sha256',
  },
});

// Çalışma zamanı yapılandırması — `configure()` ile derinlemesine
// (shallow per-section) birleştirilir. Başlangıçta varsayılanların bir
// kopyasıdır.
let _current = JSON.parse(JSON.stringify(DEFAULTS, (k, v) => typeof v === 'function' ? undefined : v));
// commonName fonksiyonlarını (JSON.stringify tarafından atlanan) geri koy
_current.ecRootCA.commonName = DEFAULTS.ecRootCA.commonName;

/**
 * Global varsayılanları kısmi olarak günceller (bölüm bazlı sığ birleştirme).
 * @param {object} partial  ör: { rootCA: { organization: 'ACME A.Ş.' } }
 */
function configure(partial = {}) {
  for (const [section, values] of Object.entries(partial)) {
    _current[section] = { ..._current[section], ...values };
  }
  return getDefaults();
}

/** Geçerli (etkin) varsayılanların salt-okunur bir kopyasını döner. */
function getDefaults() {
  return _current;
}

/** Fabrika ayarlarına (kütüphanenin özgün sabit değerlerine) sıfırlar. */
function resetDefaults() {
  _current = JSON.parse(JSON.stringify(DEFAULTS, (k, v) => typeof v === 'function' ? undefined : v));
  _current.ecRootCA.commonName = DEFAULTS.ecRootCA.commonName;
  return getDefaults();
}

/**
 * `opts.subject` (nameAttrs dizisi: [[oid,value],...]) verilmişse onu
 * kullanır; verilmemişse `section` için varsayılan DN'yi üretir.
 * @param {string} section  'rootCA' | 'intermediateCA' | 'endEntity' | ...
 * @param {object} opts      Çağıranın opts nesnesi (subject alanı olabilir)
 * @param {object} OIDs      ./oid.js OIDs tablosu (döngüsel import'tan kaçınmak için parametre olarak alınır)
 * @param {string} [commonNameOverride] endEntity gibi durumlarda CN'nin dışarıdan (ör. hostname) belirlendiği hâller
 */
function resolveSubject(section, opts, OIDs, commonNameOverride) {
  if (opts && Array.isArray(opts.subject)) return opts.subject;
  const d = _current[section];
  const defaultCn = typeof d.commonName === 'function' ? d.commonName(opts && opts.curveName) : d.commonName;
  const cn = commonNameOverride !== undefined
    ? commonNameOverride
    : ((opts && opts.commonName !== undefined) ? opts.commonName : defaultCn);
  return [
    [OIDs.country, (opts && opts.country) || d.country],
    [OIDs.orgName, (opts && opts.organization) || d.organization],
    [OIDs.commonName, cn],
  ];
}

module.exports = { DEFAULTS, configure, getDefaults, resetDefaults, resolveSubject };
