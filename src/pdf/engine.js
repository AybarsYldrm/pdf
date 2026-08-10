'use strict';
const PDFStreamWriter = require('./stream-writer');
const XRefBuilder = require('./xref-builder');
const ColorEngine = require('../utils/colors');
const { PAGE_SIZES } = require('../constants/specs');
class PDFEngine {
    constructor(outputPath, pageSize = 'A5_LANDSCAPE') {
        this.writer = new PDFStreamWriter(outputPath); this.xref = new XRefBuilder(); this.objectIdCounter = 1;
        this.pageWidth = PAGE_SIZES[pageSize.toUpperCase()].width; this.pageHeight = PAGE_SIZES[pageSize.toUpperCase()].height;
        this.pages = []; this.xObjects = [];
    }
    _writeObject(content, binaryBuffer = null) {
        const id = this.objectIdCounter++; this.xref.add(id, this.writer.offset);
        this.writer.writeLine(`${id} 0 obj\n${content}`);
        if (binaryBuffer) { this.writer.writeLine('stream'); this.writer.write(binaryBuffer); this.writer.writeLine('\nendstream'); }
        this.writer.writeLine('endobj'); return id;
    }
    async compile(renderQueue) {
        this.writer.writeLine("%PDF-1.7\n%\x81\x82\x83\x84");
        const fontId = this._writeObject(`<< /Type /Font /Subtype /Type1 /Name /F1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
        let currentPageStream = ''; let imageIndex = 1;
        const finalizePage = () => {
            if (!currentPageStream) return;
            this.pages.push(this._writeObject(`<< /Length ${Buffer.byteLength(currentPageStream, 'binary')} >>\nstream\n${currentPageStream}\nendstream`));
            currentPageStream = '';
        };
        for (const item of renderQueue) {
            if (item.type === 'pageBreak') finalizePage();
            else if (item.type === 'rect') {
                const color = ColorEngine.toPdfColorString(ColorEngine.parse(item.styles.borderColor || '#000'));
                currentPageStream += `q ${item.borderWidth || 1} w ${color} RG ${item.x.toFixed(2)} ${item.y.toFixed(2)} ${item.width.toFixed(2)} ${item.height.toFixed(2)} re S Q\n`;
            } else if (item.type === 'text') {
                const color = ColorEngine.toPdfColorString(ColorEngine.parse(item.styles.color || '#000'));
                const escaped = item.content.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
                currentPageStream += `q ${color} rg BT /F1 ${item.fontSize} Tf ${item.x.toFixed(2)} ${item.y.toFixed(2)} Td (${escaped}) Tj ET Q\n`;
            } else if (item.type === 'image') {
                const name = `Im${imageIndex++}`;
                let sMaskAttr = '';
                if (item.alphaBuffer) {
                    const alphaId = this._writeObject(`<< /Type /XObject /Subtype /Image /Width ${item.intrinsicWidth} /Height ${item.intrinsicHeight} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${item.alphaBuffer.length} >>`, item.alphaBuffer);
                    sMaskAttr = `/SMask ${alphaId} 0 R`;
                }
                const filter = item.isFlate ? '/FlateDecode' : '/DCTDecode';
                const xObjId = this._writeObject(`<< /Type /XObject /Subtype /Image /Width ${item.intrinsicWidth} /Height ${item.intrinsicHeight} /ColorSpace /${item.colorSpace || 'DeviceRGB'} /BitsPerComponent 8 /Filter ${filter} ${sMaskAttr} /Length ${item.buffer.length} >>`, item.buffer);
                this.xObjects.push({ name, id: xObjId });
                currentPageStream += `q ${item.width.toFixed(2)} 0 0 ${item.height.toFixed(2)} ${item.x.toFixed(2)} ${item.y.toFixed(2)} cm /${name} Do Q\n`;
            }
        }
        finalizePage();
        let xObjRefs = this.xObjects.map(xo => `/${xo.name} ${xo.id} 0 R`).join(' ');
        const resourcesId = this._writeObject(`<< /Font << /F1 ${fontId} 0 R >> /XObject << ${xObjRefs} >> >>`);
        const pagesTreeId = this.objectIdCounter++;
        const pageObjectIds = this.pages.map(streamId => this._writeObject(`<< /Type /Page /Parent ${pagesTreeId} 0 R /MediaBox [0 0 ${this.pageWidth.toFixed(2)} ${this.pageHeight.toFixed(2)}] /Contents ${streamId} 0 R /Resources ${resourcesId} 0 R >>`));
        this.xref.add(pagesTreeId, this.writer.offset);
        this.writer.writeLine(`${pagesTreeId} 0 obj\n<< /Type /Pages /Kids [${pageObjectIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>\nendobj`);
        const catalogId = this._writeObject(`<< /Type /Catalog /Pages ${pagesTreeId} 0 R >>`);
        this.writer.writeLine(this.xref.buildTable() + `trailer\n<< /Size ${this.objectIdCounter} /Root ${catalogId} 0 R >>\nstartxref\n${this.xref.objects[0].offset}\n%%EOF`);
        return await this.writer.end();
    }
}
module.exports = PDFEngine;