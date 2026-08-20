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
`rotation`, `opacity`, `locked`, `hidden`.

| Tip | Tipe özgü alanlar |
|---|---|
| `text` | `text`, `runs[]`, `fontFamily`, `fontSize`, `lineHeight`, `color`, `align`, `valign`, `bold`, `italic`, `letterSpacing`, `padding` |
| `rect` | `fill`, `stroke`, `strokeWidth`, `radius` |
| `ellipse` | `fill`, `stroke`, `strokeWidth` |
| `line` | `stroke`, `strokeWidth`, `dash` — çerçevenin köşegeni üzerinde tanımlıdır |
| `image` | `assetId`, `fit` (contain/cover/fill), `alt` |
| `qr` | `payload`, `ecc`, `quiet`, `dark`, `light` |
| `signature` | `fieldName`, `signer`, `role`, `label`, `showFrame` |
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
- `snap` — kenar, merkez ve sayfa kılavuzlarına yapışma + kılavuz çizgileri

"Eşit aralıklı dağıtım" ile "eşit merkez mesafesi" farklıdır; farklı boyutlu
nesnelerde gözle doğru görünen birincisidir ve uygulanan odur.

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

`@fitfak/pdf-doc`'un konumlandırılmış metin çıkarıcısı kullanılır. Font
verilirse taban çizgisi → kutu üstü dönüşümü **gerçek yükseltiyle** yapılır
ve sahne → PDF → sahne turu birebir kapanır.

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

---

## 9. Sunucu uçları

| Uç | İş |
|---|---|
| `POST /api/scene/render` | Sahne → PDF + imza yuvası manifesti |
| `POST /api/scene/import/pdf` | PDF → sahne |
| `POST /api/scene/import/html` | HTML → sahne |
| `GET /vendor/scene.esm.js` | Tarayıcı paketi (anında üretilir) |

Varlık baytları sahnenin **dışında**, ayrı bir dizide taşınır: on yerde
kullanılan bir görsel bir kez gider.

Güvenlik: font **dosya yolu** kabul edilmez, yalnız sunucunun tanıdığı
aileler seçilebilir. Varlık kimlikleri içerikten hesaplanır. Bütün sahne
uçları mevcut gövde/sayım sınırlarına ve hız sınırına tabidir.

---

## 10. Bilinen sınırlar

Bunlar **kabul edilmiş** sınırlardır; "destekleniyor" diye sunulmamalıdır.

- **İçe aktarma bir düzleştirmedir.** Akış belgesindeki "paragraf" kavramı
  sahnede yoktur. İçe aktarılan belge düzenlenebilir ama artık akmaz: metin
  uzayınca sonraki kutuyu itmez. Uyarı olarak bildirilir
  (`WARN_IMPORT_FLATTENED`).
- **PDF içe aktarma yalnız metindir.** Vektör çizimler, görseller ve gömülü
  fontlar aktarılmaz (`WARN_IMPORT_TEXT_ONLY`). İmzalı bir belgeyi içe
  aktarmak yeni bir belge üretir; eski imzalar taşınmaz
  (`WARN_SIGNATURES_DROPPED`). İmzalı belgeyi düzenlemek isteyen
  `@fitfak/pdf-doc`'un artımlı yolunu kullanmalıdır.
- **Sahne tek sayfa boyutu taşır.** Kaynak belgede sayfalar farklı
  boyutluysa ilk sayfanınki kullanılır (`WARN_PAGE_SIZE_MISMATCH`).
- **Metin kutuya sığmazsa kırpılmaz, uyarılır** (`WARN_TEXT_OVERFLOW`).
  Sahne PDF'inde taşan metin çizilir; kullanıcı kutuyu büyütmelidir.
- **Sahne yolunda PDF/A ve PDF/UA profilleri yoktur.** Etiketli yapı ağacı,
  çıktı amacı ve `pdfaid`/`pdfuaid` XMP'si yalnız HTML yolunda üretilir.
  Sahne PDF'i geçerli bir PDF 1.7 belgesidir ama arşiv/erişilebilirlik
  uyumu iddia etmez.
- **Font seçimi sunucunun kayıtlı aileleriyle sınırlıdır.** Şu an yalnız
  Ubuntu kayıtlıdır; `fontFamily` alanı şemada serbesttir ama derleyici
  bulamadığı aileyi kayıtlı ilk aileye düşürür.
- **Döndürülmüş nesnelerde yapışma, dönmemiş çerçeveye göre hesaplanır.**
  Küçük açılarda fark edilmez, büyük açılarda kılavuz ile görünen kenar
  ayrışır.
- **Editör dokunmatik/kalem girdisi için ayarlanmamıştır.** Pointer olayları
  kullanılır ama tutamak boyutları fare için seçilmiştir.
- **Eşzamanlı düzenleme yoktur.** Geri alma yığını ters işlem tabanlı olduğu
  için ileride eklenebilir; şu an tek kullanıcılıdır.
