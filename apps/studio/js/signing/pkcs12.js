/**
 * Tarayıcı içi PKCS#12 açma ve imzalama.
 *
 * VARSAYILAN GÜVENLİK DURUŞU: özel anahtar tarayıcıdan çıkmaz.
 *
 *   1. PFX burada açılır (sunucuya gitmez),
 *   2. anahtar WebCrypto'ya `extractable: false` olarak alınır,
 *   3. sunucudan yalnız İMZALANACAK VERİ istenir,
 *   4. imza burada atılır ve sunucuya yalnız imza değeri gider.
 *
 * Not: PKCS#12 çözme (PBES2/PBKDF2/AES) WebCrypto ile yapılır. Eski RC2/3DES
 * şemalı dosyalar tarayıcıda açılamaz; bu durumda kullanıcıya sunucu tarafı
 * modu önerilir (arayüz bunu açıkça söyler).
 */

const enc = new TextEncoder();

class BrowserPkcs12Error extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrowserPkcs12Error';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Minimal DER okuyucu                                                  */
/* ------------------------------------------------------------------ */

function readTLV(buf, pos) {
  const tag = buf[pos];
  let len = buf[pos + 1];
  let lenBytes = 1;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[pos + 2 + i];
    lenBytes = 1 + n;
  }
  const start = pos + 1 + lenBytes;
  return { tag, len, hdr: 1 + lenBytes, start, end: start + len, next: start + len };
}

function children(buf, tlv) {
  const out = [];
  let p = tlv.start;
  while (p < tlv.end) {
    const t = readTLV(buf, p);
    if (t.next <= p) break;
    out.push(t);
    p = t.next;
  }
  return out;
}

function oidOf(buf, tlv) {
  const b = buf.subarray(tlv.start, tlv.end);
  if (!b.length) return '';
  const arcs = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = (v << 7) | (b[i] & 0x7f);
    if (!(b[i] & 0x80)) { arcs.push(v); v = 0; }
  }
  return arcs.join('.');
}

function intOf(buf, tlv) {
  let n = 0;
  for (let i = tlv.start; i < tlv.end; i++) n = (n << 8) | buf[i];
  return n;
}

/* ------------------------------------------------------------------ */
/* PBES2 çözme (WebCrypto)                                              */
/* ------------------------------------------------------------------ */

const PBES2 = '1.2.840.113549.1.5.13';
const PBKDF2 = '1.2.840.113549.1.5.12';
const AES_CBC = {
  '2.16.840.1.101.3.4.1.2': 16,
  '2.16.840.1.101.3.4.1.22': 24,
  '2.16.840.1.101.3.4.1.42': 32
};
const PRF = {
  '1.2.840.113549.2.7': 'SHA-1',
  '1.2.840.113549.2.9': 'SHA-256',
  '1.2.840.113549.2.10': 'SHA-384',
  '1.2.840.113549.2.11': 'SHA-512'
};

async function decryptPbes2(buf, algTlv, cipherText, password) {
  const parts = children(buf, algTlv);
  const oid = oidOf(buf, parts[0]);
  if (oid !== PBES2) {
    throw new BrowserPkcs12Error('ERR_BROWSER_PKCS12_LEGACY',
      'Bu PFX eski bir şifreleme şeması kullanıyor (PBES2 değil). ' +
      'Tarayıcıda açılamaz — "PFX\'i sunucuda çöz" seçeneğini kullanın.');
  }

  const p = children(buf, parts[1]);
  const kdf = children(buf, p[0]);
  if (oidOf(buf, kdf[0]) !== PBKDF2) {
    throw new BrowserPkcs12Error('ERR_BROWSER_PKCS12_KDF', 'Desteklenmeyen PBES2 KDF');
  }

  const kdfParams = children(buf, kdf[1]);
  const salt = buf.slice(kdfParams[0].start, kdfParams[0].end);
  const iterations = intOf(buf, kdfParams[1]);
  let hash = 'SHA-1';
  for (let i = 2; i < kdfParams.length; i++) {
    if (kdfParams[i].tag === 0x30) {
      const prf = children(buf, kdfParams[i]);
      hash = PRF[oidOf(buf, prf[0])] || 'SHA-1';
    }
  }

  const encParts = children(buf, p[1]);
  const keyLen = AES_CBC[oidOf(buf, encParts[0])];
  if (!keyLen) {
    throw new BrowserPkcs12Error('ERR_BROWSER_PKCS12_CIPHER',
      'Bu PFX AES dışında bir şifre kullanıyor. Sunucu tarafı modunu kullanın.');
  }
  const iv = buf.slice(encParts[1].start, encParts[1].end);

  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash },
    baseKey,
    { name: 'AES-CBC', length: keyLen * 8 },
    false,
    ['decrypt']
  );

  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, cipherText);
    return new Uint8Array(plain);
  } catch {
    throw new BrowserPkcs12Error('ERR_BROWSER_PKCS12_BAD_PASSWORD',
      'PFX çözülemedi — parola yanlış olabilir.');
  }
}

/* ------------------------------------------------------------------ */
/* Genel API                                                            */
/* ------------------------------------------------------------------ */

const OIDS = {
  data: '1.2.840.113549.1.7.1',
  encryptedData: '1.2.840.113549.1.7.6',
  keyBag: '1.2.840.113549.1.12.10.1.1',
  shroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
  certBag: '1.2.840.113549.1.12.10.1.3',
  x509: '1.2.840.113549.1.9.22.1'
};

/**
 * PFX'i tarayıcıda açar.
 * @returns {Promise<{ keyDer: Uint8Array, certDers: Uint8Array[] }>}
 */
export async function parsePfx(bytes, password) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  const pfx = readTLV(buf, 0);
  const top = children(buf, pfx);
  const authSafeCi = children(buf, top[1]);
  const octet = readTLV(buf, authSafeCi[1].start);
  const authSafe = readTLV(buf, octet.start);

  const certDers = [];
  let keyDer = null;

  const extractBags = async (safeBuf) => {
    const seq = readTLV(safeBuf, 0);
    for (const bag of children(safeBuf, seq)) {
      const parts = children(safeBuf, bag);
      const oid = oidOf(safeBuf, parts[0]);
      const value = parts[1];

      if (oid === OIDS.certBag) {
        const cb = readTLV(safeBuf, value.start);
        const cbParts = children(safeBuf, cb);
        if (oidOf(safeBuf, cbParts[0]) !== OIDS.x509) continue;
        const oct = readTLV(safeBuf, cbParts[1].start);
        certDers.push(safeBuf.slice(oct.start, oct.end));
      } else if (oid === OIDS.shroudedKeyBag) {
        const epki = readTLV(safeBuf, value.start);
        const ep = children(safeBuf, epki);
        keyDer = await decryptPbes2(safeBuf, ep[0], safeBuf.slice(ep[1].start, ep[1].end), password);
      } else if (oid === OIDS.keyBag) {
        const pki = readTLV(safeBuf, value.start);
        keyDer = safeBuf.slice(value.start, value.start + pki.hdr + pki.len);
      }
    }
  };

  for (const ci of children(buf, authSafe)) {
    const parts = children(buf, ci);
    const oid = oidOf(buf, parts[0]);

    if (oid === OIDS.encryptedData) {
      const ed = readTLV(buf, parts[1].start);
      const edParts = children(buf, ed);
      const eci = children(buf, edParts[1]);
      const plain = await decryptPbes2(buf, eci[1], buf.slice(eci[2].start, eci[2].end), password);
      await extractBags(plain);
    } else if (oid === OIDS.data) {
      const oct = readTLV(buf, parts[1].start);
      await extractBags(buf.slice(oct.start, oct.end));
    }
  }

  if (!keyDer) {
    throw new BrowserPkcs12Error('ERR_BROWSER_PKCS12_NO_KEY',
      'PFX içinde özel anahtar bulunamadı.');
  }
  return { keyDer, certDers };
}

/**
 * PKCS#8 anahtarını WebCrypto'ya DIŞA AKTARILAMAZ olarak alır.
 * `extractable: false` — anahtar bir daha JS tarafından okunamaz.
 */
export async function importSigningKey(keyDer, keyType, hash = 'SHA-256') {
  const algo = keyType === 'ec' || keyType === 'ecdsa'
    ? { name: 'ECDSA', namedCurve: 'P-256' }
    : { name: 'RSASSA-PKCS1-v1_5', hash };

  return crypto.subtle.importKey('pkcs8', keyDer, algo, false, ['sign']);
}

/**
 * Veriyi imzalar. ECDSA için WebCrypto ham (r||s) üretir; CMS DER ister —
 * dönüşüm burada yapılır.
 */
export async function signData(key, data, keyType, hash = 'SHA-256') {
  if (keyType === 'ec' || keyType === 'ecdsa') {
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash }, key, data));
    return rawEcdsaToDer(raw);
  }
  return new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data));
}

/** WebCrypto'nun ham (r||s) ECDSA imzasını DER SEQUENCE'a çevirir. */
function rawEcdsaToDer(raw) {
  const half = raw.length / 2;
  const r = trimInt(raw.slice(0, half));
  const s = trimInt(raw.slice(half));
  const body = new Uint8Array(2 + r.length + 2 + s.length);
  let i = 0;
  body[i++] = 0x02; body[i++] = r.length; body.set(r, i); i += r.length;
  body[i++] = 0x02; body[i++] = s.length; body.set(s, i);

  const out = new Uint8Array(2 + body.length);
  out[0] = 0x30; out[1] = body.length; out.set(body, 2);
  return out;
}

function trimInt(bytes) {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  let v = bytes.slice(i);
  if (v[0] & 0x80) {
    const padded = new Uint8Array(v.length + 1);
    padded.set(v, 1);
    v = padded;
  }
  return v;
}

/** DER sertifikayı PEM'e çevirir. */
export function derToPem(der, label = 'CERTIFICATE') {
  const b64 = btoa(String.fromCharCode.apply(null, der));
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}

export { BrowserPkcs12Error };
