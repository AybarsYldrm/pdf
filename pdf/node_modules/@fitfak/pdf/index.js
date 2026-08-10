'use strict';
const Document = require('./src/core/Document');
const BoxModel = require('./src/layout/BoxModel');
const TextEngine = require('./src/layout/TextEngine');
const Paginator = require('./src/layout/Paginator');
const Renderer = require('./src/layout/Renderer');
const TtfParser = require('./src/fonts/TtfParser');
const Subsetter = require('./src/fonts/Subsetter');
const JpegParser = require('./src/media/JpegParser');
const PngParser = require('./src/media/PngParser');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

class NativePdfEngine {
    constructor(outputPath, options = {}) {
        this.outputPath = outputPath;
        this.options = options; 
        this.document = new Document(outputPath, options.metadata);
        
        const format = Paginator.PAGE_FORMATS[options.format || 'A4'];
        const margins = options.margins || { top: 40, bottom: 40, left: 40, right: 40 };
        this.paginator = new Paginator(format, margins);

        const printableWidth = format.width - margins.left - margins.right;
        this.rootBox = new BoxModel({ width: printableWidth, height: 0, type: 'root' });

        this.fonts = new Map();
        this.images = new Map();
    }

    registerFont(name, filePath) {
        const parser = new TtfParser(filePath);
        const subsetter = new Subsetter(parser);
        this.fonts.set(name, { parser, subsetter, embeddedId: null, filePath }); 
    }

    addElement(elementConfig, parentBox = this.rootBox) {
        const box = new BoxModel(elementConfig.style);
        box.config = elementConfig; 
        
        if (elementConfig.children && Array.isArray(elementConfig.children)) {
            for (const childConfig of elementConfig.children) {
                this.addElement(childConfig, box); 
            }
        }
        parentBox.addChild(box);
    }

    async build() {
        console.log('PDF Derlemesi Başlıyor...');

        this._measurePhase(this.rootBox, this.rootBox.width);

        // 2. ABSOLUTE KOORDİNAT HESAPLAMASI
        const startX = this.paginator.margins.left;
        const startY = this.paginator.margins.top;
        const availableHeight = this.paginator.format.height - this.paginator.margins.top - this.paginator.margins.bottom;
        this.rootBox.calculateLayout(startX, startY, this.rootBox.width, availableHeight);

        // 3. SAYFALANDIRMA VE DİZGİ
        this._paginationPhase(this.rootBox);

        // 4. GÖMME (EMBEDDING)
        await this._embedResources();

        // 5. RENDER
        const renderer = new Renderer(this.document, this.paginator, this.fonts, this.images);
        await renderer.renderAll();

        // 6. KAPAT
        await this.document.end();
        console.log(`Ham PDF başarıyla oluşturuldu: ${this.outputPath}`);
    }

    _measurePhase(boxNode, availableWidth) {
        let currentWidth = boxNode.width;
        if (currentWidth === '100%' || !currentWidth) {
            currentWidth = availableWidth - boxNode.margin.left - boxNode.margin.right;
        }

        const boxInnerWidth = currentWidth 
            - boxNode.padding.left - boxNode.padding.right
            - boxNode.border.left - boxNode.border.right;

        if (boxNode.config && boxNode.config.type === 'text') {
            const fontName = boxNode.config.style.fontFamily || Array.from(this.fonts.keys())[0];
            const font = this.fonts.get(fontName);
            if (!font) throw new Error(`Font bulunamadı: ${fontName}`);

            font.subsetter.addString(boxNode.config.text);

            const lines = TextEngine.wordWrap(
                boxNode.config.text, font.parser,
                boxNode.config.style.fontSize || 12,
                boxInnerWidth, boxNode.config.style.lineHeight || 1.2
            );
            
            const alignedLines = TextEngine.alignLines(
                lines, boxInnerWidth, boxNode.config.style.align || 'left'
            );
            
            boxNode.textLines = alignedLines.map(line => ({
                text: line.text, xOffset: line.x, yOffset: line.y
            }));
            
            if (!boxNode.height) {
                boxNode.height = lines.length * ((boxNode.config.style.fontSize || 12) * (boxNode.config.style.lineHeight || 1.2));
            }
        }

        if (boxNode.config && boxNode.config.type === 'image') {
            const buffer = fs.readFileSync(boxNode.config.src);
            const isJpeg = boxNode.config.src.toLowerCase().endsWith('.jpg') || boxNode.config.src.toLowerCase().endsWith('.jpeg');
            const parser = isJpeg ? new JpegParser(buffer) : new PngParser(buffer);
            this.images.set(boxNode.config.src, { parser, embeddedId: null });

            if (boxNode.width && !boxNode.height) {
                boxNode.height = (parser.height / parser.width) * boxNode.width;
            } else if (!boxNode.width && boxNode.height) {
                boxNode.width = (parser.width / parser.height) * boxNode.height;
            } else if (!boxNode.width && !boxNode.height) {
                boxNode.width = parser.width;
                boxNode.height = parser.height;
            }
        }

        for (const child of boxNode.children) {
            this._measurePhase(child, boxInnerWidth);
        }
    }

    _paginationPhase(boxNode) {
        if (boxNode.config && boxNode.config.type === 'block') {
            this.paginator.currentPage.items.push({
                type: 'box',
                absoluteX: boxNode.absoluteX,
                absoluteY: boxNode.absoluteY,
                width: boxNode.width,
                height: boxNode.height,
                backgroundColor: boxNode.backgroundColor || boxNode.config.style.backgroundColor,
                borderColor: boxNode.borderColor || boxNode.config.style.borderColor,
                borderWidth: boxNode.borderWidth || boxNode.config.style.borderWidth
            });
        }

        if (boxNode.config && boxNode.config.type === 'text') {
            this.paginator.currentPage.items.push({
                type: 'textChunk',
                parentBox: boxNode,
                lines: boxNode.textLines,
                absoluteY: boxNode.absoluteY 
            });
        }

        if (boxNode.config && boxNode.config.type === 'image') {
            boxNode.type = 'image';
            this.paginator.currentPage.items.push(boxNode);
        }

        for (const child of boxNode.children) {
            this._paginationPhase(child);
        }
    }

    async _embedResources() {
        const PdfObjects = require('./src/core/PdfObjects');
        const CMapBuilder = require('./src/fonts/CMapBuilder');
        
        for (const [name, fontData] of this.fonts.entries()) {
            const rawTtfBuffer = fs.readFileSync(fontData.filePath);
            const hexString = rawTtfBuffer.toString('hex') + '>';
            
            const fontFileId = this.document.addStream(hexString, {
                Length1: rawTtfBuffer.length, 
                Filter: PdfObjects.name('ASCIIHexDecode')
            });

            const safeName = name.replace(/\s+/g, '');
            const baseFontName = 'AAAAAA+' + safeName;

            const descriptorId = this.document.addDictionary({
                Type: PdfObjects.name('FontDescriptor'),
                FontName: PdfObjects.name(baseFontName),
                Flags: 4, 
                FontBBox: PdfObjects.array([-500, -300, 1200, 1000]),
                ItalicAngle: 0,
                Ascent: fontData.parser.hhea ? fontData.parser.hhea.ascender : 800,
                Descent: fontData.parser.hhea ? fontData.parser.hhea.descender : -200,
                CapHeight: 700,
                StemV: 80,
                FontFile2: PdfObjects.ref(fontFileId)
            });

            const cidFontId = this.document.addDictionary({
                Type: PdfObjects.name('Font'),
                Subtype: PdfObjects.name('CIDFontType2'),
                BaseFont: PdfObjects.name(baseFontName),
                CIDSystemInfo: PdfObjects.dict({ Registry: PdfObjects.string('Adobe'), Ordering: PdfObjects.string('Identity'), Supplement: 0 }),
                FontDescriptor: PdfObjects.ref(descriptorId),
                CIDToGIDMap: PdfObjects.name('Identity'),
                W: fontData.parser.getPdfWidths() 
            });

            const glyphToUnicodeMap = new Map();
            for (const unicode of fontData.subsetter.usedUnicodes) {
                const gid = fontData.parser.getGlyphId(unicode);
                glyphToUnicodeMap.set(gid, unicode);
            }
            const toUnicodeCmap = CMapBuilder.generate(glyphToUnicodeMap);
            const toUnicodeId = this.document.addStream(toUnicodeCmap);

            fontData.embeddedId = this.document.addDictionary({
                Type: PdfObjects.name('Font'),
                Subtype: PdfObjects.name('Type0'),
                BaseFont: PdfObjects.name(baseFontName),
                Encoding: PdfObjects.name('Identity-H'),
                DescendantFonts: PdfObjects.array([PdfObjects.ref(cidFontId)]),
                ToUnicode: PdfObjects.ref(toUnicodeId)
            });
        }

        for (const [src, imgData] of this.images.entries()) {
            if(imgData.embeddedId === null){
               imgData.embeddedId = imgData.parser.embedToDocument(this.document);
            }
        }
    }
}

module.exports = NativePdfEngine;