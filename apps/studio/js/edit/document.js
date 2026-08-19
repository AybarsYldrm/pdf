/**
 * "Düzenle" sekmesi — mevcut bir PDF'i açar, sayfa işlemleri uygular,
 * görsel/metin yerleştirir, form doldurur.
 *
 * Koordinat dönüşümü burada tek yerde yapılır: tarayıcı sol-ÜST orijin
 * kullanır, PDF ise sol-ALT. `toPdfRect` bu farkı kapatır ve sayfa dönmesini
 * (`/Rotate`) hesaba katar.
 */

import { el, clear, $, kv } from '../lib/dom.js';
import { api, toBase64, fromBase64 } from '../lib/api.js';

export class DocumentEditor {
  /**
   * @param {{ onChange: (pdf: Uint8Array, summary: Object) => void,
   *           onStatus: (text: string) => void,
   *           onToast: (msg: string, kind?: string, title?: string) => void,
   *           onError: (err: Error, context: string) => void }} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.pdf = null;
    this.summary = null;
    this.pageIndex = 0;
    this.selection = null;      // { x, y, width, height } — PDF birimleri
    this.imageBytes = null;
    this.password = '';
  }

  /* ---------------------------------------------------------------- */
  /* Açma                                                              */
  /* ---------------------------------------------------------------- */

  async open(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    this.pdf = bytes;
    await this.refresh({ announce: `${file.name} açıldı` });
  }

  /** Sunucudan belge özetini tazeler ve arayüzü kurar. */
  async refresh({ announce = null } = {}) {
    if (!this.pdf) return;

    try {
      this.summary = await api.pdfOpen(this.pdf, this.password);
    } catch (err) {
      if (err.code === 'ERR_CRYPT_BAD_PASSWORD') {
        $('#editPassField').classList.remove('is-hidden');
        this.hooks.onToast('Belge parolalı: parolayı girip yeniden deneyin.', 'warn', 'Şifreli PDF');
        return;
      }
      this.hooks.onError(err, 'PDF açılamadı');
      return;
    }

    if (this.pageIndex >= this.summary.pageCount) this.pageIndex = 0;

    this.renderSummary();
    this.renderPageSelect();
    this.renderFormFields();
    this.renderPlacer();
    this.setEnabled(true);

    $('#editMetaTitle').value = this.summary.info.Title || '';
    $('#editMetaAuthor').value = this.summary.info.Author || '';

    this.hooks.onChange(this.pdf, this.summary);
    if (announce) this.hooks.onToast(announce, 'ok');
    this.hooks.onStatus(
      `${this.summary.pageCount} sayfa · ${(this.pdf.length / 1024).toFixed(0)} KB` +
      (this.summary.hasSignatures ? ' · imzalı' : '') +
      (this.summary.hasForm ? ' · form' : ''));
  }

  renderSummary() {
    const s = this.summary;
    const box = clear($('#editSummary'));
    box.classList.remove('is-hidden');

    const flags = [];
    if (s.hasSignatures) flags.push('imzalı');
    if (s.hasForm) flags.push('form içeriyor');
    if (s.encrypted) flags.push('şifreli');
    if (s.recovered) flags.push('xref onarıldı');

    box.appendChild(kv([
      ['Sayfa', s.pageCount],
      ['Boyut', `${(s.byteLength / 1024).toFixed(0)} KB`],
      ['Başlık', s.info.Title || '—'],
      ['Üretici', s.info.Producer || s.info.Creator || '—'],
      ['Durum', flags.length ? flags.join(', ') : 'düz belge']
    ], 'kv kv--compact'));

    if (s.hasSignatures) {
      box.appendChild(el('p', {
        class: 'notice notice--info',
        text: 'Bu belge imzalı. Düzenlemeler artımlı revizyon olarak eklenir; ' +
              'imza kriptografik olarak geçerli kalır ama belge "imzadan sonra değiştirildi" görünür.'
      }));
    }
  }

  renderPageSelect() {
    const select = clear($('#editPage'));
    for (const page of this.summary.pages) {
      select.appendChild(el('option', {
        value: String(page.index),
        text: `${page.index + 1}. sayfa · ${Math.round(page.width)}×${Math.round(page.height)} pt` +
              (page.rotate ? ` · ${page.rotate}°` : '')
      }));
    }
    select.value = String(this.pageIndex);
    select.disabled = false;
  }

  renderFormFields() {
    const wrap = $('#editFormFields');
    const list = clear($('#formFieldList'));
    const fields = (this.summary.fields || []).filter((f) => f.type !== 'Sig');

    if (!fields.length) {
      wrap.classList.add('is-hidden');
      return;
    }
    wrap.classList.remove('is-hidden');

    for (const field of fields) {
      const id = `ff_${field.name.replace(/[^\w]/g, '_')}`;
      let control;

      if (field.type === 'Btn') {
        control = el('input', { type: 'checkbox', id, class: 'check__box' });
        control.checked = !!field.value && field.value !== 'Off';
      } else if (field.options && field.options.length) {
        control = el('select', { id, class: 'input' },
          field.options.map((o) => el('option', { value: o, text: o })));
        if (field.value) control.value = field.value;
      } else if (field.multiline) {
        control = el('textarea', { id, class: 'input input--code', rows: '3' });
        control.value = field.value || '';
      } else {
        control = el('input', { type: 'text', id, class: 'input' });
        control.value = field.value || '';
      }

      control.dataset.fieldName = field.name;
      control.dataset.fieldType = field.type;
      if (field.readOnly) control.disabled = true;

      list.appendChild(el('label', { class: 'field' }, [
        el('span', {
          class: 'field__label',
          text: field.name + (field.required ? ' *' : '') + (field.readOnly ? ' (salt okunur)' : '')
        }),
        control
      ]));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Konum seçici                                                      */
  /* ---------------------------------------------------------------- */

  /** Sayfa şemasını gerçek en/boy oranıyla çizer. */
  renderPlacer() {
    const page = this.summary.pages[this.pageIndex];
    if (!page) return;

    const sheet = $('#placerSheet');
    const maxW = 240;
    const maxH = 320;
    const scale = Math.min(maxW / page.width, maxH / page.height);

    sheet.style.width = `${Math.round(page.width * scale)}px`;
    sheet.style.height = `${Math.round(page.height * scale)}px`;
    sheet.dataset.scale = String(scale);

    this.selection = null;
    $('#placerRect').classList.add('is-hidden');
    $('#placerReadout').textContent = 'seçim yok';
  }

  /** Şema üzerindeki sürüklemeyi PDF koordinatlarına çevirir. */
  attachPlacer() {
    const sheet = $('#placerSheet');
    const rect = $('#placerRect');
    let start = null;

    const local = (event) => {
      const box = sheet.getBoundingClientRect();
      return {
        x: Math.min(Math.max(event.clientX - box.left, 0), box.width),
        y: Math.min(Math.max(event.clientY - box.top, 0), box.height)
      };
    };

    const draw = (a, b) => {
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      rect.style.left = `${x}px`;
      rect.style.top = `${y}px`;
      rect.style.width = `${Math.abs(b.x - a.x)}px`;
      rect.style.height = `${Math.abs(b.y - a.y)}px`;
      rect.classList.remove('is-hidden');
    };

    sheet.addEventListener('pointerdown', (event) => {
      if (!this.summary) return;
      sheet.setPointerCapture(event.pointerId);
      start = local(event);
      draw(start, start);
    });

    sheet.addEventListener('pointermove', (event) => {
      if (!start) return;
      draw(start, local(event));
    });

    const finish = (event) => {
      if (!start) return;
      const end = local(event);
      const scale = Number(sheet.dataset.scale) || 1;
      const page = this.summary.pages[this.pageIndex];

      const left = Math.min(start.x, end.x) / scale;
      const top = Math.min(start.y, end.y) / scale;
      const width = Math.abs(end.x - start.x) / scale;
      const height = Math.abs(end.y - start.y) / scale;
      start = null;

      if (width < 4 || height < 4) {
        this.selection = null;
        rect.classList.add('is-hidden');
        $('#placerReadout').textContent = 'seçim yok';
        return;
      }

      // Tarayıcı sol-ÜST, PDF sol-ALT orijin kullanır
      this.selection = {
        x: round(left),
        y: round(page.height - top - height),
        width: round(width),
        height: round(height)
      };
      $('#placerReadout').textContent =
        `x ${this.selection.x} · y ${this.selection.y} · ` +
        `${this.selection.width}×${this.selection.height} pt`;
    };

    sheet.addEventListener('pointerup', finish);
    sheet.addEventListener('pointercancel', () => { start = null; });
  }

  /* ---------------------------------------------------------------- */
  /* İşlemler                                                          */
  /* ---------------------------------------------------------------- */

  /** İşlem listesini sunucuya gönderir ve belgeyi tazeler. */
  async apply(ops, label) {
    if (!this.pdf || !ops.length) return null;
    this.hooks.onStatus(`${label}…`);

    try {
      const res = await api.pdfEdit({
        pdf: toBase64(this.pdf),
        password: this.password || undefined,
        ops
      });
      this.pdf = fromBase64(res.pdf);
      await this.refresh();
      this.hooks.onToast(`${label} tamam.`, 'ok');
      return res;
    } catch (err) {
      this.hooks.onError(err, label + ' başarısız');
      return null;
    }
  }

  rotate(degrees) {
    return this.apply([{ op: 'rotate', page: this.pageIndex, degrees }], 'Sayfa döndürüldü');
  }

  movePage(delta) {
    const to = this.pageIndex + delta;
    if (to < 0 || to >= this.summary.pageCount) return null;
    const promise = this.apply(
      [{ op: 'movePage', from: this.pageIndex, to }], 'Sayfa taşındı');
    this.pageIndex = to;
    return promise;
  }

  insertPage() {
    const page = this.summary.pages[this.pageIndex];
    return this.apply([{
      op: 'insertPage',
      index: this.pageIndex + 1,
      size: [0, 0, page.width, page.height]
    }], 'Boş sayfa eklendi');
  }

  deletePage() {
    if (this.summary.pageCount <= 1) {
      this.hooks.onToast('Tek sayfalı belgede sayfa silinemez.', 'warn');
      return null;
    }
    const promise = this.apply(
      [{ op: 'removePage', page: this.pageIndex }], 'Sayfa silindi');
    if (this.pageIndex >= this.summary.pageCount - 1) this.pageIndex = Math.max(0, this.pageIndex - 1);
    return promise;
  }

  async placeImage() {
    if (!this.imageBytes) {
      this.hooks.onToast('Önce bir görsel seçin.', 'warn');
      return;
    }
    if (!this.selection) {
      this.hooks.onToast('Sayfa şemasında bir alan seçin.', 'warn');
      return;
    }
    const opacity = Number($('#editOpacity').value);
    await this.apply([{
      op: 'image',
      page: this.pageIndex,
      image: toBase64(this.imageBytes),
      x: this.selection.x,
      y: this.selection.y,
      width: this.selection.width,
      height: this.selection.height,
      opacity: Number.isFinite(opacity) && opacity < 1 ? opacity : undefined
    }], 'Görsel yerleştirildi');
  }

  async placeText() {
    const text = $('#editText').value.trim();
    if (!text) {
      this.hooks.onToast('Önce metni yazın.', 'warn');
      return;
    }
    if (!this.selection) {
      this.hooks.onToast('Sayfa şemasında bir alan seçin.', 'warn');
      return;
    }
    const size = Number($('#editTextSize').value) || 11;
    await this.apply([{
      op: 'text',
      page: this.pageIndex,
      text,
      x: this.selection.x,
      // Metin taban çizgisi seçimin ALT kenarına oturur
      y: this.selection.y + Math.max(0, (this.selection.height - size) / 2),
      size
    }], 'Metin eklendi');
  }

  async fillForm() {
    const values = {};
    for (const control of document.querySelectorAll('#formFieldList [data-field-name]')) {
      if (control.disabled) continue;
      values[control.dataset.fieldName] =
        control.type === 'checkbox' ? control.checked : control.value;
    }
    if (!Object.keys(values).length) return;

    const res = await this.apply([{
      op: 'fillForm',
      values,
      flatten: $('#flattenForm').checked
    }], 'Form dolduruldu');

    const report = res && res.applied && res.applied[0];
    for (const item of (report && report.skipped) || []) {
      this.hooks.onToast(`${item.name}: ${item.reason}`, 'warn', 'Atlanan alan');
    }
  }

  saveMetadata() {
    return this.apply([{
      op: 'metadata',
      values: { title: $('#editMetaTitle').value, author: $('#editMetaAuthor').value }
    }], 'Üst veri yazıldı');
  }

  download() {
    if (!this.pdf) return;
    const blob = new Blob([this.pdf], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const name = (this.summary && this.summary.info.Title) || 'duzenlenmis-belge';
    const a = el('a', { href: url, download: `${name}.pdf` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  setEnabled(on) {
    const ids = [
      '#btnRotateLeft', '#btnRotateRight', '#btnPageUp', '#btnPageDown',
      '#btnPageInsert', '#btnPageDelete', '#btnPlaceImage', '#btnPlaceText',
      '#btnSaveMeta', '#btnEditDownload', '#btnEditToSign'
    ];
    for (const id of ids) $(id).disabled = !on;
  }

  /** Olay bağlantılarını kurar (bir kez çağrılır). */
  attach() {
    this.attachPlacer();

    $('#editFile').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) this.open(file);
    });

    $('#editPass').addEventListener('change', (e) => {
      this.password = e.target.value;
      this.refresh({ announce: 'Belge parolayla açıldı' });
    });

    $('#editPage').addEventListener('change', (e) => {
      this.pageIndex = Number(e.target.value) || 0;
      this.renderPlacer();
    });

    $('#editImage').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      this.imageBytes = file ? new Uint8Array(await file.arrayBuffer()) : null;
    });

    $('#btnRotateLeft').addEventListener('click', () => this.rotate(-90));
    $('#btnRotateRight').addEventListener('click', () => this.rotate(90));
    $('#btnPageUp').addEventListener('click', () => this.movePage(-1));
    $('#btnPageDown').addEventListener('click', () => this.movePage(1));
    $('#btnPageInsert').addEventListener('click', () => this.insertPage());
    $('#btnPageDelete').addEventListener('click', () => this.deletePage());
    $('#btnPlaceImage').addEventListener('click', () => this.placeImage());
    $('#btnPlaceText').addEventListener('click', () => this.placeText());
    $('#btnFillForm').addEventListener('click', () => this.fillForm());
    $('#btnSaveMeta').addEventListener('click', () => this.saveMetadata());
    $('#btnEditDownload').addEventListener('click', () => this.download());
  }
}

function round(n) {
  return Math.round(n * 10) / 10;
}
