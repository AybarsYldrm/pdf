'use strict';
const ImageParser = require('../utils/image-parser');
class ImageLoader {
    static async enhanceAST(node) {
        if (node.tag === 'img' && node.attributes.src) {
            try {
                const imgData = await ImageParser.processImage(node.attributes.src);
                Object.assign(node, { imageBuffer: imgData.buffer, alphaBuffer: imgData.alphaBuffer, intrinsicWidth: imgData.width, intrinsicHeight: imgData.height, colorSpace: imgData.colorSpace, isFlate: imgData.isFlate });
            } catch (e) { console.error(`⚠️ Görsel Hatası: ${node.attributes.src} -> ${e.message}`); }
        }
        if (node.children) { for (const child of node.children) await this.enhanceAST(child); }
    }
}
module.exports = ImageLoader;