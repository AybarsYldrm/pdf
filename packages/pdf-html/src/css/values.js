'use strict';
/**
 * CSS değer çözümleyicileri: birimler, renkler, kısayol özellikleri.
 *
 * Tüm uzunluklar PDF kullanıcı birimine (1/72 inç = 1pt) çevrilir.
 */

const PT_PER_UNIT = {
  pt: 1,
  px: 0.75,              // 96 dpi varsayımı: 1px = 0.75pt
  in: 72,
  cm: 72 / 2.54,
  mm: 72 / 25.4,
  q:  72 / 101.6,        // çeyrek milimetre
  pc: 12
};

const NAMED_COLORS = {
  transparent: [0, 0, 0, 0],
  black: [0, 0, 0, 1],           white: [255, 255, 255, 1],
  red: [255, 0, 0, 1],           green: [0, 128, 0, 1],
  blue: [0, 0, 255, 1],          yellow: [255, 255, 0, 1],
  orange: [255, 165, 0, 1],      purple: [128, 0, 128, 1],
  gray: [128, 128, 128, 1],      grey: [128, 128, 128, 1],
  silver: [192, 192, 192, 1],    maroon: [128, 0, 0, 1],
  navy: [0, 0, 128, 1],          teal: [0, 128, 128, 1],
  olive: [128, 128, 0, 1],       lime: [0, 255, 0, 1],
  aqua: [0, 255, 255, 1],        cyan: [0, 255, 255, 1],
  fuchsia: [255, 0, 255, 1],     magenta: [255, 0, 255, 1],
  darkgray: [169, 169, 169, 1],  lightgray: [211, 211, 211, 1],
  whitesmoke: [245, 245, 245, 1], crimson: [220, 20, 60, 1]
};

/**
 * Bir uzunluk değerini pt'ye çevirir.
 *
 * @param {string|number} value
 * @param {{ fontSize?:number, rootFontSize?:number, percentBase?:number,
 *           viewportWidth?:number, viewportHeight?:number }} [ctx]
 * @returns {number|null} pt cinsinden değer; çözülemezse null
 */
function toPt(value, ctx = {}) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value;

  const s = String(value).trim().toLowerCase();
  if (s === '0') return 0;
  if (s === 'auto' || s === 'none' || s === 'normal') return null;

  const m = /^(-?[\d.]+)([a-z%]*)$/.exec(s);
  if (!m) return null;

  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  const unit = m[2] || 'px';

  if (PT_PER_UNIT[unit] !== undefined) return n * PT_PER_UNIT[unit];

  switch (unit) {
    case 'em':   return n * (ctx.fontSize || 12);
    case 'rem':  return n * (ctx.rootFontSize || 12);
    case 'ch':   return n * (ctx.fontSize || 12) * 0.5;
    case 'ex':   return n * (ctx.fontSize || 12) * 0.5;
    case '%':    return ctx.percentBase != null ? (n / 100) * ctx.percentBase : null;
    case 'vw':   return ctx.viewportWidth  != null ? (n / 100) * ctx.viewportWidth  : null;
    case 'vh':   return ctx.viewportHeight != null ? (n / 100) * ctx.viewportHeight : null;
    default:     return null;
  }
}

/** Değer yüzde mi? (yüzdeler yerleşim sırasında geç çözülür) */
function isPercent(value) {
  return typeof value === 'string' && value.trim().endsWith('%');
}

/**
 * Renk ayrıştırır. `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`,
 * `hsl()`, `hsla()` ve isimli renkler desteklenir.
 * @returns {[number,number,number,number]|null} [r,g,b,a] — r/g/b 0-255, a 0-1
 */
function toColor(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.length === 4 ? value : [...value, 1];

  const s = String(value).trim().toLowerCase();
  if (NAMED_COLORS[s]) return [...NAMED_COLORS[s]];

  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      hex = hex.split('').map((c) => c + c).join('');
    }
    if (hex.length !== 6 && hex.length !== 8) return null;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    if ([r, g, b].some(Number.isNaN)) return null;
    return [r, g, b, a];
  }

  let m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean);
    const r = parseChannel(parts[0]);
    const g = parseChannel(parts[1]);
    const b = parseChannel(parts[2]);
    const a = parts[3] !== undefined ? parseAlpha(parts[3]) : 1;
    if ([r, g, b].some((v) => v == null)) return null;
    return [r, g, b, a];
  }

  m = /^hsla?\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean);
    const h = parseFloat(parts[0]);
    const sat = parseFloat(parts[1]) / 100;
    const l = parseFloat(parts[2]) / 100;
    const a = parts[3] !== undefined ? parseAlpha(parts[3]) : 1;
    if ([h, sat, l].some(Number.isNaN)) return null;
    const [r, g, b] = hslToRgb(h, sat, l);
    return [r, g, b, a];
  }

  return null;
}

function parseChannel(v) {
  if (v == null) return null;
  if (v.endsWith('%')) return Math.round(parseFloat(v) * 2.55);
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : Math.max(0, Math.min(255, Math.round(n)));
}

function parseAlpha(v) {
  if (v == null) return 1;
  if (v.endsWith('%')) return Math.max(0, Math.min(1, parseFloat(v) / 100));
  const n = parseFloat(v);
  return Number.isNaN(n) ? 1 : Math.max(0, Math.min(1, n));
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue(h + 1 / 3) * 255),
    Math.round(hue(h) * 255),
    Math.round(hue(h - 1 / 3) * 255)
  ];
}

/**
 * `margin: 10px 20px` gibi kısayolları dört kenara açar.
 * @returns {{top:string, right:string, bottom:string, left:string}}
 */
function expandBox(value) {
  const parts = String(value).trim().split(/\s+/);
  if (parts.length === 1) return { top: parts[0], right: parts[0], bottom: parts[0], left: parts[0] };
  if (parts.length === 2) return { top: parts[0], right: parts[1], bottom: parts[0], left: parts[1] };
  if (parts.length === 3) return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[1] };
  return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[3] };
}

/** `border: 1pt solid #000` kısayolunu parçalar. */
function expandBorder(value) {
  const out = { width: null, style: null, color: null };
  const parts = String(value).trim().split(/\s+(?![^(]*\))/);
  const styles = ['none', 'hidden', 'solid', 'dashed', 'dotted', 'double'];
  for (const p of parts) {
    if (styles.includes(p.toLowerCase())) out.style = p.toLowerCase();
    else if (toColor(p)) out.color = p;
    else if (toPt(p) != null) out.width = p;
  }
  return out;
}

/** `font: bold 12pt/1.4 Ubuntu, sans-serif` kısayolunu parçalar. */
function expandFont(value) {
  const out = {};
  const s = String(value).trim();
  const m = /^(?:(normal|italic|oblique)\s+)?(?:(normal|bold|[1-9]00)\s+)?([\d.]+[a-z%]*)(?:\s*\/\s*([\d.]+[a-z%]*))?\s+(.+)$/i.exec(s);
  if (!m) return out;
  if (m[1]) out.fontStyle = m[1].toLowerCase();
  if (m[2]) out.fontWeight = m[2].toLowerCase();
  if (m[3]) out.fontSize = m[3];
  if (m[4]) out.lineHeight = m[4];
  if (m[5]) out.fontFamily = m[5];
  return out;
}

/** `font-family` listesini diziye çevirir. */
function fontFamilyList(value) {
  if (!value) return [];
  return String(value).split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/** Ağırlık adını sayıya çevirir. */
function fontWeightNumber(value) {
  if (value == null) return 400;
  const s = String(value).trim().toLowerCase();
  if (s === 'normal') return 400;
  if (s === 'bold') return 700;
  if (s === 'lighter') return 300;
  if (s === 'bolder') return 700;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? 400 : n;
}

module.exports = {
  PT_PER_UNIT, NAMED_COLORS,
  toPt, isPercent, toColor, expandBox, expandBorder, expandFont,
  fontFamilyList, fontWeightNumber, hslToRgb
};
