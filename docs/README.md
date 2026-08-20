# FITFAK Belge Platformu — Planlama Dosyaları

Bu klasör, projenin **"eksiksiz PAdES + LTV imzalama"** ve **"HTML/CSS ile ciddi PDF üretimi"**
hedefine giden yolun analiz, mimari ve yol haritası belgelerini içerir.

> Bu belgeler kod değildir; kodun **sözleşmesidir**. Bir modül yazılmadan önce burada
> tanımlanır, yazıldıktan sonra buradaki kabul kriterleriyle doğrulanır.

## Okuma Sırası

| # | Belge | İçerik |
|---|-------|--------|
| 01 | [Durum Analizi](./01-durum-analizi.md) | Bugün elimizde ne var, ne çalışıyor, ne kırık. Dosya/satır seviyesinde bulgu listesi. |
| 02 | [Hedef Mimari](./02-mimari.md) | Monorepo yapısı, paket sınırları, katmanlar, veri akışı, temel soyutlamalar. |
| 03 | [PAdES & LTV](./03-pades-ltv.md) | ETSI/ISO standart haritası, B-B → B-LTA seviyeleri, DSS/VRI, OCSP/CRL/TSA, PKCS#12. |
| 04 | [PDF Motoru & HTML/CSS](./04-pdf-motoru.md) | HTML/CSS→PDF derleyicisi, desteklenen CSS alt kümesi, `@fitfak/paper` tasarım paketi, layout manifest. |
| 05 | [Web Studio](./05-web-studio.md) | Vanilla JS arayüz: PDF görüntüleyici, editör, imza yerleştirme, PFX, imza paneli. |
| 06 | [Yol Haritası](./06-yol-haritasi.md) | Fazlar, milestone'lar, kabul kriterleri, test stratejisi, risk kaydı. |
| 07 | [CLI](./07-cli.md) | `fitfak-belge` komut satırı aracı: üret, imzala, doğrula, denetle. |
| 08 | [Güvenlik](./08-guvenlik.md) | Güven sınırları, denetim bulguları (G-01…G-12), düzeltmeler, regresyon testleri, kabul edilmiş sınırlar. |
| 09 | [Sahne Modeli](./09-sahne-modeli.md) | Serbest yerleşimli belge şeması, geometri, varlık sistemi, görsel editör, Scene→PDF/HTML derleyicileri. |

## Tek Cümlelik Hedef

> Kullanıcının tarayıcıda hazırladığı veya yüklediği bir PDF'i, kendi `.pfx`'iyle,
> **anahtarı tarayıcıdan çıkarmadan**, ETSI EN 319 142-1 **B-LTA** seviyesinde
> imzalayabilmesi; imzalı belgenin uzun vadeli (LTV) olarak, çevrimdışı bile
> doğrulanabilmesi.

## Değişmez Kurallar (Non-Negotiables)

1. **Sıfır harici bağımlılık.** Yalnızca Node.js dahili modülleri + `@fitfak/*` paketleri.
2. **Code39 yapısı değişmez.** QR bir *ek* seçenektir, ikame değil. Mevcut damga çıktısı
   varsayılan ayarlarla bit-bit aynı kalmalıdır.
3. **İmza kırılmaz.** Her yazma işlemi PDF *incremental update* olarak yapılır; önceki
   imzaların ByteRange kapsamı asla bozulmaz.
4. **Özel anahtar sızmaz.** Varsayılan akışta PFX tarayıcıda çözülür, imza tarayıcıda
   atılır; sunucu yalnızca hash ve CMS gövdesi görür.
5. **Standart > kolaylık.** Bir davranış Adobe Acrobat ve EU DSS doğrulayıcısında yeşil
   yanmıyorsa "çalışıyor" sayılmaz.
