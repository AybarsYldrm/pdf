# Uyumluluk Raporu

> Üretim: `npm run conformance:report` · 2026-08-19 · fitfak-belge v0.1.0 · Node v22.22.2
> Bu dosya **elle düzenlenmez**; her koşuda sıfırdan üretilir.

## Kapsam ve dürüstlük notu

Buradaki denetim `@fitfak/conformance` ile yapılır ve **veraPDF gibi resmî bir
doğrulayıcının yerini tutmaz.** Uyumu kanıtlamaz; uyumsuzluğun pratikte en sık
görülen biçimlerini yakalar ve hangi maddeyi denetlediğini adıyla söyler.
Resmî beyan için çıktıların bağımsız bir doğrulayıcıdan geçirilmesi gerekir.
Aşağıdaki tablodaki örnek PDF'ler bunun içindir: bu betik onları
`docs/conformance/ornekler/` altına **yerel olarak** üretir (depoya alınmazlar,
çünkü her koşuda yeniden üretilebilirler ve ~3 MB tutarlar).

## Sonuç tablosu

| Belge | Profil | Sonuç | Hata | Uyarı | Sayfa | Boyut | Örnek |
|-------|--------|-------|-----:|------:|------:|------:|-------|
| Resmî Yazı | `pdf/a-1b` | ✅ uyumlu | 0 | 0 | 1 | 150 KB | [resmi-yazi__pdf_a-1b.pdf](ornekler/resmi-yazi__pdf_a-1b.pdf) |
| Resmî Yazı | `pdf/a-2b` | ✅ uyumlu | 0 | 0 | 1 | 150 KB | [resmi-yazi__pdf_a-2b.pdf](ornekler/resmi-yazi__pdf_a-2b.pdf) |
| Resmî Yazı | `pdf/a-3b` | ✅ uyumlu | 0 | 0 | 1 | 150 KB | [resmi-yazi__pdf_a-3b.pdf](ornekler/resmi-yazi__pdf_a-3b.pdf) |
| Resmî Yazı | `pdf/ua` | ✅ uyumlu | 0 | 0 | 1 | 151 KB | [resmi-yazi__pdf_ua.pdf](ornekler/resmi-yazi__pdf_ua.pdf) |
| Resmî Yazı | `pdf/a-2b+pdf/ua` | ✅ uyumlu | 0 | 0 | 1 | 151 KB | [resmi-yazi__pdf_a-2b_pdf_ua.pdf](ornekler/resmi-yazi__pdf_a-2b_pdf_ua.pdf) |
| Tablolu Rapor | `pdf/a-1b` | ✅ uyumlu | 0 | 0 | 1 | 150 KB | [tablo-rapor__pdf_a-1b.pdf](ornekler/tablo-rapor__pdf_a-1b.pdf) |
| Tablolu Rapor | `pdf/a-2b` | ✅ uyumlu | 0 | 0 | 1 | 150 KB | [tablo-rapor__pdf_a-2b.pdf](ornekler/tablo-rapor__pdf_a-2b.pdf) |
| Tablolu Rapor | `pdf/a-3b` | ✅ uyumlu | 0 | 0 | 1 | 150 KB | [tablo-rapor__pdf_a-3b.pdf](ornekler/tablo-rapor__pdf_a-3b.pdf) |
| Tablolu Rapor | `pdf/ua` | ✅ uyumlu | 0 | 0 | 1 | 152 KB | [tablo-rapor__pdf_ua.pdf](ornekler/tablo-rapor__pdf_ua.pdf) |
| Tablolu Rapor | `pdf/a-2b+pdf/ua` | ✅ uyumlu | 0 | 0 | 1 | 152 KB | [tablo-rapor__pdf_a-2b_pdf_ua.pdf](ornekler/tablo-rapor__pdf_a-2b_pdf_ua.pdf) |
| Listeli Sözleşme | `pdf/a-1b` | ✅ uyumlu | 0 | 0 | 1 | 150 KB | [listeli-sozlesme__pdf_a-1b.pdf](ornekler/listeli-sozlesme__pdf_a-1b.pdf) |
| Listeli Sözleşme | `pdf/a-2b` | ✅ uyumlu | 0 | 0 | 1 | 150 KB | [listeli-sozlesme__pdf_a-2b.pdf](ornekler/listeli-sozlesme__pdf_a-2b.pdf) |
| Listeli Sözleşme | `pdf/a-3b` | ✅ uyumlu | 0 | 0 | 1 | 150 KB | [listeli-sozlesme__pdf_a-3b.pdf](ornekler/listeli-sozlesme__pdf_a-3b.pdf) |
| Listeli Sözleşme | `pdf/ua` | ✅ uyumlu | 0 | 0 | 1 | 151 KB | [listeli-sozlesme__pdf_ua.pdf](ornekler/listeli-sozlesme__pdf_ua.pdf) |
| Listeli Sözleşme | `pdf/a-2b+pdf/ua` | ✅ uyumlu | 0 | 0 | 1 | 152 KB | [listeli-sozlesme__pdf_a-2b_pdf_ua.pdf](ornekler/listeli-sozlesme__pdf_a-2b_pdf_ua.pdf) |
| Görselli Belge | `pdf/a-1b` | ✅ uyumlu | 0 | 0 | 1 | 149 KB | [gorselli-belge__pdf_a-1b.pdf](ornekler/gorselli-belge__pdf_a-1b.pdf) |
| Görselli Belge | `pdf/a-2b` | ✅ uyumlu | 0 | 0 | 1 | 149 KB | [gorselli-belge__pdf_a-2b.pdf](ornekler/gorselli-belge__pdf_a-2b.pdf) |
| Görselli Belge | `pdf/a-3b` | ✅ uyumlu | 0 | 0 | 1 | 149 KB | [gorselli-belge__pdf_a-3b.pdf](ornekler/gorselli-belge__pdf_a-3b.pdf) |
| Görselli Belge | `pdf/ua` | ✅ uyumlu | 0 | 0 | 1 | 150 KB | [gorselli-belge__pdf_ua.pdf](ornekler/gorselli-belge__pdf_ua.pdf) |
| Görselli Belge | `pdf/a-2b+pdf/ua` | ✅ uyumlu | 0 | 0 | 1 | 150 KB | [gorselli-belge__pdf_a-2b_pdf_ua.pdf](ornekler/gorselli-belge__pdf_a-2b_pdf_ua.pdf) |

**Toplam:** 20 kombinasyon, 0 hata.

## Denetlenen maddeler

### PDF/A (ISO 19005)

| Madde | Konu |
|-------|------|
| `6.1.2` | Dosya başlığı ve ikili yorum satırı |
| `6.1.3` | Trailer: `/ID` zorunlu, `/Encrypt` yasak |
| `6.1.7` | `LZWDecode` yasak; harici akış (`/F`) yasak |
| `6.2.2` | Çıktı amacı (`OutputIntent`) + gömülü ICC profili |
| `6.2.11` | Bütün fontlar gömülü (standart 14 istisnası YOK) |
| `6.3` | Şeffaflık (yalnız PDF/A-1'de yasak) |
| `6.5.3` | Açıklamalar: `/AP` zorunlu, `/CA = 1`, gizli olamaz |
| `6.6.1` | Yasaklı eylemler: JavaScript, Launch, Movie, Sound, XFA |
| `6.7.2` | XMP üst verisi ve `pdfaid` iddiası |
| `6.7.3` | XMP ile `/Info` tutarlılığı |

### PDF/UA-1 (ISO 14289-1, Matterhorn maddeleri)

| Kural | Konu |
|-------|------|
| `01` | Etiketlenmemiş içerik; `/MarkInfo`, `/StructTreeRoot`, `/ParentTree` |
| `06` | Belge başlığı (`/Title` + `/DisplayDocTitle`) |
| `09` | Başlık düzeylerinin atlanmaması (H1 → H3 yasak) |
| `11` | Doğal dil (`/Lang`) |
| `13` | Görsellerde alternatif metin (`/Alt`) |
| `14` | Bağlantılarda erişilebilir açıklama + `/OBJR` bağı |
| `15` | Tablo yapısı (TR / TH / TD, `/Scope`), liste yapısı (Lbl / LBody) |
| `19` | XMP `pdfuaid:part` iddiası |
| `31` | Font gömme |

## Bilinen sınırlar

- **PDF/A-2a / -3a** (erişilebilir arşiv) iddia edilebilir ama tam denetlenmez:
  "a" düzeyi PDF/UA kurallarının tamamını da kapsar; ikisini birlikte istemek
  (`pdf/a-2b+pdf/ua`) şu an daha dürüst bir yoldur.
- **Renk uzayları**: yalnız DeviceRGB üretiliyor ve sRGB çıktı amacı yazılıyor.
  CMYK veya Lab içeren belgelerde denetim eksik kalır.
- **Gömülü dosyalar** (PDF/A-3 eki) denetlenmez.
- **Şeffaflık** yalnız PDF/A-1 için ve yalnız `ExtGState` düzeyinde bakılır.

