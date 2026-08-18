# FITFAK Belge Platformu

HTML/CSS ile belge tasarla, PDF üret, **PAdES B-LTA** seviyesinde imzala,
**çevrimdışı** doğrula. Yalnızca Node.js dahili modülleri ve `@fitfak/*` paketleri —
sıfır harici bağımlılık.

```bash
npm install
npm start          # → http://127.0.0.1:8787
npm test           # birim testleri
npm run test:e2e   # uçtan uca (tamamen çevrimdışı, yerel PKI ile)
```

---

## Ne yapar

| | |
|---|---|
| **Tasarla** | `@fitfak/paper` tasarım sistemiyle HTML/CSS → PDF. Tarayıcı önizlemesi PDF motoruyla **aynı CSS**'i kullanır. |
| **İmzala** | PFX/P12 ile PAdES B-B / B-T / B-LT / B-LTA. Varsayılan akışta **özel anahtar tarayıcıdan çıkmaz**. |
| **Damgala** | Görünür imza damgası: ad + logo + **Code39** (değişmedi) + **QR** + el yazısı imza. |
| **Doğrula** | ETSI TS 119 102-1 biçiminde rapor; LTV'li belgeler **ağa çıkmadan** doğrulanır. |

---

## Paketler

```
packages/
├── ssl/        @fitfak/ssl        kripto + PKI ilkelleri (ASN.1, X.509, CRL, OCSP, TSA)
├── qr/         @fitfak/qr         QR kodlayıcı (Level 40'a kadar)
├── pdf/        @fitfak/pdf        PDF yazma motoru (TTF subset, PNG/JPEG)
├── pades/      @fitfak/pades      PAdES imzalama, DSS/VRI, CAdES, RFC 3161
├── pkcs12/     @fitfak/pkcs12     tam PFX okuma/yazma (RFC 7292, RC2 dâhil)
├── stamp/      @fitfak/stamp      slot tabanlı görsel damga motoru
├── pdf-html/   @fitfak/pdf-html   HTML + CSS → PDF derleyicisi
├── paper/      @fitfak/paper      baskıya öncelikli CSS tasarım sistemi
└── verify/     @fitfak/verify     imza doğrulama + ETSI raporu

apps/
├── server/     node:http API sunucusu
├── studio/     vanilla JS arayüz (framework/bundler yok)
└── scanner/    QR tarayıcı (ayrı ürün)
```

Paketler npm **workspaces** ile bağlıdır: `require('@fitfak/pades')` doğrudan
`packages/pades`'i çözer. Hepsi ayrı ayrı yayınlanabilir.

---

## Üç kilit fikir

### 1. Layout Manifest — imza koordinatları tasarımdan gelir

HTML'de `data-signer` taşıyan eleman, nihai PDF koordinatlarıyla manifest'e yazılır:

```html
<div class="paper-sig-slot" data-signer="aybars" data-role="Düzenleyen"></div>
```

```js
const { pdf, manifest } = render({ html, css: paper.stack('kurumsal'), fonts });
const slot = manifest.signatureSlots.find(s => s.id === 'aybars');

await manager.sign({
  pdfBuffer: pdf,
  pfx, pfxPassword,
  visibleSignature: fromManifestSlot(slot, { template: 'dual', font, vars })
});
```

Kodda `{ x: 170, y: 37, width: 115 }` gibi sihirli sayı yok. Şablon değişince
imza kendiliğinden doğru yere oturur.

### 2. Signer arayüzü — anahtar nerede olursa olsun

Motor `keyPem` değil bir **imzalayıcı** ister:

```js
Signer = { getCertificates(), sign(data, alg), keyInfo() }
```

`PemSigner` · `Pkcs12Signer` · `RemoteSigner` (HSM / akıllı kart / tarayıcı).
Bu sayede iki fazlı imzalama mümkün olur: sunucu yalnız imzalanacak veriyi üretir,
imza tarayıcıda atılır, sunucuya yalnız imza değeri döner.

### 3. Tek CSS, iki hedef

`@fitfak/paper` hem PDF motoruna hem tarayıcıya verilir. Önizleme bu yüzden
gerçekten WYSIWYG olur — ve tasarım sistemi, motorun desteklediği CSS alt kümesinin
sözleşmesi hâline gelir.

---

## Hızlı başlangıç

```js
const paper = require('@fitfak/paper');
const { render } = require('@fitfak/pdf-html');
const { PAdESManager } = require('@fitfak/pades/src/utils/pades_manager');
const { fromManifestSlot } = require('@fitfak/pades/src/signature/visible');

// 1. HTML → PDF
const { pdf, manifest } = render({
  html: fs.readFileSync('belge.html', 'utf8'),
  css: paper.stack('kurumsal'),
  fonts: [{ family: 'Ubuntu', src: './assets/Ubuntu-Regular.ttf' }],
  page: { size: 'A4', margin: '20mm 18mm' }
});

// 2. PFX ile B-LTA imzala
const manager = new PAdESManager({ tsaUrl: 'http://timestamp.digicert.com' });
const result = await manager.sign({
  mode: 'LTA',
  pdfBuffer: pdf,
  pfx: fs.readFileSync('kimlik.pfx'),
  pfxPassword: '…',
  visibleSignature: fromManifestSlot(manifest.signatureSlots[0], {
    template: 'dual',
    font: './assets/Ubuntu-Regular.ttf',
    vars: { signerName: 'Aybars YILDIRIM', docNo: 'DOC-1', verifyUrl: '…' }
  })
});

console.log(result.achievedLevel);   // 'pades-lta'
console.log(result.reasons);         // seviye düşüşü olduysa SEBEBİYLE birlikte

// 3. Doğrula (çevrimdışı)
const { verifyPdf } = require('@fitfak/verify');
const report = await verifyPdf(result.pdf, { allowNetwork: false });
```

Çalışan tam örnek: `node examples/03-html-sign.js` (ağ gerekmez).

---

## PAdES seviyeleri

| Seviye | Ne ekler | Durum |
|--------|----------|:-----:|
| **B-B** | CAdES-BES, `signing-certificate-v2` (ESS) | ✔ |
| **B-T** | RFC 3161 imza zaman damgası | ✔ |
| **B-LT** | DSS: sertifikalar + **OCSP ve CRL** gömülü | ✔ |
| **B-LTA** | Arşiv belge zaman damgası + **damganın kendi doğrulama verisi** | ✔ |

Seviye talep edilip ulaşılamazsa **sessizce düşülmez**:
`{ requestedLevel, achievedLevel, reasons[] }` döner.

Mevcut imzalı belgeler `extendToLT()` / `extendToLTA()` ile yükseltilebilir —
imzalara dokunulmadan, yeni bir artımlı revizyon olarak.

---

## Test

Tüm testler **çevrimdışı** çalışır: yerel CA + OCSP responder + CRL dağıtım
noktası + RFC 3161 TSA `@fitfak/ssl` ile ayağa kaldırılır ve üretilen
sertifikalara **gerçek AIA/CDP uzantıları** gömülür — böylece otomatik keşif
kodu da gerçekten sınanır.

```bash
npm test          # 80 birim testi
npm run test:e2e  # 44 uçtan uca test
npm run fixtures  # OpenSSL ile 9 farklı PFX varyantı üretir
```

Kapsam: PAdES seviyeleri · yalnız-CRL veren CA · çoklu imza · iptal · seviye
düşüşü raporlama · artımlı güncelleme bütünlüğü · 6 PFX şeması · RFC 2268 RC2
vektörleri · damga geriye uyumu (piksel-piksel) · HTML/CSS motoru · doğrulama
(kurcalama, POE, güvenilmeyen kök) · sunucu API'si · iki fazlı imzalama.

---

## Belgeler

| Belge | İçerik |
|-------|--------|
| [docs/01-durum-analizi.md](docs/01-durum-analizi.md) | Başlangıç durumu ve bulgu listesi |
| [docs/02-mimari.md](docs/02-mimari.md) | Katmanlar, paket sınırları, temel soyutlamalar |
| [docs/03-pades-ltv.md](docs/03-pades-ltv.md) | ETSI/ISO standart haritası, DSS/VRI, PKCS#12 |
| [docs/04-pdf-motoru.md](docs/04-pdf-motoru.md) | HTML/CSS derleyicisi, `@fitfak/paper` |
| [docs/05-web-studio.md](docs/05-web-studio.md) | Arayüz tasarımı ve API sözleşmesi |
| [docs/06-yol-haritasi.md](docs/06-yol-haritasi.md) | Fazlar, kabul kriterleri, risk kaydı |

Paket README'leri: [pkcs12](packages/pkcs12/README.md) ·
[stamp](packages/stamp/README.md) · [pdf-html](packages/pdf-html/README.md) ·
[paper](packages/paper/README.md) · [verify](packages/verify/README.md)

---

## Güvenlik duruşu

- Varsayılan akışta **özel anahtar sunucuya hiç gelmez** (iki fazlı imzalama).
- Sunucu tarafı PFX modu **opt-in**'dir; dosya yalnız bellekte tutulur ve işlem
  biter bitmez sıfırlanır. Arayüz bunu açıkça bildirir.
- İmza oturumları kısa ömürlü (120 sn) ve **tek kullanımlık**.
- Sunucu hiçbir şeyi diske yazmaz.
- Arayüzde `innerHTML` kullanılmaz; kullanıcı içeriği yalnız `textContent` ile
  yazılır ve önizleme script çalıştırmayan bir `sandbox` iframe içindedir.
- CSP, `nosniff`, `frame-ancestors 'none'`, yol kaçışı koruması.
- Doğrulanamayan bir iptal kanıtı **asla** DSS'e gömülmez.

## Lisans

MIT
