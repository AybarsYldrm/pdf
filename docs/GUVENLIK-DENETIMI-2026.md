# FITFAK Platformu — Adversarial Güvenlik Denetimi

**Kapsam:** PKI · X.509 · PAdES/CAdES/CMS · TSA (RFC 3161) · OCSP/CRL · LTV/POE · PDF imza · sunucu API · doğrulama kaydı
**Yöntem:** Kaynak-seviyesi inceleme + her kritik bulgu için çalışan exploit (`.audit/*.js`)
**Tarih:** 2026-08-20

> Bu denetim "kod çalışıyor mu?" değil, **"saldırgan tarafından üretilmiş girdide güvenlik kararı doğru mu?"** sorusunu sorar. 687/687 testin geçmesi bir güvenlik kanıtı DEĞİLDİR: aşağıdaki açıkların **hepsi** testler yeşilken mevcuttur, çünkü testler yalnız meşru girdiyle üretilmiş belgeleri deniyor.

---

## A. Yönetici Özeti — En kritik 10 bulgu

| ID | Sev | Başlık | Sonuç |
|----|-----|--------|-------|
| **F-01** | CRITICAL | Trust anchor yalnız **Subject DN** ile eşleştiriliyor | Saldırgan aynı DN'li kök üretip **her belgeyi doğrulatır** |
| **F-02** | CRITICAL | Yol doğrulamasında **basicConstraints / keyUsage / pathLen yok** | `CA=false` bir yaprak sertifikayla **sahte sertifika ihraç** edilir |
| **F-03** | CRITICAL | CMS `content-type` ve `signing-certificate-v2` **fail-open** | Zorunlu öznitelik eksik/yanlış olsa da **TOTAL-PASSED** |
| **F-04** | CRITICAL | TSA **güven çıpasına bağlanmadan POE** üretiyor | Güvenilmeyen TSA ile **2031 tarihli sahte zaman kanıtı** |
| **F-05** | CRITICAL | OCSP responder yetkisi **AKI/DN** ile (imza doğrulanmıyor) | İmzalanmamış sahte responder → **iptal baypası** |
| **F-06** | HIGH | **DocMDP doğrulama tarafında hiç uygulanmıyor** | DocMDP=1 belgeye görünür içerik eklenir, yine PASSED |
| **F-07** | HIGH | CRL/OCSP/AIA/TSA **SSRF koruması yok** (netguard yalnız HTML'de) | Sertifika CDP'siyle **169.254.169.254 / iç ağ** taranır |
| **F-08** | HIGH | `API_TOKENS` tanımsızsa **tüm hassas uçlar fail-open** | `0.0.0.0` + token yok → imzalama/PFX kimliksiz, yalnız `warn` |
| **F-09** | MEDIUM | Zayıf algoritma politikası yok | **SHA-1 imza** uyarısız kabul; RSA anahtar boyu denetlenmiyor |
| **F-11** | MEDIUM | QR **docNo** ile lookup — belgeye kriptografik bağ yok | QR kopyala/başka belgeye bas → tarayıcı **verified** der |

**Ortak kök neden (F-01, F-03, F-04):** `packages/verify/index.js:345`

```js
if (entry.indication === INDICATION.INDETERMINATE && !entry.subIndication) {
  entry.indication = INDICATION.PASSED;          // ← errors[] hiç okunmadan
}
```

Doğrulama başlangıçta `INDETERMINATE`tir ve her adım yalnız `subIndication` set ederse başarısız olur. `errors[]` dizisine yazılan hatalar (content-type yok, signing-cert yanlış, trust bulunamadı) **nihai karara hiç bağlanmaz**; `subIndication` boş kaldığı sürece belge `PASSED` olur. Bütün "hata kaydediliyor ama karar değişmiyor" açıkları buradan doğar.

---

## B. Kritik Bulgular (kanıtlı)

### F-01 — Trust anchor Subject DN çakışmasıyla güven baypası

| | |
|---|---|
| **SEVERITY** | CRITICAL |
| **PACKAGE / FILE** | `packages/verify/index.js` |
| **FUNCTION / LINE** | `isSelfSignedIn` (838-846), `verifyOneSignature` (257) |
| **STANDARDS** | RFC 5280 §6.1 (trust anchor = ad **+ açık anahtar**), ETSI EN 319 102-1 |

**Kök neden.** Zincirin kökü güven deposuyla iki yoldan eşleştiriliyor:

```js
const trusted = ctx.trustAnchors.some((ta) => ta.equals(anchor))
             || isSelfSignedIn(anchor, ctx.trustAnchors);
```

Birinci koşul (tam DER eşitliği) doğrudur. Ancak `isSelfSignedIn` — adına rağmen self-signed'ı doğrulamaz — yalnız **Subject DN** karşılaştırır:

```js
function isSelfSignedIn(certDer, anchors) {
  const subject = getSubjectDer(certDer);
  return anchors.some((a) => getSubjectDer(a).equals(subject));   // yalnız DN
}
```

Anchor DER'i güven deposundakiyle birebir aynı olmasa bile, **DN'i aynı** olan herhangi bir kök `trusted = true` yapar. Açık anahtar, SPKI, SKI, self-imza — hiçbiri kontrol edilmez.

**Exploit** (`.audit/x01-trust-anchor.js`): saldırgan `CN=FITFAK Test Root CA` DN'li kendi kökünü üretir (farklı anahtar), belgeyi kendi zinciriyle imzalar. Kurban yalnız gerçek kökü güvenir:

```
gerçek kök SPKI: cafc63bd...   sahte kök SPKI: 3b1aaf01...   (farklı anahtarlar)
indication   : TOTAL-PASSED
chain.trusted: true
>>> TRUST BYPASS DOĞRULANDI — sahte kök güvenilir sayıldı
```

**Etki.** Herhangi bir belgeyi "geçerli imzalı" gösterebilir. PKI'nın tüm temeli çöker.
**Düzeltme.** Trust kararı yalnız **tam DER eşitliği** (ya da SPKI/sertifika fingerprint) ile verilmeli; `isSelfSignedIn`'in DN-tabanlı ikinci yolu tamamen kaldırılmalı.
**CONFIDENCE:** Kesin (çalışan exploit).

---

### F-02 — Yol doğrulamasında basicConstraints / keyUsage / pathLen yok

| | |
|---|---|
| **SEVERITY** | CRITICAL |
| **PACKAGE / FILE** | `packages/verify/index.js` (zincir bloğu 252-288), `packages/pades/src/cades/x509_ext.js` `buildChain` (387) |
| **STANDARDS** | RFC 5280 §6.1.4 (k)(n) — `cA=TRUE`, `keyCertSign`, `pathLenConstraint` zorunlu |

**Kök neden.** `buildChain` yalnız **isIssuerOf** (issuer DN = subject DN + opsiyonel AKI/SKI) ile zincir kurar. `verifyOneSignature` zincir **imzalarını** doğrular (269) ama hiçbir yerde ara sertifikaların `basicConstraints.cA=true`, `keyUsage.keyCertSign`, `pathLenConstraint` kısıtları denetlenmez. "Zincir kurulabiliyor + imzalar geçerli" ile "geçerli sertifika yolu" birbirine karıştırılmış.

**Exploit** (`.audit/x02-leaf-as-ca.js`): saldırgan meşru bir `CA=false` yaprak sertifikaya sahip (sıradan çalışan sertifikası). Onu CA gibi kullanıp "GENEL MUDUR" adına sertifika üretir:

```
zincir: ceo.kurum.tr → saldirgan.kurum.tr → Kurum Ara CA → Kurum Kok CA
CA bayrakları: ceo.kurum.tr=false, saldirgan.kurum.tr=false, ...
indication: TOTAL-PASSED
>>> CA KISITI YOK — son-varlık sertifikası CA gibi kullanıldı
```

**Etki.** Herhangi bir meşru son-varlık sertifikası (e-posta sertifikası, TLS sertifikası) sahte CA'ya dönüşür; istenen her kimlikle imza üretilebilir. F-01'den bağımsız ikinci tam PKI baypası.
**Düzeltme.** Yol doğrulamasına RFC 5280 §6.1.4 uygulanmalı: her ara için `cA=TRUE` + `keyCertSign`, `pathLenConstraint` sayacı, yaprakta `digitalSignature`/`nonRepudiation`, kritik-bilinmeyen-uzantı reddi.
**CONFIDENCE:** Kesin.

---

### F-03 — CMS `content-type` ve `signing-certificate-v2` fail-open

| | |
|---|---|
| **SEVERITY** | CRITICAL |
| **PACKAGE / FILE** | `packages/verify/src/cms.js` (237-262), `packages/verify/index.js` (240-249, 345) |
| **STANDARDS** | RFC 5652 §11.1 (content-type), §11.2 (message-digest); RFC 5035 / ETSI EN 319 122 (signing-certificate-v2) |

**Kök neden.** `verifySignerInfo` `content-type` ve `signing-certificate-v2` hatalarını `result.errors`'a yazıyor ama `verifyOneSignature` yalnız `messageDigestMatches` ve `signatureValid`'i karara bağlıyor (240-249). Diğer hatalar F-01'deki `INDETERMINATE→PASSED` yolundan geçip yutuluyor.

**Exploit** (`.audit/x03-cms-attrs.js`) — dört zorunlu-öznitelik ihlali:

```
A. signing-certificate-v2 YOK      → TOTAL-PASSED  (hata kaydedildi ama yutuldu)
B. content-type YOK                → TOTAL-PASSED
C. signing-certificate-v2 BAŞKA sertifika → TOTAL-PASSED
D. content-type YANLIŞ OID         → TOTAL-PASSED
```

C özellikle tehlikeli: signing-certificate-v2 imzalayanı sertifikaya **bağlayan** özniteliktir; yanlış olması sertifika-değiştirme (substitution) saldırısına kapı açar.

**Not (doğru davranan):** `message-digest` eksik/yanlış ve `signature` kripto hataları **fail-closed** (bunlar `messageDigestMatches=false` / `signatureValid=false` set ediyor). Açık yalnız diğer zorunlu özniteliklerde.

**Düzeltme.** `cmsResult.errors.length > 0` ise `INDETERMINATE`/`FAILED` yapılmalı; `contentTypeValid`, `signingCertificateValid` `false`/`null` iken PASSED verilmemeli.
**CONFIDENCE:** Kesin.

---

### F-04 — TSA güven çıpasına bağlanmadan POE üretiyor

| | |
|---|---|
| **SEVERITY** | CRITICAL |
| **PACKAGE / FILE** | `packages/verify/index.js` `verifyTimestamp` (492-546), POE kullanımı (302-304) |
| **STANDARDS** | RFC 3161 §2.3; ETSI EN 319 102-1 (POE yalnız **güvenilir** TSA'dan) |

**Kök neden.** İmza zaman damgasını doğrulayan `verifyTimestamp`, EKU=timeStamping ve TST imzasını kontrol eder ama **TSA sertifikasının zincirini kurmaz, güven çıpasına bağlamaz**. `t.valid = res.signatureValid && ekuValid && ...` — güven yok. Ardından `verifyOneSignature`:

```js
const poeSource = entry.timestamps.find((t) => t.valid && t.genTime);  // güven aranmıyor
```

Belge zaman damgası yolundaki `verifyDocTimeStamp` **zinciri kuruyor** (464-470) — yani asimetri var: doc-timestamp korumalı, imza-timestamp değil.

**Exploit** (`.audit/x04b-untrusted-tsa.js`): saldırgan kendi CA'sından EKU=timeStamping'li TSA çıkarır (kurbanın deposunda yok), `T=+5yıl` damgalar:

```
sahte TSA kökü kurbanın deposunda mı: HAYIR
POE: {"time":"2031-08-19...","source":"signature-timestamp","tsa":"sahte.tsa"}
>>> GÜVENİLMEYEN TSA KABUL EDİLDİ — sahte POE üretildi
```

**Etki.** Sahte POE, süresi dolmuş/iptal edilmiş sertifikaları "imza anında geçerliydi" diye kurtarır (verify/index.js:315 — POE varsa expired sertifika yalnız uyarı). Uzun-vadeli doğrulamanın (LTV) tüm değeri yok olur.
**Düzeltme.** `verifyTimestamp` da `buildChain` + trust-anchor kontrolü yapmalı; `t.valid` yalnız TSA zinciri güvenilirse `true` olmalı; POE seçimi `t.chainTrusted` istemeli.
**CONFIDENCE:** Kesin.

---

### F-05 — OCSP responder yetkisi imza doğrulanmadan AKI/DN ile belirleniyor

| | |
|---|---|
| **SEVERITY** | CRITICAL |
| **PACKAGE / FILE** | `packages/verify/src/ocsp.js` `checkResponderAuthorization` (459-497), `isIssuerOf` (`x509_ext.js:357`) |
| **STANDARDS** | RFC 6960 §4.2.2.2 (delege responder CA tarafından **imzalanmış** olmalı) |

**Kök neden.** Delege responder yetkisi `ext.isIssuerOf(responderDer, issuerDer)` ile belirleniyor. `isIssuerOf` yalnız **issuer DN = subject DN** ve (varsa) **AKI keyId = SKI** karşılaştırır — CA'nın responder'ı gerçekten **imzalayıp imzalamadığını doğrulamaz**. AKI, saldırganın ürettiği sertifikanın içindedir; gerçek CA'nın SKI'sıyla eşitlenebilir.

**Exploit** (`.audit/x05b-ocsp-aki-patch.js`): aynı DN'li sahte CA'dan responder çıkarılır, AKI baytı gerçek CA'nın SKI'sıyla yamalanır:

```
gerçek CA bu sertifikayı İMZALADI mı: false
yanıtlayan yetkili: true          durum: good        hatalar: []
>>> İPTAL BAYPASI — imzalanmamış sahte responder yetkili sayıldı
```

**Etki.** İptal edilmiş bir sertifika için saldırgan kendi "good" OCSP yanıtını imzalar; DSS'e gömer; iptal tümüyle baypas edilir. (İlk denemede — F-05a — AKI/SKI kontrolü tutmuştu; ama AKI saldırganın kontrolünde olduğundan yama ile aşıldı.)
**Düzeltme.** `checkResponderAuthorization` responder sertifikasının imzasını issuer'ın **açık anahtarıyla** doğrulamalı (`X509Certificate.verify(issuer.publicKey)`), DN/AKI eşleşmesine güvenmemeli.
**CONFIDENCE:** Kesin.

---

## C. Yüksek Bulgular

### F-06 — DocMDP doğrulama tarafında uygulanmıyor

| | |
|---|---|
| **SEVERITY** | HIGH |
| **FILE** | `packages/verify/index.js` (imza kapsamı 164-183) |
| **STANDARDS** | ISO 32000-1 §12.8.2.2 (DocMDP), PAdES |

İmzalama tarafı `docMDP` parametresini yazıyor ama doğrulama tarafı hiç okumuyor. DocMDP=1 ("hiçbir değişiklik") ile imzalanmış belgeye incremental update ile görünür içerik (FreeText annotation) eklendiğinde:

```
indication            : TOTAL-PASSED
belge tümünü kapsıyor : false
docMDP raporu         : null
uyarılar: ["... sonrasında 151 bayt daha var (sonraki imza olabilir)"]
```

(`.audit/x06b-incremental.js`.) Kullanıcıya gösterilen tek sinyal "sonraki imza olabilir" uyarısıdır — oysa değişiklik DocMDP'nin **yasakladığı** türden. "Document changed" ile "Document changed in a way prohibited by DocMDP" ayrımı yapılmıyor.

**Düzeltme.** İmzadan sonraki her revizyon fark analizinden geçmeli; DocMDP `P` değerine göre yasak değişiklik (`/Annots`, sayfa ekleme/silme, içerik akışı) `INVALID_DOCMDP` ile raporlanmalı.

### F-07 — CRL/OCSP/AIA/TSA fetch'inde SSRF koruması yok

| | |
|---|---|
| **SEVERITY** | HIGH |
| **FILE** | `packages/pades/src/cades/crl.js` `fetchCrl` (74), `.../ocsp.js`, `.../revocation.js` `collectForCertificate` (67) |
| **STANDARDS** | — (uygulama güvenliği) |

`fetchCrl` URL'yi doğrudan `transport.get(u)`'ya veriyor; adres kontrolü yok. `collectForCertificate` CDP/AIA URL'lerini **sertifikanın içinden** okuyor (`extractCDP`, `extractAIA`). HTML tarafındaki `packages/pdf-html/src/assets/netguard.js` özel-ağ/IPv4-mapped/redirect savunması **PKI koduna hiç bağlı değil** — iki ayrı, tutarsız ağ katmanı (bkz. F-15 mimari borcu).

`.audit/x07-pki-ssrf.js` `127.0.0.1`/`localhost` iç servise bağlantının kurulduğunu gösterdi (içerik geldi, yalnız CRL-format ayrıştırmasında düştü). `/api/verify` `allowNetwork: body.allowNetwork === true` ile bunu istemciye açıyor: saldırgan CDP'si `http://169.254.169.254/latest/meta-data/` olan bir sertifikayla belge yollar → sunucu bulut metadata'sına istek atar.

**Düzeltme.** Tek bir güvenli ağ soyutlaması (netguard) hem HTML hem PKI fetch'lerinde kullanılmalı: DNS-bir-kez-çöz-IP'ye-bağlan, özel/link-local/multicast/metadata blokları, redirect başına yeniden doğrulama.

### F-08 — API_TOKENS tanımsızsa hassas uçlar fail-open

| | |
|---|---|
| **SEVERITY** | HIGH |
| **FILE** | `apps/server/src/policy.js` `authorize` (208-220), `apps/server/server.js` (1404-1409) |

```js
if (!authEnabled()) {                 // API_TOKENS boş
  return { allowed: true, kind, unauthenticated: true };   // ← her hassas uç açık
}
```

`HOST=0.0.0.0` + `API_TOKENS` tanımsız senaryosunda sunucu yalnız `console.warn` verir; **kapanmaz**. `/api/sign/pfx`, `/api/sign/prepare`, `/api/sign/finalize`, `/api/collab/*` kimlik doğrulamasız erişilebilir. Ayrıca collab uçları `classify()` içinde `sensitive` değil `compute` sınıfında (belge okuma/yazma yetkisi hiçbir zaman token istemez — F-12).

**Düzeltme.** Dışa-açık bind + token yok = **başlatmayı reddet** (ya da hassas uçları 503 yap). "Uyarı ver ama çalış" fail-open'dır.

---

## D. Orta ve Düşük Bulgular

| ID | Sev | Yer | Özet |
|----|-----|-----|------|
| **F-09** | MEDIUM | `verify/src/cms.js:35`, `ocsp.js:70` | SHA-1 imza (`sha1WithRSA`, `1.3.14.3.2.26`) uyarısız kabul; RSA anahtar boyu / EC eğri politikası yok. Zayıf-algoritma reddi eklenmeli. |
| **F-10** | MEDIUM | `registry/index.js:247` | `_read()` tüm defteri `readFileSync`+`split('\n')` ile belleğe alır (MAX_RECORDS 500K ≈ 150 MB). Önbellek var ama ilk okuma/değişiklik sonrası tam yükleme; stream+indeks tercih edilmeli. |
| **F-11** | MEDIUM | `apps/scanner/server.js` `lookup` (85,110) | QR yalnız `docNo` taşıyorsa (`lookupByDocNo`) belge içeriğiyle **kriptografik bağ yok**. Aynı docNo'lu QR sahte belgeye basılırsa tarayıcı "verified" der. `docs/09` "kayda bakar" der ama docNo-lookup replay'e açık; yalnız `documentHash` bağlayıcıdır. |
| **F-12** | MEDIUM | `apps/server/server.js` collab uçları, `policy.js:166` | Collab oturumlarında **authorization yok**: `sessionId` bilen herkes join edip belgeyi okur/değiştirir. 96-bit random ID enumeration'ı zorlaştırır ama belge sahipliği/erişim kontrolü yoktur. |
| **F-13** | LOW | `pades/src/cades/x509_extract.js:8-10` | `readTLV` indefinite-length (`0x80`) formunu 0-uzunluk gibi sessizce ayrıştırır; BER ≠ DER. Kanonik-olmayan uzunluk/INTEGER reddi yok. |
| **F-14** | LOW | `pades/src/cades/crl.js:109,126` | `normalizeCrlBuffer` `res.on('end')` callback'i içinde **senkron throw** eder; Promise reddine değil `uncaughtException`'a döner → hedefli bir yanıtla süreç çökebilir (DoS). |

---

## E. Standartlar Uyum Özeti

| Standart | Madde | Beklenen | Mevcut | Sonuç |
|----------|-------|----------|--------|-------|
| RFC 5280 | §6.1 trust anchor | ad **+ açık anahtar** | yalnız DN yolu var | **F-01** ihlal |
| RFC 5280 | §6.1.4 (k)(n) | cA/keyCertSign/pathLen | denetlenmiyor | **F-02** ihlal |
| RFC 5280 | §6.3.3 CRL kritik ext | tam CRL kapsamı | S-4'te büyük ölçüde uygulanmış | uyumlu (doğrulandı) |
| RFC 5652 | §11.1/11.2 zorunlu attr | content-type + message-digest | md fail-closed, content-type fail-open | **F-03** kısmi ihlal |
| RFC 5035 | signing-certificate-v2 | imzalayanı bağlar | fail-open | **F-03** ihlal |
| RFC 3161 | §2.3 TSA EKU + güven | EKU **ve** trust | EKU var, trust yok | **F-04** ihlal |
| RFC 6960 | §4.2.2.2 responder yetki | CA **imzası** | DN/AKI eşleşmesi | **F-05** ihlal |
| ISO 32000-1 | §12.8.2.2 DocMDP | değişiklik sınıfı | uygulanmıyor | **F-06** ihlal |
| ETSI EN 319 102-1 | POE | güvenilir TSA'dan | güvenilmeyen kabul | **F-04** ihlal |

> Madde numaraları doğrulanmıştır; kesin alt-madde eşlemesi için ilgili RFC'nin son sürümü referans alınmalı.

---

## F. Saldırı Yüzeyi ve Tehdit Modeli

| Saldırgan | Girdi | En ağır sonuç |
|-----------|-------|---------------|
| Kötü niyetli **sertifika** | kendi kökü/yaprağı | F-01, F-02 → herhangi bir belgeyi doğrulatma |
| Kötü niyetli **CMS** | elle kurulmuş SignerInfo | F-03 → zorunlu öznitelik baypası |
| Kötü niyetli **TSA** | sahte token | F-04 → sahte POE, LTV çürütme |
| Kötü niyetli **OCSP** | AKI-yamalı responder | F-05 → iptal baypası |
| Kötü niyetli **HTTP sunucu** | CDP/AIA URL'li sertifika | F-07 → SSRF |
| **Kimliksiz uzak** kullanıcı | 0.0.0.0 + token yok | F-08 → imzalama/PFX uçları |
| Kötü niyetli **QR** | docNo QR kopyası | F-11 → sahte "verified" |

---

## G. Doğrulama Kanıtları (`.audit/`)

Her kritik bulgu çalışan bir betikle kanıtlandı:

```
.audit/x01-trust-anchor.js       F-01  TRUST BYPASS DOĞRULANDI
.audit/x02-leaf-as-ca.js         F-02  CA KISITI YOK
.audit/x03-cms-attrs.js          F-03  4/4 FAIL-OPEN
.audit/x04b-untrusted-tsa.js     F-04  sahte POE (2031)
.audit/x05b-ocsp-aki-patch.js    F-05  İPTAL BAYPASI
.audit/x06b-incremental.js       F-06  DocMDP yok
.audit/x07-pki-ssrf.js           F-07  iç servise bağlantı
```

Bu betikler düzeltmeden sonra **regresyon testine** dönüştürülmeli (beklenen: hepsi `TOTAL-FAILED`/`INDETERMINATE`).

---

## H. Önerilen Düzeltme Sırası

**P0 (üretim engelleyici — güven kararları yanlış):**
- F-01 trust anchor tam-DER/SPKI eşitliği
- F-02 RFC 5280 §6.1.4 kısıt zinciri
- F-03 `errors[]`'ı karara bağla (verify/index.js:345 kök neden)
- F-04 TSA zinciri + POE güven kontrolü
- F-05 OCSP responder imzasını doğrula

**P1 (yüksek):**
- F-06 DocMDP doğrulaması
- F-07 tek güvenli ağ soyutlaması (netguard'ı PKI'ya uygula)
- F-08 fail-closed bind

**P2 (orta):** F-09 algoritma politikası · F-11 QR-belge bağı (hash zorunlu) · F-12 collab authorization
**P3 (düşük):** F-10 registry stream · F-13 DER kanoniklik · F-14 senkron-throw

---

## I. Nihai Güvenlik Kararı

### NOT PRODUCTION SAFE

**Gerekçe.** Sistem meşru girdiyle doğru çalışır ve 687 test geçer, ancak **beş bağımsız CRITICAL açık** doğrulamanın temel güvenlik garantisini çürütür: saldırgan (a) sahte kök (F-01) ya da (b) `CA=false` yaprak (F-02) ile herhangi bir belgeyi "geçerli imzalı" gösterebilir; (c) zorunlu CMS öznitelikleri baypas edilebilir (F-03); (d) sahte zaman kanıtı üretilebilir (F-04); (e) iptal baypas edilebilir (F-05). Bunlardan **herhangi biri tek başına** bir imza-doğrulama ürününü kullanılamaz kılar.

Bu açıklar bir kodlama hatası değil, **mimari bir eksikliktir**: `verify/index.js` bir *sertifika yolu doğrulayıcısı* değil, bir *zincir kurucu + imza kontrolcüsüdür*. RFC 5280 §6 yol doğrulaması (trust anchor kimliği, kısıtlar, policy) hiç uygulanmamış. F-03/F-04/F-01 aynı kök nedenden (`errors[]` karara bağlanmaması) beslenir.

**Üretime çıkış için asgari koşul:** P0 kalemlerinin tamamı düzeltilip `.audit/` betiklerinin regresyon testi olarak `TOTAL-FAILED` vermesi; ardından bağımsız bir çapraz-doğrulayıcıyla (EU DSS, Adobe) uyum kontrolü.

*Not: Bu denetim önceki turda kapatılan S-1…S-11 kalemlerini (sıkıştırma bombası, HTML SSRF, RFC 5280 CRL kapsamı, hız sınırı, kayıt defteri kurcalama) doğruladı — bunlar sağlamdır. Yeni bulgular PKI/CMS/TSA **çekirdek doğrulama mantığındadır** ve bu katman denetlenmemişti.*
