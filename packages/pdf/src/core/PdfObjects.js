/**
 * Alt seviye PDF nesnelerini serileştiren (serialize) modül.
 * JS tiplerini, PDF spesifikasyonuna uygun string/byte dizilimlerine çevirir.
 */

class PdfObjects {
    /**
     * PDF Name objesi (Örn: "Type" -> "/Type")
     * @param {string} name 
     * @returns {string}
     */
    static name(name) {
        return `/${name}`;
    }

    /**
     * PDF Indirect Reference (Örn: id: 5 -> "5 0 R")
     * Başka bir objeye işaret eden referans (pointer) tipidir.
     * @param {number} objectId 
     * @param {number} [generation=0] - PDF 1.5+ itibariyle genelde 0'dır.
     * @returns {string}
     */
    static ref(objectId, generation = 0) {
        return `${objectId} ${generation} R`;
    }

    /**
     * PDF Literal String (Örn: "Test" -> "(Test)")
     * Parantez ve ters slash gibi PDF parser'ı bozan karakterler escape edilmelidir.
     * @param {string} text 
     * @returns {string}
     */
    static string(text) {
        // PDF spesifikasyonu gereği string içindeki kontrol karakterleri kaçış dizisine (escape sequence) çevrilmelidir.
        const escapedText = text
            .replace(/\\/g, '\\\\')
            .replace(/\(/g, '\\(')
            .replace(/\)/g, '\\)')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r');
        return `(${escapedText})`;
    }

    /**
     * PDF Hexadecimal String (Örn: "FF00AA" -> "<FF00AA>")
     * Genellikle CID font eşlemeleri ve binary veri gömmeleri için kullanılır.
     * @param {string} hex 
     * @returns {string}
     */
    static hexString(hex) {
        return `<${hex}>`;
    }

    /**
     * PDF Array (Örn: [1, 2, "Test"] -> "[1 2 (Test)]")
     * Dizi içindeki elemanlar halihazırda PDF formatına serileştirilmiş olmalıdır.
     * @param {Array<string|number>} items 
     * @returns {string}
     */
    static array(items) {
        return `[${items.join(' ')}]`;
    }

    /**
     * PDF Dictionary (Örn: { Type: "/Page", Parent: "2 0 R" } -> "<< /Type /Page /Parent 2 0 R >>")
     * PDF'in bel kemiğidir. Key'ler otomatik olarak "/Name" formatına çevrilir.
     * @param {Object} dictMap - Key-Value çiftleri
     * @returns {string}
     */
    static dict(dictMap) {
        let str = '<<\n';
        for (const [key, value] of Object.entries(dictMap)) {
            if (value === undefined || value === null) continue;
            str += `  /${key} ${value}\n`;
        }
        str += '>>';
        return str;
    }

    /**
     * Formatlanmış bir PDF Objeyi doğrudan PdfWriter'a yazar.
     * @param {import('./PdfWriter')} writer 
     * @param {number} objId 
     * @param {string} content 
     */
    static writeObject(writer, objId, content) {
        // C++ ile bellek adreslerine yazmak gibidir; objenin tam offset'ini yakalarız.
        writer.xrefTable.set(objId, writer.currentOffset);
        writer.writeString(`${objId} 0 obj\n`);
        writer.writeString(content);
        writer.writeString('\nendobj\n');
    }

    /**
     * Stream objesini dictionary header'ı ile birlikte PdfWriter'a yazar.
     * @param {import('./PdfWriter')} writer 
     * @param {number} objId 
     * @param {Object} dictMap - Stream'in dictionary'si (örn: Length, Filter)
     * @param {Buffer|string} streamData - Ham binary veya metin verisi
     */
    static writeStream(writer, objId, dictMap, streamData) {
        // Stream uzunluğu PDF parser'ları için hayati önem taşır.
        const buffer = Buffer.isBuffer(streamData) ? streamData : Buffer.from(streamData, 'binary');
        dictMap.Length = buffer.length;

        writer.xrefTable.set(objId, writer.currentOffset);
        writer.writeString(`${objId} 0 obj\n`);
        writer.writeString(this.dict(dictMap));
        writer.writeString('\nstream\n');
        writer.writeBuffer(buffer);
        writer.writeString('\nendstream\n');
        writer.writeString('endobj\n');
    }
}

module.exports = PdfObjects;