'use strict';
/**
 * İmzadan SONRA yapılan değişikliklerin gerçekten ne olduğunu bulur.
 *
 * PDF'te imza belgenin yalnız ilk N baytını kapsar. Sonrasına eklenen
 * "artımlı güncelleme" imzayı bozmaz — ama belgenin NE SÖYLEDİĞİNİ tamamen
 * değiştirebilir: sayfanın içerik akışını yeniden tanımlamak yeterlidir.
 * Bu, PDF imzalarına yönelik en pratik saldırıdır.
 *
 * ESKİ YAKLAŞIM BİR KANIT DEĞİLDİ. Doğrulayıcı imzadan sonraki baytların
 * metnine bakıp `/DSS` ya da `/VRI` görürse "bu yalnız doğrulama verisi"
 * diyordu. Saldırgan trailer'a bir `/DSS << /Certs [] >>` yazıp sayfanın
 * içerik akışını da değiştirdiğinde bayrak sönüyordu. Bir dizge aramak,
 * belgenin ne söylediğini öğrenmenin yolu değildir.
 *
 * YENİ YAKLAŞIM: iki belge de AÇILIR ve karşılaştırılır.
 *   - imzalanmış hâl  = pdfBuffer.slice(0, covered)  (imza anındaki dosya)
 *   - şimdiki hâl     = pdfBuffer
 * Sayfa sayısı, her sayfanın çözülmüş içerik akışı baytları, sayfa kutusu,
 * kaynaklardaki XObject özetleri ve belge düzeyindeki eylemler (OpenAction,
 * AA, Names/JavaScript) tek tek karşılaştırılır.
 *
 * PAdES'in İZİN VERDİĞİ değişiklikler ayrıca sınıflandırılır: DSS/VRI
 * eklenmesi, yeni imza alanı ve belge zaman damgası. Bunlar belgenin
 * görünen içeriğini değiştirmez, bu yüzden "değiştirilmiş" saymayız.
 */

const crypto = require('crypto');

/** Sonuç: hangi değişiklikler bulundu ve bunlar zararsız mı? */
function analyzeIncrementalChanges(pdfBuffer, coveredBytes) {
  const out = {
    analyzed: false,
    contentChanged: null,       // null = karar verilemedi
    appendedIsStructured: null, // eklenen bölüm geçerli bir artımlı güncelleme mi
    changes: [],
    errors: []
  };

  if (!Number.isInteger(coveredBytes) || coveredBytes <= 0 ||
      coveredBytes >= pdfBuffer.length) {
    // Kapsanmayan bayt yok: karşılaştıracak bir şey de yok.
    out.analyzed = true;
    out.contentChanged = false;
    out.appendedIsStructured = true;
    return out;
  }

  out.appendedIsStructured = isWellFormedAppend(pdfBuffer, coveredBytes);
  if (!out.appendedIsStructured) {
    out.changes.push('İmzadan sonra eklenen baytlar geçerli bir artımlı ' +
      'güncelleme oluşturmuyor (xref/trailer yok) — belgeye ait olmayan veri');
  }

  let PdfDocument;
  try {
    ({ PdfDocument } = require('@fitfak/pdf-doc'));
  } catch (err) {
    out.errors.push(`PDF okuyucu yüklenemedi: ${err.message}`);
    return out;
  }

  let before, after;
  try {
    before = new PdfDocument(pdfBuffer.slice(0, coveredBytes));
    after = new PdfDocument(pdfBuffer);
  } catch (err) {
    // Açılamayan bir belge "değişmemiş" sayılamaz. `contentChanged` null
    // kalır ve çağıran taraf bunu belirsizlik olarak raporlar.
    out.errors.push(`Sürüm karşılaştırılamadı: ${err.message}`);
    return out;
  }

  out.analyzed = true;

  const snapBefore = safeSnapshot(before, out, 'imzalanmış sürüm');
  const snapAfter = safeSnapshot(after, out, 'güncel sürüm');
  if (!snapBefore || !snapAfter) return out;

  if (snapBefore.pageCount !== snapAfter.pageCount) {
    out.changes.push(
      `Sayfa sayısı değişti: ${snapBefore.pageCount} → ${snapAfter.pageCount}`);
  }

  const n = Math.min(snapBefore.pages.length, snapAfter.pages.length);
  for (let i = 0; i < n; i++) {
    const a = snapBefore.pages[i];
    const b = snapAfter.pages[i];
    if (a.contentDigest !== b.contentDigest) {
      out.changes.push(`Sayfa ${i + 1}: içerik akışı değiştirildi`);
    }
    if (a.box !== b.box) {
      out.changes.push(`Sayfa ${i + 1}: sayfa kutusu değişti (${a.box} → ${b.box})`);
    }
    if (a.xobjects !== b.xobjects) {
      out.changes.push(`Sayfa ${i + 1}: gömülü nesneler (XObject) değişti`);
    }
  }

  for (const key of ['openAction', 'aa', 'names']) {
    if (snapBefore[key] === snapAfter[key]) continue;
    out.changes.push(`Belge düzeyinde ${key} değişti — ` +
      'açılışta çalışan eylemler belgenin davranışını değiştirebilir');
  }

  out.contentChanged = out.changes.length > 0;
  return out;
}

/**
 * Eklenen bölüm gerçekten bir artımlı güncelleme mi?
 *
 * ISO 32000-1 §7.5.6: her artımlı güncelleme kendi xref bölümüyle biter ve
 * `startxref` ile onu gösterir. Bu yapıyı taşımayan bir kuyruk PDF'in parçası
 * değildir: okuyucu onu görmez ama dosyada durur. Böyle bir kuyruğu "yalnız
 * doğrulama verisi" saymak, dosyaya ne konduğunu bilmemek demektir.
 *
 * Ölçüt yapısaldır, metin araması değildir: kuyrukta nesne tanımı varken
 * geçerli bir `startxref` hedefi yoksa ek yapısız sayılır.
 */
function isWellFormedAppend(pdfBuffer, coveredBytes) {
  const tail = pdfBuffer.slice(coveredBytes).toString('latin1');
  if (!tail.trim()) return true;                      // yalnız boşluk

  const starts = [...tail.matchAll(/startxref\s+(\d+)/g)];
  if (!starts.length) return false;

  for (const m of starts) {
    const off = Number(m[1]);
    if (!Number.isFinite(off) || off < 0 || off >= pdfBuffer.length) return false;
    // Hedefte ya klasik xref tablosu ya da bir xref akışı nesnesi olmalı.
    const at = pdfBuffer.slice(off, off + 32).toString('latin1');
    if (!/^\s*xref\b/.test(at) && !/^\s*\d+\s+\d+\s+obj\b/.test(at)) return false;
  }
  return true;
}

function safeSnapshot(doc, out, label) {
  try {
    return snapshot(doc);
  } catch (err) {
    out.errors.push(`${label} okunamadı: ${err.message}`);
    return null;
  }
}

/**
 * Belgenin "ne söylediğini" belirleyen alanların özeti.
 *
 * Nesne numaralarını DEĞİL içeriği özetler: artımlı güncelleme aynı içeriği
 * başka bir nesne numarasıyla yeniden yazabilir ve bu bir değişiklik değildir.
 */
function snapshot(doc) {
  const pageCount = doc.pageCount;
  const pages = [];

  for (let i = 0; i < pageCount; i++) {
    let content = Buffer.alloc(0);
    try {
      const c = doc.getPageContent(i);
      if (Buffer.isBuffer(c)) content = c;
      else if (typeof c === 'string') content = Buffer.from(c, 'latin1');
    } catch { /* içerik okunamadı: boş kabul edilir, farkı yine yakalanır */ }

    pages.push({
      contentDigest: sha(content),
      box: describeBox(doc, i),
      xobjects: describeXObjects(doc, i)
    });
  }

  return {
    pageCount,
    pages,
    openAction: stable(safe(() => doc.get(doc.catalog, 'OpenAction'))),
    aa: stable(safe(() => doc.get(doc.catalog, 'AA'))),
    names: stable(safe(() => doc.get(doc.catalog, 'Names')))
  };
}

function describeBox(doc, index) {
  try {
    const g = doc.getPageGeometry(index);
    if (!g) return '?';
    return `${round(g.width)}x${round(g.height)}@${g.rotate || 0}`;
  } catch { return '?'; }
}

const round = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : '?');

/**
 * Sayfanın kaynaklarındaki XObject'lerin ad → veri özeti eşlemesi.
 *
 * Görsel değiştirmek de içerik değiştirmektir: içerik akışı aynı kalıp
 * `/Im0`'ın işaret ettiği görselin baytları değişirse sayfa başka bir şey
 * gösterir.
 */
function describeXObjects(doc, index) {
  try {
    const { dict } = doc.getPage(index);
    const res = doc.getPageProperty(dict, 'Resources');
    const xo = res && doc.get(res, 'XObject');
    if (!xo || typeof xo.keys !== 'function') return '';

    const parts = [];
    for (const name of Array.from(xo.keys()).sort()) {
      let digest = '?';
      try {
        const stream = doc.resolve(xo.get(name));
        const data = doc.getStreamData(stream);
        digest = sha(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'latin1'));
      } catch { /* çözülemeyen akış: '?' olarak kalır ve fark yine görünür */ }
      parts.push(`${name}:${digest.slice(0, 16)}`);
    }
    return parts.join(',');
  } catch { return ''; }
}

/**
 * Sıralı, kararlı bir metin gösterimi — nesne kimliği değil, DEĞER önemli.
 *
 * Dolaylı gönderiler (`Ref`) çözülmeden 'ref' olarak yazılır: aynı içeriğin
 * başka bir nesne numarasına taşınması bir içerik değişikliği değildir ve
 * yanlış alarm üretmemelidir.
 */
function stable(value, depth = 0) {
  if (depth > 8 || value == null) return String(value);
  if (Buffer.isBuffer(value)) return `b:${sha(value).slice(0, 16)}`;
  if (Array.isArray(value)) return `[${value.map((v) => stable(v, depth + 1)).join(',')}]`;

  const ctor = value.constructor && value.constructor.name;
  if (ctor === 'Ref') return 'ref';
  if (ctor === 'Name') return `/${value.name}`;
  if (ctor === 'Str') return `s:${sha(value.bytes).slice(0, 16)}`;
  if (ctor === 'Stream') return `stream:${stable(value.dict, depth + 1)}`;
  if (typeof value.keys === 'function' && typeof value.get === 'function') {
    return `{${Array.from(value.keys()).sort()
      .map((k) => `${k}=${stable(value.get(k), depth + 1)}`).join(',')}}`;
  }
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((k) => `${k}=${stable(value[k], depth + 1)}`).join(',')}}`;
  }
  return String(value);
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function safe(fn) {
  try { return fn(); } catch { return null; }
}

/**
 * /ByteRange'in YAPISAL geçerliliği (ISO 32000-1 §12.8.1).
 *
 * Doğru bir ByteRange dosyanın TAMAMINI kapsar; dışarıda bıraktığı tek
 * boşluk `/Contents <…>` onaltılığıdır. Bu sınanmazsa saldırgan boşluğu
 * genişletip oraya imzasız içerik saklayabilir ya da `s1`'i sıfırdan
 * büyük seçip dosyanın başını imza dışına çıkarabilir.
 *
 * @param {Object} sig findAllSignatures() çıktısındaki imza
 * @param {number} pdfLength
 * @returns {{ ok:boolean, errors:string[] }}
 */
function validateByteRange(sig, pdfLength) {
  const errors = [];
  const br = sig.byteRange;

  if (!Array.isArray(br) || br.length !== 4) {
    errors.push(`/ByteRange dört sayıdan oluşmalı (bulunan: ${br ? br.length : 0})`);
    return { ok: false, errors };
  }
  const [s1, l1, s2, l2] = br;

  for (const [name, v] of [['s1', s1], ['l1', l1], ['s2', s2], ['l2', l2]]) {
    if (!Number.isInteger(v) || v < 0) {
      errors.push(`/ByteRange ${name} negatif ya da tam sayı değil: ${v}`);
    }
  }
  if (errors.length) return { ok: false, errors };

  if (s1 !== 0) {
    errors.push(`/ByteRange dosyanın başından başlamıyor (s1=${s1}) — ` +
      'ilk baytlar imza dışında bırakılmış');
  }
  if (s2 < s1 + l1) {
    errors.push('/ByteRange aralıkları çakışıyor ya da geriye gidiyor');
  }
  if (s2 + l2 > pdfLength) {
    errors.push(`/ByteRange dosya sonunu aşıyor (${s2 + l2} > ${pdfLength})`);
  }

  // Dışarıda bırakılan boşluk tam olarak /Contents onaltılığı olmalı.
  if (Number.isInteger(sig.contentsStart) && Number.isInteger(sig.contentsEnd)) {
    const gapStart = s1 + l1;
    const gapEnd = s2;
    if (gapStart !== sig.contentsStart || gapEnd !== sig.contentsEnd) {
      errors.push(
        `/ByteRange boşluğu /Contents ile örtüşmüyor ` +
        `(boşluk ${gapStart}–${gapEnd}, /Contents ${sig.contentsStart}–${sig.contentsEnd}) — ` +
        'imza dışında bırakılan alanda imzasız içerik olabilir');
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * İmza sözlüğündeki DocMDP dönüşüm parametresini okur (ISO 32000-1 §12.8.2.2).
 *
 * DocMDP bir "sertifikasyon imzası"dır: imzalayan, belgenin bundan SONRA ne
 * kadar değiştirilebileceğini bildirir.
 *   P = 1  hiçbir değişikliğe izin yok
 *   P = 2  yalnız form doldurma ve imzalama
 *   P = 3  ek olarak açıklama (annotation) ekleme/değiştirme
 *
 * @param {Buffer} pdfBuffer
 * @param {Object} sig findAllSignatures() çıktısındaki imza
 * @returns {{ isCertification:boolean, permissions:number|null }}
 */
function readDocMdp(pdfBuffer, sig) {
  const out = { isCertification: false, permissions: null };
  if (!Number.isInteger(sig.contentsStart)) return out;

  // İmza sözlüğü /Contents'ten ÖNCE gelir; geriye doğru sınırlı bir pencere
  // yeterlidir ve tüm dosyayı taramaktan güvenlidir.
  const from = Math.max(0, sig.contentsStart - 6000);
  const window = pdfBuffer.slice(from, sig.contentsStart).toString('latin1');

  const m = /\/TransformMethod\s*\/DocMDP[\s\S]{0,400}?\/P\s+(\d+)/.exec(window) ||
            /\/P\s+(\d+)[\s\S]{0,400}?\/TransformMethod\s*\/DocMDP/.exec(window);
  if (!m) return out;

  out.isCertification = true;
  const p = Number(m[1]);
  out.permissions = (p >= 1 && p <= 3) ? p : null;
  return out;
}

module.exports = {
  analyzeIncrementalChanges, validateByteRange, readDocMdp, isWellFormedAppend
};
