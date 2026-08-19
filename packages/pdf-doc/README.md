# @fitfak/pdf-doc

Mevcut PDF belgelerini **okuma** ve **düzenleme** motoru. Sıfır bağımlılık:
yalnız Node.js dahili modülleri.

`@fitfak/pdf-html` sıfırdan PDF *üretir*; bu paket ise dışarıdan gelen —
Word, Chrome, InDesign, tarayıcı çıktısı — belgeleri açar ve üzerinde çalışır.

## Kilit iddia: artımlı kaydetme imzayı bozmaz

Kaydetme varsayılan olarak **artımlı güncellemedir** (ISO 32000-1 §7.5.6):
orijinal bayt dizisine hiç dokunulmaz, değişiklikler dosyanın sonuna yeni bir
revizyon olarak eklenir.

```
[ orijinal bayt dizisi — HİÇ DEĞİŞTİRİLMEZ ]
[ yeni / güncellenmiş nesneler              ]
[ xref  (/Prev → önceki startxref)          ]
[ trailer + startxref + %%EOF               ]
```

Böylece belgedeki imzaların `ByteRange` kapsamı bozulmaz ve imzalar
**kriptografik olarak geçerli kalır**. Doğrulayıcı belgeyi "imzadan sonra
değiştirildi" olarak işaretler — ki doğrusu budur; değişiklik gizlenmez.

İmzalı bir belgeyi baştan yazmak (`save({ full: true })`) imzayı geçersiz
kılacağı için açıkça engellenir:

```js
doc.save({ full: true });
// WriterError: ERR_WOULD_BREAK_SIGNATURE
```

## Desteklenen yapılar

| Yapı | Durum |
|------|-------|
| Klasik `xref` tablosu + `trailer` | ✅ |
| Çapraz başvuru akışı (`/Type /XRef`, PDF 1.5+) | ✅ |
| Nesne akışı (`/ObjStm`) | ✅ |
| Filtreler: Flate (+PNG/TIFF predictor), LZW, ASCII85, ASCIIHex, RunLength | ✅ |
| Görsel filtreleri (DCT, JPX, CCITT, JBIG2) | ham veri olarak geçirilir |
| Şifreleme: RC4-40/128 (R2–R4), AESV2, AESV3 (R5/R6) | ✅ okuma **ve** yazma |
| Bozuk xref kurtarma (tam dosya taraması) | ✅ |
| Yanlış xref konumları | ✅ otomatik onarılır |
| Metin çıkarımı (`/ToUnicode`, `/Differences`, Type0) | ✅ |
| AcroForm okuma / doldurma / düzleştirme | ✅ |

## Kullanım

### Açma ve inceleme

```js
const { PdfDocument } = require('@fitfak/pdf-doc');

const doc = PdfDocument.load(fs.readFileSync('belge.pdf'), { password: '' });

doc.pageCount                 // 12
doc.isEncrypted               // false
doc.hasSignatures             // true
doc.hasForm                   // false
doc.getInfo()                 // { Title: '…', Author: '…', ModDate: 'D:…' }
doc.getPageGeometry(0)        // { width, height, rotate, mediaBox, cropBox, … }
doc.getPageContent(0)         // Buffer — çözülmüş içerik akışı
```

### Metin çıkarımı

```js
doc.extractText(0);           // 'Sözleşme Başlığı\nBu belge …'
doc.extractDocumentText();    // sayfalar \f ile ayrılmış
doc.extractTextItems(0);      // [{ text, x, y, width, height, fontSize, font }]
```

Kod → Unicode eşlemesinde sırayla `/ToUnicode` CMap, `/Encoding` +
`/Differences`, sonra Latin-1 denenir. Form XObject'lere (`Do`) inilir, böylece
düzleştirilmiş formların ve damgaların metni de çıkar. `/Widths` yazılmamış
standart 14 fontta yerleşik AFM metrikleri kullanılır — aksi hâlde tüm
genişlikler sıfır çıkar ve kelime araları kaybolur.

### Sayfa işlemleri

```js
doc.rotatePage(0, 90);            // birikimli
doc.movePage(0, 3);
doc.reorderPages([2, 0, 1]);
doc.removePage(1);
doc.insertPage(0, { size: [0, 0, 595.28, 841.89] });
doc.importPages(digerBelge, [0, 2]);   // birleştirme
```

### Görsel, metin, bağlantı

Koordinatlar PDF kullanıcı uzayındadır: **orijin sol-alt**, birim punto.

```js
doc.addImage(0, pngBuffer, { x: 400, y: 700, width: 120, opacity: 0.85, rotate: 15 });
doc.addText(0, 'Ağrı Dağı', { x: 60, y: 120, size: 11, color: [0.1, 0.2, 0.6] });
doc.addLink(0, { x: 60, y: 100, width: 180, height: 14 }, 'https://aybars.net.tr/');
doc.setMetadata({ title: 'Sözleşme', author: 'Aybars Yıldırım' });
```

Türkçe harfler Windows-1254 kodlarıyla yazılır ve `/Differences` ile doğru
gliflere (`Gbreve`, `dotlessi`, `Scedilla`…) bağlanır. Bu adım atlanırsa
okuyucu "Ağrı" yerine "Aðrý" çizer.

Mevcut içerik akışına **dokunulmaz**: yeni komutlar `q … Q` ile sarmalanıp
`/Contents` dizisine eklenir.

### Formlar

```js
doc.listFields();
// [{ name: 'ad', type: 'Tx', value: null, options: [], rect: […], page: 0, … }]

doc.fillForm({ ad: 'Aybars YILDIRIM', sehir: 'Istanbul', onay: true });
// { filled: ['ad','sehir','onay'], skipped: [] }

doc.flattenForm();
// { flattened: ['ad','sehir','onay'], kept: ['imza'] }
```

Doldurma sırasında `/AP /N` görünüm akışı üretilir; `/NeedAppearances`
bayrağına muhtaç kalınmaz. **İmza alanlarına (`/FT /Sig`) dokunulmaz** —
onlar `@fitfak/pades`'in işidir ve düzleştirilmeleri imzayı anlamsız kılar.

### Kaydetme

```js
doc.save();                        // artımlı (varsayılan) — imzalar korunur
doc.save({ full: true });          // baştan yaz — yalnız imzasız belgelerde
doc.saveAndReload();               // kaydedip yeni bir PdfDocument döndürür
```

Şifreli bir belgede artımlı kaydetme, **yeni nesneleri de belgenin anahtarıyla
şifreler**; `save({ full: true })` çıktısı ise şifresizdir.

## `@fitfak/pades` ile ilişki

PAdES yazıcısı klasik `trailer` + `xref` tablosu okur. Modern bir belge
geldiğinde `@fitfak/pades/src/utils/normalize` bu paketi kullanarak dosyanın
sonuna **klasik xref köprüsü** ekler:

```js
const { normalizePdf } = require('@fitfak/pades/src/utils/normalize');
const { pdf, normalized } = normalizePdf(chromeCiktisi);
```

Orijinal baytlar korunduğu için köprü, belgede zaten var olan imzaları bozmaz.
`PAdESManager.sign()` bunu kendiliğinden çağırır; ayrıca elle çağırmak
gerekmez.

## Düşük seviye API

```js
const { Lexer, Dict, Ref, Name, Str, Stream, serialize,
        XRef, decodeStream, tokenizeContent,
        writeIncremental, writeFull } = require('@fitfak/pdf-doc');

doc.getObject(12);                  // ham nesne
doc.resolve(new Ref(12, 0));        // referans çözümü
doc.getStreamData(stream);          // filtreler çözülmüş
doc.setObject(12, yeniDeger);       // değişiklik kaydı
doc.addObject(deger);               // → Ref

for (const { op, args } of tokenizeContent(icerik)) { … }
```

## Sınırlar

- Görsel filtreleri (DCT/JPX/CCITT/JBIG2) **çözülmez**; ham veri ve filtre adı
  döner. PDF'i düzenlemek için gerekmez, piksel okumak için gerekir.
- Sayfa rasterleştirme yoktur — bu paket PDF *üretmez ve çizmez*.
- Şifreli belgelere doğrudan imza atılamaz; önce şifre kaldırılmalıdır
  (imza sözlüğü belgenin anahtarıyla şifrelenemez).
- `/ObjStm` içine **yazılmaz**; yeni nesneler her zaman açık yazılır. Dosya
  biraz büyür, karşılığında her okuyucu (imza doğrulayıcıları dâhil) anlar.

## Test

```bash
npm run fixtures:pdf     # test/fixtures/pdf/*.pdf üretir
npm test                 # test/unit/pdf-doc.test.js
```

Fixture'lar elle üretilir (`test/fixtures/pdf/generate.js`): xref akışı, nesne
akışı, karışık filtreler, bozuk xref, RC4 şifreli, döndürülmüş sayfalar ve
AcroForm. Harici araç gerekmez ve hangi yapının sınandığı tam olarak bellidir.
