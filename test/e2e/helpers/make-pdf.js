'use strict';
/**
 * Testler için küçük, bağımsız bir PDF üreticisi.
 *
 * @fitfak/pdf motoru dosya yoluna yazar; testlerde geçici dizin kullanılır.
 * Font gerektirmeyen "çıplak" bir PDF de üretebiliriz — imza testlerinin çoğu
 * içeriğe değil yapıya bakar, bu yüzden hızlı yol varsayılandır.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

/**
 * Bağımlılıksız, elle kurulmuş küçük bir PDF üretir (klasik xref tablosu ile).
 * @param {{ title?: string, lines?: string[], pages?: number }} [opts]
 * @returns {Buffer}
 */
function makeSimplePdf(opts = {}) {
  const title = opts.title || 'Test Belgesi';
  const lines = opts.lines || ['PAdES imza testi', 'Bu belge test amacli uretilmistir.'];
  const pageCount = Math.max(1, opts.pages || 1);

  const objects = [];   // 1 tabanlı; objects[i-1] = içerik string/Buffer
  const push = (content) => { objects.push(content); return objects.length; };

  const fontId = push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  const pageIds = [];
  const contentIds = [];
  for (let p = 0; p < pageCount; p++) {
    let stream = 'BT /F1 18 Tf 56 780 Td (' + escapePdfText(title) + ') Tj ET\n';
    let y = 745;
    for (const ln of lines) {
      stream += `BT /F1 11 Tf 56 ${y} Td (${escapePdfText(ln)}) Tj ET\n`;
      y -= 18;
    }
    stream += `BT /F1 9 Tf 56 60 Td (Sayfa ${p + 1} / ${pageCount}) Tj ET\n`;
    const cid = push({ dict: `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>`, stream });
    contentIds.push(cid);
  }

  const pagesId = objects.length + pageCount + 1;
  for (let p = 0; p < pageCount; p++) {
    pageIds.push(push(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595.28 841.89] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[p]} 0 R >>`
    ));
  }

  const realPagesId = push(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
  );
  // pageIds içindeki /Parent referansı realPagesId ile aynı olmalı
  if (realPagesId !== pagesId) {
    for (let i = 0; i < pageIds.length; i++) {
      const idx = pageIds[i] - 1;
      objects[idx] = objects[idx].replace(`/Parent ${pagesId} 0 R`, `/Parent ${realPagesId} 0 R`);
    }
  }

  const catalogId = push(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);
  const infoId = push(`<< /Title (${escapePdfText(title)}) /Producer (fitfak-belge test) >>`);

  // ── Serileştir ──
  const chunks = [];
  let offset = 0;
  const write = (str) => {
    const b = Buffer.isBuffer(str) ? str : Buffer.from(str, 'latin1');
    chunks.push(b);
    offset += b.length;
  };

  write('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');

  const offsets = new Array(objects.length + 1).fill(0);
  for (let i = 0; i < objects.length; i++) {
    offsets[i + 1] = offset;
    const o = objects[i];
    if (typeof o === 'string') {
      write(`${i + 1} 0 obj\n${o}\nendobj\n`);
    } else {
      write(`${i + 1} 0 obj\n${o.dict}\nstream\n`);
      write(o.stream);
      write('\nendstream\nendobj\n');
    }
  }

  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  write(xref);
  write(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n`);
  write(`startxref\n${xrefStart}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

function escapePdfText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Geçici bir dosya yolu üretir (testler sonunda silinir). */
function tmpFile(suffix = '.pdf') {
  return path.join(os.tmpdir(), `fitfak-test-${process.pid}-${Math.random().toString(36).slice(2)}${suffix}`);
}

module.exports = { makeSimplePdf, tmpFile };
