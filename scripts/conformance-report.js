#!/usr/bin/env node
'use strict';
/**
 * Uyumluluk raporu üreteci — `docs/conformance/RAPOR.md`.
 *
 * Amaç: "PDF/A destekliyoruz" demek yerine, **hangi profilin hangi belge
 * tipinde hangi maddelerden geçtiğini** tarih ve sürümle birlikte kayda
 * geçirmek. Rapor her koşuda sıfırdan üretilir; elle düzenlenmez.
 *
 * Kullanım: npm run conformance:report
 */

const fs = require('fs');
const path = require('path');

const { render } = require('@fitfak/pdf-html');
const paper = require('@fitfak/paper');
const conformance = require('@fitfak/conformance');
const { PdfDocument } = require('@fitfak/pdf-doc');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'conformance');
const SAMPLE_DIR = path.join(OUT_DIR, 'ornekler');
const FONT = path.join(ROOT, 'assets', 'Ubuntu-Regular.ttf');
const LOGO = path.join(ROOT, 'apps', 'studio', 'favicon.png');

/* ------------------------------------------------------------------ */
/* Belge tipleri                                                       */
/* ------------------------------------------------------------------ */

const DOCUMENTS = {
  'resmi-yazi': {
    title: 'Resmî Yazı',
    metadata: { title: 'Resmî Bilgilendirme Yazısı', author: 'Aybars Yıldırım', lang: 'tr-TR' },
    html: `<!doctype html><html lang="tr"><body>
      <h1>Resmî Bilgilendirme Yazısı</h1>
      <p>Sayın ilgili, bu belge PAdES altyapısıyla imzalanmak üzere üretilmiştir.</p>
      <h2>Gerekçe</h2>
      <p>İlgili mevzuat uyarınca bilgilendirme yapılmaktadır.</p>
      <p>Ayrıntı için <a href="https://aybars.net.tr/">kurumsal sayfamıza</a> bakınız.</p>
    </body></html>`
  },

  'tablo-rapor': {
    title: 'Tablolu Rapor',
    metadata: { title: 'Üç Aylık Faaliyet Raporu', author: 'FITFAK', lang: 'tr-TR' },
    html: `<!doctype html><html lang="tr"><body>
      <h1>Üç Aylık Faaliyet Raporu</h1>
      <h2>Malzeme Dökümü</h2>
      <table>
        <thead><tr><th scope="col">Ürün</th><th scope="col">Adet</th><th scope="col">Tutar</th></tr></thead>
        <tbody>
          <tr><td>Çelik levha</td><td>120</td><td>1.250,00</td></tr>
          <tr><td>Bakır tel</td><td>45</td><td>430,00</td></tr>
          <tr><td>Şerit conta</td><td>8</td><td>92,50</td></tr>
        </tbody>
      </table>
      <h2>Değerlendirme</h2>
      <p>Dönem hedefleri karşılanmıştır.</p>
    </body></html>`
  },

  'listeli-sozlesme': {
    title: 'Listeli Sözleşme',
    metadata: { title: 'Hizmet Sözleşmesi', author: 'Aybars Yıldırım', lang: 'tr-TR' },
    html: `<!doctype html><html lang="tr"><body>
      <h1>Hizmet Sözleşmesi</h1>
      <h2>Taraflar</h2>
      <ul><li>Birinci taraf: FITFAK</li><li>İkinci taraf: Müşteri</li></ul>
      <h2>Yükümlülükler</h2>
      <ol><li>Teslim süresi otuz gündür.</li><li>Ödeme peşin yapılır.</li></ol>
      <h3>İstisnalar</h3>
      <p>Mücbir sebep hâlleri saklıdır.</p>
    </body></html>`
  },

  'gorselli-belge': {
    title: 'Görselli Belge',
    metadata: { title: 'Kurumsal Antetli Belge', author: 'FITFAK', lang: 'tr-TR' },
    html: `<!doctype html><html lang="tr"><body>
      <h1>Kurumsal Antetli Belge</h1>
      <p><img src="${LOGO}" width="48" alt="FITFAK kurum logosu"></p>
      <p>Görsel, alternatif metniyle birlikte gömülmüştür.</p>
    </body></html>`
  }
};

const PROFILES = ['pdf/a-1b', 'pdf/a-2b', 'pdf/a-3b', 'pdf/ua', 'pdf/a-2b+pdf/ua'];

/* ------------------------------------------------------------------ */

function build(doc, profile) {
  return render({
    html: doc.html,
    css: paper.bundle({ theme: 'kurumsal' }),
    fonts: [{ family: 'Ubuntu', src: FONT }],
    baseDir: ROOT,
    metadata: doc.metadata,
    conformance: profile
  });
}

function main() {
  fs.mkdirSync(SAMPLE_DIR, { recursive: true });

  const rows = [];
  const details = [];
  let totalErrors = 0;

  for (const [key, doc] of Object.entries(DOCUMENTS)) {
    for (const profile of PROFILES) {
      const result = build(doc, profile);
      const file = `${key}__${profile.replace(/[/+]/g, '_')}.pdf`;
      fs.writeFileSync(path.join(SAMPLE_DIR, file), result.pdf);

      const report = conformance.check(result.pdf);
      const parsed = PdfDocument.load(result.pdf);
      totalErrors += report.summary.errors;

      rows.push({
        document: doc.title,
        profile,
        conforms: report.conforms,
        errors: report.summary.errors,
        warnings: report.summary.warnings,
        bytes: result.pdf.length,
        pages: parsed.pageCount,
        file
      });

      if (report.summary.errors || report.summary.warnings) {
        details.push({ document: doc.title, profile, report });
      }
    }
  }

  const md = renderMarkdown(rows, details, totalErrors);
  fs.writeFileSync(path.join(OUT_DIR, 'RAPOR.md'), md);

  console.log(`docs/conformance/RAPOR.md yazıldı — ${rows.length} kombinasyon, ` +
    `${totalErrors} hata`);
  console.log(`örnek belgeler: docs/conformance/ornekler/ (${rows.length} dosya)`);

  process.exitCode = totalErrors === 0 ? 0 : 2;
}

function renderMarkdown(rows, details, totalErrors) {
  const version = require(path.join(ROOT, 'package.json')).version;
  const date = new Date().toISOString().slice(0, 10);

  const lines = [];
  lines.push('# Uyumluluk Raporu');
  lines.push('');
  lines.push(`> Üretim: \`npm run conformance:report\` · ${date} · fitfak-belge v${version} · ` +
    `Node ${process.version}`);
  lines.push('> Bu dosya **elle düzenlenmez**; her koşuda sıfırdan üretilir.');
  lines.push('');

  lines.push('## Kapsam ve dürüstlük notu');
  lines.push('');
  lines.push('Buradaki denetim `@fitfak/conformance` ile yapılır ve **veraPDF gibi resmî bir');
  lines.push('doğrulayıcının yerini tutmaz.** Uyumu kanıtlamaz; uyumsuzluğun pratikte en sık');
  lines.push('görülen biçimlerini yakalar ve hangi maddeyi denetlediğini adıyla söyler.');
  lines.push('Resmî beyan için çıktıların bağımsız bir doğrulayıcıdan geçirilmesi gerekir.');
  lines.push('Aşağıdaki tablodaki örnek PDF\'ler bunun içindir: bu betik onları');
  lines.push('`docs/conformance/ornekler/` altına **yerel olarak** üretir (depoya alınmazlar,');
  lines.push('çünkü her koşuda yeniden üretilebilirler ve ~3 MB tutarlar).');
  lines.push('');

  lines.push('## Sonuç tablosu');
  lines.push('');
  lines.push('| Belge | Profil | Sonuç | Hata | Uyarı | Sayfa | Boyut | Örnek |');
  lines.push('|-------|--------|-------|-----:|------:|------:|------:|-------|');
  for (const r of rows) {
    lines.push(`| ${r.document} | \`${r.profile}\` | ${r.conforms ? '✅ uyumlu' : '❌ uyumsuz'} | ` +
      `${r.errors} | ${r.warnings} | ${r.pages} | ${(r.bytes / 1024).toFixed(0)} KB | ` +
      `[${r.file}](ornekler/${r.file}) |`);
  }
  lines.push('');
  lines.push(`**Toplam:** ${rows.length} kombinasyon, ${totalErrors} hata.`);
  lines.push('');

  if (details.length) {
    lines.push('## Bulgular');
    lines.push('');
    for (const d of details) {
      lines.push(`### ${d.document} · \`${d.profile}\``);
      lines.push('');
      lines.push('```');
      lines.push(conformance.formatReport(d.report));
      lines.push('```');
      lines.push('');
    }
  }

  lines.push('## Denetlenen maddeler');
  lines.push('');
  lines.push('### PDF/A (ISO 19005)');
  lines.push('');
  lines.push('| Madde | Konu |');
  lines.push('|-------|------|');
  for (const [clause, topic] of [
    ['6.1.2', 'Dosya başlığı ve ikili yorum satırı'],
    ['6.1.3', 'Trailer: `/ID` zorunlu, `/Encrypt` yasak'],
    ['6.1.7', '`LZWDecode` yasak; harici akış (`/F`) yasak'],
    ['6.2.2', 'Çıktı amacı (`OutputIntent`) + gömülü ICC profili'],
    ['6.2.11', 'Bütün fontlar gömülü (standart 14 istisnası YOK)'],
    ['6.3', 'Şeffaflık (yalnız PDF/A-1\'de yasak)'],
    ['6.5.3', 'Açıklamalar: `/AP` zorunlu, `/CA = 1`, gizli olamaz'],
    ['6.6.1', 'Yasaklı eylemler: JavaScript, Launch, Movie, Sound, XFA'],
    ['6.7.2', 'XMP üst verisi ve `pdfaid` iddiası'],
    ['6.7.3', 'XMP ile `/Info` tutarlılığı']
  ]) {
    lines.push(`| \`${clause}\` | ${topic} |`);
  }
  lines.push('');

  lines.push('### PDF/UA-1 (ISO 14289-1, Matterhorn maddeleri)');
  lines.push('');
  lines.push('| Kural | Konu |');
  lines.push('|-------|------|');
  for (const [rule, topic] of [
    ['01', 'Etiketlenmemiş içerik; `/MarkInfo`, `/StructTreeRoot`, `/ParentTree`'],
    ['06', 'Belge başlığı (`/Title` + `/DisplayDocTitle`)'],
    ['09', 'Başlık düzeylerinin atlanmaması (H1 → H3 yasak)'],
    ['11', 'Doğal dil (`/Lang`)'],
    ['13', 'Görsellerde alternatif metin (`/Alt`)'],
    ['14', 'Bağlantılarda erişilebilir açıklama + `/OBJR` bağı'],
    ['15', 'Tablo yapısı (TR / TH / TD, `/Scope`), liste yapısı (Lbl / LBody)'],
    ['19', 'XMP `pdfuaid:part` iddiası'],
    ['31', 'Font gömme']
  ]) {
    lines.push(`| \`${rule}\` | ${topic} |`);
  }
  lines.push('');

  lines.push('## Bilinen sınırlar');
  lines.push('');
  lines.push('- **PDF/A-2a / -3a** (erişilebilir arşiv) iddia edilebilir ama tam denetlenmez:');
  lines.push('  "a" düzeyi PDF/UA kurallarının tamamını da kapsar; ikisini birlikte istemek');
  lines.push('  (`pdf/a-2b+pdf/ua`) şu an daha dürüst bir yoldur.');
  lines.push('- **Renk uzayları**: yalnız DeviceRGB üretiliyor ve sRGB çıktı amacı yazılıyor.');
  lines.push('  CMYK veya Lab içeren belgelerde denetim eksik kalır.');
  lines.push('- **Gömülü dosyalar** (PDF/A-3 eki) denetlenmez.');
  lines.push('- **Şeffaflık** yalnız PDF/A-1 için ve yalnız `ExtGState` düzeyinde bakılır.');
  lines.push('');

  return lines.join('\n') + '\n';
}

if (require.main === module) main();

module.exports = { DOCUMENTS, PROFILES, build };
