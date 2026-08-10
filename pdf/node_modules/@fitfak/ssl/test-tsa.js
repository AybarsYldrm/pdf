'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ssl = require('./index.js');
const {
  createTimestampResponder, buildTimeStampRequest,
  parseTimeStampResponseStatus, SerialAllocator, PKI_STATUS,
} = require('./src/tsa');

// RFC 3161 zaman damgası sunucusu — openssl'e karşı uçtan uca doğrulama.
//
// Bu paketin kendi ürettiği baytları yine kendi kodunun okuyabilmesi hiçbir şey
// kanıtlamaz: iki tarafta da aynı yanlış anlaşılma olabilir. Anlamlı olan tek
// kontrol, bağımsız bir uygulamanın (openssl ts -verify) üretilen token'ı kabul
// etmesidir.

let checks = 0;
function check(name, condition) {
  checks += 1;
  if (!condition) throw new Error(`check failed: ${name}`);
  console.log(`  ok ${name}`);
}

function hasOpenssl() {
  try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); return true; }
  catch (_) { return false; }
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitfak-tsa-'));

  console.log('\n[1] TSA hiyerarşisi ve sertifikası');
  const ca = ssl.CertificateAuthority.create({
    useIntermediate: true, organization: 'FITFAK', country: 'TR',
  });
  const tsaKey = ssl.generateEcKeyPair('P-256');
  const tsaCsr = ssl.generateCSR(
    { keyType: 'ec', curveName: tsaKey.curve, ...tsaKey },
    [[ssl.oid.OIDs.country, 'TR'], [ssl.oid.OIDs.orgName, 'FITFAK'], [ssl.oid.OIDs.commonName, 'FITFAK Timestamp Authority']],
    [],
  );
  const tsaCert = ssl.issueCertificateFromCSR(tsaCsr, ca.issuer || ca, {
    profile: 'tsa',
    policies: [{ oid: '1.3.6.1.4.1.65133.1.4', cps: 'https://trust.fitfak.net/policy/timestamping' }],
    validityDays: 1095,
  });
  const leaf = new crypto.X509Certificate(tsaCert.pem);
  check('sertifikada EKU=timeStamping var', (leaf.keyUsage || []).includes('1.3.6.1.5.5.7.3.8'));

  const keyPem = ssl.ecPrivToPem({ keyType: 'ec', curveName: tsaKey.curve, ...tsaKey });
  const chainPem = `${tsaCert.pem.trim()}\n${(ca.getIntermediatePem ? ca.getIntermediatePem() : '').trim()}\n${(ca.getRootPem ? ca.getRootPem() : ca.certPem).trim()}\n`;

  console.log('\n[2] Yanlış yapılandırma açılışta yakalanır');
  // TSA olmayan bir sertifikayla kurmak, sunucuyu sessizce çalıştırıp
  // üretilen her damganın katı doğrulayıcılarda reddedilmesine yol açardı.
  const plainCert = ssl.issueCertificateFromCSR(tsaCsr, ca.issuer || ca, { profile: 'tls-client' });
  let refused = false;
  try {
    createTimestampResponder({
      keyPem, certChainPem: plainCert.pem, policyOid: '1.3.6.1.4.1.65133.1.4',
      serialFile: path.join(dir, 's1.bin'),
    });
  } catch (e) { refused = /timeStamping/.test(e.message); }
  check('EKU=timeStamping olmayan sertifika reddedilir', refused);

  const tsa = createTimestampResponder({
    keyPem, certChainPem: chainPem,
    policyOid: '1.3.6.1.4.1.65133.1.4',
    serialFile: path.join(dir, 'serial.bin'),
    accuracy: { seconds: 1 },
  });

  console.log('\n[3] Seri numaraları benzersiz ve çökmeye dayanıklı');
  const alloc = new SerialAllocator(path.join(dir, 'seq.bin'), { batchSize: 8 });
  const run = [];
  for (let i = 0; i < 20; i++) run.push(alloc.next());
  check('ardışık seriler tekrar etmiyor', new Set(run.map(String)).size === 20);
  // Çökmeyi taklit et: aynı dosyadan yeni bir ayırıcı aç.
  const afterCrash = new SerialAllocator(path.join(dir, 'seq.bin'), { batchSize: 8 });
  const resumed = afterCrash.next();
  check('yeniden açılışta seri geriye gitmiyor', resumed > run[run.length - 1]);

  console.log('\n[4] Damga üretimi');
  const data = Buffer.from('FITFAK zaman damgası testi');
  const digest = crypto.createHash('sha256').update(data).digest();
  const nonce = crypto.randomBytes(8);
  const tsq = buildTimeStampRequest({ hash: digest, nonce, certReq: true });
  const resp = tsa.handle(tsq);
  const status = parseTimeStampResponseStatus(resp);
  check('yanıt granted', status.granted === true);
  check('token içeriyor', status.hasToken === true);

  console.log('\n[5] Reddetmeler de geçerli birer TimeStampResp');
  const wrongPolicy = tsa.handle(buildTimeStampRequest({ hash: digest, policyOid: '1.2.3.4.5' }));
  check('bilinmeyen politika reddedilir', parseTimeStampResponseStatus(wrongPolicy).status === PKI_STATUS.REJECTION);
  const shortHash = tsa.handle(buildTimeStampRequest({ hash: Buffer.alloc(16) }));
  check('yanlış uzunlukta özet reddedilir', parseTimeStampResponseStatus(shortHash).status === PKI_STATUS.REJECTION);
  const garbage = tsa.handle(Buffer.from('bu DER değil'));
  check('bozuk istek yanıt döndürür (çökmez)', parseTimeStampResponseStatus(garbage).status === PKI_STATUS.REJECTION);

  console.log('\n[6] certReq davranışı (RFC 3161 §2.4.1)');
  const withCerts = tsa.handle(buildTimeStampRequest({ hash: digest, certReq: true }));
  const withoutCerts = tsa.handle(buildTimeStampRequest({ hash: digest, certReq: false }));
  check('certReq=true token\'ı büyütür', withCerts.length > withoutCerts.length);

  if (!hasOpenssl()) {
    console.log('\n[7] openssl bulunamadı -- bağımsız doğrulama ATLANDI');
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\nOK - TSA: ${checks} kontrol geçti (openssl doğrulaması atlandı).`);
    return;
  }

  console.log('\n[7] openssl ile bağımsız doğrulama');
  fs.writeFileSync(path.join(dir, 'data.txt'), data);
  fs.writeFileSync(path.join(dir, 'resp.tsr'), resp);
  fs.writeFileSync(path.join(dir, 'chain.pem'), chainPem);
  fs.writeFileSync(path.join(dir, 'root.pem'), (ca.getRootPem ? ca.getRootPem() : ca.certPem));
  fs.writeFileSync(path.join(dir, 'query.tsq'), tsq);

  const reply = execFileSync('openssl', ['ts', '-reply', '-in', path.join(dir, 'resp.tsr'), '-text'], { encoding: 'utf8' });
  check('openssl yanıtı çözümleyebiliyor', /Status: Granted/i.test(reply));
  check('politika OID doğru okunuyor', /1\.3\.6\.1\.4\.1\.65133\.1\.4/.test(reply));
  check('nonce geri döndürülmüş', /Nonce:/i.test(reply));

  const verify = execFileSync('openssl', [
    'ts', '-verify',
    '-data', path.join(dir, 'data.txt'),
    '-in', path.join(dir, 'resp.tsr'),
    '-CAfile', path.join(dir, 'root.pem'),
    '-untrusted', path.join(dir, 'chain.pem'),
  ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  check('openssl ts -verify: imza ve zincir doğrulandı', /Verification: OK/i.test(verify));

  console.log('\n[8] HTTP arayüzü');
  const server = http.createServer(tsa.httpHandler());
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/',
      headers: { 'content-type': 'application/timestamp-query', 'content-length': tsq.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        check('content-type application/timestamp-reply', res.headers['content-type'] === 'application/timestamp-reply');
        check('HTTP üzerinden granted yanıt', parseTimeStampResponseStatus(body).granted === true);
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`\nOK - TSA: ${checks} kontrol geçti (openssl ile çapraz doğrulandı).`);
      });
    });
    req.end(tsq);
  });
}

main();
