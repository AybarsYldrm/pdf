'use strict';
/**
 * PDF yazıcı — bellek içi Buffer üretir.
 *
 * @fitfak/pdf'in `Document`u dosya yoluna yazıyor ve font gömmede ham TTF'i
 * ASCIIHexDecode ile koyuyordu (dosya boyutunu iki katına çıkarır). Burada:
 *   - çıktı Buffer'dır (imzalama zinciri diske uğramaz),
 *   - fontlar FlateDecode ile gömülür,
 *   - aile başına birden çok yüz desteklenir,
 *   - /Link açıklamaları ve anahat (outline) yazılır,
 *   - XMP metadata + isteğe bağlı sRGB output intent (PDF/A yolu) eklenir.
 */

const zlib = require('zlib');
const crypto = require('crypto');

class PdfEmitter {
  constructor(options = {}) {
    this.objects = [];        // 1 tabanlı: objects[i-1]
    this.options = options;
    this.compress = options.compress !== false;
  }

  /** Yeni nesne ayırır, numarasını döndürür. */
  alloc() {
    this.objects.push(null);
    return this.objects.length;
  }

  set(objNum, content) {
    this.objects[objNum - 1] = content;
    return objNum;
  }

  add(content) {
    const n = this.alloc();
    return this.set(n, content);
  }

  /** Stream nesnesi ekler. */
  addStream(dict, data, { compress = this.compress } = {}) {
    let buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    const entries = { ...dict };
    if (compress && buf.length > 128) {
      buf = zlib.deflateSync(buf, { level: 9 });
      entries.Filter = entries.Filter ? `[${entries.Filter} /FlateDecode]` : '/FlateDecode';
    }
    entries.Length = buf.length;
    return this.add({ dict: entries, stream: buf });
  }

  /* ---------------------------------------------------------------- */
  /* Serileştirme                                                      */
  /* ---------------------------------------------------------------- */

  static dictToString(dict) {
    const parts = [];
    for (const [k, v] of Object.entries(dict)) {
      if (v === undefined || v === null) continue;
      parts.push(`/${k} ${v}`);
    }
    return `<< ${parts.join(' ')} >>`;
  }

  /** PDF metin dizesi (UTF-16BE, BOM'lu) — Türkçe karakterler için gerekli. */
  static textString(s) {
    const buf = Buffer.from('﻿' + String(s), 'utf16le').swap16();
    return '<' + buf.toString('hex').toUpperCase() + '>';
  }

  static literalString(s) {
    return '(' + String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')';
  }

  static pdfDate(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `(D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
           `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z)`;
  }

  /**
   * Tüm nesneleri serileştirir ve PDF Buffer'ı döndürür.
   * @param {{ rootObj:number, infoObj?:number, idHex?:string }} trailer
   */
  build({ rootObj, infoObj, idHex }) {
    const chunks = [];
    let offset = 0;
    const write = (data) => {
      const b = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
      chunks.push(b);
      offset += b.length;
    };

    write('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');

    const offsets = new Array(this.objects.length + 1).fill(0);
    for (let i = 0; i < this.objects.length; i++) {
      const obj = this.objects[i];
      offsets[i + 1] = offset;
      write(`${i + 1} 0 obj\n`);
      if (obj == null) {
        write('null\n');
      } else if (typeof obj === 'string') {
        write(obj + '\n');
      } else if (obj.stream !== undefined) {
        write(PdfEmitter.dictToString(obj.dict) + '\nstream\n');
        write(obj.stream);
        write('\nendstream\n');
      } else if (obj.dict !== undefined) {
        write(PdfEmitter.dictToString(obj.dict) + '\n');
      } else {
        write(String(obj) + '\n');
      }
      write('endobj\n');
    }

    const xrefStart = offset;
    let xref = `xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= this.objects.length; i++) {
      xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    write(xref);

    const id = idHex || crypto.randomBytes(16).toString('hex').toUpperCase();
    const trailerDict = {
      Size: this.objects.length + 1,
      Root: `${rootObj} 0 R`,
      ID: `[<${id}> <${id}>]`
    };
    if (infoObj) trailerDict.Info = `${infoObj} 0 R`;

    write(`trailer\n${PdfEmitter.dictToString(trailerDict)}\n`);
    write(`startxref\n${xrefStart}\n%%EOF\n`);

    return Buffer.concat(chunks);
  }
}

/* ------------------------------------------------------------------ */
/* Font gömme                                                          */
/* ------------------------------------------------------------------ */

/**
 * Bir TTF yüzünü CID (Identity-H) font olarak gömer.
 * @returns {number} Font nesne numarası
 */
function embedFont(emitter, face, usedCodePoints) {
  const parser = face.parser;
  const ttf = parser.buffer;

  const fontFileId = emitter.addStream({ Length1: ttf.length }, ttf);

  const unitsPerEm = parser.head ? parser.head.unitsPerEm : 1000;
  const scale = 1000 / unitsPerEm;
  const ascent = parser.hhea ? Math.round(parser.hhea.ascender * scale) : 800;
  const descent = parser.hhea ? Math.round(parser.hhea.descender * scale) : -200;

  const safeName = String(face.family).replace(/[^A-Za-z0-9]/g, '');
  const subsetTag = crypto.createHash('sha1')
    .update(face.file + face.weight + face.style)
    .digest('hex').slice(0, 6).toUpperCase().replace(/[0-9]/g, (d) => 'ABCDEFGHIJ'[+d]);
  const baseFont = `${subsetTag}+${safeName || 'Font'}`;

  const flags = 4 | (face.style === 'italic' ? 64 : 0) | (face.weight >= 600 ? 262144 : 0);

  const descriptorId = emitter.add({ dict: {
    Type: '/FontDescriptor',
    FontName: `/${baseFont}`,
    Flags: flags,
    FontBBox: `[${Math.round((parser.head?.xMin ?? -500) * scale)} ` +
              `${Math.round((parser.head?.yMin ?? -300) * scale)} ` +
              `${Math.round((parser.head?.xMax ?? 1200) * scale)} ` +
              `${Math.round((parser.head?.yMax ?? 1000) * scale)}]`,
    ItalicAngle: face.style === 'italic' ? -12 : 0,
    Ascent: ascent,
    Descent: descent,
    CapHeight: Math.round(ascent * 0.86),
    StemV: face.weight >= 600 ? 120 : 80,
    FontFile2: `${fontFileId} 0 R`
  } });

  // Yalnız KULLANILAN glif genişliklerini yaz (W dizisi kısalır, dosya küçülür)
  const widths = new Map();
  for (const cp of usedCodePoints) {
    const gid = parser.getGlyphId(cp);
    if (!widths.has(gid)) {
      widths.set(gid, Math.round(parser.getGlyphWidth(gid, 1000)));
    }
  }
  const wArray = buildWArray(widths);

  const cidFontId = emitter.add({ dict: {
    Type: '/Font',
    Subtype: '/CIDFontType2',
    BaseFont: `/${baseFont}`,
    CIDSystemInfo: '<< /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>',
    FontDescriptor: `${descriptorId} 0 R`,
    CIDToGIDMap: '/Identity',
    DW: 1000,
    W: wArray
  } });

  const toUnicodeId = emitter.addStream({}, buildToUnicodeCMap(parser, usedCodePoints));

  return emitter.add({ dict: {
    Type: '/Font',
    Subtype: '/Type0',
    BaseFont: `/${baseFont}`,
    Encoding: '/Identity-H',
    DescendantFonts: `[${cidFontId} 0 R]`,
    ToUnicode: `${toUnicodeId} 0 R`
  } });
}

/** Ardışık glif numaralarını gruplayarak /W dizisi üretir. */
function buildWArray(widths) {
  const gids = [...widths.keys()].sort((a, b) => a - b);
  if (!gids.length) return '[]';

  const parts = [];
  let i = 0;
  while (i < gids.length) {
    const start = gids[i];
    const run = [widths.get(start)];
    let j = i + 1;
    while (j < gids.length && gids[j] === gids[j - 1] + 1) {
      run.push(widths.get(gids[j]));
      j++;
    }
    parts.push(`${start} [${run.join(' ')}]`);
    i = j;
  }
  return `[${parts.join(' ')}]`;
}

/** Glif → Unicode eşlemesi (metin çıkarma ve arama için). */
function buildToUnicodeCMap(parser, usedCodePoints) {
  const pairs = [];
  const seen = new Set();
  for (const cp of usedCodePoints) {
    const gid = parser.getGlyphId(cp);
    if (seen.has(gid)) continue;
    seen.add(gid);
    const hexGid = gid.toString(16).padStart(4, '0').toUpperCase();
    const hexUni = cp > 0xFFFF
      ? surrogateHex(cp)
      : cp.toString(16).padStart(4, '0').toUpperCase();
    pairs.push(`<${hexGid}> <${hexUni}>`);
  }

  const chunks = [];
  for (let i = 0; i < pairs.length; i += 100) {
    const slice = pairs.slice(i, i + 100);
    chunks.push(`${slice.length} beginbfchar\n${slice.join('\n')}\nendbfchar`);
  }

  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${chunks.join('\n')}
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

function surrogateHex(cp) {
  const v = cp - 0x10000;
  const hi = 0xD800 + (v >> 10);
  const lo = 0xDC00 + (v & 0x3FF);
  return hi.toString(16).padStart(4, '0').toUpperCase() +
         lo.toString(16).padStart(4, '0').toUpperCase();
}

module.exports = { PdfEmitter, embedFont, buildWArray, buildToUnicodeCMap };
