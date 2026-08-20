# 02 — Hedef Mimari

---

## 1. Temel Yapısal Karar: Monorepo + npm workspaces

**Problem:** `@fitfak/*` paketleri "dahili" kabul ediliyor ama `node_modules/` içinde,
gitignore'lu, versiyonlanmıyor, düzenlenemiyor, test edilemiyor.

**Çözüm:** Paketleri repoya `packages/` altına taşı, npm **workspaces** ile bağla.

```jsonc
// package.json (kök)
{
  "name": "fitfak-belge",
  "private": true,
  "workspaces": ["packages/*", "apps/*"],
  "engines": { "node": ">=20" }
}
```

Bu tek hamle ile:

- `require('@fitfak/pades')` **hiç değişmeden** çalışmaya devam eder (workspaces symlink kurar),
- paketler git'te versiyonlanır, PR'lanır, test edilir,
- yeni paketler aynı isim alanında eklenir,
- `npm publish -w packages/pades` ile hâlâ npm'e yayınlanabilir.

> **Not:** Bu bir *fork* değil, *iç kaynak*laştırmadır. Sürüm numaraları korunur, yukarı
> yönlü yayın kapısı açık kalır.

---

## 2. Depo Yerleşimi

```
fitfak-belge/
├── package.json                 # workspaces kökü
├── docs/                        # bu klasör
│
├── packages/
│   ├── ssl/          @fitfak/ssl        [mevcut]  kripto + PKI ilkelleri
│   ├── qr/           @fitfak/qr         [mevcut]  QR kodlayıcı
│   ├── pdf/          @fitfak/pdf        [mevcut]  PDF yazma motoru
│   ├── pades/        @fitfak/pades      [mevcut]  PAdES imzalama
│   │
│   ├── pkcs12/       @fitfak/pkcs12     [YENİ]    tam PFX parse/build
│   ├── pdf-doc/      @fitfak/pdf-doc    [YENİ]    PDF okuma + incremental düzenleme
│   ├── pdf-html/     @fitfak/pdf-html   [YENİ]    HTML/CSS → PDF derleyici
│   ├── pdf-scene/    @fitfak/pdf-scene  [YENİ]    serbest yerleşimli sahne modeli
│   ├── paper/        @fitfak/paper      [YENİ]    baskıya-öncelikli CSS tasarım sistemi
│   ├── stamp/        @fitfak/stamp      [YENİ]    damga şablon motoru (pades'ten ayrılır)
│   ├── verify/       @fitfak/verify     [YENİ]    imza doğrulama + ETSI raporu
│   └── registry/     @fitfak/registry   [YENİ]    eklemeli doğrulama kaydı
│
├── apps/
│   ├── studio/                          [YENİ]    vanilla JS web arayüzü
│   ├── server/                          [YENİ]    node:http API (server.js'in halefi)
│   └── cli/                             [YENİ]    fitfak-belge komut satırı
│
├── test/
│   ├── fixtures/                        örnek PDF/PFX/sertifikalar
│   ├── e2e/                             offline CA+OCSP+CRL+TSA ile uçtan uca
│   └── unit/
│
└── examples/                            index.js'in halefi: senaryo örnekleri
```

**Kaldırılacaklar:** kökteki `src/` (→ `pdf-html`'e devrolur), kökteki `qr.js` (kopya),
`signature/signature_assets.js` (bozuk ölü kod).

---

## 3. Katmanlar ve Bağımlılık Yönü

Bağımlılık **yalnızca aşağı doğru** akar. Yukarı ok yoktur; döngü yoktur.

```
┌──────────────────────────────────────────────────────────────┐
│  L4  UYGULAMA        apps/studio · apps/server · apps/cli     │
├──────────────────────────────────────────────────────────────┤
│  L3  ORKESTRASYON    @fitfak/pades  (sign pipeline)           │
│                      @fitfak/verify (validate pipeline)       │
├──────────────────────────────────────────────────────────────┤
│  L2  BELGE           @fitfak/pdf-html  @fitfak/paper          │
│                      @fitfak/pdf-doc   @fitfak/stamp          │
│                      @fitfak/pdf-scene                        │
├──────────────────────────────────────────────────────────────┤
│  L1  BİÇİM           @fitfak/pdf   @fitfak/qr                 │
├──────────────────────────────────────────────────────────────┤
│  L0  KRİPTO          @fitfak/ssl   @fitfak/pkcs12             │
├──────────────────────────────────────────────────────────────┤
│      Node.js dahili: crypto · zlib · http/https · fs · buffer │
└──────────────────────────────────────────────────────────────┘
```

| Paket | İzinli bağımlılıklar |
|-------|----------------------|
| `ssl` | (yok) |
| `qr` | (yok) |
| `pkcs12` | `ssl` |
| `pdf` | (yok) |
| `stamp` | `pdf`, `qr` |
| `pdf-doc` | `pdf` |
| `pdf-html` | `pdf`, `paper` |
| `pdf-scene` | `pdf`, `pdf-html`, `qr`, `conformance` |
| `paper` | (yok — saf CSS + şema) |
| `pades` | `ssl`, `pdf-doc`, `stamp` |
| `verify` | `ssl`, `pdf-doc` |
| `registry` | (yok) |

---

## 4. Uçtan Uca Veri Akışı

### 4.1 Üretim → İmza (tam yol)

```
   HTML + CSS (@fitfak/paper temaları)
        │
        ▼  @fitfak/pdf-html
   ┌────────────────────────────┐
   │  DOM  →  CSSOM  →  Cascade │
   │  →  Box tree  →  Layout    │
   │  →  Fragment tree (sayfalı)│
   └────────────────────────────┘
        │
        ├──────────────► PDF Buffer            (@fitfak/pdf)
        │
        └──────────────► Layout Manifest       ◄── KİLİT FİKİR (§5)
                         { signatureSlots, links, outline, pageBoxes }
                                │
                                ▼
   ┌─────────────────────────────────────────────────────────┐
   │  @fitfak/pades  ·  sign()                               │
   │                                                          │
   │   Signer arayüzü ──► PFX | HSM | tarayıcı | akıllı kart  │
   │        │                                                 │
   │   1. görsel damga  (@fitfak/stamp: ad + Code39 + QR)     │
   │   2. placeholder   (/ByteRange + /Contents)              │
   │   3. CAdES-BES     (signed attrs + signing-certificate-v2)│
   │   4. RFC 3161 TST  → B-T                                 │
   │   5. DSS + VRI     (cert + OCSP + CRL) → B-LT            │
   │   6. DocTimeStamp  + TSA zinciri için DSS → B-LTA        │
   └─────────────────────────────────────────────────────────┘
                                │
                                ▼
                        imzalı.pdf  (LTV etkin)
```

### 4.2 Yükle → Düzenle → İmzala

```
   yüklenen.pdf
        │  @fitfak/pdf-doc
        ▼
   ┌──────────────────────────────────────────────┐
   │ Lexer → Object model                          │
   │  · xref table + XRef stream + ObjStm          │
   │  · Flate/LZW/A85/AHx/RunLength/DCT filtreleri │
   │  · RC4 + AES şifre çözme (gerekirse)          │
   └──────────────────────────────────────────────┘
        │
        ├─► render  ──► apps/studio canvas görüntüleyici
        │
        ├─► edit ops ──► görsel ekle · sayfa döndür/sil · metin ·
        │                form doldur · açıklama · damga
        │
        ▼  incremental update writer (önceki imzalar korunur)
   düzenlenmiş.pdf ──► @fitfak/pades ──► imzalı.pdf
```

---

## 5. Kilit Soyutlama #1 — Layout Manifest

> **Problem:** Bugün imza kutusunun yeri `index.js:138`'de sabit:
> `{ x: 170, y: 37, width: 115 }`. Şablon bir milimetre değişse imza kayar.

**Çözüm:** PDF üreticisi, çıktının yanında bir **layout manifest** döndürür. HTML'deki
imza yuvaları koordinatlarını kendileri bildirir.

```html
<!-- belge.html -->
<div class="paper-signature-row">
  <div class="paper-sig-slot" data-signer="aybars"  data-role="Düzenleyen"></div>
  <div class="paper-sig-slot" data-signer="ahmet"   data-role="Onaylayan"></div>
</div>
```

```jsonc
// manifest.json (motorun çıktısı)
{
  "pages": [{ "index": 0, "width": 595.28, "height": 841.89, "rotate": 0 }],
  "signatureSlots": [
    { "id": "aybars", "role": "Düzenleyen", "page": 0,
      "rect": { "x": 56.7, "y": 78.4, "width": 155.9, "height": 62.4 },
      "origin": "bottom-left" },
    { "id": "ahmet",  "role": "Onaylayan",  "page": 0,
      "rect": { "x": 240.9, "y": 78.4, "width": 155.9, "height": 62.4 },
      "origin": "bottom-left" }
  ],
  "links":   [{ "page": 0, "rect": {...}, "uri": "https://..." }],
  "outline": [{ "level": 1, "title": "Giriş", "page": 0, "y": 720 }]
}
```

```js
// imzalama artık sihirli sayı içermez
const { pdf, manifest } = await renderHtml(html, { css: paper.theme('kurumsal') });
await sign(pdf, { signer, slot: manifest.signatureSlots.find(s => s.id === 'aybars') });
```

**Kazanç:** Tasarım ile imza konumu tek kaynaktan gelir. Şablon değişince imza kendiliğinden
doğru yere oturur. Aynı manifest Web Studio'da imza kutusunu vurgulamak için de kullanılır.

---

## 6. Kilit Soyutlama #2 — `Signer` Arayüzü

> **Problem:** Bugün imzalama `keyPem` string'i istiyor. Bu, anahtarın **düz metin olarak
> bellekte** bulunmasını zorunlu kılar; HSM, akıllı kart veya tarayıcı-içi anahtar mümkün değil.

**Çözüm:** İmzalama motoru anahtarı değil, bir **imzalayıcı** ister.

```js
/**
 * @typedef {Object} Signer
 * @property {() => Promise<{ certPem: string, chainPems: string[] }>} getCertificates
 * @property {(digest: Buffer, alg: {hash:string, scheme:'pkcs1'|'pss'|'ecdsa'}) => Promise<Buffer>} signDigest
 * @property {() => { keyType:'rsa'|'ec', curve?:string, bits?:number }} keyInfo
 */
```

Uygulamalar:

| Uygulama | Nerede çalışır | Anahtar nerede |
|----------|----------------|----------------|
| `PemSigner` | Node | bellek (mevcut davranış) |
| `Pkcs12Signer` | Node | PFX'ten çözülmüş, bellekte |
| `WebCryptoSigner` | tarayıcı | `CryptoKey`, **dışa aktarılamaz** |
| `RemoteSigner` | Node ↔ tarayıcı | uzak uçta; sadece hash gidip imza döner |
| `Pkcs11Signer` | Node | akıllı kart / HSM *(gelecek)* |

Bu arayüz, §7'deki iki fazlı imzalamayı ve "anahtar tarayıcıdan çıkmaz" güvencesini
mümkün kılan tek şeydir.

---

## 7. Kilit Soyutlama #3 — İki Fazlı (Detached) İmzalama

Tarayıcıda PFX kullanılırken özel anahtar **asla** sunucuya gitmez:

```
TARAYICI                            SUNUCU
────────                            ──────
PFX + parola
  │ @fitfak/pkcs12 (ESM)
  ▼
{ key(CryptoKey), cert, chain }
  │
  │  POST /api/sign/prepare
  │  { pdfId, certPem, chainPems, slot, stampOpts }
  ├───────────────────────────────────►
  │                                   görsel damga bas
  │                                   placeholder aç
  │                                   CAdES signedAttrs kur
  │  { sessionId, signedAttrsDigest } ByteRange hash'le
  ◄───────────────────────────────────┤
  │
WebCrypto.sign(privateKey, digest)
  │
  │  POST /api/sign/finalize
  │  { sessionId, signatureValue }
  ├───────────────────────────────────►
  │                                   CMS'i tamamla
  │                                   TSA'ya git (B-T)
  │                                   OCSP/CRL topla → DSS (B-LT)
  │                                   DocTS + DSS (B-LTA)
  │  imzalı.pdf                       CMS'i /Contents'e enjekte et
  ◄───────────────────────────────────┤
```

Sunucu hiçbir zaman özel anahtarı görmez. `sessionId` kısa ömürlü (varsayılan 120 sn),
tek kullanımlık, yalnız bellekte.

**Alternatif mod (tercihe bağlı):** `serverSideSigning: true` — PFX sunucuya yüklenir,
yalnız bellekte tutulur, işlem biter bitmez sıfırlanır. Basit ama daha zayıf; varsayılan
değildir ve arayüzde açıkça uyarı gösterir.

---

## 8. Kilit Soyutlama #4 — Damga Şablonu (Slot DSL)

`stamp.js` bugün üç sabit bölgeden oluşuyor. Bunu, Code39'a hiç dokunmadan, slot tabanlı
bir şablona çeviriyoruz:

```js
const template = {
  size: { width: 1280, height: 320 },       // varsayılan: mevcut çıktıyla aynı
  background: 'transparent',
  slots: [
    { type: 'grain',   rect: [0,   0, 560, 160] },
    { type: 'text',    rect: [0,   0, 560, 160], value: '{signerName}', transform: 'upper-tr' },
    { type: 'band',    rect: [0, 160, 560, 160], color: [35,35,35] },
    { type: 'image',   rect: [34,190,  92,  92], src: '{logo}' },
    { type: 'text',    rect: [0, 160, 560, 160], value: 'FITFAK', color: [220,220,220] },
    { type: 'code39',  rect: [560, 0, 720, 320], value: '{docNo}' },   // ← DEĞİŞMEZ
  ]
};
```

QR için yalnızca yeni bir slot tipi eklenir:

```js
{ type: 'qr', rect: [x,y,w,h], value: '{verifyUrl}', ecLevel: 'M', quiet: 2 }
```

Hazır şablonlar: `classic` (bugünkü çıktı, bit-bit aynı) · `qr` (Code39 yerine QR) ·
`dual` (Code39 + QR yan yana) · `minimal` (yalnız ad + tarih) ·
`handwritten` (kullanıcının yüklediği imza PNG'si + küçük QR).

---

## 9. Kilit Soyutlama #5 — Tek Doğruluk Kaynağı Olarak CSS

`@fitfak/paper` yalnızca PDF motoruna değil, **tarayıcıya da** verilir:

```
              @fitfak/paper/dist/paper.css
                 ┌──────────┴──────────┐
                 ▼                     ▼
        @fitfak/pdf-html         apps/studio (<iframe>)
        (PDF çıktısı)            (canlı önizleme)
```

Aynı CSS iki tarafta çalıştığı için önizleme **gerçekten** WYSIWYG olur. Motorun
desteklemediği CSS özellikleri `paper.css` içinde **kullanılmaz** — yani tasarım sistemi
aynı zamanda motorun uyumluluk sözleşmesidir. Bu, "CSS'in tamamını destekle" gibi bitmez
bir hedefi, "tasarım sisteminin kullandığı CSS'i kusursuz destekle" gibi bitebilir bir
hedefe çevirir.

---

## 10. Hata ve Günlük Politikası

- Her paket kendi hata sınıfını dışa verir: `PadesError`, `Pkcs12Error`, `PdfParseError`,
  `LayoutError`, `VerifyError`. Her birinde makinece okunabilir bir `code` alanı bulunur
  (`ERR_PKCS12_BAD_PASSWORD`, `ERR_LTV_NO_REVOCATION_SOURCE`, `ERR_PDF_XREF_UNSUPPORTED`…).
- `console.log` kütüphane kodunda **yasak**. Enjekte edilen `logger` kullanılır
  (`{ debug, info, warn, error }`), varsayılan `noop`.
- Ağ hataları (TSA/OCSP/CRL) yutulmaz. `strict: true` (varsayılan) → fırlatır;
  `strict: false` → `report.warnings[]` içine yazılır ve seviye düşürülür
  (ör. B-LT talep edilmişken B-T üretildiyse **açıkça** bildirilir).
- Bir seviye talep edilip ulaşılamadıysa **sessizce düşürülmez**; sonuç nesnesi
  `{ requestedLevel, achievedLevel, reasons[] }` içerir.

---

## 11. Güvenlik Duruşu

| Konu | Karar |
|------|-------|
| Özel anahtar | Varsayılan: tarayıcıdan çıkmaz (§7). Sunucu modu opt-in + görünür uyarı. |
| PFX parolası | Belleğin dışına yazılmaz; log'lanmaz; kullanım sonrası buffer sıfırlanır. |
| Yüklenen PDF | Boyut sınırı (varsayılan 32 MB), sayfa sınırı, ayrıştırma zaman aşımı. |
| Ağ | TSA/OCSP/CRL için host allow-list; zaman aşımı; yönlendirme sınırı; SSRF koruması. |
| XSS | Studio'da `innerHTML` yasak; `textContent` + `createElement`. Kullanıcı HTML'i yalnız sandbox'lı `<iframe>` içinde (`sandbox="allow-same-origin"`, script yok). |
| CSP | `default-src 'self'; script-src 'self'; object-src 'none'` |
| Kalıcılık | Sunucu varsayılan olarak **hiçbir şeyi diske yazmaz**. |

---

## 12. Uyumluluk Sözü

- **Node.js ≥ 20** (mevcut `engines` ile uyumlu; `crypto.X509Certificate`, `fetch` yerleşik).
- Tarayıcı: modern evergreen (ES2022, `WebCrypto`, `OffscreenCanvas`, `Path2D`).
  Yapı adımı, transpiler, bundler **yok** — doğrudan ESM.
- Mevcut genel API'ler (`signPdfInMemory`, `new NativePdfEngine(...)`, `generateStamp`)
  **korunur**; yeni API'ler yanlarına eklenir. Kırıcı değişiklik yapılmaz.
