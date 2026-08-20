# @fitfak/registry

İmzalanan belgelerin **eklemeli** (append-only), **HMAC zincirli** doğrulama
kaydı. Sıfır bağımlılık.

## Neden var

Karekod tarayıcısı elinde yalnız bir **özet** tutar. Belgenin kendisi orada
değildir; imzayı yeniden doğrulayamaz. Kayıt olmadan verilebilecek tek dürüst
cevap "bilmiyorum"dur — ve bir doğrulama ürünü için bu, ürünün olmaması
demektir.

## Kullanım

```js
const { Registry, documentHash, recordFromReport } = require('@fitfak/registry');
const { verifyPdf } = require('@fitfak/verify');

const registry = new Registry({
  dir: process.env.REGISTRY_DIR,
  key: process.env.REGISTRY_KEY        // en az 16 karakter
});

// İmzadan SONRA, doğrulamanın sonucuyla birlikte:
const report = await verifyPdf(pdf, { trustAnchors, allowNetwork: false });
registry.append(recordFromReport(report, {
  documentHash: documentHash(pdf),
  docNo: 'DOC-2026-001'
}));

// Tarayıcı tarafında:
registry.verifyChain();                // { ok, records, brokenAt, reason }
registry.lookup(hash);                 // kayıt ya da null
registry.lookupByDocNo('DOC-2026-001');
```

## Kurallar

- **Anahtar yoksa defter yoktur.** Anahtarsız yazılan kayıt doğrulanamaz;
  doğrulanamayan kayıt, kayıt değildir. `dir` verilip `key` verilmezse
  kurucu hata atar.
- **Kayıt silinebiliyorsa kayıt değildir.** Her satır bir öncekinin MAC'ini
  taşır. Satır değiştirmek HMAC'i bozar, satır silmek zinciri kopartır.
- **Kırık noktadan sonrası sayılmaz.** Defterin ortasını bozup sonuna kendi
  kaydını ekleyen biri "doğrulanmış" sayılmamalıdır.
- **Defter arşiv değildir.** Belgenin kendisi ASLA yazılmaz: yalnız özet,
  imzalayanın adı, seviye ve doğrulama sonucu durur.
- **Kayıt, imzanın atıldığı ANDAKİ doğrulamadır.** Sertifika o tarihten
  sonra iptal edilmişse kayıt bunu bilmez; okuyan taraf bunu söylemelidir.

## Eşzamanlılık

Yazma kilitlidir (`registry.log.lock`): zincir sıraya bağlıdır ve iki süreç
aynı `prev` değerini okursa defter çatallanır. Kilit bayatlarsa (sahibi
çöktüyse) 10 saniye sonra kırılır. Okuma kilitsizdir ve dosya değişmediği
sürece önbellekten döner.
