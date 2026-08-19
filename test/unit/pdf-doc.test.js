'use strict';
/**
 * @fitfak/pdf-doc — okuma, çözme ve artımlı düzenleme testleri.
 *
 * Fixture'lar `test/fixtures/pdf/generate.js` ile üretilir; harici araç
 * gerekmez. Eksikse burada otomatik üretilirler.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const {
  PdfDocument, Lexer, Dict, Ref, Name, Stream,
  serialize, textString, decodeStream,
  writeFull, rc4, flattenPageTree, encodeWinAnsi, tokenizeContent
} = require('@fitfak/pdf-doc');

const FIX = path.join(__dirname, '..', 'fixtures', 'pdf');
if (!fs.existsSync(path.join(FIX, 'xref-stream.pdf'))) {
  require(path.join(FIX, 'generate.js')).generateAll();
}

const load = (name, opts) => PdfDocument.load(fs.readFileSync(path.join(FIX, name)), opts);
const PNG = path.join(__dirname, '..', '..', 'apps', 'studio', 'favicon.png');

/* ================================================================== */
/* Lexer                                                              */
/* ================================================================== */

test('lexer: temel nesne türleri', () => {
  const parse = (src) => new Lexer(Buffer.from(src, 'latin1'), 0).parseObject();

  assert.strictEqual(parse('42'), 42);
  assert.strictEqual(parse('-3.5'), -3.5);
  assert.strictEqual(parse('true'), true);
  assert.strictEqual(parse('null'), null);
  assert.strictEqual(parse('/Ölçü#20adi').name, 'Ölçü adi');   // #20 → boşluk
  assert.deepStrictEqual(parse('[1 2 3]'), [1, 2, 3]);

  const ref = parse('12 0 R');
  assert.ok(ref instanceof Ref);
  assert.strictEqual(ref.num, 12);

  const d = parse('<< /Type /Page /Count 3 >>');
  assert.ok(d instanceof Dict);
  assert.strictEqual(d.get('Type').name, 'Page');
  assert.strictEqual(d.get('Count'), 3);
});

test('lexer: dizgi kaçışları ve onaltılık dizgiler', () => {
  const parse = (src) => new Lexer(Buffer.from(src, 'latin1'), 0).parseObject();

  assert.strictEqual(parse('(basit)').toString(), 'basit');
  assert.strictEqual(parse('(iç (içe) parantez)').toString(), 'iç (içe) parantez');
  assert.strictEqual(parse('(satör\\nsonu)').toString(), 'satör\nsonu');
  assert.strictEqual(parse('(sekiz\\101lik)').toString(), 'sekizAlik');
  assert.strictEqual(parse('<48656C6C6F>').toString(), 'Hello');
  assert.strictEqual(parse('<48656C6C6F7>').toString(), 'Hellop');   // tek hane 0 ile tamamlanır
});

test('lexer: UTF-16BE metin dizgileri Türkçe karakterleri korur', () => {
  const s = textString('Aybars YILDIRIM — Ğğİıq');
  const round = new Lexer(Buffer.from(serialize(s), 'latin1'), 0).parseObject();
  assert.strictEqual(round.toText(), 'Aybars YILDIRIM — Ğğİıq');
});

test('lexer: serialize dict/array/name kaçışlarını doğru yazar', () => {
  const d = new Dict();
  d.set('Ad', Name.get('A B'));
  d.set('Liste', [1, new Ref(3, 0), null]);
  assert.strictEqual(serialize(d), '<< /Ad /A#20B /Liste [1 3 0 R null] >>');
});

/* ================================================================== */
/* Filtreler                                                          */
/* ================================================================== */

test('filtreler: Flate + PNG predictor çözülür', () => {
  const columns = 4;
  const rows = [[10, 20, 30, 40], [11, 22, 33, 44]];

  // PNG Up (2) predictor ile kodla
  const encoded = [];
  let prev = new Array(columns).fill(0);
  for (const row of rows) {
    encoded.push(2);
    for (let i = 0; i < columns; i++) encoded.push((row[i] - prev[i]) & 0xff);
    prev = row;
  }

  const { data } = decodeStream(
    zlib.deflateSync(Buffer.from(encoded)),
    ['FlateDecode'],
    [{ Predictor: 12, Columns: columns }]
  );
  assert.deepStrictEqual([...data], [...rows[0], ...rows[1]]);
});

test('filtreler: ASCIIHex, ASCII85 ve RunLength', () => {
  assert.strictEqual(
    decodeStream(Buffer.from('48656c6c6f>', 'latin1'), ['ASCIIHexDecode'], []).data.toString(), 'Hello');

  // RunLength: 2 bayt gerçek veri ('AB') + 'C'nin 3 kopyası + EOD (128)
  const rle = Buffer.from([1, 0x41, 0x42, 254, 0x43, 128]);
  assert.strictEqual(decodeStream(rle, ['RunLengthDecode'], []).data.toString(), 'ABCCC');

  const a85 = decodeStream(Buffer.from('87cURD]i,"Ebo80~>', 'latin1'), ['ASCII85Decode'], []).data;
  assert.strictEqual(a85.toString(), 'Hello World!');
});

test('filtreler: görsel filtreleri çözülmeden geçirilir', () => {
  const raw = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
  const out = decodeStream(raw, ['DCTDecode'], []);
  assert.strictEqual(out.imageFilter, 'DCTDecode');
  assert.ok(out.data.equals(raw));
});

/* ================================================================== */
/* Çapraz başvuru yapıları                                            */
/* ================================================================== */

test('klasik xref tablosu okunur', () => {
  const doc = load('classic-xref.pdf');
  assert.strictEqual(doc.pageCount, 1);
  assert.strictEqual(doc.xref.recovered, false);
  assert.ok(doc.getPageContent(0).length > 0);
});

test('xref AKIŞI (/Type /XRef) okunur', () => {
  const doc = load('xref-stream.pdf');
  assert.strictEqual(doc.pageCount, 2);
  assert.strictEqual(doc.xref.recovered, false);
  assert.match(doc.getPageContent(0).toString('latin1'), /BT/);
  assert.strictEqual(doc.getInfo().Title, 'XRef akisli belge');
});

test('nesne akışı (/ObjStm) içindeki nesneler okunur', () => {
  const doc = load('object-stream.pdf');
  assert.strictEqual(doc.pageCount, 2);
  assert.strictEqual(doc.getInfo().Title, 'Nesne akisli belge');

  // Sayfa sözlüğü gerçekten sıkıştırılmış bir nesne mi?
  const ref = doc.pageRefs[0];
  const entry = doc.xref.getEntry(ref.num);
  assert.strictEqual(entry.type, 2, 'sayfa /ObjStm içinde olmalı');
});

test('karışık filtreler tek belgede çözülür', () => {
  const doc = load('mixed-filters.pdf');
  const content = doc.getPageContent(0).toString('latin1');
  assert.ok(content.length > 100);
  assert.match(content, /Tj/);
});

test('bozuk xref: nesneler dosya taranarak bulunur', () => {
  const doc = load('broken-xref.pdf');
  assert.strictEqual(doc.pageCount, 1);
  assert.ok(doc.getPageContent(0).length > 0);
});

test('sayfa geometrisi: MediaBox, CropBox ve /Rotate', () => {
  const doc = load('rotated-pages.pdf');

  const g0 = doc.getPageGeometry(0);
  assert.strictEqual(g0.rotate, 90);
  assert.strictEqual(Math.round(g0.width), 842, '90° dönmede en/boy takas edilir');
  assert.strictEqual(Math.round(g0.height), 595);

  const g1 = doc.getPageGeometry(1);
  assert.deepStrictEqual(g1.cropBox, [50, 50, 400, 700], 'CropBox öncelikli');
  assert.strictEqual(g1.width, 350);
});

/* ================================================================== */
/* Şifreleme                                                          */
/* ================================================================== */

test('RC4 bilinen vektörle doğrulanır', () => {
  // RFC 6229 / klasik test vektörü
  assert.strictEqual(
    rc4(Buffer.from('Key', 'latin1'), Buffer.from('Plaintext', 'latin1')).toString('hex'),
    'bbf316e8d940af0ad3');
});

test('şifreli PDF (RC4, boş kullanıcı parolası) açılır', () => {
  const doc = load('encrypted-rc4.pdf');
  assert.strictEqual(doc.isEncrypted, true);
  assert.strictEqual(doc.pageCount, 1);
  assert.match(doc.getPageContent(0).toString('latin1'), /BT/);
  assert.strictEqual(doc.getInfo().Title, 'Sifreli test belgesi');
});

test('şifreli PDF: parola ile açılır, yanlış parola reddedilir', () => {
  const doc = load('encrypted-rc4-userpwd.pdf', { password: 'gizli' });
  assert.strictEqual(doc.pageCount, 1);

  assert.throws(
    () => load('encrypted-rc4-userpwd.pdf', { password: 'yanlis' }),
    (err) => err.code === 'ERR_CRYPT_BAD_PASSWORD');
});

/* ================================================================== */
/* Artımlı yazma                                                      */
/* ================================================================== */

test('artımlı kaydetme orijinal baytlara dokunmaz', () => {
  const doc = load('classic-xref.pdf');
  const original = Buffer.from(doc.buf);

  doc.addText(0, 'ek metin', { x: 40, y: 40 });
  const out = doc.save();

  assert.ok(out.length > original.length);
  assert.ok(out.subarray(0, original.length).equals(original),
    'orijinal bayt dizisi bire bir korunmalı');
  assert.match(out.subarray(original.length).toString('latin1'), /startxref/);
});

test('değişiklik yoksa aynı Buffer geri döner', () => {
  const doc = load('classic-xref.pdf');
  assert.strictEqual(doc.save(), doc.buf);
});

test('artımlı kaydetmede /Prev önceki startxref’i gösterir', () => {
  const doc = load('classic-xref.pdf');
  const prevStart = doc.xref.findStartXref();
  doc.setMetadata({ author: 'Aybars' });

  const out = doc.save().toString('latin1');
  const m = /\/Prev\s+(\d+)/.exec(out.slice(doc.buf.length));
  assert.ok(m, 'yeni trailer /Prev taşımalı');
  assert.strictEqual(parseInt(m[1], 10), prevStart);
});

test('bozuk xref kaydedilince tam tablo yeniden kurulur', () => {
  const doc = load('broken-xref.pdf');
  doc.addText(0, 'onarim', { x: 20, y: 20 });

  const re = PdfDocument.load(doc.save());
  assert.strictEqual(re.xref.recovered, false);
  for (const [num, entry] of re.xref.entries) {
    if (entry.type !== 1) continue;
    assert.ok(re._isHeaderAt(entry.offset, num), `nesne ${num} konumu hatalı`);
  }
  assert.match(re.getPageContent(0).toString('latin1'), /onarim/);
});

test('xref akışlı belge klasik tabloya köprülenip düzenlenebilir', () => {
  const doc = load('xref-stream.pdf');
  doc.addText(1, 'ikinci sayfaya not', { x: 50, y: 120 });

  const re = PdfDocument.load(doc.save());
  assert.strictEqual(re.pageCount, 2);
  assert.match(re.getPageContent(1).toString('latin1'), /ikinci sayfaya not/);
  assert.match(re.getPageContent(0).toString('latin1'), /BT/, 'ilk sayfa bozulmamalı');
});

test('nesne akışlı belge düzenlenebilir', () => {
  const doc = load('object-stream.pdf');
  doc.rotatePage(1, 180);

  const re = PdfDocument.load(doc.save());
  assert.strictEqual(re.getPageGeometry(1).rotate, 180);
  assert.strictEqual(re.getPageGeometry(0).rotate, 0);
  assert.strictEqual(re.getInfo().Title, 'Nesne akisli belge');
});

test('şifreli belgede artımlı düzenleme: yeni nesneler de şifrelenir', () => {
  const doc = load('encrypted-rc4.pdf');
  doc.addText(0, 'sifreli ek', { x: 50, y: 50 });
  doc.setMetadata({ subject: 'gizli konu' });

  const out = doc.save();
  // Eklenen metin dosyada AÇIK hâlde bulunmamalı
  assert.ok(!out.includes(Buffer.from('sifreli ek', 'latin1')),
    'içerik şifresiz yazılmış');

  const re = PdfDocument.load(out);
  assert.strictEqual(re.isEncrypted, true);
  assert.match(re.getPageContent(0).toString('latin1'), /sifreli ek/);
  assert.strictEqual(re.getInfo().Subject, 'gizli konu');
});

test('writeFull imzasız belgeyi sıfırdan yazar ve şifreyi kaldırır', () => {
  const doc = load('encrypted-rc4.pdf');
  const out = writeFull(doc, {});

  const re = PdfDocument.load(out);
  assert.strictEqual(re.isEncrypted, false);
  assert.strictEqual(re.pageCount, 1);
  assert.match(re.getPageContent(0).toString('latin1'), /BT/);
});

/* ================================================================== */
/* Sayfa işlemleri                                                    */
/* ================================================================== */

test('sayfa sırası değiştirilir', () => {
  const doc = load('classic-xref-3p.pdf');
  const texts = [0, 1, 2].map((i) => doc.getPageContent(i).toString('latin1'));

  doc.reorderPages([2, 0, 1]);
  const re = PdfDocument.load(doc.save());

  assert.strictEqual(re.pageCount, 3);
  assert.strictEqual(re.getPageContent(0).toString('latin1'), texts[2]);
  assert.strictEqual(re.getPageContent(1).toString('latin1'), texts[0]);
});

test('sayfa silinir, son sayfa silinemez', () => {
  const doc = load('classic-xref-3p.pdf');
  doc.removePage(1);
  assert.strictEqual(PdfDocument.load(doc.save()).pageCount, 2);

  const tek = load('classic-xref.pdf');
  assert.throws(() => tek.removePage(0), (err) => err.code === 'ERR_LAST_PAGE');
  assert.throws(() => tek.removePage(7), (err) => err.code === 'ERR_PAGE_INDEX');
});

test('sayfa taşınır ve eklenir', () => {
  const doc = load('classic-xref-3p.pdf');
  const first = doc.getPageContent(0).toString('latin1');

  doc.movePage(0, 2);
  doc.insertPage(0, { size: [0, 0, 300, 400] });

  const re = PdfDocument.load(doc.save());
  assert.strictEqual(re.pageCount, 4);
  assert.strictEqual(re.getPageGeometry(0).width, 300);
  assert.strictEqual(re.getPageContent(3).toString('latin1'), first);
});

test('döndürme birikimlidir ve 90’ın katı olmayan açı reddedilir', () => {
  const doc = load('classic-xref.pdf');
  doc.rotatePage(0, 90);
  doc.rotatePage(0, 180);
  assert.strictEqual(PdfDocument.load(doc.save()).getPageGeometry(0).rotate, 270);

  assert.throws(() => load('classic-xref.pdf').rotatePage(0, 45),
    (err) => err.code === 'ERR_ROTATE_ANGLE');
});

test('flattenPageTree miras alınan alanları sayfalara indirir', () => {
  const doc = load('classic-xref-3p.pdf');
  flattenPageTree(doc);

  for (const ref of doc.pageRefs) {
    const page = doc.resolve(ref);
    assert.ok(page.has('MediaBox'), 'MediaBox sayfaya inmeli');
    assert.ok(page.has('Resources'), 'Resources sayfaya inmeli');
  }
});

/* ================================================================== */
/* İçerik ekleme                                                      */
/* ================================================================== */

test('appendContent orijinal akışa dokunmadan dizi oluşturur', () => {
  const doc = load('classic-xref.pdf');
  const before = doc.getPageContent(0).toString('latin1');

  doc.appendContent(0, '1 0 0 RG 10 10 m 100 100 l S');
  const re = PdfDocument.load(doc.save());

  const contents = re.resolve(re.getPage(0).dict.get('Contents'));
  assert.ok(Array.isArray(contents), '/Contents dizi olmalı');

  const after = re.getPageContent(0).toString('latin1');
  assert.ok(after.startsWith(before), 'orijinal içerik başta ve değişmemiş olmalı');
  assert.match(after, /q\n1 0 0 RG 10 10 m 100 100 l S\nQ/);
});

test('addText WinAnsi ile Türkçe karakterleri kodlar', () => {
  assert.strictEqual(encodeWinAnsi('Ağrı'), 'A\\360r\\375');
  assert.strictEqual(encodeWinAnsi('(a)\\b'), '\\(a\\)\\\\b');

  const doc = load('classic-xref.pdf');
  const { fontName } = doc.addText(0, 'Ağrı Dağı', { x: 10, y: 10, size: 9 });
  const re = PdfDocument.load(doc.save());

  const content = re.getPageContent(0).toString('latin1');
  assert.match(content, new RegExp(`/${fontName} 9 Tf`));
  assert.match(content, /A\\360r\\375 Da\\360\\375/);

  // Sayfada zaten /F1 varsa çakışmayan yeni bir ad seçilmeli
  const fonts = re.get(re.get(re.getPage(0).dict, 'Resources'), 'Font');
  const font = re.resolve(fonts.get(fontName));
  assert.strictEqual(font.get('BaseFont').name, 'Helvetica');

  // WinAnsi tabanlı, ama Türkçe harfler /Differences ile doğru gliflere bağlı:
  // aksi hâlde okuyucu "Ağrı" yerine "Aðrý" çizerdi.
  const encoding = re.resolve(font.get('Encoding'));
  assert.strictEqual(encoding.get('BaseEncoding').name, 'WinAnsiEncoding');
  const diffs = encoding.get('Differences');
  assert.strictEqual(diffs[0], 208);
  assert.strictEqual(diffs[1].name, 'Gbreve');
  assert.ok(diffs.some((d) => d && d.name === 'dotlessi'));

  // Yazdığımızı geri okuyabilmeliyiz
  assert.match(re.extractText(0), /Ağrı Dağı/);
});

test('addImage PNG gömer, SMask bağlar ve XObject kaydeder', () => {
  const doc = load('classic-xref.pdf');
  const info = doc.addImage(0, fs.readFileSync(PNG), { x: 50, y: 500, width: 120 });
  assert.ok(info.width > 0 && info.height > 0);

  const re = PdfDocument.load(doc.save());
  assert.match(re.getPageContent(0).toString('latin1'), /\/Im1 Do/);

  const xo = re.get(re.get(re.getPage(0).dict, 'Resources'), 'XObject');
  const img = re.resolve(xo.get('Im1'));
  assert.ok(img instanceof Stream);
  assert.strictEqual(img.dict.get('Subtype').name, 'Image');
  assert.strictEqual(img.dict.get('Width'), info.width);

  const smask = img.dict.get('SMask');
  assert.ok(smask instanceof Ref, 'SMask gerçek bir referans olmalı');
  const mask = re.resolve(smask);
  assert.strictEqual(mask.dict.get('ColorSpace').name, 'DeviceGray');

  // Ham RGB verisi çözülebilmeli (çift sıkıştırma yok)
  assert.strictEqual(re.getStreamData(img).length, info.width * info.height * 3);
});

test('addImage saydamlık ve döndürme uygular', () => {
  const doc = load('classic-xref.pdf');
  doc.addImage(0, fs.readFileSync(PNG), { x: 10, y: 10, width: 50, opacity: 0.4, rotate: 45 });

  const re = PdfDocument.load(doc.save());
  const content = re.getPageContent(0).toString('latin1');
  assert.match(content, /\/GS1 gs/);
  assert.match(content, /0\.707 0\.707 -0\.707 0\.707 0 0 cm/);

  const gsGroup = re.get(re.get(re.getPage(0).dict, 'Resources'), 'ExtGState');
  const gs = re.resolve(gsGroup.get('GS1'));
  assert.strictEqual(gs.get('ca'), 0.4);
});

test('addLink /Annots dizisine URI eylemi ekler', () => {
  const doc = load('classic-xref.pdf');
  doc.addLink(0, { x: 10, y: 20, width: 100, height: 30 }, 'https://aybars.net.tr/');

  const re = PdfDocument.load(doc.save());
  const annots = re.get(re.getPage(0).dict, 'Annots');
  assert.strictEqual(annots.length, 1);

  const annot = re.resolve(annots[0]);
  assert.strictEqual(annot.get('Subtype').name, 'Link');
  assert.deepStrictEqual(annot.get('Rect'), [10, 20, 110, 50]);
  assert.strictEqual(re.resolve(annot.get('A')).get('URI').toString(), 'https://aybars.net.tr/');
});

test('setMetadata /Info günceller ve ModDate yazar', () => {
  const doc = load('classic-xref.pdf');
  doc.setMetadata({ title: 'Şirket Sözleşmesi', author: 'Aybars Yıldırım', keywords: ['imza', 'pades'] });

  const info = PdfDocument.load(doc.save()).getInfo();
  assert.strictEqual(info.Title, 'Şirket Sözleşmesi');
  assert.strictEqual(info.Author, 'Aybars Yıldırım');
  assert.strictEqual(info.Keywords, 'imza, pades');
  assert.match(info.ModDate, /^D:\d{14}Z$/);
});

/* ================================================================== */
/* Birleştirme                                                        */
/* ================================================================== */

test('importPages sayfaları nesne numaralarını yeniden eşleyerek kopyalar', () => {
  const hedef = load('classic-xref.pdf');
  const kaynak = load('classic-xref-3p.pdf');
  const kaynakMetin = kaynak.getPageContent(1).toString('latin1');

  const imported = hedef.importPages(kaynak, [1, 2]);
  assert.strictEqual(imported.length, 2);

  const re = PdfDocument.load(hedef.save());
  assert.strictEqual(re.pageCount, 3);
  assert.strictEqual(re.getPageContent(1).toString('latin1'), kaynakMetin);
  assert.ok(re.getPageGeometry(1).width > 0);
});

test('importPages xref akışlı kaynaktan da çalışır', () => {
  const hedef = load('classic-xref.pdf');
  const kaynak = load('xref-stream.pdf');

  hedef.importPages(kaynak);
  const re = PdfDocument.load(hedef.save());

  assert.strictEqual(re.pageCount, 3);
  assert.match(re.getPageContent(2).toString('latin1'), /BT/);
});

/* ================================================================== */
/* Sınırlar                                                           */
/* ================================================================== */

test('geçersiz girdiler anlaşılır hata verir', () => {
  assert.throws(() => PdfDocument.load('bu bir buffer değil'),
    (err) => err.code === 'ERR_PDF_INPUT');

  const doc = load('classic-xref.pdf');
  assert.throws(() => doc.getPage(9), (err) => err.code === 'ERR_PDF_NO_PAGE');
  assert.throws(() => doc.addImage(0, 'png değil', { x: 0, y: 0, width: 10 }),
    (err) => err.code === 'ERR_IMAGE_INPUT');
});

test('çözülemeyen nesne null döner, belge çökmez', () => {
  const doc = load('classic-xref.pdf');
  assert.strictEqual(doc.getObject(9999), null);
  assert.strictEqual(doc.resolve(new Ref(9999, 0)), null);
});

/* ================================================================== */
/* Metin çıkarımı                                                     */
/* ================================================================== */

test('metin çıkarımı: satırlar ve kelime araları', () => {
  const doc = load('classic-xref-3p.pdf');
  const text = doc.extractText(0);
  assert.match(text, /Klasik xref/);
  assert.strictEqual(text.split('\n').length, 1);
});

test('metin çıkarımı: parçalar konumlarıyla döner', () => {
  const doc = load('classic-xref.pdf');
  const items = doc.extractTextItems(0);

  assert.ok(items.length > 0);
  const first = items[0];
  assert.strictEqual(Math.round(first.x), 60);
  assert.strictEqual(Math.round(first.y), 700);
  assert.strictEqual(first.fontSize, 24);
  assert.ok(first.width > 0, 'genişlik font /Widths olmadan da tahmin edilmeli');
});

test('metin çıkarımı: /Differences ile Türkçe geri okunur', () => {
  const doc = load('classic-xref.pdf');
  doc.addText(0, 'Ağrı Dağı — İstanbul Şişli (öğün) ÇOK', { x: 40, y: 300, size: 12 });

  const re = PdfDocument.load(doc.save());
  assert.match(re.extractText(0), /Ağrı Dağı — İstanbul Şişli \(öğün\) ÇOK/);
});

test('metin çıkarımı: TJ dizisi ve Tm matrisi işlenir', () => {
  const doc = load('classic-xref.pdf');
  doc.appendContent(0,
    'BT /F1 10 Tf 1 0 0 1 100 400 Tm [(Kal) -200 (dirim)] TJ ET');

  const re = PdfDocument.load(doc.save());
  const items = re.extractTextItems(0).filter((i) => /Kal|dirim/.test(i.text));
  assert.strictEqual(items.length, 2);
  assert.strictEqual(Math.round(items[0].x), 100);
  assert.ok(items[1].x > items[0].x, 'ikinci parça sağda olmalı');
  assert.match(re.extractText(0), /Kaldirim|Kal dirim/);
});

test('metin çıkarımı: Form XObject içine inilir', () => {
  const doc = load('acroform.pdf');
  doc.fillForm({ ad: 'Aybars YILDIRIM' });
  doc.flattenForm();

  const re = PdfDocument.load(doc.save());
  assert.match(re.extractText(0), /Aybars YILDIRIM/,
    'düzleştirilen alanın metni Form XObject içinde yaşar');
});

test('metin çıkarımı: belge geneli sayfa ayracıyla birleşir', () => {
  const doc = load('classic-xref-3p.pdf');
  const text = doc.extractDocumentText();
  assert.strictEqual(text.split('\f').length, 3);
});

/* ================================================================== */
/* AcroForm                                                           */
/* ================================================================== */

test('form alanları tür, seçenek ve konumlarıyla listelenir', () => {
  const doc = load('acroform.pdf');
  assert.strictEqual(doc.hasForm, true);

  const fields = new Map(doc.listFields().map((f) => [f.name, f]));
  assert.deepStrictEqual([...fields.keys()].sort(),
    ['ad', 'adres', 'cinsiyet', 'imza', 'onay', 'sehir']);

  assert.strictEqual(fields.get('ad').type, 'Tx');
  assert.strictEqual(fields.get('ad').multiline, false);
  assert.deepStrictEqual(fields.get('ad').rect, [140, 720, 400, 740]);
  assert.strictEqual(fields.get('ad').page, 0);

  assert.strictEqual(fields.get('adres').multiline, true, '/Ff bit 13 çok satırlı demek');
  assert.deepStrictEqual(fields.get('sehir').options, ['Ankara', 'Istanbul', 'Izmir']);
  assert.strictEqual(fields.get('sehir').value, 'Ankara');
  assert.strictEqual(fields.get('cinsiyet').radio, true);
  assert.strictEqual(fields.get('cinsiyet').widgets.length, 2);
  assert.strictEqual(fields.get('imza').type, 'Sig');
});

test('form doldurulur, imza alanına dokunulmaz', () => {
  const doc = load('acroform.pdf');
  const report = doc.fillForm({
    ad: 'Aybars YILDIRIM',
    adres: 'Örnek Mah.\nÇiçek Sok. No:7',
    sehir: 'Istanbul',
    onay: true,
    cinsiyet: 'E',
    imza: 'buraya yazılamaz',
    olmayanAlan: 'x'
  });

  assert.deepStrictEqual(report.filled.sort(), ['ad', 'adres', 'cinsiyet', 'onay', 'sehir']);
  assert.deepStrictEqual(report.skipped.map((s) => s.name).sort(), ['imza', 'olmayanAlan']);

  const re = PdfDocument.load(doc.save());
  const fields = new Map(re.listFields().map((f) => [f.name, f]));
  assert.strictEqual(fields.get('ad').value, 'Aybars YILDIRIM');
  assert.strictEqual(fields.get('adres').value, 'Örnek Mah.\nÇiçek Sok. No:7');
  assert.strictEqual(fields.get('sehir').value, 'Istanbul');
  assert.strictEqual(fields.get('onay').value, 'Yes');
  assert.strictEqual(fields.get('cinsiyet').value, 'E');
  assert.strictEqual(fields.get('imza').value, null);
});

test('doldurma görünüm akışı üretir; NeedAppearances kapanır', () => {
  const doc = load('acroform.pdf');
  doc.fillForm({ ad: 'Test' });

  const re = PdfDocument.load(doc.save());
  const acro = re.resolve(re.catalog.get('AcroForm'));
  assert.strictEqual(acro.get('NeedAppearances'), false);

  const field = re.listFields().find((f) => f.name === 'ad');
  const widget = re.resolve(field.widgets[0]);
  const ap = re.resolve(widget.get('AP'));
  const normal = re.resolve(ap.get('N'));

  assert.ok(normal instanceof Stream, '/AP /N görünüm akışı olmalı');
  assert.deepStrictEqual(normal.dict.get('BBox'), [0, 0, 260, 20]);
  assert.match(re.getStreamData(normal).toString('latin1'), /\(Test\) Tj/);
});

test('radyo düğmesinde yalnız eşleşen widget seçilir', () => {
  const doc = load('acroform.pdf');
  doc.fillForm({ cinsiyet: 'K' });

  const re = PdfDocument.load(doc.save());
  const field = re.listFields().find((f) => f.name === 'cinsiyet');
  const states = field.widgets.map((w) => {
    const as = re.resolve(w).get('AS');
    return as ? as.name : null;
  });
  assert.deepStrictEqual(states, ['K', 'Off']);
});

test('form düzleştirilir, imza alanı korunur', () => {
  const doc = load('acroform.pdf');
  doc.fillForm({ ad: 'Aybars', sehir: 'Izmir', onay: true });

  const report = doc.flattenForm();
  assert.ok(report.flattened.includes('ad'));
  assert.deepStrictEqual(report.kept, ['imza']);

  const re = PdfDocument.load(doc.save());
  assert.deepStrictEqual(re.listFields().map((f) => f.name), ['imza']);

  // Widget'lar sayfadan kaldırılmış, görünümler içeriğe bağlanmış olmalı
  const annots = re.get(re.getPage(0).dict, 'Annots');
  assert.strictEqual(annots.length, 1, 'yalnız imza widget’ı kalmalı');
  assert.match(re.getPageContent(0).toString('latin1'), /\/Fx\d+ Do/);
  assert.match(re.extractText(0), /Aybars/);
});

test('yalnız seçili alanlar düzleştirilebilir', () => {
  const doc = load('acroform.pdf');
  doc.fillForm({ ad: 'A', sehir: 'Izmir' });
  const report = doc.flattenForm({ only: ['ad'] });

  assert.deepStrictEqual(report.flattened, ['ad']);
  const re = PdfDocument.load(doc.save());
  assert.ok(re.listFields().map((f) => f.name).includes('sehir'));
});

test('formsuz belgede fillForm anlaşılır hata verir', () => {
  assert.throws(() => load('classic-xref.pdf').fillForm({ a: 'b' }),
    (err) => err.code === 'ERR_NO_ACROFORM');

  assert.throws(() => load('acroform.pdf').fillForm({ yok: 'x' }, { strict: true }),
    (err) => err.code === 'ERR_FIELD_NOT_FOUND');
});

/* ================================================================== */
/* İçerik akışı tarayıcısı                                            */
/* ================================================================== */

test('içerik tarayıcısı operatör ve işlenenleri ayırır', () => {
  const ops = [...tokenizeContent(Buffer.from(
    'q 1 0 0 1 10 20 cm /Im1 Do Q BT /F1 12 Tf (metin) Tj ET', 'latin1'))];

  const names = ops.map((o) => o.op);
  assert.deepStrictEqual(names, ['q', 'cm', 'Do', 'Q', 'BT', 'Tf', 'Tj', 'ET']);
  assert.deepStrictEqual(ops[1].args, [1, 0, 0, 1, 10, 20]);
  assert.strictEqual(ops[2].args[0].name, 'Im1');
  assert.strictEqual(ops[6].args[0].toString(), 'metin');
});

test('içerik tarayıcısı satır içi görselleri atlar', () => {
  const data = Buffer.concat([
    Buffer.from('q BI /W 2 /H 2 /BPC 8 /CS /G ID ', 'latin1'),
    Buffer.from([0x51, 0x42, 0x00, 0xFF]),          // içinde 'Q' baytı var
    Buffer.from(' EI Q 1 0 0 RG', 'latin1')
  ]);

  const ops = [...tokenizeContent(data)].map((o) => o.op);
  assert.deepStrictEqual(ops, ['q', 'Q', 'RG'], 'ikili veri operatör sanılmamalı');
});

test('addResource miras alınan /Resources sözlüğünü gölgelemez', () => {
  // rotated-pages.pdf'te /Resources üst düğümde (/Pages) durur
  const doc = load('rotated-pages.pdf');
  const page = doc.getPage(0).dict;
  assert.ok(!page.has('Resources'), 'fixture mirası sınamalı');

  const inherited = doc.getPageProperty(page, 'Resources');
  const inheritedFonts = [...doc.resolve(inherited.get('Font')).map.keys()];
  assert.deepStrictEqual(inheritedFonts, ['F1']);

  doc.addText(0, 'yeni', { x: 10, y: 10 });
  const re = PdfDocument.load(doc.save());

  const fonts = re.get(re.get(re.getPage(0).dict, 'Resources'), 'Font');
  const names = [...fonts.map.keys()].sort();
  assert.ok(names.includes('F1'), 'orijinal /F1 korunmalı — içerik onu kullanıyor');
  assert.strictEqual(names.length, 2, 'yeni font çakışmayan bir adla eklenmeli');

  // İkinci sayfa hâlâ mirası kullanmalı (kopya ona sızmamalı)
  assert.ok(!re.getPage(1).dict.has('Resources'));
  assert.match(re.getPageContent(0).toString('latin1'), /Dondurulmus sayfa/);
});
