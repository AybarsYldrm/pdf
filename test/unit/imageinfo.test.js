'use strict';
/**
 * Görsel başlığı incelemesi ve sıkıştırma bombası savunması.
 *
 * SALDIRI: dosya küçük, çözülmüş hâli devasa. 40 KB'lık bir PNG başlığında
 * 20 000 × 20 000 bildirebilir; çözüldüğünde 1,6 GB tutar. "Dosya küçük,
 * demek ki zararsız" varsayımı tam olarak bunun üzerine kuruludur.
 *
 * SAVUNMA: sınır BAYT üzerinden değil, başlığın bildirdiği PİKSEL üzerinden
 * ve ayrıştırıcı çağrılmadan ÖNCE uygulanır.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { inspectImage, assertImageWithinLimits } =
  require('@fitfak/pdf/src/media/imageinfo');
const { AssetResolver } = require('@fitfak/pdf-html/src/assets/resolver');
const { AssetManager } = require('@fitfak/pdf-scene');

const hasCode = (code) => (err) => err && err.code === code;

/* ------------------------------------------------------------------ */
/* Kurgu üreticileri                                                   */
/* ------------------------------------------------------------------ */

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * Başlığında istenen ölçüyü BİLDİREN bir PNG üretir.
 *
 * `realPixels: false` ile piksel verisi yazılmaz — saldırganın yaptığı da
 * budur: küçük bir dosyada devasa bir ölçü bildirmek.
 */
function png({ width, height, bitDepth = 8, colorType = 2, interlace = 0, realPixels = true }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[12] = interlace;

  const samples = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] || 3;
  const rowBytes = Math.ceil((width * samples * bitDepth) / 8) + 1;
  const raw = realPixels ? Buffer.alloc(rowBytes * height) : Buffer.alloc(0);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function jpeg({ width, height, components = 3, marker = 0xc0 }) {
  const sof = Buffer.alloc(2 + 15);
  sof[0] = 0xff; sof[1] = marker;
  sof.writeUInt16BE(15, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = components;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),   // APP0
    sof,
    Buffer.from([0xff, 0xd9])
  ]);
}

/* ================================================================== */
/* Başlık okuma                                                        */
/* ================================================================== */

test('başlık: PNG ölçüsü ve bileşenleri okunur', () => {
  const info = inspectImage(png({ width: 40, height: 30 }));
  assert.strictEqual(info.format, 'png');
  assert.strictEqual(info.width, 40);
  assert.strictEqual(info.height, 30);
  assert.strictEqual(info.components, 3);
  assert.strictEqual(info.pixels, 1200);
  assert.strictEqual(info.decodedBytes, 1200 * 3);
});

test('başlık: PNG renk tipleri doğru bileşen sayısı verir', () => {
  const cases = [[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]];
  for (const [colorType, components] of cases) {
    const info = inspectImage(png({ width: 4, height: 4, colorType }));
    assert.strictEqual(info.components, components, `renk tipi ${colorType}`);
  }
});

test('başlık: Adam7 geçmeli PNG işaretlenir ve çözme payı artar', () => {
  const flat = inspectImage(png({ width: 100, height: 100 }));
  const woven = inspectImage(png({ width: 100, height: 100, interlace: 1 }));
  assert.strictEqual(flat.interlaced, false);
  assert.strictEqual(woven.interlaced, true);
  assert.ok(woven.decodedBytes > flat.decodedBytes,
    'geçmeli çözme ek tampon ister; pay yansımalı');
});

test('başlık: JPEG SOF işaretçisinden ölçü okunur', () => {
  const info = inspectImage(jpeg({ width: 640, height: 480 }));
  assert.strictEqual(info.format, 'jpeg');
  assert.strictEqual(info.width, 640);
  assert.strictEqual(info.height, 480);
  assert.strictEqual(info.progressive, false);
});

test('başlık: aşamalı (progressive) JPEG ayırt edilir', () => {
  assert.strictEqual(inspectImage(jpeg({ width: 8, height: 8, marker: 0xc2 })).progressive, true);
});

test('başlık: DHT işaretçisi çerçeve başlığı sanılmaz', () => {
  // 0xc4 (DHT) aralık içindedir ama SOF DEĞİLDİR; onu ölçü kaynağı saymak
  // rastgele baytları "genişlik" diye okumak olurdu.
  const dht = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xc4, 0x00, 0x06, 0x11, 0x22, 0x33, 0x44]),
    jpeg({ width: 21, height: 12 }).subarray(2)
  ]);
  const info = inspectImage(dht);
  assert.strictEqual(info.width, 21);
  assert.strictEqual(info.height, 12);
});

test('başlık: tanınmayan ve bozuk dosyalar reddedilir', () => {
  assert.throws(() => inspectImage(Buffer.alloc(4)), hasCode('ERR_IMAGE_TRUNCATED'));
  assert.throws(() => inspectImage(Buffer.alloc(64, 0x41)), hasCode('ERR_IMAGE_FORMAT'));

  // PNG imzası var ama IHDR yok
  const noIhdr = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('gAMA', Buffer.alloc(4)),
    Buffer.alloc(32)
  ]);
  assert.throws(() => inspectImage(noIhdr), hasCode('ERR_IMAGE_MALFORMED'));

  // JPEG ama SOF yok
  assert.throws(
    () => inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    hasCode('ERR_IMAGE_MALFORMED'));
});

test('başlık: sıfır ölçü reddedilir', () => {
  assert.throws(() => inspectImage(png({ width: 0, height: 10, realPixels: false })),
    hasCode('ERR_IMAGE_MALFORMED'));
});

test('başlık: geçersiz bit derinliği reddedilir', () => {
  const bad = png({ width: 4, height: 4 });
  bad[24] = 7;                                  // IHDR bit derinliği
  assert.throws(() => inspectImage(bad), hasCode('ERR_IMAGE_MALFORMED'));
});

/* ================================================================== */
/* Sıkıştırma bombası                                                  */
/* ================================================================== */

test('bomba: KÜÇÜK dosya, DEVASA ölçü — bayt sınırı yakalayamaz, piksel yakalar', () => {
  const bomb = png({ width: 20000, height: 20000, realPixels: false });

  // Saldırının özü: dosya minicik
  assert.ok(bomb.length < 200, `bomba ${bomb.length} bayt — bayt sınırına takılmaz`);

  const info = inspectImage(bomb);
  assert.strictEqual(info.pixels, 400_000_000);
  assert.ok(info.decodedBytes > 1_000_000_000, 'çözülünce 1 GB üstü');

  assert.throws(
    () => assertImageWithinLimits(bomb, { maxPixels: 50_000_000 }),
    hasCode('ERR_IMAGE_PIXELS'));
});

test('bomba: çözülmüş bayt sınırı da ayrıca uygulanır', () => {
  // 16 bit derinlik + RGBA = piksel başına 8 bayt: piksel sayısı sınırın
  // altında olsa bile bellek sınırı aşılabilir.
  const heavy = png({ width: 4000, height: 4000, bitDepth: 16, colorType: 6, realPixels: false });
  const info = inspectImage(heavy);
  assert.strictEqual(info.pixels, 16_000_000);
  assert.strictEqual(info.decodedBytes, 16_000_000 * 8);

  assert.doesNotThrow(() => assertImageWithinLimits(heavy, { maxPixels: 50_000_000 }));
  assert.throws(
    () => assertImageWithinLimits(heavy, { maxPixels: 50_000_000, maxDecodedBytes: 64 * 1024 * 1024 }),
    hasCode('ERR_IMAGE_DECODED_TOO_LARGE'));
});

test('bomba: JPEG için de piksel sınırı uygulanır', () => {
  const bomb = jpeg({ width: 30000, height: 30000 });
  assert.ok(bomb.length < 100);
  assert.throws(() => assertImageWithinLimits(bomb, { maxPixels: 50_000_000 }),
    hasCode('ERR_IMAGE_PIXELS'));
});

/* ================================================================== */
/* Kum havuzu ve varlık yöneticisi bunu GERÇEKTEN uyguluyor mu?         */
/* ================================================================== */

test('kum havuzu: bomba ayrıştırıcıya HİÇ ulaşmaz', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitfak-bomb-'));
  try {
    const file = path.join(dir, 'bomba.png');
    fs.writeFileSync(file, png({ width: 20000, height: 20000, realPixels: false }));

    const resolver = new AssetResolver({
      roots: [dir],
      limits: { maxImagePixels: 1_000_000 }
    });

    assert.throws(() => resolver.read('bomba.png', { kind: 'image' }),
      hasCode('ERR_IMAGE_PIXELS'));

    // Makul bir görsel geçmeli ve başlık bilgisi geri dönmeli
    fs.writeFileSync(path.join(dir, 'kucuk.png'), png({ width: 10, height: 8 }));
    const ok = resolver.read('kucuk.png', { kind: 'image' });
    assert.strictEqual(ok.info.width, 10);
    assert.strictEqual(ok.info.height, 8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('kum havuzu: bozuk görsel varlık kâhini olmadan reddedilir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitfak-bad-'));
  try {
    fs.writeFileSync(path.join(dir, 'sahte.png'), Buffer.from('bu bir PNG değil ama adı öyle'));
    const resolver = new AssetResolver({ roots: [dir] });
    assert.throws(() => resolver.read('sahte.png', { kind: 'image' }),
      hasCode('ERR_IMAGE_FORMAT'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('kum havuzu: font yolunda piksel denetimi ÇALIŞMAZ (font görsel değildir)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitfak-font-'));
  try {
    // Gerçek bir TTF: içeriği görsel olarak ayrıştırılmaya kalkışılmamalı
    const ttf = fs.readFileSync(path.resolve(__dirname, '../../assets/Ubuntu-Regular.ttf'));
    fs.writeFileSync(path.join(dir, 'font.ttf'), ttf);

    const resolver = new AssetResolver({ roots: [dir] });
    const out = resolver.read('font.ttf', { kind: 'font' });
    assert.strictEqual(out.data.length, ttf.length);
    assert.strictEqual(out.info, null, 'font için görsel başlığı okunmamalı');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('varlık yöneticisi: bomba ERR_ASSET_PIXELS ile reddedilir', () => {
  const am = new AssetManager({ limits: { maxPixels: 1_000_000 } });
  assert.throws(
    () => am.add(png({ width: 20000, height: 20000, realPixels: false })),
    hasCode('ERR_ASSET_PIXELS'));

  const ok = am.add(png({ width: 12, height: 7 }));
  assert.strictEqual(ok.width, 12);
  assert.strictEqual(ok.height, 7);
});

test('varlık yöneticisi: bozuk başlıklı görsel eklenmez', () => {
  const am = new AssetManager();
  // PNG imzası doğru ama IHDR bozuk: sniff() geçer, başlık okuması geçmez
  const broken = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(40, 0x00)
  ]);
  assert.throws(() => am.add(broken), (err) => /ERR_IMAGE|ERR_ASSET/.test(err.code));
});
