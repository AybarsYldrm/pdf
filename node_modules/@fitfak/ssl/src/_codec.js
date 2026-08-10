'use strict';
/**
 * Dahili kodlama yardımcıları (base64url ↔ Buffer ↔ BigInt).
 * Bu dosya PUBLIC API'nin bir parçası DEĞİLDİR — sadece rsa.js / ec.js /
 * keys.js gibi modüllerin `node:crypto` JWK/DER içe-dışa aktarımı için
 * ortak kullandığı iç yardımcıları barındırır. index.js tarafından ihraç
 * edilmez.
 */

/** BigInt'i `len` baytlık (baştan sıfır dolgulu) Buffer'a çevirir. */
function bigIntToBuf(v, len) {
  let hex = v.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const buf = Buffer.from(hex, 'hex');
  if (len === undefined) return buf;
  if (buf.length > len) return buf.subarray(buf.length - len);
  const out = Buffer.alloc(len);
  buf.copy(out, len - buf.length);
  return out;
}

/** Buffer'ı işaretsiz BigInt'e çevirir. */
function bufToBigInt(buf) {
  let v = 0n;
  for (const b of buf) v = (v << 8n) | BigInt(b);
  return v;
}

/** BigInt'i base64url (JWK) dizgesine çevirir. `len` verilirse sabit uzunlukta doldurulur. */
function bigIntToB64Url(v, len) {
  return bigIntToBuf(v, len).toString('base64url');
}

/** base64url (JWK) dizgesini BigInt'e çevirir. */
function b64UrlToBigInt(s) {
  return bufToBigInt(Buffer.from(s, 'base64url'));
}

/** base64url (JWK) dizgesini ham Buffer'a çevirir. */
function b64UrlToBuf(s) {
  return Buffer.from(s, 'base64url');
}

/** Buffer'ı base64url (JWK) dizgesine çevirir. */
function bufToB64Url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** PEM gövdesini (BEGIN/END satırları hariç) ham DER Buffer'a çevirir. */
function pemToDer(pem) {
  const b64 = pem
    .split('\n')
    .map(l => l.trim())
    .filter(line => line && !line.startsWith('-----'))
    .join('');
  return Buffer.from(b64, 'base64');
}

/** DER Buffer'ı belirtilen etiketle PEM'e sarmalar. */
function derToPem(der, label) {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

module.exports = {
  bigIntToBuf, bufToBigInt,
  bigIntToB64Url, b64UrlToBigInt,
  b64UrlToBuf, bufToB64Url,
  pemToDer, derToPem,
};
