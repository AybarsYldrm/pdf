# @fitfak/paper

Baskıya öncelikli CSS tasarım sistemi.

## Kilit fikir: tek CSS, iki hedef

```
        packages/paper/dist/paper.css
           ┌──────────┴──────────┐
           ▼                     ▼
   @fitfak/pdf-html         tarayıcı <iframe>
     (PDF çıktısı)          (canlı önizleme)
```

Aynı CSS iki tarafta çalıştığı için önizleme **gerçekten** WYSIWYG olur.
Yan etkisi de değerli: tasarım sistemi, PDF motorunun desteklediği CSS alt
kümesinin **sözleşmesi** hâline gelir — `paper.css` yalnız motorun bildiği
özellikleri kullanır. Böylece "CSS'in tamamını destekle" gibi bitmez bir hedef,
"tasarım sisteminin kullandığı CSS'i kusursuz destekle" gibi bitebilir bir
hedefe dönüşür.

## Kullanım

```js
const paper = require('@fitfak/paper');
render({ html, css: paper.stack('kurumsal'), ... });
```

Tarayıcıda: `<link rel="stylesheet" href="@fitfak/paper/dist/paper.css">`

## Temalar

| Tema | Karakter |
|------|----------|
| `kurumsal` | Lacivert, ince cetveller, kurumsal ciddiyet |
| `resmi` | Siyah-beyaz, serif, resmî yazışma düzeni |
| `akademik` | Serif, geniş kenar boşlukları, iki yana yaslı |
| `minimal` | Tipografi ağırlıklı, dekorasyonsuz |
| `sertifika` | Yatay, altın çerçeveli, mühür alanlı |

## Bileşenler

`paper-letterhead` · `paper-titleblock` · `paper-metatable` · `paper-table`
(zebra/bordered/compact) · `paper-callout` (info/ok/warn/danger) ·
**`paper-sig-slot`** · `paper-stamp-slot` · `paper-footer` · `paper-watermark` ·
`paper-verify` · `paper-row`/`paper-col` ızgarası

## İmza yuvası — motorla sözleşme

```html
<div class="paper-signature-row">
  <div class="paper-sig-slot" data-signer="aybars" data-role="Düzenleyen">
    <span class="paper-sig-slot__role">Düzenleyen</span>
    <span class="paper-sig-slot__name">Aybars YILDIRIM</span>
  </div>
</div>
```

`data-signer` taşıyan eleman, PDF motoru tarafından **layout manifest**'e yazılır.
İmza koordinatları kodda değil, tasarımda tanımlanmış olur.

## Belirteçler (tokens)

Temalar YALNIZCA CSS değişkenlerini ezer; bileşenlerde ham renk/ölçü yoktur.
Tam liste: `src/tokens.css`.
