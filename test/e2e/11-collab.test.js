'use strict';
/**
 * Eşzamanlı düzenleme — İKİ İSTEMCİ, TEK BELGE.
 *
 * Tek süreçte paylaşılan bir nesneyi sınamak yeterli olmazdı: burada iki
 * ayrı HTTP istemcisi vardır, biri SSE akışını dinler, diğeri yazar.
 * Sorular şunlar:
 *   - Yazılan şey diğerine ULAŞIYOR mu?
 *   - Silinmiş nesneye dokunmak REDDEDİLİYOR mu?
 *   - Aynı alanı ikisi de değiştirirse ÜZERİNE YAZILDIĞI söyleniyor mu?
 *   - Bağlantı koparsa kaçırılan işlemler yetişiyor mu?
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { Scene } = require('@fitfak/pdf-scene');

let api;
let server;
let base;

test.before(async () => {
  const mod = require('../../apps/server/server');
  api = mod;
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (api) api.collab.reset();
  if (server) await new Promise((r) => server.close(r));
});

test.beforeEach(() => { api.rateLimiter.reset(); });

async function call(pathname, body) {
  const res = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

/**
 * SSE dinleyicisi.
 *
 * `fetch` yerine ham `http` kullanılıyor: akışı istediğimiz anda kapatmak
 * ve gelen olayları tek tek toplamak gerekiyor.
 */
function listen(sessionId, clientId, since = 0) {
  const events = [];
  const waiters = [];

  const req = http.get(
    `${base}/api/collab/stream?sessionId=${sessionId}&clientId=${clientId}&since=${since}`,
    (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (!raw.startsWith('data: ')) continue;          // ara vuruş
          const event = JSON.parse(raw.slice(6));
          events.push(event);
          for (const w of waiters.splice(0)) w();
        }
      });
    });

  return {
    events,
    /** Koşul sağlanana kadar bekler. */
    async until(predicate, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = events.find(predicate);
        if (hit) return hit;
        if (Date.now() > deadline) {
          throw new Error(`Beklenen olay gelmedi. Gelenler: ${JSON.stringify(events)}`);
        }
        await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
      }
    },
    close() { req.destroy(); }
  };
}

const rect = (id, extra = {}) => Scene.createNode('rect', {
  id, x: 10, y: 10, width: 50, height: 50, fill: '#ff0000', ...extra
});

/* ================================================================== */

test('oturum açılır ve ikinci istemci belgenin SON hâlini alır', async () => {
  const created = await call('/api/collab/create', {
    scene: Scene.blank({ title: 'Ortak' }).toJSON(), name: 'Ali'
  });
  assert.strictEqual(created.status, 200, JSON.stringify(created.body));

  await call('/api/collab/ops', {
    sessionId: created.body.sessionId,
    clientId: created.body.clientId,
    baseVersion: created.body.version,
    ops: [{ op: 'addNode', node: rect('r1') }]
  });

  const joined = await call('/api/collab/join', {
    sessionId: created.body.sessionId, name: 'Veli'
  });

  assert.strictEqual(joined.status, 200);
  assert.strictEqual(joined.body.version, 1);
  assert.strictEqual(joined.body.scene.pages[0].nodes.length, 1,
    'sonradan katılan da nesneyi görmeli');
  assert.strictEqual(joined.body.peers.length, 2);
});

test('bir istemcinin yazdığı DİĞERİNE ulaşır', async () => {
  const a = await call('/api/collab/create', { name: 'Ali' });
  const b = await call('/api/collab/join', { sessionId: a.body.sessionId, name: 'Veli' });

  const stream = listen(a.body.sessionId, b.body.clientId, b.body.version);
  try {
    await stream.until((e) => e.type === 'peers');       // akış bağlandı

    await call('/api/collab/ops', {
      sessionId: a.body.sessionId, clientId: a.body.clientId,
      baseVersion: a.body.version,
      ops: [{ op: 'addNode', node: rect('uzak') }]
    });

    const event = await stream.until((e) => e.type === 'ops');
    assert.strictEqual(event.ops[0].node.id, 'uzak');
    assert.strictEqual(event.version, 1);
    assert.strictEqual(event.clientId, a.body.clientId, 'kimin yazdığı bilinmeli');
  } finally {
    stream.close();
  }
});

test('gönderen KENDİ değişikliğini geri almaz', async () => {
  // Kendi yazdığını geri almak imleci zıplatır ve kelime kaybettirir.
  const a = await call('/api/collab/create', { name: 'Ali' });
  const stream = listen(a.body.sessionId, a.body.clientId, a.body.version);

  try {
    await stream.until((e) => e.type === 'peers');
    await call('/api/collab/ops', {
      sessionId: a.body.sessionId, clientId: a.body.clientId,
      baseVersion: a.body.version, ops: [{ op: 'addNode', node: rect('kendi') }]
    });

    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(stream.events.some((e) => e.type === 'ops'), false,
      'kendi işlemi geri gelmemeli');
  } finally {
    stream.close();
  }
});

test('SİLİNMİŞ düğüme dokunmak 409 ile reddedilir', async () => {
  const a = await call('/api/collab/create', { name: 'Ali' });
  const b = await call('/api/collab/join', { sessionId: a.body.sessionId, name: 'Veli' });

  await call('/api/collab/ops', {
    sessionId: a.body.sessionId, clientId: a.body.clientId,
    baseVersion: 0, ops: [{ op: 'addNode', node: rect('r1') }]
  });
  await call('/api/collab/ops', {
    sessionId: a.body.sessionId, clientId: a.body.clientId,
    baseVersion: 1, ops: [{ op: 'removeNode', nodeId: 'r1' }]
  });

  // Veli hâlâ eski sürümde: sildiğinden haberi yok
  const late = await call('/api/collab/ops', {
    sessionId: a.body.sessionId, clientId: b.body.clientId,
    baseVersion: 1, ops: [{ op: 'updateNode', nodeId: 'r1', patch: { fill: '#00ff00' } }]
  });

  assert.strictEqual(late.status, 409);
  assert.strictEqual(late.body.error.code, 'ERR_OP_MISSING');
});

test('aynı alanı ikisi de değiştirirse ÜZERİNE YAZILDIĞI söylenir', async () => {
  const a = await call('/api/collab/create', { name: 'Ali' });
  const b = await call('/api/collab/join', { sessionId: a.body.sessionId, name: 'Veli' });

  await call('/api/collab/ops', {
    sessionId: a.body.sessionId, clientId: a.body.clientId,
    baseVersion: 0, ops: [{ op: 'addNode', node: rect('r1') }]
  });
  // Ali rengi değiştirir (sürüm 2)
  await call('/api/collab/ops', {
    sessionId: a.body.sessionId, clientId: a.body.clientId,
    baseVersion: 1, ops: [{ op: 'updateNode', nodeId: 'r1', patch: { fill: '#0000ff' } }]
  });

  // Veli sürüm 1'i görüyor ve AYNI alanı değiştiriyor
  const veli = await call('/api/collab/ops', {
    sessionId: a.body.sessionId, clientId: b.body.clientId,
    baseVersion: 1, ops: [{ op: 'updateNode', nodeId: 'r1', patch: { fill: '#00ff00' } }]
  });

  assert.strictEqual(veli.status, 200, 'son gelen kazanır, istek reddedilmez');
  assert.strictEqual(veli.body.overwritten.length, 1,
    'ama neyin üzerine yazıldığı SÖYLENMELİ');
  assert.strictEqual(veli.body.overwritten[0].by, a.body.clientId);
});

test('FARKLI alanlara dokunmak çakışma sayılmaz', async () => {
  const a = await call('/api/collab/create', { name: 'Ali' });
  const b = await call('/api/collab/join', { sessionId: a.body.sessionId, name: 'Veli' });

  await call('/api/collab/ops', {
    sessionId: a.body.sessionId, clientId: a.body.clientId,
    baseVersion: 0, ops: [{ op: 'addNode', node: rect('r1') }]
  });
  await call('/api/collab/ops', {
    sessionId: a.body.sessionId, clientId: a.body.clientId,
    baseVersion: 1, ops: [{ op: 'updateNode', nodeId: 'r1', patch: { fill: '#0000ff' } }]
  });

  const veli = await call('/api/collab/ops', {
    sessionId: a.body.sessionId, clientId: b.body.clientId,
    baseVersion: 1, ops: [{ op: 'updateNode', nodeId: 'r1', patch: { frame: { x: 200 } } }]
  });

  assert.deepStrictEqual(veli.body.overwritten, [],
    'biri rengi diğeri konumu değiştirdiyse çakışma yoktur');
});

test('KOPAN bağlantı kaçırdığı işlemleri yetişir', async () => {
  const a = await call('/api/collab/create', { name: 'Ali' });
  const b = await call('/api/collab/join', { sessionId: a.body.sessionId, name: 'Veli' });

  // Veli bağlı değilken üç işlem geçiyor
  for (const id of ['x', 'y', 'z']) {
    await call('/api/collab/ops', {
      sessionId: a.body.sessionId, clientId: a.body.clientId,
      baseVersion: 99, ops: [{ op: 'addNode', node: rect(id) }]
    });
  }

  // Veli 0. sürümden bağlanıyor: aradaki her şey gelmeli
  const stream = listen(a.body.sessionId, b.body.clientId, 0);
  try {
    const event = await stream.until((e) => e.type === 'ops');
    assert.strictEqual(event.ops.length, 3, 'kaçırılan üç işlem de gelmeli');
    assert.deepStrictEqual(event.ops.map((o) => o.node.id), ['x', 'y', 'z']);
  } finally {
    stream.close();
  }
});

test('geçersiz işlem oturumu BOZMAZ', async () => {
  const a = await call('/api/collab/create', { name: 'Ali' });

  await call('/api/collab/ops', {
    sessionId: a.body.sessionId, clientId: a.body.clientId,
    baseVersion: 0, ops: [{ op: 'addNode', node: rect('iyi') }]
  });

  const bad = await call('/api/collab/ops', {
    sessionId: a.body.sessionId, clientId: a.body.clientId,
    baseVersion: 1,
    ops: [
      { op: 'addNode', node: rect('yeni') },
      { op: 'updateNode', nodeId: 'yok', patch: {} }
    ]
  });
  assert.strictEqual(bad.status, 409);

  // Sunucudaki belge yarım uygulanmış olmamalı
  const joined = await call('/api/collab/join', { sessionId: a.body.sessionId, name: 'Denetçi' });
  assert.deepStrictEqual(
    joined.body.scene.pages[0].nodes.map((n) => n.id), ['iyi']);
  assert.strictEqual(joined.body.version, 1, 'reddedilen işlem sürümü artırmamalı');
});

test('bilinmeyen oturum 404 döner', async () => {
  const res = await call('/api/collab/join', { sessionId: 'yok', name: 'Ali' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error.code, 'ERR_COLLAB_NO_SESSION');
});

test('oturumdan ayrılan katılımcı listeden düşer', async () => {
  const a = await call('/api/collab/create', { name: 'Ali' });
  const b = await call('/api/collab/join', { sessionId: a.body.sessionId, name: 'Veli' });

  await call('/api/collab/leave', {
    sessionId: a.body.sessionId, clientId: b.body.clientId
  });

  const c = await call('/api/collab/join', { sessionId: a.body.sessionId, name: 'Ayşe' });
  assert.deepStrictEqual(c.body.peers.map((p) => p.name).sort(), ['Ali', 'Ayşe']);
});

test('sağlık ucu oturum sayısını bildirir', async () => {
  await call('/api/collab/create', { name: 'Ali' });
  const res = await fetch(base + '/api/health');
  const body = await res.json();
  assert.ok(body.collab.sessions >= 1);
  assert.ok(body.collab.maxSessions > 0);
});
