const PdfWriter = require('./PdfWriter');
const PdfObjects = require('./PdfObjects');
const XrefBuilder = require('./XrefBuilder');

/**
 * PDF Hiyerarşisini (Catalog, Pages Tree, Info) yöneten ana sınıf.
 */
class Document {
    constructor(filePath, metadata = {}) {
        this.writer = new PdfWriter(filePath);
        this.catalogId = this.writer.objectIdCounter++;
        this.pagesRootId = this.writer.objectIdCounter++;
        this.pages = [];
        this.metadata = metadata;
        
        // Şifreleme Modülü Referansı
        this.encryptor = null; 
    }

    /**
     * Şifreleme motorunu Document sınıfına bağlar.
     * @param {import('../security/Encryptor')} encryptor 
     */
    setEncryptor(encryptor) {
        this.encryptor = encryptor;
    }

    addDictionary(dictMap) {
        const objId = this.writer.startObject();
        this.writer.writeString(PdfObjects.dict(dictMap));
        this.writer.endObject();
        return objId;
    }

    addStream(data, dictMap = {}) {
        const objId = this.writer.startObject();
        let buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary');

        // MÜHENDİSLİK DETAYI: Eğer şifreleme aktifse, stream diske yazılmadan önce 
        // kendi Obje ID'si (objId) ile AES-256 algoritmasından geçirilir.
        if (this.encryptor) {
            buffer = this.encryptor.encryptStream(buffer, objId);
        }

        PdfObjects.writeStream(this.writer, objId, dictMap, buffer);
        return objId;
    }

    addPage(width, height, contentStreamId, resourcesId) {
        const pageId = this.writer.startObject();
        const mediaBox = `[0 0 ${width} ${height}]`;
        
        const pageDict = {
            Type: PdfObjects.name('Page'),
            Parent: PdfObjects.ref(this.pagesRootId),
            MediaBox: mediaBox,
            Contents: PdfObjects.ref(contentStreamId),
            Resources: PdfObjects.ref(resourcesId)
        };

        this.writer.writeString(PdfObjects.dict(pageDict));
        this.writer.endObject();
        
        this.pages.push(PdfObjects.ref(pageId));
        return pageId;
    }

    async end() {
        // 1. Pages Tree
        this.writer.xrefTable.set(this.pagesRootId, this.writer.getCurrentOffset());
        this.writer.writeString(`${this.pagesRootId} 0 obj\n`);
        this.writer.writeString(PdfObjects.dict({
            Type: PdfObjects.name('Pages'),
            Count: this.pages.length,
            Kids: PdfObjects.array(this.pages)
        }));
        this.writer.endObject();

        // 2. Catalog
        this.writer.xrefTable.set(this.catalogId, this.writer.getCurrentOffset());
        this.writer.writeString(`${this.catalogId} 0 obj\n`);
        this.writer.writeString(PdfObjects.dict({
            Type: PdfObjects.name('Catalog'),
            Pages: PdfObjects.ref(this.pagesRootId)
        }));
        this.writer.endObject();
 
        // 3. Metadata (Info) 
        let infoId = null;
        if (Object.keys(this.metadata).length > 0) {
            infoId = this.writer.objectIdCounter++;
            this.writer.xrefTable.set(infoId, this.writer.getCurrentOffset());
            this.writer.writeString(`${infoId} 0 obj\n`);
            
            const infoDict = {};
            for (const [key, value] of Object.entries(this.metadata)) {
                // PDF BAŞLIKLARI İÇİNDEKİ (ı, ş, ğ) SORUNUNU ÇÖZEN HEX BOM (FEFF) ÇEVİRİMİ
                let hex = 'FEFF';
                for (let i = 0; i < value.length; i++) {
                    hex += value.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
                }
                const unicodeHex = `<${hex}>`;
                
                infoDict[key] = this.encryptor ? this.encryptor.encryptString(value, infoId) : unicodeHex;
            }
            
            infoDict.Producer = PdfObjects.string('Native Node.js PDF Engine');
            const dateStr = `D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
            infoDict.CreationDate = PdfObjects.string(dateStr);
            
            this.writer.writeString(PdfObjects.dict(infoDict));
            this.writer.endObject();
        }

        // 4. Encrypt Sözlüğü (Şifreleme ayarlarını PDF'e gömme)
        let encryptId = null;
        if (this.encryptor) {
            encryptId = this.writer.objectIdCounter++;
            this.writer.xrefTable.set(encryptId, this.writer.getCurrentOffset());
            this.writer.writeString(`${encryptId} 0 obj\n`);
            this.writer.writeString(PdfObjects.dict(this.encryptor.getEncryptionDictionary()));
            this.writer.endObject();
        }

        // 5. Final: XREF ve Trailer (Şifreleme objesi ve Document ID parametreleri ile)
        const documentIdArray = this.encryptor ? this.encryptor.getDocumentIdArray() : null;
        XrefBuilder.writeXrefAndTrailer(this.writer, this.catalogId, infoId, encryptId, documentIdArray);
        
        await this.writer.close();
    }
}

module.exports = Document;