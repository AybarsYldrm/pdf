# @fitfak/conformance

PDF/A ve PDF/UA uyumluluk **denetimi**. Sıfır bağımlılık: yalnız Node.js
dahili modülleri ve `@fitfak/pdf-doc`.

## Dürüstlük notu — önce bunu okuyun

Bu paket **veraPDF gibi resmî bir doğrulayıcının yerini tutmaz.**

- Bir belgenin PDF/A olduğunu **kanıtlamaz**.
- PDF/A **olmadığını** gösteren, pratikte en sık karşılaşılan ihlalleri yakalar.
- Her bulgu, ihlal edilen **maddeyi adıyla** söyler; hangi kuralın sınandığı
  tartışmaya açık değildir.

Resmî beyan gerekiyorsa çıktıyı bağımsız bir doğrulayıcıdan geçirin.
`npm run conformance:report` bunun için hazır örnek belgeler üretir.

## Kullanım

```js
const conformance = require('@fitfak/conformance');

// Belgenin XMP'de İDDİA ETTİĞİ profilleri denetler
const report = conformance.check(pdfBuffer);

// Ya da açıkça belirtin
const report = conformance.check(pdfBuffer, { profiles: ['pdf/a-2b', 'pdf/ua'] });

report.conforms                  // true / false
report.summary                   // { errors: 0, warnings: 1 }
report.pdfA.errors               // [{ clause: '6.2.2', message: '…' }]
report.pdfUA.structure.roles     // { H1: 1, P: 4, Table: 1, TH: 2, … }

console.log(conformance.formatReport(report));
```

Komut satırından:

```bash
fitfak-belge check belge.pdf                      # XMP iddiasına göre
fitfak-belge check belge.pdf --profile pdf/a-2b   # açıkça
fitfak-belge check belge.pdf --json               # makine okunur
```

Uyumsuzlukta çıkış kodu **2**'dir; betiklerde `if ! fitfak-belge check …` ile
kullanılabilir.

## Üretim tarafı

Bu paket denetler, **üretmez**. Uyumlu belge üretmek `@fitfak/pdf-html`'in
işidir:

```js
const { pdf, conformance, warnings } = render({
  html, css, fonts,
  metadata: { title: 'Sözleşme', author: 'Aybars Yıldırım', lang: 'tr-TR' },
  conformance: 'pdf/a-2b+pdf/ua'
});
```

Motor o zaman şunları yazar:

| Profil | Eklenen yapı |
|--------|--------------|
| PDF/A | XMP `pdfaid` iddiası, gömülü sRGB ICC profili + `/OutputIntents`, `/ID`, açıklamalarda `/F 4` |
| PDF/UA | `/StructTreeRoot` + `/ParentTree`, `/MarkInfo`, işaretli içerik (`BDC`/`EMC`), `/Lang`, `/DisplayDocTitle`, bağlantılarda `/Contents` + `/OBJR` |

**PDF/UA istendiğinde etiketleme zorunlu açılır.** Etiketsiz bir belgede
`pdfuaid:part 1` yazmak yanlış beyandır; motor buna izin vermez.

Denetleyici üretimden **bağımsızdır**: "profili istedik" ile "profil gerçekten
yazılmış" ayrı şeylerdir ve ikincisi ayrıca sınanır.

## Denetlenen maddeler

### PDF/A (ISO 19005-1/-2/-3, "b" düzeyi)

| Madde | Konu |
|-------|------|
| `6.1.2` | Dosya başlığı ve ikili yorum satırı (metin aktarımında bozulmama) |
| `6.1.3` | Trailer: `/ID` zorunlu, `/Encrypt` yasak |
| `6.1.7` | `LZWDecode` yasak; harici akış (`/F`) yasak |
| `6.2.2` | Çıktı amacı (`/S /GTS_PDFA1`) + geçerli gömülü ICC profili |
| `6.2.11` | Bütün fontlar gömülü — **standart 14 istisnası yoktur** |
| `6.3` | Şeffaflık (yalnız PDF/A-1'de yasak) |
| `6.5.3` | Açıklamalar: `/AP` zorunlu, `/CA = 1`, gizli olamaz, Print bayrağı |
| `6.6.1` | Yasaklı eylemler: JavaScript, Launch, Movie, Sound, XFA |
| `6.7.2` | XMP üst verisi ve `pdfaid` iddiası |
| `6.7.3` | XMP ile `/Info` tutarlılığı |

### PDF/UA-1 (ISO 14289-1, Matterhorn maddeleri)

| Kural | Konu |
|-------|------|
| `01` | Etiketlenmemiş içerik; `/MarkInfo`, `/StructTreeRoot`, `/ParentTree`, `/StructParents` |
| `06` | Belge başlığı (`/Title` + `/DisplayDocTitle`) |
| `09` | Başlık düzeylerinin atlanmaması (H1 → H3 yasak) |
| `11` | Doğal dil (`/Lang`) |
| `13` | Görsellerde alternatif metin (`/Alt` ya da `/ActualText`) |
| `14` | Bağlantılarda erişilebilir açıklama + `/OBJR` bağı |
| `15` | Tablo yapısı (TR / TH / TD, `/Scope`), liste yapısı (Lbl / LBody) |
| `19` | XMP `pdfuaid:part` iddiası |
| `31` | Font gömme |

`01` kuralı gerçekten içerik akışını tarar: `BDC`/`BMC` bloğu dışında kalan her
`Tj`, `TJ`, `'`, `"` ve `Do` işlemi sayılır. "Etiketli görünen ama içeriği
etiketlenmemiş" belgeler böyle yakalanır.

## Gömülü sRGB ICC profili

PDF/A, gömülü bir ICC profili ister. Dışarıdan ikili dosya taşımak yerine
profil **üretilir** (`src/icc.js`, ~500 bayt):

```js
const { sRGBProfile, readProfileHeader } = require('@fitfak/conformance');

const icc = sRGBProfile();          // ICC v2.1, RGB → XYZ, D50, 9 etiket
readProfileHeader(icc);
// { size: 504, version: '2.1.0', deviceClass: 'mntr', colorSpace: 'RGB', … }
```

Çıktı **deterministiktir** (oluşturma tarihi sabittir): aynı girdi hep aynı
baytları verir, yani tekrarlanabilir derleme bozulmaz.

## XMP

```js
const { buildXmp, parseXmp } = require('@fitfak/conformance');

const xmp = buildXmp({ title: 'Şirket Sözleşmesi', author: 'Aybars Yıldırım',
                       lang: 'tr-TR', pdfA: '2b', pdfUA: true });

parseXmp(xmp);
// { title: 'Şirket Sözleşmesi', creator: 'Aybars Yıldırım', pdfA: '2b', pdfUA: 1, … }
```

Tam bir RDF ayrıştırıcısı değildir ve olmasına gerek yoktur; PDF'teki XMP
paketleri dar bir kalıbı izler. Ad alanı önekleri **zorunlu** tutulur:
`dc:description` ararken `rdf:Description` sarmalayıcısına takılmamak için.

## Bilinen sınırlar

- **PDF/A-2a / -3a** (erişilebilir arşiv) iddia edilebilir ama tam denetlenmez.
  "a" düzeyi PDF/UA kurallarının tamamını kapsar; ikisini birlikte istemek
  (`pdf/a-2b+pdf/ua`) şu an daha dürüst bir yoldur.
- **Renk uzayları**: yalnız DeviceRGB üretilir ve sRGB çıktı amacı yazılır.
  CMYK / Lab içeren belgelerde denetim eksik kalır.
- **Gömülü dosyalar** (PDF/A-3 eki) denetlenmez.
- **Şeffaflık** yalnız PDF/A-1 için ve yalnız `ExtGState` düzeyinde bakılır.
- Yazı tipi **alt kümesi** doğruluğu (gerçekten kullanılan tüm glifler gömülü
  mü) denetlenmez; yalnız `/FontFile*` varlığı sınanır.

## Test

```bash
npm test                    # test/unit/conformance.test.js
npm run conformance:report  # docs/conformance/RAPOR.md + örnek PDF'ler
```

Rapor 4 belge tipi × 5 profil = 20 kombinasyon üretir ve her birini denetler.
Örnek PDF'ler `docs/conformance/ornekler/` altına yazılır (depoya alınmaz):
bağımsız doğrulayıcıya vermek için oradadırlar.
