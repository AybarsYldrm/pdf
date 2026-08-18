'use strict';
const crypto = require('crypto');
const fs = require('fs');
const { PDFPAdESWriter, ensureAcroFormAndEmptySigField } = require('../utils/pdf_parser');
const { pemToDer, parseCertBasics, parseKeyUsageAndEKU, extractSubjectCN } = require('../cades/x509_extract');
const { buildTSQ, requestTimestamp, extractTimeStampTokenOrThrow } = require('../timestamp/rfc3161');
const { OIDS } = require('../cades/oids');
const { buildCAdES_BES_auto, buildCAdES_BES_withSigner, addUnsignedAttr_signatureTimeStampToken, buildSignedData } = require('../cades/cades_builder');
const { resolveSigner } = require('../signer');

// TSA hash adı -> OID
const HASH_NAME_TO_OID = {
  sha256: OIDS.sha256,
  sha384: OIDS.sha384,
  sha512: OIDS.sha512,
};

// Adobe Acrobat'ın beklediği RFC 2560 OCSPResponse sarmalamasını yapar
// YENİ: Dış bağımlılık olmadan, saf Buffer manipülasyonu ile ASN.1 kılıfı örer
function wrapToFullOCSPResponse(basicDer) {
    // Yanıt zaten Full OCSP ise (içinde status baytı 0x0A 0x01 varsa) dokunma
    if (basicDer[0] === 0x30 && basicDer.indexOf(Buffer.from([0x0A, 0x01])) !== -1) {
        return basicDer;
    }

    // ASN.1 Uzunluk Kodlayıcı (Length Encoder)
    const encodeLen = (len) => {
        if (len < 128) return Buffer.from([len]);
        let hex = len.toString(16);
        if (hex.length % 2 !== 0) hex = '0' + hex;
        const buf = Buffer.from(hex, 'hex');
        return Buffer.concat([Buffer.from([0x80 | buf.length]), buf]);
    };

    // 1. responseStatus: ENUMERATED successful (0)
    const status = Buffer.from([0x0A, 0x01, 0x00]);

    // 2. id-pkix-ocsp-basic OID: 1.3.6.1.5.5.7.48.1.1
    const basicOid = Buffer.from([0x06, 0x09, 0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x01, 0x01]);

    // 3. response: OCTET STRING
    const octetStringHeader = Buffer.concat([Buffer.from([0x04]), encodeLen(basicDer.length)]);
    const responseOctet = Buffer.concat([octetStringHeader, basicDer]);

    // 4. ResponseBytes SEQUENCE
    const seqBytes = Buffer.concat([basicOid, responseOctet]);
    const seqHeader = Buffer.concat([Buffer.from([0x30]), encodeLen(seqBytes.length)]);
    const responseBytesSeq = Buffer.concat([seqHeader, seqBytes]);

    // 5. [0] EXPLICIT
    const explicitHeader = Buffer.concat([Buffer.from([0xA0]), encodeLen(responseBytesSeq.length)]);
    const explicitTag0 = Buffer.concat([explicitHeader, responseBytesSeq]);

    // 6. En dış SEQUENCE (OCSPResponse)
    const outerBytes = Buffer.concat([status, explicitTag0]);
    const outerHeader = Buffer.concat([Buffer.from([0x30]), encodeLen(outerBytes.length)]);
    
    return Buffer.concat([outerHeader, outerBytes]);
}

class PAdESManager {
  constructor({ tsaUrl, tsaOptions = {}, tsaHeaders = {}, logger = null }) {
    this.tsaUrl = tsaUrl;
    this.tsaOptions = tsaOptions; // { hashName, certReq, reqPolicyOid, nonceBytes }
    this.tsaHeaders = tsaHeaders; // { Authorization: 'Basic ...', ... }
    this._buildTSQ = buildTSQ;
    this._requestTimestamp = requestTimestamp;
    this._extractTimeStampTokenOrThrow = extractTimeStampTokenOrThrow;
    this._hashSignatureForTimestamp = (signatureValue, hashName) => {
      const normalizedHash = (hashName || 'sha256').toLowerCase();
      if (!Buffer.isBuffer(signatureValue)) {
        signatureValue = Buffer.from(signatureValue);
      }
      return crypto.createHash(normalizedHash).update(signatureValue).digest();
    };
    this._parseKeyUsageAndEKU = parseKeyUsageAndEKU;
    const resolvedLogger = logger || null;
    if (resolvedLogger && typeof resolvedLogger.debug === 'function') {
      this.logger = resolvedLogger;
    } else if (resolvedLogger && typeof resolvedLogger.log === 'function') {
      this.logger = { debug: resolvedLogger.log.bind(resolvedLogger) };
    } else {
      this.logger = null;
    }
  }

  _logDebug(message, context) {
    if (this.logger && typeof this.logger.debug === 'function') {
      this.logger.debug(message, context || {});
    }
  }

  /**
   * DocTimeStamp (ETSI.RFC3161) — imza olmadan yalnız TSA damgası ekler.
   * AcroForm/Sig yoksa görünmez bir /Sig alanı otomatik eklenir.
   */
  async addDocTimeStamp({ pdfBuffer, fieldName = null, placeholderHexLen = 64000 }) {
    const normalizedFieldName = (typeof fieldName === 'string' && fieldName.length > 0) ? fieldName : null;
    let workingPdf = pdfBuffer;

    if (normalizedFieldName) {
      workingPdf = ensureAcroFormAndEmptySigField(workingPdf, normalizedFieldName);
    }

    const writer = new PDFPAdESWriter(workingPdf);
    if (normalizedFieldName) {
      writer.preparePlaceholder({ subFilter: 'ETSI.RFC3161', placeholderHexLen, fieldName: normalizedFieldName });
    } else {
      writer.prepareDocumentTimeStampPlaceholder({ placeholderHexLen });
    }
    this._logDebug('DocTimeStamp.preparePlaceholder', {
      fieldName: normalizedFieldName,
      placeholderHexLen,
      mode: normalizedFieldName ? 'acro-field' : 'standalone'
    });

    // TSA hash seçimi
    const tsHashName = (this.tsaOptions.hashName || 'sha256').toLowerCase();
    const tsHashOid  = HASH_NAME_TO_OID[tsHashName] || OIDS.sha256;
    const allowMissingNonce = this.tsaOptions.allowMissingNonce;

    const tbsHash = writer.computeByteRangeHash(tsHashName);
    this._logDebug('DocTimeStamp.byteRangeHash', { hashAlgorithm: tsHashName, digest: tbsHash.toString('hex') });
    const { der: tsqDer, nonce: tsNonce } = this._buildTSQ(tbsHash, { hashOid: tsHashOid, certReq: true, ...this.tsaOptions });
    this._logDebug('DocTimeStamp.tsqBuilt', {
      nonce: tsNonce ? tsNonce.toString('hex') : null,
      tsqLength: tsqDer.length
    });
    const { der: tsRespDer } = await this._requestTimestamp(this.tsaUrl, tsqDer, this.tsaHeaders);
    this._logDebug('DocTimeStamp.tsaResponse', { responseLength: tsRespDer.length });
    const tst = this._extractTimeStampTokenOrThrow(tsRespDer, {
      expectedImprint: tbsHash,
      expectedNonce: tsNonce,
      expectedHashOid: tsHashOid,
      allowMissingNonce
    });

    writer.injectCMS(tst);
    this._logDebug('DocTimeStamp.injected', { cmsLength: tst.length });
    return writer.toBuffer();
  }

  /**
   * PAdES-T (CAdES-BES + signatureTimeStampToken).
   * Sertifikada imza yetkisi yoksa otomatik DocTS’e düşer.
   * AcroForm/Sig yoksa görünmez bir /Sig alanı otomatik eklenir.
   *
   * DocTS ekleme akışı `documentTimestamp` nesnesiyle yönetilir.
   *  - { append: true, fieldName, placeholderHexLen } → imzadan sonra DocTS ekler.
   *  - append=false (varsayılan) → yalnız imza + signatureTimeStampToken üretir.
   *  - Eski `addDocumentTimeStamp` ve ilgili parametreler geriye dönük uyumluluk için
   *    desteklenir.
   */
  async signPAdES_T({
    pdfBuffer,
    keyPem,
    certPem,
    chainPems = [],
    fieldName = null,
    placeholderHexLen = 120000,
    addDocumentTimeStamp = false,
    docTimeStampFieldName = null,
    docTimeStampPlaceholderHexLen = 64000,
    documentTimestamp = null,
    visibleSignature = null,
    docMDP = null,
    policy = null, // EPES isteniyorsa: { oid, hashBuffer, uri, hashName?, userNoticeText? }
    signer = null  // Signer arayüzü; verilirse keyPem yerine bu kullanılır
  }) {
    // Signer verildiyse sertifikaları ondan al (PFX / HSM / uzak imzalayıcı yolu)
    if (signer) {
      const certs = await signer.getCertificates();
      certPem = certs.certPem;
      if (!chainPems || chainPems.length === 0) chainPems = certs.chainPems || [];
    }
    this._logDebug('PAdES.sign.start', {
      fieldName,
      addDocumentTimeStamp,
      documentTimestampProvided: !!documentTimestamp
    });
    const visiblePage = (visibleSignature && typeof visibleSignature.page === 'number')
      ? visibleSignature.page : 0;
    pdfBuffer = ensureAcroFormAndEmptySigField(pdfBuffer, fieldName || 'Sig1', visiblePage);
    // KeyUsage kontrolü (auto fallback DocTS)
    const leafDer = pemToDer(certPem);
    const subjectCN = (() => {
      try {
        return extractSubjectCN(leafDer) || null;
      } catch (err) {
        this._logDebug('PAdES.subjectCN.error', { error: err && err.message ? err.message : String(err) });
        return null;
      }
    })();
    const { keyUsage = {}, eku = [] } = this._parseKeyUsageAndEKU(leafDer);
    const keyUsageBitsPresent = Object.values(keyUsage).some(Boolean);
    const canSignByKU = !keyUsageBitsPresent || keyUsage.digitalSignature || keyUsage.contentCommitment;
    const ekuList = Array.isArray(eku) ? eku : [];
    const tsaOnly = ekuList.length > 0 && ekuList.every((oid) => oid === OIDS.id_kp_timeStamping);
    const canSign = canSignByKU && !tsaOnly;
    this._logDebug('PAdES.keyUsage', { keyUsage, eku: ekuList, canSign, reason: canSign ? 'allowed' : 'disallowed' });

    const normalizeFieldName = (name) => (typeof name === 'string' && name.length > 0 ? name : null);
    const resolvedDocTs = (() => {
      if (documentTimestamp && typeof documentTimestamp === 'object') {
        const append = !!documentTimestamp.append;
        const normalizedField = normalizeFieldName(documentTimestamp.fieldName);
        const placeholder = (typeof documentTimestamp.placeholderHexLen === 'number' && documentTimestamp.placeholderHexLen > 0)
          ? documentTimestamp.placeholderHexLen
          : 64000;
        return { append, fieldName: normalizedField, placeholderHexLen: placeholder };
      }

      const legacyField = normalizeFieldName(docTimeStampFieldName);
      const placeholder = (typeof docTimeStampPlaceholderHexLen === 'number' && docTimeStampPlaceholderHexLen > 0)
        ? docTimeStampPlaceholderHexLen
        : 64000;
      return { append: !!addDocumentTimeStamp, fieldName: legacyField, placeholderHexLen: placeholder };
    })();

    this._logDebug('PAdES.docTimeStamp.config', {
      append: resolvedDocTs.append,
      fieldName: resolvedDocTs.fieldName,
      placeholderHexLen: resolvedDocTs.placeholderHexLen,
      viaDocumentTimestampOption: !!documentTimestamp
    });

    if (!canSign) {
      const docTsPlaceholderLen = resolvedDocTs.append ? resolvedDocTs.placeholderHexLen : placeholderHexLen;
      const fallbackField = resolvedDocTs.append ? resolvedDocTs.fieldName : normalizeFieldName(fieldName);
      this._logDebug('PAdES.fallback.docTimeStamp', {
        fieldName: fallbackField,
        placeholderHexLen: docTsPlaceholderLen,
        appendRequested: resolvedDocTs.append
      });
      const fallbackPdf = await this.addDocTimeStamp({
        pdfBuffer,
        fieldName: fallbackField,
        placeholderHexLen: docTsPlaceholderLen
      });
      return { pdf: fallbackPdf, mode: 'docts-fallback' };
    }

    // PAdES-T akışı
    const writer = new PDFPAdESWriter(pdfBuffer);
    
    // 1. ADIM: ÖNCE GÖRSELİ PDF'E İŞLİYORUZ (Dosya boyutu güvenli şekilde büyür)
    if (visibleSignature) {
      try {
        writer.applyVisibleSignatureFromPng({
          fieldName: fieldName || 'Sig1', 
          imageBuffer: visibleSignature.imageBuffer,
          rect: visibleSignature.defaultPosition
        });
      } catch (err) {
        console.warn('Görsel ekleme atlandı:', err.message);
      }
    }

    // YENİ GÜNCELLEME: adbe.pkcs7.detached yerine PAdES standardı olan ETSI.CAdES.detached kullanıyoruz.
    writer.preparePlaceholder({
      subFilter: 'ETSI.CAdES.detached',
      placeholderHexLen,
      fieldName,
      signerName: subjectCN || undefined,
      docMDP: docMDP || undefined
    });
    this._logDebug('PAdES.preparePlaceholder', { fieldName: fieldName || 'Sig1', placeholderHexLen });

    // İmzalanacak veri özeti (algoritma sertifikanın eğrisine göre)
    const { recommendedHash } = parseCertBasics(leafDer);
    const tbsHash = writer.computeByteRangeHash(recommendedHash);
    this._logDebug('PAdES.byteRangeHash', { hashAlgorithm: recommendedHash, digest: tbsHash.toString('hex') });

    // CAdES-BES/EPES üretimi: policy verilmediyse BES kalır (fake/test policy eklenmez).
    const { signerInfo, signatureValue, hashName, keyType, leafDer: _ld, chainDer } = signer
      ? await buildCAdES_BES_withSigner(tbsHash, signer, certPem, chainPems, policy)
      : buildCAdES_BES_auto(tbsHash, keyPem, certPem, chainPems, policy);
    this._logDebug('PAdES.signatureValue', { length: signatureValue.length });

    // İmza Zaman Damgası (RFC3161) — signatureValue üzerinde
    const tsHashName = (this.tsaOptions.hashName || 'sha256').toLowerCase();
    const tsHashOid  = HASH_NAME_TO_OID[tsHashName] || OIDS.sha256;
    const allowMissingNonce = this.tsaOptions.allowMissingNonce;

    const sigValHash = this._hashSignatureForTimestamp(signatureValue, tsHashName);
    this._logDebug('PAdES.signatureTimestamp.hash', {
      hashAlgorithm: tsHashName,
      digest: sigValHash.toString('hex')
    });
    const { der: tsqDer, nonce: tsNonce } = this._buildTSQ(sigValHash, { hashOid: tsHashOid, certReq: true, ...this.tsaOptions });
    this._logDebug('PAdES.signatureTimestamp.tsqBuilt', {
      nonce: tsNonce ? tsNonce.toString('hex') : null,
      tsqLength: tsqDer.length
    });
    const { der: tsRespDer } = await this._requestTimestamp(this.tsaUrl, tsqDer, this.tsaHeaders);
    this._logDebug('PAdES.signatureTimestamp.tsaResponse', { responseLength: tsRespDer.length });
    const tst = this._extractTimeStampTokenOrThrow(tsRespDer, {
      expectedImprint: sigValHash,
      expectedNonce: tsNonce,
      expectedHashOid: tsHashOid,
      allowMissingNonce
    });

    const signerInfo_T = addUnsignedAttr_signatureTimeStampToken(signerInfo, tst);
    const cmsT = buildSignedData(hashName, [_ld, ...chainDer], signerInfo_T, keyType);

    writer.injectCMS(cmsT);
    this._logDebug('PAdES.signatureTimestamp.injected', { cmsLength: cmsT.length });
    let signedPdf = writer.toBuffer();

    if (resolvedDocTs.append) {
      const docTsField = resolvedDocTs.fieldName;
      this._logDebug('PAdES.appendDocTimeStamp', {
        fieldName: docTsField,
        placeholderHexLen: resolvedDocTs.placeholderHexLen
      });
      signedPdf = await this.addDocTimeStamp({
        pdfBuffer: signedPdf,
        fieldName: docTsField,
        placeholderHexLen: resolvedDocTs.placeholderHexLen
      });
      return { pdf: signedPdf, mode: 'pades-t+docts' };
    }

    return { pdf: signedPdf, mode: 'pades-t' };
  }

  /**
   * PAdES-B: zaman damgası OLMADAN düz CAdES-BES imzası (ETSI.CAdES.detached).
   * signPAdES_T ile aynı hazırlık adımlarını (KeyUsage kontrolü, görünür imza,
   * placeholder) kullanır; yalnızca RFC3161 adımını atlar.
   */
  async signPAdES_B({
    pdfBuffer,
    keyPem,
    certPem,
    chainPems = [],
    fieldName = null,
    placeholderHexLen = 120000,
    visibleSignature = null,
    docMDP = null,
    policy = null, // EPES isteniyorsa: { oid, hashBuffer, uri, hashName?, userNoticeText? }
    signer = null
  }) {
    if (signer) {
      const certs = await signer.getCertificates();
      certPem = certs.certPem;
      if (!chainPems || chainPems.length === 0) chainPems = certs.chainPems || [];
    }
    this._logDebug('PAdES-B.sign.start', { fieldName });
    const visiblePageB = (visibleSignature && typeof visibleSignature.page === 'number')
      ? visibleSignature.page : 0;
    pdfBuffer = ensureAcroFormAndEmptySigField(pdfBuffer, fieldName || 'Sig1', visiblePageB);
    const leafDer = pemToDer(certPem);
    const subjectCN = (() => {
      try { return extractSubjectCN(leafDer) || null; } catch (err) { return null; }
    })();
    const { keyUsage = {}, eku = [] } = this._parseKeyUsageAndEKU(leafDer);
    const keyUsageBitsPresent = Object.values(keyUsage).some(Boolean);
    const canSignByKU = !keyUsageBitsPresent || keyUsage.digitalSignature || keyUsage.contentCommitment;
    const ekuList = Array.isArray(eku) ? eku : [];
    const tsaOnly = ekuList.length > 0 && ekuList.every((oid) => oid === OIDS.id_kp_timeStamping);
    const canSign = canSignByKU && !tsaOnly;
    if (!canSign) {
      throw new Error('Bu sertifika ile içerik imzalanamaz (KeyUsage/EKU izin vermiyor).');
    }

    const writer = new PDFPAdESWriter(pdfBuffer);
    if (visibleSignature) {
      try {
        writer.applyVisibleSignatureFromPng({
          fieldName: fieldName || 'Sig1',
          imageBuffer: visibleSignature.imageBuffer,
          rect: visibleSignature.defaultPosition
        });
      } catch (err) {
        console.warn('Görsel ekleme atlandı:', err.message);
      }
    }

    writer.preparePlaceholder({
      subFilter: 'ETSI.CAdES.detached',
      placeholderHexLen,
      fieldName,
      signerName: subjectCN || undefined,
      docMDP: docMDP || undefined
    });
    this._logDebug('PAdES-B.preparePlaceholder', { fieldName: fieldName || 'Sig1', placeholderHexLen });

    const { recommendedHash } = parseCertBasics(leafDer);
    const tbsHash = writer.computeByteRangeHash(recommendedHash);
    const { cmsBES } = signer
      ? await buildCAdES_BES_withSigner(tbsHash, signer, certPem, chainPems, policy)
      : buildCAdES_BES_auto(tbsHash, keyPem, certPem, chainPems, policy);
    writer.injectCMS(cmsBES);
    this._logDebug('PAdES-B.injected', { cmsLength: cmsBES.length });

    return { pdf: writer.toBuffer(), mode: 'pades-b' };
  }

  

  /**
   * PAdES-LT: imzalı bir PDF'e Document Security Store (DSS) ekler.
   *
   * Belgedeki HER imza (onay imzaları ve belge zaman damgaları) için:
   *   1. CMS'ten sertifikalar toplanır,
   *   2. sertifika yolu kurulur (AIA'dan eksik halkalar indirilebilir),
   *   3. yoldaki her sertifika için OCSP ve/veya CRL kanıtı alınır ve DOĞRULANIR,
   *   4. kanıtlar imzaya özel bir /VRI girdisi altında DSS'e gömülür.
   *
   * ETSI EN 319 142-1, LT seviyesi için imzanın zaman damgalı (B-T) olmasını
   * gerektirir; bu metod zaten zaman damgalanmış bir PDF bekler.
   *
   * @param {Object}   o
   * @param {Buffer}   o.pdfBuffer
   * @param {string[]} [o.certsPem]      Ek olarak gömülecek/zincir kurmada kullanılacak sertifikalar
   * @param {Array}    [o.ocsp]          [{ certPem, issuerPem, url? }] — açık OCSP istekleri
   * @param {Array}    [o.crl]           [{ certPem, issuerPem, url? }] — açık CRL istekleri
   * @param {boolean}  [o.autoDiscover=true]  Zinciri ve kanıt adreslerini kendi keşfet
   * @param {'ocsp-first'|'crl-first'|'ocsp-only'|'crl-only'|'both'} [o.prefer='ocsp-first']
   * @param {boolean}  [o.strict=false]  true → eksik iptal kanıtı hata fırlatır
   * @param {Date}     [o.validationTime]
   * @param {boolean}  [o.fetchIssuers=true] AIA caIssuers üzerinden eksik CA'ları indir
   * @returns {Promise<{ pdf: Buffer, dssInfo: Object, report: Object }>}
   */
  async addLTV({
    pdfBuffer,
    certsPem = [],
    ocsp = [],
    crl = [],
    ocspHeaders = {},
    autoDiscover = true,
    prefer = 'ocsp-first',
    strict = false,
    validationTime = null,
    fetchIssuers = true,
    timeoutMs = 15000
  }) {
    const {
      buildChain, collectCertificates, isSelfSigned, extractAIA, derToPem, getSubjectDer
    } = require('../cades/x509_ext');
    const { collectForPath, collectForCertificate } = require('../cades/revocation');
    const { findAllSignatures } = require('./pdf_parser');

    const now = validationTime || new Date();
    const writer = new PDFPAdESWriter(pdfBuffer);
    const signatures = findAllSignatures(pdfBuffer);

    this._logDebug('LTV.start', {
      signatureCount: signatures.length,
      extraCerts: certsPem.length,
      explicitOcsp: ocsp.length,
      explicitCrl: crl.length,
      prefer
    });

    if (!signatures.length) {
      throw new Error('LTV eklenemedi: belgede imza bulunamadı.');
    }

    // ── Sertifika havuzu ───────────────────────────────────────────────
    // Zincir kurulumunda kullanılacak tüm adaylar burada toplanır.
    const pool = [];
    const poolSeen = new Set();
    const addToPool = (der) => {
      if (!der || !der.length) return;
      const hex = der.toString('hex');
      if (poolSeen.has(hex)) return;
      poolSeen.add(hex);
      pool.push(der);
    };

    for (const pem of certsPem) {
      try { addToPool(pemToDer(pem)); } catch { /* geçersiz PEM atlanır */ }
    }
    for (const sig of signatures) collectCertificates(sig.cmsDer).forEach(addToPool);

    // Açık isteklerde verilen sertifikalar da havuza girsin
    for (const entry of [...ocsp, ...crl]) {
      for (const key of ['certPem', 'issuerPem']) {
        if (entry && entry[key]) {
          try { addToPool(pemToDer(entry[key])); } catch { /* atla */ }
        }
      }
    }

    /** AIA caIssuers üzerinden eksik üst sertifikaları indirir. */
    const fetchIssuerViaAIA = async (certDer) => {
      const urls = extractAIA(certDer).caIssuers;
      for (const url of urls) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          // Yanıt DER sertifika, PEM ya da PKCS#7 zinciri olabilir
          const found = collectCertificates(buf);
          if (found.length) return found;
          const text = buf.toString('latin1');
          const pems = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
          if (pems) return pems.map((p) => pemToDer(p));
        } catch (err) {
          this._logDebug('LTV.aia.fetchFailed', { url, error: err.message });
        }
      }
      return [];
    };

    // ── Her imza için doğrulama verisi ─────────────────────────────────
    const vriEntries = [];
    const report = {
      signatures: [],
      embedded: { certs: 0, ocsps: 0, crls: 0 },
      warnings: [],
      achievedLevel: null
    };

    const globalCerts = [];
    const globalCertSeen = new Set();
    const pushGlobalCert = (der) => {
      const hex = der.toString('hex');
      if (globalCertSeen.has(hex)) return;
      globalCertSeen.add(hex);
      globalCerts.push(der);
    };

    for (const sig of signatures) {
      const sigCerts = collectCertificates(sig.cmsDer);
      const entryReport = {
        vriKeys: sig.vriKeys,
        subFilter: sig.subFilter,
        type: sig.type === 'DocTimeStamp' ? 'doc-timestamp' : 'signature',
        paths: [],
        warnings: []
      };

      // CMS içindeki her "yaprak" sertifika için (imzalayan + TSA) yol kur.
      // Yaprak = havuzda kendisini issuer olarak gösteren başka sertifika olmayan.
      const subjects = new Set(sigCerts.map((c) => {
        try { return getSubjectDer(c).toString('hex'); } catch { return ''; }
      }));
      const issuerSubjects = new Set();
      for (const c of sigCerts) {
        try {
          const { getIssuerDer } = require('../cades/x509_ext');
          issuerSubjects.add(getIssuerDer(c).toString('hex'));
        } catch { /* atla */ }
      }
      let leaves = sigCerts.filter((c) => {
        try {
          if (isSelfSigned(c)) return false;
          return !issuerSubjects.has(getSubjectDer(c).toString('hex'));
        } catch { return false; }
      });
      if (!leaves.length) leaves = sigCerts.filter((c) => !isSelfSigned(c));

      const sigOcsps = [];
      const sigCrls = [];
      const sigPathCerts = [];

      for (const leaf of leaves) {
        // Yolu kur; eksikse AIA'dan indirmeyi dene
        let chain = buildChain(leaf, pool);
        if (!chain.complete && fetchIssuers && autoDiscover) {
          for (let attempt = 0; attempt < 4 && !chain.complete; attempt++) {
            const missing = chain.missingIssuerOf;
            if (!missing) break;
            const fetched = await fetchIssuerViaAIA(missing);
            if (!fetched.length) break;
            fetched.forEach(addToPool);
            chain = buildChain(leaf, pool);
          }
        }

        for (const c of chain.path) { sigPathCerts.push(c); pushGlobalCert(c); }

        const collected = await collectForPath(chain.path, {
          prefer,
          validationTime: now,
          headers: ocspHeaders,
          timeoutMs
        });

        for (const c of collected.certsDer) { sigPathCerts.push(c); pushGlobalCert(c); }
        sigOcsps.push(...collected.ocspsDer);
        sigCrls.push(...collected.crlsDer);

        let cn = null;
        try { cn = extractSubjectCN(leaf); } catch { /* isim okunamadı */ }

        entryReport.paths.push({
          subjectCN: cn,
          pathLength: chain.path.length,
          pathComplete: chain.complete,
          revocationComplete: collected.complete,
          revoked: collected.revoked,
          entries: collected.entries
        });

        if (collected.revoked) {
          const msg = `İptal edilmiş sertifika tespit edildi (${cn || 'bilinmeyen'}).`;
          entryReport.warnings.push(msg);
          if (strict) throw new Error('LTV: ' + msg);
        }
        if (!chain.complete) {
          const msg = `Sertifika yolu köke ulaşmadı (${cn || 'bilinmeyen'}).`;
          entryReport.warnings.push(msg);
          if (strict) throw new Error('LTV: ' + msg);
        }
        if (!collected.complete) {
          const msg = `Yoldaki her sertifika için iptal kanıtı alınamadı (${cn || 'bilinmeyen'}).`;
          entryReport.warnings.push(msg);
          if (strict) throw new Error('LTV: ' + msg);
        }
      }

      // Açık olarak verilen (kullanıcı tarafından) OCSP/CRL istekleri
      for (const req of ocsp) {
        if (!req || !req.certPem || !req.issuerPem) continue;
        try {
          const got = await collectForCertificate(
            pemToDer(req.certPem), pemToDer(req.issuerPem),
            { prefer: 'ocsp-only', ocspUrl: req.url, headers: ocspHeaders, validationTime: now, timeoutMs }
          );
          if (got.ocspDer) sigOcsps.push(got.ocspDer);
          got.extraCerts.forEach((c) => { sigPathCerts.push(c); pushGlobalCert(c); });
        } catch (err) {
          entryReport.warnings.push(`Açık OCSP isteği başarısız: ${err.message}`);
        }
      }
      for (const req of crl) {
        if (!req || !req.certPem || !req.issuerPem) continue;
        try {
          const got = await collectForCertificate(
            pemToDer(req.certPem), pemToDer(req.issuerPem),
            { prefer: 'crl-only', crlUrl: req.url, headers: ocspHeaders, validationTime: now, timeoutMs }
          );
          if (got.crlDer) sigCrls.push(got.crlDer);
        } catch (err) {
          entryReport.warnings.push(`Açık CRL isteği başarısız: ${err.message}`);
        }
      }

      // Tekilleştir
      const uniq = (arr) => {
        const seen = new Set();
        return arr.filter((b) => {
          const k = b.toString('base64');
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      };

      const vriCerts = uniq(sigPathCerts);
      const vriOcsps = uniq(sigOcsps);
      const vriCrls = uniq(sigCrls);

      if (vriCerts.length || vriOcsps.length || vriCrls.length) {
        vriEntries.push({
          hashes: sig.vriKeys,
          certsDer: vriCerts,
          ocspsDer: vriOcsps,
          crlsDer: vriCrls,
          validationTime: now
        });
      }

      entryReport.embedded = {
        certs: vriCerts.length, ocsps: vriOcsps.length, crls: vriCrls.length
      };
      report.signatures.push(entryReport);
      report.warnings.push(...entryReport.warnings);
    }

    // ── DSS yaz ────────────────────────────────────────────────────────
    const dssInfo = writer.addDSS({ vri: vriEntries });

    report.embedded = {
      certs: dssInfo.certsTotal || 0,
      ocsps: dssInfo.ocspsTotal || 0,
      crls: dssInfo.crlsTotal || 0
    };
    report.vriCount = dssInfo.vriTotal || 0;

    this._logDebug('LTV.dss.added', dssInfo);
    return { pdf: writer.toBuffer(), dssInfo, report };
  }

  /**
   * Var olan imzalı bir PDF'i B-LT seviyesine yükseltir.
   *
   * İmzalara dokunulmaz; yalnızca yeni bir artımlı revizyon olarak DSS eklenir.
   * Arşiv yönetimi için kıymetlidir: yıllar önce B-T olarak imzalanmış belgeler,
   * sertifikaların süresi dolmadan LTV'ye taşınabilir.
   *
   * @param {Buffer} pdfBuffer
   * @param {Object} [opts] addLTV seçenekleri
   */
  async extendToLT(pdfBuffer, opts = {}) {
    const { findAllSignatures } = require('./pdf_parser');
    const sigs = findAllSignatures(pdfBuffer);
    if (!sigs.length) throw new Error('extendToLT: belgede imza yok.');

    const { pdf, report, dssInfo } = await this.addLTV({ pdfBuffer, ...opts });
    return { pdf, mode: 'pades-lt', achievedLevel: 'pades-lt', report, dssInfo };
  }

  /**
   * Var olan imzalı bir PDF'i B-LTA seviyesine yükseltir (veya arşiv damgasını
   * yeniler). Önce doğrulama verisi tazelenir, sonra yeni bir belge zaman damgası
   * eklenir, sonra O damganın yolu için ikinci bir DSS turu yapılır.
   *
   * Arşiv damgası zincirleme yenilenebilir: her yenileme, bir öncekinin
   * kriptografik geçerliliğini "dondurur".
   */
  async extendToLTA(pdfBuffer, opts = {}) {
    const lt = await this.extendToLT(pdfBuffer, opts);

    const stamped = await this.addDocTimeStamp({
      pdfBuffer: lt.pdf,
      fieldName: opts.archiveFieldName || ('ArchiveTimeStamp_' + crypto.randomBytes(3).toString('hex')),
      placeholderHexLen: opts.archivePlaceholderHexLen || 64000
    });

    let final = stamped;
    let archiveReport = null;
    try {
      const res = await this.addLTV({ pdfBuffer: stamped, ...opts, strict: false });
      final = res.pdf;
      archiveReport = res.report;
    } catch (err) {
      this._logDebug('extendToLTA.archiveDssFailed', { error: err.message });
      if (opts.strict) throw err;
    }

    return {
      pdf: final,
      mode: 'pades-lta',
      achievedLevel: 'pades-lta',
      report: lt.report,
      archiveReport
    };
  }

  /**
   * Tek giriş noktası.
   *
   *   B     → düz CAdES-BES imzası, zaman damgası yok
   *   T     → B + RFC 3161 imza zaman damgası
   *   LT    → T + DSS (sertifikalar + OCSP/CRL gömülü, uzun vadeli doğrulama)
   *   LTA   → LT + arşiv belge zaman damgası + O DAMGANIN yolu için ikinci DSS
   *   DOCTS → yalnız belge zaman damgası, imza yok
   *
   * `certify: { level: 1|2|3 }` verilirse DocMDP sertifikalama imzası uygulanır
   * (yalnızca belgenin İLK imzasında kullanılmalıdır).
   *
   * @returns {Promise<{ pdf: Buffer, mode: string, requestedLevel: string,
   *                     achievedLevel: string, reasons: string[], ltvReport?: Object }>}
   */
  async sign({
    mode = 'T',
    pdfBuffer,
    keyPem,
    certPem,
    chainPems = [],
    fieldName = null,
    placeholderHexLen = 120000,
    visibleSignature = null,
    certify = null,
    ltv = null,   // { certsPem?, ocsp?, crl?, prefer?, strict?, autoDiscover? }
    policy = null,
    strict = false,
    signer = null,      // Signer arayüzü (keyPem yerine); bkz. src/signer/
    pfx = null,         // .pfx/.p12 Buffer — verilirse Pkcs12Signer kurulur
    pfxPassword = '',
    pfxOptions = null
  }) {
    // PFX verildiyse imzalayıcıyı ondan kur (kullanıcının en sık istediği yol).
    if (!signer && pfx) {
      signer = resolveSigner({ pfx, pfxPassword, pfxOptions: pfxOptions || {} });
    }
    const docMDP = certify && typeof certify === 'object' ? { level: certify.level } : null;
    const normalizedMode = String(mode || 'T').toUpperCase();
    const reasons = [];

    const finish = (pdf, achieved, extra = {}) => ({
      pdf,
      mode: achieved,
      requestedLevel: normalizedMode,
      achievedLevel: achieved,
      reasons,
      ...extra
    });

    if (normalizedMode === 'DOCTS') {
      const pdf = await this.addDocTimeStamp({
        pdfBuffer,
        fieldName: fieldName || 'DocTimeStamp1',
        placeholderHexLen: placeholderHexLen || 64000
      });
      return finish(pdf, 'docts');
    }

    if (normalizedMode === 'B') {
      const { pdf, mode: m } = await this.signPAdES_B({
        pdfBuffer, keyPem, certPem, chainPems, fieldName,
        placeholderHexLen, visibleSignature, docMDP, policy, signer
      });
      return finish(pdf, m);
    }

    // T, LT ve LTA zaman damgalı imzayla başlar.
    let signedPdf;
    let baseMode;
    try {
      const res = await this.signPAdES_T({
        pdfBuffer, keyPem, certPem, chainPems, fieldName, placeholderHexLen,
        documentTimestamp: { append: false }, visibleSignature, docMDP, policy, signer
      });
      signedPdf = res.pdf;
      baseMode = res.mode;
    } catch (err) {
      if (strict || normalizedMode === 'T') throw err;
      // TSA erişilemiyorsa B seviyesine düş — ama SESSİZCE değil.
      reasons.push(`Zaman damgası alınamadı (${err.message}); B seviyesine düşüldü.`);
      const { pdf } = await this.signPAdES_B({
        pdfBuffer, keyPem, certPem, chainPems, fieldName,
        placeholderHexLen, visibleSignature, docMDP, policy, signer
      });
      return finish(pdf, 'pades-b');
    }

    if (normalizedMode === 'T') {
      return finish(signedPdf, baseMode);
    }

    if (normalizedMode !== 'LT' && normalizedMode !== 'LTA') {
      throw new Error("Bilinmeyen mode: '" + mode + "'. Geçerli: 'B' | 'T' | 'LT' | 'LTA' | 'DOCTS'.");
    }

    // ── LT ────────────────────────────────────────────────────────────
    // Not: OCSP artık ZORUNLU DEĞİL. Yalnız CRL yayınlayan CA'lar da LT'ye
    // çıkabilir; kural "kök hariç her sertifika için en az bir iptal kanıtı".
    const ltvOpts = ltv && typeof ltv === 'object' ? ltv : {};
    let ltPdf;
    let ltvReport;
    try {
      const res = await this.addLTV({
        pdfBuffer: signedPdf,
        certsPem: ltvOpts.certsPem || chainPems || [],
        ocsp: Array.isArray(ltvOpts.ocsp) ? ltvOpts.ocsp : [],
        crl: Array.isArray(ltvOpts.crl) ? ltvOpts.crl : [],
        ocspHeaders: ltvOpts.ocspHeaders || {},
        autoDiscover: ltvOpts.autoDiscover !== false,
        prefer: ltvOpts.prefer || 'ocsp-first',
        strict: ltvOpts.strict !== undefined ? ltvOpts.strict : strict,
        validationTime: ltvOpts.validationTime || null,
        fetchIssuers: ltvOpts.fetchIssuers !== false,
        timeoutMs: ltvOpts.timeoutMs || 15000
      });
      ltPdf = res.pdf;
      ltvReport = res.report;
      reasons.push(...(res.report.warnings || []));
    } catch (err) {
      if (strict) throw err;
      reasons.push(`LTV verisi eklenemedi (${err.message}); ${baseMode} seviyesinde kalındı.`);
      return finish(signedPdf, baseMode);
    }

    if (normalizedMode === 'LT') {
      return finish(ltPdf, 'pades-lt', { ltvReport });
    }

    // ── LTA ───────────────────────────────────────────────────────────
    // ETSI EN 319 142-1: arşiv damgası eklendikten sonra, O DAMGANIN TSA
    // sertifika yolu için de doğrulama verisi gömülmelidir. Aksi hâlde TSA
    // sertifikasının süresi dolduğunda arşiv damgası doğrulanamaz — ki LTA'nın
    // var oluş sebebi tam olarak budur.
    let ltaPdf;
    try {
      ltaPdf = await this.addDocTimeStamp({
        pdfBuffer: ltPdf,
        fieldName: (fieldName ? fieldName + '_Archive' : 'ArchiveTimeStamp1'),
        placeholderHexLen: ltvOpts.archivePlaceholderHexLen || 64000
      });
    } catch (err) {
      if (strict) throw err;
      reasons.push(`Arşiv zaman damgası eklenemedi (${err.message}); LT seviyesinde kalındı.`);
      return finish(ltPdf, 'pades-lt', { ltvReport });
    }

    let finalPdf = ltaPdf;
    let archiveReport = null;
    try {
      const res2 = await this.addLTV({
        pdfBuffer: ltaPdf,
        certsPem: ltvOpts.certsPem || [],
        autoDiscover: true,
        prefer: ltvOpts.prefer || 'ocsp-first',
        strict: false,
        validationTime: ltvOpts.validationTime || null,
        fetchIssuers: ltvOpts.fetchIssuers !== false,
        timeoutMs: ltvOpts.timeoutMs || 15000
      });
      finalPdf = res2.pdf;
      archiveReport = res2.report;
      reasons.push(...(res2.report.warnings || []));
    } catch (err) {
      reasons.push(`Arşiv damgasının doğrulama verisi eklenemedi (${err.message}).`);
      if (strict) throw err;
    }

    return finish(finalPdf, 'pades-lta', { ltvReport, archiveReport });
  }
}

module.exports = { PAdESManager };