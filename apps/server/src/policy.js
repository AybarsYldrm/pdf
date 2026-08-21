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

  /* Varlıklar
   * `maxImagePixels` bayt sınırından BAĞIMSIZ olmak zorundadır: 40 KB'lık
   * bir PNG başlığında 20 000 × 20 000 bildirip çözüldüğünde 1,6 GB tutar.
   * `maxImageDecodedBytes` ise bit derinliği yüksek görselleri yakalar. */
  maxImageBytes: num('MAX_IMAGE_BYTES', 16 * 1024 * 1024),
  maxImagePixels: num('MAX_IMAGE_PIXELS', 50_000_000),
  maxImageDecodedBytes: num('MAX_IMAGE_DECODED_BYTES', 512 * 1024 * 1024),
  maxFontBytes: num('MAX_FONT_BYTES', 8 * 1024 * 1024),
  maxFonts: num('MAX_FONTS', 32),
  maxAssets: num('MAX_ASSETS', 256),

  /* PKCS#12 */
  maxPfxBytes: num('MAX_PFX_BYTES', 8 * 1024 * 1024),

  /* LTV */
  maxDssEntries: num('MAX_DSS_ENTRIES', 512)
};

/**
 * Uzak varlık (belgeden gelen `http(s)://` görsel/font) ayarları.
 *
 * VARSAYILAN KAPALI. Açmanın tek yolu `REMOTE_ASSET_HOSTS` ile bir İZİN
 * LİSTESİ vermektir. "Aç ama her yere izin ver" seçeneği kasten yoktur:
 * izin listesi olmadan açmak, belgeye sunucunun ağına istek attırma
 * yetkisi vermek demektir (SSRF). Adres denetimi (özel/geri döngü/üstveri
 * blokları) zaten her hâlükârda çalışır ama tek başına yeterli sayılmaz —
 * DNS ile ulaşılabilen iç servisler o denetimden geçebilir.
 */
const REMOTE = {
  allowHosts: (process.env.REMOTE_ASSET_HOSTS || '')
    .split(',').map((h) => h.trim()).filter(Boolean),
  timeoutMs: num('REMOTE_ASSET_TIMEOUT_MS', 8000),
  maxRedirects: num('REMOTE_ASSET_MAX_REDIRECTS', 3),
  maxPerDocument: num('REMOTE_ASSET_MAX', 16),
  get enabled() { return this.allowHosts.length > 0; }
};

/** Hız sınırı ayarları. */
const RATE = {
  windowMs: num('RATE_WINDOW_MS', 60_000),
  maxRequests: num('RATE_MAX', 120),
  /** Pahalı uçlar için ayrı, daha dar pencere. */
  maxSensitive: num('RATE_MAX_SENSITIVE', 20),
  /**
   * Paylaşımlı sayaç dizini.
   *
   * Tanımlıysa sayaçlar dosyada tutulur ve aynı makinedeki BÜTÜN süreçler
   * aynı sayacı görür. Tanımlı değilse sayaç süreç belleğindedir — tek
   * süreçli kurulumda doğru, çok süreçlide sınırı süreç sayısıyla çarpar.
   */
  dir: (process.env.RATE_LIMIT_DIR || '').trim()
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
 * Belirteç (token) yapılandırılmadıysa hassas uçlar YALNIZ yerel arayüzde
 * çalışır. Dışa açık bir adreste belirteçsiz imzalama, PFX ve LTV uçları
 * 503 ile reddedilir: uyarı basmak bir denetim değildir, ve "yanlışlıkla
 * açık kalan bir dağıtım" tam olarak böyle olur.
 */
const AUTH = {
  /** Virgülle ayrılmış belirteçler; hiçbiri yoksa kimlik doğrulama kapalıdır. */
  tokens: (process.env.API_TOKENS || '')
    .split(',').map((t) => t.trim()).filter(Boolean),

  /** Yalnız hassas uçlar korunsun (varsayılan) ya da hepsi. */
  scope: (process.env.API_AUTH_SCOPE || 'sensitive').toLowerCase(),

  /**
   * Sunucunun bağlandığı adres. `start()` tarafından bildirilir.
   *
   * Yerel arayüze bağlıysa belirteç yokluğu kabul edilebilir bir geliştirme
   * varsayımıdır. Dışa açık bir adreste DEĞİLDİR: orada belirteçsiz bir
   * imzalama ucu, internete açık bir imzalama hizmeti demektir.
   */
  boundHost: null
};

/** Sunucunun bağlandığı adresi bildirir (yetki kararı buna bakar). */
function setBinding(host) {
  AUTH.boundHost = host ? String(host) : null;
}

/** Bağlanılan adres yerel arayüz dışında mı? */
function isExposed() {
  const h = AUTH.boundHost;
  if (!h) return false;                     // bilinmiyorsa varsayım: yerel
  return !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(h);
}

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
    // UYARI BİR DENETİM DEĞİLDİR. Eskiden burada yalnız konsola bir uyarı
    // basılıyor, istek yine de işleniyordu: dışa açık bir adrese bağlanmış
    // belirteçsiz bir sunucu, imzalama ve PFX uçlarını internete açıyordu.
    // Yerelde geliştirme yaparken belirteç istememek makul; dışarıda değil.
    if (kind === 'sensitive' && isExposed()) {
      return {
        allowed: false, kind, status: 503, code: 'ERR_AUTH_NOT_CONFIGURED',
        message: 'Sunucu dışa açık bir adrese bağlı ama API_TOKENS tanımlı ' +
          'değil. İmzalama, PFX ve LTV uçları kimlik doğrulaması olmadan ' +
          'kullanılamaz.'
      };
    }
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
 * Kayan pencereli hız sınırlayıcı.
 *
 * SAYAÇ NEREDE DURUYORSA SINIR ORADA GEÇERLİDİR. Sayaç süreç belleğindeyse,
 * sunucu iki süreçle çalıştığı anda sınır ikiye katlanır — rapor "sınır var"
 * der, gerçek başka söyler. Bu yüzden depo takılabilir: varsayılan bellek
 * deposu tek süreç için, `FileStore` aynı makinedeki bütün süreçler için.
 *
 * `RATE_LIMIT_DIR` tanımlıysa dosya deposu kendiliğinden seçilir.
 */
class RateLimiter {
  /**
   * @param {{ windowMs?: number, store?: Object, dir?: string }} [options]
   */
  constructor(options = {}) {
    this.windowMs = options.windowMs || RATE.windowMs;

    const dir = options.dir !== undefined ? options.dir : RATE.dir;
    if (options.store) {
      this.store = options.store;
    } else if (dir) {
      const { FileStore } = require('./ratestore');
      this.store = new FileStore({ dir });
    } else {
      const { MemoryStore } = require('./ratestore');
      this.store = new MemoryStore();
    }

    /** Süpürme her istekte değil, arada bir yapılır. */
    this._sweepEvery = 500;
    this._sinceSweep = 0;
  }

  /** @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }} */
  hit(key, limit) {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    if (++this._sinceSweep >= this._sweepEvery) {
      this._sinceSweep = 0;
      this.store.sweep(now, cutoff);
    }

    const { hits, recorded } = this.store.record(key, now, cutoff, limit);
    if (!recorded) {
      const oldest = hits.length ? hits[0] : now;
      return {
        allowed: false, remaining: 0,
        retryAfterMs: Math.max(1, oldest + this.windowMs - now)
      };
    }
    return { allowed: true, remaining: Math.max(0, limit - hits.length), retryAfterMs: 0 };
  }

  sweep(now = Date.now()) { this.store.sweep(now, now - this.windowMs); }

  reset() { this.store.clear(); }

  /** Sağlık ucu için: sayaç nerede duruyor, paylaşımlı mı? */
  describe() { return this.store.describe(); }
}

/** İstek sahibini tanımlayan anahtar (belirteç varsa o, yoksa IP). */
function clientKey(req) {
  const token = presentedToken(req);
  if (token) return 't:' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
  const ip = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'bilinmeyen';
  return 'ip:' + ip;
}

/* ------------------------------------------------------------------ */
/* Güven çapaları                                                      */
/* ------------------------------------------------------------------ */

/**
 * Sunucunun kendi doğrulamalarında kullandığı kök sertifikalar.
 *
 * `TRUST_ANCHORS` virgülle ayrılmış PEM dosya yollarıdır. TANIMLI DEĞİLSE
 * BOŞ DÖNER — ve bu, doğrulamanın "güvenilir zincir" diyememesi demektir.
 * Sistemin kök deposunu sessizce kullanmak, hangi köke güvenildiğini
 * belirsiz bırakırdı; imza doğrulamasında belirsizlik kabul edilemez.
 */
let _anchors = null;

function trustAnchors() {
  if (_anchors) return _anchors;

  const list = (process.env.TRUST_ANCHORS || '').split(',')
    .map((p) => p.trim()).filter(Boolean);

  const out = [];
  for (const file of list) {
    try {
      out.push(require('fs').readFileSync(file, 'utf8'));
    } catch (err) {
      console.warn(`[güven çapası] okunamadı: ${file} (${err.message})`);
    }
  }
  _anchors = out;
  return out;
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
  LIMITS, RATE, REMOTE, AUTH, PolicyError,
  checkBytes, checkCount, checkPdf,
  authorize, authEnabled, classify, clientKey, presentedToken, tokenValid,
  setBinding, isExposed,
  RateLimiter, auditLog, trustAnchors
};
