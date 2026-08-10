'use strict';
/**
 * ASN.1 / DER kodlama yardımcıları.
 * X.509 sertifika, CSR ve CRL oluşturma için gerekli tüm ilkeller.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Temel DER ilkeller
// ─────────────────────────────────────────────────────────────────────────────
function encLen(len) {
  if (len < 0x80) return Buffer.from([len]);
  let h = len.toString(16);
  if (h.length % 2) h = '0' + h;
  return Buffer.concat([Buffer.from([0x80 | (h.length >> 1)]), Buffer.from(h, 'hex')]);
}

function tlv(tag, content) {
  const c = Buffer.isBuffer(content) ? content : Buffer.alloc(0);
  return Buffer.concat([Buffer.from([tag]), encLen(c.length), c]);
}

const SEQ   = (...parts) => tlv(0x30, Buffer.concat(parts.filter(Boolean)));
const SET   = (...parts) => tlv(0x31, Buffer.concat(parts.filter(Boolean)));
const BIT   = buf => tlv(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
const OCT   = buf => tlv(0x04, buf);
const NULL  = ()  => tlv(0x05, Buffer.alloc(0));
/**
 * OBJECT IDENTIFIER TLV'si üretir.
 * Girdi olarak ŞUNLARIN HEPSİ kabul edilir (bkz. oid.js#normalizeOid):
 *   OID('timeStamping')                    // bilinen ad
 *   OID('1.3.6.1.4.1.65133.1.1')           // noktalı-ondalık (ÖNERİLEN)
 *   OID('2b 06 01 04 01 83 fc 6d 01 01')   // boşluklu hex
 *   OID('2b0601040183fc6d0101')            // düz hex (eski kullanım)
 * Böylece kurumsal PEN OID'leri için elle DER hesabı yapmak GEREKMEZ.
 */
const OID   = input => tlv(0x06, Buffer.from(normalizeOid(input), 'hex'));
const UTF8  = str => tlv(0x0c, Buffer.from(str, 'utf8'));
const PRINT = str => tlv(0x13, Buffer.from(str, 'ascii'));
const BOOL  = val => tlv(0x01, Buffer.from([val ? 0xff : 0x00]));
const ENUM  = val => tlv(0x0a, Buffer.from([val]));
const CTX   = (n, c) => tlv(0xa0 | n, c);
const CTXI  = (n, c) => tlv(0x80 | n, c);

function INT(bigInt) {
  if (typeof bigInt === 'number') bigInt = BigInt(bigInt);
  let hex = bigInt.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let buf = Buffer.from(hex, 'hex');
  if (buf[0] >= 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf]);
  return tlv(0x02, buf);
}

function intSmall(v) { return tlv(0x02, Buffer.from([v & 0xff])); }

function UTCTime(d) {
  const p = n => String(n).padStart(2, '0');
  const s = `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s));
}

function GenTime(d) {
  const p = n => String(n).padStart(2, '0');
  const s = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x18, Buffer.from(s));
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal DER okuyucu (parser) — sertifika/CSR/CRL/OCSP çözümleme için
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Tek bir TLV düğümünü `off` konumundan okur.
 * @returns {{ tag:number, len:number, headerLen:number, contentOff:number, totalLen:number, content:Buffer }}
 */
function readTLV(buf, off = 0) {
  if (off >= buf.length) throw new Error('DER: beklenmeyen veri sonu');
  const tag = buf[off];
  let p = off + 1;
  let len = buf[p++];
  if (len & 0x80) {
    const ll = len & 0x7f;
    if (ll === 0) throw new Error('DER: belirsiz uzunluk desteklenmiyor');
    len = 0;
    for (let i = 0; i < ll; i++) len = (len * 256) + buf[p++];
  }
  const contentOff = p;
  const totalLen = (contentOff - off) + len;
  return {
    tag, len, headerLen: contentOff - off, contentOff,
    totalLen, content: buf.subarray(contentOff, contentOff + len),
  };
}

/** Bir SEQUENCE/SET içeriğindeki tüm üst-seviye TLV düğümlerini döner. */
function readChildren(content) {
  const out = [];
  let off = 0;
  while (off < content.length) {
    const node = readTLV(content, off);
    out.push(node);
    off += node.totalLen;
  }
  return out;
}

/** DER INTEGER içeriğini bigint'e çevirir (işaretsiz, X.509 seri no vb. için). */
function derIntToBigInt(content) {
  let v = 0n;
  for (const b of content) v = (v << 8n) | BigInt(b);
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// OID tablosu — kanonik kayıt defteri ./oid.js içindedir (tek referans
// kaynağı). Burada AYNI ŞEKİLDE (`OIDs`, `KU`) geriye dönük uyumlu olarak
// yeniden ihraç edilir; ./oid.js önceki tablodan çok daha fazla OID içerir
// (EKU amaçları, CRL/OCSP sabitleri, isim bileşenleri vb.).
// ─────────────────────────────────────────────────────────────────────────────
const {
  OIDs, KU, REASON, REASON_NAMES, GENERAL_NAME_TAG,
  nameToOid, oidToName, encodeOid, decodeOidHex, normalizeOid,
} = require('./oid');

// ─────────────────────────────────────────────────────────────────────────────
// SPKI (Subject Public Key Info) oluşturucular
// ─────────────────────────────────────────────────────────────────────────────
function buildRsaSPKI(n, e) {
  const rsaAlg = SEQ(OID(OIDs.rsaEncryption), NULL());
  const pubKey = BIT(SEQ(INT(n), INT(e)));
  return SEQ(rsaAlg, pubKey);
}

function buildEcSPKI(curveName, pubKeyBuf) {
  const { CURVES } = require('./ec');
  const curve = CURVES[curveName];
  if (!curve) throw new Error(`SPKI: bilinmeyen eğri ${curveName}`);
  const ecAlg = SEQ(OID(OIDs.ecPublicKey), OID(curve.oidCurve));
  return SEQ(ecAlg, BIT(pubKeyBuf));
}

// ─────────────────────────────────────────────────────────────────────────────
// İsim (DN) oluşturma
// ─────────────────────────────────────────────────────────────────────────────
function buildName(attrs) {
  return SEQ(...attrs.map(([oid, val]) => {
    const encoded = (oid === OIDs.country) ? PRINT(val) : UTF8(val);
    return SET(SEQ(OID(oid), encoded));
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// SKID (Subject Key Identifier) hesaplama
// ─────────────────────────────────────────────────────────────────────────────
function computeRsaSKID(n, e) {
  const { sha256 } = require('./hash');
  return sha256(SEQ(INT(n), INT(e))).subarray(0, 20);
}

function computeEcSKID(pubKeyBuf) {
  const { sha256 } = require('./hash');
  return sha256(pubKeyBuf).subarray(0, 20);
}

// ─────────────────────────────────────────────────────────────────────────────
// X.509 Uzantı oluşturucular
// ─────────────────────────────────────────────────────────────────────────────
function ext(oid, critical, value) {
  const parts = [OID(oid)];
  if (critical) parts.push(BOOL(true));
  parts.push(OCT(value));
  return SEQ(...parts);
}

function extBasicConstraints(isCA, pathLen) {
  let inner;
  if (!isCA)                   inner = SEQ();
  else if (pathLen !== undefined) inner = SEQ(BOOL(true), intSmall(pathLen));
  else                          inner = SEQ(BOOL(true));
  return ext(OIDs.basicConstraints, true, inner);
}

function extKeyUsage(bits) {
  let v = 0;
  for (const b of bits) v |= (0x80 >> b);
  const maxBit = bits.reduce((m, b) => Math.max(m, b + 1), 0);
  const unused = (maxBit % 8 === 0) ? 0 : (8 - maxBit % 8);
  // İki byte'lık bit dizisi (KeyUsage en fazla 9 bit)
  const bytes = v > 0xff
    ? [unused, (v >> 8) & 0xff, v & 0xff]
    : [unused, v & 0xff];
  // Kullanılmayan bit konumlarındaki bitler sıfır olmalı (DER kuralı)
  bytes[bytes.length - 1] &= (0xff << unused) & 0xff;
  return ext(OIDs.keyUsage, true, tlv(0x03, Buffer.from(bytes)));
}

/**
 * Extended Key Usage (RFC 5280 §4.2.1.12).
 * @param {string[]} oids      Ad / noktalı-ondalık / hex — hepsi kabul edilir
 *                             (ör. ['serverAuth','clientAuth'] veya ['1.3.6.1.5.5.7.3.8'])
 * @param {boolean} [critical=false]  TSA gibi profillerde `true` yapılmalıdır
 */
function extEKU(oids, critical = false) {
  return ext(OIDs.extKeyUsage, critical, SEQ(...oids.map(o => OID(o))));
}

/**
 * Certificate Policies (RFC 5280 §4.2.1.4) — CPS URI ve User Notice destekli.
 *
 * Girdi biçimleri (hepsi kabul edilir):
 *   extCertificatePolicies('1.3.6.1.4.1.65133.1.1')
 *   extCertificatePolicies(['1.3.6.1.4.1.65133.1.1', 'anyPolicy'])
 *   extCertificatePolicies([{
 *     oid: '1.3.6.1.4.1.65133.1.1',
 *     cps: 'https://fitfak.com/cps',              // veya cps: [url1, url2]
 *     notice: 'Bu sertifika FITFAK politikalarına tabidir.',
 *     // ya da ayrıntılı biçim:
 *     // notice: { text: '...', organization: 'FITFAK', noticeNumbers: [1,2] }
 *   }])
 *
 * @param {string|object|Array<string|object>} policies
 * @param {boolean} [critical=false]
 */
function extCertificatePolicies(policies, critical = false) {
  const list = Array.isArray(policies) ? policies : [policies];
  const infos = list.map(p => {
    const spec = (typeof p === 'string') ? { oid: p } : p;
    if (!spec || !spec.oid) throw new Error('extCertificatePolicies: her politika bir `oid` içermelidir');

    const quals = [];

    // id-qt-cps (1.3.6.1.5.5.7.2.1) — CPS Pointer (IA5String URI)
    const cpsList = spec.cps === undefined ? []
      : (Array.isArray(spec.cps) ? spec.cps : [spec.cps]);
    for (const url of cpsList) {
      quals.push(SEQ(OID('1.3.6.1.5.5.7.2.1'), tlv(0x16, Buffer.from(url, 'ascii'))));
    }

    // id-qt-unotice (1.3.6.1.5.5.7.2.2) — UserNotice
    if (spec.notice !== undefined && spec.notice !== null) {
      const n = (typeof spec.notice === 'string') ? { text: spec.notice } : spec.notice;
      const noticeParts = [];
      // NoticeReference ::= SEQUENCE { organization DisplayText, noticeNumbers SEQUENCE OF INTEGER }
      if (n.organization !== undefined) {
        const numbers = (n.noticeNumbers || []).map(num => intSmall(num));
        noticeParts.push(SEQ(UTF8(n.organization), SEQ(...numbers)));
      }
      if (n.text !== undefined) noticeParts.push(UTF8(n.text));
      quals.push(SEQ(OID('1.3.6.1.5.5.7.2.2'), SEQ(...noticeParts)));
    }

    // PolicyInformation ::= SEQUENCE { policyIdentifier, policyQualifiers OPTIONAL }
    return quals.length
      ? SEQ(OID(spec.oid), SEQ(...quals))
      : SEQ(OID(spec.oid));
  });
  return ext(OIDs.certificatePolicies, critical, SEQ(...infos));
}

function extSKID(skid) { return ext(OIDs.subjectKeyId, false, OCT(skid)); }
function extAKID(akid) { return ext(OIDs.authorityKeyId, false, SEQ(CTXI(0, akid))); }

function extSAN(names, critical = false) {
  const gnames = names.map(n => {
    if (n.type === 'dns')   return CTXI(2, Buffer.from(n.value, 'ascii'));
    if (n.type === 'ip')    return CTXI(7, Buffer.from(n.value.split('.').map(Number)));
    if (n.type === 'email') return CTXI(1, Buffer.from(n.value, 'ascii'));
    if (n.type === 'uri')   return CTXI(6, Buffer.from(n.value, 'ascii'));
    throw new Error(`SAN: bilinmeyen tür ${n.type}`);
  });
  return ext(OIDs.subjectAltName, critical, SEQ(...gnames));
}

function extCDP(urls, critical = false) {
  const list = Array.isArray(urls) ? urls : [urls];
  const dps = list.map(u => SEQ(CTX(0, CTX(0, CTXI(6, Buffer.from(u, 'ascii'))))));
  return ext(OIDs.crlDistPoints, critical, SEQ(...dps));
}

function extAIA(ocspUrl, caIssuersUrl, critical = false) {
  const asList = (v) => (v === undefined || v === null || v === '') ? [] : (Array.isArray(v) ? v : [v]);
  const parts = [];
  for (const u of asList(ocspUrl))      parts.push(SEQ(OID(OIDs.ocsp),      CTXI(6, Buffer.from(u, 'ascii'))));
  for (const u of asList(caIssuersUrl)) parts.push(SEQ(OID(OIDs.caIssuers), CTXI(6, Buffer.from(u, 'ascii'))));
  return ext(OIDs.authorityInfoAccess, critical, SEQ(...parts));
}

// ─────────────────────────────────────────────────────────────────────────────
// İmza algoritması tanımlayıcısı
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {'rsa'|'ec'} keyType
 * @param {'sha256'|'sha384'|'sha512'} hashAlg
 * @param {string} [curveName]
 */
function algId(keyType, hashAlg, curveName) {
  if (keyType === 'rsa') {
    const oidMap = {
      sha256: OIDs.sha256WithRSAEncryption,
      sha384: OIDs.sha384WithRSAEncryption,
      sha512: OIDs.sha512WithRSAEncryption,
    };
    const o = oidMap[hashAlg];
    if (!o) throw new Error(`RSA algId: bilinmeyen hash ${hashAlg}`);
    return SEQ(OID(o), NULL());   // RSA → parameters = NULL
  }
  if (keyType === 'ec') {
    const { CURVES } = require('./ec');
    const curve = CURVES[curveName];
    if (!curve) throw new Error(`EC algId: bilinmeyen eğri ${curveName}`);
    return SEQ(OID(curve.oidSig));  // ECDSA → parameters ABSENT
  }
  throw new Error(`algId: bilinmeyen anahtar türü ${keyType}`);
}

module.exports = {
  // İlkeller
  tlv, SEQ, SET, BIT, OCT, NULL, OID, UTF8, PRINT, BOOL, ENUM, INT, intSmall,
  CTX, CTXI, UTCTime, GenTime,
  // DER okuyucu (parser)
  readTLV, readChildren, derIntToBigInt,
  // OID tablosu, KU ve genişletilmiş kayıt defteri yardımcıları (bkz. oid.js)
  OIDs, KU, REASON, REASON_NAMES, GENERAL_NAME_TAG,
  nameToOid, oidToName, encodeOid, decodeOidHex, normalizeOid,
  // SPKI / isim
  buildRsaSPKI, buildEcSPKI, buildName,
  computeRsaSKID, computeEcSKID,
  // Uzantılar
  ext, extBasicConstraints, extKeyUsage, extEKU,
  extSKID, extAKID, extSAN, extCDP, extAIA, extCertificatePolicies,
  // İmza algoritması tanımlayıcısı
  algId,
};