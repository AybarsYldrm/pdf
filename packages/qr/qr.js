const zlib = require('zlib');
const { Buffer } = require('buffer');

/* ----------------------------- CRC32 (PNG) ----------------------------- */

function crc32(buf) {
  if (!crc32.table) {
    crc32.table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      crc32.table[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crc32.table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ----------------------------- PNG encoder ----------------------------- */

function pngFromMatrix(model, cellSize = 8, quiet = 4) {
  const n = model.size;
  const imgModules = n + quiet * 2;
  const width = imgModules * cellSize;
  const height = width;
  const rowBytes = width;

  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0; // filter type 0
    const my = Math.floor(y / cellSize) - quiet;
    for (let x = 0; x < width; x++) {
      const mx = Math.floor(x / cellSize) - quiet;
      let dark = 0;
      if (my >= 0 && my < n && mx >= 0 && mx < n) {
        dark = model.matrix[my][mx].val ? 1 : 0;
      }
      raw[rowStart + 1 + x] = dark ? 0x00 : 0xff;
    }
  }

  const compressed = zlib.deflateSync(raw);

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const payload = Buffer.concat([typeBuf, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(payload), 0);
    return Buffer.concat([len, payload, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------ QR ENGINE ------------------------------ */

const QR = (function () {
  /* ---- GF(256) ---- */

  const EXP = new Array(512);
  const LOG = new Array(256);
  let v = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = v;
    LOG[v] = i;
    v <<= 1;
    if (v & 0x100) v ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[(LOG[a] + LOG[b]) % 255];
  }

  function polyMul(a, b) {
    const out = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < b.length; j++) {
        out[i + j] ^= gfMul(a[i], b[j]);
      }
    }
    return out;
  }

  function makeGenerator(ecLen) {
    let poly = [1];
    for (let i = 0; i < ecLen; i++) {
      poly = polyMul(poly, [1, EXP[i]]);
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    const gen = makeGenerator(ecLen);
    const msg = data.concat(new Array(ecLen).fill(0));
    for (let i = 0; i < data.length; i++) {
      const coef = msg[i];
      if (coef !== 0) {
        for (let j = 0; j < gen.length; j++) {
          msg[i + j] ^= gfMul(gen[j], coef);
        }
      }
    }
    return msg.slice(msg.length - ecLen);
  }

  /* ---- RS block table (only EC=M, versions 1..40) ---- */
  // Her eleman: { ec: ecPerBlock, blocks: [ {c:count, data:dataCodewords}, ... ] }

  const RS_M = [
    null, // index 0 yok
    { ec: 10, blocks: [{ c: 1, data: 16 }] },                            // 1
    { ec: 16, blocks: [{ c: 1, data: 28 }] },                            // 2
    { ec: 26, blocks: [{ c: 1, data: 44 }] },                            // 3
    { ec: 18, blocks: [{ c: 2, data: 32 }] },                            // 4
    { ec: 24, blocks: [{ c: 2, data: 43 }] },                            // 5
    { ec: 16, blocks: [{ c: 4, data: 27 }] },                            // 6
    { ec: 18, blocks: [{ c: 4, data: 31 }] },                            // 7
    { ec: 22, blocks: [{ c: 2, data: 38 }, { c: 2, data: 39 }] },        // 8
    { ec: 22, blocks: [{ c: 3, data: 36 }, { c: 2, data: 37 }] },        // 9
    { ec: 26, blocks: [{ c: 4, data: 43 }, { c: 1, data: 44 }] },        //10
    { ec: 30, blocks: [{ c: 1, data: 50 }, { c: 4, data: 51 }] },        //11
    { ec: 22, blocks: [{ c: 6, data: 36 }, { c: 2, data: 37 }] },        //12
    { ec: 22, blocks: [{ c: 8, data: 37 }, { c: 1, data: 38 }] },        //13
    { ec: 24, blocks: [{ c: 4, data: 40 }, { c: 5, data: 41 }] },        //14
    { ec: 24, blocks: [{ c: 5, data: 41 }, { c: 5, data: 42 }] },        //15
    { ec: 28, blocks: [{ c: 7, data: 45 }, { c: 3, data: 46 }] },        //16
    { ec: 28, blocks: [{ c: 10, data: 46 }, { c: 1, data: 47 }] },       //17
    { ec: 26, blocks: [{ c: 9, data: 43 }, { c: 4, data: 44 }] },        //18
    { ec: 26, blocks: [{ c: 3, data: 44 }, { c: 11, data: 45 }] },       //19
    { ec: 26, blocks: [{ c: 3, data: 41 }, { c: 13, data: 42 }] },       //20
    { ec: 26, blocks: [{ c: 17, data: 42 }] },                           //21
    { ec: 28, blocks: [{ c: 17, data: 46 }] },                           //22
    { ec: 28, blocks: [{ c: 4, data: 47 }, { c: 14, data: 48 }] },       //23
    { ec: 28, blocks: [{ c: 6, data: 45 }, { c: 14, data: 46 }] },       //24
    { ec: 28, blocks: [{ c: 8, data: 47 }, { c: 13, data: 48 }] },       //25
    { ec: 28, blocks: [{ c: 19, data: 46 }, { c: 4, data: 47 }] },       //26
    { ec: 28, blocks: [{ c: 22, data: 45 }, { c: 3, data: 46 }] },       //27
    { ec: 28, blocks: [{ c: 3, data: 45 }, { c: 23, data: 46 }] },       //28
    { ec: 28, blocks: [{ c: 21, data: 45 }, { c: 7, data: 46 }] },       //29
    { ec: 28, blocks: [{ c: 19, data: 47 }, { c: 10, data: 48 }] },      //30
    { ec: 28, blocks: [{ c: 2, data: 46 }, { c: 29, data: 47 }] },       //31
    { ec: 28, blocks: [{ c: 10, data: 46 }, { c: 23, data: 47 }] },      //32
    { ec: 28, blocks: [{ c: 14, data: 46 }, { c: 21, data: 47 }] },      //33
    { ec: 28, blocks: [{ c: 14, data: 46 }, { c: 23, data: 47 }] },      //34
    { ec: 28, blocks: [{ c: 12, data: 47 }, { c: 26, data: 48 }] },      //35
    { ec: 28, blocks: [{ c: 6, data: 47 }, { c: 34, data: 48 }] },       //36
    { ec: 28, blocks: [{ c: 29, data: 46 }, { c: 14, data: 47 }] },      //37
    { ec: 28, blocks: [{ c: 13, data: 46 }, { c: 32, data: 47 }] },      //38
    { ec: 28, blocks: [{ c: 40, data: 47 }, { c: 7, data: 48 }] },       //39
    { ec: 28, blocks: [{ c: 18, data: 47 }, { c: 31, data: 48 }] }       //40
  ];

  function getRSInfo(version, ecLevel) {
    if (ecLevel !== 'M') {
      throw new Error('Şu an sadece EC=M destekli. Diğer seviyeler için RS tablosunu genişlet.');
    }
    if (version < 1 || version > 40) {
      throw new Error('Versiyon 1..40 arası olmalı.');
    }
    return RS_M[version];
  }

  function capacityBytes(version, ecLevel) {
    const info = getRSInfo(version, ecLevel);
    let total = 0;
    for (const b of info.blocks) total += b.c * b.data;
    return total;
  }

  /* ---- Alignment positions v1..40 ---- */

  const ALIGN_POS = [
    [],      // 0
    [],      // 1
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
    [6, 30, 54],
    [6, 32, 58],
    [6, 34, 62],
    [6, 26, 46, 66],
    [6, 26, 48, 70],
    [6, 26, 50, 74],
    [6, 30, 54, 78],
    [6, 30, 56, 82],
    [6, 30, 58, 86],
    [6, 34, 62, 90],
    [6, 28, 50, 72, 94],
    [6, 26, 50, 74, 98],
    [6, 30, 54, 78, 102],
    [6, 28, 54, 80, 106],
    [6, 32, 58, 84, 110],
    [6, 30, 58, 86, 114],
    [6, 34, 62, 90, 118],
    [6, 26, 50, 74, 98, 122],
    [6, 30, 54, 78, 102, 126],
    [6, 26, 52, 78, 104, 130],
    [6, 30, 56, 82, 108, 134],
    [6, 34, 60, 86, 112, 138],
    [6, 30, 58, 86, 114, 142],
    [6, 34, 62, 90, 118, 146],
    [6, 30, 54, 78, 102, 126, 150],
    [6, 24, 50, 76, 102, 128, 154],
    [6, 28, 54, 80, 106, 132, 158],
    [6, 32, 58, 84, 110, 136, 162],
    [6, 26, 54, 82, 110, 138, 166],
    [6, 30, 58, 86, 114, 142, 170]
  ];

  /* ---- Matrix helpers ---- */

  function makeMatrix(version) {
    const size = 21 + (version - 1) * 4;
    const m = new Array(size);
    for (let r = 0; r < size; r++) {
      m[r] = new Array(size).fill(null);
    }
    return { m, size };
  }

  function placeFinder(m, x, y) {
    const pat = [
      [1,1,1,1,1,1,1],
      [1,0,0,0,0,0,1],
      [1,0,1,1,1,0,1],
      [1,0,1,1,1,0,1],
      [1,0,1,1,1,0,1],
      [1,0,0,0,0,0,1],
      [1,1,1,1,1,1,1]
    ];
    const n = m.length;
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        m[y + r][x + c] = { val: pat[r][c], reserved: true };
      }
    }
    // separator
    for (let rr = y - 1; rr <= y + 7; rr++) {
      if (rr < 0 || rr >= n) continue;
      for (let cc = x - 1; cc <= x + 7; cc++) {
        if (cc < 0 || cc >= n) continue;
        if (m[rr][cc] == null) m[rr][cc] = { val: 0, reserved: true };
      }
    }
  }

  function placeAlignment(m, cx, cy) {
    const pat = [
      [1,1,1,1,1],
      [1,0,0,0,1],
      [1,0,1,0,1],
      [1,0,0,0,1],
      [1,1,1,1,1]
    ];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const y = cy - 2 + r;
        const x = cx - 2 + c;
        if (m[y][x] == null || !m[y][x].reserved) {
          m[y][x] = { val: pat[r][c], reserved: true };
        }
      }
    }
  }

  function placeTiming(m) {
    const n = m.length;
    for (let i = 8; i < n - 8; i++) {
      if (m[6][i] == null) m[6][i] = { val: (i % 2 === 0 ? 1 : 0), reserved: true };
      if (m[i][6] == null) m[i][6] = { val: (i % 2 === 0 ? 1 : 0), reserved: true };
    }
  }

  function reserveFormatArea(m) {
    const n = m.length;
    for (let i = 0; i < 9; i++) {
      if (i !== 6) {
        if (m[8][i] == null) m[8][i] = { val: 0, reserved: true };
        if (m[i][8] == null) m[i][8] = { val: 0, reserved: true };
      }
    }
    for (let i = 0; i < 8; i++) {
      if (m[n - 1 - i][8] == null) m[n - 1 - i][8] = { val: 0, reserved: true };
      if (m[8][n - 1 - i] == null) m[8][n - 1 - i] = { val: 0, reserved: true };
    }
    if (m[8][6] == null) m[8][6] = { val: 0, reserved: true };
    if (m[6][8] == null) m[6][8] = { val: 0, reserved: true };
  }

  function reserveVersionArea(m, version) {
    if (version < 7) return;
    const n = m.length;
    // bottom-left 3x6
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 6; c++) {
        const y = n - 11 + r;
        const x = c;
        if (m[y][x] == null) m[y][x] = { val: 0, reserved: true };
        else m[y][x].reserved = true;
      }
    }
    // top-right 6x3
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 3; c++) {
        const y = r;
        const x = n - 11 + c;
        if (m[y][x] == null) m[y][x] = { val: 0, reserved: true };
        else m[y][x].reserved = true;
      }
    }
  }

  function placeDarkModule(m, version) {
    const n = m.length;
    const y = 4 * version + 9;
    const x = 8;
    if (y < n) {
      m[y][x] = { val: 1, reserved: true };
    }
  }

  function placeData(m, bits) {
    const n = m.length;
    let bitIndex = 0;
    let upward = true;
    let col = n - 1;

    while (col > 0) {
      if (col === 6) col--;

      for (let i = 0; i < n; i++) {
        const row = upward ? n - 1 - i : i;
        for (let c = 0; c < 2; c++) {
          const x = col - c;
          const cell = m[row][x];
          if (cell && cell.reserved) continue;
          const bit = bitIndex < bits.length ? bits[bitIndex++] : 0;
          m[row][x] = { val: bit, reserved: false };
        }
      }
      col -= 2;
      upward = !upward;
    }
  }

  const MASK_FUNCS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) === 0,
    (r, c) => (((r * c) % 2 + (r * c) % 3) % 2) === 0,
    (r, c) => (((r + c) % 2 + (r * c) % 3) % 2) === 0
  ];

  function applyMask(m, maskIndex) {
    const n = m.length;
    const fn = MASK_FUNCS[maskIndex];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const cell = m[r][c];
        if (!cell || cell.reserved) continue;
        if (fn(r, c)) cell.val ^= 1;
      }
    }
  }

  function penaltyScore(m) {
    const n = m.length;
    let score = 0;

    // Rule 1: rows
    for (let r = 0; r < n; r++) {
      let run = 1;
      for (let c = 1; c < n; c++) {
        if (m[r][c].val === m[r][c - 1].val) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }

    // Rule 1: cols
    for (let c = 0; c < n; c++) {
      let run = 1;
      for (let r = 1; r < n; r++) {
        if (m[r][c].val === m[r - 1][c].val) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }

    // Rule 2: 2x2
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const s = m[r][c].val + m[r][c + 1].val + m[r + 1][c].val + m[r + 1][c + 1].val;
        if (s === 0 || s === 4) score += 3;
      }
    }

    // Rule 3: finder-like patterns
    const p1 = [1,0,1,1,1,0,1,0,0,0,0];
    const p2 = [0,0,0,0,1,0,1,1,1,0,1];

    function matchPattern(arr, r, c, dr, dc) {
      for (let i = 0; i < arr.length; i++) {
        const rr = r + dr * i;
        const cc = c + dc * i;
        if (rr < 0 || rr >= n || cc < 0 || cc >= n) return false;
        if (m[rr][cc].val !== arr[i]) return false;
      }
      return true;
    }

    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (c + 11 <= n) {
          if (matchPattern(p1, r, c, 0, 1) || matchPattern(p2, r, c, 0, 1)) score += 40;
        }
        if (r + 11 <= n) {
          if (matchPattern(p1, r, c, 1, 0) || matchPattern(p2, r, c, 1, 0)) score += 40;
        }
      }
    }

    // Rule 4: dark ratio
    let dark = 0;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (m[r][c].val) dark++;
    }
    const total = n * n;
    const k = Math.abs((dark * 100 / total) - 50) / 5;
    score += k * 10;

    return score;
  }

  function bytesToBits(bytes) {
    const bits = [];
    for (const b of bytes) {
      for (let i = 7; i >= 0; i--) bits.push(((b >> i) & 1) ? 1 : 0);
    }
    return bits;
  }

  /* ---- Format & Version info ---- */

  const FORMAT_EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  function makeFormatBits(ecLevel, mask) {
    const ec = FORMAT_EC_BITS[ecLevel];
    let data = ((ec << 3) | mask) & 0x1f; // 5 bit
    let bits = data << 10;
    const poly = 0x537; // 10100110111
    for (let i = 14; i >= 10; i--) {
      if ((bits >> i) & 1) {
        bits ^= poly << (i - 10);
      }
    }
    const code = ((data << 10) | bits) ^ 0x5412;
    const out = [];
    for (let i = 14; i >= 0; i--) out.push(((code >> i) & 1) ? 1 : 0);
    return out;
  }

  function writeFormatBits(m, formatBits) {
    const n = m.length;
    // top-left + top-right vertical
    for (let i = 0; i < 6; i++) m[8][i].val = formatBits[i];
    m[8][7].val = formatBits[6];
    m[8][8].val = formatBits[7];
    m[7][8].val = formatBits[8];
    for (let i = 9; i < 15; i++) m[14 - i][8].val = formatBits[i];

    // bottom-left + top-right horizontal
    for (let i = 0; i < 8; i++) m[n - 1 - i][8].val = formatBits[i];
    for (let i = 8; i < 15; i++) m[8][n - 15 + i].val = formatBits[i];
  }

  function makeVersionBits(version) {
    if (version < 7) return null;
    const gen = 0x1f25; // 18,6 Golay generator polynomial
    let data = version & 0x3f; // 6 bit
    let bits = data << 12;
    for (let i = 17; i >= 12; i--) {
      if ((bits >> i) & 1) {
        bits ^= gen << (i - 12);
      }
    }
    const remainder = bits & 0xfff;
    return (data << 12) | remainder; // 18 bit
  }

  function writeVersionBits(m, version) {
    if (version < 7) return;
    const n = m.length;
    const val = makeVersionBits(version);
    const bits = [];
    for (let i = 0; i < 18; i++) bits.push((val >> i) & 1); // 0=LSB

    const mapBL = [
      [0,3,6,9,12,15],
      [1,4,7,10,13,16],
      [2,5,8,11,14,17]
    ];
    const mapTR = [
      [0,1,2],
      [3,4,5],
      [6,7,8],
      [9,10,11],
      [12,13,14],
      [15,16,17]
    ];

    // bottom-left
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 6; c++) {
        const idx = mapBL[r][c];
        const y = n - 11 + r;
        const x = c;
        m[y][x] = { val: bits[idx], reserved: true };
      }
    }
    // top-right
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 3; c++) {
        const idx = mapTR[r][c];
        const y = r;
        const x = n - 11 + c;
        m[y][x] = { val: bits[idx], reserved: true };
      }
    }
  }

  /* ---- Data encoding ---- */

  function utf8Bytes(str) {
    return Array.from(Buffer.from(str, 'utf8'));
  }

  function estimateMinVersion(lenBytes, ecLevel) {
    for (let v = 1; v <= 40; v++) {
      const cap = capacityBytes(v, ecLevel) * 8;
      const lenBits = (v <= 9) ? 8 : 16; // byte mode
      const needed = 4 + lenBits + lenBytes * 8;
      if (needed <= cap) return v;
    }
    return null;
  }

  function build(text, versionPref = 0, ecLevel = 'M') {
    ecLevel = ecLevel.toUpperCase();
    if (ecLevel !== 'M') {
      throw new Error('Şu an sadece EC=M uygulanmış durumda.');
    }

    const dataBytes = utf8Bytes(String(text));
    let version = versionPref || 1;

    if (!versionPref) {
      const est = estimateMinVersion(dataBytes.length, ecLevel);
      if (est == null) {
        throw new Error('Veri 40-M kapasitesini bile aşıyor.');
      }
      version = est;
    } else {
      if (version < 1 || version > 40) {
        throw new Error('Versiyon 1..40 arasında olmalı.');
      }
      const capBits = capacityBytes(version, ecLevel) * 8;
      const lenBits = (version <= 9) ? 8 : 16;
      const needed = 4 + lenBits + dataBytes.length * 8;
      if (needed > capBits) {
        throw new Error('Seçilen versiyon/EC kapasiteyi karşılamıyor.');
      }
    }

    // byte mode
    const mode = 0b0100;
    const bits = [];
    for (let i = 3; i >= 0; i--) bits.push(((mode >> i) & 1) ? 1 : 0);

    const lenBits = (version <= 9) ? 8 : 16;
    const len = dataBytes.length;
    for (let i = lenBits - 1; i >= 0; i--) bits.push(((len >> i) & 1) ? 1 : 0);

    for (const b of dataBytes) {
      for (let i = 7; i >= 0; i--) bits.push(((b >> i) & 1) ? 1 : 0);
    }

    const capBits = capacityBytes(version, ecLevel) * 8;
    if (bits.length > capBits) {
      throw new Error('Kapasite hesabı aşılmış (bit overflow).');
    }

    // terminator + padding
    const remaining = capBits - bits.length;
    const term = Math.min(4, remaining);
    for (let i = 0; i < term; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    const dataCodewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      dataCodewords.push(v);
    }

    const totalData = capacityBytes(version, ecLevel);
    const padBytes = [0xEC, 0x11];
    let pi = 0;
    while (dataCodewords.length < totalData) {
      dataCodewords.push(padBytes[pi++ & 1]);
    }

    const info = getRSInfo(version, ecLevel);
    const blocks = [];
    let idx = 0;
    for (const b of info.blocks) {
      for (let i = 0; i < b.c; i++) {
        const part = dataCodewords.slice(idx, idx + b.data);
        idx += b.data;
        blocks.push({ data: part, ecLen: info.ec });
      }
    }

    const ecBlocks = blocks.map(bl => ({
      data: bl.data,
      ecc: rsEncode(bl.data, bl.ecLen)
    }));

    const maxDataLen = Math.max(...ecBlocks.map(b => b.data.length));
    const interleaved = [];
    for (let i = 0; i < maxDataLen; i++) {
      for (const b of ecBlocks) {
        if (i < b.data.length) interleaved.push(b.data[i]);
      }
    }
    const maxEcLen = ecBlocks[0].ecc.length;
    for (let i = 0; i < maxEcLen; i++) {
      for (const b of ecBlocks) interleaved.push(b.ecc[i]);
    }

    const finalBits = bytesToBits(interleaved);

    const { m, size } = makeMatrix(version);
    placeFinder(m, 0, 0);
    placeFinder(m, size - 7, 0);
    placeFinder(m, 0, size - 7);

    const align = ALIGN_POS[version];
    if (align && align.length) {
      for (let i = 0; i < align.length; i++) {
        for (let j = 0; j < align.length; j++) {
          const cx = align[i];
          const cy = align[j];
          if (cx === 6 && (cy === 6 || cy === size - 7)) continue;
          if (cy === 6 && (cx === 6 || cx === size - 7)) continue;
          if (cx === 0 || cy === 0) continue;
          placeAlignment(m, cx, cy);
        }
      }
    }

    placeTiming(m);
    reserveFormatArea(m);
    reserveVersionArea(m, version);
    placeDarkModule(m, version);
    placeData(m, finalBits);

    // mask seçimi
    let bestScore = null;
    let bestMask = 0;
    let bestMatrix = null;

    for (let mask = 0; mask < 8; mask++) {
      const clone = m.map(row => row.map(cell => ({ val: cell.val, reserved: cell.reserved })));
      applyMask(clone, mask);
      const score = penaltyScore(clone);
      if (bestScore === null || score < bestScore) {
        bestScore = score;
        bestMask = mask;
        bestMatrix = clone;
      }
    }

    const formatBits = makeFormatBits(ecLevel, bestMask);
    writeFormatBits(bestMatrix, formatBits);
    writeVersionBits(bestMatrix, version);

    return {
      matrix: bestMatrix,
      size,
      version,
      ecLevel,
      mask: bestMask
    };
  }

  return { build };
})();

/* -------------------------- Public PNG helper -------------------------- */

function generatePngBuffer(text, opts = {}) {
  const version = typeof opts.version === 'number' ? opts.version : 0;
  const size = typeof opts.size === 'number' ? opts.size : 512;
  const margin = typeof opts.margin === 'number' ? opts.margin : 4;

  const model = QR.build(String(text), version || 0, 'M');
  let cell = Math.floor(size / (model.size + margin * 2));
  if (cell < 1) cell = 1;
  return pngFromMatrix(model, cell, margin);
}

/* ------------------------------ Exports ------------------------------ */

module.exports = {
  QR,
  generatePngBuffer,
};