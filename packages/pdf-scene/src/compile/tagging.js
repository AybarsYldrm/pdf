'use strict';
/**
 * Etiketleme: sahne düğümleri → PDF yapı ağacı (PDF/UA).
 *
 * SERBEST YERLEŞİMDE OKUMA SIRASI KENDİLİĞİNDEN OLUŞMAZ.
 *
 * Akış belgesinde sıra bellidir: HTML'de ne önce yazıldıysa o önce okunur.
 * Sahnede ise kullanıcı nesneleri istediği sırayla ekler; en son eklediği
 * başlık, çizim listesinin sonunda durur. Çizim sırasını okuma sırası
 * saymak, ekran okuyucunun belgeyi tersten okuması demektir.
 *
 * Bu yüzden iki kaynak vardır:
 *   1. `page.readingOrder` — kullanıcının açıkça verdiği sıra. Bu varsa
 *      tartışma biter.
 *   2. Yoksa GÖRSEL sıra hesaplanır: satırlara ayrılıp yukarıdan aşağı,
 *      her satırda soldan sağa. Türkçe/İngilizce gibi soldan sağa yazılan
 *      diller için doğru varsayımdır ve tahmin olduğu bildirilir.
 *
 * İçerik olmayan her şey (`artifact`) etiketlenmez ama BAŞIBOŞ da bırakılmaz:
 * `/Artifact` olarak işaretlenir. PDF/UA'da üçüncü bir seçenek yoktur —
 * ne etiketli ne artifact olan çizim "etiketsiz içerik"tir ve hatadır.
 */

// Tipe göre varsayılan rol ŞEMADAN gelir: editör de aynı tabloyu okur.
const { DEFAULT_ROLE } = require('../schema');

/** Aynı "satır" sayılma toleransı (punto). */
const ROW_TOLERANCE = 6;

/**
 * Bir düğümün etkin rolü.
 *
 * `auto` tipe göre çözülür; kullanıcı açıkça bir rol verdiyse o kazanır.
 * Metin düğümünün varsayılanı `P`dir — büyük puntolu olması onu başlık
 * YAPMAZ. Başlık olduğunu yalnız kullanıcı bilebilir.
 */
function roleOf(node) {
  const role = node.role && node.role !== 'auto' ? node.role : DEFAULT_ROLE[node.type];
  return role || 'artifact';
}

/**
 * Görsel okuma sırası: satırlara böl, yukarıdan aşağı, soldan sağa.
 *
 * @param {Array<{ id:string, frame:Object }>} placed mutlak çerçeveli düğümler
 * @returns {string[]} düğüm kimlikleri
 */
function visualOrder(placed) {
  const sorted = [...placed].sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);

  const rows = [];
  for (const item of sorted) {
    const row = rows.find((r) => Math.abs(r.y - item.frame.y) <= ROW_TOLERANCE);
    if (row) { row.items.push(item); row.y = Math.min(row.y, item.frame.y); }
    else rows.push({ y: item.frame.y, items: [item] });
  }

  const out = [];
  for (const row of rows.sort((a, b) => a.y - b.y)) {
    for (const item of row.items.sort((a, b) => a.frame.x - b.frame.x)) out.push(item.id);
  }
  return out;
}

/**
 * Sayfa için yapı planı üretir.
 *
 * @param {Object} page doğrulanmış sahne sayfası
 * @param {Array} drawItems `collectItems` çıktısı (her öğede `nodeId` olmalı)
 * @param {Array} placed [{ id, type, frame, role, alt, lang }] mutlak çerçeveli
 * @returns {{ order: string[], entries: Map<string, Object>, guessed: boolean,
 *             warnings: Array }}
 */
function planPage(page, placed) {
  const warnings = [];
  const content = placed.filter((n) => roleOf(n) !== 'artifact');

  let order;
  let guessed = false;

  if (Array.isArray(page.readingOrder) && page.readingOrder.length) {
    const given = page.readingOrder.filter((id) => content.some((n) => n.id === id));
    const missing = content.filter((n) => !given.includes(n.id)).map((n) => n.id);
    // Eksik kalanlar sona eklenir: kullanıcı bir düğümü unuttuysa belge
    // yine de tam etiketlenmelidir.
    if (missing.length) {
      warnings.push({
        code: 'WARN_READING_ORDER_INCOMPLETE',
        message: `Okuma sırasında ${missing.length} düğüm belirtilmemiş; ` +
                 'görsel sıraya göre sona eklendi.'
      });
    }
    order = [...given, ...visualOrder(content.filter((n) => missing.includes(n.id)))];
  } else {
    order = visualOrder(content);
    guessed = content.length > 1;
  }

  const entries = new Map();
  for (const node of content) {
    const role = roleOf(node);
    const entry = { id: node.id, role, alt: node.alt || '', lang: node.lang || '', mcids: [] };

    // PDF/UA §7.3: Figure alternatif metin olmadan geçerli değildir.
    if (role === 'Figure' && !entry.alt) {
      entry.alt = node.type === 'qr'
        ? (node.payload ? `Karekod: ${String(node.payload).slice(0, 120)}` : 'Karekod')
        : '';
      if (!entry.alt) {
        warnings.push({
          code: 'WARN_MISSING_ALT', nodeId: node.id,
          message: `Görselde alternatif metin yok (${node.id}); PDF/UA bunu zorunlu kılar.`
        });
      }
    }
    entries.set(node.id, entry);
  }

  return { order, entries, guessed, warnings };
}

/**
 * Yapı ağacını `@fitfak/pdf-html`in `writeStructTree` biçimine çevirir.
 *
 * Sahne düz bir listedir; yapı ağacı ise ağaçtır. Kök `Document`, altında
 * sayfa başına bir `Sect` ve onun altında okuma sırasına göre elemanlar
 * durur. Sayfaları `Sect` ile ayırmak, ekran okuyucunun "sayfa 2'ye geç"
 * diyebilmesini sağlar.
 */
function buildStructRoot(pagePlans) {
  const root = { role: undefined, k: [] };
  const document = { role: 'Document', k: [] };
  root.k.push(document);

  for (const plan of pagePlans) {
    const section = { role: 'Sect', k: [] };
    for (const id of plan.order) {
      const entry = plan.entries.get(id);
      if (!entry || !entry.mcids.length) continue;

      const node = { role: entry.role, k: [] };
      if (entry.alt) node.alt = entry.alt;
      if (entry.lang) node.lang = entry.lang;
      for (const mc of entry.mcids) node.k.push(mc);
      section.k.push(node);
    }
    if (section.k.length) document.k.push(section);
  }

  return root;
}

module.exports = { roleOf, visualOrder, planPage, buildStructRoot, DEFAULT_ROLE };
