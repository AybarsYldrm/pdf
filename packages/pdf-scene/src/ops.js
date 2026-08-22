'use strict';
/**
 * Serileştirilebilir işlem günlüğü — eşzamanlı düzenlemenin taşıyıcısı.
 *
 * SORUN: geri alma yığını KAPANIŞ (closure) tutar. Bellek içinde
 * mükemmel çalışır ama ağdan geçmez: bir fonksiyonu JSON'a çeviremezsiniz.
 * İki kişinin aynı belgeyi düzenlemesi için değişikliğin KENDİSİ veri
 * olmalıdır.
 *
 * BU BİR CRDT DEĞİLDİR — VE ÖYLEYMİŞ GİBİ SUNULMAMALIDIR.
 *
 * Burada yapılan şey daha basit ve daha açıktır: işlemler SUNUCUDA
 * sıralanır. Sunucunun kabul ettiği sıra tek gerçektir; herkes o sırayı
 * uygular. Çakışma "otomatik birleştirilmez", ÇÖZÜLÜR:
 *
 *   - Var olmayan düğüme yapılan işlem REDDEDİLİR (silinmiş nesneyi
 *     hayalet gibi geri getirmek, kullanıcının sildiğini geri almaktır).
 *   - Var olan kimlikle ekleme REDDEDİLİR.
 *   - Aynı alanı iki kişi değiştirirse SON GELEN kazanır ve diğerine
 *     "üzerine yazıldı" diye bildirilir. Sessizce birinin emeğini
 *     çöpe atmak, en kötü seçenektir.
 *
 * Bu semantik dar ama dürüsttür: ne yaptığı tam olarak söylenebilir.
 */

const { validateScene, SceneError } = require('./validate');
const { NODE_TYPES } = require('./schema');

/** Tanınan işlemler ve zorunlu alanları. */
const OPS = {
  addNode:    ['node'],
  removeNode: ['nodeId'],
  updateNode: ['nodeId', 'patch'],
  reorder:    ['nodeId', 'to'],
  addPage:    [],
  removePage: ['pageId'],
  movePage:   ['pageId', 'index'],
  replacePage: ['pageId', 'nodes'],
  // `size` boş bırakılabilir (`null` → belgenin ölçüsüne dön); bu yüzden
  // zorunlu alan listesinde YOKTUR.
  setPageSize: ['pageId'],
  setMeta:    ['meta'],
  setPage:    ['page']
};

/** Tek istekte gönderilebilecek en fazla işlem. */
const MAX_OPS = 500;

class OpError extends Error {
  constructor(code, message, op) {
    super(message);
    this.name = 'OpError';
    this.code = code;
    this.op = op;
  }
}

/**
 * İşlemi biçimsel olarak denetler.
 *
 * İÇERİK denetimi burada YAPILMAZ: düğüm alanları uygulandıktan sonra
 * `validateScene` ile denetlenir. Burada yalnız "bu nesne bir işleme
 * benziyor mu?" sorusu cevaplanır — güvenilmez girdinin ilk süzgeci.
 */
function checkOp(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpError('ERR_OP_TYPE', 'İşlem nesnesi bekleniyordu', raw);
  }
  const fields = OPS[raw.op];
  if (!fields) {
    throw new OpError('ERR_OP_UNKNOWN', `Bilinmeyen işlem: ${JSON.stringify(raw.op)}`, raw);
  }
  for (const field of fields) {
    if (raw[field] === undefined || raw[field] === null) {
      throw new OpError('ERR_OP_FIELD', `${raw.op} işlemi ${field} alanını ister`, raw);
    }
  }
  if (raw.op === 'addNode' && !NODE_TYPES[raw.node && raw.node.type]) {
    throw new OpError('ERR_OP_NODE_TYPE',
      `Bilinmeyen düğüm tipi: ${JSON.stringify(raw.node && raw.node.type)}`, raw);
  }
  return raw;
}

/**
 * İşlemi sahneye uygular.
 *
 * Uygulanamayan işlem SESSİZCE ATLANMAZ: `OpError` fırlatır. Çağıran
 * (sunucu oturumu) bunu "reddedildi" olarak kaydeder ve gönderene söyler.
 *
 * @param {Scene} scene
 * @param {Object} op
 */
function applyOp(scene, op) {
  checkOp(op);

  switch (op.op) {
    case 'addNode': {
      if (scene.node(op.node.id)) {
        throw new OpError('ERR_OP_DUPLICATE_ID',
          `Bu kimlikle bir düğüm zaten var: ${op.node.id}`, op);
      }
      return scene.addNode(op.node, {
        pageId: op.pageId, parentId: op.parentId, index: op.index
      });
    }

    case 'removeNode': {
      if (!scene.node(op.nodeId)) {
        throw new OpError('ERR_OP_MISSING', `Düğüm yok: ${op.nodeId}`, op);
      }
      return scene.removeNode(op.nodeId);
    }

    case 'updateNode': {
      if (!scene.node(op.nodeId)) {
        throw new OpError('ERR_OP_MISSING', `Düğüm yok: ${op.nodeId}`, op);
      }
      return scene.updateNode(op.nodeId, op.patch);
    }

    case 'reorder': {
      if (!scene.node(op.nodeId)) {
        throw new OpError('ERR_OP_MISSING', `Düğüm yok: ${op.nodeId}`, op);
      }
      return scene.reorder(op.nodeId, op.to);
    }

    case 'addPage':
      return scene.addPage(op.options || {});

    case 'removePage': {
      if (!scene.pages.some((p) => p.id === op.pageId)) {
        throw new OpError('ERR_OP_MISSING', `Sayfa yok: ${op.pageId}`, op);
      }
      return scene.removePage(op.pageId);
    }

    case 'movePage': {
      if (!scene.pages.some((p) => p.id === op.pageId)) {
        throw new OpError('ERR_OP_MISSING', `Sayfa yok: ${op.pageId}`, op);
      }
      return scene.movePage(op.pageId, op.index);
    }

    case 'replacePage': {
      if (!scene.pages.some((p) => p.id === op.pageId)) {
        throw new OpError('ERR_OP_MISSING', `Sayfa yok: ${op.pageId}`, op);
      }
      if (!Array.isArray(op.nodes)) {
        throw new OpError('ERR_OP_FIELD', 'replacePage düğüm dizisi ister', op);
      }
      return scene.replacePageNodes(op.pageId, op.nodes);
    }

    case 'setPageSize': {
      if (!scene.pages.some((p) => p.id === op.pageId)) {
        throw new OpError('ERR_OP_MISSING', `Sayfa yok: ${op.pageId}`, op);
      }
      return scene.setPageSize(op.pageId, op.size || null);
    }

    case 'setMeta':
      return scene.setMeta(op.meta);

    case 'setPage':
      return scene.setPage(op.page);

    default:
      throw new OpError('ERR_OP_UNKNOWN', `Bilinmeyen işlem: ${op.op}`, op);
  }
}

/**
 * İşlem dizisini TEK işlem (transaction) içinde uygular.
 *
 * Biri başarısız olursa hepsi geri sarılır: yarım uygulanmış bir grup,
 * sunucuyla istemcinin sahnesini ayrıştırır ve bir daha asla
 * buluşmamalarına yol açar.
 *
 * @returns {{ applied: number }}
 * @throws {OpError}
 */
function applyOps(scene, ops, label = 'Uzak değişiklik') {
  if (!Array.isArray(ops)) throw new OpError('ERR_OP_TYPE', 'Dizi bekleniyordu');
  if (ops.length > MAX_OPS) {
    throw new OpError('ERR_OP_TOO_MANY', `En çok ${MAX_OPS} işlem gönderilebilir`);
  }
  for (const op of ops) checkOp(op);

  scene.transaction(label, () => {
    for (const op of ops) applyOp(scene, op);
  });
  return { applied: ops.length };
}

/**
 * İki işlem AYNI ŞEYE mi dokunuyor?
 *
 * Çakışma bildirimi için: kullanıcının değiştirdiği alanı başkası da
 * değiştirdiyse haber verilmelidir. Farklı alanlara dokunan iki işlem
 * çakışmaz — aynı nesnenin rengini biri, konumunu diğeri değiştirebilir.
 */
function overlaps(a, b) {
  if (!a || !b) return false;
  const target = (op) => op.nodeId || (op.node && op.node.id) || op.pageId || op.op;
  if (target(a) !== target(b)) return false;

  if (a.op === 'updateNode' && b.op === 'updateNode') {
    const keysA = Object.keys(a.patch || {});
    const keysB = new Set(Object.keys(b.patch || {}));
    return keysA.some((k) => keysB.has(k));
  }
  // Silme/ekleme/sıralama bütün nesneye dokunur.
  return true;
}

/**
 * Sahnenin tamamını işlem listesinden yeniden kurar.
 *
 * Yeni katılan bir istemciye bütün günlüğü göndermek yerine sahnenin son
 * hâli gönderilir; bu işlev yalnız denetim ve test içindir: günlük ile
 * sahne ayrışmışsa bir yerde hata vardır.
 */
function replay(SceneClass, ops, initial = {}) {
  const scene = SceneClass.blank(initial);
  applyOps(scene, ops, 'Günlükten kur');
  scene.history.clear();
  return scene;
}

module.exports = { OPS, MAX_OPS, OpError, checkOp, applyOp, applyOps, overlaps, replay };
