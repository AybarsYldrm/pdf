'use strict';
/**
 * Eliptik Eğri Kriptografisi — `node:crypto` (OpenSSL) üzerinden.
 *   - P-256 (secp256r1), P-384 (secp384r1), P-521 (secp521r1)
 *   - ECDSA imzalama / doğrulama
 *   - ECDH anahtar değişimi
 *   - X25519 (Curve25519 ECDHE)
 *
 * Önceki sürüm, Jacobian projektif koordinatlarla nokta aritmetiğini
 * (double/add/scalarMul), RFC 6979 deterministik k üretimini ve X25519
 * Montgomery merdivenini elle (saf JavaScript BigInt) uyguluyordu. Elle
 * yazılmış eğri aritmetiği; zamanlama yan kanalı, ince aritmetik hataları
 * ve zayıf/öngörülebilir rastgelelik risklerine açıktır. Bu sürüm, tüm
 * gerçek eğri işlemlerini (nokta çarpımı, imzalama, DH) OpenSSL'in
 * denetimden geçmiş, sabit-zamanlı uygulamasına devreder.
 *
 * Dışa aktarılan fonksiyon imzaları ve giriş/çıkış şekilleri (curveName
 * string'i, ham BigInt özel anahtar, {x,y} BigInt açık anahtar noktası
 * veya sıkıştırılmamış 0x04 buffer'ı) AYNEN korunmuştur.
 */
const crypto = require('node:crypto');
const { SEQ, OID, OCT, BIT, CTX, INT, intSmall } = require('./asn1');

// ─────────────────────────────────────────────────────────────────────────────
// Eğri meta verisi (OID'ler + node:crypto eğri adları + hash eşleşmesi)
// Not: p/a/b/Gx/Gy/n alanları geriye dönük uyumluluk için KORUNMUŞTUR
// (bazı tüketiciler bu tabloyu okuyor olabilir) fakat artık dahili nokta
// aritmetiği için KULLANILMAZ — tüm eğri matematiği OpenSSL'e devredilir.
// ─────────────────────────────────────────────────────────────────────────────
const CURVES = {
  'P-256': {
    p:  0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn,
    a:  0xffffffff00000001000000000000000000000000fffffffffffffffffffffffcn,
    b:  0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn,
    Gx: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
    Gy: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
    n:  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
    h: 1n, byteLen: 32, hashAlg: 'sha256',
    oidCurve: '2a8648ce3d030107',
    oidSig:   '2a8648ce3d040302',
    nodeCurve: 'prime256v1',
  },
  'P-384': {
    p:  0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000ffffffffn,
    a:  0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000fffffffcn,
    b:  0xb3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aefn,
    Gx: 0xaa87ca22be8b05378eb1c71ef320ad746e1d3b628ba79b9859f741e082542a385502f25dbf55296c3a545e3872760ab7n,
    Gy: 0x3617de4a96262c6f5d9e98bf9292dc29f8f41dbd289a147ce9da3113b5f0b8c00a60b1ce1d7e819d7a431d7c90ea0e5fn,
    n:  0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973n,
    h: 1n, byteLen: 48, hashAlg: 'sha384',
    oidCurve: '2b81040022',
    oidSig:   '2a8648ce3d040303',
    nodeCurve: 'secp384r1',
  },
  'P-521': {
    p:  (1n << 521n) - 1n,
    a:  (1n << 521n) - 4n,
    b:  0x51953eb9618e1c9a1f929a21a0b68540eea2da725b99b315f3b8b489918ef109e156193951ec7e937b1652c0bd3bb1bf073573df883d2c34f1ef451fd46b503f00n,
    Gx: 0xc6858e06b70404e9cd9e3ecb662395b4429c648139053fb521f828af606b4d3dbaa14b5e77efe75928fe1dc127a2ffa8de3348b3c1856a429bf97e7e31c2e5bd66n,
    Gy: 0x11839296a789a3bc0045c8a5fb42c7d1bd998f54449579b446817afbd17273e662c97ee72995ef42640c550b9013fad0761353c7086a272c24088be94769fd16650n,
    n:  0x01fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa51868783bf2f966b7fcc0148f709a5d03bb5c9b8899c47aebb6fb71e91386409n,
    h: 1n, byteLen: 66, hashAlg: 'sha512',
    oidCurve: '2b81040023',
    oidSig:   '2a8648ce3d040304',
    nodeCurve: 'secp521r1',
  },
};

function getCurve(name) {
  const c = CURVES[name];
  if (!c) throw new Error(`Bilinmeyen eğri: ${name}. Desteklenenler: P-256, P-384, P-521`);
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
// Buffer ↔ Nokta / BigInt serileştirme (saf kodlama — kripto işlemi değildir)
// ─────────────────────────────────────────────────────────────────────────────
function _pointToUncompressed(pt, byteLen) {
  const buf = Buffer.alloc(1 + byteLen * 2);
  buf[0] = 0x04;
  let x = pt.x, y = pt.y;
  for (let i = byteLen - 1; i >= 0; i--) {
    buf[1 + i]           = Number(x & 0xffn); x >>= 8n;
    buf[1 + byteLen + i] = Number(y & 0xffn); y >>= 8n;
  }
  return buf;
}

function _uncompressedToPoint(buf, byteLen) {
  if (buf[0] !== 0x04 || buf.length !== 1 + byteLen * 2)
    throw new Error('EC: geçersiz sıkıştırılmamış nokta formatı');
  let x = 0n, y = 0n;
  for (let i = 0; i < byteLen; i++) {
    x = (x << 8n) | BigInt(buf[1 + i]);
    y = (y << 8n) | BigInt(buf[1 + byteLen + i]);
  }
  return { x, y };
}

function _bigIntToFixedBuf(v, len) {
  let hex = v.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const pad = len * 2;
  hex = hex.padStart(pad, '0').slice(-pad);
  return Buffer.from(hex, 'hex');
}

function _bufToBigInt(buf) {
  let v = 0n;
  for (const b of buf) v = (v << 8n) | BigInt(b);
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// KeyObject yeniden inşası — SEC1 (özel) / SPKI (genel) DER
// SEC1 ECPrivateKey publicKey alanı OPSİYONELDİR: yalnızca özel skaler ve
// eğri OID'i verildiğinde OpenSSL genel anahtarı kendisi türetir. Böylece
// nokta çarpımını elle yapmaya gerek KALMAZ.
// ─────────────────────────────────────────────────────────────────────────────
function _ecPrivateKeyObject(curveName, privateKey) {
  const curve = getCurve(curveName);

  // Özel anahtar bir SKALER'dir (BigInt). Ham bayt dizisi de kabul edilir --
  // aynı sayının başka gösterimi.
  //
  // Bunu açıkça kontrol etmenin sebebi: yanlış tipte bir değer geldiğinde
  // eski davranış `buffer.toString(16)` çağırıyordu, ki Buffer#toString'in
  // ilk parametresi KODLAMA adıdır -- sonuç "Unknown encoding: 16" gibi,
  // gerçek sorunla hiçbir ilgisi olmayan bir hata oluyordu. Bir DER
  // kodlanmış anahtarı skaler sanmak kolay bir hata ve mesaj onu söylemeli.
  let scalar;
  if (typeof privateKey === 'bigint') {
    scalar = privateKey;
  } else if (Buffer.isBuffer(privateKey) && privateKey.length === curve.byteLen) {
    scalar = _bufToBigInt(privateKey);
  } else {
    throw new TypeError(
      `EC özel anahtarı ${curve.byteLen} baytlık bir skaler (BigInt ya da ham Buffer) olmalı; `
      + `${Buffer.isBuffer(privateKey) ? `${privateKey.length} baytlık Buffer` : typeof privateKey} alındı. `
      + 'PKCS#8/SEC1 DER veya PEM geçiriyorsanız önce pemToEcPriv() ile skalere çevirin.',
    );
  }

  const der = SEQ(intSmall(1), OCT(_bigIntToFixedBuf(scalar, curve.byteLen)), CTX(0, OID(curve.oidCurve)));
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'sec1' });
}

function _ecPublicKeyObject(curveName, publicKey) {
  const curve = getCurve(curveName);
  const pubBuf = Buffer.isBuffer(publicKey) ? publicKey : _pointToUncompressed(publicKey, curve.byteLen);
  const der = SEQ(SEQ(OID('2a8648ce3d0201'), OID(curve.oidCurve)), BIT(pubBuf));
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Anahtar üretimi
// ─────────────────────────────────────────────────────────────────────────────
/**
 * EC anahtar çifti üretir.
 * @param {'P-256'|'P-384'|'P-521'} curveName
 * @returns {{ curve, privateKey: bigint, publicKey: {x,y}, publicKeyBuf: Buffer }}
 */
function generateEcKeyPair(curveName) {
  const curve = getCurve(curveName);
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: curve.nodeCurve });
  const jwk = privateKey.export({ format: 'jwk' });
  const priv = _bufToBigInt(Buffer.from(jwk.d, 'base64url'));
  const pub = {
    x: _bufToBigInt(Buffer.from(jwk.x, 'base64url')),
    y: _bufToBigInt(Buffer.from(jwk.y, 'base64url')),
  };
  return {
    curve: curveName,
    privateKey: priv,
    publicKey: pub,
    publicKeyBuf: _pointToUncompressed(pub, curve.byteLen),
  };
}

/**
 * ECDSA imzası — DER kodlu SEQUENCE { INTEGER r, INTEGER s } döner.
 * @param {'P-256'|'P-384'|'P-521'} curveName
 * @param {bigint} privateKey
 * @param {Buffer} message
 * @param {string} [hashAlg]  Varsayılan: eğrinin hashAlg alanı
 */
function ecdsaSign(curveName, privateKey, message, hashAlg) {
  const curve = getCurve(curveName);
  const alg = hashAlg || curve.hashAlg;
  const keyObj = _ecPrivateKeyObject(curveName, privateKey);
  // Node'un varsayılan imza kodlaması EC anahtarları için zaten DER'dir.
  return crypto.sign(alg, message, { key: keyObj, dsaEncoding: 'der' });
}

/**
 * ECDSA imzası doğrulama.
 * @param {'P-256'|'P-384'|'P-521'} curveName
 * @param {{ x: bigint, y: bigint }|Buffer} publicKey
 * @param {Buffer} message
 * @param {Buffer} derSig  DER kodlu imza
 * @param {string} [hashAlg]
 */
function ecdsaVerify(curveName, publicKey, message, derSig, hashAlg) {
  const curve = getCurve(curveName);
  const alg = hashAlg || curve.hashAlg;
  try {
    const pubObj = _ecPublicKeyObject(curveName, publicKey);
    return crypto.verify(alg, message, { key: pubObj, dsaEncoding: 'der' }, derSig);
  } catch (e) {
    return false;
  }
}

/**
 * ECDH paylaşılan sır hesabı (x koordinatı, SEC1/ANSI X9.63 kuralı).
 * @param {'P-256'|'P-384'|'P-521'} curveName
 * @param {bigint} privateKey
 * @param {{ x, y }|Buffer} peerPublicKey
 * @returns {Buffer} Paylaşılan sır
 */
function ecdhCompute(curveName, privateKey, peerPublicKey) {
  const privObj = _ecPrivateKeyObject(curveName, privateKey);
  const pubObj = _ecPublicKeyObject(curveName, peerPublicKey);
  return crypto.diffieHellman({ privateKey: privObj, publicKey: pubObj });
}

// ─────────────────────────────────────────────────────────────────────────────
// X25519 — Curve25519 ECDHE (RFC 7748) — node:crypto
// ─────────────────────────────────────────────────────────────────────────────
const X25519_OID = '2b656e'; // 1.3.101.110 (id-X25519, RFC 8410)

function _x25519PrivateKeyObject(privateKeyBuf) {
  // Minimal PKCS#8 DER: yalnızca ham 32 baytlık skalerden anahtar nesnesi
  // inşa eder (RFC 8410). JWK importu `x` (genel anahtar) alanını da
  // zorunlu kıldığından, burada doğrudan PKCS#8 kullanılır.
  const pkcs8 = SEQ(INT(0), SEQ(OID(X25519_OID)), OCT(OCT(privateKeyBuf)));
  return crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
}
function _x25519PublicKeyObject(publicKeyBuf) {
  const jwk = { kty: 'OKP', crv: 'X25519', x: publicKeyBuf.toString('base64url') };
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/**
 * X25519 anahtar çifti üretir.
 * @returns {{ privateKey: Buffer(32), publicKey: Buffer(32) }}
 */
function generateX25519KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const privJwk = privateKey.export({ format: 'jwk' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  return {
    privateKey: Buffer.from(privJwk.d, 'base64url'),
    publicKey: Buffer.from(pubJwk.x, 'base64url'),
  };
}

/**
 * X25519 paylaşılan sır hesabı.
 * @param {Buffer} privateKey  32 bayt
 * @param {Buffer} peerPublicKey  32 bayt
 * @returns {Buffer} 32 baytlık paylaşılan sır
 */
function x25519(privateKey, peerPublicKey) {
  const privObj = _x25519PrivateKeyObject(privateKey);
  const pubObj = _x25519PublicKeyObject(peerPublicKey);
  return crypto.diffieHellman({ privateKey: privObj, publicKey: pubObj });
}

// ─────────────────────────────────────────────────────────────────────────────
// DER imza kodlama / çözümleme (r,s) — saf kodlama yardımcıları (korunmuştur)
// ─────────────────────────────────────────────────────────────────────────────
function _encIntDer(v) {
  let h = v.toString(16);
  if (h.length % 2) h = '0' + h;
  let b = Buffer.from(h, 'hex');
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
  const lenBuf = Buffer.alloc(b.length < 0x80 ? 1 : 2);
  if (b.length < 0x80) lenBuf[0] = b.length;
  else { lenBuf[0] = 0x81; lenBuf[1] = b.length; }
  return Buffer.concat([Buffer.from([0x02]), lenBuf, b]);
}

function _encodeEcdsaDer(r, s) {
  const rBuf = _encIntDer(r);
  const sBuf = _encIntDer(s);
  const inner = Buffer.concat([rBuf, sBuf]);
  const lenBuf = inner.length < 0x80
    ? Buffer.from([inner.length])
    : Buffer.from([0x81, inner.length]);
  return Buffer.concat([Buffer.from([0x30]), lenBuf, inner]);
}

function _readDerInt(buf, off) {
  if (buf[off] !== 0x02) throw new Error('DER: INTEGER beklendi');
  off++;
  let len = buf[off++];
  if (len & 0x80) {
    const ll = len & 0x7f;
    len = 0;
    for (let i = 0; i < ll; i++) len = (len << 8) | buf[off++];
  }
  const raw = buf.subarray(off, off + len);
  let v = 0n;
  for (const b of raw) v = (v << 8n) | BigInt(b);
  return { v, nextOff: off + len };
}

function _decodeEcdsaDer(buf) {
  if (buf[0] !== 0x30) throw new Error('DER: SEQUENCE beklendi');
  let off = 1;
  let len = buf[off++];
  if (len & 0x80) { const ll = len & 0x7f; len = 0; for (let i = 0; i < ll; i++) len = (len << 8) | buf[off++]; }
  const { v: r, nextOff } = _readDerInt(buf, off);
  const { v: s }          = _readDerInt(buf, nextOff);
  return { r, s };
}

// ─────────────────────────────────────────────────────────────────────────────
// İhracat
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  CURVES, getCurve,
  generateEcKeyPair, ecdsaSign, ecdsaVerify, ecdhCompute,
  generateX25519KeyPair, x25519,
  // Dahili yardımcılar (PKI için — korunmuştur)
  _pointToUncompressed, _uncompressedToPoint,
  _bigIntToFixedBuf, _bufToBigInt,
  _encodeEcdsaDer, _decodeEcdsaDer,
  // Dahili KeyObject inşacıları (keys.js / chain.js için)
  _ecPrivateKeyObject, _ecPublicKeyObject,
};
