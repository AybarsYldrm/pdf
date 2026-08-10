/**
 * Sayfalandırma ve Kesim Motoru (Guillotine/Fragmentation Engine).
 * Sonsuz uzunluktaki DOM ağacını, fiziksel sayfa boyutlarına (A4, A5 vb.) göre parçalar.
 */

const PAGE_FORMATS = {
    A4: { width: 595.28, height: 841.89 },
    A5: { width: 419.53, height: 595.28 },
    A5_LANDSCAPE: { width: 595.28, height: 419.53 }, // YENİ EKLENEN SATIR BURADA OLMALI
    LETTER: { width: 612.00, height: 792.00 }
};

class Paginator {
    /**
     * @param {Object} format - Sayfa formatı (Örn: PAGE_FORMATS.A4)
     * @param {Object} margins - Sayfa kenar boşlukları {top, bottom, left, right}
     */
    constructor(format = PAGE_FORMATS.A4, margins = { top: 40, bottom: 40, left: 40, right: 40 }) {
        this.format = format;
        this.margins = margins;
        
        // Kesim yapılabilecek maksimum kullanılabilir dikey alan
        this.usableHeight = this.format.height - this.margins.top - this.margins.bottom;
        
        this.pages = []; // Render edilecek sayfaların dizisi
        this._createNewPage();
    }

    /**
     * Yeni, boş bir fiziksel sayfa (Virtual Page) oluşturur.
     * @private
     */
    _createNewPage() {
        this.currentPage = {
            items: [], // Sayfaya basılacak render komutları/objeleri
            currentY: this.margins.top // İmleci sayfanın en üstüne (margin altına) al
        };
        this.pages.push(this.currentPage);
    }

    /**
     * Sayfada kalan boş alanı hesaplar.
     * @returns {number}
     */
    getAvailableSpace() {
        return this.format.height - this.margins.bottom - this.currentPage.currentY;
    }

    /**
     * Parçalanamayan (Atomik) bir bloğu (Örn: Görsel, Tablo satırı) sayfaya ekler.
     * Eğer sığmıyorsa, otomatik olarak yeni sayfaya taşır.
     * @param {Object} item - Çizilecek öğe (BoxModel veya Render komutu)
     * @param {number} itemHeight - Öğenin toplam dikey yüksekliği
     * @returns {number} Öğenin basıldığı Y koordinatı (Top-Down sisteminde)
     */
    addAtomicBlock(item, itemHeight) {
        // Eğer öğe mevcut sayfaya sığmıyorsa ve sayfa boş değilse (sayfadan büyük tek bir obje değilse)
        if (itemHeight > this.getAvailableSpace() && this.currentPage.currentY > this.margins.top) {
            this._createNewPage();
        }

        const yPos = this.currentPage.currentY;
        
        // Öğeyi sayfaya kaydet ve imleci aşağı kaydır
        this.currentPage.items.push({ ...item, absoluteY: yPos });
        this.currentPage.currentY += itemHeight;

        return yPos;
    }

    /**
     * Bölünebilir (Fragmentable) bir metin bloğunu sayfaya ekler.
     * Sığmayan satırları (TextLines) tespit edip bir sonraki sayfaya taşır.
     * @param {Object} textNode - BoxModel metin düğümü
     * @param {Array<Object>} lines - TextEngine'den gelen satırlar dizisi
     * @param {number} lineHeight - Satır yüksekliği
     */
    addTextBlock(textNode, lines, lineHeight) {
        let remainingLines = [...lines];

        while (remainingLines.length > 0) {
            const availableSpace = this.getAvailableSpace();
            
            // Mevcut sayfaya kaç satır sığabileceğini hesapla (Math.floor ile tam satırları al)
            let fitCount = Math.floor(availableSpace / lineHeight);

            // MÜHENDİSLİK DETAYI: "Orphan & Widow" (Tek kalan satır) Koruması
            // Eğer sayfanın sonuna sadece 1 satır sığıyorsa veya yeni sayfaya sadece 1 satır taşıyorsa, 
            // estetiği bozmamak için bloğu komple alt sayfaya atmak veya taşımayı optimize etmek kurumsal PDF'lerin kuralıdır.
            if (fitCount === 1 && remainingLines.length > 1) {
                fitCount = 0; // Hiçbirini sığdırma, hepsini yeni sayfaya at
            }

            if (fitCount === 0 || availableSpace < lineHeight) {
                // Sayfada yer yok, yeni sayfaya geç
                this._createNewPage();
                continue; // Döngüyü başa sar ve yeni sayfanın kapasitesiyle tekrar sına
            }

            // Sığanları bu sayfaya al, geri kalanları (sığmayanları) ayır
            const linesToFit = remainingLines.slice(0, fitCount);
            remainingLines = remainingLines.slice(fitCount);

            // Sığan satırları mevcut sayfanın item'larına ekle
            const yPos = this.currentPage.currentY;
            this.currentPage.items.push({
                type: 'textChunk',
                parentBox: textNode,
                lines: linesToFit,
                absoluteY: yPos
            });

            // İmleci eklenen satırların toplam yüksekliği kadar aşağı kaydır
            this.currentPage.currentY += (linesToFit.length * lineHeight);
        }
    }
    
    getPages() {
        return this.pages;
    }
}

// Formatları dışarı aktarıyoruz ki ana dosyada kullanılabilsin
Paginator.PAGE_FORMATS = PAGE_FORMATS;

module.exports = Paginator;