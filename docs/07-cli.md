# Komut Satırı Arayüzü

`fitfak-belge`, Studio'nun yaptığı her şeyi terminalden yapar. Tasarım kararı:
**her komut ilgili pakete devreder**, iş mantığı CLI'da durmaz. Böylece CLI ile
Studio aynı kodu çalıştırır ve davranışları ayrışamaz.

```bash
npx fitfak-belge <komut> [seçenekler]
npm run cli -- <komut>            # depo içinden
```

## Çıkış kodları

| Kod | Anlam |
|----:|-------|
| `0` | Başarı |
| `1` | Kullanım hatası ya da işlem başarısız (dosya yok, parola yanlış, geçersiz argüman) |
| `2` | **Doğrulama ya da uyumluluk başarısızlığı** — komut çalıştı, sonuç olumsuz |

`2` ayrımı bilinçlidir: betiklerde `if ! fitfak-belge check belge.pdf` doğrudan
çalışır ve "araç çöktü" ile "belge uyumsuz" birbirine karışmaz.

---

## `render` — HTML/CSS → PDF

```bash
fitfak-belge render belge.html -o belge.pdf \
  --title "Sözleşme" --author "Aybars Yıldırım" \
  --conformance pdf/a-2b+pdf/ua
```

| Seçenek | Açıklama |
|---------|----------|
| `-o, --out <dosya>` | çıktı PDF (verilmezse **stdout**) |
| `--theme <ad>` | `@fitfak/paper` teması (varsayılan `kurumsal`) |
| `--no-theme` | paper temasını yükleme |
| `--css <dosya>` | ek CSS (birden çok kez) |
| `--font <Aile=yol.ttf>` | font kaydı (birden çok kez) |
| `--page <boyut>` | `A4` · `A4 landscape` · `"210mm 297mm"` |
| `--margin <deger>` | CSS kısayolu, örn. `"20mm 18mm"` |
| `--title` / `--author` / `--lang` | belge üst verisi |
| `--conformance <profil>` | `pdf/a-2b` · `pdf/ua` · `pdf/a-2b+pdf/ua` |
| `--manifest <dosya>` | yerleşim manifest'ini JSON yaz |

Göreli görsel ve font yolları, **girdi HTML'inin bulunduğu dizine** göre
çözülür (stdin kullanılıyorsa çalışma dizinine).

---

## `sign` — PAdES imzalama

```bash
fitfak-belge sign belge.pdf -o imzali.pdf \
  --pfx kimlik.p12 --password gizli \
  --level LTA --name "Aybars YILDIRIM" --stamp qr
```

| Seçenek | Açıklama |
|---------|----------|
| `--pfx <dosya>` + `--password` | PKCS#12 kimliği |
| `--key` + `--cert` + `--chain` | PEM yolu (`--pfx` yerine) |
| `--level <B\|T\|LT\|LTA>` | PAdES seviyesi (varsayılan `T`) |
| `--tsa <url>` | RFC 3161 sunucusu (`TSA_URL` ortam değişkeni de okunur) |
| `--field <ad>` | imza alanı adı |
| `--reason` / `--location` | imza gerekçesi ve yeri |
| `--page <n>` · `--rect <x,y,g>` | görünür imzanın yeri |
| `--stamp <şablon>` | `classic` · `qr` · `dual` · `minimal` · `handwritten` · `kurumsal` |
| `--name <metin>` | damgada görünecek ad |
| `--invisible` | görünür damga ekleme |

Talep edilen seviyeye ulaşılamazsa **sessizce düşülmez**: gerekçe `stderr`'e
yazılır ve `achievedLevel` bildirilir.

Modern PDF'ler (xref akışı, nesne akışı) otomatik olarak köprülenir; ayrı bir
dönüştürme adımı gerekmez.

---

## `verify` — İmza doğrulama

```bash
fitfak-belge verify imzali.pdf --trust kok.pem --offline
```

| Seçenek | Açıklama |
|---------|----------|
| `--trust <dosya>` | güven çıpası PEM (birden çok kez); yoksa sistem deposu |
| `--offline` | ağa çıkma; yalnız gömülü LTV verisini kullan |
| `--at <ISO tarih>` | doğrulama zamanı |
| `--json` | ETSI raporunu JSON olarak yaz |

Çıktı, her imza için gösterge (`TOTAL-PASSED` / `INDETERMINATE` /
`TOTAL-FAILED`), seviye, imzalayan, kriptografik sonuçlar ve kapsam bilgisidir.
Herhangi bir imza `TOTAL-PASSED` değilse çıkış kodu **2**'dir.

---

## `extend` — LT / LTA'ya yükseltme

```bash
fitfak-belge extend imzali.pdf --to LTA -o arsiv.pdf
```

Mevcut imzalara **dokunmaz**: doğrulama verisi ve arşiv damgası yeni bir
artımlı revizyon olarak eklenir.

---

## `inspect` — Yapı özeti

```bash
fitfak-belge inspect belge.pdf            # okunabilir
fitfak-belge inspect belge.pdf --json     # makine okunur
fitfak-belge inspect gizli.pdf --password …
```

Sayfa sayısı ve geometrisi, şifreleme durumu, üst veri, form alanları, imzalar.
Bozuk çapraz başvuru tablosu onarıldıysa bunu da bildirir.

---

## `text` — Metin çıkarımı

```bash
fitfak-belge text belge.pdf               # tüm belge (sayfalar \f ile ayrılır)
fitfak-belge text belge.pdf --page 0
fitfak-belge text belge.pdf --json        # konumlarıyla birlikte
```

`/ToUnicode` CMap, `/Encoding` + `/Differences` ve Type0 fontlar desteklenir;
Form XObject'lere inilir (düzleştirilmiş formların metni de çıkar).

---

## `edit` — Artımlı düzenleme

```bash
fitfak-belge edit belge.pdf -o duzenli.pdf \
  --rotate 0:90 \
  --text "0:60:40:9=Onaylandı" \
  --image "0:400:700:80=logo.png" \
  --fill "ad=Aybars YILDIRIM" --flatten
```

| Seçenek | Biçim |
|---------|-------|
| `--rotate` | `sayfa:derece` (90'ın katı, birikimli) |
| `--remove-page` | `n` (birden çok kez; indeksler kaymaz) |
| `--move-page` | `from:to` |
| `--image` | `sayfa:x:y:genişlik[:yükseklik]=dosya` |
| `--text` | `sayfa:x:y[:punto]=metin` |
| `--fill` | `alan=değer` (birden çok kez) |
| `--flatten` | formu düzleştir (imza alanı korunur) |
| `--title` / `--author` | üst veri |
| `--rewrite` | artımlı yerine tam yeniden yazım |

Koordinatlar PDF kullanıcı uzayındadır: **orijin sol-alt**, birim punto.

Varsayılan **artımlıdır**: orijinal baytlara dokunulmaz, belgedeki imzalar
geçerli kalır. `--rewrite` imzalı bir belgede `ERR_WOULD_BREAK_SIGNATURE` ile
reddedilir.

---

## `check` — PDF/A ve PDF/UA denetimi

```bash
fitfak-belge check belge.pdf                       # XMP iddiasına göre
fitfak-belge check belge.pdf --profile pdf/a-2b    # açıkça
fitfak-belge check belge.pdf --json
```

Uyumsuzlukta çıkış kodu **2**. Her bulgu ihlal edilen maddeyi (`6.2.2`) ya da
kuralı (`13`) adıyla söyler.

---

## `stamp` — Damga PNG'si

```bash
fitfak-belge stamp -o damga.png --template dual --name "Aybars YILDIRIM"
```

Görünür imza damgasını PDF'ten bağımsız üretir — önizleme ve tasarım için.

---

## `serve` — Studio sunucusu

```bash
fitfak-belge serve --port 8787 --host 127.0.0.1
```

`npm start` ile aynı sunucuyu başlatır; ikisi de `apps/server/server.js`
içindeki `start()` fonksiyonunu çağırır.

---

## Boru hattı örneği

Üret → denetle → imzala → doğrula, hepsi çevrimdışı:

```bash
set -e

fitfak-belge render sozlesme.html -o sozlesme.pdf \
  --title "Hizmet Sözleşmesi" --conformance pdf/a-2b+pdf/ua

fitfak-belge check sozlesme.pdf                    # uyumsuzsa burada durur

fitfak-belge sign sozlesme.pdf -o imzali.pdf \
  --pfx kimlik.p12 --password "$PFX_PAROLA" --level LTA

fitfak-belge verify imzali.pdf --trust kok.pem --offline
```

`set -e` ile her adım çıkış koduyla kapıyı tutar: uyumsuz belge imzalanmaz,
geçersiz imza da sessizce geçmez.
