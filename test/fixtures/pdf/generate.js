'use strict';
/**
 * PDF test dosyası üreteci.
 *
 * Amaç: parser'ın gerçekten sınanması gereken yapıları ÜRETMEK — çapraz
 * başvuru akışı, nesne akışı, farklı filtreler, şifreleme, bozuk xref.
 * Bunları elle üretiyoruz ki testler harici araç gerektirmesin ve hangi
 * yapının sınandığı tam olarak belli olsun.
 *
 * Kullanım: node test/fixtures/pdf/generate.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const OUT = __dirname;

/* ------------------------------------------------------------------ */
/* Küçük yazıcı                                                         */
/* ------------------------------------------------------------------ */

class Writer {
  constructor() {
    this.chunks = [];
    this.offset = 0;
    this.objects = new Map();      // num → offset
  }
  write(data) {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    this.chunks.push(b);
    this.offset += b.length;
    return this;
  }
  startObject(num) {
    this.objects.set(num, this.offset);
    this.write(`${num} 0 obj\n`);
    return this;
  }
  endObject() { return this.write('endobj\n'); }
  obj(num, body) { return this.startObject(num).write(body + '\n').endObject(); }
  streamObj(num, dictBody, data) {
    this.startObject(num);
    this.write(`<< ${dictBody} /Length ${data.length} >>\nstream\n`);
    this.write(data);
    this.write('\nendstream\n');
    return this.endObject();
  }
  toBuffer() { return Buffer.concat(this.chunks); }
}

/** Basit sayfa içeriği (Helvetica ile). */
function contentFor(text, y = 700) {
  return Buffer.from(
    `BT /F1 24 Tf 60 ${y} Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET\n` +
    `0.2 0.3 0.6 rg 60 ${y - 40} 200 20 re f\n`, 'latin1');
}

/* ------------------------------------------------------------------ */
/* 1. Klasik xref (temel)                                              */
/* ------------------------------------------------------------------ */

function classicXref(pageCount = 1) {
  const w = new Writer();
  w.write('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  const fontNum = 1;
  w.obj(fontNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const pagesNum = 2;
  const pageNums = [];
  const contentNums = [];
  let next = 3;

  for (let i = 0; i < pageCount; i++) {
    const cNum = next++;
    contentNums.push(cNum);
    w.streamObj(cNum, '', contentFor(`Klasik xref — sayfa ${i + 1}`));
  }
  for (let i = 0; i < pageCount; i++) {
    const pNum = next++;
    pageNums.push(pNum);
    w.obj(pNum,
      `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 595.28 841.89] ` +
      `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNums[i]} 0 R >>`);
  }

  w.objects.set(pagesNum, w.offset);
  w.write(`${pagesNum} 0 obj\n<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] ` +
          `/Count ${pageCount} >>\nendobj\n`);

  const catalogNum = next++;
  w.obj(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  const infoNum = next++;
  w.obj(infoNum, '<< /Title (Klasik xref belgesi) /Producer (fitfak test) >>');

  writeClassicTrailer(w, next, catalogNum, infoNum);
  return w.toBuffer();
}

function writeClassicTrailer(w, size, catalogNum, infoNum) {
  const start = w.offset;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) {
    const off = w.objects.get(i) || 0;
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  w.write(xref);
  w.write(`trailer\n<< /Size ${size} /Root ${catalogNum} 0 R` +
          (infoNum ? ` /Info ${infoNum} 0 R` : '') +
          ` /ID [<0102030405060708090A0B0C0D0E0F10> <0102030405060708090A0B0C0D0E0F10>] >>\n`);
  w.write(`startxref\n${start}\n%%EOF\n`);
}

/* ------------------------------------------------------------------ */
/* 2. Çapraz başvuru AKIŞI (/Type /XRef) — PDF 1.5+                     */
/* ------------------------------------------------------------------ */

function xrefStream(pageCount = 2) {
  const w = new Writer();
  w.write('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n');

  const fontNum = 1;
  w.obj(fontNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const pagesNum = 2;
  let next = 3;
  const pageNums = [];
  const contentNums = [];

  for (let i = 0; i < pageCount; i++) {
    const cNum = next++;
    contentNums.push(cNum);
    w.streamObj(cNum, '/Filter /FlateDecode',
      zlib.deflateSync(contentFor(`XRef akisi — sayfa ${i + 1}`)));
  }
  for (let i = 0; i < pageCount; i++) {
    const pNum = next++;
    pageNums.push(pNum);
    w.obj(pNum,
      `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 595.28 841.89] ` +
      `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNums[i]} 0 R >>`);
  }

  w.objects.set(pagesNum, w.offset);
  w.write(`${pagesNum} 0 obj\n<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] ` +
          `/Count ${pageCount} >>\nendobj\n`);

  const catalogNum = next++;
  w.obj(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  const infoNum = next++;
  w.obj(infoNum, '<< /Title (XRef akisli belge) /Producer (fitfak test) >>');

  const xrefNum = next++;
  writeXrefStream(w, xrefNum, next, catalogNum, infoNum);
  return w.toBuffer();
}

/** `/Type /XRef` akışını Predictor 12 ile yazar. */
function writeXrefStream(w, xrefNum, size, catalogNum, infoNum, extra = '') {
  const xrefOffset = w.offset;
  w.objects.set(xrefNum, xrefOffset);

  // W = [1 4 2]: tip(1) + offset(4) + gen(2)
  const rowLen = 7;
  const rows = [];
  for (let i = 0; i < size; i++) {
    const row = Buffer.alloc(rowLen);
    if (i === 0) {
      row[0] = 0;
      row.writeUInt32BE(0, 1);
      row.writeUInt16BE(0xFFFF, 5);
    } else if (w.objects.has(i)) {
      row[0] = 1;
      row.writeUInt32BE(w.objects.get(i), 1);
      row.writeUInt16BE(0, 5);
    } else {
      row[0] = 0;
      row.writeUInt32BE(0, 1);
      row.writeUInt16BE(0xFFFF, 5);
    }
    rows.push(row);
  }

  // PNG Up (2) predictor uygula
  const predicted = [];
  let prev = Buffer.alloc(rowLen);
  for (const row of rows) {
    const enc = Buffer.alloc(rowLen + 1);
    enc[0] = 2;
    for (let i = 0; i < rowLen; i++) enc[i + 1] = (row[i] - prev[i]) & 0xff;
    predicted.push(enc);
    prev = row;
  }

  const data = zlib.deflateSync(Buffer.concat(predicted));
  w.write(`${xrefNum} 0 obj\n`);
  w.write(`<< /Type /XRef /Size ${size} /W [1 4 2] /Root ${catalogNum} 0 R ` +
          (infoNum ? `/Info ${infoNum} 0 R ` : '') +
          `/ID [<0102030405060708090A0B0C0D0E0F10> <0102030405060708090A0B0C0D0E0F10>] ` +
          `/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns ${rowLen} >> ` +
          `${extra}/Length ${data.length} >>\nstream\n`);
  w.write(data);
  w.write('\nendstream\nendobj\n');
  w.write(`startxref\n${xrefOffset}\n%%EOF\n`);
}

/* ------------------------------------------------------------------ */
/* 3. NESNE AKIŞI (/ObjStm) — nesneler sıkıştırılmış                    */
/* ------------------------------------------------------------------ */

function objectStream(pageCount = 2) {
  const w = new Writer();
  w.write('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n');

  // İçerik akışları ObjStm içine KONULAMAZ (akışlar sıkıştırılamaz),
  // bu yüzden onlar dosyada normal durur.
  const contentNums = [];
  let next = 1;
  for (let i = 0; i < pageCount; i++) {
    const cNum = next++;
    contentNums.push(cNum);
    w.streamObj(cNum, '/Filter /FlateDecode',
      zlib.deflateSync(contentFor(`Nesne akisi — sayfa ${i + 1}`)));
  }

  // Bu nesneler ObjStm İÇİNE gidecek
  const fontNum = next++;
  const pagesNum = next++;
  const pageNums = [];
  for (let i = 0; i < pageCount; i++) pageNums.push(next++);
  const catalogNum = next++;
  const infoNum = next++;

  const inStream = [
    [fontNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    [pagesNum, `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageCount} >>`],
    ...pageNums.map((pNum, i) => [pNum,
      `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 595.28 841.89] ` +
      `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNums[i]} 0 R >>`]),
    [catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`],
    [infoNum, '<< /Title (Nesne akisli belge) /Producer (fitfak test) >>']
  ];

  // ObjStm düzeni: "num offset num offset …" başlığı + nesne gövdeleri
  let header = '';
  let body = '';
  for (const [num, text] of inStream) {
    header += `${num} ${body.length} `;
    body += text + '\n';
  }
  const first = Buffer.byteLength(header, 'latin1');
  const objStmData = zlib.deflateSync(Buffer.from(header + body, 'latin1'));

  const objStmNum = next++;
  w.startObject(objStmNum);
  w.write(`<< /Type /ObjStm /N ${inStream.length} /First ${first} ` +
          `/Filter /FlateDecode /Length ${objStmData.length} >>\nstream\n`);
  w.write(objStmData);
  w.write('\nendstream\n');
  w.endObject();

  // XRef akışı: ObjStm içindekiler tip 2 ile gösterilir
  const xrefNum = next++;
  const size = next;
  const xrefOffset = w.offset;
  w.objects.set(xrefNum, xrefOffset);

  const rowLen = 7;
  const rows = [];
  for (let i = 0; i < size; i++) {
    const row = Buffer.alloc(rowLen);
    const inStmIndex = inStream.findIndex(([num]) => num === i);

    if (i === 0) {
      row[0] = 0; row.writeUInt32BE(0, 1); row.writeUInt16BE(0xFFFF, 5);
    } else if (inStmIndex >= 0) {
      row[0] = 2;                                   // sıkıştırılmış nesne
      row.writeUInt32BE(objStmNum, 1);              // hangi ObjStm
      row.writeUInt16BE(inStmIndex, 5);             // içindeki sıra
    } else if (w.objects.has(i)) {
      row[0] = 1; row.writeUInt32BE(w.objects.get(i), 1); row.writeUInt16BE(0, 5);
    } else {
      row[0] = 0; row.writeUInt32BE(0, 1); row.writeUInt16BE(0xFFFF, 5);
    }
    rows.push(row);
  }

  const data = zlib.deflateSync(Buffer.concat(rows));   // predictor YOK (çeşitlilik)
  w.write(`${xrefNum} 0 obj\n`);
  w.write(`<< /Type /XRef /Size ${size} /W [1 4 2] /Root ${catalogNum} 0 R ` +
          `/Info ${infoNum} 0 R /Filter /FlateDecode /Length ${data.length} >>\nstream\n`);
  w.write(data);
  w.write('\nendstream\nendobj\n');
  w.write(`startxref\n${xrefOffset}\n%%EOF\n`);

  return w.toBuffer();
}

/* ------------------------------------------------------------------ */
/* 4. Farklı filtreler                                                  */
/* ------------------------------------------------------------------ */

function mixedFilters() {
  const w = new Writer();
  w.write('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  const fontNum = 1;
  w.obj(fontNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const raw = contentFor('Karisik filtreler');

  // ASCIIHex
  const hexData = Buffer.from(raw.toString('hex') + '>', 'latin1');
  w.streamObj(3, '/Filter /ASCIIHexDecode', hexData);

  // RunLength
  w.streamObj(4, '/Filter /RunLengthDecode', runLengthEncode(contentFor('RunLength filtresi', 600)));

  // ASCII85 + Flate zinciri
  const a85 = ascii85Encode(zlib.deflateSync(contentFor('ASCII85 + Flate', 500)));
  w.streamObj(5, '/Filter [/ASCII85Decode /FlateDecode]', a85);

  const pagesNum = 2;
  const pageNum = 6;
  w.obj(pageNum,
    `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 595.28 841.89] ` +
    `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents [3 0 R 4 0 R 5 0 R] >>`);

  w.objects.set(pagesNum, w.offset);
  w.write(`${pagesNum} 0 obj\n<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>\nendobj\n`);

  const catalogNum = 7;
  w.obj(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  writeClassicTrailer(w, 8, catalogNum, null);
  return w.toBuffer();
}

function runLengthEncode(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    let runLen = 1;
    while (i + runLen < data.length && data[i + runLen] === data[i] && runLen < 127) runLen++;
    if (runLen >= 2) {
      out.push(257 - runLen, data[i]);
      i += runLen;
    } else {
      let litStart = i;
      let litLen = 0;
      while (i < data.length && litLen < 127) {
        if (i + 1 < data.length && data[i + 1] === data[i]) break;
        i++; litLen++;
      }
      out.push(litLen - 1);
      for (let k = 0; k < litLen; k++) out.push(data[litStart + k]);
    }
  }
  out.push(128);
  return Buffer.from(out);
}

function ascii85Encode(data) {
  let out = '';
  for (let i = 0; i < data.length; i += 4) {
    const chunk = data.subarray(i, i + 4);
    const n = chunk.length;
    let tuple = 0;
    for (let k = 0; k < 4; k++) tuple = tuple * 256 + (chunk[k] || 0);
    if (n === 4 && tuple === 0) { out += 'z'; continue; }
    const chars = [];
    for (let k = 0; k < 5; k++) { chars.unshift(String.fromCharCode(0x21 + (tuple % 85))); tuple = Math.floor(tuple / 85); }
    out += chars.slice(0, n + 1).join('');
  }
  return Buffer.from(out + '~>', 'latin1');
}

/* ------------------------------------------------------------------ */
/* 5. Bozuk xref (kurtarma testi)                                       */
/* ------------------------------------------------------------------ */

function brokenXref() {
  const pdf = classicXref(1);
  const text = pdf.toString('latin1');

  // Tüm xref offset'lerini bozalım
  const xrefIdx = text.lastIndexOf('xref');
  const out = Buffer.from(pdf);
  const broken = Buffer.from(
    text.slice(xrefIdx).replace(/\d{10} \d{5} n/g, '0000000999 00000 n'), 'latin1');
  broken.copy(out, xrefIdx);
  return out;
}

/* ------------------------------------------------------------------ */
/* 6. Şifreli PDF (RC4-40, R2)                                          */
/* ------------------------------------------------------------------ */

const PAD = Buffer.from([
  0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56,
  0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80,
  0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A
]);

function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }
  const out = Buffer.alloc(data.length);
  let i = 0; j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const t = s[i]; s[i] = s[j]; s[j] = t;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

function padPwd(pwd) {
  const b = Buffer.from(pwd || '', 'latin1');
  const out = Buffer.alloc(32);
  const n = Math.min(b.length, 32);
  b.copy(out, 0, 0, n);
  PAD.copy(out, n, 0, 32 - n);
  return out;
}

/** RC4-40 (R2) şifreli PDF üretir. Kullanıcı parolası boş, sahip parolası verilir. */
function encryptedRc4(userPwd = '', ownerPwd = 'sahip') {
  const id = Buffer.from('0102030405060708090A0B0C0D0E0F10', 'hex');
  const p = -1;                                        // tüm izinler

  // /O: sahip parolasından türetilir (Algoritma 3)
  const ownerKey = crypto.createHash('md5').update(padPwd(ownerPwd || userPwd)).digest().subarray(0, 5);
  const O = rc4(ownerKey, padPwd(userPwd));

  // Dosya anahtarı (Algoritma 2)
  const pBuf = Buffer.alloc(4);
  pBuf.writeInt32LE(p, 0);
  const fileKey = crypto.createHash('md5')
    .update(padPwd(userPwd)).update(O).update(pBuf).update(id)
    .digest().subarray(0, 5);

  // /U (Algoritma 4, R2)
  const U = rc4(fileKey, PAD);

  const objKey = (num, gen) => crypto.createHash('md5').update(Buffer.concat([
    fileKey,
    Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff])
  ])).digest().subarray(0, 10);

  const w = new Writer();
  w.write('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  const fontNum = 1;
  w.obj(fontNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const contentNum = 3;
  const content = contentFor('Sifreli belge (RC4-40)');
  w.streamObj(contentNum, '', rc4(objKey(contentNum, 0), content));

  const pagesNum = 2;
  const pageNum = 4;
  w.obj(pageNum,
    `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 595.28 841.89] ` +
    `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`);

  w.objects.set(pagesNum, w.offset);
  w.write(`${pagesNum} 0 obj\n<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>\nendobj\n`);

  const catalogNum = 5;
  w.obj(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);

  // /Info içindeki dizgiler de şifrelenir
  const infoNum = 6;
  const title = rc4(objKey(infoNum, 0), Buffer.from('Sifreli test belgesi', 'latin1'));
  w.obj(infoNum, `<< /Title <${title.toString('hex')}> >>`);

  const encNum = 7;
  w.obj(encNum,
    `<< /Filter /Standard /V 1 /R 2 /Length 40 /P ${p} ` +
    `/O <${O.toString('hex')}> /U <${U.toString('hex')}> >>`);

  const start = w.offset;
  const size = 8;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) {
    xref += `${String(w.objects.get(i) || 0).padStart(10, '0')} 00000 n \n`;
  }
  w.write(xref);
  w.write(`trailer\n<< /Size ${size} /Root ${catalogNum} 0 R /Info ${infoNum} 0 R ` +
          `/Encrypt ${encNum} 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\n`);
  w.write(`startxref\n${start}\n%%EOF\n`);

  return w.toBuffer();
}

/* ------------------------------------------------------------------ */
/* 7. Döndürülmüş / farklı kutulu sayfa                                 */
/* ------------------------------------------------------------------ */

function rotatedPages() {
  const w = new Writer();
  w.write('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  const fontNum = 1;
  w.obj(fontNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const contentNum = 3;
  w.streamObj(contentNum, '', contentFor('Dondurulmus sayfa'));

  const pagesNum = 2;
  const p1 = 4, p2 = 5;
  // Miras: MediaBox ve Resources üst düğümde
  w.obj(p1, `<< /Type /Page /Parent ${pagesNum} 0 R /Rotate 90 /Contents ${contentNum} 0 R >>`);
  w.obj(p2, `<< /Type /Page /Parent ${pagesNum} 0 R /CropBox [50 50 400 700] /Contents ${contentNum} 0 R >>`);

  w.objects.set(pagesNum, w.offset);
  w.write(`${pagesNum} 0 obj\n<< /Type /Pages /Kids [${p1} 0 R ${p2} 0 R] /Count 2 ` +
          `/MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 ${fontNum} 0 R >> >> >>\nendobj\n`);

  const catalogNum = 6;
  w.obj(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  writeClassicTrailer(w, 7, catalogNum, null);
  return w.toBuffer();
}

/* ------------------------------------------------------------------ */
/* 9. AcroForm (doldurulabilir form)                                    */
/* ------------------------------------------------------------------ */

function acroForm() {
  const w = new Writer();
  w.write('%PDF-1.6\n%\xE2\xE3\xCF\xD3\n');

  const fontNum = 1;
  w.obj(fontNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  const contentNum = 3;
  w.streamObj(contentNum, '', Buffer.from(
    'BT /F1 16 Tf 60 780 Td (Basvuru Formu) Tj ET\n' +
    'BT /F1 10 Tf 60 726 Td (Ad Soyad:) Tj ET\n' +
    'BT /F1 10 Tf 60 686 Td (Adres:) Tj ET\n' +
    'BT /F1 10 Tf 60 626 Td (Sehir:) Tj ET\n' +
    'BT /F1 10 Tf 60 596 Td (Onay:) Tj ET\n' +
    'BT /F1 10 Tf 60 566 Td (Cinsiyet:) Tj ET\n', 'latin1'));

  // --- alanlar ---
  const adNum = 10, adresNum = 11, sehirNum = 12, onayNum = 13;
  const cinsiyetNum = 14, cinsiyetK1 = 15, cinsiyetK2 = 16, imzaNum = 17;
  const pageNum = 4;

  const widget = (extra) => `/Type /Annot /Subtype /Widget /F 4 /P ${pageNum} 0 R ${extra}`;

  w.obj(adNum, `<< ${widget('/FT /Tx /T (ad) /Rect [140 720 400 740] ' +
    '/DA (0 0 0.4 rg /Helv 11 Tf) /MaxLen 60')} >>`);

  w.obj(adresNum, `<< ${widget('/FT /Tx /Ff 4096 /T (adres) /Rect [140 660 400 710] /DA (0 g /Helv 9 Tf)')} >>`);

  w.obj(sehirNum, `<< ${widget('/FT /Ch /T (sehir) /Rect [140 620 300 640] /DA (0 g /Helv 10 Tf) ' +
    '/Opt [(Ankara) (Istanbul) (Izmir)] /V (Ankara)')} >>`);

  w.obj(onayNum, `<< ${widget('/FT /Btn /T (onay) /Rect [140 590 158 608] /DA (0 g /ZaDb 0 Tf) ' +
    '/AS /Off /AP << /N << /Yes 20 0 R /Off 21 0 R >> >>')} >>`);

  // Radyo grubu: iki widget alt düğüm
  w.obj(cinsiyetNum, `<< /FT /Btn /Ff 32768 /T (cinsiyet) /V /Off /Kids [${cinsiyetK1} 0 R ${cinsiyetK2} 0 R] >>`);
  w.obj(cinsiyetK1, `<< ${widget(`/Parent ${cinsiyetNum} 0 R /Rect [140 560 156 576] ` +
    '/AS /Off /AP << /N << /K 20 0 R /Off 21 0 R >> >>')} >>`);
  w.obj(cinsiyetK2, `<< ${widget(`/Parent ${cinsiyetNum} 0 R /Rect [200 560 216 576] ` +
    '/AS /Off /AP << /N << /E 20 0 R /Off 21 0 R >> >>')} >>`);

  // İmza alanı: doldurma/düzleştirme buna DOKUNMAMALI
  w.obj(imzaNum, `<< ${widget('/FT /Sig /T (imza) /Rect [380 540 560 600]')} >>`);

  // Görünüm akışları (işaretli / boş)
  w.streamObj(20, '/Type /XObject /Subtype /Form /BBox [0 0 18 18]',
    Buffer.from('q 0 g 3 3 m 8 9 l 15 15 l 13 17 l 8 12 l 5 5 l f Q', 'latin1'));
  w.streamObj(21, '/Type /XObject /Subtype /Form /BBox [0 0 18 18]',
    Buffer.from('q 0.6 g 0.5 0.5 17 17 re S Q', 'latin1'));

  const pagesNum = 2;
  w.obj(pageNum, `<< /Type /Page /Parent ${pagesNum} 0 R /Contents ${contentNum} 0 R ` +
    `/Annots [${adNum} 0 R ${adresNum} 0 R ${sehirNum} 0 R ${onayNum} 0 R ` +
    `${cinsiyetK1} 0 R ${cinsiyetK2} 0 R ${imzaNum} 0 R] >>`);

  w.objects.set(pagesNum, w.offset);
  w.write(`${pagesNum} 0 obj\n<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 ` +
          `/MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 ${fontNum} 0 R >> >> >>\nendobj\n`);

  // /DR: alanların /DA dizgisinde adı geçen fontlar
  const drFontNum = 22;
  w.obj(drFontNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  const acroNum = 23;
  w.obj(acroNum, `<< /Fields [${adNum} 0 R ${adresNum} 0 R ${sehirNum} 0 R ${onayNum} 0 R ` +
    `${cinsiyetNum} 0 R ${imzaNum} 0 R] /NeedAppearances true ` +
    `/DR << /Font << /Helv ${drFontNum} 0 R >> >> /DA (0 g /Helv 10 Tf) >>`);

  const catalogNum = 24;
  w.obj(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R /AcroForm ${acroNum} 0 R >>`);
  writeClassicTrailer(w, 25, catalogNum, null);
  return w.toBuffer();
}

/* ------------------------------------------------------------------ */

const FIXTURES = {
  'classic-xref.pdf': () => classicXref(1),
  'classic-xref-3p.pdf': () => classicXref(3),
  'xref-stream.pdf': () => xrefStream(2),
  'object-stream.pdf': () => objectStream(2),
  'mixed-filters.pdf': () => mixedFilters(),
  'broken-xref.pdf': () => brokenXref(),
  'encrypted-rc4.pdf': () => encryptedRc4('', 'sahip'),
  'encrypted-rc4-userpwd.pdf': () => encryptedRc4('gizli', 'sahip'),
  'rotated-pages.pdf': () => rotatedPages(),
  'acroform.pdf': () => acroForm()
};

function generateAll() {
  const written = [];
  for (const [name, fn] of Object.entries(FIXTURES)) {
    const buf = fn();
    fs.writeFileSync(path.join(OUT, name), buf);
    written.push({ name, size: buf.length });
  }
  return written;
}

module.exports = { generateAll, FIXTURES, classicXref, xrefStream, objectStream, encryptedRc4, acroForm };

if (require.main === module) {
  for (const f of generateAll()) {
    console.log(`  ${f.name.padEnd(28)} ${String(f.size).padStart(7)} bayt`);
  }
}
