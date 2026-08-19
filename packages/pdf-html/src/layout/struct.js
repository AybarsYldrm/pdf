'use strict';
/**
 * Etiketli PDF (Tagged PDF) yapı ağacı — ISO 32000-1 §14.7, PDF/UA-1.
 *
 * Yerleşim motoru HTML'i zaten anlıyor: hangi kutu başlık, hangisi paragraf,
 * hangisi tablo hücresi. Bu bilgi çizim sırasında kaybolmasın diye burada
 * paralel bir **yapı ağacı** kurulur. Ağaç, içerik akışındaki işaretli içerik
 * (`/P <</MCID n>> BDC … EMC`) parçalarına bağlanır.
 *
 * Ekran okuyucular belgeyi bu ağaçtan okur; görsel sıralama değil, ağaçtaki
 * sıra "okuma sırası"dır.
 */

/** HTML etiketi → PDF yapı türü (ISO 32000-1 Tablo 333–337). */
const ROLE_BY_TAG = {
  h1: 'H1', h2: 'H2', h3: 'H3', h4: 'H4', h5: 'H5', h6: 'H6',
  p: 'P',
  blockquote: 'BlockQuote',
  pre: 'Code',
  ul: 'L', ol: 'L', li: 'LI',
  dl: 'L', dt: 'Lbl', dd: 'LBody',
  table: 'Table', thead: 'THead', tbody: 'TBody', tfoot: 'TFoot',
  tr: 'TR', th: 'TH', td: 'TD',
  caption: 'Caption',
  figure: 'Figure', figcaption: 'Caption',
  img: 'Figure',
  a: 'Link',
  article: 'Art', section: 'Sect', aside: 'Aside',
  header: 'Sect', footer: 'Sect', main: 'Sect', nav: 'Sect',
  div: 'Div', span: 'Span',
  form: 'Form',
  hr: null                       // yalnız süsleme: yapaydır (artifact)
};

/** Standart yapı türleri — doğrulayıcı bunları tanır. */
const STANDARD_ROLES = new Set([
  'Document', 'Part', 'Art', 'Sect', 'Div', 'BlockQuote', 'Caption', 'TOC', 'TOCI',
  'Index', 'NonStruct', 'Private', 'P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'L', 'LI', 'Lbl', 'LBody', 'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot',
  'Span', 'Quote', 'Note', 'Reference', 'BibEntry', 'Code', 'Link', 'Annot',
  'Ruby', 'Warichu', 'Figure', 'Formula', 'Form'
]);

class StructNode {
  /**
   * @param {string} role PDF yapı türü
   * @param {{ alt?: string, lang?: string, title?: string, scope?: string,
   *           actualText?: string }} [attrs]
   */
  constructor(role, attrs = {}) {
    this.role = role;
    this.alt = attrs.alt || null;
    this.lang = attrs.lang || null;
    this.title = attrs.title || null;
    this.scope = attrs.scope || null;
    this.actualText = attrs.actualText || null;
    /** Çocuklar: StructNode | { mcid, page } | { objr: <annotIndex>, page } */
    this.k = [];
  }

  get isEmpty() {
    return this.k.length === 0;
  }
}

/**
 * Yapı ağacını yönetir: yerleşim sırasında düğüm yığını tutar.
 *
 * Ölçüm turları (`FlowLayout.trial`) atılacağı için `mark()`/`restore()` ile
 * o tur boyunca eklenen düğümler geri alınabilir.
 */
class StructBuilder {
  constructor() {
    this.root = new StructNode('Document');
    this.stack = [this.root];
  }

  get top() { return this.stack[this.stack.length - 1]; }

  /** Yeni düğümü geçerli düğümün altına ekler ve yığına iter. */
  push(role, attrs) {
    const node = new StructNode(role, attrs);
    this.top.k.push(node);
    this.stack.push(node);
    return node;
  }

  pop() {
    if (this.stack.length > 1) this.stack.pop();
  }

  /** Ölçüm turu için geri alma noktası. */
  mark() {
    return { node: this.top, length: this.top.k.length, depth: this.stack.length };
  }

  /** Ölçüm turunda eklenen her şeyi siler. */
  restore(mark) {
    this.stack.length = mark.depth;
    mark.node.k.length = mark.length;
  }

  /** Boş kalan düğümleri ayıklar (PDF/UA: içeriksiz yapı elemanı istenmez). */
  prune(node = this.root) {
    node.k = node.k.filter((kid) => {
      if (!(kid instanceof StructNode)) return true;
      this.prune(kid);
      // İçeriği olmayan ama /Alt taşıyan Figure korunur
      return !kid.isEmpty || kid.alt != null;
    });
    return node;
  }
}

/** Kutudan yapı türü ve niteliklerini çıkarır. */
function roleFor(box) {
  const tag = box && box.tag;
  if (!tag) return null;
  if (!(tag in ROLE_BY_TAG)) return null;
  return ROLE_BY_TAG[tag];
}

/** HTML niteliklerinden erişilebilirlik bilgilerini toplar. */
function attrsFor(box) {
  const a = (box && box.attrs) || {};
  const out = {};

  // `role="presentation"` çağrısı: eleman anlamsızdır (yapay)
  if (a.role === 'presentation' || a.role === 'none' || a['aria-hidden'] === 'true') {
    return { presentational: true };
  }
  if (a.alt) out.alt = a.alt;
  if (a['aria-label']) out.alt = a['aria-label'];
  if (a.title) out.title = a.title;
  if (a.lang) out.lang = a.lang;
  if (a.scope) out.scope = a.scope === 'col' ? 'Column' : a.scope === 'row' ? 'Row' : null;
  return out;
}

module.exports = { StructNode, StructBuilder, ROLE_BY_TAG, STANDARD_ROLES, roleFor, attrsFor };
