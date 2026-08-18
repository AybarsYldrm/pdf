const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 80;
// Sunucuyu tüm ağ arayüzlerine açıyoruz ki telefondan veya tünelden erişilebilsin
const HOST = '127.0.0.1'; 

const server = http.createServer((req, res) => {
  // Basit bir Router mantığı
  
  // 1. İstemci Arayüzünü (QR Tarayıcı) Sunma
  if (req.method === 'GET' && req.url === '/') {
    const filePath = path.join(__dirname, 'scanner.html');
    
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Sunucu Hatası: scanner.html dosyası bulunamadı veya okunamadı.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    });
  }
  
  // 2. Belge Doğrulama API Endpoint'i (İleride PoA Blockchain'e bağlanacak kısım)
  else if (req.method === 'POST' && req.url === '/api/verify') {
    let body = '';
    
    // Gelen veri parçalarını (chunks) birleştir
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const parsedData = JSON.parse(body);
        console.log(`[+] Gelen doğrulama talebi: ${parsedData.hash}`);
        
        // Burada gerçek sisteminde zincire (blockchain) bakıp belgeyi doğrulayacaksın
        // Şimdilik başarılı bir JSON dönüyoruz
        const responseData = {
          status: 'success',
          message: 'Belge zincirde başarıyla doğrulandı.',
          documentId: parsedData.hash,
          timestamp: new Date().toISOString()
        };
        
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(responseData));
        
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', message: 'Geçersiz veri formatı.' }));
      }
    });
  }
  
  // 3. Bulunamayan Rotalar (404)
  else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 - Sayfa Bulunamadı');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n🚀 Saf Node.js Sunucusu Başlatıldı!`);
  console.log(`-> Yerel Erişim: http://localhost:${PORT}`);
  console.log(`-> Ağ Erişimi:   http://<BILGISAYARIN_IP_ADRESI>:${PORT}`);
  console.log(`\nNot: Kameranın mobil tarayıcıda çalışması için telefondan girerken HTTPS veya localhost üzerinden (örn: WebEdge tüneli ile) erişim sağlanmalıdır.`);
});