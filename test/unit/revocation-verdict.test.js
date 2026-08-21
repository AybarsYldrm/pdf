'use strict';
/**
 * İptal kararının ETSI mantığı.
 *
 * Denetimde iki ayrı eksen birbirine karışmıştı:
 *   `poeTime ? 'REVOKED_CA_NO_POE' : 'REVOKED_NO_POE'`
 * yani POE'nin VARLIĞI "iptal edilen bir CA'ydı" anlamına geliyordu. Oysa:
 *   • iptal edilen sertifika YAPRAK mı CA mı — bir eksen
 *   • imza iptalden ÖNCE var mıydı (POE) — bambaşka bir eksen
 */

const test = require('node:test');
const assert = require('node:assert');

const { poeAntedatesRevocation } = require('@fitfak/verify');

const T = (iso) => new Date(iso);

test('POE iptalden önceyse imza korunur', () => {
  assert.strictEqual(
    poeAntedatesRevocation(T('2024-01-01T00:00:00Z'), {
      revocationTime: '2024-06-01T00:00:00Z', reason: 'superseded'
    }), true);
});

test('POE iptalden sonraysa korumaz', () => {
  assert.strictEqual(
    poeAntedatesRevocation(T('2024-09-01T00:00:00Z'), {
      revocationTime: '2024-06-01T00:00:00Z', reason: 'superseded'
    }), false);
});

test('anahtar ele geçirilmesinde POE koruma sağlamaz', () => {
  // Anahtarın ne zamandan beri başkasının elinde olduğu bilinmez: imza
  // iptalden önce atılmış olsa bile onu saldırgan atmış olabilir.
  for (const reason of ['keyCompromise', 'cACompromise', 'CACompromise']) {
    assert.strictEqual(
      poeAntedatesRevocation(T('2024-01-01T00:00:00Z'), {
        revocationTime: '2024-06-01T00:00:00Z', reason
      }), false, `${reason} için koruma verilmemeli`);
  }
});

test('invalidityDate varsa kıyas ONA yapılır', () => {
  // CA "bu sertifika 2023-12-01'den İTİBAREN geçersizdi" diyor. İmza
  // 2024-01-01'de atılmışsa, iptal kaydı 2024-06'da girilmiş olsa da
  // imza zaten geçersiz bir sertifikayla atılmıştır.
  assert.strictEqual(
    poeAntedatesRevocation(T('2024-01-01T00:00:00Z'), {
      revocationTime: '2024-06-01T00:00:00Z',
      invalidityTime: '2023-12-01T00:00:00Z',
      reason: 'superseded'
    }), false);

  // Tersi: geçersizlik tarihi imzadan sonraysa imza korunur.
  assert.strictEqual(
    poeAntedatesRevocation(T('2023-06-01T00:00:00Z'), {
      revocationTime: '2024-06-01T00:00:00Z',
      invalidityTime: '2023-12-01T00:00:00Z',
      reason: 'superseded'
    }), true);
});

test('zaman bilinmiyorsa koruma verilmez', () => {
  assert.strictEqual(
    poeAntedatesRevocation(T('2024-01-01T00:00:00Z'),
      { revocationTime: null, reason: 'superseded' }), false);
  assert.strictEqual(
    poeAntedatesRevocation(T('2024-01-01T00:00:00Z'),
      { revocationTime: 'gecersiz-tarih', reason: null }), false);
});

test('POE yoksa koruma yok', () => {
  assert.strictEqual(
    poeAntedatesRevocation(null, { revocationTime: '2024-06-01T00:00:00Z' }), false);
});
