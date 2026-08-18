/**
 * NATIVE PDF ENGINE - V9 (Perfect Alignment & Dark Blue Border)
 * Kullanım: node setup.js
 */

const fs = require('fs');
const path = require('path');

console.log("📦 Native PDF Engine (V9 - Perfect Layout) oluşturuluyor...\n");

try {
    const content = fs.readFileSync(__filename, 'utf8');
    const lines = content.split('\n');
    let currentFile = null;
    let currentData = [];

    for (let line of lines) {
        line = line.replace(/\r$/, ''); 
        if (line.startsWith('// @@FILE: ')) {
            if (currentFile) {
                const fullPath = path.join(__dirname, currentFile);
                fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                fs.writeFileSync(fullPath, currentData.join('\n'), 'utf8');
                console.log(`✅ GÜNCELLENDİ: ${currentFile}`);
            }
            currentFile = line.replace('// @@FILE: ', '').trim();
            currentData = [];
        } else if (currentFile && line.startsWith('//|')) {
            currentData.push(line.substring(3)); 
        }
    }
    if (currentFile) {
        const fullPath = path.join(__dirname, currentFile);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, currentData.join('\n'), 'utf8');
        console.log(`✅ GÜNCELLENDİ: ${currentFile}`);
    }

    console.log("\n🚀 Kurulum tamamlandı! Sertifikayı üretmek için 'npm start' komutunu çalıştır.");
} catch (error) {
    console.error("❌ Kurulum hatası:", error);
}
process.exit(0);

// ============================================================================
// PROJE DOSYALARI (V9)
// ============================================================================

// @@FILE: package.json
//|{
//|  "name": "native-pdf-engine",
//|  "version": "9.0.0",
//|  "main": "index.js",
//|  "scripts": { "start": "node index.js" }
//|}

// @@FILE: src/constants/specs.js
//|'use strict';
//|module.exports = {
//|    PAGE_SIZES: { A4: { width: 595.28, height: 841.89 }, A5_LANDSCAPE: { width: 595.28, height: 419.53 } },
//|    DEFAULT_STYLES: {
//|        'div': { display: 'block', marginTop: '0px', marginBottom: '0px' },
//|        'p': { display: 'block', marginTop: '16px', marginBottom: '16px' },
//|        'h1': { display: 'block', marginTop: '24px', marginBottom: '24px', fontSize: '32px', fontWeight: 'bold' },
//|        'h2': { display: 'block', marginTop: '18px', marginBottom: '18px', fontSize: '24px', fontWeight: 'bold' },
//|        'span': { display: 'inline' }, 'b': { display: 'inline', fontWeight: 'bold' }
//|    },
//|    INHERITABLE_PROPERTIES: ['color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'textAlign'],
//|    HELVETICA_METRIC_MULTIPLIER: 0.51
//|};

// @@FILE: src/utils/units.js
//|'use strict';
//|const { HELVETICA_METRIC_MULTIPLIER } = require('../constants/specs');
//|class UnitEngine {
//|    static parseToPt(value, baseSize = 12) {
//|        if (!value) return 0;
//|        if (typeof value === 'number') return value;
//|        const num = parseFloat(value.toString().trim().toLowerCase());
//|        if (isNaN(num)) return 0;
//|        if (value.toString().toLowerCase().endsWith('px')) return num * 0.75;
//|        return num * 0.75;
//|    }
//|    static measureTextWidth(text, fontSizePt) { return text ? text.length * (fontSizePt * HELVETICA_METRIC_MULTIPLIER) : 0; }
//|}
//|module.exports = UnitEngine;

// @@FILE: src/utils/colors.js
//|'use strict';
//|class ColorEngine {
//|    static parse(colorStr) {
//|        const def = { r: 0, g: 0, b: 0 };
//|        if (!colorStr) return def;
//|        if (colorStr.startsWith('#')) {
//|            let hex = colorStr.slice(1).replace(/[^0-9a-fA-F]/g, '');
//|            if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
//|            return { r: parseInt(hex.substring(0,2),16)/255||0, g: parseInt(hex.substring(2,4),16)/255||0, b: parseInt(hex.substring(4,6),16)/255||0 };
//|        }
//|        return def;
//|    }
//|    static toPdfColorString(c) { return `${c.r.toFixed(3)} ${c.g.toFixed(3)} ${c.b.toFixed(3)}`; }
//|}
//|module.exports = ColorEngine;

// @@FILE: src/utils/image-parser.js
//|'use strict';
//|const https = require('https');
//|const zlib = require('zlib');
//|class ImageParser {
//|    static fetchBuffer(url) {
//|        return new Promise((res, rej) => {
//|            https.get(url, r => {
//|                if ([301, 302, 308].includes(r.statusCode)) return res(this.fetchBuffer(r.headers.location));
//|                if (r.statusCode !== 200) return rej(new Error(`HTTP ${r.statusCode}`));
//|                const data = []; r.on('data', c => data.push(c)); r.on('end', () => res(Buffer.concat(data)));
//|            }).on('error', rej);
//|        });
//|    }
//|    static async processImage(url) {
//|        const b = await this.fetchBuffer(url);
//|        if (b[0] === 0xFF && b[1] === 0xD8) return this.parseJPEG(b);
//|        if (b[0] === 0x89 && b[1] === 0x50) return this.parsePNG(b);
//|        throw new Error("Gecersiz format.");
//|    }
//|    static parseJPEG(b) {
//|        let o = 2;
//|        while (o < b.length) {
//|            if (b[o] !== 0xFF) { o++; continue; }
//|            let m = b[o + 1];
//|            if (m === 0xC0 || m === 0xC1 || m === 0xC2) return { width: b.readUInt16BE(o + 7), height: b.readUInt16BE(o + 5), colorSpace: b[o + 9] === 3 ? 'DeviceRGB' : 'DeviceGray', buffer: b, isFlate: false };
//|            o += 2 + b.readUInt16BE(o + 2);
//|        }
//|        throw new Error("Gecersiz JPEG");
//|    }
//|    static parsePNG(b) {
//|        let o = 8, w, h, bd, ct, bpp; const idat = []; let plte, trns;
//|        while (o < b.length) {
//|            const len = b.readUInt32BE(o); const type = b.toString('ascii', o+4, o+8); const doff = o+8;
//|            if (type === 'IHDR') {
//|                w = b.readUInt32BE(doff); h = b.readUInt32BE(doff+4); bd = b.readUInt8(doff+8); ct = b.readUInt8(doff+9);
//|                bpp = ct===0||ct===3 ? Math.max(1, bd/8) : ct===2 ? 3*(bd/8) : ct===4 ? 2*(bd/8) : 4*(bd/8);
//|                if(b.readUInt8(doff+12) === 1) throw new Error("Adam7 Interlaced PNG desteklenmiyor.");
//|            } else if (type === 'PLTE') plte = b.subarray(doff, doff+len);
//|            else if (type === 'tRNS') trns = b.subarray(doff, doff+len);
//|            else if (type === 'IDAT') idat.push(b.subarray(doff, doff+len));
//|            else if (type === 'IEND') break;
//|            o += 12 + len;
//|        }
//|        const inf = zlib.inflateSync(Buffer.concat(idat));
//|        const hasA = ct===6 || ct===4 || trns;
//|        const rgb = Buffer.alloc(w * h * 3); const alpha = hasA ? Buffer.alloc(w * h, 255) : null;
//|        let rs = ct===0||ct===3 ? Math.ceil(w*bd/8) : ct===2 ? w*3*(bd/8) : ct===4 ? w*2*(bd/8) : w*4*(bd/8);
//|        const pRow = Buffer.alloc(rs), cRow = Buffer.alloc(rs);
//|        let iO = 0, rI = 0, aI = 0;
//|        for (let y = 0; y < h; y++) {
//|            const ft = inf[iO++];
//|            for (let x = 0; x < rs; x++) {
//|                const raw = inf[iO+x], left = x>=bpp ? cRow[x-bpp] : 0, up = pRow[x], upL = x>=bpp ? pRow[x-bpp] : 0;
//|                let val = raw;
//|                if(ft===1) val += left; else if(ft===2) val += up; else if(ft===3) val += Math.floor((left+up)/2);
//|                else if(ft===4) { const p = left+up-upL, pa = Math.abs(p-left), pb = Math.abs(p-up), pc = Math.abs(p-upL); val += (pa<=pb && pa<=pc ? left : pb<=pc ? up : upL); }
//|                cRow[x] = val & 0xFF;
//|            }
//|            for (let i = 0; i < w; i++) {
//|                let r=0,g=0,b=0,a=255;
//|                if (ct===2) { r=cRow[i*3]; g=cRow[i*3+1]; b=cRow[i*3+2]; }
//|                else if (ct===6) { r=cRow[i*4]; g=cRow[i*4+1]; b=cRow[i*4+2]; a=cRow[i*4+3]; }
//|                else if (ct===3) {
//|                    const ppb = 8/bd; const shift = 8-bd-((i%ppb)*bd);
//|                    const idx = (cRow[Math.floor(i/ppb)] >> shift) & ((1<<bd)-1);
//|                    if(plte) { r=plte[idx*3]; g=plte[idx*3+1]; b=plte[idx*3+2]; }
//|                    if(trns && idx<trns.length) { a=trns[idx]; if(a===0) r=g=b=255; }
//|                } else if (ct===0 || ct===4) {
//|                    let v=cRow[i]; if(bd<8) { const ppb=8/bd; const shift=8-bd-((i%ppb)*bd); v=(cRow[Math.floor(i/ppb)]>>shift)&((1<<bd)-1); v=Math.round(v*255/((1<<bd)-1)); }
//|                    r=g=b=v; if(ct===4) a=cRow[i*2+1];
//|                }
//|                rgb[rI++]=r; rgb[rI++]=g; rgb[rI++]=b; if(hasA) alpha[aI++]=a;
//|            }
//|            cRow.copy(pRow); iO+=rs;
//|        }
//|        return { width:w, height:h, colorSpace: 'DeviceRGB', isFlate: true, buffer: zlib.deflateSync(rgb), alphaBuffer: hasA ? zlib.deflateSync(alpha) : null };
//|    }
//|}
//|module.exports = ImageParser;

// @@FILE: src/parser/css-parser.js
//|'use strict';
//|const { INHERITABLE_PROPERTIES, DEFAULT_STYLES } = require('../constants/specs');
//|class CSSParser {
//|    static parseInline(str) {
//|        const styles = {};
//|        if (!str) return styles;
//|        str.split(';').forEach(decl => {
//|            const i = decl.indexOf(':');
//|            if (i !== -1) styles[decl.substring(0, i).trim().replace(/-([a-z])/g, g => g[1].toUpperCase())] = decl.substring(i + 1).trim();
//|        });
//|        return styles;
//|    }
//|    static computeStyles(tag, parent = {}, inline = '') {
//|        const computed = { ...(DEFAULT_STYLES[tag] || DEFAULT_STYLES['span']) };
//|        INHERITABLE_PROPERTIES.forEach(p => { if (parent[p] !== undefined) computed[p] = parent[p]; });
//|        Object.assign(computed, this.parseInline(inline));
//|        return computed;
//|    }
//|}
//|module.exports = CSSParser;

// @@FILE: src/parser/html-tokenizer.js
//|'use strict';
//|const CSSParser = require('./css-parser');
//|class HTMLTokenizer {
//|    static parse(htmlString) {
//|        const root = { tag: 'body', styles: CSSParser.computeStyles('div'), children: [] };
//|        const stack = [root];
//|        const tagRegex = /<(\/?)([a-zA-Z1-6\-]+)([^>]*)>/g;
//|        let lastIndex = 0, match;
//|        while ((match = tagRegex.exec(htmlString)) !== null) {
//|            if (match.index > lastIndex) {
//|                let text = htmlString.substring(lastIndex, match.index).replace(/\s+/g, ' ').trim();
//|                if (text) stack[stack.length - 1].children.push({ type: 'text', content: text, styles: { ...stack[stack.length - 1].styles } });
//|            }
//|            if (match[1] === '/') {
//|                for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === match[2].toLowerCase()) { stack.length = i; break; }
//|            } else {
//|                const attrsStr = match[3];
//|                const attributes = {};
//|                const attrRegex = /([a-zA-Z0-9\-]+)(?:\s*=\s*(?:(?:"([^"]*)")|(?:'([^']*)')|([^>\s]+)))?/g;
//|                let am; while ((am = attrRegex.exec(attrsStr)) !== null) attributes[am[1].toLowerCase()] = am[2] || am[3] || am[4] || '';
//|                const node = { type: 'element', tag: match[2].toLowerCase(), attributes, styles: CSSParser.computeStyles(match[2].toLowerCase(), stack[stack.length - 1].styles, attributes.style || ''), children: [] };
//|                stack[stack.length - 1].children.push(node);
//|                if (!['img', 'br', 'hr'].includes(node.tag)) stack.push(node);
//|            }
//|            lastIndex = tagRegex.lastIndex;
//|        }
//|        return root;
//|    }
//|}
//|module.exports = HTMLTokenizer;

// @@FILE: src/parser/image-loader.js
//|'use strict';
//|const ImageParser = require('../utils/image-parser');
//|class ImageLoader {
//|    static async enhanceAST(node) {
//|        if (node.tag === 'img' && node.attributes.src) {
//|            try {
//|                const imgData = await ImageParser.processImage(node.attributes.src);
//|                Object.assign(node, { imageBuffer: imgData.buffer, alphaBuffer: imgData.alphaBuffer, intrinsicWidth: imgData.width, intrinsicHeight: imgData.height, colorSpace: imgData.colorSpace, isFlate: imgData.isFlate });
//|            } catch (e) { console.error(`⚠️ Görsel Hatası: ${node.attributes.src} -> ${e.message}`); }
//|        }
//|        if (node.children) { for (const child of node.children) await this.enhanceAST(child); }
//|    }
//|}
//|module.exports = ImageLoader;

// @@FILE: src/layout/text-wrapper.js
//|'use strict';
//|const UnitEngine = require('../utils/units');
//|class TextWrapper {
//|    static wrap(text, fontSizePt, maxWidth) {
//|        const lines = [];
//|        if (!text) return lines;
//|        text.split('\n').forEach(paragraph => {
//|            if (!paragraph.trim()) return;
//|            let cl = '', cw = 0;
//|            paragraph.split(' ').forEach(word => {
//|                const ww = UnitEngine.measureTextWidth(word, fontSizePt);
//|                const sw = cl.length ? UnitEngine.measureTextWidth(' ', fontSizePt) : 0;
//|                if (cw + sw + ww > maxWidth && cl.length > 0) { lines.push({ text: cl, width: cw }); cl = word; cw = ww; }
//|                else { cl += (cl.length ? ' ' : '') + word; cw += sw + ww; }
//|            });
//|            if (cl) lines.push({ text: cl, width: cw });
//|        });
//|        return lines;
//|    }
//|}
//|module.exports = TextWrapper;

// @@FILE: src/layout/box-model.js
//|'use strict';
//|const UnitEngine = require('../utils/units');
//|const TextWrapper = require('./text-wrapper');
//|const { PAGE_SIZES } = require('../constants/specs');
//|class BoxModelEngine {
//|    constructor(pageSize = 'A5_LANDSCAPE', globalMargins = [30, 30, 30, 30]) {
//|        this.pageWidth = PAGE_SIZES[pageSize.toUpperCase()].width;
//|        this.pageHeight = PAGE_SIZES[pageSize.toUpperCase()].height;
//|        this.margins = {
//|            top: UnitEngine.parseToPt(globalMargins[0]), bottom: UnitEngine.parseToPt(globalMargins[2]),
//|            left: UnitEngine.parseToPt(globalMargins[3]), right: UnitEngine.parseToPt(globalMargins[1])
//|        };
//|    }
//|    calculateLayout(astRoot) {
//|        this.renderQueue = []; this.cursorY = this.pageHeight - this.margins.top; this.lastMarginBottom = 0;
//|        this._traverse(astRoot, this.margins.left, this.pageWidth - this.margins.left - this.margins.right);
//|        return this.renderQueue;
//|    }
//|    _traverse(node, containerX, containerWidth) {
//|        if (!node) return;
//|        const isBlock = node.styles && node.styles.display === 'block';
//|        const isAbsolute = node.styles && node.styles.position === 'absolute';
//|        const fontSizePt = UnitEngine.parseToPt(node.styles ? node.styles.fontSize : 12);
//|        let innerX = containerX, innerWidth = containerWidth, savedY = this.cursorY;
//|
//|        if (isAbsolute) {
//|            let hVal = UnitEngine.parseToPt(node.styles.height) || 30;
//|            if (node.styles.bottom !== undefined) this.cursorY = this.margins.bottom + UnitEngine.parseToPt(node.styles.bottom) + hVal;
//|            if (node.styles.right !== undefined) {
//|                innerWidth = UnitEngine.parseToPt(node.styles.width) || 150;
//|                innerX = this.pageWidth - this.margins.right - UnitEngine.parseToPt(node.styles.right) - innerWidth;
//|            } else if (node.styles.left !== undefined) innerX = this.margins.left + UnitEngine.parseToPt(node.styles.left);
//|        } else if (isBlock) {
//|            let mt = UnitEngine.parseToPt(node.styles.marginTop);
//|            this.cursorY -= Math.max(0, mt - this.lastMarginBottom);
//|            if (node.styles.borderWidth || node.styles.borderColor) {
//|                const bw = UnitEngine.parseToPt(node.styles.borderWidth || '1px');
//|                const pad = UnitEngine.parseToPt(node.styles.padding || '0px');
//|                this.renderQueue.push({ type: 'rect', x: containerX, y: this.margins.bottom, width: containerWidth, height: this.pageHeight - this.margins.top - this.margins.bottom, borderWidth: bw, styles: node.styles });
//|                innerX += (bw + pad); innerWidth -= (bw * 2 + pad * 2); this.cursorY -= (bw + pad);
//|            }
//|        }
//|
//|        if (node.tag === 'img' && node.imageBuffer) {
//|            let targetW = UnitEngine.parseToPt(node.attributes.width || node.styles.width);
//|            let targetH = UnitEngine.parseToPt(node.attributes.height || node.styles.height);
//|            if (targetW && !targetH) targetH = targetW * (node.intrinsicHeight / node.intrinsicWidth);
//|            else if (targetH && !targetW) targetW = targetH * (node.intrinsicWidth / node.intrinsicHeight);
//|            else if (!targetW && !targetH) { targetW = node.intrinsicWidth * 0.75; targetH = node.intrinsicHeight * 0.75; }
//|
//|            if (!isAbsolute && this.cursorY - targetH < this.margins.bottom) { this.renderQueue.push({ type: 'pageBreak' }); this.cursorY = this.pageHeight - this.margins.top; }
//|            this.cursorY -= targetH;
//|            let tx = innerX;
//|            if (node.styles.textAlign === 'center') tx = innerX + (innerWidth - targetW) / 2;
//|            if (node.styles.textAlign === 'right') tx = innerX + innerWidth - targetW;
//|            this.renderQueue.push({ type: 'image', buffer: node.imageBuffer, alphaBuffer: node.alphaBuffer, isFlate: node.isFlate, x: tx, y: this.cursorY, width: targetW, height: targetH, intrinsicWidth: node.intrinsicWidth, intrinsicHeight: node.intrinsicHeight, colorSpace: node.colorSpace });
//|            if(!isAbsolute) this.lastMarginBottom = 0;
//|        }
//|
//|        if (node.type === 'text') {
//|            TextWrapper.wrap(node.content, fontSizePt, innerWidth).forEach(line => {
//|                const lh = fontSizePt * 1.3;
//|                if (!isAbsolute && this.cursorY - lh < this.margins.bottom) { this.renderQueue.push({ type: 'pageBreak' }); this.cursorY = this.pageHeight - this.margins.top; }
//|                this.cursorY -= lh;
//|                let tx = innerX;
//|                if (node.styles.textAlign === 'center') tx = innerX + (innerWidth - line.width) / 2;
//|                if (node.styles.textAlign === 'right') tx = innerX + innerWidth - line.width;
//|                this.renderQueue.push({ type: 'text', content: line.text, x: tx, y: this.cursorY + (fontSizePt * 0.2), fontSize: fontSizePt, styles: node.styles });
//|            });
//|            if(!isAbsolute) this.lastMarginBottom = 0;
//|        }
//|
//|        if (node.children) node.children.forEach(c => this._traverse(c, innerX, innerWidth));
//|        if (isAbsolute) { this.cursorY = savedY; this.lastMarginBottom = 0; } 
//|        else if (isBlock) { this.lastMarginBottom = UnitEngine.parseToPt(node.styles.marginBottom); this.cursorY -= this.lastMarginBottom; }
//|    }
//|}
//|module.exports = BoxModelEngine;

// @@FILE: src/pdf/stream-writer.js
//|'use strict';
//|const fs = require('fs');
//|class PDFStreamWriter {
//|    constructor(outputPath) { this.outputPath = outputPath; this.stream = fs.createWriteStream(outputPath, { flags: 'w', encoding: 'binary' }); this.offset = 0; }
//|    write(chunk) { const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'binary'); this.stream.write(b); this.offset += b.length; return this.offset; }
//|    writeLine(line) { this.write(line + '\n'); }
//|    end() { return new Promise((res, rej) => { this.stream.on('finish', () => res(this.outputPath)); this.stream.end(); }); }
//|}
//|module.exports = PDFStreamWriter;

// @@FILE: src/pdf/xref-builder.js
//|'use strict';
//|class XRefBuilder {
//|    constructor() { this.objects = []; }
//|    add(id, offset) { this.objects.push({ id, offset }); }
//|    buildTable() {
//|        this.objects.sort((a, b) => a.id - b.id);
//|        const count = this.objects.length ? this.objects[this.objects.length - 1].id + 1 : 1;
//|        let str = `xref\n0 ${count}\n0000000000 65535 f \n`;
//|        let e = 1;
//|        for (const obj of this.objects) { while (e++ < obj.id) str += `0000000000 65535 f \n`; str += `${obj.offset.toString().padStart(10, '0')} 00000 n \n`; }
//|        return str;
//|    }
//|}
//|module.exports = XRefBuilder;

// @@FILE: src/pdf/engine.js
//|'use strict';
//|const PDFStreamWriter = require('./stream-writer');
//|const XRefBuilder = require('./xref-builder');
//|const ColorEngine = require('../utils/colors');
//|const { PAGE_SIZES } = require('../constants/specs');
//|class PDFEngine {
//|    constructor(outputPath, pageSize = 'A5_LANDSCAPE') {
//|        this.writer = new PDFStreamWriter(outputPath); this.xref = new XRefBuilder(); this.objectIdCounter = 1;
//|        this.pageWidth = PAGE_SIZES[pageSize.toUpperCase()].width; this.pageHeight = PAGE_SIZES[pageSize.toUpperCase()].height;
//|        this.pages = []; this.xObjects = [];
//|    }
//|    _writeObject(content, binaryBuffer = null) {
//|        const id = this.objectIdCounter++; this.xref.add(id, this.writer.offset);
//|        this.writer.writeLine(`${id} 0 obj\n${content}`);
//|        if (binaryBuffer) { this.writer.writeLine('stream'); this.writer.write(binaryBuffer); this.writer.writeLine('\nendstream'); }
//|        this.writer.writeLine('endobj'); return id;
//|    }
//|    async compile(renderQueue) {
//|        this.writer.writeLine("%PDF-1.7\n%\x81\x82\x83\x84");
//|        const fontId = this._writeObject(`<< /Type /Font /Subtype /Type1 /Name /F1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
//|        let currentPageStream = ''; let imageIndex = 1;
//|        const finalizePage = () => {
//|            if (!currentPageStream) return;
//|            this.pages.push(this._writeObject(`<< /Length ${Buffer.byteLength(currentPageStream, 'binary')} >>\nstream\n${currentPageStream}\nendstream`));
//|            currentPageStream = '';
//|        };
//|        for (const item of renderQueue) {
//|            if (item.type === 'pageBreak') finalizePage();
//|            else if (item.type === 'rect') {
//|                const color = ColorEngine.toPdfColorString(ColorEngine.parse(item.styles.borderColor || '#000'));
//|                currentPageStream += `q ${item.borderWidth || 1} w ${color} RG ${item.x.toFixed(2)} ${item.y.toFixed(2)} ${item.width.toFixed(2)} ${item.height.toFixed(2)} re S Q\n`;
//|            } else if (item.type === 'text') {
//|                const color = ColorEngine.toPdfColorString(ColorEngine.parse(item.styles.color || '#000'));
//|                const escaped = item.content.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
//|                currentPageStream += `q ${color} rg BT /F1 ${item.fontSize} Tf ${item.x.toFixed(2)} ${item.y.toFixed(2)} Td (${escaped}) Tj ET Q\n`;
//|            } else if (item.type === 'image') {
//|                const name = `Im${imageIndex++}`;
//|                let sMaskAttr = '';
//|                if (item.alphaBuffer) {
//|                    const alphaId = this._writeObject(`<< /Type /XObject /Subtype /Image /Width ${item.intrinsicWidth} /Height ${item.intrinsicHeight} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${item.alphaBuffer.length} >>`, item.alphaBuffer);
//|                    sMaskAttr = `/SMask ${alphaId} 0 R`;
//|                }
//|                const filter = item.isFlate ? '/FlateDecode' : '/DCTDecode';
//|                const xObjId = this._writeObject(`<< /Type /XObject /Subtype /Image /Width ${item.intrinsicWidth} /Height ${item.intrinsicHeight} /ColorSpace /${item.colorSpace || 'DeviceRGB'} /BitsPerComponent 8 /Filter ${filter} ${sMaskAttr} /Length ${item.buffer.length} >>`, item.buffer);
//|                this.xObjects.push({ name, id: xObjId });
//|                currentPageStream += `q ${item.width.toFixed(2)} 0 0 ${item.height.toFixed(2)} ${item.x.toFixed(2)} ${item.y.toFixed(2)} cm /${name} Do Q\n`;
//|            }
//|        }
//|        finalizePage();
//|        let xObjRefs = this.xObjects.map(xo => `/${xo.name} ${xo.id} 0 R`).join(' ');
//|        const resourcesId = this._writeObject(`<< /Font << /F1 ${fontId} 0 R >> /XObject << ${xObjRefs} >> >>`);
//|        const pagesTreeId = this.objectIdCounter++;
//|        const pageObjectIds = this.pages.map(streamId => this._writeObject(`<< /Type /Page /Parent ${pagesTreeId} 0 R /MediaBox [0 0 ${this.pageWidth.toFixed(2)} ${this.pageHeight.toFixed(2)}] /Contents ${streamId} 0 R /Resources ${resourcesId} 0 R >>`));
//|        this.xref.add(pagesTreeId, this.writer.offset);
//|        this.writer.writeLine(`${pagesTreeId} 0 obj\n<< /Type /Pages /Kids [${pageObjectIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>\nendobj`);
//|        const catalogId = this._writeObject(`<< /Type /Catalog /Pages ${pagesTreeId} 0 R >>`);
//|        this.writer.writeLine(this.xref.buildTable() + `trailer\n<< /Size ${this.objectIdCounter} /Root ${catalogId} 0 R >>\nstartxref\n${this.xref.objects[0].offset}\n%%EOF`);
//|        return await this.writer.end();
//|    }
//|}
//|module.exports = PDFEngine;

// @@FILE: index.js
//|'use strict';
//|const HTMLTokenizer = require('./src/parser/html-tokenizer');
//|const ImageLoader = require('./src/parser/image-loader');
//|const BoxModelEngine = require('./src/layout/box-model');
//|const PDFEngine = require('./src/pdf/engine');
//|
//|// Helvetica için Transliterasyon Koruması (Ç, Ö, Ü native olarak var)
//|const sanitizeTurkish = (text) => {
//|    const map = { 'ğ':'g', 'Ğ':'G', 'ş':'s', 'Ş':'S', 'ı':'i', 'İ':'I' };
//|    return text.replace(/[ğĞşŞıİ]/g, char => map[char] || char);
//|};
//|
//|const certificateHTML = `
//|    <div style="border-width: 8px; border-color: #033248; padding: 15px; display: block;">
//|        
//|        <h1 style="text-align: center; color: #033248; font-size: 26px; margin-top: 10px; margin-bottom: 5px;">
//|            Katılım Belgesi
//|        </h1>
//|        <p style="text-align: center; color: #205b73; font-size: 11px; margin-top: 0px; margin-bottom: 30px;">
//|            Bu belge, aşağıdaki kişinin etkinliğe katılımını onaylar
//|        </p>
//|
//|        <p style="text-align: center; color: #205b73; font-size: 12px; margin-top: 0px; margin-bottom: 5px;">
//|            Sunulur:
//|        </p>
//|        <h2 style="text-align: center; color: #033248; font-size: 32px; margin-top: 0px; margin-bottom: 20px;">
//|            Selahattin Aybars Yildiz
//|        </h2>
//|
//|        <p style="text-align: center; color: #274a57; font-size: 12px; line-height: 1.4; margin-top: 0px; margin-bottom: 30px;">
//|            Bu sertifika, <b>FITFAK Sport Club</b> kapsamında gösterdiği başarılı katılım ve 
//|            katkılarından dolayı verilmiştir. Katılımcının çabası ve özverisi bu belge ile takdir edilmektedir.
//|        </p>
//|
//|        <p style="text-align: center; color: #274a57; font-size: 10px; margin-top: 0px;">
//|            Etkinlik Tarihi: 2026-06-15    |    Oluşturma Saati: 11:30
//|        </p>
//|
//|        //|        <img src="https://storage.fitfak.net/images/fitfak-banner" style="position: absolute; bottom: 25px; left: 30px;" width="60" />
//|        <div style="position: absolute; bottom: 38px; left: 105px; width: 150px;">
//|            <b style="font-size: 12px; color: #033248;">FITFAK</b>
//|            <div style="font-size: 10px; color: #274a57; margin-top: 3px;">Sport Club</div>
//|        </div>
//|
//|        //|        <div style="position: absolute; bottom: 38px; right: 105px; width: 200px; text-align: right;">
//|            <b style="font-size: 12px; color: #033248;">Cumhuriyet Üniversitesi</b>
//|            <div style="font-size: 10px; color: #274a57; margin-top: 3px;">Tıp Fakültesi</div>
//|        </div>
//|        <img src="https://storage.fitfak.net/images/school-logo" style="position: absolute; bottom: 25px; right: 30px;" width="60" />
//|    </div>
//|`;
//|
//|async function buildCertificate() {
//|    console.time("⏱️ Derleme Süresi");
//|    try {
//|        const PAPER_SIZE = 'A5_LANDSCAPE'; 
//|        
//|        console.log("🚀 1. Ağaç Çıkarılıyor ve URL Görselleri İndiriliyor...");
//|        const safeHTML = sanitizeTurkish(certificateHTML);
//|        const astRoot = HTMLTokenizer.parse(safeHTML);
//|        await ImageLoader.enhanceAST(astRoot);
//|
//|        console.log("📐 2. Aspect Ratio Box Model Hesaplanıyor...");
//|        const layoutEngine = new BoxModelEngine(PAPER_SIZE, [20, 20, 20, 20]);
//|        const renderQueue = layoutEngine.calculateLayout(astRoot);
//|
//|        console.log("⚙️  3. Koyu Çerçeve ve Gelişmiş Maskelerle Derleniyor...");
//|        const pdfEngine = new PDFEngine('Sertifika_Final.pdf', PAPER_SIZE);
//|        const outputPath = await pdfEngine.compile(renderQueue);
//|        
//|        console.log(`\n✅ Başarılı! Kusursuz Hizalanmış Sertifika: ${outputPath}`);
//|    } catch (error) {
//|        console.error("❌ Hata:", error);
//|    } finally {
//|        console.timeEnd("⏱️ Derleme Süresi");
//|    }
//|}
//|buildCertificate();