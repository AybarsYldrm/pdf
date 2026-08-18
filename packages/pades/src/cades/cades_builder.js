'use strict';

const crypto = require('crypto');
const { DER } = require('./asn1_der');
const { OIDS, digestOidByName, rsaSigOidByHash, ecdsaSigOidByHash } = require('./oids');
const { pemToDer, parseCertBasics } = require('./x509_extract');

// 1. ADOBE'NİN İSTEDİĞİ 3 KATMANLI SEQUENCE DÜZELTMESİ (SigningCertificateV2)
function buildSigningCertificateV2(certDer, hashName = 'sha256') {
  const certHash = crypto.createHash(hashName).update(certDer).digest();
  const { issuerFullDER, serialContent } = parseCertBasics(certDer);
  
  const directoryName = DER.ctxExplicit(4, DER.any(issuerFullDER));
  const generalNames = DER.seq(directoryName);
  const issuerSerial = DER.seq(generalNames, DER.intFromBuf(serialContent));
  
  let essCertIdV2;
  // Adobe, sha256'nın (varsayılan değerin) açıkça yazılmamasını ister
  if (hashName === 'sha256') {
      essCertIdV2 = DER.seq(DER.octet(certHash), issuerSerial);
  } else {
      // Başka bir hash ise her zaman NULL parametresi ekle
      essCertIdV2 = DER.seq(DER.algo(digestOidByName(hashName), true), DER.octet(certHash), issuerSerial);
  }

  // KRİTİK: Tam 3 adet iç içe SEQUENCE olması gerekiyor
  const certs = DER.seq(essCertIdV2); 
  const signingCertificateV2 = DER.seq(certs); 
  
  return DER.seq(DER.oid(OIDS.signingCertificateV2), DER.set(signingCertificateV2));
}

function buildContentTypeAttr() { 
  return DER.seq(DER.oid(OIDS.contentType), DER.set(DER.oid(OIDS.data))); 
}

function buildMessageDigestAttr(hashBuf) { 
  return DER.seq(DER.oid(OIDS.messageDigest), DER.set(DER.octet(hashBuf))); 
}

/**
 * @param {object|null} policy - EPES (Explicit Policy) yapılandırması. null/undefined ise
 *   imza PAdES/CAdES-BES olarak kalır (hiçbir SignaturePolicyId attribute'u eklenmez).
 *   Verilirse PAdES/CAdES-EPES üretilir ve şu alanlar ZORUNLUDUR:
 *     - oid:         sizin/kurumunuzun tescilli signature policy OID'i (örn. kendi IANA PEN'iniz)
 *     - hashBuffer:  yayınladığınız policy dokümanının GERÇEK hash'i (aşağıdaki hashName ile hesaplanmış)
 *     - uri:         policy dokümanının barındırıldığı public URL (SPuri qualifier)
 *   opsiyonel:
 *     - hashName:        'sha256' | 'sha384' | 'sha512' (varsayılan sha256)
 *     - userNoticeText:  SPUserNotice.explicitText olarak eklenecek kısa okunabilir açıklama
 */
function buildSignedAttrs(tbsHash, leafCertDer, hashName, policy = null) {
  const attrs = [
    buildContentTypeAttr(),
    buildMessageDigestAttr(tbsHash),
    buildSigningCertificateV2(leafCertDer, hashName)
  ];

  if (policy) {
    attrs.push(buildEPESPolicyAttribute(policy));
  }

  const toSign = DER.set(...attrs);
  const forCms = DER.retagImplicit(toSign, 0xA0); // [0] IMPLICIT

  return { toSign, forCms };
}

function signSignedAttrs(signedAttrs, keyPem, hashName, keyType) {
  const toSign = signedAttrs.toSign ?? signedAttrs;
  if (keyType === 'rsa') { 
    const s = crypto.createSign(`RSA-${hashName.toUpperCase()}`); 
    s.update(toSign); 
    return s.sign(keyPem); 
  }
  if (keyType === 'ecdsa') { 
    const s = crypto.createSign(hashName.toUpperCase()); 
    s.update(toSign); 
    return s.sign({ key: keyPem }); 
  }
  throw new Error('keyType must be rsa|ecdsa');
}

// 2. ECDSA İÇİN NULL PARAMETRESİNİ KALDIRAN DÜZELTME
function buildSignerInfo_issuerSerial(leafCertDer, signature, signedAttrsForCms, keyType, hashName) {
  const { issuerFullDER, serialContent } = parseCertBasics(leafCertDer);
  const sid = DER.seq(DER.any(issuerFullDER), DER.intFromBuf(serialContent));
  
  // ADOBE KATI PROFİL KURALI: ECDSA için NULL parametresi OLMAMALIDIR (RFC 5754).
  // RSA için ise NULL parametresi zorunludur.
  // YENİ:
const isRsa = keyType === 'rsa';
const digestAlg = DER.algo(digestOidByName(hashName), true);   // NULL her zaman eklenir
const sigAlgOid = isRsa ? rsaSigOidByHash(hashName) : ecdsaSigOidByHash(hashName);
const sigAlg = DER.algo(sigAlgOid, true);                        // NULL her zaman eklenir
  
  return DER.seq(
    DER.intFromBuf(Buffer.from([0x01])), // version 1
    sid,
    digestAlg,
    DER.any(signedAttrsForCms),
    sigAlg,
    DER.octet(signature)
  );
}

/**
 * SigPolicyQualifierInfo ::= SEQUENCE { sigPolicyQualifierId OID, sigQualifier ANY }
 * spuri qualifier: policy dokümanının barındırıldığı gerçek, herkese açık URL.
 */
function buildSigPolicyQualifierUri(uri) {
  return DER.seq(DER.oid(OIDS.spqEtsUri), DER.ia5(uri));
}

/**
 * sp-user-notice qualifier: SPUserNotice ::= SEQUENCE { noticeRef OPTIONAL, explicitText OPTIONAL }
 * Burada sadece explicitText (DisplayText -> utf8String) kullanılıyor; bazı validator'lar
 * (ör. DSS tabanlı doğrulayıcılar) bu metni kullanıcıya doğrudan gösterir.
 */
function buildSigPolicyQualifierUserNotice(explicitText) {
  const spUserNotice = DER.seq(DER.utf8Str(explicitText));
  return DER.seq(DER.oid(OIDS.spqEtsUserNotice), spUserNotice);
}

/**
 * PAdES-EPES (Explicit Policy) için signature-policy-identifier signed attribute'unu üretir.
 * RFC 5126 / ETSI TS 101 733:
 *   SignaturePolicyId ::= SEQUENCE {
 *     sigPolicyId          SigPolicyId,               -- OID (kendi tescilli policy OID'iniz)
 *     sigPolicyHash        SigPolicyHash,              -- OtherHashAlgAndValue
 *     sigPolicyQualifiers  SEQUENCE OF SigPolicyQualifierInfo OPTIONAL
 *   }
 *
 * @param {object} policy
 * @param {string} policy.oid          - Sizin/kurumunuzun tescilli signature policy OID'i.
 * @param {Buffer} policy.hashBuffer   - policy.uri'de yayınlanan dokümanın GERÇEK hash'i.
 * @param {string} policy.uri          - Policy dokümanının barındırıldığı public URL.
 * @param {string} [policy.hashName]   - 'sha256' | 'sha384' | 'sha512' (varsayılan: 'sha256').
 * @param {string} [policy.userNoticeText] - Opsiyonel, SPUserNotice.explicitText.
 */
function buildEPESPolicyAttribute(policy) {
  if (!policy || typeof policy !== 'object') {
    throw new Error('EPES policy objesi zorunludur: { oid, hashBuffer, uri, hashName?, userNoticeText? }');
  }
  const { oid, hashBuffer, uri, hashName = 'sha256', userNoticeText } = policy;
  if (!oid) throw new Error('EPES: policy.oid zorunludur (kendi tescilli signature policy OID\'iniz).');
  if (!Buffer.isBuffer(hashBuffer) || hashBuffer.length === 0) {
    throw new Error('EPES: policy.hashBuffer zorunludur (yayınladığınız policy dokümanının gerçek hash\'i).');
  }
  if (!uri) throw new Error('EPES: policy.uri zorunludur (validator\'ların policy dokümanına ulaşabileceği URL).');

  const sigPolicyIdOid = DER.oid(oid);
  const hashAlgId = DER.algo(digestOidByName(hashName), true); // AlgorithmIdentifier + NULL
  const sigPolicyHash = DER.seq(hashAlgId, DER.octet(hashBuffer)); // OtherHashAlgAndValue

  const qualifiers = [buildSigPolicyQualifierUri(uri)];
  if (userNoticeText) {
    qualifiers.push(buildSigPolicyQualifierUserNotice(userNoticeText));
  }
  const sigPolicyQualifiers = DER.seq(...qualifiers);

  const signaturePolicyId = DER.seq(sigPolicyIdOid, sigPolicyHash, sigPolicyQualifiers);

  // signature-policy-identifier Attribute ::= SEQUENCE { id-aa-ets-sigPolicyId, SET { SignaturePolicyId } }
  return DER.seq(DER.oid(OIDS.sigPolicyId), DER.set(signaturePolicyId));
}

// 3. SIGNED DATA İÇİN DE DİNAMİK NULL DÜZELTMESİ
function buildSignedData(digestHashName, certsDerArray, signerInfoDer, keyType) {
  // ADOBE KATI PROFİL KURALI: DigestAlgorithms kümesi için RSA ise NULL, ECDSA ise NULL yok.
  // YENİ:
const isRsa = keyType === 'rsa';
const digestAlgs = DER.set(DER.algo(digestOidByName(digestHashName), true)); // NULL her zaman eklenir
  
  const eci = DER.seq(DER.oid(OIDS.data)); // detached
  const certSet = DER.set(...certsDerArray.map(der => DER.any(der)));
  const certsImplicit = DER.retagImplicit(certSet, 0xA0); // [0] IMPLICIT
  const signerInfos = DER.set(signerInfoDer);
  const sd = DER.seq(DER.intFromBuf(Buffer.from([0x01])), digestAlgs, eci, certsImplicit, signerInfos);
  return DER.seq(DER.oid(OIDS.signedData), DER.ctxExplicit(0, sd));
}

// 4. ANA İMZALAMA FONKSİYONU
// policy: null ise BES üretilir; { oid, hashBuffer, uri, hashName?, userNoticeText? } verilirse EPES üretilir.
function buildCAdES_BES_auto(tbsHash, keyPem, leafCertPem, chainCertPems = [], policy = null) {
  const leafDer = pemToDer(leafCertPem);
  const { spkiAlgOid, ecCurveOid, recommendedHash } = parseCertBasics(leafDer);
  let keyType, hashName = recommendedHash;
  
  if (spkiAlgOid === OIDS.idEcPublicKey) keyType = 'ecdsa';
  else if (spkiAlgOid === OIDS.rsaEncryption) { keyType = 'rsa'; hashName = 'sha256'; }
  else throw new Error('Unsupported SPKI alg OID: ' + spkiAlgOid);
  
  const need = (hashName === 'sha256' ? 32 : hashName === 'sha384' ? 48 : 64);
  if (tbsHash.length !== need) throw new Error(`tbsHash must be ${hashName} (${need} bytes), got ${tbsHash.length}`);
  
  // policy verilmişse EPES, verilmemişse (null) BES üretilir
  const signedAttrs = buildSignedAttrs(tbsHash, leafDer, hashName, policy);
  
  const signature = signSignedAttrs(signedAttrs, keyPem, hashName, keyType);
  const signerInfo = buildSignerInfo_issuerSerial(leafDer, signature, signedAttrs.forCms, keyType, hashName);
  const chainDer = chainCertPems.map(p => pemToDer(p));
  
  const cmsBES = buildSignedData(hashName, [leafDer, ...chainDer], signerInfo, keyType);
  
  return { cmsBES, signerInfo, signatureValue: signature, hashName, keyType, leafDer, chainDer, signedAttrs };
}

function addUnsignedAttr_signatureTimeStampToken(signerInfoDer, tsTokenDer) {
  const attr = DER.seq(DER.oid(OIDS.signatureTimeStampToken), DER.set(DER.any(tsTokenDer)));
  const unsignedSet = DER.set(attr);
  const unsignedImplicit = DER.retagImplicit(unsignedSet, 0xA1); // [1]
  const tlv = readTLV_local(signerInfoDer, 0);
  if (tlv.tag !== 0x30) throw new Error('signerInfo not SEQ');
  const body = signerInfoDer.slice(tlv.start, tlv.end);
  return DER.seq(DER.any(Buffer.concat([body, unsignedImplicit])));
}

// tiny local TLV reader
function readTLV_local(buf, pos) {
  const t = buf[pos]; let l = buf[pos+1], lenBytes = 1;
  if (l & 0x80) { const n = l & 0x7F; l = 0; for(let i=0; i<n; i++) l = (l<<8) | buf[pos+2+i]; lenBytes = 1+n; }
  const start = pos + 1 + lenBytes, end = start + l;
  return { tag: t, start, end, next: end };
}

module.exports = {
  buildCAdES_BES_auto,
  addUnsignedAttr_signatureTimeStampToken,
  buildSignedData,
  buildEPESPolicyAttribute
};