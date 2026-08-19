#!/usr/bin/env node
'use strict';
/**
 * fitfak-belge — komut satırı arayüzü.
 *
 * Tasarım kararı: her komut ilgili PAKETE devreder, iş mantığı burada durmaz.
 * Böylece CLI ile Studio aynı kodu çalıştırır ve ikisi birbirinden ayrışamaz.
 *
 * Bağımsız argüman ayrıştırıcısı kullanıyoruz (yaklaşık 40 satır): dış paket
 * yok, davranış tam olarak burada okunabilir.
 */

const fs = require('fs');
const path = require('path');

const COMMANDS = {};      // ad → { summary, usage, options, run }

/* ------------------------------------------------------------------ */
/* Argüman ayrıştırma                                                  */
/* ------------------------------------------------------------------ */

/**
 * `--anahtar deger`, `--anahtar=deger`, `--bayrak`, `-o kisa` ve konumsal
 * argümanları ayırır. `--` sonrası her şey konumsaldır.
 */
function parseArgs(argv, spec = {}) {
  const flags = new Set(spec.flags || []);
  const alias = spec.alias || {};
  const out = { _: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--') { out._.push(...argv.slice(i + 1)); break; }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      const key = alias[name] || name;

      if (eq > 0) { push(out, key, arg.slice(eq + 1)); continue; }
      if (flags.has(key)) { out[key] = true; continue; }
      if (name.startsWith('no-') && flags.has(alias[name.slice(3)] || name.slice(3))) {
        out[alias[name.slice(3)] || name.slice(3)] = false;
        continue;
      }
      push(out, key, argv[++i]);
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      const name = arg.slice(1);
      const key = alias[name] || name;
      if (flags.has(key)) { out[key] = true; continue; }
      push(out, key, argv[++i]);
      continue;
    }

    out._.push(arg);
  }
  return out;
}

function push(obj, key, value) {
  if (value === undefined) throw new CliError(`--${key} bir değer bekliyor`);
  if (obj[key] === undefined) obj[key] = value;
  else if (Array.isArray(obj[key])) obj[key].push(value);
  else obj[key] = [obj[key], value];
}

class CliError extends Error {
  constructor(message, code = 'ERR_CLI') { super(message); this.code = code; }
}

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                         */
/* ------------------------------------------------------------------ */

const read = (file) => {
  if (!file) throw new CliError('Girdi dosyası belirtilmedi');
  if (file === '-') return fs.readFileSync(0);
  if (!fs.existsSync(file)) throw new CliError(`Dosya bulunamadı: ${file}`);
  return fs.readFileSync(file);
};

function write(file, data, label = 'yazıldı') {
  if (!file || file === '-') { process.stdout.write(data); return; }
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, data);
  say(`${label}: ${file} (${fmtBytes(data.length)})`);
}

const say = (text) => process.stderr.write(text + '\n');
const out = (text) => process.stdout.write(text + '\n');

function fmtBytes(n) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024
    ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
}

/** PEM ya da PFX olabilen bir imzalayıcı girdisini çözer. */
function resolveSignerInput(args) {
  if (args.pfx) {
    return {
      pfx: read(args.pfx),
      pfxPassword: args.password !== undefined ? String(args.password) : ''
    };
  }
  if (args.key && args.cert) {
    return {
      keyPem: read(args.key).toString('utf8'),
      certPem: read(args.cert).toString('utf8'),
      chainPems: args.chain
        ? [].concat(args.chain).map((f) => read(f).toString('utf8'))
        : []
    };
  }
  throw new CliError('İmzalamak için --pfx ya da --key + --cert gerekir');
}

/* ------------------------------------------------------------------ */
/* render                                                             */
/* ------------------------------------------------------------------ */

COMMANDS.render = {
  summary: 'HTML + CSS dosyasından PDF üretir',
  usage: 'fitfak-belge render <girdi.html> -o <cikti.pdf> [seçenekler]',
  options: [
    ['-o, --out <dosya>', 'çıktı PDF (varsayılan: stdout)'],
    ['--theme <ad>', '@fitfak/paper teması (varsayılan: kurumsal)'],
    ['--css <dosya>', 'ek CSS dosyası (birden çok kez verilebilir)'],
    ['--font <aile=dosya>', 'font kaydı (birden çok kez verilebilir)'],
    ['--page <boyut>', 'A4 | A4 landscape | "210mm 297mm"'],
    ['--margin <deger>', 'CSS kısayolu, örn. "20mm 18mm"'],
    ['--title <metin>', 'belge başlığı'],
    ['--author <metin>', 'belge yazarı'],
    ['--lang <kod>', 'doğal dil (varsayılan: tr-TR)'],
    ['--conformance <profil>', 'pdf/a-2b | pdf/ua | pdf/a-2b+pdf/ua'],
    ['--manifest <dosya>', 'yerleşim manifest\'ini JSON olarak yaz'],
    ['--no-theme', 'paper temasını yükleme']
  ],
  flags: ['theme'],
  alias: { o: 'out' },

  run(args) {
    const { render } = require('@fitfak/pdf-html');
    const paper = require('@fitfak/paper');

    const input = args._[0];
    const html = read(input).toString('utf8');
    const baseDir = input && input !== '-' ? path.dirname(path.resolve(input)) : process.cwd();

    const css = [];
    if (args.theme !== false) css.push(...paper.stack(typeof args.theme === 'string' ? args.theme : 'kurumsal'));
    for (const file of [].concat(args.css || [])) css.push(read(file).toString('utf8'));

    const fonts = [];
    for (const entry of [].concat(args.font || [])) {
      const eq = String(entry).indexOf('=');
      if (eq < 0) throw new CliError(`--font biçimi "Aile=yol.ttf" olmalı: ${entry}`);
      fonts.push({ family: entry.slice(0, eq), src: path.resolve(entry.slice(eq + 1)) });
    }
    if (!fonts.length) {
      fonts.push({ family: 'Ubuntu', src: path.join(__dirname, '..', 'assets', 'Ubuntu-Regular.ttf') });
    }

    const result = render({
      html, css, fonts, baseDir,
      page: { size: args.page || 'A4', margin: args.margin || '20mm 18mm' },
      metadata: {
        title: args.title, author: args.author, subject: args.subject,
        lang: args.lang || 'tr-TR'
      },
      conformance: args.conformance || null
    });

    for (const w of result.warnings) say(`uyarı [${w.type}] ${w.message}`);
    if (result.conformance) {
      say(`uyumluluk: ${JSON.stringify(result.conformance)}`);
    }
    if (args.manifest) {
      write(args.manifest, Buffer.from(JSON.stringify(result.manifest, null, 2)), 'manifest');
    }
    write(args.out, result.pdf, 'PDF');
    say(`${result.manifest.pages.length} sayfa · ${result.manifest.signatureSlots.length} imza yuvası`);
  }
};

/* ------------------------------------------------------------------ */
/* sign                                                               */
/* ------------------------------------------------------------------ */

COMMANDS.sign = {
  summary: 'PDF\'i PAdES ile imzalar (B / T / LT / LTA)',
  usage: 'fitfak-belge sign <belge.pdf> --pfx <kimlik.p12> -o <imzali.pdf>',
  options: [
    ['-o, --out <dosya>', 'çıktı PDF'],
    ['--pfx <dosya>', 'PKCS#12 kimlik dosyası'],
    ['--password <parola>', 'PFX parolası'],
    ['--key <dosya>', 'PEM özel anahtar (--pfx yerine)'],
    ['--cert <dosya>', 'PEM sertifika'],
    ['--chain <dosya>', 'ara sertifika (birden çok kez)'],
    ['--level <B|T|LT|LTA>', 'PAdES seviyesi (varsayılan: T)'],
    ['--tsa <url>', 'RFC 3161 zaman damgası sunucusu'],
    ['--field <ad>', 'imza alanı adı'],
    ['--reason <metin>', 'imza gerekçesi'],
    ['--location <metin>', 'imza yeri'],
    ['--page <n>', 'görünür imza sayfası (0 tabanlı)'],
    ['--rect <x,y,g>', 'görünür imza konumu (PDF birimi)'],
    ['--stamp <şablon>', 'damga şablonu: classic | qr | dual | minimal'],
    ['--name <metin>', 'damgada görünecek ad'],
    ['--invisible', 'görünür damga ekleme']
  ],
  flags: ['invisible'],
  alias: { o: 'out' },

  async run(args) {
    const { PAdESManager } = require('@fitfak/pades/src/utils/pades_manager');

    const pdfBuffer = read(args._[0]);
    const signer = resolveSignerInput(args);
    const level = String(args.level || 'T').toUpperCase();

    const manager = new PAdESManager({
      tsaUrl: args.tsa || process.env.TSA_URL || 'http://timestamp.digicert.com',
      tsaOptions: { hashName: 'sha256', certReq: true }
    });

    let visibleSignature = null;
    if (!args.invisible) {
      const { buildVisibleSignature } = require('@fitfak/pades/src/signature/visible');
      const rect = args.rect ? String(args.rect).split(',').map(Number) : null;
      visibleSignature = buildVisibleSignature({
        template: args.stamp || 'dual',
        signerName: args.name || null,
        page: Number(args.page) || 0,
        ...(rect && rect.length >= 3 ? { x: rect[0], y: rect[1], width: rect[2] } : {})
      });
    }

    say(`imzalanıyor: PAdES-${level}…`);
    const result = await manager.sign({
      mode: level,
      pdfBuffer,
      fieldName: args.field || null,
      reason: args.reason,
      location: args.location,
      visibleSignature,
      ...signer
    });

    for (const reason of result.reasons || []) say(`  not: ${reason}`);
    if (result.achievedLevel !== `pades-${level.toLowerCase()}`) {
      say(`UYARI: istenen seviye ${level}, ulaşılan ${result.achievedLevel}`);
    }
    write(args.out, result.pdf, `imzalı PDF (${result.achievedLevel})`);
  }
};

/* ------------------------------------------------------------------ */
/* verify                                                             */
/* ------------------------------------------------------------------ */

COMMANDS.verify = {
  summary: 'İmzaları doğrular ve ETSI biçiminde rapor üretir',
  usage: 'fitfak-belge verify <imzali.pdf> [--trust kok.pem] [--offline]',
  options: [
    ['--trust <dosya>', 'güven çıpası PEM (birden çok kez)'],
    ['--offline', 'ağa çıkma; yalnız gömülü LTV verisini kullan'],
    ['--at <tarih>', 'doğrulama zamanı (ISO 8601)'],
    ['--json', 'raporu JSON olarak yaz']
  ],
  flags: ['offline', 'json'],

  async run(args) {
    const { verifyPdf } = require('@fitfak/verify');

    const anchors = [].concat(args.trust || []).map((f) => read(f).toString('utf8'));
    const report = await verifyPdf(read(args._[0]), {
      trustAnchors: anchors.length ? anchors : undefined,
      allowNetwork: !args.offline,
      validationTime: args.at ? new Date(args.at) : undefined
    });

    if (args.json) { out(JSON.stringify(report, null, 2)); }
    else { out(formatVerify(report)); }

    process.exitCode = report.signatures.every((s) => s.indication === 'TOTAL-PASSED') ? 0 : 2;
  }
};

function formatVerify(report) {
  const lines = [];
  const di = report.documentIntegrity;

  lines.push(`Belge: ${fmtBytes(di.byteLength)} · ${di.revisions} revizyon · ${di.signatureCount} imza`);
  if (di.modifiedAfterSigning) {
    lines.push(`  ! Son imzadan sonra ${di.unsignedBytes} bayt eklenmiş` +
      (di.trailingRevisionIsValidationData ? ' (yalnız doğrulama verisi)' : ''));
  }

  for (const s of report.signatures) {
    lines.push('');
    lines.push(`── ${s.fieldName || s.type} · ${s.indication}` +
      (s.subIndication ? `/${s.subIndication}` : ''));
    lines.push(`   seviye     : ${s.achievedLevel || '—'}  (${s.subFilter})`);
    if (s.signer) {
      lines.push(`   imzalayan  : ${s.signer.cn || s.signer.subject}`);
      lines.push(`   veren      : ${s.signer.issuer}`);
      lines.push(`   geçerlilik : ${s.signer.notBefore} → ${s.signer.notAfter}`);
    }
    if (s.cms) {
      lines.push(`   kripto     : imza=${yesNo(s.cms.signatureValid)} ` +
        `özet=${yesNo(s.cms.messageDigestMatches)} sertifika-bağı=${yesNo(s.cms.signingCertificateV2Matches)}`);
    }
    if (s.coverage) {
      lines.push(`   kapsam     : ${s.coverage.coveredBytes}/${s.coverage.documentBytes} bayt` +
        (s.coverage.coversWholeDocument ? ' (tam belge)' : ' (kısmi)'));
    }
    for (const e of s.errors || []) lines.push(`   HATA       : ${e}`);
    for (const w of s.warnings || []) lines.push(`   uyarı      : ${w}`);
  }
  return lines.join('\n');
}

const yesNo = (v) => (v === true ? 'evet' : v === false ? 'HAYIR' : '—');

/* ------------------------------------------------------------------ */
/* extend                                                             */
/* ------------------------------------------------------------------ */

COMMANDS.extend = {
  summary: 'Mevcut imzayı LT / LTA seviyesine yükseltir',
  usage: 'fitfak-belge extend <imzali.pdf> --to LTA -o <cikti.pdf>',
  options: [
    ['-o, --out <dosya>', 'çıktı PDF'],
    ['--to <LT|LTA>', 'hedef seviye (varsayılan: LT)'],
    ['--tsa <url>', 'RFC 3161 zaman damgası sunucusu'],
    ['--prefer <yol>', 'ocsp-first | crl-first | both']
  ],
  alias: { o: 'out' },

  async run(args) {
    const { PAdESManager } = require('@fitfak/pades/src/utils/pades_manager');
    const manager = new PAdESManager({
      tsaUrl: args.tsa || process.env.TSA_URL || 'http://timestamp.digicert.com',
      tsaOptions: { hashName: 'sha256', certReq: true }
    });

    const target = String(args.to || 'LT').toUpperCase();
    const pdf = read(args._[0]);

    const result = target === 'LTA'
      ? await manager.extendToLTA(pdf, { prefer: args.prefer || 'ocsp-first' })
      : await manager.extendToLT(pdf, { prefer: args.prefer || 'ocsp-first' });

    if (result.report) {
      const e = result.report.embedded || {};
      say(`gömülen: ${e.certs || 0} sertifika, ${e.ocsps || 0} OCSP, ${e.crls || 0} CRL`);
    }
    write(args.out, result.pdf, `PDF (${result.achievedLevel || target})`);
  }
};

/* ------------------------------------------------------------------ */
/* inspect / text                                                     */
/* ------------------------------------------------------------------ */

COMMANDS.inspect = {
  summary: 'Belgenin yapısını özetler (sayfa, üst veri, form, imza)',
  usage: 'fitfak-belge inspect <belge.pdf> [--password ...] [--json]',
  options: [
    ['--password <parola>', 'şifreli belge parolası'],
    ['--json', 'JSON çıktı']
  ],
  flags: ['json'],

  run(args) {
    const { PdfDocument } = require('@fitfak/pdf-doc');
    const { findAllSignatures } = require('@fitfak/pades/src/utils/pdf_parser');

    const buf = read(args._[0]);
    const doc = PdfDocument.load(buf, { password: args.password || '' });

    const pages = [];
    for (let i = 0; i < doc.pageCount; i++) {
      const g = doc.getPageGeometry(i);
      pages.push({ index: i, width: +g.width.toFixed(2), height: +g.height.toFixed(2), rotate: g.rotate });
    }

    const info = {
      byteLength: buf.length,
      pageCount: doc.pageCount,
      encrypted: doc.isEncrypted,
      repaired: doc.xref.recovered || !!doc.offsetsRepaired,
      hasForm: doc.hasForm,
      metadata: doc.getInfo(),
      pages,
      fields: doc.hasForm ? doc.listFields().map((f) => ({ name: f.name, type: f.type, value: f.value })) : [],
      signatures: findAllSignatures(buf).map((s) => ({ type: s.type, subFilter: s.subFilter }))
    };

    if (args.json) { out(JSON.stringify(info, null, 2)); return; }

    out(`Dosya      : ${fmtBytes(buf.length)}`);
    out(`Sayfa      : ${doc.pageCount}` +
      (pages.length ? `  (${pages[0].width}×${pages[0].height} pt` +
        (pages[0].rotate ? `, ${pages[0].rotate}°` : '') + ')' : ''));
    out(`Şifreli    : ${doc.isEncrypted ? 'evet' : 'hayır'}`);
    if (info.repaired) out('Not        : çapraz başvuru tablosu onarıldı');

    const meta = Object.entries(info.metadata).filter(([, v]) => v);
    if (meta.length) {
      out('Üst veri   :');
      for (const [k, v] of meta) out(`  ${k.padEnd(12)} ${String(v).slice(0, 70)}`);
    }
    if (info.fields.length) {
      out(`Form alanı : ${info.fields.length}`);
      for (const f of info.fields) {
        out(`  ${f.name.padEnd(16)} ${f.type.padEnd(4)} ${f.value == null ? '' : JSON.stringify(f.value)}`);
      }
    }
    if (info.signatures.length) {
      out(`İmza       : ${info.signatures.length}`);
      for (const s of info.signatures) out(`  ${s.type} · ${s.subFilter}`);
    }
  }
};

COMMANDS.text = {
  summary: 'Belgedeki metni çıkarır',
  usage: 'fitfak-belge text <belge.pdf> [--page 0] [--password ...]',
  options: [
    ['--page <n>', 'yalnız bu sayfa (0 tabanlı)'],
    ['--password <parola>', 'şifreli belge parolası'],
    ['--json', 'konumlarıyla birlikte JSON']
  ],
  flags: ['json'],

  run(args) {
    const { PdfDocument } = require('@fitfak/pdf-doc');
    const doc = PdfDocument.load(read(args._[0]), { password: args.password || '' });

    if (args.json) {
      const pages = [];
      const range = args.page !== undefined ? [Number(args.page)] : doc.pageRefs.map((_, i) => i);
      for (const i of range) pages.push({ page: i, items: doc.extractTextItems(i) });
      out(JSON.stringify(pages, null, 2));
      return;
    }

    out(args.page !== undefined
      ? doc.extractText(Number(args.page))
      : doc.extractDocumentText());
  }
};

/* ------------------------------------------------------------------ */
/* edit                                                               */
/* ------------------------------------------------------------------ */

COMMANDS.edit = {
  summary: 'Belgeyi artımlı düzenler (imzalar geçerli kalır)',
  usage: 'fitfak-belge edit <belge.pdf> -o <cikti.pdf> [işlemler]',
  options: [
    ['-o, --out <dosya>', 'çıktı PDF'],
    ['--rotate <sayfa:derece>', 'sayfayı döndür (birden çok kez)'],
    ['--remove-page <n>', 'sayfa sil (birden çok kez)'],
    ['--move-page <from:to>', 'sayfa taşı'],
    ['--image <sayfa:x:y:g[:y2]=dosya>', 'görsel yerleştir'],
    ['--text <sayfa:x:y=metin>', 'metin ekle'],
    ['--title <metin>', 'belge başlığı'],
    ['--author <metin>', 'belge yazarı'],
    ['--fill <alan=deger>', 'form alanı doldur (birden çok kez)'],
    ['--flatten', 'formu düzleştir'],
    ['--password <parola>', 'şifreli belge parolası'],
    ['--rewrite', 'artımlı yerine tam yeniden yazım (imzayı bozar)']
  ],
  flags: ['flatten', 'rewrite'],
  alias: { o: 'out' },

  run(args) {
    const { PdfDocument } = require('@fitfak/pdf-doc');
    const doc = PdfDocument.load(read(args._[0]), { password: args.password || '' });
    let changes = 0;

    for (const spec of [].concat(args.rotate || [])) {
      const [page, deg] = String(spec).split(':').map(Number);
      doc.rotatePage(page, deg);
      changes++;
    }
    for (const spec of [].concat(args['move-page'] || [])) {
      const [from, to] = String(spec).split(':').map(Number);
      doc.movePage(from, to);
      changes++;
    }
    // Silmeleri büyükten küçüğe yap: indeksler kaymasın
    const removals = [].concat(args['remove-page'] || []).map(Number).sort((a, b) => b - a);
    for (const page of removals) { doc.removePage(page); changes++; }

    for (const spec of [].concat(args.image || [])) {
      const eq = String(spec).indexOf('=');
      if (eq < 0) throw new CliError(`--image biçimi "sayfa:x:y:genişlik=dosya" olmalı: ${spec}`);
      const [page, x, y, width, height] = spec.slice(0, eq).split(':').map(Number);
      doc.addImage(page, read(spec.slice(eq + 1)), { x, y, width, height: height || undefined });
      changes++;
    }

    for (const spec of [].concat(args.text || [])) {
      const eq = String(spec).indexOf('=');
      if (eq < 0) throw new CliError(`--text biçimi "sayfa:x:y=metin" olmalı: ${spec}`);
      const [page, x, y, size] = spec.slice(0, eq).split(':').map(Number);
      doc.addText(page, spec.slice(eq + 1), { x, y, size: size || undefined });
      changes++;
    }

    if (args.title || args.author) {
      doc.setMetadata({ title: args.title, author: args.author });
      changes++;
    }

    const values = {};
    for (const spec of [].concat(args.fill || [])) {
      const eq = String(spec).indexOf('=');
      if (eq < 0) throw new CliError(`--fill biçimi "alan=deger" olmalı: ${spec}`);
      values[spec.slice(0, eq)] = spec.slice(eq + 1);
    }
    if (Object.keys(values).length) {
      const report = doc.fillForm(values);
      for (const s of report.skipped) say(`atlandı: ${s.name} — ${s.reason}`);
      changes++;
    }
    if (args.flatten) { doc.flattenForm(); changes++; }

    if (!changes) throw new CliError('Hiçbir düzenleme işlemi verilmedi (--help ile seçeneklere bakın)');

    const result = doc.save({ full: !!args.rewrite });
    write(args.out, result, args.rewrite ? 'PDF (tam yazım)' : 'PDF (artımlı)');
  }
};

/* ------------------------------------------------------------------ */
/* check (uyumluluk)                                                  */
/* ------------------------------------------------------------------ */

COMMANDS.check = {
  summary: 'PDF/A ve PDF/UA uyumluluğunu denetler',
  usage: 'fitfak-belge check <belge.pdf> [--profile pdf/a-2b] [--json]',
  options: [
    ['--profile <ad>', 'denetlenecek profil (birden çok kez); yoksa XMP iddiası'],
    ['--password <parola>', 'şifreli belge parolası'],
    ['--json', 'JSON çıktı']
  ],
  flags: ['json'],

  run(args) {
    const conformance = require('@fitfak/conformance');
    const profiles = args.profile ? [].concat(args.profile) : undefined;

    const report = conformance.check(read(args._[0]), {
      profiles, password: args.password || ''
    });

    out(args.json ? JSON.stringify(report, null, 2) : conformance.formatReport(report));
    process.exitCode = report.conforms ? 0 : 2;
  }
};

/* ------------------------------------------------------------------ */
/* stamp                                                              */
/* ------------------------------------------------------------------ */

COMMANDS.stamp = {
  summary: 'İmza damgası (PNG) üretir',
  usage: 'fitfak-belge stamp -o damga.png [--template dual] [--name "Ad Soyad"]',
  options: [
    ['-o, --out <dosya>', 'çıktı PNG'],
    ['--template <ad>', 'classic | qr | dual | minimal | handwritten | kurumsal'],
    ['--name <metin>', 'imzalayan adı'],
    ['--seed <metin>', 'barkod/QR verisi'],
    ['--font <dosya>', 'TTF font']
  ],
  alias: { o: 'out' },

  run(args) {
    const { renderStamp } = require('@fitfak/stamp');
    const ROOT = path.join(__dirname, '..');

    const result = renderStamp({
      template: args.template || 'dual',
      font: args.font || path.join(ROOT, 'assets', 'Ubuntu-Regular.ttf'),
      baseDir: ROOT,
      seed: args.seed,
      vars: {
        personName: args.name || '',
        logo: path.join(ROOT, 'packages/pades/src/assets/caduceus.png')
      }
    });

    write(args.out, result.png, `damga ${result.width}×${result.height}`);
  }
};

/* ------------------------------------------------------------------ */
/* serve                                                              */
/* ------------------------------------------------------------------ */

COMMANDS.serve = {
  summary: 'Belge Studio sunucusunu başlatır',
  usage: 'fitfak-belge serve [--port 8787] [--host 127.0.0.1]',
  options: [
    ['--port <n>', 'dinlenecek port (varsayılan: 8787)'],
    ['--host <adres>', 'dinlenecek adres (varsayılan: 127.0.0.1)'],
    ['--tsa <url>', 'varsayılan zaman damgası sunucusu']
  ],

  run(args) {
    if (args.port) process.env.PORT = String(args.port);
    if (args.host) process.env.HOST = String(args.host);
    if (args.tsa) process.env.TSA_URL = String(args.tsa);
    require(path.join(__dirname, '..', 'apps', 'server', 'server.js')).start();
  }
};

/* ------------------------------------------------------------------ */
/* Yardım ve giriş                                                    */
/* ------------------------------------------------------------------ */

function printHelp(name) {
  if (name && COMMANDS[name]) {
    const cmd = COMMANDS[name];
    out(`${cmd.summary}\n`);
    out(`Kullanım:\n  ${cmd.usage}\n`);
    if (cmd.options && cmd.options.length) {
      out('Seçenekler:');
      const width = Math.max(...cmd.options.map(([o]) => o.length));
      for (const [option, description] of cmd.options) {
        out(`  ${option.padEnd(width + 2)}${description}`);
      }
    }
    return;
  }

  out('fitfak-belge — PAdES imzalama, PDF üretimi ve belge işleme\n');
  out('Kullanım:\n  fitfak-belge <komut> [seçenekler]\n');
  out('Komutlar:');
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  for (const [key, cmd] of Object.entries(COMMANDS)) {
    out(`  ${key.padEnd(width + 2)}${cmd.summary}`);
  }
  out('\nBir komutun ayrıntısı için:  fitfak-belge <komut> --help');
}

async function main(argv) {
  const name = argv[0];

  if (!name || name === '--help' || name === '-h' || name === 'help') {
    printHelp(argv[1]);
    return;
  }
  if (name === '--version' || name === '-v') {
    out(require(path.join(__dirname, '..', 'package.json')).version);
    return;
  }

  const cmd = COMMANDS[name];
  if (!cmd) {
    say(`Bilinmeyen komut: ${name}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const rest = argv.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) { printHelp(name); return; }

  const args = parseArgs(rest, { flags: cmd.flags || [], alias: cmd.alias || {} });
  await cmd.run(args);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    say(`hata${err.code ? ` [${err.code}]` : ''}: ${err.message}`);
    if (process.env.DEBUG) say(err.stack);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, COMMANDS, CliError };
