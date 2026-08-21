# Güvenlik Denetimi — Ağustos 2026

**Kapsam:** PAdES/CAdES imzalama ve doğrulama motoru, PKI yolu, PDF ayrıştırma,
sunucu API'si, karekod doğrulama zinciri.
**Yöntem:** Her bulgu için önce kaynak kod izlendi, sonra çalışan bir istismar
yazıldı, düzeltme uygulandı ve istismar yeniden koşularak kapandığı kanıtlandı.
**Kural:** Testlerin geçmesi güvenlik kanıtı sayılmadı. Her iddianın arkasında
ya çalışan bir istismar ya da bir standart maddesi var; emin olunmayanlar
"doğrulanmalı" olarak işaretlendi.

---

## A. Yönetici Özeti

Denetim, **sekiz çalışan atlatma** buldu. Beşi doğrudan imza güvenini
bozuyordu: saldırganın ürettiği belgeler `TOTAL-PASSED` dönüyordu. Hepsi
kapatıldı ve kalıcı regresyonla korundu.

| # | Bulgu | Önem | Durum |
|---|-------|------|-------|
| F-01 | Güven çıpası yalnız Subject DN ile kabul ediliyordu | **Kritik** | Kapatıldı |
| F-02 | RFC 5280 yol kısıtları hiç uygulanmıyordu (EE sertifikası CA gibi kullanılabiliyordu) | **Kritik** | Kapatıldı |
| F-03 | İmzadan sonra değiştirilen belge `TOTAL-PASSED` dönüyordu | **Kritik** | Kapatıldı |
| F-04 | CMS zorunlu imzalı öznitelikleri karar vermiyordu (fail-open) | **Kritik** | Kapatıldı |
| F-05 | Karekod nakli: karekod başka bir belgeye yapıştırılabiliyordu | **Yüksek** | Kapatıldı |
| F-06 | PKI getiricilerinde SSRF (AIA / CDP / OCSP) | **Yüksek** | Kapatıldı |
| F-07 | Algoritma politikası yoktu (SHA-1, RSA-1024 sessizce kabul) | **Yüksek** | Kapatıldı |
| F-08 | Dışa açık kurulumda hassas uçlar korumasızdı (yalnız uyarı) | **Yüksek** | Kapatıldı |
| F-09 | OCSP delege yanıtlayan yetkisi isim eşleşmesiyle veriliyordu | **Yüksek** | Kapatıldı |
| F-10 | İptal alt göstergesi iki ayrı ekseni karıştırıyordu | Orta | Kapatıldı |
| F-11 | `isSelfSigned()` boş isimleri eşit sayıyordu | Orta | Kapatıldı |
| F-12 | İmza başına belge yeniden açılıyordu (DoS çarpanı) | Orta | Kapatıldı |

**Ortak kök neden:** *ad, kimlik sanılıyordu.* Güven çıpası Subject DN ile,
issuer isim eşleşmesiyle, OCSP yetkisi isim eşleşmesiyle, "değiştirilmiş mi"
sorusu metin aramasıyla yanıtlanıyordu. Bunların hepsi saldırganın serbestçe
seçtiği alanlardır. Düzeltmelerin ortak yönü de aynı: **her yerde kriptografik
kimlik** (DER/SPKI eşitliği, imza doğrulaması, hesaplanmış özet).

---

## B. Bulgular

### F-01 — Güven çıpası yalnız Subject DN ile kabul ediliyordu

| | |
|---|---|
| **Önem** | Kritik |
| **Kategori** | Kimlik doğrulama atlatma |
| **Paket** | `@fitfak/verify` |
| **Dosya** | `packages/verify/index.js` |
| **Fonksiyon** | `isSelfSignedIn()` (satır ~838), kullanım satır 257 |
| **Güven** | Kesin — çalışan istismarla kanıtlandı |

**Özet.** Fonksiyonun adı yanıltıcıydı: hiçbir kendinden-imza kontrolü
yapmıyor, yalnız Subject DN'leri karşılaştırıyordu.

```js
// ÖNCE
const trusted = ctx.trustAnchors.some((ta) => ta.equals(anchor))
             || isSelfSignedIn(anchor, ctx.trustAnchors);

function isSelfSignedIn(certDer, anchors) {
  const subject = safe(() => ext.getSubjectDer(certDer));
  return anchors.some((a) => ext.getSubjectDer(a).equals(subject));  // yalnız İSİM
}
```

**Teknik kök neden.** DN bir kimlik değil, bir etikettir; kimseyi kimseden
ayırt etmez ve sertifikayı üreten tarafından serbestçe seçilir. Ayrıca
`buildChain()` havuzu `dedupe([...pool, ...trustAnchors])` sırasıyla gezdiği
için gömülü (saldırgan kontrolündeki) sertifikalar güven deposundakilerden
önce geliyordu.

**Saldırı.** Saldırgan, kurbanın güvendiği kökle **aynı DN'ye, tamamen farklı
anahtara** sahip kendi kökünü üretir; onunla bir yaprak sertifika imzalar,
belgeyi imzalar, iki sertifikayı da CMS'e gömer. Zincir saldırganın kökünde
biter, `ta.equals(anchor)` false döner ama `isSelfSignedIn` true der.

**Kanıt (düzeltme öncesi).**
```
gerçek kök SPKI: ae761f64843b48d9ea2ce6c40635fd73
sahte  kök SPKI: 5d2e60e3b9dbcde66b86e2cda6b41a9b
indication   : TOTAL-PASSED
chain.trusted: true
```

**Düzeltme.** `isTrustAnchor()`: ölçüt DER kimliği; kodlama farklarına karşı
SPKI + Subject eşleşmesi de kabul edilir. `buildChain()` artık adayın çocuğun
imzasını **kriptografik olarak doğrulamasını** şart koşuyor (`verifiesAsIssuer`)
ve eşit güçteki adaylar arasında güven deposundakini tercih ediyor.

**Kanıt (sonra).** `INDETERMINATE / NO_CERTIFICATE_CHAIN_FOUND`, `trusted: false`.

**Regresyon.** `test/e2e/12-signature-attacks.test.js` · `test/unit/verify-trust.test.js`

---

### F-02 — RFC 5280 yol kısıtları hiç uygulanmıyordu

| | |
|---|---|
| **Önem** | Kritik |
| **Kategori** | Yetkilendirme atlatma |
| **Dosya** | `packages/verify/index.js` (kısıt kodu YOKTU) |
| **Standart** | RFC 5280 §6.1.4 (k), (m), (n), (f), (g)–(j) |
| **Güven** | Kesin — çalışan istismarla kanıtlandı |

**Özet.** Zincirdeki imzalar doğrulanıyordu ama **imzalayanın imzalamaya
yetkili olup olmadığı** hiç sorulmuyordu. `basicConstraints`, `keyUsage`,
`pathLenConstraint`, kritik uzantı işleme ve `nameConstraints` denetimlerinin
hiçbiri yoktu.

**Saldırı.** Saldırganın elinde güvenilen bir CA'dan alınmış **sıradan bir son
varlık sertifikası** var (S/MIME ya da TLS istemci — ucuz ve herkese açık,
`cA=FALSE`). Bu sertifikanın anahtarıyla kendine "Genel Müdür" adına bir
sertifika üretir ve belgeyi imzalar. Zincirdeki bütün imzalar gerçekten
doğrulanır, kök gerçekten güven deposundadır.

**Kanıt (önce).**
```
saldırganın EE sertifikası → isCA: false
zincir  : ceo.kurban.example → signer2.test.fitfak.net → Issuing CA → Root CA
indication: TOTAL-PASSED    hatalar: []
```

**Düzeltme.** Yeni `packages/verify/src/path.js` — `validatePath()`:
`basicConstraints` (§6.1.4(k)), `keyCertSign` (§6.1.4(n)), `pathLenConstraint`
(§6.1.4(m)), tanınmayan kritik uzantı (§6.1.4(f)), `nameConstraints`
(§6.1.4(g)–(j)), imzalayanın `keyUsage`'ı ve gerektiğinde EKU. TSA yolu da aynı
denetimden ve `id-kp-timeStamping` zorunluluğundan geçiyor.
`x509_ext`'e dokuz KeyUsage bitinin tamamını okuyan `extractKeyUsage()`,
`extractEKU()`, `extractSAN()`, `extractNameConstraints()` ve
`criticalExtensionOids()` eklendi — eski `parseKeyUsageAndEKU()` yalnız üç bit
okuduğu için `keyCertSign` hiç görülemiyordu.

**Kanıt (sonra).** `TOTAL-FAILED / CHAIN_CONSTRAINTS_FAILURE` —
*"CA olmayan sertifika issuer olarak kullanılmış (RFC 5280 §6.1.4(k))"*.

---

### F-03 — İmzadan sonra değiştirilen belge geçerli görünüyordu

| | |
|---|---|
| **Önem** | Kritik |
| **Kategori** | Bütünlük atlatma |
| **Dosya** | `packages/verify/index.js` (satır ~113–121) |
| **Standart** | ISO 32000-1 §7.5.6, §12.8; ETSI EN 319 142-1 |
| **Güven** | Kesin — iki varyantla kanıtlandı |

**Özet.** İki ayrı sorun iç içeydi.

1. **Değişiklik göstergeyi hiç etkilemiyordu.** `documentIntegrity.modifiedAfterSigning`
   true olsa bile `signatures[0].indication` `TOTAL-PASSED` kalıyordu. Raporu
   okuyan doğal davranış — imzanın göstergesine bakmak — değiştirilmiş belgeyi
   kabul ediyordu.
2. **"Yalnız doğrulama verisi mi?" sorusu metin aramasıyla yanıtlanıyordu:**
   ```js
   const tailIsOnlyValidationData =
     /\/DSS\b|\/VRI\b/.test(tail) && !/\/Type\s*\/Page\b/.test(tail);
   ```
   Trailer'a bir `/DSS << /Certs [] >>` yazmak bayrağı söndürmeye yetiyordu.

**Saldırı.** İmzalı PDF'e artımlı güncelleme eklenir; sayfanın içerik akışı
nesnesi yeniden tanımlanır (`Tutar: 1.000 TL` → `ODEME EMRI: 10.000.000 TL`).
İmzanın kapsadığı baytlar bire bir korunduğu için kriptografi bozulmaz.

**Kanıt (önce).**
```
düz güncelleme : indication TOTAL-PASSED, modifiedAfterSigning true
/DSS yemi VAR  : indication TOTAL-PASSED, modifiedAfterSigning FALSE
```

**Düzeltme.** Yeni `packages/verify/src/revision.js` — iki sürüm de **açılıp
karşılaştırılıyor**: sayfa sayısı, her sayfanın çözülmüş içerik akışı, sayfa
kutusu, kaynaklardaki XObject baytları, belge düzeyindeki eylemler
(`OpenAction`, `AA`, `Names`). Nesne numaraları değil DEĞERLER
karşılaştırıldığı için aynı içeriğin başka nesneye taşınması yanlış alarm
üretmez. Eklenen bölümün **yapısı** da sınanıyor: geçerli bir artımlı güncelleme
kendi xref bölümüyle biter (ISO 32000-1 §7.5.6); bu yapıyı taşımayan kuyruk
"doğrulama verisi" sayılamaz.

**Davranış değişikliği (bilinçli).** Belge imzadan sonra değiştirilmişse sonuç
artık `INDETERMINATE / DOC_MODIFIED_AFTER_SIGNING`. `cms.signatureValid` true
kalır — imza KAPSADIĞI sürüm için geçerlidir ve bu ayrım raporda durur. Ama
okuyucunun gördüğü belge o sürüm değildir ve doğrulayan taraf meşru bir
düzenlemeyi saldırgan eklemesinden ayırt edemez. Sertifikasyon imzası hiçbir
değişikliğe izin vermiyorsa (DocMDP P=1) sonuç `TOTAL-FAILED`.

**Meşru akış korundu:** ardışık imzalamada iki imza arasında belge
değişmezse ilk imza `TOTAL-PASSED` kalır (bunun için ayrı test eklendi).

---

### F-04 — CMS zorunlu öznitelikleri karar vermiyordu (fail-open)

| | |
|---|---|
| **Önem** | Kritik |
| **Kategori** | Fail-open / doğrulama atlatma |
| **Dosya** | `packages/verify/index.js` (satır ~239, ~401), `packages/verify/src/cms.js` (satır 222) |
| **Standart** | RFC 5652 §5.3, §11.1; ETSI EN 319 142-1 |
| **Güven** | Kesin — üç varyantla kanıtlandı |

**Özet.** Üç ayrı kapı da açıktı.

1. **`signedAttrs` hiç yoksa** üç kontrol de sessizce atlanıyor
   (`if (signerInfo.signedAttrs) { … }`), imza doğrudan ham ByteRange özetinin
   üzerine düşüyordu. O noktada imza ne bir sertifikaya, ne bir içerik türüne,
   ne bir amaca bağlıdır: aynı anahtarla başka bir protokolde üretilmiş ham bir
   imza doğrudan PDF'e taşınabilir.
2. **`content-type` ve `signing-certificate-v2` hataları** yalnız `errors[]`
   listesine yazılıyor, göstergeyi hiç etkilemiyordu.
3. **Nihai karar bloğu `errors[]`'a hiç bakmıyordu:**
   ```js
   if (entry.indication === INDETERMINATE && !entry.subIndication) {
     entry.indication = PASSED;        // hata listesi dolu olsa bile
   }
   ```

**Kanıt (önce).** Üç varyantta da `TOTAL-PASSED`, hata listesi dolu:
```
bad-content-type: TOTAL-PASSED
  'content-type beklenmedik: 1.2.840.113549.1.9.16.1.4'
  'signing-certificate-v2 özniteliği yok (PAdES bunu zorunlu kılar)'
```

**Düzeltme.** `signedAttrs` yokluğu, yanlış `content-type` ve uyuşmayan
`signing-certificate-v2` artık `TOTAL-FAILED / SIG_CONSTRAINTS_FAILURE`.
Öznitelik hiç yoksa PAdES alt filtreleri (`ETSI.*`) için `FAILED`, eski Adobe
profilleri için `INDETERMINATE` — biri standart ihlali, diğeri eksik kanıt.
Nihai karar bloğu tek bir yükseltme kuralına indirgendi: **hiç hata yoksa ve
alt gösterge konmadıysa** imza geçer. Bir doğrulayıcıda "bilinmeyen bir sorun
vardı ama geçti" durumu olamaz.

---

### F-05 — Karekod nakli (QR transplant)

| | |
|---|---|
| **Önem** | Yüksek |
| **Kategori** | Kimlik bağlama eksikliği |
| **Dosya** | `apps/scanner/server.js` (`/api/verify`) |
| **Güven** | Kesin — tasarım gereği, testle kanıtlandı |

**Özet.** Karekod bir kanıt değildir: üzerinde durduğu belgeyle arasında hiçbir
bağ yoktur. Tarayıcı yalnız istemcinin verdiği `hash` / `docNo` ile deftere
bakıyordu. Gerçek, imzalı bir belgenin karekodunu kesip sahte bir belgeye
yapıştıran biri "doğrulandı" cevabı alıyordu — üstelik gerçek imzalayanın adıyla.

**Düzeltme.** `/api/verify` artık `pdf` alanını kabul ediyor ve özeti **kendi
hesaplıyor**. Cevaba `binding` alanı eklendi: `computed` (dosya görüldü),
`claimed` (yalnız kimlik verildi), `mismatch` (karekod dosyayla uyuşmuyor →
`invalid`). Arayüze "Dosyayı Doğrula" düğmesi eklendi ve "doğrulandı" iletisi
artık kanıtın ötesine geçmiyor: dosya görülmediyse *"Bu KİMLİK kayıtlı ve
geçerli"* denir, *"Bu dosya…"* değil.

**Kalan sınır (kabul edilen).** Kamerayla tarama doğası gereği yalnız `claimed`
üretir. Bu, arayüzde ve `scope` metninde açıkça yazıyor.

---

### F-06 — PKI getiricilerinde SSRF

| | |
|---|---|
| **Önem** | Yüksek |
| **Kategori** | SSRF |
| **Dosyalar** | `packages/pades/src/utils/pades_manager.js` (AIA), `.../cades/crl.js`, `.../cades/ocsp.js`, `.../timestamp/rfc3161.js` |
| **Güven** | Kesin — kaynak seviyesinde doğrulandı, regresyonla kapatıldı |

**Özet.** AIA (caIssuers), CDP ve OCSP adresleri **sertifikanın içinden** gelir:
onları imzalayan değil, sertifikayı üreten yazar — doğrulayıcı açısından
imzasız bir alandır. AIA getiricisi çıplak `fetch()` kullanıyordu; ne adres
denetimi, ne boyut sınırı, ne yönlendirme kontrolü vardı. OCSP istemcisinde
**zaman aşımı da yoktu**.

```
AIA: http://169.254.169.254/latest/meta-data/iam/security-credentials/
CDP: http://127.0.0.1:8500/v1/kv/production?raw
```

**Düzeltme.** SSRF savunması zaten vardı ama yanlış yerdeydi
(`@fitfak/pdf-html` içinde, yalnız uzak görsel/font için). Yeni
`@fitfak/netguard` paketine taşındı ve PKI için `pkiFetch()` yüzü eklendi:
POST gövdesi, yönlendirmede gövdeyi düşürme, akış sırasında boyut sınırı,
toplam süre zaman aşımı. Ad **bir kez** çözülür ve doğrulanmış IP'ye bağlanılır
(DNS yeniden bağlama kapalı); her yönlendirme halkası sıfırdan denetlenir.
Sertifikadan gelen adreslerin özel ağa çıkması **varsayılan olarak kapalı**;
kurum içi PKI için `allowPrivateNetwork` / `ALLOW_PRIVATE_PKI=1` /
`--allow-private-pki` ile açılır. `/api/verify`'da bu izin **istek gövdesinden
gelmez**: iç ağa çıkma izni bir istemci kararı olamaz.

**TSA kasten dışarıda.** TSA adresini operatör yapılandırır, saldırgan değil;
kurum içi bir TSA meşru bir kurulumdur. Oraya eklenen şey zaman aşımı ve boyut
sınırıdır.

---

### F-07 — Algoritma politikası yoktu

| | |
|---|---|
| **Önem** | Yüksek |
| **Kategori** | Kriptografik politika |
| **Standart** | ETSI TS 119 312 |
| **Güven** | Kesin — çalışan istismarla kanıtlandı |

**Özet.** 1024 bitlik RSA anahtarıyla imzalanmış bir belge, **tek bir uyarı bile
üretmeden** `TOTAL-PASSED` dönüyordu. SHA-1 için de aynısı geçerliydi.

Bir imzanın matematiksel olarak doğrulanması güvenilir olduğu anlamına gelmez:
SHA-1 çakışma direncini 2017'de kaybetti (SHAttered), 2020'de seçilmiş ön ekli
çakışma pratikleşti. Belge imzasında karşılığı şudur — saldırgan zararsız bir
belgeyi imzalatır, aynı özeti veren zararlı belgeyi üretir, imzayı ona taşır;
imza her ikisinde de doğrular.

**Düzeltme.** Yeni `packages/verify/src/algorithms.js`: kırık özetler
(md2/md4/md5/sha1/ripemd160), en az 2048 bit RSA, en az 256 bit EC. 2048 bit
kabul edilir ama uzun ömürlü arşiv için uyarı verilir. Sonuç
`INDETERMINATE / CRYPTO_CONSTRAINTS_FAILURE_NO_POE` — imza matematiksel olarak
doğrulandı, güvenilmez olan algoritmadır.

**İki yerde kasten uygulanmıyor** (gerekçeleriyle belgelendi):
OCSP CertID'deki SHA-1 (RFC 6960 varsayılanı) bir imza değil arama
anahtarıdır; kendinden imzalı kökün kendi imzası güven kararına girmez — köke
güven imzasından değil, güven deposunda bulunmasından gelir.

---

### F-08 — Dışa açık kurulumda hassas uçlar korumasızdı

| | |
|---|---|
| **Önem** | Yüksek |
| **Kategori** | Dağıtım varsayılanı |
| **Dosya** | `apps/server/src/policy.js`, `apps/server/server.js` |

**Özet.** Sunucu `0.0.0.0`'a bağlanmış ve `API_TOKENS` tanımlı değilse konsola
bir **uyarı** yazılıyor, istekler yine de işleniyordu: imzalama, PFX ve LTV
uçları kimlik doğrulaması olmadan internete açık kalıyordu. "Yanlışlıkla açık
kalan bir dağıtım" tam olarak böyle olur ve **uyarı bir denetim değildir**.

**Düzeltme.** `policy.setBinding()` ile bağlanılan adres yetki kararına giriyor:
dışa açık adreste belirteçsiz hassas uçlar `503 ERR_AUTH_NOT_CONFIGURED` döner.
Zararsız uçlar (render, verify, health) etkilenmez — sunucu tamamen kullanılmaz
hâle gelmez. Yerel arayüzde geliştirme akışı aynen sürer.

---

### F-09 — OCSP delege yanıtlayan yetkisi isim eşleşmesiyle veriliyordu

| | |
|---|---|
| **Önem** | Yüksek |
| **Dosya** | `packages/verify/src/ocsp.js` → `checkResponderAuthorization()` |
| **Standart** | RFC 6960 §4.2.2.2 |

**Özet.** "CA tarafından ihraç edilmiş" olmak `ext.isIssuerOf()` ile, yani
isim + AKI eşleşmesiyle belirleniyordu. Saldırgan, Issuer alanına CA'nın DN'sini
yazdığı ve `id-kp-OCSPSigning` EKU'su taşıyan **kendi** sertifikasını üretir,
onunla `good` yanıtı imzalar ve yanıtın içine koyar — havuz saldırgandan geldiği
için sertifika oradadır. İptal edilmiş bir sertifika geçerli görünür.

**Düzeltme.** "İhraç edilmiş" olmak bir isim eşleşmesi değil, bir imzadır:
`ext.verifiesAsIssuer(responderDer, issuerDer) === true` şartı eklendi.

---

### F-10 — İptal alt göstergesi iki ekseni karıştırıyordu

**Dosya:** `packages/verify/index.js`. Kodda
`poeTime ? 'REVOKED_CA_NO_POE' : 'REVOKED_NO_POE'` yazılıydı: POE'nin **varlığı**
"iptal edilen bir CA'ydı" anlamına geliyordu. İki eksen ilgisizdir. Ayrıca POE,
iptal zamanıyla hiç karşılaştırılmıyordu.

**Düzeltme.** `isCa` gerçek yol konumundan geliyor. `poeAntedatesRevocation()`
ETSI mantığını uyguluyor: imza iptalden önce vardıysa sonradan gelen iptal onu
geçersiz kılmaz — ama `keyCompromise`/`cACompromise`'de anahtarın ne zamandan
beri başkasının elinde olduğu bilinmediği için koruma yoktur, ve `invalidityDate`
varsa kıyas ona yapılır.

Ayrıca **"iptal kanıtı yok" ile "iptal edilmemiş"** ayrımı görünür kılındı:
hangi sertifikaların kanıtsız kaldığı adıyla bildiriliyor, rapora makine okunur
`revocationComplete` alanı eklendi, ve `requireRevocation: true` verilirse eksik
kanıt `INDETERMINATE / TRY_LATER` üretiyor. Varsayılan uyarı olarak bırakıldı:
çevrimdışı B-B doğrulaması meşru bir kullanımdır.

---

### F-11 / F-12 — Ayrıştırıcı ve kaynak sınırları

**F-11.** `isSelfSigned()` bozuk DER'de hem subject hem issuer boş tampon
dönüyor, `equals` bunları eşit bulup sertifikayı "kendinden imzalı" ilan
ediyordu. İki sonucu vardı: zincir çöp bir "kök"te tamamlanmış sayılıyor ve o
sertifika **iptal denetiminden muaf** tutuluyordu. Issuer alanı X.509'da boş
olamaz (RFC 5280 §4.1.2.4); ölçüt artık bu.

**F-12.** Her imzanın kapsamı farklıysa revizyon karşılaştırması yeniden koşup
belgeyi iki kez açıyordu. Karşılaştırma artık kapsam başına önbellekleniyor ve
imza sayısına üst sınır kondu (varsayılan 128, `maxSignatures` ile yükseltilir).
Sınır aşılırsa doğrulama **yapılmaz** ve bildirilir.

**Ayrıca `/ByteRange` yapısal olarak doğrulanıyor** (ISO 32000-1 §12.8.1):
`s1` sıfır olmalı, aralıklar çakışmamalı, dosya sonu aşılmamalı ve dışarıda
bırakılan boşluk **tam olarak** `/Contents` onaltılığı olmalı. Bunun için
`pdf_parser` artık `/Contents`'in dosyadaki gerçek konumunu bildiriyor.

---

## C. Standart Uyumu

| Standart | Madde | Önce | Sonra |
|----------|-------|------|-------|
| RFC 5280 | §6.1.4(k) basicConstraints | ✗ yok | ✓ |
| RFC 5280 | §6.1.4(n) keyCertSign | ✗ yok | ✓ |
| RFC 5280 | §6.1.4(m) pathLenConstraint | ✗ yok | ✓ |
| RFC 5280 | §6.1.4(f) kritik uzantı | ✗ yok | ✓ |
| RFC 5280 | §6.1.4(g)–(j) nameConstraints | ✗ yok | ✓ dizin/DNS/e-posta/URI/IP |
| RFC 5280 | §4.1.2.4 issuer boş olamaz | ✗ | ✓ |
| RFC 5280 | Politika işleme (§6.1.3(d)) | ✗ yok | ✗ **kalan boşluk** |
| RFC 5652 | §5.3 signedAttrs zorunluluğu | ✗ atlanıyordu | ✓ |
| RFC 5652 | §11.1 content-type | ⚠ raporlanıyor, karar vermiyordu | ✓ |
| RFC 5035 | signing-certificate-v2 | ⚠ raporlanıyor, karar vermiyordu | ✓ |
| RFC 3161 | §2.3 TSA EKU | ✓ zaten vardı | ✓ + yol kısıtları |
| RFC 6960 | §4.2.2.2 yanıtlayan yetkisi | ⚠ isim eşleşmesi | ✓ imza doğrulaması |
| ETSI TS 119 312 | Algoritma politikası | ✗ yok | ✓ |
| ETSI TS 119 102-1 | POE / iptal zamanı | ⚠ eksik | ✓ |
| ISO 32000-1 | §12.8.1 ByteRange | ⚠ okunuyordu, sınanmıyordu | ✓ |
| ISO 32000-1 | §7.5.6 artımlı güncelleme | ✗ metin araması | ✓ yapısal + içerik karşılaştırması |
| ISO 32000-1 | §12.8.2.2 DocMDP | ✗ yok | ⚠ P=1 uygulanıyor, P=2/P=3 **doğrulanmalı** |

---

## D. Kalan Boşluklar (dürüstlük bölümü)

Bunlar **bilinen ve kabul edilen** eksiklerdir; "tam destekleniyor" denmiyor.

1. **Sertifika politikası işleme (RFC 5280 §6.1.3(d), §6.1.4(b))** —
   `certificatePolicies`, `policyMappings`, `policyConstraints`,
   `inhibitAnyPolicy` ayrıştırılıyor ve kritik olarak *tanınıyor* ama politika
   ağacı işletilmiyor. Nitelikli imza (QES) profilleri politika OID'i
   gerektirir; bu kurulum için ek iş gerekir.
2. **DocMDP P=2 / P=3** — yalnız P=1 (hiçbir değişikliğe izin yok) uygulanıyor.
   Form doldurma ve açıklama izinlerinin ayrımı yapılmıyor; bu izinlerdeki bir
   belge şu an "değiştirilmiş" olarak `INDETERMINATE` döner. **Doğrulanmalı.**
3. **FieldMDP** hiç işlenmiyor.
4. **Kamerayla karekod taraması** doğası gereği `claimed` bağ üretir. Kesin bağ
   yalnız dosya yüklendiğinde kurulur.
5. **İptal kanıtı eksikliği** varsayılan olarak uyarıdır. Kesin doğrulama
   isteyen kurulumlar `requireRevocation: true` vermelidir.
6. **Ortak düzenleme oturum kimliği** bir yetenek belirtecidir (96 bit rastgele).
   Kimlik doğrulama değildir: bağlantıyı bilen katılabilir. Bu bilinçli bir
   tasarım ama kurumsal kullanımda yetersiz kalabilir.
7. **`@fitfak/registry`** paylaşımlı bir HMAC anahtarına dayanır. Anahtarı
   bilen sahte kayıt üretebilir; defter bir *zincir bütünlüğü* aracıdır, bir
   ortak anahtar altyapısı değil.

---

## E. Saldırı Yüzeyi

| Yüzey | Girdi kaynağı | Ana savunma |
|-------|---------------|-------------|
| PDF ayrıştırma | Tamamen saldırgan | Derinlik/boyut sınırları, `maxSignatures`, ByteRange yapısal denetimi |
| CMS / ASN.1 | Tamamen saldırgan | TLV sınır denetimi, zorunlu öznitelik kapıları |
| Sertifika zinciri | Tamamen saldırgan | Kriptografik issuer doğrulaması, RFC 5280 yol kısıtları, DER kimliği |
| AIA / CDP / OCSP adresleri | Tamamen saldırgan | `@fitfak/netguard` — varsayılan özel ağ engeli |
| TSA adresi | Operatör | Zaman aşımı + boyut sınırı |
| Sunucu API gövdesi | İstemci | Boyut sınırları, hız sınırı, belirteç, bağlama farkındalığı |
| Karekod yükü | Tamamen saldırgan | Hesaplanmış özet (`binding`) |
| Kayıt defteri | Yerel dosya | HMAC zinciri, yalnız okuma erişimi |

---

## F. Tehdit Modeli

**Saldırgan yetenekleri (varsayılan).** Belgeyi tamamen üretebilir; herhangi bir
ticari CA'dan sıradan sertifika alabilir; kendi CA'sını kurabilir; sertifika
uzantılarına istediği URL'i yazabilir; imzalı bir belgeyi ele geçirip artımlı
güncelleme ekleyebilir; karekodları kopyalayabilir.

**Saldırganın yapamadıkları (varsayım).** Güvenilen bir CA'nın özel anahtarını
ele geçiremez; SHA-256 çakışması üretemez; doğrulayan makinede kod çalıştıramaz;
güven deposunu değiştiremez.

**Bu modelde denetim öncesi durum:** saldırgan yalnız 1. yetenekle
(belgeyi üretmek) `TOTAL-PASSED` alabiliyordu (F-01). Denetim sonrası: bilinen
bir yol kalmadı.

---

## G. Test Boşlukları

Denetim sırasında **76 yeni test** eklendi (687 → 763). Kalan boşluklar:

- Gerçek dünya sertifikalarıyla (ticari CA zincirleri) uyumluluk sınanmıyor —
  yalnız yerel test PKI'ı kullanılıyor.
- Nitelikli imza (QES) profilleri için test yok.
- PDF/A-3 ve PDF/UA doğrulaması dış araçla (veraPDF) çapraz kontrol edilmiyor.
- Uzun süreli arşiv senaryosu (10+ yıl, çoklu arşiv damgası) simüle edilmiyor.
- Eşzamanlı yük altında hız sınırı ve oturum davranışı ölçülmüyor.

---

## H. Düzeltme Sırası (uygulandı)

| Öncelik | Bulgu | Durum |
|---------|-------|-------|
| P0 | F-01, F-02, F-03, F-04 | ✓ tamamlandı |
| P1 | F-05, F-06, F-07, F-08, F-09 | ✓ tamamlandı |
| P2 | F-10, F-11, F-12 | ✓ tamamlandı |
| P3 | Kalan boşluklar (§D) | açık — ayrı bir iş kalemi |

---

## I. Nihai Karar

> ### PRODUCTION READY WITH HARDENING

**Gerekçe.** Denetimde bulunan sekiz çalışan atlatmanın hepsi kapatıldı ve her
biri kalıcı bir regresyonla korunuyor. Doğrulama motoru artık güven kararını
kriptografik kimliğe, yetkiyi RFC 5280 yol kısıtlarına, bütünlüğü gerçek
sürüm karşılaştırmasına ve algoritma kabulünü açık bir politikaya bağlıyor.

**"…WITH HARDENING" niçin.** İki eksik, kararın "PRODUCTION READY" olmasını
engelliyor:

1. **Sertifika politikası işleme yok** (§D.1). Nitelikli elektronik imza
   iddiasında bulunulacaksa bu şart.
2. **DocMDP P=2/P=3 ayrımı yapılmıyor** (§D.2). Form doldurmaya izin veren
   sertifikasyon imzaları şu an fazla katı değerlendiriliyor.

Ayrıca dağıtımda **zorunlu** olan üç ayar var:
`API_TOKENS` tanımlanmalı, `ALLOW_SERVER_PFX` kapalı bırakılmalı,
`ALLOW_PRIVATE_PKI` yalnız kurum içi PKI varsa açılmalıdır.

**Ölçüm.** 763 test geçiyor (denetim başlangıcında 687). Altı istismar betiği
sekiz saldırı varyantını kapsıyor; hepsi düzeltme öncesi başarılı, sonrası
başarısız — her biri commit mesajında kanıtıyla kayıtlı.

---

*Bu rapor, denetim sırasında yazılan istismarların çıktılarına ve okunan
kaynak koda dayanır. Emin olunmayan noktalar "doğrulanmalı" olarak
işaretlenmiştir; hiçbir standart maddesi uydurulmamıştır.*
