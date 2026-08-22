# Sahne Modeli ve Görsel Editör

Serbest yerleşimli belgeler için ikinci bir üretim yolu: `@fitfak/pdf-scene`.

---

## 1. Neden ikinci bir yol

Var olan HTML/CSS → PDF motoru **akış** belgeleri için doğru araçtır: bir
sözleşmede paragraf uzayınca sonraki paragraf aşağı kayar, sayfa dolunca
yenisi açılır. Bu davranış istenen davranıştır.

Ama sertifika, kartvizit, kapak, sunum sayfası gibi belgelerde istenen tam
tersidir: **kullanıcı nesneyi nereye koyduysa oraya basılmalıdır.** Akış
yerleşimi burada düşman olur — araya giren her kutu her şeyi kaydırır.

İki ihtiyacı tek motora yüklemek yerine ikinci bir yol açtık:

```
Editör (tarayıcı) ─┐
İçe aktarma        ─┼─→  SAHNE MODELİ  ─┬─→  Scene → PDF   →  PAdES imza
Şablon / kod       ─┘   (düz JSON veri)  └─→  Scene → HTML  →  önizleme

HTML + CSS ──────────→  AKIŞ MOTORU  ───────→  PDF          →  PAdES imza
```

İki yol da **aynı PDF yazarını** ve **aynı imza motorunu** kullanır. PAdES
tarafında hiçbir şey değişmedi.

---

## 2. Model

### Tasarım kararları

| Karar | Gerekçe |
|---|---|
| Düz JSON, DOM'a bağlı değil | Aynı belge tarayıcıda düzenlenip sunucuda derlenebilsin |
| Tek birim: **punto** | Karışık birim taşımak her okuyucuyu dönüştürmeye zorlar; biri unutur |
| Başlangıç: sayfanın **sol üstü** | Ekranla aynı yön; PDF'in sol-altına çevirmek derleyicinin işi |
| Varlıklar **kimlikle** anılır | Sahne taşınabilir olur; belge içeriği dosya sistemine dokunamaz |
| Metin **metindir** | `text` düz metindir, HTML değildir ve HTML olarak yorumlanmaz |
| **Sürüm** alanı zorunlu | Şema değişince eski dosyayı okumanın tek yolu |

### Şema (sürüm 1)

```jsonc
{
  "version": 1,
  "id": "scene",
  "meta": { "title": "", "author": "", "subject": "", "lang": "tr-TR", "keywords": [] },
  "page": {
    "size": "A4",                 // ya da { width, height }
    "orientation": "portrait",
    "width": 595.28, "height": 841.89,
    "margin": { "top": 56.7, "right": 51, "bottom": 56.7, "left": 51 }
  },
  "assets": [
    { "id": "ast_…", "kind": "image", "mime": "image/png",
      "sha256": "…", "size": 12345, "width": 800, "height": 600 }
  ],
  "pages": [
    { "id": "pg1", "name": "Sayfa 1", "background": "#ffffff", "nodes": [ … ] }
  ]
}
```

### Düğüm tipleri

Her düğümde ortak alanlar: `id`, `type`, `name`, `frame {x,y,width,height}`,
`rotation`, `opacity`, `locked`, `hidden` ve erişilebilirlik alanları
`role` (PDF/UA yapı rolü), `alt`, `lang` (bkz. §9).

İmza yuvasındaki imzalayan unvanı `signerTitle`dır; `role` her düğümde
**yapı rolü** anlamına gelir. Eski belgelerdeki serbest metinli
`signature.role` sessizce yutulmaz, `ERR_RENAMED_FIELD` ile reddedilir.

| Tip | Tipe özgü alanlar |
|---|---|
| `text` | `text`, `runs[]`, `fontFamily`, `fontSize`, `lineHeight`, `color`, `align`, `valign`, `bold`, `italic`, `letterSpacing`, `padding`, `autoHeight` |
| `rect` | `fill`, `stroke`, `strokeWidth`, `radius` |
| `ellipse` | `fill`, `stroke`, `strokeWidth` |
| `line` | `stroke`, `strokeWidth`, `dash` — çerçevenin köşegeni üzerinde tanımlıdır |
| `path` | `d` (`[['M',x,y],['L',x,y],['C',…],['Z']]`), `fill`, `stroke`, `strokeWidth`, `fillRule`, `dash` |
| `image` | `assetId`, `fit` (contain/cover/fill) |
| `qr` | `payload`, `ecc`, `quiet`, `dark`, `light` |
| `signature` | `fieldName`, `signer`, `signerTitle`, `label`, `showFrame` |
| `group` | `children[]` — çocuk koordinatları **grubun sol üstüne göredir** |

`runs[]`, zengin metin içindir: her koşu kendi `bold`/`italic`/`color`/
`fontSize`/`link` değerlerini taşır. Bu sayede derleyicinin dizge
birleştirerek işaretleme üretmesi gerekmez.

### Doğrulama

`validateScene()` hem **denetler** hem **normalleştirir**: eksik alanlar
varsayılanla dolar, uzunluklar puntoya çevrilir, renkler `#rrggbb` olur,
**şemada olmayan alanlar atılır**.

Reddedilenler:

| Kod | Ne yakalar |
|---|---|
| `ERR_VERSION` | Desteklenmeyen şema sürümü |
| `ERR_NODE_TYPE` | Bilinmeyen düğüm tipi |
| `ERR_DUPLICATE_ID` | Yinelenen kimlik |
| `ERR_DEPTH` | 32 seviyeden derin yuvalama |
| `ERR_TOO_MANY` | Sayfa/düğüm/varlık/koşu sınırı |
| `ERR_LINK_SCHEME` | `javascript:`, `data:`, `file:`, `vbscript:` … |
| `ERR_NUL` | Metinde NUL baytı |
| `ERR_RANGE` | Aralık dışı sayı (punto, saydamlık, dönme…) |
| `ERR_ASSET_MISSING` | Var olmayan varlığa gönderme |

Hatalar **biriktirilir**; ilkinde durulmaz. Kullanıcı beş sorunu beş turda
değil tek seferde görsün.

---

## 3. Varlık sistemi

Varlıklar SHA-256 ile tekilleştirilir: aynı görsel on kez kullanılsa da bir
kez saklanır ve bir kez gömülür. Kimlik özetin ilk 16 karakterinden türer
(`ast_<hex16>`), yani **kimlik içeriğin kendisidir**.

Tür **uzantıdan değil bayttan** belirlenir. `resim.png` adlı bir
yürütülebilir dosya varlık olarak kabul edilmez.

Sınırlar: tek varlık boyutu, toplam boyut, varlık sayısı, piksel sayısı.

Sunucu, istemcinin bildirdiği varlık üst verisine **güvenmez**: baytları
alır, özeti kendisi hesaplar, sahnenin varlık listesini kendi hesabıyla
değiştirir. İstemci uydurma bir kimlik gönderirse gönderme yeniden bağlanır.

---

## 4. Geometri

`geometry.js` saf matematiktir: DOM yok, canvas yok, `getBoundingClientRect`
yok. Tarayıcıda ve Node'da aynı sonucu vermek zorundadır — kullanıcı ekranda
gördüğü yeri PDF'te de görmelidir.

- Matris işlemleri (PDF/SVG sırası: `[a b c d e f]`)
- `rotatedBounds` — dönmüş çerçevenin **eksene hizalı** sınır kutusu
- `absoluteFrame` — grup kaymaları ve ata dönmeleri toplanır; düğümün
  **kendi** dönmesi `x/y`'ye karışmaz, ayrı alanda döner
- `align` / `distribute` — yeni konumları **döndürür**, düğüme dokunmaz
- `snap` — kenar, merkez ve sayfa kılavuzlarına yapışma + kılavuz çizgileri.
  **Dönme hesaba katılır**: dönmüş bir nesnenin görünen kenarı çerçevesinin
  kenarı değildir ve kullanıcı gördüğü kenarın yapışmasını bekler

"Eşit aralıklı dağıtım" ile "eşit merkez mesafesi" farklıdır; farklı boyutlu
nesnelerde gözle doğru görünen birincisidir ve uygulanan odur.

`pageGeometry(doc, page)` bir sayfanın **etkin** ölçüsünü verir: sayfa kendi
ölçüsünü taşıyorsa o, taşımıyorsa belgenin geneli. `scene.page.width`'e
doğrudan bakan her kod, çok ölçülü belgelerde ilk sayfanın ölçüsünü bütün
sayfalara dayatır.

### PDF ↔ sahne: `pagespace.js`

İki uzay vardır ve karıştırılmamalıdır:

| | Başlangıç | y ekseni |
|---|---|---|
| PDF kullanıcı uzayı | sol **alt** | yukarı |
| Sahne uzayı | sol **üst** | aşağı |

Aradaki dönüşüm **tek bir yerde** tanımlıdır. Daha önce üç yerde ayrı ayrı
yapılıyordu: çizim toplayıcı sayfa matrisiyle (doğru), metin içe aktarıcısı
`pageHeight - y` ile (yanlış), imza yerleştirici üçüncü bir yolla.
`pageHeight - y` ne `/CropBox` kaymasını ne `/Rotate`ı görür — bu yüzden
yatay ve döndürülmüş sayfalarda metin, çizimlerden koparak sayfanın başka bir
köşesine düşüyordu.

**Kural: bir dosyada `pageHeight - y` görürseniz o bir hatadır.**

`pagespace` şunları verir:

- `effectiveGeometry(geo)` — `/MediaBox`, `/CropBox` (MediaBox ile kesiştirilir)
  ve `/Rotate`tan görünen sayfa kutusu; 90/270'te en-boy takas edilir
- `pageMatrix` / `inverseMatrix` — iki yönlü dönüşüm
- `toScene` / `toPdf` — nokta dönüşümü
- `sceneRectToPdf` / `pdfRectToScene` — kutu dönüşümü (imza yuvası, bağlantı,
  form alanı); dönmüş sayfada köşeler yer değiştirdiği için min/max alınır
- `placeTextRect` — metnin KENDİ eksenlerindeki kutuyu sahne düğümüne çevirir;
  satır/paragraf gruplaması okuma uzayında yapılır, dönme bir kez uygulanır
- `placeUnitSquare` — görsel XObject matrisinden yerleşim; eğrilme ve
  aynalanma **bildirilir**, sessizce dikleştirilmez

---

## 5. Geri alma: anlık görüntü değil, ters işlem

Her değişiklik, kendisini geri alan işlemle birlikte kaydedilir.

Belgenin tamamının anlık görüntüsünü almak da işe yarardı ama:

- bellek belge boyutuyla **çarpılır** (100 adım × 20 000 düğüm),
- bir nesneyi 3 punto kaydırmak bütün belgeyi kopyalatır,
- eşzamanlı düzenlemeye hiç yol bırakmaz.

**Bir sürükleme tek adımdır.** Fare saniyede 60 olay üretir; her biri ayrı
adım olsaydı kullanıcı Ctrl+Z'ye 60 kez basardı. Sürükleme `begin()` ile
açılır, hareketler aynı işleme yazılır, `commit()` ile kapanır. Ok tuşuyla
kaydırma gibi ardışık küçük işlemler `mergeKey` ile birleştirilir.

Boş işlem yığına yazılmaz; işlem içinde hata olursa yapılanlar geri sarılır.

---

## 6. Derleyiciler

### Scene → PDF

**Sahnedeki koordinat, PDF'teki koordinattır.** Araya akış yerleşimi girmez.

Sahneyi önce HTML'e çevirip yerleşim motorundan geçirmek kolay olurdu ama
o zaman kullanıcının tuvalde çizdiği yer ile PDF'teki yer, arada duran
motorun insafına kalırdı. Serbest yerleşimli bir editörün tek sözü
"gördüğün yere koyarım"dır.

PDF yazarı ve font gömme **yeniden yazılmadı**: `@fitfak/pdf-html`'in
`PdfEmitter`'ı ve `embedFont`'u olduğu gibi kullanılır. Üzerine sahnenin
kendi içerik akışı kurulur:

- sözcük sarma, yatay/dikey hizalama, karışık boyutlu koşularda ortak taban
- dönme (nesnenin kendi merkezi etrafında), saydamlık (`ExtGState`)
- yuvarlatılmış dikdörtgen, elips, kesikli/noktalı çizgi
- görsel oturtma (contain/cover/fill), karekod
- `/Link` açıklamaları

**İmza yuvası çizilmez, bildirilir.** Manifest her yuvayı hem PDF
(sol-alt) hem sahne (sol-üst) koordinatlarıyla taşır ve alan adı
`signatureSlots` — `@fitfak/pdf-html` manifestiyle aynı. İmzalama tarafı
belgenin sahneden mi HTML'den mi geldiğini bilmek zorunda değildir.

**Akan metin kutuları.** `autoHeight: true` olan metin düğümünde genişlik
kullanıcının, YÜKSEKLİK METNİNDİR: derleyici yerleşimden hesaplar, taşma
diye bir şey olmaz, dikey hizalama yok sayılır. İçe aktarılan paragraflar
bu bayrakla gelir; kullanıcı kutuyu dikey olarak elle boyutlandırırsa
bayrak düşer (iki otorite olamaz).

**Vektör yollar** `path` düğümünde taşınır. `d` düğümün KENDİ uzayındadır;
derleyici veriden sınır kutusunu hesaplar ve çerçeveye oturtur — böylece
düğümü büyütmek çizimi büyütür ve saklanan ikinci bir ölçek alanıyla
çerçevenin ayrışma ihtimali kalmaz. Tek eğri tipi kübiktir; PDF'in `v`/`y`
işleçleri içe aktarmada kübiğe çevrilir.

### Scene → HTML (önizleme)

**Bu çıktı gerçeğin kaynağı değildir.** PDF sahneden doğrudan üretilir;
HTML yalnız tarayıcıda göstermek içindir.

Hiçbir güvenilmez değer HTML'e **dizge birleştirilerek** girmez: önce bir
eleman ağacı kurulur, sonra tek bir serileştirici onu kaçışlayarak yazar.
Metnin içinde `<script>` varsa metin olarak görünür; başka türlüsü mümkün
değildir. Font ailesi süzülür ve tırnaklanır, CSS bildirimi kapatılamaz.

---

## 7. İçe aktarma

### HTML → Sahne

Yerleşim **yeniden hesaplanmaz**: `@fitfak/pdf-html`'e eklenen `layoutOnly`
seçeneğiyle mevcut motorun konumlandırılmış çıktı listesi alınır ve düğümlere
çevrilir. İkinci bir yerleşim yazmak, iki motorun ayrışması demekti.

Aynı satırdaki bitişik parçalar tek metin düğümünde toplanır; her çizim
parçasına ayrı düğüm vermek teknik olarak doğru ama kullanışsız olurdu.

### PDF → Sahne

Üç kaynak birleştirilir:

1. **Metin** — `@fitfak/pdf-doc`'un konumlandırılmış çıkarıcısı. Font
   verilirse taban çizgisi → kutu üstü dönüşümü **gerçek yükseltiyle**
   yapılır ve sahne → PDF → sahne turu birebir kapanır.
2. **Vektör çizimler** — içerik akışı yürütülür (`q/Q`, `cm`, renk
   işleçleri, `m/l/c/v/y/h/re` + `f/S/B` aileleri) ve her boyama bir `path`
   düğümüne çevrilir. Form XObject'lerin içine girilir (derinlik sınırlı,
   döngüye karşı korumalı).
3. **Görseller** — görsel XObject'leri varlığa çevrilir: JPEG baytları
   olduğu gibi alınır, Flate ile sıkıştırılmış örnekler PNG'ye kayıpsız
   yeniden kodlanır, `/SMask` alfa kanalına katılır.

Sayfa matrisi üç şeyi birlikte çözer: y ekseninin yönü, kırpma kutusu
kayması ve `/Rotate`. Böylece içe aktarılan sahne **kullanıcının gördüğü**
yerleşimdir, ham kullanıcı uzayı değil.

---

## 8. Editör

`apps/studio` içinde "Serbest tasarım" sekmesi.

**Tek model, iki ortam.** Editör ile sunucu aynı sahne modelini kullanır.
Tarayıcı için ayrı bir kopya yazmak, "tuvalde geçerli olanın sunucuda
reddedilmesi" sınıfından hataların kaynağı olurdu. Küçük bir paketleyici
(`packages/pdf-scene/browser.js`) aynı CommonJS kaynaklarını tek bir ES
modülüne toplar; eksik olan iki şey (`Buffer`, `crypto`) için ince bir
uyumluluk katmanı vardır. SHA-256 uygulamasının Node ile birebir aynı sonucu
verdiği testle sabitlenmiştir.

Paket `/vendor/scene.esm.js` adresinden **anında üretilir**; depoda tutulan
bir `dist` dosyası yoktur, dolayısıyla kaynakla ayrışamaz.

### Kısayollar

| Tuş | İşlem |
|---|---|
| `Ctrl+Z` / `Ctrl+Shift+Z` | Geri al / yinele |
| `Ctrl+C` / `X` / `V` | Kopyala / kes / yapıştır |
| `Ctrl+D` | Çoğalt |
| `Ctrl+G` / `Ctrl+Shift+G` | Grupla / çöz |
| `Ctrl+A` | Tümünü seç |
| Ok tuşları | 1 pt kaydır (`Shift` ile 10 pt) |
| `Shift` + sürükle | Eksene kilitle |
| `Shift` + tutamak | En-boy oranını koru |
| `Alt` + tık | Grubun içine gir |
| `Delete` | Sil |
| Dönme tutamağı (`Shift`) | 15°lik adımlarla döndür |
| `Ctrl`/`⌘` + tekerlek | İmlecin altındaki nokta sabit kalarak yakınlaştır |
| İki parmak | Yakınlaştır (dokunmatik) |

---

## 9. Erişilebilirlik ve arşiv uyumu (PDF/UA, PDF/A)

`compileToPdf(scene, { conformance: 'pdf/a-2b+pdf/ua' })` sahne yolunda da
etiketli, arşivlenebilir belge üretir. Yazılanlar: `pdfaid`/`pdfuaid` XMP
iddiası, sRGB çıktı amacı, `MarkInfo`, `StructTreeRoot` + `ParentTree`,
sayfa başına `StructParents` ve içerik akışında `BDC`/`EMC` işaretleri.

**Serbest yerleşimde okuma sırası kendiliğinden oluşmaz.** Akış belgesinde
"önce yazılan önce okunur"; sahnede kullanıcı nesneleri istediği sırayla
ekler ve en son eklediği başlık listenin sonunda durur. Çizim sırasını okuma
sırası saymak, ekran okuyucunun belgeyi tersten okuması demektir. Bu yüzden:

| Kaynak | Davranış |
| --- | --- |
| `page.readingOrder: ['h1','p1',…]` | Kullanıcının verdiği sıra kullanılır |
| Verilmediyse | Görsel sıra (satırlara böl → yukarıdan aşağı, satır içinde soldan sağa) hesaplanır ve `WARN_READING_ORDER_GUESSED` bildirilir |
| Sırada eksik düğüm | Sona eklenir, `WARN_READING_ORDER_INCOMPLETE` bildirilir |

Rol, düğümdeki `role` alanında taşınır. Ekran okuyucu **punto göremez**:
22 punto bir metnin başlık olduğunu ancak kullanıcı söyleyebilir. `auto`
tipe göre çözülür (`text` → `P`, `image`/`qr` → `Figure`, süs nesneleri →
`artifact`) ve tablo şemadaki `DEFAULT_ROLE`tur — editör de aynı tabloyu
okur.

Etiketli çıktıda **üçüncü seçenek yoktur**: her çizim ya bir yapı elemanına
aittir (`/P << /MCID n >> BDC`) ya da `/Artifact BMC` ile yapay işaretlenir.
`Figure` rolündeki bir düğümde alternatif metin yoksa `WARN_MISSING_ALT`
verilir (karekodda alternatif metin içerikten türetilir).

PDF/A-1 saydamlığı yasakladığı için o profil seçilirse `opacity` değerleri
1'e düzleştirilir ve `WARN_PDFA1_FLATTENED` bildirilir; PDF/A-2 ve
sonrasında saydamlık korunur.

---

## 10. Ortak düzenleme

**SUNUCU SIRALAR, HERKES O SIRAYI UYGULAR.**

Geri alma yığını kapanış (closure) tutar ve ağdan geçmez. Ortak düzenleme
için değişikliğin KENDİSİ veri olmalıdır: `src/ops.js` serileştirilebilir
işlemleri tanımlar (`addNode`, `removeNode`, `updateNode`, `reorder`,
`replacePage`, `addPage`, `removePage`, `movePage`, `setMeta`, `setPage`).

`scene.recordOps(fn)` kurulduğunda her değişiklik bir işleme çevrilip
`fn`e verilir. Gruplama gibi ağacı toptan kuran işler tek bir
`replacePage` olarak taşınır: "şunu ekle, şunu çıkar" dizisine bölmek,
aradaki her ara durumun geçerli olmasını gerektirirdi.

| Durum | Davranış |
| --- | --- |
| Silinmiş düğüme dokunma | **Reddedilir** (`ERR_OP_MISSING`, HTTP 409) — hayalet nesneyi geri getirmek, kullanıcının sildiğini geri almaktır |
| Var olan kimlikle ekleme | **Reddedilir** (`ERR_OP_DUPLICATE_ID`) |
| Aynı alana iki kişi | Son gelen kazanır; gönderene `overwritten` ile **bildirilir** |
| Farklı alanlara iki kişi | Çakışma sayılmaz (biri rengi, diğeri konumu değiştirebilir) |
| Grup içinde bir işlem başarısız | **Hepsi geri sarılır** — yarım uygulanmış grup, sunucuyla istemciyi ayrıştırır |
| Bağlantı koptu | İstemci `since` ile nerede kaldığını söyler, aradaki işlemler yetişir |

Uzaktan gelen işlem **geri alma yığınına girmez**: başkasının yazdığını
Ctrl+Z ile geri almak en şaşırtıcı davranıştır.

Taşıma SSE'dir (WebSocket değil): istemci → sunucu yolu zaten POST'tur,
tek yönlü bir akış yeterlidir ve düz `node:http` ile çalışır.

---

## 11. Sunucu uçları

| Uç | İş |
|---|---|
| `POST /api/scene/render` | Sahne → PDF + imza yuvası manifesti |
| `POST /api/scene/import/pdf` | PDF → sahne + varlık baytları + belge çözümlemesi |
| `POST /api/scene/import/html` | HTML → sahne + varlık baytları |
| `POST /api/collab/create` · `join` · `ops` · `leave` | Ortak oturum |
| `GET /api/collab/stream` | Olay akışı (SSE) |
| `GET /vendor/scene.esm.js` | Tarayıcı paketi (anında üretilir) |

Varlık baytları sahnenin **dışında**, ayrı bir dizide taşınır: on yerde
kullanılan bir görsel bir kez gider. **Her iki içe aktarma ucu da baytları
döndürür** — yalnız üst veri dönmek, tarayıcıdaki editörün görselin kimliğini
bilip içeriğini bilmemesi ve belge yeniden derlendiğinde görselin sessizce
kaybolması demektir.

`import/pdf` ayrıca bir **belge çözümlemesi** (`analysis`) döndürür: sayfa
ölçüleri, dönme, içe aktarılan nesne sayıları, form alanları, imza alanları,
açıklamalar, şifreleme ve iddia edilen PDF/A profili. Bu bir DENETİM değildir;
"iddia" ile "doğrulanmış" ayrı şeylerdir ve gerçek denetim
`@fitfak/conformance`'ındır.

Güvenlik: font **dosya yolu** kabul edilmez, yalnız sunucunun tanıdığı
aileler seçilebilir. Varlık kimlikleri içerikten hesaplanır. Bütün sahne
uçları mevcut gövde/sayım sınırlarına ve hız sınırına tabidir.

---

## 12. Bilinen sınırlar

Bunlar **kabul edilmiş** sınırlardır; "destekleniyor" diye sunulmamalıdır.

- **İçe aktarma bir düzleştirmedir.** Paragraflar kendi içinde yeniden akar
  (`autoHeight`) ama KUTULAR BİRBİRİNİ İTMEZ: bir paragraf uzayınca altındaki
  paragrafın üstüne biner. Akış belgesindeki "sonraki bloğu aşağı it"
  davranışı sahnede yoktur ve olmamalıdır — serbest yerleşimin tanımı budur.
  `WARN_IMPORT_FLATTENED` ile bildirilir.
- **Paragraf gruplama bir TAHMİNDİR.** Ardışık satırlar punto, biçim, satır
  aralığı ve sütun örtüşmesine bakılarak birleştirilir; kaynaktaki SABİT
  satır sonları korunmaz (`WARN_IMPORT_LINES_MERGED`). Adres bloğu gibi
  satır sonu anlamlı metinlerde satırlar tek paragrafa akar. Kural dar
  tutulmuştur: şüphede kalınırsa satır ayrı bırakılır.
- **PDF içe aktarmada gömülü fontlar aktarılmaz.** Metin, sahnenin
  yapılandırdığı aileyle yeniden çizilir; satır genişlikleri birebir aynı
  olmayabilir. Kırpma bölgeleri (`WARN_IMPORT_CLIP`), gradyanlar
  (`WARN_IMPORT_SHADING`), desen dolguları (`WARN_IMPORT_PATTERN`),
  aynalanmış görseller (`WARN_IMPORT_MIRRORED`) ve JPEG 2000/JBIG2/CCITT
  görseller (`WARN_IMPORT_IMAGE_FAILED`) aktarılmaz. İmzalı bir belgeyi içe
  aktarmak yeni bir belge üretir; eski imzalar taşınmaz
  (`WARN_SIGNATURES_DROPPED`). İmzalı belgeyi düzenlemek isteyen
  `@fitfak/pdf-doc`'un artımlı yolunu kullanmalıdır.
- **İçe aktarmada metin çizimlerin ÜSTÜNE konur.** Metin ayrı bir
  çıkarıcıdan geldiği için gerçek katman sırası korunamaz; belgelerin ezici
  çoğunluğunda doğru olan varsayım seçilmiştir.
- **İçe aktarmada düğüm bütçesi vardır** (varsayılan 4000/belge). Karmaşık
  bir grafik on binlerce yol içerebilir; sınıra kadar alınır ve kalanın
  alınmadığı `WARN_IMPORT_NODE_BUDGET` ile söylenir.
- **Sayfalar KENDİ ölçülerini taşıyabilir.** `page.width`/`page.height`
  verilirse o sayfa için geçerlidir; verilmezse belgenin `page` geometrisi
  kullanılır. Kenar boşluğu her zaman belgeden gelir. İçe aktarmada her
  sayfa kaynaktaki ölçüsünü korur ve belge ölçüsü ilk sayfanınkidir; karışık
  ölçü `WARN_PAGE_SIZE_MIXED` ile bildirilir.
- **Sahnede `/Rotate` alanı YOKTUR.** Sahne "görünen"i taşır. İçe aktarmada
  sayfa dönmesi gerçekten uygulanır (ölçü takas edilir, düğümler döner);
  `Scene.rotatePage()` de aynı şeyi yapar. Bunun bedeli: dışa aktarılan PDF
  `/Rotate 0` ile yazılır — görsel sonuç aynıdır, sözlük girdisi değil.
- **Metin kutuya sığmazsa kırpılmaz, uyarılır** (`WARN_TEXT_OVERFLOW`).
  Sahne PDF'inde taşan metin çizilir; kullanıcı kutuyu büyütmelidir.
- **PDF/UA'da okuma sırası TAHMİN edilir.** Serbest yerleşimde "önce yazılan
  önce okunur" kuralı yoktur. `page.readingOrder` verilmezse görsel sıra
  (yukarıdan aşağı, soldan sağa) varsayılır ve bu `WARN_READING_ORDER_GUESSED`
  ile bildirilir. Soldan sağa yazılmayan diller ve sütunlu düzenler için sıra
  kullanıcı tarafından verilmelidir.
- **Dokunmatikte tek parmak KAYDIRIR, sürüklemez.** `touch-action: pan-x
  pan-y` ile sayfayı gezmek tarayıcıya bırakılmıştır. İkinci parmak
  değdiğinde yarım kalan sürükleme geri sarılır ve yakınlaştırma başlar.
- **Eşzamanlı düzenleme CRDT DEĞİLDİR.** Sunucu sıralar, herkes o sırayı
  uygular. Aynı alanı iki kişi değiştirirse son gelen kazanır ve önceki
  sahibine "üzerine yazıldı" denir; otomatik birleştirme yoktur.
- **Ortak oturumda GERİ ALMA sayfayı toptan yazar.** Geri alma ters
  işlemleri doğrudan çalıştırır ve kendiliğinden işlem üretmez; ayrışmayı
  önlemek için değişen sayfa bütünüyle bildirilir. Aynı sayfada aynı anda
  çalışan birinin son değişikliği bu yazımla kaybolabilir.
- **Oturumlar yalnız BELLEKTEDİR.** Sunucu yeniden başlarsa oturum kaybolur;
  belge kaybolmaz — her istemcinin kendi kopyası vardır ve dışa
  aktarılabilir.
