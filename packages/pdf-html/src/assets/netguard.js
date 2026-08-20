'use strict';
/**
 * Ağ adresi güvenlik denetimi — SSRF savunmasının çekirdeği.
 *
 * TEHDİT
 *
 * Belgeden gelen bir `<img src="http://…">` sunucuya HTTP isteği attırır.
 * Sunucu, saldırganın ulaşamadığı yerlere ulaşabilir:
 *
 *   http://169.254.169.254/latest/meta-data/   bulut kimlik bilgileri
 *   http://127.0.0.1:6379/                      yerel Redis
 *   http://[::1]:8080/admin                     yerel yönetim arayüzü
 *   http://10.0.0.5/                            özel ağ
 *   http://metadata.google.internal/            DNS ile aynı yere
 *
 * SAVUNMANIN İKİ ZOR NOKTASI
 *
 * 1. **Ad çözümlemesi denetimden SONRA değişebilir** (DNS rebinding):
 *    adres denetlenir, sonra istek atılırken ad yeniden çözülür ve bu kez
 *    127.0.0.1 döner. Bu yüzden ad BİR KEZ çözülür, güvenli bulunan IP'ye
 *    BAĞLANILIR ve `Host` başlığı elle korunur.
 *
 * 2. **Yönlendirme (redirect) denetimi atlatır**: güvenli bir adres
 *    30x ile `http://169.254.169.254`e gönderir. Bu yüzden her yönlendirme
 *    halkası SIFIRDAN denetlenir; `fetch`in kendi yönlendirme takibi
 *    KULLANILMAZ.
 *
 * Bu dosya yalnız KARAR verir; isteği `remote.js` atar.
 */

const dns = require('dns');
const net = require('net');

class NetGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NetGuardError';
    this.code = code;
  }
}

/** İzin verilen şemalar — yasak listesi değil, İZİN listesi. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Engellenen IPv4 blokları (CIDR).
 *
 * Kaynak: RFC 1918 (özel), RFC 5735/6890 (özel amaçlı), RFC 6598 (CGNAT),
 * RFC 3927 (link-local — bulut üstveri adresi buradadır).
 */
const BLOCKED_V4 = [
  ['0.0.0.0', 8],          // "bu ağ"
  ['10.0.0.0', 8],         // özel
  ['100.64.0.0', 10],      // CGNAT
  ['127.0.0.0', 8],        // geri döngü
  ['169.254.0.0', 16],     // link-local + bulut üstveri (169.254.169.254)
  ['172.16.0.0', 12],      // özel
  ['192.0.0.0', 24],       // IETF protokol atamaları
  ['192.0.2.0', 24],       // TEST-NET-1
  ['192.88.99.0', 24],     // 6to4 relay (kullanımdan kalktı)
  ['192.168.0.0', 16],     // özel
  ['198.18.0.0', 15],      // kıyaslama
  ['198.51.100.0', 24],    // TEST-NET-2
  ['203.0.113.0', 24],     // TEST-NET-3
  ['224.0.0.0', 4],        // çoklu gönderim
  ['240.0.0.0', 4]         // ayrılmış (255.255.255.255 dâhil)
];

const v4ToInt = (ip) =>
  ip.split('.').reduce((acc, part) => ((acc << 8) | (Number(part) & 0xff)) >>> 0, 0) >>> 0;

function inV4Block(ip, base, bits) {
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

/** IPv6 adresini 16 baytlık diziye çevirir (`::` genişletilir). */
function v6ToBytes(address) {
  let text = address;
  let mappedV4 = null;

  // IPv4-eşlenmiş biçim: ::ffff:1.2.3.4
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (tail) {
    mappedV4 = tail[1];
    const n = v4ToInt(mappedV4);
    text = text.slice(0, tail.index) +
      [(n >>> 16) & 0xffff, n & 0xffff].map((h) => h.toString(16)).join(':');
  }

  const [head, rest] = text.split('::');
  const left = head ? head.split(':').filter(Boolean) : [];
  const right = rest !== undefined ? rest.split(':').filter(Boolean) : [];
  const fill = rest !== undefined ? 8 - left.length - right.length : 0;
  if (fill < 0) throw new NetGuardError('ERR_NET_BAD_ADDRESS', `Geçersiz IPv6: ${address}`);

  const groups = [...left, ...Array(fill).fill('0'), ...right];
  if (groups.length !== 8) throw new NetGuardError('ERR_NET_BAD_ADDRESS', `Geçersiz IPv6: ${address}`);

  const bytes = Buffer.alloc(16);
  groups.forEach((g, i) => bytes.writeUInt16BE(parseInt(g, 16) || 0, i * 2));
  return { bytes, mappedV4 };
}

/**
 * Bu IP adresine bağlanmak güvenli mi?
 *
 * @returns {{ safe: boolean, reason?: string }}
 */
function inspectAddress(address) {
  const family = net.isIP(address);
  if (!family) return { safe: false, reason: `IP adresi değil: ${address}` };

  if (family === 4) {
    for (const [base, bits] of BLOCKED_V4) {
      if (inV4Block(address, base, bits)) {
        return { safe: false, reason: `Engelli IPv4 bloğu ${base}/${bits}: ${address}` };
      }
    }
    return { safe: true };
  }

  let parsed;
  try { parsed = v6ToBytes(address); }
  catch (err) { return { safe: false, reason: err.message }; }

  const b = parsed.bytes;

  // ::ffff:0:0/96 — IPv4 eşlenmiş: IPv4 kurallarıyla denetlenir.
  // Bu adım atlanırsa `http://[::ffff:127.0.0.1]/` savunmayı deler.
  const isMapped = b.subarray(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  if (isMapped) {
    const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
    const inner = inspectAddress(v4);
    return inner.safe ? inner : { safe: false, reason: `IPv4-eşlenmiş ${v4}: ${inner.reason}` };
  }

  // ::  (belirsiz) ve ::1 (geri döngü)
  if (b.subarray(0, 15).every((x) => x === 0) && (b[15] === 0 || b[15] === 1)) {
    return { safe: false, reason: `IPv6 geri döngü/belirsiz: ${address}` };
  }
  // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) {
    return { safe: false, reason: `IPv6 link-local: ${address}` };
  }
  // fc00::/7 benzersiz yerel (ULA)
  if ((b[0] & 0xfe) === 0xfc) {
    return { safe: false, reason: `IPv6 benzersiz yerel adres: ${address}` };
  }
  // ff00::/8 çoklu gönderim
  if (b[0] === 0xff) {
    return { safe: false, reason: `IPv6 çoklu gönderim: ${address}` };
  }
  // 2002::/16 6to4 ve 64:ff9b::/96 NAT64 — gömülü IPv4'ü denetle
  if (b[0] === 0x20 && b[1] === 0x02) {
    const v4 = `${b[2]}.${b[3]}.${b[4]}.${b[5]}`;
    const inner = inspectAddress(v4);
    return inner.safe ? inner : { safe: false, reason: `6to4 gömülü ${v4}: ${inner.reason}` };
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
    const inner = inspectAddress(v4);
    return inner.safe ? inner : { safe: false, reason: `NAT64 gömülü ${v4}: ${inner.reason}` };
  }

  return { safe: true };
}

/**
 * URL'i denetler ve bağlanılacak GÜVENLİ IP'yi döndürür.
 *
 * Ad çözümlemesi burada BİR KEZ yapılır ve dönen IP'ye bağlanılır; istek
 * anında yeniden çözmek DNS rebinding'e kapı açar.
 *
 * @param {string} rawUrl
 * @param {{ allowHosts?: string[], denyHosts?: string[], lookup?: Function,
 *           allowPrivate?: boolean }} [opts]
 * @returns {Promise<{ url: URL, address: string, family: number }>}
 */
async function resolveSafeUrl(rawUrl, opts = {}) {
  let url;
  try { url = new URL(rawUrl); }
  catch { throw new NetGuardError('ERR_NET_BAD_URL', `Adres çözümlenemedi: ${String(rawUrl).slice(0, 120)}`); }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new NetGuardError('ERR_NET_SCHEME',
      `Yalnız http ve https: ${url.protocol}`);
  }
  if (url.username || url.password) {
    // `http://kullanici:parola@host` — kimlik bilgisi taşımak, hedefte
    // istenmeyen bir oturum açmanın yoludur.
    throw new NetGuardError('ERR_NET_CREDENTIALS', 'Adreste kimlik bilgisi taşınamaz');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (opts.denyHosts && opts.denyHosts.some((h) => matchHost(host, h))) {
    throw new NetGuardError('ERR_NET_HOST_DENIED', `Yasaklı sunucu adı: ${host}`);
  }
  if (opts.allowHosts && opts.allowHosts.length &&
      !opts.allowHosts.some((h) => matchHost(host, h))) {
    throw new NetGuardError('ERR_NET_HOST_NOT_ALLOWED',
      `Sunucu adı izin listesinde değil: ${host}`);
  }

  // Ad zaten IP ise çözümlemeye gerek yok
  const literal = net.isIP(host);
  if (literal) {
    const verdict = opts.allowPrivate ? { safe: true } : inspectAddress(host);
    if (!verdict.safe) throw new NetGuardError('ERR_NET_BLOCKED_ADDRESS', verdict.reason);
    return { url, address: host, family: literal };
  }

  const lookup = opts.lookup || dns.promises.lookup;
  let records;
  try {
    records = await lookup(host, { all: true });
  } catch (err) {
    throw new NetGuardError('ERR_NET_DNS', `Ad çözümlenemedi (${host}): ${err.message}`);
  }
  if (!records || !records.length) {
    throw new NetGuardError('ERR_NET_DNS', `Ad hiçbir adrese çözülmedi: ${host}`);
  }

  // TEK BİR kötü adres bile varsa reddedilir. "İyi olanı seç" demek,
  // saldırganın hem iyi hem kötü adres yayınlamasına ve yarışı kazanmasına
  // izin vermek olurdu.
  for (const record of records) {
    const verdict = opts.allowPrivate ? { safe: true } : inspectAddress(record.address);
    if (!verdict.safe) {
      throw new NetGuardError('ERR_NET_BLOCKED_ADDRESS',
        `${host} → ${verdict.reason}`);
    }
  }

  return { url, address: records[0].address, family: records[0].family };
}

/** `*.ornek.test` ve tam ad eşleşmesi. */
function matchHost(host, pattern) {
  const h = String(host).toLowerCase();
  const p = String(pattern).toLowerCase();
  if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1));
  return h === p;
}

module.exports = {
  resolveSafeUrl, inspectAddress, matchHost,
  NetGuardError, ALLOWED_PROTOCOLS, BLOCKED_V4
};
