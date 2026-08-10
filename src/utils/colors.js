'use strict';
class ColorEngine {
    static parse(colorStr) {
        const def = { r: 0, g: 0, b: 0 };
        if (!colorStr) return def;
        if (colorStr.startsWith('#')) {
            let hex = colorStr.slice(1).replace(/[^0-9a-fA-F]/g, '');
            if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
            return { r: parseInt(hex.substring(0,2),16)/255||0, g: parseInt(hex.substring(2,4),16)/255||0, b: parseInt(hex.substring(4,6),16)/255||0 };
        }
        return def;
    }
    static toPdfColorString(c) { return `${c.r.toFixed(3)} ${c.g.toFixed(3)} ${c.b.toFixed(3)}`; }
}
module.exports = ColorEngine;