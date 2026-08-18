'use strict';
const https = require('https');
const zlib = require('zlib');
class ImageParser {
    static fetchBuffer(url) {
        return new Promise((res, rej) => {
            https.get(url, r => {
                if ([301, 302, 308].includes(r.statusCode)) return res(this.fetchBuffer(r.headers.location));
                if (r.statusCode !== 200) return rej(new Error(`HTTP ${r.statusCode}`));
                const data = []; r.on('data', c => data.push(c)); r.on('end', () => res(Buffer.concat(data)));
            }).on('error', rej);
        });
    }
    static async processImage(url) {
        const b = await this.fetchBuffer(url);
        if (b[0] === 0xFF && b[1] === 0xD8) return this.parseJPEG(b);
        if (b[0] === 0x89 && b[1] === 0x50) return this.parsePNG(b);
        throw new Error("Gecersiz format.");
    }
    static parseJPEG(b) {
        let o = 2;
        while (o < b.length) {
            if (b[o] !== 0xFF) { o++; continue; }
            let m = b[o + 1];
            if (m === 0xC0 || m === 0xC1 || m === 0xC2) return { width: b.readUInt16BE(o + 7), height: b.readUInt16BE(o + 5), colorSpace: b[o + 9] === 3 ? 'DeviceRGB' : 'DeviceGray', buffer: b, isFlate: false };
            o += 2 + b.readUInt16BE(o + 2);
        }
        throw new Error("Gecersiz JPEG");
    }
    static parsePNG(b) {
        let o = 8, w, h, bd, ct, bpp; const idat = []; let plte, trns;
        while (o < b.length) {
            const len = b.readUInt32BE(o); const type = b.toString('ascii', o+4, o+8); const doff = o+8;
            if (type === 'IHDR') {
                w = b.readUInt32BE(doff); h = b.readUInt32BE(doff+4); bd = b.readUInt8(doff+8); ct = b.readUInt8(doff+9);
                bpp = ct===0||ct===3 ? Math.max(1, bd/8) : ct===2 ? 3*(bd/8) : ct===4 ? 2*(bd/8) : 4*(bd/8);
            } else if (type === 'PLTE') plte = b.subarray(doff, doff+len);
            else if (type === 'tRNS') trns = b.subarray(doff, doff+len);
            else if (type === 'IDAT') idat.push(b.subarray(doff, doff+len));
            else if (type === 'IEND') break;
            o += 12 + len;
        }
        const inf = zlib.inflateSync(Buffer.concat(idat));
        const hasA = ct===6 || ct===4 || trns;
        const rgb = Buffer.alloc(w * h * 3); const alpha = hasA ? Buffer.alloc(w * h, 255) : null;
        let rs = ct===0||ct===3 ? Math.ceil(w*bd/8) : ct===2 ? w*3*(bd/8) : ct===4 ? w*2*(bd/8) : w*4*(bd/8);
        const pRow = Buffer.alloc(rs), cRow = Buffer.alloc(rs);
        let iO = 0, rI = 0, aI = 0;
        for (let y = 0; y < h; y++) {
            const ft = inf[iO++];
            for (let x = 0; x < rs; x++) {
                const raw = inf[iO+x], left = x>=bpp ? cRow[x-bpp] : 0, up = pRow[x], upL = x>=bpp ? pRow[x-bpp] : 0;
                let val = raw;
                if(ft===1) val += left; else if(ft===2) val += up; else if(ft===3) val += Math.floor((left+up)/2);
                else if(ft===4) { const p = left+up-upL, pa = Math.abs(p-left), pb = Math.abs(p-up), pc = Math.abs(p-upL); val += (pa<=pb && pa<=pc ? left : pb<=pc ? up : upL); }
                cRow[x] = val & 0xFF;
            }
            for (let i = 0; i < w; i++) {
                let r=0,g=0,b=0,a=255;
                if (ct===2) { r=cRow[i*3]; g=cRow[i*3+1]; b=cRow[i*3+2]; }
                else if (ct===6) { r=cRow[i*4]; g=cRow[i*4+1]; b=cRow[i*4+2]; a=cRow[i*4+3]; }
                else if (ct===3) {
                    const ppb = 8/bd; const shift = 8-bd-((i%ppb)*bd);
                    const idx = (cRow[Math.floor(i/ppb)] >> shift) & ((1<<bd)-1);
                    if(plte) { r=plte[idx*3]; g=plte[idx*3+1]; b=plte[idx*3+2]; }
                    if(trns && idx<trns.length) a=trns[idx];
                } else if (ct===0 || ct===4) {
                    let v=cRow[i]; if(bd<8) { const ppb=8/bd; const shift=8-bd-((i%ppb)*bd); v=(cRow[Math.floor(i/ppb)]>>shift)&((1<<bd)-1); v=Math.round(v*255/((1<<bd)-1)); }
                    r=g=b=v; if(ct===4) a=cRow[i*2+1];
                }
                rgb[rI++]=r; rgb[rI++]=g; rgb[rI++]=b; if(hasA) alpha[aI++]=a;
            }
            cRow.copy(pRow); iO+=rs;
        }
        return { width:w, height:h, colorSpace: 'DeviceRGB', isFlate: true, buffer: zlib.deflateSync(rgb), alphaBuffer: hasA ? zlib.deflateSync(alpha) : null };
    }
}
module.exports = ImageParser;