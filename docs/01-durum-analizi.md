# 01 — Durum Analizi

Bu belge, mevcut kod tabanının **olduğu gibi** fotoğrafını çeker. Övgü yok, suçlama yok;
sadece "burada ne var, ne kadarı hedefe hizmet ediyor" tespiti.

---

## 1. Envanter

### 1.1 Kök dizin (uygulama katmanı)

| Dosya | Satır | Ne yapıyor | Değerlendirme |
|-------|------:|------------|---------------|
| `index.js` | 279 | Ana pipeline: PDF taslağı üret → LTV konfigürasyonu topla → sırayla iki profille imzala | Çalışan referans akış. Ama profiller, konumlar ve sertifika yolları **hardcoded**. |
| `certificate.js` | 116 | RFC 8628 device-flow ile `trust.fitfak.net`'ten sertifika alır | Sağlam fikir. `./device-login` modülü **repoda yok** → dosya şu an çalışmaz. |
| `pfx.js` | 266 | PKCS#12 parse + build (kendi ASN.1'i ile) | Kritik eksikleri var (§3.2). |
| `qr.js` | 773 | `@fitfak/qr`'ın repoya kopyalanmış hâli | Paketle **birebir aynı** → çift kaynak (drift riski). |
| `setup.js` | 526 | (kurulum yardımcısı) | Pipeline'ın parçası değil. |
| `server.js` | 71 | `scanner.html` servis eder + `/api/verify` sahte cevap döner | İskelet. Gerçek doğrulama yok. |
| `scanner.html` | 36 KB | Kamera ile QR tarayıcı | İmzalama arayüzüyle ilgisi yok; ayrı bir ürün. |
| `test/validation.js` | 453 | İmza doğrulayıcı sınıfı (trust store + OCSP) | **En değerli varlıklardan biri.** `test/` altında saklı kalmış. |
| `test/timestamp.js` | 630 | Tam bir RFC 3161 TSA sunucusu | **Çok değerli.** Offline E2E testin temeli. |
| `test/server.js` | 207 | HTTP/2 doğrulama arayüzü | Web Studio'nun ilk taslağı sayılabilir. |

### 1.2 `src/` — yarım kalmış ikinci PDF motoru

`src/pdf/engine.js`, `src/layout/box-model.js`, `src/parser/html-tokenizer.js`,
`src/parser/css-parser.js` … toplam ~350 satır.

**Tespit:** Bu ağaç, `@fitfak/pdf` paketiyle **aynı işi yapan rakip bir motordur** ve her
yönden daha zayıftır:

- Sadece `Helvetica` (Type1), gömülü font yok → Türkçe karakterler `WinAnsi` sınırında.
- `UnitEngine.measureTextWidth` = `metin.length × fontSize × 0.51` — yani **gerçek font
  metriği yok**, sabit çarpan. Satır sonu hesapları yaklaşık.
- `ColorEngine.parse` yalnız `#rgb`/`#rrggbb` anlıyor; `rgb()`, isimli renk, `hsl` yok.
- `UnitEngine.parseToPt` her birimi `×0.75` sayıyor → `pt`, `mm`, `cm`, `%`, `em`, `rem`
  ayrımı yok.
- Sayfa akışı tek kolon, tablo/flex/grid yok.

Buna karşılık `@fitfak/pdf` gerçek TTF parse + subset + `Identity-H` CID font + PNG/JPEG
gömme + kutu modeli sunuyor.

> **Karar:** `src/` ağacı **kaldırılır**. Fikirleri (HTML tokenizer + CSS parser) yeni
> `@fitfak/pdf-html` paketine, düzgün hâliyle taşınır. İki motor bakılmaz.

### 1.3 `@fitfak/*` paketleri (node_modules içinde)

| Paket | Satır | Rol | Olgunluk |
|-------|------:|-----|----------|
| `@fitfak/ssl` v2.1 | ~4.500 | ASN.1, RSA/EC, X.509, CSR, CRL, OCSP, TSA, CT, ML-KEM/ML-DSA | **Yüksek.** Projenin kripto omurgası. |
| `@fitfak/pades` v1.0 | ~3.400 | CAdES builder, RFC3161, PDF imza yazıcı, DSS, görsel damga | **Orta-yüksek.** Çekirdek doğru, LTV tarafı eksik. |
| `@fitfak/pdf` v1.0 | ~1.700 | TTF subset, PNG/JPEG, kutu modeli, sayfalama, render | **Orta.** Motor sağlam, CSS katmanı yok. |
| `@fitfak/qr` v1.0 | 760 | QR (Level 40'a kadar) + PNG üretimi | **İyi.** `QR.build()` matris döndürüyor → damgaya doğrudan gömülebilir. |

**Sorun:** Bu paketler `.gitignore`'daki `node_modules/` yüzünden **repoda yok**. Kullanıcı
"bunlar da aslında dahili" diyor ama versiyonlanmıyor, düzenlenemiyor, test edilemiyor.
Bu, planın çözmesi gereken **1 numaralı yapısal problem**dir (bkz. [02-mimari](./02-mimari.md)).

---

## 2. Çalışan Akış (bugünkü hâliyle)

```
index.js
  │
  ├─ createPdfDraft()  ──────────────►  @fitfak/pdf  ──►  temp_draft.pdf (Buffer)
  │
  ├─ loadSignerProfileAsync('aybars')
  │     └─ LtvAutomationService.buildDynamicLtvConfig(sign.crt)
  │           ├─ PEM'leri ayır (leaf + varsa subCA)
  │           ├─ AIA "CA Issuers" ile zinciri köke kadar indir
  │           ├─ AIA "OCSP - URI" topla        → ocspRequests[]
  │           └─ DER içinde regex ile ".crl"   → crlRequests[]     ⚠️  (§3.1.2)
  │
  └─ signPdfInMemory(...)  ──────────►  @fitfak/pades
        └─ PAdESManager.sign({mode:'LT'})
              ├─ signPAdES_T()   → görsel damga + placeholder + CAdES-BES + RFC3161 TST
              └─ addLTV()        → OCSP çek, sertifika topla, DSS+VRI yaz
                                    ⚠️  crl parametresi HİÇ OKUNMUYOR (§3.1.1)
```

---

## 3. Bulgular

Ağırlık: 🔴 kritik · 🟠 önemli · 🟡 iyileştirme

### 3.1 PAdES / LTV

#### 🔴 3.1.1 — CRL'ler DSS'e hiç yazılmıyor

`index.js:107` üretilen `crlRequests` dizisi `ltvConfig.crl` olarak paketleniyor ve
`options.ltv` üzerinden `PAdESManager.sign()`'a gidiyor. Ancak:

- `pades_manager.js:581` → `this.addLTV({ pdfBuffer, certsPem: ltv.certsPem, ocsp: ltv.ocsp })`
- `pades_manager.js:390` → `async addLTV({ pdfBuffer, certsPem = [], ocsp = [], ocspHeaders = {} })`

`crl` parametresi **imzada yok**. Sessizce düşüyor. Konsolda "CRL adresi eklendi" yazması
yanıltıcı — hiçbir CRL indirilmiyor, doğrulanmıyor, gömülmüyor.

İyi haber: alt katman hazır. `pdf_parser.js:1432` →
`addDSS({ certsDer, crlsDer, ocspsDer, signatureHashes })` **CRL'yi destekliyor**.
Eksik olan sadece aradaki boru hattı ve indirme/doğrulama adımı.

#### 🔴 3.1.2 — CDP ve OCSP URL'leri regex ile çıkarılıyor

```js
// index.js:101-103
const derText = cert.raw.toString('latin1');
const crlMatch = derText.match(/http:\/\/[a-zA-Z0-9\-\.\/]+crl/i);
```

```js
// pades_manager.js:494-504
const ocspIdx = certStr.indexOf('http://ocsp.');
...
if (!ocspUrl && certStr.includes('digicert')) ocspUrl = 'http://ocsp.digicert.com';
```

Binary DER üzerinde string araması yapılıyor. Bu yaklaşım:
- `.crl` ile bitmeyen CDP'leri kaçırır (çoğu kurumsal CA öyle),
- `ocsp.` ile başlamayan OCSP host'larını kaçırır,
- sertifikanın **başka bir alanında** geçen benzer bir URL'i yanlışlıkla yakalayabilir,
- LDAP CDP'lerini hiç görmez,
- `digicert` özel-durum kodu (`hardcoded fallback`) taşınabilir değil.

Doğrusu: `id-pe-authorityInfoAccess` (1.3.6.1.5.5.7.1.1) ve
`id-ce-cRLDistributionPoints` (2.5.29.31) uzantılarını **ASN.1 olarak** çözmek.
`@fitfak/ssl/src/asn1.js` + `oid.js` bunun için hazır.

#### 🔴 3.1.3 — Modern PDF'ler okunamayabilir (xref stream / object stream yok)

`pdf_parser.js:76`:
```js
if (str.slice(offset, offset + 4) !== 'xref') return;
```

Yani **yalnızca klasik xref tablosu** parse ediliyor. PDF 1.5+ (2003'ten beri) yaygın olarak
**cross-reference stream** (`/Type /XRef`) ve **object stream** (`/ObjStm`) kullanır — Word,
Chrome "Yazdır→PDF", LibreOffice, InDesign çıktılarının çoğu böyledir.

Kısmi kurtarıcı: `readObject`'teki `legacyRead` tüm dosyada `N 0 obj` tarıyor. Bu, xref
tablosu okunamasa bile *sıkıştırılmamış* nesneleri bulur. Ama `/ObjStm` içine sıkıştırılmış
nesneler (ki Catalog ve Pages sıklıkla oradadır) **hiç görünmez**.

Sonuç: "kullanıcı dışarıdan PDF yükleyip imzalasın" senaryosu bugün **güvenilir değil**.

#### 🟠 3.1.4 — LTA seviyesi ETSI'ye göre eksik

`pades_manager.js:587-593`, LTA'yı `LT → addDocTimeStamp` olarak uyguluyor. Ancak
ETSI EN 319 142-1 / TS 119 102-1 uyarınca arşiv zaman damgasının **kendi TSA sertifikası
için de** doğrulama verisi (sertifika + OCSP/CRL) DSS'te bulunmalıdır. Aksi hâlde arşiv
damgası, TSA sertifikası süresi dolduğunda doğrulanamaz — ki LTA'nın var oluş sebebi tam
olarak budur.

Doğru sıra: `LT → DocTS → (DocTS'in TSA zinciri için) yeni DSS revizyonu`.

#### 🟠 3.1.5 — `addLTV` yalnızca **son** imzayı görüyor

`pades_manager.js:447-449`:
```js
while ((match = sigRegex.exec(pdfStr)) !== null) lastHex = match[1];
```

Çoklu imzada (ki `index.js` iki kez imzalıyor) her imza için ayrı bir VRI girdisi gerekir.
Şu an yalnızca son imzanın CMS'inden sertifika toplanıyor.

#### 🟠 3.1.6 — `mode:'LT'` OCSP olmadan çalışmıyor

`pades_manager.js:578`:
```js
if (!ltv || !Array.isArray(ltv.ocsp)) throw new Error("mode='LT'/'LTA' için ...");
```

Yalnızca CRL yayınlayan CA'lar (Türkiye'de ve kurumsal PKI'larda yaygın) ile LT seviyesine
çıkılamıyor. Doğru kural: *"kök hariç her sertifika için en az bir iptal kanıtı"*.

#### 🟠 3.1.7 — DocTimeStamp sözlüğü `/Type /Sig`

`pdf_parser.js:1213`:
```js
'<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.RFC3161 ... /M (...) >>'
```

ISO 32000-2 §12.8.5, belge zaman damgası sözlüğü için `/Type /DocTimeStamp` ister; `/M`
girdisi ise zaman damgası için anlamsızdır (zaman TST'nin içindedir). Adobe hoşgörülü
davranıyor olabilir, EU DSS doğrulayıcısı olmayabilir. Doğrulanmalı.

#### 🟠 3.1.8 — `placeholderHexLen` sabit 120.000

LTV verisi büyüdükçe (uzun zincir + birden çok OCSP + CRL) CMS bu alana sığmayabilir.
İçerik boyutuna göre uyarlanabilir hesap gerekir.

#### 🟡 3.1.9 — Kriptografik kapsam

`cades/oids.js` içinde yalnızca RSA PKCS#1 v1.5 ve ECDSA var. Yok olanlar:
RSASSA-PSS, Ed25519/Ed448, SHA-3. Bazı kurumsal imza politikaları PSS zorunlu kılar.

#### 🟡 3.1.10 — `signature_assets.js` bozuk (ölü kod)

`signature/signature_assets.js:4` kendi kendini `require('./signature_assets')` ediyor ve
var olmayan `'../../signature_positions'` yolunu istiyor. Şu an kimse çağırmadığı için
patlamıyor. Silinmeli.

### 3.2 PKCS#12 (`pfx.js`)

#### 🔴 3.2.1 — Gerçek dünya `.pfx` dosyalarının çoğu parse edilemez

`#decryptPBES2` yalnızca **PBES2** (`1.2.840.113549.1.5.13`) destekliyor. Oysa Windows
sertifika deposu, Java keytool ve OpenSSL 1.x/3.x'in varsayılan `-export` çıktısı
**PKCS#12 PBE** kullanır:

| OID | Şema | Durum |
|-----|------|-------|
| `1.2.840.113549.1.12.1.3` | pbeWithSHAAnd3-KeyTripleDES-CBC | ❌ desteklenmiyor |
| `1.2.840.113549.1.12.1.6` | pbeWithSHAAnd40BitRC2-CBC | ❌ desteklenmiyor |
| `1.2.840.113549.1.5.13` | PBES2 (AES-CBC) | ✅ destekleniyor |

Bunlar RFC 7292 Ek B'deki **PKCS#12 KDF**'ini gerektirir (PBKDF2 değil). RC2-40 ayrıca
modern OpenSSL'de "legacy provider" arkasındadır → saf JS RC2 gerekebilir.

#### 🔴 3.2.2 — MAC yok

- **Parse:** MacData doğrulanmıyor → yanlış parola "boş sonuç" veya çöp veri olarak döner,
  net bir "parola hatalı" hatası yok; dosya bütünlüğü de kontrol edilmiyor.
- **Build:** `pfx.js:237` kendi yorumunda itiraf ediyor — *"DİKKAT: MacData katmanı eksiktir."*
  MacData'sız PFX'i Windows ve Java **reddeder**.

#### 🟠 3.2.3 — Kimlik eşleştirme yok

`parse()` düz `{ certificates[], privateKeys[] }` döndürüyor. `localKeyId` /
`friendlyName` bag attribute'ları okunmuyor. İçinde birden çok kimlik olan bir PFX'te
hangi anahtarın hangi sertifikaya ait olduğu bilinemez. Zincir sıralaması (leaf → ara CA)
da yapılmıyor.

#### 🟠 3.2.4 — Zayıf KDF parametreleri (build)

`pfx.js:157` → `iterations = 2048`. 2025 ölçeğinde düşük. Modern hedef: PBKDF2 ≥ 600.000
veya PBMAC1 + yüksek iterasyon.

#### 🟠 3.2.5 — İmzalama akışına bağlı değil

`index.js` yalnızca diskteki `sign.key` + `sign.crt` ile çalışıyor. Kullanıcının istediği
"PFX ile imzala" yolu **hiç yok**.

### 3.3 Görsel damga (`stamp.js`)

| Bulgu | Ağırlık | Detay |
|-------|---------|-------|
| Barkod içeriği belgeye bağlı değil | 🟠 | `makeBarcodeCore()` → `"FITFAK-" + Date.now().toString(36)`. Aynı belge iki kez damgalanırsa iki farklı barkod; barkod belgeyi *tanımlamıyor*. |
| QR yok | 🟠 | Kullanıcı isteği. `@fitfak/qr` hazır ve `QR.build()` matris veriyor → PNG round-trip'e gerek yok, doğrudan RGBA tuvale çizilebilir. |
| Layout sabit | 🟠 | `leftW=560 / rightW=720` sabit; barkod damganın %56'sını yiyor. Slot tabanlı bir şablon sistemi gerek. |
| Dış imza görseli desteklenmiyor | 🟠 | Kullanıcının el yazısı imza PNG'sini gömme yolu yok. |
| Code39 check digit yok | 🟡 | Mod-43 opsiyonel eklenebilir (varsayılan kapalı — çıktı değişmesin). |
| `finalW` sabit 1280 | 🟡 | DPI hesabı yok; küçük rect'lerde gereksiz büyük PNG. |
| Rasterleştirme O(piksel×poligon) | 🟡 | `windingContains` her piksel için tüm kenarları tarıyor. 4× supersampling ile 1280×320 → yavaş. Scanline algoritması ~50× hızlandırır. |

> **Kural:** Code39 kodlama tablosu ve `encodeCode39Data()` **dokunulmaz**. QR ayrı bir
> slot tipi olarak eklenir.

### 3.4 PDF üretimi (`@fitfak/pdf`)

| Bulgu | Ağırlık | Detay |
|-------|---------|-------|
| HTML/CSS girişi yok | 🔴 | Sadece JSON eleman ağacı. Kullanıcının açık isteği HTML/CSS. |
| Tablo / flex / grid yok | 🟠 | `BoxModel` yalnız block akışı + absolute. |
| Sayfa kırma ilkel | 🟠 | `Paginator` var ama tablo başlığı tekrarı, `page-break-inside`, dul/yetim satır kontrolü yok. |
| Link / bookmark / etiketli PDF yok | 🟠 | Erişilebilirlik (PDF/UA) ve PDF/A hedefleri için gerekli. |
| Font ailesi kavramı yok | 🟠 | `registerFont(name, path)` tek yüz. `bold`/`italic` varyantı seçilemiyor. |
| Font subset edilmiyor (gömme) | 🟡 | `index.js:171` **ham TTF'i tamamen** `ASCIIHexDecode` ile gömüyor → dosya boyutu 2× şişiyor. `Subsetter` sınıfı var ama çıktıya bağlanmamış. |
| Renk/gradient/gölge yok | 🟡 | Sadece düz RGB dolgu + kenarlık. |

### 3.5 Yapısal / süreç

| Bulgu | Ağırlık | Detay |
|-------|---------|-------|
| `@fitfak/*` repoda yok | 🔴 | `node_modules/` gitignore'da. "Dahili" denen modüller versiyonlanmıyor, düzenlenemiyor. |
| `qr.js` iki yerde | 🟠 | Kök dizinde ve pakette birebir kopya → drift kaçınılmaz. |
| İki PDF motoru | 🟠 | `src/` vs `@fitfak/pdf`. |
| Test yok | 🟠 | `test/` klasörü test değil, çalıştırılabilir araçlar içeriyor. Assert yok, runner yok. |
| `certificate.js` kırık | 🟠 | `./device-login` modülü eksik. |
| `package.json` boş | 🟡 | `name`, `scripts`, `engines` yok. |
| Ağa bağımlı imzalama | 🟡 | TSA/OCSP/CRL için internet şart. Offline test ortamı yok (oysa `test/timestamp.js` ile kurulabilir). |

---

## 4. Elimizdeki Güçlü Varlıklar

Plan bunların üzerine kurulur — sıfırdan yazılacak çok az şey var:

1. **`@fitfak/ssl`** — ASN.1, X.509, CSR, CRL üretme/ayrıştırma, OCSP istemci+sunucu,
   RFC 3161 TSA, zincir doğrulama, CA yöneticisi. PKI tarafında ihtiyacımız olan her şey.
2. **`test/timestamp.js`** — çalışır bir TSA sunucusu. Offline E2E LTV testinin anahtarı.
3. **`test/validation.js`** — sistem trust store + OCSP ile imza doğrulayıcı iskeleti.
4. **`pdf_parser.js` → `addDSS`** — DSS/VRI yazımı (CRL dâhil) zaten doğru kurgulanmış.
5. **`stamp.js`** — TTF glyph outline → raster hattı. Bu kod, tarayıcı tarafı PDF
   görüntüleyicide **glyph → `Path2D`** dönüşümü için doğrudan yeniden kullanılabilir.
6. **`@fitfak/qr` `QR.build()`** — matris döndürüyor; damgaya ve PDF'e vektörel olarak
   basılabilir.
7. **`@fitfak/pdf` `TtfParser` + `Subsetter`** — gerçek font metrikleri ve subset altyapısı.

---

## 5. Özet Tablo: Hedefe Uzaklık

| Kullanıcı isteği | Bugün | Boşluk |
|------------------|-------|--------|
| PFX ile imzalama | ❌ | PKCS#12 parse'ı gerçek dosyaları açamıyor; imza akışına bağlı değil |
| Zaman damgası | ✅ | RFC 3161 çalışıyor |
| OCSP ile LTV | 🟡 | Çalışıyor ama URL çıkarımı kırılgan, çoklu imza eksik |
| CRL ile LTV | ❌ | Hiç gömülmüyor |
| B-LTA (arşiv) | 🟡 | Var ama ETSI'ye göre eksik |
| HTML/CSS ile PDF | ❌ | Yok |
| Tasarım CSS paketi | ❌ | Yok |
| PDF yükle & düzenle | ❌ | Modern PDF'ler parse edilemiyor |
| Görsel gömme / konumlandırma | 🟡 | PDF üretiminde var, düzenlemede yok |
| Dış imza görseli | ❌ | Yok |
| Damgada QR | ❌ | Yok (Code39 var) |
| Web arayüzü (vanilla JS) | ❌ | Yok |
| PDF görüntüleyici | ❌ | Yok |
| İmza paneli | 🟡 | `inspectPdfSignatures` var, arayüzü yok |
