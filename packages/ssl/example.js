'use strict';
/**
 * KULLANIM ÖRNEKLERİ — node example.js
 *
 * Bu dosya, kolaylaştırılmış API'yi uçtan uca gösterir:
 *   1) FITFAK kurumsal OID'leri (IANA PEN 65133) — noktalı-ondalık, elle hex YOK
 *   2) TSA sertifikası — `profile:'tsa'` ile critical EKU otomatik
 *   3) Certificate Policies — CPS URL + User Notice
 *   4) OCSP / CRL adresleri — AÇIKÇA verilir, sabit yol eki YOK
 *   5) Şifreleme anahtarları — RSA-OAEP ve ECDH, `node:crypto` ile ÇAPRAZ DOĞRULAMA
 */
const crypto = require('node:crypto');
const lib = require('./index.js');

const line = (t) => console.log('\n' + '─'.repeat(72) + '\n' + t + '\n' + '─'.repeat(72));

// ─────────────────────────────────────────────────────────────────────────────
line('1) KURUMSAL OID — IANA PEN 65133 (elle hex hesaplamak GEREKMİYOR)');
// ─────────────────────────────────────────────────────────────────────────────
const FITFAK = {
  base:      '1.3.6.1.4.1.65133',
  tsaPolicy: '1.3.6.1.4.1.65133.1.1',
  tlsPolicy: '1.3.6.1.4.1.65133.1.2',
};
console.log('  Noktalı-ondalık :', FITFAK.tsaPolicy);
console.log('  DER hex (otomatik):', lib.encodeOid(FITFAK.tsaPolicy));
console.log('  Geri çözüldü      :', lib.decodeOid(lib.encodeOid(FITFAK.tsaPolicy)));
console.log('  ✓ Eskiden elle yazmanız gereken: \'2b 06 01 04 01 83 fc 6d 01 01\'');

// ─────────────────────────────────────────────────────────────────────────────
line('2) KÖK + ARA CA — OCSP/CRL adresleri AÇIKÇA veriliyor');
// ─────────────────────────────────────────────────────────────────────────────
const root = lib.generateRootCA({
  organization: 'FITFAK', country: 'TR', commonName: 'FITFAK Root CA R1',
  bits: 2048, validityDays: 3650,
});

const inter = lib.generateIntermediateCA(root, {
  organization: 'FITFAK', commonName: 'FITFAK Issuing CA R1',
  // ── Sabit yol eki YOK — tam adresi siz belirliyorsunuz ──
  ocspUrl:      'http://ocsp.fitfak.com',
  caIssuersUrl: 'http://pki.fitfak.com/root.crt',
  crlUrls:      ['http://crl.fitfak.com/root.crl'],
  policies:     [{ oid: FITFAK.base, cps: 'https://fitfak.com/cps' }],
});
console.log('  ✓ Kök CA ve Ara CA üretildi');

// ─────────────────────────────────────────────────────────────────────────────
line('3) TSA SERTİFİKASI — CSR\'den, profile ile (critical EKU OTOMATİK)');
// ─────────────────────────────────────────────────────────────────────────────
const tsaKey = lib.generateRsaKeyPair(2048);
const tsaCsr = lib.generateCSR(
  { keyType: 'rsa', ...tsaKey },
  [[lib.oid.OIDs.country, 'TR'],
   [lib.oid.OIDs.orgName, 'FITFAK'],
   [lib.oid.OIDs.commonName, 'tsa.fitfak.com']],
  [{ type: 'dns', value: 'tsa.fitfak.com' }],
);
console.log('  CSR öz-imzası geçerli mi? →', lib.verifyCSR(tsaCsr));

const tsaCert = lib.issueCertificateFromCSR(tsaCsr, inter, {
  profile: 'tsa',                       // ← KeyUsage + EKU + critical hepsi hazır
  policies: [{
    oid: FITFAK.tsaPolicy,
    cps: 'https://fitfak.com/cps',
    notice: { organization: 'FITFAK', noticeNumbers: [1], text: 'FITFAK Zaman Damgası Politikası' },
  }],
  ocspUrl:      'http://ocsp.fitfak.com',
  caIssuersUrl: 'http://pki.fitfak.com/issuing.crt',
  crlUrls:      ['http://crl.fitfak.com/issuing.crl'],
  validityDays: 825,
});
console.log(tsaCert.pem);

// node:crypto ile doğrula
const tsaX509 = new crypto.X509Certificate(tsaCert.pem);
console.log('  [node:crypto] Subject     :', tsaX509.subject.replace(/\n/g, ', '));
console.log('  [node:crypto] Issuer      :', tsaX509.issuer.replace(/\n/g, ', '));
console.log('  [node:crypto] Geçerlilik  :', tsaX509.validFrom, '→', tsaX509.validTo);
console.log('  [node:crypto] İmza doğru? :', tsaX509.verify(new crypto.X509Certificate(inter.certPem).publicKey));
console.log('  [zincir]      Tam zincir  :', lib.verifyChain(tsaCert.pem, [inter.certPem], [root.certPem]).ok);

// ─────────────────────────────────────────────────────────────────────────────
line('4) ŞİFRELEME ANAHTARLARI — profile:\'encryption\' + RSA-OAEP');
// ─────────────────────────────────────────────────────────────────────────────
const encKey = lib.generateRsaKeyPair(2048);
const encCsr = lib.generateCSR(
  { keyType: 'rsa', ...encKey },
  [[lib.oid.OIDs.country, 'TR'],
   [lib.oid.OIDs.orgName, 'FITFAK'],
   [lib.oid.OIDs.commonName, 'crypt.fitfak.com']],
  [{ type: 'dns', value: 'crypt.fitfak.com' }],
);
const encCert = lib.issueCertificateFromCSR(encCsr, inter, {
  profile: 'encryption',                       // keyEncipherment + dataEncipherment, imza biti YOK
  policies: FITFAK.tlsPolicy,                  // tek OID: kısa biçim de kabul edilir
  ocspUrl: 'http://ocsp.fitfak.com',
  crlUrls: ['http://crl.fitfak.com/issuing.crl'],
});
console.log(encCert.pem);

// ── Bu kütüphaneyle ŞİFRELE → node:crypto ile ÇÖZ ──
const mesaj = Buffer.from('FITFAK gizli mesaj — RSA-OAEP testi', 'utf8');
const sifreli = lib.rsaOaepEncrypt({ n: encKey.n, e: encKey.e }, mesaj);
console.log('  Şifreli (ilk 32 bayt):', sifreli.subarray(0, 32).toString('hex'), '...');

const cryptoPrivKey = crypto.createPrivateKey(lib.rsaPrivToPem(encKey));
const cozuldu = crypto.privateDecrypt(
  { key: cryptoPrivKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
  sifreli,
);
console.log('  [node:crypto] Çözülen    :', cozuldu.toString('utf8'));
console.log('  ✓ Çapraz doğrulama       :', cozuldu.equals(mesaj));

// ── Tersi: node:crypto ile ŞİFRELE → bu kütüphaneyle ÇÖZ ──
const certPubKey = new crypto.X509Certificate(encCert.pem).publicKey;
const sifreli2 = crypto.publicEncrypt(
  { key: certPubKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
  mesaj,
);
const cozuldu2 = lib.rsaOaepDecrypt(encKey, sifreli2);
console.log('  ✓ Ters yön doğrulama     :', cozuldu2.equals(mesaj), `("${cozuldu2.toString('utf8')}")`);

// ─────────────────────────────────────────────────────────────────────────────
line('5) EC ANAHTAR DEĞİŞİMİ (ECDH) — node:crypto ile çapraz doğrulama');
// ─────────────────────────────────────────────────────────────────────────────
const alice = lib.generateEcKeyPair('P-256');
const bob   = lib.generateEcKeyPair('P-256');
const ortakA = lib.ecdhCompute('P-256', alice.privateKey, bob.publicKey);
const ortakB = lib.ecdhCompute('P-256', bob.privateKey, alice.publicKey);
console.log('  Alice ↔ Bob ortak sır eşleşiyor?:', ortakA.equals(ortakB));
console.log('  Ortak sır (hex):', ortakA.toString('hex'));

// node:crypto ile aynı sırrı üret
const aliceCryptoPriv = crypto.createPrivateKey(lib.ecPrivToPem(alice));
const bobCryptoPub    = crypto.createPublicKey(lib.ecPrivToPem(bob));
const ortakCrypto = crypto.diffieHellman({ privateKey: aliceCryptoPriv, publicKey: bobCryptoPub });
console.log('  ✓ [node:crypto] aynı sır :', ortakCrypto.equals(ortakA));

// Ortak sırdan AES anahtarı türet ve şifrele
const aesKey = lib.hkdf('sha256', ortakA, Buffer.from('fitfak-salt'), Buffer.from('aes-key'), 32);
const iv = lib.randomBytes(12);
const { ciphertext, tag } = lib.gcmEncrypt(aesKey, iv, Buffer.from('ECDH ile korunan veri'));
const acik = lib.gcmDecrypt(aesKey, iv, ciphertext, Buffer.alloc(0), tag);
console.log('  ✓ HKDF+AES-GCM roundtrip :', acik.toString('utf8'));

// ─────────────────────────────────────────────────────────────────────────────
line('6) OCSP / CRL — adreslerin sertifikadan OKUNMASI ve sunucu kurulumu');
// ─────────────────────────────────────────────────────────────────────────────
const bilgi = lib.inspectCert(tsaCert.pem);
console.log('  Seri numarası :', bilgi.serialNumber);
console.log('  SHA-256 parmak izi:', bilgi.fingerprint256);
console.log('  KeyUsage      :', Object.entries(bilgi.keyUsage).filter(([, v]) => v).map(([k]) => k).join(', '));

const http = require('node:http');
const ca = lib.CertificateAuthority.create({
  useIntermediate: true,
  organization: 'FITFAK',
  ocspUrl: 'http://ocsp.fitfak.com',
  crlUrls: ['http://crl.fitfak.com/issuing.crl'],
});
const leaf = ca.issueLeaf('web.fitfak.com', { profile: 'tls-both' });
const leafSerial = lib.certInfoFromPem(leaf.certPem).serialNumber;
ca.revoke(leafSerial, lib.oid.REASON.superseded);

const sunucu = http.createServer((req, res) =>
  req.url.startsWith('/crl') ? ca.crlHandler()(req, res) : ca.ocspHandler()(req, res));

sunucu.listen(0, async () => {
  const port = sunucu.address().port;
  const { der } = lib.buildOcspRequest(ca.issuer, leafSerial, { nonce: true });
  const yanit = await lib.sendOcspRequest(`http://127.0.0.1:${port}/`, der);
  console.log('  OCSP yanıt imzası geçerli :', lib.verifyOcspResponse(yanit, ca.issuer).ok);
  const crl = await lib.fetchCrl(`http://127.0.0.1:${port}/crl`);
  console.log('  CRL indirildi             :', crl.length, 'bayt');
  console.log('  Kayıt defteri             :', ca.list().map(x => `${x.hostname}=${x.status}`).join(', '));
  sunucu.close();
  console.log('\n✅ Tüm örnekler tamamlandı.\n');
});
