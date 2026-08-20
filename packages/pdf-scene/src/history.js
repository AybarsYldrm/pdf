'use strict';
/**
 * İşlem (transaction) günlüğü ve geri al / yinele.
 *
 * TASARIM: ANLIK GÖRÜNTÜ DEĞİL, TERS İŞLEM
 *
 * Her değişiklik, kendisini geri alan işlemle birlikte kaydedilir. Geri alma
 * bu ters işlemleri ters sırayla uygulamaktır.
 *
 * Belgenin tamamının anlık görüntüsünü almak da işe yarardı ama:
 *   - bellek belge boyutuyla ÇARPILIR (100 adım × 20 000 düğüm),
 *   - bir nesneyi 3 punto kaydırmak bütün belgeyi kopyalatır,
 *   - eşzamanlı düzenlemeye (birleştirme/çakışma) hiç yol bırakmaz.
 *
 * SÜRÜKLEME TEK ADIMDIR
 *
 * Fare hareketi saniyede 60 olay üretir. Her biri ayrı bir geri alma adımı
 * olsaydı, kullanıcı Ctrl+Z'ye 60 kez basmak zorunda kalırdı. Bu yüzden
 * sürükleme `begin()` ile açılır, hareketler aynı işlemin içine yazılır ve
 * `commit()` ile tek adım olarak kapanır. `mergeKey` ile ardışık küçük
 * işlemler (ok tuşuyla kaydırma gibi) de birleştirilebilir.
 */

const DEFAULT_LIMIT = 200;

class History {
  /**
   * @param {{ limit?: number, mergeWindowMs?: number, now?: () => number }} [opts]
   */
  constructor(opts = {}) {
    this.limit = opts.limit || DEFAULT_LIMIT;
    this.mergeWindowMs = opts.mergeWindowMs === undefined ? 600 : opts.mergeWindowMs;
    this.now = opts.now || (() => Date.now());

    this.undoStack = [];
    this.redoStack = [];
    this.open = null;        // açık işlem
    this._depth = 0;         // iç içe begin/commit
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get isOpen() { return this.open !== null; }

  /**
   * İşlem açar. İç içe çağrılabilir: yalnız en dıştaki commit gerçekten
   * kapatır. Bu, bir bileşik işlemin (örn. "gruplandır") kendi içinde
   * başka işlemleri çağırabilmesini sağlar.
   */
  begin(label = 'Değişiklik', mergeKey = null) {
    this._depth++;
    if (this.open) return this.open;
    this.open = { label, mergeKey, entries: [], at: this.now() };
    return this.open;
  }

  /** Açık işleme bir adım yazar. */
  record(apply, revert) {
    if (!this.open) throw new Error('History.record: açık işlem yok');
    this.open.entries.push({ apply, revert });
  }

  /**
   * İşlemi kapatır.
   *
   * Boş işlem KAYDEDİLMEZ: "hiçbir şey yapmadım" adımını geri almak
   * kullanıcıya hiçbir şey ifade etmez, yalnız Ctrl+Z'yi bir kez boşa
   * bastırır.
   */
  commit() {
    if (!this.open) return null;
    if (--this._depth > 0) return null;

    const tx = this.open;
    this.open = null;
    if (!tx.entries.length) return null;

    const last = this.undoStack[this.undoStack.length - 1];
    if (last && tx.mergeKey && last.mergeKey === tx.mergeKey &&
        tx.at - last.at <= this.mergeWindowMs) {
      // Aynı türden ardışık küçük değişiklikler tek adımda toplanır
      last.entries.push(...tx.entries);
      last.at = tx.at;
      this.redoStack.length = 0;
      return last;
    }

    this.undoStack.push(tx);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;   // yeni dal: ileri geçmiş geçersiz
    return tx;
  }

  /** Açık işlemi geri alarak iptal eder (örn. kullanıcı ESC'ye bastı). */
  rollback() {
    if (!this.open) return;
    this._depth = 0;
    const tx = this.open;
    this.open = null;
    for (let i = tx.entries.length - 1; i >= 0; i--) tx.entries[i].revert();
  }

  undo() {
    if (this.open) throw new Error('History.undo: açık işlem var');
    const tx = this.undoStack.pop();
    if (!tx) return null;
    for (let i = tx.entries.length - 1; i >= 0; i--) tx.entries[i].revert();
    this.redoStack.push(tx);
    return tx;
  }

  redo() {
    if (this.open) throw new Error('History.redo: açık işlem var');
    const tx = this.redoStack.pop();
    if (!tx) return null;
    for (const e of tx.entries) e.apply();
    this.undoStack.push(tx);
    return tx;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.open = null;
    this._depth = 0;
  }

  /** Arayüzde "Geri al: Metin taşı" gösterebilmek için. */
  peek() {
    return {
      undo: this.undoStack.length ? this.undoStack[this.undoStack.length - 1].label : null,
      redo: this.redoStack.length ? this.redoStack[this.redoStack.length - 1].label : null
    };
  }
}

module.exports = { History, DEFAULT_LIMIT };
