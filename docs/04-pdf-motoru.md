# 04 — PDF Motoru: HTML/CSS Derleyicisi, `@fitfak/paper` ve Belge Düzenleme

---

## 1. `@fitfak/pdf-html` — HTML/CSS → PDF

### 1.1 Boru hattı

```
HTML metni + CSS
   │
   ▼ 1. TOKENIZE      HTML5 uyumlu tokenizer (void element, entity, comment, <style>)
   ▼ 2. TREE          DOM ağacı (implicit tag kapatma, öngörülebilir yapı)
   ▼ 3. CSSOM         @rule + selector + declaration ayrıştırma
   ▼ 4. CASCADE       özgüllük (specificity) + kaynak sırası + !important + kalıtım
   ▼ 5. COMPUTED      birimleri mutlaklaştır (px/pt/mm/cm/in/%/em/rem/vw/vh), var() çöz
   ▼ 6. BOX TREE      display'e göre kutu üret (block/inline/flex/grid/table/none)
   ▼ 7. LAYOUT        satır kutuları, kırılma noktaları, ölçüm (gerçek font metrikleriyle)
   ▼ 8. FRAGMENT      sayfalara böl (@page kuralları, break-* özellikleri)
   ▼ 9. PAINT         @fitfak/pdf çağrıları: content stream + kaynaklar
   ▼
PDF Buffer  +  Layout Manifest
```

### 1.2 Desteklenecek CSS Alt Kümesi

> **Felsefe:** CSS'in tamamını desteklemek bitmez bir iştir. Bunun yerine
> `@fitfak/paper`'ın kullandığı — ve ciddi belge tasarımı için gereken — alt kümeyi
> **kusursuz** destekleriz. Bu liste bir sözleşmedir: listede olan çalışır, olmayan
> derleme sırasında **uyarı verir** (sessizce yoksayılmaz).

#### Faz 1 (asgari ciddi belge)
| Alan | Kapsam |
|------|--------|
| Seçiciler | `tag`, `.class`, `#id`, `*`, `A B`, `A > B`, `A, B`, `[attr]`, `[attr="v"]`, `:first-child`, `:last-child`, `:nth-child(n)` |
| Kutu | `display: block\|inline\|inline-block\|none`, `width/height`, `min/max-*`, `margin`, `padding`, `border` (yön başına, `style`, `radius`), `box-sizing` |
| Konum | `position: static\|relative\|absolute`, `top/right/bottom/left`, `z-index` |
| Tipografi | `font-family` (fallback zinciriyle), `font-size`, `font-weight`, `font-style`, `line-height`, `letter-spacing`, `word-spacing`, `text-align` (`justify` dâhil), `text-transform`, `text-decoration`, `white-space`, `color`, `vertical-align` |
| Boyama | `background-color`, `opacity`, `border-color/style/width` |
| Renk | `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`, `hsl()`, `hsla()`, isimli renkler, `currentColor` |
| Birim | `px`, `pt`, `mm`, `cm`, `in`, `pc`, `%`, `em`, `rem`, `ch`, `vw`, `vh` |
| Değişken | `--x: …` + `var(--x, fallback)` |
| Sayfa | `@page { size, margin, marks }`, `page-break-before/after/inside`, `break-*` |
| Liste | `ul`, `ol`, `list-style-type` (disc, decimal, lower-alpha, upper-roman) |
| Görsel | `<img>` PNG/JPEG, `object-fit: contain\|cover\|fill`, `background-image: url()` |

#### Faz 2 (ciddi tasarım)
| Alan | Kapsam |
|------|--------|
| Flexbox | `flex-direction`, `justify-content`, `align-items`, `align-self`, `flex-wrap`, `gap`, `flex-grow/shrink/basis` |
| Grid | `grid-template-columns/rows` (`px`, `%`, `fr`, `repeat()`, `auto`), `gap`, `grid-column/row`, `span` |
| Tablo | `<table>` tam kutu modeli, `border-collapse`, **`<thead>` sayfa başına tekrar**, `colspan`/`rowspan`, sütun genişliği algoritması |
| Sayaç | `counter-reset/increment`, `counter(page)`, `counter(pages)`, `content:` |
| Koşan başlık | `position: running(header)` + `@page { @top-center { content: element(header) } }` |
| Dul/yetim | `widows`, `orphans` |
| Gradyan | `linear-gradient()` → PDF Type 2 shading |
| Gölge | `box-shadow` (yaklaşık), `text-shadow` (yok sayılır + uyarı) |
| Dönüşüm | `transform: rotate\|scale\|translate` → `cm` operatörü |
| Bağlantı | `<a href>` → `/Link` annot; `#anchor` → named destination |
| Anahat | `h1`–`h6` → PDF bookmark ağacı |

#### Faz 3 (dünya standardı)
| Alan | Kapsam |
|------|--------|
| PDF/A | PDF/A-2b ve PDF/A-3b: sRGB output intent, XMP metadata, tam font gömme, şeffaflık kuralları |
| PDF/UA | Etiketli PDF: `StructTreeRoot`, `/Alt` metni, okuma sırası, `/Lang` |
| Türkçe/BiDi | Doğru Türkçe büyük/küçük harf (`İ`/`ı`), tireleme, gerekirse Arapça/İbranice RTL |
| Font | `@font-face`, aile başına birden çok yüz, WOFF→TTF açma, OpenType `kern`/`liga` |
| SVG | Alt küme: `path`, `rect`, `circle`, `line`, `polygon`, `g`, `text`, `transform` |
| Form | `<input>`/`<select>` → AcroForm alanları (doldurulabilir PDF) |

#### Açıkça desteklenmeyecekler (baştan dürüst olalım)
`float` · CSS animasyon/geçiş · `filter` · `clip-path` · `mix-blend-mode` ·
`@container` · JavaScript · webfont ağdan indirme · `position: sticky`

Bunlar derleme sırasında **`UnsupportedCssWarning`** üretir; sessizce kaybolmazlar.

### 1.3 API

```js
const { render, renderToFile } = require('@fitfak/pdf-html');

const { pdf, manifest, warnings } = await render({
  html: '<article class="paper">…</article>',
  css:  [ paper.base(), paper.theme('kurumsal'), customCss ],
  fonts: [
    { family:'Ubuntu', weight:400, style:'normal', src:'./assets/Ubuntu-Regular.ttf' },
    { family:'Ubuntu', weight:700, style:'normal', src:'./assets/Ubuntu-Bold.ttf' }
  ],
  page: { size:'A4', orientation:'portrait', margin:'20mm 18mm' },
  metadata: { title:'…', author:'…', subject:'…', keywords:[…], lang:'tr-TR' },
  compliance: 'pdf/a-2b',        // | 'pdf/a-3b' | null
  baseDir: __dirname,            // göreli src'ler için
  strict: false                  // true → desteklenmeyen CSS hata verir
});
```

### 1.4 `@fitfak/pdf` Motorunda Yapılacak İyileştirmeler

| # | İş | Neden |
|---|-----|------|
| 1 | **Font subset'ini gerçekten kullan** | `index.js:171` ham TTF'i tamamen gömüyor; `Subsetter` sınıfı var ama bağlı değil. Dosya boyutu ~2× fazla. |
| 2 | `FlateDecode` ile gömme | `ASCIIHexDecode` boyutu iki katına çıkarıyor. |
| 3 | Font ailesi kaydı | `registerFontFamily(name, { 400:'…', 700:'…', italic:… })` |
| 4 | `hmtx`+`kern` gerçek metrikleri | Şu an `TextEngine` yalnız advance width kullanıyor. |
| 5 | Sayfa başına bağımsız `Resources` | Bugün tek paylaşılan sözlük; büyük belgelerde israf. |
| 6 | Grafik durumu (`ExtGState`) | `opacity`, blend modu için gerekli. |
| 7 | Shading (Type 2/3) | Gradyan için. |
| 8 | `/Link` ve `/Annots` yazımı | Bağlantılar ve dış açıklamalar. |
| 9 | Outline (bookmark) ağacı | Uzun belgelerde gezinme. |
| 10 | XMP metadata + output intent | PDF/A için zorunlu. |
| 11 | Etiketli PDF alt yapısı | PDF/UA için. |
| 12 | `Encryptor` bağlantısı | `security/Encryptor.js` yazılmış ama `Document`'a bağlı değil. |

---

## 2. `@fitfak/paper` — Baskıya Öncelikli CSS Tasarım Sistemi

> Kullanıcının isteği: *"sabit bir büyük ve ciddi tasarımlar yapılabilecek bir css paketi"*.

### 2.1 Yapı

```
packages/paper/
├── src/
│   ├── tokens.css        design token'lar (custom property)
│   ├── reset.css         baskı için sıfırlama
│   ├── page.css          @page ustaları: A4/A5/Letter, dikey/yatay, kenar boşlukları
│   ├── typography.css    tip ölçeği, başlıklar, gövde, dipnot, alıntı
│   ├── layout.css        grid/flex yardımcıları, sütun, ayırıcı
│   ├── components/
│   │   ├── letterhead.css    antet: logo + kurum + iletişim
│   │   ├── titleblock.css    başlık bloğu: belge adı, no, tarih, sayı
│   │   ├── metatable.css     künye tablosu (etiket/değer)
│   │   ├── table.css         veri tablosu, zebra, başlık tekrarı, hizalama
│   │   ├── callout.css       uyarı/not/dikkat kutuları
│   │   ├── signature.css     ★ imza yuvaları (layout manifest kaynağı)
│   │   ├── stamp.css         damga/QR yerleşimi
│   │   ├── footer.css        alt bilgi, sayfa numarası, belge no
│   │   └── watermark.css     filigran: TASLAK / KOPYA / GİZLİ
│   └── themes/
│       ├── kurumsal.css   lacivert + ince cetveller  (bugünkü index.js estetiği)
│       ├── resmi.css      siyah-beyaz, resmî yazışma düzeni
│       ├── akademik.css   serif, geniş kenar boşlukları, dipnot
│       ├── minimal.css    tipografi ağırlıklı, dekorasyonsuz
│       └── sertifika.css  yatay, çerçeveli, mühür alanlı
└── dist/paper.css         birleştirilmiş (tarayıcı ve motor aynı dosyayı okur)
```

### 2.2 Design Token'lar

```css
:root {
  /* Ölçü — A4 baz */
  --paper-width: 210mm;   --paper-height: 297mm;
  --paper-margin-x: 18mm; --paper-margin-y: 20mm;

  /* Tip ölçeği (1.25 majör üçlü) */
  --font-serif: 'Source Serif', Georgia, serif;
  --font-sans:  'Ubuntu', 'Inter', system-ui, sans-serif;
  --font-mono:  'JetBrains Mono', monospace;
  --fs-xs: 7.5pt;  --fs-sm: 8.5pt;  --fs-base: 10pt;
  --fs-md: 12pt;   --fs-lg: 15pt;   --fs-xl: 19pt;  --fs-2xl: 24pt;
  --lh-tight: 1.2; --lh-base: 1.45; --lh-loose: 1.7;

  /* Boşluk (4pt ızgara) */
  --sp-1: 4pt; --sp-2: 8pt; --sp-3: 12pt; --sp-4: 16pt;
  --sp-6: 24pt; --sp-8: 32pt; --sp-12: 48pt;

  /* Renk rolleri — temalar yalnız bunları ezer */
  --c-ink:      #14202b;   --c-ink-soft: #47535f;
  --c-accent:   #142d5f;   --c-accent-soft: #e8edf6;
  --c-rule:     #c8ced6;   --c-rule-soft: #e6e9ee;
  --c-paper:    #ffffff;   --c-paper-alt: #f7f8fa;
  --c-danger:   #9b1c1c;   --c-ok: #14603a;

  /* Cetveller */
  --rule-hair: 0.5pt; --rule-thin: 1pt; --rule-bold: 2.5pt; --rule-frame: 4pt;
}
```

### 2.3 İmza Yuvası — Motorla Sözleşme

```css
.paper-sig-slot {
  --sig-w: 55mm; --sig-h: 22mm;
  width: var(--sig-w); min-height: var(--sig-h);
  border-top: var(--rule-thin) solid var(--c-rule);
  padding-top: var(--sp-2);
  font-size: var(--fs-xs); color: var(--c-ink-soft);
  break-inside: avoid;
}
.paper-sig-slot[data-signer]::after { content: attr(data-role); display: block; }
```

Motor, `[data-signer]` taşıyan her elemanın nihai sayfa + dikdörtgenini
**layout manifest**'e yazar. İmza motoru bunu doğrudan tüketir:

```js
const slot = manifest.signatureSlots.find(s => s.id === 'aybars');
await sign(pdf, { signer, rect: slot.rect, page: slot.page });
```

Böylece `index.js:138`'deki `{ x:170, y:37, width:115 }` sihirli sayıları tarihe karışır.

### 2.4 Örnek Belge

```html
<link rel="stylesheet" href="@fitfak/paper/dist/paper.css">
<article class="paper paper--kurumsal" data-page-size="A4">

  <header class="paper-letterhead">
    <img class="paper-letterhead__logo" src="./assets/fitfak-logo.png" alt="FITFAK">
    <div class="paper-letterhead__org">
      <strong>FITFAK</strong>
      <span>Cumhuriyet Üniversitesi · Tıp Fakültesi</span>
    </div>
  </header>

  <div class="paper-titleblock">
    <h1>Resmî Bilgilendirme Belgesi</h1>
    <dl class="paper-metatable">
      <dt>Belge No</dt><dd data-doc-no>DOC-…</dd>
      <dt>Tarih</dt>   <dd>10.08.2026</dd>
      <dt>Sayı</dt>    <dd>2026/1478</dd>
    </dl>
  </div>

  <section class="paper-body">
    <p>Bu belge, PAdES altyapısıyla güvenli şekilde dijital olarak mühürlenmiştir.</p>
    <table class="paper-table"> … </table>
  </section>

  <div class="paper-signature-row">
    <div class="paper-sig-slot" data-signer="aybars" data-role="Düzenleyen"></div>
    <div class="paper-sig-slot" data-signer="ahmet"  data-role="Onaylayan"></div>
  </div>

  <footer class="paper-footer">
    <span class="paper-footer__doc">Belge No: <span data-doc-no></span></span>
    <span class="paper-footer__page">Sayfa <span data-page></span> / <span data-pages></span></span>
    <div class="paper-stamp-slot" data-stamp="qr"></div>
  </footer>
</article>
```

---

## 3. `@fitfak/pdf-doc` — PDF Okuma ve Düzenleme

### 3.1 Neden yeni bir paket

Bugünkü `pdf_parser.js` **imzalama için** yazılmış: string üzerinde regex, klasik xref,
belirli anahtarları yamalamak. Genel amaçlı bir belge modeli değil. Genel bir okuyucu
gerekiyor ve `pades` bunu tüketecek.

### 3.2 Okuyucu gereksinimleri

| Özellik | Bugün | Hedef |
|---------|:-----:|-------|
| Klasik `xref` tablosu | ✅ | ✅ |
| **Xref stream (`/Type /XRef`)** | ❌ | ✅ **kritik** |
| **Object stream (`/ObjStm`)** | ❌ | ✅ **kritik** |
| Lineerize PDF | 🟡 | ✅ |
| Bozuk xref → tam tarama kurtarma | 🟡 | ✅ |
| `FlateDecode` (+`/Predictor`) | 🟡 | ✅ |
| `LZWDecode`, `ASCII85`, `ASCIIHex`, `RunLength` | ❌ | ✅ |
| `DCTDecode`, `JPXDecode` | ❌ | geçirgen (yeniden kodlanmaz) |
| Standart güvenlik: RC4-40/128, AES-128/256 | ❌ | ✅ (açma) |
| Sayfa ağacı, `inherited` özellikler | 🟡 | ✅ |
| Content stream tokenizer | ❌ | ✅ (metin çıkarma + render için) |
| AcroForm okuma | 🟡 | ✅ |

### 3.3 Düzenleme işlemleri

```js
const doc = await PdfDocument.load(buffer, { password });

doc.pages.length;
doc.page(0).size;                              // { width, height, rotate }
doc.page(0).addImage(png, { x, y, width, height, rotate, opacity });
doc.page(0).addText('Onaylandı', { x, y, font, size, color });
doc.page(0).addLink({ rect, uri });
doc.page(0).rotate(90);
doc.insertPage(2, { size:'A4' });
doc.removePage(3);
doc.movePage(1, 4);
doc.merge(otherDoc);
doc.split([[0,2],[3,5]]);
doc.form.field('ad').setValue('Aybars');
doc.form.flatten();
doc.metadata.set({ title:'…', author:'…' });

// KRİTİK: incremental → önceki imzalar geçerli kalır
const out = await doc.save({ incremental: true });
```

### 3.4 Incremental Update Kuralı

```
[ orijinal bayt dizisi — HİÇ DEĞİŞTİRİLMEZ ]
[ yeni/güncellenmiş nesneler                ]
[ xref (/Prev → önceki startxref)           ]
[ trailer                                    ]
[ %%EOF                                      ]
```

`incremental: false` yalnızca **imzasız** belgelerde kullanılabilir; imzalı belgede
denenirse `PdfDocumentError('ERR_WOULD_BREAK_SIGNATURE')` fırlatılır.

### 3.5 Metin Çıkarımı

Content stream'deki `Tf`/`Td`/`TJ`/`Tj`/`TD`/`T*`/`Tm` operatörleri yorumlanır; font
`/ToUnicode` CMap'i ile karakterlere çevrilir. Kullanım yerleri: Studio'da arama,
doğrulamada "belge içeriği" özeti, erişilebilirlik denetimi.

---

## 4. `@fitfak/stamp` — Damga Motoru

`pades/src/signature/stamp.js`'ten ayrılır ve genelleştirilir.

### 4.1 API

```js
const { renderStamp, templates } = require('@fitfak/stamp');

const png = await renderStamp({
  template: templates.dual,          // classic | qr | dual | minimal | handwritten
  vars: {
    signerName: 'Aybars YILDIRIM',
    role: 'Düzenleyen',
    date: new Date(),
    docNo: 'DOC-M2K4J7-X9A3B1',
    verifyUrl: 'https://dogrula.fitfak.net/d/M2K4J7X9A3B1',
    logo: './assets/fitfak-logo.png',
    handwrittenSignature: userUploadedPngBuffer   // opsiyonel
  },
  output: { width: 1280, height: 320, dpi: 300 },
  font: './assets/Ubuntu-Regular.ttf'
});
```

### 4.2 Slot Tipleri

| Tip | Açıklama |
|-----|----------|
| `text` | TTF ile raster metin, hizalama, `upper-tr` dönüşümü, çok satır |
| `image` | PNG/JPEG blit, `object-fit`, renk çarpanı |
| `grain` | Mevcut PRNG doku efekti (aynen korunur) |
| `band` | Düz renk bandı |
| `rule` | Çizgi |
| **`code39`** | **Mevcut `CODE39_MAP` + `encodeCode39Data()` — DEĞİŞTİRİLMEZ.** Yeni: opsiyonel mod-43 check digit (varsayılan kapalı) |
| **`qr`** | **YENİ.** `@fitfak/qr`'ın `QR.build()` matrisi doğrudan RGBA tuvale çizilir (PNG round-trip yok) |
| `handwritten` | Kullanıcının yüklediği/çizdiği imza; otomatik kırpma + alfa temizliği |

### 4.3 Geriye Dönük Uyumluluk Testi

```
test/unit/stamp/backcompat.test.js
  → templates.classic çıktısı,
    eski generateStamp({finalW:1280, finalH:320, leftW:560, rightW:720}) ile
    piksel-piksel AYNI olmalı (grain PRNG tohumu sabitlenerek).
```

Bu test, "Code39 yapısını değiştirmek istemem" isteğinin **makine tarafından
zorlanan** karşılığıdır.

### 4.4 Barkod İçeriği Politikası

Bugün: `"FITFAK-" + Date.now().toString(36)` — belgeyle ilgisiz, her çağrıda farklı.

Yeni:

| Slot | İçerik | Gerekçe |
|------|--------|---------|
| Code39 | `docNo` (ör. `DOC-M2K4J7-X9A3B1`) | Code39 alfabesi sınırlı (A–Z 0–9 `-.$/+%` boşluk); URL taşıyamaz |
| QR | Doğrulama URL'i + belge özeti (ör. `https://dogrula.fitfak.net/d/<id>`) | Telefonla okutunca doğrulama sayfası açılır |

Belge numarası PDF üretiminde bir kez üretilir, hem gövdeye hem damgaya hem de PDF
metadata'sına yazılır — tek kaynak.

### 4.5 Performans

`windingContains` her piksel için tüm poligon kenarlarını tarıyor; 4× supersampling ile
1280×320 damga ≈ 6,5 milyon nokta-içinde-mi testi. **Scanline (active edge table)
rasterleştirmeye** geçilecek: kenarlar y'ye göre sıralanır, her tarama satırında kesişimler
bulunur, çift-tek/nonzero kuralıyla aralıklar doldurulur. Beklenen kazanım ~50×.
