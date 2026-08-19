'use strict';
/**
 * PDF belge modeli: nesne çözümü, sayfa ağacı, kaynaklar.
 */

const { Lexer, Dict, Ref, Name, Str, Stream, PdfSyntaxError, serialize } = require('./lexer');
const { XRef, ENTRY_NORMAL, ENTRY_COMPRESSED, ENTRY_FREE, nameList, plainParms } = require('./xref');
const { decodeStream } = require('./filters');
const { StandardSecurityHandler, CryptError } = require('./crypt');

class PdfDocumentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PdfDocumentError';
    this.code = code;
  }
}

/** Sayfalardan miras alınan özellikler (ISO 32000-1 Tablo 30). */
const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];

class PdfDocument {
  /**
   * @param {Buffer} buf
   * @param {{ password?: string }} [opts]
   */
  constructor(buf, opts = {}) {
    if (!Buffer.isBuffer(buf)) {
      throw new PdfDocumentError('ERR_PDF_INPUT', 'PdfDocument: Buffer bekleniyor');
    }
    this.buf = buf;
    this.opts = opts;

    this.xref = XRef.parse(buf);
    this.cache = new Map();
    this.objStmCache = new Map();
    this.crypt = null;

    /** Değiştirilmiş/eklenmiş nesneler — kaydederken artımlı revizyona yazılır.
     *  Nesne çözümü bu haritaya baktığı için kataloğu okumadan ÖNCE kurulur. */
    this.changes = new Map();
    this.nextObjNum = Math.max(this.xref.size, maxObjNum(this.xref) + 1);

    this._setupEncryption(opts.password || '');

    this.trailer = this.xref.trailer;
    this.catalog = this.resolve(this.trailer.get('Root'));
    if (!(this.catalog instanceof Dict)) {
      throw new PdfDocumentError('ERR_PDF_NO_CATALOG', 'Belge kataloğu (/Root) okunamadı');
    }
  }

  static load(buf, opts) { return new PdfDocument(buf, opts); }

  /* ---------------------------------------------------------------- */
  /* Şifreleme                                                         */
  /* ---------------------------------------------------------------- */

  _setupEncryption(password) {
    const encryptRef = this.xref.trailer.get('Encrypt');
    if (!encryptRef) return;

    // /Encrypt sözlüğünün KENDİSİ şifrelenmez; ham okunur.
    const dict = this._fetchRaw(encryptRef instanceof Ref ? encryptRef.num : null)
      || (encryptRef instanceof Dict ? encryptRef : null);
    if (!(dict instanceof Dict)) {
      throw new PdfDocumentError('ERR_PDF_ENCRYPT', '/Encrypt sözlüğü okunamadı');
    }

    const id = this.xref.trailer.get('ID');
    const idFirst = Array.isArray(id) && id[0] instanceof Str ? id[0].bytes : Buffer.alloc(0);

    try {
      this.crypt = new StandardSecurityHandler(dict, idFirst, password);
    } catch (err) {
      if (err instanceof CryptError) {
        throw new PdfDocumentError(err.code, err.message);
      }
      throw err;
    }
    this.encryptRefNum = encryptRef instanceof Ref ? encryptRef.num : null;
  }

  /* ---------------------------------------------------------------- */
  /* Nesne erişimi                                                     */
  /* ---------------------------------------------------------------- */

  /** Referansı çözer; referans değilse değeri olduğu gibi döndürür. */
  resolve(value, depth = 0) {
    if (!(value instanceof Ref) || depth > 32) return value;
    return this.resolve(this.getObject(value.num, value.gen), depth + 1);
  }

  /** Sözlükten bir anahtarı okur ve çözer. */
  get(dict, key) {
    if (!(dict instanceof Dict)) return undefined;
    return this.resolve(dict.get(key));
  }

  /** Bir nesneyi numarasıyla getirir. */
  getObject(num, gen = 0) {
    if (this.changes.has(num)) return this.changes.get(num).value;

    const cacheKey = num;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    const entry = this.xref.getEntry(num);
    if (!entry || entry.type === ENTRY_FREE) {
      this.cache.set(cacheKey, null);
      return null;
    }

    let value = null;
    try {
      value = entry.type === ENTRY_COMPRESSED
        ? this._fetchFromObjStm(entry.objStm, entry.index, num)
        : this._fetchAt(entry.offset, num, entry.gen != null ? entry.gen : gen);
    } catch (err) {
      value = null;
    }

    this.cache.set(cacheKey, value);
    return value;
  }

  /** Şifre çözmeden ham nesne okur (/Encrypt için gerekli). */
  _fetchRaw(num) {
    if (num == null) return null;
    const entry = this.xref.getEntry(num);
    if (!entry || entry.type !== ENTRY_NORMAL) return null;
    try {
      const lexer = new Lexer(this.buf, entry.offset, {
        resolveLength: (ref) => {
          const e = this.xref.getEntry(ref.num);
          if (!e || e.type !== ENTRY_NORMAL) return null;
          const l = new Lexer(this.buf, e.offset);
          l.readToken(); l.readToken(); l.readToken();
          const v = l.parseObject();
          return typeof v === 'number' ? v : null;
        }
      });
      lexer.readToken(); lexer.readToken();
      if (lexer.readToken() !== 'obj') return null;
      return lexer.parseObject();
    } catch {
      return null;
    }
  }

  /** Dosyadaki bir konumdan nesne okur. */
  _fetchAt(offset, num, gen) {
    if (offset == null || offset < 0 || offset >= this.buf.length) return null;

    const lexer = new Lexer(this.buf, offset, {
      resolveLength: (ref) => {
        const v = this.getObject(ref.num, ref.gen);
        return typeof v === 'number' ? v : null;
      }
    });

    lexer.skipWhitespace();
    const numToken = lexer.readToken();
    const genToken = lexer.readToken();
    const kw = lexer.readToken();

    if (kw !== 'obj') {
      // xref yanlış olabilir: doğru başlığı yakında ara
      const found = this._findObjectHeader(num);
      if (found == null || found === offset) return null;
      this.offsetsRepaired = true;
      return this._fetchAt(found, num, gen);
    }
    // Numara uyuşmuyorsa xref bozuktur
    if (parseInt(numToken, 10) !== num) {
      const found = this._findObjectHeader(num);
      if (found != null && found !== offset) {
        this.offsetsRepaired = true;
        return this._fetchAt(found, num, gen);
      }
    }

    const obj = lexer.parseObject();
    return this._decryptObject(obj, num, parseInt(genToken, 10) || 0);
  }

  /**
   * Nesnenin orijinal dosyadaki DOĞRULANMIŞ konumunu döndürür.
   * xref'teki offset gerçekten `num G obj` başlığını göstermiyorsa dosyayı
   * tarayarak düzeltir; hiç bulunamazsa `null`.
   */
  offsetOf(num) {
    const entry = this.xref.getEntry(num);
    if (entry && entry.type === ENTRY_NORMAL && this._isHeaderAt(entry.offset, num)) {
      return entry.offset;
    }
    const found = this._findObjectHeader(num);
    return found != null && this._isHeaderAt(found, num) ? found : null;
  }

  /** Verilen konumda `num G obj` başlığı var mı? */
  _isHeaderAt(offset, num) {
    if (offset == null || offset < 0 || offset >= this.buf.length) return false;
    const end = Math.min(this.buf.length, offset + 48);
    const m = /^[\s]*(\d+)[\s]+(\d+)[\s]+obj\b/.exec(this.buf.toString('latin1', offset, end));
    return !!m && parseInt(m[1], 10) === num;
  }

  /** `N G obj` başlığını dosyada arar (bozuk xref kurtarması). */
  _findObjectHeader(num) {
    if (!this._headerIndex) {
      this._headerIndex = new Map();
      const text = this.buf.toString('latin1');
      const re = /(?:^|[\s>])(\d+)\s+(\d+)\s+obj\b/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const n = parseInt(m[1], 10);
        this._headerIndex.set(n, m.index + (m[0].length - `${m[1]} ${m[2]} obj`.length));
      }
    }
    return this._headerIndex.get(num);
  }

  /** Nesne akışı (/ObjStm) içinden sıkıştırılmış nesne okur. */
  _fetchFromObjStm(stmNum, index, wantedNum) {
    let parsed = this.objStmCache.get(stmNum);

    if (!parsed) {
      const stm = this.getObject(stmNum);
      if (!(stm instanceof Stream)) return null;

      const data = this.getStreamData(stm, stmNum);
      const n = Number(this.get(stm.dict, 'N')) || 0;
      const first = Number(this.get(stm.dict, 'First')) || 0;

      // Başlık: N adet "objNum offset" çifti
      const headerLexer = new Lexer(data, 0);
      const pairs = [];
      for (let i = 0; i < n; i++) {
        const objNum = parseInt(headerLexer.readToken(), 10);
        const off = parseInt(headerLexer.readToken(), 10);
        if (!Number.isFinite(objNum) || !Number.isFinite(off)) break;
        pairs.push({ objNum, offset: first + off });
      }

      parsed = { data, pairs };
      this.objStmCache.set(stmNum, parsed);
    }

    // Önce sıra numarasına, olmazsa nesne numarasına göre bul
    let pair = parsed.pairs[index];
    if (!pair || pair.objNum !== wantedNum) {
      pair = parsed.pairs.find((p) => p.objNum === wantedNum) || pair;
    }
    if (!pair) return null;

    const lexer = new Lexer(parsed.data, pair.offset);
    // /ObjStm içindeki nesneler AYRICA şifrelenmez (akışın kendisi çözülmüştür)
    return lexer.parseObject();
  }

  /** Dizgi ve akışları çözer. */
  _decryptObject(obj, num, gen, depth = 0) {
    if (!this.crypt || depth > 32) return obj;
    if (num === this.encryptRefNum) return obj;

    if (obj instanceof Str) {
      return new Str(this.crypt.decrypt(obj.bytes, num, gen), obj.isHex);
    }
    if (Array.isArray(obj)) {
      return obj.map((v) => this._decryptObject(v, num, gen, depth + 1));
    }
    if (obj instanceof Stream) {
      obj.dict = this._decryptObject(obj.dict, num, gen, depth + 1);
      obj._cryptNum = num;
      obj._cryptGen = gen;
      return obj;
    }
    if (obj instanceof Dict) {
      const out = new Dict();
      for (const [k, v] of obj.map) out.set(k, this._decryptObject(v, num, gen, depth + 1));
      return out;
    }
    return obj;
  }

  /* ---------------------------------------------------------------- */
  /* Akışlar                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Bir akışın çözülmüş içeriğini döndürür.
   * @param {Stream} stream
   * @param {number} [objNum] şifre çözme için nesne numarası
   * @returns {Buffer}
   */
  getStreamData(stream, objNum) {
    if (!(stream instanceof Stream)) {
      throw new PdfDocumentError('ERR_PDF_NOT_STREAM', 'Akış bekleniyordu');
    }
    if (stream._decoded) return stream._decoded;

    let raw = stream.raw;
    if (this.crypt) {
      const num = stream._cryptNum != null ? stream._cryptNum : objNum;
      if (num != null) {
        const type = stream.dict.get('Type');
        const isXRef = type instanceof Name && type.name === 'XRef';
        // XRef akışları hiçbir zaman şifrelenmez
        if (!isXRef) raw = this.crypt.decrypt(raw, num, stream._cryptGen || 0);
      }
    }

    const { data, imageFilter } = decodeStream(
      raw,
      nameList(this.get(stream.dict, 'Filter')),
      plainParms(this.get(stream.dict, 'DecodeParms') || this.get(stream.dict, 'DP'))
    );
    stream._imageFilter = imageFilter;
    stream._decoded = data;
    return data;
  }

  /* ---------------------------------------------------------------- */
  /* Sayfalar                                                          */
  /* ---------------------------------------------------------------- */

  /** Sayfa referanslarını sırayla döndürür. */
  get pageRefs() {
    if (this._pageRefs) return this._pageRefs;

    const out = [];
    const seen = new Set();

    const walk = (ref, depth) => {
      if (depth > 64 || out.length > 20000) return;
      const key = ref instanceof Ref ? ref.key : null;
      if (key) {
        if (seen.has(key)) return;
        seen.add(key);
      }
      const node = this.resolve(ref);
      if (!(node instanceof Dict)) return;

      const type = node.get('Type');
      const typeName = type instanceof Name ? type.name : null;

      if (typeName === 'Page') { out.push(ref); return; }

      const kids = this.get(node, 'Kids');
      if (Array.isArray(kids)) {
        for (const kid of kids) walk(kid, depth + 1);
        return;
      }
      // /Type yoksa ama /Contents varsa sayfa say
      if (!typeName && node.has('Contents')) out.push(ref);
    };

    const pagesRef = this.catalog.get('Pages');
    walk(pagesRef, 0);

    // Sayfa ağacı bozuksa tüm nesneleri tara
    if (!out.length) {
      for (const [num, entry] of this.xref.entries) {
        if (entry.type === ENTRY_FREE) continue;
        const obj = this.getObject(num);
        if (obj instanceof Dict) {
          const t = obj.get('Type');
          if (t instanceof Name && t.name === 'Page') out.push(new Ref(num, entry.gen || 0));
        }
      }
    }

    this._pageRefs = out;
    return out;
  }

  get pageCount() { return this.pageRefs.length; }

  /** Sayfa sözlüğünü (miras alınan alanlar çözülmüş hâlde) döndürür. */
  getPage(index) {
    const ref = this.pageRefs[index];
    if (!ref) throw new PdfDocumentError('ERR_PDF_NO_PAGE', `Sayfa ${index} yok`);
    const dict = this.resolve(ref);
    return { ref, dict, index };
  }

  /** Sayfadan (gerekirse üst düğümlerden) bir özelliği okur. */
  getPageProperty(pageDict, key, depth = 0) {
    if (!(pageDict instanceof Dict) || depth > 64) return undefined;
    if (pageDict.has(key)) return this.resolve(pageDict.get(key));
    return this.getPageProperty(this.resolve(pageDict.get('Parent')), key, depth + 1);
  }

  /** Sayfa geometrisi: kutu, dönme, efektif genişlik/yükseklik. */
  getPageGeometry(index) {
    const { dict } = this.getPage(index);

    const box = normalizeBox(this.getPageProperty(dict, 'MediaBox')) || [0, 0, 612, 792];
    const cropRaw = normalizeBox(this.getPageProperty(dict, 'CropBox'));
    const crop = cropRaw || box;

    let rotate = Number(this.getPageProperty(dict, 'Rotate')) || 0;
    rotate = ((rotate % 360) + 360) % 360;

    const width = crop[2] - crop[0];
    const height = crop[3] - crop[1];
    const swapped = rotate === 90 || rotate === 270;

    return {
      mediaBox: box,
      cropBox: crop,
      rotate,
      width: swapped ? height : width,
      height: swapped ? width : height,
      rawWidth: width,
      rawHeight: height
    };
  }

  /** Sayfanın birleştirilmiş içerik akışı. */
  getPageContent(index) {
    const { dict } = this.getPage(index);
    const contents = this.resolve(dict.get('Contents'));

    if (contents instanceof Stream) return this.getStreamData(contents);

    if (Array.isArray(contents)) {
      const parts = [];
      for (const item of contents) {
        const s = this.resolve(item);
        if (s instanceof Stream) {
          parts.push(this.getStreamData(s));
          parts.push(Buffer.from('\n'));
        }
      }
      return Buffer.concat(parts);
    }
    return Buffer.alloc(0);
  }

  /* ---------------------------------------------------------------- */
  /* Üst veri                                                          */
  /* ---------------------------------------------------------------- */

  getInfo() {
    const info = this.resolve(this.trailer.get('Info'));
    if (!(info instanceof Dict)) return {};
    const out = {};
    for (const [k, v] of info.map) {
      const value = this.resolve(v);
      out[k] = value instanceof Str ? value.toText() : value;
    }
    return out;
  }

  /** Belge şifreli mi? */
  get isEncrypted() { return !!this.crypt; }

  /** İmza alanları var mı? */
  get hasSignatures() {
    const acro = this.get(this.catalog, 'AcroForm');
    if (!(acro instanceof Dict)) return false;
    const fields = this.get(acro, 'Fields');
    if (!Array.isArray(fields)) return false;
    for (const ref of fields) {
      const f = this.resolve(ref);
      if (!(f instanceof Dict)) continue;
      const ft = f.get('FT');
      if (ft instanceof Name && ft.name === 'Sig' && f.has('V')) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Değişiklik kaydı                                                  */
  /* ---------------------------------------------------------------- */

  /** Yeni nesne numarası ayırır. */
  allocObjNum() { return this.nextObjNum++; }

  /** Bir nesneyi değiştirir/ekler (kaydetmede artımlı revizyona yazılır). */
  setObject(num, value) {
    this.changes.set(num, { num, value });
    this.cache.delete(num);
    return new Ref(num, 0);
  }

  /** Yeni nesne ekler, referansını döndürür. */
  addObject(value) {
    const num = this.allocObjNum();
    return this.setObject(num, value);
  }

  get isModified() { return this.changes.size > 0; }

  /* ---------------------------------------------------------------- */
  /* Kaydetme                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Belgeyi kaydeder.
   *
   * Varsayılan artımlı güncellemedir: orijinal baytlar korunur, mevcut
   * imzalar geçerli kalır. `{ full: true }` verilirse belge sıfırdan yazılır
   * (imzalı belgelerde hata verir; `force: true` ile bastırılabilir).
   *
   * @param {{ full?: boolean, force?: boolean, compress?: boolean }} [opts]
   * @returns {Buffer}
   */
  save(opts = {}) {
    const { writeIncremental, writeFull } = require('./writer');
    return opts.full ? writeFull(this, opts) : writeIncremental(this, opts);
  }

  /** Kaydeder ve sonucu yeni bir belge olarak geri yükler. */
  saveAndReload(opts = {}) {
    return new PdfDocument(this.save(opts), this.opts);
  }

  /* ---------------------------------------------------------------- */
  /* Düzenleme kısayolları                                             */
  /* ---------------------------------------------------------------- */

  removePage(index) { return require('./edit').removePage(this, index); }
  movePage(from, to) { return require('./edit').movePage(this, from, to); }
  reorderPages(order) { return require('./edit').reorderPages(this, order); }
  rotatePage(index, degrees) { return require('./edit').rotatePage(this, index, degrees); }
  insertPage(index, options) { return require('./edit').insertPage(this, index, options); }
  appendContent(pageIndex, commands) { return require('./edit').appendContent(this, pageIndex, commands); }
  addImage(pageIndex, buffer, placement) { return require('./edit').addImage(this, pageIndex, buffer, placement); }
  addText(pageIndex, text, options) { return require('./edit').addText(this, pageIndex, text, options); }
  addLink(pageIndex, rect, uri) { return require('./edit').addLink(this, pageIndex, rect, uri); }
  setMetadata(metadata) { return require('./edit').setMetadata(this, metadata); }
  importPages(sourceDoc, indexes) { return require('./edit').importPages(this, sourceDoc, indexes); }

  /* ---------------------------------------------------------------- */
  /* Metin ve formlar                                                  */
  /* ---------------------------------------------------------------- */

  extractText(pageIndex, opts) { return require('./text').extractText(this, pageIndex, opts); }
  extractTextItems(pageIndex) { return require('./text').extractTextItems(this, pageIndex); }
  extractDocumentText(opts) { return require('./text').extractDocumentText(this, opts); }

  listFields() { return require('./acroform').listFields(this); }
  fillForm(values, opts) { return require('./acroform').fillForm(this, values, opts); }
  flattenForm(opts) { return require('./acroform').flattenForm(this, opts); }
  get hasForm() { return !!require('./acroform').getAcroForm(this); }
}

/* ------------------------------------------------------------------ */

function normalizeBox(box) {
  if (!Array.isArray(box) || box.length < 4) return null;
  const nums = box.map((v) => Number(v) || 0);
  return [
    Math.min(nums[0], nums[2]), Math.min(nums[1], nums[3]),
    Math.max(nums[0], nums[2]), Math.max(nums[1], nums[3])
  ];
}

function maxObjNum(xref) {
  let max = 0;
  for (const num of xref.entries.keys()) if (num > max) max = num;
  return max;
}

module.exports = { PdfDocument, PdfDocumentError, INHERITABLE, normalizeBox };
