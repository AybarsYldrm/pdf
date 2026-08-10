'use strict';
const UnitEngine = require('../utils/units');
const TextWrapper = require('./text-wrapper');
const { PAGE_SIZES } = require('../constants/specs');
class BoxModelEngine {
    constructor(pageSize = 'A5_LANDSCAPE', globalMargins = [30, 30, 30, 30]) {
        this.pageWidth = PAGE_SIZES[pageSize.toUpperCase()].width;
        this.pageHeight = PAGE_SIZES[pageSize.toUpperCase()].height;
        this.margins = {
            top: UnitEngine.parseToPt(globalMargins[0]), bottom: UnitEngine.parseToPt(globalMargins[2]),
            left: UnitEngine.parseToPt(globalMargins[3]), right: UnitEngine.parseToPt(globalMargins[1])
        };
    }
    calculateLayout(astRoot) {
        this.renderQueue = []; this.cursorY = this.pageHeight - this.margins.top; this.lastMarginBottom = 0;
        this._traverse(astRoot, this.margins.left, this.pageWidth - this.margins.left - this.margins.right);
        return this.renderQueue;
    }
    _traverse(node, containerX, containerWidth) {
        if (!node) return;
        const isBlock = node.styles && node.styles.display === 'block';
        const isAbsolute = node.styles && node.styles.position === 'absolute';
        const fontSizePt = UnitEngine.parseToPt(node.styles ? node.styles.fontSize : 12);
        let innerX = containerX, innerWidth = containerWidth, savedY = this.cursorY;

        if (isAbsolute) {
            let hVal = UnitEngine.parseToPt(node.styles.height) || 30;
            if (node.styles.bottom !== undefined) this.cursorY = this.margins.bottom + UnitEngine.parseToPt(node.styles.bottom) + hVal;
            if (node.styles.right !== undefined) {
                innerWidth = UnitEngine.parseToPt(node.styles.width) || 150;
                innerX = this.pageWidth - this.margins.right - UnitEngine.parseToPt(node.styles.right) - innerWidth;
            } else if (node.styles.left !== undefined) innerX = this.margins.left + UnitEngine.parseToPt(node.styles.left);
        } else if (isBlock) {
            let mt = UnitEngine.parseToPt(node.styles.marginTop);
            this.cursorY -= Math.max(0, mt - this.lastMarginBottom);
            if (node.styles.borderWidth || node.styles.borderColor) {
                const bw = UnitEngine.parseToPt(node.styles.borderWidth || '1px');
                const pad = UnitEngine.parseToPt(node.styles.padding || '0px');
                this.renderQueue.push({ type: 'rect', x: containerX, y: this.margins.bottom, width: containerWidth, height: this.pageHeight - this.margins.top - this.margins.bottom, borderWidth: bw, styles: node.styles });
                innerX += (bw + pad); innerWidth -= (bw * 2 + pad * 2); this.cursorY -= (bw + pad);
            }
        }

        if (node.tag === 'img' && node.imageBuffer) {
            let targetW = UnitEngine.parseToPt(node.attributes.width || node.styles.width);
            let targetH = UnitEngine.parseToPt(node.attributes.height || node.styles.height);
            // Aspect Ratio (Orantılı Boyutlandırma) Mantığı
            if (targetW && !targetH) targetH = targetW * (node.intrinsicHeight / node.intrinsicWidth);
            else if (targetH && !targetW) targetW = targetH * (node.intrinsicWidth / node.intrinsicHeight);
            else if (!targetW && !targetH) { targetW = node.intrinsicWidth * 0.75; targetH = node.intrinsicHeight * 0.75; }

            if (!isAbsolute && this.cursorY - targetH < this.margins.bottom) { this.renderQueue.push({ type: 'pageBreak' }); this.cursorY = this.pageHeight - this.margins.top; }
            this.cursorY -= targetH;
            let tx = innerX;
            if (node.styles.textAlign === 'center') tx = innerX + (innerWidth - targetW) / 2;
            if (node.styles.textAlign === 'right') tx = innerX + innerWidth - targetW;
            this.renderQueue.push({ type: 'image', buffer: node.imageBuffer, alphaBuffer: node.alphaBuffer, isFlate: node.isFlate, x: tx, y: this.cursorY, width: targetW, height: targetH, intrinsicWidth: node.intrinsicWidth, intrinsicHeight: node.intrinsicHeight, colorSpace: node.colorSpace });
            if(!isAbsolute) this.lastMarginBottom = 0;
        }

        if (node.type === 'text') {
            TextWrapper.wrap(node.content, fontSizePt, innerWidth).forEach(line => {
                const lh = fontSizePt * 1.3;
                if (!isAbsolute && this.cursorY - lh < this.margins.bottom) { this.renderQueue.push({ type: 'pageBreak' }); this.cursorY = this.pageHeight - this.margins.top; }
                this.cursorY -= lh;
                let tx = innerX;
                if (node.styles.textAlign === 'center') tx = innerX + (innerWidth - line.width) / 2;
                if (node.styles.textAlign === 'right') tx = innerX + innerWidth - line.width;
                this.renderQueue.push({ type: 'text', content: line.text, x: tx, y: this.cursorY + (fontSizePt * 0.2), fontSize: fontSizePt, styles: node.styles });
            });
            if(!isAbsolute) this.lastMarginBottom = 0;
        }

        if (node.children) node.children.forEach(c => this._traverse(c, innerX, innerWidth));
        if (isAbsolute) { this.cursorY = savedY; this.lastMarginBottom = 0; } 
        else if (isBlock) { this.lastMarginBottom = UnitEngine.parseToPt(node.styles.marginBottom); this.cursorY -= this.lastMarginBottom; }
    }
}
module.exports = BoxModelEngine;