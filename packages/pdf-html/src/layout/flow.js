'use strict';
/**
 * Akış yerleşimi: block, flex, table ve mutlak konumlandırma.
 *
 * Çıktı, sayfalanmış bir ÇİZİM LİSTESİdir. Koordinatlar PDF kullanıcı uzayında
 * (sol-alt köşe orijin) verilir; yerleşim ise yukarıdan aşağı yapılır ve son
 * adımda çevrilir.
 */

const { toPt, toColor } = require('../css/values');
const { isBlockDisplay, applyTextTransform } = require('./engine');
const { StructBuilder, StructNode, roleFor, attrsFor } = require('./struct');

const LIST_MARKERS = {
  disc: '•', circle: '◦', square: '▪', none: ''
};

class FlowLayout {
  /**
   * @param {import('./engine').LayoutEngine} engine
   */
  constructor(engine) {
    this.engine = engine;
    this.page = engine.page;
    this.pages = [];
    this.current = null;
    this.pendingBreak = false;
    this.repeatHeaders = [];   // sayfa başına tekrar edecek tablo başlıkları
    this.counters = { page: 0 };

    /** Etiketli PDF yapı ağacı — çizim listesiyle paralel kurulur. */
    this.struct = new StructBuilder();
    /** >0 iken üretilen her öğe yapay (artifact) sayılır. */
    this._artifactDepth = 0;
  }

  get contentWidth() {
    return this.page.width - this.page.margin.left - this.page.margin.right;
  }
  get contentHeight() {
    return this.page.height - this.page.margin.top - this.page.margin.bottom;
  }

  newPage() {
    this.current = {
      index: this.pages.length,
      items: [],
      width: this.page.width,
      height: this.page.height
    };
    this.pages.push(this.current);
    this.cursorY = 0;                    // içerik alanının üstünden itibaren
    this.counters.page = this.pages.length;

    // Tekrar eden tablo başlıklarını yeni sayfaya bas
    for (const header of this.repeatHeaders) {
      const h = this.asArtifact(() => this.emitRows(header.rows, header.x, this.cursorY,
        header.columns, header.style, true));
      this.cursorY += h;
    }
    return this.current;
  }

  ensurePage() {
    if (!this.current) this.newPage();
  }

  /** Dikey alan yetmiyorsa sayfa kırar. */
  ensureSpace(height) {
    this.ensurePage();
    // Bölünmemesi gereken bir kutunun içindeyken sayfa kırmayız; kırma kararı
    // kutunun tamamı için, ölçüm turundan sonra verilir.
    if (this._noBreak) return false;
    if (this.cursorY + height > this.contentHeight + 0.01 && this.cursorY > 0) {
      this.newPage();
      return true;
    }
    return false;
  }

  /**
   * Bir yerleşim işini ATILACAK bir sayfa üzerinde deneyip yüksekliğini ölçer.
   *
   * Sayfa kırma kararını doğru verebilmek için gerekli: "bu kutu kalan alana
   * sığıyor mu?" sorusu, kutu çizilmeden önce cevaplanmalıdır. Aksi hâlde
   * flex satırındaki her öğe ayrı ayrı sayfa kırıyordu.
   *
   * @param {Function} fn
   * @returns {number} kullanılan yükseklik (birden çok sayfaya taştıysa Infinity)
   */
  trial(fn) {
    const saved = {
      pages: this.pages, current: this.current, cursorY: this.cursorY,
      headers: this.repeatHeaders.slice(), noBreak: this._noBreak,
      struct: this.struct.mark(),
      slots: this.engine.slots.length,
      links: this.engine.links.length,
      outline: this.engine.outline.length
    };

    this.pages = [];
    this.current = null;
    this.newPage();
    const startY = this.cursorY;
    let height;
    try {
      fn();
      height = this.pages.length > 1 ? Infinity : this.cursorY - startY;
    } finally {
      this.pages = saved.pages;
      this.current = saved.current;
      this.cursorY = saved.cursorY;
      this.repeatHeaders = saved.headers;
      this._noBreak = saved.noBreak;
      this.struct.restore(saved.struct);
      this.engine.slots.length = saved.slots;
      this.engine.links.length = saved.links;
      this.engine.outline.length = saved.outline;
    }
    return height;
  }

  /** Kalan dikey alan. */
  get remainingHeight() {
    return this.contentHeight - this.cursorY;
  }

  /**
   * Çizim öğesi ekler (koordinatlar içerik alanına göre).
   *
   * `artifact: true` verilmeyen her öğe, o an açık olan yapı düğümüne
   * bağlanır. MCID numaraları burada DEĞİL, içerik akışı yazılırken atanır:
   * dekorasyonlar listeye sonradan araya sokulduğu için sıra ancak o zaman
   * kesinleşir.
   */
  emit(item) {
    this.ensurePage();
    if (this._artifactDepth > 0) item.artifact = true;
    if (!item.artifact) item.struct = this.struct.top;
    this.current.items.push(item);
  }

  /** Yapay (dekoratif) öğe: ekran okuyucu görmez. */
  emitArtifact(item) {
    item.artifact = true;
    this.emit(item);
  }

  /**
   * Satır içi bir görseli `Figure` yapı elemanına sarar.
   *
   * Blok bağlamındaki `<img>` zaten `layoutBlockInner` üzerinden Figure açar;
   * satır içi olan bu yoldan geçmez ve sarılmazsa paragrafın parçası sayılırdı
   * — o zaman /Alt hiç istenmez ve erişilebilirlik sessizce kaybolur.
   */
  inFigure(item, fn) {
    const attrs = item.box ? attrsFor(item.box) : {};
    if (attrs.presentational) {
      // role="presentation" → süsleme; ekran okuyucu atlar
      return this.asArtifact(fn);
    }
    this.struct.push('Figure', attrs);
    try { return fn(); } finally { this.struct.pop(); }
  }

  /** Verilen iş boyunca üretilen her şeyi yapay sayar. */
  asArtifact(fn) {
    this._artifactDepth++;
    try { return fn(); } finally { this._artifactDepth--; }
  }

  /* ---------------------------------------------------------------- */
  /* Ana giriş                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Kök kutuyu yerleştirir.
   * @param {Object} rootBox
   * @returns {{ pages: Array }}
   */
  run(rootBox) {
    this.newPage();
    this.layoutBlockChildren(rootBox, 0, this.contentWidth, rootBox.style);
    return { pages: this.pages };
  }

  /* ---------------------------------------------------------------- */
  /* Block akışı                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Bir kapsayıcının çocuklarını dikey akışta yerleştirir.
   * @returns {number} kullanılan toplam yükseklik
   */
  layoutBlockChildren(box, x, width, parentStyle) {
    const startY = this.cursorY;
    let inlineRun = [];

    const flushInline = () => {
      if (!inlineRun.length) return;
      const { lines } = this.engine.layoutInline(inlineRun, width, parentStyle);
      this.emitLines(lines, x, width, parentStyle);
      inlineRun = [];
    };

    for (const child of box.children) {
      if (child.kind === 'text') {
        if (child.text.trim() || child.style.whiteSpace === 'pre') inlineRun.push(child);
        continue;
      }

      const display = child.style.display;
      const position = child.style.position;

      if (position === 'absolute' || position === 'fixed') {
        flushInline();
        this.layoutAbsolute(child, x, width);
        continue;
      }

      if (!isBlockDisplay(display)) {
        inlineRun.push(child);
        continue;
      }

      flushInline();
      this.layoutBlock(child, x, width);
    }
    flushInline();

    return this.cursorY - startY;
  }

  /** Tek bir blok kutusunu yerleştirir. */
  layoutBlock(box, containerX, containerWidth) {
    const style = box.style;

    // Sayfa kırma yönergeleri
    const breakBefore = style.raw['break-before'] || style.raw['page-break-before'];
    if (breakBefore === 'always' || breakBefore === 'page') {
      if (this.cursorY > 0 && !this._noBreak) this.newPage();
    }

    // break-inside: avoid → kutu bölünmemeli. Önce ölçüp sığmıyorsa sayfa kır.
    const avoidBreak = (style.raw['break-inside'] === 'avoid' ||
                        style.raw['page-break-inside'] === 'avoid');
    if (avoidBreak && !this._noBreak && this.cursorY > 0) {
      const needed = this.trial(() => {
        this._noBreak = true;
        this.layoutBlockInner(box, containerX, containerWidth);
      });
      if (needed !== Infinity && needed > this.remainingHeight) this.newPage();
    }

    this.layoutBlockInner(box, containerX, containerWidth);

    const breakAfter = style.raw['break-after'] || style.raw['page-break-after'];
    if (breakAfter === 'always' || breakAfter === 'page') {
      if (!this._noBreak) this.newPage();
    }
  }

  /**
   * layoutBlock'un gövdesi — ölçüm turunda da çağrılabilsin diye ayrı.
   *
   * Kutu bir anlam taşıyorsa (başlık, paragraf, tablo hücresi…) yapı ağacında
   * bir düğüm açılır; içindeki her çizim öğesi o düğüme bağlanır.
   */
  layoutBlockInner(box, containerX, containerWidth) {
    const opened = this.openStruct(box);
    try {
      this.layoutBlockBody(box, containerX, containerWidth);
    } finally {
      for (let i = 0; i < opened; i++) this.struct.pop();
    }
  }

  /**
   * Kutuya karşılık gelen yapı düğümlerini açar; açılan düğüm sayısını döndürür.
   * `<li>` iki düğüm açar: `LI` ve içeriği taşıyan `LBody`.
   */
  openStruct(box) {
    const attrs = attrsFor(box);
    if (attrs.presentational) return 0;      // role="presentation" → yapay

    const role = roleFor(box);
    if (!role) return 0;

    this.struct.push(role, attrs);
    if (role === 'LI') {
      this.struct.push('LBody', {});
      return 2;
    }
    return 1;
  }

  layoutBlockBody(box, containerX, containerWidth) {
    const style = box.style;
    const e = this.engine.edges(style, containerWidth);

    const declaredWidth = this.engine.resolveSize(style, 'width', containerWidth);
    const outerWidth = declaredWidth != null
      ? declaredWidth + e.padding.left + e.padding.right + e.border.left + e.border.right
      : containerWidth - e.margin.left - e.margin.right;

    const boxX = containerX + e.margin.left;
    const innerWidth = outerWidth - e.padding.left - e.padding.right - e.border.left - e.border.right;

    this.cursorY += e.margin.top;
    const boxTop = this.cursorY;
    const contentTop = boxTop + e.border.top + e.padding.top;
    this.cursorY = contentTop;

    // Arka plan ve kenarlık, içeriğin ALTINDA kalmalıdır. İçeriği çizmeden önce
    // listedeki yeri işaretliyoruz; dekorasyon sonradan TAM BURAYA eklenecek.
    // (Bu işaret olmadan arka plan en sona eklenip metnin ÜSTÜNÜ kapatıyordu.)
    const markPage = this.current.index;
    const markIndex = this.current.items.length;

    // Liste işareti — PDF/UA'da LI, Lbl + LBody taşır. İşaret LBody'nin değil,
    // LI'nin doğrudan çocuğudur ve okuma sırasında LBody'den ÖNCE gelir.
    if (style.display === 'list-item') {
      const stack = this.struct.stack;
      const li = stack[stack.length - 1].role === 'LBody' ? stack[stack.length - 2] : null;

      if (li) {
        const label = new StructNode('Lbl');
        li.k.unshift(label);
        stack.push(label);
        try {
          this.emitListMarker(box, boxX, innerWidth, style);
        } finally {
          stack.pop();
        }
      } else {
        this.emitListMarker(box, boxX, innerWidth, style);
      }
    }

    let contentHeight = 0;
    const display = style.display;

    if (box.tag === 'img') {
      // Blok/flex bağlamındaki görsel: satır içi yoldan geçmez, doğrudan çizilir.
      contentHeight = this.emitBlockImage(box, boxX + e.border.left + e.padding.left, innerWidth);
    } else if (display === 'flex') {
      contentHeight = this.layoutFlex(box, boxX + e.border.left + e.padding.left, innerWidth);
    } else if (display === 'table') {
      contentHeight = this.layoutTable(box, boxX + e.border.left + e.padding.left, innerWidth);
    } else {
      contentHeight = this.layoutBlockChildren(
        box, boxX + e.border.left + e.padding.left, innerWidth, style
      );
    }

    const declaredHeight = this.engine.resolveSize(style, 'height', this.contentHeight);
    const minHeight = this.engine.resolveSize(style, 'min-height', this.contentHeight);
    if (declaredHeight != null && declaredHeight > contentHeight) {
      this.cursorY = contentTop + declaredHeight;
      contentHeight = declaredHeight;
    } else if (minHeight != null && minHeight > contentHeight) {
      this.cursorY = contentTop + minHeight;
      contentHeight = minHeight;
    }

    this.cursorY += e.padding.bottom + e.border.bottom;
    const boxHeight = this.cursorY - boxTop;

    // Arka plan ve kenarlık (içeriğin ALTINA çizilmeli)
    this.emitBoxDecoration(box, boxX, boxTop, outerWidth, boxHeight, e, { markPage, markIndex });

    // İmza yuvası mı? (layout manifest'in kaynağı)
    this.captureSlot(box, boxX, boxTop, outerWidth, boxHeight);

    // Başlıksa anahat (outline) girdisi
    this.captureOutline(box, boxTop);

    this.cursorY += e.margin.bottom;
  }

  /** Blok bağlamındaki bir görseli çizer; kullanılan yüksekliği döndürür. */
  emitBlockImage(box, x, width) {
    const img = this.engine.tryLoadImage(box);
    if (!img) return 0;

    this.ensureSpace(img.height);
    let ox = x;
    const align = box.style.textAlign;
    if (align === 'center') ox = x + (width - img.width) / 2;
    else if (align === 'right') ox = x + width - img.width;

    this.emit({
      type: 'image', image: img.image, src: img.src,
      x: ox, y: this.cursorY, width: img.width, height: img.height,
      page: this.current.index, opacity: box.style.opacity
    });
    this.cursorY += img.height;
    return img.height;
  }

  /**
   * Arka plan + kenarlıkları çizim listesine ekler.
   *
   * `mark`, kutunun içeriği çizilmeden ÖNCE alınan yer işaretidir; dekorasyon
   * oraya eklenir ki metnin altında kalsın. İçerik sayfa değiştirdiyse
   * dekorasyon, başladığı sayfanın o noktasına yazılır.
   */
  emitBoxDecoration(box, x, y, width, height, e, mark = null) {
    const style = box.style;
    const bg = toColor(style.raw['background-color']);
    const radius = toPt(style.raw['border-top-left-radius'], { fontSize: style.fontSize }) || 0;

    // Hedef sayfa: içerik sayfa değiştirdiyse dekorasyon BAŞLADIĞI sayfaya gider.
    const targetPage = mark && mark.markPage !== this.current.index
      ? this.pages[mark.markPage]
      : this.current;
    const insertAt = mark && mark.markPage === this.current.index
      ? mark.markIndex
      : (mark ? mark.markIndex : targetPage.items.length);

    // Sayfa değiştiyse kutu, başladığı sayfanın sonuna kadar uzanır.
    const drawHeight = (mark && mark.markPage !== this.current.index)
      ? Math.max(0, this.contentHeight - y)
      : height;

    const decorations = [];
    if (bg && bg[3] > 0) {
      decorations.push({
        type: 'rect', x, y, width, height: drawHeight, fill: bg, radius,
        page: targetPage.index, opacity: style.opacity, artifact: true
      });
    }

    const sides = [
      ['top',    x, y, width, e.border.top],
      ['bottom', x, y + drawHeight - e.border.bottom, width, e.border.bottom],
      ['left',   x, y, e.border.left, drawHeight],
      ['right',  x + width - e.border.right, y, e.border.right, drawHeight]
    ];
    for (const [side, sx, sy, sw, sh] of sides) {
      if (!sh || sh <= 0 || !sw || sw <= 0) continue;
      const color = toColor(style.raw[`border-${side}-color`]) || [0, 0, 0, 1];
      const bstyle = style.raw[`border-${side}-style`] || 'solid';
      if (bstyle === 'none' || bstyle === 'hidden') continue;
      decorations.push({
        type: 'rect', x: sx, y: sy, width: sw, height: sh, fill: color,
        page: targetPage.index, opacity: style.opacity, artifact: true,
        dash: bstyle === 'dashed' ? [3, 2] : (bstyle === 'dotted' ? [1, 2] : null)
      });
    }

    if (decorations.length) {
      targetPage.items.splice(Math.min(insertAt, targetPage.items.length), 0, ...decorations);
    }
  }

  emitListMarker(box, x, width, style) {
    const type = style['list-style-type'] || 'disc';
    let marker = LIST_MARKERS[type];
    if (marker === undefined) {
      const parent = box.node.parent;
      const siblings = parent ? parent.children.filter((c) => c.type === 'element' && c.tag === 'li') : [];
      const idx = siblings.indexOf(box.node) + 1;
      marker = formatListNumber(idx, type) + '.';
    }
    if (!marker) return;

    const face = this.engine.fonts.resolve(style.fontFamily, style.fontWeight, style.fontStyle);
    const w = this.engine.fonts.measure(marker, face, style.fontSize, 0);
    this.emit({
      type: 'text', text: marker, face, style,
      x: x - w - style.fontSize * 0.4,
      y: this.cursorY + style.fontSize * 0.85,
      fontSize: style.fontSize, color: style.color,
      page: this.current.index
    });
  }

  /** Satır kutularını çizim listesine yazar. */
  emitLines(lines, x, width, parentStyle) {
    for (const line of lines) {
      const lineHeight = line.height || parentStyle.lineHeight;
      this.ensureSpace(lineHeight);

      const align = parentStyle.textAlign;
      let offset = 0;
      let extraSpace = 0;
      if (align === 'center') offset = (width - line.width) / 2;
      else if (align === 'right') offset = width - line.width;
      else if (align === 'justify' && line !== lines[lines.length - 1]) {
        const spaces = line.items.filter((i) => i.isSpace).length;
        if (spaces > 0) extraSpace = (width - line.width) / spaces;
      }

      let penX = x + Math.max(0, offset);
      const baselineY = this.cursorY + lineHeight - (lineHeight - parentStyle.fontSize * 0.8) / 2;

      for (const item of line.items) {
        if (item.type === 'image') {
          this.inFigure(item, () => this.emit({
            type: 'image', image: item.image, src: item.src,
            x: penX, y: this.cursorY + lineHeight - item.height,
            width: item.width, height: item.height,
            page: this.current.index, opacity: item.style ? item.style.opacity : 1
          }));
          penX += item.width;
          continue;
        }

        const itemBaseline = this.cursorY + lineHeight
          - (lineHeight - item.style.fontSize * 0.8) / 2;

        if (!item.isSpace) {
          // Bağlantı metni kendi `Link` yapı elemanına girer; açıklama nesnesi
          // sonradan (nesne numarası belli olunca) OBJR ile ona bağlanır.
          const linkNode = item.href
            ? this.struct.push('Link', { alt: item.linkTitle || null })
            : null;

          this.emit({
            type: 'text', text: item.text, face: item.face, style: item.style,
            x: penX, y: itemBaseline, fontSize: item.style.fontSize,
            color: item.style.color, letterSpacing: item.style.letterSpacing,
            page: this.current.index, opacity: item.style.opacity
          });

          if (item.style.textDecoration.includes('underline')) {
            this.emit({
              type: 'rect', x: penX, y: itemBaseline + item.style.fontSize * 0.12,
              width: item.width, height: Math.max(0.5, item.style.fontSize * 0.05),
              fill: item.style.color, page: this.current.index, artifact: true
            });
          }
          if (item.style.textDecoration.includes('line-through')) {
            this.emit({
              type: 'rect', x: penX, y: itemBaseline - item.style.fontSize * 0.28,
              width: item.width, height: Math.max(0.5, item.style.fontSize * 0.05),
              fill: item.style.color, page: this.current.index, artifact: true
            });
          }
          if (item.href) {
            this.engine.links.push({
              page: this.current.index, uri: item.href,
              rect: { x: penX, y: itemBaseline - item.style.fontSize * 0.25,
                      width: item.width, height: item.style.fontSize * 1.1 },
              structNode: linkNode,
              _pending: true
            });
            this.struct.pop();
          }
        }
        penX += item.width + (item.isSpace ? extraSpace : 0);
      }
      this.cursorY += lineHeight;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Flex                                                              */
  /* ---------------------------------------------------------------- */

  layoutFlex(box, x, width) {
    const style = box.style;
    const direction = (style.raw['flex-direction'] || 'row').toLowerCase();
    const justify = (style.raw['justify-content'] || 'flex-start').toLowerCase();
    const alignItems = (style.raw['align-items'] || 'stretch').toLowerCase();
    const colGap = toPt(style.raw['column-gap'], { fontSize: style.fontSize, percentBase: width }) || 0;
    const rowGap = toPt(style.raw['row-gap'], { fontSize: style.fontSize, percentBase: width }) || 0;

    const items = box.children.filter((c) => c.kind === 'box' && c.style.display !== 'none');
    if (!items.length) return 0;

    if (direction === 'column' || direction === 'column-reverse') {
      const ordered = direction === 'column-reverse' ? [...items].reverse() : items;
      const startY = this.cursorY;
      for (let i = 0; i < ordered.length; i++) {
        this.layoutBlock(ordered[i], x, width);
        if (i < ordered.length - 1) this.cursorY += rowGap;
      }
      return this.cursorY - startY;
    }

    // Satır yönü: her öğenin genişliğini belirle
    const ordered = direction === 'row-reverse' ? [...items].reverse() : items;
    const n = ordered.length;
    const totalGap = colGap * (n - 1);
    const available = width - totalGap;

    const measured = ordered.map((item) => {
      const e = this.engine.edges(item.style, width);
      const basis = item.style.raw['flex-basis'];
      let w = null;
      if (basis && basis !== 'auto') w = toPt(basis, { fontSize: item.style.fontSize, percentBase: width });
      if (w == null) w = this.engine.resolveSize(item.style, 'width', width);
      const grow = parseFloat(item.style.raw['flex-grow'] || '0') || 0;
      return { item, e, width: w, grow, outer: (w != null ? w : 0) + e.margin.left + e.margin.right };
    });

    const fixedTotal = measured.reduce((s, m) => s + (m.width != null ? m.outer : 0), 0);
    const autoItems = measured.filter((m) => m.width == null);
    const growTotal = measured.reduce((s, m) => s + m.grow, 0);

    let remaining = available - fixedTotal;
    if (autoItems.length) {
      const each = Math.max(0, remaining / autoItems.length);
      for (const m of autoItems) {
        m.width = Math.max(0, each - m.e.margin.left - m.e.margin.right);
        m.outer = m.width + m.e.margin.left + m.e.margin.right;
      }
      remaining = 0;
    } else if (growTotal > 0 && remaining > 0) {
      for (const m of measured) {
        if (!m.grow) continue;
        const add = remaining * (m.grow / growTotal);
        m.width += add;
        m.outer += add;
      }
      remaining = 0;
    }

    const usedWidth = measured.reduce((s, m) => s + m.outer, 0) + totalGap;
    let startX = x;
    let gap = colGap;
    const free = width - usedWidth;
    if (free > 0) {
      if (justify === 'center') startX += free / 2;
      else if (justify === 'flex-end' || justify === 'end' || justify === 'right') startX += free;
      else if (justify === 'space-between' && n > 1) gap = colGap + free / (n - 1);
      else if (justify === 'space-around' && n > 0) { gap = colGap + free / n; startX += gap / 2; }
      else if (justify === 'space-evenly' && n > 0) { gap = colGap + free / (n + 1); startX += gap; }
    }

    // Satırı çizmek: her öğe AYNI üst hizadan başlar. Bu yüzden öğeler tek tek
    // sayfa kıramaz — kırma kararı satırın tamamı için, önceden verilir.
    const drawRow = () => {
      const rowTop = this.cursorY;
      let maxBottom = rowTop;
      let penX = startX;

      for (const m of measured) {
        this.cursorY = rowTop;
        const savedWidth = m.item.style.raw.width;
        m.item.style.raw.width = `${m.width}pt`;
        this.layoutBlock(m.item, penX, m.outer);
        if (savedWidth === undefined) delete m.item.style.raw.width;
        else m.item.style.raw.width = savedWidth;

        maxBottom = Math.max(maxBottom, this.cursorY);
        penX += m.outer + gap;
      }
      this.cursorY = maxBottom;
      return maxBottom - rowTop;
    };

    if (!this._noBreak) {
      const needed = this.trial(() => { this._noBreak = true; drawRow(); });
      if (needed !== Infinity && needed > this.remainingHeight && this.cursorY > 0) {
        this.newPage();
      }
    }

    const savedNoBreak = this._noBreak;
    this._noBreak = true;
    let used;
    try { used = drawRow(); } finally { this._noBreak = savedNoBreak; }
    return used;
  }

  /* ---------------------------------------------------------------- */
  /* Tablo                                                             */
  /* ---------------------------------------------------------------- */

  layoutTable(box, x, width) {
    const style = box.style;
    const startY = this.cursorY;

    const groups = { head: [], body: [], foot: [] };
    const collectRows = (node, bucket) => {
      for (const child of node.children) {
        if (child.kind !== 'box') continue;
        if (child.style.display === 'table-row') bucket.push(child);
        else if (child.style.display === 'table-header-group') collectRows(child, groups.head);
        else if (child.style.display === 'table-footer-group') collectRows(child, groups.foot);
        else if (child.style.display === 'table-row-group') collectRows(child, groups.body);
        else collectRows(child, bucket);
      }
    };
    collectRows(box, groups.body);

    const allRows = [...groups.head, ...groups.body, ...groups.foot];
    if (!allRows.length) return 0;

    // Sütun sayısı ve genişlikleri
    const colCount = Math.max(...allRows.map((r) => r.children.filter((c) => c.kind === 'box').length));
    const columns = this.computeColumnWidths(allRows, colCount, width);

    // thead varsa sayfa başına tekrar etsin
    if (groups.head.length) {
      this.repeatHeaders.push({ rows: groups.head, x, columns, style });
    }

    let used = 0;
    used += this.emitRows(groups.head, x, this.cursorY, columns, style);
    this.cursorY = startY + used;

    for (const row of groups.body) {
      const rowHeight = this.measureRow(row, columns, style);
      if (this.cursorY + rowHeight > this.contentHeight && this.cursorY > 0) {
        this.newPage();
      }
      const h = this.emitRows([row], x, this.cursorY, columns, style);
      this.cursorY += h;
    }

    if (groups.foot.length) {
      const h = this.emitRows(groups.foot, x, this.cursorY, columns, style);
      this.cursorY += h;
    }

    if (groups.head.length) this.repeatHeaders.pop();

    return this.cursorY - startY;
  }

  computeColumnWidths(rows, colCount, totalWidth) {
    const widths = new Array(colCount).fill(null);

    // Açıkça belirtilmiş genişlikler
    for (const row of rows) {
      const cells = row.children.filter((c) => c.kind === 'box');
      for (let i = 0; i < cells.length && i < colCount; i++) {
        if (widths[i] != null) continue;
        const w = this.engine.resolveSize(cells[i].style, 'width', totalWidth);
        if (w != null) widths[i] = w;
      }
    }

    const fixed = widths.reduce((s, w) => s + (w || 0), 0);
    const autoCount = widths.filter((w) => w == null).length;
    const each = autoCount ? Math.max(20, (totalWidth - fixed) / autoCount) : 0;
    return widths.map((w) => (w == null ? each : w));
  }

  /** Bir satırın yüksekliğini çizmeden ölçer. */
  measureRow(row, columns, tableStyle) {
    const cells = row.children.filter((c) => c.kind === 'box');
    let maxH = 0;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const colWidth = columns[i] || columns[columns.length - 1] || 50;
      const e = this.engine.edges(cell.style, colWidth);
      const inner = colWidth - e.padding.left - e.padding.right - e.border.left - e.border.right;
      const { height } = this.engine.layoutInline(cell.children, Math.max(10, inner), cell.style);
      maxH = Math.max(maxH, height + e.padding.top + e.padding.bottom + e.border.top + e.border.bottom);
    }
    return maxH || tableStyle.lineHeight;
  }

  /** Satırları çizim listesine yazar; kullanılan yüksekliği döndürür. */
  emitRows(rows, x, startY, columns, tableStyle, repeated = false) {
    let y = startY;
    for (const row of rows) {
      const cells = row.children.filter((c) => c.kind === 'box');
      const rowHeight = this.measureRow(row, columns, tableStyle);

      // Satır ve hücreler yapı ağacında TR / TH / TD olarak açılır.
      // Sayfa başına TEKRARLANAN başlık satırları görsel yinelemedir; ekran
      // okuyucu onları ikinci kez okumasın diye yapay sayılırlar.
      const tagged = !repeated;
      if (tagged) this.struct.push('TR', attrsFor(row));

      let cellX = x;
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const cellAttrs = attrsFor(cell);
        const isHeader = cell.tag === 'th';
        if (isHeader && !cellAttrs.scope) cellAttrs.scope = 'Column';
        if (tagged) this.struct.push(isHeader ? 'TH' : 'TD', cellAttrs);
        const colWidth = columns[i] || columns[columns.length - 1] || 50;
        const e = this.engine.edges(cell.style, colWidth);

        // Hücre arka planı ve kenarlığı
        const bg = toColor(cell.style.raw['background-color']) ||
                   toColor(row.style.raw['background-color']);
        if (bg && bg[3] > 0) {
          this.emitArtifact({ type: 'rect', x: cellX, y, width: colWidth, height: rowHeight,
                              fill: bg, page: this.current.index });
        }
        for (const side of ['top', 'right', 'bottom', 'left']) {
          const bw = e.border[side];
          if (!bw) continue;
          const color = toColor(cell.style.raw[`border-${side}-color`]) || [0, 0, 0, 1];
          const geom = {
            top:    [cellX, y, colWidth, bw],
            bottom: [cellX, y + rowHeight - bw, colWidth, bw],
            left:   [cellX, y, bw, rowHeight],
            right:  [cellX + colWidth - bw, y, bw, rowHeight]
          }[side];
          this.emitArtifact({ type: 'rect', x: geom[0], y: geom[1], width: geom[2], height: geom[3],
                              fill: color, page: this.current.index });
        }

        // Hücre içeriği
        const inner = colWidth - e.padding.left - e.padding.right - e.border.left - e.border.right;
        const savedCursor = this.cursorY;
        this.cursorY = y + e.padding.top + e.border.top;
        const { lines } = this.engine.layoutInline(cell.children, Math.max(10, inner), cell.style);
        this.emitLinesNoBreak(lines, cellX + e.padding.left + e.border.left, inner, cell.style);
        this.cursorY = savedCursor;

        if (tagged) this.struct.pop();      // TH / TD
        cellX += colWidth;
      }
      if (tagged) this.struct.pop();        // TR
      y += rowHeight;
    }
    return y - startY;
  }

  /** Satır kutularını sayfa kırmadan yazar (tablo hücreleri için). */
  emitLinesNoBreak(lines, x, width, style) {
    for (const line of lines) {
      const lineHeight = line.height || style.lineHeight;
      const align = style.textAlign;
      let offset = 0;
      if (align === 'center') offset = (width - line.width) / 2;
      else if (align === 'right') offset = width - line.width;

      let penX = x + Math.max(0, offset);
      for (const item of line.items) {
        if (item.type === 'image') {
          this.inFigure(item, () => this.emit({
            type: 'image', image: item.image, src: item.src,
            x: penX, y: this.cursorY + lineHeight - item.height,
            width: item.width, height: item.height, page: this.current.index }));
          penX += item.width;
          continue;
        }
        if (!item.isSpace) {
          const baseline = this.cursorY + lineHeight - (lineHeight - item.style.fontSize * 0.8) / 2;
          this.emit({ type: 'text', text: item.text, face: item.face, style: item.style,
                      x: penX, y: baseline, fontSize: item.style.fontSize,
                      color: item.style.color, letterSpacing: item.style.letterSpacing,
                      page: this.current.index });
        }
        penX += item.width;
      }
      this.cursorY += lineHeight;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Mutlak konumlandırma                                              */
  /* ---------------------------------------------------------------- */

  layoutAbsolute(box, containerX, containerWidth) {
    const style = box.style;
    const ctx = { fontSize: style.fontSize, percentBase: containerWidth };
    const e = this.engine.edges(style, containerWidth);

    const left = toPt(style.raw.left, ctx);
    const right = toPt(style.raw.right, ctx);
    const top = toPt(style.raw.top, { ...ctx, percentBase: this.contentHeight });
    const bottom = toPt(style.raw.bottom, { ...ctx, percentBase: this.contentHeight });

    let width = this.engine.resolveSize(style, 'width', containerWidth);
    if (width == null) {
      if (left != null && right != null) width = containerWidth - left - right;
      else width = containerWidth / 2;
    }

    let x = containerX;
    if (left != null) x = containerX + left;
    else if (right != null) x = containerX + containerWidth - right - width;

    const savedCursor = this.cursorY;
    let y;
    if (top != null) y = top;
    else if (bottom != null) y = this.contentHeight - bottom;
    else y = this.cursorY;

    this.cursorY = y;
    const markPage = this.current.index;
    const markIndex = this.current.items.length;
    const innerWidth = width - e.padding.left - e.padding.right - e.border.left - e.border.right;
    const contentStart = this.cursorY + e.border.top + e.padding.top;
    this.cursorY = contentStart;

    const height = this.layoutBlockChildren(box, x + e.border.left + e.padding.left, innerWidth, style);
    const boxHeight = height + e.padding.top + e.padding.bottom + e.border.top + e.border.bottom;

    // bottom verildiyse kutuyu yukarı kaydır
    let finalY = y;
    if (bottom != null && top == null) {
      finalY = this.contentHeight - bottom - boxHeight;
      const dy = finalY - y;
      if (dy !== 0) {
        // Bu kutunun ürettiği öğeleri kaydır
        const produced = this.current.items.slice(markIndex);
        for (const it of produced) if (it.y != null) it.y += dy;
      }
    }

    this.emitBoxDecoration(box, x, finalY, width, boxHeight, e, { markPage, markIndex });
    this.captureSlot(box, x, finalY, width, boxHeight);

    this.cursorY = savedCursor;
  }

  /* ---------------------------------------------------------------- */
  /* Manifest yakalama                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * İmza yuvalarını layout manifest'e yazar.
   * `data-signer` özniteliği taşıyan her eleman bir yuvadır.
   *
   * BU, PROJEDEKİ SİHİRLİ KOORDİNAT SAYILARINI ORTADAN KALDIRAN NOKTADIR.
   */
  captureSlot(box, x, y, width, height) {
    const signer = box.attrs['data-signer'];
    if (!signer) return;

    this.engine.slots.push({
      id: signer,
      role: box.attrs['data-role'] || null,
      page: this.current.index,
      // PDF kullanıcı uzayına çevrim son adımda yapılır; burada içerik alanı
      // koordinatlarını saklıyoruz.
      _contentRect: { x, y, width, height },
      origin: 'bottom-left'
    });
  }

  captureOutline(box, y) {
    const m = /^h([1-6])$/.exec(box.tag || '');
    if (!m) return;
    const title = collectText(box).trim();
    if (!title) return;
    this.engine.outline.push({
      level: parseInt(m[1], 10),
      title,
      page: this.current.index,
      _contentY: y
    });
  }
}

function collectText(box) {
  if (box.kind === 'text') return box.text;
  return box.children.map(collectText).join('');
}

function formatListNumber(n, type) {
  switch (type) {
    case 'decimal': return String(n);
    case 'lower-alpha': case 'lower-latin': return numberToAlpha(n).toLowerCase();
    case 'upper-alpha': case 'upper-latin': return numberToAlpha(n);
    case 'lower-roman': return numberToRoman(n).toLowerCase();
    case 'upper-roman': return numberToRoman(n);
    default: return String(n);
  }
}

function numberToAlpha(n) {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

function numberToRoman(n) {
  const table = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
                 [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, sym] of table) while (n >= v) { out += sym; n -= v; }
  return out;
}

module.exports = { FlowLayout, formatListNumber };
