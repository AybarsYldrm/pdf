'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// PAdES ve PDF motoru modülleri
const { signPdfInMemory } = require('@fitfak/pades'); 
const { buildVisibleSignatureConfig } = require('@fitfak/pades/src/signature/signature_config');
const padesModuleRoot = path.dirname(require.resolve('@fitfak/pades/package.json'));
const NativePdfEngine = require('@fitfak/pdf');       

// ==========================================
// 1. YARDIMCI FONKSİYONLAR
// ==========================================

function generateSnowflakeDocNo() {
    const timestamp = Date.now().toString(36); 
    const randomPart = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `DOC-${timestamp}-${randomPart}`.toUpperCase();
}

// ==========================================
// 2. KESİN LTV (AIA & CRL) OTOMASYON SERVİSİ
// ==========================================

class LtvAutomationService {
    static formatToPem(buffer) {
        const text = buffer.toString('utf8');
        if (text.includes('-----BEGIN CERTIFICATE-----')) return text; 
        const base64 = buffer.toString('base64');
        const pemBody = base64.match(/.{1,64}/g).join('\n');
        return `-----BEGIN CERTIFICATE-----\n${pemBody}\n-----END CERTIFICATE-----\n`;
    }

    static async fetchIssuerCert(infoAccess) {
        if (!infoAccess) return null;
        const match = infoAccess.match(/CA Issuers - URI:(http[^\s]+)/);
        if (!match) return null;
        try {
            const response = await fetch(match[1]);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return this.formatToPem(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
            console.warn(`[LTV UYARI] Üst sertifika indirilemedi:`, error.message);
            return null;
        }
    }

    static async buildDynamicLtvConfig(certPemRaw) {
        // 1. sign.crt içindeki tüm sertifikaları ayır
        const certRegex = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
        const localCerts = certPemRaw.match(certRegex) || [];

        if (localCerts.length === 0) throw new Error("Sertifika dosyası boş veya geçersiz!");

        const leafPem = localCerts[0];
        const chainPems = [];
        
        // Eğer sign.crt içine sub_ca gömülmüşse onu zincire ekle
        if (localCerts.length > 1) {
            chainPems.push(localCerts[1]);
        }

        // 2. Zinciri AIA üzerinden köke (Root) kadar takip et ve indir
        let currentPem = chainPems.length > 0 ? chainPems[0] : leafPem;

        while (true) {
            const cert = new crypto.X509Certificate(currentPem);
            if (cert.subject === cert.issuer) break; 
            
            const issuerPem = await this.fetchIssuerCert(cert.infoAccess);
            if (!issuerPem) break;
            
            if (!chainPems.includes(issuerPem)) {
                chainPems.push(issuerPem);
            }
            currentPem = issuerPem;
        }

        // 3. HEM OCSP HEM CRL'Yİ TÜM ZİNCİR İÇİN ÇIKAR VE YAPILANDIR
        const fullChain = [leafPem, ...chainPems];
        const ocspRequests = [];
        const crlRequests = []; // Artık sadece Buffer değil, ilişkisel obje dizisi tutuyoruz

        for (let i = 0; i < fullChain.length - 1; i++) {
            const subjectPem = fullChain[i];
            const issuerPem = fullChain[i + 1];

            try {
                const cert = new crypto.X509Certificate(subjectPem);
                
                // A) OCSP Çıkarımı
                if (cert.infoAccess) {
                    const ocspMatch = cert.infoAccess.match(/OCSP - URI:(http[^\s]+)/);
                    if (ocspMatch) {
                        ocspRequests.push({ certPem: subjectPem, issuerPem: issuerPem, url: ocspMatch[1] });
                    }
                }

                // B) CRL Çıkarımı (Doğrudan kütüphaneye URL objesi olarak veriyoruz)
                const derText = cert.raw.toString('latin1');
                const crlMatch = derText.match(/http:\/\/[a-zA-Z0-9\-\.\/]+crl/i);
                if (crlMatch) {
                    const crlUrl = crlMatch[0];
                    console.log(`[LTV BİLGİ] Zincir için CRL adresi eklendi: ${crlUrl}`);
                    
                    crlRequests.push({
                        certPem: subjectPem,
                        issuerPem: issuerPem,
                        url: crlUrl
                    });
                }
            } catch(e) {}
        }

        return {
            leafPem,
            chainPems,
            ltvConfig: {
                certsPem: chainPems, // SubCA ve RootCA PAdES motoruna besleniyor
                ocsp: ocspRequests.length > 0 ? ocspRequests : undefined,
                crl: crlRequests.length > 0 ? crlRequests : undefined // Parametre adı "crl" ve obje dizisi olarak ayarlandı
            }
        };
    }
}

// ==========================================
// 3. PROFİL YÖNETİMİ VE PDF TASLAK MOTORU
// ==========================================

const SIGNER_PROFILES = {
    aybars: {
        name: 'Aybars YILDIRIM',
        keyPath: 'certs/357510292957040640/sign.key',
        certPath: 'certs/357510292957040640/sign.crt', 
        mode: 'LT',
        position: { x: 170, y: 37, width: 115, origin: 'bottom-left' }
    },
    ahmet: {
        name: 'Ahmet Yılmaz',
        keyPath: 'certs/357603506581934080/sign.key',
        certPath: 'certs/357603506581934080/sign.crt',
        mode: 'LT',
        position: { x: 310, y: 37, width: 115, origin: 'bottom-left' }
    }
};

async function loadSignerProfileAsync(profileKey) {
    const profile = SIGNER_PROFILES[profileKey];
    if (!profile) throw new Error(`İmzalayan profili bulunamadı: ${profileKey}`);

    const keyPem = fs.readFileSync(path.join(__dirname, profile.keyPath), 'utf8');
    const certPemRaw = fs.readFileSync(path.join(__dirname, profile.certPath), 'utf8');
    
    console.log(`[SİSTEM] ${profile.name} için sertifika zinciri ve iptal listeleri (OCSP/CRL) çekiliyor...`);
    
    const { leafPem, chainPems, ltvConfig } = await LtvAutomationService.buildDynamicLtvConfig(certPemRaw);

    return {
        ...profile,
        keyPem,
        certPem: leafPem,
        chainArray: chainPems, 
        ltvConfig
    };
}

async function createPdfDraft(draftPath, docNo) {
    const pdf = new NativePdfEngine(draftPath, {
        format: 'A5_LANDSCAPE',
        margins: { top: 10, bottom: 10, left: 10, right: 10 },
        metadata: { Title: 'İmzalı Kurumsal Belge', Author: 'Native Engine' },
    });

    pdf.registerFont('Ubuntu', './assets/Ubuntu-Regular.ttf');
    
    pdf.addElement({
        type: 'block',
        style: { width: '100%', height: '100%', borderWidth: 1.5, borderColor: [20, 45, 95], padding: 4 },
        children: [{
            type: 'block',
            style: { width: '100%', height: '100%', borderWidth: 4, borderColor: [20, 45, 95], paddingTop: 35, paddingLeft: 36, paddingRight: 36, paddingBottom: 10 },
            children: [
                { type: 'text', text: 'RESMİ BİLGİLENDİRME BELGESİ', style: { fontFamily: 'Ubuntu', fontSize: 22, color: [20, 45, 95], align: 'center', marginBottom: 12 } },
                { type: 'text', text: 'Bu belge, PAdES altyapısıyla güvenli şekilde dijital olarak mühürlenmiş ve imzalanmıştır.', style: { fontFamily: 'Ubuntu', fontSize: 10, color: [50, 50, 50], align: 'center', lineHeight: 1.4, margin: '0 30' } },

                { type: 'image', src: './assets/fitfak-logo.png', style: { position: 'absolute', left: 0, bottom: 44, width: 35 } },
                { type: 'text', text: 'FITFAK', style: { position: 'absolute', left: 42, bottom: 50, width: 120, fontFamily: 'Ubuntu', fontSize: 13, color: [20, 45, 95] } },
                
                { type: 'image', src: './assets/school-logo.png', style: { position: 'absolute', right: 0, bottom: 44, width: 35 } },
                { type: 'text', text: 'Cumhuriyet Üniversitesi\nTıp Fakültesi', style: { position: 'absolute', right: 42, bottom: 50, width: 180, fontFamily: 'Ubuntu', fontSize: 9.5, color: [20, 45, 95], align: 'right', lineHeight: 1.2 } },

                { type: 'block', style: { position: 'absolute', bottom: 42, left: 0, width: '100%', height: 1, backgroundColor: [200, 200, 200] } },
                { type: 'block', style: { position: 'absolute', bottom: 8, left: 0, width: '100%', height: 1, backgroundColor: [200, 200, 200] } },
                
                { type: 'text', text: `Belge No: ${docNo} | Zaman Damgalı`, style: { position: 'absolute', left: 0, right: 0, bottom: 0, fontFamily: 'Ubuntu', fontSize: 7.5, color: [150, 150, 150], align: 'center' } }
            ]
        }]
    });

    await pdf.build();
    return fs.readFileSync(draftPath);
}

// ==========================================
// 4. ANA İŞ AKIŞI (MAIN PIPELINE)
// ==========================================

async function main() {
    console.log("[SİSTEM] Başlatılıyor...");

    const dynamicDocNo = generateSnowflakeDocNo();
    console.log(`[BİLGİ] Üretilen Belge No: ${dynamicDocNo}`);

    const tempDraftPath = path.join(__dirname, 'temp_draft.pdf');
    const signedPdfPath = path.join(__dirname, 'signed.pdf');

    console.log("[SİSTEM] PDF taslağı oluşturuluyor...");
    let currentPdfBuffer = await createPdfDraft(tempDraftPath, dynamicDocNo);
    if (fs.existsSync(tempDraftPath)) {
        fs.unlinkSync(tempDraftPath); 
    }
    console.log("[BİLGİ] Taslak belleğe alındı.");

    const signatureQueue = ['aybars', 'ahmet']; 

    for (const profileKey of signatureQueue) {
        const profile = await loadSignerProfileAsync(profileKey);
        
        console.log(`\n--- İMZA BAŞLIYOR: ${profile.name} [Mod: ${profile.mode}] ---`);
        
        if (profile.mode === 'LT') {
            console.log(`[LTV] Zincir Yüklendi: ${profile.chainArray.length} adet CA`);
            if (profile.ltvConfig?.ocsp) console.log(`      -> OCSP İsteği: ${profile.ltvConfig.ocsp.length} adres eklendi.`);
            if (profile.ltvConfig?.crl) console.log(`      -> CRL İsteği: ${profile.ltvConfig.crl.length} adres eklendi.`);
        }

        const visibleSignatureConfig = buildVisibleSignatureConfig({
            baseDir: padesModuleRoot,
            env: { ...process.env, SIGNATURE_IMAGE_OUTPUT: '' }, 
            signerName: profile.name
        });

        if (visibleSignatureConfig) {
            visibleSignatureConfig.textTemplate = ''; 
            visibleSignatureConfig.textLines = [];    
            visibleSignatureConfig.text = '';         
            visibleSignatureConfig.cnFallbackEnabled = false; 
        }

        const advancedOptions = {
            mode: profile.mode,
            visibleSignature: visibleSignatureConfig,
            ltv: profile.mode === 'LT' ? profile.ltvConfig : undefined
        };

        try {
            currentPdfBuffer = await signPdfInMemory(
                currentPdfBuffer, 
                profile.keyPem, 
                profile.certPem, 
                profile.chainArray, 
                profile.name, 
                profile.position, 
                advancedOptions
            );

            console.log(`[BAŞARILI] ${profile.name} imzası eklendi.`);
        } catch (error) {
            console.error(`[HATA] ${profile.name} imza işlemi başarısız:`, error.message);
            break; 
        }
    }

    fs.writeFileSync(signedPdfPath, currentPdfBuffer);
    console.log(`\n[BİTTİ] Çoklu imzalı nihai belge oluşturuldu: ${signedPdfPath}`);
}

main().catch(console.error);