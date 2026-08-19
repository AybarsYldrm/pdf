'use strict';

/**
 * PDF belgesinin içine XML dosyasını 'EmbeddedFile' (Ek Dosya) olarak gömer.
 * Bu işlem %100 Native PDF Incremental Update yöntemiyle yapılır.
 */
function embedXmlToPdf(pdfBuffer, xmlBuffer, filename = 'signed.xml') {
    const pdfStr = pdfBuffer.toString('latin1');

    // 1. Trailer ve Root Objesini Bul (Son xref ve traileri tararız)
    const trailerMatches = [...pdfStr.matchAll(/trailer\s*<<([\s\S]+?)>>/g)];
    if (trailerMatches.length === 0) throw new Error("PDF Trailer bulunamadı.");
    const lastTrailer = trailerMatches[trailerMatches.length - 1][1];

    const rootMatch = lastTrailer.match(/\/Root\s+(\d+)\s+0\s+R/);
    const sizeMatch = lastTrailer.match(/\/Size\s+(\d+)/);
    if (!rootMatch || !sizeMatch) throw new Error("PDF yapısı okunamadı (Root/Size eksik).");

    const rootObjNum = parseInt(rootMatch[1]);
    const size = parseInt(sizeMatch[1]);
    let nextObjNum = size; // Yeni objeler bu numaradan başlayacak

    // 2. Catalog (Root) objesinin mevcut içeriğini bul
    const catalogRegex = new RegExp(`(?:^|\\n)\\s*${rootObjNum}\\s+0\\s+obj\\s*<<([\\s\\S]+?)>>\\s*endobj`);
    const catalogMatch = pdfStr.match(catalogRegex);
    if (!catalogMatch) throw new Error("Catalog objesi bulunamadı (ObjStm ile sıkıştırılmış olabilir).");

    // Varsa eski Names dizinini temizle ki çakışma olmasın
    let catalogContent = catalogMatch[1].replace(/\/Names\s+\d+\s+0\s+R/g, '').trim();

    // --- INCREMENTAL UPDATE İNŞASI BAŞLIYOR ---
    let currentOffset = pdfBuffer.length;
    const chunks = [pdfBuffer];
    const newXrefEntries = [];

    // Saf Buffer Manipülasyonu ile Yeni Obje Ekleme (Dosya bozulmasını engeller)
    const addObj = (objNum, dictStr, streamBuffer = null) => {
        newXrefEntries.push({ objNum, offset: currentOffset });
        const head = Buffer.from(`\n${objNum} 0 obj\n${dictStr}\n`, 'latin1');
        const tail = Buffer.from('\nendobj\n', 'latin1');
        
        let data;
        if (streamBuffer) {
            // PDF standartlarına göre stream başı ve sonu
            data = Buffer.concat([
                head, 
                Buffer.from('stream\n', 'latin1'), 
                streamBuffer, 
                Buffer.from('\nendstream', 'latin1'), 
                tail
            ]);
        } else {
            data = Buffer.concat([head, tail]);
        }
        chunks.push(data);
        currentOffset += data.length;
    };

    // 3. Ekli Dosyanın Akışı (EmbeddedFile Stream - XML verisi)
    const streamObjNum = nextObjNum++;
    const streamHeader = `<< /Type /EmbeddedFile /Subtype /application#2Fxml /Length ${xmlBuffer.length} >>`;
    addObj(streamObjNum, streamHeader, xmlBuffer);

    // 4. Dosya Özellikleri (Filespec Dictionary)
    const filespecObjNum = nextObjNum++;
    const filespecStr = `<< /Type /Filespec /F (${filename}) /UF (${filename}) /EF << /F ${streamObjNum} 0 R /UF ${streamObjNum} 0 R >> /Desc (XAdES-T Imzali Tibbi Kayit) >>`;
    addObj(filespecObjNum, filespecStr);

    // 5. İsim Ağacı (Names Dictionary) - Adobe'un "Ekler" menüsünü tetikleyen asıl dizin!
    const namesObjNum = nextObjNum++;
    const namesStr = `<< /EmbeddedFiles << /Names [ (${filename}) ${filespecObjNum} 0 R ] >> >>`;
    addObj(namesObjNum, namesStr);

    // 6. Catalog (Root) Objesini Güncelle ve /Names düğümünü bağla
    const updatedCatalogStr = `<< ${catalogContent} /Names ${namesObjNum} 0 R >>`;
    addObj(rootObjNum, updatedCatalogStr);

    // 7. Yeni XREF (Çapraz Referans) Tablosu (Adobe'un aradığı harita)
    const startXref = currentOffset;
    let xrefStr = `\nxref\n`;
    
    // Obje numaralarını küçükten büyüğe sıralayalım (Katı Xref kuralı)
    newXrefEntries.sort((a, b) => a.objNum - b.objNum);
    
    for (const entry of newXrefEntries) {
        xrefStr += `${entry.objNum} 1\n`;
        // Xref satırı tam 20 byte olmak zorundadır. Format: "0000000000 00000 n \n"
        xrefStr += `${String(entry.offset).padStart(10, '0')} 00000 n \n`;
    }

    // 8. Yeni Trailer
    const prevStartXrefMatch = [...pdfStr.matchAll(/startxref\s+(\d+)/g)];
    const prevStartXref = prevStartXrefMatch.length > 0 ? prevStartXrefMatch[prevStartXrefMatch.length - 1][1] : 0;

    let trailerStr = `trailer\n<< /Size ${nextObjNum} /Root ${rootObjNum} 0 R /Prev ${prevStartXref} >>\n`;
    trailerStr += `startxref\n${startXref}\n%%EOF\n`;

    chunks.push(Buffer.from(xrefStr + trailerStr, 'latin1'));

    return Buffer.concat(chunks);
}

module.exports = { embedXmlToPdf };