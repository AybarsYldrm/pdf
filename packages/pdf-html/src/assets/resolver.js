'use strict';
/**
 * Varlık (asset) çözümleyici — dosya sistemi kum havuzu.
 *
 * TEHDİT: `render({ html })` çağrısına gelen HTML **güvenilmez** girdidir.
 * Sunucu bunu `/api/render` üzerinden herkesten alır. HTML içindeki
 * `<img src>` ve `@font-face url()` değerleri doğrudan `fs.readFileSync`e
 * verilirse saldırgan sunucunun dosya sistemini okur:
 *
 *     <img src="../../../../etc/passwd">        → yol kaçışı
 *     <img src="/home/kullanici/.ssh/id_rsa">   → mutlak yol
 *     <img src="/proc/self/environ">            → ortam değişkenleri
 *     <img src="C:\Windows\win.ini">            → Windows mutlak yol
 *     <img src="\\\\sunucu\\paylasim\\x">       → UNC yolu
 *     <img src="%2e%2e%2fgizli.png">            → kodlanmış kaçış
 *     <img src="link.png">  (kum havuzu dışına symlink)
 *
 * Dosya bir PNG/JPEG olmasa bile **varlık kâhini** (existence oracle) oluşur:
 * hata mesajı "bulunamadı" ile "geçersiz PNG" arasında ayrım yapar.
 *
 * SAVUNMA: kök dizin(ler) dışına çıkış yapısal olarak imkânsız kılınır.
 *
 *     girdi
 *       ↓ şema reddi (http:, file:, data: ayrı ele alınır)
 *       ↓ yüzde kodu çözme (tekrarlı)
 *       ↓ ayırıcı normalleştirme
 *       ↓ mutlak yol reddi
 *       ↓ resolve
 *       ↓ realpath  ← symlink/junction burada açılır
 *       ↓ kapsama doğrulaması
 *       ↓ oku
 *
 * `realpath` ADIMI ATLANAMAZ: kum havuzu içindeki bir symlink `/etc`e
 * işaret edebilir ve yalnız metinsel kontrol bunu göremez.
 */

const fs = require('fs');
const path = require('path');
const { assertImageWithinLimits } = require('@fitfak/pdf/src/media/imageinfo');

class AssetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AssetError';
    this.code = code;
  }
}

/**
 * Varsayılan boyut sınırları (DoS'a karşı).
 *
 * `maxImagePixels` ayrı durur ve BAYT sınırından bağımsızdır: 40 KB'lık bir
 * PNG, başlığında 20 000 × 20 000 bildirebilir ve çözüldüğünde 1,6 GB tutar.
 * Bayt sınırı bunu yakalayamaz (bkz. media/imageinfo.js).
 */
const DEFAULT_LIMITS = {
  maxImageBytes: 16 * 1024 * 1024,
  maxImagePixels: 50_000_000,
  maxImageDecodedBytes: 512 * 1024 * 1024,
  maxFontBytes: 8 * 1024 * 1024,
  maxAssets: 256
};

/** `data:` URL'inde izin verilen MIME türleri. */
const DATA_MIME = new Set([
  'image/png', 'image/jpeg', 'image/jpg',
  'font/ttf', 'font/otf', 'application/font-sfnt',
  'application/octet-stream'
]);

/**
 * Yüzde kodlamasını çözer — kaçış ÇİFT kodlanmış olabilir (`%252e%252e`).
 * Değişim durana kadar tekrarlanır; sınırlı tur sayısıyla sonsuz döngü yok.
 */
function fullyDecode(value) {
  let current = String(value);
  for (let i = 0; i < 4; i++) {
    let next;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current;              // bozuk kodlama: olduğu gibi bırak
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

/** Windows mutlak yolu, UNC yolu ya da sürücü harfi mi? */
function looksAbsolute(value) {
  return path.isAbsolute(value)
    || /^[a-zA-Z]:[\\/]/.test(value)       // C:\ ya da C:/
    || /^[\\/]{2}/.test(value);            // \\sunucu\paylasim ya da //sunucu
}

/**
 * Dosya sistemi kum havuzu.
 *
 * Kökler `realpath` ile bir kez çözülür ve karşılaştırmalar hep çözülmüş
 * yollar üzerinden yapılır: kökün kendisi bir symlink olsa bile tutarlı.
 */
class AssetResolver {
  /**
   * @param {{ roots?: string[], allowAbsolute?: boolean, allowRemote?: boolean,
   *           allowData?: boolean, limits?: Object, remote?: Object }} [options]
   *        `roots` boşsa HİÇBİR dosya okunamaz (yalnız `data:` ve Buffer).
   *        `remote` uzak getiriciye geçer: `allowHosts`, `denyHosts`,
   *        `maxBytes`, `timeoutMs`, `maxRedirects`.
   */
  constructor(options = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
    this.allowAbsolute = options.allowAbsolute === true;
    this.allowRemote = options.allowRemote === true;
    this.allowData = options.allowData !== false;
    this.remoteOptions = options.remote || {};

    this.roots = [];
    for (const root of options.roots || []) {
      if (!root) continue;
      try {
        this.roots.push(fs.realpathSync(path.resolve(root)));
      } catch {
        // Var olmayan kök sessizce atlanır: yanlışlıkla "her yer serbest"
        // durumuna düşmemek için listeye eklenmez.
      }
    }

    /** Okunan varlıklar — tekrar okumayı ve sayaç aşımını önler. */
    this.cache = new Map();
    /** Önceden indirilmiş uzak kaynaklar: url → { data } ya da { error }. */
    this.remoteCache = new Map();
    /** Reddedilen erişimler; çağıran raporlayabilsin diye tutulur. */
    this.rejections = [];
  }

  /**
   * Uzak kaynakları ÖNCEDEN, paralel olarak indirir.
   *
   * Hatalar fırlatılmaz, önbelleğe yazılır: bir görselin indirilememesi
   * bütün belgeyi düşürmemeli, o görselin yerinde bir uyarı bırakmalıdır.
   *
   * @param {Iterable<string>} urls
   * @returns {Promise<{ fetched: number, failed: number }>}
   */
  async prefetch(urls) {
    const unique = [...new Set([...urls].filter((u) => /^https?:\/\//i.test(String(u))))];
    if (!unique.length) return { fetched: 0, failed: 0 };

    if (!this.allowRemote) {
      for (const url of unique) {
        this.remoteCache.set(url, {
          error: new AssetError('ERR_ASSET_REMOTE',
            `Uzak kaynak yükleme kapalı (SSRF koruması): ${url.slice(0, 80)}`)
        });
      }
      return { fetched: 0, failed: unique.length };
    }

    const { fetchRemoteAsset } = require('@fitfak/netguard');
    const budget = this.remoteOptions.maxRemote || 32;
    let fetched = 0;
    let failed = 0;

    await Promise.all(unique.slice(0, budget).map(async (url) => {
      if (this.remoteCache.has(url)) return;
      try {
        const result = await fetchRemoteAsset(url, {
          maxBytes: this.limits.maxImageBytes,
          ...this.remoteOptions
        });
        this.remoteCache.set(url, { data: result.data, contentType: result.contentType });
        fetched++;
      } catch (err) {
        this.remoteCache.set(url, {
          error: new AssetError(err.code || 'ERR_ASSET_REMOTE', err.message)
        });
        failed++;
      }
    }));

    for (const url of unique.slice(budget)) {
      this.remoteCache.set(url, {
        error: new AssetError('ERR_ASSET_TOO_MANY',
          `Uzak kaynak sayısı sınırı aşıldı (${budget})`)
      });
      failed++;
    }

    return { fetched, failed };
  }

  /** Kaynağın kum havuzu içinde olup olmadığını söyler (okumadan). */
  isAllowed(src) {
    try {
      this.resolvePath(src);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Kaynak dizesini kum havuzu içindeki gerçek bir dosya yoluna çevirir.
   * @throws {AssetError} kum havuzu dışıysa
   */
  resolvePath(src) {
    const raw = String(src == null ? '' : src).trim();
    if (!raw) throw new AssetError('ERR_ASSET_EMPTY', 'Boş varlık kaynağı');

    // Şema taşıyan kaynaklar dosya yolu DEĞİLDİR.
    // Tek harfli "şema" aslında Windows sürücü harfidir (C:\...): onu
    // mutlak yol olarak sınıflandırmak daha doğru bir sinyal verir.
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
    if (scheme && scheme[1].length > 1) {
      const name = scheme[1].toLowerCase();
      if (name === 'data') {
        throw new AssetError('ERR_ASSET_IS_DATA', 'data: URL dosya yolu değil');
      }
      // `file:` kum havuzunu atlatmanın kestirme yoludur; uzak şemalar SSRF'tir
      const remote = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) && name !== 'file';
      throw new AssetError(remote ? 'ERR_ASSET_REMOTE' : 'ERR_ASSET_SCHEME',
        `Şemalı kaynaklara izin verilmiyor: ${name}: (${raw.slice(0, 60)})`);
    }

    const decoded = fullyDecode(raw).replace(/\\/g, '/');

    // NUL baytı: bazı sistem çağrılarında yolu erken keser
    if (decoded.includes('\0')) {
      throw new AssetError('ERR_ASSET_NUL', 'Varlık yolunda NUL baytı var');
    }

    if (looksAbsolute(decoded) && !this.allowAbsolute) {
      throw new AssetError('ERR_ASSET_ABSOLUTE',
        `Mutlak yollara izin verilmiyor: ${decoded.slice(0, 80)}`);
    }

    if (!this.roots.length) {
      throw new AssetError('ERR_ASSET_NO_ROOT',
        'Varlık kökü tanımlı değil; dosya sisteminden okuma kapalı');
    }

    for (const root of this.roots) {
      const candidate = path.resolve(root, decoded.replace(/^\/+/, ''));

      // Metinsel kontrol: hızlı eleme
      if (!isInside(root, candidate)) continue;

      // Gerçek kontrol: symlink/junction burada açılır
      let real;
      try {
        real = fs.realpathSync(candidate);
      } catch {
        continue;                  // yok ya da okunamıyor
      }
      if (!isInside(root, real)) {
        throw new AssetError('ERR_ASSET_SYMLINK_ESCAPE',
          `Varlık kum havuzu dışına bağlanıyor: ${decoded.slice(0, 80)}`);
      }

      const stat = fs.statSync(real);
      if (!stat.isFile()) {
        throw new AssetError('ERR_ASSET_NOT_FILE', `Dosya değil: ${decoded.slice(0, 80)}`);
      }
      return real;
    }

    throw new AssetError('ERR_ASSET_OUTSIDE',
      `Varlık kum havuzu dışında ya da bulunamadı: ${decoded.slice(0, 80)}`);
  }

  /**
   * Varlığı okur.
   *
   * @param {string|Buffer|Uint8Array} src yol, `data:` URL'i ya da doğrudan bayt
   * @param {{ kind?: 'image'|'font' }} [opts]
   * @returns {{ data: Buffer, source: 'buffer'|'data'|'file', path: string|null }}
   */
  read(src, opts = {}) {
    const kind = opts.kind || 'image';
    const maxBytes = kind === 'font' ? this.limits.maxFontBytes : this.limits.maxImageBytes;

    // 1) Doğrudan bayt — en güvenli yol, hiç dosya sistemine dokunulmaz
    if (Buffer.isBuffer(src)) return this.accept(src, 'buffer', null, maxBytes, kind);
    if (src instanceof Uint8Array) {
      return this.accept(Buffer.from(src), 'buffer', null, maxBytes, kind);
    }

    const raw = String(src == null ? '' : src).trim();

    // 2) data: URL
    if (/^data:/i.test(raw)) {
      if (!this.allowData) {
        throw new AssetError('ERR_ASSET_DATA_DISABLED', 'data: URL kapalı');
      }
      return this.accept(decodeDataUrl(raw), 'data', null, maxBytes, kind);
    }

    // 3) Uzak kaynak — varsayılan olarak KAPALI (SSRF).
    //    `file://` uzak değil, yerel dosya kaçışıdır: ayrı kodla bildirilir.
    const remoteScheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(raw);
    if (remoteScheme && remoteScheme[1].length > 1) {
      if (remoteScheme[1].toLowerCase() === 'file') {
        throw new AssetError('ERR_ASSET_SCHEME',
          `file: şemasına izin verilmiyor: ${raw.slice(0, 80)}`);
      }
      if (!this.allowRemote) {
        throw new AssetError('ERR_ASSET_REMOTE',
          `Uzak kaynak yükleme kapalı (SSRF koruması): ${raw.slice(0, 80)}`);
      }

      // Uzak kaynaklar ÖNCEDEN indirilir (`prefetch`). Bunun sebebi
      // `read()`in eşzamanlı olması değil sadece; yerleşim motorunun
      // ortasında ağ beklemek, tek bir yavaş sunucunun bütün derlemeyi
      // kilitlemesi demektir. Önceden indirmek hepsini paralel yapar ve
      // hatayı yerleşim başlamadan bildirir.
      const fetched = this.remoteCache.get(raw);
      if (!fetched) {
        throw new AssetError('ERR_ASSET_REMOTE_NOT_PREFETCHED',
          `Uzak kaynak önceden indirilmemiş: ${raw.slice(0, 80)}`);
      }
      if (fetched.error) throw fetched.error;
      return this.accept(fetched.data, 'remote', null, maxBytes, kind);
    }

    // 4) Kum havuzu içinde dosya
    const cached = this.cache.get(raw);
    if (cached) return cached;

    if (this.cache.size >= this.limits.maxAssets) {
      throw new AssetError('ERR_ASSET_TOO_MANY',
        `Varlık sayısı sınırı aşıldı (${this.limits.maxAssets})`);
    }

    const file = this.resolvePath(raw);
    const stat = fs.statSync(file);
    if (stat.size > maxBytes) {
      throw new AssetError('ERR_ASSET_TOO_LARGE',
        `Varlık çok büyük: ${stat.size} bayt (sınır ${maxBytes})`);
    }

    const result = this.accept(fs.readFileSync(file), 'file', file, maxBytes, kind);
    this.cache.set(raw, result);
    return result;
  }

  /**
   * Baytları kabul eder — bayt sınırı VE (görsellerde) piksel sınırı.
   *
   * Piksel denetimi burada yapılır çünkü burası, baytların ayrıştırıcıya
   * gitmeden önce geçtiği SON noktadır. Denetimi çağırana bırakmak,
   * çağıranlardan birinin unutması demektir.
   */
  accept(data, source, file, maxBytes, kind = 'image') {
    if (data.length > maxBytes) {
      throw new AssetError('ERR_ASSET_TOO_LARGE',
        `Varlık çok büyük: ${data.length} bayt (sınır ${maxBytes})`);
    }

    let info = null;
    if (kind === 'image') {
      try {
        info = assertImageWithinLimits(data, {
          maxPixels: this.limits.maxImagePixels,
          maxDecodedBytes: this.limits.maxImageDecodedBytes
        });
      } catch (err) {
        throw new AssetError(err.code || 'ERR_IMAGE_INVALID', err.message);
      }
    }

    return { data, source, path: file, info };
  }

  /** Reddedilen erişimi kaydeder (uyarı listesine dönüştürmek için). */
  reject(src, err) {
    this.rejections.push({ src: String(src).slice(0, 120), code: err.code, message: err.message });
    return err;
  }
}

/** `child`, `root`un içinde mi? Yol ayırıcı sınırına dikkat edilir. */
function isInside(root, child) {
  if (child === root) return true;
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return child.startsWith(withSep);
}

/** `data:` URL'ini baytlara çevirir. */
function decodeDataUrl(url) {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(url);
  if (!m) throw new AssetError('ERR_ASSET_DATA_MALFORMED', 'Bozuk data: URL');

  const mime = (m[1] || 'application/octet-stream').toLowerCase();
  if (!DATA_MIME.has(mime)) {
    throw new AssetError('ERR_ASSET_DATA_MIME', `data: URL için desteklenmeyen tür: ${mime}`);
  }
  return m[2]
    ? Buffer.from(m[3], 'base64')
    : Buffer.from(decodeURIComponent(m[3]), 'latin1');
}

module.exports = { AssetResolver, AssetError, DEFAULT_LIMITS, isInside, fullyDecode };
