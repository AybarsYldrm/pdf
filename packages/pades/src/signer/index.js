'use strict';
/**
 * Signer arayüzü.
 *
 * PROBLEM: İmzalama motoru bugüne kadar `keyPem` string'i istiyordu. Bu, özel
 * anahtarın düz metin olarak bellekte bulunmasını ZORUNLU kılar — akıllı kart,
 * HSM veya "anahtar tarayıcıdan çıkmasın" senaryoları imkânsız hâle gelir.
 *
 * ÇÖZÜM: Motor anahtarı değil, bir *imzalayıcı* ister. İmzalayıcı yalnız iki şey
 * yapabilmelidir: sertifikalarını vermek ve verilen veriyi imzalamak.
 *
 *   @typedef {Object} Signer
 *   @property {() => Promise<{certPem:string, chainPems:string[]}>} getCertificates
 *   @property {(data:Buffer, alg:{hash:string, keyType:string}) => Promise<Buffer>} sign
 *   @property {() => {keyType:'rsa'|'ec', curve?:string, bits?:number}} keyInfo
 *
 * `sign()` HAM VERİYİ alır (signedAttrs DER'i), özetini kendisi hesaplar ve
 * imzalar — WebCrypto ve PKCS#11 API'leri de böyle çalışır.
 */

const crypto = require('crypto');

class SignerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SignerError';
    this.code = code;
  }
}

/**
 * Bellekteki PEM anahtarla imzalar. En basit uygulama; mevcut davranışın karşılığı.
 */
class PemSigner {
  /**
   * @param {{ keyPem:string, certPem:string, chainPems?:string[] }} o
   */
  constructor({ keyPem, certPem, chainPems = [] }) {
    if (!keyPem) throw new SignerError('ERR_SIGNER_NO_KEY', 'PemSigner: keyPem zorunlu');
    if (!certPem) throw new SignerError('ERR_SIGNER_NO_CERT', 'PemSigner: certPem zorunlu');
    this._keyPem = keyPem;
    this._certPem = certPem;
    this._chainPems = chainPems;
    this._keyObj = crypto.createPrivateKey(keyPem);
  }

  async getCertificates() {
    return { certPem: this._certPem, chainPems: this._chainPems };
  }

  keyInfo() {
    const d = this._keyObj.asymmetricKeyDetails || {};
    const type = this._keyObj.asymmetricKeyType === 'ec' ? 'ec' : 'rsa';
    return { keyType: type, curve: d.namedCurve, bits: d.modulusLength };
  }

  /**
   * @param {Buffer} data İmzalanacak ham veri (signedAttrs DER'i)
   * @param {{hash:string, keyType:string}} alg
   */
  async sign(data, alg) {
    const hash = (alg.hash || 'sha256').toUpperCase();
    if (alg.keyType === 'rsa') {
      const s = crypto.createSign(`RSA-${hash}`);
      s.update(data);
      return s.sign(this._keyPem);
    }
    const s = crypto.createSign(hash);
    s.update(data);
    return s.sign({ key: this._keyPem });
  }
}

/**
 * PKCS#12 (.pfx / .p12) dosyasından imzalayıcı üretir.
 *
 * Kullanıcının en çok istediği yol: "elimdeki .pfx ile imzala".
 */
class Pkcs12Signer extends PemSigner {
  /**
   * @param {Buffer} pfxDer
   * @param {string} password
   * @param {{ identityIndex?:number, friendlyName?:string, verifyMac?:boolean }} [opts]
   */
  static from(pfxDer, password, opts = {}) {
    const p12 = require('@fitfak/pkcs12');
    const store = p12.parse(pfxDer, password, { verifyMac: opts.verifyMac !== false });

    if (!store.identities.length) {
      throw new SignerError('ERR_PKCS12_NO_IDENTITY',
        'PFX içinde özel anahtar + sertifika çifti bulunamadı.');
    }

    let identity;
    if (opts.friendlyName) {
      identity = store.identities.find((i) => i.friendlyName === opts.friendlyName);
      if (!identity) {
        throw new SignerError('ERR_PKCS12_IDENTITY_NOT_FOUND',
          `PFX içinde "${opts.friendlyName}" adlı kimlik yok. ` +
          `Mevcut: ${store.identities.map((i) => i.friendlyName).join(', ')}`);
      }
    } else {
      identity = store.identities[opts.identityIndex || 0];
    }

    if (!identity.certificatePem) {
      throw new SignerError('ERR_PKCS12_NO_CERT',
        'Seçilen kimliğin sertifikası yok (yalnız özel anahtar bulundu).');
    }

    const signer = new Pkcs12Signer({
      keyPem: identity.privateKeyPem,
      certPem: identity.certificatePem,
      chainPems: identity.chainPems
    });
    signer.identity = identity;
    signer.store = store;
    return signer;
  }

  /** PFX içindeki tüm kimlikleri listeler (arayüzde seçim için). */
  static listIdentities(pfxDer, password, opts = {}) {
    const p12 = require('@fitfak/pkcs12');
    const store = p12.parse(pfxDer, password, { verifyMac: opts.verifyMac !== false });
    return store.identities.map((i, index) => ({
      index,
      friendlyName: i.friendlyName,
      subject: i.subject,
      issuer: i.issuer,
      notBefore: i.notBefore,
      notAfter: i.notAfter,
      keyInfo: i.keyInfo,
      chainLength: i.chainPems.length,
      hasCertificate: !!i.certificatePem
    }));
  }
}

/**
 * İmzalama işini dışarıya devreden imzalayıcı.
 *
 * Sunucu bunu kullanır: sertifikalar istemciden gelir, imzalanacak veri
 * istemciye gönderilir, imza geri döner. Özel anahtar sunucuya HİÇ uğramaz.
 *
 * Aynı sınıf PKCS#11 / HSM entegrasyonu için de kullanılabilir.
 */
class RemoteSigner {
  /**
   * @param {{ certPem:string, chainPems?:string[],
   *           keyInfo:{keyType:'rsa'|'ec', curve?:string, bits?:number},
   *           signCallback:(data:Buffer, alg:Object)=>Promise<Buffer> }} o
   */
  constructor({ certPem, chainPems = [], keyInfo, signCallback }) {
    if (typeof signCallback !== 'function') {
      throw new SignerError('ERR_SIGNER_NO_CALLBACK', 'RemoteSigner: signCallback zorunlu');
    }
    if (!certPem) throw new SignerError('ERR_SIGNER_NO_CERT', 'RemoteSigner: certPem zorunlu');
    this._certPem = certPem;
    this._chainPems = chainPems;
    this._keyInfo = keyInfo || inferKeyInfoFromCert(certPem);
    this._signCallback = signCallback;
  }

  async getCertificates() {
    return { certPem: this._certPem, chainPems: this._chainPems };
  }

  keyInfo() { return this._keyInfo; }

  async sign(data, alg) {
    const sig = await this._signCallback(data, alg);
    if (!Buffer.isBuffer(sig)) {
      return Buffer.from(sig);
    }
    return sig;
  }
}

/** Sertifikadan anahtar türünü çıkarır (RemoteSigner için kolaylık). */
function inferKeyInfoFromCert(certPem) {
  const x = new crypto.X509Certificate(certPem);
  const pub = x.publicKey;
  const d = pub.asymmetricKeyDetails || {};
  return {
    keyType: pub.asymmetricKeyType === 'ec' ? 'ec' : 'rsa',
    curve: d.namedCurve,
    bits: d.modulusLength
  };
}

/**
 * Verilen argümanlardan bir Signer üretir. Motorun tek giriş noktası —
 * eski `keyPem` kullanımı da desteklenmeye devam eder.
 *
 * @param {{ signer?:Object, keyPem?:string, certPem?:string, chainPems?:string[],
 *           pfx?:Buffer, pfxPassword?:string }} o
 * @returns {Object} Signer
 */
function resolveSigner(o) {
  if (o.signer) {
    const s = o.signer;
    if (typeof s.sign !== 'function' || typeof s.getCertificates !== 'function') {
      throw new SignerError('ERR_SIGNER_INVALID',
        'Verilen signer, Signer arayüzünü karşılamıyor (sign + getCertificates gerekli).');
    }
    return s;
  }
  if (o.pfx) {
    return Pkcs12Signer.from(o.pfx, o.pfxPassword || '', o.pfxOptions || {});
  }
  if (o.keyPem && o.certPem) {
    return new PemSigner({ keyPem: o.keyPem, certPem: o.certPem, chainPems: o.chainPems || [] });
  }
  throw new SignerError('ERR_SIGNER_MISSING',
    'İmzalayıcı belirtilmedi: signer, pfx veya keyPem+certPem verilmeli.');
}

module.exports = {
  SignerError,
  PemSigner,
  Pkcs12Signer,
  RemoteSigner,
  resolveSigner,
  inferKeyInfoFromCert
};
