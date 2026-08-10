/**
 * Sıfır Bağımlılık (Zero-Dependency) JPEG Binary Parser.
 * JPEG buffer'ını baştan tarayarak SOF (Start of Frame) bloklarını bulur;
 * Width, Height ve Color Space bilgilerini çıkarır.
 */
class JpegParser {
    /**
     * @param {Buffer} buffer - JPEG dosyasının ham binary verisi
     */
    constructor(buffer) {
        this.buffer = buffer;
        this.width = 0;
        this.height = 0;
        this.colorSpace = 'DeviceRGB'; // PDF Varsayılanı (1=DeviceGray, 3=DeviceRGB, 4=DeviceCMYK)
        this.bitsPerComponent = 8;
        
        this.parse();
    }

    /**
     * Buffer'ı parse edip metrikleri ayıklar.
     */
    parse() {
        // JPEG dosyaları her zaman 0xFF 0xD8 (SOI - Start of Image) ile başlar.
        if (this.buffer[0] !== 0xFF || this.buffer[1] !== 0xD8) {
            throw new Error('Geçersiz JPEG Formatı: Dosya 0xFFD8 ile başlamıyor.');
        }

        let offset = 2;

        while (offset < this.buffer.length) {
            // Marker her zaman 0xFF ile başlar
            if (this.buffer[offset] !== 0xFF) {
                // Eğer ardışık 0xFF değilse, byte padding olabilir, geç.
                offset++;
                continue;
            }

            // Marker tipi (Örn: 0xC0 -> SOF0, 0xE0 -> APP0)
            const marker = this.buffer[offset + 1];
            offset += 2; // Marker'ı (2 byte) atla

            // Eğer SOS (Start of Scan - 0xDA) marker'ına ulaştıysak, 
            // header bitmiş ve asıl resim verisi (pikseller) başlamış demektir.
            // Arama yapmayı durdur, çünkü aradığımızı bulamadıysak JPEG bozuktur.
            if (marker === 0xDA) {
                break;
            }

            // Segmentin uzunluğu (Kendi 2 byte'ı dahil)
            const length = this.buffer.readUInt16BE(offset);

            // 0xC0 (SOF0), 0xC1 (SOF1), 0xC2 (SOF2) marker'ları resmin boyutlarını barındırır.
            if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
                // Precision (Genelde 8 bit)
                this.bitsPerComponent = this.buffer[offset + 2];
                
                // Yükseklik (Height) ve Genişlik (Width) - Big Endian
                this.height = this.buffer.readUInt16BE(offset + 3);
                this.width = this.buffer.readUInt16BE(offset + 5);
                
                // Number of components (Renk Kanalı Sayısı: 1=Gri, 3=RGB, 4=CMYK)
                const colorComponents = this.buffer[offset + 7];
                
                if (colorComponents === 1) {
                    this.colorSpace = 'DeviceGray';
                } else if (colorComponents === 3) {
                    this.colorSpace = 'DeviceRGB';
                } else if (colorComponents === 4) {
                    this.colorSpace = 'DeviceCMYK';
                }

                // Aradığımız her şeyi bulduk, döngüden çıkabiliriz.
                // Binary'nin geri kalan MB'larca kısmını okuyup CPU yormaya gerek yok!
                break;
            }

            // Aradığımız marker bu değilse, segment uzunluğu kadar atla (Hızlı geçiş)
            offset += length;
        }

        if (!this.width || !this.height) {
            throw new Error('JPEG metrikleri bulunamadı (SOF marker eksik).');
        }
    }

    /**
     * Parse edilmiş JPG görselini doğrudan PDF Document objesine bir Stream olarak gömer.
     * @param {import('../core/Document')} document 
     * @returns {number} Oluşturulan PDF Image Objesinin (Stream) ID'si
     */
    embedToDocument(document) {
        // PDF spesifikasyonunda Image'lar aslında "XObject" türünde stream'lerdir.
        const imageDict = {
            Type: require('../core/PdfObjects').name('XObject'),
            Subtype: require('../core/PdfObjects').name('Image'),
            Width: this.width,
            Height: this.height,
            ColorSpace: require('../core/PdfObjects').name(this.colorSpace),
            BitsPerComponent: this.bitsPerComponent,
            // MÜHENDİSLİK DETAYI: JPEG, PDF tarafından yerel desteklenir.
            // /DCTDecode filtresi, PDF okuyucuya "bu binary veriyi doğrudan JPEG olarak yorumla" der.
            Filter: require('../core/PdfObjects').name('DCTDecode') 
        };

        // Eğer JPEG CMYK (4 kanal) formatındaysa, Invert işlemi gerekir 
        // (Aksi halde renkler Adobe Acrobat'ta negatif/ters gözükür).
        if (this.colorSpace === 'DeviceCMYK') {
            imageDict.Decode = '[1 0 1 0 1 0 1 0]'; 
        }

        return document.addStream(this.buffer, imageDict);
    }
}

module.exports = JpegParser;