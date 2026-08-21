'use strict';
/**
 * `fitfak-belge` CLI — imzalama, yükseltme ve doğrulama akışları.
 *
 * Yerel CA + OCSP + CRL + TSA ile çalışır; ağa çıkılmaz.
 *
 * DİKKAT: alt süreçler `execFile` ile EŞZAMANSIZ çağrılır. `execFileSync`
 * bu testin kendi olay döngüsünü bloklar ve yerel PKI sunucuları yanıt
 * veremediği için süreç kilitlenir.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const { startTestServices } = require('./pki/services');
const p12 = require('@fitfak/pkcs12');

const ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(ROOT, 'bin', 'fitfak-belge.js');

let svc;
let workDir;
const at = (name) => path.join(workDir, name);

async function run(args) {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI, ...args],
      { encoding: 'utf8', cwd: ROOT, timeout: 60000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

test.before(async () => {
  svc = await startTestServices();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitfak-cli-e2e-'));

  const profile = svc.pki.profile('signer');
  fs.writeFileSync(at('kimlik.p12'), p12.build({
    privateKeyPem: profile.keyPem,
    certificatePem: profile.certPem,
    chainPems: profile.chainPems,
    password: 'test',
    friendlyName: profile.name
  }));
  fs.writeFileSync(at('kok.pem'), profile.rootPem);
  fs.writeFileSync(at('anahtar.pem'), profile.keyPem);
  fs.writeFileSync(at('sertifika.pem'), profile.certPem);
  fs.writeFileSync(at('ara.pem'), profile.issuerPem);

  fs.writeFileSync(at('belge.html'),
    `<!doctype html><html lang="tr"><body>
      <h1>Uçtan Uca Belge</h1>
      <p>Bu belge CLI ile üretilip imzalanacak.</p>
      <div data-signer="imzaci1" data-role="Düzenleyen">&nbsp;</div>
    </body></html>`);

  const rendered = await run(['render', at('belge.html'), '-o', at('belge.pdf'),
    '--title', 'Uçtan Uca Belge', '--author', 'Aybars Yıldırım']);
  assert.strictEqual(rendered.code, 0, rendered.stderr);
});

test.after(async () => {
  if (svc) await svc.close();
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

const signArgs = (input, output, extra = []) => [
  'sign', input, '-o', output,
  '--pfx', at('kimlik.p12'), '--password', 'test',
  '--tsa', svc.endpoints.tsa, ...extra
];

const verifyArgs = (input, extra = []) =>
  ['verify', input, '--trust', at('kok.pem'), '--offline', ...extra];

/* ================================================================== */

test('sign: PAdES-T ile imzalar ve doğrulama geçer', async () => {
  const signed = await run(signArgs(at('belge.pdf'), at('t.pdf'),
    ['--level', 'T', '--name', 'Aybars YILDIRIM', '--stamp', 'qr']));

  assert.strictEqual(signed.code, 0, signed.stderr);
  assert.match(signed.stderr, /pades-t/);

  const verified = await run(verifyArgs(at('t.pdf')));
  assert.strictEqual(verified.code, 0, verified.stdout + verified.stderr);
  assert.match(verified.stdout, /TOTAL-PASSED/);
  assert.match(verified.stdout, /seviye\s+: B-T/);
  assert.match(verified.stdout, /kripto\s+: imza=evet özet=evet sertifika-bağı=evet/);
});

test('sign: PEM anahtar + sertifika yolu da çalışır', async () => {
  const signed = await run([
    'sign', at('belge.pdf'), '-o', at('pem.pdf'),
    '--key', at('anahtar.pem'), '--cert', at('sertifika.pem'),
    '--chain', at('ara.pem'), '--chain', at('kok.pem'),
    '--level', 'B', '--tsa', svc.endpoints.tsa
  ]);
  assert.strictEqual(signed.code, 0, signed.stderr);

  const verified = await run(verifyArgs(at('pem.pdf')));
  assert.strictEqual(verified.code, 0);
  assert.match(verified.stdout, /TOTAL-PASSED/);
});

test('sign: kimlik verilmezse anlaşılır hata', async () => {
  const result = await run(['sign', at('belge.pdf'), '-o', at('yok.pdf')]);
  assert.strictEqual(result.code, 1);
  assert.match(result.stderr, /--pfx ya da --key \+ --cert gerekir/);
});

test('sign: yanlış PFX parolası hata verir', async () => {
  const result = await run(signArgs(at('belge.pdf'), at('yanlis.pdf'),
    ['--level', 'B']).map((a) => (a === 'test' ? 'yanlis-parola' : a)));

  assert.strictEqual(result.code, 1);
  assert.ok(result.stderr.length > 0, 'hata mesajı yazılmalı');
});

test('sign: LT seviyesi LTV verisini gömer', async () => {
  const signed = await run(signArgs(at('belge.pdf'), at('lt.pdf'), ['--level', 'LT']));
  assert.strictEqual(signed.code, 0, signed.stderr);

  const verified = await run(verifyArgs(at('lt.pdf')));
  assert.strictEqual(verified.code, 0);
  assert.match(verified.stdout, /seviye\s+: B-LT/,
    'çevrimdışı doğrulama, iptal verisinin gerçekten gömüldüğünü kanıtlar');
});

test('extend: imzayı LTA seviyesine yükseltir', async () => {
  const extended = await run(['extend', at('lt.pdf'), '--to', 'LTA',
    '-o', at('lta.pdf'), '--tsa', svc.endpoints.tsa]);

  assert.strictEqual(extended.code, 0, extended.stderr);
  assert.match(extended.stderr, /gömülen: \d+ sertifika/);

  const verified = await run(verifyArgs(at('lta.pdf')));
  assert.strictEqual(verified.code, 0);
  assert.match(verified.stdout, /seviye\s+: B-LTA/);
  assert.match(verified.stdout, /2 imza/, 'arşiv damgası ikinci imza olarak görünür');
});

test('verify: güven çıpası yoksa 2 ile çıkar', async () => {
  const result = await run(['verify', at('t.pdf'), '--offline']);
  assert.strictEqual(result.code, 2, 'doğrulanamayan imza sıfırdan farklı çıkış kodu vermeli');
  assert.match(result.stdout, /INDETERMINATE/);
});

test('verify: --json makine okunur rapor verir', async () => {
  const result = await run(verifyArgs(at('t.pdf'), ['--json']));
  const report = JSON.parse(result.stdout);

  assert.strictEqual(report.signatures.length, 1);
  assert.strictEqual(report.signatures[0].indication, 'TOTAL-PASSED');
  assert.strictEqual(report.signatures[0].cms.signatureValid, true);
  assert.strictEqual(report.documentIntegrity.modifiedAfterSigning, false);
});

test('verify: bozulmuş belge yakalanır', async () => {
  const pdf = fs.readFileSync(at('t.pdf'));

  // İmzanın KAPSADIĞI alanda bir baytı değiştir: sayfa içeriğinin ortası
  const marker = pdf.indexOf(Buffer.from('BT', 'latin1'), 1000);
  assert.ok(marker > 0, 'içerik akışı bulunamadı');
  pdf[marker + 1] = pdf[marker + 1] === 0x54 ? 0x55 : 0x54;
  fs.writeFileSync(at('bozuk.pdf'), pdf);

  const result = await run(verifyArgs(at('bozuk.pdf')));
  assert.strictEqual(result.code, 2);
  assert.ok(/TOTAL-FAILED|HASH_FAILURE|INDETERMINATE/.test(result.stdout),
    `beklenen başarısızlık göstergesi yok:\n${result.stdout}`);
});

/* ================================================================== */
/* İmzalı belgeyi düzenleme                                           */
/* ================================================================== */

test('edit: imzalı belge artımlı düzenlenir, imza geçerli kalır', async () => {
  const before = fs.readFileSync(at('t.pdf'));

  const edited = await run(['edit', at('t.pdf'), '-o', at('duzenli.pdf'),
    '--text', '0:60:40:9=imzadan sonra eklendi']);
  assert.strictEqual(edited.code, 0, edited.stderr);
  assert.match(edited.stderr, /artımlı/);

  const after = fs.readFileSync(at('duzenli.pdf'));
  assert.ok(after.subarray(0, before.length).equals(before),
    'imzanın kapsadığı baytlar korunmalı');

  const verified = await run(verifyArgs(at('duzenli.pdf'), ['--json']));
  const report = JSON.parse(verified.stdout);

  // İmza kapsadığı sürüm için geçerli, ama belge o sürüm değil: CLI de
  // yeşil tik göstermemeli. `cms.signatureValid` ayrımı raporda duruyor.
  assert.strictEqual(report.signatures[0].cms.signatureValid, true);
  assert.strictEqual(report.signatures[0].indication, 'INDETERMINATE');
  assert.strictEqual(report.signatures[0].subIndication, 'DOC_MODIFIED_AFTER_SIGNING');
  assert.strictEqual(report.documentIntegrity.modifiedAfterSigning, true,
    'değişiklik gizlenmemeli');
});

test('edit: --rewrite imzalı belgede reddedilir', async () => {
  const result = await run(['edit', at('t.pdf'), '-o', at('tam.pdf'),
    '--title', 'Yeni', '--rewrite']);

  assert.strictEqual(result.code, 1);
  assert.match(result.stderr, /ERR_WOULD_BREAK_SIGNATURE/);
});

/* ================================================================== */
/* Uyumluluk + imza birlikte                                          */
/* ================================================================== */

test('PDF/A belgesi imzalandıktan sonra da doğrulanır', async () => {
  const rendered = await run(['render', at('belge.html'), '-o', at('arsiv.pdf'),
    '--title', 'Arşivlik Belge', '--conformance', 'pdf/a-2b']);
  assert.strictEqual(rendered.code, 0, rendered.stderr);

  const checked = await run(['check', at('arsiv.pdf')]);
  assert.strictEqual(checked.code, 0, checked.stdout);

  const signed = await run(signArgs(at('arsiv.pdf'), at('arsiv-imzali.pdf'), ['--level', 'T']));
  assert.strictEqual(signed.code, 0, signed.stderr);

  const verified = await run(verifyArgs(at('arsiv-imzali.pdf')));
  assert.strictEqual(verified.code, 0);
  assert.match(verified.stdout, /TOTAL-PASSED/);
});

test('imzalı belgede uyumluluk iddiası korunur', async () => {
  const checked = await run(['check', at('arsiv-imzali.pdf'), '--json']);
  const report = JSON.parse(checked.stdout);

  assert.deepStrictEqual(report.profiles, ['pdf/a-2b'],
    'imzalama, XMP iddiasını silmemeli');
  assert.strictEqual(report.pdfA.claimed, 'PDF/A-2B');
});
