'use strict';
/**
 * @fitfak/pdf-html birim testleri.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { render, PAGE_SIZES } = require('@fitfak/pdf-html');
const { parseHtml, decodeEntities } = require('@fitfak/pdf-html/src/html/parser');
const { parseCss, parseSelector, matches } = require('@fitfak/pdf-html/src/css/parser');
const { toPt, toColor, expandBox, expandBorder } = require('@fitfak/pdf-html/src/css/values');
const { StyleResolver } = require('@fitfak/pdf-html/src/css/cascade');
const paper = require('@fitfak/paper');

const ROOT = path.join(__dirname, '..', '..');
const FONT = path.join(ROOT, 'assets', 'Ubuntu-Regular.ttf');
const baseRender = (html, css = '', extra = {}) => render({
  html, css,
  fonts: [{ family: 'Ubuntu', src: FONT }],
  baseDir: ROOT,
  ...extra
});

/* ------------------------------------------------------------------ */
/* HTML ayrıştırma                                                      */
/* ------------------------------------------------------------------ */

test('HTML: temel ağaç kurulur', () => {
  const { root } = parseHtml('<div><p>Merhaba</p></div>');
  const div = root.children.find((c) => c.tag === 'div');
  assert.ok(div);
  assert.strictEqual(div.children[0].tag, 'p');
  assert.strictEqual(div.children[0].children[0].text, 'Merhaba');
});

test('HTML: void elementler kapatılmaz', () => {
  const { root } = parseHtml('<div><br><img src="a.png"><hr></div>');
  const div = root.children.find((c) => c.tag === 'div');
  assert.strictEqual(div.children.length, 3);
  assert.strictEqual(div.children[1].attrs.src, 'a.png');
});

test('HTML: öznitelik biçimleri (tırnaklı, tırnaksız, boş)', () => {
  const { root } = parseHtml('<div id="a" class=b data-x hidden></div>');
  const div = root.children.find((c) => c.tag === 'div');
  assert.strictEqual(div.attrs.id, 'a');
  assert.strictEqual(div.attrs.class, 'b');
  assert.strictEqual(div.attrs['data-x'], '');
  assert.strictEqual(div.attrs.hidden, '');
});

test('HTML: varlıklar (entity) çözülür', () => {
  assert.strictEqual(decodeEntities('a&amp;b'), 'a&b');
  assert.strictEqual(decodeEntities('&lt;x&gt;'), '<x>');
  assert.strictEqual(decodeEntities('&#231;'), 'ç');
  assert.strictEqual(decodeEntities('&#x15F;'), 'ş');
  assert.strictEqual(decodeEntities('&ndash;'), '–');
});

test('HTML: <p> otomatik kapanır', () => {
  const { root } = parseHtml('<div><p>bir<p>iki</div>');
  const div = root.children.find((c) => c.tag === 'div');
  assert.strictEqual(div.children.filter((c) => c.tag === 'p').length, 2);
});

test('HTML: <style> içeriği ayrı toplanır, DOM\'a girmez', () => {
  const { root, styles } = parseHtml('<style>p{color:red}</style><p>x</p>');
  assert.strictEqual(styles.length, 1);
  assert.ok(styles[0].includes('color:red'));

  const styleEl = root.children.find((c) => c.tag === 'style');
  assert.ok(styleEl, 'style elemanı DOM\'da yer tutar (display:none)');
  assert.strictEqual(styleEl.children.length, 0, 'ama CSS metni çocuk düğüm olmamalı');
});

test('HTML: yorumlar atılır', () => {
  const { root } = parseHtml('<div><!-- gizli -->görünür</div>');
  const div = root.children.find((c) => c.tag === 'div');
  assert.strictEqual(div.children.length, 1);
  assert.strictEqual(div.children[0].text, 'görünür');
});

/* ------------------------------------------------------------------ */
/* CSS değerleri                                                        */
/* ------------------------------------------------------------------ */

test('CSS: birimler pt\'ye çevrilir', () => {
  assert.strictEqual(toPt('12pt'), 12);
  assert.strictEqual(toPt('16px'), 12);
  assert.strictEqual(toPt('1in'), 72);
  assert.ok(Math.abs(toPt('10mm') - 28.346) < 0.01);
  assert.ok(Math.abs(toPt('1cm') - 28.346) < 0.01);
  assert.strictEqual(toPt('2em', { fontSize: 10 }), 20);
  assert.strictEqual(toPt('50%', { percentBase: 200 }), 100);
  assert.strictEqual(toPt('0'), 0);
  assert.strictEqual(toPt('auto'), null);
});

test('CSS: renkler ayrıştırılır', () => {
  assert.deepStrictEqual(toColor('#f00'), [255, 0, 0, 1]);
  assert.deepStrictEqual(toColor('#ff0000'), [255, 0, 0, 1]);
  assert.deepStrictEqual(toColor('rgb(1, 2, 3)'), [1, 2, 3, 1]);
  assert.deepStrictEqual(toColor('rgba(1,2,3,0.5)'), [1, 2, 3, 0.5]);
  assert.deepStrictEqual(toColor('white'), [255, 255, 255, 1]);
  assert.deepStrictEqual(toColor('transparent'), [0, 0, 0, 0]);
  const hsl = toColor('hsl(0, 100%, 50%)');
  assert.deepStrictEqual(hsl, [255, 0, 0, 1]);
  assert.strictEqual(toColor('gecersiz-renk'), null);
});

test('CSS: kutu kısayolu açılır', () => {
  assert.deepStrictEqual(expandBox('1pt'), { top: '1pt', right: '1pt', bottom: '1pt', left: '1pt' });
  assert.deepStrictEqual(expandBox('1pt 2pt'), { top: '1pt', right: '2pt', bottom: '1pt', left: '2pt' });
  assert.deepStrictEqual(expandBox('1pt 2pt 3pt 4pt'), { top: '1pt', right: '2pt', bottom: '3pt', left: '4pt' });
});

test('CSS: border kısayolu parçalanır', () => {
  const b = expandBorder('2pt solid #ff0000');
  assert.strictEqual(b.width, '2pt');
  assert.strictEqual(b.style, 'solid');
  assert.strictEqual(b.color, '#ff0000');
});

/* ------------------------------------------------------------------ */
/* CSS seçiciler ve cascade                                             */
/* ------------------------------------------------------------------ */

test('CSS: seçici özgüllüğü doğru hesaplanır', () => {
  assert.deepStrictEqual(parseSelector('div').specificity, [0, 0, 1]);
  assert.deepStrictEqual(parseSelector('.a').specificity, [0, 1, 0]);
  assert.deepStrictEqual(parseSelector('#a').specificity, [1, 0, 0]);
  assert.deepStrictEqual(parseSelector('div.a#b').specificity, [1, 1, 1]);
  assert.deepStrictEqual(parseSelector('div p').specificity, [0, 0, 2]);
});

test('CSS: torun ve çocuk birleştiricileri', () => {
  const { root } = parseHtml('<div class="a"><section><p>x</p></section></div>');
  const p = findTag(root, 'p');
  assert.ok(matches(p, parseSelector('.a p')), 'torun eşleşmeli');
  assert.ok(!matches(p, parseSelector('.a > p')), 'çocuk eşleşmemeli');
  const section = findTag(root, 'section');
  assert.ok(matches(section, parseSelector('.a > section')), 'doğrudan çocuk eşleşmeli');
});

test('CSS: :nth-child ve :first-child', () => {
  const { root } = parseHtml('<ul><li>1</li><li>2</li><li>3</li></ul>');
  const items = findTag(root, 'ul').children.filter((c) => c.tag === 'li');
  assert.ok(matches(items[0], parseSelector('li:first-child')));
  assert.ok(!matches(items[1], parseSelector('li:first-child')));
  assert.ok(matches(items[1], parseSelector('li:nth-child(even)')));
  assert.ok(matches(items[2], parseSelector('li:nth-child(3)')));
  assert.ok(matches(items[2], parseSelector('li:last-child')));
});

test('CSS: öznitelik seçicileri', () => {
  const { root } = parseHtml('<div data-signer="aybars" class="x"></div>');
  const div = findTag(root, 'div');
  assert.ok(matches(div, parseSelector('[data-signer]')));
  assert.ok(matches(div, parseSelector('[data-signer="aybars"]')));
  assert.ok(!matches(div, parseSelector('[data-signer="ahmet"]')));
});

test('CSS: !important ve özgüllük sıralaması', () => {
  const resolver = new StyleResolver([
    'p { color: red }',
    '.x { color: blue }',
    'p { color: green !important }'
  ]);
  const { root } = parseHtml('<p class="x">m</p>');
  const p = findTag(root, 'p');
  const computed = resolver.compute(p, null);
  assert.deepStrictEqual(computed.color, [0, 128, 0, 1], '!important kazanmalı');
});

test('CSS: değişkenler (var) kalıtımla geçer ve çözülür', () => {
  const resolver = new StyleResolver([
    ':root, .root { --ana: #123456; }',
    '.child { color: var(--ana); }'
  ]);
  const { root } = parseHtml('<div class="root"><span class="child">x</span></div>');
  const div = findTag(root, 'div');
  const span = findTag(root, 'span');
  const parentComputed = resolver.compute(div, null);
  const computed = resolver.compute(span, parentComputed);
  assert.deepStrictEqual(computed.color, [18, 52, 86, 1]);
});

test('CSS: var() kısayol içinde de çalışır (ertelenmiş açılım)', () => {
  const resolver = new StyleResolver([
    '.root { --w: 3pt; --c: #ff0000; }',
    '.box { border-left: var(--w) solid var(--c); }'
  ]);
  const { root } = parseHtml('<div class="root"><div class="box">x</div></div>');
  const outer = findTag(root, 'div');
  const box = outer.children.find((c) => c.tag === 'div');
  const computed = resolver.compute(box, resolver.compute(outer, null));

  assert.strictEqual(computed.raw['border-left-width'], '3pt',
    'kısayol içindeki var() çözülmeli — yoksa kenarlık sessizce kaybolur');
  assert.strictEqual(computed.raw['border-left-color'], '#ff0000');
});

test('CSS: @media screen baskıda uygulanmaz', () => {
  const resolver = new StyleResolver([
    'p { color: #000 }',
    '@media screen { p { color: #f00 } }',
    '@media print { p { font-size: 20pt } }'
  ]);
  const { root } = parseHtml('<p>x</p>');
  const computed = resolver.compute(findTag(root, 'p'), null);
  assert.deepStrictEqual(computed.color, [0, 0, 0, 1], 'screen kuralı uygulanmamalı');
  assert.strictEqual(computed.fontSize, 20, 'print kuralı uygulanmalı');
});

test('CSS: @page kuralı sayfa boyutunu belirler', () => {
  const { manifest } = baseRender('<p>x</p>', '@page { size: A5; margin: 10mm }');
  assert.ok(Math.abs(manifest.pages[0].width - PAGE_SIZES.A5[0]) < 1);
  assert.ok(Math.abs(manifest.pages[0].margin.top - 28.35) < 0.5);
});

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

test('render: geçerli PDF üretir', () => {
  const { pdf } = baseRender('<h1>Başlık</h1><p>Gövde</p>');
  assert.strictEqual(pdf.slice(0, 5).toString(), '%PDF-');
  assert.ok(pdf.includes('%%EOF'));
  assert.ok(pdf.length > 1000);
});

test('render: font olmadan net hata verir', () => {
  assert.throws(
    () => render({ html: '<p>x</p>', fonts: [] }),
    (e) => e.code === 'ERR_NO_FONT'
  );
});

test('render: uzun içerik sayfalara bölünür', () => {
  const long = Array.from({ length: 120 }, (_, i) => `<p>Paragraf ${i + 1}</p>`).join('');
  const { manifest } = baseRender(long);
  assert.ok(manifest.pageCount > 1, `birden çok sayfa beklenirdi, ${manifest.pageCount} bulundu`);
});

test('render: sayfa yönü landscape uygulanır', () => {
  const { manifest } = baseRender('<p>x</p>', '', { page: { size: 'A4', orientation: 'landscape' } });
  assert.ok(manifest.pages[0].width > manifest.pages[0].height);
});

test('MANIFEST: data-signer taşıyan elemanlar imza yuvası olur', () => {
  const { manifest } = baseRender(
    '<div class="row">' +
    '<div data-signer="aybars" data-role="Düzenleyen">A</div>' +
    '<div data-signer="ahmet" data-role="Onaylayan">B</div>' +
    '</div>',
    '.row{display:flex;gap:20pt} .row>div{width:150pt;min-height:50pt}'
  );

  assert.strictEqual(manifest.signatureSlots.length, 2);
  const [a, b] = manifest.signatureSlots;
  assert.strictEqual(a.id, 'aybars');
  assert.strictEqual(a.role, 'Düzenleyen');
  assert.strictEqual(b.id, 'ahmet');

  // Yan yana olmalılar: aynı y, farklı x
  assert.ok(Math.abs(a.rect.y - b.rect.y) < 1, 'aynı hizada olmalılar');
  assert.ok(b.rect.x > a.rect.x, 'ikincisi sağda olmalı');

  // Koordinatlar PDF kullanıcı uzayında (sol-alt orijin) ve sayfa içinde
  for (const s of manifest.signatureSlots) {
    assert.ok(s.rect.x >= 0 && s.rect.x < manifest.pages[0].width);
    assert.ok(s.rect.y >= 0 && s.rect.y < manifest.pages[0].height);
    assert.ok(s.rect.width > 0 && s.rect.height > 0);
    assert.strictEqual(s.origin, 'bottom-left');
  }
});

test('MANIFEST: başlıklar anahat (outline) girdisi üretir', () => {
  const { manifest } = baseRender('<h1>Birinci</h1><h2>İkinci</h2>');
  assert.strictEqual(manifest.outline.length, 2);
  assert.strictEqual(manifest.outline[0].title, 'Birinci');
  assert.strictEqual(manifest.outline[0].level, 1);
  assert.strictEqual(manifest.outline[1].level, 2);
});

test('MANIFEST: bağlantılar kaydedilir', () => {
  const { manifest } = baseRender('<p>Bir <a href="https://fitfak.net">bağlantı</a> var.</p>');
  assert.strictEqual(manifest.links.length, 1);
  assert.strictEqual(manifest.links[0].uri, 'https://fitfak.net');
  assert.ok(manifest.links[0].rect.width > 0);
});

test('render: eksik görsel uyarı üretir, çökmez', () => {
  const { pdf, warnings } = baseRender('<p><img src="yok-boyle-bir-dosya.png"></p>');
  assert.ok(pdf.length > 500);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].type, 'image');
});

test('render: tablo başlığı ve gövdesi çizilir', () => {
  const { pdf } = baseRender(
    '<table><thead><tr><th>A</th><th>B</th></tr></thead>' +
    '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    'table{width:100%} th,td{border:1pt solid #000;padding:4pt}'
  );
  assert.ok(pdf.length > 1000);
});

test('@fitfak/paper: tüm temalar hatasız derlenir', () => {
  for (const t of paper.THEMES) {
    const css = paper.stack(t);
    assert.strictEqual(css.length, 3);
    const { pdf, warnings } = baseRender(
      '<article class="paper paper--' + t + '"><h1>Başlık</h1><p>Gövde metni.</p>' +
      '<div class="paper-signature-row"><div class="paper-sig-slot" data-signer="x">İmza</div></div>' +
      '</article>',
      css
    );
    assert.ok(pdf.length > 1000, `${t} teması PDF üretmeli`);
    assert.strictEqual(warnings.length, 0, `${t} teması uyarı üretmemeli`);
  }
});

test('@fitfak/paper: bilinmeyen tema net hata verir', () => {
  assert.throws(() => paper.theme('olmayan'), /Bilinmeyen tema/);
});

/* ------------------------------------------------------------------ */

function findTag(node, tag) {
  if (node.tag === tag) return node;
  for (const child of node.children || []) {
    const found = findTag(child, tag);
    if (found) return found;
  }
  return null;
}
