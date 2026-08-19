'use strict';
/**
 * Basit font kodlamaları — ISO 32000-1 Ek D.
 *
 * Tablolar kod → GLİF ADI biçimindedir; `/Differences` de glif adı verdiği
 * için ikisi aynı düzlemde birleşebilir. Adı Unicode'a çevirmek `GLYPH_TO_UNICODE`
 * işidir (Adobe Glyph List'in gerçekten kullanılan kesiti).
 */

/** Boşlukla ayrılmış glif adlarını tabloya `start`'tan itibaren yazar ('.' = tanımsız). */
function fill(out, start, names) {
  names.split(/\s+/).filter(Boolean).forEach((name, i) => {
    if (name !== '.') out[start + i] = name;
  });
  return out;
}

const empty = () => new Array(256).fill(null);

const ASCII_LOWER =
  'space exclam quotedbl numbersign dollar percent ampersand quotesingle ' +
  'parenleft parenright asterisk plus comma hyphen period slash ' +
  'zero one two three four five six seven eight nine ' +
  'colon semicolon less equal greater question at ' +
  'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z ' +
  'bracketleft backslash bracketright asciicircum underscore grave ' +
  'a b c d e f g h i j k l m n o p q r s t u v w x y z ' +
  'braceleft bar braceright asciitilde';

/* ------------------------------------------------------------------ */
/* WinAnsiEncoding (CP1252)                                             */
/* ------------------------------------------------------------------ */

const WINANSI_ENCODING = fill(empty(), 32, ASCII_LOWER);
fill(WINANSI_ENCODING, 128,
  'Euro . quotesinglbase florin quotedblbase ellipsis dagger daggerdbl ' +
  'circumflex perthousand Scaron guilsinglleft OE . Zcaron . ' +
  '. quoteleft quoteright quotedblleft quotedblright bullet endash emdash ' +
  'tilde trademark scaron guilsinglright oe . zcaron Ydieresis ' +
  'space exclamdown cent sterling currency yen brokenbar section ' +
  'dieresis copyright ordfeminine guillemotleft logicalnot hyphen registered macron ' +
  'degree plusminus twosuperior threesuperior acute mu paragraph periodcentered ' +
  'cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown ' +
  'Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla ' +
  'Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis ' +
  'Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply ' +
  'Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls ' +
  'agrave aacute acircumflex atilde adieresis aring ae ccedilla ' +
  'egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis ' +
  'eth ntilde ograve oacute ocircumflex otilde odieresis divide ' +
  'oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis');

/* ------------------------------------------------------------------ */
/* MacRomanEncoding                                                     */
/* ------------------------------------------------------------------ */

const MACROMAN_ENCODING = fill(empty(), 32, ASCII_LOWER);
fill(MACROMAN_ENCODING, 128,
  'Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute ' +
  'agrave acircumflex adieresis atilde aring ccedilla eacute egrave ' +
  'ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ' +
  'ograve ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis ' +
  'dagger degree cent sterling section bullet paragraph germandbls ' +
  'registered copyright trademark acute dieresis notequal AE Oslash ' +
  'infinity plusminus lessequal greaterequal yen mu partialdiff summation ' +
  'product pi integral ordfeminine ordmasculine Omega ae oslash ' +
  'questiondown exclamdown logicalnot radical florin approxequal Delta guillemotleft ' +
  'guillemotright ellipsis space Agrave Atilde Otilde OE oe ' +
  'endash emdash quotedblleft quotedblright quoteleft quoteright divide lozenge ' +
  'ydieresis Ydieresis fraction currency guilsinglleft guilsinglright fi fl ' +
  'daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute ' +
  'Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex ' +
  'apple Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde ' +
  'macron breve dotaccent ring cedilla hungarumlaut ogonek caron');

/* ------------------------------------------------------------------ */
/* StandardEncoding                                                     */
/* ------------------------------------------------------------------ */

const STANDARD_ENCODING = fill(empty(), 32, ASCII_LOWER);
STANDARD_ENCODING[39] = 'quoteright';
STANDARD_ENCODING[96] = 'quoteleft';
for (const [code, name] of Object.entries({
  161: 'exclamdown', 162: 'cent', 163: 'sterling', 164: 'fraction', 165: 'yen',
  166: 'florin', 167: 'section', 168: 'currency', 169: 'quotesingle', 170: 'quotedblleft',
  171: 'guillemotleft', 172: 'guilsinglleft', 173: 'guilsinglright', 174: 'fi', 175: 'fl',
  177: 'endash', 178: 'dagger', 179: 'daggerdbl', 180: 'periodcentered', 182: 'paragraph',
  183: 'bullet', 184: 'quotesinglbase', 185: 'quotedblbase', 186: 'quotedblright',
  187: 'guillemotright', 188: 'ellipsis', 189: 'perthousand', 191: 'questiondown',
  193: 'grave', 194: 'acute', 195: 'circumflex', 196: 'tilde', 197: 'macron',
  198: 'breve', 199: 'dotaccent', 200: 'dieresis', 202: 'ring', 203: 'cedilla',
  205: 'hungarumlaut', 206: 'ogonek', 207: 'caron', 208: 'emdash',
  225: 'AE', 227: 'ordfeminine', 232: 'Lslash', 233: 'Oslash', 234: 'OE',
  235: 'ordmasculine', 241: 'ae', 245: 'dotlessi', 248: 'lslash', 249: 'oslash',
  250: 'oe', 251: 'germandbls'
})) {
  STANDARD_ENCODING[Number(code)] = name;
}

/* ------------------------------------------------------------------ */
/* Glif adı → Unicode                                                   */
/* ------------------------------------------------------------------ */

const GLYPH_TO_UNICODE = Object.create(null);

// ASCII aralığı doğrudan kendi adlarından türetilir
ASCII_LOWER.split(' ').forEach((name, i) => {
  if (name !== '.') GLYPH_TO_UNICODE[name] = String.fromCharCode(32 + i);
});
GLYPH_TO_UNICODE.quoteright = '’';
GLYPH_TO_UNICODE.quoteleft = '‘';

/** 'ad kodnoktası' çiftlerini haritaya yazar. */
function addGlyphs(spec) {
  const parts = spec.split(/\s+/).filter(Boolean);
  for (let i = 0; i + 1 < parts.length; i += 2) {
    GLYPH_TO_UNICODE[parts[i]] = String.fromCodePoint(parseInt(parts[i + 1], 16));
  }
}

addGlyphs(`
  Euro 20AC quotesinglbase 201A florin 0192 quotedblbase 201E ellipsis 2026
  dagger 2020 daggerdbl 2021 circumflex 02C6 perthousand 2030 Scaron 0160
  guilsinglleft 2039 OE 0152 Zcaron 017D quotedblleft 201C quotedblright 201D
  bullet 2022 endash 2013 emdash 2014 tilde 02DC trademark 2122 scaron 0161
  guilsinglright 203A oe 0153 zcaron 017E Ydieresis 0178
  exclamdown 00A1 cent 00A2 sterling 00A3 currency 00A4 yen 00A5 brokenbar 00A6
  section 00A7 dieresis 00A8 copyright 00A9 ordfeminine 00AA guillemotleft 00AB
  logicalnot 00AC registered 00AE macron 00AF degree 00B0 plusminus 00B1
  twosuperior 00B2 threesuperior 00B3 acute 00B4 mu 00B5 paragraph 00B6
  periodcentered 00B7 cedilla 00B8 onesuperior 00B9 ordmasculine 00BA
  guillemotright 00BB onequarter 00BC onehalf 00BD threequarters 00BE questiondown 00BF
  Agrave 00C0 Aacute 00C1 Acircumflex 00C2 Atilde 00C3 Adieresis 00C4 Aring 00C5
  AE 00C6 Ccedilla 00C7 Egrave 00C8 Eacute 00C9 Ecircumflex 00CA Edieresis 00CB
  Igrave 00CC Iacute 00CD Icircumflex 00CE Idieresis 00CF Eth 00D0 Ntilde 00D1
  Ograve 00D2 Oacute 00D3 Ocircumflex 00D4 Otilde 00D5 Odieresis 00D6 multiply 00D7
  Oslash 00D8 Ugrave 00D9 Uacute 00DA Ucircumflex 00DB Udieresis 00DC Yacute 00DD
  Thorn 00DE germandbls 00DF agrave 00E0 aacute 00E1 acircumflex 00E2 atilde 00E3
  adieresis 00E4 aring 00E5 ae 00E6 ccedilla 00E7 egrave 00E8 eacute 00E9
  ecircumflex 00EA edieresis 00EB igrave 00EC iacute 00ED icircumflex 00EE
  idieresis 00EF eth 00F0 ntilde 00F1 ograve 00F2 oacute 00F3 ocircumflex 00F4
  otilde 00F5 odieresis 00F6 divide 00F7 oslash 00F8 ugrave 00F9 uacute 00FA
  ucircumflex 00FB udieresis 00FC yacute 00FD thorn 00FE ydieresis 00FF
`);

// Türkçe ve orta Avrupa glifleri — `addText` bunları /Differences ile kullanır
addGlyphs(`
  Gbreve 011E gbreve 011F Idotaccent 0130 dotlessi 0131 Scedilla 015E scedilla 015F
  Lslash 0141 lslash 0142 Zdotaccent 017B zdotaccent 017C Zacute 0179 zacute 017A
  Sacute 015A sacute 015B Cacute 0106 cacute 0107 Nacute 0143 nacute 0144
  Eogonek 0118 eogonek 0119 Aogonek 0104 aogonek 0105 Racute 0154 racute 0155
`);

// Tipografik / matematiksel ekler (MacRoman ve Standard tablolarında geçenler)
addGlyphs(`
  notequal 2260 infinity 221E lessequal 2264 greaterequal 2265 partialdiff 2202
  summation 2211 product 220F pi 03C0 integral 222B Omega 03A9 radical 221A
  approxequal 2248 Delta 2206 lozenge 25CA fraction 2044 fi FB01 fl FB02
  apple F8FF ring 02DA breve 02D8 dotaccent 02D9 hungarumlaut 02DD ogonek 02DB
  caron 02C7 space 0020 nbspace 00A0
`);

module.exports = {
  STANDARD_ENCODING, WINANSI_ENCODING, MACROMAN_ENCODING, GLYPH_TO_UNICODE
};
