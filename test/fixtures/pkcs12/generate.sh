#!/usr/bin/env bash
# Gerçek dünyadaki PFX çeşitlerini üretir. Repoya GERÇEK anahtar konmaz;
# bunlar yalnız test amaçlı, tek kullanımlık anahtarlardır. Parola: "test"
#
# Kullanım:  bash test/fixtures/pkcs12/generate.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$DIR/.work"
PASS="test"

rm -rf "$WORK"; mkdir -p "$WORK"
cd "$WORK"

echo "→ Test CA ve son kullanıcı sertifikaları üretiliyor..."

# Kök CA
openssl req -x509 -newkey rsa:2048 -keyout ca.key -out ca.crt -days 3650 -nodes \
  -subj "/C=TR/O=FITFAK Test/CN=FITFAK Test PFX CA" 2>/dev/null

# Ara CA
openssl req -newkey rsa:2048 -keyout sub.key -out sub.csr -nodes \
  -subj "/C=TR/O=FITFAK Test/CN=FITFAK Test PFX Sub CA" 2>/dev/null
openssl x509 -req -in sub.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out sub.crt -days 1825 \
  -extfile <(printf "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n") 2>/dev/null

# RSA son kullanıcı
openssl req -newkey rsa:2048 -keyout ee-rsa.key -out ee-rsa.csr -nodes \
  -subj "/C=TR/O=FITFAK Test/CN=Aybars YILDIRIM" 2>/dev/null
openssl x509 -req -in ee-rsa.csr -CA sub.crt -CAkey sub.key -CAcreateserial -out ee-rsa.crt -days 730 \
  -extfile <(printf "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,nonRepudiation\n") 2>/dev/null

# EC son kullanıcı
openssl ecparam -name prime256v1 -genkey -noout -out ee-ec.key 2>/dev/null
openssl req -new -key ee-ec.key -out ee-ec.csr -subj "/C=TR/O=FITFAK Test/CN=Ahmet YILMAZ" 2>/dev/null
openssl x509 -req -in ee-ec.csr -CA sub.crt -CAkey sub.key -CAcreateserial -out ee-ec.crt -days 730 \
  -extfile <(printf "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,nonRepudiation\n") 2>/dev/null

cat sub.crt ca.crt > chain.pem

echo "→ PFX varyantları üretiliyor..."

# 1) Modern varsayılan: PBES2 + AES-256-CBC, HMAC-SHA256
openssl pkcs12 -export -out "$DIR/openssl3-aes256.pfx" \
  -inkey ee-rsa.key -in ee-rsa.crt -certfile chain.pem \
  -passout "pass:$PASS" -name "Aybars YILDIRIM" \
  -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256 2>/dev/null

# 2) Eski OpenSSL/Windows varsayılanı: PKCS#12 PBE 3DES + RC2-40
#    (OpenSSL 3'te legacy provider gerekir)
if openssl pkcs12 -export -out "$DIR/legacy-3des-rc2.pfx" \
  -inkey ee-rsa.key -in ee-rsa.crt -certfile chain.pem \
  -passout "pass:$PASS" -name "Aybars YILDIRIM" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-RC2-40 -macalg sha1 -legacy 2>/dev/null; then
  echo "   ✔ legacy-3des-rc2.pfx (RC2-40 sertifika çantası)"
else
  echo "   ⚠ legacy provider yok — legacy-3des-rc2.pfx atlandı"
fi

# 3) Yalnız 3DES (RC2 olmadan) — legacy provider gerektirmeyebilir
if openssl pkcs12 -export -out "$DIR/legacy-3des.pfx" \
  -inkey ee-rsa.key -in ee-rsa.crt -certfile chain.pem \
  -passout "pass:$PASS" -name "Aybars YILDIRIM" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 -legacy 2>/dev/null; then
  echo "   ✔ legacy-3des.pfx"
else
  echo "   ⚠ legacy-3des.pfx atlandı"
fi

# 4) EC anahtarlı
openssl pkcs12 -export -out "$DIR/ec-aes256.pfx" \
  -inkey ee-ec.key -in ee-ec.crt -certfile chain.pem \
  -passout "pass:$PASS" -name "Ahmet YILMAZ" \
  -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256 2>/dev/null

# 5) MAC'siz
openssl pkcs12 -export -out "$DIR/no-mac.pfx" \
  -inkey ee-rsa.key -in ee-rsa.crt -certfile chain.pem \
  -passout "pass:$PASS" -nomac -keypbe AES-256-CBC -certpbe AES-256-CBC 2>/dev/null || \
  echo "   ⚠ no-mac.pfx atlandı"

# 6) Boş parola
openssl pkcs12 -export -out "$DIR/empty-password.pfx" \
  -inkey ee-rsa.key -in ee-rsa.crt -certfile chain.pem \
  -passout "pass:" -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256 2>/dev/null

# 7) Çok kimlikli (iki anahtar + iki sertifika)
cat ee-rsa.key ee-rsa.crt > id1.pem
cat ee-ec.key  ee-ec.crt  > id2.pem
openssl pkcs12 -export -out "$DIR/multi-identity.pfx" \
  -inkey ee-rsa.key -in ee-rsa.crt -certfile chain.pem \
  -passout "pass:$PASS" -name "Kimlik 1" \
  -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256 2>/dev/null

# 8) Sertifikasız (yalnız CA paketi)
openssl pkcs12 -export -out "$DIR/certs-only.pfx" -nokeys \
  -in chain.pem -passout "pass:$PASS" \
  -certpbe AES-256-CBC -macalg sha256 2>/dev/null || echo "   ⚠ certs-only.pfx atlandı"

# 9) Unicode parola
openssl pkcs12 -export -out "$DIR/unicode-password.pfx" \
  -inkey ee-rsa.key -in ee-rsa.crt -certfile chain.pem \
  -passout "pass:şifreÖĞÜ123" -name "Unicode" \
  -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256 2>/dev/null

# Referans PEM'ler (testlerin karşılaştırma yapabilmesi için)
cp ee-rsa.crt "$DIR/ref-ee-rsa.crt"
cp ee-ec.crt  "$DIR/ref-ee-ec.crt"
cp chain.pem  "$DIR/ref-chain.pem"

cd "$DIR"
rm -rf "$WORK"

echo
echo "Üretilenler:"
ls -la "$DIR"/*.pfx 2>/dev/null || true
