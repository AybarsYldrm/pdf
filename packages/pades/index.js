'use strict';
const path = require('path');
const crypto = require('crypto');
const { PAdESManager } = require('./src/utils/pades_manager');
const { buildVisibleSignatureConfig } = require('./src/signature/signature_config'); 

/**
 * Tamamen in-memory (RAM üzerinde) PAdES İmza Motoru
 * Yeni mimari ile B, T, LT ve LTA modlarını destekler.
 * 
 * @param {Buffer} pdfBuffer - İmzalanacak PDF dosyasının Buffer'ı
 * @param {string} keyPem - Private Key (PEM formatında)
 * @param {string} certPem - Public Certificate (PEM formatında)
 * @param {Array<string>} chainPems - Alt CA / Kök CA sertifikaları dizisi
 * @param {string} signerName - Görsel mühürde yer alacak isim
 * @param {Object} signatureRect - Görselin PDF üzerindeki konumu {x, y, width, origin}
 * @param {Object} options - Gelişmiş LTV, DocMDP ve Mod ayarları
 * @param {Object} [options.policy] - PAdES-EPES için: { oid, hashBuffer, uri, hashName?, userNoticeText? }.
 *   Verilmezse imza BES/T/LT/LTA olarak kalır. Kendi tescilli OID'iniz ve GERÇEKTEN yayınladığınız
 *   policy dokümanının hash'i + URL'i olmadan bu alanı doldurmayın.
 * @returns {Promise<Buffer>} - İmzalanmış PDF Buffer'ı
 */
async function signPdfInMemory(
    pdfBuffer, 
    keyPem, 
    certPem, 
    chainPems = [], 
    signerName = '', 
    signatureRect = null, 
    options = {}
) {
    const baseDir = __dirname;
    const TSA_URL = process.env.TSA_URL || options.tsaUrl || 'http://timestamp.digicert.com'; // Varsayılan TSA URL'i

    // 1. Çevresel Değişkenleri (env) Hazırlıyoruz
    const envOverrides = { ...process.env, SIGNATURE_IMAGE_OUTPUT: '' };
    
    // 2. Eğer dışarıdan bir konum/boyut objesi geldiyse, env değişkenini eziyoruz
    if (signatureRect) {
        const { x = 430, y = 130, width = 80, origin = 'bottom-left' } = signatureRect;
        envOverrides.SIGNATURE_POSITIONS = `default@${origin}=${x},${y},${width}`;
    }

    // 3. Görsel konfigürasyon ayarlarını oluşturuyoruz
    const visibleSignatureConfig = buildVisibleSignatureConfig({
        baseDir: baseDir,
        env: envOverrides,
        signerName: signerName 
    });

    // 4. PAdES Yöneticisini Başlatıyoruz
    const pm = new PAdESManager({
        tsaUrl: TSA_URL,
        tsaOptions: { hashName: 'sha256', certReq: true },
        logger: options.logger || console // Opsiyonel logger desteği
    });

    // 5. Gelişmiş Ayarlar (Defaults)
    const signMode = options.mode || 'T'; // Varsayılan: PAdES-T (Zaman Damgalı)
    const fieldName = options.fieldName || ('Signature_' + crypto.randomBytes(4).toString('hex'));

    // 6. YENİ API: Tek Giriş Noktasından (sign) İşlem Yapıyoruz
    const { pdf, mode } = await pm.sign({
        mode: signMode,
        pdfBuffer: pdfBuffer,
        keyPem: keyPem,
        certPem: certPem,
        chainPems: chainPems,
        fieldName: fieldName,
        placeholderHexLen: options.placeholderHexLen || 120000,
        visibleSignature: visibleSignatureConfig,
        certify: options.certify || null,
        ltv: options.ltv || null,
        // PAdES-EPES istiyorsanız: { oid, hashBuffer, uri, hashName?, userNoticeText? }
        // Verilmezse imza PAdES-BES/T/LT/LTA olarak kalır (policy attribute eklenmez).
        policy: options.policy || null
    });
    
    console.log(`[Başarılı] Dijital İmza Modu: ${mode.toUpperCase()} tamamlandı.`);
    return pdf;
}

// --- TEST VE DOĞRUDAN KULLANIM --- //
if (require.main === module) {
    const fs = require('fs');
    (async () => {
        try {
            console.log('In-memory imzalama işlemi başlıyor...');
            
            const inputPdfPath = path.join(__dirname, '../doc.pdf');
            const inputPdf = fs.readFileSync(inputPdfPath);

            const subCaPem = fs.readFileSync(path.join(__dirname, '../certs/sub_ca.crt'), 'utf8');
            const key = fs.readFileSync(path.join(__dirname, '../certs/signer.key'), 'utf8');
            const cert = fs.readFileSync(path.join(__dirname, '../certs/signer.crt'), 'utf8');

            const certRegex = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
            const chainArray = subCaPem.match(certRegex) || [];

            // Temel görsel konumlandırma
            const customPosition = { x: 20, y: 20, width: 150, origin: 'bottom-right' };
            const testName = 'Örnek İmzacı';

            // Gelişmiş ayarların kullanımı (Opsiyonel 7. Parametre)
            const advancedOptions = {
                mode: 'T', // 'B', 'T', 'LT', 'LTA', 'DOCTS'
                certify: { level: 1 } // Belgeyi kilitle (Sadece ilk imzada)
            };
            
            const signedPdfBuffer = await signPdfInMemory(
                inputPdf, 
                key, 
                cert, 
                chainArray, 
                testName, 
                customPosition, 
                advancedOptions
            );

            const OUT_PATH = path.join(__dirname, '../doc_signed.pdf');
            fs.writeFileSync(OUT_PATH, signedPdfBuffer);
            
            console.log(`İşlem tamamlandı! İmzalı dosya şuraya kaydedildi: ${OUT_PATH}`);
        } catch (error) {
            console.error('İmzalama Hatası:', error);
        }
    })();
}

module.exports = { signPdfInMemory };