'use strict';
/**
 * Büyük tam sayı kriptografi: modüler aritmetik, asal sayı üretimi.
 * RSA ve EC modülleri için ortak temel.
 */
const { randomBytes, randomBigIntRange } = require('./random');

function modPow(base, exp, mod) {
  if (mod === 1n) return 0n;
  let r = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) r = r * base % mod;
    exp >>= 1n;
    base = base * base % mod;
  }
  return r;
}

function modInverse(a, m) {
  if (m === 1n) return 0n;
  let [m0, x0, x1] = [m, 0n, 1n];
  while (a > 1n) {
    const q = a / m;
    [a, m] = [m, a % m];
    [x0, x1] = [x1 - q * x0, x0];
  }
  return x1 < 0n ? x1 + m0 : x1;
}

// Küçük asal ön eleme tablosu
const SMALL_PRIMES = [
  2n,3n,5n,7n,11n,13n,17n,19n,23n,29n,31n,37n,41n,43n,47n,53n,
  59n,61n,67n,71n,73n,79n,83n,89n,97n,101n,103n,107n,109n,113n,
  127n,131n,137n,139n,149n,151n,157n,163n,167n,173n,179n,181n,191n,
  193n,197n,199n,211n,223n,227n,229n,233n,239n,241n,251n,
];

// Belirleyici Miller-Rabin tanıkları (64-bit'e kadar kesin)
const MR_WITNESSES = [2n,3n,5n,7n,11n,13n,17n,19n,23n,29n,31n,37n];

function isProbablePrime(n, rounds = 20) {
  if (n < 2n) return false;
  for (const p of SMALL_PRIMES) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }
  // Miller-Rabin
  let d = n - 1n, s = 0n;
  while (!(d & 1n)) { d >>= 1n; s++; }

  const witnesses = [...MR_WITNESSES];
  // Rastgele ek tanıklar ekle
  for (let i = witnesses.length; i < rounds; i++) {
    witnesses.push(randomBigIntRange(2n, n - 2n));
  }

  outer: for (const a of witnesses.slice(0, rounds)) {
    if (a >= n) continue;
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let r = 1n; r < s; r++) {
      x = x * x % n;
      if (x === n - 1n) continue outer;
    }
    return false;
  }
  return true;
}

/**
 * `bits` bitlik rastgele asal sayı üretir.
 * @param {number} bits - Bit uzunluğu (ör: 1024, 1536, 2048)
 * @param {boolean} [verbose] - İlerleme noktaları yaz
 */
function generatePrime(bits, verbose = false) {
  while (true) {
    const bytes = randomBytes(Math.ceil(bits / 8));
    // En yüksek iki bit ve en düşük bir bit set et (güçlü asal)
    bytes[0] |= 0xc0;
    bytes[bytes.length - 1] |= 0x01;
    let p = 0n;
    for (const b of bytes) p = (p << 8n) | BigInt(b);
    if (verbose) process.stdout.write('.');
    if (isProbablePrime(p, 20)) return p;
  }
}

module.exports = { modPow, modInverse, isProbablePrime, generatePrime };
