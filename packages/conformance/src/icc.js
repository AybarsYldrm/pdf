'use strict';
/**
 * En küçük geçerli sRGB ICC v2 profili — ISO 15076-1 / ICC.1:2001-04.
 *
 * PDF/A, cihaza bağımlı renklerin (DeviceRGB) yorumlanabilmesi için gömülü bir
 * ICC profili taşıyan çıktı amacı (`/OutputIntent`) ister. Dışarıdan ikili bir
 * profil dosyası taşımak yerine profili burada ÜRETİYORUZ: paket saf JS kalır,
 * çıktı deterministiktir ve ne yazdığımızı satır satır görebiliriz.
 *
 * Profil `RGB ` → `XYZ ` bir görüntüleme (display) profilidir; sRGB'nin
 * IEC 61966-2.1'deki birincil renkleri, D65 beyaz noktası ve gama eğrisi
 * kullanılır.
 */

/** s15Fixed16Number (ICC'nin 16.16 sabit noktalı sayısı). */
function s15f16(value) {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(Math.round(value * 65536), 0);
  return buf;
}

function tag(name) {
  return Buffer.from(name, 'latin1');
}

/** XYZType etiketi: 'XYZ ' + 4 sıfır + 3 × s15Fixed16 */
function xyzType(x, y, z) {
  return Buffer.concat([tag('XYZ '), Buffer.alloc(4), s15f16(x), s15f16(y), s15f16(z)]);
}

/**
 * curveType etiketi.
 * Tek girdi = gama değeri (u8Fixed8Number). sRGB'nin gerçek eğrisi parçalı
 * doğrusaldır; 2.2 gama, ICC v2'de bunun standart yaklaşıklamasıdır.
 */
function curveType(gamma = 2.2) {
  const buf = Buffer.alloc(14);
  tag('curv').copy(buf, 0);
  buf.writeUInt32BE(0, 4);                       // ayrılmış
  buf.writeUInt32BE(1, 8);                       // giriş sayısı
  buf.writeUInt16BE(Math.round(gamma * 256), 12);
  return buf;
}

/** textDescriptionType ('desc') — ICC v2'nin metin etiketi. */
function descType(text) {
  const ascii = Buffer.from(text + '\0', 'latin1');
  const buf = Buffer.alloc(12 + ascii.length + 12 + 67);
  let p = 0;
  tag('desc').copy(buf, p); p += 4;
  buf.writeUInt32BE(0, p); p += 4;               // ayrılmış
  buf.writeUInt32BE(ascii.length, p); p += 4;    // ASCII uzunluğu
  ascii.copy(buf, p); p += ascii.length;
  buf.writeUInt32BE(0, p); p += 4;               // Unicode dil kodu
  buf.writeUInt32BE(0, p); p += 4;               // Unicode uzunluğu
  buf.writeUInt16BE(0, p); p += 2;               // ScriptCode kodu
  buf.writeUInt8(0, p); p += 1;                  // ScriptCode uzunluğu
  // kalan 67 bayt ScriptCode alanı zaten sıfır
  return buf;
}

/** textType ('text') — telif hakkı gibi düz metinler. */
function textType(text) {
  return Buffer.concat([tag('text'), Buffer.alloc(4), Buffer.from(text + '\0', 'latin1')]);
}

/** 4 baytlık hizalamaya tamamlar (ICC etiket verileri hizalı olmalıdır). */
function pad4(buf) {
  const rem = buf.length % 4;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem)]);
}

/**
 * sRGB ICC v2 profilini üretir.
 * @returns {Buffer} ~0.5 KB, deterministik
 */
function sRGBProfile() {
  // sRGB birincil renkleri, D50'ye Bradford ile uyarlanmış hâlde (ICC PCS D50'dir)
  const tags = [
    ['desc', pad4(descType('sRGB IEC61966-2.1'))],
    ['cprt', pad4(textType('Public Domain'))],
    ['wtpt', pad4(xyzType(0.96420, 1.00000, 0.82491))],   // D50
    ['rXYZ', pad4(xyzType(0.43607, 0.22249, 0.01392))],
    ['gXYZ', pad4(xyzType(0.38515, 0.71687, 0.09708))],
    ['bXYZ', pad4(xyzType(0.14307, 0.06061, 0.71410))],
    ['rTRC', pad4(curveType(2.2))],
    ['gTRC', pad4(curveType(2.2))],
    ['bTRC', pad4(curveType(2.2))]
  ];

  const headerSize = 128;
  const tableSize = 4 + tags.length * 12;
  let offset = headerSize + tableSize;

  const entries = [];
  const bodies = [];
  for (const [name, data] of tags) {
    entries.push({ name, offset, size: data.length });
    bodies.push(data);
    offset += data.length;
  }
  const total = offset;

  const header = Buffer.alloc(headerSize);
  header.writeUInt32BE(total, 0);                // profil boyutu
  tag('FTFK').copy(header, 4);                   // tercih edilen CMM
  header.writeUInt32BE(0x02100000, 8);           // sürüm 2.1.0
  tag('mntr').copy(header, 12);                  // cihaz sınıfı: monitör
  tag('RGB ').copy(header, 16);                  // veri renk uzayı
  tag('XYZ ').copy(header, 20);                  // PCS

  // Oluşturma tarihi: SABİT — çıktının deterministik kalması için
  header.writeUInt16BE(2026, 24);                // yıl
  header.writeUInt16BE(1, 26);                   // ay
  header.writeUInt16BE(1, 28);                   // gün

  tag('acsp').copy(header, 36);                  // dosya imzası
  header.writeUInt32BE(0, 40);                   // birincil platform (yok)
  header.writeUInt32BE(0, 44);                   // profil bayrakları
  header.writeUInt32BE(0, 64);                   // renklendirme amacı: algısal

  // PCS aydınlatıcısı D50
  s15f16(0.96420).copy(header, 68);
  s15f16(1.00000).copy(header, 72);
  s15f16(0.82491).copy(header, 76);

  const table = Buffer.alloc(tableSize);
  table.writeUInt32BE(tags.length, 0);
  entries.forEach((entry, i) => {
    const at = 4 + i * 12;
    tag(entry.name).copy(table, at);
    table.writeUInt32BE(entry.offset, at + 4);
    table.writeUInt32BE(entry.size, at + 8);
  });

  return Buffer.concat([header, table, ...bodies]);
}

/** Profil başlığını okur (doğrulama ve tanılama için). */
function readProfileHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 128) return null;
  if (buf.toString('latin1', 36, 40) !== 'acsp') return null;

  return {
    size: buf.readUInt32BE(0),
    version: `${buf[8]}.${buf[9] >> 4}.${buf[9] & 0x0f}`,
    deviceClass: buf.toString('latin1', 12, 16),
    colorSpace: buf.toString('latin1', 16, 20).trim(),
    pcs: buf.toString('latin1', 20, 24).trim(),
    tagCount: buf.length >= 132 ? buf.readUInt32BE(128) : 0
  };
}

/** Renk uzayı → PDF `/N` bileşen sayısı. */
const COMPONENTS = { RGB: 3, GRAY: 1, CMYK: 4 };

module.exports = { sRGBProfile, readProfileHeader, COMPONENTS };
