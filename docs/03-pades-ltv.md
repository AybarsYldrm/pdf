# 03 — PAdES & LTV: Standart Haritası ve Uygulama Planı

Hedef: **ETSI EN 319 142-1 · PAdES baseline B-LTA**, Adobe Acrobat ve
EU DSS doğrulayıcısında yeşil.

---

## 1. Standart Haritası

| Standart | Konu | Bizi ilgilendiren |
|----------|------|-------------------|
| ISO 32000-1 / 32000-2 | PDF | §12.8 dijital imza, `/ByteRange`, `/Contents`, AcroForm, DocMDP, DSS |
| ETSI EN 319 142-1 | PAdES baseline profilleri | B-B, B-T, B-LT, B-LTA seviyeleri |
| ETSI EN 319 142-2 | PAdES genişletilmiş profiller | DSS/VRI ayrıntıları |
| ETSI EN 319 122-1 | CAdES baseline | İmzalı/imzasız öznitelikler |
| ETSI TS 119 102-1 | Doğrulama prosedürü | Doğrulama raporu, sub-indication'lar |
| ETSI TS 119 312 | Kripto paketleri | İzinli algoritma/anahtar boyları |
| RFC 5652 | CMS | SignedData yapısı |
| RFC 5035 | ESS | `signing-certificate-v2` |
| RFC 3161 + RFC 5816 | Zaman damgası | TSQ/TSR, TSTInfo |
| RFC 6960 | OCSP | CertID, BasicOCSPResponse, yetkilendirme |
| RFC 5280 | X.509 / CRL | AIA, CDP, zincir doğrulama |
| RFC 7292 | PKCS#12 | PFX yapısı, KDF, MAC |

---

## 2. Seviye Tanımları ve Yapılacaklar

### B-B — Temel imza

CAdES-BES/EPES, detached, `/SubFilter /ETSI.CAdES.detached`.

| Gereksinim | Durum | Aksiyon |
|------------|:-----:|---------|
| `content-type` imzalı özniteliği | ✅ | — |
| `message-digest` imzalı özniteliği | ✅ | — |
| `signing-certificate-v2` (ESS, RFC 5035) | ✅ | — |
| `/SubFilter /ETSI.CAdES.detached` | ✅ | — |
| `/ByteRange` tüm dosyayı kapsar (yalnız `/Contents` hariç) | ✅ | Testle sabitlenecek |
| SignedData `certificates` alanı tam zincir | 🟡 | Kök CA dâhil etme politikası netleştirilecek |
| `signature-policy-identifier` (EPES) | ✅ (opsiyonel) | — |
| RSASSA-PSS desteği | ❌ | `oids.js`'e `id-RSASSA-PSS` + parametreler eklenecek |
| Ed25519 / Ed448 | ❌ | Faz 5'e ertelendi |
| SHA-3 aile | ❌ | Faz 5'e ertelendi |

**Ek doğrulama görevi:** `/Type /Sig` sözlüğünde `/M` (imza zamanı) ile CAdES
`signing-time` özniteliğinin **çelişmemesi**. PAdES, `/M`'yi tercih eder; ikisi de
konulacaksa aynı olmalı.

### B-T — Zaman damgalı

B-B + `signature-time-stamp-token` imzasız özniteliği (`signatureValue` üzerinden).

| Gereksinim | Durum | Aksiyon |
|------------|:-----:|---------|
| RFC 3161 TSQ üretimi (nonce + certReq) | ✅ | — |
| TSR'den TST çıkarımı, imprint/nonce doğrulaması | ✅ | — |
| **TST imzasının kriptografik doğrulanması** | ❓ | Zorunlu hâle getirilecek |
| **TSA sertifikasında `id-kp-timeStamping` (critical) kontrolü** | ❓ | Zorunlu hâle getirilecek |
| TSA zincirinin CMS'e/DSS'e gömülmesi | 🟡 | Netleştirilecek |
| Birden çok TSA yedeği (failover) | ❌ | Eklenecek |
| TSA politika OID kontrolü | ❌ | Opsiyonel doğrulama eklenecek |

### B-LT — Uzun vadeli doğrulama verisi

B-T + **DSS** (Document Security Store): imza yolundaki her sertifika ve her sertifika için
iptal kanıtı belgeye gömülür. Amaç: sertifikaların/CA'ların süresi dolduğunda bile imzanın
**çevrimdışı** doğrulanabilmesi.

| Gereksinim | Durum | Aksiyon |
|------------|:-----:|---------|
| `/DSS /Certs` | ✅ | — |
| `/DSS /OCSPs` | ✅ | — |
| `/DSS /CRLs` | ❌ | **`addLTV`'ye `crl` parametresi eklenecek** (bulgu 3.1.1) |
| `/DSS /VRI /<SHA1(Contents)>` | ✅ | Çoklu imza için genişletilecek (bulgu 3.1.5) |
| VRI `/TU` (doğrulama zamanı) | ❌ | Eklenecek |
| Her imza için ayrı VRI | ❌ | Eklenecek |
| TSA sertifika zinciri + iptal verisi | 🟡 | Tamamlanacak |
| OCSP responder sertifikası + zinciri | ✅ | `extractCertsFromDER` topluyor |
| Kök CA hariç **her** sertifika için iptal kanıtı | 🟡 | Kapsam denetimi eklenecek |
| Yalnız-CRL veren CA ile LT | ❌ | `ocsp` zorunluluğu kaldırılacak (bulgu 3.1.6) |

### B-LTA — Arşiv

B-LT + **DocTimeStamp** (`/Type /DocTimeStamp`, `/SubFilter /ETSI.RFC3161`).

| Gereksinim | Durum | Aksiyon |
|------------|:-----:|---------|
| DocTimeStamp eklenmesi | ✅ | — |
| `/Type /DocTimeStamp` (`/Sig` değil) | ❌ | Düzeltilecek (bulgu 3.1.7) |
| DocTS sözlüğünde `/M` bulunmaması | ❌ | Kaldırılacak |
| `/Perms /DocMDP` ile çakışmama | 🟡 | Test edilecek |
| **Arşiv damgasının TSA'sı için ikinci DSS revizyonu** | ❌ | Eklenecek (bulgu 3.1.4) |
| Zincirleme arşivleme (LTA-yenileme) | ❌ | `extendToLTA(pdf)` API'si eklenecek |

**Doğru LTA sırası:**

```
1. B-T imza                                   (revizyon N)
2. DSS: imza yolu + TSA-1 yolu için iptal     (revizyon N+1)   → B-LT
3. DocTimeStamp (TSA-2)                       (revizyon N+2)
4. DSS: TSA-2 yolu için sertifika + iptal     (revizyon N+3)   → B-LTA
```

4. adım olmadan arşiv damgası, kendi TSA sertifikası süresi dolduğunda doğrulanamaz.

---

## 3. `addLTV` Yeniden Tasarımı

### 3.1 Yeni sözleşme

```js
/**
 * @param {Object}   o
 * @param {Buffer}   o.pdfBuffer
 * @param {string[]} [o.certsPem]      Ek olarak gömülecek sertifikalar
 * @param {Array}    [o.ocsp]          [{ certPem, issuerPem, url? }]  url yoksa AIA'dan
 * @param {Array}    [o.crl]           [{ certPem, issuerPem, url? }]  url yoksa CDP'den
 * @param {boolean}  [o.autoDiscover]  varsayılan true — zinciri kendi çıkarır
 * @param {'ocsp-first'|'crl-first'|'both'} [o.prefer]  varsayılan 'ocsp-first'
 * @param {boolean}  [o.strict]        varsayılan true — eksik iptal kanıtı = hata
 * @param {Date}     [o.validationTime]
 * @returns {Promise<{ pdf: Buffer, report: LtvReport }>}
 */
```

```jsonc
// LtvReport
{
  "signatures": [
    { "vriKey": "A3F1…",                       // SHA1(/Contents) büyük harf hex
      "signerCN": "Aybars YILDIRIM",
      "path": [
        { "subject": "…Signer",  "source": "ocsp", "status": "good",
          "producedAt": "2026-08-10T12:00:03Z", "nextUpdate": "2026-08-17T…" },
        { "subject": "…Sub CA",  "source": "crl",  "status": "good",
          "thisUpdate": "…", "nextUpdate": "…" },
        { "subject": "…Root CA", "source": "trust-anchor" }
      ],
      "timestamps": [ { "tsa": "…", "genTime": "…", "pathComplete": true } ]
    }
  ],
  "embedded": { "certs": 7, "ocsps": 3, "crls": 2 },
  "achievedLevel": "B-LT",
  "warnings": []
}
```

### 3.2 Algoritma

```
1. TÜM imzaları bul  (/Type /Sig ve /Type /DocTimeStamp)
2. Her imza için:
     a. CMS'i parse et → signer cert + gömülü sertifikalar + TST'ler
     b. TST'lerden TSA sertifika zincirlerini çıkar
     c. Sertifika havuzunu birleştir (CMS + OCSP responder + verilen certsPem + AIA indirilen)
3. Havuzdan zincirleri kur:  subject/issuer DER eşleşmesi + AKI/SKI kontrolü
   (bugünkü latin1 arama yerine ASN.1 karşılaştırma)
4. Her sertifika için (kök hariç):
     a. AIA'dan OCSP URL'i, CDP'den CRL URL'i çıkar (gerçek ASN.1 çözümü)
     b. prefer politikasına göre iptal kanıtı al
     c. Kanıtı DOĞRULA:
        · OCSP: imza geçerli mi · responder yetkili mi (issuer ya da id-kp-OCSPSigning)
                · CertID eşleşiyor mu · thisUpdate ≤ now ≤ nextUpdate · status ≠ revoked
        · CRL : imza geçerli mi · issuer doğru mu · thisUpdate ≤ now ≤ nextUpdate
                · seri numarası listede mi · IDP/delta-CRL uyumu
     d. Doğrulanamayan kanıt DSS'e KONMAZ; strict ise hata
5. DSS yaz:  Certs ∪  OCSPs ∪  CRLs  +  imza başına VRI (+ /TU)
6. Rapor döndür
```

### 3.3 Yeni yardımcı: `packages/pades/src/cades/x509_ext.js`

```js
extractAIA(certDer)   // → { ocsp: string[], caIssuers: string[] }
extractCDP(certDer)   // → { http: string[], ldap: string[], reasons?, crlIssuer? }
extractAKI(certDer)   // → { keyId?: Buffer, serial?: Buffer, issuer?: Buffer }
extractSKI(certDer)   // → Buffer
buildChain(leafDer, poolDer[])  // → { path: Buffer[], complete: boolean, anchor?: Buffer }
```

Temel: `@fitfak/ssl/src/asn1.js` (`readTLV`, `readChildren`, `decodeOidHex`).
Bu, `index.js:101` ve `pades_manager.js:494`'teki regex'leri **tamamen ortadan kaldırır**.

---

## 4. PKCS#12 (`@fitfak/pkcs12`) Tasarımı

### 4.1 API

```js
const { parse, build, probe } = require('@fitfak/pkcs12');

probe(der);
// → { macAlgorithm:'sha256', macIterations:100000, encryptionSchemes:['pbes2-aes256-cbc'],
//     bagCount:{cert:3,key:1}, needsPassword:true }   // parola gerektirmez

const store = parse(der, password, { verifyMac: true });
// → { identities: [ { friendlyName, localKeyId,
//                     privateKeyPem, certificatePem, chainPems:[…],
//                     keyInfo:{type:'ec',curve:'P-256'} } ],
//     otherCertificates: [ pem… ],
//     mac: { verified: true, algorithm:'sha256', iterations: 100000 } }

const der2 = build({
  privateKeyPem, certificatePem, chainPems,
  password, friendlyName: 'Aybars YILDIRIM',
  encryption: 'pbes2-aes256-cbc',     // | 'pkcs12-3des' (eski uyum)
  kdf: { iterations: 600000, hash: 'sha256' },
  mac: { algorithm: 'sha256', iterations: 600000 }   // | false
});
```

### 4.2 Desteklenecek şifreleme şemaları

| OID | İsim | Parse | Build |
|-----|------|:-----:|:-----:|
| `1.2.840.113549.1.5.13` | PBES2 (AES-128/192/256-CBC, 3DES) | ✅ var | ✅ varsayılan |
| `1.2.840.113549.1.12.1.3` | pbeWithSHAAnd3-KeyTripleDES-CBC | **eklenecek** | opsiyonel |
| `1.2.840.113549.1.12.1.4` | pbeWithSHAAnd2-KeyTripleDES-CBC | **eklenecek** | — |
| `1.2.840.113549.1.12.1.5` | pbeWithSHAAnd128BitRC2-CBC | **eklenecek** | — |
| `1.2.840.113549.1.12.1.6` | pbeWithSHAAnd40BitRC2-CBC | **eklenecek** | — |

### 4.3 Yazılacak parçalar

1. **PKCS#12 KDF (RFC 7292 Ek B).** PBKDF2 *değildir*. `id=1` şifreleme anahtarı,
   `id=2` IV, `id=3` MAC anahtarı. Parola **BMPString** (UTF-16BE + çift null sonlandırma)
   olarak kodlanır — en sık yapılan hata budur.
2. **RC2-CBC (RFC 2268).** Node'un modern OpenSSL'inde legacy provider arkasında.
   `crypto.createDecipheriv('rc2-40-cbc')` denenir, başarısızsa saf JS RC2'ye düşülür
   (~120 satır; efektif anahtar bit uzunluğu parametresi kritik).
3. **MacData.** `SEQUENCE { DigestInfo, salt, iterations }`. Doğrulama = yanlış parolanın
   **tek güvenilir** göstergesi. `PBMAC1` (RFC 9579) desteklenir.
4. **Bag attribute'ları.** `localKeyId` (1.2.840.113549.1.9.21) ve
   `friendlyName` (…9.20) okunur → anahtar↔sertifika eşleşmesi ve kimlik adları.
5. **Zincir sıralama.** Havuzdaki sertifikalar issuer/subject ile leaf→kök sıralanır.
6. **Tarayıcı yapısı.** Aynı kaynak `dist/pkcs12.esm.js` olarak da derlenir (Node `Buffer`
   yerine `Uint8Array`; `node:crypto` yerine `WebCrypto`). Bundler yok — küçük bir
   `platform.js` adaptörü yeterli.

### 4.4 Mevcut `pfx.js`'in kaderi

`pfx.js` → `packages/pkcs12/src/legacy-reference.js` olarak arşivlenir; yeni uygulama
onun ASN.1 kullanımını temel alır ama testleri gerçek dünya dosyalarıyla yapılır:

```
test/fixtures/pkcs12/
  openssl3-aes256.pfx      openssl1-3des.pfx      windows-export.pfx
  java-keytool.pfx         rc2-40.pfx             no-mac.pfx
  multi-identity.pfx       empty-password.pfx     unicode-password.pfx
```

Bu dosyalar `@fitfak/ssl` + `openssl` ile **üretim betiğiyle** oluşturulur, repoya
gerçek anahtar konmaz (parola: `test`).

---

## 5. Doğrulama Motoru (`@fitfak/verify`)

### 5.1 API

```js
const report = await verifyPdf(pdfBuffer, {
  trustAnchors: [...pem],          // varsayılan: tls.rootCertificates
  validationTime: new Date(),      // veya 'signing-time' | 'timestamp'
  useEmbeddedRevocation: true,     // LTV kanıtını tercih et
  allowNetwork: false,             // çevrimdışı doğrulama testi
  policy: 'etsi-baseline'
});
```

### 5.2 Rapor (ETSI TS 119 102-1 uyumlu)

```jsonc
{
  "documentIntegrity": {
    "revisions": 4,
    "signedRevisions": [1, 2, 3, 4],
    "modifiedAfterSigning": false,
    "unsignedBytes": 0
  },
  "signatures": [{
    "fieldName": "Signature_a3f1",
    "type": "approval",              // approval | certification | doc-timestamp
    "indication": "TOTAL-PASSED",    // TOTAL-PASSED | INDETERMINATE | TOTAL-FAILED
    "subIndication": null,           // ör. NO_CERTIFICATE_CHAIN_FOUND, REVOKED_NO_POE …
    "achievedLevel": "B-LTA",
    "signer": { "cn": "…", "serial": "…", "issuer": "…",
                "notBefore": "…", "notAfter": "…", "keyUsage": […] },
    "coverage": { "byteRange": [...], "coversWholeDocument": true },
    "digest": { "algorithm": "sha256", "matches": true },
    "cms": { "signatureValid": true, "signedAttrsValid": true,
             "signingCertificateV2Matches": true },
    "chain": [ … ],
    "revocation": [ { "cert": "…", "source": "dss-ocsp", "status": "good",
                      "producedAt": "…", "poe": "timestamp" } ],
    "timestamps": [ { "type":"signature-timestamp", "genTime": "…",
                      "tsa": "…", "valid": true, "hashAlgorithm": "sha256" } ],
    "visual": { "page": 0, "rect": [...], "hasAppearance": true },
    "warnings": [], "errors": []
  }],
  "ltv": { "dssPresent": true, "certs": 7, "ocsps": 3, "crls": 2,
           "vriPerSignature": true, "offlineVerifiable": true }
}
```

### 5.3 Doğrulama adımları

1. **Revizyon analizi.** Tüm `%%EOF` sınırlarını çıkar, her imzanın ByteRange'inin hangi
   revizyona denk geldiğini bul. ByteRange dışında bayt varsa "imzadan sonra değiştirildi".
2. **Fark analizi.** Ardışık revizyonlar arasında değişen nesneleri karşılaştır → izinli
   değişiklikler (yeni imza, DSS ekleme, form doldurma) vs. izinsiz (içerik değişikliği).
   DocMDP seviyesine göre karar.
3. **CMS doğrulaması.** `signedAttrs` DER'i yeniden kur, digest karşılaştır, imzayı
   doğrula, `signing-certificate-v2` hash'i imzalayan sertifikayla eşleşiyor mu bak.
4. **Zincir kurulumu ve doğrulama.** RFC 5280 yol doğrulaması: imza, geçerlilik,
   `basicConstraints`, `keyUsage`, `pathLen`, isim kısıtları.
5. **İptal kontrolü.** Önce DSS (çevrimdışı LTV kanıtı), yoksa ağ (izin verilmişse).
   **POE (Proof of Existence)** hesabı: zaman damgası, sertifika süresi dolmuş olsa bile
   imzanın o an geçerli olduğunu kanıtlar → `REVOKED_NO_POE` / `OUT_OF_BOUNDS_NO_POE`
   ayrımı burada yapılır.
6. **Seviye tespiti.** Yukarıdaki bulgulara göre B-B / B-T / B-LT / B-LTA.

`test/validation.js` bu motorun tohumudur — sınıf `packages/verify/` altına taşınır,
assert'lı testlerle sarılır.

---

## 6. Offline Test PKI'ı

Ağa bağımlı olmayan, tekrarlanabilir E2E testi için tam bir sahte ekosistem —
**tamamı `@fitfak/ssl` ile**, ek bağımlılık yok:

```
test/e2e/pki/
├── ca.js       Root CA → Sub CA → (signer, tsa, ocsp-responder) sertifikaları
├── ocsp.js     createOcspResponderHandler  →  http://127.0.0.1:8081/ocsp
├── crl.js      createCrlServerHandler      →  http://127.0.0.1:8082/ca.crl
└── tsa.js      test/timestamp.js'ten uyarlanmış → http://127.0.0.1:8083/tsa
```

Üretilen sertifikalara **gerçek AIA ve CDP uzantıları** konur (yerel adresleri gösterir),
böylece otomatik keşif kodu gerçekten sınanır.

**E2E senaryoları:**

| # | Senaryo | Beklenen |
|---|---------|----------|
| 1 | HTML → PDF → B-B imza | `TOTAL-PASSED`, level `B-B` |
| 2 | + TSA | level `B-T` |
| 3 | + OCSP → DSS | level `B-LT`, çevrimdışı doğrulanır |
| 4 | Yalnız-CRL veren CA ile | level `B-LT` (bulgu 3.1.6 kapandı) |
| 5 | + DocTS + ikinci DSS | level `B-LTA` |
| 6 | Çoklu imza (2 imzacı) | 2 imza, 2 VRI, ikisi de geçerli |
| 7 | İmzadan sonra bayt değiştir | `TOTAL-FAILED` / `HASH_FAILURE` |
| 8 | İmzadan sonra revizyon ekle | ilk imza geçerli, "değiştirildi" bayrağı |
| 9 | İptal edilmiş sertifika | `TOTAL-FAILED` / `REVOKED` |
| 10 | Süresi dolmuş sertifika + geçerli TST | `TOTAL-PASSED` (POE sayesinde) |
| 11 | 6 farklı formatta PFX ile imza | hepsi parse edilir ve imzalar |
| 12 | Xref-stream'li PDF'i imzala | başarılı |
| 13 | Şifreli PDF'i imzala | doğru hata veya destek |
| 14 | TSA erişilemez, `strict:false` | B-B üretilir + uyarı, sessiz düşüş yok |

Hepsi ağsız, saniyeler içinde, CI'da çalışır.

---

## 7. Dış Doğrulayıcı Kontrol Listesi (manuel, sürüm öncesi)

| Araç | Ne kontrol eder |
|------|-----------------|
| Adobe Acrobat Reader | İmza paneli: "İmza geçerli", "LTV etkin", "Belge değiştirilmedi" |
| EU DSS Demo (`ec.europa.eu/digital-building-blocks/DSS`) | ETSI seviye tespiti + doğrulama raporu |
| `pdfsig` (poppler-utils) | ByteRange, CMS, sertifika |
| veraPDF | PDF/A uyumu (üretim tarafı) |
| `openssl cms -verify` | CMS'in bağımsız doğrulaması |
| `openssl ts -verify` | TST'nin bağımsız doğrulaması |

Sürüm çıkmadan bu altı kontrolün çıktıları `docs/conformance/<sürüm>/` altına kaydedilir.
