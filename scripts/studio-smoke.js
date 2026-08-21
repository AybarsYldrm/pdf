'use strict';
/**
 * Studio duman testi — GERÇEK tarayıcıda uçtan uca içe aktarma.
 *
 * NEDEN AYRI: birim testler modeli sınar (`npm test`), bu ise tarayıcıdaki
 * yolu sınar — sahne paketi yükleniyor mu, sunucudan gelen varlık BAYTLARI
 * sahneye giriyor mu, tuval görseli gerçekten çiziyor mu, yatay sayfa yatay
 * kalıyor mu. Bu sorulara ancak bir tarayıcı cevap verebilir ve bu yüzden
 * `npm test`e bağlı DEĞİLDİR: Chromium her ortamda bulunmaz.
 *
 *     node scripts/studio-smoke.js
 *
 * Chromium yolu `CHROME` ortam değişkeniyle verilebilir. Uygulama kodunda
 * test kancası tutmamak için sonda, araya giren ince bir vekil tarafından
 * sayfaya eklenir; `window.fitfakStudio` uygulamanın kendi tanı yüzeyidir.
 *
 * Çıkış kodu: 0 temiz, 1 konsol hatası ya da sonda başarısız, 2 kurulum hatası.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createServer } = require('../apps/server/server');
const { Scene, compileToPdf } = require('@fitfak/pdf-scene');

const CHROME = process.env.CHROME ||
  process.env.CHROME_PATH ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ROOT = path.resolve(__dirname, '..');
const FONTS = [{ family: 'Ubuntu', src: path.join(ROOT, 'assets', 'Ubuntu-Regular.ttf') }];

function makePng(w, h, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(w * 3 + 1);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Görsel + metin + yatay ikinci sayfa taşıyan kaynak PDF. */
function sourcePdf() {
  const s = Scene.blank({ title: 'Tarayıcı turu', margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  const asset = s.assets.add(makePng(8, 8, [200, 30, 40]), { name: 'k.png' });
  s.transaction('kur', () => {
    s.addNode(Scene.createNode('image', {
      x: 60, y: 200, width: 120, height: 90, assetId: asset.id, fit: 'fill'
    }));
    s.addNode(Scene.createNode('text', {
      x: 72, y: 100, width: 300, height: 24, text: 'Tarayıcı turu', fontSize: 13
    }));
    s.addPage({ id: 'pg2', name: 'Yatay', width: 841.89, height: 595.28 });
    s.addNode(Scene.createNode('rect', {
      x: 700, y: 500, width: 100, height: 60, fill: '#aa2222'
    }), { pageId: 'pg2' });
  });
  return compileToPdf(s, { fonts: FONTS }).pdf;
}

const PROBE = (pdfB64) => `
(async () => {
  const out = (o) => {
    const n = document.createElement('div');
    n.id = '__probe';
    n.textContent = JSON.stringify(o);
    document.body.appendChild(n);
  };
  const waitFor = async (fn, ms = 12000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };

  try {
    // Uygulama bir ES modülüdür ve sahne paketini TEMBEL yükler; hazır
    // olmasını beklemeden sormak yalnız yarışı ölçer.
    const ready = await waitFor(() =>
      window.fitfakStudio && window.fitfakStudio.sceneEditor);
    if (!ready) return out({ ok: false, where: 'editor', error: 'editör kurulmadı' });

    const res = await fetch('/api/scene/import/pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf: ${JSON.stringify(pdfB64)} })
    });
    const body = await res.json();
    if (!res.ok) return out({ ok: false, where: 'import', error: body.error });

    const editor = window.fitfakStudio.sceneEditor;

    editor.loadScene(body.scene, body.assets || [], { analysis: body.analysis });
    await new Promise((r) => setTimeout(r, 400));

    const scene = editor.scene;
    const imageNode = scene.pages[0].nodes.find((n) => n.type === 'image');
    const assetId = imageNode && imageNode.assetId;

    // Tuvalde gerçekten bir <img> var mı ve adresi çözülmüş mü?
    const img = document.querySelector('.sc-canvas img');

    // İkinci sayfaya geç: yatay kâğıt gerçekten yatay mı?
    editor.setPage(1);
    const box = editor.canvas.pageBox;

    out({
      ok: true,
      assetsReturned: (body.assets || []).length,
      hasImageNode: !!imageNode,
      assetInScene: !!(assetId && scene.assets.bytes(assetId)),
      assetBytes: assetId ? (scene.assets.bytes(assetId) || []).length : 0,
      canvasImgSrc: img ? img.getAttribute('src').slice(0, 5) : null,
      thumbs: document.querySelectorAll('.sc-thumb').length,
      page2: [Math.round(box.width), Math.round(box.height)],
      analysisRows: document.querySelectorAll('.docscan__row').length,
      exportAssets: editor.exportAssets().length,
      validation: scene.validate().issues.length
    });
  } catch (err) {
    out({ ok: false, where: 'probe', error: String(err && err.stack || err) });
  }
})();
`;

(async () => {
  const http = require('http');
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  // Sondayı sayfaya sokmak için ince bir aracı: yalnız `/` yanıtına, kapanış
  // </body>'den önce betiği ekler. Uygulama kodunda test kancası tutmamak
  // için böyle; kalan her istek olduğu gibi geçer.
  const pdfB64 = sourcePdf().toString('base64');
  const probeTag = `<script>${PROBE(pdfB64)}</script>`;

  const proxy = http.createServer((req, res) => {
    const upstream = http.request(origin + req.url, { method: req.method, headers: req.headers }, (up) => {
      const isPage = req.url === '/' || req.url.startsWith('/?');
      if (!isPage) {
        res.writeHead(up.statusCode, up.headers);
        return up.pipe(res);
      }
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8')
          .replace('</body>', `${probeTag}\n</body>`);
        const headers = { ...up.headers };
        delete headers['content-length'];
        delete headers['content-security-policy'];
        res.writeHead(up.statusCode, headers);
        res.end(html);
      });
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${proxy.address().port}/`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-'));

  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--user-data-dir=${profile}`,
    '--enable-logging=stderr', '--v=0',
    '--virtual-time-budget=15000',
    '--dump-dom', url
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let dom = '';
  let err = '';
  child.stdout.on('data', (d) => { dom += d; });
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((r) => child.on('close', r));
  proxy.close();
  server.close();

  const problems = err.split('\n').filter((l) =>
    /ERROR:CONSOLE|Uncaught|SyntaxError|TypeError|ReferenceError|is not a function|is not defined/.test(l));

  const found = /id="__probe"[^>]*>([\s\S]*?)<\/div>/.exec(dom);
  let probe = null;
  try { probe = found ? JSON.parse(found[1]) : null; } catch { /* bozuk sonda */ }

  console.log(`chrome çıkışı: ${code}`);
  console.log('sonda:', found ? found[1] : '(çalışmadı)');

  // Sonda "ok" demesi yetmez; ölçtüğü şeylerin de doğru olması gerekir.
  const checks = probe && probe.ok ? [
    ['sunucu varlık baytlarını döndürdü', probe.assetsReturned === 1],
    ['görsel düğümü üretildi', probe.hasImageNode === true],
    ['baytlar SAHNENİN varlık havuzunda', probe.assetInScene === true],
    ['tuval görseli çiziyor', probe.canvasImgSrc === 'blob:'],
    ['sayfa şeridi doldu', probe.thumbs >= 3],
    ['yatay sayfa yatay kaldı', probe.page2 && probe.page2[0] > probe.page2[1]],
    ['çözümleme paneli doldu', probe.analysisRows > 0],
    ['dışa aktarma varlığı taşıyor', probe.exportAssets === 1],
    ['sahne kendi kendine geçerli', probe.validation === 0]
  ] : [['sonda çalıştı', false]];

  console.log('--- denetimler ---');
  for (const [label, ok] of checks) console.log(`${ok ? '✓' : '✕'} ${label}`);

  console.log('--- konsol ---');
  console.log(problems.length ? problems.join('\n') : '(temiz)');

  const failed = problems.length || checks.some(([, ok]) => !ok);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
