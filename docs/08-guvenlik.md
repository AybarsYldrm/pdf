# Güvenlik Denetimi ve Sertleştirme

Bu belge, kod tabanının güvenlik denetimini, bulunan açıkları, uygulanan
düzeltmeleri ve her düzeltmeyi koruyan regresyon testini kayda geçirir.

Yöntem: her bulgu için önce **çalışan bir saldırı** yazıldı, saldırının işe
yaradığı gösterildi, sonra düzeltme yapıldı ve aynı saldırının artık işe
yaramadığı testle sabitlendi. "Şu fonksiyon `true` dönüyor" testi yazılmadı.

---

## 1. Güven sınırları

Kodun her yerinde aynı soru sorulur: **bu veri kimden geliyor?**

| Kaynak | Güven | Örnek |
|---|---|---|
| Çağıranın kendi JS'i | Güvenilir | `render({ fonts: [...] })` |
| **Belgenin içeriği** | **Güvenilmez** | `<img src>`, `@font-face url()` |
| HTTP istek gövdesi | Güvenilmez | `/api/render` gövdesi |
| PKCS#12 dosyası | Güvenilmez | kullanıcının yüklediği `.pfx` |
| OCSP / CRL / TSA yanıtı | Güvenilmez | ağdan gelen DER |
| DSS'e gömülü kanıt | Güvenilmez | belgeyi kim ürettiyse koymuş |

Son üç satır özellikle önemlidir: bunlar "PKI'dan geliyor" diye güvenilir
sanılır. Oysa bir OCSP yanıtı ancak **doğrulandıktan sonra** kanıttır.

---

## 2. Bulgular ve düzeltmeler

### G-01 · Kritik · HTML işleyicisinde yerel dosya ifşası

| | |
|---|---|
| **Dosya** | `packages/pdf-html/index.js`, `packages/pdf-html/src/assets/resolver.js` |
| **Sorun** | `<img src>` ve `@font-face url()` değerleri doğrudan `fs.readFileSync`'e veriliyordu. |
| **Saldırı** | Belgeye `<img src="../../etc/passwd">` koyan biri, sunucunun okuyabildiği HERHANGİ bir dosyayı PDF'e gömdürebilirdi. Web Studio bunu `/api/render` üzerinden internete açıyordu. |
| **Düzeltme** | Bütün belge kaynaklı yollar `AssetResolver` kum havuzundan geçer: **çöz → normalize et → mutlak yolu reddet → `resolve` → `realpath` → kapsam doğrula → oku**. `realpath` atlanamaz; kum havuzunun içindeki bir sembolik bağ dışarıyı gösterebilir. |
| **Kapsanan varyantlar** | `../`, derin `../../../`, mutlak yol, Windows sürücü yolu (`C:\`), UNC (`\\sunucu\pay`), yüzde kodlaması, ÇİFT yüzde kodlaması, karışık ayraç, sembolik bağ kaçışı, NUL baytı, `file://`, `http://`, `169.254.169.254` (SSRF) |
| **Test** | `test/unit/security.test.js` — "yol geçişi" bölümü (14 varyant) · `test/e2e/08-security.test.js` — "`/api/render` belge kaynaklı dosya yollarını okumaz" |

Kum havuzu **varsayılan olarak kapalıdır**: kök verilmezse hiçbir dosya
okunmaz. Sunucu, kökü `ASSET_ROOT` (varsayılan `assets/`) ile sınırlar —
depo kökü DEĞİL.

Ayrıca `TtfParser` artık `Buffer` kabul eder; motor dosya yolu yerine baytla
çalışabildiği için kum havuzu tek geçiş noktası olur.

### G-02 · Kritik · Sunucu tarafı PFX imzalama varsayılan açık

| | |
|---|---|
| **Dosya** | `apps/server/server.js` |
| **Sorun** | `ALLOW_SERVER_PFX !== '0'` — yani değişken tanımsızken bile AÇIK. |
| **Saldırı** | Varsayılan kurulumda özel anahtar + parola sunucuya gönderiliyordu. Sunucuyu ele geçiren, imzalama yeteneğini de ele geçirir. |
| **Düzeltme** | `process.env.ALLOW_SERVER_PFX === '1'`. Tanımsız → kapalı, `0` → kapalı, yalnız `1` → açık. Birincil model iki fazlı tarayıcı imzalamasıdır: anahtar tarayıcıdan çıkmaz. |
| **Test** | `test/e2e/08-security.test.js` — "sunucu tarafı PFX imzalama VARSAYILAN olarak kapalıdır" |

### G-03 · Yüksek · PKCS#12 KDF kaynak tüketimi

| | |
|---|---|
| **Dosya** | `packages/pkcs12/src/limits.js`, `packages/pkcs12/index.js` |
| **Sorun** | PFX içindeki yineleme sayısı sınırsızdı. |
| **Saldırı** | 2 milyar yinelemeli bir PFX, **parola doğrulanmadan önce** işlemciyi dakikalarca kilitler. Ölçüm: 200 000 yineleme = 371 ms → 50 milyon ≈ 93 saniye. Birkaç istek sunucuyu düşürür. |
| **Düzeltme** | `maxIterations`, `maxBytes`, `maxSaltBytes`, `maxBags`, `maxCertificates`, `maxDepth`, `maxAttributes`, `maxEncryptedBytes`. Sınırlar `parse(pfx, { limits })` ile geçirilir — **genel (global) durum kullanılmaz**, eşzamanlı istekler birbirinin sınırını değiştiremez. |
| **Test** | `test/unit/security.test.js` — "PKCS#12 kaynak sınırları" (yineleme, boyut, tuz, sayım, bozuk ASN.1) |

Test, yineleme alanını değiştirirken **kapsayan DER uzunluklarını da düzeltir**;
aksi hâlde ayrıştırıcı bozuk yapıya takılır ve sınır hiç sınanmamış olur.

### G-04 · Kritik · OCSP doğrulaması dizge araması ile yapılıyordu

| | |
|---|---|
| **Dosya** | `packages/verify/src/ocsp.js` (yeni), `packages/verify/index.js` |
| **Sorun** | Yanıtın doğru sertifikaya ait olup olmadığı `der.includes(serial)` gibi bayt örüntüleriyle belirleniyordu. |
| **Saldırı** | İptal edilmiş bir sertifikanın sahibi, BAŞKA bir sertifika için alınmış geçerli imzalı bir "good" yanıtını sunar. Yanıt gerçekten CA imzalıdır; tek kusuru başka sertifikaya ait olmasıdır. Dizge araması bunu ayırt edemez. Hatta seri numarasını içeren düz çöp veri bile "kanıt" sayılırdı. |
| **Düzeltme** | Tam RFC 6960 ayrıştırma zinciri: `OCSPResponse → BasicOCSPResponse → ResponseData → SingleResponse → CertID`. CertID eşleşmesi **hesaplanır**: yanıtın bildirdiği özet algoritmasıyla ihraç edenin adı ve açık anahtarı yeniden özetlenip karşılaştırılır. Ardından imza doğrulanır, yanıtlayanın yetkisi denetlenir (CA'nın kendisi ya da `id-kp-OCSPSigning` taşıyan delege — RFC 6960 §4.2.2.2), zaman geçerliliği kontrol edilir. |
| **Test** | `test/e2e/08-security.test.js` — A bölümü, 13 test |

Reddedilen bir yanıt "kanıt yok" sayılır ve `status: 'unknown'` döner —
sessizce yok sayılmaz, gerekçesi raporlanır.

### G-05 · Yüksek · DSS/LTV kanıt semantiği

| | |
|---|---|
| **Dosya** | `packages/verify/index.js` (`determineLevel`) |
| **Sorun** | Seviye tespiti `pdfBuffer.toString('latin1').includes('/DSS')` benzeri bayt aramasına dayanıyordu. |
| **Saldırı** | Belgeye herhangi bir OCSP yanıtı gömen biri, belgeyi "B-LT" gösterebilirdi. |
| **Düzeltme** | Seviye, **her sertifika için ayrı ayrı** doğrulanmış kanıttan hesaplanır: yoldaki her sertifikanın DSS kaynaklı, doğrulanmış ve `good`/`revoked` sonucu veren bir kanıtı olmalıdır. Belge zaman damgası varlığı da ayrıştırılmış imza listesinden okunur, bayt aramasıyla değil. |
| **Test** | `test/e2e/08-security.test.js` — "DSS: sahte OCSP kanıtı gömülü belge B-LT seviyesine YÜKSELMEZ" (+ meşru belgenin B-LT olduğunu gösteren olumlu kontrol) |

### G-06 · Yüksek · TSA `timeStamping` EKU'su uyarıya indirgenmişti

| | |
|---|---|
| **Dosya** | `packages/verify/index.js` |
| **Sorun** | `id-kp-timeStamping` (1.3.6.1.5.5.7.3.8) yoksa uyarı üretilip geçiliyordu. |
| **Saldırı** | Elindeki HERHANGİ bir sertifikayla "zaman damgası" üreten biri, belgeye istediği tarihi yazdırabilirdi. Arşiv damgasının bütün değeri bu kontrolden gelir. |
| **Düzeltme** | Belge zaman damgasında EKU yoksa `TOTAL-FAILED / SIG_CONSTRAINTS_FAILURE`. İmza zaman damgasında damga geçersiz sayılır: POE üretmez, seviye yükseltmez ve **raporda görünür** (sessizce yutulmaz). `strictTimestamps: false` verilirse `TOTAL-FAILED` yerine `INDETERMINATE` döner — kanıt eksiktir ama belge kesin sahte de değildir. |
| **Test** | `test/e2e/08-security.test.js` — C bölümü, 4 test (`test/e2e/helpers/rogue-tsa.js` gerçek, imzalı ama kuralsız bir RFC 3161 jetonu üretir) |

Ek olarak `content-type` imzalı özniteliği artık **beklenen türle** karşılaştırılır:
belge imzalarında `id-data`, zaman damgalarında `id-ct-TSTInfo`. Önceden her
jetonda `id-data` bekleniyordu; kontrol bu yüzden her zaman başarısız olur ve
hiçbir şey ayırt etmezdi.

### G-07 · Yüksek · Uçlarda kimlik doğrulama, yetkilendirme ve hız sınırı yoktu

| | |
|---|---|
| **Dosya** | `apps/server/src/policy.js` (yeni), `apps/server/server.js` |
| **Sorun** | `/api/sign/*`, `/api/pfx/*`, `/api/ltv/*` kimlik doğrulaması olmadan çağrılabiliyordu. |
| **Düzeltme** | Uçlar üç sınıfa ayrılır: `public` (`/api/health`), `compute` (`/api/render`, `/api/pdf/*`, `/api/verify`), `sensitive` (`sign`, `pfx`, `ltv`). Hassas uçlar `API_TOKENS` tanımlıysa belirteç ister; belirteç karşılaştırması **sabit zamanlıdır** (iki taraf da SHA-256'ya indirgenip `timingSafeEqual` ile karşılaştırılır, böylece uzunluk farkı da sızmaz). Kayan pencereli hız sınırı vardır (hassas uçlar için daha dar). Hassas işlemler denetim günlüğüne yazılır — parola, PFX içeriği, özel anahtar ve imza değeri **asla** kaydedilmez. |
| **Test** | `test/unit/security.test.js` (sınıflandırma, sabit zamanlı karşılaştırma, hız sınırlayıcı) · `test/e2e/08-security.test.js` (401, 429 + `Retry-After`, sağlık ucunun açık kalması) |

Sunucu dışa açık bir adrese bağlanıp `API_TOKENS` tanımlı değilse açılışta
uyarı basar.

### G-08 · Orta · Merkezî kaynak politikası yoktu

| | |
|---|---|
| **Dosya** | `apps/server/src/policy.js` |
| **Sorun** | Sınırlar dağınıktı; bir kısmı hiç yoktu. |
| **Saldırı** | 500 MB JSON gövde, 50 000 elemanlı `ops` dizisi, 200 000 sayfalık PDF, 10 MB HTML, 100 megapiksel PNG — hepsi bellek ya da işlemci tüketir. |
| **Düzeltme** | Bütün sınırlar tek sözlükte: gövde, PDF boyutu/sayfa sayısı, `ops`, HTML/CSS/metin, görsel bayt/piksel, font, varlık sayısı, PFX boyutu, DSS girdisi. Hepsi ortam değişkeniyle gevşetilebilir ama **varsayılanlar güvenlidir**. Aşımda 413 (boyut) ya da 400 (sayım) döner. |
| **Test** | `test/e2e/08-security.test.js` — D bölümü |

### G-09 · Orta · Gövde sınırı aşılınca bağlantı sessizce koparılıyordu

| | |
|---|---|
| **Dosya** | `apps/server/server.js` |
| **Sorun** | Sınır aşılınca `req.destroy()` anında çağrılıyordu; istemci 413 yerine "bağlantı sıfırlandı" görüyordu. |
| **Düzeltme** | Fazla baytlar **belleğe alınmaz** ama bağlantı hemen koparılmaz: istemci 413'ü görür. İsrafı sınırlamak için yalnız sınırın iki katına kadar tolerans gösterilir. |
| **Test** | `test/e2e/08-security.test.js` — "gövde sınırı aşılınca 413 döner ve istek okunmaz" |

### G-10 · Orta · `Content-Type` doğrulanmıyordu

| | |
|---|---|
| **Dosya** | `apps/server/server.js`, `apps/scanner/server.js` |
| **Sorun** | Her türde gövde JSON olarak ayrıştırılmaya çalışılıyordu. |
| **Saldırı** | Tarayıcılar `text/plain`, `multipart/form-data` ve `application/x-www-form-urlencoded` gövdeli POST'ları "basit istek" sayar ve **ön kontrol (preflight) yapmadan** başka kaynaklara gönderir. JSON şartı bu yolu kapatır. |
| **Düzeltme** | Gövdeli isteklerde `application/json` zorunlu; değilse 415. |
| **Test** | `test/e2e/08-security.test.js` — D ve E bölümleri |

### G-11 · Orta · Tarayıcı sunucusu sahte "doğrulandı" cevabı veriyordu

| | |
|---|---|
| **Dosya** | `apps/scanner/server.js` |
| **Sorun** | Arayüz dosyası adı (`scanner.html` / `index.html`) uyuşmuyordu; `/api/verify` ucu gövde sınırı, zaman aşımı ve girdi doğrulaması olmadan **her hash için olumlu** cevap veriyordu. |
| **Düzeltme** | Dosya adı düzeltildi; 64 KB gövde sınırı, istek/başlık zaman aşımı, `Content-Type` denetimi, `^[0-9a-fA-F]{32,128}$` hash biçimi kontrolü eklendi. Doğrulama kaydı bağlanana kadar uç `status: 'unverified'` döner — **kayıt yokken "doğrulandı" demek, hiç cevap vermemekten kötüdür.** |
| **Test** | `test/e2e/08-security.test.js` — E bölümü, 6 test |

### G-12 · Düşük · `npm ci` temiz ortamda çalışmıyordu

Çalışma alanı (`workspaces`) listesi ile `package-lock.json` ayrışmıştı.
`npm install --package-lock-only` ile eşitlendi; temiz bir dizine kopyalanıp
`npm ci` ile doğrulandı.

### G-13 · Yüksek · Sıkıştırma bombası: piksel sınırı ÇÖZDÜKTEN sonra

| | |
|---|---|
| **Dosya** | `packages/pdf/src/media/imageinfo.js` (yeni), `packages/pdf-html/src/assets/resolver.js`, `packages/pdf-scene/src/assets.js` |
| **Sorun** | Piksel sınırı vardı ama bayt boyutundan tahmin ediliyordu. |
| **Saldırı** | 40 KB'lık bir PNG başlığında 20000×20000 bildirebilir: çözüldüğünde 1,6 GB. Bayt sınırı bunu geçirir. |
| **Düzeltme** | Görsel başlığı (PNG IHDR / JPEG SOF) ÇÖZMEDEN okunur; piksel sayısı, bileşen sayısı ve çözülmüş bayt öngörüsü sınıra vurulur (Adam7 taraması için 1,5 katsayı). Sınırı aşan görsel hiç çözülmez. Aynı kod hem sunucuda hem tarayıcı paketinde çalışır: iki yer, iki farklı cevap vermesin. |
| **Test** | `test/unit/imageinfo.test.js` — 17 test |

### G-14 · Yüksek · Uzak varlıklarda SSRF savunması yoktu

| | |
|---|---|
| **Dosya** | `packages/pdf-html/src/assets/netguard.js`, `.../remote.js` (yeni) |
| **Sorun** | `allowRemoteAssets` bayrağı vardı ama adres denetimi yoktu. |
| **Saldırı** | Belgedeki `<img src="http://169.254.169.254/latest/meta-data/">` bulut kimlik bilgilerini okur; `http://127.0.0.1:8787/api/...` sunucunun kendi iç uçlarına istek attırır; DNS'i önce iyi sonra kötü adrese çözen bir ad (DNS rebinding) denetimi atlatır. |
| **Düzeltme** | Uzak varlıklar **varsayılan olarak kapalı** (`REMOTE_ASSET_HOSTS` izin listesi olmadan açılmaz). Ad BİR KEZ çözülür, dönen adreslerin HEPSİ denetlenir ve bağlantı doğrulanmış IP'ye kurulur (`Host` başlığı ve TLS `servername` elle verilir) — çözüm ile bağlantı arasında zaman farkı kalmaz. Özel/bağlantı yerel/çoklu yayın blokları, IPv4-eşlemeli IPv6 (`::ffff:127.0.0.1`), 6to4 ve NAT64 gömülü adresleri reddedilir. Yönlendirmelerin HER adımı yeniden denetlenir; boyut akış sırasında sayılır (`Content-Length`e güvenilmez). |
| **Test** | `test/unit/netguard.test.js` — 32 test |

### G-15 · Orta · CRL doğrulaması kapsam ve tazelik bilgisini okumuyordu

| | |
|---|---|
| **Dosya** | `packages/pades/src/cades/crl.js`, `packages/verify/index.js` |
| **Sorun** | Seri numarası aranıyordu; listenin o sertifikayı KAPSAYIP kapsamadığı sorulmuyordu. |
| **Saldırı** | Yalnız CA sertifikalarını kapsayan (`onlyCACerts`) ya da yalnız bir iptal nedenini kapsayan (`onlySomeReasons`) bir CRL, kapsamadığı bir sertifika için "listede yok → geçerli" cevabı üretirdi. |
| **Düzeltme** | IssuingDistributionPoint, delta CRL bağlantısı (`deltaCRLIndicator` + `cRLNumber`), `certificateIssuer` ile dolayı girdiler, `invalidityDate` ve ReasonFlags çözülür. Kısmi kapsamda sonuç `good` değil `unknown`tur ve gerekçesi bildirilir. Bilinmeyen KRİTİK eklenti taşıyan CRL reddedilir (RFC 5280 §6.3.3). |
| **Test** | `test/unit/crl.test.js` — 27 test |

### G-16 · Orta · Hız sınırı süreç sayısıyla çarpılıyordu

| | |
|---|---|
| **Dosya** | `apps/server/src/ratestore.js` (yeni), `apps/server/src/policy.js` |
| **Sorun** | Sayaç süreç belleğindeydi. |
| **Saldırı** | `cluster` ile dört çekirdek açan bir kurulumda "dakikada 20 imza" fiilen 80 olur. Bir denetimin çarpanla çalışması, olmamasından kötüdür: rapor "sınır var" der, gerçek başka söyler. |
| **Düzeltme** | Depo arayüzü ayrıldı. `RATE_LIMIT_DIR` tanımlıysa sayaçlar dosyada paylaşılır ve aynı makinedeki bütün süreçler aynı sayacı görür. Anahtar dosya adına çevrilmez, SHA-256 ile özetlenir (dizin dışına çıkma yüzeyi kalmasın). Depo yazamazsa süreç içi sayaca düşülür — **sessizce serbest bırakılmaz**: başarısızlık sayılır ve `/api/health` içinde bildirilir. |
| **Test** | `test/unit/ratelimit.test.js` — 19 test (paylaşım GERÇEK ayrı süreçlerle sınanır) |

### G-17 · Yüksek · Tarayıcı doğrulama yapmadan cevap veriyordu

| | |
|---|---|
| **Dosya** | `packages/registry/` (yeni), `apps/scanner/server.js`, `apps/server/server.js` |
| **Sorun** | G-11'de sahte "doğrulandı" cevabı kaldırılmıştı ama yerine bir şey konmamıştı: uç her belge için "kayıtlı değil" diyordu. |
| **Düzeltme** | İmza atıldığında belge, `@fitfak/verify` ile doğrulanır ve sonucu **eklemeli, HMAC zincirli** bir deftere yazılır (`REGISTRY_DIR` + `REGISTRY_KEY`). Tarayıcı defteri YALNIZ OKUR. Cevaplar birbirine karıştırılmaz: `unavailable` (defter yok/bozuk), `unverified` (kayıtlı değil), `indeterminate` (karar verilemedi), `invalid` (geçersizdi), `verified`. Defterin zinciri bozuksa **hiçbir kayıt kanıt sayılmaz**. Belgenin kendisi deftere yazılmaz: defter arşiv değildir. |
| **Test** | `test/unit/registry.test.js` (17) · `test/e2e/10-registry.test.js` (9, iki ayrı sunucu tek defter) |

---

## 3. Yapılmayanlar ve gerekçeleri

Bunlar bilinen ve **kabul edilmiş** sınırlardır; "destekleniyor" diye
sunulmamalıdır.

- **Hız sınırı yalnız AYNI MAKİNEDE paylaşılır.** `RATE_LIMIT_DIR`
  tanımlıysa sayaçlar dosyada tutulur ve o makinedeki bütün süreçler aynı
  sayacı görür; tanımlı değilse sayaç süreç içindedir ve sınır süreç
  sayısıyla çarpılır. Hangisinin geçerli olduğu `/api/health` içinde
  bildirilir. Birden çok MAKİNEYE yayılan bir kurulumda paylaşımlı bir depo
  (Redis vb.) gerekir; depo arayüzü bunun için ayrılmıştır.
- **Dosya deposu kilit kullanmaz.** İki süreç aynı anda son kotayı okursa
  sınır bir istek aşılabilir (N süreçte en fazla N-1). Kilit almak, çekişme
  anında olay döngüsünü bloklardı; sapma bilinerek kabul edilmiştir.
- **Belirteçler düz metin ortam değişkenindedir.** Bir sır yöneticisi
  (secret manager) kullanılmıyor.
- **Uzak kaynaklar VARSAYILAN OLARAK KAPALIDIR.** `REMOTE_ASSET_HOSTS` ile
  bir izin listesi verilmeden açılamaz (bkz. G-14).
- **Tarayıcı KAYDA bakar, belgeye değil.** Karekod yalnız bir özet/numara
  taşır; belgenin kendisi tarayıcıda yoktur. Cevap "imza ATILDIĞI ANDA
  şuydu" bilgisidir. Sertifika o tarihten sonra iptal edilmişse kayıt bunu
  bilmez ve cevap bunu açıkça söyler (`scope` alanı).
- **Kayıt defteri tek makinede bir dosyadır.** Zincir HMAC'lidir ve
  kurcalanma yakalanır ama defterin YEDEĞİ ve çoğaltılması işletmenin
  işidir. Defter silinirse kayıtlar da gider — silinmiş kayıt "kayıtlı
  değil" cevabı üretir, sahte bir onay değil.
- **`REGISTRY_KEY` düz metin ortam değişkenindedir.** Anahtarı ele geçiren
  biri geçerli kayıt üretebilir.

---

## 4. Regresyon testleri

| Dosya | Test | Kapsam |
|---|---|---|
| `test/unit/security.test.js` | 28 | Dosya yolu kum havuzu, PKCS#12 sınırları, sunucu politikası |
| `test/e2e/08-security.test.js` | 38 | OCSP, DSS/LTV, RFC 3161, HTTP sertleştirme, tarayıcı sunucusu |
| `test/unit/imageinfo.test.js` | 17 | Sıkıştırma bombası: piksel/çözülmüş bayt sınırı |
| `test/unit/netguard.test.js` | 32 | SSRF: özel ağ blokları, IPv4-eşlemeli IPv6, yönlendirme |
| `test/unit/crl.test.js` | 27 | RFC 5280 CRL kapsamı, delta, neden kodları |
| `test/unit/ratelimit.test.js` | 19 | Hız sınırı depoları, süreçler arası paylaşım |
| `test/unit/registry.test.js` | 17 | Kayıt defteri: kurcalama, zincir kopması, kilit |
| `test/e2e/10-registry.test.js` | 9 | İmza → kayıt → tarayıcı zinciri |

Yardımcı: `test/e2e/helpers/rogue-tsa.js` — kuralları kasten çiğneyen ama
yapısal olarak geçerli bir RFC 3161 jetonu üretir. Kendi TSA sunucumuz böyle
bir jeton üretmeyi reddettiği için, doğrulayıcının aynı kuralı zorladığını
sınamanın tek yolu saldırganı taklit etmektir. **Üretim kodunda kullanılmaz.**

Bütün paket: `npm run test:all`.
