'use strict';
const fs = require('fs');
class PDFStreamWriter {
    constructor(outputPath) { this.outputPath = outputPath; this.stream = fs.createWriteStream(outputPath, { flags: 'w', encoding: 'binary' }); this.offset = 0; }
    write(chunk) { const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'binary'); this.stream.write(b); this.offset += b.length; return this.offset; }
    writeLine(line) { this.write(line + '\n'); }
    end() { return new Promise((res, rej) => { this.stream.on('finish', () => res(this.outputPath)); this.stream.end(); }); }
}
module.exports = PDFStreamWriter;