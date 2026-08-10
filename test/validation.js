'use strict';

const fs = require('fs');
const crypto = require('crypto');
const tls = require('tls');
const http = require('http');
const https = require('https');

class SignatureValidator {
    constructor() {
        this.systemTrustedRoots = new Set();
        this.ocspModule = null;
        this._initTrustStore();
        this._initOcspModule();
    }

    _initTrustStore() {
        try {
            // Node.js'in içine gömülü (Mozilla) tüm kök sertifikaların Subject'lerini belleğe al
            for (const pem of tls.rootCertificates) {
                const x = new crypto.X509Certificate(pem);
                this.systemTrustedRoots.add(x.subject.replace(/\n/g, ', '));
            }
        } catch (e) {
            console.warn("Uyarı: Node.js kök sertifika deposu yüklenemedi.");
        }
    }

    _initOcspModule() {
        try {
            this.ocspModule = require('@fitfak/pades/src/cades/ocsp');
        } catch (e) {
            console.warn("UYARI: OCSP modülü yüklenemedi. OCSP doğrulamaları atlanacak.");
        }
    }

    // --- YARDIMCI FONKSİYONLAR ---
    _readTLV(buf, pos) {
        const t = buf[pos];
        let l = buf[pos + 1], lenBytes = 1;
        if (l & 0x80) {
            const n = l & 0x7F; l = 0;
            for (let i = 0; i < n; i++) l = (l << 8) | buf[pos + 2 + i];
            lenBytes = 1 + n;
        }
        const hdr = 1 + lenBytes, start = pos + hdr, end = start + l;
        return { tag: t, len: l, hdr, start, end, next: end };
    }

    _oidFromBytes(bytes) {
        const b = Buffer.from(bytes);
        if (!b.length) return '(empty)';
        const first = b[0];
        const arcs = [Math.floor(first / 40), first % 40];
        let val = 0;
        for (let i = 1; i < b.length; i++) {
            const v = b[i];
            val = (val << 7) | (v & 0x7f);
            if (!(v & 0x80)) { arcs.push(val); val = 0; }
        }
        return arcs.join('.');
    }

    _checkLTV(pdfBuf) {
        return pdfBuf.indexOf(Buffer.from('/DSS')) !== -1;
    }

    _formatASN1Date(str) {
        if (!str) return 'Bilinmiyor';
        const m = str.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
        if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]} UTC`;
        return str;
    }

    _fetchAIA(urlStr) {
        return new Promise((resolve, reject) => {
            const url = new URL(urlStr);
            const agent = url.protocol === 'https:' ? https : http;
            const req = agent.get(urlStr, (res) => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error('HTTP Status ' + res.statusCode));
                }
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            });
            req.on('error', reject);
        });
    }

    _findSignatures(pdfBuf) {
        const s = pdfBuf.toString('latin1');
        const results = [];
        const re = /(\d+)\s+0\s+obj\s*<<([\s\S]*?)>>\s*(?:stream|endobj)/g;
        let m;
        while ((m = re.exec(s)) !== null) {
            const dictStr = m[2];
            if (!/\/Type\s*\/Sig\b/.test(dictStr) && !/\/SubFilter\s*\/ETSI\.RFC3161/.test(dictStr)) continue;
            const brMatch = /\/ByteRange\s*\[([^\]]+)\]/.exec(dictStr);
            const contentsMatch = /\/Contents\s*<([0-9A-Fa-f\s]+)>/.exec(dictStr);
            const subFilterMatch = /\/SubFilter\s*\/([A-Za-z0-9.\-]+)/.exec(dictStr);
            if (!brMatch || !contentsMatch) continue;
            
            results.push({
                objNum: m[1],
                subFilter: subFilterMatch ? subFilterMatch[1] : 'Bilinmiyor',
                byteRange: brMatch[1].trim().split(/\s+/).map(Number),
                contentsHex: contentsMatch[1].replace(/\s+/g, '')
            });
        }
        return results;
    }

    _parseSignedData(cmsDer) {
        try {
            const outer = this._readTLV(cmsDer, 0);
            const ctOid = this._readTLV(cmsDer, outer.start);
            const explicit0 = this._readTLV(cmsDer, ctOid.next);
            const signedData = this._readTLV(cmsDer, explicit0.start);

            let p = signedData.start;
            p = this._readTLV(cmsDer, p).next; 
            p = this._readTLV(cmsDer, p).next; 
            const encapContentInfo = this._readTLV(cmsDer, p); 
            p = encapContentInfo.next;

            let extractedTime = null;
            const encapHex = cmsDer.slice(encapContentInfo.start - encapContentInfo.hdr, encapContentInfo.end).toString('hex');
            const timeMatch = encapHex.match(/18[0-9a-f]{2}(3230[0-9a-f]+5a)/i); 
            if (timeMatch) {
                const asciiTime = Buffer.from(timeMatch[1], 'hex').toString('ascii');
                extractedTime = this._formatASN1Date(asciiTime);
            }

            let certsTlv = null;
            let next = this._readTLV(cmsDer, p);
            if ((next.tag & 0xE0) === 0xA0 && (next.tag & 0x1F) === 0) {
                certsTlv = next; p = next.next; next = this._readTLV(cmsDer, p);
            }
            if ((next.tag & 0xE0) === 0xA0 && (next.tag & 0x1F) === 1) {
                p = next.next; next = this._readTLV(cmsDer, p);
            }
            const signerInfos = next;

            const certs = [];
            if (certsTlv) {
                let r = certsTlv.start;
                while (r < certsTlv.end) {
                    const cert = this._readTLV(cmsDer, r);
                    certs.push(Buffer.from(cmsDer.slice(r, cert.next)));
                    r = cert.next;
                }
            }

            const si = this._readTLV(cmsDer, signerInfos.start);
            let q = si.start;
            q = this._readTLV(cmsDer, q).next; 
            q = this._readTLV(cmsDer, q).next; 
            q = this._readTLV(cmsDer, q).next; 

            const signedAttrs = this._readTLV(cmsDer, q);
            let messageDigest = null;
            if ((signedAttrs.tag & 0xE0) === 0xA0) {
                let r = signedAttrs.start;
                while (r < signedAttrs.end) {
                    const attr = this._readTLV(cmsDer, r); r = attr.next;
                    let z = attr.start;
                    const attrOidTlv = this._readTLV(cmsDer, z);
                    const attrOid = this._oidFromBytes(cmsDer.slice(attrOidTlv.start, attrOidTlv.end));
                    z = attrOidTlv.next;
                    if (attrOid === '1.2.840.113549.1.9.4') {
                        const octStr = this._readTLV(cmsDer, this._readTLV(cmsDer, z).start);
                        messageDigest = Buffer.from(cmsDer.slice(octStr.start, octStr.end));
                    }
                }
                q = signedAttrs.next;
            }

            q = this._readTLV(cmsDer, q).next; 
            q = this._readTLV(cmsDer, q).next; 

            let timeStampTokens = [];
            if (q < si.end) {
                const unsignedAttrsTlv = this._readTLV(cmsDer, q);
                if ((unsignedAttrsTlv.tag & 0xE0) === 0xA0 && (unsignedAttrsTlv.tag & 0x1F) === 1) {
                    let r = unsignedAttrsTlv.start;
                    while (r < unsignedAttrsTlv.end) {
                        const attr = this._readTLV(cmsDer, r); r = attr.next;
                        let z = attr.start;
                        const attrOidTlv = this._readTLV(cmsDer, z);
                        const attrOid = this._oidFromBytes(cmsDer.slice(attrOidTlv.start, attrOidTlv.end));
                        z = attrOidTlv.next;
                        const attrValues = this._readTLV(cmsDer, z);
                        if (attrOid === '1.2.840.113549.1.9.16.2.14') {
                            const tstContentInfo = this._readTLV(cmsDer, attrValues.start);
                            const tstDer = Buffer.from(cmsDer.slice(tstContentInfo.start - tstContentInfo.hdr, tstContentInfo.end));
                            timeStampTokens.push(this._parseSignedData(tstDer)); // Rekürsif çağrı
                        }
                    }
                }
            }
            return { certs, messageDigest, timeStampTokens, extractedTime };
        } catch (e) {
            return { error: 'CMS Ayrıştırma Hatası: ' + e.message, certs: [], timeStampTokens: [] };
        }
    }

    _extractCertDetails(certDer, source) {
        if (typeof crypto.X509Certificate !== 'function') return null;
        try {
            const x = new crypto.X509Certificate(certDer);
            let ocspUrl = 'Yok';
            let caIssuersUrl = 'Yok';
            
            if (x.infoAccess) {
                const lines = x.infoAccess.split('\n');
                const ocspLine = lines.find(l => l.includes('1.3.6.1.5.5.7.48.1') || l.includes('OCSP'));
                if (ocspLine) {
                    const match = ocspLine.match(/URI:(http[^\s]+)/);
                    if (match) ocspUrl = match[1];
                }
                
                const caLine = lines.find(l => l.includes('1.3.6.1.5.5.7.48.2') || l.includes('CA Issuers'));
                if (caLine) {
                    const match = caLine.match(/URI:(http[^\s]+)/);
                    if (match) caIssuersUrl = match[1];
                }
            }
            
            const cnMatch = x.subject.match(/CN=([^,\n]+)/);
            const shortName = cnMatch ? cnMatch[1] : x.subject.split('\n')[0];

            return {
                certDer,
                subject: x.subject.replace(/\n/g, ', '),
                shortName,
                issuer: x.issuer.replace(/\n/g, ', '),
                isSelfSigned: x.subject === x.issuer,
                ocspUrl,
                caIssuersUrl, 
                source,
                ocspResult: 'Sorgulanmadı' 
            };
        } catch (e) {
            return null;
        }
    }

    /**
     * @param {Buffer} pdfBuf - Doğrulanacak PDF dosyasının Buffer nesnesi.
     * @param {String} fileName - Loglarda gösterilecek opsiyonel dosya adı.
     * @returns {Promise<Object>} { isValid: boolean, padesLevel: string, reportText: string }
     */
    async validateBuffer(pdfBuf, fileName = "Belge") {
        const logs = [];
        const print = (msg) => logs.push(msg);

        const sigs = this._findSignatures(pdfBuf);
        
        if (!sigs.length) { 
            print(`\n======================================================================`);
            print(`[ FITFAK PDF GÜVENLİK VE DOĞRULAMA MOTORU v2.0 ]`);
            print(`❌ Dosyada İmza objesi bulunamadı: ${fileName}`); 
            print(`======================================================================\n`);
            return { isValid: false, padesLevel: "Yok", reportText: logs.join('\n') };
        }

        const hasDSS = this._checkLTV(pdfBuf);
        let hasMainSig = false;
        let hasArchiveTimestamp = false;
        let hasSigTimestamp = false;

        const parsedSignatures = [];

        for (const sig of sigs) {
            const [s1, l1, s2, l2] = sig.byteRange;
            const covered = Buffer.concat([pdfBuf.subarray(s1, s1 + l1), pdfBuf.subarray(s2, s2 + l2)]);
            const cmsDer = Buffer.from(sig.contentsHex, 'hex');
            const info = this._parseSignedData(cmsDer);
            
            if (sig.subFilter === 'ETSI.RFC3161') hasArchiveTimestamp = true;
            if (sig.subFilter === 'ETSI.CAdES.detached' || sig.subFilter === 'adbe.pkcs7.detached') hasMainSig = true;
            if (info.timeStampTokens && info.timeStampTokens.length > 0) hasSigTimestamp = true;

            parsedSignatures.push({ sig, covered, cmsDer, info });
        }

        let padesLevel = "Bilinmiyor";
        if (hasMainSig) {
            if (hasArchiveTimestamp && hasDSS && hasSigTimestamp) padesLevel = "PAdES-LTA (Arşiv Seviyesi Uzun Vadeli Doğrulama)";
            else if (hasDSS && hasSigTimestamp) padesLevel = "PAdES-LT (Uzun Vadeli Doğrulama)";
            else if (hasSigTimestamp) padesLevel = "PAdES-T (Zaman Damgalı)";
            else padesLevel = "PAdES-B (Temel İmza)";
        } else {
            if (hasArchiveTimestamp) padesLevel = "SADECE BELGE ZAMAN DAMGASI (Document TimeStamp - RFC3161)";
            else padesLevel = "Standart Dışı İmza";
        }

        print(`\n======================================================================`);
        print(`[ FITFAK PDF GÜVENLİK VE DOĞRULAMA MOTORU v2.0 ]`);
        print(`Dosya              : ${fileName}`);
        print(`Tespit Edilen Mod  : ${padesLevel}`);
        print(`LTV (DSS Store)    : ${hasDSS ? 'AKTİF ✅' : 'PASİF ⚠️'}`);
        print(`======================================================================\n`);

        let docOverallValid = true;

        for (let i = 0; i < parsedSignatures.length; i++) {
            const { sig, covered, cmsDer, info } = parsedSignatures[i];
            const isDocTimestamp = sig.subFilter === 'ETSI.RFC3161';
            
            let headerLabel = isDocTimestamp ? '(BELGE ZAMAN DAMGASI)' : '(ANA İMZA)';
            if (hasMainSig && isDocTimestamp) headerLabel = '(ARŞİV ZAMAN DAMGASI / LTA)';
            
            print(`--- İMZA #${i + 1} ${headerLabel} ---`);
            
            if (info.error) { 
                print(`❌ ${info.error}`); docOverallValid = false; continue; 
            }

            let isHashValid = false;
            let matchedAlgo = 'Bilinmiyor';

            if (isDocTimestamp) {
                const algos = ['sha256', 'sha384', 'sha512'];
                const cmsHex = cmsDer.toString('hex');
                for (const algo of algos) {
                    const hashVal = crypto.createHash(algo).update(covered).digest('hex');
                    if (cmsHex.includes(hashVal)) {
                        isHashValid = true; matchedAlgo = algo; break;
                    }
                }
            } else {
                if (info.messageDigest) {
                    const algos = ['sha256', 'sha384', 'sha512'];
                    for (const algo of algos) {
                        const hashVal = crypto.createHash(algo).update(covered).digest('hex');
                        if (hashVal === info.messageDigest.toString('hex')) {
                            isHashValid = true; matchedAlgo = algo; break;
                        }
                    }
                }
            }
            
            if (!isHashValid) docOverallValid = false;
            print(`Belge Bütünlüğü (Hash)     : ${isHashValid ? `BAŞARILI ✅ (${matchedAlgo})` : 'BOZULMUŞ ❌'}`);

            if (isDocTimestamp) {
                print(`Zaman Damgası              : MEVCUT ✅ (${info.extractedTime})`);
            } else if (info.timeStampTokens.length > 0 && info.timeStampTokens[0].extractedTime) {
                print(`Zaman Damgası (PAdES-T)    : MEVCUT ✅ (${info.timeStampTokens[0].extractedTime})`);
            } else {
                print(`Zaman Damgası (PAdES-T)    : YOK ⚠️`);
            }

            const parsedCerts = [];
            info.certs.forEach(c => {
                const d = this._extractCertDetails(c, isDocTimestamp ? 'TSA (Zaman Damgası)' : 'İmza Sahibi');
                if (d) parsedCerts.push(d);
            });
            info.timeStampTokens.forEach(tst => {
                tst.certs.forEach(c => {
                    const d = this._extractCertDetails(c, 'TSA (Zaman Damgası)');
                    if (d) parsedCerts.push(d);
                });
            });

            print(`\n[ GÜVEN ZİNCİRİ VE OCSP CANLI SORGUSU ]`);
            
            // Sertifika kontrol döngüsü dinamik olarak uzayabilir (AIA'dan cert eklendiğinde)
            for (let idx = 0; idx < parsedCerts.length; idx++) {
                const cDetails = parsedCerts[idx];
                const typeStr = `[${cDetails.source}]`;
                let issuerCert = parsedCerts.find(c => c.subject === cDetails.issuer);

                // --- DİNAMİK AIA İNDİRME İŞLEMİ ---
                if (!issuerCert && !cDetails.isSelfSigned && cDetails.caIssuersUrl !== 'Yok') {
                    print(` └─ [Ağ] Üst CA Eksik. AIA'dan İndiriliyor: ${cDetails.caIssuersUrl}...`);
                    try {
                        const fetchedDer = await this._fetchAIA(cDetails.caIssuersUrl);
                        const newCert = this._extractCertDetails(fetchedDer, 'AIA Ağından İndirilen CA');
                        if (newCert) {
                            parsedCerts.push(newCert); // Dizi uzar, bu cert de taranır
                            issuerCert = newCert;
                            print(`    ↳ Başarılı: ${newCert.shortName} zincire dahil edildi!`);
                        }
                    } catch (e) {
                        print(`    ↳ İndirme Başarısız: ${e.message}`);
                    }
                }
                
                if (cDetails.isSelfSigned) {
                    cDetails.ocspResult = 'Self-Signed (Kök CA) - OCSP Atlandı ✅';
                } 
                else if (cDetails.ocspUrl === 'Yok') {
                    cDetails.ocspResult = 'OCSP URL Yok';
                } 
                else {
                    if (!issuerCert) {
                        if (this.systemTrustedRoots.has(cDetails.issuer)) {
                            cDetails.ocspResult = 'SİSTEM KÖK DEPOSUNDA BULUNDU ✅ (Node.js Trust Store)';
                        } else {
                            cDetails.ocspResult = 'Zincir Sonu Eksik (OS Güvenine Bırakıldı) ⚠️';
                        }
                    } 
                    else if (this.ocspModule) {
                        try {
                            const reqDer = this.ocspModule.buildOCSPRequest(cDetails.certDer, issuerCert.certDer, 'sha1');
                            const respDer = await this.ocspModule.requestOCSP(cDetails.ocspUrl, reqDer);
                            const parsedResp = this.ocspModule.parseOCSPResponse(respDer);
                            
                            if (parsedResp.certStatus === 'good') {
                                cDetails.ocspResult = `GOOD ✅ (Güncelleme: ${this._formatASN1Date(parsedResp.thisUpdate)})`;
                            } else if (parsedResp.certStatus === 'revoked') {
                                cDetails.ocspResult = `REVOKED ❌ (Sertifika İptal Edilmiş!)`;
                                docOverallValid = false;
                            } else {
                                cDetails.ocspResult = `BİLİNMİYOR ⚠️ (${parsedResp.certStatus})`;
                                docOverallValid = false;
                            }
                        } catch (err) {
                            cDetails.ocspResult = `BAĞLANTI HATASI ❌ (${err.message})`;
                            docOverallValid = false;
                        }
                    }
                }

                print(` └─ ${typeStr} ${cDetails.shortName}`);
                print(`      Durum: ${cDetails.ocspResult}`);
            }
            print(``);
        }

        print(`>>> GENEL BELGE GEÇERLİLİK SONUCU: ${docOverallValid ? 'TAMAMEN GEÇERLİ VE GÜVENİLİR ✅' : 'DOĞRULAMA SORUNLARI VAR ❌'}`);
        print(`======================================================================\n`);

        return {
            isValid: docOverallValid,
            padesLevel: padesLevel,
            reportText: logs.join('\n')
        };
    }

    /**
     * @param {String} filePath - PDF dosyasının yolu
     * @returns {Promise<Object>}
     */
    async validateFile(filePath) {
        const buf = fs.readFileSync(filePath);
        return await this.validateBuffer(buf, filePath);
    }
}

module.exports = SignatureValidator;