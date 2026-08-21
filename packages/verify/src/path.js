'use strict';
/**
 * RFC 5280 §6.1 — sertifika yolu kısıtlarının doğrulanması.
 *
 * NEDEN AYRI BİR MODÜL: `buildChain()` yalnız "kim kimi imzalamış" sorusunu
 * yanıtlar. İmzaların doğrulanması bir yolu GEÇERLİ yapmaz. Bir sertifikanın
 * başkasını imzalamaya YETKİLİ olup olmadığı ayrı bir sorudur ve yanıtı
 * sertifikanın uzantılarındadır.
 *
 * Bu kontrol yokken şu saldırı çalışıyordu: saldırgan güvenilen bir CA'dan
 * sıradan bir son varlık sertifikası alır (S/MIME, TLS istemci — ucuz ve
 * herkese açık), o sertifikanın anahtarıyla kendine "Genel Müdür" adına bir
 * sertifika üretir ve belgeyi imzalar. Zincirdeki bütün imzalar gerçekten
 * doğrulanır, kök gerçekten güven deposundadır — ve belge TOTAL-PASSED döner.
 * RFC 5280 §6.1.4(k) tam olarak bunu yasaklar: CA olmayan bir sertifika yol
 * içinde issuer olamaz.
 *
 * Uygulanan kontroller:
 *   §4.2.1.9  basicConstraints — issuer olan her sertifika cA=TRUE olmalı
 *   §6.1.4(n) keyUsage — varsa keyCertSign biti set olmalı
 *   §6.1.4(m) pathLenConstraint — altındaki ara CA sayısı sınırı aşmamalı
 *   §6.1.4(f) tanınmayan KRİTİK uzantı → yol reddedilir
 *   §6.1.4(g-j) nameConstraints — permitted/excluded alt ağaçları
 *   §4.2.1.3  imzalayan sertifikada digitalSignature/contentCommitment
 */

const ext = require('@fitfak/pades/src/cades/x509_ext');

/**
 * İşlemesini bildiğimiz uzantılar.
 *
 * RFC 5280 §6.1.4(f): tanımadığı KRİTİK bir uzantı gören doğrulayıcı yolu
 * REDDETMEK zorundadır. Bilinmeyeni yok saymak, sertifikanın "bu anahtar
 * yalnız şu koşulda kullanılabilir" demesini görmezden gelmektir.
 */
const KNOWN_EXTENSIONS = new Set([
  '2.5.29.14',            // subjectKeyIdentifier
  '2.5.29.15',            // keyUsage
  '2.5.29.16',            // privateKeyUsagePeriod
  '2.5.29.17',            // subjectAltName
  '2.5.29.18',            // issuerAltName
  '2.5.29.19',            // basicConstraints
  '2.5.29.30',            // nameConstraints
  '2.5.29.31',            // cRLDistributionPoints
  '2.5.29.32',            // certificatePolicies
  '2.5.29.33',            // policyMappings
  '2.5.29.35',            // authorityKeyIdentifier
  '2.5.29.36',            // policyConstraints
  '2.5.29.37',            // extKeyUsage
  '2.5.29.46',            // freshestCRL
  '2.5.29.54',            // inhibitAnyPolicy
  '1.3.6.1.5.5.7.1.1',    // authorityInfoAccess
  '1.3.6.1.5.5.7.1.11',   // subjectInfoAccess
  '1.3.6.1.5.5.7.1.3',    // qcStatements (nitelikli sertifika beyanları)
  '1.3.6.1.5.5.7.48.1.5'  // ocsp-nocheck
]);

/** EKU: herhangi bir amaç. */
const EKU_ANY = '2.5.29.37.0';

/**
 * Bir sertifika yolunu RFC 5280 §6.1 kısıtlarına göre doğrular.
 *
 * @param {Buffer[]} path `buildChain()` çıktısı — [leaf, …, anchor]
 * @param {Object} [opts]
 * @param {string[]} [opts.requiredEku] Yaprakta bulunması gereken EKU'lardan
 *   EN AZ BİRİ. EKU uzantısı yoksa kısıt yok sayılır (RFC 5280 §4.2.1.12).
 * @param {boolean} [opts.requireSigningKeyUsage=true] Yaprak, belge imzalamak
 *   için digitalSignature ya da contentCommitment taşımalı mı?
 * @returns {{ ok:boolean, errors:string[], warnings:string[] }}
 */
function validatePath(path, opts = {}) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(path) || path.length === 0) {
    return { ok: false, errors: ['Doğrulanacak sertifika yolu yok'], warnings };
  }

  const name = (der) => {
    try { return ext.getSubjectDer(der).toString('base64').slice(0, 12); }
    catch { return '?'; }
  };
  const cn = (der) => {
    try {
      const crypto = require('crypto');
      const m = /CN=([^\n,]+)/.exec(new crypto.X509Certificate(der).subject || '');
      return m ? m[1].trim() : name(der);
    } catch { return name(der); }
  };

  /* ── 1. Tanınmayan kritik uzantı (§6.1.4(f), §6.1.5(f)) ───────────── */
  for (const der of path) {
    for (const oid of safe(() => ext.criticalExtensionOids(der)) || []) {
      if (KNOWN_EXTENSIONS.has(oid)) continue;
      errors.push(`${cn(der)}: tanınmayan kritik uzantı ${oid} — ` +
        'RFC 5280 §6.1.4(f) bu yolun reddedilmesini gerektirir');
    }
  }

  /* ── 2. Issuer yetkisi: CA bayrağı ve keyCertSign (§6.1.4(k),(n)) ─── */
  // path[k] (k ≥ 1) daima path[k-1]'i imzalayan taraftır.
  for (let k = 1; k < path.length; k++) {
    const issuer = path[k];
    const bc = safe(() => ext.extractBasicConstraints(issuer));

    if (!bc || !bc.isCA) {
      errors.push(`${cn(issuer)}: CA olmayan sertifika issuer olarak kullanılmış ` +
        '(basicConstraints cA=FALSE ya da yok) — RFC 5280 §6.1.4(k)');
      continue;
    }
    if (!bc.critical) {
      // RFC 5280 §4.2.1.9: CA sertifikalarında kritik OLMALIDIR. Eski ya da
      // özensiz CA'lar bunu ihlal edebilir; yolu kesmek yerine bildirilir.
      warnings.push(`${cn(issuer)}: basicConstraints kritik değil (RFC 5280 §4.2.1.9)`);
    }

    const ku = safe(() => ext.extractKeyUsage(issuer));
    if (ku && ku.present && !ku.keyCertSign) {
      errors.push(`${cn(issuer)}: keyUsage uzantısı var ama keyCertSign biti yok — ` +
        'bu anahtar sertifika imzalamaya yetkili değil (RFC 5280 §6.1.4(n))');
    }
  }

  /* ── 3. pathLenConstraint (§6.1.4(m)) ─────────────────────────────── */
  // Yolun tepesinden aşağı inerken RFC'nin max_path_length sayacı işletilir.
  let maxPathLength = Infinity;
  for (let k = path.length - 1; k >= 1; k--) {
    const issuer = path[k];
    const child = path[k - 1];

    // Kendi kendine verilmiş sertifikalar (subject === issuer) sayaçtan düşmez.
    const selfIssued = safe(() => ext.getSubjectDer(child).equals(ext.getIssuerDer(child))) === true;
    if (!selfIssued) {
      if (maxPathLength <= 0) {
        errors.push(`${cn(issuer)}: pathLenConstraint aşıldı — ` +
          'bu CA altında bu kadar ara sertifikaya izin vermiyor (RFC 5280 §6.1.4(m))');
        break;
      }
      maxPathLength -= 1;
    }

    const bc = safe(() => ext.extractBasicConstraints(issuer));
    if (bc && bc.isCA && bc.pathLen !== null && bc.pathLen < maxPathLength) {
      maxPathLength = bc.pathLen;
    }
  }

  /* ── 4. nameConstraints (§6.1.4(g)–(j), §6.1.3(b),(c)) ────────────── */
  nameConstraintErrors(path, errors, warnings, cn);

  /* ── 5. Yaprağın kendi yetkisi ────────────────────────────────────── */
  const leaf = path[0];
  if (opts.requireSigningKeyUsage !== false) {
    const ku = safe(() => ext.extractKeyUsage(leaf));
    if (ku && ku.present && !ku.digitalSignature && !ku.contentCommitment) {
      errors.push(`${cn(leaf)}: imzalayan sertifikada digitalSignature ya da ` +
        'contentCommitment biti yok — bu anahtar belge imzalamaya yetkili değil');
    }
  }
  if (Array.isArray(opts.requiredEku) && opts.requiredEku.length) {
    const eku = safe(() => ext.extractEKU(leaf));
    if (eku && eku.present && !eku.oids.includes(EKU_ANY) &&
        !opts.requiredEku.some((o) => eku.oids.includes(o))) {
      errors.push(`${cn(leaf)}: gerekli extendedKeyUsage yok ` +
        `(beklenen: ${opts.requiredEku.join(', ')}; bulunan: ${eku.oids.join(', ') || 'yok'})`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * İsim kısıtlarını yol boyunca işler.
 *
 * Bir CA "yalnız .example.com altındaki adlara sertifika verebilirim" diye
 * kısıtlanmışsa ve bu kısıt uygulanmazsa, o CA'nın ele geçirilmesi bütün
 * internet için sertifika üretmek anlamına gelir. Kısıt yalnız yazıldığı yerde
 * değil, ALTINDAKİ bütün sertifikalarda geçerlidir.
 */
function nameConstraintErrors(path, errors, warnings, cn) {
  const permitted = [];   // { type, value }
  const excluded = [];

  for (let k = path.length - 1; k >= 0; k--) {
    const cert = path[k];

    // Önce bu sertifika, YUKARIDAN gelen kısıtlara uyuyor mu?
    if (permitted.length || excluded.length) {
      for (const gn of subjectNames(cert)) {
        for (const bad of excluded) {
          if (withinSubtree(gn, bad)) {
            errors.push(`${cn(cert)}: adı üst CA'nın excludedSubtrees kısıtına ` +
              `giriyor (${gn.type}) — RFC 5280 §6.1.4(h)`);
          }
        }
        const sameType = permitted.filter((p) => p.type === gn.type);
        if (sameType.length && !sameType.some((p) => withinSubtree(gn, p))) {
          errors.push(`${cn(cert)}: adı üst CA'nın permittedSubtrees kısıtı ` +
            `dışında (${gn.type}) — RFC 5280 §6.1.4(g)`);
        }
      }
    }

    // Sonra bu sertifika kendi kısıtlarını aşağıya devreder.
    const nc = safe(() => ext.extractNameConstraints(cert));
    if (!nc || !nc.present) continue;
    if (!nc.critical) {
      warnings.push(`${cn(cert)}: nameConstraints kritik değil (RFC 5280 §4.2.1.10 kritik olmasını ister)`);
    }
    permitted.push(...nc.permitted);
    excluded.push(...nc.excluded);
  }
}

/** Sertifikanın kısıt karşılaştırmasına giren adları: Subject DN + SAN. */
function subjectNames(certDer) {
  const out = [];
  const subject = safe(() => ext.getSubjectDer(certDer));
  // Boş bir Subject DN (SEQUENCE {}) kısıt karşılaştırmasına girmez.
  if (subject && subject.length > 2) out.push({ type: 'directoryName', value: subject });

  const san = safe(() => ext.extractSAN(certDer));
  if (san && san.names.length) out.push(...san.names);
  return out;
}

/**
 * `name` verilen alt ağacın içinde mi?
 *
 * Bilmediğimiz bir ad türü için `false` döner: kısıt uygulanamıyorsa
 * "kısıt yok" demek, kısıtın kendisini kaldırmaktır.
 */
function withinSubtree(name, base) {
  if (name.type !== base.type) return false;

  switch (name.type) {
    case 'dNSName': {
      const n = String(name.value).toLowerCase().replace(/\.$/, '');
      const b = String(base.value).toLowerCase().replace(/\.$/, '');
      if (!b) return true;                       // boş taban her şeyi kapsar
      return n === b || n.endsWith(b.startsWith('.') ? b : `.${b}`);
    }
    case 'rfc822Name': {
      const n = String(name.value).toLowerCase();
      const b = String(base.value).toLowerCase();
      if (!b) return true;
      if (b.includes('@')) return n === b;        // tek posta kutusu
      if (b.startsWith('.')) return n.endsWith(b); // alan adı alt ağacı
      const at = n.lastIndexOf('@');
      return at >= 0 && n.slice(at + 1) === b;    // tam alan adı
    }
    case 'uri': {
      const host = hostOfUri(String(name.value));
      const b = String(base.value).toLowerCase().replace(/\.$/, '');
      if (!host) return false;
      if (!b) return true;
      return host === b || host.endsWith(b.startsWith('.') ? b : `.${b}`);
    }
    case 'iPAddress':
      return ipWithin(name.value, base.value);
    case 'directoryName':
      // RFC 5280: taban, adayın ÖNEKİ olan bir RDN dizisidir. DER'de RDN'ler
      // sırayla kodlandığı için önek karşılaştırması yapısal olarak doğrudur.
      return derPrefixOfRdnSequence(base.value, name.value);
    default:
      return false;
  }
}

function hostOfUri(uri) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^:/?#]*)/i.exec(uri);
  return m ? m[1].toLowerCase().replace(/\.$/, '') : null;
}

/** iPAddress alt ağacı: taban = adres + ağ maskesi (4+4 ya da 16+16 bayt). */
function ipWithin(addr, base) {
  if (!Buffer.isBuffer(addr) || !Buffer.isBuffer(base)) return false;
  const half = base.length / 2;
  if (half !== 4 && half !== 16) return false;
  if (addr.length !== half) return false;
  for (let i = 0; i < half; i++) {
    if ((addr[i] & base[half + i]) !== (base[i] & base[half + i])) return false;
  }
  return true;
}

/**
 * `base` RDNSequence'ı `name` RDNSequence'ının başlangıcı mı?
 *
 * Her ikisi de tam DER (tag+len+value). İçerik baytlarını RDN RDN karşılaştırmak
 * yerine önek kontrolü yapılır; DER'de aynı RDN'ler aynı baytlara kodlandığı
 * için bu güvenlidir.
 */
function derPrefixOfRdnSequence(base, name) {
  const b = rdnList(base);
  const n = rdnList(name);
  if (b === null || n === null) return false;
  if (b.length > n.length) return false;
  for (let i = 0; i < b.length; i++) {
    if (!b[i].equals(n[i])) return false;
  }
  return true;
}

function rdnList(der) {
  try {
    const { readTLV } = require('@fitfak/pades/src/cades/x509_extract');
    const seq = readTLV(der, 0);
    if (seq.tag !== 0x30) return null;
    const out = [];
    let p = seq.start;
    while (p < seq.end) {
      const rdn = readTLV(der, p);
      if (rdn.next <= p) break;
      out.push(der.slice(p, rdn.end));
      p = rdn.next;
    }
    return out;
  } catch {
    return null;
  }
}

function safe(fn) {
  try { return fn(); } catch { return null; }
}

module.exports = { validatePath, KNOWN_EXTENSIONS, withinSubtree };
