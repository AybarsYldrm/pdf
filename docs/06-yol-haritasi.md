# 06 — Yol Haritası

> **DURUM (bu dalda):** Faz 0, 1, 2, 3, 4, 6 ve 7 **tamamlandı** ve testleriyle
> birlikte depoda. **Tüm fazlar tamamlandı** (0–8). Aşağıdaki plan olduğu gibi
> bırakıldı; her satırın karşısına ne yapıldığı yazıldı.

Fazlar sıralıdır: her faz, bir öncekinin çıktısını temel alır. Her fazın sonunda
**gösterilebilir bir şey** vardır — "altyapı fazı" yoktur.

Efor birimi: **AG = adam-gün** (kaba tahmin, kalibre edilecek).

---

## ✅ Faz 0 — Temizlik ve İskele · ~3 AG

Kod yazmadan önce zemini düzelt. Bu fazın tamamı mekaniktir, riski düşüktür.

| # | İş | Çıktı |
|---|-----|-------|
| 0.1 | `@fitfak/*` paketlerini `packages/` altına taşı, npm workspaces kur | `require('@fitfak/pades')` değişmeden çalışır |
| 0.2 | Kök `package.json`: `name`, `engines`, `scripts`, `workspaces` | `npm test` / `npm run dev` çalışır |
| 0.3 | Kökteki kopya `qr.js`'i sil (paket kanonik kaynak) | Tek kaynak |
| 0.4 | `src/` ağacını `packages/pdf-html/reference/` altına arşivle | Rakip motor kalkar |
| 0.5 | `signature/signature_assets.js` (bozuk ölü kod) sil | Bulgu 3.1.10 kapanır |
| 0.6 | `certificate.js`'in eksik `device-login.js` bağımlılığını yaz veya dosyayı `examples/`'a taşı | Kırık dosya kalmaz |
| 0.7 | Minimal test koşucusu (`node:test` + `node --test`) | `npm test` yeşil |
| 0.8 | `examples/` klasörü; `index.js` → `examples/01-multi-sign.js` | Kök temizlenir |
| 0.9 | GitHub Actions: `node --test` + lint | CI |

**Kabul:** `npm ci && npm test` temiz bir makinede yeşil; mevcut `index.js` senaryosu
`examples/` altından aynı çıktıyı üretiyor.

---

## ✅ Faz 1 — PAdES/LTV'yi Eksiksiz Yap · ~10 AG

Kullanıcının **birincil** isteği. En yüksek değer burada.

| # | İş | Bulgu | Kabul kriteri |
|---|-----|-------|---------------|
| 1.1 | `x509_ext.js`: AIA/CDP/AKI/SKI'yı **ASN.1 ile** çıkar | 3.1.2 | Birim testi: 10 farklı gerçek sertifikada doğru URL'ler; regex kodu tamamen silinmiş |
| 1.2 | `buildChain(leaf, pool)` — subject/issuer DER + AKI/SKI eşleşmesi | 3.1.2 | Karışık havuzdan doğru yol kurulur |
| 1.3 | `addLTV`'ye `crl` parametresi; CRL indir, **doğrula**, DSS'e göm | **3.1.1** | `/DSS /CRLs` dolu; `pdfsig` ve Adobe görüyor |
| 1.4 | `sign()`'daki `ocsp` zorunluluğunu kaldır → "her sertifika için ≥1 iptal kanıtı" | 3.1.6 | Yalnız-CRL veren CA ile B-LT üretilir |
| 1.5 | Çoklu imza: her imza için ayrı VRI + `/TU` | 3.1.5 | 2 imzalı belgede 2 VRI girdisi |
| 1.6 | DocTS sözlüğü: `/Type /DocTimeStamp`, `/M` kaldır | 3.1.7 | EU DSS doğrulayıcısı DocTS'i tanır |
| 1.7 | LTA: arşiv damgasının TSA zinciri için **ikinci DSS revizyonu** | **3.1.4** | `achievedLevel === 'B-LTA'` ve TSA yolu çevrimdışı doğrulanır |
| 1.8 | `extendToLT()` / `extendToLTA()` API'si (var olan imzayı yükselt) | — | B-T belge → B-LTA, imzalar bozulmadan |
| 1.9 | TST imzasını + TSA EKU'sunu **doğrula** | 3.1.9 | Sahte TST reddedilir |
| 1.10 | Uyarlanabilir `placeholderHexLen` | 3.1.8 | 8 sertifikalı + 4 OCSP + 3 CRL'li belge sığar |
| 1.11 | Çoklu TSA yedeği + zaman aşımı/yeniden deneme | — | Birincil TSA düşünce ikincisi devreye girer |
| 1.12 | `strict` bayrağı + `{requestedLevel, achievedLevel, reasons[]}` raporu | — | Sessiz seviye düşüşü imkânsız |
| 1.13 | RSASSA-PSS desteği | 3.1.9 | PSS sertifikayla imza `openssl cms -verify` geçer |

**Kabul:** Faz 3 E2E senaryolarından 1–10 yeşil; Adobe Acrobat'ta "LTV etkin".

---

## ✅ Faz 2 — PKCS#12 · ~6 AG

| # | İş | Kabul kriteri |
|---|-----|---------------|
| 2.1 | `@fitfak/pkcs12` paketi + RFC 7292 KDF (BMPString!) | Birim testi RFC vektörleriyle |
| 2.2 | PBES1 şemaları: 3DES (2/3 anahtar), RC2-128, RC2-40 | 6 fixture PFX'in hepsi açılır |
| 2.3 | Saf JS RC2-CBC yedeği (legacy provider yoksa) | RC2-40 PFX Node 20/22/24'te açılır |
| 2.4 | MacData doğrulama + üretme (HMAC-SHA1/256, PBMAC1) | Yanlış parola → `ERR_PKCS12_BAD_PASSWORD` |
| 2.5 | `localKeyId` / `friendlyName` bag attribute'ları | Çok kimlikli PFX'te doğru eşleşme |
| 2.6 | Zincir sıralama (leaf → kök) | `chainPems` doğru sırada |
| 2.7 | `build()`: MacData + PBES2-AES256 + yüksek iterasyon | Windows ve Java üretilen PFX'i kabul eder |
| 2.8 | `probe()` — parolasız ön inceleme | Arayüzde "bu dosyada 2 kimlik var" gösterimi |
| 2.9 | `Pkcs12Signer` (Signer arayüzü) | `sign(pdf, { signer: Pkcs12Signer.from(pfx, pw) })` |
| 2.10 | Tarayıcı ESM yapısı (WebCrypto adaptörü) | Studio'da PFX tarayıcıda açılır |
| 2.11 | Fixture üretim betiği (`test/fixtures/pkcs12/generate.sh`) | 9 varyant üretilir, repoya anahtar konmaz |

**Kabul:** OpenSSL 1.x/3.x, Windows, Java keytool çıktısı olan PFX'lerin hepsi parse
edilir; E2E senaryo 11 yeşil.

---

## ✅ Faz 3 — Doğrulama Motoru ve Offline Test PKI'ı · ~7 AG

Faz 1 ve 2'yi **kanıtlayan** faz. Aslında Faz 1 ile paralel yürütülmeli.

| # | İş | Kabul kriteri |
|---|-----|---------------|
| 3.1 | `test/validation.js` → `packages/verify/` taşı, assert'le sar | Mevcut yetenek testli |
| 3.2 | Revizyon analizi + "imzadan sonra değiştirildi" tespiti | Senaryo 7, 8 |
| 3.3 | Revizyonlar arası fark analizi + DocMDP kararı | İzinli/izinsiz değişiklik ayrımı |
| 3.4 | CMS tam doğrulama (`signedAttrs`, `signing-certificate-v2`) | Sahte imza yakalanır |
| 3.5 | Zincir doğrulama (RFC 5280) — `@fitfak/ssl` `verifyChain` üzerine | Eksik/yanlış zincir yakalanır |
| 3.6 | DSS'ten çevrimdışı iptal doğrulaması + POE hesabı | Senaryo 10: süresi dolmuş sertifika + TST → geçerli |
| 3.7 | ETSI TS 119 102-1 rapor şeması (indication/subIndication) | JSON rapor şemaya uyar |
| 3.8 | Offline test PKI'ı: CA + OCSP + CRL + TSA sunucuları | `npm run test:e2e` ağsız çalışır |
| 3.9 | 14 E2E senaryosu | Hepsi yeşil, < 60 sn |
| 3.10 | `test/timestamp.js` → `test/e2e/pki/tsa.js` | Yeniden kullanılabilir |

**Kabul:** CI'da internet olmadan 14 senaryo yeşil.

---

## ✅ Faz 4 — Damga: QR + Şablonlar · ~4 AG

| # | İş | Kabul kriteri |
|---|-----|---------------|
| 4.1 | `@fitfak/stamp` paketi + slot DSL | `renderStamp({template, vars})` çalışır |
| 4.2 | **Geriye uyum testi:** `classic` şablon = eski çıktı, piksel-piksel | Code39 yapısı kanıtlanabilir şekilde değişmedi |
| 4.3 | `qr` slot tipi — `QR.build()` matrisi doğrudan tuvale | Telefonla okunur, `dual` şablonda hem Code39 hem QR |
| 4.4 | Scanline rasterleştirici | ≥ 20× hızlanma, çıktı aynı |
| 4.5 | `handwritten` slotu: dış imza görseli, otomatik kırpma, beyaz→şeffaf | Kullanıcı PNG'si damgaya oturur |
| 4.6 | Belge-bağlı barkod içeriği (`docNo`, `verifyUrl`) | Aynı belge → aynı barkod |
| 4.7 | 5 hazır şablon (classic/qr/dual/minimal/handwritten) | Studio'da önizlemeli seçim |
| 4.8 | Opsiyonel Code39 mod-43 check digit (varsayılan **kapalı**) | Açıldığında doğru, kapalıyken eski davranış |

---

## ✅ Faz 5 — PDF Okuma/Düzenleme · ~10 AG

| # | İş | Kabul kriteri | Durum |
|---|-----|---------------|-------|
| 5.1 | `@fitfak/pdf-doc`: tam lexer + nesne modeli | — | ✅ `src/lexer.js`, `src/document.js` |
| 5.2 | **Xref stream + ObjStm** desteği | Word/Chrome/InDesign PDF'leri açılır (bulgu 3.1.3) | ✅ `src/xref.js` |
| 5.3 | Filtreler: Flate+Predictor, LZW, A85, AHx, RunLength | Test korpusu açılır | ✅ `src/filters.js` |
| 5.4 | Şifre çözme: RC4-40/128, AES-128/256 | Parolalı PDF açılır | ✅ `src/crypt.js` — yazarken de şifreler |
| 5.5 | Bozuk xref kurtarma (tam tarama) | Hasarlı dosyalar açılır | ✅ kaydederken tablo yeniden kurulur |
| 5.6 | Incremental update yazıcı + imza koruma güvencesi | İmzalı PDF'e sayfa eklenir, imza geçerli kalır | ✅ `06-pdf-doc-signing.test.js` |
| 5.7 | Sayfa işlemleri: ekle/sil/taşı/döndür/böl/birleştir | API testleri | ✅ `src/edit.js` |
| 5.8 | Görsel yerleştirme (konum, ölçek, döndürme, saydamlık) | Studio'dan sürükle-bırak | ✅ "Düzenle" sekmesi + `/api/pdf/edit` |
| 5.9 | Metin ekleme (font gömme/subset ile) | Türkçe karakterler doğru | ✅ WinAnsi + `/Differences` (Gbreve, dotlessi…) |
| 5.10 | AcroForm okuma/doldurma/düzleştirme | Doldurulabilir form senaryosu | ✅ `src/acroform.js` — imza alanı korunur |
| 5.11 | Content stream metin çıkarımı (`/ToUnicode`) | Arama çalışır | ✅ `src/text.js` — Form XObject'lere iner |
| 5.12 | `pades`'i `pdf-doc` üzerine taşı | Tek parser; senaryo 12 yeşil | ✅ `pades/src/utils/normalize.js` köprüsü |

### 5.12 nasıl çözüldü — "klasik xref köprüsü"

PAdES yazıcısını modern parser'a taşımak yerine, modern belgeye **klasik bir
xref tablosu ekliyoruz**. Orijinal baytlara dokunulmadığı için belgede zaten
var olan imzalar bozulmaz:

```
[ orijinal bayt dizisi — HİÇ DEĞİŞTİRİLMEZ ]
[ /ObjStm içindeki nesnelerin açık kopyaları ]
[ tüm nesneleri kapsayan klasik xref tablosu ]
[ trailer + startxref + %%EOF                ]
```

Böylece tek bir kod yolu hem PAdES yazıcısını hem de dış dünyadan gelen
PDF 1.5+ dosyalarını karşılar.

---

## ✅ Faz 6 — HTML/CSS Motoru ve `@fitfak/paper` · ~18 AG

En büyük faz. Kendi içinde üçe bölünür.

### 6a — Çekirdek (~8 AG)
6a.1 HTML tokenizer + DOM · 6a.2 CSS parser + CSSOM · 6a.3 Cascade + specificity +
kalıtım · 6a.4 Computed values + birim sistemi + `var()` · 6a.5 Box tree ·
6a.6 Block/inline layout + gerçek font metrikleri · 6a.7 Sayfalama + `@page` ·
6a.8 Paint → `@fitfak/pdf` · 6a.9 **Layout manifest**

**Kabul:** `examples/01-multi-sign.js`'in ürettiği belge, HTML/CSS'ten **aynı görünümde**
üretilir ve imza konumları manifest'ten gelir (sihirli sayı kalmaz).

### 6b — Tasarım Yetenekleri (~6 AG)
6b.1 Flexbox · 6b.2 Grid · 6b.3 Tablo (+ `<thead>` sayfa başına tekrar) ·
6b.4 Sayaçlar + koşan başlık/altbilgi · 6b.5 Bağlantı + bookmark ·
6b.6 Gradyan + gölge + `transform` · 6b.7 Dul/yetim

### 6c — `@fitfak/paper` (~4 AG)
6c.1 Token'lar + reset + sayfa ustaları · 6c.2 Tipografi ölçeği ·
6c.3 9 bileşen (antet, başlık bloğu, künye, tablo, callout, **imza**, damga, altbilgi,
filigran) · 6c.4 5 tema · 6c.5 `dist/paper.css` derleme betiği ·
6c.6 Örnek belge galerisi (`examples/paper/`)

**Kabul:** 5 tema × 4 belge tipi = 20 örnek PDF, hepsi Adobe'de temiz açılıyor;
aynı HTML tarayıcıda `paper.css` ile **görsel olarak eşdeğer** görünüyor.

### ✅ Faz 6d — Uyumluluk (~5 AG)

| # | İş | Durum |
|---|-----|-------|
| 6d.1 | PDF/A-1b/-2b/-3b: XMP `pdfaid`, gömülü sRGB ICC, `/OutputIntents`, `/ID` | ✅ `pdf-html` `conformance` seçeneği |
| 6d.2 | **Etiketli PDF**: yapı ağacı, `/ParentTree`, işaretli içerik | ✅ `layout/struct.js` + `pdf/tagged.js` |
| 6d.3 | PDF/UA-1: `/Lang`, `/DisplayDocTitle`, `/Alt`, bağlantı `/OBJR` | ✅ |
| 6d.4 | Bağımsız denetleyici (`@fitfak/conformance`) | ✅ 10 PDF/A maddesi + 9 PDF/UA kuralı |
| 6d.5 | `@font-face` | ✅ (Faz 6a'da geldi) |
| 6d.6 | SVG alt kümesi | ⬜ **yapılmadı** — kapsam dışı bırakıldı |

**Kabul:** 4 belge tipi × 5 profil = 20 kombinasyon denetimden geçiyor
(`npm run conformance:report` → `docs/conformance/RAPOR.md`).

**Dürüstlük notu:** Denetleyici veraPDF'in yerini tutmaz. Uyumu kanıtlamaz;
uyumsuzluğun en sık görülen biçimlerini yakalar ve hangi maddeyi denetlediğini
adıyla söyler. Resmî beyan için örnek PDF'ler bağımsız doğrulayıcıya verilmelidir.

---

## ✅ Faz 7 — Web Studio · ~14 AG

| # | İş | AG |
|---|-----|---:|
| 7.1 | Uygulama kabuğu, durum deposu, sekmeler, `dom.js` (innerHTML'siz) | 2 |
| 7.2 | Canvas PDF renderer: lexer + filtreler + content yorumlayıcı | 3 |
| 7.3 | `glyphs.js` — TTF outline → `Path2D` (`stamp.js`'ten türetilir) | 1.5 |
| 7.4 | Görüntüleyici: sayfalar, zoom, kaydırma, küçük resim, Web Worker | 1.5 |
| 7.5 | `coords.js` (ekran ↔ PDF uzayı) + birim testleri | 0.5 |
| 7.6 | İmza kutusu yerleştirme (sürükle/boyutlandır/snap/klavye) | 1.5 |
| 7.7 | İmza görseli: dosya / çizim tuvali / kayıtlı / otomatik damga | 1.5 |
| 7.8 | PFX akışı: tarayıcıda parse + WebCrypto + iki fazlı imzalama | 1.5 |
| 7.9 | İmza paneli + revizyon zaman çizelgesi + "LTV ekle" | 1 |
| 7.10 | Tasarla sekmesi: şablon seç, alan doldur, canlı `<iframe>` önizleme | 1.5 |
| 7.11 | Düzenle sekmesi: sayfa işlemleri, görsel yerleştirme | 1.5 |
| 7.12 | Erişilebilirlik, i18n (tr/en), koyu tema | 1 |

Sunucu (`apps/server`) 7.1 ile paralel: ~2 AG.

---

## ✅ Faz 8 — Cilalama · ~5 AG

| # | İş | Durum |
|---|-----|-------|
| 8.1 | CLI: `render` · `sign` · `verify` · `extend` · `inspect` · `text` · `edit` · `check` · `stamp` · `serve` | ✅ `bin/fitfak-belge.js` |
| 8.2 | Uyumluluk raporu (`docs/conformance/`) | ✅ `npm run conformance:report` |
| 8.3 | Paket README'leri | ✅ 9 paket |
| 8.4 | npm yayın hattı | ✅ `scripts/publish.js` (topolojik sıra, idempotent) + GitHub Actions |
| 8.5 | CI: Node 20 + 22, birim + e2e + uyumluluk | ✅ `.github/workflows/ci.yml` |
| 8.6 | Örnek galeri sitesi | ⬜ **yapılmadı** — Studio zaten canlı önizleme veriyor |

**CLI çıkış kodları:** 0 başarı · 1 kullanım/işlem hatası · 2 doğrulama ya da
uyumluluk başarısızlığı. Betiklerde `if ! fitfak-belge check …` doğrudan çalışır.

---

## Toplam ve Sıralama

| Faz | Konu | AG | Kümülatif |
|-----|------|---:|----------:|
| 0 | Temizlik & iskele | 3 | 3 |
| 1 | PAdES/LTV eksiksiz | 10 | 13 |
| 2 | PKCS#12 | 6 | 19 |
| 3 | Doğrulama + offline PKI | 7 | 26 |
| 4 | Damga: QR + şablon | 4 | 30 |
| 5 | PDF okuma/düzenleme | 10 | 40 |
| 6 | HTML/CSS + paper | 18 | 58 |
| 7 | Web Studio | 14 | 72 |
| 8 | Cilalama | 5 | 77 |

**~77 AG.** Faz 3, Faz 1–2 ile paralel yürütülürse takvim ~65 güne iner.

### Gerçekleşen kapsam

Tüm fazlar tamamlandı. Bilinçli olarak **yapılmayan** iki kalem:

- **SVG alt kümesi** (6d.6): HTML/CSS motoru zaten dikdörtgen, kenarlık, görsel
  ve metin çiziyor; SVG bunların üstüne yeni bir ayrıştırıcı + yol motoru
  getirirdi. Görsel ihtiyacı PNG/JPEG ile karşılanıyor.
- **Örnek galeri sitesi** (8.6): Studio'nun "Tasarla" sekmesi canlı önizleme
  veriyor ve `examples/` altında çalışan betikler var; ayrı bir statik site
  bakım yükü olurdu.

Ayrıca §05/2'deki **kendi canvas PDF renderer'ımız** yazılmadı: tarayıcının
yerleşik görüntüleyicisi `blob:` URL'li ayrı bir çerçevede kullanılıyor.
Gerekçe `docs/05-web-studio.md` §2.1'de.

### Neden bu sıra?

1. **Faz 1–3 önce**, çünkü kullanıcının asıl derdi *"eksiksiz ve LTV etkin PAdES"*.
   Güzel bir arayüz, altındaki imza standarda uymuyorsa değersizdir.
2. **Faz 4 (damga)** küçük ve görünür — erken moral ve erken geri bildirim.
3. **Faz 5 (pdf-doc)**, hem düzenlemenin hem Studio görüntüleyicisinin ön koşuludur.
4. **Faz 6 (HTML/CSS)** en büyüğü ama en az riskli olanı: hata yaparsak sonuç "çirkin PDF",
   "geçersiz imza" değil.
5. **Faz 7 (Studio)** en sona kalır çünkü altındaki her API'nin oturmuş olması gerekir.

---

## Risk Kaydı

| # | Risk | Etki | Olasılık | Azaltma |
|---|------|------|----------|---------|
| R1 | Adobe'nin belgelenmemiş DSS/VRI beklentileri | Yüksek | Orta | Her fazda Adobe + EU DSS ile manuel doğrulama; `docs/conformance/` kaydı |
| R2 | Tarayıcıda PDF render'ı sanılandan zor (CFF/Type1 fontlar) | Orta | **Yüksek** | Kapsam baştan dürüstçe sınırlı (§05/2.2); bizim ürettiğimiz belgelerde HTML önizleme yolu var |
| R3 | HTML/CSS motoru kapsam kayması (scope creep) | Yüksek | **Yüksek** | Desteklenen CSS listesi **sözleşme**; `paper.css` yalnız o listeyi kullanır; liste dışı → uyarı |
| R4 | RC2-40 / legacy OpenSSL sağlayıcı sorunları | Orta | Orta | Saf JS RC2 yedeği (Faz 2.3) |
| R5 | Kamu TSA/OCSP servislerinin hız sınırı, kesinti | Orta | Orta | Offline test PKI'ı (Faz 3.8); çoklu TSA yedeği (Faz 1.11) |
| R6 | Xref-stream desteği eskiden yazılmış kodu kırar | Orta | Düşük | `pdf-doc` yeni paket; `pades` ona 5.12'de taşınır, önce E2E yeşil olur |
| R7 | Tarayıcıda PKCS#12 (WebCrypto RC2/3DES yok) | Orta | Orta | Saf JS şifre çözme tarayıcıda da çalışır (aynı kaynak) |
| R8 | Damga geriye uyumu bozulur | Orta | Düşük | Piksel-piksel geriye uyum testi (Faz 4.2) |
| R9 | ~77 AG'lik kapsam tek kişi için büyük | Yüksek | Yüksek | Sürüm kilometre taşları bağımsız değerli; v0.1 tek başına kullanışlı |

---

## Sürüm Durumu

| Sürüm | İçerik | Durum |
|-------|--------|-------|
| **v0.1** | Faz 0–1 | ✅ PAdES B-LTA, OCSP + CRL ile gerçek LTV |
| **v0.2** | Faz 2–3 | ✅ Herhangi bir PFX ile imzala, çevrimdışı doğrula |
| **v0.3** | Faz 4–5 | ✅ PDF yükle, düzenle, QR'lı damgayla imzala |
| **v0.4** | Faz 6 | ✅ HTML/CSS ile ciddi belge tasarla |
| **v1.0** | Faz 7–8 | ✅ Tarayıcıdan ve komut satırından uçtan uca |

Test durumu: **271 test** (192 birim + 79 e2e) yeşil. E2E testleri ağa çıkmaz;
yerel CA + OCSP + CRL + TSA ayağa kaldırır.

---

## Bundan Sonrası

Yol haritasındaki işler bitti. Bir sonraki adım için doğal adaylar:

| Aday | Neden değerli | Neden bekletildi |
|------|---------------|------------------|
| **veraPDF ile çapraz doğrulama** | Uyumluluk iddiasını bağımsız kanıtlar | Java bağımlılığı; CI'ya ayrı bir kurulum adımı getirir |
| **PAdES-LTA yenileme (`refresh`)** | Arşiv damgası zamanla eskir; zincirleme damga gerekir | Şu an LTA bir kez uygulanıyor; yenileme senaryosu ayrı test PKI'ı ister |
| **CMYK ve renk profilleri** | Baskı işleri için gerekli | Motor bugün yalnız DeviceRGB üretiyor |
| **SVG alt kümesi** | Vektör logo ve şemalar | Yeni bir yol motoru demek; PNG/JPEG bugün yetiyor |
| **Uzak imzalayıcı (HSM / bulut)** | Kurumsal dağıtımın olağan yolu | `Signer` arayüzü hazır (`RemoteSigner`), gerçek bir HSM'e karşı sınanmadı |
