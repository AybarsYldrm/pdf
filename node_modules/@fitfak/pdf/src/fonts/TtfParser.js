const fs = require('fs');

/**
 * TrueType Font (.ttf) Binary Parser'ı.
 * Node.js Buffer API'sini kullanarak TTF yapısındaki (head, hhea, maxp, loca, glyf, cmap)
 * tabloları bit seviyesinde ayrıştırır ve Unicode->GlyphID haritalamasını yapar.
 */
class TtfParser {
    /**
     * @param {string} filePath - TTF dosyasının disk yolu
     */
    constructor(filePath) {
        // Font dosyasını tamamen RAM'e alıyoruz
        this.buffer = fs.readFileSync(filePath);
        this.offset = 0;
        this.tables = {};
        
        this.parse();
    }

    // --- Alt Seviye Buffer Okuma (Big-Endian) ---
    readUint8() {
        const val = this.buffer.readUInt8(this.offset);
        this.offset += 1;
        return val;
    }

    readUint16() {
        const val = this.buffer.readUInt16BE(this.offset);
        this.offset += 2;
        return val;
    }

    readUint32() {
        const val = this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return val;
    }

    readInt16() {
        const val = this.buffer.readInt16BE(this.offset);
        this.offset += 2;
        return val;
    }

    readString(length) {
        const str = this.buffer.toString('ascii', this.offset, this.offset + length);
        this.offset += length;
        return str;
    }

    // --- Parser Mantığı ---

    parse() {
        const version = this.readUint32();
        const numTables = this.readUint16();
        
        this.readUint16(); // searchRange
        this.readUint16(); // entrySelector
        this.readUint16(); // rangeShift

        // Tablo dizinini oku
        for (let i = 0; i < numTables; i++) {
            const tag = this.readString(4);
            const checkSum = this.readUint32();
            const offset = this.readUint32(); 
            const length = this.readUint32();

            this.tables[tag] = { offset, length, checkSum };
        }

        // Kritik tabloları ayrıştır
        this.head = this.parseHeadTable();
        this.hhea = this.parseHheaTable();
        this.hmtx = this.parseHmtxTable();
        
        // SİHİRLİ DOKUNUŞ: Çince sembol hatasını çözen Unicode haritasını ayrıştır!
        this.parseCmapTable();
    }

    parseHeadTable() {
        const table = this.tables['head'];
        if (!table) throw new Error("TTF'te 'head' tablosu bulunamadı.");
        
        this.offset = table.offset;
        this.offset += 18; 
        
        const unitsPerEm = this.readUint16(); 
        return { unitsPerEm };
    }

    parseHheaTable() {
        const table = this.tables['hhea'];
        if (!table) throw new Error("TTF'te 'hhea' tablosu bulunamadı.");

        this.offset = table.offset;
        this.offset += 4; 
        
        const ascender = this.readInt16(); 
        const descender = this.readInt16(); 
        const lineGap = this.readInt16();
        
        this.offset += 24; 
        const numberOfHMetrics = this.readUint16(); 

        return { ascender, descender, lineGap, numberOfHMetrics };
    }

    parseHmtxTable() {
        const table = this.tables['hmtx'];
        if (!table) throw new Error("TTF'te 'hmtx' tablosu bulunamadı.");

        this.offset = table.offset;
        const metrics = [];
        const numMetrics = this.hhea.numberOfHMetrics;

        for (let i = 0; i < numMetrics; i++) {
            const advanceWidth = this.readUint16();
            const leftSideBearing = this.readInt16();
            metrics.push({ advanceWidth, leftSideBearing });
        }
        return metrics;
    }

    /**
     * TTF CMAP Format 4 Tablosunu okur.
     * Agresif Tarama: Tüm alt tabloları gezer ve kesin olarak Format 4'ü bulur.
     */
    parseCmapTable() {
        const table = this.tables['cmap'];
        if (!table) return;

        this.offset = table.offset + 2; // version atla
        const numTables = this.readUint16();

        let targetOffset = -1;

        // Bütün alt tabloları tarayıp Format 4'ü buluyoruz
        for (let i = 0; i < numTables; i++) {
            this.readUint16(); // platformId atla
            this.readUint16(); // encodingId atla
            const subOffset = this.readUint32();

            const currentPos = this.offset; // Döngüye dönmek için konumu kaydet

            this.offset = table.offset + subOffset;
            const format = this.readUint16();

            if (format === 4) {
                targetOffset = table.offset + subOffset;
                break; // Format 4'ü bulduk, çık!
            }

            this.offset = currentPos; // Konumu geri yükle ve sonrakine geç
        }

        if (targetOffset === -1) return; // Bulunamazsa iptal et

        this.offset = targetOffset;
        this.readUint16(); // format (4)
        this.offset += 4; // length, language atla
        const segCount = this.readUint16() / 2;
        this.offset += 6; // searchRange, entrySelector, rangeShift atla

        const endCodes = [];
        for (let i = 0; i < segCount; i++) endCodes.push(this.readUint16());
        this.offset += 2; // reservedPad atla

        const startCodes = [];
        for (let i = 0; i < segCount; i++) startCodes.push(this.readUint16());

        const idDeltas = [];
        for (let i = 0; i < segCount; i++) idDeltas.push(this.readInt16());

        const idRangeOffsetsPos = this.offset;
        const idRangeOffsets = [];
        for (let i = 0; i < segCount; i++) idRangeOffsets.push(this.readUint16());

        this.cmap4 = { segCount, endCodes, startCodes, idDeltas, idRangeOffsets, idRangeOffsetsPos };
    }

    /**
     * Unicode (charCode) değerine karşılık gelen gerçek Glyph ID'sini bulur.
     */
    getGlyphId(charCode) {
        if (!this.cmap4) return 0; // HATA DURUMUNDA ASCII DÖNMESİN, 0 DÖNSÜN!

        for (let i = 0; i < this.cmap4.segCount; i++) {
            if (charCode <= this.cmap4.endCodes[i] && charCode >= this.cmap4.startCodes[i]) {
                if (this.cmap4.idRangeOffsets[i] === 0) {
                    return (charCode + this.cmap4.idDeltas[i]) & 0xFFFF;
                } else {
                    const offset = this.cmap4.idRangeOffsetsPos + (i * 2) + this.cmap4.idRangeOffsets[i] + ((charCode - this.cmap4.startCodes[i]) * 2);
                    const glyphIndex = this.buffer.readUInt16BE(offset);
                    return glyphIndex !== 0 ? (glyphIndex + this.cmap4.idDeltas[i]) & 0xFFFF : 0;
                }
            }
        }
        return 0;
    }

    /**
     * Bir karakterin (Glyph ID) genişliğini PDF point cinsinden hesaplar.
     */
    getGlyphWidth(glyphId, fontSize) {
        const metricIndex = Math.min(glyphId, this.hmtx.length - 1);
        const advanceWidth = this.hmtx[metricIndex].advanceWidth;
        return (advanceWidth / this.head.unitsPerEm) * fontSize;
    }

    /**
     * TextEngine tarafından metinlerin genişliğini ölçmek için çağrılan metot.
     */
    measureText(text, fontSize) {
        let totalWidth = 0;
        for (let i = 0; i < text.length; i++) {
            const charCode = text.charCodeAt(i);
            // ARTIK SAHTE ID DEĞİL, GERÇEK CMAP GLYPH ID'Sİ KULLANILIYOR!
            const glyphId = this.getGlyphId(charCode); 
            totalWidth += this.getGlyphWidth(glyphId, fontSize);
        }
        return totalWidth;
    }

    /**
     * PDF Spesifikasyonu için karakter genişlik dizisini (W Array) üretir.
     * Bu metot sayesinde PDF'te harfler arasındaki devasa boşluklar ve sağa taşmalar yok olur!
     */
    getPdfWidths() {
        let wArray = '[ 0 [ ';
        
        // Fonttaki ilk 1000 Glyph'in genişlik haritasını çıkarıyoruz (çoğu Latin/Türkçe fontu kapsar)
        const limit = Math.min(this.hmtx.length, 1000);
        for (let i = 0; i < limit; i++) {
            const advanceWidth = this.hmtx[i].advanceWidth;
            // TTF genişliğini PDF'in 1000'lik sistemine (PDF standardı) orantıla
            const pdfWidth = Math.round((advanceWidth / this.head.unitsPerEm) * 1000);
            wArray += `${pdfWidth} `;
        }
        
        wArray += '] ]';
        return wArray;
    }
}

module.exports = TtfParser;