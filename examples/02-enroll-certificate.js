'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ssl = require('@fitfak/ssl'); 
const pki = require('@fitfak/ssl/src/pki');
const { deviceLogin } = require('./device-login');

// --- YAPILANDIRMA ---
const IDP_BASE_URL = 'https://session.fitfak.net'; 
const CERT_ISSUER_URL = 'https://trust.fitfak.net'; 
const CLIENT_ID = '928c499a-e86a-4e01-9501-8631711dcbff'; 
const SCOPES = 'openid profile cert:issue'; 

// 1. ADIM: @fitfak/ssl ile Anahtar ve CSR Üretimi (sans olmadan)
async function generateKeyAndCsr() {
  const keyPair = ssl.generateEcKeyPair ? ssl.generateEcKeyPair('P-256') : ssl.generateEcRootCA({ curveName: 'P-256', verbose: false });

  const nameAttrs = [["550403", "Fitfak-CLI-Client"]];
  // sans dizisi kaldırıldı

  const csrKeyInfo = {
    keyType: "ec",
    curveName: "P-256",
    privateKey: keyPair.privateKey,
    publicKeyBuf: keyPair.publicKeyBuf,
  };

  const csrPem = pki.generateCSR(csrKeyInfo, nameAttrs);
  const privateKeyPem = ssl.ecPrivToPem(keyPair);
  
  return { csrPem, privateKeyPem };
}

async function main() {
  try {
    console.log('🔑 Anahtar ve CSR üretiliyor...');
    const { csrPem, privateKeyPem } = await generateKeyAndCsr();

    console.log('🚀 Device Authorization (Cihaz Yetkilendirme) başlatılıyor...\n');

    // RFC 8628 Device Login Akışı
    const tokens = await deviceLogin({
      baseUrl: IDP_BASE_URL,
      clientId: CLIENT_ID,
      scope: SCOPES,
      onPrompt: (info) => {
        console.log('==================================================');
        console.log('👉 Lütfen şu adresi bir tarayıcıda (telefon/bilgisayar) açın:');
        console.log(`🔗 ${info.verificationUriComplete || info.verificationUri}`);
        console.log(`\n🔑 Eşleştirme Kodunuz: ${info.userCode}`);
        console.log('==================================================\n');
        console.log('⏳ Onay bekleniyor (başka bir cihazdan onay verin)...');
      }
    });

    console.log('✅ Giriş başarılı! Token alındı.');

    let username = 'cli_user';
    try {
      const parts = tokens.accessToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
        username = payload.preferred_username || payload.name || payload.sub || 'cli_user';
      }
    } catch (_) {}

    const safeUsername = username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const userCertDir = path.join(__dirname, 'certs', safeUsername);
    
    if (!fs.existsSync(userCertDir)) {
      fs.mkdirSync(userCertDir, { recursive: true });
    }

    console.log('📜 Sertifika sunucusuna (trust.fitfak.net) CSR gönderiliyor...');

    const certPayload = JSON.stringify({ csrPem, profile: 'smime' }); //[cite: 4]
    const requestHeaders = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${tokens.accessToken}`,
      'Origin': 'https://trust.fitfak.net'
    };

    const certRes = await fetch(`${CERT_ISSUER_URL}/device/certificate`, {
      method: 'POST',
      headers: requestHeaders,
      body: certPayload
    });

    const certResText = await certRes.text();

    if (!certRes.ok) {
      throw new Error(`Sertifika sunucusu hata döndürdü [HTTP ${certRes.status}]: ${certResText}`);
    }

    const certData = JSON.parse(certResText);
    
    // Anahtar ve Sertifikayı Kaydet
    fs.writeFileSync(path.join(userCertDir, 'sign.key'), privateKeyPem);
    fs.writeFileSync(path.join(userCertDir, 'sign.crt'), certData.certPem);

    console.log(`\n🎉 İşlem Başarılı!`);
    console.log(`📁 Dosyalar kaydedildi: ${userCertDir}`);
    console.log('   - sign.key');
    console.log('   - sign.crt');

    process.exit(0);

  } catch (err) {
    console.error('\n❌ [KRİTİK HATA]:', err.message);
    process.exit(1);
  }
}

main();