'use strict';
const crypto = require('crypto');
const zlib = require('zlib');
const { parsePng } = require('../signature/png_decoder');

const PDF_STATE_CACHE = new WeakMap();

function getPdfState(pdf){
  if (!Buffer.isBuffer(pdf)) throw new Error('pdf must be Buffer');
  let state = PDF_STATE_CACHE.get(pdf);
  if (state) return state;
  const pdfStr = pdf.toString('latin1');
  const meta = _parseLastTrailer(pdfStr);
  const xrefMap = _buildXrefMap(pdfStr, meta.startxref);
  state = { pdfStr, meta, xrefMap };
  PDF_STATE_CACHE.set(pdf, state);
  return state;
}

function _parseLastTrailer(pdfStr){
  const sxRe = /startxref\s+(\d+)\s+%%EOF/g;
  let sxMatch = null;
  let m;
  while ((m = sxRe.exec(pdfStr)) !== null) sxMatch = m;
  if (!sxMatch) throw new Error('startxref not found');
  const startxref = parseInt(sxMatch[1], 10);
  const trailers = pdfStr.match(/trailer\s*<<[\s\S]*?>>/g);
  if (!trailers || !trailers.length) throw new Error('trailer not found');
  const trailerStr = trailers[trailers.length - 1];
  const rootM = /\/Root\s+(\d+)\s+0\s+R/.exec(trailerStr);
  const sizeM = /\/Size\s+(\d+)/.exec(trailerStr);
  if (!rootM || !sizeM) throw new Error('missing /Root or /Size');
  return {
    startxref,
    rootRef: rootM[1] + ' 0 R',
    rootObjNum: parseInt(rootM[1], 10),
    size: parseInt(sizeM[1], 10)
  };
}

function _skipWs(str, pos){
  while (pos < str.length) {
    const ch = str.charCodeAt(pos);
    if (ch === 0x20 || ch === 0x09 || ch === 0x0d || ch === 0x0a) pos++;
    else break;
  }
  return pos;
}

function _extractDictAt(str, idx){
  if (idx < 0 || idx >= str.length) return null;
  const tok = /<<|>>/g;
  tok.lastIndex = idx;
  let depth = 0, start = -1;
  let t;
  while ((t = tok.exec(str)) !== null) {
    const sym = str.substr(t.index, 2);
    if (sym === '<<') {
      if (depth === 0) start = t.index;
      depth++;
    } else {
      depth--;
      if (depth === 0) {
        return { dictStr: str.slice(start, t.index + 2), endPos: tok.lastIndex };
      }
      if (depth < 0) break;
    }
  }
  return null;
}

function _parseXrefAt(str, offset, map, visited){
  if (visited.has(offset)) return;
  visited.add(offset);
  if (offset < 0 || offset >= str.length) return;
  if (str.slice(offset, offset + 4) !== 'xref') return;
  let pos = offset + 4;
  pos = _skipWs(str, pos);
  while (pos < str.length){
    if (str.startsWith('trailer', pos)){
      pos += 7;
      pos = _skipWs(str, pos);
      const dictStart = str.indexOf('<<', pos);
      const dict = _extractDictAt(str, dictStart);
      if (dict) {
        const prevM = /\/Prev\s+(\d+)/.exec(dict.dictStr);
        if (prevM) _parseXrefAt(str, parseInt(prevM[1], 10), map, visited);
      }
      break;
    }
    const headerRe = /(\d+)\s+(\d+)/y;
    headerRe.lastIndex = pos;
    const header = headerRe.exec(str);
    if (!header) break;
    pos = headerRe.lastIndex;
    const startObj = parseInt(header[1], 10);
    const count = parseInt(header[2], 10);
    for (let i = 0; i < count; i++){
      const entryRe = /(\d{10})\s+(\d{5})\s+([nf])/y;
      entryRe.lastIndex = pos;
      const entry = entryRe.exec(str);
      if (!entry) return;
      pos = entryRe.lastIndex;
      if (entry[3] === 'n'){
        const objNum = startObj + i;
        const off = parseInt(entry[1], 10);
        if (!map.has(objNum)) map.set(objNum, off);
      }
      pos = _skipWs(str, pos);
    }
  }
}

function _buildXrefMap(str, startxref){
  const map = new Map();
  const visited = new Set();
  if (typeof startxref === 'number' && !Number.isNaN(startxref)){
    _parseXrefAt(str, startxref, map, visited);
  }
  return map;
}

/* ------------------------- Basit PDF yardımcıları ------------------------- */
function readLastTrailer(pdf){
  const state = getPdfState(pdf);
  const { meta } = state;
  return {
    startxref: meta.startxref,
    rootRef: meta.rootRef,
    rootObjNum: meta.rootObjNum,
    size: meta.size
  };
}

/* ---- DENGELİ blok okuyan geliştirilmiş readObject (iç içe << >> destekler) ---- */
function readObject(pdf, objNum){
  const state = getPdfState(pdf);
  const { pdfStr, xrefMap } = state;
  let offset = xrefMap.get(objNum);

  const legacyRead = () => {
    const re = new RegExp(String(objNum) + '\\s+0\\s+obj\\b', 'g');
    let match;
    let best = null;
    let bestPriority = -1;
    while ((match = re.exec(pdfStr)) !== null){
      const bodyStart = re.lastIndex;
      const endIdx = pdfStr.indexOf('endobj', bodyStart);
      if (endIdx < 0) break;
      const body = pdfStr.slice(bodyStart, endIdx);
      const relIdx = body.indexOf('<<');
      if (relIdx >= 0){
        const dict = _extractDictAt(body, relIdx);
        if (dict){
          const dictStr = dict.dictStr;
          const typeMatch = /\/Type\s*\/([A-Za-z]+)/.exec(dictStr);
          if (typeMatch){
            const t = typeMatch[1];
            let priority = 1;
            if (t === 'Page') priority = 5;
            else if (t === 'Pages' || t === 'Catalog') priority = 4;
            else if (t === 'AcroForm' || t === 'Annot' || t === 'Sig' || t === 'DocTimeStamp') priority = 3;
            else if (t === 'FontDescriptor') priority = 0;
            else priority = 2;
            if (priority >= bestPriority) {
              const startIdx = pdfStr.indexOf(dictStr, bodyStart);
              const endIdxAbs = (startIdx >= 0) ? startIdx + dictStr.length : -1;
              best = { dictStr, start: startIdx, end: endIdxAbs };
              bestPriority = priority;
            }
          } else {
            if (bestPriority <= 1) {
              const startIdx = pdfStr.indexOf(dictStr, bodyStart);
              const endIdxAbs = (startIdx >= 0) ? startIdx + dictStr.length : -1;
              best = { dictStr, start: startIdx, end: endIdxAbs };
              bestPriority = 1;
            }
          }
        }
      }
      re.lastIndex = endIdx + 6;
    }
    return best;
  };

  if (offset == null) {
    return legacyRead();
  }
  const headerRe = /(\d+)\s+(\d+)\s+obj\b/y;
  headerRe.lastIndex = offset;
  const header = headerRe.exec(pdfStr);
  if (!header || parseInt(header[1], 10) !== objNum) {
    return legacyRead();
  }
  const dictIdx = pdfStr.indexOf('<<', headerRe.lastIndex);
  if (dictIdx < 0) return legacyRead();
  const dict = _extractDictAt(pdfStr, dictIdx);
  if (!dict) return legacyRead();
  return { dictStr: dict.dictStr, start: dictIdx, end: dict.endPos };
}

/* -------------------- Güvenli /Page bulucu (Pages ağacı) -------------------- */
function _readKidsArray(dictStr){
  const m = /\/Kids\s*\[\s*([^\]]*)\]/.exec(dictStr);
  if (!m) return [];
  const arr = [];
  const re = /(\d+)\s+0\s+R/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) arr.push(parseInt(mm[1], 10));
  return arr;
}

function _dictHasType(dictStr, typeName){
  return new RegExp('\\/Type\\s+\\/' + typeName + '\\b').test(dictStr);
}

function _findFirstPageFrom(pdf, objNum, depth){
  if (depth > 20) return null;
  const obj = readObject(pdf, objNum);
  if (!obj) return null;
  if (_dictHasType(obj.dictStr, 'Page')) return objNum;
  if (_dictHasType(obj.dictStr, 'Pages')){
    const kids = _readKidsArray(obj.dictStr);
    for (let i=0;i<kids.length;i++){
      const p = _findFirstPageFrom(pdf, kids[i], depth+1);
      if (p) return p;
    }
  }
  return null;
}

/**
 * Belgedeki TÜM sayfa nesne numaralarını sırayla döndürür.
 *
 * Görünür imza bugüne kadar yalnız ilk sayfaya konabiliyordu; çok sayfalı
 * belgelerde imza yuvası son sayfada olsa bile damga birinci sayfaya basılıyordu.
 */
function listPageObjNums(pdf, objNum, depth, out){
  if (out === undefined) {
    const meta = readLastTrailer(pdf);
    const root = readObject(pdf, meta.rootObjNum);
    if (!root || !root.dictStr) return [];
    const pagesRef = /\/Pages\s+(\d+)\s+0\s+R/.exec(root.dictStr);
    if (!pagesRef) return [];
    return listPageObjNums(pdf, parseInt(pagesRef[1], 10), 0, []);
  }
  if (depth > 32) return out;
  const obj = readObject(pdf, objNum);
  if (!obj || !obj.dictStr) return out;
  if (_dictHasType(obj.dictStr, 'Page')) { out.push(objNum); return out; }
  for (const kid of _readKidsArray(obj.dictStr)) listPageObjNums(pdf, kid, depth + 1, out);
  return out;
}

function findFirstPageObjNumSafe(pdf){
  const meta = readLastTrailer(pdf);
  const catalog = readObject(pdf, meta.rootObjNum);
  if (!catalog) throw new Error('Catalog (Root) not found');
  const pagesRef = /\/Pages\s+(\d+)\s+0\s+R/.exec(catalog.dictStr);
  if (!pagesRef) throw new Error('Catalog has no /Pages');
  const pagesNum = parseInt(pagesRef[1], 10);
  const firstPage = _findFirstPageFrom(pdf, pagesNum, 0);
  if (!firstPage) throw new Error('No /Page found via /Pages tree');
  return firstPage;
}

function _findFirstPageByScan(pdf){
  const state = getPdfState(pdf);
  const { pdfStr, xrefMap } = state;
  const sorted = Array.from(xrefMap.keys()).sort((a,b) => a - b);
  for (let i = 0; i < sorted.length; i++){
    const num = sorted[i];
    const obj = readObject(pdf, num);
    if (obj && /\/Type\s*\/Page\b/.test(obj.dictStr)) return num;
  }
  const objRe = /(\d+)\s+0\s+obj\b/g;
  let m;
  while ((m = objRe.exec(pdfStr)) !== null){
    const num = parseInt(m[1], 10);
    if (Number.isNaN(num)) continue;
    const bodyStart = objRe.lastIndex;
    const endIdx = pdfStr.indexOf('endobj', bodyStart);
    if (endIdx < 0) break;
    const body = pdfStr.slice(bodyStart, endIdx);
    if (/\/Type\s*\/Page\b/.test(body)) return num;
    objRe.lastIndex = endIdx + 6;
  }
  return null;
}

function _parseBoxArray(matchStr){
  if (!matchStr) return null;
  const nums = matchStr
    .trim()
    .split(/\s+/)
    .map((value) => parseFloat(value))
    .filter((num) => Number.isFinite(num));
  if (nums.length < 4) return null;
  const [x0, y0, x1, y1] = nums;
  return { x0, y0, width: x1 - x0, height: y1 - y0 };
}

function _readPageBox(pdf, pageObj){
  if (!pageObj || !pageObj.dictStr) return null;
  const cropMatch = /\/CropBox\s*\[\s*([^\]]+)\]/.exec(pageObj.dictStr);
  if (cropMatch) {
    return _parseBoxArray(cropMatch[1]);
  }
  const mediaMatch = /\/MediaBox\s*\[\s*([^\]]+)\]/.exec(pageObj.dictStr);
  if (mediaMatch) {
    return _parseBoxArray(mediaMatch[1]);
  }
  return null;
}

function _normalizeOrigin(origin){
  if (!origin) return 'bottom-left';
  const norm = String(origin).trim().toLowerCase();
  switch (norm) {
    case 'tl':
    case 'top-left':
      return 'top-left';
    case 'tr':
    case 'top-right':
      return 'top-right';
    case 'br':
    case 'bottom-right':
      return 'bottom-right';
    case 'bl':
    case 'bottom-left':
    default:
      return 'bottom-left';
  }
}

function _resolveRectOrigin(origin, rectWidth, rectHeight, pageBox, xInput, yInput){
  const resolvedOrigin = _normalizeOrigin(origin);
  if (!pageBox) {
    if (resolvedOrigin !== 'bottom-left') {
      throw new Error('rect origin requires page box information');
    }
    return { x: xInput, y: yInput };
  }
  const baseX = pageBox.x0 || 0;
  const baseY = pageBox.y0 || 0;
  const pageWidth = pageBox.width;
  const pageHeight = pageBox.height;

  switch (resolvedOrigin) {
    case 'top-left':
      return {
        x: baseX + xInput,
        y: baseY + pageHeight - yInput - rectHeight
      };
    case 'top-right':
      return {
        x: baseX + pageWidth - xInput - rectWidth,
        y: baseY + pageHeight - yInput - rectHeight
      };
    case 'bottom-right':
      return {
        x: baseX + pageWidth - xInput - rectWidth,
        y: baseY + yInput
      };
    case 'bottom-left':
    default:
      return {
        x: baseX + xInput,
        y: baseY + yInput
      };
  }
}

/* -------------------- AcroForm/Sig & Widget injection yardımcıları -------------------- */
function _injectKeyRef(dictStr, key, valueRef){
  const re = new RegExp(key.replace('/', '\\/') + '\\s+\\d+\\s+0\\s+R');
  if (re.test(dictStr)) return dictStr;
  return dictStr.replace(/\s*>>\s*$/, ' ' + key + ' ' + valueRef + ' >>');
}

function _injectKeyRaw(dictStr, rawKV){
  const k = rawKV.split(/\s+/)[0];
  const re = new RegExp(k.replace('/', '\\/') + '\\b');
  if (re.test(dictStr)) return dictStr;
  return dictStr.replace(/\s*>>\s*$/, ' ' + rawKV + ' >>');
}

function _ensureDocTimeStampPerms(pdf, rootDict, docTsRef){
  let updatedRoot = rootDict;
  let rootChanged = false;
  const extraObjs = [];

  const permsRefMatch = /\/Perms\s+(\d+)\s+0\s+R/.exec(updatedRoot);
  if (permsRefMatch){
    const permsObjNum = parseInt(permsRefMatch[1], 10);
    const permsObj = readObject(pdf, permsObjNum);
    if (permsObj && permsObj.dictStr){
      const docRefRe = /\/DocTimeStamp\s+\d+\s+0\s+R/;
      let permsDict = permsObj.dictStr;
      let newPermsDict;
      if (docRefRe.test(permsDict)){
        newPermsDict = permsDict.replace(docRefRe, '/DocTimeStamp ' + docTsRef);
      } else {
        newPermsDict = permsDict.replace(/\s*>>\s*$/, ' /DocTimeStamp ' + docTsRef + ' >>');
      }
      if (newPermsDict !== permsDict){
        extraObjs.push({ objNum: permsObjNum, contentStr: newPermsDict });
      }
    } else {
      const replacement = '/Perms << /DocTimeStamp ' + docTsRef + ' >>';
      const replaced = updatedRoot.replace(permsRefMatch[0], replacement);
      if (replaced !== updatedRoot){
        updatedRoot = replaced;
        rootChanged = true;
      }
    }
    return { rootDict: updatedRoot, rootChanged, extraObjs };
  }

  const permsInlineMatch = /\/Perms\s*<<([\s\S]*?)>>/.exec(updatedRoot);
  if (permsInlineMatch){
    const inner = permsInlineMatch[1];
    const docRefRe = /\/DocTimeStamp\s+\d+\s+0\s+R/;
    let newInner;
    if (docRefRe.test(inner)){
      newInner = inner.replace(docRefRe, '/DocTimeStamp ' + docTsRef);
    } else {
      newInner = inner.trim() + ' /DocTimeStamp ' + docTsRef;
    }
    const replacement = '/Perms << ' + newInner.trim() + ' >>';
    if (replacement !== permsInlineMatch[0]){
      updatedRoot = updatedRoot.slice(0, permsInlineMatch.index) +
                    replacement +
                    updatedRoot.slice(permsInlineMatch.index + permsInlineMatch[0].length);
      rootChanged = true;
    }
    return { rootDict: updatedRoot, rootChanged, extraObjs };
  }

  const injected = _injectKeyRaw(updatedRoot, '/Perms << /DocTimeStamp ' + docTsRef + ' >>');
  if (injected !== updatedRoot){
    updatedRoot = injected;
    rootChanged = true;
  }
  return { rootDict: updatedRoot, rootChanged, extraObjs };
}

function _ensureDocTimeStampAcroForm(pdf, rootDict, allocateObjNum, opts){
  opts = opts || {};
  const docTsRef = opts.docTsRef;
  const pageRefStr = opts.pageRefStr || null;
  const fieldLabel = (typeof opts.fieldName === 'string' && opts.fieldName.length > 0)
    ? opts.fieldName
    : 'DocTimeStamp';

  if (!docTsRef) {
    throw new Error('docTsRef must be provided while preparing DocTimeStamp placeholder.');
  }

  let updatedRoot = rootDict;
  let rootChanged = false;
  const extraObjs = [];

  const fieldObjNum = allocateObjNum();
  let widgetObjNum = null;

  if (pageRefStr) {
    const pageMatch = /^(\d+)\s+0\s+R$/.exec(pageRefStr);
    if (pageMatch) {
      const pageObjNum = parseInt(pageMatch[1], 10);
      const pageObj = readObject(pdf, pageObjNum);
      if (pageObj && pageObj.dictStr && /\/Type\s*\/Page\b/.test(pageObj.dictStr)) {
        widgetObjNum = allocateObjNum();
        const widgetDict = '<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [0 0 0 0] /F 132 /Parent ' +
                           fieldObjNum + ' 0 R /P ' + pageRefStr + ' >>';
        extraObjs.push({ objNum: widgetObjNum, contentStr: widgetDict });
        const updatedPage = _appendUniqueRef(pageObj.dictStr, '/Annots', widgetObjNum);
        if (updatedPage !== pageObj.dictStr) {
          extraObjs.push({ objNum: pageObjNum, contentStr: updatedPage });
        }
      }
    }
  }

  let fieldDict = '<< /FT /Sig /T (' + fieldLabel + ') /Ff 0 /V ' + docTsRef;
  if (widgetObjNum) {
    fieldDict += ' /Kids [ ' + widgetObjNum + ' 0 R ]';
  }
  fieldDict += ' >>';
  extraObjs.push({ objNum: fieldObjNum, contentStr: fieldDict });

  const ensureAcroDict = (dictStr) => {
    let out = dictStr;
    out = _injectKeyRaw(out, '/Type /AcroForm');
    out = /\/Fields\s*\[/.test(out) ? out : _injectKeyRaw(out, '/Fields []');
    out = _appendUniqueRef(out, '/Fields', fieldObjNum);
    out = _ensureSigFlags(out);
    return out;
  };

  const acroInlineMatch = /\/AcroForm\s*<<([\s\S]*?)>>/.exec(updatedRoot);
  if (acroInlineMatch) {
    const original = acroInlineMatch[0];
    const dictStr = '<<' + acroInlineMatch[1] + '>>';
    const ensured = ensureAcroDict(dictStr);
    if (ensured !== dictStr) {
      const replacement = '/AcroForm ' + ensured;
      updatedRoot = updatedRoot.slice(0, acroInlineMatch.index) +
                    replacement +
                    updatedRoot.slice(acroInlineMatch.index + original.length);
      rootChanged = true;
    }
    return { rootDict: updatedRoot, rootChanged, extraObjs };
  }

  const acroRefMatch = /\/AcroForm\s+(\d+)\s+0\s+R/.exec(updatedRoot);
  if (acroRefMatch) {
    const acroNum = parseInt(acroRefMatch[1], 10);
    const acroObj = readObject(pdf, acroNum);
    const dictStr = acroObj && acroObj.dictStr ? acroObj.dictStr : '<<>>';
    const ensured = ensureAcroDict(dictStr);
    if (ensured !== dictStr) {
      extraObjs.push({ objNum: acroNum, contentStr: ensured });
    }
    return { rootDict: updatedRoot, rootChanged, extraObjs };
  }

  const acroObjNum = allocateObjNum();
  let acroDict = '<< /Type /AcroForm /Fields [] /SigFlags 3 >>';
  acroDict = _appendUniqueRef(acroDict, '/Fields', fieldObjNum);
  acroDict = _ensureSigFlags(acroDict);
  extraObjs.push({ objNum: acroObjNum, contentStr: acroDict });

  const injected = _injectKeyRef(updatedRoot, '/AcroForm', acroObjNum + ' 0 R');
  if (injected !== updatedRoot) {
    updatedRoot = injected;
    rootChanged = true;
  }

  return { rootDict: updatedRoot, rootChanged, extraObjs };
}

function _appendUniqueRef(dictStr, arrayKey, objNum){
  const ref = objNum + ' 0 R';
  const keyRe = new RegExp(arrayKey.replace('/', '\\/') + '\\s*\\[([\\s\\S]*?)\]');
  const match = keyRe.exec(dictStr);
  if (match){
    const inside = match[1];
    const refRe = new RegExp('\\b' + objNum + '\\s+0\\s+R\\b');
    if (refRe.test(inside)) return dictStr;
    const existingRefs = inside.match(/\d+\s+0\s+R/g) || [];
    existingRefs.push(ref);
    const replaced = arrayKey + ' [ ' + existingRefs.join(' ') + ' ]';
    return dictStr.slice(0, match.index) +
           replaced +
           dictStr.slice(match.index + match[0].length);
  }
  return _injectKeyRaw(dictStr, arrayKey + ' [ ' + ref + ' ]');
}

function _ensureSigFlags(dictStr){
  if (/\/SigFlags\s+3\b/.test(dictStr)) return dictStr;
  if (/\/SigFlags\b/.test(dictStr)){
    return dictStr.replace(/\/SigFlags\s+\d+/, '/SigFlags 3');
  }
  return _injectKeyRaw(dictStr, '/SigFlags 3');
}

function _buildXrefSorted(newObjs){
  const byNum = newObjs.slice().sort(function(a,b){ return a.objNum - b.objNum; });
  const groups = [];
  var i = 0;
  while (i < byNum.length){
    var start = byNum[i].objNum;
    var arr = [byNum[i]];
    i++;
    while (i < byNum.length && byNum[i].objNum === arr[arr.length - 1].objNum + 1){
      arr.push(byNum[i]); i++;
    }
    groups.push({ start: start, arr: arr });
  }
  var out = 'xref\n';
  for (var gi = 0; gi < groups.length; gi++){
    var g = groups[gi];
    out += (g.start + ' ' + g.arr.length + '\n');
    for (var ai = 0; ai < g.arr.length; ai++){
      var o = g.arr[ai];
      out += (String(o.offset).padStart(10,'0') + ' 00000 n \n');
    }
  }
  return out;
}

function _appendXrefTrailer(baseBuf, newObjs, opts){
  const size = opts.size, rootRef = opts.rootRef, prevXref = opts.prevXref;
  // ADOBE GÜVENLİ: PDF'in sonu yeni satırla bitmiyorsa, objeler yapışmasın diye yeni satır ekle!
  let safeBase = baseBuf;
  if (safeBase[safeBase.length - 1] !== 0x0A && safeBase[safeBase.length - 1] !== 0x0D) {
    safeBase = Buffer.concat([safeBase, Buffer.from('\n', 'latin1')]);
  }
  let pos = safeBase.length;
  const chunks = [];
  for (let i = 0; i < newObjs.length; i++) {
    const o = newObjs[i];
    let bodyBuf;
    if (o.stream && o.dict) {
      let dictStr = o.dict;
      
      // GÜVENLİ DÜZELTME: >> kapatma işlemlerinde Acrobat'ın takılmaması için \s*>>\s*$ regex yapısı kullanılır
      if (!/\/Length\b/.test(dictStr)) {
        dictStr = dictStr.replace(/\s*>>\s*$/, ' /Length ' + o.stream.length + ' >>');
      }
      
      // ADOBE GÜVENLİ DÜZELTMESİ: Stream yapısının başı ve sonu spesifikasyona kesin uymalıdır
      const header = o.objNum + ' 0 obj\n' + dictStr + '\nstream\n';
      const footer = '\nendstream\nendobj\n';
      
      bodyBuf = Buffer.concat([
        Buffer.from(header, 'latin1'), 
        o.stream, 
        Buffer.from(footer, 'latin1')
      ]);
    } else {
      const content = (o.content instanceof Buffer) ? o.content : Buffer.from(o.contentStr || '', 'latin1');
      const header = o.objNum + ' 0 obj\n';
      const footer = '\nendobj\n';
      bodyBuf = Buffer.concat([Buffer.from(header, 'latin1'), content, Buffer.from(footer, 'latin1')]);
    }
    o.offset = pos; // Ofset bozulmaz, tamamen güvenli!
    pos += bodyBuf.length;
    chunks.push(bodyBuf);
  }
  const xrefPos = pos;
  const xref = _buildXrefSorted(newObjs);
  const trailer = 'trailer\n<< /Size ' + size + ' /Root ' + rootRef + ' /Prev ' + prevXref + ' >>\nstartxref\n' + xrefPos + '\n%%EOF\n';
  return Buffer.concat([safeBase, Buffer.concat(chunks), Buffer.from(xref + trailer, 'latin1')]);
}

function _formatPdfNumber(value){
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('PDF number must be finite');
  }
  const rounded = Math.round(value * 1000) / 1000;
  let str = String(rounded);
  if (/[eE]/.test(str)) {
    str = rounded.toFixed(6);
  }
  if (str.indexOf('.') >= 0) {
    str = str.replace(/0+$/, '');
    if (str.endsWith('.')) str = str.slice(0, -1);
  }
  if (str === '') str = '0';
  return str;
}

const VISIBLE_FONT_INFO = (() => {
  let cache = null;
  return {
    get(){
      if (cache) return cache;
      cache = _getHelveticaMetrics();
      return cache;
    }
  };
})();

function _measureVisibleFontTextWidth(text, fontSize){
  if (!text || fontSize <= 0) return 0;
  const metrics = VISIBLE_FONT_INFO.get();
  const normalized = typeof text === 'string' ? text.normalize('NFC') : '';
  if (!normalized) return 0;
  let total = 0;
  for (const ch of normalized) {
    total += metrics.widthForChar(ch);
  }
  return (total / metrics.unitsPerEm) * fontSize;
}

const TURKISH_PDF_GLYPH_CODE_MAP = {
  'Ş': 0xD0, 'İ': 0xDD, 'Ş': 0xDE,
  'ğ': 0xF0, 'ı': 0xFD, 'ş': 0xFE
};

const HELVETICA_WIDTH_TABLE = Object.freeze({
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
  '@': 1015, 'A': 667, 'B': 667, 'C': 722, 'D': 722, 'E': 667, 'F': 611, 'G': 778,
  'H': 722, 'I': 278, 'J': 556, 'K': 667, 'L': 556, 'M': 833, 'N': 722, 'O': 778,
  'P': 667, 'Q': 778, 'R': 722, 'S': 667, 'T': 611, 'U': 722, 'V': 667, 'W': 944,
  'X': 667, 'Y': 667, 'Z': 611, '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556,
  '`': 333, 'a': 556, 'b': 556, 'c': 500, 'd': 556, 'e': 556, 'f': 278, 'g': 556,
  'h': 556, 'i': 222, 'j': 222, 'k': 500, 'l': 222, 'm': 833, 'n': 556, 'o': 556,
  'p': 556, 'q': 556, 'r': 333, 's': 500, 't': 278, 'u': 556, 'v': 500, 'w': 722,
  'x': 500, 'y': 500, 'z': 500, '{': 334, '|': 260, '}': 334, '~': 584,
  'Ç': 722, 'Ö': 778, 'Ü': 722, 'ç': 500, 'ö': 556, 'ü': 556, 'Ğ': 778, 'ğ': 556,
  'İ': 278, 'ı': 222, 'Ş': 667, 'ş': 500
});

const HELVETICA_FALLBACKS = Object.freeze({
  'Á': 'A', 'À': 'A', 'Â': 'A', 'Ä': 'A', 'Ã': 'A', 'Å': 'A', 'Æ': 'A',
  'É': 'E', 'È': 'E', 'Ê': 'E', 'Ë': 'E', 'Í': 'I', 'Ì': 'I',
  'Ó': 'O', 'Ò': 'O', 'Ô': 'O', 'Õ': 'O', 'Ú': 'U', 'Ù': 'U', 'Ý': 'Y',
  'á': 'a', 'à': 'a', 'â': 'a', 'ä': 'a', 'ã': 'a', 'å': 'a', 'æ': 'a',
  'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e', 'í': 'i', 'ì': 'i',
  'ñ': 'n', 'ó': 'o', 'ò': 'o', 'ô': 'o', 'õ': 'o', 'ú': 'u', 'ù': 'u', 'û': 'u',
  'ý': 'y', 'ÿ': 'y'
});

function _getHelveticaMetrics(){
  const defaultWidth = HELVETICA_WIDTH_TABLE['?'];
  return {
    unitsPerEm: 1000,
    widthForChar(ch){
      if (!ch) return defaultWidth;
      const direct = HELVETICA_WIDTH_TABLE[ch];
      if (typeof direct === 'number') return direct;
      const fallbackKey = HELVETICA_FALLBACKS[ch];
      if (fallbackKey) {
        const mapped = HELVETICA_WIDTH_TABLE[fallbackKey];
        if (typeof mapped === 'number') return mapped;
      }
      const codePoint = ch.codePointAt(0);
      if (codePoint >= 0x20 && codePoint <= 0x7E) {
        const asciiChar = String.fromCharCode(codePoint);
        if (typeof HELVETICA_WIDTH_TABLE[asciiChar] === 'number') {
          return HELVETICA_WIDTH_TABLE[asciiChar];
        }
      }
      return defaultWidth;
    }
  };
}

const WIN_ANSI_CHAR_TO_BYTE = (() => {
  const map = new Map();
  for (let i = 0x20; i <= 0x7E; i++) {
    map.set(String.fromCharCode(i), i);
  }
  const extras = {
    '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87,
    'ˆ': 0x88, '‰': 0x89, 'Š': 0x8A, '‹': 0x8B, 'Œ': 0x8C, 'Ž': 0x8E, '‘': 0x91,
    '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98,
    '™': 0x99, 'š': 0x9A, '›': 0x9B, 'œ': 0x9C, 'ž': 0x9E, 'Ÿ': 0x9F, ' ': 0xA0,
    '¡': 0xA1, '¢': 0xA2, '£': 0xA3, '¤': 0xA4, '¥': 0xA5, '¦': 0xA6, '§': 0xA7,
    '¨': 0xA8, '©': 0xA9, 'ª': 0xAA, '«': 0xAB, '¬': 0xAC, '®': 0xAE, '¯': 0xAF,
    '°': 0xB0, '±': 0xB1, '²': 0xB2, '³': 0xB3, '´': 0xB4, 'µ': 0xB5, '¶': 0xB6,
    '·': 0xB7, '¸': 0xB8, '¹': 0xB9, 'º': 0xBA, '»': 0xBB, '¼': 0xBC, '½': 0xBD,
    '¾': 0xBE, '¿': 0xBF, 'À': 0xC0, 'Á': 0xC1, 'Â': 0xC2, 'Ã': 0xC3, 'Ä': 0xC4,
    'Å': 0xC5, 'Æ': 0xC6, 'Ç': 0xC7, 'È': 0xC8, 'É': 0xC9, 'Ê': 0xCA, 'Ë': 0xCB,
    'Ì': 0xCC, 'Í': 0xCD, 'Î': 0xCE, 'Ï': 0xCF, 'Ð': 0xD0, 'Ñ': 0xD1, 'Ò': 0xD2,
    'Ó': 0xD3, 'Ô': 0xD4, 'Õ': 0xD5, 'Ö': 0xD6, '×': 0xD7, 'Ø': 0xD8, 'Ù': 0xD9,
    'Ú': 0xDA, 'Û': 0xDB, 'Ü': 0xDC, 'Ý': 0xDD, 'Þ': 0xDE, 'ß': 0xDF, 'à': 0xE0,
    'á': 0xE1, 'â': 0xE2, 'ã': 0xE3, 'ä': 0xE4, 'å': 0xE5, 'æ': 0xE6, 'ç': 0xE7,
    'è': 0xE8, 'é': 0xE9, 'ê': 0xEA, 'ë': 0xEB, 'ì': 0xEC, 'í': 0xED, 'î': 0xEE,
    'ï': 0xEF, 'ð': 0xF0, 'ñ': 0xF1, 'ò': 0xF2, 'ó': 0xF3, 'ô': 0xF4, 'õ': 0xF5,
    'ö': 0xF6, '÷': 0xF7, 'ø': 0xF8, 'ù': 0xF9, 'ú': 0xFA, 'û': 0xFB, 'ü': 0xFC,
    'ý': 0xFD, 'þ': 0xFE, 'ÿ': 0xFF
  };
  Object.entries(extras).forEach(([ch, code]) => map.set(ch, code));
  Object.entries(TURKISH_PDF_GLYPH_CODE_MAP).forEach(([ch, code]) => map.set(ch, code));
  map.set('\n', 0x0A);
  map.set('\r', 0x0D);
  return map;
})();

function _encodeWinAnsiString(text){
  const normalized = typeof text === 'string' ? text.normalize('NFC') : '';
  const bytes = [];
  const fallback = 0x3F; // '?'
  for (const ch of normalized) {
    const mapped = WIN_ANSI_CHAR_TO_BYTE.get(ch);
    if (mapped != null) {
      bytes.push(mapped);
      continue;
    }
    const codePoint = ch.codePointAt(0);
    if (codePoint >= 0 && codePoint <= 0xFF) {
      bytes.push(codePoint);
    } else {
      bytes.push(fallback);
    }
  }
  return Buffer.from(bytes);
}

function _pdfStringLiteralFromBuffer(buffer){
  let out = '';
  for (const byte of buffer) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5C) {
      out += '\\' + String.fromCharCode(byte);
    } else if (byte < 0x20 || byte > 0x7E) {
      const octal = byte.toString(8).padStart(3, '0');
      out += '\\' + octal;
    } else {
      out += String.fromCharCode(byte);
    }
  }
  return '(' + out + ')';
}

function _forceBreakWord(word, fontSize, maxWidth){
  if (!word) return [];
  const chars = Array.from(word);
  const lines = [];
  let current = '';
  const tolerance = Math.max(0.01, maxWidth * 0.01);
  chars.forEach((char) => {
    const candidate = current + char;
    if (!current) {
      current = char;
      return;
    }
    const width = _measureVisibleFontTextWidth(candidate, fontSize);
    if (width <= maxWidth + tolerance || _measureVisibleFontTextWidth(current, fontSize) <= tolerance) {
      current = candidate;
    } else {
      lines.push(current);
      current = char;
    }
  });
  if (current) lines.push(current);
  return lines;
}

function _wrapTextLine(line, fontSize, maxWidth){
  const words = line.split(/\s+/).filter((word) => word.length > 0);
  if (!words.length) return [];
  const lines = [];
  const tolerance = Math.max(0.01, maxWidth * 0.01);
  let current = '';
  const pushCurrent = () => {
    if (!current) return;
    if (_measureVisibleFontTextWidth(current, fontSize) > maxWidth + tolerance) {
      const forced = _forceBreakWord(current, fontSize, maxWidth);
      forced.forEach((segment) => {
        if (segment) lines.push(segment);
      });
    } else {
      lines.push(current);
    }
    current = '';
  };
  words.forEach((word) => {
    if (!current) {
      if (_measureVisibleFontTextWidth(word, fontSize) <= maxWidth + tolerance) {
        current = word;
      } else {
        const forced = _forceBreakWord(word, fontSize, maxWidth);
        forced.forEach((segment) => {
          if (segment) lines.push(segment);
        });
      }
      return;
    }
    const candidate = current + ' ' + word;
    if (_measureVisibleFontTextWidth(candidate, fontSize) <= maxWidth + tolerance) {
      current = candidate;
      return;
    }
    pushCurrent();
    if (_measureVisibleFontTextWidth(word, fontSize) <= maxWidth + tolerance) {
      current = word;
    } else {
      const forced = _forceBreakWord(word, fontSize, maxWidth);
      forced.forEach((segment) => {
        if (segment) lines.push(segment);
      });
    }
  });
  pushCurrent();
  return lines;
}

function _layoutTextBlock(lines, availableWidth, opts){
  const sanitized = Array.isArray(lines)
    ? lines.filter((line) => typeof line === 'string' && line.trim().length > 0)
    : [];
  if (!sanitized.length || availableWidth <= 0 || opts.fontSize <= 0) {
    return { lines: [], fontSize: 0, lineHeight: 0, blockHeight: 0 };
  }
  const minFont = Math.max(4, Math.min(opts.fontSize, opts.minFontSize || 8));
  const step = opts.fontStep && opts.fontStep > 0 ? opts.fontStep : 0.5;
  const width = Math.max(availableWidth, 1);
  const ratio = opts.fontSize > 0 ? opts.lineHeight / opts.fontSize : 1.2;
  let size = opts.fontSize;
  let best = null;
  while (size + 1e-6 >= minFont) {
    const wrapped = [];
    sanitized.forEach((line) => {
      const segments = _wrapTextLine(line, size, width);
      if (segments.length === 0) return;
      segments.forEach((segment) => wrapped.push(segment));
    });
    const tooWide = wrapped.some((line) => _measureVisibleFontTextWidth(line, size) > width + Math.max(0.01, width * 0.01));
    const lineHeight = Math.max(size * 1.05, ratio * size);
    const blockHeight = wrapped.length
      ? opts.padding.top + opts.padding.bottom + size + (wrapped.length - 1) * lineHeight
      : 0;
    best = { lines: wrapped, fontSize: size, lineHeight, blockHeight };
    if (!tooWide) {
      return best;
    }
    if (size === minFont) break;
    size = Math.max(minFont, size - step);
  }
  if (best) return best;
  return { lines: [], fontSize: 0, lineHeight: 0, blockHeight: 0 };
}

function _encodePdfDocBytes(text){
  const bytes = [];
  const pushByte = (byte) => {
    bytes.push(byte & 0xFF);
  };
  const encodeChar = (char) => {
    if (!char) return;
    if (Object.prototype.hasOwnProperty.call(TURKISH_PDF_GLYPH_CODE_MAP, char)) {
      pushByte(TURKISH_PDF_GLYPH_CODE_MAP[char]);
      return;
    }
    const codePoint = char.codePointAt(0);
    if (codePoint <= 0xFF) {
      pushByte(codePoint);
      return;
    }
    const decomposed = char.normalize('NFD');
    if (decomposed && decomposed !== char) {
      for (const subChar of decomposed) {
        encodeChar(subChar);
      }
      return;
    }
    pushByte(0x3F);
  };
  const normalized = typeof text === 'string' ? text.normalize('NFC') : '';
  for (const char of normalized) {
    encodeChar(char);
  }
  return bytes;
}

function _pdfStringLiteral(value){
  const bytes = _encodePdfDocBytes(value);
  let body = '';
  for (const byte of bytes) {
    if (byte === 0x28) { // (
      body += '\\(';
    } else if (byte === 0x29) { // )
      body += '\\)';
    } else if (byte === 0x5C) { // \
      body += '\\\\';
    } else if (byte < 0x20 || byte > 0x7E) {
      body += '\\' + byte.toString(8).padStart(3, '0');
    } else {
      body += String.fromCharCode(byte);
    }
  }
  return '(' + body + ')';
}

function _setRect(dictStr, coords){
  const formatted = coords.map(_formatPdfNumber);
  const rectStr = '/Rect [ ' + formatted.join(' ') + ' ]';
  if (/\/Rect\s*\[[^\]]*\]/.test(dictStr)) {
    return dictStr.replace(/\/Rect\s*\[[^\]]*\]/, rectStr);
  }
  return dictStr.replace(/\s*>>\s*$/, ' ' + rectStr + ' >>');
}

// GÜVENLİ DÜZELTME: Appearance /AP dictionary set etme metodunda `>>` Regex koruması
function _setAppearance(dictStr, appearanceRef){
  const appStr = '/AP << /N ' + appearanceRef + ' >>';
  if (/\/AP\s*<<[\s\S]*?>>/.test(dictStr)) {
    return dictStr.replace(/\/AP\s*<<[\s\S]*?>>/, appStr);
  }
  return dictStr.replace(/\s*>>\s*$/, ' ' + appStr + ' >>');
}

/**
 * PDF'te AcroForm yoksa oluşturur; boş /Sig alanı yoksa ekler.
 * Ayrıca:
 *  - AcroForm'a /SigFlags 3,
 *  - Boş /Sig field + görünmez Widget (/Parent=field, /P=page),
 *  - 1. sayfanın /Annots'una widget referansı eklenir (gerçek /Page objesi!).
 */
/** PDF tarih dizgisi literali: (D:YYYYMMDDHHMMSSZ) */
function _pdfDateLiteral(d){
  const pad = (x) => String(x).padStart(2, '0');
  return '(D:' + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
         pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z)';
}

/**
 * Bir imza /Contents onaltılık dizgisinden VRI anahtarlarını üretir.
 *
 * ETSI EN 319 142-2, VRI anahtarını imza /Contents oktet dizisinin SHA-1 özeti
 * olarak tanımlar. Uygulamada iki yorum dolaşımdadır: dolgu sıfırları dahil ve
 * gerçek ASN.1 uzunluğuna kırpılmış. Doğrulayıcılar arasında uyum için ikisi de
 * üretilir ve aynı VRI nesnesine bağlanır.
 *
 * @param {string} contentsHex
 * @returns {string[]} büyük harf onaltılık SHA-1 değerleri (tekilleştirilmiş)
 */
function vriKeysFromContentsHex(contentsHex){
  const withZeros = Buffer.from(contentsHex, 'hex');
  const padded = crypto.createHash('sha1').update(withZeros).digest('hex').toUpperCase();

  let actualLength = withZeros.length;
  if (withZeros[0] === 0x30) {
    let len = withZeros[1];
    let offset = 2;
    if (len & 0x80) {
      const numBytes = len & 0x7F;
      len = 0;
      for (let i = 0; i < numBytes; i++) len = (len << 8) | withZeros[offset++];
    }
    actualLength = offset + len;
  }
  if (actualLength <= 0 || actualLength > withZeros.length) actualLength = withZeros.length;
  const unpadded = crypto.createHash('sha1')
    .update(withZeros.slice(0, actualLength)).digest('hex').toUpperCase();

  return padded === unpadded ? [padded] : [padded, unpadded];
}

/**
 * PDF'teki TÜM imza sözlüklerini (onay imzaları + belge zaman damgaları) bulur.
 *
 * Eski `getLastSignatureHashes()` yalnız SON imzayı görüyordu; çoklu imzalı
 * belgelerde bu, önceki imzaların VRI girdisi olmaması demekti.
 *
 * @param {Buffer} pdfBuffer
 * @returns {Array<{ contentsHex:string, cmsDer:Buffer, vriKeys:string[],
 *                   subFilter:string|null, type:string|null, byteRange:number[]|null }>}
 */
function findAllSignatures(pdfBuffer){
  const pdfStr = pdfBuffer.toString('latin1');
  const out = [];
  const seen = new Set();

  // /Type /Sig veya /Type /DocTimeStamp taşıyan sözlükleri yakala.
  const re = /\/Type\s*\/(Sig|DocTimeStamp)\b([\s\S]{0,4000}?)\/Contents\s*<([0-9A-Fa-f]*)>/g;
  let m;
  while ((m = re.exec(pdfStr)) !== null) {
    const type = m[1];
    const head = m[2];
    const contentsHex = m[3];
    if (!contentsHex || seen.has(contentsHex)) continue;
    seen.add(contentsHex);

    const subFilterMatch = /\/SubFilter\s*\/([A-Za-z0-9._\-]+)/.exec(head);
    const byteRangeMatch = /\/ByteRange\s*\[([^\]]*)\]/.exec(head);
    const byteRange = byteRangeMatch
      ? byteRangeMatch[1].trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n))
      : null;

    const withZeros = Buffer.from(contentsHex, 'hex');
    let cmsLen = withZeros.length;
    if (withZeros[0] === 0x30) {
      let len = withZeros[1];
      let off = 2;
      if (len & 0x80) {
        const n = len & 0x7F;
        len = 0;
        for (let i = 0; i < n; i++) len = (len << 8) | withZeros[off++];
      }
      cmsLen = off + len;
    }
    if (cmsLen <= 0 || cmsLen > withZeros.length) cmsLen = withZeros.length;

    const subFilter = subFilterMatch ? subFilterMatch[1] : null;
    // Sınıflandırmada SubFilter, /Type'tan daha güvenilirdir: başka araçlarla
    // üretilmiş belgelerde belge zaman damgası /Type /Sig taşıyabiliyor.
    const resolvedType = (subFilter === 'ETSI.RFC3161') ? 'DocTimeStamp' : type;

    // /Contents onaltılığının dosyadaki GERÇEK konumu.
    //
    // Doğrulayıcının, ByteRange'in dışarıda bıraktığı boşluğun tam olarak bu
    // aralık olduğunu sınayabilmesi için gerekir. Bu bilgi olmadan saldırgan
    // boşluğu genişletip imzasız içerik saklayabilir. `latin1` bire bir bayt
    // eşlemesi olduğu için dizge konumu = bayt konumu.
    const matchEnd = m.index + m[0].length;      // '>' karakterinden hemen sonrası
    const contentsStart = matchEnd - contentsHex.length - 2;  // '<' karakterinin konumu

    out.push({
      contentsHex,
      cmsDer: withZeros.slice(0, cmsLen),
      vriKeys: vriKeysFromContentsHex(contentsHex),
      subFilter,
      type: resolvedType,
      rawType: type,
      byteRange,
      contentsStart,
      contentsEnd: matchEnd
    });
  }
  return out;
}

function ensureAcroFormAndEmptySigField(pdfBuffer, fieldName, pageIndex){
  const requestedName = (typeof fieldName === 'string' && fieldName.length > 0) ? fieldName : null;
  const fieldLabel = requestedName || 'Sig1';
  const meta = readLastTrailer(pdfBuffer);
  const root = readObject(pdfBuffer, meta.rootObjNum);
  if (!root) throw new Error('Root object not found');
  const acroInfo = locateAcroForm(pdfBuffer, meta.rootObjNum);
  const existingField = findEmptySignatureField(pdfBuffer, meta.rootObjNum, requestedName);
  const newObjs = [];
  let nextObj = meta.size;
  let acroObjNum;
  let acroDict = acroInfo ? acroInfo.dictStr : null;
  let acroChanged = false;
  let rootDict = root.dictStr;
  let rootChanged = false;
  if (acroInfo) {
    acroObjNum = acroInfo.objNum;
  } else {
    acroObjNum = nextObj++;
    acroDict = '<< /Type /AcroForm /Fields [] /SigFlags 3 >>';
    acroChanged = true;
    const updatedRoot = _injectKeyRef(rootDict, '/AcroForm', acroObjNum + ' 0 R');
    if (updatedRoot !== rootDict) {
      rootDict = updatedRoot;
      rootChanged = true;
    }
  }
  if (acroDict) {
    const withType = _injectKeyRaw(acroDict, '/Type /AcroForm');
    if (withType !== acroDict) { acroDict = withType; acroChanged = true; }
    const withFlags = _ensureSigFlags(acroDict);
    if (withFlags !== acroDict) { acroDict = withFlags; acroChanged = true; }
  }
  let fieldObjNum;
  if (existingField) {
    fieldObjNum = existingField.objNum;
    const updatedAcro = _appendUniqueRef(acroDict, '/Fields', fieldObjNum);
    if (updatedAcro !== acroDict) { acroDict = updatedAcro; acroChanged = true; }
  } else {
    fieldObjNum = nextObj++; // KRİTİK: Field ve Widget için TEK BİR obje numarası ayırıyoruz
    let pageObjNum = null;
    // İmza yuvası hangi sayfadaysa widget O sayfaya bağlanmalı.
    if (typeof pageIndex === 'number' && pageIndex > 0) {
      const all = listPageObjNums(pdfBuffer);
      if (all.length > pageIndex) pageObjNum = all[pageIndex];
    }
    if (pageObjNum == null) {
      try {
        pageObjNum = findFirstPageObjNumSafe(pdfBuffer);
      } catch (err) {
        pageObjNum = _findFirstPageByScan(pdfBuffer);
        if (!pageObjNum) throw err;
      }
    }
    const pageObj = readObject(pdfBuffer, pageObjNum);
    if (!pageObj || !/\/Type\s*\/Page\b/.test(pageObj.dictStr)) throw new Error('Resolved page is not /Type /Page');
    
    // ADOBE KURALI: Field ve Annot(Widget) nesnelerini birleştiriyoruz (Merged Dictionary)
    const fieldDict = '<< /Type /Annot /Subtype /Widget /FT /Sig /T (' + fieldLabel + ') /Ff 0 /Rect [0 0 0 0] /F 132 /P ' + pageObjNum + ' 0 R >>';
    newObjs.push({ objNum: fieldObjNum, contentStr: fieldDict });
    
    let pageDict = pageObj.dictStr;
    const updatedPage = _appendUniqueRef(pageDict, '/Annots', fieldObjNum);
    if (updatedPage !== pageDict) {
      pageDict = updatedPage;
      newObjs.push({ objNum: pageObjNum, contentStr: pageDict });
    }
    const updatedAcro = _appendUniqueRef(acroDict || '<<>>', '/Fields', fieldObjNum);
    if (updatedAcro !== acroDict) { acroDict = updatedAcro; acroChanged = true; }
  }
  if (acroChanged) newObjs.push({ objNum: acroObjNum, contentStr: acroDict });
  if (rootChanged) newObjs.push({ objNum: meta.rootObjNum, contentStr: rootDict });
  if (newObjs.length === 0) return pdfBuffer;
  const maxObjNum = newObjs.reduce((max, obj) => Math.max(max, obj.objNum), -Infinity);
  const newSize = Math.max(meta.size, maxObjNum + 1);
  return _appendXrefTrailer(pdfBuffer, newObjs, { size: newSize, rootRef: meta.rootRef, prevXref: meta.startxref });
}

/* --------------------------- İmza yerleştirici sınıf --------------------------- */
class PDFPAdESWriter {
  constructor(pdfBuffer){
    if (!Buffer.isBuffer(pdfBuffer)) throw new Error('pdfBuffer must be Buffer');
    this.pdf = pdfBuffer;
    const meta = readLastTrailer(this.pdf);
    this.rootRef = meta.rootRef;
    this.rootObjNum = meta.rootObjNum;
    this.size = meta.size;
    this.prevXref = meta.startxref;
    this._ph = null;
  }
  /**
   * subFilter:
   *  - 'ETSI.CAdES.detached'    PAdES-T imza (Type /Sig)
   *  - 'ETSI.RFC3161'           Belge Zaman Damgası (Type /Sig, SubFilter ETSI.RFC3161)
   * fieldName: varsa o isimli /Sig alanı doldurulur; yoksa ilk boş alan
   */
  preparePlaceholder(opts){
    opts = opts || {};
    var subFilter = opts.subFilter || 'adbe.pkcs7.detached';
    var placeholderHexLen = (typeof opts.placeholderHexLen === 'number') ? opts.placeholderHexLen : 120000;
    if (placeholderHexLen < 2) throw new Error('placeholderHexLen must be at least 2.');
    if (placeholderHexLen % 2 !== 0) placeholderHexLen += 1;
    var fieldName = opts.fieldName || null;
    const field = findEmptySignatureField(this.pdf, this.rootObjNum, fieldName);
    if (!field) throw new Error('Empty signature field not found (FT/Sig without /V).');
    var pageRefStr = null;
    const fieldObj = readObject(this.pdf, field.objNum);
    if (fieldObj){
      const kidM = /\/Kids\s*\[\s*(\d+)\s+0\s+R/.exec(fieldObj.dictStr);
      let wNum = field.objNum; // Birleştirilmiş sözlük (Merged Dict) kontrolü
      if (kidM) wNum = parseInt(kidM[1],10);
      
      const wObj = readObject(this.pdf, wNum);
      if (wObj){
        const pM = /\/P\s+(\d+)\s+0\s+R/.exec(wObj.dictStr);
        if (pM) pageRefStr = pM[1] + ' 0 R';
      }
    }
    const sigObjNum = this.size;
    const fieldObjNum = field.objNum;
    const placeholderHex = new Array(placeholderHexLen + 1).join('0');
    const dateStr = this._pdfDate(new Date());
    const BR = '0000000000 0000000000 0000000000 0000000000';
    const extraEntries = [];
    if (typeof opts.signerName === 'string' && opts.signerName.length > 0) {
      extraEntries.push('/Name ' + _pdfStringLiteral(opts.signerName));
    }

    // SERTİFİKALAMA (DocMDP): yalnızca belgenin İLK imzasında kullanılmalıdır (ISO 32000-1 §12.8.2.2).
    // /Reference, imzalanan Sig sözlüğünün İÇİNDE yer alır; /Perms ise Root'ta, AYNI revizyonda
    // eklenir (böylece imzanın ByteRange'i her ikisini de kapsar).
    const docMDP = (opts.docMDP && typeof opts.docMDP === 'object') ? opts.docMDP : null;
    if (docMDP) {
      const level = [1, 2, 3].includes(docMDP.level) ? docMDP.level : 2;
      extraEntries.push(
        '/Reference [ << /Type /SigRef /TransformMethod /DocMDP /DigestMethod /SHA256' +
        ' /TransformParams << /Type /TransformParams /P ' + level + ' /V /1.2 >> >> ]'
      );
    }
    
    // ISO 32000-2 §12.8.5: SubFilter ETSI.RFC3161 ise bu bir BELGE ZAMAN DAMGASIDIR
    // ve sözlüğün /Type değeri /DocTimeStamp olmalıdır. Ayrıca /M (imza zamanı)
    // konulmaz — güvenilir zaman, zaman damgası jetonunun içindedir.
    const isDocTimeStamp = subFilter === 'ETSI.RFC3161';
    const typeName = isDocTimeStamp ? '/DocTimeStamp' : '/Sig';
    const mEntry = isDocTimeStamp ? '' : ' /M (' + dateStr + ')';

    // ETSI KURALI: /P referansı imza sözlüğünde kesinlikle yer almamalıdır!
    const sigDict = '<< /Type ' + typeName + ' /Filter /Adobe.PPKLite /SubFilter /' + subFilter +
                    ' /ByteRange [' + BR + '] /Contents <' + placeholderHex + '>' + mEntry +
                    (extraEntries.length ? ' ' + extraEntries.join(' ') : '') + ' >>';
    const fieldOrig = readObject(this.pdf, fieldObjNum);
    const newFieldDictStr = this._injectV(fieldOrig.dictStr, sigObjNum + ' 0 R');
    const baseLen = this.pdf.length;
    const appendedParts = [];
    const xrefObjs = [];
    let offsetCursor = baseLen;
    let sigBuf = null, sigObjOffset = 0;
    
    // KESİN DÜZELTME: Obje eklenirken kesin Bayt Uzunluğunu takip ediyoruz
    const pushObj = (objNum, contentStr) => {
      const objStr = objNum + ' 0 obj\n' + contentStr + '\nendobj\n';
      const buf = Buffer.from(objStr, 'latin1');
      if (objNum === sigObjNum) {
        sigBuf = buf;
        sigObjOffset = offsetCursor;
      }
      appendedParts.push(buf);
      xrefObjs.push({ objNum, offset: offsetCursor });
      offsetCursor += buf.length;
    };
    pushObj(sigObjNum, sigDict);
    pushObj(fieldObjNum, newFieldDictStr);
    if (docMDP) {
      const rootObj = readObject(this.pdf, this.rootObjNum);
      if (!rootObj || !rootObj.dictStr) throw new Error('DocMDP için Root nesnesi bulunamadı');
      const permsRef = sigObjNum + ' 0 R';
      let rootDict = rootObj.dictStr;
      rootDict = /\/Perms\s*<</.test(rootDict)
        ? rootDict.replace(/\/Perms\s*<<([\s\S]*?)>>/, (m, inner) => '/Perms << ' + inner.trim() + ' /DocMDP ' + permsRef + ' >>')
        : rootDict.replace(/\s*>>\s*$/, ' /Perms << /DocMDP ' + permsRef + ' >> >>');
      pushObj(this.rootObjNum, rootDict);
    }
    const appended = Buffer.concat(appendedParts);
    const xrefPos = offsetCursor;
    const xref = _buildXrefSorted(xrefObjs);
    const maxObjNum = xrefObjs.length > 0 ? xrefObjs.reduce((max, obj) => Math.max(max, obj.objNum), -Infinity) : (this.size - 1);
    const newSize = Math.max(this.size, maxObjNum + 1);
    const trailer = 'trailer\n<< /Size ' + newSize + ' /Root ' + this.rootRef + ' /Prev ' + this.prevXref + ' >>\nstartxref\n' + xrefPos + '\n%%EOF\n';
    let draft = Buffer.concat([this.pdf, appended, Buffer.from(xref + trailer, 'latin1')]);
    
    // KESİN DÜZELTME: Regex iptal edildi! Nokta atışı ofset koordinatları kullanıyoruz!
    const placeholderMarker = '<' + placeholderHex + '>';
    const lessThanPosLocal = sigBuf.indexOf(placeholderMarker);
    if (lessThanPosLocal < 0) throw new Error('placeholder not found in sigBuf');
    const contentsStartLocal = lessThanPosLocal + 1;
    const contentsEndLocal = contentsStartLocal + placeholderHexLen - 1;
    const greaterThanPosLocal = contentsEndLocal + 1;
    const brNumsStartLocal = sigBuf.indexOf('[' + BR + ']') + 1;
    
    // Mutlak koordinatları hesaplıyoruz
    const lessThanPos = sigObjOffset + lessThanPosLocal;
    const contentsStart = sigObjOffset + contentsStartLocal;
    const contentsEnd = sigObjOffset + contentsEndLocal;
    const greaterThanPos = sigObjOffset + greaterThanPosLocal;
    const brNumsStart = sigObjOffset + brNumsStartLocal;
    
    const beforeLen = lessThanPos;
    const afterStart = greaterThanPos + 1;
    const afterLen = draft.length - afterStart;
    const brText = this._p10(0) + ' ' + this._p10(beforeLen) + ' ' + this._p10(afterStart) + ' ' + this._p10(afterLen);
    draft = this._patchByteRange(draft, brNumsStart, brText);
    this.pdf = draft;
    this._ph = {
      sigObjNum: sigObjNum,
      fieldObjNum: fieldObjNum,
      contentsStart: contentsStart,
      contentsEnd: contentsEnd,
      lessThanPos: lessThanPos,
      greaterThanPos: greaterThanPos,
      afterStart: afterStart,
      placeholderHexLen: placeholderHexLen,
      brNumsStart: brNumsStart
    };
    return {
      sigObjNum: sigObjNum,
      fieldObjNum: fieldObjNum,
      subFilter: subFilter,
      placeholderHexLen: placeholderHexLen,
      byteRange: [0, beforeLen, afterStart, afterLen]
    };
  }

  prepareDocumentTimeStampPlaceholder(opts){
    opts = opts || {};
    var placeholderHexLen = (typeof opts.placeholderHexLen === 'number') ? opts.placeholderHexLen : 64000;
    if (placeholderHexLen < 2) {
      throw new Error('placeholderHexLen must be at least 2.');
    }
    if (placeholderHexLen % 2 !== 0) {
      placeholderHexLen += 1;
    }
    let nextObjNum = this.size;
    const allocateObjNum = () => nextObjNum++;
    const docTsObjNum = allocateObjNum();
    let pageRefStr = null;
    try {
      const firstPage = findFirstPageObjNumSafe(this.pdf);
      if (typeof firstPage === 'number' && firstPage >= 0) {
        pageRefStr = firstPage + ' 0 R';
      }
    } catch (err) {
      // ignore - /P anahtarı zorunlu değil, bulamazsak eklemeyelim
      pageRefStr = null;
    }
    const placeholderHex = new Array(placeholderHexLen + 1).join('0');
    const BR = '0000000000 0000000000 0000000000 0000000000';

    // ISO 32000-2 §12.8.5: belge zaman damgası sözlüğünün /Type değeri
    // /DocTimeStamp olmalıdır (/Sig değil). /M girdisi de konulmaz — güvenilir
    // zaman, zaman damgası jetonunun (TSTInfo.genTime) içindedir; sözlükte ayrı
    // bir tarih taşımak çelişkili iki zaman kaynağı yaratır.
    const sigDict = '<< /Type /DocTimeStamp /Filter /Adobe.PPKLite /SubFilter /ETSI.RFC3161' +
                    ' /ByteRange [' + BR + '] /Contents <' + placeholderHex + '> >>';
    const rootObj = readObject(this.pdf, this.rootObjNum);
    if (!rootObj || !rootObj.dictStr) {
      throw new Error('Root object not found while preparing DocTimeStamp placeholder.');
    }
    const docTsRef = docTsObjNum + ' 0 R';
    const permsInfo = _ensureDocTimeStampPerms(this.pdf, rootObj.dictStr, docTsRef);
    const acroInfo = _ensureDocTimeStampAcroForm(this.pdf, permsInfo.rootDict, allocateObjNum, {
      docTsRef,
      pageRefStr,
      fieldName: opts.fieldName
    });
    const newObjs = [{ objNum: docTsObjNum, contentStr: sigDict }];
    if (permsInfo.rootChanged || acroInfo.rootChanged) {
      newObjs.push({ objNum: this.rootObjNum, contentStr: acroInfo.rootDict });
    }
    if (Array.isArray(permsInfo.extraObjs) && permsInfo.extraObjs.length) {
      Array.prototype.push.apply(newObjs, permsInfo.extraObjs);
    }
    if (Array.isArray(acroInfo.extraObjs) && acroInfo.extraObjs.length) {
      Array.prototype.push.apply(newObjs, acroInfo.extraObjs);
    }
    const newSize = Math.max(this.size, nextObjNum);
    const draft = _appendXrefTrailer(this.pdf, newObjs, {
      size: newSize,
      rootRef: this.rootRef,
      prevXref: this.prevXref
    });
    const spans = this._locateNewSigSpans(draft, docTsObjNum);
    const contentsStart = spans.contentsStart;
    const contentsEnd   = spans.contentsEnd;
    const brNumsStart   = spans.brNumsStart;
    const lessThanPos   = spans.lessThanPos;
    const greaterThanPos = spans.greaterThanPos;
    const beforeLen = lessThanPos - 0;
    const afterStart = greaterThanPos + 1;
    const afterLen = draft.length - afterStart;
    const brText = this._p10(0) + ' ' + this._p10(beforeLen) + ' ' + this._p10(afterStart) + ' ' + this._p10(afterLen);
    const patched = this._patchByteRange(draft, brNumsStart, brText);
    this.pdf = patched;
    this._ph = {
      sigObjNum: docTsObjNum,
      fieldObjNum: null,
      contentsStart: contentsStart,
      contentsEnd: contentsEnd,
      lessThanPos: lessThanPos,
      greaterThanPos: greaterThanPos,
      afterStart: afterStart,
      placeholderHexLen: placeholderHexLen,
      brNumsStart: brNumsStart
    };
    return {
      sigObjNum: docTsObjNum,
      fieldObjNum: null,
      subFilter: 'ETSI.RFC3161',
      placeholderHexLen: placeholderHexLen,
      byteRange: [0, beforeLen, afterStart, afterLen]
    };
  }

  computeByteRangeHash(algo){
    if (!algo) algo = 'sha256';
    if (!this._ph) throw new Error('call preparePlaceholder() first');
    this._refreshByteRange();
    const h = crypto.createHash(algo);
    const a = 0;
    const b = this._ph.lessThanPos;
    const c = this._ph.afterStart;
    const d = this.pdf.length - this._ph.afterStart;
    h.update(this.pdf.slice(a, a + b));
    h.update(this.pdf.slice(c, c + d));
    return h.digest();
  }

  applyVisibleSignatureFromPng(opts){
    if (!opts || typeof opts !== 'object') throw new Error('visible signature options are required');
    
    const fieldName = opts.fieldName || null;
    const field = findEmptySignatureField(this.pdf, this.rootObjNum, fieldName);
    if (!field) throw new Error('Signature field not found for appearance');
    const fieldObjNum = field.objNum;
    
    if (!opts.imageBuffer) throw new Error('visible signature requires imageBuffer');
    
    const pngInfo = parsePng(opts.imageBuffer);
    const rectOpts = opts.rect || {};
    const xInput = (typeof rectOpts.x === 'number') ? rectOpts.x : 0;
    const yInput = (typeof rectOpts.y === 'number') ? rectOpts.y : 0;
    const rectOrigin = rectOpts.origin || rectOpts.anchor || opts.rectOrigin || null;
    
    const ratio = pngInfo.width / pngInfo.height;
    const resolvedWidth = (typeof rectOpts.width === 'number' && rectOpts.width > 0) ? rectOpts.width : pngInfo.width;
    const resolvedHeight = (typeof rectOpts.height === 'number') ? rectOpts.height : (resolvedWidth / ratio);
    
    const fieldObj = readObject(this.pdf, fieldObjNum);
    if (!fieldObj) throw new Error('Signature field object not found for appearance');
    
    let widgetObjNum = fieldObjNum;
    let widgetObj = fieldObj;
    const kidMatch = /\/Kids\s*\[\s*(\d+)\s+0\s+R/.exec(fieldObj.dictStr);
    if (kidMatch) {
        widgetObjNum = parseInt(kidMatch[1], 10);
        widgetObj = readObject(this.pdf, widgetObjNum);
        if (!widgetObj) throw new Error('Widget annotation object missing for signature field');
    }
    
    let pageBox = null;
    const pageRefMatch = /\/P\s+(\d+)\s+0\s+R/.exec(widgetObj.dictStr);
    if (pageRefMatch) {
      const pageObj = readObject(this.pdf, parseInt(pageRefMatch[1], 10));
      pageBox = _readPageBox(this.pdf, pageObj);
    }
    
    const resolvedCoords = _resolveRectOrigin(rectOrigin, resolvedWidth, resolvedHeight, pageBox, xInput, yInput);
    const x = resolvedCoords.x;
    const y = resolvedCoords.y;
    const x2 = x + resolvedWidth;
    const y2 = y + resolvedHeight;
    
    const meta = readLastTrailer(this.pdf);
    let nextObjNum = Math.max(meta.size, 0);
    const allocateObj = () => nextObjNum++;
    
    const imageObjNum = allocateObj();
    const n0ObjNum = allocateObj();
    const n2ObjNum = allocateObj();
    const outerObjNum = allocateObj();
    
    // ADOBE GÜVENLİ DÜZELTMESİ: SMask (şeffaflık) yasak! Arkaplanı beyazla birleştiriyoruz (Flattening)
    let finalPixelData = pngInfo.pixelData;
    if (pngInfo.alphaData) {
      finalPixelData = Buffer.alloc(pngInfo.pixelData.length);
      const channels = pngInfo.colorSpace === 'DeviceGray' ? 1 : 3;
      for (let i = 0; i < pngInfo.width * pngInfo.height; i++) {
        const a = pngInfo.alphaData[i] / 255.0;
        const invA = 1.0 - a;
        if (channels === 3) {
          finalPixelData[i*3]   = Math.round(pngInfo.pixelData[i*3] * a + 255 * invA);
          finalPixelData[i*3+1] = Math.round(pngInfo.pixelData[i*3+1] * a + 255 * invA);
          finalPixelData[i*3+2] = Math.round(pngInfo.pixelData[i*3+2] * a + 255 * invA);
        } else {
          finalPixelData[i] = Math.round(pngInfo.pixelData[i] * a + 255 * invA);
        }
      }
    }
    const imageStream = zlib.deflateSync(finalPixelData);
    const imageDict = `<< /Type /XObject /Subtype /Image /Width ${pngInfo.width} /Height ${pngInfo.height} /ColorSpace /${pngInfo.colorSpace} /BitsPerComponent 8 /Filter /FlateDecode /Length ${imageStream.length} >>`;
    
    const newObjs = [{ objNum: imageObjNum, dict: imageDict, stream: imageStream }];
    
    const bboxStr = `[0 0 ${_formatPdfNumber(resolvedWidth)} ${_formatPdfNumber(resolvedHeight)}]`;

    // ADOBE UYUMLULUK DÜZELTMESİ: Acrobat'ın kendi imza görselleri katmanlı (n0/n2) yapı kullanır.
    // n0 = boş arkaplan katmanı, n2 = asıl görsel içerik katmanı. Acrobat'ın "Gelişmiş Özellikler" /
    // sertifika görüntüleme rutinleri bu iç yapıyı bulmayı bekler; düz/tek katmanlı bir form
    // kullanıldığında bazı Acrobat sürümlerinde "Beklenen bir sözlük nesnesi" iç hatasına yol açar.

    // n0: boş arkaplan formu (aynı BBox, boş içerik)
    const n0Content = Buffer.alloc(0);
    const n0Dict = `<< /Type /XObject /Subtype /Form /FormType 1 /BBox ${bboxStr} /Matrix [1 0 0 1 0 0] /Resources << /ProcSet [/PDF] >> /Length 0 >>`;
    newObjs.push({ objNum: n0ObjNum, dict: n0Dict, stream: n0Content });

    // n2: asıl görsel içerik formu (imzayı çizen katman)
    const rawN2 = Buffer.from(`q\n${_formatPdfNumber(resolvedWidth)} 0 0 ${_formatPdfNumber(resolvedHeight)} 0 0 cm\n/Im0 Do\nQ\n`, 'latin1');
    const n2Content = zlib.deflateSync(rawN2);
    const n2Dict = `<< /Type /XObject /Subtype /Form /FormType 1 /BBox ${bboxStr} /Matrix [1 0 0 1 0 0] /Resources << /ProcSet [/PDF /Text /ImageB /ImageC /ImageI] /XObject << /Im0 ${imageObjNum} 0 R >> >> /Filter /FlateDecode /Length ${n2Content.length} >>`;
    newObjs.push({ objNum: n2ObjNum, dict: n2Dict, stream: n2Content });

    // Dış kapsayıcı form (AP/N budur): n0 ve n2'yi sırayla çizer
    const rawOuter = Buffer.from(`q\n1 0 0 1 0 0 cm\n/n0 Do\nQ\nq\n1 0 0 1 0 0 cm\n/n2 Do\nQ\n`, 'latin1');
    const outerContent = zlib.deflateSync(rawOuter);
    const outerDict = `<< /Type /XObject /Subtype /Form /FormType 1 /BBox ${bboxStr} /Matrix [1 0 0 1 0 0] /Resources << /ProcSet [/PDF] /XObject << /n0 ${n0ObjNum} 0 R /n2 ${n2ObjNum} 0 R >> >> /Filter /FlateDecode /Length ${outerContent.length} >>`;
    newObjs.push({ objNum: outerObjNum, dict: outerDict, stream: outerContent });
    
    let widgetDict = widgetObj.dictStr;
    widgetDict = _setRect(widgetDict, [x, y, x2, y2]);
    widgetDict = _setAppearance(widgetDict, outerObjNum + ' 0 R');
    newObjs.push({ objNum: widgetObjNum, contentStr: widgetDict });
    
    const newSize = Math.max(nextObjNum, meta.size);
    this.pdf = _appendXrefTrailer(this.pdf, newObjs, {
      size: newSize,
      rootRef: meta.rootRef,
      prevXref: meta.startxref
    });
    
    const newMeta = readLastTrailer(this.pdf);
    this.size = newMeta.size;
    this.prevXref = newMeta.startxref;
    
    return { width: resolvedWidth, height: resolvedHeight, x, y };
  }

  injectCMS(cmsDer){
    if (!this._ph) throw new Error('call preparePlaceholder() first');
    const dataHexRaw = Buffer.isBuffer(cmsDer) ? cmsDer.toString('hex') : String(cmsDer).replace(/\s+/g,'');
    const dataHex = dataHexRaw.toUpperCase();
    const capacity = (this._ph.contentsEnd - this._ph.contentsStart + 1);
    if (dataHex.length > capacity) throw new Error('/Contents capacity too small. Need hex ' + dataHex.length + ', have ' + capacity);
    const padded = dataHex + new Array(capacity - dataHex.length + 1).join('0');
    const before = this.pdf.slice(0, this._ph.contentsStart);
    const after  = this.pdf.slice(this._ph.contentsEnd + 1);
    this.pdf = Buffer.concat([before, Buffer.from(padded, 'latin1'), after]);
  }

  /**
   * PAdES-LT/LTA: Document Security Store (DSS) ekler/günceller.
   * ETSI EN 319 142-1 §5.4.2 uyarınca: sertifikalar, CRL'ler ve OCSP yanıtları
   * PDF içine ayrı stream nesneleri olarak gömülür; Root katalog /DSS ile bu
   * nesneye işaret eder. Zaten bir /DSS varsa, önceki girdiler korunarak yenileri
   * eklenir (spec: "DSS Dictionary will contain validation data from previous
   * revisions plus validation data added for the current revision").
   *
   * @param {Buffer[]} certsDer - Gömülecek sertifikaların DER baytları
   * @param {Buffer[]} crlsDer  - Gömülecek CRL'lerin DER baytları
   * @param {Buffer[]} ocspsDer - Gömülecek BasicOCSPResponse DER baytları
   */
    addDSS({ certsDer = [], crlsDer = [], ocspsDer = [], signatureHashes = null, vri = null } = {}){
    const hasVriPayload = Array.isArray(vri) && vri.some((e) =>
      (e.certsDer && e.certsDer.length) || (e.crlsDer && e.crlsDer.length) || (e.ocspsDer && e.ocspsDer.length));
    if (!certsDer.length && !crlsDer.length && !ocspsDer.length && !hasVriPayload) {
      return { dssObjNum: null, certsTotal: 0, crlsTotal: 0, ocspsTotal: 0, vriTotal: 0 };
    }

    const rootObj = readObject(this.pdf, this.rootObjNum);
    if (!rootObj || !rootObj.dictStr) throw new Error('DSS eklenirken Root nesnesi bulunamadı');

    // Var olan /DSS varsa mevcut referansları oku
    let existingCertRefs = [], existingCrlRefs = [], existingOcspRefs = [];
    let existingVriRefs = {}; // YENİ: VRI hash'lerini tutacağız

    const dssRefMatch = /\/DSS\s+(\d+)\s+0\s+R/.exec(rootObj.dictStr);
    if (dssRefMatch) {
      const existingDssObj = readObject(this.pdf, parseInt(dssRefMatch[1], 10));
      if (existingDssObj && existingDssObj.dictStr) {
        const grabRefs = (key) => {
          const m = new RegExp('\\/' + key + '\\s*\\[([^\\]]*)\\]').exec(existingDssObj.dictStr);
          if (!m) return [];
          const refs = [];
          const re = /(\d+)\s+0\s+R/g;
          let mm;
          while ((mm = re.exec(m[1])) !== null) refs.push(mm[1] + ' 0 R');
          return refs;
        };
        existingCertRefs = grabRefs('Certs');
        existingCrlRefs = grabRefs('CRLs');
        existingOcspRefs = grabRefs('OCSPs');

        // YENİ: Mevcut VRI sözlüğünü parse et
        const vriMatch = /\/VRI\s*<<([\s\S]*?)>>/.exec(existingDssObj.dictStr);
        if (vriMatch) {
            const vriInner = vriMatch[1];
            const re = /\/([0-9A-F]{40})\s+(\d+\s+0\s+R)/g;
            let mm;
            while((mm = re.exec(vriInner)) !== null) {
                existingVriRefs[mm[1]] = mm[2];
            }
        }
      }
    }

    let nextObjNum = this.size;
    const allocateObj = () => nextObjNum++;
    const newObjs = [];

    const addStreamEntries = (derArray) => {
      const refs = [];
      for (const der of derArray) {
        const buf = Buffer.isBuffer(der) ? der : Buffer.from(der);
        const objNum = allocateObj();
        const dict = `<< /Length ${buf.length} >>`;
        newObjs.push({ objNum, dict, stream: buf });
        refs.push(objNum + ' 0 R');
      }
      return refs;
    };

    const newCertRefs = addStreamEntries(certsDer);
    const newCrlRefs = addStreamEntries(crlsDer);
    const newOcspRefs = addStreamEntries(ocspsDer);

    // ── VRI sözlükleri ───────────────────────────────────────────────
    // İki kullanım biçimi desteklenir:
    //   (a) `signatureHashes` verilir  → TEK bir VRI objesi üretilir ve bu üst
    //       düzey DER dizilerini gösterir. (Eski davranış, geriye dönük uyum.)
    //   (b) `vri` dizisi verilir       → HER İMZA İÇİN ayrı VRI objesi üretilir,
    //       her biri yalnız kendi doğrulama verisini gösterir. ETSI EN 319 142-1
    //       çoklu imzalı belgelerde bunu gerektirir.
    const vriBindings = []; // { hashes: string[], objNum: number }

    if (Array.isArray(vri) && vri.length > 0) {
      for (const entry of vri) {
        const hashes = Array.isArray(entry.hashes) ? entry.hashes.filter(Boolean) : [];
        if (!hashes.length) continue;
        const certRefs = addStreamEntries(entry.certsDer || []);
        const crlRefs  = addStreamEntries(entry.crlsDer || []);
        const ocspRefs = addStreamEntries(entry.ocspsDer || []);
        if (!certRefs.length && !crlRefs.length && !ocspRefs.length) continue;

        const objNum = allocateObj();
        let dict = '<< /Type /VRI';
        if (certRefs.length) dict += ` /Cert [ ${certRefs.join(' ')} ]`;
        if (crlRefs.length)  dict += ` /CRL [ ${crlRefs.join(' ')} ]`;
        if (ocspRefs.length) dict += ` /OCSP [ ${ocspRefs.join(' ')} ]`;
        // /TU: bu doğrulama verisinin toplandığı zaman (ETSI EN 319 142-2 tavsiyesi)
        dict += ' /TU ' + _pdfDateLiteral(entry.validationTime || new Date());
        dict += ' >>';
        newObjs.push({ objNum, contentStr: dict });

        // VRI'nin gösterdiği nesneler üst düzey /Certs /CRLs /OCSPs içinde de
        // listelenmelidir (bazı doğrulayıcılar yalnız üst düzeye bakar).
        newCertRefs.push(...certRefs);
        newCrlRefs.push(...crlRefs);
        newOcspRefs.push(...ocspRefs);

        vriBindings.push({ hashes, objNum });
      }
    } else if (signatureHashes && signatureHashes.length > 0) {
      const objNum = allocateObj();
      let dict = '<< /Type /VRI';
      if (newCertRefs.length) dict += ` /Cert [ ${newCertRefs.join(' ')} ]`;
      if (newCrlRefs.length)  dict += ` /CRL [ ${newCrlRefs.join(' ')} ]`;
      if (newOcspRefs.length) dict += ` /OCSP [ ${newOcspRefs.join(' ')} ]`;
      dict += ' /TU ' + _pdfDateLiteral(new Date());
      dict += ' >>';
      newObjs.push({ objNum, contentStr: dict });
      vriBindings.push({ hashes: signatureHashes, objNum });
    }

    const allCertRefs = existingCertRefs.concat(newCertRefs);
    const allCrlRefs = existingCrlRefs.concat(newCrlRefs);
    const allOcspRefs = existingOcspRefs.concat(newOcspRefs);

    const dssObjNum = allocateObj();
    const parts = ['/Type /DSS'];
    if (allCertRefs.length) parts.push('/Certs [ ' + allCertRefs.join(' ') + ' ]');
    if (allCrlRefs.length) parts.push('/CRLs [ ' + allCrlRefs.join(' ') + ' ]');
    if (allOcspRefs.length) parts.push('/OCSPs [ ' + allOcspRefs.join(' ') + ' ]');

    // VRI sözlüğünü DSS'e bağla. Bu turda yenilenen hash'ler eskisini ezer.
    const refreshedHashes = new Set();
    for (const b of vriBindings) for (const h of b.hashes) refreshedHashes.add(h);

    const vriEntries = [];
    for (const [hash, ref] of Object.entries(existingVriRefs)) {
      if (!refreshedHashes.has(hash)) vriEntries.push(`/${hash} ${ref}`);
    }
    for (const b of vriBindings) {
      for (const hash of b.hashes) vriEntries.push(`/${hash} ${b.objNum} 0 R`);
    }
    if (vriEntries.length > 0) {
      parts.push(`/VRI << ${vriEntries.join(' ')} >>`);
    }

    const dssDict = '<< ' + parts.join(' ') + ' >>';
    newObjs.push({ objNum: dssObjNum, contentStr: dssDict });

    let rootDict = rootObj.dictStr;
    const dssRef = dssObjNum + ' 0 R';
    rootDict = dssRefMatch
      ? rootDict.replace(/\/DSS\s+\d+\s+0\s+R/, '/DSS ' + dssRef)
      : rootDict.replace(/\s*>>\s*$/, ' /DSS ' + dssRef + ' >>');
    newObjs.push({ objNum: this.rootObjNum, contentStr: rootDict });

    const newSize = Math.max(this.size, nextObjNum);
    this.pdf = _appendXrefTrailer(this.pdf, newObjs, {
      size: newSize,
      rootRef: this.rootRef,
      prevXref: this.prevXref
    });

    const newMeta = readLastTrailer(this.pdf);
    this.size = newMeta.size;
    this.prevXref = newMeta.startxref;

    return {
      dssObjNum,
      certsTotal: allCertRefs.length,
      crlsTotal: allCrlRefs.length,
      ocspsTotal: allOcspRefs.length,
      vriTotal: vriBindings.length
    };
  }

  toBuffer(){ return this.pdf; }

  // YENİ EKLENEN METOT: Son imzanın SHA1 hash'ini (VRI Key) hesaplar
  // YENİ VE KESİN DÜZELTME: Son imzanın SHA1 hash'ini Adobe Acrobat gibi hesaplar
  // KESİN DÜZELTME: Adobe'un her sürümünü yakalamak için hem sıfırlı hem sıfırsız Hash üretir
  getLastSignatureHashes() {
    const pdfStr = this.pdf.toString('latin1');
    const sigRegex = /\/Type\s*\/Sig[\s\S]*?\/Contents\s*<([0-9A-Fa-f]+)>/g;
    let match, lastHex = null;
    while ((match = sigRegex.exec(pdfStr)) !== null) lastHex = match[1];
    if (!lastHex) throw new Error('VRI için hash hesaplanacak imza bulunamadı.');
    
    const sigDerWithZeros = Buffer.from(lastHex, 'hex');
    // 1. Sıfırların (Padding) dahil olduğu klasik Hash
    const hashPadded = crypto.createHash('sha1').update(sigDerWithZeros).digest('hex').toUpperCase();

    // 2. Gerçek ASN.1 Uzunluğu (Sıfırların atıldığı) Hash
    let actualLength = sigDerWithZeros.length;
    if (sigDerWithZeros[0] === 0x30) {
        let len = sigDerWithZeros[1];
        let offset = 2;
        if (len & 0x80) { 
            const numBytes = len & 0x7F;
            len = 0;
            for (let i = 0; i < numBytes; i++) len = (len << 8) | sigDerWithZeros[offset++];
        }
        actualLength = offset + len;
    }
    const trueSigDer = sigDerWithZeros.slice(0, actualLength);
    const hashUnpadded = crypto.createHash('sha1').update(trueSigDer).digest('hex').toUpperCase();

    return [hashPadded, hashUnpadded]; // İkisini de VRI sözlüğüne yolluyoruz
  } 

  /* ----------------------------- iç yardımcılar ----------------------------- */
  _injectV(dictStr, sigRef){
    if (/\/V\s+\d+\s+0\s+R/.test(dictStr)) return dictStr;
    return dictStr.replace(/\s*>>\s*$/, ' /V ' + sigRef + ' >>');
  }

  _p10(n) { 
    // Sayıları ('0') yerine standartlara uygun olarak boşluk (' ') ile dolduruyoruz
    return String(n).padEnd(10, ' '); 
  }

  _patchByteRange(buf, brNumsStart, text) {
    if (text.length !== 43) throw new Error('BR text must be exactly 43 chars');
    const before = buf.slice(0, brNumsStart);
    const after  = buf.slice(brNumsStart + text.length);
    return Buffer.concat([before, Buffer.from(text, 'latin1'), after]);
  }

  _pdfDate(d){
    function pad(x){ return String(x).padStart(2,'0'); }
    return 'D:' + d.getUTCFullYear() + pad(d.getUTCMonth()+1) + pad(d.getUTCDate()) +
           pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  }

  _refreshByteRange(){
    if (!this._ph || typeof this._ph.brNumsStart !== 'number') return;
    const beforeLen = this._ph.lessThanPos - 0;
    const afterStart = this._ph.afterStart;
    const afterLen = this.pdf.length - afterStart;
    const text = this._p10(0) + ' ' + this._p10(beforeLen) + ' ' + this._p10(afterStart) + ' ' + this._p10(afterLen);
    this.pdf = this._patchByteRange(this.pdf, this._ph.brNumsStart, text);
  }

  _locateNewSigSpans(buf, sigObjNum){
    const s = buf.toString('latin1');
    const pat = sigObjNum + '\\s+0\\s+obj\\s*<<[\\s\\S]*?>>\\s*endobj';
    const reObj = new RegExp(pat);
    const m = reObj.exec(s); if (!m) throw new Error('signature object not found');
    const objStr = m[0]; const base = m.index;
    const mc = /\/Contents\s*<([\s\S]*?)>/.exec(objStr);
    if (!mc) throw new Error('/Contents placeholder missing');
    const rel = objStr.slice(mc.index);
    const ltOffset = rel.indexOf('<');
    if (ltOffset < 0) throw new Error('/Contents opening < not found');
    const gtOffset = rel.indexOf('>', ltOffset);
    if (gtOffset < 0) throw new Error('/Contents closing > not found');
    const lessThanPos = base + mc.index + ltOffset;
    const greaterThanPos = base + mc.index + gtOffset;
    const cStartInObj = lessThanPos + 1 - base;
    const inside = mc[1].replace(/[\s\r\n]/g,'');
    const cEndInObj   = cStartInObj + inside.length;
    const mbr = /\/ByteRange\s*\[\s*0{10}\s+0{10}\s+0{10}\s+0{10}\s*\]/.exec(objStr);
    if (!mbr) throw new Error('/ByteRange placeholder missing');
    const brNumsStart = mbr.index + objStr.slice(mbr.index).indexOf('[') + 1;
    return {
      contentsStart: base + cStartInObj,
      contentsEnd: base + cEndInObj - 1,
      brNumsStart: base + brNumsStart,
      lessThanPos: lessThanPos,
      greaterThanPos: greaterThanPos
    };
  }
}

/* ------------------------------ AcroForm lookup ------------------------------ */
function locateAcroForm(pdf, rootObjNum){
  const root = readObject(pdf, rootObjNum);
  if (!root) return null;
  const acroRef = /\/AcroForm\s+(\d+)\s+0\s+R/.exec(root.dictStr);
  if (!acroRef) return null;
  const acroNum = parseInt(acroRef[1],10);
  const acroObj = readObject(pdf, acroNum);
  if (!acroObj) return null;
  return { objNum: acroNum, dictStr: acroObj.dictStr };
}

function listFields(acroFormDictStr){
  const m = /\/Fields\s*\[\s*([^\]]*)\]/.exec(acroFormDictStr);
  if (!m) return [];
  const arr = [];
  const re = /(\d+)\s+0\s+R/g;
  var mm;
  while ((mm = re.exec(m[1])) !== null){ arr.push(parseInt(mm[1],10)); }
  return arr;
}

function findEmptySignatureField(pdf, rootObjNum, fieldName){
  const acro = locateAcroForm(pdf, rootObjNum);
  if (!acro) return null;
  const refs = listFields(acro.dictStr);
  for (var i=0; i<refs.length; i++){
    const n = refs[i];
    const f = readObject(pdf, n);
    if (!f) continue;
    if (!/\/FT\s*\/Sig/.test(f.dictStr)) continue;
    if (/\/V\s+\d+\s+0\s+R/.test(f.dictStr)) continue;
    if (fieldName) {
      const nameM = /\/T\s*\((.*?)\)/.exec(f.dictStr);
      if (!nameM || nameM[1] !== fieldName) continue;
    }
    return { objNum: n, dictStr: f.dictStr };
  }
  return null;
}

/* --------------------------------- exports --------------------------------- */
module.exports = {
  PDFPAdESWriter,
  ensureAcroFormAndEmptySigField,
  readLastTrailer,
  readObject,
  findAllSignatures,
  vriKeysFromContentsHex,
  listPageObjNums
};