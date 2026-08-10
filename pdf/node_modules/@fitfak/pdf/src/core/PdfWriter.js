const fs = require('fs');

/**
 * Native PDF yazma motoru.
 * Belleği şişirmemek için fs.WriteStream kullanır ve byte offset takibi yapar.
 */
class PdfWriter {
    /**
     * @param {string} filePath - PDF dosyasının kaydedileceği yol
     */
    constructor(filePath) {
        // highWaterMark: 64KB ideal bir chunk boyutudur. Bellek taşmasını engeller.
        this.stream = fs.createWriteStream(filePath, { highWaterMark: 64 * 1024 });
        
        this.currentOffset = 0;
        this.xrefTable = new Map(); // Kilit nokta: { objectId -> byte offset }
        this.objectIdCounter = 1;

        // PDF Header'ı başlat
        this._writeHeader();
    }

    /**
     * PDF Header ve Binary Marker yazımı.
     * @private
     */
    _writeHeader() {
        this.writeString("%PDF-1.7\n");
        // PDF spesifikasyon kuralı: Dosyanın binary içerdiğini reader'lara bildirmek için
        // ASCII tablosunda 127'den büyük rastgele 4 byte eklenmelidir.
        // Bu adım atlanırsa, bazı reader'lar (özellikle Acrobat) dosyayı corrupt sanabilir.
        this.writeBuffer(Buffer.from([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])); // %âãÏÓ\n
    }

    /**
     * Raw Buffer yazar ve offset'i günceller.
     * Binary veriler (Görsel, Font, Sıkıştırılmış Stream) için kullanılır.
     * @param {Buffer} buffer 
     */
    writeBuffer(buffer) {
        this.stream.write(buffer);
        this.currentOffset += buffer.length;
    }

    /**
     * String yazar ve offset'i günceller.
     * PDF komutları (Dictionary, komutlar) için kullanılır.
     * @param {string} str 
     */
    writeString(str) {
        // PDF objeleri binary-safe olmalıdır, bu yüzden 'binary' encoding kullanılır.
        const buf = Buffer.from(str, 'binary');
        this.writeBuffer(buf);
    }

    /**
     * Yeni bir PDF objesi (örn: 1 0 obj) başlatır.
     * @returns {number} Oluşturulan objenin ID'si
     */
    startObject() {
        const objId = this.objectIdCounter++;
        
        // Objenin başladığı tam byte offset'ini XREF tablosu için kaydediyoruz
        this.xrefTable.set(objId, this.currentOffset);
        
        this.writeString(`${objId} 0 obj\n`);
        return objId;
    }

    /**
     * Mevcut PDF objesini kapatır.
     */
    endObject() {
        this.writeString("\nendobj\n");
    }

    // --- Getter Metotları (XrefBuilder tarafından kullanılacak) ---

    getXrefTable() {
        return this.xrefTable;
    }

    getCurrentOffset() {
        return this.currentOffset;
    }

    getObjectCount() {
        return this.objectIdCounter;
    }

    /**
     * Stream'i güvenli bir şekilde kapatır ve dosyanın diske yazılmasını bekler.
     * @returns {Promise<void>}
     */
    close() {
        return new Promise((resolve, reject) => {
            this.stream.end();
            this.stream.on('finish', resolve);
            this.stream.on('error', reject);
        });
    }
}

module.exports = PdfWriter;