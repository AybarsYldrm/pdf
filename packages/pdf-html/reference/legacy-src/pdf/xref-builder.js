'use strict';
class XRefBuilder {
    constructor() { this.objects = []; }
    add(id, offset) { this.objects.push({ id, offset }); }
    buildTable() {
        this.objects.sort((a, b) => a.id - b.id);
        const count = this.objects.length ? this.objects[this.objects.length - 1].id + 1 : 1;
        let str = `xref\n0 ${count}\n0000000000 65535 f \n`;
        let e = 1;
        for (const obj of this.objects) { while (e++ < obj.id) str += `0000000000 65535 f \n`; str += `${obj.offset.toString().padStart(10, '0')} 00000 n \n`; }
        return str;
    }
}
module.exports = XRefBuilder;