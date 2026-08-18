const zlib = require('zlib');
const PdfObjects = require('../core/PdfObjects');

/**
 * Sıfır Bağımlılık (Zero-Dependency) PNG Binary Parser ve Defilter Motoru.
 * PNG verisini ham piksellere ayırır, saydamlık (Alpha) kanalını PDF'in SMask sistemine çevirir.
 */
class PngParser {
    /**
     * @param {Buffer} buffer - PNG dosyasının ham binary verisi
     */
    constructor(buffer) {
        this.buffer = buffer;
        this.offset = 8; // İlk 8 byte (PNG Magic Number) atlanır
        
        this.width = 0;
        this.height = 0;
        this.bitDepth = 0;
        this.colorType = 0; // 2: RGB, 6: RGBA
        
        this.idatBuffers = []; // Sıkıştırılmış pixel chunk'ları
        this.palette = null;
        this.transparency = null;

        this._parseChunks();
        this._decodePixels();
    }

    /**
     * PNG formatının doğruluğunu Magic Number ile test eder.
     */
    static isValid(buffer) {
        return buffer.toString('hex', 0, 8) === '89504e470d0a1a0a';
    }

    /**
     * Chunk'ları (IHDR, PLTE, IDAT, IEND) okur.
     * @private
     */
    _parseChunks() {
        if (!PngParser.isValid(this.buffer)) throw new Error('Geçersiz PNG formatı.');

        while (this.offset < this.buffer.length) {
            const length = this.buffer.readUInt32BE(this.offset);
            const type = this.buffer.toString('ascii', this.offset + 4, this.offset + 8);
            const dataOffset = this.offset + 8;

        if (type === 'IHDR') {
                this.width = this.buffer.readUInt32BE(dataOffset);
                this.height = this.buffer.readUInt32BE(dataOffset + 4);
                this.bitDepth = this.buffer.readUInt8(dataOffset + 8);
                this.colorType = this.buffer.readUInt8(dataOffset + 9);
                const compression = this.buffer.readUInt8(dataOffset + 10);
                const filter = this.buffer.readUInt8(dataOffset + 11);
                const interlace = this.buffer.readUInt8(dataOffset + 12);
                if (compression !== 0 || filter !== 0) throw new Error('Bilinmeyen PNG sıkıştırma/filtre metodu.');
                if (interlace !== 0) throw new Error('Interlaced (Ağ) PNG desteklenmiyor.');
                if (this.bitDepth !== 8) throw new Error('Sadece 8-bit PNG destekleniyor.');
            } 
            // YENİ: İndeksli PNG'ler için Renk Paletini (PLTE) hafızaya al
            else if (type === 'PLTE') {
                this.palette = this.buffer.subarray(dataOffset, dataOffset + length);
            } 
            // YENİ: Transparanlık (tRNS) bloğunu hafızaya al
            else if (type === 'tRNS') {
                this.trns = this.buffer.subarray(dataOffset, dataOffset + length);
            }
            else if (type === 'IDAT') {
                this.idatBuffers.push(this.buffer.subarray(dataOffset, dataOffset + length));
            } 
            else if (type === 'IEND') {
                break;
            }

            // Chunk Uzunluğu (4) + Type (4) + Data (Length) + CRC (4) = Length + 12
            this.offset += length + 12;
        }
    }

    /**
     * Zlib ile IDAT'ı açar ve Scanline Defiltering işlemini uygular.
     * @private
     */
    _decodePixels() {
        // Tüm sıkıştırılmış IDAT parçalarını tek bir buffer'da birleştir ve zlib ile aç
        const compressedData = Buffer.concat(this.idatBuffers);
        const rawData = zlib.inflateSync(compressedData);

        // Her piksel kaç byte kaplıyor? (RGB = 3, RGBA = 4)
        const bytesPerPixel = (this.colorType === 6) ? 4 : (this.colorType === 2) ? 3 : 1;
        const bytesPerLine = this.width * bytesPerPixel;
        
        // Temizlenmiş (Filtresiz) ham pikselleri tutacak buffer
        this.pixels = Buffer.alloc(this.height * bytesPerLine);

        // --- DEFILTERING ALGORİTMASI ---
        for (let y = 0; y < this.height; y++) {
            // PNG'de her satırın ilk byte'ı "Filtre Tipi"ni (0'dan 4'e kadar) belirtir.
            const filterType = rawData[(y * (bytesPerLine + 1))];
            const lineOffset = (y * (bytesPerLine + 1)) + 1;
            
            for (let x = 0; x < bytesPerLine; x++) {
                const byteOffset = lineOffset + x;
                const destOffset = (y * bytesPerLine) + x;
                
                const rawByte = rawData[byteOffset];
                let left = (x >= bytesPerPixel) ? this.pixels[destOffset - bytesPerPixel] : 0;
                let up = (y > 0) ? this.pixels[destOffset - bytesPerLine] : 0;
                let upLeft = (x >= bytesPerPixel && y > 0) ? this.pixels[destOffset - bytesPerLine - bytesPerPixel] : 0;

                // Matematiksel ters filtreleme
                switch (filterType) {
                    case 0: // None
                        this.pixels[destOffset] = rawByte;
                        break;
                    case 1: // Sub (Solundaki ile topla)
                        this.pixels[destOffset] = (rawByte + left) & 0xFF;
                        break;
                    case 2: // Up (Üstündeki ile topla)
                        this.pixels[destOffset] = (rawByte + up) & 0xFF;
                        break;
                    case 3: // Average (Sol ve Üstün ortalaması)
                        this.pixels[destOffset] = (rawByte + Math.floor((left + up) / 2)) & 0xFF;
                        break;
                    case 4: // Paeth (Paeth Predictor Algoritması)
                        const p = left + up - upLeft;
                        const pa = Math.abs(p - left);
                        const pb = Math.abs(p - up);
                        const pc = Math.abs(p - upLeft);
                        let pr;
                        if (pa <= pb && pa <= pc) pr = left;
                        else if (pb <= pc) pr = up;
                        else pr = upLeft;
                        this.pixels[destOffset] = (rawByte + pr) & 0xFF;
                        break;
                    default:
                        throw new Error(`Bilinmeyen PNG filtresi: ${filterType}`);
                }
            }
        }
    }

    /**
     * Resmi (ve varsa saydamlık maskesini) PDF'e stream olarak gömer.
     * @param {import('../core/Document')} document 
     * @returns {number} Oluşturulan PDF Image Objesinin (Stream) ID'si
     */
    embedToDocument(document) {
      let rgbBuffer, alphaBuffer;
        
        // MÜHENDİSLİK DETAYI: RGBA Split, İndeksli (Palette) ve Gri Tonlama Çevirimi
        if (this.colorType === 6) {
            // 1. RGBA (Saydamlık Ayrıştırma)
            rgbBuffer = Buffer.alloc(this.width * this.height * 3);
            alphaBuffer = Buffer.alloc(this.width * this.height);
            let rgbIndex = 0, alphaIndex = 0;
            for (let i = 0; i < this.pixels.length; i += 4) {
                rgbBuffer[rgbIndex++] = this.pixels[i];     // R
                rgbBuffer[rgbIndex++] = this.pixels[i + 1]; // G
                rgbBuffer[rgbIndex++] = this.pixels[i + 2]; // B
                alphaBuffer[alphaIndex++] = this.pixels[i + 3]; // Alpha (A)
            }
        } 
        else if (this.colorType === 3 && this.palette) {
            // İndeksli (8-bit) PNG'yi 24-bit RGB'ye Çevirme
            rgbBuffer = Buffer.alloc(this.width * this.height * 3);
            
            // YENİ: Eğer resimde saydamlık (tRNS) varsa PDF için bir maske (Alpha) oluştur
            if (this.trns) {
                alphaBuffer = Buffer.alloc(this.width * this.height);
            }
            
            let rgbIndex = 0;
            let alphaIndex = 0;
            
            for (let i = 0; i < this.pixels.length; i++) {
                const pixelIndex = this.pixels[i];
                const colorIndex = pixelIndex * 3;
                
                rgbBuffer[rgbIndex++] = this.palette[colorIndex];     // R
                rgbBuffer[rgbIndex++] = this.palette[colorIndex + 1]; // G
                rgbBuffer[rgbIndex++] = this.palette[colorIndex + 2]; // B
                
                // Eğer saydamlık ayarı varsa, PDF'e maske (Alpha) değerini yolla
                if (this.trns) {
                    // tRNS tablosunda bu indekse ait bir saydamlık değeri varsa al, yoksa opak (255) yap
                    alphaBuffer[alphaIndex++] = (pixelIndex < this.trns.length) ? this.trns[pixelIndex] : 255;
                }
            }
        }
        else if (this.colorType === 0) {
            // 3. YENİ: Gri Tonlamalı (Grayscale) PNG'yi 24-bit RGB'ye Çevirme!
            rgbBuffer = Buffer.alloc(this.width * this.height * 3);
            let rgbIndex = 0;
            for (let i = 0; i < this.pixels.length; i++) {
                const val = this.pixels[i];
                rgbBuffer[rgbIndex++] = val; // R
                rgbBuffer[rgbIndex++] = val; // G
                rgbBuffer[rgbIndex++] = val; // B
            }
        } 
        else {
            // 4. Sadece Gerçek Renkli RGB (ColorType 2)
            rgbBuffer = this.pixels;
        }

        // Maske stream'ini yaz (Eğer saydamlık varsa)
        let sMaskId = null;
        if (alphaBuffer) {
            const compressedAlpha = zlib.deflateSync(alphaBuffer);
            sMaskId = document.addStream(compressedAlpha, {
                Type: PdfObjects.name('XObject'),
                Subtype: PdfObjects.name('Image'),
                Width: this.width,
                Height: this.height,
                ColorSpace: PdfObjects.name('DeviceGray'), // Alpha kanalı bir Gri tonlama maskesidir
                BitsPerComponent: 8,
                Filter: PdfObjects.name('FlateDecode') // Sıkıştırdığımız için FlateDecode kullanıyoruz
            });
        }

        // Ana RGB resim stream'ini yaz
        const compressedRgb = zlib.deflateSync(rgbBuffer);
        const imageDict = {
            Type: PdfObjects.name('XObject'),
            Subtype: PdfObjects.name('Image'),
            Width: this.width,
            Height: this.height,
            ColorSpace: PdfObjects.name('DeviceRGB'),
            BitsPerComponent: 8,
            Filter: PdfObjects.name('FlateDecode')
        };

        // Eğer maske varsa birbirine bağla (Pointer)
        if (sMaskId) {
            imageDict.SMask = PdfObjects.ref(sMaskId);
        }

        return document.addStream(compressedRgb, imageDict);
    }
}

module.exports = PngParser;