'use strict';
const { HELVETICA_METRIC_MULTIPLIER } = require('../constants/specs');
class UnitEngine {
    static parseToPt(value, baseSize = 12) {
        if (!value) return 0;
        if (typeof value === 'number') return value;
        const num = parseFloat(value.toString().trim().toLowerCase());
        if (isNaN(num)) return 0;
        if (value.toString().toLowerCase().endsWith('px')) return num * 0.75;
        return num * 0.75;
    }
    static measureTextWidth(text, fontSizePt) { return text ? text.length * (fontSizePt * HELVETICA_METRIC_MULTIPLIER) : 0; }
}
module.exports = UnitEngine;