'use strict';
module.exports = {
    PAGE_SIZES: { A4: { width: 595.28, height: 841.89 }, A5_LANDSCAPE: { width: 595.28, height: 419.53 } },
    DEFAULT_STYLES: {
        'div': { display: 'block', marginTop: '0px', marginBottom: '0px' },
        'p': { display: 'block', marginTop: '16px', marginBottom: '16px' },
        'h1': { display: 'block', marginTop: '24px', marginBottom: '24px', fontSize: '32px', fontWeight: 'bold' },
        'h2': { display: 'block', marginTop: '18px', marginBottom: '18px', fontSize: '24px', fontWeight: 'bold' },
        'span': { display: 'inline' }, 'b': { display: 'inline', fontWeight: 'bold' }
    },
    INHERITABLE_PROPERTIES: ['color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'textAlign'],
    HELVETICA_METRIC_MULTIPLIER: 0.51
};