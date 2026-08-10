/**
 * ToUnicode CMap (Character Map) Üreticisi.
 * PDF içindeki Glyph ID'lerin (CID) gerçek Unicode karakterlere dönüştürülmesini sağlar.
 * Metinlerin seçilebilir (selectable), kopyalanabilir ve aranabilir (searchable) olması için zorunludur.
 */
class CMapBuilder {
    /**
     * @param {Map<number, number>} glyphToUnicodeMap - { GlyphID -> Unicode Kodu } haritası
     * @returns {string} PostScript formatında CMap akışı (Stream verisi)
     */
    static generate(glyphToUnicodeMap) {
        // PDF spesifikasyonuna uygun CMap Header (PostScript dili)
        let cmap = `%!PS-Adobe-3.0 Resource-CMap
%%DocumentNeededResources: ProcSet (CIDInit)
%%IncludeResource: ProcSet (CIDInit)
%%BeginResource: CMap (TeX)
%%Title: (TeX Adobe Identity 0)
%%Version: 1.000
%%EndComments
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo
<< /Registry (Adobe)
/Ordering (UCS)
/Supplement 0
>> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
`;

        // Map'i işlemek için diziye çeviriyoruz
        const mappings = Array.from(glyphToUnicodeMap.entries());

        // MÜHENDİSLİK DETAYI: PostScript (PDF okuyucularının çekirdek motoru),
        // bir "beginbfchar" (Begin Base Font Character) bloğunda maksimum 100 adet tanımlama
        // yapılmasına izin verir. Eğer 100'den fazla karakter gömüyorsak, bunu 100'erlik
        // bloklara (chunk) bölmek zorundayız. Aksi takdirde Acrobat Reader çöker veya metni bozabilir.
        
        const CHUNK_SIZE = 100;
        for (let i = 0; i < mappings.length; i += CHUNK_SIZE) {
            const chunk = mappings.slice(i, i + CHUNK_SIZE);
            
            cmap += `${chunk.length} beginbfchar\n`;
            
            for (const [glyphId, unicode] of chunk) {
                // Değerler 4 haneli Hex (16'lık taban) formatına (Zero-padded) çevrilmeli.
                // Örnek: Glyph ID 45 -> <002D>, Unicode 'ş' (351) -> <015F>
                const hexGlyph = glyphId.toString(16).toUpperCase().padStart(4, '0');
                const hexUnicode = unicode.toString(16).toUpperCase().padStart(4, '0');
                
                // <GlyphID> <Unicode> eşleşmesi
                cmap += `<${hexGlyph}> <${hexUnicode}>\n`;
            }
            
            cmap += `endbfchar\n`;
        }

        // CMap Footer
        cmap += `endcmap
CMapName currentdict /CMap defineresource pop
end
end
%%EndResource
%%EOF`;

        return cmap;
    }
}

module.exports = CMapBuilder;