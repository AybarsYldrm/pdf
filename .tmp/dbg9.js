const { Scene, compileToPdf } = require('@fitfak/pdf-scene');
const { importFromPdf } = require('@fitfak/pdf-scene/src/import/pdf');
const zlib = require('zlib');
const FONTS = [{ family: 'Ubuntu', src: '/home/user/pdf/assets/Ubuntu-Regular.ttf' }];

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
  for (let x = 0; x < w; x++) { row[1 + x*3] = rgb[0]; row[2 + x*3] = rgb[1]; row[3 + x*3] = rgb[2]; }
  const raw = Buffer.concat(Array.from({length: h}, () => row));
  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

// 1) Kaynak sahne: dikdörtgen + elips + görsel + metin
const s = Scene.blank({ title: 'Kaynak' });
const asset = s.assets.add(makePng(4, 4, [200, 30, 40]), { name: 'kirmizi.png' });
s.transaction('kur', () => {
  s.addNode(Scene.createNode('rect', { id:'r1', x: 40, y: 40, width: 200, height: 60, fill: '#1f3a63' }));
  s.addNode(Scene.createNode('ellipse', { id:'e1', x: 300, y: 40, width: 80, height: 80, fill: '#00aa55', stroke:'#000000', strokeWidth: 2 }));
  s.addNode(Scene.createNode('image', { id:'i1', x: 60, y: 200, width: 120, height: 90, assetId: asset.id, fit: 'fill' }));
  s.addNode(Scene.createNode('text', { id:'t1', x: 60, y: 400, width: 300, height: 30, text: 'Merhaba dünya', fontSize: 14 }));
});
const { pdf } = compileToPdf(s, { fonts: FONTS, compress: true });
require('fs').writeFileSync('/home/user/pdf/.tmp/kaynak.pdf', pdf);

// 2) Geri içe aktar
const back = importFromPdf(pdf, { fonts: FONTS });
console.log('uyarılar:', back.warnings.map(w => w.code));
for (const n of back.scene.pages[0].nodes) {
  console.log(n.type, JSON.stringify(n.frame), n.fill || n.stroke || n.assetId || n.text || '', n.rotation || '');
}
console.log('varlıklar:', back.scene.assets.manifest());
