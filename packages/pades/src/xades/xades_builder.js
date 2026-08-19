'use strict';
const crypto = require('crypto');
const http = require('http');
const https = require('https');

// --- 1. YARDIMCI ARAÇLAR ---

// X.509 Serial Number (Hex) -> Decimal (String) Çevirici
function hexToDecimalString(hex) {
    hex = hex.replace(/^0+/, '');
    if (!hex) return '0';
    let dec = '0';
    for (let i = 0; i < hex.length; i++) {
        let carry = parseInt(hex[i], 16);
        let temp = '';
        for (let j = dec.length - 1; j >= 0; j--) {
            let val = parseInt(dec[j], 10) * 16 + carry;
            temp = (val % 10) + temp;
            carry = Math.floor(val / 10);
        }
        while (carry > 0) {
            temp = (carry % 10) + temp;
            carry = Math.floor(carry / 10);
        }
        dec = temp;
    }
    return dec;
}

// Zaman Damgası İsteği (TSQ - Time Stamp Query) İnşa Edici (Sıfır Bağımlılık)
function buildTSQ(hashBuffer) {
    // ASN.1 Formatında SHA-256 Zaman Damgası İsteği Başlığı (24 bytes)
    const header = Buffer.from('30430201013031300d060960864801650304020105000420', 'hex');
    const nonceHeader = Buffer.from('0208', 'hex');
    const nonce = crypto.randomBytes(8);
    const certReq = Buffer.from('0101ff', 'hex'); // Sertifika isteği: True
    return Buffer.concat([header, hashBuffer, nonceHeader, nonce, certReq]);
}

// Zaman Damgası Yanıtı (TSR) içinden 'TimeStampToken' PKCS#7 Paketini Söken Motor
function extractTimeStampToken(tsrBuffer) {
    if (tsrBuffer[0] !== 0x30) throw new Error("Geçersiz TSR Formatı");
    let offset = 1;
    let len = tsrBuffer[offset++];
    if (len & 0x80) {
        const bytesLen = len & 0x7F;
        len = 0;
        for (let i = 0; i < bytesLen; i++) len = (len << 8) | tsrBuffer[offset++];
    }
    
    // PKIStatusInfo'yu atlıyoruz
    if (tsrBuffer[offset] !== 0x30) throw new Error("TSR İçinde Status Bulunamadı");
    offset++;
    let statusLen = tsrBuffer[offset++];
    if (statusLen & 0x80) {
        const bytesLen = statusLen & 0x7F;
        statusLen = 0;
        for (let i = 0; i < bytesLen; i++) statusLen = (statusLen << 8) | tsrBuffer[offset++];
    }
    
    const tokenOffset = offset + statusLen;
    if (tokenOffset >= tsrBuffer.length) {
        throw new Error("TSA Sunucusu isteği reddetti veya TimeStampToken döndürmedi.");
    }
    
    return tsrBuffer.slice(tokenOffset);
}

// HTTP/HTTPS üzerinden TSA Sunucusuna İstek Atan İstemci
function fetchTSA(url, tsqBuffer) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/timestamp-query',
                'Content-Length': tsqBuffer.length
            }
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error(`TSA HTTP Hatası: ${res.statusCode}`));
                resolve(Buffer.concat(chunks));
            });
        });
        req.on('error', reject);
        req.write(tsqBuffer);
        req.end();
    });
}

// --- 2. ANA XADES MİMARİSİ ---

class XAdESBuilder {
    constructor(certPem, keyPem, opts = {}) {
        this.certPem = certPem;
        this.keyPem = keyPem;
        
        const x509 = new crypto.X509Certificate(certPem);
        this.certDer = Buffer.from(x509.raw);
        this.serialNumberDec = hexToDecimalString(x509.serialNumber);
        
        this.issuerName = x509.issuer.split('\n').join(', ');
        this.subjectName = x509.subject.split('\n').join(', ');

        const pubKey = x509.publicKey;
        this.isEc = pubKey.asymmetricKeyType === 'ec';
        this.sigAlgXml = this.isEc 
            ? 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256' 
            : 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';

        this.policyOid = opts.policyOid || '1.3.6.1.4.1.65133.1.1'; 
        this.policyHash = this._calculateHashBase64(Buffer.from(opts.policyUri || 'FitDB_Policy', 'utf8'));
    }

    _calculateHashBase64(data, algorithm = 'sha256') {
        const hash = crypto.createHash(algorithm);
        hash.update(data);
        return hash.digest('base64');
    }

    _getCertDigest() { return this._calculateHashBase64(this.certDer); }
    _getCertBase64() { return this.certDer.toString('base64'); }
    _getXAdESTime() { return new Date().toISOString().split('.')[0] + 'Z'; }

    /**
     * XML belgesini XAdES-T (Zaman Damgalı) olarak mühürler.
     * DİKKAT: TSA İsteği atıldığı için artık Asenkron (async/await) çalışır.
     */
    async buildEnvelopedSignature(originalXml, tsaUrl = 'http://timestamp.digicert.com') {
        const uniqueId = crypto.randomBytes(6).toString('hex').toUpperCase();
        const sigId = `Signature-${uniqueId}`;
        const propsId = `${sigId}-SignedProperties`;
        const sigValueId = `${sigId}-SignatureValue`; 

        const normalizedXml = originalXml.replace(/\r\n/g, '\n').trim();
        const docHash = this._calculateHashBase64(Buffer.from(normalizedXml, 'utf8'));

        const signedProps = `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="${propsId}"><xades:SignedSignatureProperties><xades:SigningTime>${this._getXAdESTime()}</xades:SigningTime><xades:SigningCertificate><xades:Cert><xades:CertDigest><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod><ds:DigestValue>${this._getCertDigest()}</ds:DigestValue></xades:CertDigest><xades:IssuerSerial><ds:X509IssuerName>${this.issuerName}</ds:X509IssuerName><ds:X509SerialNumber>${this.serialNumberDec}</ds:X509SerialNumber></xades:IssuerSerial></xades:Cert></xades:SigningCertificate><xades:SignaturePolicyIdentifier><xades:SignaturePolicyId><xades:SigPolicyId><xades:Identifier>${this.policyOid}</xades:Identifier></xades:SigPolicyId><xades:SigPolicyHash><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod><ds:DigestValue>${this.policyHash}</ds:DigestValue></xades:SigPolicyHash></xades:SignaturePolicyId></xades:SignaturePolicyIdentifier></xades:SignedSignatureProperties></xades:SignedProperties>`;
        
        const propsHash = this._calculateHashBase64(Buffer.from(signedProps, 'utf8'));

        const signedInfo = `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:CanonicalizationMethod><ds:SignatureMethod Algorithm="${this.sigAlgXml}"></ds:SignatureMethod><ds:Reference URI=""><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></ds:Transform><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:Transform></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod><ds:DigestValue>${docHash}</ds:DigestValue></ds:Reference><ds:Reference Type="http://uri.etsi.org/01903#SignedProperties" URI="#${propsId}"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:Transform></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod><ds:DigestValue>${propsHash}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;

        let signatureValueBuffer;
        if (this.isEc) {
            signatureValueBuffer = crypto.sign('SHA256', Buffer.from(signedInfo, 'utf8'), {
                key: this.keyPem,
                dsaEncoding: 'ieee-p1363' 
            });
        } else {
            signatureValueBuffer = crypto.sign('SHA256', Buffer.from(signedInfo, 'utf8'), this.keyPem);
        }
        const signatureValue = signatureValueBuffer.toString('base64');
        const sigValueNode = `<ds:SignatureValue Id="${sigValueId}">${signatureValue}</ds:SignatureValue>`;

        // === XAdES-T : TSA'DAN ZAMAN DAMGASI ÇEKİLİYOR ===
        console.log(`[TSA] Zaman damgası sunucusuna bağlanılıyor: ${tsaUrl}`);
        const sigValueHashBuffer = crypto.createHash('sha256').update(Buffer.from(sigValueNode, 'utf8')).digest();
        const tsqBuffer = buildTSQ(sigValueHashBuffer);
        
        let tsaBase64 = '';
        try {
            const tsrBuffer = await fetchTSA(tsaUrl, tsqBuffer);
            const tokenBuffer = extractTimeStampToken(tsrBuffer);
            tsaBase64 = tokenBuffer.toString('base64');
            console.log('[TSA] Zaman damgası başarıyla çekildi ve eklendi!');
        } catch (error) {
            console.error('[TSA HATASI]', error.message);
            console.warn('[UYARI] TSA sunucusuna ulaşılamadı. Belge XAdES-B seviyesinde kalacak.');
        }

        const unsignedProps = tsaBase64 ? `
        <xades:UnsignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="#${sigId}">
            <xades:UnsignedSignatureProperties>
                <xades:SignatureTimeStamp>
                    <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:CanonicalizationMethod>
                    <xades:EncapsulatedTimeStamp>${tsaBase64}</xades:EncapsulatedTimeStamp>
                </xades:SignatureTimeStamp>
            </xades:UnsignedSignatureProperties>
        </xades:UnsignedProperties>` : '';

        // === MÜHÜR BİRLEŞTİRİLİYOR ===
        const signatureBlock = `
<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="${sigId}">
    ${signedInfo}
    ${sigValueNode}
    <ds:KeyInfo>
        <ds:X509Data>
            <ds:X509IssuerSerial>
                <ds:X509IssuerName>${this.issuerName}</ds:X509IssuerName>
                <ds:X509SerialNumber>${this.serialNumberDec}</ds:X509SerialNumber>
            </ds:X509IssuerSerial>
            <ds:X509SubjectName>${this.subjectName}</ds:X509SubjectName>
            <ds:X509Certificate>${this._getCertBase64()}</ds:X509Certificate>
        </ds:X509Data>
    </ds:KeyInfo>
    <ds:Object>
        <xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="#${sigId}">
            ${signedProps}${unsignedProps}
        </xades:QualifyingProperties>
    </ds:Object>
</ds:Signature>`;

        const closingTagIdx = normalizedXml.lastIndexOf('</');
        if (closingTagIdx === -1) throw new Error('Geçerli bir XML bulunamadı.');
        
        return normalizedXml.substring(0, closingTagIdx) + signatureBlock + '\n' + normalizedXml.substring(closingTagIdx);
    }
}

module.exports = { XAdESBuilder };