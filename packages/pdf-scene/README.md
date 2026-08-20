# @fitfak/pdf-scene

Serbest yerleşimli belge modeli — editör ile PDF motoru arasındaki tek gerçek
kaynak.

Akış belgeleri (`@fitfak/pdf-html`) için değil; **kullanıcı nesneyi nereye
koyduysa oraya basılsın** isteyen belgeler için: sertifika, kartvizit, kapak,
sunum sayfası, etiket.

> Ayrıntılı tasarım ve bilinen sınırlar: [docs/09-sahne-modeli.md](../../docs/09-sahne-modeli.md)

## Hızlı bakış

```js
const { Scene, compileToPdf } = require('@fitfak/pdf-scene');

const scene = Scene.blank({ title: 'Katılım Belgesi' });

scene.transaction('Kur', () => {
  scene.addNode(Scene.createNode('rect', {
    x: 40, y: 40, width: 515, height: 80, fill: '#1f3a63', radius: 6
  }));
  scene.addNode(Scene.createNode('text', {
    x: 60, y: 55, width: 475, height: 50,
    text: 'KATILIM BELGESİ', fontSize: 24, color: '#ffffff',
    align: 'center', valign: 'middle'
  }));
  scene.addNode(Scene.createNode('signature', {
    x: 330, y: 640, width: 200, height: 70,
    fieldName: 'Imza_Yetkili', signerTitle: 'Düzenleyen'
  }));
});

const { pdf, manifest, warnings } = compileToPdf(scene, {
  fonts: [{ family: 'Ubuntu', src: 'assets/Ubuntu-Regular.ttf' }]
});

// manifest.signatureSlots → doğrudan @fitfak/pades'in fromManifestSlot()'una verilir
```

## Temel kurallar

- **Tek birim: punto.** Sayfa, çerçeve, font boyutu — hepsi pt.
- **Başlangıç: sayfanın sol üstü.** PDF'in sol-altına çevirmek derleyicinin işi.
- **Varlıklar kimlikle anılır**, dosya yoluyla değil. Belge içeriği dosya
  sistemine dokunamaz.
- **Metin metindir.** HTML değildir, HTML olarak yorumlanmaz.
- **Değişiklikler işlem (transaction) içinde yapılır.** Bir sürükleme tek
  geri alma adımıdır.

## API

| Giriş | İş |
|---|---|
| `Scene.blank(opts)` / `Scene.fromJSON(doc)` | Belge kur |
| `scene.transaction(label, fn, { mergeKey })` | Değişiklikleri tek adımda topla |
| `scene.addNode / removeNode / updateNode / moveNode` | Düğüm işlemleri |
| `scene.group / ungroup / reorder` | Yapı ve z sırası |
| `scene.copy / paste / duplicate` | Pano |
| `scene.align / alignToPage / distribute` | Hizalama |
| `scene.undo() / redo()` | Geri alma |
| `validateScene(doc)` | Doğrula + normalleştir |
| `compileToPdf(scene, { fonts, assets })` | Sahne → PDF |
| `compileToHtml(scene, { assets })` | Sahne → önizleme HTML'i |
| `importFromHtml(opts)` / `importFromPdf(bytes, opts)` | İçe aktar |
| `AssetManager` | SHA-256 tekilleştirmeli varlık havuzu |
| `geometry` | Matris, sınır kutusu, hizalama, yapışma |

## Tarayıcı paketi

`browser.js`, model çekirdeğini tek bir ES modülüne toplar:

```bash
npm run build -w @fitfak/pdf-scene   # dist/scene.esm.js
```

`apps/server` bunu `/vendor/scene.esm.js` adresinde **anında** üretir; editör
ile sunucu böylece aynı kaynaktan çalışır. Derleyiciler ve içe aktarıcılar
pakete girmez — onlar sunucuda çalışır.

## Bağımlılıklar

`@fitfak/pdf-html` (PDF yazarı ve font gömme), `@fitfak/qr` (karekod).
Harici bağımlılık yoktur.
