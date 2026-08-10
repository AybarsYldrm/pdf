'use strict';
/**
 * Sertifika Zinciri Oluşturma ve Doğrulama.
 *
 * Önceki sürümde bir zinciri (leaf → intermediate(ler) → root) uçtan uca
 * doğrulayan bir fonksiyon YOKTU — her sertifika ayrı ayrı üretilebiliyor
 * ama zincir bütünlüğü (imza, geçerlilik tarihi, CA/pathLen kısıtlaması,
 * KeyUsage) hiç kontrol edilmiyordu.
 *
 * Bu modül, gerçek imza/tarih doğrulamasını doğrudan `node:crypto`'nun
 * `X509Certificate` sınıfına (`.verify()`, `.checkIssued()`) devreder — bu,
 * "crypto modülüne yakınlaştırma" isteğinin doğrudan bir uygulamasıdır.
 * `X509Certificate.keyUsage`'ın (Node'da normalde extKeyUsage OID listesini
 * döndürdüğü, temel KeyUsage bit dizisini DEĞİL) belirsizliğinden kaçınmak
 * için, temel KeyUsage/BasicConstraints/pathLen kontrolleri kendi hafif
 * ASN.1 okuyucumuzla (asn1.js) yapılır — bu saf yapısal ayrıştırmadır,
 * kriptografik bir işlem değildir.
 */
const crypto = require('node:crypto');
const { readTLV, readChildren, OIDs } = require('./asn1');
const { pemToDer } = require('./_codec');

function _toX509(input) {
  if (input instanceof crypto.X509Certificate) return input;
  const der = Buffer.isBuffer(input) ? input : (typeof input === 'string' && input.includes('BEGIN') ? input : pemToDer(input));
  return new crypto.X509Certificate(der);
}

/** Bir sertifikanın X509v3 uzantılarını { oidHex → {critical, valueDer} } biçiminde ayrıştırır. */
function _parseExtensions(x509) {
  const der = x509.raw;
  const top = readTLV(der, 0);
  const certChildren = readChildren(top.content);
  const tbs = certChildren[0];
  const tbsChildren = readChildren(tbs.content);
  const extsCtx = tbsChildren.find(n => n.tag === 0xa3);
  const out = {};
  if (!extsCtx) return out;
  const extsSeq = readTLV(extsCtx.content, 0);
  for (const extNode of readChildren(extsSeq.content)) {
    const children = readChildren(extNode.content);
    const oidHex = children[0].content.toString('hex');
    let critical = false;
    let valueNode = children[1];
    if (children[1].tag === 0x01) { critical = children[1].content[0] !== 0; valueNode = children[2]; }
    out[oidHex] = { critical, valueDer: valueNode.content };
  }
  return out;
}

/** BasicConstraints uzantısını { isCA, pathLen } olarak çözer (yoksa isCA:false). */
function _basicConstraints(exts) {
  const e = exts[OIDs.basicConstraints];
  if (!e) return { isCA: false, pathLen: undefined };
  const seq = readTLV(e.valueDer, 0);
  const children = readChildren(seq.content);
  const isCA = children.length > 0 && children[0].tag === 0x01 && children[0].content[0] !== 0;
  const plNode = children.find(c => c.tag === 0x02);
  const pathLen = plNode ? plNode.content.reduce((a, b) => a * 256 + b, 0) : undefined;
  return { isCA, pathLen };
}

/** KeyUsage BIT STRING'ini { digitalSignature, keyCertSign, cRLSign, ... } bool haritasına çözer. */
function _keyUsage(exts) {
  const e = exts[OIDs.keyUsage];
  const names = ['digitalSignature', 'nonRepudiation', 'keyEncipherment', 'dataEncipherment', 'keyAgreement', 'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly'];
  const out = Object.fromEntries(names.map(n => [n, false]));
  if (!e) return out;
  const bs = readTLV(e.valueDer, 0);
  const bytes = bs.content.subarray(1); // ilk bayt = kullanılmayan bit sayacı
  let bitIdx = 0;
  for (const byte of bytes) {
    for (let b = 0; b < 8; b++) {
      if (names[bitIdx]) out[names[bitIdx]] = (byte & (0x80 >> b)) !== 0;
      bitIdx++;
    }
  }
  return out;
}

/**
 * Tek bir "issued-by" bağlantısını doğrular: `cert`'in gerçekten
 * `issuerCert` tarafından imzalandığını, isim eşleşmesini ve KeyUsage
 * (keyCertSign) / BasicConstraints (CA:TRUE, pathLen) kısıtlamalarını
 * kontrol eder.
 * @returns {{ ok: boolean, errors: string[] }}
 */
function verifyLink(certInput, issuerInput, opts = {}) {
  const cert = _toX509(certInput);
  const issuer = _toX509(issuerInput);
  const errors = [];

  if (!cert.checkIssued(issuer)) errors.push('issuer/subject adı veya AKID/SKID eşleşmiyor (checkIssued=false)');
  let sigOk = false;
  try { sigOk = cert.verify(issuer.publicKey); } catch (e) { errors.push(`imza doğrulama hatası: ${e.message}`); }
  if (!sigOk) errors.push('imza geçersiz (issuer public key ile doğrulanamadı)');

  const issuerExts = _parseExtensions(issuer);
  const bc = _basicConstraints(issuerExts);
  if (!issuer.ca && !bc.isCA) errors.push('issuer, CA sertifikası değil (BasicConstraints.CA != TRUE)');
  const ku = _keyUsage(issuerExts);
  if (issuerExts[OIDs.keyUsage] && !ku.keyCertSign) errors.push('issuer KeyUsage.keyCertSign biti işaretli değil');

  const at = opts.at || new Date();
  if (at < issuer.validFromDate || at > issuer.validToDate) errors.push('issuer sertifikası verilen tarihte geçerli değil (geçerlilik dışı)');
  if (at < cert.validFromDate || at > cert.validToDate) errors.push('sertifika verilen tarihte geçerli değil (geçerlilik dışı)');

  return { ok: errors.length === 0, errors };
}

/**
 * Tam bir zinciri (leaf → ara CA'lar → güvenilen kök) doğrular.
 * Zincir, `leaf`'ten başlayarak her sertifikanın bir SONRAKİ (issuer)
 * tarafından imzalandığı varsayılarak `chain` dizisi ile birlikte kurulur;
 * en sonunda `trustedRoots` içindeki bir sertifikaya ulaşılmalıdır.
 *
 * @param {string|Buffer} leafCert
 * @param {Array<string|Buffer>} [intermediates]  issuer sırasına göre (leaf'e en yakın önce)
 * @param {Array<string|Buffer>} trustedRoots
 * @param {{ at?: Date, requireHostname?: string }} [opts]
 * @returns {{ ok: boolean, errors: string[], chain: object[], rootMatched: boolean }}
 */
function verifyChain(leafCert, intermediates = [], trustedRoots = [], opts = {}) {
  const errors = [];
  const chainX509 = [_toX509(leafCert), ...intermediates.map(_toX509)];
  const roots = trustedRoots.map(_toX509);

  if (opts.requireHostname) {
    try {
      if (!chainX509[0].checkHost(opts.requireHostname)) {
        errors.push(`leaf sertifikası '${opts.requireHostname}' için geçerli değil (checkHost başarısız)`);
      }
    } catch (e) {
      errors.push(`checkHost hatası: ${e.message}`);
    }
  }

  // Zincir içi bağlantıları doğrula: leaf→inter[0], inter[0]→inter[1], ...
  for (let i = 0; i < chainX509.length - 1; i++) {
    const link = verifyLink(chainX509[i], chainX509[i + 1], opts);
    if (!link.ok) errors.push(...link.errors.map(e => `[zincir #${i}→#${i + 1}] ${e}`));
  }

  // Zincirin son halkasını güvenilen köklerden biriyle eşleştir.
  const last = chainX509[chainX509.length - 1];
  let rootMatched = false;
  let rootErrors = [];
  for (const root of roots) {
    // Son sertifikanın kendisi zaten güvenilen bir kök olabilir (ör. tek-CA senaryosu).
    if (Buffer.compare(last.raw, root.raw) === 0) { rootMatched = true; break; }
    const link = verifyLink(last, root, opts);
    if (link.ok) { rootMatched = true; break; }
    rootErrors = link.errors;
  }
  if (!rootMatched) {
    errors.push(roots.length === 0
      ? 'trustedRoots boş — hiçbir güvenilen kök verilmedi'
      : `zincir hiçbir güvenilen köke ulaşmıyor (son denemedeki hatalar: ${rootErrors.join('; ')})`);
  }

  return { ok: errors.length === 0, errors, chain: chainX509, rootMatched };
}

/** Bir sertifikanın (PEM/DER/X509Certificate) `node:crypto` X509Certificate nesnesini döner — hızlı inceleme için. */
function inspect(certInput) {
  const x509 = _toX509(certInput);
  const exts = _parseExtensions(x509);
  return {
    subject: x509.subject, issuer: x509.issuer,
    validFrom: x509.validFromDate, validTo: x509.validToDate,
    serialNumber: x509.serialNumber, fingerprint256: x509.fingerprint256,
    ca: x509.ca, basicConstraints: _basicConstraints(exts), keyUsage: _keyUsage(exts),
    x509,
  };
}

module.exports = { verifyChain, verifyLink, inspect };
