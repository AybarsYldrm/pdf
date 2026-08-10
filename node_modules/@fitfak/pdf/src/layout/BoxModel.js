/**
 * HTML/CSS benzeri Kutu Modeli (Box-Model) motoru.
 * Margin, padding, border ve block-layout dizilim matematiklerini yönetir.
 */
class BoxModel {
    /**
     * @param {Object} style - CSS benzeri stil tanımları
     */
    constructor(style = {}) {
        // GERÇEK CSS MANTIĞI: Border-Box
        // Artık 0 yerine doğrudan değeri alıyoruz ki '100%' veya undefined olup olmadığını anlayabilelim
        this.width = style.width;
        this.height = style.height;

        this.borderColor = style.borderColor || null;
        this.borderWidth = style.borderWidth || 0;
        this.backgroundColor = style.backgroundColor || null;

        // Dış Boşluk (Margin)
        this.margin = {
            top: style.marginTop || 0,
            right: style.marginRight || 0,
            bottom: style.marginBottom || 0,
            left: style.marginLeft || 0
        };

        // İç Boşluk (Padding)
        this.padding = {
            top: style.paddingTop || 0,
            right: style.paddingRight || 0,
            bottom: style.paddingBottom || 0,
            left: style.paddingLeft || 0
        };

        // Kenarlık (Border) - Görselleştirme ve alan kaplama hesapları için
        const bw = style.borderWidth || 0;
        this.border = {
            top: style.borderTopWidth || bw,
            right: style.borderRightWidth || bw,
            bottom: style.borderBottomWidth || bw,
            left: style.borderLeftWidth || bw
        };

        // Sanal (Virtual) DOM Koordinatları:
        this.absoluteX = 0;
        this.absoluteY = 0;

        this.children = [];
        this.parent = null;
        this.type = style.type || 'block'; // 'block', 'text', 'image'
        this.config = null; // JSON nesnesini tutmak için
    }

    /**
     * Ağaca alt eleman (DOM node) ekler
     * @param {BoxModel} childBox 
     */
    addChild(childBox) {
        childBox.parent = this;
        this.children.push(childBox);
    }

    /**
     * Kutunun kapladığı toplam yatay alanı hesaplar
     * @returns {number}
     */
    getOuterWidth() {
        return this.margin.left + (this.width || 0) + this.margin.right;
    }

    /**
     * Kutunun kapladığı toplam dikey alanı hesaplar
     * @returns {number}
     */
    getOuterHeight() {
        return this.margin.top + (this.height || 0) + this.margin.bottom;
    }

    /**
     * Rekürsif Layout Motoru (Block Formatting Context).
     * @param {number} startX - Ebeveynden gelen başlangıç X koordinatı
     * @param {number} startY - Ebeveynden gelen başlangıç Y koordinatı
     * @param {number} availableWidth - İçine yayılabileceği maksimum genişlik
     * @param {number} availableHeight - İçine yayılabileceği maksimum yükseklik
     */
    calculateLayout(startX, startY, availableWidth, availableHeight) {
        // 1. TAM OTOMASYON: '100%' veya tanımsızsa alanı otomatik doldur (Margin düşülerek)
        if (this.width === '100%' || this.width === undefined) {
            this.width = availableWidth - this.margin.left - this.margin.right;
        }
        
        // DÜZELTME 1: Yükseklik %100 ise her zaman sayıya çevir (String kalıp PDF motorunu bozmasın)
        if (this.height === '100%') {
            this.height = availableHeight !== undefined ? availableHeight - this.margin.top - this.margin.bottom : 0;
        }

        const isAbsolute = this.config && this.config.style && this.config.style.position === 'absolute';

        // 2. Referans Noktası (Origin) Sabitlemesi
        let refX = startX;
        let refY = startY;

        if (isAbsolute && this.parent) {
            refX = this.parent.absoluteX + this.parent.border.left + this.parent.padding.left;
            refY = this.parent.absoluteY + this.parent.border.top + this.parent.padding.top;
        }

        // 3. Blok Hizalama (Center / Right)
        let alignX = refX + this.margin.left;
        if (this.config && this.config.style && this.config.style.align && this.config.type !== 'text') {
            if (this.config.style.align === 'center') {
                alignX = refX + (availableWidth - this.width) / 2;
            } else if (this.config.style.align === 'right') {
                alignX = refX + availableWidth - this.width - this.margin.right;
            }
        }
        
        this.absoluteX = alignX;
        this.absoluteY = refY + this.margin.top;

        // 4. Absolute Konumlandırma Hesaplaması
        if (isAbsolute) {
            if (this.config.style.bottom !== undefined && this.parent) {
                // Ebeveynin net iç yüksekliğini koruyarak aşağıdan yukarı diz
                const parentInnerHeight = (this.parent.height || availableHeight) - (this.parent.padding.top + this.parent.padding.bottom + this.parent.border.top + this.parent.border.bottom);
                this.absoluteY = refY + parentInnerHeight - this.config.style.bottom - this.height;
            } else if (this.config.style.top !== undefined) {
                this.absoluteY = refY + this.config.style.top;
            }
            
            if (this.config.style.right !== undefined && this.parent) {
                const parentInnerWidth = this.parent.width - (this.parent.padding.left + this.parent.padding.right + this.parent.border.left + this.parent.border.right);
                this.absoluteX = refX + parentInnerWidth - this.config.style.right - this.width;
            } else if (this.config.style.left !== undefined) {
                this.absoluteX = refX + this.config.style.left;
            }
        }

        // 5. İçerik ve Çocukların Dizilimi
        let contentStartX = this.absoluteX + this.border.left + this.padding.left;
        let contentStartY = this.absoluteY + this.border.top + this.padding.top;
        let currentChildY = contentStartY;
        
        // DÜZELTME 2: Kapsayıcının (Root) kendi yüksekliği 0 olsa bile, ana sayfa yüksekliğini (availableHeight) alt kutulara transfer et!
        const innerAvailableWidth = this.width - (this.padding.left + this.padding.right + this.border.left + this.border.right);
        const effectiveHeight = (this.height > 0) ? this.height : availableHeight;
        const innerAvailableHeight = effectiveHeight !== undefined ? effectiveHeight - (this.padding.top + this.padding.bottom + this.border.top + this.border.bottom) : undefined;
        
        for (const child of this.children) {
            child.calculateLayout(contentStartX, currentChildY, innerAvailableWidth, innerAvailableHeight);
            
            const childIsAbsolute = child.config && child.config.style && child.config.style.position === 'absolute';
            if (!childIsAbsolute) {
                currentChildY += child.getOuterHeight(); 
            }
        }

        // 6. Yükseklik Otomatikse İçeriklerin İttiği Kadar Büyüt
        if (!this.height && this.children.length > 0) {
            this.height = (currentChildY - this.absoluteY) + this.padding.bottom + this.border.bottom;
        }
    }
}

module.exports = BoxModel;