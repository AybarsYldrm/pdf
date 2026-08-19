'use strict';
/**
 * XMP paketi okuma/yazma — ISO 16684-1.
 *
 * Tam bir RDF ayrıştırıcısı değildir ve olmasına gerek yoktur: PDF'teki XMP
 * paketleri dar bir kalıbı izler ve bizim ilgilendiğimiz alanlar (uyumluluk
 * iddiaları, dc:title, dc:creator) hep aynı biçimdedir. İhtiyaç duyulan şey
 * "hangi profil iddia edilmiş?" sorusuna güvenilir cevaptır.
 */

const NS = {
  dc: 'http://purl.org/dc/elements/1.1/',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  pdf: 'http://ns.adobe.com/pdf/1.3/',
  pdfaid: 'http://www.aiim.org/pdfa/ns/id/',
  pdfuaid: 'http://www.aiim.org/pdfua/ns/id/'
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const unesc = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

/**
 * `<önek:ad>` biçimindeki bir elemanın değerini okur.
 *
 * Ad alanı öneki ZORUNLUDUR ve eşleşme büyük/küçük harfe DUYARLIDIR: aksi
 * hâlde `dc:description` ararken `rdf:Description` sarmalayıcısına takılırdık.
 */
function readTag(xml, qualifiedName) {
  const re = new RegExp(`<${qualifiedName}(?:\\s[^>]*)?>([\\s\\S]*?)</${qualifiedName}>`);
  const m = re.exec(xml);
  if (!m) return null;

  // rdf:Alt / rdf:Seq / rdf:Bag sarmalayıcılarının ilk öğesini al
  const li = /<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i.exec(m[1]);
  return unesc((li ? li[1] : m[1]).trim());
}

/**
 * XMP paketinden uyumluluk iddialarını ve temel üst veriyi çıkarır.
 * @param {string|Buffer} xml
 */
function parseXmp(xml) {
  const text = Buffer.isBuffer(xml) ? xml.toString('utf8') : String(xml || '');
  if (!text) return null;

  // pdfaid ve pdfuaid ikisi de `part` kullanır; ad alanı öneki ayırır
  const pdfaPart = readTagNs(text, 'pdfaid', 'part');
  const pdfuaPart = readTagNs(text, 'pdfuaid', 'part');
  const pdfaLevel = readTagNs(text, 'pdfaid', 'conformance');

  // Yanlış üretilmiş '2b' gibi değerlerden de doğru bilgiyi çıkar
  const partDigit = pdfaPart ? (/(\d)/.exec(pdfaPart) || [])[1] : null;
  const levelChar = (pdfaLevel && /([ab])/i.exec(pdfaLevel))
    ? /([ab])/i.exec(pdfaLevel)[1].toLowerCase()
    : 'b';

  return {
    title: readTag(text, 'dc:title'),
    creator: readTag(text, 'dc:creator'),
    description: readTag(text, 'dc:description'),
    language: readTag(text, 'dc:language'),
    producer: readTag(text, 'pdf:Producer'),
    creatorTool: readTag(text, 'xmp:CreatorTool'),
    createDate: readTag(text, 'xmp:CreateDate'),
    pdfA: partDigit ? `${partDigit}${levelChar}` : null,
    pdfUA: pdfuaPart ? Number((/(\d)/.exec(pdfuaPart) || [])[1]) : null,
    raw: text
  };
}

/** Ad alanı ÖNEKİYLE birlikte okur — pdfaid:part ile pdfuaid:part'ı ayırır. */
function readTagNs(xml, prefix, localName) {
  const re = new RegExp(`<${prefix}:${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</${prefix}:${localName}>`, 'i');
  const m = re.exec(xml);
  if (m) return unesc(m[1].trim());

  // Nitelik biçimi: pdfaid:part="2"
  const attr = new RegExp(`${prefix}:${localName}\\s*=\\s*"([^"]*)"`, 'i').exec(xml);
  return attr ? unesc(attr[1]) : null;
}

/**
 * XMP paketi üretir.
 *
 * @param {{ title?, author?, subject?, keywords?, lang?, producer?, creatorTool?,
 *           createDate?: Date, pdfA?: string, pdfUA?: boolean }} meta
 * @returns {Buffer}
 */
function buildXmp(meta = {}) {
  const date = (meta.createDate instanceof Date ? meta.createDate : new Date()).toISOString();

  let claims = '';
  if (meta.pdfA) {
    const m = /^(\d)([ab])?$/i.exec(String(meta.pdfA).replace(/^pdf\/a-?/i, ''));
    const part = m ? m[1] : '2';
    const level = (m && m[2] ? m[2] : 'b').toUpperCase();
    claims += `\n   <pdfaid:part>${part}</pdfaid:part>` +
              `\n   <pdfaid:conformance>${level}</pdfaid:conformance>`;
  }
  if (meta.pdfUA) claims += '\n   <pdfuaid:part>1</pdfuaid:part>';

  return Buffer.from(
`<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="${NS.dc}"
    xmlns:xmp="${NS.xmp}"
    xmlns:pdf="${NS.pdf}"
    xmlns:pdfaid="${NS.pdfaid}"
    xmlns:pdfuaid="${NS.pdfuaid}">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(meta.title)}</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>${esc(meta.author)}</rdf:li></rdf:Seq></dc:creator>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${esc(meta.subject)}</rdf:li></rdf:Alt></dc:description>
   <dc:language><rdf:Bag><rdf:li>${esc(meta.lang || 'tr-TR')}</rdf:li></rdf:Bag></dc:language>
   <xmp:CreatorTool>${esc(meta.creatorTool || 'fitfak-belge')}</xmp:CreatorTool>
   <xmp:CreateDate>${date}</xmp:CreateDate>
   <xmp:ModifyDate>${date}</xmp:ModifyDate>
   <pdf:Producer>${esc(meta.producer || 'fitfak-belge')}</pdf:Producer>${claims}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`, 'utf8');
}

module.exports = { buildXmp, parseXmp, NS };
