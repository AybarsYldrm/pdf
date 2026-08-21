# @fitfak/verify

PDF imza doğrulama motoru. ETSI TS 119 102-1 biçiminde rapor üretir.

## Kilit iddia: çevrimdışı doğrulama

LTV verisi gömülü (B-LT / B-LTA) bir belge, **ağa hiç çıkmadan** doğrulanabilir.
Testler `allowNetwork: false` ile koşar; geçmeleri bunun kanıtıdır.

```js
const { verifyPdf } = require('@fitfak/verify');

const report = await verifyPdf(pdfBuffer, {
  trustAnchors: [rootPem],      // varsayılan: Node'un sistem kök deposu
  validationTime: new Date(),
  useEmbeddedRevocation: true,  // önce DSS'teki kanıt
  allowNetwork: false,          // çevrimdışı doğrulama

  // Sertifikadan gelen AIA/CDP adresleri iç ağa çıkabilsin mi?
  // VARSAYILAN HAYIR: o adresleri imzalayan değil, sertifikayı üreten
  // yazar — 127.0.0.1, ::1, 169.254.169.254 ve özel ağlar engellidir.
  // Kurum içi PKI için bilinçli olarak açılır.
  allowPrivateNetwork: false,

  // İptal kanıtı EKSİKSE ne olsun? Varsayılan uyarıdır (çevrimdışı B-B
  // doğrulaması meşru bir kullanımdır). `true` verilirse eksik kanıt
  // INDETERMINATE / TRY_LATER üretir.
  requireRevocation: false,

  // Algoritma politikası (ETSI TS 119 312). Varsayılan eşikler:
  // kırık özetler reddedilir, RSA ≥ 2048, EC ≥ 256.
  algorithmPolicy: { minRsaBits: 3072 }
});
```

## Rapor

```jsonc
{
  "documentIntegrity": {
    "revisions": 4, "signatureCount": 2,
    "modifiedAfterSigning": false,
    "unsignedBytes": 25567,
    "trailingRevisionIsValidationData": true   // DSS eklemesi "değişiklik" sayılmaz
  },
  "signatures": [{
    "type": "signature",                 // signature | doc-timestamp
    "indication": "TOTAL-PASSED",        // TOTAL-PASSED | INDETERMINATE | TOTAL-FAILED
    "subIndication": null,               // HASH_FAILURE, REVOKED_NO_POE, …
    "achievedLevel": "B-LTA",
    "signer": { "cn": "…", "serialNumber": "…", "notAfter": "…" },
    "coverage": { "byteRange": [...], "coversWholeDocument": true },
    "cms": { "signatureValid": true, "messageDigestMatches": true,
             "signingCertificateV2Matches": true },
    "chain": [ … ],                       // .trusted alanı güven çıpasını söyler
    "revocation": [{ "source": "dss-crl", "status": "good", … }],
    "timestamps": [{ "type": "signature-timestamp", "valid": true,
                     "imprintMatches": true, "ekuValid": true, "genTime": "…" }],
    "poe": { "time": "…", "source": "signature-timestamp", "tsa": "…" },
    "errors": [], "warnings": []
  }],
  "ltv": { "dssPresent": true, "certs": 7, "ocsps": 3, "crls": 2,
           "offlineVerifiable": true }
}
```

## Ne kontrol eder

| Adım | İçerik |
|------|--------|
| Kapsam | `/ByteRange` belgenin neresini kapsıyor; sonrasında ne var |
| Bütünlük | Kapsanan baytların özeti `message-digest` ile eşleşiyor mu |
| CMS | `signedAttrs` üzerinden imza, `content-type`, `signing-certificate-v2` (ESS) |
| Zincir | Yol kurulumu (AKI/SKI dâhil), her halkanın imzası, güven çıpası |
| İptal | Önce DSS'teki CRL/OCSP (çevrimdışı), sonra izin verilirse ağ |
| Zaman damgası | TST'nin kendi CMS imzası, `messageImprint` eşleşmesi, TSA'da `id-kp-timeStamping` EKU (RFC 3161 §2.3) |
| POE | Geçerli damga varsa doğrulama zamanı damga anına çekilir — süresi dolmuş sertifikayla imza geçerli kalır |
| Yol kısıtları | RFC 5280 §6.1: `basicConstraints`, `keyCertSign`, `pathLenConstraint`, tanınmayan kritik uzantı, `nameConstraints` |
| Algoritma | Kırık özet (SHA-1, MD5) ve kısa anahtar reddi — ETSI TS 119 312 |
| Sonraki sürümler | İmzadan sonra eklenen bölüm belgenin GÖRÜNEN içeriğini değiştiriyor mu (iki sürüm açılıp karşılaştırılır) |
| Seviye | B-B / B-T / B-LT / B-LTA tespiti |

## Neyi ne kadar iddia ediyoruz

Bu tablo, raporun ne söylediğini ve ne SÖYLEMEDİĞİNİ açık tutmak içindir.

| Sonuç | Anlamı | Anlamı DEĞİL |
|-------|--------|--------------|
| `TOTAL-PASSED` | İmza geçerli, zincir güvenilen köke ulaştı, kısıtlar sağlandı | "Sertifika kesinlikle iptal edilmemiş" — iptal kanıtı yoksa yalnız *bilinen bir iptal yok* demektir (`revocationComplete` alanına bakın) |
| `cms.signatureValid: true` | Kriptografik imza, kapsanan baytları doğruluyor | "Belgenin tamamı imzalı" — `coverage.coversWholeDocument` ayrı bir sorudur |
| `INDETERMINATE` / `DOC_MODIFIED_AFTER_SIGNING` | İmza sağlam ama belge imzalandığı hâlde değil | "İmza sahte" |
| `INDETERMINATE` / `CRYPTO_CONSTRAINTS_FAILURE_NO_POE` | İmza matematiksel olarak doğrulandı ama algoritma/anahtar politika altında | "İmza doğrulanamadı" |
| `chain.trusted: true` | Yolun ucu, güven deposundaki sertifikanın TA KENDİSİ (DER/SPKI kimliği) | "Aynı isimli bir kök" — ad bir kimlik değildir |

**Belge zaman damgaları ayrı yoldan doğrulanır:** bir DocTimeStamp'in CMS'i bir
TST'dir (eContentType = `id-ct-TSTInfo`), `message-digest`'i PDF'i değil TSTInfo'yu
özetler; PDF'in ByteRange özeti `TSTInfo.messageImprint` ile karşılaştırılır.
