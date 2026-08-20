/**
 * Özellik ve katman paneli.
 *
 * Panel MODELİ okur ve modele YAZAR; kendi kopyasını tutmaz. İki kopya
 * tutmak, "panelde 12pt yazıyor ama belge 11pt" sınıfından hataların tek
 * sebebidir.
 *
 * Her yazma bir işlem (transaction) açar ve `mergeKey` taşır: bir sayı
 * kutusunda oka basılı tutmak tek geri alma adımı olur.
 */

import { el, clear } from '../lib/dom.js';

/** Tip başına düzenlenebilir alanlar — şemadaki adlarla birebir. */
const FIELDS = {
  text: [
    { key: 'text', label: 'Metin', kind: 'textarea' },
    // Seçenekler sunucudan gelir (`/api/health`): kullanıcı olmayan bir
    // aileyi yazıp belgeyi sessizce başka fontla üretmesin.
    { key: 'fontFamily', label: 'Font', kind: 'families' },
    { key: 'fontSize', label: 'Punto', kind: 'number', min: 1, max: 400, step: 0.5 },
    { key: 'lineHeight', label: 'Satır aralığı', kind: 'number', min: 0.5, max: 4, step: 0.05 },
    { key: 'color', label: 'Renk', kind: 'color' },
    { key: 'align', label: 'Yatay', kind: 'enum', values: ['left', 'center', 'right', 'justify'] },
    { key: 'valign', label: 'Dikey', kind: 'enum', values: ['top', 'middle', 'bottom'] },
    { key: 'bold', label: 'Kalın', kind: 'bool' },
    { key: 'italic', label: 'Eğik', kind: 'bool' },
    { key: 'letterSpacing', label: 'Harf aralığı', kind: 'number', min: -20, max: 100, step: 0.1 },
    { key: 'padding', label: 'İç boşluk', kind: 'number', min: 0, max: 200, step: 1 }
  ],
  rect: [
    { key: 'fill', label: 'Dolgu', kind: 'color' },
    { key: 'stroke', label: 'Çizgi', kind: 'color' },
    { key: 'strokeWidth', label: 'Çizgi kalınlığı', kind: 'number', min: 0, max: 40, step: 0.5 },
    { key: 'radius', label: 'Köşe yarıçapı', kind: 'number', min: 0, max: 200, step: 1 }
  ],
  ellipse: [
    { key: 'fill', label: 'Dolgu', kind: 'color' },
    { key: 'stroke', label: 'Çizgi', kind: 'color' },
    { key: 'strokeWidth', label: 'Çizgi kalınlığı', kind: 'number', min: 0, max: 40, step: 0.5 }
  ],
  line: [
    { key: 'stroke', label: 'Renk', kind: 'color' },
    { key: 'strokeWidth', label: 'Kalınlık', kind: 'number', min: 0.1, max: 40, step: 0.5 },
    { key: 'dash', label: 'Biçim', kind: 'enum', values: ['solid', 'dashed', 'dotted'] }
  ],
  image: [
    { key: 'fit', label: 'Oturtma', kind: 'enum', values: ['contain', 'cover', 'fill'] }
    // `alt` her düğümde ortaktır; erişilebilirlik bölümünde düzenlenir.
  ],
  path: [
    { key: 'fill', label: 'Dolgu', kind: 'color' },
    { key: 'stroke', label: 'Çizgi', kind: 'color' },
    { key: 'strokeWidth', label: 'Çizgi kalınlığı', kind: 'number', min: 0, max: 40, step: 0.5 },
    { key: 'fillRule', label: 'Dolgu kuralı', kind: 'enum', values: ['nonzero', 'evenodd'] },
    { key: 'dash', label: 'Biçim', kind: 'enum', values: ['solid', 'dashed', 'dotted'] }
  ],
  qr: [
    { key: 'payload', label: 'İçerik', kind: 'textarea' },
    { key: 'ecc', label: 'Hata düzeltme', kind: 'enum', values: ['L', 'M', 'Q', 'H'] },
    { key: 'quiet', label: 'Sessiz bölge', kind: 'number', min: 0, max: 16, step: 1 }
  ],
  signature: [
    { key: 'fieldName', label: 'Alan adı', kind: 'text' },
    { key: 'signer', label: 'İmzalayan', kind: 'text' },
    { key: 'signerTitle', label: 'Unvan', kind: 'text' },
    { key: 'label', label: 'Etiket', kind: 'text' },
    { key: 'showFrame', label: 'Çerçeve göster', kind: 'bool' }
  ],
  group: []
};

const TYPE_LABELS = {
  text: 'Metin', rect: 'Dikdörtgen', ellipse: 'Elips', line: 'Çizgi',
  image: 'Görsel', qr: 'Karekod', signature: 'İmza yuvası', group: 'Grup',
  path: 'Vektör çizim'
};


export class Inspector {
  /**
   * @param {HTMLElement} root
   * @param {Object} canvas SceneCanvas
   * @param {{ structRoles?: string[], roleDefaults?: Object }} [schema]
   *        sahne paketinden gelen rol tabloları
   */
  constructor(root, canvas, schema = {}) {
    this.root = root;
    this.canvas = canvas;
    this.onChange = () => {};
    /** Sunucunun sunduğu font aileleri (`/api/health` → `fonts`). */
    this.fontFamilies = [];
    this.structRoles = schema.structRoles || ['auto', 'artifact'];
    this.roleDefaults = schema.roleDefaults || {};
  }

  /**
   * Seçilebilir font ailelerini bildirir.
   *
   * Sunucudan gelenlere, sahnenin varlık havuzuna YÜKLENMİŞ fontlar da
   * eklenir: kullanıcı kendi fontunu yüklediyse listede görmelidir.
   */
  setFontFamilies(serverFamilies) {
    this.fontFamilies = Array.isArray(serverFamilies) ? serverFamilies.slice() : [];
  }

  _allFamilies() {
    const names = new Set(this.fontFamilies);
    const current = this.scene && [...this.scene.selection]
      .map((id) => this.scene.node(id))
      .filter((n) => n && n.fontFamily)
      .map((n) => n.fontFamily);
    for (const n of current || []) names.add(n);
    for (const name of this.canvas.embeddedFontFamilies || []) names.add(name);
    return [...names].sort((a, b) => a.localeCompare(b, 'tr'));
  }

  get scene() { return this.canvas.scene; }

  render() {
    clear(this.root);
    if (!this.scene) return;

    const ids = [...this.scene.selection];
    this.root.appendChild(this._pageSection());
    this.root.appendChild(this._layerSection());

    if (!ids.length) {
      this.root.appendChild(el('p', { class: 'empty', text: 'Bir nesne seçin.' }));
      return;
    }
    if (ids.length > 1) {
      this.root.appendChild(this._multiSection(ids));
      return;
    }
    this.root.appendChild(this._nodeSection(this.scene.node(ids[0])));
  }

  /* ---------------------------------------------------------------- */
  /* Bölümler                                                          */
  /* ---------------------------------------------------------------- */

  _pageSection() {
    const page = this.scene.page;
    return el('section', { class: 'insp' }, [
      el('h3', { class: 'insp__title', text: 'Sayfa' }),
      el('dl', { class: 'kv' }, [
        el('dt', { text: 'Ölçü' }),
        el('dd', { text: `${round(page.width)} × ${round(page.height)} pt` }),
        el('dt', { text: 'Sayfa sayısı' }),
        el('dd', { text: String(this.scene.pages.length) })
      ])
    ]);
  }

  _layerSection() {
    const page = this.canvas.page;
    const list = el('ul', { class: 'layers' });

    // En üstteki katman listede de en üstte olsun: çizim sırası TERSTİR
    for (const node of [...(page ? page.nodes : [])].reverse()) {
      const selected = this.scene.selection.has(node.id);
      list.appendChild(el('li', {
        class: 'layers__item' + (selected ? ' is-selected' : ''),
        onclick: (e) => {
          if (!e.shiftKey) this.scene.selection.clear();
          this.scene.selection.add(node.id);
          this.canvas.render();
          this.render();
        }
      }, [
        el('span', { class: 'layers__type', text: TYPE_LABELS[node.type] || node.type }),
        el('span', { class: 'layers__name', text: labelOf(node) }),
        el('button', {
          class: 'layers__btn', type: 'button',
          title: node.hidden ? 'Göster' : 'Gizle',
          text: node.hidden ? '◌' : '●',
          onclick: (e) => {
            e.stopPropagation();
            this._patch(node.id, { hidden: !node.hidden }, 'Görünürlük');
          }
        }),
        el('button', {
          class: 'layers__btn', type: 'button',
          title: node.locked ? 'Kilidi aç' : 'Kilitle',
          text: node.locked ? 'K' : '·',
          onclick: (e) => {
            e.stopPropagation();
            this._patch(node.id, { locked: !node.locked }, 'Kilit');
          }
        })
      ]));
    }

    return el('section', { class: 'insp' }, [
      el('h3', { class: 'insp__title', text: 'Katmanlar' }),
      list.childNodes.length ? list : el('p', { class: 'empty', text: 'Sayfa boş.' })
    ]);
  }

  _multiSection(ids) {
    return el('section', { class: 'insp' }, [
      el('h3', { class: 'insp__title', text: `${ids.length} nesne seçili` }),
      el('div', { class: 'insp__row' }, [
        this._btn('←', () => this._align(ids, 'left')),
        this._btn('↔', () => this._align(ids, 'hcenter')),
        this._btn('→', () => this._align(ids, 'right')),
        this._btn('↑', () => this._align(ids, 'top')),
        this._btn('↕', () => this._align(ids, 'vcenter')),
        this._btn('↓', () => this._align(ids, 'bottom'))
      ]),
      el('div', { class: 'insp__row' }, [
        this._btn('Yatay dağıt', () => this._distribute(ids, 'horizontal')),
        this._btn('Dikey dağıt', () => this._distribute(ids, 'vertical'))
      ]),
      el('div', { class: 'insp__row' }, [
        this._btn('Gruplandır', () => {
          this.scene.transaction('Gruplandır', () => this.scene.group(ids));
          this._refresh();
        })
      ])
    ]);
  }

  _nodeSection(node) {
    if (!node) return el('div');

    const rows = [
      el('h3', { class: 'insp__title', text: TYPE_LABELS[node.type] || node.type }),
      this._geometryRow(node)
    ];

    for (const field of FIELDS[node.type] || []) {
      rows.push(this._field(node, field));
    }

    rows.push(el('div', { class: 'insp__row' }, [
      this._number('Döndür', node.rotation, (v) => this._patch(node.id, { rotation: v }, 'Döndür'),
        { min: -360, max: 360, step: 1 }),
      this._number('Saydamlık', node.opacity, (v) => this._patch(node.id, { opacity: v }, 'Saydamlık'),
        { min: 0, max: 1, step: 0.05 })
    ]));

    rows.push(el('div', { class: 'insp__row' }, [
      this._btn('En öne', () => this._reorder(node.id, 'front')),
      this._btn('Öne', () => this._reorder(node.id, 'forward')),
      this._btn('Arkaya', () => this._reorder(node.id, 'backward')),
      this._btn('En arkaya', () => this._reorder(node.id, 'back'))
    ]));

    for (const row of this._accessibilityRows(node)) rows.push(row);

    if (node.type === 'group') {
      rows.push(this._btn('Grubu çöz', () => {
        this.scene.transaction('Grubu çöz', () => this.scene.ungroup(node.id));
        this._refresh();
      }));
    }

    return el('section', { class: 'insp' }, rows);
  }

  /**
   * Erişilebilirlik alanları.
   *
   * Ekran okuyucu punto göremez: 22 punto bir metnin BAŞLIK olduğunu ancak
   * kullanıcı söyleyebilir. Bu yüzden rol modelde taşınır ve burada
   * düzenlenir. `Figure` seçili ve alternatif metin boşsa PDF/UA çıktısı
   * geçersizdir — panel bunu sessizce geçmez, uyarır.
   */
  _accessibilityRows(node) {
    const rows = [el('h4', { class: 'insp__sub', text: 'Erişilebilirlik' })];
    const effective = this.roleDefaults[node.type] || 'artifact';

    rows.push(this._field(node, {
      key: 'role', label: `Yapı rolü (kendiliğinden: ${effective})`,
      kind: 'enum', values: this.structRoles
    }));

    const role = node.role && node.role !== 'auto' ? node.role : effective;
    if (role !== 'artifact') {
      rows.push(this._field(node, { key: 'alt', label: 'Alternatif metin', kind: 'text' }));
      rows.push(this._field(node, { key: 'lang', label: 'Dil (farklıysa)', kind: 'text' }));
      if (role === 'Figure' && !node.alt && node.type !== 'qr') {
        rows.push(el('p', {
          class: 'insp__warn',
          text: 'PDF/UA: görsel için alternatif metin zorunludur.'
        }));
      }
    }
    return rows;
  }

  _geometryRow(node) {
    const mk = (key, label) => this._number(label, node.frame[key], (v) => {
      this._patch(node.id, { frame: { [key]: v } }, 'Konum', `frame:${node.id}:${key}`);
    }, { step: 1 });

    return el('div', { class: 'insp__grid' }, [
      mk('x', 'X'), mk('y', 'Y'), mk('width', 'Genişlik'), mk('height', 'Yükseklik')
    ]);
  }

  /* ---------------------------------------------------------------- */
  /* Alan kurucuları                                                   */
  /* ---------------------------------------------------------------- */

  _field(node, spec) {
    const value = node[spec.key];
    const write = (v) => this._patch(node.id, { [spec.key]: v }, spec.label, `${spec.key}:${node.id}`);

    switch (spec.kind) {
      case 'number':
        return this._number(spec.label, value, write, spec);

      case 'bool':
        return el('label', { class: 'check' }, [
          el('input', {
            type: 'checkbox', checked: !!value,
            onchange: (e) => write(e.target.checked)
          }),
          el('span', { text: spec.label })
        ]);

      case 'color':
        return el('label', { class: 'field field--inline' }, [
          el('span', { class: 'field__label', text: spec.label }),
          el('input', {
            class: 'input input--color', type: 'color',
            value: value || '#000000',
            oninput: (e) => write(e.target.value)
          }),
          el('button', {
            class: 'btn btn--sm', type: 'button', text: 'Yok',
            title: 'Bu rengi kaldır',
            onclick: () => write(undefined)
          })
        ]);

      case 'enum':
      case 'families': {
        const values = spec.kind === 'families' ? this._allFamilies() : spec.values;
        const select = el('select', {
          class: 'input',
          onchange: (e) => write(e.target.value)
        });
        if (spec.kind === 'families' && !values.length) {
          select.appendChild(el('option', { value: '' }, '(font listesi alınamadı)'));
        }
        for (const v of values) {
          select.appendChild(el('option', { value: v, selected: v === value }, v));
        }
        return el('label', { class: 'field' }, [
          el('span', { class: 'field__label', text: spec.label }), select
        ]);
      }

      case 'textarea':
        return el('label', { class: 'field' }, [
          el('span', { class: 'field__label', text: spec.label }),
          el('textarea', {
            class: 'input input--area', spellcheck: 'false',
            oninput: (e) => write(e.target.value),
            text: String(value == null ? '' : value)
          })
        ]);

      default:
        return el('label', { class: 'field' }, [
          el('span', { class: 'field__label', text: spec.label }),
          el('input', {
            class: 'input', type: 'text', value: value == null ? '' : String(value),
            oninput: (e) => write(e.target.value)
          })
        ]);
    }
  }

  _number(label, value, write, spec = {}) {
    return el('label', { class: 'field field--inline' }, [
      el('span', { class: 'field__label', text: label }),
      el('input', {
        class: 'input input--num', type: 'number',
        value: value == null ? '' : String(round(value)),
        min: spec.min, max: spec.max, step: spec.step || 1,
        oninput: (e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) write(n);
        }
      })
    ]);
  }

  _btn(label, onclick) {
    return el('button', { class: 'btn btn--sm', type: 'button', text: label, onclick });
  }

  /* ---------------------------------------------------------------- */
  /* Yazma                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Modele yazar.
   *
   * `mergeKey`, aynı alana ardışık yazmaları TEK geri alma adımında
   * toplar: bir sayı kutusunda oka basılı tutmak otuz adım üretmez.
   */
  _patch(nodeId, patch, label, mergeKey) {
    this.scene.transaction(label || 'Değiştir',
      () => this.scene.updateNode(nodeId, patch),
      { mergeKey: mergeKey || `${label}:${nodeId}` });
    this.canvas.render();
    this.onChange();
  }

  _align(ids, how) {
    this.scene.transaction('Hizala', () => {
      if (ids.length === 1) this.scene.alignToPage(ids, how);
      else this.scene.align(ids, how);
    });
    this._refresh();
  }

  _distribute(ids, axis) {
    this.scene.transaction('Dağıt', () => this.scene.distribute(ids, axis));
    this._refresh();
  }

  _reorder(id, to) {
    this.scene.transaction('Sırala', () => this.scene.reorder(id, to));
    this._refresh();
  }

  _refresh() {
    this.canvas.render();
    this.render();
    this.onChange();
  }
}

const round = (n) => Math.round(n * 100) / 100;

function labelOf(node) {
  if (node.name) return node.name;
  if (node.type === 'text') {
    const t = (node.text || '').trim();
    return t ? t.slice(0, 28) : 'boş metin';
  }
  if (node.type === 'signature') return node.fieldName || node.label || 'imza';
  if (node.type === 'group') return `${(node.children || []).length} nesne`;
  return node.id.slice(0, 10);
}
