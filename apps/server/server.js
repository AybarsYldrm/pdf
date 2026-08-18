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

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(__dirname, '..', 'studio');

const CONFIG = {
  port: Number(process.env.PORT) || 8787,
  host: process.env.HOST || '127.0.0.1',
  maxBodyBytes: Number(process.env.MAX_BODY) || 32 * 1024 * 1024,
  sessionTtlMs: 120000,
  tsaUrl: process.env.TSA_URL || 'http://timestamp.digicert.com',
  allowServerSidePfx: process.env.ALLOW_SERVER_PFX !== '0',
  defaultFont: process.env.PDF_FONT || path.join(ROOT, 'assets', 'Ubuntu-Regular.ttf')
};

/* ------------------------------------------------------------------ */
/* Oturum deposu (yalnız bellek, TTL'li, tek kullanımlık)              */
/* ------------------------------------------------------------------ */

const sessions = new Map();

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

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error('İstek gövdesi çok büyük'), { code: 'ERR_BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
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
      serverSidePfx: CONFIG.allowServerSidePfx,
      maxBodyBytes: CONFIG.maxBodyBytes
    });
  },

  /** HTML + CSS → PDF + layout manifest */
  'POST /api/render': async (req, res) => {
    const body = await readJson(req);
    if (!body.html) return sendError(res, 400, 'ERR_HTML_MISSING', 'html alanı zorunlu');

    const css = [];
    if (body.theme !== null) css.push(...paper.stack(body.theme || 'kurumsal'));
    if (body.css) css.push(...(Array.isArray(body.css) ? body.css : [body.css]));

    const result = render({
      html: body.html,
      css,
      fonts: body.fonts || [{ family: 'Ubuntu', src: CONFIG.defaultFont }],
      page: body.page || { size: 'A4', margin: '20mm 18mm' },
      metadata: body.metadata || {},
      baseDir: ROOT
    });

    sendJson(res, 200, {
      pdf: b64(result.pdf),
      manifest: result.manifest,
      warnings: result.warnings
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
      try {
        await handler(req, res);
      } catch (err) {
        if (!res.headersSent) {
          const status = err.code === 'ERR_BODY_TOO_LARGE' ? 413
            : err.code === 'ERR_BAD_JSON' ? 400
            : 500;
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

if (require.main === module) {
  // paper.css derlenmiş olsun
  try { paper.build(); } catch (err) { console.warn('paper.css derlenemedi:', err.message); }

  const server = createServer();
  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`\n  FITFAK Belge Studio`);
    console.log(`  → http://${CONFIG.host}:${CONFIG.port}\n`);
    console.log(`  TSA          : ${CONFIG.tsaUrl}`);
    console.log(`  Sunucu PFX   : ${CONFIG.allowServerSidePfx ? 'açık (opt-in mod)' : 'kapalı'}`);
    console.log(`  Gövde sınırı : ${(CONFIG.maxBodyBytes / 1024 / 1024).toFixed(0)} MB`);
    console.log(`  Not: Varsayılan akışta özel anahtar tarayıcıdan çıkmaz.\n`);
  });
}

module.exports = { createServer, CONFIG, routes };
