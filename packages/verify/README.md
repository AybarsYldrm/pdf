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
  allowNetwork: false           // çevrimdışı doğrulama
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
| Seviye | B-B / B-T / B-LT / B-LTA tespiti |

**Belge zaman damgaları ayrı yoldan doğrulanır:** bir DocTimeStamp'in CMS'i bir
TST'dir (eContentType = `id-ct-TSTInfo`), `message-digest`'i PDF'i değil TSTInfo'yu
özetler; PDF'in ByteRange özeti `TSTInfo.messageImprint` ile karşılaştırılır.
