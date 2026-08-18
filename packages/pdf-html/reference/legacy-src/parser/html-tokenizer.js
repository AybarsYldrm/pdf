'use strict';
const CSSParser = require('./css-parser');
class HTMLTokenizer {
    static parse(htmlString) {
        const root = { tag: 'body', styles: CSSParser.computeStyles('div'), children: [] };
        const stack = [root];
        const tagRegex = /<(\/?)([a-zA-Z1-6\-]+)([^>]*)>/g;
        let lastIndex = 0, match;
        while ((match = tagRegex.exec(htmlString)) !== null) {
            if (match.index > lastIndex) {
                let text = htmlString.substring(lastIndex, match.index).replace(/\s+/g, ' ').trim();
                if (text) stack[stack.length - 1].children.push({ type: 'text', content: text, styles: { ...stack[stack.length - 1].styles } });
            }
            if (match[1] === '/') {
                for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === match[2].toLowerCase()) { stack.length = i; break; }
            } else {
                const attrsStr = match[3];
                const attributes = {};
                const attrRegex = /([a-zA-Z0-9\-]+)(?:\s*=\s*(?:(?:"([^"]*)")|(?:'([^']*)')|([^>\s]+)))?/g;
                let am; while ((am = attrRegex.exec(attrsStr)) !== null) attributes[am[1].toLowerCase()] = am[2] || am[3] || am[4] || '';
                const node = { type: 'element', tag: match[2].toLowerCase(), attributes, styles: CSSParser.computeStyles(match[2].toLowerCase(), stack[stack.length - 1].styles, attributes.style || ''), children: [] };
                stack[stack.length - 1].children.push(node);
                if (!['img', 'br', 'hr'].includes(node.tag)) stack.push(node);
            }
            lastIndex = tagRegex.lastIndex;
        }
        return root;
    }
}
module.exports = HTMLTokenizer;