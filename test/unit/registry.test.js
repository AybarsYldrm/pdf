'use strict';
/**
 * Doğrulama kaydı — eklemeli, zincirli, HMAC'li.
 *
 * Bu defterin tek işi bir soruyu dürüstçe cevaplamaktır: "bu belge bizden
 * mi çıktı?" Kayıt silinebiliyor ya da değiştirilebiliyorsa cevap
 * anlamsızdır. Testler tam olarak bunu zorlar: kurcalanan defter
 * KURCALANDIĞINI söylemelidir.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  Registry, RegistryError, documentHash, recordFromReport
} = require('@fitfak/registry');

const KEY = 'test-anahtari-0123456789';
const dirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitfak-reg-'));
  dirs.push(dir);
  return dir;
}

const open = (dir, key = KEY) => new Registry({ dir, key });

const entry = (n) => ({
  documentHash: String(n).padStart(2, '0').repeat(32),
  docNo: `DOC-${n}`,
  signer: `İmzalayan ${n}`,
  issuer: 'Test CA',
  level: 'pades-lt',
  indication: 'PASSED',
  signatureCount: 1,
  timestamped: true
});

test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/* ================================================================== */
/* Yapılandırma                                                        */
/* ================================================================== */

test('kayıt: dizin verilmezse defter KAPALIDIR ve bunu söyler', () => {
  const reg = new Registry({});
  assert.strictEqual(reg.enabled, false);
  assert.deepStrictEqual(reg.describe(), { enabled: false, records: 0 });
  assert.strictEqual(reg.lookup('a'.repeat(64)), null);
  assert.throws(() => reg.append(entry(1)), (e) => e.code === 'ERR_REGISTRY_DISABLED');
});

test('kayıt: anahtarsız defter AÇILMAZ', () => {
  // Anahtarsız yazılan kayıt doğrulanamaz; doğrulanamayan kayıt, kayıt
  // değildir. Sessizce imzasız yazmaktansa açılmamak doğrudur.
  assert.throws(() => new Registry({ dir: tempDir() }),
    (e) => e instanceof RegistryError && e.code === 'ERR_REGISTRY_KEY');
  assert.throws(() => new Registry({ dir: tempDir(), key: 'kisa' }),
    (e) => e.code === 'ERR_REGISTRY_KEY');
});

/* ================================================================== */
/* Yazma ve okuma                                                      */
/* ================================================================== */

test('kayıt: yazılan kayıt özetle ve belge numarasıyla bulunur', () => {
  const reg = open(tempDir());
  reg.append(entry(1));
  reg.append(entry(2));

  assert.strictEqual(reg.lookup(entry(1).documentHash).docNo, 'DOC-1');
  assert.strictEqual(reg.lookupByDocNo('DOC-2').signer, 'İmzalayan 2');
  assert.strictEqual(reg.lookup('f'.repeat(64)), null, 'olmayan kayıt null olmalı');
});

test('kayıt: sıra numarası artar ve zincir bağlanır', () => {
  const reg = open(tempDir());
  const first = reg.append(entry(1));
  const second = reg.append(entry(2));

  assert.strictEqual(first.seq, 1);
  assert.strictEqual(second.seq, 2);

  const lines = fs.readFileSync(reg.file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(lines[0].prev, '', 'ilk kaydın öncesi yoktur');
  assert.strictEqual(lines[1].prev, lines[0].mac, 'ikinci kayıt birinciye bağlanmalı');
});

test('kayıt: geçersiz özet reddedilir', () => {
  const reg = open(tempDir());
  assert.throws(() => reg.append({ ...entry(1), documentHash: 'kisa' }),
    (e) => e.code === 'ERR_REGISTRY_HASH');
});

test('kayıt: aynı belge yeniden imzalanırsa SON kayıt geçerlidir', () => {
  const reg = open(tempDir());
  const hash = 'a'.repeat(64);
  reg.append({ ...entry(1), documentHash: hash, level: 'pades-t' });
  reg.append({ ...entry(1), documentHash: hash, level: 'pades-lta' });

  assert.strictEqual(reg.lookup(hash).level, 'pades-lta');
});

test('kayıt: belge İÇERİĞİ deftere yazılmaz', () => {
  const reg = open(tempDir());
  reg.append(entry(1));
  const text = fs.readFileSync(reg.file, 'utf8');

  // Defter bir arşiv değildir: yalnız özet, ad ve sonuç durur.
  const record = JSON.parse(text.trim());
  assert.deepStrictEqual(Object.keys(record).sort(), [
    'docNo', 'documentHash', 'indication', 'issuer', 'level', 'mac', 'prev',
    'seq', 'signatureCount', 'signedAt', 'signer', 'subIndication', 'timestamped'
  ]);
});

/* ================================================================== */
/* Kurcalama                                                           */
/* ================================================================== */

test('kurcalama: DEĞİŞTİRİLEN kayıt yakalanır', () => {
  const dir = tempDir();
  const reg = open(dir);
  reg.append(entry(1));
  reg.append(entry(2));

  const lines = fs.readFileSync(reg.file, 'utf8').trim().split('\n');
  const forged = JSON.parse(lines[0]);
  forged.signer = 'Sahtekâr';
  fs.writeFileSync(reg.file, [JSON.stringify(forged), lines[1]].join('\n') + '\n');

  const fresh = open(dir);
  const chain = fresh.verifyChain();
  assert.strictEqual(chain.ok, false);
  assert.strictEqual(chain.brokenAt, 1);
  assert.match(chain.reason, /HMAC/);
});

test('kurcalama: SİLİNEN kayıt zinciri kopartır', () => {
  const dir = tempDir();
  const reg = open(dir);
  reg.append(entry(1));
  reg.append(entry(2));
  reg.append(entry(3));

  const lines = fs.readFileSync(reg.file, 'utf8').trim().split('\n');
  fs.writeFileSync(reg.file, [lines[0], lines[2]].join('\n') + '\n');   // ortadaki silindi

  const chain = open(dir).verifyChain();
  assert.strictEqual(chain.ok, false);
  assert.strictEqual(chain.brokenAt, 2);
  assert.match(chain.reason, /Zincir kopuk/);
});

test('kurcalama: kırık noktadan SONRAKİ kayıtlar sayılmaz', () => {
  // Saldırgan defterin ortasını bozup sonuna kendi kaydını eklerse, o
  // kayıt "doğrulanmış" sayılmamalıdır.
  const dir = tempDir();
  const reg = open(dir);
  reg.append(entry(1));
  reg.append(entry(2));

  const lines = fs.readFileSync(reg.file, 'utf8').trim().split('\n');
  const broken = JSON.parse(lines[0]);
  broken.level = 'pades-lta';
  fs.writeFileSync(reg.file, [JSON.stringify(broken), lines[1]].join('\n') + '\n');

  const fresh = open(dir);
  assert.strictEqual(fresh.lookup(entry(2).documentHash), null,
    'kırık zincirin ardındaki kayıt bulunmamalı');
});

test('kurcalama: YANLIŞ anahtarla defter doğrulanamaz', () => {
  const dir = tempDir();
  open(dir).append(entry(1));

  const chain = open(dir, 'baska-bir-anahtar-123').verifyChain();
  assert.strictEqual(chain.ok, false);
});

test('kurcalama: bozuk satır ayrıştırma hatası olarak bildirilir', () => {
  const dir = tempDir();
  const reg = open(dir);
  reg.append(entry(1));
  fs.appendFileSync(reg.file, '{bu json değil}\n');

  const chain = open(dir).verifyChain();
  assert.strictEqual(chain.ok, false);
  assert.strictEqual(chain.brokenAt, 2);
});

/* ================================================================== */
/* Eşzamanlılık                                                        */
/* ================================================================== */

test('kilit: ard arda yazmalar zinciri bozmaz', () => {
  const reg = open(tempDir());
  for (let i = 1; i <= 20; i++) reg.append(entry(i));

  const chain = reg.verifyChain();
  assert.strictEqual(chain.ok, true, chain.reason);
  assert.strictEqual(chain.records, 20);
});

test('kilit: bayat kilit defteri sonsuza dek kilitli bırakmaz', () => {
  const dir = tempDir();
  const reg = open(dir);
  reg.append(entry(1));

  // Çökmüş bir sürecin bıraktığı kilit
  const lock = `${reg.file}.lock`;
  fs.writeFileSync(lock, '99999');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);

  assert.strictEqual(reg.append(entry(2)).seq, 2);
});

/* ================================================================== */
/* Yardımcılar                                                         */
/* ================================================================== */

test('recordFromReport: belge zaman damgası İMZALAYAN sayılmaz', () => {
  // LTA belgelerinde son "imza" bir belge zaman damgasıdır; onun sahibi
  // TSA'dır. Onu imzalayan diye yazmak, belgeyi TSA imzalamış gibi gösterir.
  const record = recordFromReport({
    signatures: [
      { type: 'signature', indication: 'TOTAL-PASSED', achievedLevel: 'pades-lta',
        signer: { cn: 'Aybars YILDIRIM' }, timestamps: [{ valid: true }] },
      { type: 'doc-timestamp', indication: 'TOTAL-PASSED',
        signer: { cn: 'Test TSA' }, timestamps: [] }
    ]
  }, { documentHash: 'a'.repeat(64) });

  assert.strictEqual(record.signer, 'Aybars YILDIRIM');
  assert.strictEqual(record.signatureCount, 1, 'zaman damgası imza sayılmaz');
});

test('documentHash: özet içerikten türer', () => {
  const a = documentHash(Buffer.from('belge'));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.strictEqual(a, documentHash(Buffer.from('belge')));
  assert.notStrictEqual(a, documentHash(Buffer.from('belge ')));
});

test('recordFromReport: rapordan yalnız ÖZET alınır', () => {
  const report = {
    signatures: [{
      type: 'signature',
      indication: 'TOTAL-PASSED', achievedLevel: 'pades-lt',
      signer: { cn: 'Aybars YILDIRIM', issuer: 'Test CA' },
      timestamps: [{ valid: true }],
      cms: { signatureValid: true, raw: 'ÇOK UZUN VERİ' }
    }]
  };
  const record = recordFromReport(report, { documentHash: 'a'.repeat(64), docNo: 'DOC-9' });

  assert.strictEqual(record.signer, 'Aybars YILDIRIM');
  assert.strictEqual(record.indication, 'TOTAL-PASSED');
  assert.strictEqual(record.level, 'pades-lt');
  assert.strictEqual(record.timestamped, true);
  assert.strictEqual(record.signatureCount, 1);
  assert.strictEqual(JSON.stringify(record).includes('ÇOK UZUN VERİ'), false,
    'imza verisi deftere girmemeli');
});
