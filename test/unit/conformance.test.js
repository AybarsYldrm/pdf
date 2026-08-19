'use strict';
/**
 * @fitfak/conformance — PDF/A ve PDF/UA denetimi.
 *
 * Testlerin mantığı: aynı HTML'i farklı uyumluluk profilleriyle üretiyoruz ve
 * denetleyicinin hem UYUMLU hem UYUMSUZ durumu doğru raporladığını sınıyoruz.
 * "Her şey geçti" diyen bir denetleyici işe yaramaz; kasıtlı ihlallerin
 * yakalandığını göstermek asıl kanıttır.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const conf = require('@fitfak/conformance');
const { sRGBProfile, readProfileHeader, buildXmp, parseXmp } = conf;
const { render } = require('@fitfak/pdf-html');
const paper = require('@fitfak/paper');
const { PdfDocument, Dict, Name, Stream } = require('@fitfak/pdf-doc');

const ROOT = path.join(__dirname, '..', '..');
const FONT = path.join(ROOT, 'assets', 'Ubuntu-Regular.ttf');
const LOGO = path.join(ROOT, 'apps', 'studio', 'favicon.png');

const DOC = `<!doctype html><html lang="tr"><body>
  <h1>Sözleşme</h1>
  <p>Giriş paragrafı. <a href="https://aybars.net.tr/">Bağlantı</a> içerir.</p>
  <h2>Taraflar</h2>
  <ul><li>Birinci madde</li><li>İkinci madde</li></ul>
  <table>
    <thead><tr><th>Ürün</th><th>Tutar</th></tr></thead>
    <tbody><tr><td>Çelik levha</td><td>1.250,00</td></tr></tbody>
  </table>
</body></html>`;

function build(html, conformance, metadata = {}) {
  return render({
    html,
    css: paper.bundle({ theme: 'kurumsal' }),
    fonts: [{ family: 'Ubuntu', src: FONT }],
    baseDir: ROOT,
    metadata: { title: 'Sözleşme Örneği', author: 'Aybars Yıldırım', lang: 'tr-TR', ...metadata },
    conformance
  });
}

/* ================================================================== */
/* ICC profili                                                        */
/* ================================================================== */

test('sRGB ICC profili geçerli ve deterministik', () => {
  const icc = sRGBProfile();

  assert.ok(icc.length > 300 && icc.length < 4096, `beklenmeyen boyut: ${icc.length}`);
  assert.strictEqual(icc.readUInt32BE(0), icc.length, 'başlıktaki boyut gerçek boyutla eşleşmeli');
  assert.strictEqual(icc.toString('latin1', 36, 40), 'acsp', 'ICC dosya imzası');
  assert.ok(sRGBProfile().equals(icc), 'aynı çıktı — tekrarlanabilir derleme');

  const header = readProfileHeader(icc);
  assert.strictEqual(header.colorSpace, 'RGB');
  assert.strictEqual(header.pcs, 'XYZ');
  assert.strictEqual(header.deviceClass, 'mntr');
  assert.strictEqual(header.tagCount, 9);
});

test('ICC etiket tablosu tutarlı ve 4 bayta hizalı', () => {
  const icc = sRGBProfile();
  const count = icc.readUInt32BE(128);

  const required = new Set(['desc', 'wtpt', 'rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC', 'cprt']);
  for (let i = 0; i < count; i++) {
    const at = 132 + i * 12;
    const name = icc.toString('latin1', at, at + 4);
    const offset = icc.readUInt32BE(at + 4);
    const size = icc.readUInt32BE(at + 8);

    assert.ok(offset % 4 === 0, `${name} etiketi 4 bayta hizalı değil`);
    assert.ok(offset + size <= icc.length, `${name} etiketi dosya dışına taşıyor`);
    required.delete(name);
  }
  assert.strictEqual(required.size, 0, `eksik zorunlu etiketler: ${[...required]}`);
});

test('bozuk ICC verisi reddedilir', () => {
  assert.strictEqual(readProfileHeader(Buffer.alloc(64)), null);
  assert.strictEqual(readProfileHeader(Buffer.from('bu ICC değil')), null);
});

/* ================================================================== */
/* XMP                                                                */
/* ================================================================== */

test('XMP üretilir ve geri okunur', () => {
  const xmp = buildXmp({
    title: 'Şirket Sözleşmesi', author: 'Aybars Yıldırım',
    subject: 'Örnek', lang: 'tr-TR', pdfA: '2b', pdfUA: true
  });

  const parsed = parseXmp(xmp);
  assert.strictEqual(parsed.title, 'Şirket Sözleşmesi', 'UTF-8 Türkçe korunmalı');
  assert.strictEqual(parsed.creator, 'Aybars Yıldırım');
  assert.strictEqual(parsed.pdfA, '2b');
  assert.strictEqual(parsed.pdfUA, 1);
});

test('XMP ayrıştırıcısı rdf:Description ile dc:description’ı karıştırmaz', () => {
  const parsed = parseXmp(buildXmp({ title: 'Başlık', subject: 'Konu' }));
  assert.strictEqual(parsed.description, 'Konu');
  assert.strictEqual(parsed.pdfA, null, 'iddia yoksa null olmalı');
});

test('XMP kaçışları XML’i bozmaz', () => {
  const xmp = buildXmp({ title: 'A & B <script>', author: '"tırnak"' }).toString('utf8');
  assert.ok(xmp.includes('A &amp; B &lt;script&gt;'));
  assert.strictEqual(parseXmp(xmp).title, 'A & B <script>');
});

/* ================================================================== */
/* PDF/A                                                              */
/* ================================================================== */

test('conformance verilmeyen belge PDF/A denetimini geçmez', () => {
  const { pdf } = build(DOC, null);
  const report = conf.check(pdf, { profiles: ['pdf/a-2b'] });

  assert.strictEqual(report.conforms, false);
  const clauses = report.pdfA.errors.map((e) => e.clause);
  assert.ok(clauses.includes('6.2.2'), 'çıktı amacı eksikliği yakalanmalı');
  assert.ok(clauses.includes('6.7.2'), 'pdfaid iddiası eksikliği yakalanmalı');
});

test('PDF/A-2b ile üretilen belge denetimi geçer', () => {
  const { pdf, conformance } = build(DOC, 'pdf/a-2b');
  assert.deepStrictEqual(conformance, { pdfA: '2b', pdfUA: false, tagged: false });

  const report = conf.check(pdf);
  assert.deepStrictEqual(report.profiles, ['pdf/a-2b'], 'profil XMP iddiasından okunur');
  assert.strictEqual(report.conforms, true,
    report.pdfA.errors.map((e) => `[${e.clause}] ${e.message}`).join('; '));
  assert.strictEqual(report.pdfA.claimed, 'PDF/A-2B');
});

test('PDF/A belgesi gömülü sRGB çıktı amacı taşır', () => {
  const { pdf } = build(DOC, 'pdf/a-2b');
  const doc = PdfDocument.load(pdf);

  const intents = doc.get(doc.catalog, 'OutputIntents');
  assert.ok(Array.isArray(intents) && intents.length === 1);

  const intent = doc.resolve(intents[0]);
  assert.strictEqual(intent.get('S').name, 'GTS_PDFA1');

  const profile = doc.resolve(intent.get('DestOutputProfile'));
  assert.ok(profile instanceof Stream);
  assert.strictEqual(profile.dict.get('N'), 3, 'RGB profili 3 bileşenlidir');

  const icc = doc.getStreamData(profile);
  assert.strictEqual(readProfileHeader(icc).colorSpace, 'RGB');
});

test('PDF/A: XMP ile /Info tutarlıdır (Türkçe karakterler dâhil)', () => {
  const { pdf } = build(DOC, 'pdf/a-2b');
  const doc = PdfDocument.load(pdf);

  const info = doc.getInfo();
  const xmp = parseXmp(doc.getStreamData(doc.get(doc.catalog, 'Metadata')));

  assert.strictEqual(info.Title, 'Sözleşme Örneği');
  assert.strictEqual(xmp.title, info.Title, 'XMP latin1 yazılırsa burada bozulurdu');
  assert.strictEqual(xmp.creator, info.Author);
});

test('PDF/A: fontlar gömülüdür, LZW kullanılmaz', () => {
  const { pdf } = build(DOC, 'pdf/a-2b');
  const report = conf.check(pdf, { profiles: ['pdf/a-2b'] });

  assert.ok(report.pdfA.checked.includes('6.2.11'));
  assert.ok(report.pdfA.checked.includes('6.1.7'));
  assert.strictEqual(report.pdfA.errors.filter((e) => e.clause === '6.2.11').length, 0);
});

test('PDF/A: şifreli belge reddedilir', () => {
  const fixtures = path.join(ROOT, 'test', 'fixtures', 'pdf');
  if (!fs.existsSync(path.join(fixtures, 'encrypted-rc4.pdf'))) {
    require(path.join(fixtures, 'generate.js')).generateAll();
  }
  const doc = PdfDocument.load(fs.readFileSync(path.join(fixtures, 'encrypted-rc4.pdf')));
  const report = conf.checkPdfA(doc, { part: 2, level: 'b' });

  assert.strictEqual(report.conforms, false);
  assert.ok(report.errors.some((e) => e.clause === '6.1.3' && /şifreli/i.test(e.message)));
});

/* ================================================================== */
/* PDF/UA                                                             */
/* ================================================================== */

test('PDF/UA ile üretilen belge denetimi geçer', () => {
  const { pdf, conformance } = build(DOC, 'pdf/ua');
  assert.strictEqual(conformance.tagged, true, 'PDF/UA etiketlemeyi zorunlu açar');

  const report = conf.check(pdf);
  assert.strictEqual(report.conforms, true,
    report.pdfUA.errors.map((e) => `[${e.rule}] ${e.message}`).join('; '));
  assert.strictEqual(report.pdfUA.claimed, true);
});

test('PDF/UA yapı ağacı HTML anlamını korur', () => {
  const { pdf } = build(DOC, 'pdf/ua');
  const report = conf.check(pdf, { profiles: ['pdf/ua'] });
  const roles = report.pdfUA.structure.roles;

  assert.strictEqual(roles.H1, 1);
  assert.strictEqual(roles.H2, 1);
  assert.strictEqual(roles.L, 1, '<ul> → L');
  assert.strictEqual(roles.LI, 2);
  assert.strictEqual(roles.Table, 1);
  assert.strictEqual(roles.TH, 2, '<th> → TH');
  assert.strictEqual(roles.TD, 2);
  assert.ok(roles.Link >= 1, '<a> → Link');
  assert.deepStrictEqual(report.pdfUA.structure.headings, [1, 2]);
});

test('PDF/UA: liste öğeleri Lbl + LBody taşır', () => {
  const { pdf } = build(DOC, 'pdf/ua');
  const report = conf.check(pdf, { profiles: ['pdf/ua'] });

  assert.strictEqual(report.pdfUA.structure.roles.Lbl, 2, 'liste işaretleri etiketlenmeli');
  assert.strictEqual(report.pdfUA.structure.roles.LBody, 2);
  assert.strictEqual(report.pdfUA.warnings.filter((w) => w.rule === '15').length, 0);
});

test('PDF/UA: etiketsiz belge yakalanır', () => {
  const { pdf } = build(DOC, null);
  const report = conf.check(pdf, { profiles: ['pdf/ua'] });

  assert.strictEqual(report.conforms, false);
  const rules = report.pdfUA.errors.map((e) => e.rule);
  assert.ok(rules.includes('01'), 'etiketsizlik 01 numaralı kuralla bildirilmeli');
});

test('PDF/UA: alternatif metni olmayan görsel yakalanır', () => {
  const html = `<!doctype html><html lang="tr"><body><h1>Başlık</h1>
    <p><img src="${LOGO}" width="40"></p></body></html>`;

  const without = conf.check(build(html, 'pdf/ua').pdf, { profiles: ['pdf/ua'] });
  assert.strictEqual(without.conforms, false);
  assert.ok(without.pdfUA.errors.some((e) => e.rule === '13'));
  assert.strictEqual(without.pdfUA.structure.figures, 1, 'satır içi görsel de Figure olmalı');

  const withAlt = html.replace('width="40"', 'width="40" alt="Kurum logosu"');
  const good = conf.check(build(withAlt, 'pdf/ua').pdf, { profiles: ['pdf/ua'] });
  assert.strictEqual(good.conforms, true,
    good.pdfUA.errors.map((e) => e.message).join('; '));
});

test('PDF/UA: role="presentation" görseli yapay sayılır', () => {
  const html = `<!doctype html><html lang="tr"><body><h1>Başlık</h1>
    <p><img src="${LOGO}" width="40" role="presentation"></p></body></html>`;

  const report = conf.check(build(html, 'pdf/ua').pdf, { profiles: ['pdf/ua'] });
  assert.strictEqual(report.pdfUA.structure.figures, 0, 'süsleme Figure açmamalı');
  assert.strictEqual(report.conforms, true);
});

test('PDF/UA: başlık düzeyi atlaması yakalanır', () => {
  const html = '<!doctype html><html lang="tr"><body><h1>Bir</h1><h3>Üç</h3><p>metin</p></body></html>';
  const report = conf.check(build(html, 'pdf/ua').pdf, { profiles: ['pdf/ua'] });

  assert.strictEqual(report.conforms, false);
  assert.ok(report.pdfUA.errors.some((e) => e.rule === '09' && /H1 sonrası H3/.test(e.message)));
});

test('PDF/UA: belge başlığı zorunludur', () => {
  const html = '<!doctype html><html lang="tr"><body><h1>Bir</h1><p>metin</p></body></html>';
  const { pdf, warnings } = build(html, 'pdf/ua', { title: undefined });

  assert.ok(warnings.some((w) => w.type === 'conformance'),
    'render zaten uyarmalı — sessizce geçersiz belge üretmemeli');

  const report = conf.check(pdf, { profiles: ['pdf/ua'] });
  assert.ok(report.pdfUA.errors.some((e) => e.rule === '06'));
});

test('PDF/UA: bağlantılar açıklama taşır ve yapıya bağlıdır', () => {
  const { pdf } = build(DOC, 'pdf/ua');
  const doc = PdfDocument.load(pdf);

  const annots = doc.get(doc.getPage(0).dict, 'Annots');
  assert.ok(Array.isArray(annots) && annots.length >= 1);

  const annot = doc.resolve(annots[0]);
  assert.strictEqual(annot.get('Subtype').name, 'Link');
  assert.ok(annot.has('Contents'), 'erişilebilir açıklama');
  assert.ok(Number.isFinite(annot.get('StructParent')), 'yapı ağacına geri bağ');
  assert.strictEqual(Number(annot.get('F')) & 4, 4, 'Print bayrağı (PDF/A da ister)');
});

test('PDF/UA: sayfa /StructParents taşır ve etiketlenmemiş içerik kalmaz', () => {
  const { pdf } = build(DOC, 'pdf/ua');
  const doc = PdfDocument.load(pdf);

  assert.strictEqual(doc.getPage(0).dict.get('StructParents'), 0);

  const report = conf.check(pdf, { profiles: ['pdf/ua'] });
  assert.strictEqual(report.pdfUA.errors.filter((e) => e.rule === '01').length, 0);
  assert.strictEqual(report.pdfUA.warnings.filter((w) => w.rule === '01').length, 0);
});

/* ================================================================== */
/* Birleşik profil ve rapor                                           */
/* ================================================================== */

test('PDF/A + PDF/UA birlikte iddia edilebilir', () => {
  const { pdf, conformance } = build(DOC, 'pdf/a-2b+pdf/ua');
  assert.deepStrictEqual(conformance, { pdfA: '2b', pdfUA: true, tagged: true });

  const report = conf.check(pdf);
  assert.deepStrictEqual(report.profiles.sort(), ['pdf/a-2b', 'pdf/ua']);
  assert.strictEqual(report.conforms, true,
    [...(report.pdfA.errors), ...(report.pdfUA.errors)].map((e) => e.message).join('; '));
});

test('etiketleme çizim işlemlerini DEĞİŞTİRMEZ', () => {
  const { tokenizeContent } = require('@fitfak/pdf-doc');

  const ops = (pdf) => {
    const doc = PdfDocument.load(pdf);
    const out = [];
    for (const { op, args } of tokenizeContent(doc.getPageContent(0))) {
      if (op === 'BDC' || op === 'BMC' || op === 'EMC') continue;
      out.push(op + ' ' + args.map(String).join(' '));
    }
    return out;
  };

  const plain = ops(build(DOC, null).pdf);
  const tagged = ops(build(DOC, 'pdf/ua').pdf);
  assert.deepStrictEqual(tagged, plain,
    'etiketleme yalnız işaret ekler; yerleşim ve çizim aynı kalmalı');
});

test('bilinmeyen profil uyarı üretir, üretimi durdurmaz', () => {
  const { pdf, warnings, conformance } = build(DOC, 'pdf/zzz');
  assert.strictEqual(conformance, null);
  assert.ok(warnings.some((w) => w.type === 'conformance'));
  assert.ok(pdf.length > 1000, 'belge yine de üretilmeli');
});

test('formatReport okunabilir metin üretir', () => {
  const report = conf.check(build(DOC, 'pdf/a-2b+pdf/ua').pdf);
  const text = conf.formatReport(report);

  assert.match(text, /Profiller: pdf\/a-2b, pdf\/ua/);
  assert.match(text, /Sonuç:\s+UYUMLU/);
  assert.match(text, /── PDF\/A-2b ──/);
  assert.match(text, /── PDF\/UA-1 ──/);
  assert.match(text, /denetlenen maddeler: 6\.1\.2/);
});

test('detectClaims XMP iddialarını okur', () => {
  assert.deepStrictEqual(
    conf.detectClaims(PdfDocument.load(build(DOC, 'pdf/a-3b').pdf)), ['pdf/a-3b']);
  assert.deepStrictEqual(
    conf.detectClaims(PdfDocument.load(build(DOC, null).pdf)), []);
});
