'use strict';
const UnitEngine = require('../utils/units');
class TextWrapper {
    static wrap(text, fontSizePt, maxWidth) {
        const lines = [];
        if (!text) return lines;
        text.split('\n').forEach(paragraph => {
            if (!paragraph.trim()) return;
            let cl = '', cw = 0;
            paragraph.split(' ').forEach(word => {
                const ww = UnitEngine.measureTextWidth(word, fontSizePt);
                const sw = cl.length ? UnitEngine.measureTextWidth(' ', fontSizePt) : 0;
                if (cw + sw + ww > maxWidth && cl.length > 0) { lines.push({ text: cl, width: cw }); cl = word; cw = ww; }
                else { cl += (cl.length ? ' ' : '') + word; cw += sw + ww; }
            });
            if (cl) lines.push({ text: cl, width: cw });
        });
        return lines;
    }
}
module.exports = TextWrapper;