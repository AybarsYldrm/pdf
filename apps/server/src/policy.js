'use strict';
/**
 * Merkezi kaynak politikası ve erişim denetimi.
 *
 * TEHDİT: uçların hepsi pahalı iş yapar — PDF ayrıştırma, KDF, font gömme,
 * ASN.1 gezme. Sınırsız girdi bunu bir hizmet reddi silahına çevirir:
 *
 *   • 500 MB'lık JSON gövde                   → bellek
 *   • 50 000 elemanlı `ops` dizisi            → işlemci
 *   • 200 000 sayfalık PDF                    → bellek + işlemci
 *   • 10 MB HTML + 5 MB CSS                   → yerleşim motoru
 *   • 100 megapiksel PNG                      → çözme sırasında RAM
 *
 * Sınırlar TEK YERDE tanımlanır; her uç aynı sözlüğü kullanır. Dağıtık
 * sabitler kaçınılmaz olarak birbirinden ayrışır ve biri unutulur.
 *
 * Hepsi ortam değişkeniyle gevşetilebilir ama VARSAYILANLAR güvenlidir.
 */

const crypto = require('crypto');

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Kaynak sınırları — aşımda 400 ya da 413 döner. */
const LIMITS = {
  /* HTTP */
  maxBodyBytes: num('MAX_BODY', 32 * 1024 * 1024),
  requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 60_000),
  headersTimeoutMs: num('HEADERS_TIMEOUT_MS', 20_000),

  /* PDF */
  maxPdfBytes: num('MAX_PDF_BYTES', 64 * 1024 * 1024),
  maxPages: num('MAX_PAGES', 5000),
  maxOps: num('MAX_OPS', 500),

  /* HTML/CSS */
  maxHtmlBytes: num('MAX_HTML_BYTES', 4 * 1024 * 1024),
  maxCssBytes: num('MAX_CSS_BYTES', 2 * 1024 * 1024),
  maxTextBytes: num('MAX_TEXT_BYTES', 1024 * 1024),

  /* Varlıklar */
  maxImageBytes: num('MAX_IMAGE_BYTES', 16 * 1024 * 1024),
  maxImagePixels: num('MAX_IMAGE_PIXELS', 50_000_000),
  maxFontBytes: num('MAX_FONT_BYTES', 8 * 1024 * 1024),
  maxFonts: num('MAX_FONTS', 32),
  maxAssets: num('MAX_ASSETS', 256),

  /* PKCS#12 */
  maxPfxBytes: num('MAX_PFX_BYTES', 8 * 1024 * 1024),

  /* LTV */
  maxDssEntries: num('MAX_DSS_ENTRIES', 512)
};

/** Hız sınırı ayarları. */
const RATE = {
  windowMs: num('RATE_WINDOW_MS', 60_000),
  maxRequests: num('RATE_MAX', 120),
  /** Pahalı uçlar için ayrı, daha dar pencere. */
  maxSensitive: num('RATE_MAX_SENSITIVE', 20)
};

class PolicyError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* Doğrulayıcılar                                                      */
/* ------------------------------------------------------------------ */

function checkBytes(value, limitKey, label) {
  const length = value ? value.length : 0;
  if (length > LIMITS[limitKey]) {
    throw new PolicyError('ERR_TOO_LARGE',
      `${label} çok büyük: ${length} bayt (sınır ${LIMITS[limitKey]})`, 413);
  }
  return value;
}

function checkCount(actual, limitKey, label) {
  if (actual > LIMITS[limitKey]) {
    throw new PolicyError('ERR_TOO_MANY',
      `Çok fazla ${label}: ${actual} (sınır ${LIMITS[limitKey]})`, 400);
  }
  return actual;
}

/** PDF girdisini doğrular (boyut + sayfa sayısı). */
function checkPdf(buffer, doc) {
  checkBytes(buffer, 'maxPdfBytes', 'PDF');
  if (doc && doc.pageCount > LIMITS.maxPages) {
    throw new PolicyError('ERR_TOO_MANY',
      `Sayfa sayısı sınırı aşıyor: ${doc.pageCount} (sınır ${LIMITS.maxPages})`, 400);
  }
  return buffer;
}

/* ------------------------------------------------------------------ */
/* Kimlik doğrulama                                                    */
/* ------------------------------------------------------------------ */

/**
 * Yetenek tabanlı erişim denetimi.
 *
 * Uçlar üç sınıfa ayrılır:
 *
 *   public     `/api/health` — bilgi verir, iş yapmaz
 *   compute    `/api/render`, `/api/pdf/*`, `/api/verify` — pahalı ama zararsız
 *   sensitive  `/api/sign/*`, `/api/pfx/*`, `/api/ltv/*` — anahtar/kimlik dokunur
 *
 * Belirteç (token) yapılandırılmadıysa sunucu YALNIZ yerel arayüze bağlanır
 * ve uyarı basar. Dışarıya açık bir adrese bağlanıp belirteç istememek,
 * imzalama yeteneğini internete açmak demektir.
 */
const AUTH = {
  /** Virgülle ayrılmış belirteçler; hiçbiri yoksa kimlik doğrulama kapalıdır. */
  tokens: (process.env.API_TOKENS || '')
    .split(',').map((t) => t.trim()).filter(Boolean),

  /** Yalnız hassas uçlar korunsun (varsayılan) ya da hepsi. */
  scope: (process.env.API_AUTH_SCOPE || 'sensitive').toLowerCase()
};

/** Uç adına göre sınıf. */
function classify(routeKey) {
  if (/\/api\/(sign|pfx|ltv)\b/.test(routeKey)) return 'sensitive';
  if (/\/api\/health\b/.test(routeKey)) return 'public';
  return 'compute';
}

/** Kimlik doğrulama etkin mi? */
function authEnabled() {
  return AUTH.tokens.length > 0;
}

/**
 * İsteğin belirtecini sabit zamanlı karşılaştırmayla doğrular.
 *
 * Sabit zaman önemlidir: uzunluk ya da erken çıkış farkı, belirtecin
 * karakterlerini tek tek tahmin etmeye yarayan bir yan kanal açar.
 */
function tokenValid(presented) {
  if (!presented) return false;
  const given = Buffer.from(String(presented), 'utf8');

  let ok = false;
  for (const token of AUTH.tokens) {
    const expected = Buffer.from(token, 'utf8');
    // Uzunluk farkı da sızmasın diye her ikisini sabit uzunluğa özetliyoruz
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    if (crypto.timingSafeEqual(a, b)) ok = true;
  }
  return ok;
}

/** `Authorization: Bearer …` ya da `X-API-Token` başlığını okur. */
function presentedToken(req) {
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const header = req.headers['x-api-token'];
  return header ? String(header).trim() : null;
}

/**
 * İsteğin bu ucu kullanmaya yetkisi var mı?
 * @returns {{ allowed: boolean, code?: string, message?: string, status?: number }}
 */
function authorize(req, routeKey) {
  const kind = classify(routeKey);
  if (kind === 'public') return { allowed: true, kind };

  if (!authEnabled()) {
    // Belirteç yapılandırılmamış: yalnız yerel kullanım varsayımı
    return { allowed: true, kind, unauthenticated: true };
  }
  if (AUTH.scope !== 'all' && kind !== 'sensitive') {
    return { allowed: true, kind };
  }

  if (!tokenValid(presentedToken(req))) {
    return {
      allowed: false, kind, status: 401, code: 'ERR_UNAUTHORIZED',
      message: 'Geçerli bir API belirteci gerekiyor (Authorization: Bearer …)'
    };
  }
  return { allowed: true, kind, authenticated: true };
}

/* ------------------------------------------------------------------ */
/* Hız sınırı                                                          */
/* ------------------------------------------------------------------ */

/**
 * Kayan pencereli, bellek içi hız sınırlayıcı.
 *
 * Tek süreç için yeterlidir; birden çok örnekli dağıtımda paylaşımlı bir
 * depoya taşınmalıdır. Bunu bilmek, hiç sınır koymamaktan iyidir.
 */
class RateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || RATE.windowMs;
    this.buckets = new Map();       // anahtar → zaman damgaları
    this.maxKeys = 10_000;          // sınırlayıcının kendisi de sınırlı olmalı
  }

  /** @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }} */
  hit(key, limit) {
    const now = Date.now();
    let hits = this.buckets.get(key);

    if (!hits) {
      if (this.buckets.size >= this.maxKeys) this.sweep(now);
      hits = [];
      this.buckets.set(key, hits);
    }

    // Pencere dışına çıkanları at
    const cutoff = now - this.windowMs;
    while (hits.length && hits[0] < cutoff) hits.shift();

    if (hits.length >= limit) {
      return { allowed: false, remaining: 0, retryAfterMs: hits[0] + this.windowMs - now };
    }
    hits.push(now);
    return { allowed: true, remaining: limit - hits.length, retryAfterMs: 0 };
  }

  sweep(now = Date.now()) {
    const cutoff = now - this.windowMs;
    for (const [key, hits] of this.buckets) {
      while (hits.length && hits[0] < cutoff) hits.shift();
      if (!hits.length) this.buckets.delete(key);
    }
  }

  reset() { this.buckets.clear(); }
}

/** İstek sahibini tanımlayan anahtar (belirteç varsa o, yoksa IP). */
function clientKey(req) {
  const token = presentedToken(req);
  if (token) return 't:' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
  const ip = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'bilinmeyen';
  return 'ip:' + ip;
}

/* ------------------------------------------------------------------ */
/* Denetim günlüğü                                                     */
/* ------------------------------------------------------------------ */

/**
 * Hassas işlemleri kaydeder.
 *
 * ASLA kaydedilmeyenler: parola, PFX içeriği, özel anahtar, imza değeri.
 * Kaydedilen: ne yapıldı, kim yaptı (belirteç özeti), ne zaman, sonuç.
 */
function auditLog(event) {
  if (process.env.AUDIT_LOG === '0') return;
  const line = {
    ts: new Date().toISOString(),
    event: event.event,
    route: event.route,
    client: event.client,
    outcome: event.outcome,
    ...(event.detail ? { detail: event.detail } : {})
  };
  process.stderr.write('AUDIT ' + JSON.stringify(line) + '\n');
}

module.exports = {
  LIMITS, RATE, AUTH, PolicyError,
  checkBytes, checkCount, checkPdf,
  authorize, authEnabled, classify, clientKey, presentedToken, tokenValid,
  RateLimiter, auditLog
};
