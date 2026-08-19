'use strict';
/**
 * @fitfak/pdf-doc — mevcut PDF belgelerini okuma ve düzenleme.
 *
 * Klasik xref tabloları, `/Type /XRef` akışları, `/ObjStm` nesne akışları,
 * standart şifreleme (RC4 / AESV2 / AESV3) ve bozuk dosya kurtarma desteklenir.
 * Kaydetme varsayılan olarak artımlıdır: mevcut imzalar geçerliliğini korur.
 */

module.exports = {
  ...require('./src/lexer'),
  ...require('./src/filters'),
  ...require('./src/xref'),
  ...require('./src/crypt'),
  ...require('./src/document'),
  ...require('./src/writer'),
  ...require('./src/edit'),
  ...require('./src/encoding'),
  ...require('./src/metrics'),
  ...require('./src/content'),
  ...require('./src/text'),
  ...require('./src/acroform')
};
