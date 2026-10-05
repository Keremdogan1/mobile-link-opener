# Mobile Link Opener (Obsidian Eklentisi)

Obsidian'ın mobil (özellikle iPad ve iPhone) sürümünde notlarınızdaki web linklerini konforlu bir şekilde açmanızı sağlayan hafif ve harici bağımlılığı olmayan bir eklentidir.

Notlarınızdaki bir web linkine (`http://` veya `https://`) tıkladığınızda:
1. **Site gömülmeye izin veriyorsa:** Obsidian içinde yeni bir sekmede (`iframe` tabanlı dahili tarayıcı) açılır.
2. **Site gömülmeyi engelliyorsa (`X-Frame-Options` veya CSP):** Doğrudan iOS Capacitor Browser ile native tam ekran / popover görünümünde açılır.

---

## Özellikler

- **Akıllı Link Yakalama:** Notlarınızdaki dış bağlantıları otomatik olarak yakalar.
- **Dahili Sekme Görünümü:** Adres/arama çubuğu ve yenileme butonu içeren hafif dahili web sekmesi.
- **Native Fallback (Dahili Tarayıcı):** Google, YouTube gibi iframe içinde açılmayı engelleyen siteleri doğrudan iOS'un native Capacitor tarayıcısında açar.
- **"Sayfa Boş mu Görünüyor?" Yardımcı Bandı:** Header kontrolünü aşsa bile JS ile gömülmeyi engelleyen sitelerde tek tıkla native tarayıcıya geçiş ve siteyi her zaman native açılacaklar listesine ekleme kolaylığı.
- **Özelleştirilebilir Arama Motoru:** Adres çubuğuna bir arama terimi yazıldığında DuckDuckGo, Bing, Brave veya belirleyeceğiniz özel bir arama URL'si kullanılır.
- **Son Açılan Siteler Geçmişi:** Son gezilen web bağlantılarını hatırlar, komut paletinden hızlı erişim sağlar.
- **Hafif ve Güvenli:** Tek dosya (`main.js`), sıfır npm bağımlılığı, sadece Obsidian ve Web standart API'leri.

---

## Nasıl Çalışır?

```
Linke Tıklandı
      │
      ▼
Bu site her zaman native listesinde mi?
   ├── Evet ─────────────► Native Tarayıcıda Aç
   └── Hayır
          │
          ▼
   Header Kontrolü (HEAD / GET requestUrl)
   [X-Frame-Options veya CSP frame-ancestors var mı?]
          ├── İzin vermiyor ──► Native Tarayıcıda Aç
          └── İzin veriyor
                  │
                  ▼
          Obsidian Sekmesinde (iframe) Aç
                  │
                  ▼ (6 saniye sonra)
          "Sayfa boş mu görünüyor?" yardımcı bandı görünür
```

---

## Bilinen Sınırlar

Tarayıcı güvenlik standartları (Same-Origin Policy) ve iOS WebKit mimarisi gereği şunlar yapılamaz:
- **Cross-origin iframe navigasyonu:** Farklı alan adlarındaki sitelerin içindeki ileri/geri geçmişi doğrudan kontrol edilemez.
- **Sayfa içi link takibi:** iframe içinde kullanıcının tıkladığı yeni linkler cross-origin güvenlik duvarı nedeniyle Obsidian tarafından doğrudan okunamaz.
- **Gömülmeyi zorla aşma:** `X-Frame-Options: DENY/SAMEORIGIN` gibi sunucu başlıkları güvenlik gereği atlatılmaz; eklenti bu siteleri güvenle native tarayıcıda açar.

---

## Kurulum

### Yöntem 1: BRAT ile Kurulum (Önerilen)

Obsidian'da [BRAT](https://github.com/TfTHacker/obsidian42-brat) eklentisi yüklüyse:
1. Obsidian Ayarları -> **BRAT** sekmesine gidin.
2. **Add Beta plugin** düğmesine tıklayın.
3. Repo adresini girin: `https://github.com/Keremdogan1/mobile-link-opener`
4. **Add Plugin**'e basın. BRAT son sürümü indirip kuracaktır.
5. **Topluluk Eklentileri (Community Plugins)** listesinden eklentiyi etkinleştirin.

### Yöntem 2: Manuel Kurulum (iPad / iOS)

1. Bu depodaki son [Release](https://github.com/Keremdogan1/mobile-link-opener/releases) sayfasından `main.js`, `manifest.json` ve `styles.css` dosyalarını indirin.
2. iPad'inizde **Dosyalar (Files)** uygulamasını açın.
3. Kasanızın (Vault) klasörüne gidin: `<KasaAdı>/.obsidian/plugins/`
4. Bu klasör altında `mobile-link-opener` adında yeni bir klasör oluşturun.
5. İndirdiğiniz 3 dosyayı bu klasöre kopyalayın.
6. Obsidian'ı açıp Ayarlar -> **Topluluk Eklentileri** altından eklentiyi etkinleştirin.

---

## Ayarlar

- **Arama Motoru:** Adres çubuğuna arama terimi girildiğinde kullanılacak motor (DuckDuckGo, Bing, Brave, Özel URL).
- **Her Zaman Native Açılacak Siteler:** Doğrudan iOS native tarayıcısında açılmasını istediğiniz sitelerin listesi (her satıra bir alan adı, ör: `google.com`).
- **Native Ekran Stili:** Native tarayıcının görünüm biçimi (`fullscreen` veya `popover`).
- **Linkleri Yakala:** Notlardaki web linklerinin eklenti tarafından yakalanıp yakalanmayacağını belirleyen açma/kapama ayarı.
