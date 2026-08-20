'use strict';
/**
 * Eşzamanlı düzenleme oturumları.
 *
 * MİMARİ: SUNUCU SIRALAR, HERKES O SIRAYI UYGULAR.
 *
 * Her oturumun bir SÜRÜM sayacı ve bir işlem günlüğü vardır. İstemci
 * değişikliklerini "şu sürümün üzerine" diye gönderir; sunucu uygular,
 * sürümü artırır ve sonucu bütün dinleyicilere yayar. Böylece herkesin
 * belgesi aynı işlemleri aynı sırayla görür.
 *
 * BU BİR CRDT DEĞİLDİR. Otomatik birleştirme yoktur; çakışma AÇIKÇA
 * çözülür ve sonucu gönderene BİLDİRİLİR:
 *   - silinmiş bir düğüme yapılan işlem reddedilir,
 *   - aynı alanı iki kişi değiştirirse son gelen kazanır ve önceki
 *     sahibine "üzerine yazıldı" denir.
 * Sessizce birinin emeğini çöpe atmak en kötü seçenektir.
 *
 * OTURUMLAR YALNIZ BELLEKTEDİR ve kısa ömürlüdür. Sunucu yeniden
 * başlarsa oturum kaybolur; belge kaybolmaz çünkü istemcilerin kendi
 * kopyası vardır ve her an dışa aktarılabilir. Kalıcı bir depo eklemek,
 * bu dosyanın değil bir ürün kararının konusudur.
 */

const crypto = require('crypto');
const { Scene } = require('@fitfak/pdf-scene');
const { applyOps, overlaps, OpError, MAX_OPS } = require('@fitfak/pdf-scene/src/ops');

const LIMITS = {
  /** Aynı anda açık oturum sayısı. */
  maxSessions: Number(process.env.COLLAB_MAX_SESSIONS) || 50,
  /** Oturum başına bağlı istemci. */
  maxClients: Number(process.env.COLLAB_MAX_CLIENTS) || 16,
  /** Günlükte tutulan işlem sayısı (geç kalan istemci buradan yetişir). */
  maxLog: Number(process.env.COLLAB_MAX_LOG) || 2000,
  /** Hareketsiz oturumun ömrü. */
  ttlMs: Number(process.env.COLLAB_TTL_MS) || 30 * 60_000
};

class CollabError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CollabError';
    this.code = code;
    this.status = status;
  }
}

class Session {
  constructor(id, scene) {
    this.id = id;
    this.scene = scene;
    this.version = 0;
    /** [{ version, clientId, op }] — sürüm sırasına göre. */
    this.log = [];
    /** clientId → { name, res, lastSeen } */
    this.clients = new Map();
    this.createdAt = Date.now();
    this.touchedAt = Date.now();
  }

  touch() { this.touchedAt = Date.now(); }

  /** Belirli bir sürümden SONRAKİ işlemler. */
  since(version) {
    return this.log.filter((e) => e.version > version);
  }

  /**
   * İşlemleri uygular.
   *
   * @param {string} clientId
   * @param {number} baseVersion istemcinin gördüğü son sürüm
   * @param {Array} ops
   * @returns {{ version:number, applied:number, overwritten:Array }}
   */
  commit(clientId, baseVersion, ops) {
    if (!Array.isArray(ops) || !ops.length) {
      return { version: this.version, applied: 0, overwritten: [] };
    }
    if (ops.length > MAX_OPS) {
      throw new CollabError('ERR_OP_TOO_MANY', `En çok ${MAX_OPS} işlem gönderilebilir`);
    }

    // GERİDE KALMIŞ İSTEMCİ: arada başkasının yaptığı işlemlerle çakışan
    // varsa gönderene söylenir. İşlem yine de uygulanır (son gelen kazanır)
    // ama kullanıcı neyin üzerine yazdığını bilir.
    const missed = this.since(baseVersion);
    const overwritten = [];
    for (const op of ops) {
      for (const past of missed) {
        if (past.clientId !== clientId && overlaps(op, past.op)) {
          overwritten.push({ op, by: past.clientId, atVersion: past.version });
          break;
        }
      }
    }

    try {
      applyOps(this.scene, ops, 'Ortak düzenleme');
    } catch (err) {
      if (err instanceof OpError) {
        throw new CollabError(err.code, err.message, 409);
      }
      throw err;
    }

    for (const op of ops) {
      this.version += 1;
      this.log.push({ version: this.version, clientId, op });
    }
    if (this.log.length > LIMITS.maxLog) {
      this.log.splice(0, this.log.length - LIMITS.maxLog);
    }

    this.touch();
    this.broadcast(clientId, ops);
    return { version: this.version, applied: ops.length, overwritten };
  }

  /**
   * İşlemleri diğer istemcilere yayar.
   *
   * Gönderen HARİÇ tutulur: kendi değişikliğini geri almak, imleci
   * zıplatır ve yazarken kelime kaybettirir.
   */
  broadcast(fromClientId, ops) {
    const payload = JSON.stringify({
      type: 'ops', version: this.version, clientId: fromClientId, ops
    });
    for (const [id, client] of this.clients) {
      if (id === fromClientId || !client.res) continue;
      write(client.res, payload);
    }
  }

  /** Katılım/ayrılma haberi — kimin bağlı olduğu herkesçe bilinsin. */
  announce() {
    const payload = JSON.stringify({
      type: 'peers', version: this.version,
      peers: [...this.clients.entries()].map(([id, c]) => ({ id, name: c.name }))
    });
    for (const client of this.clients.values()) {
      if (client.res) write(client.res, payload);
    }
  }

  describe() {
    return {
      id: this.id,
      version: this.version,
      peers: [...this.clients.entries()].map(([id, c]) => ({ id, name: c.name })),
      logSize: this.log.length,
      createdAt: new Date(this.createdAt).toISOString()
    };
  }
}

/** SSE olayı yazar; kopmuş bağlantı sessizce atlanır. */
function write(res, data) {
  try {
    res.write(`data: ${data}\n\n`);
  } catch { /* istemci gitmiş; süpürme temizler */ }
}

class Collab {
  constructor() {
    this.sessions = new Map();
  }

  /** Yeni oturum açar. */
  create(sceneJson, name) {
    this.sweep();
    if (this.sessions.size >= LIMITS.maxSessions) {
      throw new CollabError('ERR_COLLAB_FULL',
        `Aynı anda en çok ${LIMITS.maxSessions} oturum açılabilir`, 429);
    }

    let scene;
    try {
      scene = sceneJson ? Scene.fromJSON(sceneJson) : Scene.blank({ title: 'Ortak belge' });
    } catch (err) {
      throw new CollabError(err.code || 'ERR_SCENE_INVALID', err.message);
    }

    const id = crypto.randomBytes(12).toString('hex');
    const session = new Session(id, scene);
    this.sessions.set(id, session);

    return { session, client: this.join(id, name) };
  }

  get(sessionId) {
    const session = this.sessions.get(String(sessionId || ''));
    if (!session) {
      throw new CollabError('ERR_COLLAB_NO_SESSION', 'Oturum bulunamadı', 404);
    }
    session.touch();
    return session;
  }

  /** Oturuma katılır ve bir istemci kimliği verir. */
  join(sessionId, name) {
    const session = this.get(sessionId);
    if (session.clients.size >= LIMITS.maxClients) {
      throw new CollabError('ERR_COLLAB_CROWDED',
        `Oturumda en çok ${LIMITS.maxClients} kişi bulunabilir`, 429);
    }
    const clientId = crypto.randomBytes(8).toString('hex');
    session.clients.set(clientId, {
      name: String(name || 'Katılımcı').slice(0, 64),
      res: null,
      lastSeen: Date.now()
    });
    session.announce();
    return { clientId, sessionId: session.id, version: session.version };
  }

  leave(sessionId, clientId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const client = session.clients.get(clientId);
    if (client && client.res) { try { client.res.end(); } catch { /* kapalı */ } }
    session.clients.delete(clientId);
    session.announce();
    if (!session.clients.size) session.touch();
  }

  /** SSE akışını bağlar. */
  attach(sessionId, clientId, res) {
    const session = this.get(sessionId);
    const client = session.clients.get(clientId);
    if (!client) {
      throw new CollabError('ERR_COLLAB_NO_CLIENT', 'İstemci bu oturumda değil', 403);
    }
    client.res = res;
    client.lastSeen = Date.now();
    session.announce();
    return session;
  }

  /** Süresi dolmuş oturumları kapatır. */
  sweep(now = Date.now()) {
    for (const [id, session] of this.sessions) {
      if (now - session.touchedAt < LIMITS.ttlMs) continue;
      for (const client of session.clients.values()) {
        if (client.res) { try { client.res.end(); } catch { /* kapalı */ } }
      }
      this.sessions.delete(id);
    }
  }

  describe() {
    return {
      sessions: this.sessions.size,
      maxSessions: LIMITS.maxSessions,
      maxClients: LIMITS.maxClients
    };
  }

  /** Testler için: bütün oturumları kapatır. */
  reset() {
    for (const id of [...this.sessions.keys()]) {
      const session = this.sessions.get(id);
      for (const client of session.clients.values()) {
        if (client.res) { try { client.res.end(); } catch { /* kapalı */ } }
      }
    }
    this.sessions.clear();
  }
}

module.exports = { Collab, Session, CollabError, LIMITS };
