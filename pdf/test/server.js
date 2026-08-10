'use strict';

const http2 = require('http2');
const fs = require('fs');
const SignatureValidator = require('./validation');

// --- 1. DOĞRULAMA MOTORUNU BAŞLAT ---
const validator = new SignatureValidator();

// --- 2. SADE, MİNİMALİST VE BEYAZ (VANILLA) HTML TASARIMI ---
const HTML_PAGE = `
<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="utf-8">
    <title>FITFAK Doğrulama Motoru</title>
    <style>
        body { 
            background-color: #ffffff; 
            color: #000000; 
            font-family: system-ui, -apple-system, sans-serif; 
            margin: 0; 
            padding: 40px 20px;
            line-height: 1.6;
        }
        .container { 
            max-width: 800px; 
            margin: 0 auto; 
        }
        h1 { 
            font-weight: normal; 
            border-bottom: 1px solid #e5e5e5; 
            padding-bottom: 15px;
            margin-bottom: 30px;
            font-size: 24px;
        }
        .upload-section { 
            border: 1px solid #e5e5e5; 
            padding: 25px; 
            margin-bottom: 30px;
            background-color: #fafafa;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 8px;
            font-weight: 500;
        }
        button { 
            background-color: #ffffff; 
            border: 1px solid #000000; 
            color: #000000; 
            padding: 10px 20px; 
            cursor: pointer; 
            font-size: 14px;
            transition: background-color 0.2s;
        }
        button:hover { 
            background-color: #f5f5f5; 
        }
        h2 {
            font-size: 18px;
            font-weight: normal;
            margin-bottom: 15px;
        }
        .terminal {
            background-color: #ffffff; 
            color: #333333; 
            font-family: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace; 
            padding: 20px; 
            border: 1px solid #e5e5e5; 
            white-space: pre-wrap; 
            word-wrap: break-word; 
            min-height: 250px;
            font-size: 13px;
            line-height: 1.5;
            overflow-x: auto;
        }
        .footer {
            margin-top: 40px;
            font-size: 12px;
            color: #666666;
            text-align: center;
            border-top: 1px solid #e5e5e5;
            padding-top: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>FITFAK PDF Güvenlik ve Doğrulama Motoru</h1>
        
        <div class="upload-section">
            <div class="form-group">
                <label for="pdfInput">Doğrulanacak PDF Dosyasını Seçin:</label>
                <input type="file" id="pdfInput" accept="application/pdf">
            </div>
            <button onclick="uploadAndValidate()">Doğrulamayı Başlat</button>
        </div>

        <h2>Doğrulama Sonucu:</h2>
        <div id="output" class="terminal">Sistem hazır. Lütfen bir PDF dosyası yükleyin.</div>
        
        <div class="footer">
            &copy; 2026 FitFak Technologies. Gelişmiş AIA Mimarisi ile desteklenmektedir.
        </div>
    </div>

    <script>
        async function uploadAndValidate() {
            const fileInput = document.getElementById('pdfInput');
            const output = document.getElementById('output');
            
            if (fileInput.files.length === 0) {
                alert("Lütfen önce bir PDF dosyası seçiniz!"); 
                return;
            }
            
            output.textContent = "Bağlantı kuruluyor... Sunucu yanıtı bekleniyor...";
            
            try {
                const arrayBuffer = await fileInput.files[0].arrayBuffer();
                
                const response = await fetch('/validate', {
                    method: 'POST',
                    body: arrayBuffer,
                    headers: { 
                        'Content-Type': 'application/pdf',
                        'X-File-Name': encodeURIComponent(fileInput.files[0].name)
                    }
                });
                
                const resultText = await response.text();
                output.textContent = resultText;
            } catch (err) {
                output.textContent = "HATA: Sunucu ile iletişim kurulamadı!\\nDetay: " + err.message;
            }
        }
    </script>
</body>
</html>
`;

// --- 3. HTTP/2 SUNUCUSU ---
const server = http2.createSecureServer({
    key: fs.readFileSync('certs/server.key'),
    cert: fs.readFileSync('certs/server.crt')
});

server.on('error', (err) => console.error(err));

server.on('stream', (stream, headers) => {
    const path = headers[':path'];
    const method = headers[':method'];

    // Yönlendirme: Ana Sayfa
    if (method === 'GET' && path === '/') {
        stream.respond({
            'content-type': 'text/html; charset=utf-8',
            ':status': 200
        });
        stream.end(HTML_PAGE);
    } 
    // API: Doğrulama Endpoint'i
    else if (method === 'POST' && path === '/validate') {
        const bodyChunks = [];
        
        stream.on('data', chunk => bodyChunks.push(chunk));
        
        stream.on('end', async () => {
            const pdfBuf = Buffer.concat(bodyChunks);
            
            let fileName = 'Yuklenen_Belge.pdf';
            if (headers['x-file-name']) {
                fileName = decodeURIComponent(headers['x-file-name']);
            }

            try {
                // SignatureValidator sınıfımızı kullanarak işlemi gerçekleştir
                const result = await validator.validateBuffer(pdfBuf, fileName);
                
                stream.respond({
                    'content-type': 'text/plain; charset=utf-8',
                    ':status': 200
                });
                stream.end(result.reportText);
            } catch (e) {
                stream.respond({ ':status': 500 });
                stream.end('İç Sunucu Hatası: ' + e.message);
            }
        });
    } 
    // Yönlendirme: Bulunamadı
    else {
        stream.respond({ ':status': 404 });
        stream.end();
    }
});

const PORT = 443;
server.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`FITFAK HTTP/2 Doğrulama Sunucusu Başladı!`);
    console.log(`Minimalist Arayüz Aktif: https://localhost:${PORT}`);
    console.log(`=========================================`);
});