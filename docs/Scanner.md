# Secure QR Scanner & Validation Gateway

Tamamen bağımlılıksız (zero-dependency) mimariyle geliştirilmiş, tarayıcı üzerinde Version 40 (177x177 modül) yoğunluğundaki karekodları çözümleyebilen Vanilla JS motoru ve güvenli Node.js doğrulama sunucusu.

Bu proje, modern web'in getirdiği gereksiz yüklerden arındırılmış, 90'ların klasik, temiz ve işlevsel web arayüzü anlayışıyla tasarlanmıştır[cite: 1]. Tüm işlemler, herhangi bir harici kütüphane kullanılmadan doğrudan tarayıcı ve sunucu çekirdeğinde gerçekleşir[cite: 1, 2].

## Proje Durumu ve Kapasite

Sistem şu anda en yüksek kapasiteli QR standartlarından biri olan Versiyon 40 QR kodlarını başarılı bir şekilde binarize edip, hizalama testlerinden geçirerek hatasız şekilde çözebilmektedir[cite: 1].

Aşağıdaki görselde projenin qr.png dosyası üzerindeki hata düzeltme (EC H, Mask 2) ve çözümleme başarısı (1852 karaktere kadar) görülmektedir[cite: 1]:

![Tarama Sonucu](result.png)

## Temel Özellikler

### İstemci (Frontend - Vanilla JS)
*   Harici Kütüphanesiz Çözümleme: Reed-Solomon (RS) hata düzeltme, Galois Field (GF) matematiği ve Homografi hesaplamaları tamamen sıfırdan, Vanilla JS ile yazılmıştır[cite: 1].
*   Debug Motoru (v3): Gelişmiş hata izleme paneli sayesinde binarize matris, finder adayları, seçilen finder üçgeni ve kilitlenme (yeşil çerçeve) anlık olarak ekranda oluşturulur[cite: 1].
*   Klasik UI Tasarımı: Gereksiz CSS animasyonları veya modern framework'ler yerine `<fieldset>`, `<legend>` ve temel HTML etiketleri kullanılarak CPU dostu, nostaljik ve son derece hızlı bir arayüz oluşturulmuştur[cite: 1].
*   Gelişmiş Binarizasyon: Siyahların kanamasını (bleeding) durdurmak için eşik değeri 0.80'e kalibre edilmiş ve pencere boyutu 15'e çıkarılmıştır[cite: 1].

### Sunucu (Backend - Node.js)
*   Native Node.js Mimarisi: Sadece yerleşik `http`, `fs` ve `path` modülleri kullanılarak oluşturulmuş, yüksek performanslı doğrulama geçidi.
*   Anti-Karekod Nakli (QR Transplant): Karekodun, üzerinde bulunduğu belgeye ait olup olmadığını doğrulamak için computed (dosyadan hesaplanan) ve claimed (karekottaki) özet değerlerini (hash) karşılaştırır. Eşleşmezse işlemi sahtecilik olarak işaretler.
*   Katı Bellek Yönetimi ve DoS Koruması: Bellek tüketimini engellemek adına kimlik sorguları için gövde sınırı 64 KB, PDF dosyaları için maksimum 8 MB olarak sınırlandırılmıştır. Sınır aşımında bağlantı anında koparılır[cite: 2].
*   Güvenlik Başlıkları: İsteklere otomatik olarak `nosniff`, `no-referrer` ve katı CSP (Content-Security-Policy) başlıkları eklenir[cite: 2].

## Kurulum ve Çalıştırma

Sunucu herhangi bir paket yöneticisi veya node_modules klasörüne ihtiyaç duymaz.

```bash
# Ortam değişkenlerini ayarlayın (Opsiyonel)
export SCANNER_PORT=8080
export SCANNER_HOST="0.0.0.0"

# Sunucuyu başlatın
node server.js
