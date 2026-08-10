'use strict';
/**
 * Hazır Sertifika Profilleri.
 *
 * SORUN: "Bir TSA sertifikası nasıl olmalı?" sorusunun cevabı (KeyUsage'da
 * hangi bitler, EKU'da hangi OID, EKU critical olmalı mı) RFC'lere dağılmış
 * durumdadır ve her seferinde elle yazmak hataya açıktır — nitekim
 * `extendedKeyUsage`'ın TSA için **critical** olması gerektiği sık atlanan
 * bir ayrıntıdır (RFC 3161 §2.3).
 *
 * ÇÖZÜM: Bu modül, yaygın kullanım amaçlarını isimlendirilmiş profiller
 * hâlinde sunar. `profile: 'tsa'` demek yeterlidir; doğru KeyUsage bitleri,
 * doğru EKU OID'i ve doğru critical bayrağı otomatik uygulanır. İstenirse
 * profil üzerindeki her alan ayrı ayrı override edilebilir.
 */
const { KU, OIDs } = require('./oid');

const PROFILES = {
  /** TLS sunucu sertifikası (varsayılan davranışla aynı). */
  'tls-server': {
    keyUsage: [KU.digitalSignature, KU.keyEncipherment],
    keyUsageCritical: true,
    eku: [OIDs.serverAuth],
    ekuCritical: false,
  },
  /** TLS istemci sertifikası (mTLS). */
  'tls-client': {
    keyUsage: [KU.digitalSignature, KU.keyEncipherment],
    keyUsageCritical: true,
    eku: [OIDs.clientAuth],
    ekuCritical: false,
  },
  /** Hem sunucu hem istemci (bu kütüphanenin eski varsayılanı). */
  'tls-both': {
    keyUsage: [KU.digitalSignature, KU.keyEncipherment],
    keyUsageCritical: true,
    eku: [OIDs.serverAuth, OIDs.clientAuth],
    ekuCritical: false,
  },
  /**
   * Zaman Damgası Otoritesi (RFC 3161).
   * DİKKAT: RFC 3161 §2.3, EKU'nun yalnızca id-kp-timeStamping içermesini
   * ve **critical** olarak işaretlenmesini ZORUNLU kılar.
   */
  'tsa': {
    keyUsage: [KU.digitalSignature, KU.nonRepudiation],
    keyUsageCritical: true,
    eku: [OIDs.timeStamping],
    ekuCritical: true,
  },
  /**
   * OCSP Responder (RFC 6960 §4.2.2.2) — delege edilmiş yanıtlayıcı.
   * `ocspNoCheck` uzantısı, yanıtlayıcının kendi sertifikasının iptal
   * kontrolünden muaf tutulmasını sağlar.
   */
  'ocsp-responder': {
    keyUsage: [KU.digitalSignature],
    keyUsageCritical: true,
    eku: [OIDs.ocspSigning],
    ekuCritical: false,
    ocspNoCheck: true,
  },
  /** Kod imzalama. */
  'code-signing': {
    keyUsage: [KU.digitalSignature],
    keyUsageCritical: true,
    eku: [OIDs.codeSigning],
    ekuCritical: false,
  },
  /** S/MIME e-posta koruması (imzalama + şifreleme). */
  'email': {
    keyUsage: [KU.digitalSignature, KU.keyEncipherment, KU.dataEncipherment],
    keyUsageCritical: true,
    eku: [OIDs.emailProtection],
    ekuCritical: false,
  },
  /**
   * Salt şifreleme anahtarı (anahtar sarmalama / veri şifreleme).
   * İmzalama biti YOKTUR — anahtar yalnızca şifreleme için kullanılabilir.
   */
  'encryption': {
    keyUsage: [KU.keyEncipherment, KU.dataEncipherment],
    keyUsageCritical: true,
    eku: [],
    ekuCritical: false,
  },
  /** Ara/alt CA sertifikası. */
  'ca': {
    keyUsage: [KU.keyCertSign, KU.cRLSign, KU.digitalSignature],
    keyUsageCritical: true,
    eku: [],
    ekuCritical: false,
    isCA: true,
  },
};

/**
 * Bir profil adını (veya doğrudan bir profil nesnesini) çözer ve kullanıcı
 * seçenekleriyle birleştirir. Kullanıcının açıkça verdiği alanlar HER ZAMAN
 * profili ezer.
 * @param {string|object|undefined} profile
 * @param {object} [opts]  Çağıranın verdiği seçenekler (öncelikli)
 * @returns {object} birleştirilmiş seçenekler
 */
function applyProfile(profile, opts = {}) {
  if (!profile) return { ...opts };
  const base = (typeof profile === 'string') ? PROFILES[profile] : profile;
  if (!base) {
    throw new Error(
      `Bilinmeyen profil '${profile}'. Kullanılabilir: ${Object.keys(PROFILES).join(', ')}`,
    );
  }
  const merged = { ...base, ...opts };
  // `profile` anahtarını aşağı akışa taşımaya gerek yok
  delete merged.profile;
  return merged;
}

/** Kullanılabilir profil adlarını listeler. */
function listProfiles() {
  return Object.keys(PROFILES);
}

module.exports = { PROFILES, applyProfile, listProfiles };
