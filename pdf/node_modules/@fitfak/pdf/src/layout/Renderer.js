/**
 * Render Motoru.
 * Sanal layout ağacını (Top-Down) alır, PDF Content Stream komutlarına (Bottom-Up) çevirir.
 * PDF Graphics State (q, Q) yönetimini yapar.
 */
class Renderer {
    /**
     * @param {import('../core/Document')} document - Çıktının yazılacağı ana Document objesi
     * @param {import('./Paginator')} paginator - Sayfalara bölünmüş veri ağacı
     * @param {Map} fonts - Sisteme yüklenmiş fontlar
     * @param {Map} images - Sisteme yüklenmiş resimler
     */
    constructor(document, paginator, fonts, images) {
        this.document = document;
        this.paginator = paginator;
        // index.js'ten gelen font ve resim Map'leri
        this.fonts = fonts || new Map();
        this.images = images || new Map();
        
        this.pageHeight = paginator.format.height;
        this.pageWidth = paginator.format.width;
    }

    /**
     * RGB (0-255) değerlerini PDF renk uzayına (0.0 - 1.0) dönüştürür.
     */
    _colorToPdf(rgb) {
        return `${(rgb[0] / 255).toFixed(3)} ${(rgb[1] / 255).toFixed(3)} ${(rgb[2] / 255).toFixed(3)}`;
    }

    /**
     * Metinleri UTF-16 Hex formatına dönüştürür.
     * DİKKAT: Identity-H için Unicode değerleri değil, Glyph ID'ler (CID) HEX'e çevrilmelidir!
     */
    _encodeToHex(text, fontParser) {
        let hex = '';
        for (let i = 0; i < text.length; i++) {
            const charCode = text.charCodeAt(i);
            
            // TTF içinden karakterin gerçek Glyph ID'sini bul
            const glyphId = fontParser.getGlyphId(charCode);
            
            // Glyph ID'yi 4 haneli HEX string'e çevir
            hex += glyphId.toString(16).padStart(4, '0').toUpperCase();
        }
        return `<${hex}>`;
    }

    async renderAll() {
        const pages = this.paginator.getPages();
        const PdfObjects = require('../core/PdfObjects');

        // YENİ: Dökümandaki tüm resimleri XObject sözlüğü için hazırla
        const xObjectsDict = {};
        for (const [src, imgData] of this.images.entries()) {
            if (imgData.embeddedId) {
                // Kaynak adını /Img<ID> formatında atıyoruz (Örn: Img14)
                xObjectsDict[`Img${imgData.embeddedId}`] = PdfObjects.ref(imgData.embeddedId);
            }
        }

        for (const page of pages) {
            let contentStream = '';
            for (const item of page.items) {
                if (item.type === 'box') {
                    contentStream += this._renderBox(item);
                } else if (item.type === 'textChunk') {
                    contentStream += this._renderText(item);
                } else if (item.config && item.config.type === 'image') {
                    // YENİ: Resim render metodunu çağırıyoruz
                    contentStream += this._renderImage(item);
                }
            }
            
            // Oluşturulan sayfa komutlarını stream objesine çevir
            const streamId = this.document.addStream(contentStream);
            
            let f1Ref = null;
            if (this.fonts.size > 0) {
                const firstFontData = Array.from(this.fonts.values())[0];
                f1Ref = PdfObjects.ref(firstFontData.embeddedId);
            } else {
                const fallbackFontId = this.document.addDictionary({
                    Type: PdfObjects.name('Font'),
                    Subtype: PdfObjects.name('Type1'),
                    BaseFont: PdfObjects.name('Helvetica'),
                    Encoding: PdfObjects.name('WinAnsiEncoding')
                });
                f1Ref = PdfObjects.ref(fallbackFontId);
            }
            
            // Resources (Kaynaklar) sözlüğünü oluştur
            const resources = {
                Font: PdfObjects.dict({
                    F1: f1Ref
                })
            };

            // YENİ: Eğer sayfada/dökümanda resim varsa XObject (Resim Sözlüğü) olarak ekle
            if (Object.keys(xObjectsDict).length > 0) {
                resources.XObject = PdfObjects.dict(xObjectsDict);
            }

            const resourcesId = this.document.addDictionary(resources);
            
            // Sayfayı PDF ağacına ekle
            this.document.addPage(this.pageWidth, this.pageHeight, streamId, resourcesId);
        }
    }

    /**
     * Bir kutuyu (Arkaplan ve Kenarlıklar) çizer.
     */
    _renderBox(boxNode) {
        let stream = 'q\n';
        
        // 1. Koordinat Çevirimi (Top-Left -> Bottom-Left)
        const pdfY = this.pageHeight - boxNode.absoluteY - boxNode.height;

        // 2. Arkaplan Rengi (Non-Stroking Color -> rg)
        if (boxNode.backgroundColor) {
            stream += `${this._colorToPdf(boxNode.backgroundColor)} rg\n`;
            stream += `${boxNode.absoluteX.toFixed(2)} ${pdfY.toFixed(2)} ${boxNode.width.toFixed(2)} ${boxNode.height.toFixed(2)} re\n`;
            stream += `f\n`; 
        }

        // 3. Çerçeve (Stroking Color -> RG ve Line Width -> w)
        if (boxNode.borderColor && boxNode.borderWidth > 0) {
            stream += `${this._colorToPdf(boxNode.borderColor)} RG\n`;
            stream += `${boxNode.borderWidth.toFixed(2)} w\n`;
            stream += `${boxNode.absoluteX.toFixed(2)} ${pdfY.toFixed(2)} ${boxNode.width.toFixed(2)} ${boxNode.height.toFixed(2)} re\n`;
            stream += `S\n`;
        }

        stream += 'Q\n'; 
        return stream;
    }

    _renderText(textChunk) {
        let stream = 'q\n';
        stream += 'BT\n';
                 
        const style = (textChunk.parentBox.config && textChunk.parentBox.config.style) ? textChunk.parentBox.config.style : {};
        const fontSize = style.fontSize || 12;
        const color = style.color || null;
        
        // Hangi fontun kullanıldığını bul
        const fontName = style.fontFamily || Array.from(this.fonts.keys())[0];
        const fontData = this.fonts.get(fontName);

        stream += `/F1 ${fontSize} Tf\n`;
        
        if (color) {
            stream += `${this._colorToPdf(color)} rg\n`;
        }
        
        for (const line of textChunk.lines) {
            // Y Koordinatı BaseLine'a göre ayarla
            const pdfY = this.pageHeight - (textChunk.absoluteY + line.yOffset + fontSize);
            
            // YENİ: Kutu başlangıç noktasına (absoluteX), satırın özel hizalama kaydırmasını (xOffset) ekle!
            const pdfX = textChunk.parentBox.absoluteX + (line.xOffset || 0);
            
            // Metni ilgili X, Y koordinatına taşı
            stream += `1 0 0 1 ${pdfX.toFixed(2)} ${pdfY.toFixed(2)} Tm\n`;
            
            // Metni Hex olarak çiz
            stream += `${this._encodeToHex(line.text, fontData.parser)} Tj\n`;
        }
        stream += 'ET\n';
        stream += 'Q\n';
                 
        return stream;
    }

    /**
     * Resimleri (XObject) PDF sayfasına çizer.
     */
    _renderImage(imageNode) {
        // Resmin gömülmüş ID'sini al
        const imgData = this.images.get(imageNode.config.src);
        if (!imgData || !imgData.embeddedId) return '';
        
        // Kaynak adı (Örn: /Img14)
        const resName = `/Img${imgData.embeddedId}`;
        
        // 1. Koordinat çevirimi (PDF'te resmin x,y koordinatı sol alt köşedir)
        const pdfY = this.pageHeight - imageNode.absoluteY - imageNode.height;
        const pdfX = imageNode.absoluteX;
        
        let stream = 'q\n';
        
        // 2. Transformation Matrix (cm): [ScaleX SkewY SkewX ScaleY TranslateX TranslateY] cm
        // PDF resimleri varsayılan olarak 1x1 nokta boyutundadır. Kendi genişlik ve 
        // yüksekliğimize göre scale (ölçekleme) yapıp ilgili x,y konumuna taşıyoruz.
        stream += `${imageNode.width.toFixed(2)} 0 0 ${imageNode.height.toFixed(2)} ${pdfX.toFixed(2)} ${pdfY.toFixed(2)} cm\n`;
        
        // 3. Do (Draw Object) komutu ile resmi belirtilen matrisin içine bas
        stream += `${resName} Do\n`;
        
        stream += 'Q\n';
        
        return stream;
    }
}

module.exports = Renderer;