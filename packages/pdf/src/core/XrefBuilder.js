/**
 * Cross-Reference (XREF) tablosunu ve Trailer bölümünü oluşturan modül.
 */
class XrefBuilder {
    /**
     * XREF tablosunu ve Trailer'ı byte hassasiyetinde yazar.
     */
    static writeXrefAndTrailer(writer, rootObjectId, infoObjectId = null, encryptObjectId = null, documentIdArray = null) {
        const startXrefOffset = writer.getCurrentOffset();
        const objectCount = writer.getObjectCount();
        const xrefTable = writer.getXrefTable();

        writer.writeString("xref\n");
        writer.writeString(`0 ${objectCount}\n`);
        
        // SİHİRLİ DOKUNUŞ 1: 'f' ve 'n' harflerinden sonraki boşluğu (space) siliyoruz! 
        // Tam 20 byte (10 + 1 + 5 + 1 + 1 + 2) olmak ZORUNDA.
        writer.writeString("0000000000 65535 f\r\n");

        for (let i = 1; i < objectCount; i++) {
            const offset = xrefTable.get(i);
            if (offset !== undefined) {
                const paddedOffset = offset.toString().padStart(10, '0');
                // SİHİRLİ DOKUNUŞ 2: 'n' harfinden sonraki boşluk silindi.
                writer.writeString(`${paddedOffset} 00000 n\r\n`);
            } else {
                writer.writeString("0000000000 65535 f\r\n");
            }
        }

        // Trailer Dictionary
        writer.writeString("trailer\n");
        writer.writeString("<<\n");
        writer.writeString(`  /Size ${objectCount}\n`);
        writer.writeString(`  /Root ${rootObjectId} 0 R\n`);
        
        if (infoObjectId) {
            writer.writeString(`  /Info ${infoObjectId} 0 R\n`);
        }
        
        // MÜHENDİSLİK DETAYI: Şifreleme aktifse PDF okuyucuya bunu Trailer'dan bildirmeliyiz.
        if (encryptObjectId) {
            writer.writeString(`  /Encrypt ${encryptObjectId} 0 R\n`);
        }
        
        if (documentIdArray) {
            writer.writeString(`  /ID ${documentIdArray}\n`);
        }
        
        writer.writeString(">>\n");

        writer.writeString("startxref\n");
        writer.writeString(`${startXrefOffset}\n`);
        writer.writeString("%%EOF\n");
    }
}

module.exports = XrefBuilder;