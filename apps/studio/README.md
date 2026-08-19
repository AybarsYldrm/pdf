# FITFAK Belge Studio

Vanilla JS arayüz. **Framework yok, bundler yok, derleme adımı yok** — doğrudan ESM.

```
apps/studio/
├── index.html
├── css/app.css          arayüz kabuğu (belge stilinden bağımsız)
├── js/
│   ├── main.js          uygulama girişi, durum, olaylar
│   ├── lib/dom.js       el()/append()/clear() — innerHTML KULLANILMAZ
│   ├── lib/api.js       sunucu istemcisi + base64 dönüşümleri
│   ├── signing/pkcs12.js  tarayıcı içi PFX açma + WebCrypto imzalama
│   └── verify/panel.js  imza panelinin render'ı (doğrulama mantığı YOK)
└── favicon.png
```

## Üç sekme

**Tasarla** — HTML düzenle, canlı önizleme, PDF üret.
Önizleme `@fitfak/paper`'ın **derlenmiş CSS'ini** (`/vendor/paper.css`) kullanır;
PDF motoru da aynı dosyayı okur, bu yüzden gerçekten WYSIWYG'dir.
İmza yuvaları önizlemede kesikli çerçeveyle işaretlenir.

**İmzala** — PFX aç, kimlik seç, imza yuvası seç, damga şablonu seç, seviye seç, imzala.

**Doğrula** — İmzalı PDF yükle, imza panelinde ETSI raporunu gör, gerekirse LTV ekle.

## Anahtar tarayıcıdan çıkmaz

Varsayılan akış:

1. PFX **tarayıcıda** açılır (`js/signing/pkcs12.js`, WebCrypto ile PBES2 çözme)
2. Anahtar `importKey(..., extractable: false)` ile alınır — bir daha okunamaz
3. `POST /api/sign/prepare` → sunucu yalnız **imzalanacak veriyi** döndürür
4. İmza `crypto.subtle.sign()` ile **tarayıcıda** atılır
5. `POST /api/sign/finalize` → sunucuya yalnız **imza değeri** gider

Üst çubuktaki 🔒 rozeti bu durumu canlı gösterir.

**Sınır:** Tarayıcı içi çözme yalnız PBES2 (PBKDF2 + AES) şemalı PFX'lerde
çalışır. Eski RC2/3DES şemalı dosyalarda arayüz bunu açıkça söyler ve sunucu
tarafı moduna geçmeyi önerir (o modda `@fitfak/pkcs12`'nin saf JS RC2'si devreye
girer).

## XSS duruşu

- `innerHTML` yalnız TEK yerde kullanılır: önizleme iframe'inin gövdesine
  kullanıcının kendi HTML'ini yazmak için. O iframe `sandbox="allow-same-origin"`
  ile açılır — `allow-scripts` **verilmez**, yani içerideki script çalışmaz.
- Uygulama kabuğundaki tüm düğümler `lib/dom.js` ile kurulur; kullanıcı metni
  yalnız `textContent` ile yazılır.
