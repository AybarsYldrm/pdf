'use strict';
/**
 * Yapı ağacını PDF nesnelerine yazar — ISO 32000-1 §14.7.
 *
 * İki taraf birbirine MCID (marked-content identifier) ile bağlanır:
 *
 *   içerik akışı:  /H1 <</MCID 0>> BDC  … metin …  EMC
 *   yapı ağacı:    << /Type /StructElem /S /H1 /P … /K 0 /Pg <sayfa> >>
 *
 * `/ParentTree` tersine aramadır: bir sayfadaki MCID'den (ya da bir
 * açıklamadan) yapı elemanına gidilir. Ekran okuyucular ikisini de kullanır.
 */

const { PdfEmitter } = require('./emitter');
const { STANDARD_ROLES } = require('../layout/struct');

/**
 * Sayfalardaki içerik öğelerine MCID atar ve yapı düğümlerine kaydeder.
 *
 * Numaralar, öğe sırası KESİNLEŞTİKTEN sonra (dekorasyonlar araya sokulduktan
 * sonra) verilmelidir; bu yüzden yerleşimde değil burada atanır.
 *
 * @param {Array} pages çizim listesi
 */
function assignMcids(pages) {
  for (const p of pages) {
    let next = 0;
    for (const item of p.items) {
      if (item.artifact || !item.struct) continue;
      item.mcid = next++;
      item.struct.k.push({ mcid: item.mcid, page: p.index });
    }
  }
}

/**
 * Yapı ağacını nesnelere yazar.
 *
 * @param {import('./emitter').PdfEmitter} emitter
 * @param {import('../layout/struct').StructNode} root
 * @param {number[]} pageIds sayfa nesne numaraları
 * @param {Map<Object, number>} [annotParents] yapı düğümü → /StructParent anahtarı
 * @returns {number} StructTreeRoot nesne numarası
 */
function writeStructTree(emitter, root, pageIds, annotParents = new Map()) {
  const structTreeRootId = emitter.alloc();

  /** sayfa dizini → MCID sırasına göre StructElem nesne numaraları */
  const perPage = new Map();
  /** açıklama anahtarı → StructElem nesne numarası */
  const annotEntries = [];

  const writeNode = (node, parentId) => {
    const id = emitter.alloc();
    const kids = [];
    const pagesTouched = new Set();

    for (const kid of node.k) {
      if (kid && kid.role !== undefined) {                    // alt yapı elemanı
        kids.push(`${writeNode(kid, id)} 0 R`);
        continue;
      }
      if (kid && kid.objr !== undefined) {                    // açıklamaya bağ
        const objrId = emitter.add({ dict: {
          Type: '/OBJR', Obj: `${kid.objr} 0 R`, Pg: `${pageIds[kid.page]} 0 R`
        } });
        kids.push(`${objrId} 0 R`);
        pagesTouched.add(kid.page);
        continue;
      }
      if (kid && kid.mcid !== undefined) {                    // işaretli içerik
        const list = perPage.get(kid.page) || [];
        list[kid.mcid] = id;
        perPage.set(kid.page, list);
        pagesTouched.add(kid.page);
        kids.push({ mcid: kid.mcid, page: kid.page });
      }
    }

    // Düğüm tek sayfaya bağlıysa /Pg yazılır ve MCID'ler düz sayı olur;
    // birden çok sayfaya yayılıyorsa her biri /MCR sözlüğüne sarılır.
    const single = pagesTouched.size === 1 ? [...pagesTouched][0] : null;
    const kidStrings = kids.map((k) => {
      if (typeof k === 'string') return k;
      if (single !== null) return String(k.mcid);
      const mcrId = emitter.add({ dict: {
        Type: '/MCR', Pg: `${pageIds[k.page]} 0 R`, MCID: k.mcid
      } });
      return `${mcrId} 0 R`;
    });

    const dict = {
      Type: '/StructElem',
      S: `/${STANDARD_ROLES.has(node.role) ? node.role : 'NonStruct'}`,
      P: `${parentId} 0 R`,
      K: kidStrings.length === 1 ? kidStrings[0] : `[${kidStrings.join(' ')}]`
    };
    if (single !== null) dict.Pg = `${pageIds[single]} 0 R`;
    if (node.alt) dict.Alt = PdfEmitter.textString(node.alt);
    if (node.actualText) dict.ActualText = PdfEmitter.textString(node.actualText);
    if (node.title) dict.T = PdfEmitter.textString(node.title);
    if (node.lang) dict.Lang = PdfEmitter.literalString(node.lang);
    if (node.scope) dict.A = `<< /O /Table /Scope /${node.scope} >>`;

    emitter.set(id, { dict });

    if (annotParents.has(node)) {
      annotEntries.push({ key: annotParents.get(node), id });
    }
    return id;
  };

  const topKids = [];
  for (const kid of root.k) {
    if (kid && kid.role !== undefined) topKids.push(`${writeNode(kid, structTreeRootId)} 0 R`);
  }

  // ParentTree: 0…N-1 sayfa anahtarları, sonrasında açıklama anahtarları
  const numsParts = [];
  for (let i = 0; i < pageIds.length; i++) {
    const list = perPage.get(i) || [];
    const refs = [];
    for (let m = 0; m < list.length; m++) refs.push(list[m] ? `${list[m]} 0 R` : 'null');
    const arrId = emitter.add(`[${refs.join(' ')}]`);
    numsParts.push(`${i} ${arrId} 0 R`);
  }

  let nextKey = pageIds.length;
  for (const entry of annotEntries.sort((a, b) => a.key - b.key)) {
    numsParts.push(`${entry.key} ${entry.id} 0 R`);
    if (entry.key >= nextKey) nextKey = entry.key + 1;
  }

  const parentTreeId = emitter.add({ dict: { Nums: `[${numsParts.join(' ')}]` } });

  emitter.set(structTreeRootId, { dict: {
    Type: '/StructTreeRoot',
    K: topKids.length === 1 ? topKids[0] : `[${topKids.join(' ')}]`,
    ParentTree: `${parentTreeId} 0 R`,
    ParentTreeNextKey: nextKey
  } });

  return structTreeRootId;
}

module.exports = { assignMcids, writeStructTree };
