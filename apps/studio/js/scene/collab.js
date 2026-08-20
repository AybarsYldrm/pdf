/**
 * Ortak düzenleme istemcisi.
 *
 * SUNUCU SIRALAR, HERKES O SIRAYI UYGULAR. Bu dosyanın iki işi vardır:
 *   1. Kullanıcının yaptığı değişikliği İŞLEME çevirip göndermek.
 *   2. Başkasının işlemlerini alıp yerel sahneye uygulamak.
 *
 * UZAKTAN GELEN İŞLEM GERİ ALMA YIĞININA GİRMEZ. Girseydi Ctrl+Z
 * başkasının yazdığını geri alırdı — kullanıcının kendi yapmadığı bir şeyi
 * "geri alması" en şaşırtıcı davranıştır.
 *
 * ÇAKIŞMA GİZLENMEZ. Sunucu "üzerine yazdın" derse kullanıcıya söylenir.
 * Sessizce birinin emeğini çöpe atmak en kötü seçenektir.
 */

/** Gönderim aralığı: sürükleme sırasında her karede istek atılmasın. */
const FLUSH_MS = 120;

export class CollabClient {
  /**
   * @param {Object} o
   * @param {Object} o.api sunucu istemcisi
   * @param {Function} o.onRemote (ops) => void — uzak işlemleri uygula
   * @param {Function} o.onPeers (peers) => void
   * @param {Function} o.onStatus (message, kind) => void
   * @param {Function} o.onConflict (overwritten) => void
   */
  constructor(o) {
    this.api = o.api;
    this.onRemote = o.onRemote || (() => {});
    this.onPeers = o.onPeers || (() => {});
    this.onStatus = o.onStatus || (() => {});
    this.onConflict = o.onConflict || (() => {});

    this.sessionId = null;
    this.clientId = null;
    this.version = 0;
    this.peers = [];

    /** Gönderilmeyi bekleyen işlemler. */
    this._queue = [];
    this._timer = null;
    this._sending = false;
    this._stream = null;
    /** Uzak işlem uygulanırken üretilen yerel işlemler geri gönderilmesin. */
    this.suspended = false;
  }

  get active() { return !!this.sessionId; }

  /* ---------------------------------------------------------------- */
  /* Bağlanma                                                          */
  /* ---------------------------------------------------------------- */

  async start(sceneJson, name) {
    const res = await this.api.collabCreate(sceneJson, name);
    this._connect(res);
    this.onStatus(`Ortak oturum açıldı: ${res.sessionId}`, 'ok');
    return res;
  }

  async join(sessionId, name) {
    const res = await this.api.collabJoin(sessionId, name);
    this._connect({ ...res, sessionId });
    this.peers = res.peers || [];
    this.onPeers(this.peers);
    this.onStatus(`Oturuma katıldınız (${this.peers.length} kişi)`, 'ok');
    return res;
  }

  _connect(res) {
    this.sessionId = res.sessionId;
    this.clientId = res.clientId;
    this.version = res.version || 0;
    this._openStream();

    // Sekme kapanırken haber ver: aksi hâlde katılımcı listesinde hayalet
    // kalır ve oturum boşalmadığı için erken temizlenmez.
    this._unload = () => {
      navigator.sendBeacon?.('/api/collab/leave', new Blob(
        [JSON.stringify({ sessionId: this.sessionId, clientId: this.clientId })],
        { type: 'application/json' }));
    };
    window.addEventListener('pagehide', this._unload);
  }

  _openStream() {
    this._closeStream();
    const url = `/api/collab/stream?sessionId=${encodeURIComponent(this.sessionId)}` +
                `&clientId=${encodeURIComponent(this.clientId)}&since=${this.version}`;
    const stream = new EventSource(url);
    this._stream = stream;

    stream.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }

      if (data.type === 'peers') {
        this.peers = data.peers || [];
        this.onPeers(this.peers);
        return;
      }
      if (data.type !== 'ops') return;

      this.version = Math.max(this.version, data.version || 0);
      this.suspended = true;
      try {
        this.onRemote(data.ops || []);
      } finally {
        this.suspended = false;
      }
    };

    // Kopan akış: tarayıcı kendiliğinden yeniden bağlanır, ama `since`
    // eski kalırdı. Bu yüzden akış kapatılıp güncel sürümle açılır.
    stream.onerror = () => {
      if (!this.sessionId) return;
      this.onStatus('Ortak oturum bağlantısı koptu; yeniden bağlanılıyor…', 'warn');
      setTimeout(() => { if (this.sessionId) this._openStream(); }, 1500);
    };
  }

  _closeStream() {
    if (this._stream) { this._stream.close(); this._stream = null; }
  }

  async stop() {
    if (!this.sessionId) return;
    const { sessionId, clientId } = this;
    this._closeStream();
    if (this._unload) window.removeEventListener('pagehide', this._unload);
    this.sessionId = null;
    this.clientId = null;
    this._queue = [];
    try { await this.api.collabLeave(sessionId, clientId); } catch { /* zaten kapandı */ }
    this.onPeers([]);
    this.onStatus('Ortak oturumdan çıkıldı', 'ok');
  }

  /* ---------------------------------------------------------------- */
  /* Gönderme                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * İşlem kuyruğa alınır ve kısa bir gecikmeyle toplu gönderilir.
   *
   * Sürükleme saniyede onlarca güncelleme üretir; her birini ayrı istek
   * yapmak ağı ve sunucuyu boğardı.
   */
  send(ops) {
    if (!this.active || this.suspended || !ops.length) return;
    this._queue.push(...ops);
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this._flush(); }, FLUSH_MS);
  }

  async _flush() {
    if (!this.active || this._sending || !this._queue.length) return;
    const ops = this._queue.splice(0);
    this._sending = true;

    try {
      const res = await this.api.collabOps({
        sessionId: this.sessionId,
        clientId: this.clientId,
        baseVersion: this.version,
        ops
      });
      this.version = res.version;
      if (res.overwritten && res.overwritten.length) this.onConflict(res.overwritten);
    } catch (err) {
      // Reddedilen işlem YOK SAYILMAZ: yerel belge sunucudan ayrıştı,
      // kullanıcı bunu bilmeli ve yeniden katılabilmeli.
      this.onStatus(
        `Değişiklik sunucuda uygulanamadı (${err.code || 'hata'}): ${err.message}`, 'err');
    } finally {
      this._sending = false;
      if (this._queue.length) this._flush();
    }
  }
}
