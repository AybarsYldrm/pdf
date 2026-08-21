/**
 * FITFAK Belge Studio — uygulama girişi.
 *
 * Vanilla JS + ESM. Framework, bundler, derleme adımı yok.
 */

import { el, clear, $, $$, kv, setOptions } from './lib/dom.js';
import { api, toBase64, fromBase64, ApiError } from './lib/api.js';
import { parsePfx, importSigningKey, signData, derToPem, BrowserPkcs12Error } from './signing/pkcs12.js';
import { renderPanel } from './verify/panel.js';
import { DocumentEditor } from './edit/document.js';
import { SceneEditor } from './scene/editor.js';

/* ------------------------------------------------------------------ */
/* Durum                                                                */
/* ------------------------------------------------------------------ */

const state = {
  capabilities: null,
  pdf: null,           // Uint8Array — üzerinde çalışılan belge
  manifest: null,      // layout manifest (imza yuvaları burada)
  pfxBytes: null,
  identities: [],
  identityIndex: 0,
  browserKey: null,    // CryptoKey (extractable: false)
  keyType: 'rsa',
  certPem: null,
  chainPems: [],
  zoom: 1,
  verifyReport: null,
  editor: null,
  sceneEditor: null,
  activeTab: 'scene'
};

const DEFAULT_HTML = `<article class="paper paper--kurumsal">

  <header class="paper-letterhead">
    <div class="paper-letterhead__org">
      <span class="paper-letterhead__name">FITFAK</span>
      <span class="paper-letterhead__unit">Cumhuriyet Üniversitesi · Tıp Fakültesi</span>
    </div>
    <div class="paper-letterhead__contact">Sivas / Türkiye<br>trust.fitfak.net</div>
  </header>

  <div class="paper-titleblock">
    <h1 data-title>Resmî Bilgilendirme Belgesi</h1>
    <table class="paper-metatable">
      <tr><th>Belge No</th><td data-doc-no>—</td></tr>
      <tr><th>Tarih</th><td>18.08.2026</td></tr>
    </table>
  </div>

  <section class="paper-body">
    <p class="paper-lead">
      Bu belge, PAdES altyapısıyla dijital olarak imzalanmıştır.
    </p>
    <p>
      Metni buradan düzenleyebilirsiniz. Önizleme, PDF motorunun kullandığı
      CSS'in aynısıyla çizilir.
    </p>
  </section>

  <div class="paper-signature-row">
    <div class="paper-sig-slot" data-signer="imzaci1" data-role="Düzenleyen">
      <span class="paper-sig-slot__role">Düzenleyen</span>
    </div>
    <div class="paper-sig-slot" data-signer="imzaci2" data-role="Onaylayan">
      <span class="paper-sig-slot__role">Onaylayan</span>
    </div>
  </div>

  <footer class="paper-footer">
    <span class="paper-footer__doc">Belge No: <span data-doc-no>—</span></span>
    <span class="paper-footer__page">Sayfa 1</span>
  </footer>
</article>`;

/* ------------------------------------------------------------------ */
/* Bildirimler                                                          */
/* ------------------------------------------------------------------ */

/**
 * TEK bildirim sistemi.
 *
 * `key` verilirse aynı anahtarlı bildirim YENİLENİR, ikincisi eklenmez —
 * "içe aktarılıyor → 4 sayfa çözümlendi" gibi ilerleyen işler ekranı
 * doldurmasın. `kind: 'loading'` kendiliğinden kapanmaz; işi bitiren
 * çağıran onu yeni bir durumla değiştirir ya da `dismissToast` ile kapatır.
 *
 * @param {string} message
 * @param {'ok'|'info'|'warn'|'error'|'loading'} [kind]
 * @param {string} [title]
 * @param {{ key?: string, progress?: number }} [opts]
 */
const liveToasts = new Map();

function toast(message, kind = 'ok', title = null, opts = {}) {
  const body = [
    title ? el('div', { class: 'toast__title' }, title) : null,
    el('div', { class: 'toast__body' }, message)
  ];
  if (typeof opts.progress === 'number') {
    body.push(el('div', { class: 'toast__bar' }, [
      el('i', { style: `width:${Math.max(0, Math.min(100, opts.progress))}%` })
    ]));
  }

  const node = el('div', { class: `toast toast--${kind}`, role: 'status' }, body);

  const key = opts.key || null;
  if (key && liveToasts.has(key)) {
    const prev = liveToasts.get(key);
    clearTimeout(prev.timer);
    prev.node.replaceWith(node);
  } else {
    $('#toasts').appendChild(node);
  }

  const ttl = kind === 'loading' ? 0 : (kind === 'error' ? 8000 : 4500);
  const timer = ttl ? setTimeout(() => {
    node.remove();
    if (key) liveToasts.delete(key);
  }, ttl) : null;

  if (key) liveToasts.set(key, { node, timer });
  return node;
}

/** Anahtarlı bir bildirimi kapatır (iş bitti ama söylenecek bir şey yok). */
function dismissToast(key) {
  const entry = liveToasts.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.node.remove();
  liveToasts.delete(key);
}

function status(text) { $('#canvasStatus').textContent = text; }

/**
 * Kullanıcıya ANLAŞILIR, geliştiriciye TAM hata.
 *
 * Ham `TypeError` ya da `ERR_ASSET_MISSING` gibi kodlar kullanıcıya bir şey
 * anlatmaz. Arayüzde ne olduğu insan diliyle, tanı bilgisi (kod, yığın,
 * bağlam) konsolda durur.
 */
const ERROR_MESSAGES = {
  ERR_ASSET_MISSING: 'Belgedeki bir görselin verisi bulunamadı. Görseli yeniden ekleyin.',
  ERR_ASSET_TOO_LARGE: 'Görsel dosyası çok büyük.',
  ERR_ASSET_TYPE: 'Bu dosya türü desteklenmiyor (PNG, JPEG, TTF ya da OTF bekleniyordu).',
  ERR_PDF_OPEN: 'PDF açılamadı. Dosya bozuk ya da parola korumalı olabilir.',
  ERR_PDF_PASSWORD: 'Belge parolayla korunmuş; doğru parolayı girin.',
  ERR_IMPORT: 'Belge içe aktarılamadı.',
  ERR_SCENE_INVALID: 'Sahne dosyası geçersiz.',
  ERR_TOO_LARGE: 'Dosya sunucunun kabul ettiği boyutu aşıyor.'
};

function handleError(err, context) {
  const code = err && err.code;
  const known = code && ERROR_MESSAGES[code];
  const raw = err instanceof ApiError || err instanceof BrowserPkcs12Error
    ? err.message : (err && err.message) || String(err);

  toast(known || raw, 'error', context);
  status('Hata');
  // Tanı konsolda KALIR: kod, bağlam ve yığın olmadan hata ayıklanamaz.
  console.error(`[${context}]`, code || '(kodsuz)', err);
}

/* ------------------------------------------------------------------ */
/* Önizleme                                                             */
/* ------------------------------------------------------------------ */

/**
 * HTML'i sandbox'lı iframe içinde, PDF motoruyla AYNI CSS ile gösterir.
 * Script çalıştırılmaz (sandbox="allow-same-origin", allow-scripts YOK).
 */
function updatePreview(html) {
  const frame = $('#preview');
  const doc = frame.contentDocument;
  if (!doc) return;
  showHtmlPreview();

  doc.open();
  doc.write(
    '<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8">' +
    '<link rel="stylesheet" href="/vendor/paper.css">' +
    // paper.css'in @media screen bloğu kâğıdı gri bir zemine oturtur; burada
    // zeminin kendisi zaten iframe olduğu için o süslemeyi nötrleyip sayfayı
    // tam genişlikte gösteriyoruz.
    '<style>html,body{background:#fff;margin:0;padding:0}' +
    '.paper{width:auto;min-height:0;margin:0;box-shadow:none;' +
    'padding:var(--paper-margin-y) var(--paper-margin-x)}</style>' +
    '</head><body></body></html>');
  doc.close();

  // Kullanıcı HTML'i doc.body'ye yazılır. Script çalışmaz çünkü iframe
  // sandbox'ında allow-scripts verilmemiştir.
  doc.body.innerHTML = html;
  applySubstitutions(doc);
  highlightSlots(doc);
}

function applySubstitutions(doc) {
  const title = $('#docTitle').value;
  const docNo = $('#docNo').value;
  for (const node of doc.querySelectorAll('[data-title]')) node.textContent = title;
  for (const node of doc.querySelectorAll('[data-doc-no]')) node.textContent = docNo;
}

/** İmza yuvalarını görsel olarak işaretler (yalnız önizlemede). */
function highlightSlots(doc) {
  const style = doc.createElement('style');
  style.textContent = `
    [data-signer] { position: relative; outline: 1.5px dashed rgba(20,45,95,.45); outline-offset: 2px; }
    [data-signer]::after {
      content: "imza: " attr(data-signer);
      position: absolute; top: -14px; left: 0;
      font: 8pt system-ui, sans-serif; color: #142d5f; opacity: .8;
    }
    [data-signer].is-selected { outline-color: #c9302c; outline-width: 2.5px; }
  `;
  doc.head.appendChild(style);
}

function markSelectedSlot(id) {
  const doc = $('#preview').contentDocument;
  if (!doc) return;
  for (const node of doc.querySelectorAll('[data-signer]')) {
    node.classList.toggle('is-selected', node.getAttribute('data-signer') === id);
  }
}

/**
 * Yüklenmiş/üretilmiş bir PDF'i gösterir — tarayıcının yerleşik görüntüleyicisi.
 *
 * HTML önizlemesi AYRI bir çerçevede yaşar ve orada `sandbox` hiç kaldırılmaz:
 * kullanıcı HTML'inin script çalıştırma ihtimali böylece yapısal olarak yok.
 */
function showPdfPreview(bytes) {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));

  $('#preview').classList.add('is-hidden');
  const frame = $('#pdfPreview');
  frame.classList.remove('is-hidden');
  frame.src = state.previewUrl;
}

/** HTML önizlemesine geri döner. */
function showHtmlPreview() {
  $('#pdfPreview').classList.add('is-hidden');
  $('#preview').classList.remove('is-hidden');
}

function setZoom(z) {
  state.zoom = Math.min(2, Math.max(0.4, z));
  $('#preview').style.transform = `scale(${state.zoom})`;
  $('#zoomLabel').textContent = `%${Math.round(state.zoom * 100)}`;
}

/* ------------------------------------------------------------------ */
/* Tasarla                                                              */
/* ------------------------------------------------------------------ */

async function doRender() {
  const btn = $('#btnRender');
  btn.disabled = true;
  status('PDF üretiliyor…');

  try {
    const res = await api.render({
      html: withSubstitutions($('#htmlSource').value),
      theme: $('#themeSelect').value,
      page: { size: $('#pageSize').value, margin: '20mm 18mm' },
      metadata: { title: $('#docTitle').value, lang: 'tr-TR' },
      conformance: $('#conformance').value || null
    });

    state.pdf = fromBase64(res.pdf);
    state.manifest = res.manifest;
    state.verifyReport = null;

    refreshSlotSelect();
    $('#btnDownload').disabled = false;
    $('#btnConformance').disabled = false;
    $('#btnSign').disabled = !state.browserKey && !$('#serverSide').checked;

    for (const w of res.warnings || []) toast(w.message, 'warn', 'Render uyarısı');
    if (res.conformance) await checkConformance({ quiet: true });

    status(`Hazır · ${res.manifest.pageCount} sayfa · ${res.manifest.signatureSlots.length} imza yuvası`);
    toast(`PDF üretildi (${res.manifest.pageCount} sayfa).`, 'ok');
    await refreshVerifyPanel();
  } catch (err) {
    handleError(err, 'PDF üretilemedi');
  } finally {
    btn.disabled = false;
  }
}

function withSubstitutions(html) {
  return html
    .replace(/(<[^>]*data-title[^>]*>)[^<]*/g, `$1${escapeText($('#docTitle').value)}`)
    .replace(/(<[^>]*data-doc-no[^>]*>)[^<]*/g, `$1${escapeText($('#docNo').value)}`);
}

function escapeText(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

function downloadPdf() {
  if (!state.pdf) return;
  const blob = new Blob([state.pdf], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: (($('#docNo').value || 'belge') + '.pdf') });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ */
/* İmzala                                                               */
/* ------------------------------------------------------------------ */

function refreshSlotSelect() {
  const select = $('#slotSelect');
  const slots = (state.manifest && state.manifest.signatureSlots) || [];
  if (!slots.length) {
    setOptions(select, [{ value: '', label: 'Yuva yok — HTML\'e data-signer ekleyin' }]);
    return;
  }
  setOptions(select, slots.map((s) => ({
    value: s.id,
    label: `${s.id}${s.role ? ' · ' + s.role : ''} (sayfa ${s.page + 1})`
  })));
  markSelectedSlot(select.value);
}

async function openPfx() {
  const file = $('#pfxFile').files[0];
  if (!file) return toast('Önce bir .pfx dosyası seçin.', 'warn');

  const password = $('#pfxPass').value;
  state.pfxBytes = new Uint8Array(await file.arrayBuffer());

  try {
    // Kimlik listesi için sunucuya sorulur (yalnız üst veri döner, imza atılmaz).
    const res = await api.pfxIdentities(state.pfxBytes, password);
    state.identities = res.identities;

    setOptions($('#identitySelect'), res.identities.map((id, i) => ({
      value: String(i),
      label: id.friendlyName || id.subject || `Kimlik ${i + 1}`
    })));
    $('#identityBox').classList.remove('is-hidden');
    showIdentityMeta(0);

    // Tarayıcı içi anahtar: varsayılan ve tercih edilen yol
    if (!$('#serverSide').checked) {
      await prepareBrowserKey(password);
    } else {
      $('#btnSign').disabled = !state.pdf;
    }

    toast(`${res.identities.length} kimlik okundu.`, 'ok');
  } catch (err) {
    handleError(err, 'PFX açılamadı');
  } finally {
    $('#pfxPass').value = '';       // parolayı formda bırakma
  }
}

async function prepareBrowserKey(password) {
  try {
    const { keyDer, certDers } = await parsePfx(state.pfxBytes, password);
    const identity = state.identities[state.identityIndex] || {};
    state.keyType = (identity.keyInfo && identity.keyInfo.type) || 'rsa';

    // extractable: false → anahtar bir daha okunamaz
    state.browserKey = await importSigningKey(keyDer, state.keyType);
    keyDer.fill(0);

    state.certPem = derToPem(certDers[0]);
    state.chainPems = certDers.slice(1).map((d) => derToPem(d));

    setKeyBadge(true);
    $('#btnSign').disabled = !state.pdf;
    $('#signHint').textContent = 'Anahtar tarayıcıda açıldı; sunucuya gitmeyecek.';
  } catch (err) {
    state.browserKey = null;
    setKeyBadge(false);
    if (err instanceof BrowserPkcs12Error && err.code === 'ERR_BROWSER_PKCS12_LEGACY') {
      $('#serverSide').checked = true;
      $('#signHint').textContent = err.message;
      $('#btnSign').disabled = !state.pdf;
      toast(err.message, 'warn', 'Tarayıcıda açılamadı');
    } else {
      throw err;
    }
  }
}

function setKeyBadge(inBrowser) {
  const badge = $('#keyBadge');
  badge.className = 'badge ' + (inBrowser ? 'badge--lock' : 'badge--warn');
  badge.textContent = inBrowser ? 'Anahtar tarayıcıda' : 'Anahtar sunucuya gidecek';
}

function showIdentityMeta(index) {
  state.identityIndex = index;
  const id = state.identities[index];
  const box = clear($('#identityMeta'));
  if (!id) return;
  box.appendChild(kv([
    ['Konu', id.subject],
    ['Veren', id.issuer],
    ['Geçerlilik', `${fmtDate(id.notBefore)} → ${fmtDate(id.notAfter)}`],
    ['Anahtar', id.keyInfo ? `${id.keyInfo.type} ${id.keyInfo.curve || id.keyInfo.bits || ''}` : '—'],
    ['Zincir', `${id.chainLength} ara sertifika`]
  ], 'identity__meta'));
}

async function doSign() {
  if (!state.pdf) return toast('Önce bir PDF üretin veya yükleyin.', 'warn');

  const slotId = $('#slotSelect').value;
  const slot = (state.manifest && state.manifest.signatureSlots || [])
    .find((s) => s.id === slotId) || null;
  const level = ($$('input[name="level"]').find((r) => r.checked) || {}).value || 'LT';
  const identity = state.identities[state.identityIndex] || {};

  const visible = {
    template: $('#stampTemplate').value,
    signerName: extractCn(identity.subject) || identity.friendlyName || '',
    role: slot ? slot.role : '',
    docNo: $('#docNo').value,
    verifyUrl: location.origin + '/v/' + encodeURIComponent($('#docNo').value || '')
  };

  $('#btnSign').disabled = true;
  status('İmzalanıyor…');

  try {
    let result;

    if ($('#serverSide').checked) {
      // Opt-in: PFX sunucuya gider
      const password = prompt('PFX parolası (sunucuya gönderilecek):') || '';
      result = await api.signPfx({
        pdf: toBase64(state.pdf),
        pfx: toBase64(state.pfxBytes),
        password,
        identityIndex: state.identityIndex,
        level, slot, visible
      });
    } else {
      // Varsayılan: iki fazlı — anahtar tarayıcıdan çıkmaz
      if (!state.browserKey) throw new Error('Önce PFX açın.');

      const prep = await api.signPrepare({
        pdf: toBase64(state.pdf),
        certPem: state.certPem,
        chainPems: state.chainPems,
        level, slot, visible
      });

      const dataToSign = fromBase64(prep.dataToSign);
      const hash = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' }[prep.hashAlgorithm] || 'SHA-256';
      const signature = await signData(state.browserKey, dataToSign, prep.keyType, hash);

      result = await api.signFinalize({
        sessionId: prep.sessionId,
        signature: toBase64(signature)
      });
    }

    // Mevcut state atamanız
    state.pdf = fromBase64(result.pdf);
    $('#btnDownload').disabled = false;

    // =========================================================
    // YENİ EKLENEN KISIM: OTOMATİK PDF İNDİRME İŞLEMİ
    // =========================================================
    // state.pdf (Uint8Array/Buffer) verisini doğrudan Blob'a sarıyoruz
    const pdfBlob = new Blob([state.pdf], { type: 'application/pdf' });
    const blobUrl = URL.createObjectURL(pdfBlob);

    const downloadLink = document.createElement('a');
    downloadLink.href = blobUrl;

    // İndirilecek dosyanın adını Belge No alanına göre ayarlıyoruz
    const docName = $('#docNo').value ? `${$('#docNo').value}_imzali.pdf` : 'imzali_belge.pdf';
    downloadLink.download = docName;

    document.body.appendChild(downloadLink);
    downloadLink.click();

    // DOM ve bellek temizliği
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(blobUrl);
    // =========================================================

    const achieved = result.achievedLevel;
    const requested = result.requestedLevel;
    if (achieved && requested && !achieved.toUpperCase().includes(requested)) {
      toast(`${requested} istendi, ${achieved} elde edildi. ${(result.reasons || []).join(' ')}`,
        'warn', 'Seviye düşüşü');
    } else {
      toast(`İmza tamamlandı: ${achieved}`, 'ok');
    }
    for (const r of result.reasons || []) toast(r, 'warn');

    status(`İmzalandı · ${achieved}`);
    await refreshVerifyPanel();
  } catch (err) {
    handleError(err, 'İmzalama başarısız');
  } finally {
    $('#btnSign').disabled = false;
  }
}

async function refreshStampPreview() {
  const box = clear($('#stampPreview'));
  const identity = state.identities[state.identityIndex] || {};
  try {
    const res = await api.stampPreview({
      template: $('#stampTemplate').value,
      seed: 12345,
      vars: {
        signerName: extractCn(identity.subject) || 'AD SOYAD',
        role: 'Düzenleyen',
        docNo: $('#docNo').value || 'DOC-XXXX',
        verifyUrl: location.origin + '/v/ornek',
        org: 'FITFAK'
      }
    });
    box.appendChild(el('img', {
      src: `data:image/png;base64,${res.png}`,
      alt: 'Damga önizlemesi'
    }));
  } catch {
    box.appendChild(el('span', { class: 'empty' }, 'Önizleme üretilemedi'));
  }
}

/* ------------------------------------------------------------------ */
/* Doğrula                                                              */
/* ------------------------------------------------------------------ */

async function refreshVerifyPanel() {
  if (!state.pdf) return;
  try {
    const report = await api.verify({
      pdf: toBase64(state.pdf),
      allowNetwork: $('#allowNetwork').checked
    });
    state.verifyReport = report;
    renderPanel($('#signaturePanel'), report, { onExtend: extendLtv });
  } catch (err) {
    handleError(err, 'Doğrulama başarısız');
  }
}

async function extendLtv(targetLevel) {
  if (!state.pdf) return;
  status('LTV ekleniyor…');
  try {
    const res = await api.ltvExtend({ pdf: toBase64(state.pdf), targetLevel });
    state.pdf = fromBase64(res.pdf);
    toast(`Belge ${res.achievedLevel} seviyesine yükseltildi.`, 'ok');
    await refreshVerifyPanel();
    status('Hazır');
  } catch (err) {
    handleError(err, 'LTV eklenemedi');
  }
}

async function loadVerifyFile() {
  const file = $('#verifyFile').files[0];
  if (!file) return toast('Önce bir PDF seçin.', 'warn');

  state.pdf = new Uint8Array(await file.arrayBuffer());
  state.manifest = null;
  refreshSlotSelect();
  $('#btnDownload').disabled = false;

  status(`Yüklendi · ${file.name}`);
  await refreshVerifyPanel();
}

/* ------------------------------------------------------------------ */
/* Uyumluluk                                                            */
/* ------------------------------------------------------------------ */

/**
 * Üzerinde çalışılan belgeyi PDF/A ve PDF/UA açısından denetler.
 *
 * Rapor, üretim tarafından BAĞIMSIZ okunur: "profili istedik" ile "profil
 * gerçekten yazılmış" ayrı şeylerdir ve kullanıcı ikincisini görmelidir.
 */
async function checkConformance({ quiet = false } = {}) {
  if (!state.pdf) return;
  const panel = $('#conformancePanel');

  try {
    const report = await api.conformance(state.pdf);
    renderConformance(panel, report);
    if (!quiet) {
      toast(report.conforms ? 'Belge denetlenen kurallara uyuyor.'
                            : `${report.summary.errors} uyumluluk hatası bulundu.`,
        report.conforms ? 'ok' : 'warn', 'Uyumluluk');
    }
  } catch (err) {
    handleError(err, 'Uyumluluk denetimi başarısız');
  }
}

function renderConformance(panel, report) {
  clear(panel);

  if (!report.profiles.length || (!report.pdfA && !report.pdfUA)) {
    panel.appendChild(el('p', { class: 'empty', text: 'Belge bir uyumluluk profili iddia etmiyor.' }));
    return;
  }

  panel.appendChild(el('div', {
    class: `conf__verdict ${report.conforms ? 'is-ok' : 'is-bad'}`
  }, [
    el('strong', { text: report.conforms ? 'UYUMLU' : 'UYUMSUZ' }),
    el('span', { text: ` · ${report.profiles.join(', ')}` })
  ]));

  const section = (title, block, keyName) => {
    if (!block) return;
    panel.appendChild(el('h3', { class: 'conf__title', text: title }));

    const list = el('ul', { class: 'conf__list' });
    for (const item of block.errors) {
      list.appendChild(el('li', { class: 'conf__item conf__item--error' },
        [el('code', { text: item[keyName] || '—' }), ' ', item.message]));
    }
    for (const item of block.warnings) {
      list.appendChild(el('li', { class: 'conf__item conf__item--warn' },
        [el('code', { text: item[keyName] || '—' }), ' ', item.message]));
    }
    if (!list.children.length) {
      list.appendChild(el('li', { class: 'conf__item conf__item--ok', text: 'İhlal bulunamadı.' }));
    }
    panel.appendChild(list);
  };

  section(report.pdfA ? report.pdfA.profile : '', report.pdfA, 'clause');
  section('PDF/UA-1', report.pdfUA, 'rule');

  if (report.pdfUA && report.pdfUA.structure.elements) {
    const s = report.pdfUA.structure;
    panel.appendChild(el('p', {
      class: 'hint',
      text: `Yapı: ${s.elements} eleman · ${s.figures} görsel · ` +
            `${s.links} bağlantı · ${s.tables} tablo`
    }));
  }
}

/* ------------------------------------------------------------------ */
/* Başlangıç                                                            */
/* ------------------------------------------------------------------ */

function switchTab(name) {
  state.activeTab = name;
  for (const tab of $$('.tab')) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  for (const pane of $$('.pane')) {
    pane.classList.toggle('is-hidden', pane.dataset.pane !== name);
  }

  // Sahne editörü kendi tuvalini kullanır; iki tuval aynı anda görünmez.
  const scene = name === 'scene';
  $('#sceneShell').classList.toggle('is-hidden', !scene);
  $('#canvasScroll').classList.toggle('is-hidden', scene);
  $('.canvas__toolbar').classList.toggle('is-hidden', scene);

  if (scene) {
    ensureSceneEditor()
      // Tuval ölçüsü ancak GÖRÜNÜR olduğunda bilinir; sekme açılışında
      // sığdırmak, kullanıcının ilk gördüğü şeyin tam sayfa olmasını sağlar.
      .then((editor) => { if (!editor.lastPdf && !editor.dirty) editor.fitPage(); })
      .catch((err) => handleError(err, 'Editör yüklenemedi'));
  }
}

/**
 * Sahne editörünü İLK kullanımda yükler.
 *
 * Model paketi 78 KB'tır; bu sekmeye hiç girmeyen kullanıcı onu indirmez.
 */
async function ensureSceneEditor() {
  if (state.sceneEditor) return state.sceneEditor;

  const editor = new SceneEditor({
    canvasRoot: $('#sceneCanvas'),
    inspectorRoot: $('#sceneInspector'),
    toolbarRoot: $('#sceneToolbar'),
    pagesRoot: $('#scenePages'),
    api,
    isActive: () => state.activeTab === 'scene',
    onStatus: (message) => status(message)
  });

  editor.onAnalysis = (analysis) => renderAnalysis(analysis);

  await editor.init();
  state.sceneEditor = editor;
  bindSceneControls(editor);
  return editor;
}

function bindSceneControls(editor) {
  $('#btnSceneNew').addEventListener('click', () => {
    editor.newDocument();
    $('#btnSceneDownload').disabled = true;
    $('#btnSceneToSign').disabled = true;
  });

  $('#btnSceneRender').addEventListener('click', async () => {
    try {
      status('Sahne derleniyor…');
      const result = await editor.renderPdf({
        conformance: $('#sceneConformance').value || null
      });

      // Üretilen belge imzalama ve doğrulama akışlarının da girdisidir
      state.pdf = editor.lastPdf;
      state.manifest = result.manifest;
      state.verifyReport = null;
      refreshSlotSelect();

      $('#btnSceneDownload').disabled = false;
      $('#btnSceneToSign').disabled = false;
      $('#btnDownload').disabled = false;
      $('#btnSign').disabled = !state.browserKey && !$('#serverSide').checked;

      for (const w of result.warnings || []) toast(w.message, 'warn', w.code);
      const slots = result.manifest.signatureSlots.length;
      toast(`PDF üretildi — ${result.manifest.pageCount} sayfa, ${slots} imza yuvası`, 'ok');

      // İddia edilen uyum GERÇEKTEN denetlenir: damgayı vurup denetlemeden
      // "uyumlu" demek, kullanıcıya olmayan bir güvence satmaktır.
      if (result.conformance) await checkConformance({ quiet: true });
      status('PDF hazır');
    } catch (err) {
      handleError(err, 'Sahne derlenemedi');
    }
  });

  $('#btnSceneDownload').addEventListener('click', () => {
    if (!editor.lastPdf) return;
    downloadBytes(editor.lastPdf, 'application/pdf',
      (editor.scene.doc.meta.title || 'belge') + '.pdf');
  });

  $('#btnSceneToSign').addEventListener('click', async () => {
    switchTab('sign');
    await refreshVerifyPanel();
    toast('Belge imzalama akışına aktarıldı.', 'ok');
  });

  $('#btnSceneExport').addEventListener('click', () => {
    // Varlık BAYTLARI da yazılır. Yalnız üst veriyi kaydetmek, dosyayı
    // yeniden açan kullanıcıya boş çerçeveler göstermek demekti: sahne
    // dosyası kendi kendine yeter olmalıdır.
    const doc = editor.scene.toJSON();
    doc.assetBytes = editor.exportAssets();
    const json = JSON.stringify(doc, null, 2);
    downloadBytes(new TextEncoder().encode(json), 'application/json',
      (editor.scene.doc.meta.title || 'sahne') + '.json');
  });

  $('#sceneImportJson').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await importIntoScene(editor, file);
  });

  $('#sceneImportPdf').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await importIntoScene(editor, file);
  });

  $('#btnSceneFromHtml').addEventListener('click', async () => {
    const key = 'import-html';
    try {
      status('HTML içe aktarılıyor…');
      toast('HTML sahneye çevriliyor…', 'loading', 'İçe aktarma', { key });
      const result = await api.sceneImportHtml({
        html: withSubstitutions($('#htmlSource').value),
        theme: $('#themeSelect').value
      });
      editor.loadScene(result.scene, result.assets || []);
      reportImport(result, key, 'HTML');
      switchTab('scene');
      status('İçe aktarıldı');
    } catch (err) {
      dismissToast(key);
      handleError(err, 'HTML içe aktarılamadı');
    }
  });

  bindSceneDropZone(editor);
  bindScenePageOps(editor);
}

/* ------------------------------------------------------------------ */
/* İçe aktarma — TEK giriş                                              */
/* ------------------------------------------------------------------ */

/**
 * Dosyayı türüne göre sahneye alır.
 *
 * Dosya seçici de sürükle-bırak da BURAYA gelir. İki ayrı yol tutmak, iki
 * ayrı davranış demekti: birinde varlıklar yükleniyor, ötekinde
 * yüklenmiyor gibi farklar tam olarak böyle doğar.
 *
 * @param {SceneEditor} editor
 * @param {File} file
 */
async function importIntoScene(editor, file) {
  const name = file.name || 'dosya';
  const lower = name.toLowerCase();
  const key = `import-${name}`;

  const isPdf = file.type === 'application/pdf' || lower.endsWith('.pdf');
  const isJson = file.type === 'application/json' || lower.endsWith('.json');
  const isImage = /^image\/(png|jpeg)$/.test(file.type) ||
                  /\.(png|jpe?g)$/.test(lower);

  try {
    if (isPdf) {
      status('PDF içe aktarılıyor…');
      toast(`${name} okunuyor…`, 'loading', 'İçe aktarma', { key });
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await api.sceneImportPdf(bytes);
      // Panel `editor.onAnalysis` üzerinden tazelenir; burada ikinci kez
      // çizmek aynı DOM'u iki kez kurmak olurdu.
      editor.loadScene(result.scene, result.assets || [], { analysis: result.analysis });
      reportImport(result, key, name);
      status('İçe aktarıldı');
      return;
    }

    if (isJson) {
      const parsed = JSON.parse(await file.text());
      // Sahne dosyası varlıkları İÇİNDE taşıyabilir (dışa aktarımda
      // gömüldüyse); taşımıyorsa yalnız üst veri gelir ve görseller
      // eksik kalır — bu sessizce geçilmez.
      editor.loadScene(parsed, parsed.assetBytes || []);
      const missing = (parsed.assets || []).length && !(parsed.assetBytes || []).length;
      toast(missing
        ? 'Sahne yüklendi; varlık baytları dosyada yok, görselleri yeniden ekleyin.'
        : 'Sahne yüklendi.', missing ? 'warn' : 'ok', null, { key });
      status('Sahne yüklendi');
      return;
    }

    if (isImage) {
      await editor.addImageFile(file);
      toast(`${name} sahneye eklendi.`, 'ok', null, { key });
      return;
    }

    toast(`${name} desteklenmiyor. PDF, PNG/JPEG ya da sahne (.json) bırakın.`,
      'warn', 'İçe aktarma', { key });
  } catch (err) {
    dismissToast(key);
    handleError(err, `${name} içe aktarılamadı`);
  }
}

/** İçe aktarma sonucunu tek bir bildirimde özetler. */
function reportImport(result, key, label) {
  const warnings = result.warnings || [];
  const pages = (result.scene && result.scene.pages ? result.scene.pages.length : 0);
  const serious = warnings.filter((w) => w.code !== 'WARN_IMPORT_FLATTENED');

  toast(
    `${label}: ${pages} sayfa aktarıldı` +
    (serious.length ? ` · ${serious.length} not` : ''),
    serious.length ? 'warn' : 'ok', 'İçe aktarma', { key });

  // Uyarı yağmuru YOK: ayrıntı çözümleme panelinde ve konsolda durur.
  if (warnings.length) console.info('[içe aktarma uyarıları]', warnings);
}

/* ------------------------------------------------------------------ */
/* Sürükle-bırak                                                        */
/* ------------------------------------------------------------------ */

function bindSceneDropZone(editor) {
  const shell = $('#sceneShell');
  const overlay = $('#sceneDrop');
  let depth = 0;

  const show = (on) => overlay.classList.toggle('is-hidden', !on);

  // `dragenter`/`dragleave` iç içe elemanlarda defalarca tetiklenir; sayaç
  // tutmadan örtü sürükleme ortasında kaybolur.
  shell.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    show(true);
  });
  shell.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  shell.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) show(false);
  });
  shell.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    show(false);
    for (const file of [...e.dataTransfer.files].slice(0, 8)) {
      await importIntoScene(editor, file);
    }
  });
}

const hasFiles = (e) =>
  !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');

/* ------------------------------------------------------------------ */
/* Sayfa işlemleri                                                      */
/* ------------------------------------------------------------------ */

const PAGE_PRESETS = {
  A4: [595.28, 841.89], A3: [841.89, 1190.55], A5: [419.53, 595.28],
  LETTER: [612, 792]
};

function bindScenePageOps(editor) {
  const act = (label, fn) => () => {
    if (!editor.scene) return;
    try {
      editor.scene.transaction(label, () => fn(editor.scene, editor.currentPage));
      editor.refresh();
    } catch (err) {
      handleError(err, label);
    }
  };

  $('#btnScenePageRotL').addEventListener('click',
    act('Sayfayı çevir', (sc, page) => sc.rotatePage(page.id, -90)));
  $('#btnScenePageRotR').addEventListener('click',
    act('Sayfayı çevir', (sc, page) => sc.rotatePage(page.id, 90)));
  $('#btnScenePageDup').addEventListener('click',
    act('Sayfayı çoğalt', (sc, page) => sc.duplicatePage(page.id)));
  $('#btnScenePageUp').addEventListener('click',
    act('Sayfayı taşı', (sc, page) => sc.movePage(page.id, editor.canvas.pageIndex - 1)));
  $('#btnScenePageDown').addEventListener('click',
    act('Sayfayı taşı', (sc, page) => sc.movePage(page.id, editor.canvas.pageIndex + 1)));
  $('#btnScenePageDel').addEventListener('click',
    act('Sayfayı sil', (sc, page) => sc.removePage(page.id)));

  $('#scenePageSize').addEventListener('change', (e) => {
    const value = e.target.value;
    act('Sayfa ölçüsü', (sc, page) => sc.setPageSize(page.id, parsePageSize(value)))();
  });

  // Seçili sayfa değişince ölçü kutusu onu göstermeli.
  editor.onPageChange = (page) => {
    const box = editor.canvas.pageBox;
    $('#scenePageSize').value = page && page.width > 0
      ? (matchPreset(box.width, box.height) || '') : '';
  };
}

function parsePageSize(value) {
  if (!value) return null;
  const [name, orientation] = value.split(' ');
  const size = PAGE_PRESETS[name.toUpperCase()];
  if (!size) return null;
  const [w, h] = orientation === 'landscape' ? [size[1], size[0]] : size;
  return { width: w, height: h };
}

function matchPreset(width, height) {
  for (const [name, [w, h]] of Object.entries(PAGE_PRESETS)) {
    if (Math.abs(width - w) < 2 && Math.abs(height - h) < 2) return name;
    if (Math.abs(width - h) < 2 && Math.abs(height - w) < 2) return `${name} landscape`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Belge çözümlemesi paneli                                             */
/* ------------------------------------------------------------------ */

/**
 * İçe aktarılan belgenin envanterini gösterir.
 *
 * Amaç modal bombardımanı DEĞİL: kullanıcı ne kaybettiğini merak ettiğinde
 * bakacağı tek yer. Düzenlenebilirlik durumu açıkça yazılır — form alanları
 * ve açıklamalar sahneye çevrilmez, bunu saklamak yanıltıcı olurdu.
 */
function renderAnalysis(analysis) {
  const root = clear($('#sceneAnalysis'));
  if (!analysis) {
    root.appendChild(el('p', { class: 'empty' },
      'Bir PDF açtığınızda belgenin envanteri burada çıkar.'));
    return;
  }

  const row = (label, value, cls) => el('div', { class: `docscan__row ${cls || ''}` }, [
    el('span', { class: 'docscan__k', text: label }),
    el('span', { class: 'docscan__v', text: String(value) })
  ]);

  root.appendChild(row('Sayfa',
    analysis.truncated
      ? `${analysis.importedPages} / ${analysis.pageCount} (kırpıldı)`
      : analysis.pageCount));
  root.appendChild(row('Ölçü', analysis.sizes.join(' · ')));
  if (analysis.rotated) root.appendChild(row('Dönme', 'var (uygulandı)'));

  const o = analysis.objects || {};
  root.appendChild(row('Metin', `${o.text || 0} nesne`));
  root.appendChild(row('Görsel', `${o.image || 0} nesne`));
  root.appendChild(row('Vektör', `${o.path || 0} nesne`));

  if (analysis.form && analysis.form.fieldCount) {
    root.appendChild(row('Form alanı',
      `${analysis.form.fieldCount} · sahneye aktarılmadı`, 'is-warn'));
  }
  if (analysis.signatures && analysis.signatures.fieldCount) {
    root.appendChild(row('İmza alanı',
      `${analysis.signatures.fieldCount}` +
      (analysis.signatures.signed ? ' · belge imzalı' : ''), 'is-warn'));
  }
  if (analysis.annotations && analysis.annotations.total) {
    root.appendChild(row('Açıklama',
      `${analysis.annotations.total} · sahneye aktarılmadı`, 'is-warn'));
  }
  if (analysis.encrypted) root.appendChild(row('Şifreleme', 'var', 'is-warn'));
  if (analysis.claimedProfile) {
    root.appendChild(row('Profil (iddia)', analysis.claimedProfile.label));
  }

  const notes = (analysis.warnings || []).filter((w) => w.code !== 'WARN_IMPORT_FLATTENED');
  if (notes.length) {
    root.appendChild(el('details', { class: 'docscan__notes' }, [
      el('summary', { text: `${notes.length} not` }),
      el('ul', {}, notes.map((w) => el('li', {}, [
        el('code', { text: w.code }), ' ', w.message
      ])))
    ]));
  }

  if (analysis.signatures && analysis.signatures.signed) {
    root.appendChild(el('p', { class: 'hint' },
      'Bu belge imzalı. Sahne YENİ bir belge üretir ve eski imzaları taşımaz; ' +
      'imzayı korumak için "Artımlı düzenle" sekmesini kullanın.'));
  }
}

/** Baytları dosya olarak indirir. *//** Baytları dosya olarak indirir. */
function downloadBytes(bytes, mime, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('tr-TR'); } catch { return iso; }
}

function extractCn(dn) {
  if (!dn) return null;
  const m = /CN=([^,\n]+)/.exec(dn);
  return m ? m[1].trim() : null;
}

function generateDocNo() {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `DOC-${t}-${r}`;
}

async function init() {
  // Tema
  const saved = localStorage.getItem('studio-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('studio-theme', next);
  });

  // Sekmeler
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) switchTab(tab.dataset.tab);
  });

  // Yetenekler
  try {
    state.capabilities = await api.health();
    setOptions($('#themeSelect'), state.capabilities.themes, 'kurumsal');
    setOptions($('#stampTemplate'), state.capabilities.stampTemplates, 'dual');
    for (const profile of state.capabilities.conformanceProfiles || []) {
      // Aynı liste iki yerde: HTML yolu ve sahne yolu. Profiller SUNUCUDAN
      // gelir; istemci desteklenmeyen bir profil uyduramaz.
      for (const id of ['#conformance', '#sceneConformance']) {
        $(id).appendChild(el('option', { value: profile, text: profile.toUpperCase() }));
      }
    }
    if (!state.capabilities.serverSidePfx) {
      $('#serverSide').disabled = true;
      $('#serverSide').closest('.check').classList.add('is-hidden');
    }
  } catch (err) {
    handleError(err, 'Sunucuya bağlanılamadı');
  }

  // Başlangıç içeriği
  $('#htmlSource').value = DEFAULT_HTML;
  $('#docNo').value = generateDocNo();
  updatePreview(DEFAULT_HTML);
  setZoom(0.85);

  // Olaylar
  let previewTimer = null;
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => updatePreview($('#htmlSource').value), 250);
  };
  $('#htmlSource').addEventListener('input', schedulePreview);
  $('#docTitle').addEventListener('input', schedulePreview);
  $('#docNo').addEventListener('input', schedulePreview);
  $('#themeSelect').addEventListener('change', () => {
    const html = $('#htmlSource').value.replace(/paper--\w+/g, `paper--${$('#themeSelect').value}`);
    $('#htmlSource').value = html;
    updatePreview(html);
  });

  $('#btnRender').addEventListener('click', doRender);
  $('#btnDownload').addEventListener('click', downloadPdf);
  $('#btnPfxOpen').addEventListener('click', openPfx);
  $('#btnSign').addEventListener('click', doSign);
  $('#btnVerify').addEventListener('click', loadVerifyFile);
  $('#btnConformance').addEventListener('click', () => checkConformance());
  $('#btnVerifyConformance').addEventListener('click', () => checkConformance());
  $('#identitySelect').addEventListener('change', (e) => {
    showIdentityMeta(Number(e.target.value));
    refreshStampPreview();
  });
  $('#slotSelect').addEventListener('change', (e) => markSelectedSlot(e.target.value));
  $('#stampTemplate').addEventListener('change', refreshStampPreview);
  $('#serverSide').addEventListener('change', (e) => {
    setKeyBadge(!e.target.checked && !!state.browserKey);
    $('#signHint').textContent = e.target.checked
      ? 'Dikkat: PFX dosyanız sunucuya gönderilecek. Sunucu onu yalnız bellekte tutar.'
      : 'Anahtarınız tarayıcınızdan çıkmaz.';
  });

  $('#zoomIn').addEventListener('click', () => setZoom(state.zoom + 0.1));
  $('#zoomOut').addEventListener('click', () => setZoom(state.zoom - 0.1));

  // Düzenle sekmesi: yüklenen PDF üzerinde artımlı düzenleme
  state.editor = new DocumentEditor({
    onStatus: status,
    onToast: toast,
    onError: handleError,
    onChange: (pdf) => {
      // Düzenlenen belge, imzalama ve doğrulama akışlarının da girdisi olur
      state.pdf = pdf;
      state.manifest = null;
      state.verifyReport = null;
      refreshSlotSelect();
      $('#btnDownload').disabled = false;
      $('#btnSign').disabled = !state.browserKey && !$('#serverSide').checked;
      showPdfPreview(pdf);
    }
  });
  state.editor.attach();

  $('#btnEditToSign').addEventListener('click', async () => {
    switchTab('sign');
    await refreshVerifyPanel();
    toast('Belge imzalama akışına aktarıldı.', 'ok');
  });

  refreshStampPreview();

  /**
   * TANI YÜZEYİ.
   *
   * Hata ayıklama ve uçtan uca otomasyon için uygulama durumuna tek bir
   * tutamak. Konsolda `fitfakStudio.sceneEditor.scene` demek, DOM'u kazımaya
   * çalışmaktan hem kolay hem de doğrudur. Sayfada üçüncü taraf betik
   * çalışmaz (önizleme iframe'i `allow-scripts` almaz), bu yüzden bu tutamak
   * yeni bir saldırı yüzeyi açmaz.
   */
  window.fitfakStudio = state;

  // BAŞLANGIÇTAKİ çalışma alanını gerçekten aç.
  // HTML'de "Studio" sekmesi etkin görünüyor ama editör yalnız `switchTab`
  // içinde kuruluyordu; açılışta çağırmadan tuval boş kalırdı.
  switchTab(state.activeTab);
  status('Hazır');
}

init().catch((err) => handleError(err, 'Başlatma hatası'));
