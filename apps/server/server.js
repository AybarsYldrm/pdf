'use strict';
/**
 * FITFAK Belge Studio — API sunucusu.
 *
 * Saf `node:http`. İş mantığı yok: her uç, ilgili pakete devreder.
 *
 * Güvenlik duruşu:
 *   - Varsayılan akışta özel anahtar sunucuya HİÇ gelmez (iki fazlı imzalama).
 *   - PFX sunucu tarafı modu opt-in'dir; dosya yalnız bellekte tutulur ve
 *     işlem biter bitmez sıfırlanır.
 *   - Hiçbir şey diske yazılmaz.
 *   - Oturumlar kısa ömürlü (varsayılan 120 sn) ve tek kullanımlıktır.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { URL } = require('url');

const paper = require('@fitfak/paper');
const { render } = require('@fitfak/pdf-html');
const { renderStamp, templates } = require('@fitfak/stamp');
const { PAdESManager } = require('@fitfak/pades/src/utils/pades_manager');
const { buildVisibleSignature, fromManifestSlot } = require('@fitfak/pades/src/signature/visible');
const { findAllSignatures } = require('@fitfak/pades/src/utils/pdf_parser');
const { prepareCAdES, completeCAdES } = require('@fitfak/pades/src/cades/cades_builder');
const { verifyPdf } = require('@fitfak/verify');
const p12 = require('@fitfak/pkcs12');
const pdfDoc = require('@fitfak/pdf-doc');
const conformance = require('@fitfak/conformance');
const policy = require('./src/policy');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(__dirname, '..', 'studio');

const CONFIG = {
  port: Number(process.env.PORT) || 8787,
  host: process.env.HOST || '127.0.0.1',
  maxBodyBytes: policy.LIMITS.maxBodyBytes,
  sessionTtlMs: 120000,
  tsaUrl: process.env.TSA_URL || 'http://timestamp.digicert.com',
  // Özel anahtarın sunucuya gelmesi VARSAYILAN OLARAK KAPALIDIR.
  // Açık şekilde '1' verilmediği sürece bu yol kullanılamaz: yanlışlıkla
  // açık kalan bir dağıtım, kullanıcıların özel anahtarlarını toplar.
  // Birincil imzalama modeli iki fazlı tarayıcı imzalamasıdır.
  allowServerSidePfx: process.env.ALLOW_SERVER_PFX === '1',
  defaultFont: process.env.PDF_FONT || path.join(ROOT, 'assets', 'Ubuntu-Regular.ttf'),
  // Belgeden gelen varlıkların okunabileceği TEK dizin (kum havuzu).
  // Depo kökü VERİLMEZ: güvenilmez HTML kaynak kodunu ve anahtarları okurdu.
  assetRoot: process.env.ASSET_ROOT || path.join(ROOT, 'assets')
};

/* ------------------------------------------------------------------ */
/* Oturum deposu (yalnız bellek, TTL'li, tek kullanımlık)              */
/* ------------------------------------------------------------------ */

const sessions = new Map();

/** Hız sınırlayıcı — bellek içi, tek süreç. */
const rateLimiter = new policy.RateLimiter();

function putSession(data) {
  const id = crypto.randomBytes(16).toString('hex');
  const timer = setTimeout(() => wipeSession(id), CONFIG.sessionTtlMs);
  if (timer.unref) timer.unref();
  sessions.set(id, { ...data, timer, createdAt: Date.now() });
  return id;
}

function takeSession(id) {
  const s = sessions.get(id);
  if (!s) return null;
  clearTimeout(s.timer);
  sessions.delete(id);            // tek kullanımlık
  return s;
}

function wipeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.timer);
  sessions.delete(id);
}

/* ------------------------------------------------------------------ */
/* HTTP yardımcıları                                                    */
/* ------------------------------------------------------------------ */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
    // PDF önizlemesi blob: URL'li bir <iframe>'de, tarayıcının yerleşik
    // görüntüleyicisiyle açılır. `object-src 'none'` korunur: eklenti
    // gömülmesine hâlâ izin yok.
    "frame-src 'self' blob:; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
};

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    ...SECURITY_HEADERS
  });
  res.end(buf);
}

function sendError(res, status, code, message, details) {
  sendJson(res, status, { error: { code, message, ...(details ? { details } : {}) } });
}

/**
 * Gövdeyi SINIRLI olarak okur.
 *
 * Sınır aşıldığında iki şeyi aynı anda istiyoruz:
 *   1. fazladan bayt BELLEĞE ALINMASIN,
 *   2. istemci 413 yanıtını GÖRSÜN.
 *
 * Soketi anında koparmak (2)'yi imkânsız kılar: istemci "bağlantı sıfırlandı"
 * görür ve neden reddedildiğini asla öğrenemez — hata ayıklanamaz bir uç.
 * Bu yüzden kalan baytlar okunur ama biriktirilmez; israfı sınırlamak için
 * yalnız sınırın iki katına kadar tolerans gösterilir, sonrası koparılır.
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let total = 0;
    let overflowed = false;

    req.on('data', (c) => {
      total += c.length;

      if (overflowed) {
        // Yanıt yazılana kadar biraz tolerans; sonra bağlantı koparılır.
        if (total > maxBytes * 2) req.destroy();
        return;
      }
      if (total > maxBytes) {
        overflowed = true;
        chunks = [];                                  // birikeni de bırak
        reject(Object.assign(new Error('İstek gövdesi çok büyük'),
          { code: 'ERR_BODY_TOO_LARGE', status: 413 }));
        return;
      }
      chunks.push(c);
    });

    req.on('end', () => { if (!overflowed) resolve(Buffer.concat(chunks)); });
    req.on('error', (err) => { if (!overflowed) reject(err); });
  });
}

/**
 * `Content-Type: application/json` şart koşulur.
 *
 * Sadece biçim titizliği değil: tarayıcılar `text/plain`, `multipart/form-data`
 * ve `application/x-www-form-urlencoded` gövdeli POST'ları "basit istek" sayar
 * ve ÖN KONTROL (preflight) yapmadan başka kaynaklara gönderir. JSON şartı,
 * çapraz kaynaklı bir sayfanın bu uçları sessizce tetiklemesini engeller.
 */
function requireJsonContentType(req) {
  const len = req.headers['content-length'];
  const chunked = req.headers['transfer-encoding'] !== undefined;
  // Gövdesiz istekte içerik türü aramak anlamsızdır
  if (!chunked && (len === undefined || len === '0')) return;

  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    throw Object.assign(
      new Error(`Content-Type application/json olmalı (gelen: ${type || 'yok'})`),
      { code: 'ERR_CONTENT_TYPE', status: 415 });
  }
}

async function readJson(req) {
  requireJsonContentType(req);
  const buf = await readBody(req, CONFIG.maxBodyBytes);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw Object.assign(new Error('Geçersiz JSON gövdesi'), { code: 'ERR_BAD_JSON' });
  }
}

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => Buffer.from(String(s || ''), 'base64');

/* ------------------------------------------------------------------ */
/* Uçlar                                                                */
/* ------------------------------------------------------------------ */

const manager = () => new PAdESManager({
  tsaUrl: CONFIG.tsaUrl,
  tsaOptions: { hashName: 'sha256', certReq: true }
});

const routes = {

  /** Sağlık ve yetenek bildirimi */
  'GET /api/health': async (req, res) => {
    sendJson(res, 200, {
      ok: true,
      version: require(path.join(ROOT, 'package.json')).version,
      node: process.version,
      tsa: CONFIG.tsaUrl,
      themes: paper.THEMES,
      stampTemplates: Object.keys(templates),
      conformanceProfiles: ['pdf/a-1b', 'pdf/a-2b', 'pdf/a-3b', 'pdf/ua', 'pdf/a-2b+pdf/ua'],
      serverSidePfx: CONFIG.allowServerSidePfx,
      maxBodyBytes: CONFIG.maxBodyBytes
    });
  },

  /** HTML + CSS → PDF + layout manifest */
  'POST /api/render': async (req, res) => {
    const body = await readJson(req);
    if (!body.html) return sendError(res, 400, 'ERR_HTML_MISSING', 'html alanı zorunlu');

    // Yerleşim motoru girdiyle DOĞRUSAL DEĞİL ölçeklenir; sınır burada
    policy.checkBytes(Buffer.from(String(body.html), 'utf8'), 'maxHtmlBytes', 'HTML');
    const cssTotal = []
      .concat(body.css || [])
      .reduce((n, c) => n + Buffer.byteLength(String(c), 'utf8'), 0);
    policy.checkBytes({ length: cssTotal }, 'maxCssBytes', 'CSS');
    policy.checkCount((body.fonts || []).length, 'maxFonts', 'font');

    const css = [];
    if (body.theme !== null) css.push(...paper.stack(body.theme || 'kurumsal'));
    if (body.css) css.push(...(Array.isArray(body.css) ? body.css : [body.css]));

    const result = render({
      html: body.html,
      css,
      fonts: body.fonts || [{ family: 'Ubuntu', src: CONFIG.defaultFont }],
      page: body.page || { size: 'A4', margin: '20mm 18mm' },
      metadata: body.metadata || {},
      conformance: body.conformance || null,
      baseDir: ROOT,
      // Belgeden gelen görsel/font yolları YALNIZ bu dizinden okunabilir.
      // ROOT verilseydi güvenilmez HTML tüm depoyu okurdu.
      assetRoots: [CONFIG.assetRoot],
      assetLimits: {
        maxImageBytes: policy.LIMITS.maxImageBytes,
        maxFontBytes: policy.LIMITS.maxFontBytes,
        maxAssets: policy.LIMITS.maxAssets
      }
    });

    sendJson(res, 200, {
      pdf: b64(result.pdf),
      manifest: result.manifest,
      warnings: result.warnings,
      conformance: result.conformance || null
    });
  },

  /** PDF yapısını incele (sayfa sayısı, imzalar) */
  'POST /api/inspect': async (req, res) => {
    const body = await readJson(req);
    const pdf = unb64(body.pdf);
    if (!pdf.length) return sendError(res, 400, 'ERR_PDF_MISSING', 'pdf alanı zorunlu');

    const sigs = findAllSignatures(pdf);
    sendJson(res, 200, {
      byteLength: pdf.length,
      signatures: sigs.map((s) => ({
        type: s.type, subFilter: s.subFilter, byteRange: s.byteRange, vriKeys: s.vriKeys
      }))
    });
  },

  /**
   * Yüklenen bir PDF'i AÇAR: sayfa geometrileri, üst veri, form alanları,
   * imzalar ve metin özeti. Xref akışı / nesne akışı / şifreli belgeler dâhil.
   */
  'POST /api/pdf/open': async (req, res) => {
    const body = await readJson(req);
    const pdf = unb64(body.pdf);
    if (!pdf.length) return sendError(res, 400, 'ERR_PDF_MISSING', 'pdf alanı zorunlu');

    policy.checkBytes(pdf, 'maxPdfBytes', 'PDF');

    let doc;
    try {
      doc = pdfDoc.PdfDocument.load(pdf, { password: body.password || '' });
    } catch (err) {
      return sendError(res, 400, err.code || 'ERR_PDF_OPEN', err.message);
    }
    policy.checkPdf(pdf, doc);

    const pages = [];
    for (let i = 0; i < doc.pageCount; i++) {
      const g = doc.getPageGeometry(i);
      pages.push({
        index: i,
        width: round(g.width), height: round(g.height), rotate: g.rotate,
        mediaBox: g.mediaBox.map(round), cropBox: g.cropBox.map(round),
        text: body.text === false ? undefined : safe(() => doc.extractText(i), '').slice(0, 4000)
      });
    }

    sendJson(res, 200, {
      byteLength: pdf.length,
      pageCount: doc.pageCount,
      pages,
      encrypted: doc.isEncrypted,
      recovered: doc.xref.recovered || !!doc.offsetsRepaired,
      hasSignatures: doc.hasSignatures,
      hasForm: doc.hasForm,
      info: doc.getInfo(),
      fields: safe(() => doc.listFields().map((f) => ({
        name: f.name, type: f.type, value: f.value, options: f.options,
        readOnly: f.readOnly, required: f.required, multiline: f.multiline,
        radio: f.radio, page: f.page, rect: f.rect
      })), []),
      signatures: findAllSignatures(pdf).map((s) => ({
        type: s.type, subFilter: s.subFilter, byteRange: s.byteRange
      }))
    });
  },

  /**
   * Belgeyi ARTIMLI olarak düzenler: sayfa işlemleri, görsel/metin/bağlantı
   * yerleştirme, form doldurma, üst veri. İmzalı belgelerde önceki imzalar
   * geçerli kalır (orijinal baytlara dokunulmaz).
   */
  'POST /api/pdf/edit': async (req, res) => {
    const body = await readJson(req);
    const pdf = unb64(body.pdf);
    if (!pdf.length) return sendError(res, 400, 'ERR_PDF_MISSING', 'pdf alanı zorunlu');
    if (!Array.isArray(body.ops) || !body.ops.length) {
      return sendError(res, 400, 'ERR_OPS_MISSING', 'ops dizisi zorunlu');
    }
    policy.checkBytes(pdf, 'maxPdfBytes', 'PDF');
    policy.checkCount(body.ops.length, 'maxOps', 'düzenleme işlemi');

    let doc;
    try {
      doc = pdfDoc.PdfDocument.load(pdf, { password: body.password || '' });
    } catch (err) {
      return sendError(res, 400, err.code || 'ERR_PDF_OPEN', err.message);
    }
    policy.checkPdf(pdf, doc);

    const applied = [];
    try {
      for (const op of body.ops) applied.push(applyOp(doc, op));
    } catch (err) {
      return sendError(res, 400, err.code || 'ERR_EDIT_FAILED', err.message,
        { appliedCount: applied.length });
    }

    const out = doc.save({ full: body.rewrite === true, force: body.force === true });
    sendJson(res, 200, {
      pdf: b64(out),
      byteLength: out.length,
      pageCount: pdfDoc.PdfDocument.load(out).pageCount,
      preservedOriginal: !body.rewrite,
      applied
    });
  },

  /**
   * PDF/A ve PDF/UA uyumluluk denetimi.
   *
   * Belgeyi ÜRETMEZ, denetler: `profiles` verilmezse belgenin XMP'de iddia
   * ettiği profiller sınanır.
   */
  'POST /api/conformance/check': async (req, res) => {
    const body = await readJson(req);
    const pdf = unb64(body.pdf);
    if (!pdf.length) return sendError(res, 400, 'ERR_PDF_MISSING', 'pdf alanı zorunlu');

    let report;
    try {
      report = conformance.check(pdf, {
        profiles: Array.isArray(body.profiles) && body.profiles.length ? body.profiles : undefined,
        password: body.password || ''
      });
    } catch (err) {
      return sendError(res, 400, err.code || 'ERR_CONFORMANCE', err.message);
    }

    sendJson(res, 200, { ...report, text: conformance.formatReport(report) });
  },

  /** Damga önizlemesi (PNG) */
  'POST /api/stamp/preview': async (req, res) => {
    const body = await readJson(req);
    const result = renderStamp({
      template: body.template || 'dual',
      font: body.font || CONFIG.defaultFont,
      baseDir: ROOT,
      seed: body.seed,
      vars: {
        logo: path.join(ROOT, 'packages/pades/src/assets/caduceus.png'),
        ...(body.vars || {}),
        ...(body.handwritten ? { handwritten: unb64(body.handwritten) } : {})
      }
    });
    sendJson(res, 200, { png: b64(result.png), width: result.width, height: result.height,
                         rendered: result.rendered });
  },

  /**
   * İKİ FAZLI İMZALAMA — 1. faz.
   * İstemci sertifikalarını gönderir; sunucu imzalanacak veriyi döndürür.
   * ÖZEL ANAHTAR SUNUCUYA GELMEZ.
   */
  'POST /api/sign/prepare': async (req, res) => {
    const body = await readJson(req);
    const pdf = unb64(body.pdf);
    if (!pdf.length) return sendError(res, 400, 'ERR_PDF_MISSING', 'pdf alanı zorunlu');
    if (!body.certPem) return sendError(res, 400, 'ERR_CERT_MISSING', 'certPem alanı zorunlu');

    const {
      PDFPAdESWriter, ensureAcroFormAndEmptySigField
    } = require('@fitfak/pades/src/utils/pdf_parser');
    const { parseCertBasics, pemToDer } = require('@fitfak/pades/src/cades/x509_extract');

    const fieldName = body.fieldName || ('Signature_' + crypto.randomBytes(4).toString('hex'));
    const visible = buildVisibleForRequest(body);

    let working = ensureAcroFormAndEmptySigField(pdf, fieldName, visible ? visible.page : 0);
    const writer = new PDFPAdESWriter(working);

    if (visible) {
      try {
        writer.applyVisibleSignatureFromPng({
          fieldName, imageBuffer: visible.imageBuffer, rect: visible.defaultPosition
        });
      } catch (err) {
        // Görünür imza başarısızsa imza görünmez olarak devam eder
      }
    }

    writer.preparePlaceholder({
      subFilter: 'ETSI.CAdES.detached',
      placeholderHexLen: body.placeholderHexLen || 120000,
      fieldName
    });

    const leafDer = pemToDer(body.certPem);
    const { recommendedHash } = parseCertBasics(leafDer);
    const tbsHash = writer.computeByteRangeHash(recommendedHash);

    const prepared = prepareCAdES(tbsHash, body.certPem, body.chainPems || []);

    const sessionId = putSession({
      writer, prepared, fieldName,
      level: (body.level || 'T').toUpperCase(),
      certPem: body.certPem,
      chainPems: body.chainPems || []
    });

    sendJson(res, 200, {
      sessionId,
      dataToSign: b64(prepared.dataToSign),
      hashAlgorithm: prepared.hashName,
      keyType: prepared.keyType,
      expiresInMs: CONFIG.sessionTtlMs
    });
  },

  /**
   * İKİ FAZLI İMZALAMA — 2. faz.
   * İstemci imza değerini gönderir; sunucu CMS'i tamamlayıp TSA/LTV ekler.
   */
  'POST /api/sign/finalize': async (req, res) => {
    const body = await readJson(req);
    const session = takeSession(body.sessionId);
    if (!session) {
      return sendError(res, 410, 'ERR_SESSION_EXPIRED',
        'İmza oturumu bulunamadı ya da süresi doldu. Yeniden başlatın.');
    }
    if (!body.signature) {
      return sendError(res, 400, 'ERR_SIGNATURE_MISSING', 'signature alanı zorunlu');
    }

    const {
      addUnsignedAttr_signatureTimeStampToken, buildSignedData
    } = require('@fitfak/pades/src/cades/cades_builder');

    const completed = completeCAdES(session.prepared, unb64(body.signature));
    const pm = manager();
    const reasons = [];
    let cms = completed.cmsBES;
    let achieved = 'pades-b';

    // B-T: imza değeri üzerine RFC 3161 zaman damgası
    if (session.level !== 'B') {
      try {
        const tst = await requestTimestampFor(pm, completed.signatureValue);
        const signerInfoT = addUnsignedAttr_signatureTimeStampToken(completed.signerInfo, tst);
        cms = buildSignedData(completed.hashName,
          [completed.leafDer, ...completed.chainDer], signerInfoT, completed.keyType);
        achieved = 'pades-t';
      } catch (err) {
        reasons.push(`Zaman damgası alınamadı (${err.message}); B seviyesinde kalındı.`);
      }
    }

    session.writer.injectCMS(cms);
    let pdf = session.writer.toBuffer();
    let ltvReport = null;

    // B-LT / B-LTA
    if ((session.level === 'LT' || session.level === 'LTA') && achieved === 'pades-t') {
      try {
        const lt = await pm.addLTV({
          pdfBuffer: pdf, certsPem: session.chainPems, prefer: 'ocsp-first', strict: false
        });
        pdf = lt.pdf;
        ltvReport = lt.report;
        achieved = 'pades-lt';
        reasons.push(...(lt.report.warnings || []));

        if (session.level === 'LTA') {
          pdf = await pm.addDocTimeStamp({ pdfBuffer: pdf, fieldName: session.fieldName + '_Archive' });
          const lt2 = await pm.addLTV({ pdfBuffer: pdf, strict: false });
          pdf = lt2.pdf;
          achieved = 'pades-lta';
        }
      } catch (err) {
        reasons.push(`LTV verisi eklenemedi (${err.message}).`);
      }
    }

    sendJson(res, 200, {
      pdf: b64(pdf),
      requestedLevel: session.level,
      achievedLevel: achieved,
      reasons,
      ltvReport
    });
  },

  /**
   * SUNUCU TARAFI PFX ile imzalama (opt-in).
   * Basit ama daha zayıf: PFX sunucuya gelir. Yalnız bellekte tutulur ve
   * işlem biter bitmez sıfırlanır.
   */
  'POST /api/sign/pfx': async (req, res) => {
    if (!CONFIG.allowServerSidePfx) {
      return sendError(res, 403, 'ERR_SERVER_PFX_DISABLED',
        'Sunucu tarafı PFX imzalama kapalı. Tarayıcı içi imzalamayı kullanın.');
    }
    const body = await readJson(req);
    const pdf = unb64(body.pdf);
    const pfx = unb64(body.pfx);
    if (!pdf.length) return sendError(res, 400, 'ERR_PDF_MISSING', 'pdf alanı zorunlu');
    if (!pfx.length) return sendError(res, 400, 'ERR_PFX_MISSING', 'pfx alanı zorunlu');

    try {
      const result = await manager().sign({
        mode: (body.level || 'LT').toUpperCase(),
        pdfBuffer: pdf,
        pfx,
        pfxPassword: body.password || '',
        pfxOptions: body.identityIndex !== undefined ? { identityIndex: body.identityIndex } : {},
        fieldName: body.fieldName || undefined,
        visibleSignature: buildVisibleForRequest(body),
        ltv: { prefer: 'ocsp-first' }
      });

      sendJson(res, 200, {
        pdf: b64(result.pdf),
        requestedLevel: result.requestedLevel,
        achievedLevel: result.achievedLevel,
        reasons: result.reasons,
        ltvReport: result.ltvReport || null
      });
    } finally {
      pfx.fill(0);                       // parolayı ve anahtarı bellekte bırakma
      if (body.password) body.password = null;
    }
  },

  /** PFX içindeki kimlikleri listele (parola gerekir, imza atılmaz) */
  'POST /api/pfx/identities': async (req, res) => {
    const body = await readJson(req);
    const pfx = unb64(body.pfx);
    if (!pfx.length) return sendError(res, 400, 'ERR_PFX_MISSING', 'pfx alanı zorunlu');
    try {
      const { Pkcs12Signer } = require('@fitfak/pades/src/signer');
      const list = Pkcs12Signer.listIdentities(pfx, body.password || '');
      sendJson(res, 200, { identities: list, probe: p12.probe(pfx) });
    } finally {
      pfx.fill(0);
    }
  },

  /** Mevcut imzalı PDF'i LT/LTA seviyesine yükselt */
  'POST /api/ltv/extend': async (req, res) => {
    const body = await readJson(req);
    const pdf = unb64(body.pdf);
    if (!pdf.length) return sendError(res, 400, 'ERR_PDF_MISSING', 'pdf alanı zorunlu');

    const pm = manager();
    const target = (body.targetLevel || 'LT').toUpperCase();
    const result = target === 'LTA'
      ? await pm.extendToLTA(pdf, { prefer: 'ocsp-first', strict: false })
      : await pm.extendToLT(pdf, { prefer: 'ocsp-first', strict: false });

    sendJson(res, 200, {
      pdf: b64(result.pdf),
      achievedLevel: result.achievedLevel,
      report: result.report
    });
  },

  /** İmza doğrulama — imza panelinin veri kaynağı */
  'POST /api/verify': async (req, res) => {
    const body = await readJson(req);
    const pdf = unb64(body.pdf);
    if (!pdf.length) return sendError(res, 400, 'ERR_PDF_MISSING', 'pdf alanı zorunlu');

    const report = await verifyPdf(pdf, {
      trustAnchors: body.trustAnchors || undefined,
      allowNetwork: body.allowNetwork === true,
      useEmbeddedRevocation: body.useEmbeddedRevocation !== false
    });
    sendJson(res, 200, report);
  }
};

/* ------------------------------------------------------------------ */
/* Belge düzenleme işlemleri                                            */
/* ------------------------------------------------------------------ */

class EditRequestError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const round = (n) => Math.round(Number(n) * 100) / 100;

/** Hata fırlatan bir okumayı yedek değerle sarar. */
function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

function requireNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new EditRequestError('ERR_OP_ARG', `${label} sayı olmalı`);
  return n;
}

/**
 * Tek bir düzenleme işlemini uygular.
 *
 * Koordinatlar PDF kullanıcı uzayındadır: orijin sol-ALT köşe, birim punto.
 * Tarayıcı sol-ÜST kullandığı için istemci `y`'yi çevirmelidir.
 */
function applyOp(doc, op) {
  const kind = String(op && op.op || '');

  switch (kind) {
    case 'rotate':
      doc.rotatePage(requireNumber(op.page, 'page'), requireNumber(op.degrees, 'degrees'));
      return { op: kind, page: op.page };

    case 'removePage':
      doc.removePage(requireNumber(op.page, 'page'));
      return { op: kind, page: op.page };

    case 'movePage':
      doc.movePage(requireNumber(op.from, 'from'), requireNumber(op.to, 'to'));
      return { op: kind, from: op.from, to: op.to };

    case 'reorder':
      doc.reorderPages(op.order);
      return { op: kind, order: op.order };

    case 'insertPage': {
      const ref = doc.insertPage(requireNumber(op.index, 'index'),
        { size: op.size, rotate: op.rotate });
      return { op: kind, index: op.index, objNum: ref.num };
    }

    case 'image': {
      const image = unb64(op.image);
      if (!image.length) throw new EditRequestError('ERR_OP_ARG', 'image (base64) zorunlu');
      const info = doc.addImage(requireNumber(op.page, 'page'), image, {
        x: requireNumber(op.x, 'x'),
        y: requireNumber(op.y, 'y'),
        width: requireNumber(op.width, 'width'),
        height: op.height != null ? Number(op.height) : undefined,
        rotate: Number(op.rotate) || 0,
        opacity: op.opacity != null ? Number(op.opacity) : undefined
      });
      return { op: kind, page: op.page, name: info.name, pixels: [info.width, info.height] };
    }

    case 'text': {
      const res = doc.addText(requireNumber(op.page, 'page'), String(op.text || ''), {
        x: requireNumber(op.x, 'x'),
        y: requireNumber(op.y, 'y'),
        size: op.size != null ? Number(op.size) : undefined,
        color: Array.isArray(op.color) ? op.color.map(Number) : undefined,
        font: op.font
      });
      return { op: kind, page: op.page, fontName: res.fontName };
    }

    case 'link':
      doc.addLink(requireNumber(op.page, 'page'), {
        x: requireNumber(op.x, 'x'), y: requireNumber(op.y, 'y'),
        width: requireNumber(op.width, 'width'), height: requireNumber(op.height, 'height')
      }, String(op.uri || ''));
      return { op: kind, page: op.page };

    case 'content':
      doc.appendContent(requireNumber(op.page, 'page'), String(op.commands || ''));
      return { op: kind, page: op.page };

    case 'metadata':
      doc.setMetadata(op.values || {});
      return { op: kind, keys: Object.keys(op.values || {}) };

    case 'fillForm': {
      const report = doc.fillForm(op.values || {}, { strict: op.strict === true });
      if (op.flatten) Object.assign(report, doc.flattenForm({ only: op.only }));
      return { op: kind, ...report };
    }

    case 'flattenForm':
      return { op: kind, ...doc.flattenForm({ only: op.only }) };

    default:
      throw new EditRequestError('ERR_OP_UNKNOWN', `Bilinmeyen işlem: ${kind || '(boş)'}`);
  }
}

/** İstek gövdesinden görünür imza yapılandırması kurar. */
function buildVisibleForRequest(body) {
  if (body.visible === false) return null;
  const v = body.visible || {};
  const slot = body.slot || null;

  const vars = {
    logo: path.join(ROOT, 'packages/pades/src/assets/caduceus.png'),
    signerName: v.signerName || body.signerName || '',
    role: v.role || (slot && slot.role) || '',
    docNo: v.docNo || '',
    verifyUrl: v.verifyUrl || '',
    date: new Date(),
    ...(v.vars || {})
  };
  if (v.handwritten) vars.handwritten = unb64(v.handwritten);

  const opts = {
    template: v.template || 'minimal',
    font: v.font || CONFIG.defaultFont,
    baseDir: ROOT,
    vars
  };

  if (slot && slot.rect) return fromManifestSlot(slot, opts);
  if (v.rect) return buildVisibleSignature({ ...opts, rect: v.rect, page: v.page || 0 });
  return null;
}

async function requestTimestampFor(pm, signatureValue) {
  const { OIDS } = require('@fitfak/pades/src/cades/oids');
  const hashName = 'sha256';
  const digest = crypto.createHash(hashName).update(signatureValue).digest();
  const { der: tsq, nonce } = pm._buildTSQ(digest, { hashOid: OIDS.sha256, certReq: true });
  const { der: resp } = await pm._requestTimestamp(pm.tsaUrl, tsq, pm.tsaHeaders);
  return pm._extractTimeStampTokenOrThrow(resp, {
    expectedImprint: digest, expectedNonce: nonce, expectedHashOid: OIDS.sha256
  });
}

/* ------------------------------------------------------------------ */
/* Statik dosyalar                                                      */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

/** Yalnız bu uzantılar servis edilir — kaynak/manifest dosyaları sızmasın. */
const SERVABLE = new Set(Object.keys(MIME));

function serveStatic(pathname, res) {
  // Yüzde kodlaması ÇÖZÜLDÜKTEN sonra kontrol edilir; aksi hâlde `%2e%2e`
  // ile dizin dışına çıkılabilir.
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendError(res, 400, 'ERR_BAD_PATH', 'Geçersiz yol');
  }
  if (rel === '/') rel = '/index.html';
  if (rel.includes('\0')) return sendError(res, 400, 'ERR_BAD_PATH', 'Geçersiz yol');

  const ext = path.extname(rel).toLowerCase();
  if (!SERVABLE.has(ext)) {
    return sendError(res, 404, 'ERR_NOT_FOUND', 'Bulunamadı');
  }
  // package.json gibi paket meta dosyaları asla servis edilmez
  if (/(^|\/)(package(-lock)?\.json|\.[^/]+)$/i.test(rel)) {
    return sendError(res, 404, 'ERR_NOT_FOUND', 'Bulunamadı');
  }

  const resolved = path.resolve(PUBLIC_DIR, '.' + rel);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return sendError(res, 403, 'ERR_FORBIDDEN', 'Erişim engellendi');
  }

  // @fitfak/paper'ın derlenmiş CSS'i doğrudan servis edilir — tarayıcı ve PDF
  // motoru AYNI dosyayı okur, önizleme bu yüzden gerçekten WYSIWYG olur.
  let file = resolved;
  if (rel === '/vendor/paper.css') file = path.join(paper.DIST, 'paper.css');

  fs.readFile(file, (err, data) => {
    if (err) {
      return sendError(res, 404, 'ERR_NOT_FOUND', `Bulunamadı: ${rel}`);
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* Sunucu                                                               */
/* ------------------------------------------------------------------ */

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const key = `${req.method} ${url.pathname}`;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { Allow: 'GET, POST, OPTIONS', ...SECURITY_HEADERS });
      return res.end();
    }

    const handler = routes[key];
    if (handler) {
      /* --- Erişim denetimi ------------------------------------------
       * Hassas uçlar (imzalama, PFX, LTV) belirteç ister. Belirteç hiç
       * yapılandırılmamışsa sunucu yalnız yerel kullanım varsayar ve
       * başlangıçta uyarır. */
      const decision = policy.authorize(req, key);
      if (!decision.allowed) {
        policy.auditLog({
          event: 'auth.denied', route: key,
          client: policy.clientKey(req), outcome: decision.code
        });
        return sendError(res, decision.status, decision.code, decision.message);
      }

      /* --- Hız sınırı ---------------------------------------------- */
      const limit = decision.kind === 'sensitive'
        ? policy.RATE.maxSensitive : policy.RATE.maxRequests;
      const rate = rateLimiter.hit(policy.clientKey(req), limit);
      if (!rate.allowed) {
        res.setHeader('Retry-After', Math.ceil(rate.retryAfterMs / 1000));
        return sendError(res, 429, 'ERR_RATE_LIMIT',
          `Çok fazla istek; ${Math.ceil(rate.retryAfterMs / 1000)} saniye sonra deneyin.`);
      }

      if (decision.kind === 'sensitive') {
        policy.auditLog({
          event: 'request', route: key, client: policy.clientKey(req),
          outcome: decision.authenticated ? 'authenticated' : 'unauthenticated'
        });
      }

      try {
        await handler(req, res);
      } catch (err) {
        if (!res.headersSent) {
          const status = err.status
            || (err.code === 'ERR_BODY_TOO_LARGE' ? 413
              : err.code === 'ERR_TOO_LARGE' ? 413
              : /^ERR_(BAD_JSON|TOO_MANY|PDF_|ASSET_|PFX_|OP_|HTML_|CSS_)/.test(err.code || '') ? 400
              : 500);
          sendError(res, status, err.code || 'ERR_INTERNAL', err.message);
        }
        if (!err.code) console.error('[sunucu hatası]', err);
      }
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      return sendError(res, 404, 'ERR_NO_ROUTE', `Bilinmeyen uç: ${key}`);
    }
    if (req.method !== 'GET') {
      return sendError(res, 405, 'ERR_METHOD', 'Yalnız GET desteklenir');
    }
    serveStatic(url.pathname, res);
  });
}

/**
 * Sunucuyu başlatır. Hem `node server.js` hem `fitfak-belge serve` bunu çağırır
 * ki iki giriş noktası aynı davranışı paylaşsın.
 */
function start() {
  // Ortam değişkenleri modül yüklendikten SONRA değişmiş olabilir (CLI yolu)
  CONFIG.port = Number(process.env.PORT) || CONFIG.port;
  CONFIG.host = process.env.HOST || CONFIG.host;
  CONFIG.tsaUrl = process.env.TSA_URL || CONFIG.tsaUrl;

  // paper.css derlenmiş olsun
  try { paper.build(); } catch (err) { console.warn('paper.css derlenemedi:', err.message); }

  const server = createServer();
  // Yavaş istemci saldırıları (Slowloris) için zaman aşımları
  server.requestTimeout = policy.LIMITS.requestTimeoutMs;
  server.headersTimeout = policy.LIMITS.headersTimeoutMs;

  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`\n  FITFAK Belge Studio`);
    console.log(`  → http://${CONFIG.host}:${CONFIG.port}\n`);
    console.log(`  TSA          : ${CONFIG.tsaUrl}`);
    console.log(`  Sunucu PFX   : ${CONFIG.allowServerSidePfx ? 'açık (opt-in mod)' : 'kapalı'}`);
    console.log(`  Gövde sınırı : ${(CONFIG.maxBodyBytes / 1024 / 1024).toFixed(0)} MB`);
    console.log(`  Kimlik doğr. : ${policy.authEnabled() ? 'açık (API_TOKENS)' : 'KAPALI'}`);
    console.log(`  Varlık kökü  : ${CONFIG.assetRoot}`);

    const dısaAcik = CONFIG.host !== '127.0.0.1' && CONFIG.host !== 'localhost' && CONFIG.host !== '::1';
    if (dısaAcik && !policy.authEnabled()) {
      console.warn('\n  ⚠ UYARI: sunucu dışa açık bir adrese bağlandı ama API_TOKENS ' +
        'tanımlı değil.\n    İmzalama ve PFX uçları kimlik doğrulamasız erişilebilir. ' +
        'API_TOKENS ayarlayın.\n');
    }
    console.log(`  Not: Varsayılan akışta özel anahtar tarayıcıdan çıkmaz.\n`);
  });
  return server;
}

if (require.main === module) start();

module.exports = { createServer, start, CONFIG, routes, policy, rateLimiter };
