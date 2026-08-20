'use strict';
/**
 * Sahne modeli şeması — sürüm 1.
 *
 * TASARIM KARARLARI (ve neden böyle)
 *
 * 1. **Model DOM'a bağlı değildir.** Düz veridir: `JSON.parse(JSON.stringify(x))`
 *    turundan aynı çıkar. Editör tarayıcıda, derleyici Node'da, içe aktarıcı
 *    ikisinde de çalışır. Modeli DOM'a bağlamak, PDF üretimini tarayıcıya
 *    mahkûm ederdi.
 *
 * 2. **Tek birim: punto.** Sayfa geometrisi, düğüm çerçevesi, font boyutu —
 *    hepsi pt. Karışık birim taşımak her okuyucuyu dönüştürmeye zorlar.
 *
 * 3. **Koordinat başlangıcı sayfanın SOL ÜST köşesidir.** Ekranla aynı yön;
 *    PDF'in sol-alt başlangıcına çevirmek derleyicinin işidir. Editörde
 *    "y arttıkça aşağı" beklentisi evrenseldir, modelde tersini tutmak her
 *    sürükleme hesabında işaret hatası üretir.
 *
 * 4. **Varlıklar KİMLİKLE anılır, dosya yoluyla değil.** Bir düğüm
 *    `assetId: 'ast_…'` tutar. Böylece sahne dosyası taşınabilir olur ve
 *    belge içeriği asla dosya sistemine dokunamaz (bkz. docs/08-guvenlik.md
 *    G-01).
 *
 * 5. **Metin, metindir.** `text` alanı düz metindir; HTML değildir ve HTML
 *    olarak yorumlanmaz. Zengin biçimlendirme `runs` dizisiyle yapılır —
 *    her koşu (run) kendi stilini taşır. Böylece derleyicinin dizge
 *    birleştirerek işaretleme üretmesi gerekmez.
 *
 * 6. **Sürüm alanı zorunludur.** Şema değişince eski dosyaları okumanın tek
 *    yolu, hangi şemayla yazıldıklarını bilmektir.
 */

const SCHEMA_VERSION = 1;

/** İsimli sayfa boyutları (punto). @fitfak/pdf-html ile aynı olmalıdır. */
const PAGE_SIZES = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  A6: [297.64, 419.53],
  LETTER: [612, 792],
  LEGAL: [612, 1008],
  TABLOID: [792, 1224]
};

/**
 * Düğüm tipleri ve alanları.
 *
 * `fields` yalnız o tipe özgü alanlardır; ortak alanlar `COMMON_FIELDS`
 * içindedir. Doğrulayıcı bu tabloyu okur — kurallar iki yerde yazılmaz.
 */
const NODE_TYPES = {
  /** Düz ya da koşulara bölünmüş metin kutusu. */
  text: {
    fields: {
      text:       { type: 'string', default: '', maxLength: 100_000 },
      runs:       { type: 'runs', optional: true },
      fontFamily: { type: 'string', default: 'Ubuntu', maxLength: 128 },
      fontSize:   { type: 'length', default: 11, min: 0.5, max: 1440 },
      lineHeight: { type: 'number', default: 1.4, min: 0.5, max: 10 },
      color:      { type: 'color', default: '#111111' },
      align:      { type: 'enum', values: ['left', 'center', 'right', 'justify'], default: 'left' },
      valign:     { type: 'enum', values: ['top', 'middle', 'bottom'], default: 'top' },
      bold:       { type: 'boolean', default: false },
      italic:     { type: 'boolean', default: false },
      letterSpacing: { type: 'length', default: 0, min: -20, max: 100 },
      padding:    { type: 'length', default: 0, min: 0, max: 1000 }
    }
  },

  /** Dikdörtgen — arka plan, çerçeve, ayraç. */
  rect: {
    fields: {
      fill:        { type: 'color', optional: true },
      stroke:      { type: 'color', optional: true },
      strokeWidth: { type: 'length', default: 0, min: 0, max: 200 },
      radius:      { type: 'length', default: 0, min: 0, max: 1000 }
    }
  },

  /** Elips / daire. */
  ellipse: {
    fields: {
      fill:        { type: 'color', optional: true },
      stroke:      { type: 'color', optional: true },
      strokeWidth: { type: 'length', default: 0, min: 0, max: 200 }
    }
  },

  /**
   * Çizgi. Çerçevenin köşegeni üzerinde tanımlıdır: `(x,y)` → `(x+w, y+h)`.
   * Ayrı `from`/`to` noktaları tutmak, seçim kutusu ve dönüşüm hesabını
   * bütün diğer düğümlerden ayırırdı.
   */
  line: {
    fields: {
      stroke:      { type: 'color', default: '#111111' },
      strokeWidth: { type: 'length', default: 1, min: 0.1, max: 200 },
      dash:        { type: 'enum', values: ['solid', 'dashed', 'dotted'], default: 'solid' }
    }
  },

  /** Görsel — varlık kimliğiyle. */
  image: {
    fields: {
      assetId: { type: 'assetRef', required: true },
      fit:     { type: 'enum', values: ['contain', 'cover', 'fill'], default: 'contain' }
      // `alt` ORTAK alanlardadır: her düğüm tipi için anlamlıdır ve
      // PDF/UA onu Figure'larda ZORUNLU kılar.
    }
  },

  /** Karekod — içeriği sahnede durur, görüntü derleme sırasında üretilir. */
  qr: {
    fields: {
      payload: { type: 'string', default: '', maxLength: 2953 },
      ecc:     { type: 'enum', values: ['L', 'M', 'Q', 'H'], default: 'M' },
      quiet:   { type: 'number', default: 2, min: 0, max: 16 },
      dark:    { type: 'color', default: '#000000' },
      light:   { type: 'color', default: '#ffffff' }
    }
  },

  /**
   * İmza yuvası — PAdES imza alanının GEOMETRİSİ.
   *
   * Sahne, imzayı ATMAZ; nereye atılacağını söyler. İmzalama, PDF üretildikten
   * SONRA @fitfak/pades ile yapılır. İkisini karıştırmak, imza motorunu
   * editöre bağımlı hâle getirirdi.
   */
  signature: {
    fields: {
      fieldName: { type: 'string', default: '', maxLength: 127 },
      signer:    { type: 'string', default: '', maxLength: 256 },
      /**
       * İmzalayanın UNVANI ("Genel Müdür"). PDF/UA yapı rolü olan ortak
       * `role` alanıyla KARIŞTIRILMAMALIDIR; adı bu yüzden ayrıdır.
       */
      signerTitle: { type: 'string', default: '', maxLength: 256 },
      label:     { type: 'string', default: 'İmza', maxLength: 256 },
      showFrame: { type: 'boolean', default: true }
    }
  },

  /**
   * Grup — çocukların koordinatları GRUBUN sol üstüne GÖREDİR.
   * Böylece grubu taşımak tek bir çerçeve güncellemesidir; çocuklara
   * dokunulmaz.
   */
  group: {
    container: true,
    fields: {}
  }
};

/**
 * Erişilebilirlik (PDF/UA) yapı rolleri.
 *
 * Serbest yerleşimde "başlık" ile "gövde metni" arasındaki fark GÖRSELDİR:
 * biri büyük punto, diğeri küçük. Ekran okuyucu punto göremez; rolü görür.
 * Bu yüzden rol MODELDE taşınır ve kullanıcı tarafından verilir.
 *
 * `artifact` içerik DEĞİLDİR: arka plan, süs çizgisi, çerçeve. Etiketlenmez
 * ama "etiketsiz içerik" de sayılmaz — `/Artifact` olarak işaretlenir.
 */
const STRUCT_ROLES = [
  'auto', 'artifact',
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'Figure', 'Caption', 'Formula', 'Note', 'Quote', 'Code', 'Span'
];

/**
 * `role: 'auto'` seçildiğinde tipe göre uygulanacak rol.
 *
 * Şemada durur çünkü hem derleyici hem editör aynı cevabı vermek
 * zorundadır: panelde "kendiliğinden: P" yazıp PDF'te `Figure` üretmek,
 * kullanıcının göremediği bir yalandır.
 */
const DEFAULT_ROLE = {
  text: 'P',
  image: 'Figure',
  qr: 'Figure',
  rect: 'artifact',
  ellipse: 'artifact',
  line: 'artifact',
  signature: 'artifact',
  group: 'artifact'
};

/** Her düğümde bulunan alanlar. */
const COMMON_FIELDS = {
  id:       { type: 'id', required: true },
  type:     { type: 'nodeType', required: true },
  name:     { type: 'string', default: '', maxLength: 256 },
  frame:    { type: 'frame', required: true },
  rotation: { type: 'number', default: 0, min: -360, max: 360 },
  opacity:  { type: 'number', default: 1, min: 0, max: 1 },
  locked:   { type: 'boolean', default: false },
  hidden:   { type: 'boolean', default: false },

  /** PDF/UA yapı rolü. `auto` tipe göre seçilir. */
  role:     { type: 'enum', values: STRUCT_ROLES, default: 'auto' },
  /** Görsel olmayan okuyucular için alternatif metin. */
  alt:      { type: 'string', default: '', maxLength: 2000 },
  /** Bu düğümün dili belgeden farklıysa (örn. tek satırlık İngilizce alıntı). */
  lang:     { type: 'string', default: '', maxLength: 32 }
};

/**
 * Yapısal sınırlar.
 *
 * Sahne dosyası GÜVENİLMEZ girdidir: kullanıcıdan, ağdan ya da içe
 * aktarmadan gelir. Sınırsız derinlik özyinelemeli doğrulayıcıyı yığın
 * taşmasına, sınırsız düğüm sayısı belleğe götürür.
 */
const LIMITS = {
  maxPages: 500,
  maxNodesPerPage: 5000,
  maxNodesTotal: 20_000,
  maxDepth: 32,
  maxAssets: 512,
  maxRuns: 2000,
  maxNameLength: 256
};

module.exports = {
  SCHEMA_VERSION, PAGE_SIZES, NODE_TYPES, COMMON_FIELDS, LIMITS,
  STRUCT_ROLES, DEFAULT_ROLE
};
