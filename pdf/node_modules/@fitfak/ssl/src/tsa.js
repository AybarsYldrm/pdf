'use strict';

/**
 * RFC 3161 Zaman Damgası Otoritesi (TSA) — CMS SignedData üreten sunucu tarafı.
 *
 * Bu modül, elle yazılmış bir DER kodlayıcı taşıyan bağımsız bir TSA
 * uygulamasının yerini alır. ASN.1 ilkelleri, imzalama ve sertifika
 * ayrıştırma zaten `./asn1`, `./pki` ve `./keys` içinde mevcut ve
 * openssl'e karşı çapraz doğrulanmış durumda; ikinci bir kopya yalnızca
 * ondan sessizce ayrışabilirdi.
 *
 * Yapı:
 *   TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken ContentInfo OPTIONAL }
 *   ContentInfo   ::= SEQUENCE { contentType id-signedData, content [0] SignedData }
 *   SignedData    ::= SEQUENCE { version, digestAlgorithms, encapContentInfo,
 *                                certificates [0] IMPLICIT OPTIONAL, signerInfos }
 *   eContent      = DER(TSTInfo)
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  SEQ, SET, OCT, INT, OID, NULL, BOOL, CTX, tlv,
  GenTime, readTLV, readChildren, OIDs,
} = require('./asn1');
const { pemToDer } = require('./_codec');

// ─────────────────────────────────────────────────────────────────────────────
// OID'ler
// ─────────────────────────────────────────────────────────────────────────────
const TSA_OIDS = {
  ctTSTInfo: '1.2.840.113549.1.9.16.1.4',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  timeStamping: '1.3.6.1.5.5.7.3.8',
};

// İzin verilen özet algoritmaları ve beklenen uzunlukları. SHA-1 KASITEN yok:
// RFC 3161 onu yasaklamaz ama bir zaman damgası, imzalandığı özetin çakışma
// direncini devralır -- SHA-1 özeti üzerine atılmış bir damga, iki farklı
// belgenin aynı anda damgalanmış olduğunu iddia edebilir.
const SHA256_OID = '2.16.840.1.101.3.4.2.1';

const DIGEST_ALGS = {
  '2.16.840.1.101.3.4.2.1': { name: 'sha256', length: 32 },
  '2.16.840.1.101.3.4.2.2': { name: 'sha384', length: 48 },
  '2.16.840.1.101.3.4.2.3': { name: 'sha512', length: 64 },
};

// RFC 3161 §2.4.2 PKIStatus / PKIFailureInfo
const PKI_STATUS = { GRANTED: 0, GRANTED_WITH_MODS: 1, REJECTION: 2 };
const PKI_FAILURE = {
  badAlg: 0, badRequest: 2, badDataFormat: 5,
  timeNotAvailable: 14, unacceptedPolicy: 15, unacceptedExtension: 16, systemFailure: 25,
};

class TsaError extends Error {
  constructor(message, failureInfo = PKI_FAILURE.badRequest) {
    super(message);
    this.name = 'TsaError';
    this.failureInfo = failureInfo;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Seri numarası ayırıcı
// ─────────────────────────────────────────────────────────────────────────────
/**
 * RFC 3161 §2.4.2, her token için seri numarasının BENZERSİZ olmasını şart
 * koşar. Dosyayı oku-artır-yaz biçimindeki naif uygulama bunu sağlamaz: iki
 * eşzamanlı istek aynı değeri okur ve aynı seriyi taşıyan iki token üretilir.
 * Bir TSA için bu, iki farklı belgenin aynı damga kimliğini paylaşması demektir
 * ve damganın kanıt değerini doğrudan yok eder.
 *
 * Buradaki ayırıcı, diske HER ZAMAN dağıtacağından ilerisini yazar (batch).
 * Çökme durumunda en fazla bir batch kadar seri atlanır -- ki bu zararsızdır;
 * asla tekrar edilmez, ki tehlikeli olan odur.
 */
class SerialAllocator {
  constructor(file, { batchSize = 256 } = {}) {
    this.file = file;
    this.batchSize = batchSize;
    this._next = 0n;
    this._ceiling = 0n;
    this._load();
  }

  _load() {
    let persisted = 1n;
    try {
      const raw = fs.readFileSync(this.file);
      if (raw.length === 16) persisted = BigInt(`0x${raw.toString('hex')}`);
    } catch (_) { /* ilk çalıştırma */ }
    if (persisted < 1n) persisted = 1n;
    this._next = persisted;
    this._reserve();
  }

  _reserve() {
    this._ceiling = this._next + BigInt(this.batchSize);
    const buf = Buffer.from(this._ceiling.toString(16).padStart(32, '0'), 'hex');
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Yazma + fsync + rename: rename atomiktir, fsync ise rename'den önce
    // içeriğin gerçekten diske indiğini garanti eder. Yalnızca rename yapmak,
    // ani güç kesintisinde eski içeriğe geri dönebilir.
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
  }

  /** Senkron ve bölünemez: JS tek iş parçacıklı olduğu için araya istek giremez. */
  next() {
    if (this._next >= this._ceiling) this._reserve();
    const value = this._next;
    this._next += 1n;
    return value;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TimeStampReq ayrıştırma
// ─────────────────────────────────────────────────────────────────────────────
/**
 * TimeStampReq ::= SEQUENCE {
 *   version INTEGER { v1(1) }, messageImprint MessageImprint,
 *   reqPolicy TSAPolicyId OPTIONAL, nonce INTEGER OPTIONAL,
 *   certReq BOOLEAN DEFAULT FALSE, extensions [0] IMPLICIT Extensions OPTIONAL }
 */
function parseTimeStampReq(der) {
  let top;
  try { top = readTLV(der, 0); }
  catch (e) { throw new TsaError(`istek çözümlenemedi: ${e.message}`, PKI_FAILURE.badDataFormat); }
  if (top.tag !== 0x30) throw new TsaError('TimeStampReq bir SEQUENCE değil', PKI_FAILURE.badDataFormat);

  const children = readChildren(top.content);
  if (children.length < 2) throw new TsaError('TimeStampReq eksik', PKI_FAILURE.badDataFormat);

  const [versionNode, imprintNode] = children;
  if (versionNode.tag !== 0x02) throw new TsaError('version INTEGER değil', PKI_FAILURE.badDataFormat);
  const version = Number(BigInt(`0x${versionNode.content.toString('hex') || '00'}`));
  if (version !== 1) throw new TsaError(`desteklenmeyen sürüm ${version}`, PKI_FAILURE.badRequest);

  if (imprintNode.tag !== 0x30) throw new TsaError('messageImprint SEQUENCE değil', PKI_FAILURE.badDataFormat);

  // İstemcinin gönderdiği messageImprint'in HAM baytları saklanır ve TSTInfo'ya
  // aynen konur. Yeniden kodlamak, istemcinin ürettiğiyle bit düzeyinde
  // ayrışabilir ve istemci kendi özetini token içinde bulamaz.
  const rawMessageImprint = top.content.subarray(
    imprintNode.contentOff - imprintNode.headerLen,
    imprintNode.contentOff - imprintNode.headerLen + imprintNode.totalLen,
  );

  const [algIdNode, hashedNode] = readChildren(imprintNode.content);
  if (!algIdNode || algIdNode.tag !== 0x30) throw new TsaError('hashAlgorithm eksik', PKI_FAILURE.badDataFormat);
  if (!hashedNode || hashedNode.tag !== 0x04) throw new TsaError('hashedMessage OCTET STRING değil', PKI_FAILURE.badDataFormat);

  const algOidNode = readChildren(algIdNode.content)[0];
  const hashAlgOid = decodeOidToDotted(algOidNode.content);
  const spec = DIGEST_ALGS[hashAlgOid];
  if (!spec) throw new TsaError(`kabul edilmeyen özet algoritması ${hashAlgOid}`, PKI_FAILURE.badAlg);

  const hashedMessage = hashedNode.content;
  if (hashedMessage.length !== spec.length) {
    throw new TsaError(
      `hashedMessage uzunluğu ${spec.name} için ${spec.length} olmalı, ${hashedMessage.length} geldi`,
      PKI_FAILURE.badDataFormat,
    );
  }

  let reqPolicyOid = null;
  let nonce = null;
  let certReq = false;
  for (const node of children.slice(2)) {
    if (node.tag === 0x06) reqPolicyOid = decodeOidToDotted(node.content);
    else if (node.tag === 0x02) nonce = Buffer.from(node.content);
    else if (node.tag === 0x01) certReq = node.content[0] !== 0x00;
  }

  return { version, hashAlgOid, hashedMessage, rawMessageImprint, reqPolicyOid, nonce, certReq };
}

function decodeOidToDotted(content) {
  const first = content[0];
  const parts = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (let i = 1; i < content.length; i++) {
    value = (value * 128) + (content[i] & 0x7f);
    if ((content[i] & 0x80) === 0) { parts.push(value); value = 0; }
  }
  return parts.join('.');
}

// ─────────────────────────────────────────────────────────────────────────────
// TSTInfo
// ─────────────────────────────────────────────────────────────────────────────
function buildAccuracy({ seconds, millis }) {
  const parts = [];
  if (seconds != null) parts.push(INT(BigInt(seconds)));
  // millis [0] IMPLICIT INTEGER -- INT()'in ürettiği TLV'nin İÇERİĞİ alınıp
  // bağlam etiketiyle yeniden sarılır.
  if (millis != null) {
    const inner = INT(BigInt(millis));
    parts.push(tlv(0x80, readTLV(inner, 0).content));
  }
  return SEQ(...parts);
}

function buildTstInfo({ policyOid, rawMessageImprint, serial, nonce, accuracy, ordering, genTime }) {
  const parts = [
    INT(1n),
    OID(policyOid),
    rawMessageImprint,
    INT(serial),
    GenTime(genTime),
  ];
  if (accuracy) parts.push(buildAccuracy(accuracy));
  if (ordering) parts.push(BOOL(true));
  // Nonce, istemcinin tazelik kontrolüdür: gönderdiyse token'da AYNEN geri
  // dönmelidir, yoksa istemci yanıtın önceden kaydedilmiş olmadığını kanıtlayamaz.
  if (nonce) parts.push(tlv(0x02, nonce));
  return SEQ(...parts);
}

// ─────────────────────────────────────────────────────────────────────────────
// CMS SignedData
// ─────────────────────────────────────────────────────────────────────────────

// RFC 5754: SHA-2 özet algoritmaları AlgorithmIdentifier içinde parametresiz
// yazılır. NULL parametre eklemek yaygın bir hatadır ve katı doğrulayıcılar
// (openssl ts -verify dahil) imzayı reddeder.
const digestAlgId = (oid) => SEQ(OID(oid));

function parseIssuerAndSerial(certDer) {
  const cert = readTLV(certDer, 0);
  const tbs = readTLV(cert.content, 0);
  const tbsChildren = readChildren(tbs.content);
  let i = 0;
  if (tbsChildren[0].tag === 0xa0) i = 1;           // [0] EXPLICIT version
  const serialNode = tbsChildren[i];
  const issuerNode = tbsChildren[i + 2];            // serial, sigAlg, issuer
  const issuerDer = tbs.content.subarray(
    issuerNode.contentOff - issuerNode.headerLen,
    issuerNode.contentOff - issuerNode.headerLen + issuerNode.totalLen,
  );
  return { serialContent: serialNode.content, issuerDer };
}

/**
 * ESSCertIDv2 (RFC 5035). Sertifikanın özetine ek olarak issuer+serial de
 * taşınır: yalnızca özet verildiğinde doğrulayıcı, elindeki hangi sertifikanın
 * kastedildiğini ancak hepsini deneyerek bulabilir.
 */
function buildSigningCertificateV2(leafDer) {
  const certHash = crypto.createHash('sha256').update(leafDer).digest();
  const { issuerDer, serialContent } = parseIssuerAndSerial(leafDer);
  const generalNames = SEQ(CTX(4, issuerDer));               // directoryName [4] EXPLICIT
  const issuerSerial = SEQ(generalNames, tlv(0x02, serialContent));
  return SEQ(SEQ(SEQ(digestAlgId(SHA256_OID), OCT(certHash), issuerSerial)));
}

function buildSignedAttributes({ eContentType, eContent, leafDer, signingTime }) {
  const messageDigest = crypto.createHash('sha256').update(eContent).digest();

  const attrs = [
    SEQ(OID(TSA_OIDS.contentType), SET(OID(eContentType))),
    SEQ(OID(TSA_OIDS.messageDigest), SET(OCT(messageDigest))),
    SEQ(OID(TSA_OIDS.signingCertificateV2), SET(buildSigningCertificateV2(leafDer))),
  ];
  if (signingTime) attrs.push(SEQ(OID('1.2.840.113549.1.9.5'), SET(GenTime(signingTime))));

  // SET OF, DER'de bileşenlerin kodlanmış hâline göre sıralı olmak ZORUNDADIR.
  // Sıralamamak, imzalanan baytların doğrulayıcının yeniden kodladığından
  // farklı olmasına ve imzanın "geçersiz" görünmesine yol açar.
  const sorted = attrs.slice().sort(Buffer.compare);
  return tlv(0x31, Buffer.concat(sorted));
}

function buildSignerInfo({ leafDer, signedAttrsDer, signatureAlgId, signature }) {
  const { issuerDer, serialContent } = parseIssuerAndSerial(leafDer);
  const sid = SEQ(issuerDer, tlv(0x02, serialContent));

  // signedAttrs alanı SignerInfo içinde [0] IMPLICIT'tir; imza ise AÇIK SET OF
  // etiketi (0x31) üzerinden hesaplanır (RFC 5652 §5.4). İkisini karıştırmak,
  // üretilen imzanın doğrulanamamasının en yaygın sebebidir.
  const implicitAttrs = tlv(0xa0, readTLV(signedAttrsDer, 0).content);

  return SEQ(
    INT(1n),
    sid,
    digestAlgId(SHA256_OID),
    implicitAttrs,
    signatureAlgId,
    OCT(signature),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Yanıt
// ─────────────────────────────────────────────────────────────────────────────
function buildPkiStatusInfo(status, failureInfo = null, text = null) {
  const parts = [INT(BigInt(status))];
  if (text) parts.push(SEQ(tlv(0x0c, Buffer.from(text, 'utf8'))));   // PKIFreeText
  if (failureInfo != null) {
    // PKIFailureInfo BIT STRING: bit numarası soldan sayılır.
    const byteIndex = Math.floor(failureInfo / 8);
    const bytes = Buffer.alloc(byteIndex + 1);
    bytes[byteIndex] = 0x80 >> (failureInfo % 8);
    const unused = 7 - (failureInfo % 8);
    parts.push(tlv(0x03, Buffer.concat([Buffer.from([unused]), bytes])));
  }
  return SEQ(...parts);
}

function buildRejection(failureInfo, text) {
  // RFC 3161 §3.4: hata durumunda da bir TimeStampResp dönülür. Düz metin bir
  // HTTP 400, RFC 3161 istemcisi tarafından "sunucu bozuk" olarak görülür;
  // reddin SEBEBİNİ makine tarafından okunabilir biçimde taşımaz.
  return SEQ(buildPkiStatusInfo(PKI_STATUS.REJECTION, failureInfo, text));
}

/**
 * Zaman damgası yanıtlayıcısı.
 *
 * @param {object} opts
 * @param {string} opts.keyPem        TSA imzalama anahtarı (PEM)
 * @param {string} opts.certChainPem  TSA sertifikası + zinciri (PEM, ilki uç sertifika)
 * @param {string} opts.policyOid     TSA politika OID'i (noktalı-ondalık)
 * @param {string} [opts.serialFile]
 * @param {object} [opts.accuracy]    { seconds, millis }
 * @param {boolean}[opts.requireCertReq] true ise sertifikalar yalnızca istendiğinde eklenir
 */
function createTimestampResponder({
  keyPem, certChainPem, policyOid,
  serialFile = './tsa-serial.bin',
  accuracy = { seconds: 1 },
  ordering = false,
  signingTime = false,
  now = () => new Date(),
}) {
  if (!keyPem) throw new Error('TSA: keyPem gerekli');
  if (!certChainPem) throw new Error('TSA: certChainPem gerekli');
  if (!policyOid) throw new Error('TSA: policyOid gerekli');

  const blocks = String(certChainPem).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks || blocks.length === 0) throw new Error('TSA: certChainPem içinde sertifika bulunamadı');
  const certDerList = blocks.map(pemToDer);
  const leafDer = certDerList[0];

  const privateKey = crypto.createPrivateKey(keyPem);

  // TSA sertifikasında extendedKeyUsage = timeStamping ve CRITICAL olmalıdır
  // (RFC 3161 §2.3). Bu, en sık atlanan maddedir ve etkisi geç ortaya çıkar:
  // sunucu sorunsuz çalışır, ürettiği damgalar katı doğrulayıcılarda reddedilir.
  // Açılışta durmak, aylar sonra "damgalarımız neden geçersiz" sorusundan iyidir.
  const leaf = new crypto.X509Certificate(leafDer);
  const eku = leaf.keyUsage || [];
  if (!eku.includes(TSA_OIDS.timeStamping)) {
    throw new Error(
      'TSA: imzalama sertifikasında extendedKeyUsage=timeStamping (1.3.6.1.5.5.7.3.8) yok. '
      + 'RFC 3161 §2.3 bunu zorunlu kılar ve katı doğrulayıcılar aksi hâlde damgayı reddeder. '
      + "@fitfak/ssl ile: issueCertificateFromCSR(csr, ca, { profile: 'tsa' })",
    );
  }

  const serials = new SerialAllocator(serialFile);
  const keyType = privateKey.asymmetricKeyType === 'ec' ? 'ec' : 'rsa';
  const signatureAlgId = keyType === 'ec'
    ? SEQ(OID('1.2.840.10045.4.3.2'))                    // ecdsa-with-SHA256, parametresiz
    : SEQ(OID(OIDs.sha256WithRSAEncryption), NULL());    // RSA, parameters = NULL

  function issue(tsqDer) {
    const req = parseTimeStampReq(tsqDer);

    if (req.reqPolicyOid && req.reqPolicyOid !== policyOid) {
      throw new TsaError(
        `istenen politika ${req.reqPolicyOid} bu TSA tarafından verilmiyor`,
        PKI_FAILURE.unacceptedPolicy,
      );
    }

    const tstInfo = buildTstInfo({
      policyOid,
      rawMessageImprint: req.rawMessageImprint,
      serial: serials.next(),
      nonce: req.nonce,
      accuracy,
      ordering,
      genTime: now(),
    });

    const signedAttrs = buildSignedAttributes({
      eContentType: TSA_OIDS.ctTSTInfo,
      eContent: tstInfo,
      leafDer,
      signingTime: signingTime ? now() : null,
    });

    const signature = crypto.sign('sha256', signedAttrs, privateKey);

    const signerInfo = buildSignerInfo({ leafDer, signedAttrsDer: signedAttrs, signatureAlgId, signature });

    // RFC 3161 §2.4.1: sertifikalar yalnızca certReq istendiğinde eklenir.
    // Her zaman eklemek, her damgayı zincir boyu kadar büyütür.
    const certificatesField = req.certReq
      ? tlv(0xa0, Buffer.concat(certDerList.slice().sort(Buffer.compare)))
      : null;

    const signedData = SEQ(
      INT(3n),
      SET(digestAlgId(SHA256_OID)),
      SEQ(OID(TSA_OIDS.ctTSTInfo), CTX(0, OCT(tstInfo))),
      certificatesField,
      SET(signerInfo),
    );

    const token = SEQ(OID(TSA_OIDS.signedData), CTX(0, signedData));
    return SEQ(buildPkiStatusInfo(PKI_STATUS.GRANTED), token);
  }

  return {
    policyOid,

    /** DER TimeStampReq -> DER TimeStampResp. Hata durumunda da geçerli bir yanıt döner. */
    handle(tsqDer) {
      try { return issue(tsqDer); }
      catch (err) {
        if (err instanceof TsaError) return buildRejection(err.failureInfo, err.message);
        return buildRejection(PKI_FAILURE.systemFailure, 'internal error');
      }
    },

    /** node:http için hazır (req, res) işleyicisi. */
    httpHandler({ maxBodyBytes = 64 * 1024 } = {}) {
      return (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' });
          return res.end('RFC 3161: POST application/timestamp-query bekleniyor\n');
        }
        const chunks = [];
        let total = 0;
        req.on('data', (chunk) => {
          total += chunk.length;
          // Bir TimeStampReq birkaç yüz bayttır. Sınırsız gövde kabul etmek,
          // kimlik doğrulaması olmayan bir uçta bedava bellek tüketimi demektir.
          if (total > maxBodyBytes) { req.destroy(); return; }
          chunks.push(chunk);
        });
        req.on('end', () => {
          const der = this.handle(Buffer.concat(chunks));
          res.writeHead(200, {
            'content-type': 'application/timestamp-reply',
            'content-length': der.length,
            'cache-control': 'no-store',
          });
          res.end(der);
        });
        req.on('error', () => { try { res.destroy(); } catch (_) { /* zaten kapalı */ } });
      };
    },
  };
}

/**
 * İstemci tarafı: bir veri özetinden TimeStampReq üretir. Test ve doğrulama
 * akışları için; üretimde istemci genelde openssl ts -query kullanır.
 */
function buildTimeStampRequest({ hash, hashAlg = 'sha256', policyOid = null, nonce = null, certReq = true }) {
  const oidByName = {
    sha256: '2.16.840.1.101.3.4.2.1',
    sha384: '2.16.840.1.101.3.4.2.2',
    sha512: '2.16.840.1.101.3.4.2.3',
  };
  const algOid = oidByName[hashAlg];
  if (!algOid) throw new Error(`buildTimeStampRequest: desteklenmeyen özet ${hashAlg}`);

  const parts = [
    INT(1n),
    SEQ(SEQ(OID(algOid)), OCT(hash)),
  ];
  if (policyOid) parts.push(OID(policyOid));
  if (nonce) parts.push(tlv(0x02, nonce));
  if (certReq) parts.push(BOOL(true));
  return SEQ(...parts);
}

/** Yanıtın PKIStatus'unu okur (granted mı, reddedildiyse neden). */
function parseTimeStampResponseStatus(der) {
  const top = readTLV(der, 0);
  const children = readChildren(top.content);
  const statusInfo = readChildren(children[0].content);
  const status = Number(BigInt(`0x${statusInfo[0].content.toString('hex') || '00'}`));
  return { status, granted: status === PKI_STATUS.GRANTED, hasToken: children.length > 1 };
}

module.exports = {
  createTimestampResponder,
  buildTimeStampRequest,
  parseTimeStampReq,
  parseTimeStampResponseStatus,
  SerialAllocator,
  TsaError,
  TSA_OIDS,
  PKI_STATUS,
  PKI_FAILURE,
};
