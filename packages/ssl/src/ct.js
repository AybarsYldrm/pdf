'use strict';

/**
 * RFC 6962 — Certificate Transparency.
 *
 * CT'nin çözdüğü problem şu: bir CA'nın YANLIŞ sertifika vermediğini kimse
 * dışarıdan doğrulayamaz. Sertifika zinciri "bu CA bunu imzaladı" der, ama
 * "bu CA başka kime ne verdi" sorusuna cevap vermez. Bir CA ele geçirilir ya
 * da hata yaparsa, kurbanın adına verilmiş sertifika ancak biri onu görürse
 * fark edilir.
 *
 * CT, her verilen sertifikayı EKLENEN-ONLY (append-only) bir log'a yazar ve
 * log, yazdığına dair imzalı bir makbuz (SCT) döner. Sertifikanın içine gömülen
 * bu makbuz, doğrulayıcıya "bu sertifika halka açık bir log'a yazıldı" der --
 * yani alan adı sahibi log'u izleyerek kendi adına verilmiş sertifikaları
 * görebilir. Güvenlik, log'un dürüstlüğünden değil, Merkle ağacının geçmişi
 * değiştirmeyi KANITLANABİLİR kılmasından gelir.
 *
 * Bu dosya log tarafını ve sertifikaya gömülen yapıları üretir.
 *
 * ── Zincirleme sorunu ve önsertifika (precertificate) ─────────────────────
 * SCT sertifikanın İÇİNE yazılır, ama SCT'yi almak için sertifikayı log'a
 * göndermek gerekir -- yani sertifika SCT'den önce var olmalı ve SCT
 * sertifikadan önce var olmalı. RFC 6962 bunu ÖNSERTİFİKA ile çözer: CA,
 * gerçek sertifikanın aynısını "poison" uzantısıyla (kritik, hiçbir istemcinin
 * kabul etmeyeceği) imzalar, log onu kabul edip SCT döner, sonra CA aynı TBS'i
 * poison yerine SCT listesiyle imzalar. İki sertifika aynı seri numarasını ve
 * aynı içeriği taşır; log, önsertifikayı gördüğü için gerçek sertifikanın ne
 * olacağını da bilir.
 */

const crypto = require('node:crypto');
const { SEQ, OCT, OID, ext, readTLV, readChildren } = require('./asn1');

// Google'ın CT için ayırdığı arc. Bu OID'ler RFC 6962'de sabittir.
const CT_OIDS = {
  // SignedCertificateTimestampList -- sertifikaya gömülen SCT'ler
  sctList: '1.3.6.1.4.1.11129.2.4.2',
  // Precertificate Poison -- KRİTİK ve içeriği NULL. Kritik olduğu ve hiçbir
  // istemci tanımadığı için önsertifika hiçbir yerde geçerli sayılmaz; tek
  // işlevi log'a "bu, gerçek sertifikanın taslağıdır" demek.
  poison: '1.3.6.1.4.1.11129.2.4.3',
  // OCSP yanıtına iliştirilen SCT'ler (bu uygulamada kullanılmıyor)
  ocspSctList: '1.3.6.1.4.1.11129.2.4.5',
};

const LOG_ENTRY_TYPE = { X509: 0, PRECERT: 1 };
const SIGNATURE_TYPE = { CERTIFICATE_TIMESTAMP: 0, TREE_HASH: 1 };
const SCT_VERSION_V1 = 0;
const HASH_ALG_SHA256 = 4;      // RFC 5246 HashAlgorithm.sha256
const SIG_ALG_ECDSA = 3;        // RFC 5246 SignatureAlgorithm.ecdsa
const SIG_ALG_RSA = 1;

// ─────────────────────────────────────────────────────────────────────────────
// TLS kodlama yardımcıları (RFC 5246 §4) — CT, ASN.1 değil TLS serileştirmesi
// kullanır. Uzunluk önekleri sabit baytlıdır ve büyük-endian'dır.
// ─────────────────────────────────────────────────────────────────────────────
function u8(n) { return Buffer.from([n & 0xff]); }
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function u24(n) { const b = Buffer.alloc(3); b.writeUIntBE(n, 0, 3); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; }

/** Değişken uzunluklu vektör: uzunluk öneki + içerik. */
function vector(buf, lengthBytes) {
  const len = lengthBytes === 1 ? u8(buf.length)
    : lengthBytes === 2 ? u16(buf.length) : u24(buf.length);
  return Buffer.concat([len, buf]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Merkle Hash Tree (RFC 6962 §2.1)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Yaprak ve iç düğüm hash'leri FARKLI öneklerle hesaplanır (0x00 / 0x01).
 * Bu ayrım olmadan, bir iç düğümün hash'i bir yaprak gibi sunulabilir ve
 * saldırgan ağaçta olmayan bir kaydın var olduğunu "kanıtlayabilir"
 * (ikinci-önimaj saldırısı). Tek baytlık bu önek, tüm yapının güvenliğini
 * taşıyan detaydır.
 */
function leafHash(leafBytes) {
  return crypto.createHash('sha256').update(Buffer.concat([u8(0x00), leafBytes])).digest();
}

function nodeHash(left, right) {
  return crypto.createHash('sha256').update(Buffer.concat([u8(0x01), left, right])).digest();
}

/** Boş ağacın kök hash'i, boş dizenin SHA-256'sıdır (RFC 6962 §2.1). */
function emptyRootHash() {
  return crypto.createHash('sha256').update(Buffer.alloc(0)).digest();
}

/**
 * Yaprak hash listesinden Merkle kök hash'i.
 *
 * RFC 6962 ağacı TAM DENGELİ DEĞİLDİR: n yaprak için sol alt ağaç, n'den küçük
 * en büyük 2'nin kuvvetidir. Bunu "ikiye böl" diye yapmak farklı bir kök üretir
 * ve başka hiçbir CT uygulamasıyla uyuşmaz.
 */
function merkleRoot(leaves) {
  if (leaves.length === 0) return emptyRootHash();
  if (leaves.length === 1) return leaves[0];
  const k = largestPowerOfTwoBelow(leaves.length);
  return nodeHash(merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

function largestPowerOfTwoBelow(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** Bir yaprağın ağaçta olduğunun kanıtı (audit path). */
function inclusionProof(leaves, index) {
  if (index < 0 || index >= leaves.length) throw new Error('ct: index out of range');
  if (leaves.length === 1) return [];
  const k = largestPowerOfTwoBelow(leaves.length);
  if (index < k) {
    return [...inclusionProof(leaves.slice(0, k), index), merkleRoot(leaves.slice(k))];
  }
  return [...inclusionProof(leaves.slice(k), index - k), merkleRoot(leaves.slice(0, k))];
}

/** Kanıtı doğrular -- izleyicinin (monitor) yaptığı iş. */
function verifyInclusionProof({ leaf, index, treeSize, proof, rootHash }) {
  if (index >= treeSize) return false;
  let hash = leaf;
  let fn = index;
  let sn = treeSize - 1;
  let i = 0;
  while (sn > 0) {
    if (i >= proof.length) return false;
    if (fn % 2 === 1 || fn === sn) {
      hash = nodeHash(proof[i], hash);
      i += 1;
      while (fn % 2 === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
    } else {
      hash = nodeHash(hash, proof[i]);
      i += 1;
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return i === proof.length && hash.equals(rootHash);
}

// ─────────────────────────────────────────────────────────────────────────────
// Log girdisi ve imzalanan yapılar
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Önsertifikadan `PreCert` yapısı: yayıncının açık anahtar hash'i ve poison
 * uzantısı ÇIKARILMIŞ TBS.
 *
 * Poison'ın çıkarılması şart: log'a giren şey, GERÇEK sertifikanın ne olacağını
 * temsil etmeli. Poison kalsaydı log'daki kayıt hiçbir zaman yayınlanacak
 * sertifikayla eşleşmezdi ve izleyiciler ikisini ilişkilendiremezdi.
 */
function buildPrecertEntry({ precertDer, issuerSpkiDer }) {
  const issuerKeyHash = crypto.createHash('sha256').update(issuerSpkiDer).digest();
  const tbs = extractTbsWithoutPoison(precertDer);
  return { issuerKeyHash, tbsCertificate: tbs };
}

/** Sertifikadan TBSCertificate'i çıkarır ve poison uzantısını siler. */
function extractTbsWithoutPoison(certDer) {
  const cert = readTLV(certDer, 0);
  const tbsNode = readTLV(cert.content, 0);
  const tbsFull = cert.content.subarray(
    tbsNode.contentOff - tbsNode.headerLen,
    tbsNode.contentOff - tbsNode.headerLen + tbsNode.totalLen,
  );

  const poisonDer = OID(CT_OIDS.poison);
  const children = readChildren(tbsNode.content);
  // extensions [3] EXPLICIT
  const extsCtx = children.find((n) => n.tag === 0xa3);
  if (!extsCtx) return tbsFull;

  const extsSeq = readTLV(extsCtx.content, 0);
  const kept = [];
  for (const extNode of readChildren(extsSeq.content)) {
    const oidNode = readChildren(extNode.content)[0];
    const oidTlv = extNode.content.subarray(
      oidNode.contentOff - oidNode.headerLen,
      oidNode.contentOff - oidNode.headerLen + oidNode.totalLen,
    );
    if (oidTlv.equals(poisonDer)) continue; // poison düşür
    kept.push(extNode.content.length !== undefined
      ? extsSeq.content.subarray(
        extNode.contentOff - extNode.headerLen,
        extNode.contentOff - extNode.headerLen + extNode.totalLen,
      )
      : Buffer.alloc(0));
  }

  // TBS'i yeni uzantı listesiyle yeniden kur.
  const before = tbsNode.content.subarray(0, extsCtx.contentOff - extsCtx.headerLen);
  const after = tbsNode.content.subarray(extsCtx.contentOff - extsCtx.headerLen + extsCtx.totalLen);
  const newExts = SEQ(Buffer.concat(kept));
  const newCtx = Buffer.concat([Buffer.from([0xa3]), encodeLength(newExts.length), newExts]);
  const newTbsContent = Buffer.concat([before, newCtx, after]);
  return Buffer.concat([Buffer.from([0x30]), encodeLength(newTbsContent.length), newTbsContent]);
}

function encodeLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let x = n;
  while (x > 0) { bytes.unshift(x & 0xff); x >>>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/**
 * İmzalanan yapı (RFC 6962 §3.2). SCT imzası TAM OLARAK bunun üzerine atılır;
 * doğrulayıcı da aynısını yeniden kurup imzayı kontrol eder.
 */
function serializeSignedData({ timestamp, entryType, entry, extensions = Buffer.alloc(0) }) {
  const parts = [
    u8(SCT_VERSION_V1),
    u8(SIGNATURE_TYPE.CERTIFICATE_TIMESTAMP),
    u64(timestamp),
    u16(entryType),
  ];
  if (entryType === LOG_ENTRY_TYPE.X509) {
    parts.push(vector(entry.certDer, 3));
  } else {
    parts.push(entry.issuerKeyHash);
    parts.push(vector(entry.tbsCertificate, 3));
  }
  parts.push(vector(extensions, 2));
  return Buffer.concat(parts);
}

/** MerkleTreeLeaf (RFC 6962 §3.4) — ağaca giren baytlar. */
function serializeMerkleTreeLeaf({ timestamp, entryType, entry, extensions = Buffer.alloc(0) }) {
  const parts = [
    u8(SCT_VERSION_V1),
    u8(0), // MerkleLeafType.timestamped_entry
    u64(timestamp),
    u16(entryType),
  ];
  if (entryType === LOG_ENTRY_TYPE.X509) {
    parts.push(vector(entry.certDer, 3));
  } else {
    parts.push(entry.issuerKeyHash);
    parts.push(vector(entry.tbsCertificate, 3));
  }
  parts.push(vector(extensions, 2));
  return Buffer.concat(parts);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCT
// ─────────────────────────────────────────────────────────────────────────────
/** SCT'nin telde/sertifikada taşınan biçimi (RFC 6962 §3.2). */
function serializeSct({ logId, timestamp, extensions = Buffer.alloc(0), signature, sigAlg }) {
  return Buffer.concat([
    u8(SCT_VERSION_V1),
    logId,                       // 32 bayt, log açık anahtarının SHA-256'sı
    u64(timestamp),
    vector(extensions, 2),
    u8(HASH_ALG_SHA256),
    u8(sigAlg),
    vector(signature, 2),
  ]);
}

/**
 * Sertifikaya gömülen uzantı: OCTET STRING içinde, SCT'lerin TLS listesi.
 *
 * İki katmanlı sarma dikkat ister: X.509 uzantı değeri bir OCTET STRING'dir ve
 * ONUN içeriği yine bir OCTET STRING olarak kodlanmış SCT listesidir.
 */
function buildSctListExtension(sctBuffers) {
  const list = Buffer.concat(sctBuffers.map((s) => vector(s, 2)));
  const sctList = vector(list, 2);
  return ext(CT_OIDS.sctList, false, OCT(sctList));
}

/** Önsertifika poison uzantısı: KRİTİK, değeri NULL. */
function buildPoisonExtension() {
  return ext(CT_OIDS.poison, true, Buffer.from([0x05, 0x00]));
}

// ─────────────────────────────────────────────────────────────────────────────
// Log
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Ekleme-yalnızca (append-only) CT log'u.
 *
 * `storage` arayüzü: { append(entry), all(), size() } -- kalıcılık çağırana ait.
 * Bellekte tutan bir uygulama testler için yeterli; üretimde şifreli veritabanı.
 */
class CertificateTransparencyLog {
  /**
   * @param {object} opts
   * @param {string} opts.privateKeyPem  log imzalama anahtarı
   * @param {string} opts.publicKeyPem   log açık anahtarı (logId bundan türer)
   * @param {object} opts.storage
   */
  constructor({ privateKeyPem, publicKeyPem, storage, now = () => Date.now() }) {
    this.privateKey = crypto.createPrivateKey(privateKeyPem);
    this.publicKey = crypto.createPublicKey(publicKeyPem);
    this.storage = storage;
    this.now = now;

    // logId = SPKI'nin SHA-256'sı. Doğrulayıcı, SCT'deki logId ile bilinen
    // log anahtarlarını eşleştirir.
    const spki = this.publicKey.export({ type: 'spki', format: 'der' });
    this.logId = crypto.createHash('sha256').update(spki).digest();
    this.sigAlg = this.publicKey.asymmetricKeyType === 'ec' ? SIG_ALG_ECDSA : SIG_ALG_RSA;
  }

  _sign(data) {
    return crypto.sign('sha256', data, this.privateKey);
  }

  /**
   * Bir sertifika ya da önsertifika ekler ve SCT döner.
   *
   * Aynı girdi ikinci kez gelirse ESKİ SCT döner, yeni bir kayıt açılmaz.
   * RFC 6962 §3 bunu şart koşar: aksi halde log, aynı sertifikayı defalarca
   * ekleyerek şişer ve ağaç boyutu anlamını yitirir.
   */
  async add({ certDer, issuerSpkiDer = null, precert = false }) {
    const entryType = precert ? LOG_ENTRY_TYPE.PRECERT : LOG_ENTRY_TYPE.X509;
    const entry = precert
      ? buildPrecertEntry({ precertDer: certDer, issuerSpkiDer })
      : { certDer };

    const dedupeKey = crypto.createHash('sha256')
      .update(u8(entryType))
      .update(precert ? entry.tbsCertificate : entry.certDer)
      .digest('hex');

    const existing = await this.storage.findByKey(dedupeKey);
    if (existing) return existing.sct;

    const timestamp = this.now();
    const signature = this._sign(serializeSignedData({ timestamp, entryType, entry }));
    const sctBytes = serializeSct({
      logId: this.logId, timestamp, signature, sigAlg: this.sigAlg,
    });

    const merkleLeaf = serializeMerkleTreeLeaf({ timestamp, entryType, entry });

    await this.storage.append({
      dedupeKey,
      timestamp,
      entryType,
      leafHash: leafHash(merkleLeaf),
      merkleLeaf,
      certDer: precert ? null : entry.certDer,
      sct: sctBytes,
    });

    return sctBytes;
  }

  /** İmzalı ağaç başı (STH) -- log'un o andaki durumunun taahhüdü. */
  async signedTreeHead() {
    const entries = await this.storage.all();
    const leaves = entries.map((e) => e.leafHash);
    const rootHash = merkleRoot(leaves);
    const timestamp = this.now();
    const treeSize = leaves.length;

    const signedData = Buffer.concat([
      u8(SCT_VERSION_V1),
      u8(SIGNATURE_TYPE.TREE_HASH),
      u64(timestamp),
      u64(treeSize),
      rootHash,
    ]);

    return {
      tree_size: treeSize,
      timestamp,
      sha256_root_hash: rootHash.toString('base64'),
      tree_head_signature: Buffer.concat([
        u8(HASH_ALG_SHA256), u8(this.sigAlg), vector(this._sign(signedData), 2),
      ]).toString('base64'),
    };
  }

  async proofByHash(hashB64) {
    const entries = await this.storage.all();
    const target = Buffer.from(hashB64, 'base64');
    const index = entries.findIndex((e) => e.leafHash.equals(target));
    if (index === -1) return null;
    return {
      leaf_index: index,
      audit_path: inclusionProof(entries.map((e) => e.leafHash), index).map((h) => h.toString('base64')),
    };
  }

  async getEntries(start, end) {
    const entries = await this.storage.all();
    return entries.slice(start, end + 1).map((e) => ({
      leaf_input: e.merkleLeaf.toString('base64'),
      extra_data: '',
    }));
  }
}

/** Bellekte tutan basit depo -- testler ve tek süreçli kullanım için. */
function createMemoryLogStorage() {
  const entries = [];
  const byKey = new Map();
  return {
    async append(entry) { entries.push(entry); byKey.set(entry.dedupeKey, entry); return entries.length - 1; },
    async findByKey(key) { return byKey.get(key) || null; },
    async all() { return entries.slice(); },
    async size() { return entries.length; },
  };
}

module.exports = {
  CT_OIDS, LOG_ENTRY_TYPE, SIGNATURE_TYPE,
  leafHash, nodeHash, merkleRoot, emptyRootHash,
  inclusionProof, verifyInclusionProof,
  serializeSct, serializeSignedData, serializeMerkleTreeLeaf,
  buildSctListExtension, buildPoisonExtension,
  buildPrecertEntry, extractTbsWithoutPoison,
  CertificateTransparencyLog, createMemoryLogStorage,
  _tls: { u8, u16, u24, u64, vector },
};
