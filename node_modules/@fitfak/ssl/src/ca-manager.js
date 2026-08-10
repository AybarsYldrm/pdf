'use strict';
/**
 * CertificateAuthority — kolay kullanım için üst-seviye PKI yönetim katmanı.
 *
 * Önceki sürümde her sertifika, CRL ve OCSP yanıtı ayrı ayrı, elle
 * bağlanması gereken fonksiyonlarla üretiliyordu (hangi CA hangi seri
 * numaralarını iptal etti, CRL'i kim imzalıyor, OCSP responder hangi
 * duruma bakıyor — hepsi çağıran tarafından el ile takip edilmeliydi).
 *
 * Bu modül, TEK bir nesne üzerinden tam bir PKI hiyerarşisi (kök → ara →
 * son-varlık) kurmayı, iptalleri takip etmeyi ve CRL/OCSP'yi otomatik
 * olarak bu takipten üretmeyi sağlar. Alttaki `pki.js`/`csr.js`/
 * `http-ocsp.js`/`http-crl.js` fonksiyonlarının hepsini kullanır —
 * hiçbirinin imzasını DEĞİŞTİRMEZ, sadece onları pratik bir akışta bir
 * araya getirir.
 */
const pki = require('./pki');
const csrMod = require('./csr');
const { createOcspResponderHandler } = require('./http-ocsp');
const { createCrlServerHandler } = require('./http-crl');
const { certInfoFromPem } = require('./keys');
const { getDefaults } = require('./config');

class CertificateAuthority {
  /**
   * @param {{
   *   keyAlgo?: 'rsa'|'ec', bits?: number, curveName?: string, hashAlg?: string,
   *   subject?: Array, useIntermediate?: boolean,
   *   crlUrl?: string, aiaUrl?: string,
   *   root?: object, intermediate?: object,   // mevcut bir hiyerarşiyi devam ettirmek için
   * }} [opts]
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.keyAlgo = opts.keyAlgo || 'rsa';
    this.hashAlg = opts.hashAlg || getDefaults().key.hashAlg;

    if (opts.root) {
      this.root = opts.root;
    } else if (this.keyAlgo === 'ec') {
      this.root = pki.generateEcRootCA({ curveName: opts.curveName || getDefaults().key.curve });
    } else {
      this.root = pki.generateRootCA({ bits: opts.bits || getDefaults().key.rsaBits, hashAlg: this.hashAlg, subject: opts.subject });
    }

    this.intermediate = opts.intermediate || null;
    if (!opts.intermediate && opts.useIntermediate) {
      this.intermediate = this.keyAlgo === 'ec'
        ? pki.generateEcIntermediateCA(this.root, { curveName: opts.curveName || getDefaults().key.curve, crlUrl: opts.crlUrl, aiaUrl: opts.aiaUrl })
        : pki.generateIntermediateCA(this.root, { bits: opts.bits || getDefaults().key.rsaBits, hashAlg: this.hashAlg, crlUrl: opts.crlUrl, aiaUrl: opts.aiaUrl, subject: opts.subject });
    }

    // İmzalayan CA: ara CA varsa o, yoksa doğrudan kök.
    this.issuer = this.intermediate || this.root;

    // Seri numarası (hex) → { status, reason?, revokedAt?, certPem, hostname? }
    this.registry = new Map();
  }

  /** Statik yardımcı: tek satırda yeni bir kök (ve isteğe bağlı ara) CA ile CertificateAuthority oluşturur. */
  static create(opts = {}) {
    return new CertificateAuthority(opts);
  }

  /**
   * Bir son-varlık (end-entity) sertifikası üretir ve iç kayıt defterine ekler.
   * @param {string} hostname
   * @param {object} [opts]  generateEndEntityCert/generateEcEndEntityCert ile aynı seçenekler
   */
  issueLeaf(hostname, opts = {}) {
    const leaf = this.keyAlgo === 'ec'
      ? pki.generateEcEndEntityCert(this.issuer, hostname, { curveName: opts.curveName || getDefaults().key.curve, ...this._dpDefaults(), ...opts })
      : pki.generateEndEntityCert(this.issuer, hostname, { bits: opts.bits || getDefaults().key.rsaBits, hashAlg: this.hashAlg, ...this._dpDefaults(), ...opts });
    this._track(leaf.certPem, hostname);
    return leaf;
  }

  /**
   * Bir CSR'den (öz-imzası doğrulanarak) son-varlık sertifikası üretir ve
   * iç kayıt defterine ekler.
   * @param {string|Buffer} csrPemOrDer
   * @param {object} [opts]  issueCertificateFromCSR ile aynı seçenekler
   */
  issueFromCSR(csrPemOrDer, opts = {}) {
    const issued = csrMod.issueCertificateFromCSR(csrPemOrDer, this.issuer, {
      hashAlg: this.hashAlg, ...this._dpDefaults(), ...opts,
    });
    this._track(issued.pem);
    return issued;
  }

  /** CA kurulumunda verilen dağıtım noktası adreslerini varsayılan olarak taşır. */
  _dpDefaults() {
    const o = this.opts;
    const out = {};
    if (o.crlUrl)      out.crlUrl = o.crlUrl;
    if (o.aiaUrl)      out.aiaUrl = o.aiaUrl;
    if (o.crlUrls)     out.crlUrls = o.crlUrls;
    if (o.ocspUrl)     out.ocspUrl = o.ocspUrl;
    if (o.caIssuersUrl) out.caIssuersUrl = o.caIssuersUrl;
    if (o.policies)    out.policies = o.policies;
    return out;
  }

  _track(certPem, hostname) {
    const info = certInfoFromPem(certPem);
    this.registry.set(info.serialNumber.toString(16), {
      status: 'good', certPem, hostname, serialNumber: info.serialNumber,
    });
  }

  /**
   * Bir sertifikayı iptal eder (yalnızca bu yöneticinin kayıt defterinde
   * takip edilen sertifikalar için).
   * @param {bigint|string} serialNumber  bigint veya hex string
   * @param {number} [reason]  RFC 5280 CRLReason (varsayılan: 0 = unspecified)
   */
  revoke(serialNumber, reason = 0) {
    const key = typeof serialNumber === 'bigint' ? serialNumber.toString(16) : serialNumber;
    const entry = this.registry.get(key);
    if (!entry) throw new Error(`revoke: seri numarası bu CA tarafından bilinmiyor: ${key}`);
    entry.status = 'revoked';
    entry.reason = reason;
    entry.revokedAt = new Date();
  }

  /** Takip edilen iptallere göre canlı bir CRL üretir (PEM). */
  getCrlPem() {
    const revokedList = [...this.registry.values()]
      .filter(e => e.status === 'revoked')
      .map(e => ({ serial: e.serialNumber, date: e.revokedAt, reason: e.reason }));
    return pki.generateCRL(this.issuer, revokedList);
  }

  /** Takip edilen duruma göre bir OCSP durum sorgu fonksiyonu (getStatus) döner. */
  getOcspStatusFn() {
    return (serialNumber) => {
      const entry = this.registry.get(serialNumber.toString(16));
      if (!entry) return { status: 'good' }; // bilinmeyen seri no → varsayılan 'good' (RFC 6960 tipik davranış; isterseniz özelleştirin)
      return entry.status === 'revoked'
        ? { status: 'revoked', reason: entry.reason, revokedAt: entry.revokedAt }
        : { status: 'good' };
    };
  }

  /** Bu CA için hazır bir OCSP responder HTTP işleyicisi (req,res) döner. */
  ocspHandler(extraOpts = {}) {
    return createOcspResponderHandler({
      issuerCA: this.issuer,
      responderKey: this.issuer,
      responderCertDer: this.issuer.certDer,
      getStatus: this.getOcspStatusFn(),
      ...extraOpts,
    });
  }

  /** Bu CA için hazır bir CRL dağıtım noktası HTTP işleyicisi (req,res) döner. */
  crlHandler(extraOpts = {}) {
    return createCrlServerHandler({
      issuerCA: this.issuer,
      getRevokedList: () => [...this.registry.values()]
        .filter(e => e.status === 'revoked')
        .map(e => ({ serial: e.serialNumber, date: e.revokedAt, reason: e.reason })),
      ...extraOpts,
    });
  }

  /** Kayıt defterindeki tüm sertifikaları (özet bilgilerle) listeler. */
  list() {
    return [...this.registry.values()].map(e => ({
      serialNumber: e.serialNumber, hostname: e.hostname, status: e.status, reason: e.reason,
    }));
  }

  getRootPem() { return this.root.certPem; }
  getIntermediatePem() { return this.intermediate ? this.intermediate.certPem : null; }
  /** İstemcilere dağıtılacak tam güven zinciri PEM'i (ara + kök, bu sırayla). */
  getChainPem() {
    return (this.intermediate ? this.intermediate.certPem : '') + this.root.certPem;
  }
}

module.exports = { CertificateAuthority };
