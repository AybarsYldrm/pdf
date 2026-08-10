/**
 * Metin İşleme ve Tipografi Motoru.
 * Word-wrapping (kelime kaydırma), satır yüksekliği ve hizalama (text-align) işlemlerini yapar.
 */
class TextEngine {
    /**
     * @typedef {Object} TextLine
     * @property {string} text - Satırdaki metin
     * @property {number} width - Satırın PDF points cinsinden genişliği
     * @property {number} yOffset - Satırın kutu içindeki dikey Y konumu
     */

    /**
     * Verilen metni, kutu genişliğine ve font metriklerine göre satırlara böler.
     * @param {string} text - İşlenecek ham metin
     * @param {Object} font - Font objesi (Genişlik ölçümü için 'measureText' metoduna sahip olmalı)
     * @param {number} fontSize - Font boyutu (pt)
     * @param {number} maxWidth - Satırın taşmaması gereken maksimum genişlik
     * @param {number} lineHeight - Satır yüksekliği çarpanı (örn: 1.2 veya 1.5)
     * @returns {TextLine[]} - Hesaplanmış satırların dizisi
     */
    static wordWrap(text, font, fontSize, maxWidth, lineHeight = 1.2) {
        const lines = [];
        // Kullanıcı tarafından manuel atılan alt satırları ( \n ) koru
        const paragraphs = text.split('\n');
        
        let currentYOffset = 0;
        const lineSpacing = fontSize * lineHeight;

        for (const paragraph of paragraphs) {
            const words = paragraph.split(' ');
            let currentLine = '';

            for (let i = 0; i < words.length; i++) {
                const word = words[i];
                
                // Eğer satır boşsa, direkt kelimeyi ekle
                const testLine = currentLine.length === 0 ? word : `${currentLine} ${word}`;
                
                // MÜHENDİSLİK DETAYI: Her harfin genişliği farklıdır ('W' ile 'i' aynı boyutta değildir).
                // Font objesindeki glyph mapping kullanılarak gerçek genişlik hesaplanır.
                const testWidth = font.measureText(testLine, fontSize);

                if (testWidth > maxWidth && currentLine.length > 0) {
                    // Sınırı aştık! Mevcut satırı kaydet, test edilen kelimeyi yeni satıra at.
                    lines.push({
                        text: currentLine,
                        width: font.measureText(currentLine, fontSize),
                        yOffset: currentYOffset
                    });
                    
                    currentLine = word; // Yeni satır bu kelimeyle başlıyor
                    currentYOffset += lineSpacing; // Y koordinatını bir satır aşağı it
                } else {
                    // Sınıra ulaşmadık, kelimeyi mevcut satıra ekleyerek devam et
                    currentLine = testLine;
                }
            }

            // Paragrafın sonunda elde kalan son satırı ekle
            if (currentLine.length > 0) {
                lines.push({
                    text: currentLine,
                    width: font.measureText(currentLine, fontSize),
                    yOffset: currentYOffset
                });
                currentYOffset += lineSpacing;
            }
        }

        return lines;
    }

    /**
     * Satırların "text-align" özelliğine göre X başlangıç koordinatlarını hesaplar.
     * @param {TextLine[]} lines - wordWrap'ten dönen satır dizisi
     * @param {number} boxWidth - İçinde bulunulan kutunun toplam genişliği
     * @param {string} alignment - 'left', 'center', 'right', 'justify'
     * @returns {Array<{text: string, x: number, y: number}>} PDF'e basılmaya hazır koordinatlı nesneler
     */
    static alignLines(lines, boxWidth, alignment = 'left') {
        return lines.map(line => {
            let xOffset = 0;

            switch (alignment) {
                case 'center':
                    // Kalan boşluğu ikiye böl
                    xOffset = (boxWidth - line.width) / 2;
                    break;
                case 'right':
                    // Tamamen sağa daya
                    xOffset = boxWidth - line.width;
                    break;
                case 'left':
                case 'justify':
                    // Justify mantığı (boşlukların arasını açma) rendering aşamasında Tw/Tc 
                    // (Word Spacing / Character Spacing) operatörleriyle yapılır. X başlangıcı left ile aynıdır.
                    xOffset = 0;
                    break;
            }

            return {
                text: line.text,
                x: Math.max(0, xOffset), // Negatif xOffset olmaması için güvenlik (Taşan kelimeler)
                y: line.yOffset
            };
        });
    }
}

module.exports = TextEngine;