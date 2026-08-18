const crypto = require('crypto');
const PdfObjects = require('../core/PdfObjects');

// PDF Standardı 32-Byte Padding (Doldurma) Dizisi
const PADDING = Buffer.from([
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41,
    0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
    0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80,
    0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A
]);

function rc4(key, data) {
    const S = new Uint8Array(256);
    for (let i = 0; i < 256; i++) S[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
        j = (j + S[i] + key[i % key.length]) % 256;
        const temp = S[i]; S[i] = S[j]; S[j] = temp;
    }
    let i = 0; j = 0;
    const out = Buffer.alloc(data.length);
    for (let y = 0; y < data.length; y++) {
        i = (i + 1) % 256;
        j = (j + S[i]) % 256;
        const temp = S[i]; S[i] = S[j]; S[j] = temp;
        out[y] = data[y] ^ S[(S[i] + S[j]) % 256];
    }
    return out;
}

function md5(data) { return crypto.createHash('md5').update(data).digest(); }

function padPassword(pwd) {
    const buf = Buffer.alloc(32);
    const pwdBuf = Buffer.from(pwd || '', 'latin1');
    pwdBuf.copy(buf, 0, 0, Math.min(pwdBuf.length, 32));
    if (pwdBuf.length < 32) PADDING.copy(buf, pwdBuf.length, 0, 32 - pwdBuf.length);
    return buf;
}

class Encryptor {
    // DÜZELTME: documentId parametresini dışarıdan (Document.js'den) alıyoruz!
    constructor(userPassword = '', ownerPassword = '', permissions = { print: true, copy: false, modify: false }, documentId = null) {
        this.userPassword = userPassword;
        this.ownerPassword = ownerPassword || crypto.randomBytes(16).toString('hex');
        
        this.encryptionKeyLength = 16; 
        this.permissionFlags = this._calculatePermissions(permissions);
        
        // Eğer dışarıdan ID gelmediyse yeni üret (Ancak index.js bunu her zaman verecek)
        this.documentId = documentId || crypto.randomBytes(16); 

        this.oValue = this._computeOValue();
        this.encryptionKey = this._computeEncryptionKey();
        this.uValue = this._computeUValue();
    }

    _calculatePermissions(perms) {
        let flags = -4; 
        if (!perms.print) flags &= ~(1 << 2);   
        if (!perms.modify) flags &= ~(1 << 3);  
        if (!perms.copy) flags &= ~(1 << 4);    
        return flags;
    }

    _computeOValue() {
        const ownerPad = padPassword(this.ownerPassword);
        const userPad = padPassword(this.userPassword);
        
        let hash = md5(ownerPad);
        for (let i = 0; i < 50; i++) hash = md5(hash);
        
        const rc4Key = hash.subarray(0, 16);
        let encrypted = rc4(rc4Key, userPad);
        
        for (let i = 1; i <= 19; i++) {
            const newKey = Buffer.alloc(16);
            for (let k = 0; k < 16; k++) newKey[k] = rc4Key[k] ^ i;
            encrypted = rc4(newKey, encrypted);
        }
        return encrypted; 
    }

    _computeEncryptionKey() {
        const userPad = padPassword(this.userPassword);
        const pBuffer = Buffer.alloc(4);
        pBuffer.writeInt32LE(this.permissionFlags, 0);

        const hash = crypto.createHash('md5');
        hash.update(userPad);
        hash.update(this.oValue);
        hash.update(pBuffer);
        hash.update(this.documentId); // İşte Acrobat'ın çökmesine neden olan o eşsiz ID
        
        let res = hash.digest();
        for (let i = 0; i < 50; i++) res = md5(res.subarray(0, 16));
        return res.subarray(0, 16);
    }

    _computeUValue() {
        const hash = crypto.createHash('md5');
        hash.update(PADDING);
        hash.update(this.documentId);
        const h = hash.digest();

        let encrypted = rc4(this.encryptionKey, h);
        for (let i = 1; i <= 19; i++) {
            const newKey = Buffer.alloc(16);
            for (let k = 0; k < 16; k++) newKey[k] = this.encryptionKey[k] ^ i;
            encrypted = rc4(newKey, encrypted);
        }
        return Buffer.concat([encrypted, Buffer.alloc(16, 0)]);
    }

    _getObjectKey(objectId, generationNum = 0) {
        const objKey = Buffer.alloc(this.encryptionKeyLength + 5);
        this.encryptionKey.copy(objKey, 0);
        
        objKey[this.encryptionKeyLength] = objectId & 0xFF;
        objKey[this.encryptionKeyLength + 1] = (objectId >> 8) & 0xFF;
        objKey[this.encryptionKeyLength + 2] = (objectId >> 16) & 0xFF;
        objKey[this.encryptionKeyLength + 3] = generationNum & 0xFF;
        objKey[this.encryptionKeyLength + 4] = (generationNum >> 8) & 0xFF;
        
        const salt = Buffer.from([0x73, 0x41, 0x6C, 0x54]); // 'sAlT'
        return crypto.createHash('md5').update(objKey).update(salt).digest().subarray(0, 16);
    }

    encryptString(text, objectId) {
        const objectKey = this._getObjectKey(objectId);
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-128-cbc', objectKey, iv);
        
        // Metinleri AES standartlarında Buffer'a alıyoruz
        let hex = 'FEFF';
        for (let i = 0; i < text.length; i++) {
            hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
        }
        const textBuffer = Buffer.from(hex, 'hex');
        
        const encryptedData = Buffer.concat([cipher.update(textBuffer), cipher.final()]);
        const finalBuf = Buffer.concat([iv, encryptedData]);
        
        return `<${finalBuf.toString('hex').toUpperCase()}>`;
    }

    encryptStream(streamData, objectId) {
        const objectKey = this._getObjectKey(objectId);
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-128-cbc', objectKey, iv);
        const encryptedData = Buffer.concat([cipher.update(streamData), cipher.final()]);
        return Buffer.concat([iv, encryptedData]);
    }

    getEncryptionDictionary() {
        return {
            Filter: PdfObjects.name('Standard'),
            V: 4, 
            R: 4,
            Length: 128,
            CF: PdfObjects.dict({
                StdCF: PdfObjects.dict({
                    CFM: PdfObjects.name('AESV2'),
                    AuthEvent: PdfObjects.name('DocOpen')
                })
            }),
            StmF: PdfObjects.name('StdCF'), 
            StrF: PdfObjects.name('StdCF'), 
            O: PdfObjects.hexString(this.oValue.toString('hex')),
            U: PdfObjects.hexString(this.uValue.toString('hex')),
            P: this.permissionFlags
        };
    }

    getDocumentIdArray() {
        const idHex = this.documentId.toString('hex').toUpperCase();
        return `[<${idHex}> <${idHex}>]`; 
    }
}

module.exports = Encryptor;