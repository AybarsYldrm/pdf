/**
 * İmza paneli — @fitfak/verify raporunu render eder.
 *
 * Burada HİÇ doğrulama mantığı yoktur; panel yalnız raporu gösterir.
 */

import { el, clear, kv } from '../lib/dom.js';

const LEVEL_LABEL = {
  'B-B': 'B-B', 'B-T': 'B-T', 'B-LT': 'B-LT', 'B-LTA': 'B-LTA',
  'doc-timestamp': 'DAMGA'
};

const SUB_INDICATION_TR = {
  HASH_FAILURE: 'Belge imzadan sonra değiştirilmiş',
  SIG_CRYPTO_FAILURE: 'İmza kriptografik olarak geçersiz',
  NO_CERTIFICATE_CHAIN_FOUND: 'Sertifika zinciri güvenilen bir köke ulaşmadı',
  NO_SIGNING_CERTIFICATE_FOUND: 'İmzalayan sertifika bulunamadı',
  REVOKED_NO_POE: 'Sertifika iptal edilmiş',
  REVOKED_CA_NO_POE: 'Ara CA sertifikası iptal edilmiş',
  OUT_OF_BOUNDS_NO_POE: 'Doğrulama zamanı sertifika geçerlilik aralığı dışında',
  CHAIN_CONSTRAINTS_FAILURE: 'Sertifika zinciri kısıtları sağlanmıyor',
  SIG_CONSTRAINTS_FAILURE: 'İmza zorunlu kısıtları sağlamıyor',
  CRYPTO_CONSTRAINTS_FAILURE_NO_POE:
    'Kullanılan algoritma ya da anahtar uzunluğu artık güvenli sayılmıyor',
  DOC_MODIFIED_AFTER_SIGNING:
    'İmza geçerli ama belge imzalandıktan sonra değiştirilmiş — ' +
    'imza yalnız kapsadığı ilk bölümü doğrular',
  FORMAT_FAILURE: 'İmza yapısı okunamadı'
};

const fmtDate = (iso) => {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString('tr-TR', { hour12: false });
  } catch { return iso; }
};

/**
 * Raporu panele çizer.
 * @param {HTMLElement} container
 * @param {Object} report @fitfak/verify çıktısı
 * @param {{ onExtend?: (level:string)=>void }} [handlers]
 */
export function renderPanel(container, report, handlers = {}) {
  clear(container);

  if (!report || !report.signatures || !report.signatures.length) {
    container.appendChild(el('p', { class: 'empty' },
      report && report.warnings && report.warnings.length
        ? report.warnings[0]
        : 'Bu belgede imza bulunamadı.'));
    return;
  }

  // ── Belge bütünlüğü özeti ──
  const di = report.documentIntegrity;
  container.appendChild(el('div', { class: 'sig ' + (di.modifiedAfterSigning ? 'sig--warn' : 'sig--pass') }, [
    el('div', { class: 'sig__head' }, [
      di.modifiedAfterSigning ? 'Belge imzadan sonra değiştirilmiş' : 'Belge bütünlüğü korunuyor',
      el('span', { class: 'sig__level' }, `${di.signatureCount} imza`)
    ]),
    el('div', { class: 'sig__body' }, [
      line(`${di.revisions} revizyon · ${fmtBytes(di.byteLength)}`),
      di.unsignedBytes > 0
        ? line(di.trailingRevisionIsValidationData
            ? `Son ${fmtBytes(di.unsignedBytes)} doğrulama verisi (izinli)`
            : `Son ${fmtBytes(di.unsignedBytes)} imza kapsamı dışında`,
            di.trailingRevisionIsValidationData ? 'ok' : 'bad')
        : line('Tüm belge imza kapsamında', 'ok')
    ])
  ]));

  // ── Her imza ──
  for (const sig of report.signatures) {
    container.appendChild(renderSignature(sig, handlers));
  }

  // ── LTV özeti ──
  const ltv = report.ltv;
  container.appendChild(el('div', { class: 'sig ' + (ltv.offlineVerifiable ? 'sig--pass' : 'sig--warn') }, [
    el('div', { class: 'sig__head' }, [
      ltv.offlineVerifiable ? 'LTV etkin' : 'LTV eksik',
      el('span', { class: 'sig__level' }, ltv.dssPresent ? 'DSS' : 'yok')
    ]),
    el('div', { class: 'sig__body' }, [
      line(`${ltv.certs} sertifika · ${ltv.ocsps} OCSP · ${ltv.crls} CRL`),
      line(ltv.offlineVerifiable
        ? 'Çevrimdışı doğrulanabilir'
        : 'İptal bilgisi gömülü değil — uzun vadede doğrulanamayabilir',
        ltv.offlineVerifiable ? 'ok' : 'bad'),
      !ltv.offlineVerifiable && handlers.onExtend
        ? el('button', {
            class: 'btn', type: 'button', style: { marginTop: '8px' },
            onclick: () => handlers.onExtend('LT')
          }, 'LTV ekle')
        : null
    ])
  ]));
}

function renderSignature(sig, handlers) {
  const state = sig.indication === 'TOTAL-PASSED' ? 'pass'
    : sig.indication === 'TOTAL-FAILED' ? 'fail' : 'warn';

  const title = sig.type === 'doc-timestamp'
    ? (sig.signer && sig.signer.cn ? `Belge damgası · ${sig.signer.cn}` : 'Belge zaman damgası')
    : (sig.signer && sig.signer.cn) || 'Bilinmeyen imzalayan';

  const body = el('div', { class: 'sig__body' });

  // Ana yargı
  body.appendChild(line(
    sig.indication === 'TOTAL-PASSED' ? 'İmza geçerli'
      : sig.indication === 'TOTAL-FAILED' ? 'İmza GEÇERSİZ'
      : 'İmza doğrulanamadı',
    state === 'pass' ? 'ok' : state === 'fail' ? 'bad' : null
  ));

  if (sig.subIndication) {
    body.appendChild(line(SUB_INDICATION_TR[sig.subIndication] || sig.subIndication, 'bad'));
  }

  if (sig.coverage) {
    body.appendChild(line(
      sig.coverage.coversWholeDocument
        ? 'Belgenin tamamını kapsıyor'
        : 'Sonraki revizyonlar var (imza yine geçerli)',
      sig.coverage.coversWholeDocument ? 'ok' : null
    ));
  }

  if (sig.cms) {
    body.appendChild(line('İçerik özeti eşleşiyor',
      sig.cms.messageDigestMatches ? 'ok' : 'bad'));
    if (sig.cms.signingCertificateV2Matches !== null) {
      body.appendChild(line('İmzalayan sertifika bağı (ESS)',
        sig.cms.signingCertificateV2Matches ? 'ok' : 'bad'));
    }
  }

  if (sig.chain && sig.chain.length) {
    body.appendChild(line(
      `Zincir: ${sig.chain.map((c) => c.cn || '?').join(' → ')}`,
      sig.chain.trusted ? 'ok' : 'bad'
    ));
  }

  for (const ts of sig.timestamps || []) {
    body.appendChild(line(
      `${ts.type === 'document-timestamp' ? 'Belge damgası' : 'İmza zamanı'}: ` +
      `${fmtDate(ts.genTime) || '—'}${ts.tsa ? ' · ' + ts.tsa : ''}`,
      ts.valid ? 'ok' : 'bad'
    ));
  }

  for (const rev of sig.revocation || []) {
    body.appendChild(line(
      `İptal (${rev.source}): ${rev.status === 'good' ? 'geçerli' : rev.status}` +
      (rev.subject ? ` · ${rev.subject}` : ''),
      rev.status === 'good' ? 'ok' : rev.status === 'revoked' ? 'bad' : null
    ));
  }

  if (sig.poe) {
    body.appendChild(line(`POE: ${fmtDate(sig.poe.time)} (${sig.poe.source})`, 'ok'));
  }

  for (const w of sig.warnings || []) body.appendChild(line(w));
  for (const e of sig.errors || []) body.appendChild(line(e, 'bad'));

  // Sertifika detayları
  if (sig.signer) {
    const details = el('details', { class: 'sig__details' }, [
      el('summary', {}, 'Sertifika detayları'),
      kv([
        ['Konu', sig.signer.subject],
        ['Veren', sig.signer.issuer],
        ['Seri', sig.signer.serialNumber],
        ['Geçerlilik', `${fmtDate(sig.signer.notBefore)} → ${fmtDate(sig.signer.notAfter)}`],
        ['Anahtar', sig.signer.keyType],
        ['SHA-256', sig.signer.fingerprintSha256]
      ])
    ]);
    body.appendChild(details);
  }

  return el('div', { class: `sig sig--${state}` }, [
    el('div', { class: 'sig__head' }, [
      title,
      el('span', { class: 'sig__level' }, LEVEL_LABEL[sig.achievedLevel] || sig.achievedLevel || '—')
    ]),
    body
  ]);
}

function line(text, state) {
  const cls = 'sig__line' + (state ? ` sig__line--${state}` : '');
  return el('div', { class: cls }, el('span', {}, text));
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
