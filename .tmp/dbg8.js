const { Scene, compileToPdf } = require('@fitfak/pdf-scene');
const FONTS = [{ family: 'Ubuntu', src: '/home/user/pdf/assets/Ubuntu-Regular.ttf' }];
const s = Scene.blank({ title: 'Yol' });
s.transaction('x', () => {
  s.addNode(Scene.createNode('path', {
    id: 'p1', x: 100, y: 100, width: 200, height: 100,
    d: [['M', 0, 0], ['L', 10, 0], ['C', 10, 5, 5, 10, 0, 10], ['Z']],
    fill: '#1f3a63', stroke: '#ff0000', strokeWidth: 2, fillRule: 'evenodd'
  }));
});
const out = compileToPdf(s, { fonts: FONTS, compress: false });
const raw = out.pdf.toString('latin1');
const k = raw.indexOf('stream', raw.indexOf('/Contents'));
// find content stream: search for ' re' or ' m'
const m = raw.match(/q\n[\s\S]{0,400}?Q/);
console.log(m && m[0]);
