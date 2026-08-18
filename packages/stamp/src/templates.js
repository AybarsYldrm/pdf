'use strict';
/**
 * Hazır damga şablonları.
 *
 * Koordinatlar 1280×320 tuval içindir; `renderStamp({ size })` ile ölçek
 * değiştirilebilir (şablonun kendi ölçeğinde çizilip küçültülmez — slotlar
 * doğrudan verilen boyuta göre çizilir, bu yüzden özel boyutlarda kendi
 * şablonunuzu tanımlamanız önerilir).
 *
 * Kullanılabilir yer tutucular: {signerName} {role} {date} {docNo}
 * {verifyUrl} {logo} {handwritten} {org}
 */

/**
 * `classic` — eski `generateStamp()` çıktısıyla BİREBİR aynı.
 * Sol yarı: doku + ad. Sol alt: koyu bant + logo + FITFAK. Sağ: Code39.
 * Bu şablon değiştirilmemelidir; geriye dönük uyum testi buna bakar.
 */
const classic = {
  // Bu şablon YENİDEN UYGULANMAZ: renderStamp() bunu görünce doğrudan eski
  // generateStamp()'i çağırır. Çıktının bit-bit aynı kalması böyle garanti
  // altına alınır ve Code39 yapısı hiç kopyalanmamış olur.
  legacy: true,
  size: { width: 1280, height: 320 },
  leftW: 560,
  rightW: 720,
  supersample: 4
};

/** `qr` — Code39 yerine QR. Telefonla okutulup doğrulama sayfası açılır. */
const qr = {
  size: { width: 1280, height: 320 },
  background: 'transparent',
  slots: [
    { type: 'group', rect: [0, 0, 560, 320], supersample: 4, slots: [
      { type: 'grain', rect: [0, 0, 560, 160] },
      { type: 'text',  rect: [0, 0, 560, 160], value: '{signerName}',
        transform: 'upper-tr', color: [35, 35, 35], fontSize: 51.2 },
      { type: 'band',  rect: [0, 160, 560, 160], color: [35, 35, 35] },
      { type: 'image', rect: [33, 184, 96, 112], src: '{logo}' },
      { type: 'text',  rect: [140, 160, 420, 160], value: 'FITFAK',
        transform: 'upper-tr', color: [220, 220, 220], fontSize: 96, wrap: false }
    ] },
    { type: 'band', rect: [560, 0, 720, 320], color: [255, 255, 255] },
    { type: 'qr',   rect: [580, 10, 300, 300], value: '{verifyUrl}', ecLevel: 'M', quietZone: 2 },
    { type: 'group', rect: [896, 80, 368, 180], supersample: 3, slots: [
      { type: 'text', rect: [0, 0, 368, 56], value: '{docNo}',
        color: [35, 35, 35], fontSize: 34, align: 'left', wrap: false },
      { type: 'text', rect: [0, 60, 368, 48], value: '{date}',
        color: [90, 90, 90], fontSize: 26, align: 'left', wrap: false },
      { type: 'text', rect: [0, 112, 368, 48], value: '{role}',
        color: [120, 120, 120], fontSize: 24, align: 'left', wrap: false }
    ] }
  ]
};

/** `dual` — hem Code39 hem QR. Eski barkod okuyucular ve telefonlar birlikte. */
const dual = {
  size: { width: 1280, height: 320 },
  background: 'transparent',
  slots: [
    { type: 'group', rect: [0, 0, 560, 320], supersample: 4, slots: [
      { type: 'grain', rect: [0, 0, 560, 160] },
      { type: 'text',  rect: [0, 0, 560, 160], value: '{signerName}',
        transform: 'upper-tr', color: [35, 35, 35], fontSize: 51.2 },
      { type: 'band',  rect: [0, 160, 560, 160], color: [35, 35, 35] },
      { type: 'image', rect: [33, 184, 96, 112], src: '{logo}' },
      { type: 'text',  rect: [140, 160, 420, 160], value: 'FITFAK',
        transform: 'upper-tr', color: [220, 220, 220], fontSize: 96, wrap: false }
    ] },
    { type: 'band',   rect: [560, 0, 720, 320], color: [255, 255, 255] },
    { type: 'qr',     rect: [570, 10, 300, 300], value: '{verifyUrl}', ecLevel: 'M', quietZone: 2 },
    { type: 'code39', rect: [880, 0, 400, 320], value: '{docNo}', quietZone: 8 }
  ]
};

/** `minimal` — yalnız ad, rol ve tarih. Dar imza kutuları için. */
const minimal = {
  size: { width: 900, height: 260 },
  background: 'transparent',
  slots: [
    { type: 'group', rect: [0, 0, 900, 260], supersample: 3, slots: [
      { type: 'rule', rect: [0, 0, 900, 3], color: [35, 35, 35], thickness: 3 },
      { type: 'text', rect: [0, 20, 900, 110], value: '{signerName}',
        transform: 'upper-tr', color: [20, 45, 95], fontSize: 62 },
      { type: 'text', rect: [0, 130, 900, 50], value: '{role}',
        color: [90, 90, 90], fontSize: 34 },
      { type: 'text', rect: [0, 180, 900, 44], value: '{date}',
        color: [130, 130, 130], fontSize: 28 },
      { type: 'text', rect: [0, 220, 900, 40], value: '{docNo}',
        color: [150, 150, 150], fontSize: 24 }
    ] }
  ]
};

/** `handwritten` — kullanıcının kendi imza görseli + küçük QR. */
const handwritten = {
  size: { width: 1100, height: 340 },
  background: 'transparent',
  slots: [
    { type: 'handwritten', rect: [20, 10, 700, 200], src: '{handwritten}',
      inkColor: [20, 40, 90], when: 'handwritten' },
    { type: 'rule', rect: [20, 215, 700, 2], color: [120, 120, 120], thickness: 2 },
    { type: 'text', rect: [20, 225, 700, 56], value: '{signerName}',
      transform: 'upper-tr', color: [35, 35, 35], fontSize: 40, align: 'left' },
    { type: 'text', rect: [20, 280, 700, 46], value: '{role}',
      color: [110, 110, 110], fontSize: 28, align: 'left' },
    { type: 'qr',   rect: [760, 30, 260, 260], value: '{verifyUrl}', ecLevel: 'M', quietZone: 2 },
    { type: 'text', rect: [760, 292, 260, 38], value: '{docNo}',
      color: [140, 140, 140], fontSize: 22 }
  ]
};

/** `kurumsal` — antetli, yatay, resmî görünüm. */
const kurumsal = {
  size: { width: 1400, height: 300 },
  background: [255, 255, 255],
  slots: [
    { type: 'band',  rect: [0, 0, 1400, 8], color: [20, 45, 95] },
    { type: 'image', rect: [30, 40, 120, 120], src: '{logo}' },
    { type: 'text',  rect: [170, 35, 640, 70], value: '{signerName}',
      transform: 'upper-tr', color: [20, 45, 95], fontSize: 52, align: 'left' },
    { type: 'text',  rect: [170, 105, 640, 46], value: '{role}',
      color: [70, 90, 120], fontSize: 32, align: 'left' },
    { type: 'text',  rect: [170, 155, 640, 40], value: '{org}',
      color: [110, 120, 140], fontSize: 26, align: 'left' },
    { type: 'rule',  rect: [170, 205, 640, 2], color: [200, 210, 225], thickness: 2 },
    { type: 'text',  rect: [170, 215, 640, 40], value: 'Belge No: {docNo}',
      color: [130, 140, 160], fontSize: 24, align: 'left', wrap: false },
    { type: 'text',  rect: [170, 252, 640, 40], value: '{date}',
      color: [130, 140, 160], fontSize: 24, align: 'left', wrap: false },
    { type: 'qr',    rect: [1130, 40, 240, 240], value: '{verifyUrl}', ecLevel: 'M', quietZone: 2 }
  ]
};

module.exports = { classic, qr, dual, minimal, handwritten, kurumsal };
