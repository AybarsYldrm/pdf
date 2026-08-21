'use strict';
/**
 * @fitfak/netguard — SSRF savunmasının TEK karar noktası.
 *
 * Bu paket bir zamanlar `@fitfak/pdf-html` içinde, yalnız uzak görsel ve font
 * indirmek için duruyordu. Oysa aynı riski taşıyan başka getiriciler de var:
 * AIA (caIssuers), CRL dağıtım noktaları, OCSP yanıtlayıcıları ve TSA
 * adresleri. Bunların HEPSİ saldırganın verdiği bir belgeden gelir —
 * sertifikanın içine yazılmış bir URL, imzalayanın değil, sertifikayı üretenin
 * seçimidir.
 *
 * Bir doğrulayıcı, kendisine verilen belgedeki adrese isteği körü körüne
 * atarsa, saldırganın ağ içindeki her yere erişmesi için bir aracıya dönüşür:
 *
 *     AIA: http://169.254.169.254/latest/meta-data/iam/security-credentials/
 *     CDP: http://127.0.0.1:8500/v1/kv/production?raw
 *
 * Kural tek olsun ki iki farklı davranış olmasın: getiren kim olursa olsun
 * adres aynı süzgeçten geçsin.
 */

const netguard = require('./src/netguard');
const remote = require('./src/remote');
const pki = require('./src/pki');

module.exports = { ...netguard, ...remote, ...pki };
