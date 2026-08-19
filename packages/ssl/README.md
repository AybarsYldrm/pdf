# @fitfak/ssl — node:crypto Tabanlı PKI Motoru

Bu paket, saf JavaScript ile elle yazılmış kriptografik ilkelleri (hash, HMAC,
AES-GCM, RSA, EC, X25519) **Node.js'in yerleşik `crypto` modülüne (OpenSSL)**
taşıyan ve X.509 PKI altyapısını (CSR, CRL, OCSP, sertifika zinciri
doğrulama, HTTP responder sunucuları) ciddi ölçüde güçlendiren bir sürümdür.

> **ML-KEM (Kyber) ve ML-DSA (Dilithium)** Node'un `crypto` modülünde henüz
> yerleşik olmadığından saf JavaScript olarak **kalmaya devam eder**
> (`src/mlkem.js`, `src/mldsa.js`) — bunlar dokunulmadan korunmuştur.

## Neden bu değişiklik?

Elle yazılmış kriptografik kod (özel modüler üs, Jacobian eğri aritmetiği,
elle AES S-Box/MixColumns, elle RFC 6979 vb.) performans kaybının yanında
**yan-kanal saldırıları ve ince mantık hatalarına** açıktır. Bu sürümde tüm
gerçek kriptografik işlemler (anahtar üretimi, imzalama, şifreleme, ECDH)
OpenSSL'in denetimden geçmiş, sabit-zamanlı uygulamasına devredilmiştir.

## Geriye Dönük Uyumluluk Garantisi

**Tüm eski fonksiyonların isimleri, parametre sırası ve dönüş şekilleri
AYNEN korunmuştur.** Bu paketi kullanan mevcut servisler hiçbir değişiklik
yapmadan çalışmaya devam eder. Örnekler:

- `generateRsaKeyPair(bits)` hâlâ `{n,e,d,p,q,dp,dq,qInv,bits}` (ham BigInt
  alanları) döner — artık içeride `crypto.generateKeyPairSync('rsa', ...)`
  kullanılır ama dışa dönen şekil değişmedi.
- `rsaSign(key, data, hashAlg)` — tam CRT alanları (`p,q,dp,dq,qInv`)
  mevcutsa `node:crypto` (hızlı/donanımsal) yolunu kullanır; yalnızca
  `{n,d}` verilen eski tarz çağrılarda otomatik olarak eski BigInt tabanlı
  yola düşer (fallback) — hiçbir çağıran kod kırılmaz.
- `ecdsaSign`, `ecdhCompute`, `generateEcKeyPair`, `x25519`, `gcmEncrypt`,
  `hmac`, `sha256` vb. — hepsi aynı imza, aynı çıktı biçimi.
- PEM üretimi (`rsaPrivToPem`, `ecPrivToPem`) artık `node:crypto`'nun kendi
  PKCS#1/SEC1 exportunu kullanıyor ve **eski implementasyonla byte-byte
  aynı PEM çıktısını üretiyor** (test edildi).

Yeni yetenekler (CSR ayrıştırma, zincir doğrulama, OCSP/CRL HTTP sunucuları,
`CertificateAuthority` kolaylık sınıfı, yapılandırma) **eklenti** olarak
sunulur; hiçbir mevcut export kaldırılmadı veya adı değiştirilmedi.

## Kurulum / Çalıştırma

```bash
node test.js   # veya: npm test
```
Node **18+** gerektirir (`crypto.X509Certificate`, `crypto.diffieHellman`,
`crypto.hkdfSync` gibi API'ler için).

---

## Kolay Sertifika Üretimi (v2.1)

### OID'ler artık noktalı-ondalık — elle hex YOK

```js
// ESKİDEN (elle DER hesabı):
lib.asn1.OID('2b 06 01 04 01 83 fc 6d 01 01');

// ŞİMDİ (her üç biçim de çalışır):
lib.asn1.OID('1.3.6.1.4.1.65133.1.1');   // noktalı-ondalık — ÖNERİLEN
lib.asn1.OID('timeStamping');            // bilinen ad
lib.encodeOid('1.3.6.1.4.1.65133.1.1');  // → '2b0601040183fc6d0101'
lib.decodeOid('2b0601040183fc6d0101');   // → '1.3.6.1.4.1.65133.1.1'
```
Bu, `eku`, `policies` ve tüm uzantı oluşturucuları için geçerlidir.

### Hazır profiller — doğru KeyUsage/EKU/critical otomatik

`lib.listProfiles()` → `tls-server`, `tls-client`, `tls-both`, `tsa`,
`ocsp-responder`, `code-signing`, `email`, `encryption`, `ca`

```js
const tsa = lib.issueCertificateFromCSR(csrPem, issuingCA, { profile: 'tsa' });
```
`profile:'tsa'` şunları OTOMATİK uygular (RFC 3161 §2.3):
`KeyUsage = digitalSignature + nonRepudiation (critical)`,
`EKU = timeStamping` ve **EKU critical** — bu son madde sık atlanır.
`profile:'ocsp-responder'` ayrıca `ocspNoCheck` uzantısını da ekler.

### Certificate Policies — CPS URL + User Notice

```js
policies: [{
  oid:    '1.3.6.1.4.1.65133.1.1',
  cps:    'https://fitfak.com/cps',
  notice: { organization: 'FITFAK', noticeNumbers: [1],
            text: 'FITFAK Zaman Damgası Politikası' },
}]
// Kısa biçim: policies: '1.3.6.1.4.1.65133.1.1'
```
Üretilen çıktı:
```
X509v3 Certificate Policies:
    Policy: 1.3.6.1.4.1.65133.1.1
      CPS: https://fitfak.com/cps
      User Notice:
        Organization: FITFAK
        Explicit Text: FITFAK Zaman Damgası Politikası
```

### OCSP / CRL adresleri — sabit yol eki YOK

```js
// ESKİDEN: aiaUrl'in sonuna zorla '/ocsp' ekleniyordu.
// ŞİMDİ tam adresi siz belirliyorsunuz:
ocspUrl:      'http://ocsp.fitfak.com',
caIssuersUrl: 'http://pki.fitfak.com/issuing.crt',
crlUrls:      ['http://crl.fitfak.com/issuing.crl'],
```
Eski `crlUrl` / `aiaUrl` (taban adres) biçimi de çalışmaya devam eder.

### critical bayrağı — her uzantı için

`keyUsageCritical` (varsayılan `true`), `ekuCritical`, `sanCritical`,
`policiesCritical`, `aiaCritical` — hepsi tek tek ayarlanabilir. Ayrıca
`isCA` / `pathLen` ile CA kısıtlaması, `extraExtensions` ile tamamen özel
uzantılar eklenebilir.

### Tam örnek — kullanıcının TSA senaryosu, tek çağrıda

```js
const tsaCert = lib.issueCertificateFromCSR(csrPem, issuingCA, {
  profile: 'tsa',
  policies: [{ oid: '1.3.6.1.4.1.65133.1.1',
               cps: 'https://fitfak.com/cps',
               notice: 'FITFAK TSA politikası' }],
  ocspUrl:      'http://ocsp.fitfak.com',
  caIssuersUrl: 'http://pki.fitfak.com/issuing.crt',
  crlUrls:      ['http://crl.fitfak.com/issuing.crl'],
  validityDays: 825,
});
```
Çalışan tam gösterim için: **`node example.js`**

---

## Modül Haritası

| Dosya | İçerik |
|---|---|
| `src/hash.js` | sha1/256/384/512 (`crypto.createHash`) |
| `src/hmac.js` | HMAC + HKDF (`crypto.createHmac`, `crypto.hkdfSync`) |
| `src/aes.js` | AES-GCM (`crypto.createCipheriv/Decipheriv`) |
| `src/rsa.js` | RSA anahtar üretimi/imza/OAEP (`crypto.generateKeyPairSync`, `crypto.sign/verify`, `crypto.publicEncrypt/privateDecrypt`) |
| `src/ec.js` | EC (P-256/384/521) + X25519 (`crypto.generateKeyPairSync`, `crypto.sign/verify`, `crypto.diffieHellman`) |
| `src/keys.js` | Ham anahtar ↔ PEM (PKCS#1/SEC1) — `node:crypto` export/import |
| `src/bigint.js` | Genel modüler aritmetik yardımcıları (değişmedi — geriye dönük uyumluluk) |
| `src/oid.js` | **Yeni** — genişletilmiş kanonik OID kayıt defteri |
| `src/profiles.js` | **Yeni** — hazır sertifika profilleri (tsa, ocsp-responder, encryption, ...) |
| `src/_dp.js` | **Yeni** — CRL/AIA dağıtım noktası adres çözümleyici |
| `src/config.js` | **Yeni** — yapılandırılabilir varsayılanlar (Subject/DN, geçerlilik süreleri, anahtar boyutları) |
| `src/asn1.js` | DER ilkelleri, X.509 uzantı oluşturucular (basicConstraints/keyUsage/EKU/SAN/AKID/SKID/CDP/AIA) |
| `src/pki.js` | Sertifika/CSR/CRL/OCSP DER üretimi ve ayrıştırması |
| `src/csr.js` | **Yeni** — CSR ayrıştırma, öz-imza doğrulama, CSR'den sertifika üretme |
| `src/chain.js` | **Yeni** — sertifika zinciri doğrulama (`crypto.X509Certificate` tabanlı) |
| `src/http-ocsp.js` | **Yeni** — OCSP responder (req,res) HTTP işleyicisi + istemci gönderici |
| `src/http-crl.js` | **Yeni** — CRL dağıtım noktası (req,res) HTTP işleyicisi + istemci indirici |
| `src/ca-manager.js` | **Yeni** — `CertificateAuthority` kolaylık sınıfı (hiyerarşi + kayıt + CRL/OCSP) |
| `src/mlkem.js`, `src/mldsa.js` | ML-KEM-768 / ML-DSA-65 (post-kuantum, saf JS — **değişmedi**) |

---

## Hızlı Başlangıç

### 1) En kolay yol — `CertificateAuthority`

```js
const { CertificateAuthority } = require('@fitfak/ssl');

// Kök CA + Ara CA otomatik üretilir
const ca = CertificateAuthority.create({
  useIntermediate: true,
  subject: undefined,                 // veya özel DN: [[oid,val], ...]
  organization: 'ACME A.Ş.',          // varsayılanları tek tek override edebilirsiniz
  country: 'TR',
  crlUrl: 'http://ca.acme.com/crl',
  aiaUrl: 'http://ca.acme.com',
});

const leaf = ca.issueLeaf('app.acme.com', {
  sans: [{ type: 'dns', value: 'www.app.acme.com' }],
});

console.log(ca.getChainPem());   // istemcilere dağıtılacak ara+kök PEM
console.log(leaf.certPem, leaf.privateKey);

// İptal + CRL/OCSP
ca.revoke(leaf_serial_number, 1 /* keyCompromise */);
const crlPem = ca.getCrlPem();

// Gerçek HTTP sunucuları:
const http = require('http');
http.createServer(ca.ocspHandler()).listen(8080);
http.createServer(ca.crlHandler()).listen(8081);
```

### 2) Manuel adım adım (eski API ile birebir aynı)

```js
const {
  generateRootCA, generateIntermediateCA, generateEndEntityCert,
  verifyChain,
} = require('@fitfak/ssl');

const root  = generateRootCA({ bits: 2048 });
const inter = generateIntermediateCA(root, { crlUrl: '...', aiaUrl: '...' });
const ee    = generateEndEntityCert(inter, 'app.example.com', {
  sans: [{ type: 'dns', value: 'alt.example.com' }],
});

const result = verifyChain(ee.certPem, [inter.certPem], [root.certPem]);
console.log(result.ok, result.errors);
```

### 3) CSR akışı (istemci CSR üretir → CA imzalar)

```js
const { generateRsaKeyPair, generateCSR, parseCSR, verifyCSR,
        issueCertificateFromCSR } = require('@fitfak/ssl');

// İstemci tarafı:
const key = generateRsaKeyPair(2048);
const csrPem = generateCSR(
  { keyType: 'rsa', ...key },
  [[ '550406', 'TR'], ['550403', 'client.example.com']],   // veya oid.OIDs.country/commonName
  [{ type: 'dns', value: 'client.example.com' }],
);

// CA tarafı:
const csr = parseCSR(csrPem);
if (!verifyCSR(csr)) throw new Error('CSR imzası geçersiz');
const issued = issueCertificateFromCSR(csr, root, {
  crlUrl: 'http://ca.example.com/crl', aiaUrl: 'http://ca.example.com',
});
```

### 4) OCSP responder + istemci (ham API ile)

```js
const { buildOcspRequest, parseOcspRequest, generateOcspResponse,
        verifyOcspResponse, createOcspResponderHandler,
        sendOcspRequest } = require('@fitfak/ssl');

// Sunucu:
const handler = createOcspResponderHandler({
  issuerCA: inter, responderKey: inter, responderCertDer: inter.certDer,
  getStatus: (serial) => myDb.lookup(serial) /* {status:'good'|'revoked', reason?, revokedAt?} */,
});
require('http').createServer(handler).listen(8080);

// İstemci:
const { der } = buildOcspRequest(inter, leafSerialNumber, { nonce: true });
const respDer = await sendOcspRequest('http://ca.example.com:8080/', der);
const { ok } = verifyOcspResponse(respDer, inter);
```

### 5) Yapılandırma (varsayılanları değiştirme)

```js
const { configure, resetDefaults } = require('@fitfak/ssl');

configure({
  rootCA:  { organization: 'ACME A.Ş.', country: 'TR' },
  endEntity: { organization: 'ACME Servis Birimi', validityDays: 90 },
  key: { rsaBits: 3072, curve: 'P-384', hashAlg: 'sha384' },
});

// ...bundan sonra çağrılan generateRootCA({}) vb. yukarıdaki varsayılanları kullanır.

resetDefaults(); // fabrika ayarlarına dön
```
Her fonksiyon çağrısında `opts.subject` (tam DN dizisi), `opts.country`,
`opts.organization`, `opts.commonName`, `opts.validityDays`,
`opts.notBefore`/`opts.notAfter` ile yerel olarak da override edilebilir.

---

## API Referansı (özet)

### Klasik ilkeller
- `sha1/256/384/512(data)`, `hashByName(alg, data)`
- `hmac(alg,key,data)`, `hmac256/384/512(key,data)`, `hkdf(alg,ikm,salt,info,len)`, `hkdfExtract/hkdfExpand`
- `gcmEncrypt(key,iv,pt,aad?) → {ciphertext,tag}`, `gcmDecrypt(key,iv,ct,aad,tag) → pt`
- `generateRsaKeyPair(bits)`, `rsaSign/rsaVerify`, `rsaOaepEncrypt/Decrypt`
- `generateEcKeyPair(curve)`, `ecdsaSign/Verify`, `ecdhCompute`, `generateX25519KeyPair`, `x25519`
- `rsaPrivToPem/ecPrivToPem`, `pemToRsaPriv/pemToEcPriv`, `certInfoFromPem`

### PKI üretimi
- `generateRootCA/generateIntermediateCA/generateEndEntityCert` (RSA)
- `generateEcRootCA/generateEcIntermediateCA/generateEcEndEntityCert` (EC — hibrit zincirler de desteklenir: EC ara CA'yı RSA kök imzalayabilir ve tam tersi)
- `generateCSR(keyInfo, nameAttrs, sans?, hashAlg?)`
- `generateCRL(issuerCA, revokedList, opts?)`, `parseCRL(pem)`
- `generateOcspResponse(...)`, `parseOcspRequest(der)`, `verifyOcspResponse(...)`, `buildOcspRequest(issuerCA, serial(s), opts?)` **(yeni)**
- `createCertificate(config)` — birleşik fabrika

### Yeni: CSR işleme
- `parseCSR(pemOrDer)` → `{ subjectNameDer, spkiDer, publicKey, sans, hashAlg, tbs, signature, der }`
- `verifyCSR(csr)` → `boolean` (öz-imza doğrulaması)
- `issueCertificateFromCSR(csr, issuerCA, opts)` → `{ pem, der, publicKey, skid }`

### Yeni: Zincir doğrulama
- `verifyChain(leafCert, intermediates[], trustedRoots[], opts?)` → `{ ok, errors[], chain[], rootMatched }`
- `verifyLink(cert, issuerCert, opts?)` → tek bağlantı için
- `inspectCert(cert)` → `{ subject, issuer, validFrom, validTo, ca, basicConstraints, keyUsage, ... }`

### Yeni: HTTP sunucu/istemci yardımcıları
- `createOcspResponderHandler(opts)` → `(req,res) => Promise<void>` — GET (RFC 6960 Ek A) ve POST destekler
- `sendOcspRequest(url, der)` → `Promise<Buffer>`
- `createCrlServerHandler(opts)` → `(req,res) => Promise<void>` — ETag/If-None-Match destekler
- `fetchCrl(url)` → `Promise<Buffer>`

### Yeni: Üst-seviye yönetim
- `class CertificateAuthority` — `.issueLeaf()`, `.issueFromCSR()`, `.revoke()`, `.getCrlPem()`, `.ocspHandler()`, `.crlHandler()`, `.list()`, `.getChainPem()`

### Yeni: Yapılandırma ve OID
- `configure(partial)`, `getDefaults()`, `resetDefaults()`
- `oid.OIDs`, `oid.KU`, `oid.REASON`/`REASON_NAMES`, `oid.GENERAL_NAME_TAG`, `oid.nameToOid`, `oid.oidToName`

Tüm fonksiyonlar hem düz (flat) isimleriyle hem de `PKI`, `Chain`, `Http`,
`Keys`, `Config`, `CA`, `OID` isimli gruplandırılmış nesneler altında da
erişilebilir (ör. `lib.Chain.verifyChain === lib.verifyChain`).

---

## Test

`test.js`, kütüphaneyi yalnızca `index.js` üzerinden kullanan uçtan uca bir
kontrol paketidir (klasik ilkeller → RSA/EC hiyerarşi → CSR → zincir
doğrulama → gerçek HTTP OCSP/CRL sunucusu → `CertificateAuthority`).
Ayrıca geliştirme sırasında her modül gerçek `openssl` komut satırı
araçlarıyla (x509/req/crl/ocsp/asn1parse) çapraz doğrulanmıştır.

```bash
npm test        # 19 kontrollü regresyon paketi
node example.js # kullanım örnekleri (konsola yazdırır + node:crypto ile doğrular)
```

## Bilinen Konu (kapsam dışı)

`src/mldsa.js` içindeki `mldsaSign` fonksiyonunda, kütüphanenin **orijinal**
(bu güncellemeden ETKİLENMEYEN) sürümünde de mevcut olan bir performans/
sonlanma sorunu tespit edildi — imzalama bazı çalıştırmalarda çok uzun
sürebiliyor/sonlanmayabiliyor. ML-DSA algoritması bu güncellemenin kapsamı
dışında tutulduğundan (Node `crypto` modülünde yerleşik değil) dokunulmadı;
ML-DSA imzalama kullanan bir akışınız varsa bu bilinmesi gereken bir
husustur.
