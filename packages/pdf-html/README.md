# @fitfak/pdf-html

HTML + CSS → PDF derleyicisi. Sıfır harici bağımlılık.

## Çıktı iki parçadır

```js
const { pdf, manifest, warnings } = render({ html, css, fonts, page, metadata });
```

1. **`pdf`** — Buffer (diske uğramaz, doğrudan imzalanabilir)
2. **`manifest`** — sayfa ölçüleri, bağlantılar, anahat ve **imza yuvaları**

## Layout Manifest — projenin kilit fikri

HTML'de `data-signer` taşıyan her eleman, nihai koordinatlarıyla manifest'e yazılır:

```html
<div class="paper-sig-slot" data-signer="aybars" data-role="Düzenleyen"></div>
```

```jsonc
{ "signatureSlots": [
  { "id": "aybars", "role": "Düzenleyen", "page": 1,
    "rect": { "x": 51.02, "y": 673.83, "width": 155.91, "height": 71.36 },
    "origin": "bottom-left" }
] }
```

İmza motoru bunu doğrudan tüketir:

```js
const slot = manifest.signatureSlots.find(s => s.id === 'aybars');
const visible = fromManifestSlot(slot, { template: 'dual', font, vars });
await manager.sign({ pdfBuffer: pdf, visibleSignature: visible, ... });
```

Böylece `{ x: 170, y: 37, width: 115 }` gibi sihirli sayılar tamamen ortadan kalkar:
şablon değişince imza kendiliğinden doğru yere oturur.

## Desteklenen CSS

Bu liste bir **sözleşmedir**. `@fitfak/paper` yalnız buradakini kullanır.

| Alan | Kapsam |
|------|--------|
| Seçiciler | `tag` `.class` `#id` `*` `A B` `A > B` `A, B` `[attr]` `[attr="v"]` `[attr^=]` `[attr$=]` `[attr*=]` `:first-child` `:last-child` `:nth-child()` `:not()` |
| Kutu | `display: block\|inline\|inline-block\|flex\|table\|list-item\|none`, `width/height`, `min-height`, `margin`, `padding`, `border` (yön başına, style, radius), `box-sizing` |
| Konum | `position: static\|relative\|absolute`, `top/right/bottom/left` |
| Tipografi | `font-family` (yedek zinciriyle), `font-size`, `font-weight`, `font-style`, `line-height`, `letter-spacing`, `word-spacing`, `text-align` (`justify` dâhil), `text-transform` (Türkçe duyarlı), `text-decoration`, `white-space`, `color` |
| Flex | `flex-direction`, `justify-content`, `align-items`, `gap`, `flex-grow`, `flex-basis` |
| Tablo | tam kutu modeli, `<thead>` **sayfa başına tekrar**, sütun genişliği dağıtımı |
| Renk | `#rgb` `#rrggbb` `#rrggbbaa` `rgb()` `rgba()` `hsl()` `hsla()` isimli renkler |
| Birim | `pt px in cm mm q pc % em rem ch ex vw vh` |
| Değişken | `--x` + `var(--x, fallback)` — **kısayolların içinde de çalışır** |
| Sayfa | `@page { size, margin }`, `break-before/after`, `break-inside: avoid` |
| Liste | `ul` `ol`, `list-style-type` (disc, decimal, lower-alpha, upper-roman…) |
| Görsel | PNG (alfa dâhil) ve JPEG, satır içi ve blok bağlamda |
| Diğer | `@media print/screen`, `@font-face`, `<a href>` → `/Link`, `h1–h6` → bookmark |

### Desteklenmeyenler (baştan dürüst)

`float` · CSS animasyon/geçiş · `filter` · `clip-path` · `mix-blend-mode` ·
`grid` · JavaScript · ağdan font indirme · `position: sticky`

Eksik görsel/font sessizce yutulmaz; `warnings[]` dizisinde raporlanır.

## Örnek

```js
const paper = require('@fitfak/paper');
const { render } = require('@fitfak/pdf-html');

const { pdf, manifest } = render({
  html: fs.readFileSync('belge.html', 'utf8'),
  css: paper.stack('kurumsal'),
  fonts: [
    { family: 'Ubuntu', weight: 400, src: './assets/Ubuntu-Regular.ttf' },
    { family: 'Ubuntu', weight: 700, src: './assets/Ubuntu-Bold.ttf' }
  ],
  page: { size: 'A4', margin: '20mm 18mm' },
  metadata: { title: 'Belge', author: 'FITFAK', lang: 'tr-TR' }
});
```

## Uyumluluk profilleri (PDF/A, PDF/UA)

```js
const { pdf, conformance, warnings } = render({
  html, css, fonts,
  metadata: { title: 'Sözleşme', author: 'Aybars Yıldırım', lang: 'tr-TR' },
  conformance: 'pdf/a-2b+pdf/ua'
});

conformance;   // { pdfA: '2b', pdfUA: true, tagged: true }
```

Kabul edilen biçimler: `'pdf/a-1b'` · `'pdf/a-2b'` · `'pdf/a-3b'` · `'pdf/ua'` ·
`'pdf/a-2b+pdf/ua'` ya da `{ pdfA: '2b', pdfUA: true }`.

| Profil | Yazılan yapı |
|--------|--------------|
| **PDF/A** | XMP `pdfaid` iddiası (UTF-8, sıkıştırılmamış), gömülü sRGB ICC profili + `/OutputIntents`, trailer `/ID`, açıklamalarda `/F 4` |
| **PDF/UA** | `/StructTreeRoot` + `/ParentTree`, `/MarkInfo << /Marked true >>`, işaretli içerik (`/P << /MCID n >> BDC … EMC`), `/Lang`, `/DisplayDocTitle`, bağlantılarda `/Contents` + `/OBJR` |

### Etiketleme nasıl çalışır

Yerleşim motoru HTML'i zaten anlıyor: hangi kutu başlık, hangisi tablo hücresi.
Bu bilgi çizim sırasında kaybolmasın diye paralel bir **yapı ağacı** kurulur
(`src/layout/struct.js`) ve içerik akışındaki işaretli parçalara bağlanır
(`src/pdf/tagged.js`).

| HTML | PDF yapı türü |
|------|---------------|
| `h1`–`h6` | `H1`–`H6` |
| `p` · `div` · `span` | `P` · `Div` · `Span` |
| `ul` / `ol` → `li` | `L` → `LI` (`Lbl` + `LBody`) |
| `table` · `thead` · `tr` · `th` · `td` | `Table` · `THead` · `TR` · `TH` (`/Scope`) · `TD` |
| `img` | `Figure` — `alt` niteliği `/Alt` olur |
| `a` | `Link` + açıklamaya `/OBJR` bağı |
| arka plan, kenarlık, tekrarlanan tablo başlığı | `/Artifact` (ekran okuyucu atlar) |

`role="presentation"`, `role="none"` ve `aria-hidden="true"` süsleme sayılır;
`aria-label` alternatif metin olarak kullanılır.

**Etiketleme yalnız işaret ekler.** Çizim işlemleri ve yerleşim bire bir aynı
kalır — testler bunu ayrıca doğrular:

```js
assert.deepStrictEqual(tagged, plain);   // BDC/BMC/EMC hariç tüm operatörler
```

### Doğrulama

Motor, profili yazar; **yazdığını denetlemez**. Bağımsız denetim ayrı bir
pakettedir:

```bash
fitfak-belge check belge.pdf
```

Bkz. [`@fitfak/conformance`](../conformance/README.md).

PDF/UA için `metadata.title` **zorunludur**; verilmezse `warnings[]` içinde
uyarı çıkar (belge yine üretilir ama denetimi geçmez).
