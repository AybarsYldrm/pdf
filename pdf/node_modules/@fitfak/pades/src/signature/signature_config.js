'use strict';
const path = require('path');
// YANLIŞ OLAN İÇE AKTARMAYI SİLİYORUZ:
// const { buildSignatureImageBuffer } = require('./signature_assets');

// DOĞRU OLAN: stamp.js içindeki fonksiyonu alıyoruz
const { generateStamp } = require('./stamp');

const {
  DEFAULT_SIGNATURE_ORIGIN,
  DEFAULT_SIGNATURE_POSITION,
  parseSignaturePositions
} = require('./signature_positions');

const resolveSignatureOutputPath = (env) => {
  if (env.SIGNATURE_IMAGE_OUTPUT) {
    return path.resolve(env.SIGNATURE_IMAGE_OUTPUT);
  }
  return null;
};

const buildVisibleSignatureConfig = ({ baseDir, env, signerName }) => {
  const signatureOutputPath = resolveSignatureOutputPath(env);
  let signatureImageBuffer = null;

  try {
    // ASIL DÜZELTME BURADA: generateStamp fonksiyonunu çağırıyoruz
    signatureImageBuffer = generateStamp({
      // BURADAKİ YOLLARI KENDİ PROJE KLASÖRÜNE GÖRE DÜZENLEMELİSİN
      fontPath: path.join(baseDir, './src/assets/font.ttf'), // Veya kullandığın TTF
      pngLogoPath: path.join(baseDir, './src/assets/caduceus.png'), // Veya kullandığın Logo
      personName: signerName || 'Bilinmeyen İmzac',
      outPath: signatureOutputPath, 
      finalW: 1280, // stamp.js içindeki default ayarlar
      finalH: 320,
    });
  } catch (error) {
    console.warn('Görsel imza üretilemedi (Signature image generation failed):', error.message);
  }

  // Eğer görsel üretilemezse eski görünmez (invisible) moda geri döner
  if (!signatureImageBuffer) {
    return null; 
  }

  const defaultOrigin = env.SIGNATURE_ORIGIN || DEFAULT_SIGNATURE_ORIGIN;
  const signaturePositions = parseSignaturePositions(env.SIGNATURE_POSITIONS, {
    ...DEFAULT_SIGNATURE_POSITION,
    origin: defaultOrigin
  });

  return {
    imageBuffer: signatureImageBuffer,
    coordinateMap: signaturePositions.coordinateMap,
    defaultPosition: signaturePositions.defaultPosition,
    
    // Sistem uyumu için boş değerler
    textTemplate: '',
    textLines: [],
    text: '',
    signerName: signerName || '',
    useCertificateCN: false,
    cnFallbackEnabled: false
  };
};

module.exports = { buildVisibleSignatureConfig };