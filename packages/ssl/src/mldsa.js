'use strict';
/**
 * ML-DSA-65 (CRYSTALS-Dilithium) — FIPS 204 saf JavaScript uygulaması
 *
 * Parametre seti (Level 3 / Dilithium3):
 *   q=8380417, n=256, k=6, l=5, η=4, γ1=2^19, γ2=(q-1)/32
 *   τ=49, β=196, ω=55
 *
 * Referans: NIST FIPS 204 (2024) ve Dilithium spesifikasyonu v3.1
 *
 * NOT: Bu uygulama sertifika imzalama ve TLS handshake imzaları için
 * tasarlanmıştır. Yüksek bit sayılı BigInt işlemleri NTT ile optimize edilmiştir.
 */

const { shake128, shake256, sha3_256, sha3_512 } = require('./mlkem');
const { randomBytes } = require('./random');

// ─────────────────────────────────────────────────────────────────────────────
// ML-DSA-65 Parametreleri
// ─────────────────────────────────────────────────────────────────────────────
const Q     = 8380417;        // 2^23 - 2^13 + 1
const N     = 256;
const K     = 6;              // çıkış vektör boyutu
const L     = 5;              // giriş vektör boyutu
const ETA   = 4;
const TAU   = 49;             // imzada sıfır olmayan katsayı sayısı
const BETA  = 196;            // τ · η
const GAMMA1 = 1 << 19;      // 2^19
const GAMMA2 = (Q - 1) / 32; // (q-1)/32 = 261888
const OMEGA = 55;             // ipucu polinom maksimum +1 sayısı
const LAMBDA = 48;            // taahhüt hash boyutu (bayt)

// Boyutlar (bayt)
const MLDSA65 = {
  PK_BYTES: 1952,   // Genel anahtar
  SK_BYTES: 4032,   // Özel anahtar
  SIG_BYTES: 3309,  // İmza
};

// ─────────────────────────────────────────────────────────────────────────────
// NTT — Dilithium q=8380417, ζ=1753
// ─────────────────────────────────────────────────────────────────────────────
const DZETA = 1753;

function _bitrev8(n) {
  let r = 0;
  for (let i = 0; i < 8; i++) { r = (r << 1) | (n & 1); n >>= 1; }
  return r;
}

// Dilithium NTT zeta tablosu (128 eleman, bitrev8 ile)
const DZETAS = new Int32Array(256);
(function buildDZetas() {
  for (let i = 0; i < 256; i++) {
    const exp = _bitrev8(i) >> 1; // 7-bit reverse (n=256, stride 128)
    let z = 1;
    for (let j = 0; j < exp; j++) z = z * DZETA % Q;
    DZETAS[i] = z;
  }
})();

function _modDQ(v) {
  v = ((v % Q) + Q) % Q;
  return v;
}

/** Dilithium NTT */
function dntt(f) {
  const a = Int32Array.from(f);
  let k = 0, len = 128;
  while (len >= 1) {
    for (let start = 0; start < N; start += 2 * len) {
      k++;
      const z = DZETAS[k];
      for (let j = start; j < start + len; j++) {
        const t = Number(BigInt(z) * BigInt(a[j+len]) % BigInt(Q));
        a[j+len] = _modDQ(a[j] - t);
        a[j]     = _modDQ(a[j] + t);
      }
    }
    len >>= 1;
  }
  return a;
}

/** Dilithium Ters NTT */
function dnttInv(f) {
  const a = Int32Array.from(f);
  let k = N - 1, len = 1;
  while (len < N) {
    for (let start = 0; start < N; start += 2 * len) {
      const z = -DZETAS[k--];
      for (let j = start; j < start + len; j++) {
        const t = a[j];
        a[j]     = _modDQ(t + a[j+len]);
        a[j+len] = _modDQ(Number(BigInt(z) * BigInt(_modDQ(a[j+len] - t)) % BigInt(Q)));
      }
    }
    len <<= 1;
  }
  // f^{-1} = 8347681^{-1} mod q = 8347681 (256^{-1} mod 8380417)
  const F = 8347681;
  for (let i = 0; i < N; i++) a[i] = _modDQ(Number(BigInt(a[i]) * BigInt(F) % BigInt(Q)));
  return a;
}

function dbaseMul(f, g) {
  const h = new Int32Array(N);
  // Dilithium: pair-wise multiplication, no twist needed for baseMul
  // Basit nokta-nokta çarpım (NTT sonrası)
  for (let i = 0; i < N; i++)
    h[i] = _modDQ(Number(BigInt(f[i]) * BigInt(g[i]) % BigInt(Q)));
  return h;
}

// Vektör işlemleri
function dpolyAdd(a, b) {
  const c = new Int32Array(N);
  for (let i = 0; i < N; i++) c[i] = _modDQ(a[i] + b[i]);
  return c;
}
function dpolySub(a, b) {
  const c = new Int32Array(N);
  for (let i = 0; i < N; i++) c[i] = _modDQ(a[i] - b[i]);
  return c;
}
function dvecAdd(a, b) { return a.map((p, i) => dpolyAdd(p, b[i])); }

/** Matris-vektör çarpımı (NTT alanında) */
function dmatMulVec(A, v) {
  return A.map(row =>
    row.reduce((acc, aij, j) => dpolyAdd(acc, dbaseMul(aij, v[j])), new Int32Array(N))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bit işlemleri ve kodlama
// ─────────────────────────────────────────────────────────────────────────────

/** Merkez katsayı indirgemesi: mod q → [-q/2, q/2] */
function centerMod(v) {
  v = _modDQ(v);
  if (v > Q / 2) v -= Q;
  return v;
}

/** Yüksek/Düşük bitler (FIPS 204 §6.1) */
function highBits(r, alpha) {
  const r1 = Math.floor(centerMod(r) / alpha);
  return ((r1 % (Q - 1) / alpha) + Math.ceil((Q - 1) / alpha)) % Math.ceil((Q - 1) / alpha);
}

function lowBits(r, alpha) {
  const r0 = centerMod(r) - highBits(r, alpha) * alpha;
  return r0;
}

function decomposePoly(a, alpha) {
  const a1 = new Int32Array(N);
  const a0 = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const v = _modDQ(a[i]);
    let r1 = Math.round(v / alpha);
    let r0 = v - r1 * alpha;
    // Sınır düzeltmesi
    if (r0 > alpha / 2) { r0 -= alpha; r1++; }
    if (r0 < -alpha / 2) { r0 += alpha; r1--; }
    a1[i] = r1;
    a0[i] = r0;
  }
  return { a1, a0 };
}

/** Sonsuz norm: max(|katsayı|) */
function infNorm(poly) {
  let max = 0;
  for (let i = 0; i < N; i++) {
    const v = Math.abs(centerMod(poly[i]));
    if (v > max) max = v;
  }
  return max;
}

function vecInfNorm(vec) { return Math.max(...vec.map(p => infNorm(p))); }

// ─────────────────────────────────────────────────────────────────────────────
// Örnekleme
// ─────────────────────────────────────────────────────────────────────────────

/** ExpandA — SHAKE-128 ile A matrisi üretimi */
function expandA(rho) {
  const A = [];
  for (let i = 0; i < K; i++) {
    A.push([]);
    for (let j = 0; j < L; j++) {
      const seed = Buffer.concat([rho, Buffer.from([j, i])]);
      const stream = shake128(seed, 840);
      const poly = new Int32Array(N);
      let pos = 0, cnt = 0;
      while (cnt < N) {
        const b0 = stream[pos], b1 = stream[pos+1], b2 = stream[pos+2];
        pos += 3;
        const coef = b0 | (b1 << 8) | ((b2 & 0x7f) << 16);
        if (coef < Q) poly[cnt++] = coef;
      }
      A[i].push(poly);
    }
  }
  return A;
}

/** ExpandS — CBD ile s1, s2 üretimi */
function expandS(rhoPrime) {
  function sampleEta(seed) {
    const stream = shake256(seed, 136);
    const poly = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      const byteIdx = Math.floor(i * 3 / 4);
      let t;
      if (i % 4 === 0) t = stream[byteIdx] & 0x0f;
      else if (i % 4 === 1) t = stream[byteIdx] >> 4;
      else if (i % 4 === 2) t = stream[byteIdx] & 0x0f;
      else t = stream[byteIdx] >> 4;
      // ETA=4: 0..8 → [-4, 4]
      poly[i] = _modDQ(ETA - (t % (2 * ETA + 1)));
    }
    return poly;
  }

  const s1 = [], s2 = [];
  for (let i = 0; i < L; i++)
    s1.push(sampleEta(Buffer.concat([rhoPrime, Buffer.from([i])])));
  for (let i = 0; i < K; i++)
    s2.push(sampleEta(Buffer.concat([rhoPrime, Buffer.from([L + i])])));
  return { s1, s2 };
}

/** ExpandMask — γ1 sınırında y vektörü örneklemesi */
function expandMask(rhoPrime, kappa) {
  const y = [];
  for (let i = 0; i < L; i++) {
    const seed = Buffer.concat([rhoPrime, Buffer.from([kappa & 0xff, (kappa >> 8) & 0xff, i])]);
    const stream = shake256(seed, 640);
    const poly = new Int32Array(N);
    // 20-bit katsayı: GAMMA1 = 2^19
    for (let j = 0; j < N; j++) {
      const b = j * 20 / 8;
      const bi = Math.floor(b);
      const bitOff = Math.round((b - bi) * 8);
      let v = stream[bi] | (stream[bi+1] << 8) | (stream[bi+2] << 16);
      v = (v >> bitOff) & 0xfffff;
      poly[j] = _modDQ(GAMMA1 - v + Q);
    }
    y.push(poly);
  }
  return y;
}

// ─────────────────────────────────────────────────────────────────────────────
// Taahhüt (Commitment) fonksiyonları
// ─────────────────────────────────────────────────────────────────────────────

/** w1 kodlama — GAMMA2 için */
function encodeW1(w1vec) {
  // Her katsayı 6 bit (0..43)
  const bytesPerPoly = Math.ceil(N * 6 / 8);
  const out = Buffer.alloc(K * bytesPerPoly);
  for (let pi = 0; pi < K; pi++) {
    let bitOff = pi * bytesPerPoly * 8;
    for (let i = 0; i < N; i++) {
      const v = w1vec[pi][i] & 0x3f;
      for (let b = 0; b < 6; b++) {
        const byteIdx = Math.floor(bitOff / 8);
        const bit = bitOff % 8;
        out[byteIdx] |= ((v >> b) & 1) << bit;
        bitOff++;
      }
    }
  }
  return out;
}

/** Challenge polinom üretimi (FIPS 204 §6.3 SampleInBall) */
function sampleInBall(seed) {
  const stream = shake256(seed, 136);
  const c = new Int32Array(N);
  // Son 8 bayt: bit işareti için
  let signs = 0n;
  for (let i = 0; i < 8; i++) signs |= BigInt(stream[i]) << BigInt(8 * i);

  let pos = 8;
  for (let i = N - TAU; i < N; i++) {
    let j;
    do { j = stream[pos++]; } while (j > i);
    c[i] = c[j];
    c[j] = (signs & 1n) ? Q - 1 : 1;
    signs >>= 1n;
  }
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kodlama / Çözümleme
// ─────────────────────────────────────────────────────────────────────────────

/** t1 kodlama (10-bit katsayı) */
function encodeT1(vec) {
  const bytesPerPoly = Math.ceil(N * 10 / 8);
  const out = Buffer.alloc(K * bytesPerPoly);
  for (let pi = 0; pi < K; pi++) {
    let bitOff = pi * bytesPerPoly * 8;
    for (let i = 0; i < N; i++) {
      const v = vec[pi][i] & 0x3ff;
      for (let b = 0; b < 10; b++) {
        const byteIdx = Math.floor(bitOff / 8);
        const bit = bitOff % 8;
        out[byteIdx] |= ((v >> b) & 1) << bit;
        bitOff++;
      }
    }
  }
  return out;
}

function decodeT1(buf) {
  const bytesPerPoly = Math.ceil(N * 10 / 8);
  const vec = [];
  for (let pi = 0; pi < K; pi++) {
    const poly = new Int32Array(N);
    let bitOff = pi * bytesPerPoly * 8;
    for (let i = 0; i < N; i++) {
      let v = 0;
      for (let b = 0; b < 10; b++) {
        const byteIdx = Math.floor(bitOff / 8);
        const bit = bitOff % 8;
        v |= ((buf[byteIdx] >> bit) & 1) << b;
        bitOff++;
      }
      poly[i] = v;
    }
    vec.push(poly);
  }
  return vec;
}

/** t0 kodlama (13-bit merkez katsayı) */
function encodeT0(vec) {
  const bytesPerPoly = Math.ceil(N * 13 / 8);
  const out = Buffer.alloc(K * bytesPerPoly);
  for (let pi = 0; pi < K; pi++) {
    let bitOff = pi * bytesPerPoly * 8;
    for (let i = 0; i < N; i++) {
      const v = (_modDQ((1 << 12) - vec[pi][i])) & 0x1fff;
      for (let b = 0; b < 13; b++) {
        const byteIdx = Math.floor(bitOff / 8);
        const bit = bitOff % 8;
        out[byteIdx] |= ((v >> b) & 1) << bit;
        bitOff++;
      }
    }
  }
  return out;
}

function decodeT0(buf) {
  const bytesPerPoly = Math.ceil(N * 13 / 8);
  const vec = [];
  for (let pi = 0; pi < K; pi++) {
    const poly = new Int32Array(N);
    let bitOff = pi * bytesPerPoly * 8;
    for (let i = 0; i < N; i++) {
      let v = 0;
      for (let b = 0; b < 13; b++) {
        const byteIdx = Math.floor(bitOff / 8);
        const bit = bitOff % 8;
        v |= ((buf[byteIdx] >> bit) & 1) << b;
        bitOff++;
      }
      poly[i] = _modDQ((1 << 12) - v);
    }
    vec.push(poly);
  }
  return vec;
}

/** s (ETA=4, 4-bit) kodlama */
function encodeS(vec, size) {
  const bytesPerPoly = N / 2; // 4-bit/katsayı
  const out = Buffer.alloc(size * bytesPerPoly);
  for (let pi = 0; pi < size; pi++) {
    for (let i = 0; i < N; i += 2) {
      const a = ETA - centerMod(vec[pi][i]);
      const b = ETA - centerMod(vec[pi][i+1]);
      out[pi * bytesPerPoly + i/2] = (a & 0x0f) | ((b & 0x0f) << 4);
    }
  }
  return out;
}

function decodeS(buf, size) {
  const bytesPerPoly = N / 2;
  const vec = [];
  for (let pi = 0; pi < size; pi++) {
    const poly = new Int32Array(N);
    for (let i = 0; i < N; i += 2) {
      const byte = buf[pi * bytesPerPoly + i/2];
      poly[i]   = _modDQ(ETA - (byte & 0x0f));
      poly[i+1] = _modDQ(ETA - (byte >> 4));
    }
    vec.push(poly);
  }
  return vec;
}

/** z (GAMMA1 - β, 20-bit) kodlama */
function encodeZ(vec) {
  const bytesPerPoly = Math.ceil(N * 20 / 8);
  const out = Buffer.alloc(L * bytesPerPoly);
  for (let pi = 0; pi < L; pi++) {
    let bitOff = pi * bytesPerPoly * 8;
    for (let i = 0; i < N; i++) {
      const v = (_modDQ(GAMMA1 - centerMod(vec[pi][i]))) & 0xfffff;
      for (let b = 0; b < 20; b++) {
        const byteIdx = Math.floor(bitOff / 8);
        const bit = bitOff % 8;
        out[byteIdx] |= ((v >> b) & 1) << bit;
        bitOff++;
      }
    }
  }
  return out;
}

function decodeZ(buf) {
  const bytesPerPoly = Math.ceil(N * 20 / 8);
  const vec = [];
  for (let pi = 0; pi < L; pi++) {
    const poly = new Int32Array(N);
    let bitOff = pi * bytesPerPoly * 8;
    for (let i = 0; i < N; i++) {
      let v = 0;
      for (let b = 0; b < 20; b++) {
        const byteIdx = Math.floor(bitOff / 8);
        const bit = bitOff % 8;
        v |= ((buf[byteIdx] >> bit) & 1) << b;
        bitOff++;
      }
      poly[i] = _modDQ(GAMMA1 - v);
    }
    vec.push(poly);
  }
  return vec;
}

/** İpucu (hint) kodlama — seyrek format */
function encodeHint(h) {
  const out = Buffer.alloc(OMEGA + K);
  let idx = 0;
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < N; j++) {
      if (h[i][j] !== 0) out[idx++] = j;
    }
    out[OMEGA + i] = idx;
  }
  return out;
}

function decodeHint(buf) {
  const h = Array.from({ length: K }, () => new Int32Array(N));
  let idx = 0;
  for (let i = 0; i < K; i++) {
    const end = buf[OMEGA + i];
    while (idx < end) {
      h[i][buf[idx]] = 1;
      idx++;
    }
  }
  return h;
}

// ─────────────────────────────────────────────────────────────────────────────
// İpucu (Hint) hesabı (MakeHint / UseHint)
// ─────────────────────────────────────────────────────────────────────────────
function makeHint(z, r, alpha) {
  const h = new Int32Array(N);
  
  // r için yüksek bitleri (HighBits) çıkar
  const { a1: r1 } = decomposePoly(r, alpha);
  
  // r + z hesapla ve yüksek bitlerini çıkar
  const rz = new Int32Array(N);
  for (let i = 0; i < N; i++) rz[i] = _modDQ(r[i] + z[i]);
  const { a1: rz1 } = decomposePoly(rz, alpha);
  
  // Eğer yüksek bitler eşleşmiyorsa ipucu (hint) işaretle
  for (let i = 0; i < N; i++) {
    h[i] = (r1[i] !== rz1[i]) ? 1 : 0;
  }
  return h;
}

function useHint(h, r, alpha) {
  const out = new Int32Array(N);
  const m = Math.ceil((Q-1)/alpha);
  for (let i = 0; i < N; i++) {
    const { a1, a0 } = decomposePoly(new Int32Array([r[i]]), alpha);
    const r1 = a1[0];
    const r0 = a0[0];
    if (h[i] === 1) {
      out[i] = r0 > 0 ? (r1 + 1) % m : ((r1 - 1) % m + m) % m;
    } else {
      out[i] = r1;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// ML-DSA-65 Ana API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ML-DSA-65 Anahtar Üretimi (FIPS 204 Algorithm 1)
 * @param {Buffer} [xi]  İsteğe bağlı 32-bayt entropi (test için)
 * @returns {{ pk: Buffer(1952), sk: Buffer(4032) }}
 */
function mldsaKeyGen(xi) {
  xi = xi || randomBytes(32);

  const expanded = sha3_512(xi);
  const rho     = expanded.subarray(0, 32);   // matris tohumu
  const rhoPrime = expanded.subarray(32, 64);  // gürültü tohumu (aslında 64 bayt olur)
  const K_seed  = expanded.subarray(32, 64);

  // rhoPrime için shake256 genişletmesi
  const rhoPrimeFull = shake256(xi, 64).subarray(32, 96);

  const A = expandA(rho);
  const { s1, s2 } = expandS(rhoPrimeFull);

  // NTT dönüşümü
  const s1Ntt = s1.map(p => dntt(p));

  // t = A·s1 + s2
  const As1 = dmatMulVec(A, s1Ntt).map(p => dnttInv(p));
  const t    = dvecAdd(As1, s2);

  // t'yi yüksek/düşük bitlere ayır (2^d = 4096 sınırı, d=13)
  const d = 13;
  const t1 = t.map(p => {
    const h = new Int32Array(N);
    for (let i = 0; i < N; i++) h[i] = Math.round(_modDQ(p[i]) / (1 << d));
    return h;
  });
  const t0 = t.map((p, pi) => {
    const lo = new Int32Array(N);
    for (let i = 0; i < N; i++) lo[i] = _modDQ(p[i] - t1[pi][i] * (1 << d));
    return lo;
  });

  // Genel anahtar: rho || Encode(t1)
  const t1Enc = encodeT1(t1);
  const pk = Buffer.concat([rho, t1Enc]);

  // Özel anahtar: rho || K || tr || Encode(s1) || Encode(s2) || Encode(t0)
  const tr = sha3_256(pk); // genel anahtar hash'i
  const s1Enc = encodeS(s1, L);
  const s2Enc = encodeS(s2, K);
  const t0Enc = encodeT0(t0);
  const sk = Buffer.concat([rho, K_seed, tr, s1Enc, s2Enc, t0Enc]);

  return { pk, sk };
}

/**
 * ML-DSA-65 İmzalama (FIPS 204 Algorithm 2 — deterministik mod)
 * @param {Buffer} sk    Özel anahtar (4032 bayt)
 * @param {Buffer} msg   İmzalanacak mesaj
 * @param {Buffer} [mu]  İsteğe bağlı 64-bayt entropi (test için)
 * @returns {Buffer} İmza (3309 bayt)
 */
function mldsaSign(sk, msg, mu) {
  // Özel anahtarı çöz
  const rho     = sk.subarray(0, 32);
  const K_seed  = sk.subarray(32, 64);
  const tr      = sk.subarray(64, 96);
  const s1Enc   = sk.subarray(96, 96 + L * N/2);
  const s2Enc   = sk.subarray(96 + L * N/2, 96 + (L+K) * N/2);
  const t0Enc   = sk.subarray(96 + (L+K) * N/2);

  const s1 = decodeS(s1Enc, L);
  const s2 = decodeS(s2Enc, K);
  const t0 = decodeT0(t0Enc);

  // Mesaj temsili: μ = H(tr || msg)
  const muHash = shake256(Buffer.concat([tr, msg]), 64);

  // Rastgelelik (deterministik)
  const rhoPrime = mu || shake256(Buffer.concat([K_seed, muHash]), 64);

  // A matrisi ve NTT
  const A    = expandA(rho);
  const s1Ntt = s1.map(p => dntt(p));
  const s2Ntt = s2.map(p => dntt(p));
  const t0Ntt = t0.map(p => dntt(p));

  const alpha = 2 * GAMMA2;
  let kappa = 0;

  while (true) {
    // y örnekle
    const y = expandMask(rhoPrime, kappa);
    kappa++;

    // NTT'ye taşı, w = A·y hesapla
    const yNtt = y.map(p => dntt(p));
    const w    = dmatMulVec(A, yNtt).map(p => dnttInv(p));

    // w1 = HighBits(w)
    const w1 = w.map(p => {
      const h = new Int32Array(N);
      const { a1 } = decomposePoly(p, alpha);
      for (let i = 0; i < N; i++) h[i] = a1[i];
      return h;
    });

    // c~  = H(μ || Encode(w1))
    const w1Enc = encodeW1(w1);
    const ctTilde = shake256(Buffer.concat([muHash, w1Enc]), LAMBDA);

    // c = SampleInBall(c~)
    const c    = sampleInBall(ctTilde);
    const cNtt = dntt(c);

    // z = y + c·s1
    const cs1 = s1Ntt.map(si => dnttInv(dbaseMul(cNtt, si)));
    const z = y.map((yi, i) => dpolyAdd(yi, cs1[i]));

    // İpucu: h = MakeHint(-c·s2 + w - c·t0, w1)
    // İpucu: h = MakeHint(-c·s2 + w - c·t0, w1)
    const cs2 = s2Ntt.map(si => dnttInv(dbaseMul(cNtt, si)));
    const ct0 = t0Ntt.map(ti => dnttInv(dbaseMul(cNtt, ti)));
    const wMinusCs2 = w.map((wi, i) => {
      const r = new Int32Array(N);
      for (let j = 0; j < N; j++) r[j] = _modDQ(wi[j] - cs2[i][j]);
      return r;
    });

    // 1. DÜZELTME: wMinusCs2 polinomundan Düşük Bitleri (LowBits) ayıklıyoruz
    const r0 = wMinusCs2.map(p => {
      const { a0 } = decomposePoly(p, alpha);
      return a0;
    });

    // 2. DÜZELTME: Norm kontrolünü wMinusCs2'nin tamamıyla değil, r0 (LowBits) ile yapıyoruz
    if (vecInfNorm(z) >= GAMMA1 - BETA) continue;
    if (vecInfNorm(r0) >= GAMMA2 - BETA) continue;

    // İpucu hesabı
    const h = wMinusCs2.map((wi, i) => makeHint(ct0[i], wi, alpha));
    const hintCount = h.reduce((s, hi) => s + hi.reduce((a, v) => a + v, 0), 0);
    if (hintCount > OMEGA) continue;
    if (vecInfNorm(ct0) >= GAMMA2) continue;

    // İmza = c~ || Encode(z) || EncodeHint(h)
    const zEnc = encodeZ(z);
    const hEnc = encodeHint(h);
    const sig = Buffer.concat([ctTilde, zEnc, hEnc]);

    if (sig.length !== MLDSA65.SIG_BYTES) {
      // Boyut uyuşmazlığı, döngüye devam
      continue;
    }

    return sig;
  }
}

/**
 * ML-DSA-65 İmza Doğrulama (FIPS 204 Algorithm 3)
 * @param {Buffer} pk    Genel anahtar (1952 bayt)
 * @param {Buffer} msg   Mesaj
 * @param {Buffer} sig   İmza (3309 bayt)
 * @returns {boolean}
 */
function mldsaVerify(pk, msg, sig) {
  if (pk.length !== MLDSA65.PK_BYTES || sig.length !== MLDSA65.SIG_BYTES)
    return false;

  const rho   = pk.subarray(0, 32);
  const t1Enc = pk.subarray(32);
  const t1    = decodeT1(t1Enc);

  const ctTilde = sig.subarray(0, LAMBDA);
  const zEnc    = sig.subarray(LAMBDA, LAMBDA + L * Math.ceil(N * 20 / 8));
  const hEnc    = sig.subarray(LAMBDA + L * Math.ceil(N * 20 / 8));

  const z = decodeZ(zEnc);
  const h = decodeHint(hEnc);

  // Norm kontrolü
  if (vecInfNorm(z) >= GAMMA1 - BETA) return false;

  // tr = H(pk)
  const tr = sha3_256(pk);
  const muHash = shake256(Buffer.concat([tr, msg]), 64);

  // c = SampleInBall(c~)
  const c = sampleInBall(ctTilde);

  // A ve NTT
  const A    = expandA(rho);
  const cNtt = dntt(c);
  const zNtt = z.map(p => dntt(p));

  // w'= A·z - c·t1·2^d
  const d = 13;
  const t1Ntt = t1.map(p => {
    const shifted = new Int32Array(N);
    for (let i = 0; i < N; i++) shifted[i] = _modDQ(p[i] * (1 << d));
    return dntt(shifted);
  });

  const Az   = dmatMulVec(A, zNtt).map(p => dnttInv(p));
  const ct1  = t1Ntt.map(ti => dnttInv(dbaseMul(cNtt, ti)));
  const wPrime = Az.map((azi, i) => {
    const r = new Int32Array(N);
    for (let j = 0; j < N; j++) r[j] = _modDQ(azi[j] - ct1[i][j]);
    return r;
  });

  // UseHint ile w1' hesapla
  const alpha = 2 * GAMMA2;
  const w1Prime = wPrime.map((wp, i) => useHint(h[i], wp, alpha));

  // c~' = H(μ || Encode(w1'))
  const w1PrimeEnc = encodeW1(w1Prime);
  const ctTildePrime = shake256(Buffer.concat([muHash, w1PrimeEnc]), LAMBDA);

  // Karşılaştır
  let diff = 0;
  for (let i = 0; i < LAMBDA; i++) diff |= ctTilde[i] ^ ctTildePrime[i];
  return diff === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// İhracat
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  mldsaKeyGen,
  mldsaSign,
  mldsaVerify,
  MLDSA65,
  // Dahili test yardımcıları
  dntt, dnttInv, dbaseMul, expandA, sampleInBall,
};