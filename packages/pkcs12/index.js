'use strict';
/**
 * @fitfak/pkcs12 — Tam PKCS#12 (.pfx / .p12) okuyucu ve üretici. RFC 7292.
 *
 * Bu paket, projedeki eski `pfx.js`'in yerini alır. Eski uygulama yalnız
 * PBES2 (PBKDF2 + AES) destekliyordu; oysa gerçek dünyadaki .pfx dosyalarının
 * çoğu — Windows sertifika deposu, Java keytool, OpenSSL'in eski varsayılanı —
 * PKCS#12 PBE şemalarını (3DES / RC2) kullanır. MacData da hiç işlenmiyordu,
 * yani yanlış parola sessizce çöp veri üretebiliyordu.
 *
 * Desteklenen şifreleme şemaları:
 *   1.2.840.113549.1.5.13   PBES2 (AES-128/192/256-CBC, 3DES)          ✔ oku/yaz
 *   1.2.840.113549.1.12.1.3 pbeWithSHAAnd3-KeyTripleDES-CBC            ✔ oku/yaz
 *   1.2.840.113549.1.12.1.4 pbeWithSHAAnd2-KeyTripleDES-CBC            ✔ oku
 *   1.2.840.113549.1.12.1.5 pbeWithSHAAnd128BitRC2-CBC                 ✔ oku
 *   1.2.840.113549.1.12.1.6 pbeWithSHAAnd40BitRC2-CBC                  ✔ oku/yaz
 *
 * MAC: HMAC-SHA1/SHA256/SHA384/SHA512 (PKCS#12 KDF) — doğrulanır ve üretilir.
 */

const crypto = require('crypto');
const {
  readTLV, readChildren, decodeOidHex, derIntToBigInt,
  SEQ, SET, OID, OCT, INT, NULL, CTX, tlv, intSmall
} = require('@fitfak/ssl/src/asn1');

const { pkcs12Kdf, toBmpString, passwordVariants, ID_KEY_MATERIAL, ID_IV, ID_MAC_KEY } = require('./src/kdf');
const rc2 = require('./src/rc2');

/* ------------------------------------------------------------------ */
/* Sabitler                                                             */
/* ------------------------------------------------------------------ */

const OIDS = {
  data:                 '1.2.840.113549.1.7.1',
  encryptedData:        '1.2.840.113549.1.7.6',
  keyBag:               '1.2.840.113549.1.12.10.1.1',
  pkcs8ShroudedKeyBag:  '1.2.840.113549.1.12.10.1.2',
  certBag:              '1.2.840.113549.1.12.10.1.3',
  crlBag:               '1.2.840.113549.1.12.10.1.4',
  secretBag:            '1.2.840.113549.1.12.10.1.5',
  safeContentsBag:      '1.2.840.113549.1.12.10.1.6',
  x509Certificate:      '1.2.840.113549.1.9.22.1',
  friendlyName:         '1.2.840.113549.1.9.20',
  localKeyId:           '1.2.840.113549.1.9.21',
  pbes2:                '1.2.840.113549.1.5.13',
  pbkdf2:               '1.2.840.113549.1.5.12'
};

/** PKCS#12 PBE şemaları (RFC 7292 Ek C) */
const PKCS12_PBE = {
  '1.2.840.113549.1.12.1.1': { cipher: 'rc4',          keyLen: 16, ivLen: 0,  hash: 'sha1' },
  '1.2.840.113549.1.12.1.2': { cipher: 'rc4',          keyLen: 5,  ivLen: 0,  hash: 'sha1' },
  '1.2.840.113549.1.12.1.3': { cipher: 'des-ede3-cbc', keyLen: 24, ivLen: 8,  hash: 'sha1' },
  '1.2.840.113549.1.12.1.4': { cipher: 'des-ede3-cbc', keyLen: 16, ivLen: 8,  hash: 'sha1', twoKey: true },
  '1.2.840.113549.1.12.1.5': { cipher: 'rc2-cbc',      keyLen: 16, ivLen: 8,  hash: 'sha1', rc2Bits: 128 },
  '1.2.840.113549.1.12.1.6': { cipher: 'rc2-cbc',      keyLen: 5,  ivLen: 8,  hash: 'sha1', rc2Bits: 40 }
};

/** PBES2 şifreleme algoritmaları */
const PBES2_CIPHERS = {
  '2.16.840.1.101.3.4.1.2':  { alg: 'aes-128-cbc', keyLen: 16 },
  '2.16.840.1.101.3.4.1.22': { alg: 'aes-192-cbc', keyLen: 24 },
  '2.16.840.1.101.3.4.1.42': { alg: 'aes-256-cbc', keyLen: 32 },
  '1.2.840.113549.3.7':      { alg: 'des-ede3-cbc', keyLen: 24 }
};

const PRF_HASHES = {
  '1.2.840.113549.2.7':  'sha1',
  '1.2.840.113549.2.9':  'sha256',
  '1.2.840.113549.2.10': 'sha384',
  '1.2.840.113549.2.11': 'sha512'
};

const DIGEST_OIDS = {
  '1.3.14.3.2.26':          'sha1',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512'
};

const DIGEST_OID_BY_NAME = {
  sha1:   '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3'
};

class Pkcs12Error extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'Pkcs12Error';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                          */
/* ------------------------------------------------------------------ */

const oidOf = (node) => decodeOidHex(node.content.toString('hex'));

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

function pemToDer(pem) {
  if (Buffer.isBuffer(pem)) return pem;
  const b64 = String(pem).split('\n').filter((l) => l && !l.startsWith('-----')).join('');
  return Buffer.from(b64, 'base64');
}

/** Belleği en iyi çabayla sıfırlar. */
function wipe(buf) {
  if (Buffer.isBuffer(buf)) buf.fill(0);
}

/* ------------------------------------------------------------------ */
/* Şifre çözme                                                          */
/* ------------------------------------------------------------------ */

/**
 * PKCS#12 PBE (RFC 7292 Ek C) ile şifre çözer.
 */
function decryptPkcs12Pbe(oid, params, cipherText, passwordBmp) {
  const spec = PKCS12_PBE[oid];
  if (!spec) throw new Pkcs12Error('ERR_PKCS12_UNSUPPORTED_PBE', `Desteklenmeyen PBE: ${oid}`);

  const p = readChildren(params.content);
  const salt = p[0].content;
  const iterations = Number(derIntToBigInt(p[1].content));

  const key = pkcs12Kdf(passwordBmp, salt, ID_KEY_MATERIAL, iterations, spec.keyLen, spec.hash);
  const iv = spec.ivLen
    ? pkcs12Kdf(passwordBmp, salt, ID_IV, iterations, spec.ivLen, spec.hash)
    : null;

  try {
    if (spec.cipher === 'rc2-cbc') {
      // Modern OpenSSL'de RC2 legacy provider arkasında; saf JS uygulamamızı kullanıyoruz.
      return rc2.decryptCbc(cipherText, key, iv, spec.rc2Bits);
    }
    if (spec.cipher === 'rc4') {
      throw new Pkcs12Error('ERR_PKCS12_RC4_UNSUPPORTED',
        'RC4 tabanlı PKCS#12 şemaları desteklenmiyor (kriptografik olarak kırık).');
    }
    let effectiveKey = key;
    if (spec.twoKey) {
      // 2 anahtarlı 3DES: K1||K2||K1
      effectiveKey = Buffer.concat([key, key.slice(0, 8)]);
    }
    const decipher = crypto.createDecipheriv(spec.cipher, effectiveKey, iv);
    return Buffer.concat([decipher.update(cipherText), decipher.final()]);
  } finally {
    wipe(key);
    if (iv) wipe(iv);
  }
}

/**
 * PBES2 (PBKDF2 + AES/3DES) ile şifre çözer.
 */
function decryptPbes2(params, cipherText, password) {
  const p = readChildren(params.content);
  const kdfSeq = readChildren(p[0].content);
  const kdfOid = oidOf(kdfSeq[0]);
  if (kdfOid !== OIDS.pbkdf2) {
    throw new Pkcs12Error('ERR_PKCS12_UNSUPPORTED_KDF', `Desteklenmeyen PBES2 KDF: ${kdfOid}`);
  }

  const kdfParams = readChildren(kdfSeq[1].content);
  const salt = kdfParams[0].content;
  const iterations = Number(derIntToBigInt(kdfParams[1].content));

  let hashName = 'sha1';
  let keyLenHint = null;
  for (let i = 2; i < kdfParams.length; i++) {
    if (kdfParams[i].tag === 0x02) keyLenHint = Number(derIntToBigInt(kdfParams[i].content));
    else if (kdfParams[i].tag === 0x30) {
      const prf = readChildren(kdfParams[i].content);
      hashName = PRF_HASHES[oidOf(prf[0])] || 'sha1';
    }
  }

  const encSeq = readChildren(p[1].content);
  const encOid = oidOf(encSeq[0]);
  const cipherSpec = PBES2_CIPHERS[encOid];
  if (!cipherSpec) {
    throw new Pkcs12Error('ERR_PKCS12_UNSUPPORTED_CIPHER', `Desteklenmeyen PBES2 şifresi: ${encOid}`);
  }
  const iv = encSeq[1].content;

  const keyLen = keyLenHint || cipherSpec.keyLen;
  const key = crypto.pbkdf2Sync(password, salt, iterations, keyLen, hashName);
  try {
    const decipher = crypto.createDecipheriv(cipherSpec.alg, key, iv);
    return Buffer.concat([decipher.update(cipherText), decipher.final()]);
  } finally {
    wipe(key);
  }
}

/** AlgorithmIdentifier'a bakıp doğru şemayı seçer. */
function decryptWithAlgId(algIdNode, cipherText, password, passwordBmp) {
  const children = readChildren(algIdNode.content);
  const oid = oidOf(children[0]);
  if (oid === OIDS.pbes2) {
    return decryptPbes2(children[1], cipherText, password);
  }
  if (PKCS12_PBE[oid]) {
    return decryptPkcs12Pbe(oid, children[1], cipherText, passwordBmp);
  }
  throw new Pkcs12Error('ERR_PKCS12_UNSUPPORTED_SCHEME', `Desteklenmeyen şifreleme şeması: ${oid}`);
}

/* ------------------------------------------------------------------ */
/* MAC                                                                  */
/* ------------------------------------------------------------------ */

/**
 * MacData'yı doğrular. Yanlış parolanın TEK güvenilir göstergesi budur;
 * MAC olmadan yanlış parola "boş sonuç" ya da çöp veri olarak görünür.
 *
 * @returns {{ present:boolean, verified:boolean, algorithm:string|null,
 *             iterations:number|null, passwordBmp:Buffer|null }}
 */
function verifyMac(pfxChildren, authSafeOctets, password) {
  if (pfxChildren.length < 3) {
    return { present: false, verified: false, algorithm: null, iterations: null, passwordBmp: null };
  }
  const macData = readChildren(pfxChildren[2].content);
  const digestInfo = readChildren(macData[0].content);
  const algSeq = readChildren(digestInfo[0].content);
  const hashName = DIGEST_OIDS[oidOf(algSeq[0])];
  if (!hashName) {
    throw new Pkcs12Error('ERR_PKCS12_UNSUPPORTED_MAC', 'Desteklenmeyen MAC özet algoritması');
  }
  const expectedDigest = digestInfo[1].content;
  const salt = macData[1].content;
  const iterations = macData[2] ? Number(derIntToBigInt(macData[2].content)) : 1;

  for (const pwd of passwordVariants(password)) {
    const macKey = pkcs12Kdf(pwd, salt, ID_MAC_KEY, iterations, hashLen(hashName), hashName);
    const actual = crypto.createHmac(hashName, macKey).update(authSafeOctets).digest();
    wipe(macKey);
    if (actual.length === expectedDigest.length && crypto.timingSafeEqual(actual, expectedDigest)) {
      return { present: true, verified: true, algorithm: hashName, iterations, passwordBmp: pwd };
    }
  }
  return { present: true, verified: false, algorithm: hashName, iterations, passwordBmp: null };
}

function hashLen(name) {
  return crypto.createHash(name).update('').digest().length;
}

/* ------------------------------------------------------------------ */
/* Çantalar (bags)                                                      */
/* ------------------------------------------------------------------ */

/** Bag attribute'larını (friendlyName, localKeyId) çözer. */
function parseBagAttributes(node) {
  const attrs = { friendlyName: null, localKeyId: null };
  if (!node || node.tag !== 0x31) return attrs;
  for (const attr of readChildren(node.content)) {
    const parts = readChildren(attr.content);
    const oid = oidOf(parts[0]);
    const values = readChildren(parts[1].content);
    if (!values.length) continue;
    if (oid === OIDS.friendlyName) {
      // BMPString → UTF-16BE
      const b = values[0].content;
      let s = '';
      for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
      attrs.friendlyName = s;
    } else if (oid === OIDS.localKeyId) {
      attrs.localKeyId = values[0].content.toString('hex');
    }
  }
  return attrs;
}

/** SafeContents içindeki çantaları çıkarır. */
function extractBags(safeContentsDer, password, passwordBmp, out) {
  const seq = readTLV(safeContentsDer, 0);
  for (const bagNode of readChildren(seq.content)) {
    const bagChildren = readChildren(bagNode.content);
    const bagOid = oidOf(bagChildren[0]);
    const value = bagChildren[1];
    const attrs = parseBagAttributes(bagChildren[2]);

    if (bagOid === OIDS.certBag) {
      const certBagSeq = readTLV(value.content, 0);
      const certBagChildren = readChildren(certBagSeq.content);
      const certType = oidOf(certBagChildren[0]);
      if (certType !== OIDS.x509Certificate) continue;
      const certOctet = readTLV(certBagChildren[1].content, 0);
      out.certificates.push({ der: Buffer.from(certOctet.content), ...attrs });
    }
    else if (bagOid === OIDS.pkcs8ShroudedKeyBag) {
      const epki = readTLV(value.content, 0);
      const epkiChildren = readChildren(epki.content);
      const pkcs8 = decryptWithAlgId(epkiChildren[0], epkiChildren[1].content, password, passwordBmp);
      out.privateKeys.push({ der: pkcs8, ...attrs });
    }
    else if (bagOid === OIDS.keyBag) {
      // Şifrelenmemiş PrivateKeyInfo
      const pki = readTLV(value.content, 0);
      out.privateKeys.push({
        der: Buffer.from(value.content.subarray(0, pki.totalLen)),
        ...attrs
      });
    }
    else if (bagOid === OIDS.safeContentsBag) {
      extractBags(value.content, password, passwordBmp, out);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Genel API — probe / parse                                            */
/* ------------------------------------------------------------------ */

/**
 * Parola GEREKTİRMEDEN bir PFX hakkında bilgi verir.
 * Arayüzde "bu dosyada kaç kimlik var, hangi şifreleme kullanılmış" göstermek için.
 *
 * @param {Buffer} pfxDer
 */
function probe(pfxDer) {
  const info = {
    version: null,
    macAlgorithm: null,
    macIterations: null,
    encryptionSchemes: [],
    contentTypes: [],
    bagCount: { cert: 0, shroudedKey: 0, key: 0 }
  };

  const pfx = readTLV(pfxDer, 0);
  const children = readChildren(pfx.content);
  info.version = Number(derIntToBigInt(children[0].content));

  if (children.length >= 3) {
    try {
      const macData = readChildren(children[2].content);
      const digestInfo = readChildren(macData[0].content);
      const algSeq = readChildren(digestInfo[0].content);
      info.macAlgorithm = DIGEST_OIDS[oidOf(algSeq[0])] || oidOf(algSeq[0]);
      info.macIterations = macData[2] ? Number(derIntToBigInt(macData[2].content)) : 1;
    } catch { /* MacData bozuksa yoksay */ }
  }

  const authSafeCi = readChildren(children[1].content);
  const octet = readTLV(authSafeCi[1].content, 0);
  const authSafeSeq = readTLV(octet.content, 0);

  for (const ci of readChildren(authSafeSeq.content)) {
    const ciChildren = readChildren(ci.content);
    const oid = oidOf(ciChildren[0]);
    info.contentTypes.push(oid === OIDS.data ? 'data' : oid === OIDS.encryptedData ? 'encryptedData' : oid);

    if (oid === OIDS.encryptedData) {
      const ed = readTLV(ciChildren[1].content, 0);
      const edChildren = readChildren(ed.content);
      const eci = readChildren(edChildren[1].content);
      const algChildren = readChildren(eci[1].content);
      const algOid = oidOf(algChildren[0]);
      const label = algOid === OIDS.pbes2 ? 'pbes2' : (PKCS12_PBE[algOid] ? describePbe(algOid) : algOid);
      if (!info.encryptionSchemes.includes(label)) info.encryptionSchemes.push(label);
    } else if (oid === OIDS.data) {
      try {
        const inner = readTLV(ciChildren[1].content, 0);
        const seq = readTLV(inner.content, 0);
        for (const bag of readChildren(seq.content)) {
          const bagOid = oidOf(readChildren(bag.content)[0]);
          if (bagOid === OIDS.certBag) info.bagCount.cert++;
          else if (bagOid === OIDS.pkcs8ShroudedKeyBag) info.bagCount.shroudedKey++;
          else if (bagOid === OIDS.keyBag) info.bagCount.key++;
        }
      } catch { /* şifreli/bozuk içerik */ }
    }
  }

  info.needsPassword = info.encryptionSchemes.length > 0 || info.bagCount.shroudedKey > 0 || !!info.macAlgorithm;
  return info;
}

function describePbe(oid) {
  const s = PKCS12_PBE[oid];
  if (!s) return oid;
  if (s.cipher === 'rc2-cbc') return `pkcs12-rc2-${s.rc2Bits}`;
  if (s.cipher === 'des-ede3-cbc') return s.twoKey ? 'pkcs12-3des-2key' : 'pkcs12-3des';
  return `pkcs12-${s.cipher}`;
}

/**
 * PFX'i açar ve kimlikleri (anahtar + sertifika + zincir) çıkarır.
 *
 * @param {Buffer} pfxDer
 * @param {string} password
 * @param {{ verifyMac?: boolean }} [opts]
 * @returns {{ identities: Array, otherCertificates: string[], mac: Object }}
 */
function parse(pfxDer, password = '', opts = {}) {
  const verifyMacFlag = opts.verifyMac !== false;

  let pfx, children;
  try {
    pfx = readTLV(pfxDer, 0);
    children = readChildren(pfx.content);
  } catch (err) {
    throw new Pkcs12Error('ERR_PKCS12_PARSE', `PFX ayrıştırılamadı: ${err.message}`);
  }
  if (children.length < 2) {
    throw new Pkcs12Error('ERR_PKCS12_PARSE', 'PFX yapısı eksik');
  }

  const authSafeCi = readChildren(children[1].content);
  const authSafeOctetNode = readTLV(authSafeCi[1].content, 0);
  const authSafeOctets = authSafeOctetNode.content;

  // ── MAC ──
  let mac = { present: false, verified: false, algorithm: null, iterations: null };
  let passwordBmp = toBmpString(password);

  if (children.length >= 3) {
    const macResult = verifyMac(children, authSafeOctets, password);
    mac = {
      present: macResult.present,
      verified: macResult.verified,
      algorithm: macResult.algorithm,
      iterations: macResult.iterations
    };
    if (macResult.verified) {
      passwordBmp = macResult.passwordBmp;
    } else if (verifyMacFlag) {
      throw new Pkcs12Error('ERR_PKCS12_BAD_PASSWORD',
        'PFX MAC doğrulaması başarısız: parola yanlış ya da dosya bozulmuş.');
    }
  }

  // ── İçerik ──
  const raw = { certificates: [], privateKeys: [] };
  const authSafeSeq = readTLV(authSafeOctets, 0);

  for (const ci of readChildren(authSafeSeq.content)) {
    const ciChildren = readChildren(ci.content);
    const oid = oidOf(ciChildren[0]);

    if (oid === OIDS.encryptedData) {
      const ed = readTLV(ciChildren[1].content, 0);
      const edChildren = readChildren(ed.content);
      const eci = readChildren(edChildren[1].content);
      // EncryptedContent [0] IMPLICIT OCTET STRING
      const cipherText = eci[2].content;
      let plain;
      try {
        plain = decryptWithAlgId(eci[1], cipherText, password, passwordBmp);
      } catch (err) {
        if (err.code === 'ERR_PKCS12_UNSUPPORTED_PBE' ||
            err.code === 'ERR_PKCS12_UNSUPPORTED_SCHEME' ||
            err.code === 'ERR_PKCS12_UNSUPPORTED_CIPHER') throw err;
        throw new Pkcs12Error('ERR_PKCS12_BAD_PASSWORD',
          `Şifreli içerik çözülemedi (parola yanlış olabilir): ${err.message}`);
      }
      extractBags(plain, password, passwordBmp, raw);
      wipe(plain);
    }
    else if (oid === OIDS.data) {
      const octetNode = readTLV(ciChildren[1].content, 0);
      extractBags(octetNode.content, password, passwordBmp, raw);
    }
  }

  if (!raw.certificates.length && !raw.privateKeys.length) {
    throw new Pkcs12Error('ERR_PKCS12_EMPTY', 'PFX içinde sertifika veya anahtar bulunamadı.');
  }

  return assembleIdentities(raw, mac);
}

/**
 * Ham çantaları kimliklere dönüştürür: her özel anahtar, kendi sertifikası ve
 * zinciriyle eşleştirilir.
 */
function assembleIdentities(raw, mac) {
  const { extractCertMeta, matchChain } = require('./src/chain');

  const certs = raw.certificates.map((c) => ({ ...c, meta: extractCertMeta(c.der) }));
  const identities = [];
  const usedCertIdx = new Set();

  for (const key of raw.privateKeys) {
    let certIdx = -1;

    // 1. localKeyId ile eşleştir (en güvenilir)
    if (key.localKeyId) {
      certIdx = certs.findIndex((c, i) => !usedCertIdx.has(i) && c.localKeyId === key.localKeyId);
    }
    // 2. friendlyName ile
    if (certIdx < 0 && key.friendlyName) {
      certIdx = certs.findIndex((c, i) => !usedCertIdx.has(i) && c.friendlyName === key.friendlyName);
    }
    // 3. Açık anahtar eşleşmesi (kesin ama daha pahalı)
    if (certIdx < 0) {
      certIdx = certs.findIndex((c, i) => !usedCertIdx.has(i) && publicKeyMatches(key.der, c.der));
    }

    if (certIdx < 0) {
      identities.push({
        friendlyName: key.friendlyName || null,
        localKeyId: key.localKeyId || null,
        privateKeyPem: derToPem(key.der, 'PRIVATE KEY'),
        certificatePem: null,
        chainPems: [],
        keyInfo: describeKey(key.der),
        warning: 'Bu özel anahtarla eşleşen sertifika bulunamadı.'
      });
      continue;
    }

    usedCertIdx.add(certIdx);
    const leaf = certs[certIdx];
    const chain = matchChain(leaf, certs.filter((_, i) => i !== certIdx));
    for (const c of chain) {
      const idx = certs.indexOf(c);
      if (idx >= 0) usedCertIdx.add(idx);
    }

    identities.push({
      friendlyName: key.friendlyName || leaf.friendlyName || leaf.meta.subjectCN || null,
      localKeyId: key.localKeyId || leaf.localKeyId || null,
      privateKeyPem: derToPem(key.der, 'PRIVATE KEY'),
      certificatePem: derToPem(leaf.der, 'CERTIFICATE'),
      certificateDer: leaf.der,
      chainPems: chain.map((c) => derToPem(c.der, 'CERTIFICATE')),
      subject: leaf.meta.subject,
      issuer: leaf.meta.issuer,
      serialNumber: leaf.meta.serial,
      notBefore: leaf.meta.notBefore,
      notAfter: leaf.meta.notAfter,
      keyInfo: describeKey(key.der)
    });
  }

  const otherCertificates = certs
    .filter((_, i) => !usedCertIdx.has(i))
    .map((c) => derToPem(c.der, 'CERTIFICATE'));

  return { identities, otherCertificates, mac };
}

/** Özel anahtarın açık anahtarı, sertifikanınkiyle aynı mı? */
function publicKeyMatches(pkcs8Der, certDer) {
  try {
    const keyObj = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
    const pub = crypto.createPublicKey(keyObj).export({ format: 'der', type: 'spki' });
    const certPub = new crypto.X509Certificate(certDer).publicKey.export({ format: 'der', type: 'spki' });
    return pub.equals(certPub);
  } catch {
    return false;
  }
}

function describeKey(pkcs8Der) {
  try {
    const k = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
    const out = { type: k.asymmetricKeyType };
    const d = k.asymmetricKeyDetails || {};
    if (d.namedCurve) out.curve = d.namedCurve;
    if (d.modulusLength) out.bits = d.modulusLength;
    return out;
  } catch {
    return { type: 'unknown' };
  }
}

/* ------------------------------------------------------------------ */
/* Üretim (build)                                                       */
/* ------------------------------------------------------------------ */

/** BMPString TLV üretir. */
function BMP(str) {
  const buf = Buffer.alloc(str.length * 2);
  for (let i = 0; i < str.length; i++) buf.writeUInt16BE(str.charCodeAt(i), i * 2);
  return tlv(0x1e, buf);
}

function bagAttributes({ friendlyName, localKeyId }) {
  const attrs = [];
  if (friendlyName) {
    attrs.push(SEQ(OID(OIDS.friendlyName), SET(BMP(friendlyName))));
  }
  if (localKeyId) {
    attrs.push(SEQ(OID(OIDS.localKeyId), SET(OCT(Buffer.from(localKeyId, 'hex')))));
  }
  return attrs.length ? SET(...attrs) : null;
}

/** PBES2 + AES-256-CBC ile şifreler; AlgorithmIdentifier ve şifreli metni döndürür. */
function encryptPbes2(plain, password, opts = {}) {
  const iterations = opts.iterations || 600000;
  const hashName = opts.hash || 'sha256';
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, iterations, 32, hashName);
  try {
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const cipherText = Buffer.concat([cipher.update(plain), cipher.final()]);

    const prfOid = { sha1: '1.2.840.113549.2.7', sha256: '1.2.840.113549.2.9',
                     sha384: '1.2.840.113549.2.10', sha512: '1.2.840.113549.2.11' }[hashName];

    const pbkdf2Params = SEQ(OCT(salt), INT(BigInt(iterations)), SEQ(OID(prfOid), NULL()));
    const algId = SEQ(
      OID(OIDS.pbes2),
      SEQ(
        SEQ(OID(OIDS.pbkdf2), pbkdf2Params),
        SEQ(OID('2.16.840.1.101.3.4.1.42'), OCT(iv))
      )
    );
    return { algId, cipherText };
  } finally {
    wipe(key);
  }
}

/** PKCS#12 PBE (3DES) ile şifreler — eski uyumluluk modu. */
function encryptPkcs12Pbe3Des(plain, passwordBmp, opts = {}) {
  const iterations = opts.iterations || 100000;
  const salt = crypto.randomBytes(8);
  const key = pkcs12Kdf(passwordBmp, salt, ID_KEY_MATERIAL, iterations, 24, 'sha1');
  const iv = pkcs12Kdf(passwordBmp, salt, ID_IV, iterations, 8, 'sha1');
  try {
    const cipher = crypto.createCipheriv('des-ede3-cbc', key, iv);
    const cipherText = Buffer.concat([cipher.update(plain), cipher.final()]);
    const algId = SEQ(
      OID('1.2.840.113549.1.12.1.3'),
      SEQ(OCT(salt), INT(BigInt(iterations)))
    );
    return { algId, cipherText };
  } finally {
    wipe(key); wipe(iv);
  }
}

/**
 * PKCS#12 dosyası üretir.
 *
 * Eski `pfx.js` MacData yazmıyordu — Windows ve Java böyle dosyaları reddeder.
 * Burada MacData her zaman yazılır (`mac: false` ile açıkça kapatılmadıkça).
 *
 * @param {Object} o
 * @param {string|Buffer} o.privateKeyPem
 * @param {string|Buffer} o.certificatePem
 * @param {Array<string|Buffer>} [o.chainPems]
 * @param {string} o.password
 * @param {string} [o.friendlyName]
 * @param {'pbes2-aes256-cbc'|'pkcs12-3des'} [o.encryption='pbes2-aes256-cbc']
 * @param {{iterations?:number, hash?:string}} [o.kdf]
 * @param {{algorithm?:string, iterations?:number}|false} [o.mac]
 * @returns {Buffer} DER
 */
function build(o) {
  if (!o || !o.privateKeyPem || !o.certificatePem) {
    throw new Pkcs12Error('ERR_PKCS12_BUILD_ARGS', 'build(): privateKeyPem ve certificatePem zorunlu');
  }
  const password = o.password == null ? '' : String(o.password);
  const passwordBmp = toBmpString(password);
  const encryption = o.encryption || 'pbes2-aes256-cbc';
  const kdfOpts = o.kdf || {};

  // PEM → PKCS#8 DER (EC "SEC1" anahtarları da normalize edilir)
  const keyObj = crypto.createPrivateKey(o.privateKeyPem);
  const keyDer = keyObj.export({ format: 'der', type: 'pkcs8' });
  const certDer = pemToDer(o.certificatePem);
  const chainDers = (o.chainPems || []).map(pemToDer);

  const localKeyId = crypto.createHash('sha1').update(certDer).digest('hex');
  const friendlyName = o.friendlyName || null;

  // ── Anahtar çantası (şifreli) ──
  const keyEnc = encryption === 'pkcs12-3des'
    ? encryptPkcs12Pbe3Des(keyDer, passwordBmp, kdfOpts)
    : encryptPbes2(keyDer, password, kdfOpts);
  wipe(keyDer);

  const encryptedPrivateKeyInfo = SEQ(keyEnc.algId, OCT(keyEnc.cipherText));
  const keyBag = SEQ(
    OID(OIDS.pkcs8ShroudedKeyBag),
    CTX(0, encryptedPrivateKeyInfo),
    bagAttributes({ friendlyName, localKeyId })
  );
  const keySafeContents = SEQ(keyBag);

  // ── Sertifika çantaları ──
  const makeCertBag = (der, attrs) => SEQ(
    OID(OIDS.certBag),
    CTX(0, SEQ(OID(OIDS.x509Certificate), CTX(0, OCT(der)))),
    attrs
  );
  const certBags = [makeCertBag(certDer, bagAttributes({ friendlyName, localKeyId }))];
  for (const c of chainDers) certBags.push(makeCertBag(c, null));
  const certSafeContents = SEQ(...certBags);

  // Sertifikalar da şifrelenir (yaygın uygulama; gizli değildir ama uyum için)
  const certEnc = encryption === 'pkcs12-3des'
    ? encryptPkcs12Pbe3Des(certSafeContents, passwordBmp, kdfOpts)
    : encryptPbes2(certSafeContents, password, kdfOpts);

  const certContentInfo = SEQ(
    OID(OIDS.encryptedData),
    CTX(0, SEQ(
      intSmall(0),
      SEQ(OID(OIDS.data), certEnc.algId, tlv(0x80, certEnc.cipherText))
    ))
  );
  const keyContentInfo = SEQ(
    OID(OIDS.data),
    CTX(0, OCT(keySafeContents))
  );

  const authenticatedSafe = SEQ(certContentInfo, keyContentInfo);

  // ── MacData ──
  let macData = null;
  if (o.mac !== false) {
    const macOpts = o.mac || {};
    const macHash = macOpts.algorithm || 'sha256';
    const macIter = macOpts.iterations || 100000;
    const macSalt = crypto.randomBytes(20);
    const macKey = pkcs12Kdf(passwordBmp, macSalt, ID_MAC_KEY, macIter, hashLen(macHash), macHash);
    const digest = crypto.createHmac(macHash, macKey).update(authenticatedSafe).digest();
    wipe(macKey);

    macData = SEQ(
      SEQ(SEQ(OID(DIGEST_OID_BY_NAME[macHash]), NULL()), OCT(digest)),
      OCT(macSalt),
      INT(BigInt(macIter))
    );
  }

  return SEQ(
    intSmall(3),
    SEQ(OID(OIDS.data), CTX(0, OCT(authenticatedSafe))),
    macData
  );
}

module.exports = {
  Pkcs12Error,
  probe,
  parse,
  build,
  OIDS,
  // düşük seviye — testler ve ileri kullanım için
  pkcs12Kdf,
  toBmpString,
  rc2,
  derToPem,
  pemToDer
};
