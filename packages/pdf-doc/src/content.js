'use strict';
/**
 * İçerik akışı (content stream) tarayıcısı.
 *
 * İçerik akışları nesne değil OPERATÖR dizisidir: önce işlenenler, sonra
 * operatör adı gelir (ters Lehçe / postfix). Lexer nesneleri çözer; buradaki
 * tarayıcı hangi belirtecin işlenen hangisinin operatör olduğuna karar verir
 * ve `BI … ID … EI` satır içi görsellerini atlar.
 */

const { Lexer, Name, Str, Dict, isWs, isDelim } = require('./lexer');

/** Operand kabul etmeyen, tek başına duran anahtar sözcükler. */
const KEYWORDS = new Set(['true', 'false', 'null']);

/**
 * İçerik akışındaki operatörleri sırayla üretir.
 *
 * @param {Buffer} data çözülmüş içerik akışı
 * @yields {{ op: string, args: Array }}
 */
function* tokenizeContent(data) {
  const lexer = new Lexer(data, 0);
  let args = [];

  while (true) {
    lexer.skipWhitespace();
    if (lexer.pos >= data.length) return;

    const c = data[lexer.pos];

    // İşlenen mi? (sayı, dizgi, ad, dizi, sözlük)
    if (c === 0x2F || c === 0x28 || c === 0x5B || c === 0x3C
        || (c >= 0x30 && c <= 0x39) || c === 0x2B || c === 0x2D || c === 0x2E) {
      try {
        args.push(lexer.parseObject());
      } catch {
        return;                                  // bozuk akış: sessizce dur
      }
      if (args.length > 64) args = args.slice(-64);
      continue;
    }

    // Kapanış işaretleri: dengesiz akışlarda takılmayalım
    if (c === 0x5D || c === 0x3E || c === 0x29 || c === 0x7B || c === 0x7D) {
      lexer.pos++;
      continue;
    }

    const start = lexer.pos;
    while (lexer.pos < data.length && !isWs(data[lexer.pos]) && !isDelim(data[lexer.pos])) {
      lexer.pos++;
    }
    if (lexer.pos === start) { lexer.pos++; continue; }

    const token = data.toString('latin1', start, lexer.pos);

    if (KEYWORDS.has(token)) {
      args.push(token === 'true' ? true : token === 'false' ? false : null);
      continue;
    }

    if (token === 'BI') {
      lexer.pos = skipInlineImage(data, lexer.pos);
      args = [];
      continue;
    }

    yield { op: token, args };
    args = [];
  }
}

/** `BI … ID <ikili veri> EI` bloğunu atlar. */
function skipInlineImage(data, pos) {
  // `ID`den sonra tek bir boşluk, ardından ham veri gelir; `EI` ile biter.
  const idIdx = data.indexOf('ID', pos, 'latin1');
  if (idIdx < 0) return data.length;

  let p = idIdx + 2;
  if (isWs(data[p])) p++;

  while (p < data.length - 1) {
    if (data[p] === 0x45 && data[p + 1] === 0x49                     // 'EI'
        && (p === 0 || isWs(data[p - 1]))
        && (p + 2 >= data.length || isWs(data[p + 2]) || isDelim(data[p + 2]))) {
      return p + 2;
    }
    p++;
  }
  return data.length;
}

/**
 * Sayfanın içerik akışını operatör listesi olarak döndürür.
 * @returns {Array<{op:string, args:Array}>}
 */
function parsePageContent(doc, pageIndex) {
  return [...tokenizeContent(doc.getPageContent(pageIndex))];
}

module.exports = { tokenizeContent, parsePageContent, skipInlineImage };
