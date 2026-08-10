'use strict';
/**
 * ML-KEM-768 (CRYSTALS-Kyber) — FIPS 203 saf JavaScript uygulaması
 *
 * Parametre seti: k=3, η1=2, η2=2, du=10, dv=4, n=256, q=3329
 *
 * Referans: NIST FIPS 203 (2024)
 */

const { sha256, sha512 } = require('./hash');
const { randomBytes }    = require('./random');

const Q     = 3329;
const N     = 256;
const K     = 3;
const ETA1  = 2;
const ETA2  = 2;
const DU    = 10;
const DV    = 4;

const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const ROT = [
  [ 0,36, 3,41,18],
  [ 1,44,10,45, 2],
  [62, 6,43,15,61],
  [28,55,25,21,56],
  [27,20,39, 8,14],
];

const M64 = 0xffffffffffffffffn;

function rot64(x, n) { return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64; }

function keccakF1600(A) {
  for (let round = 0; round < 24; round++) {
    const C = Array(5);
    for (let x = 0; x < 5; x++)
      C[x] = A[x] ^ A[x+5] ^ A[x+10] ^ A[x+15] ^ A[x+20];
    const D = Array(5);
    for (let x = 0; x < 5; x++)
      D[x] = C[(x+4)%5] ^ rot64(C[(x+1)%5], 1);
    for (let i = 0; i < 25; i++) A[i] ^= D[i%5];

    // DÜZELTME 1: FIPS 202 Keccak-p Matris Koordinat Kaydırması
    const B = Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + ((2 * x + 3 * y) % 5) * 5] = rot64(A[x + y * 5], ROT[x][y]);
      }
    }

    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++)
        A[x+y*5] = B[x+y*5] ^ ((~B[(x+1)%5+y*5]) & B[(x+2)%5+y*5]);

    A[0] ^= KECCAK_RC[round];
  }
  return A;
}

function keccak(input, rate, dSuffix, outLen) {
  const state = Array(25).fill(0n);
  let off = 0;
  while (off + rate <= input.length) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 0; j < 8; j++) lane |= BigInt(input[off + i*8 + j]) << BigInt(j*8);
      state[i] ^= lane;
    }
    keccakF1600(state);
    off += rate;
  }
  const last = Buffer.alloc(rate);
  input.copy(last, 0, off);
  last[input.length - off] ^= dSuffix;
  last[rate - 1] ^= 0x80;
  for (let i = 0; i < rate / 8; i++) {
    let lane = 0n;
    for (let j = 0; j < 8; j++) lane |= BigInt(last[i*8 + j]) << BigInt(j*8);
    state[i] ^= lane;
  }
  keccakF1600(state);
  const out = Buffer.alloc(outLen);
  let written = 0;
  while (written < outLen) {
    for (let i = 0; i < rate / 8 && written < outLen; i++) {
      const lane = state[i];
      for (let j = 0; j < 8 && written < outLen; j++) {
        out[written++] = Number((lane >> BigInt(j*8)) & 0xffn);
      }
    }
    if (written < outLen) keccakF1600(state);
  }
  return out;
}

function sha3_256(data) { return keccak(data, 136, 0x06, 32); }
function sha3_512(data) { return keccak(data, 72,  0x06, 64); }
function shake128(data, outLen) { return keccak(data, 168, 0x1f, outLen); }
function shake256(data, outLen) { return keccak(data, 136, 0x1f, outLen); }

const ZETA = 17;
function _bitrev7(n) {
  let r = 0;
  for (let i = 0; i < 7; i++) { r = (r << 1) | (n & 1); n >>= 1; }
  return r;
}

const ZETAS = new Int32Array(128);
(function buildZetas() {
  for (let i = 0; i < 128; i++) {
    let z = 1, exp = _bitrev7(i);
    for (let j = 0; j < exp; j++) z = z * ZETA % Q;
    ZETAS[i] = z;
  }
})();

function _modQ(v) {
  v = v % Q;
  if (v < 0) v += Q;
  return v;
}

function ntt(f) {
  const a = Int32Array.from(f);
  let k = 1, len = 128;
  while (len >= 2) {
    for (let start = 0; start < 256; start += 2 * len) {
      const z = ZETAS[k++];
      for (let j = start; j < start + len; j++) {
        const t = z * a[j + len] % Q;
        a[j + len] = _modQ(a[j] - t);
        a[j]       = _modQ(a[j] + t);
      }
    }
    len >>= 1;
  }
  return a;
}

function nttInv(f) {
  const a = Int32Array.from(f);
  let k = 127, len = 2;
  while (len <= 128) {
    for (let start = 0; start < 256; start += 2 * len) {
      const z = ZETAS[k--]; 
      for (let j = start; j < start + len; j++) {
        const t = a[j];
        a[j]       = _modQ(t + a[j + len]);
        a[j + len] = _modQ(z * _modQ(a[j + len] - t));
      }
    }
    len <<= 1;
  }
  const F = 3303;
  for (let i = 0; i < 256; i++) a[i] = _modQ(a[i] * F);
  return a;
}

function baseMul(f, g) {
  const h = new Int32Array(256);
  for (let i = 0; i < 128; i++) {
    const j = 2 * i;
    let exp = (2 * _bitrev7(i) + 1);
    let z = 1;
    let base = 17;
    while(exp > 0) {
       if (exp & 1) z = (z * base) % 3329;
       base = (base * base) % 3329;
       exp >>= 1;
    }
    h[j]     = _modQ(f[j] * g[j] + _modQ(f[j+1] * g[j+1]) * z);
    h[j + 1] = _modQ(f[j] * g[j+1] + f[j+1] * g[j]);
  }
  return h;
}

function polyAdd(a, b) {
  const c = new Int32Array(N);
  for (let i = 0; i < N; i++) c[i] = _modQ(a[i] + b[i]);
  return c;
}

function polySub(a, b) {
  const c = new Int32Array(N);
  for (let i = 0; i < N; i++) c[i] = _modQ(a[i] - b[i]);
  return c;
}

function polyVecAdd(a, b) { return a.map((p, i) => polyAdd(p, b[i])); }

function matMulVec(A, v) {
  return A.map(row =>
    row.reduce((acc, aij, j) => {
      const prod = baseMul(aij, v[j]);
      return polyAdd(acc, prod);
    }, new Int32Array(N))
  );
}

function vecDot(a, b) {
  return a.reduce((acc, ai, i) => polyAdd(acc, baseMul(ai, b[i])), new Int32Array(N));
}

function sampleNTT(rho, i, j) {
  const seed = Buffer.concat([rho, Buffer.from([i, j])]);
  const stream = shake128(seed, 672);
  const a = new Int32Array(N);
  let pos = 0, cnt = 0;
  while (cnt < N && pos + 2 < stream.length) {
    const b0 = stream[pos], b1 = stream[pos+1], b2 = stream[pos+2];
    pos += 3;
    const d1 = b0 | ((b1 & 0x0f) << 8);
    const d2 = (b1 >> 4) | (b2 << 4);
    if (d1 < Q) a[cnt++] = d1;
    if (cnt < N && d2 < Q) a[cnt++] = d2;
  }
  return a;
}

function sampleCBD(eta, seed) {
  const stream = shake256(seed, 64 * eta);
  const f = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    let a = 0, b = 0;
    for (let j = 0; j < eta; j++) {
      const byteIdx = Math.floor((2 * i * eta + j) / 8);
      const bitIdx  = (2 * i * eta + j) % 8;
      a += (stream[byteIdx] >> bitIdx) & 1;
    }
    for (let j = 0; j < eta; j++) {
      const byteIdx = Math.floor((2 * i * eta + eta + j) / 8);
      const bitIdx  = (2 * i * eta + eta + j) % 8;
      b += (stream[byteIdx] >> bitIdx) & 1;
    }
    f[i] = _modQ(a - b);
  }
  return f;
}

function compress(poly, d) {
  const out = new Int32Array(N);
  const mask = (1 << d) - 1;
  for (let i = 0; i < N; i++) {
    out[i] = Math.floor((poly[i] * (1 << d) + 1664) / Q) & mask;
  }
  return out;
}

function decompress(poly, d) {
  const out = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = Math.floor((poly[i] * Q + (1 << (d - 1))) >> d) % Q;
  }
  return out;
}

function byteEncode(poly, d) {
  const out = Buffer.alloc(Math.ceil(N * d / 8));
  let bitOff = 0;
  for (let i = 0; i < N; i++) {
    let v = ((poly[i] % (1 << d)) + (1 << d)) % (1 << d);
    for (let bit = 0; bit < d; bit++) {
      const byteIdx = Math.floor(bitOff / 8);
      const bitIdx  = bitOff % 8;
      out[byteIdx] |= ((v >> bit) & 1) << bitIdx;
      bitOff++;
    }
  }
  return out;
}

function byteDecode(buf, d) {
  const poly = new Int32Array(N);
  let bitOff = 0;
  for (let i = 0; i < N; i++) {
    let v = 0;
    for (let bit = 0; bit < d; bit++) {
      const byteIdx = Math.floor(bitOff / 8);
      const bitIdx  = bitOff % 8;
      v |= ((buf[byteIdx] >> bitIdx) & 1) << bit;
      bitOff++;
    }
    poly[i] = v % (1 << d);
  }
  return poly;
}

function encodeVec(vec, d) { return Buffer.concat(vec.map(p => byteEncode(p, d))); }
function decodeVec(buf, d) {
  const bytesPerPoly = Math.ceil(N * d / 8);
  return Array.from({ length: K }, (_, i) =>
    byteDecode(buf.subarray(i * bytesPerPoly, (i+1) * bytesPerPoly), d)
  );
}

function generateMatrix(rho, transpose = false) {
  const A = [];
  for (let i = 0; i < K; i++) {
    A.push([]);
    for (let j = 0; j < K; j++) {
      // DÜZELTME 2: FIPS 203 Matris Transpoze Kuralı
      A[i].push(transpose ? sampleNTT(rho, i, j) : sampleNTT(rho, j, i));
    }
  }
  return A;
}

function _kPkeKeyGen(d) {
  // DÜZELTME 3: Domain Separation (d || k) eklendi
  const expanded = sha3_512(Buffer.concat([d, Buffer.from([K])]));
  const rho = expanded.subarray(0, 32);
  const sigma = expanded.subarray(32);

  const A = generateMatrix(rho, false);

  const s = [];
  const e = [];
  for (let i = 0; i < K; i++) {
    const nBuf = Buffer.concat([sigma, Buffer.from([i])]);
    s.push(ntt(sampleCBD(ETA1, nBuf)));
  }
  for (let i = 0; i < K; i++) {
    const nBuf = Buffer.concat([sigma, Buffer.from([K + i])]);
    e.push(ntt(sampleCBD(ETA1, nBuf)));
  }

  const t = polyVecAdd(matMulVec(A, s), e);

  const ekPoly = encodeVec(t, 12);
  const ek = Buffer.concat([ekPoly, rho]);
  const dk = encodeVec(s, 12);

  return { ek, dk };
}

function _kPkeEncrypt(ek, m, r) {
  const tBytes = ek.subarray(0, K * 12 * N / 8);
  const rho = ek.subarray(K * 12 * N / 8);

  const tNtt = decodeVec(tBytes, 12); 
  const AT = generateMatrix(rho, true);

  const rv = [];
  const e1 = [];
  for (let i = 0; i < K; i++) {
    rv.push(sampleCBD(ETA1, Buffer.concat([r, Buffer.from([i])])));
    e1.push(sampleCBD(ETA2, Buffer.concat([r, Buffer.from([K + i])])));
  }
  const e2 = sampleCBD(ETA2, Buffer.concat([r, Buffer.from([2 * K])]));

  const rNtt = rv.map(p => ntt(p));

  const u = polyVecAdd(matMulVec(AT, rNtt).map(p => nttInv(p)), e1);
  const tDotR = nttInv(vecDot(tNtt, rNtt));
  const mPoly = decompress(byteDecode(m, 1), 1);
  const v = polyAdd(polyAdd(tDotR, e2), mPoly);

  const c1 = encodeVec(u.map(p => compress(p, DU)), DU);
  const c2 = byteEncode(compress(v, DV), DV);

  return Buffer.concat([c1, c2]);
}

function _kPkeDecrypt(dk, c) {
  const bytesPerPoly12 = Math.ceil(N * 12 / 8);
  const bytesPerPolyDU = Math.ceil(N * DU / 8);
  const bytesPerPolyDV = Math.ceil(N * DV / 8);

  const c1 = c.subarray(0, K * bytesPerPolyDU);
  const c2 = c.subarray(K * bytesPerPolyDU);

  const u = decodeVec(c1, DU).map(p => decompress(p, DU));
  const v = decompress(byteDecode(c2, DV), DV);

  const sNtt = decodeVec(dk, 12);

  const uNtt = u.map(p => ntt(p));
  const sDotU = nttInv(vecDot(sNtt, uNtt));
  const mPoly = polySub(v, sDotU);

  return byteEncode(compress(mPoly, 1), 1);
}

const MLKEM768 = {
  EK_BYTES: 1184,
  DK_BYTES: 2400,
  CT_BYTES: 1088,
  SS_BYTES: 32,
};

function mlkem768GenerateKeyPair(z, d) {
  z = z || randomBytes(32);
  d = d || randomBytes(32);
  const { ek, dk: dkPke } = _kPkeKeyGen(d);
  const ekHash = sha3_256(ek);
  const dk = Buffer.concat([dkPke, ek, ekHash, z]);
  return { ek, dk };
}

function mlkemEncapsulate(ek, m) {
  if (ek.length !== MLKEM768.EK_BYTES)
    throw new Error(`ML-KEM: ek boyutu ${MLKEM768.EK_BYTES} bayt olmalı`);

  m = m || randomBytes(32);
  const ekHash = sha3_256(ek);
  const combined = sha3_512(Buffer.concat([m, ekHash]));
  const K_shared = combined.subarray(0, 32); 
  const r = combined.subarray(32);

  const ct = _kPkeEncrypt(ek, m, r);

  // DÜZELTME 4: FIPS 203 KDF (shake256) iptal edildi.
  const ss = K_shared;

  return { ct, ss };
}

function mlkemDecapsulate(dk, ct) {
  if (dk.length !== MLKEM768.DK_BYTES)
    throw new Error(`ML-KEM: dk boyutu ${MLKEM768.DK_BYTES} bayt olmalı`);
  if (ct.length !== MLKEM768.CT_BYTES)
    throw new Error(`ML-KEM: ct boyutu ${MLKEM768.CT_BYTES} bayt olmalı`);

  const bytesPerPoly12 = Math.ceil(N * 12 / 8);
  const dkPke = dk.subarray(0, K * bytesPerPoly12);
  const ek    = dk.subarray(K * bytesPerPoly12, K * bytesPerPoly12 + MLKEM768.EK_BYTES);
  const h     = dk.subarray(K * bytesPerPoly12 + MLKEM768.EK_BYTES, K * bytesPerPoly12 + MLKEM768.EK_BYTES + 32);
  const z     = dk.subarray(K * bytesPerPoly12 + MLKEM768.EK_BYTES + 32);

  const mPrime = _kPkeDecrypt(dkPke, ct);

  const combined = sha3_512(Buffer.concat([mPrime, h]));
  const K_prime = combined.subarray(0, 32);
  const rPrime  = combined.subarray(32);

  const ctPrime = _kPkeEncrypt(ek, mPrime, rPrime);

  let diff = 0;
  for (let i = 0; i < ct.length; i++) diff |= ct[i] ^ ctPrime[i];
  const match = (diff === 0);

  // DÜZELTME 5: FIPS 203 Implicit rejection için J(z || c)
  const K_bar = shake256(Buffer.concat([z, ct]), 32);
  const ss = match ? K_prime : K_bar;

  return ss;
}

module.exports = {
  mlkem768GenerateKeyPair, mlkemEncapsulate, mlkemDecapsulate, MLKEM768,
  sha3_256, sha3_512, shake128, shake256, keccakF1600,
  ntt, nttInv, baseMul, polyAdd, polySub, compress, decompress,
  byteEncode, byteDecode, sampleCBD, sampleNTT,
  _kPkeKeyGen, _kPkeEncrypt, _kPkeDecrypt,
};