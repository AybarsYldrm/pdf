'use strict';

const crypto = require('node:crypto');
const ct = require('./src/ct');
const ssl = require('./index.js');

// RFC 6962 — Certificate Transparency.
//
// Merkle ağacı, RFC 6962'nin referans uygulamasının test vektörlerine karşı
// doğrulanıyor. Bu şart: ağaç kendi içinde tutarlı ama BAŞKA bir kök üreten bir
// uygulama, tek başına çalışıyor görünür ve hiçbir CT istemcisi/izleyicisiyle
// uyuşmaz. Özellikle iki ayrıntı sessizce yanlış yapılabilir:
//
//   - yaprak (0x00) ve iç düğüm (0x01) önekleri: ayrılmazsa bir iç düğüm
//     yaprak gibi sunulup ağaçta olmayan bir kayıt "kanıtlanabilir";
//   - dengesiz bölme: RFC ağacı ikiye BÖLMEZ, n'den küçük en büyük 2'nin
//     kuvvetinden böler. "İkiye böl" farklı bir kök verir.

let checks = 0;
function check(name, condition) {
  checks += 1;
  if (!condition) throw new Error(`check failed: ${name}`);
  console.log(`  ok ${name}`);
}

// RFC 6962 referans uygulamasının test girdileri.
const TEST_INPUTS = [
  '', '00', '10', '2021', '3031', '40414243', '5051525354555657',
  '606162636465666768696a6b6c6d6e6f',
].map((h) => Buffer.from(h, 'hex'));

// Boyut 0..8 için beklenen kök hash'ler.
const EXPECTED_ROOTS = [
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
  'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
  'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
  'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
  '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
  '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
  'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
  '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
];

async function main() {
  console.log('\n[1] Merkle ağacı RFC 6962 test vektörleriyle uyuşuyor');
  for (let size = 0; size <= 8; size++) {
    const leaves = TEST_INPUTS.slice(0, size).map((b) => ct.leafHash(b));
    const root = ct.merkleRoot(leaves).toString('hex');
    check(`boyut ${size} kök hash'i doğru`, root === EXPECTED_ROOTS[size]);
  }

  console.log('\n[2] Kapsama kanıtları (inclusion proof) doğrulanıyor');
  const leaves8 = TEST_INPUTS.map((b) => ct.leafHash(b));
  const root8 = ct.merkleRoot(leaves8);
  for (let i = 0; i < 8; i++) {
    const proof = ct.inclusionProof(leaves8, i);
    const ok = ct.verifyInclusionProof({
      leaf: leaves8[i], index: i, treeSize: 8, proof, rootHash: root8,
    });
    check(`yaprak ${i} için kanıt geçerli`, ok);
  }

  console.log('\n[3] Sahte kanıtlar reddediliyor');
  const proof0 = ct.inclusionProof(leaves8, 0);
  check('yanlış yaprak reddedilir', !ct.verifyInclusionProof({
    leaf: leaves8[1], index: 0, treeSize: 8, proof: proof0, rootHash: root8,
  }));
  check('yanlış indeks reddedilir', !ct.verifyInclusionProof({
    leaf: leaves8[0], index: 3, treeSize: 8, proof: proof0, rootHash: root8,
  }));
  const tampered = proof0.slice();
  tampered[0] = crypto.randomBytes(32);
  check('kurcalanmış yol reddedilir', !ct.verifyInclusionProof({
    leaf: leaves8[0], index: 0, treeSize: 8, proof: tampered, rootHash: root8,
  }));

  console.log('\n[4] Yaprak ve iç düğüm önekleri ayrı');
  // Ayrılmasaydı bir iç düğümün hash'i bir yaprak gibi sunulabilirdi.
  const a = ct.leafHash(Buffer.from('aa', 'hex'));
  const b = ct.leafHash(Buffer.from('bb', 'hex'));
  const internal = ct.nodeHash(a, b);
  const asLeaf = ct.leafHash(Buffer.concat([a, b]));
  check('iç düğüm hash\'i yaprak hash\'inden farklı', !internal.equals(asLeaf));

  console.log('\n[5] Log: SCT üretimi ve imza doğrulaması');
  const logKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const logPrivPem = logKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const logPubPem = logKeys.publicKey.export({ type: 'spki', format: 'pem' });

  const log = new ct.CertificateTransparencyLog({
    privateKeyPem: logPrivPem, publicKeyPem: logPubPem,
    storage: ct.createMemoryLogStorage(),
  });

  check('logId, açık anahtarın SHA-256\'sı', log.logId.length === 32);

  const ca = ssl.CertificateAuthority.create({ useIntermediate: true, organization: 'FITFAK', country: 'TR' });
  const key = ssl.generateEcKeyPair('P-256');
  const csr = ssl.generateCSR(
    { keyType: 'ec', curveName: key.curve, ...key },
    [[ssl.oid.OIDs.commonName, 'ct-test.fitfak.net']], [],
  );
  const issued = ssl.issueCertificateFromCSR(csr, ca.issuer || ca, { validityDays: 90 });
  const certDer = issued.der;

  const sct = await log.add({ certDer });
  check('SCT üretildi', Buffer.isBuffer(sct) && sct.length > 40);
  check('SCT sürümü v1', sct[0] === 0);
  check('SCT logId taşıyor', sct.subarray(1, 33).equals(log.logId));

  // İmzayı bağımsız olarak doğrula: SCT'nin imzaladığı yapıyı yeniden kurup
  // log'un açık anahtarıyla kontrol ediyoruz -- gerçek bir doğrulayıcı da
  // aynısını yapar.
  const timestamp = Number(sct.readBigUInt64BE(33));
  const signedData = ct.serializeSignedData({
    timestamp, entryType: ct.LOG_ENTRY_TYPE.X509, entry: { certDer },
  });
  const sigLen = sct.readUInt16BE(33 + 8 + 2 + 2);
  const signature = sct.subarray(33 + 8 + 2 + 2 + 2, 33 + 8 + 2 + 2 + 2 + sigLen);
  check('SCT imzası log anahtarıyla doğrulanıyor',
    crypto.verify('sha256', signedData, logKeys.publicKey, signature));

  console.log('\n[6] Aynı sertifika tekrar eklenirse AYNI SCT dönüyor');
  const sct2 = await log.add({ certDer });
  check('SCT değişmedi', sct.equals(sct2));
  const sth1 = await log.signedTreeHead();
  check('ağaç boyutu 1 (mükerrer kayıt açılmadı)', sth1.tree_size === 1);

  console.log('\n[7] STH ve kapsama kanıtı log üzerinden');
  for (let i = 0; i < 4; i++) {
    const k = ssl.generateEcKeyPair('P-256');
    const c = ssl.generateCSR({ keyType: 'ec', curveName: k.curve, ...k },
      [[ssl.oid.OIDs.commonName, `host${i}.fitfak.net`]], []);
    await log.add({ certDer: ssl.issueCertificateFromCSR(c, ca.issuer || ca, {}).der });
  }
  const sth = await log.signedTreeHead();
  check('ağaç 5 girdiye ulaştı', sth.tree_size === 5);
  check('STH imzası var', !!sth.tree_head_signature);

  const entries = await log.storage.all();
  const proof = await log.proofByHash(entries[2].leafHash.toString('base64'));
  check('kanıt bulundu', proof && proof.leaf_index === 2);
  check('kanıt doğrulanıyor', ct.verifyInclusionProof({
    leaf: entries[2].leafHash,
    index: 2,
    treeSize: 5,
    proof: proof.audit_path.map((p) => Buffer.from(p, 'base64')),
    rootHash: Buffer.from(sth.sha256_root_hash, 'base64'),
  }));

  console.log('\n[8] Sertifikaya gömülen uzantılar');
  const poison = ct.buildPoisonExtension();
  check('poison uzantısı kritik', poison.includes(Buffer.from([0x01, 0x01, 0xff])));
  const sctExt = ct.buildSctListExtension([sct]);
  check('SCT listesi uzantısı üretildi', Buffer.isBuffer(sctExt) && sctExt.length > sct.length);

  console.log(`\nOK - Certificate Transparency: ${checks} kontrol geçti.`);
}

main().then(() => process.exit(0), (err) => { console.error('\nFAILED:', err); process.exit(1); });
