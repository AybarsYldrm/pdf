# @fitfak/stamp

Slot tabanlı görsel imza damgası motoru.

## Değişmez kural: Code39'a dokunulmaz

`templates.classic`, eski `generateStamp()` çıktısıyla **bit-bit aynıdır**.
Bunu yeniden uygulayarak değil, **doğrudan eski kodu çağırarak** garanti ediyoruz —
tek satır bile ayrışamaz. Code39 tablosu (`CODE39_MAP`) ve kodlayıcısı
(`encodeCode39Data`) `@fitfak/pades/src/signature/stamp.js`'ten **içe aktarılır**,
kopyalanmaz. `test/unit/stamp.test.js` bunu her koşuda doğrular.

QR, Code39'un **yerine değil yanına** gelir: yeni bir slot tipidir.

## Şablonlar

| Şablon | Boyut | İçerik |
|--------|-------|--------|
| `classic` | 1280×320 | Doku + ad · logo bandı · **Code39** (eski çıktı, değişmedi) |
| `qr` | 1280×320 | Doku + ad · logo bandı · **QR** + belge no/tarih/rol |
| `dual` | 1280×320 | Doku + ad · logo bandı · **QR + Code39** yan yana |
| `minimal` | 900×260 | Yalnız ad, rol, tarih, belge no |
| `handwritten` | 1100×340 | Kullanıcının el yazısı imzası + küçük QR |
| `kurumsal` | 1400×300 | Antetli yatay resmî görünüm + QR |

## Kullanım

```js
const { renderStamp } = require('@fitfak/stamp');

const { png, rendered } = renderStamp({
  template: 'dual',
  font: './assets/Ubuntu-Regular.ttf',
  vars: {
    signerName: 'Aybars YILDIRIM',
    role: 'Düzenleyen',
    date: new Date(),
    docNo: 'DOC-M2K4J7-X9A3B1',
    verifyUrl: 'https://dogrula.fitfak.net/d/M2K4J7X9A3B1',
    logo: './assets/logo.png',
    handwritten: userDrawnPngBuffer   // opsiyonel
  },
  outPath: './stamp.png'
});
```

## Slot tipleri

| Tip | Ne yapar |
|-----|----------|
| `group` | Alt slotları `supersample` katı çizip küçültür (kenar yumuşatma) |
| `text` | TTF ile raster metin; `upper-tr` dönüşümü, çok satır, hizalama |
| `image` | PNG blit, `object-fit: contain` davranışı |
| `grain` | Kâğıt dokusu (eski PRNG ile birebir aynı) |
| `band` / `rule` | Düz renk alanı / çizgi |
| `code39` | **Değiştirilmez.** Opsiyonel mod-43 check digit (varsayılan **kapalı**) |
| `qr` | `@fitfak/qr` matrisi doğrudan tuvale — PNG turu yok, modüller tam hizada |
| `handwritten` | Kullanıcı imzası: otomatik kırpma, beyaz→şeffaf, mürekkep rengi |

## Barkod içeriği

Eskiden barkod `"FITFAK-" + Date.now()` idi — belgeyle ilgisiz ve her çağrıda farklı.
Artık belgeye bağlıdır:

- **Code39** → `{docNo}` (Code39 alfabesi sınırlı olduğu için URL taşıyamaz)
- **QR** → `{verifyUrl}` (telefonla okutulunca doğrulama sayfası açılır)
