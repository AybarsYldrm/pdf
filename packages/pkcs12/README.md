# @fitfak/pkcs12

Tam PKCS#12 (`.pfx` / `.p12`) okuyucu ve üretici — RFC 7292. Sıfır harici bağımlılık.

## Neden

Projedeki eski `pfx.js` yalnız **PBES2** (PBKDF2 + AES) destekliyordu. Oysa gerçek
dünyadaki `.pfx` dosyalarının çoğu — Windows sertifika deposu, Java keytool,
OpenSSL'in eski varsayılanı — **PKCS#12 PBE** şemalarını kullanır. Ayrıca MacData
hiç işlenmiyordu: yanlış parola net bir hata yerine sessizce çöp veri üretebiliyordu.

## Desteklenen şemalar

| OID | Şema | Oku | Yaz |
|-----|------|:---:|:---:|
| `1.2.840.113549.1.5.13` | PBES2 (AES-128/192/256-CBC, 3DES) | ✔ | ✔ (varsayılan) |
| `1.2.840.113549.1.12.1.3` | pbeWithSHAAnd3-KeyTripleDES-CBC | ✔ | ✔ |
| `1.2.840.113549.1.12.1.4` | pbeWithSHAAnd2-KeyTripleDES-CBC | ✔ | — |
| `1.2.840.113549.1.12.1.5` | pbeWithSHAAnd128BitRC2-CBC | ✔ | — |
| `1.2.840.113549.1.12.1.6` | pbeWithSHAAnd40BitRC2-CBC | ✔ | — |

RC2, modern OpenSSL'de "legacy provider" arkasında olduğu için **saf JavaScript**
olarak uygulanmıştır (`src/rc2.js`, RFC 2268 test vektörleriyle doğrulanmıştır).

## Kullanım

```js
const p12 = require('@fitfak/pkcs12');

// Parola gerektirmeden ön inceleme (arayüzde göstermek için)
p12.probe(der);
// → { version: 3, macAlgorithm: 'sha256', macIterations: 2048,
//     encryptionSchemes: ['pbes2'], bagCount: {...}, needsPassword: true }

// Aç
const store = p12.parse(der, 'parola');
// → { identities: [{ friendlyName, privateKeyPem, certificatePem,
//                    chainPems: [...], subject, issuer, notAfter, keyInfo }],
//     otherCertificates: [...], mac: { present, verified, algorithm } }

// Üret (MacData her zaman yazılır)
const der2 = p12.build({
  privateKeyPem, certificatePem, chainPems,
  password: 'yeni',
  friendlyName: 'Aybars YILDIRIM',
  encryption: 'pbes2-aes256-cbc',        // veya 'pkcs12-3des'
  kdf: { iterations: 600000, hash: 'sha256' },
  mac: { algorithm: 'sha256', iterations: 100000 }
});
```

## İmzalamaya bağlama

```js
const { Pkcs12Signer } = require('@fitfak/pades/src/signer');
const signer = Pkcs12Signer.from(pfxBuffer, 'parola');

// veya doğrudan:
await manager.sign({ mode: 'LT', pdfBuffer, pfx: pfxBuffer, pfxPassword: 'parola' });
```

## Hata kodları

`ERR_PKCS12_BAD_PASSWORD` · `ERR_PKCS12_PARSE` · `ERR_PKCS12_EMPTY` ·
`ERR_PKCS12_UNSUPPORTED_PBE` · `ERR_PKCS12_UNSUPPORTED_CIPHER` ·
`ERR_PKCS12_RC4_UNSUPPORTED` · `ERR_PKCS12_BUILD_ARGS`
