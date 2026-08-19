// 'use strict';
// /**
//  * Pseudo-random byte generator — xorshift128+ algoritması.
//  * UYARI: Kriptografik açıdan güçlü bir CSPRNG değildir.
//  * Node.js crypto modülü kullanmadan en iyi seçenek budur;
//  * üretim ortamı için platform CSPRNG ile değiştirin.
//  */

// const M64 = 0xffffffffffffffffn;

// // Çok kaynaktan entropi toplama
// let s0 = BigInt(Date.now()) ^ 0x9e3779b97f4a7c15n;
// let s1 = BigInt(Math.floor(Math.random() * 0xffffffff)) | 1n;
// for (let i = 0; i < 64; i++) {
//   s0 ^= BigInt(Math.floor(Math.random() * 0xffffffff)) << BigInt(i % 48);
//   s1 ^= BigInt(Math.floor(Math.random() * 0xffffffff)) << BigInt((i * 3 + 7) % 48);
//   // Karıştır
//   let x = s0 ^ (s0 << 23n);
//   s0 = s1;
//   s1 = (x ^ s1 ^ (x >> 17n) ^ (s1 >> 26n)) & M64;
// }

// function _next() {
//   let x = s0;
//   const y = s1;
//   s0 = y;
//   x ^= (x << 23n) & M64;
//   s1 = (x ^ y ^ (x >> 17n) ^ (y >> 26n)) & M64;
//   return (s1 + y) & M64;
// }

// /**
//  * n bayt rastgele veri üretir → Buffer döner.
//  */
// function randomBytes(n) {
//   const buf = Buffer.alloc(n);
//   let i = 0;
//   while (i < n) {
//     let r = _next();
//     for (let j = 0; j < 8 && i < n; j++, i++) {
//       buf[i] = Number(r & 0xffn);
//       r >>= 8n;
//     }
//   }
//   return buf;
// }

// /**
//  * [min, max) aralığında büyük tam sayı üretir.
//  */
// function randomBigIntRange(min, max) {
//   const range = max - min;
//   const bits = range.toString(2).length;
//   const bytes = Math.ceil(bits / 8);
//   while (true) {
//     const raw = randomBytes(bytes);
//     let v = 0n;
//     for (const b of raw) v = (v << 8n) | BigInt(b);
//     // Yalnızca gerekli bit sayısını kullan
//     v &= (1n << BigInt(bits)) - 1n;
//     if (v < range) return min + v;
//   }
// }

// module.exports = { randomBytes, randomBigIntRange };
'use strict';

/**
 * Node.js 'crypto' modülü kullanarak işletim sistemi seviyesinde
 * kriptografik olarak güvenli rastgele bayt üretimi.
 */
const crypto = require('node:crypto');

/**
 * n bayt güvenli rastgele veri üretir.
 */
function randomBytes(n) {
  // crypto.randomBytes doğrudan /dev/urandom veya Windows'taki CryptGenRandom'ı kullanır.
  return crypto.randomBytes(n);
}

/**
 * [min, max) aralığında güvenli büyük tam sayı üretir.
 * Bu yapı, 'modulo bias' (modüler sapma) hatasını engellemek için tasarlanmıştır.
 */
function randomBigIntRange(min, max) {
  const range = max - min;
  if (range <= 0n) return min;
  
  const bits = range.toString(2).length;
  const bytes = Math.ceil(bits / 8);
  
  while (true) {
    const raw = crypto.randomBytes(bytes);
    let v = 0n;
    for (const b of raw) v = (v << 8n) | BigInt(b);
    
    // Maskeleme
    v &= (1n << BigInt(bits)) - 1n;
    
    // Range kontrolü (Sapmayı önlemek için rejection sampling)
    if (v < range) return min + v;
  }
}

module.exports = { randomBytes, randomBigIntRange };