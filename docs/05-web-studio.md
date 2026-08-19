# 05 — Web Studio: Vanilla JS Arayüz

> Kullanıcı isteği: *"bir web sitesi gibi olmasını istiyorum vanilla js ile … PDF
> görüntülenmesi ve içe aktarılan imza ile imzayı ilgili seçili bölgeye dahil edilmesi ve
> yüklenen sistemde bulunan pfx dosyası ile imzalanması … pdf imzalanmışsa bunu imza
> paneli gibi görmek."*

**Kısıt:** Framework yok, bundler yok, derleme adımı yok. Doğrudan ESM + tarayıcının
kendi API'leri.

---

## 1. Ekranlar

```
┌─────────────────────────────────────────────────────────────────────┐
│  FITFAK Belge Studio        [Tasarla] [Düzenle] [İmzala] [Doğrula]  │
├───────────────┬─────────────────────────────────┬───────────────────┤
│               │                                 │                   │
│  SOL PANEL    │        TUVAL / ÖNİZLEME         │   SAĞ PANEL       │
│               │                                 │                   │
│  · Sayfalar   │   ┌───────────────────────┐     │  · Özellikler     │
│    (küçük     │   │                       │     │  · İmza paneli    │
│     resim)    │   │      PDF sayfası      │     │  · Sertifika      │
│  · Katmanlar  │   │                       │     │    detayları      │
│  · Şablonlar  │   │   [imza kutusu ▭]     │     │  · LTV durumu     │
│  · Temalar    │   │                       │     │  · Revizyonlar    │
│               │   └───────────────────────┘     │                   │
│               │      ◀  1 / 3  ▶   [− 100% +]   │                   │
├───────────────┴─────────────────────────────────┴───────────────────┤
│  Durum çubuğu: hazır · 3 sayfa · 2 imza · LTV etkin                 │
└─────────────────────────────────────────────────────────────────────┘
```

| Sekme | İşlev |
|-------|-------|
| **Tasarla** | `@fitfak/paper` şablonundan belge oluştur; canlı HTML önizleme; alanları doldur; PDF üret |
| **Düzenle** | PDF yükle; sayfa döndür/sil/sırala; görsel ekle-konumlandır; metin ekle; form doldur |
| **İmzala** | İmza kutusunu yerleştir; imza görselini seç/çiz/yükle; PFX + parola; seviye (B/T/LT/LTA); imzala |
| **Doğrula** | İmzalı PDF yükle; imza paneli; ETSI raporu; revizyon zaman çizelgesi |

---

## 2. PDF Görüntüleyici

### 2.1 Uygulanan strateji: üç yollu

| Kaynak | Yol | Neden |
|--------|-----|-------|
| **Bizim ürettiğimiz belgeler (tasarım aşaması)** | HTML'i sandbox'lı `<iframe>` içinde `@fitfak/paper` CSS'iyle göster | Gerçek WYSIWYG, anında; rasterleştirmeye gerek yok |
| **Yüklenen / üretilmiş PDF'ler** | `blob:` URL'li ayrı bir `<iframe>` — tarayıcının **yerleşik** PDF görüntüleyicisi | Sıfır kod, sıfır bağımlılık, tam doğruluk; arama ve yazdırma bedava gelir |
| **Konum seçimi** | Sayfanın gerçek en/boy oranıyla çizilen şema üzerinde dikdörtgen sürükleme | Yerleşik görüntüleyicinin içine güvenilir biçimde bindirme yapılamaz |

**Neden kendi canvas renderer'ımızı yazmadık.** İlk plan, `stamp.js`'in TTF
kontur çıkarıcısını `Path2D`'ye bağlayarak kendi rasterleştiricimizi yazmaktı.
Uygulama sırasında bunun **yanlış maliyet** olduğu görüldü: her tarayıcıda
zaten üretim kalitesinde bir PDF görüntüleyici var, ve ondan alacağımız şey
(doğru çizim, seçilebilir metin, yazdırma, erişilebilirlik) bizim aylarca
yazacağımızdan iyi. Kendi renderer'ımız yalnızca *bindirme* (overlay)
yeteneği kazandıracaktı — onu da sayfa şeması ile çok daha ucuza aldık.

Bu, kapsamın bilinçli daraltılmasıdır: PDF **okuma ve düzenleme** işi
`@fitfak/pdf-doc`'ta, tam doğrulukla ve sunucu tarafında yapılır; tarayıcı
yalnız gösterir.

### 2.2 Sandbox değişmezliği

HTML önizlemesi ve PDF önizlemesi **ayrı çerçevelerdir**:

```html
<iframe id="preview"    sandbox="allow-same-origin"></iframe>  <!-- kullanıcı HTML'i -->
<iframe id="pdfPreview"></iframe>                              <!-- blob: PDF -->
```

Yerleşik PDF görüntüleyicisi `sandbox` altında çalışmaz. Tek bir çerçeve
paylaşılsaydı, PDF gösterirken `sandbox` niteliğini kaldırmak ve HTML'e
dönerken geri koymak gerekirdi — çağrı sırası bozulduğunda kullanıcı HTML'i
script çalıştırabilirdi. Ayrı çerçeveyle bu risk **yapısal olarak** yok:
`#preview` üzerindeki `sandbox` hiçbir kod yolunda kaldırılmaz.

Sunucu CSP'si buna göre `frame-src 'self' blob:` verir; `object-src 'none'`
korunur.

### 2.3 Konum seçici (`placer`)

Şema, seçilen sayfanın gerçek `width × height` oranıyla çizilir ve ölçek
`data-scale` içinde saklanır. Sürükleme bittiğinde tarayıcı koordinatları PDF
kullanıcı uzayına çevrilir — **orijin sol-üstten sol-alta taşınır**:

```js
selection = {
  x: left / scale,
  y: (pageHeight - top / scale - height / scale),   // Y ekseni ters çevrilir
  width: width / scale,
  height: height / scale
};
```

Bu çeviri arayüzde **tek bir yerde** yapılır (`edit/document.js`); sunucu
yalnız PDF koordinatı görür.

---

## 3. İmza Yerleştirme

### 3.1 Etkileşim

1. Kullanıcı **İmzala** sekmesinde "İmza alanı ekle"ye basar.
2. Sayfa üzerinde sürükleyerek dikdörtgen çizer (veya manifest'ten hazır yuvayı tıklar).
3. Dikdörtgen; tutamaçlarla yeniden boyutlandırılır, sürüklenir, ok tuşlarıyla ince ayar
   yapılır, kılavuz çizgilerine ve diğer imzalara **snap** eder.
4. Ekran koordinatı → PDF kullanıcı uzayına çevrilir (zoom, `/Rotate`, `/MediaBox` ofseti
   hesaba katılır — bu dönüşüm tek bir yerde, `coords.js`'te toplanır ve birim testi vardır).

```js
// coords.js — tek doğruluk kaynağı
screenToPdf({ x, y }, { page, zoom, rotate, mediaBox, cropBox }) → { x, y }
pdfToScreen({ x, y }, { … }) → { x, y }
```

### 3.2 İmza Görseli Kaynakları

| Kaynak | Nasıl |
|--------|-------|
| **Otomatik damga** | `@fitfak/stamp` şablonu; ad/rol/tarih/QR canlı önizlemeyle |
| **Dosyadan** | PNG/JPEG sürükle-bırak; otomatik kırpma, beyaz→şeffaf, kontrast |
| **Çizerek** | `<canvas>` üzerinde fare/dokunmatik ile imza atma; basınç yoksa hız-tabanlı kalınlık; PNG'e dışa aktarım |
| **Kayıtlı** | `IndexedDB`'de saklanan kişisel imza görselleri |

Üçü de aynı yola çıkar: RGBA PNG buffer → `@fitfak/stamp` `handwritten` slotu veya
doğrudan görünür imza görseli.

---

## 4. PFX ile İmzalama

### 4.1 Varsayılan: anahtar tarayıcıdan çıkmaz

```
1. <input type="file" accept=".pfx,.p12">  → ArrayBuffer
2. Parola istemi (autocomplete="off", bellek dışına yazılmaz)
3. @fitfak/pkcs12 (ESM) ile parse
     · MAC doğrula → parola yanlışsa net hata
     · kimlikleri listele (friendlyName) → birden fazlaysa kullanıcı seçer
4. crypto.subtle.importKey('pkcs8', …, { extractable: false })   ← dışa aktarılamaz
5. POST /api/sign/prepare  { certPem, chainPems, rect, page, level, stamp }
6. ← { sessionId, digest }
7. crypto.subtle.sign(alg, privateKey, digest)
8. POST /api/sign/finalize { sessionId, signature }
9. ← imzalı PDF
10. Parola ve anahtar materyali bellekte sıfırlanır
```

Arayüzde kalıcı rozet: **🔒 Özel anahtarınız tarayıcınızdan çıkmadı.**

### 4.2 Alternatif: sunucu tarafı (opt-in)

Ayarlarda açıkça işaretlenir; arayüz uyarı gösterir:
*"PFX dosyanız sunucuya gönderilecek. Yalnız bellekte tutulur, işlem sonunda silinir."*

Küçük ekipler/iç ağ için pratik; varsayılan değil.

### 4.3 Seviye Seçimi

```
İmza seviyesi
  ( ) B-B    Temel — zaman damgası yok
  ( ) B-T    Zaman damgalı                          [TSA: timestamp.digicert.com ▾]
  (•) B-LT   Uzun vadeli (OCSP/CRL gömülü)          ← varsayılan
  ( ) B-LTA  Arşiv (belge zaman damgası)            [önerilen: uzun saklama]

☑ Görünür imza    ☑ Belgeyi sertifikala (yalnız ilk imza)
☐ İmza politikası (EPES)   [OID …]
```

Seçilen seviyeye ulaşılamazsa (TSA/OCSP erişilemedi) işlem **sessizce düşmez**;
"B-LT istendi, B-T elde edildi — sebep: OCSP zaman aşımı" diye açıkça raporlanır.

---

## 5. İmza Paneli (Adobe benzeri)

```
┌─ İmzalar ───────────────────────────────────────┐
│                                                  │
│ ✅ Aybars YILDIRIM                    B-LTA      │
│    İmza geçerli.                                 │
│    ├ Belge bu imzadan sonra değiştirilmedi       │
│    ├ Kimlik geçerli · zincir köke ulaştı         │
│    ├ İmza zamanı: 10.08.2026 14:23:07 (TSA)      │
│    ├ 🔒 LTV etkin — çevrimdışı doğrulanabilir     │
│    ├ İptal: OCSP · good · 10.08.2026 14:23:09    │
│    └ ▸ Sertifika detayları                       │
│                                                  │
│ ⚠️  Ahmet YILMAZ                       B-T        │
│    İmza geçerli, ancak uzun vadeli veri yok.     │
│    └ İptal bilgisi gömülü değil (LTV kapalı)     │
│    [ LTV ekle ]  ← belgeyi B-LT'ye yükseltir     │
│                                                  │
│ 🕐 Belge Zaman Damgası                            │
│    12.08.2026 03:00:00 · tsa.fitfak.net          │
│                                                  │
├─ Revizyon geçmişi ──────────────────────────────┤
│  R1  oluşturuldu           10.08 14:22   142 KB │
│  R2  imza: Aybars          10.08 14:23   318 KB │
│  R3  DSS (LTV)             10.08 14:23   341 KB │
│  R4  imza: Ahmet           10.08 14:25   498 KB │
│      [ R2 ↔ R4 farkını göster ]                  │
└──────────────────────────────────────────────────┘
```

Veri kaynağı: `@fitfak/verify`'ın JSON raporu. Panel yalnızca render eder; hiçbir
doğrulama mantığı arayüzde bulunmaz.

**"LTV ekle" düğmesi:** Mevcut B-T imzalı bir belgeyi, imzaya dokunmadan
(yeni incremental revizyon ile) B-LT/B-LTA seviyesine yükseltir. Bu, arşiv yönetimi
için çok kıymetli bir yetenek ve motorumuzda zaten mümkün.

---

## 6. Sunucu API'si (`apps/server/`)

Saf `node:http`. Uygulama kodu ile sunucu kodu ayrı; iş mantığı paketlerde.

| Yöntem | Yol | Girdi | Çıktı |
|--------|-----|-------|-------|
| `POST` | `/api/render` | `{ html, css, page, fonts, metadata }` | `{ pdf(b64), manifest, warnings }` |
| `POST` | `/api/inspect` | pdf | `{ byteLength, signatures }` |
| `POST` | `/api/pdf/open` | `{ pdf, password? }` | `{ pageCount, pages[], info, fields, signatures, encrypted, hasForm }` |
| `POST` | `/api/pdf/edit` | `{ pdf, password?, ops[] }` | `{ pdf, pageCount, applied[], preservedOriginal }` (artımlı) |
| `POST` | `/api/stamp/preview` | `{ template, vars }` | png |
| `POST` | `/api/sign/prepare` | `{ pdf, certPem, chainPems, rect, level, stamp }` | `{ sessionId, digest, alg }` |
| `POST` | `/api/sign/finalize` | `{ sessionId, signature }` | `{ pdf, report }` |
| `POST` | `/api/sign/pfx` | `{ pdf, pfx, password, … }` | `{ pdf, report }` *(opt-in)* |
| `POST` | `/api/ltv/extend` | `{ pdf, targetLevel }` | `{ pdf, report }` |
| `POST` | `/api/verify` | pdf | `VerifyReport` |
| `GET`  | `/api/health` | — | `{ ok, version, tsa: {…} }` |

### 6.1 `/api/pdf/edit` işlem listesi

Tek istekte birden çok işlem sırayla uygulanır; hepsi **tek bir artımlı
revizyona** yazılır. Koordinatlar PDF kullanıcı uzayındadır (orijin sol-**alt**,
birim punto); tarayıcı sol-üst kullandığı için çeviri istemcide yapılır.

| `op` | Alanlar |
|------|---------|
| `rotate` | `page`, `degrees` (90'ın katı, birikimli) |
| `removePage` / `movePage` / `reorder` / `insertPage` | `page` · `from`,`to` · `order[]` · `index`,`size` |
| `image` | `page`, `image` (b64 PNG/JPEG), `x`, `y`, `width`, `height?`, `rotate?`, `opacity?` |
| `text` | `page`, `text`, `x`, `y`, `size?`, `color?`, `font?` |
| `link` | `page`, `x`, `y`, `width`, `height`, `uri` |
| `content` | `page`, `commands` (ham içerik akışı — `q … Q` ile sarmalanır) |
| `metadata` | `values` (`title`, `author`, `subject`, `keywords`, `creator`, `producer`) |
| `fillForm` | `values`, `flatten?`, `strict?` |
| `flattenForm` | `only?` |

Hata kodları: `ERR_OP_UNKNOWN`, `ERR_OP_ARG`, `ERR_OPS_MISSING`,
`ERR_PDF_OPEN`, `ERR_CRYPT_BAD_PASSWORD`.

**İmza güvencesi:** düzenleme her zaman artımlıdır, orijinal baytlara
dokunulmaz. Belgede imza varsa geçerli kalır; doğrulama raporu değişikliği
`modifiedAfterSigning: true` ile açıkça bildirir. `rewrite: true` ile tam
yeniden yazım istenirse imzalı belgede `ERR_WOULD_BREAK_SIGNATURE` döner.

**Sözleşme kuralları**
- Gövde `application/json` (base64 PDF) veya `application/octet-stream`.
- Hatalar: `{ error: { code, message, details? } }` + doğru HTTP kodu.
- Boyut sınırı 32 MB; istek zaman aşımı 60 sn; IP başına hız sınırı.
- `sessionId` yalnız bellekte, 120 sn TTL, tek kullanımlık.
- Diske hiçbir şey yazılmaz (`--tmp` ile açıkça istenmedikçe).
- Güvenlik başlıkları: CSP, `X-Content-Type-Options`, `Referrer-Policy`,
  `Permissions-Policy`.

---

## 7. Studio Dosya Düzeni

```
apps/studio/
├── index.html
├── css/
│   ├── app.css              arayüz kabuğu (paper.css'ten bağımsız)
│   └── paper.css            → packages/paper/dist/paper.css (symlink/kopya)
├── js/
│   ├── main.js              önyükleme, yönlendirme
│   ├── state.js             küçük gözlemlenebilir durum deposu (~80 satır)
│   ├── ui/                  panel, sekme, iletişim kutusu, bildirim bileşenleri
│   ├── edit/                sayfa işlemleri, görsel/metin yerleştirme, form doldurma
│   ├── signing/             pkcs12 (ESM), webcrypto imzalayıcı, iki fazlı akış
│   ├── verify/              rapor render'ı
│   └── lib/                 coords.js, bytes.js, dom.js
└── assets/
```

**Kural:** `innerHTML` yok. Tüm DOM `dom.js`'teki küçük yardımcılarla
(`el('div', {class}, children)`) kurulur. Kullanıcı içeriği yalnızca `textContent`.
Bu, XSS yüzeyini fiilen sıfırlar.

---

## 8. Erişilebilirlik ve Yerelleştirme

- Klavye: tüm akış klavyeyle tamamlanabilir; imza kutusu ok tuşlarıyla taşınır/boyutlanır.
- Odak yönetimi ve `aria-live` bildirimleri (imza sonucu, hata).
- Renk körlüğü: durum yalnız renkle değil, simge + metinle de anlatılır.
- Dil: `tr` varsayılan, `en` ikinci. Metinler `i18n/*.json`; kodda gömülü string yok.
- Koyu tema: `prefers-color-scheme` + açık geçiş düğmesi. Belge önizlemesi **her zaman
  beyaz kâğıt** kalır (baskı gerçekliği).
