'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { 
  readTLV, readChildren, derIntToBigInt, decodeOidHex, 
  SEQ, OID, OCT, INT, NULL, CTX 
} = require('@fitfak/ssl/src/asn1'); // Kendi modülün[cite: 1]

class PKCS12 {
  constructor(password = '') {
    this.password = password;
    this.OIDS = {
      data: '1.2.840.113549.1.7.1',
      encryptedData: '1.2.840.113549.1.7.6',
      certBag: '1.2.840.113549.1.12.10.1.3',
      pkcs8ShroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
      keyBag: '1.2.840.113549.1.12.10.1.1',
      x509Certificate: '1.2.840.113549.1.9.22.1'
    };
  }

  // ==========================================
  // YARDIMCI FONKSİYONLAR
  // ==========================================
  static derToPem(der, label) {
    const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
    return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
  }

  static pemToDer(pem) {
    const b64 = pem.split('\n').filter(l => l && !l.startsWith('-----')).join('');
    return Buffer.from(b64, 'base64');
  }

  static getHashName(oid) {
    const HASH_OIDS = {
      '1.2.840.113549.2.7': 'sha1',
      '1.2.840.113549.2.9': 'sha256',
      '1.2.840.113549.2.10': 'sha384',
      '1.2.840.113549.2.11': 'sha512'
    };
    return HASH_OIDS[oid] || 'sha1';
  }

  // ==========================================
  // PARSER (AYRIŞTIRICI) VE ŞİFRE ÇÖZÜCÜ
  // ==========================================
  parse(pfxDer) {
    const results = { certificates: [], privateKeys: [] };
    const pfxTlv = readTLV(pfxDer, 0);
    const pfxChildren = readChildren(pfxTlv.content);
    
    const authSafeNode = pfxChildren[1];
    const authSafeChildren = readChildren(authSafeNode.content);
    const authSafeContentCtx = authSafeChildren[1];
    
    const octetNode = readTLV(authSafeContentCtx.content, 0);
    const authSafeSeq = readTLV(octetNode.content, 0);
    const safeContents = readChildren(authSafeSeq.content);

    safeContents.forEach((contentInfo) => {
      const ciChildren = readChildren(contentInfo.content);
      const bagOid = decodeOidHex(ciChildren[0].content.toString('hex'));
      const ctx0 = ciChildren[1];

      if (bagOid === this.OIDS.encryptedData) {
        const encryptedDataSeq = readTLV(ctx0.content, 0);
        const edChildren = readChildren(encryptedDataSeq.content);
        
        const eciChildren = readChildren(edChildren[1].content);
        const encryptionAlgNode = eciChildren[1];
        const cipherText = eciChildren[2].content;

        const decryptedData = this.#decryptPBES2(encryptionAlgNode, cipherText);
        this.#extractBags(decryptedData, results);
      } 
      else if (bagOid === this.OIDS.data) {
         const octetDataNode = readTLV(ctx0.content, 0);
         this.#extractBags(octetDataNode.content, results);
      }
    });

    return results;
  }

  #extractBags(safeContentsDer, results) {
    const seq = readTLV(safeContentsDer, 0);
    const bags = readChildren(seq.content);

    bags.forEach((bagNode) => {
      const bagChildren = readChildren(bagNode.content);
      const bagOid = decodeOidHex(bagChildren[0].content.toString('hex'));
      const ctx0 = bagChildren[1];
      
      if (bagOid === this.OIDS.certBag) { 
        const certBagSeq = readTLV(ctx0.content, 0);
        const certBagChildren = readChildren(certBagSeq.content);
        const certOctet = readTLV(certBagChildren[1].content, 0);
        results.certificates.push(PKCS12.derToPem(certOctet.content, 'CERTIFICATE'));
      }
      else if (bagOid === this.OIDS.pkcs8ShroudedKeyBag) { 
        const encPrivKeyInfo = readTLV(ctx0.content, 0);
        const epkiChildren = readChildren(encPrivKeyInfo.content);
        const pkcs8Der = this.#decryptPBES2(epkiChildren[0], epkiChildren[1].content);
        results.privateKeys.push(PKCS12.derToPem(pkcs8Der, 'PRIVATE KEY'));
      }
      else if (bagOid === this.OIDS.keyBag) { 
         const privKeyInfoSeq = readTLV(ctx0.content, 0);
         const pkDer = ctx0.content.subarray(0, privKeyInfoSeq.totalLen);
         results.privateKeys.push(PKCS12.derToPem(pkDer, 'PRIVATE KEY'));
      }
    });
  }

  #decryptPBES2(algNode, cipherText) {
    const algChildren = readChildren(algNode.content);
    const pbes2Params = readChildren(algChildren[1].content);
    const kdfChildren = readChildren(pbes2Params[0].content);
    const pbkdf2Params = readChildren(kdfChildren[1].content);
    
    const salt = pbkdf2Params[0].content;
    const iterations = Number(derIntToBigInt(pbkdf2Params[1].content));
    
    let hashName = 'sha1';
    for (let i = 2; i < pbkdf2Params.length; i++) {
      if (pbkdf2Params[i].tag === 0x30) {
        const prfChildren = readChildren(pbkdf2Params[i].content);
        hashName = PKCS12.getHashName(decodeOidHex(prfChildren[0].content.toString('hex')));
      }
    }

    const encChildren = readChildren(pbes2Params[1].content);
    const encOid = decodeOidHex(encChildren[0].content.toString('hex'));
    const iv = encChildren[1].content;

    const CIPHER_OIDS = {
      '2.16.840.1.101.3.4.1.42': { alg: 'aes-256-cbc', keyLen: 32 },
      '2.16.840.1.101.3.4.1.2': { alg: 'aes-128-cbc', keyLen: 16 },
      '1.2.840.113549.3.7': { alg: 'des-ede3-cbc', keyLen: 24 }
    };

    const cipherInfo = CIPHER_OIDS[encOid];
    const key = crypto.pbkdf2Sync(this.password, salt, iterations, cipherInfo.keyLen, hashName);
    const decipher = crypto.createDecipheriv(cipherInfo.alg, key, iv);
    return Buffer.concat([decipher.update(cipherText), decipher.final()]);
  }

  // ==========================================
  // BUILDER (OLUŞTURUCU) VE ŞİFRELEYİCİ
  // ==========================================
  
  // Veriyi PBES2 ve AES-256-CBC ile şifreler ve ASN.1 yapısını döner
  #encryptPBES2(plainTextDer) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const iterations = 2048;

    // Anahtar Türetme (PBKDF2)
    const key = crypto.pbkdf2Sync(this.password, salt, iterations, 32, 'sha256');

    // Şifreleme (AES-256-CBC)
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const cipherText = Buffer.concat([cipher.update(plainTextDer), cipher.final()]);

    // ASN.1 Yapılandırması (Kendi asn1.js modülünü kullanıyoruz)
    const pbkdf2Params = SEQ(OCT(salt), INT(BigInt(iterations)), SEQ(OID('1.2.840.113549.2.9'), NULL())); 
    const kdf = SEQ(OID('1.2.840.113549.1.5.12'), pbkdf2Params); 
    const encScheme = SEQ(OID('2.16.840.1.101.3.4.1.42'), OCT(iv)); 

    const pbes2Seq = SEQ(kdf, encScheme);
    const algId = SEQ(OID('1.2.840.113549.1.5.13'), pbes2Seq); 

    // IMPLICIT [0] Context tag ile şifrelenmiş veriyi sarmala
    return { algId, cipherTextCtx: CTX(0, OCT(cipherText)) };
  }

  /**
   * Sertifika ve Özel Anahtarı alıp bir .pfx (PKCS#12) Buffer'ı üretir.
   * @param {string} certPem Sertifikanın PEM formatı
   * @param {string} keyPem Özel Anahtarın PEM formatı
   */
  build(certPem, keyPem) {
    const certDer = PKCS12.pemToDer(certPem);
    const keyDer = PKCS12.pemToDer(keyPem);

    // 1. ÇANTA OLUŞTUR: Sertifika (CertBag)
    const certBag = SEQ(
      OID(this.OIDS.certBag),
      CTX(0, SEQ(
        OID(this.OIDS.x509Certificate),
        CTX(0, OCT(certDer))
      ))
    );
    const certSafeContents = SEQ(certBag);

    // 2. ÇANTA OLUŞTUR: Özel Anahtar (KeyBag)
    const keyBag = SEQ(
      OID(this.OIDS.keyBag),
      CTX(0, keyDer)
    );
    const keySafeContents = SEQ(keyBag);

    // 3. ŞİFRELE: Anahtarların bulunduğu çantayı güvene alıyoruz
    const encKeyData = this.#encryptPBES2(keySafeContents);

    // 4. İÇERİK BİLGİSİ (ContentInfo) Hazırla
    // Şifreli Anahtar Bilgisi
    const encryptedDataContentInfo = SEQ(
      OID(this.OIDS.encryptedData),
      CTX(0, SEQ(
        INT(0n),
        SEQ(
          OID(this.OIDS.data),
          encKeyData.algId,
          encKeyData.cipherTextCtx
        )
      ))
    );

    // Şifresiz Sertifika Bilgisi
    const plainCertContentInfo = SEQ(
      OID(this.OIDS.data),
      CTX(0, OCT(certSafeContents))
    );

    // 5. AUTHENTICATED SAFE OLUŞTUR (Tüm içerikleri birleştir)
    const authenticatedSafe = SEQ(encryptedDataContentInfo, plainCertContentInfo);

    // 6. KÖK PFX (PKCS#12) DOSYASINI OLUŞTUR
    const pfx = SEQ(
      INT(3n), // Versiyon v3
      SEQ(     // AuthSafe ContentInfo
        OID(this.OIDS.data),
        CTX(0, OCT(authenticatedSafe))
      )
      // DİKKAT: MacData katmanı eksiktir.
    );

    return pfx; // Ham Buffer olarak döner
  }
}

// ------------------------------------------
// OLUŞTURMA (BUILD) TESTİ
// ------------------------------------------
if (require.main === module) {
  try {
    // Daha önce parse ettiğin dosyaları okuyalım
    const certPem = fs.readFileSync('./certs//357856003082948608/sign.crt', 'utf8');
    const keyPem = fs.readFileSync('./certs//357856003082948608/sign.key', 'utf8');
    
    // Sınıfı şifreyle başlatıyoruz
    const p12 = new PKCS12('123456');
    
    console.log("PFX ASN.1 Üretimi Başlatılıyor...");
    const yeniPfxBuffer = p12.build(certPem, keyPem);
    
    fs.writeFileSync('./sign.pfx', yeniPfxBuffer);
    console.log("-> BAŞARILI! 'sign.pfx' dosyası kaydedildi.");

  } catch(e) {
    console.error("İşlem Başarısız: ", e.message);
  }
}

module.exports = PKCS12;