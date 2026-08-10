'use strict';
const { INHERITABLE_PROPERTIES, DEFAULT_STYLES } = require('../constants/specs');
class CSSParser {
    static parseInline(str) {
        const styles = {};
        if (!str) return styles;
        str.split(';').forEach(decl => {
            const i = decl.indexOf(':');
            if (i !== -1) styles[decl.substring(0, i).trim().replace(/-([a-z])/g, g => g[1].toUpperCase())] = decl.substring(i + 1).trim();
        });
        return styles;
    }
    static computeStyles(tag, parent = {}, inline = '') {
        const computed = { ...(DEFAULT_STYLES[tag] || DEFAULT_STYLES['span']) };
        INHERITABLE_PROPERTIES.forEach(p => { if (parent[p] !== undefined) computed[p] = parent[p]; });
        Object.assign(computed, this.parseInline(inline));
        return computed;
    }
}
module.exports = CSSParser;