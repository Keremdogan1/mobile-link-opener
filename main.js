const { Plugin, ItemView, Notice, requestUrl, setIcon, Setting, PluginSettingTab, SuggestModal, Platform } = require("obsidian");

const VIEW_TYPE = "mobile-link-browser";

// Varsayılan eklenti ayarları
const DEFAULT_SETTINGS = {
    searchEngine: "duckduckgo", // "duckduckgo", "bing", "brave", "custom"
    customSearchUrl: "https://duckduckgo.com/?q={query}",
    alwaysNativeDomains: "google.com\nyoutube.com\nyoutu.be\nmega.nz",
    nativePresentationStyle: "fullscreen", // "fullscreen", "system", "popover"
    openLocation: "tab", // "tab" (Yeni Sekme - Tam Ekran), "split" (Yan yana bölerek)
    interceptLinks: true, // Linkleri yakalama açık/kapalı
    recentHistory: [] // Son açılan 50 site ({ url, time, title })
};

// Arama URL'si oluşturur (Google gömülemediği için seçenekler arasında yer almaz)
function getSearchUrl(query, settings) {
    const encoded = encodeURIComponent(query);
    const engine = (settings && settings.searchEngine) || "duckduckgo";
    switch (engine) {
        case "bing":
            return "https://www.bing.com/search?q=" + encoded;
        case "brave":
            return "https://search.brave.com/search?q=" + encoded;
        case "custom": {
            const template = (settings && settings.customSearchUrl) || "https://duckduckgo.com/?q={query}";
            if (template.includes("{query}")) {
                return template.replace("{query}", encoded);
            }
            return template + encoded;
        }
        case "duckduckgo":
        default:
            return "https://duckduckgo.com/?q=" + encoded;
    }
}

// Yazılan metni tam bir URL'ye çevirir: adres ise https:// ekler, değilse seçili arama motorunu kullanır
function normalizeInput(text, settings) {
    const t = (text || "").trim();
    if (!t) return null;
    if (/^https?:\/\//i.test(t)) return t;
    if (!/\s/.test(t) && /^[^\s]+\.[a-z]{2,}(\/.*)?$/i.test(t)) return "https://" + t;
    return getSearchUrl(t, settings);
}

// Alan adının listedeki herhangi bir alan adıyla eşleşip eşleşmediğini kontrol eder
function hostMatches(hostname, domainsList) {
    if (!hostname || !Array.isArray(domainsList)) return false;
    return domainsList.some((d) => hostname === d || hostname.endsWith("." + d));
}

// Alan adının kullanıcının girdiği "her zaman native açılacaklar" listesinde olup olmadığını kontrol eder
function isAlwaysNativeHost(hostname, settings) {
    if (!hostname) return false;
    const raw = (settings && settings.alwaysNativeDomains) || "";
    const list = raw
        .split("\n")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
    return hostMatches(hostname.toLowerCase(), list);
}

// Platformun mobil (iOS iPad/iPhone veya Android tablet/telefon) olup olmadığını kontrol eder
function isNativePlatform() {
    if (Platform && Platform.isMobile) return true;
    const cap = window.Capacitor;
    return !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
}

// Cihazın küçük ekranlı bir telefon (iPhone veya Android telefon) olup olmadığını kontrol eder
function isPhoneDevice() {
    return !!(Platform && Platform.isPhone);
}

// Origin bazında gömülebilirlik önbelleği (origin -> { canEmbed: boolean, expiresAt: number })
const embedCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 dakika

// Belirli bir süre (varsayılan 6 saniye) sonra zaman aşımı fırlatan yardımcı fonksiyon
function withTimeout(promise, ms = 6000) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("İstek zaman aşımına uğradı (6s)")), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        clearTimeout(timer);
    });
}

/*
 * Site, iframe içinde gösterilmeye izin veriyor mu?
 * Sitenin cevap başlıklarına (headers) bakıyoruz:
 *  - X-Frame-Options varsa        -> gömülemez
 *  - CSP "frame-ancestors" varsa  -> gömülemez (güvenli tarafta kalıyoruz)
 * Kontrol edilemezse veya zaman aşımına (6s) uğrarsa "gömülemez" sayıp native ekrana düşeriz.
 * Origin bazında 10 dakika önbellek tutulur, tekrar eden tıklamalarda ağ isteği atılmaz.
 */
async function canEmbed(url) {
    let origin = "";
    try {
        origin = new URL(url).origin;
    } catch (e) {
        return false;
    }

    // 1) Bellek önbelleği kontrolü
    const cached = embedCache.get(origin);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
        return cached.canEmbed;
    }

    const lowerKeys = (headers) => {
        const out = {};
        for (const k of Object.keys(headers || {})) out[k.toLowerCase()] = headers[k];
        return out;
    };

    let result = false;
    try {
        let res;
        try {
            // Önce hızlı yanıt için HEAD dene (6 saniye zaman aşımı ile)
            res = await withTimeout(requestUrl({ url, method: "HEAD", throw: false }), 6000);
            if (res.status >= 400) throw new Error("HEAD başarısız");
        } catch (e) {
            // HEAD desteklenmiyorsa veya hata verirse GET dene (6 saniye zaman aşımı ile)
            res = await withTimeout(requestUrl({ url, method: "GET", throw: false }), 6000);
        }

        const h = lowerKeys(res.headers);
        if (h["x-frame-options"]) {
            result = false;
        } else if (/frame-ancestors/i.test(h["content-security-policy"] || "")) {
            result = false;
        } else {
            result = true;
        }
    } catch (e) {
        console.warn("[Mobile Link Opener] Header kontrolü başarısız veya zaman aşımı:", e);
        // Zaman aşımı veya ağ hatası durumunda güvenli tarafta kalıp native'e düş
        result = false;
    }

    // Sonucu 10 dakikalığına önbelleğe kaydet
    embedCache.set(origin, {
        canEmbed: result,
        expiresAt: now + CACHE_TTL_MS
    });

    return result;
}

// URL bazında sayfa başlıkları önbelleği (url -> title)
const titleCache = new Map();

// Basit HTML entity çözümleyici
function decodeHtmlEntities(str) {
    if (!str) return "";
    return str
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code))
        .trim();
}

// Sayfa başlığını arka planda çeker (HTML'in ilk ~50 KB'ında regex ile arar)
async function fetchPageTitle(url) {
    if (!url) return null;

    // Önbellekte varsa doğrudan dön
    if (titleCache.has(url)) {
        return titleCache.get(url);
    }

    try {
        // 5 saniye zaman aşımı ile GET isteği at
        const res = await withTimeout(requestUrl({ url, method: "GET", throw: false }), 5000);
        if (res.status >= 200 && res.status < 400 && res.text) {
            // İlk 50 KB'lık kısmı tara
            const chunk = res.text.slice(0, 50000);
            const match = chunk.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            if (match && match[1]) {
                const title = decodeHtmlEntities(match[1]).replace(/\s+/g, " ");
                if (title) {
                    titleCache.set(url, title);
                    return title;
                }
            }
        }
    } catch (e) {
        // Hata durumunda sessizce geçilir, sekmede hostname gösterilmeye devam eder
    }

    return null;
}

class BrowserView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.url = "";
        this.pageTitle = "";
        this.renderedUrl = null;
        this.hostEl = null;
        this.urlInput = null;
        this.bannerEl = null;
        this.bannerTimer = null;
    }

    getViewType() {
        return VIEW_TYPE;
    }

    getIcon() {
        return "globe";
    }

    getDisplayText() {
        if (this.pageTitle) return this.pageTitle;
        try {
            return this.url ? new URL(this.url).hostname : "Web";
        } catch (e) {
            return "Web";
        }
    }

    // Obsidian sekmeyi yeniden açarken url'yi buradan geri yükler
    getState() {
        return { url: this.url };
    }

    async setState(state, result) {
        try {
            this.url = (state && state.url) || "";
            this.render();
            try {
                this.leaf.updateHeader();
            } catch (e) {}
            await super.setState(state, result);
        } catch (err) {
            console.error("[Mobile Link Opener] setState hatası:", err);
        }
    }

    clearBannerTimer() {
        if (this.bannerTimer) {
            clearTimeout(this.bannerTimer);
            this.bannerTimer = null;
        }
    }

    hideBanner() {
        this.clearBannerTimer();
        if (this.bannerEl) {
            this.bannerEl.remove();
            this.bannerEl = null;
        }
    }

    // İframe yüklendikten 6 saniye sonra görünen yardımcı bant
    showBanner() {
        if (!this.contentEl || !this.url || this.bannerEl) return;

        let domain = "";
        try {
            domain = new URL(this.url).hostname;
        } catch (e) {
            domain = "";
        }

        const banner = this.contentEl.createDiv({ cls: "mobile-link-browser-banner" });
        this.bannerEl = banner;

        const textEl = banner.createDiv({ cls: "mobile-link-banner-text" });
        textEl.setText("Sayfa boş mu görünüyor?");

        const actionsEl = banner.createDiv({ cls: "mobile-link-banner-actions" });

        // Düğme 1: Native'de aç
        const openNativeBtn = actionsEl.createEl("button", {
            cls: "mobile-link-banner-btn",
            text: "Native'de aç"
        });
        openNativeBtn.addEventListener("click", () => {
            this.plugin.openNative(this.url);
        });

        // Düğme 2: Bu siteyi hep native aç
        const alwaysNativeBtn = actionsEl.createEl("button", {
            cls: "mobile-link-banner-btn mod-cta",
            text: "Bu siteyi hep native aç"
        });
        alwaysNativeBtn.addEventListener("click", async () => {
            if (domain) {
                await this.plugin.addAlwaysNativeDomain(domain);
                new Notice(`${domain} her zaman native açılacak sitelere eklendi.`);
            }
            this.hideBanner();
            this.plugin.openNative(this.url);
        });

        // Kapat düğmesi (X)
        const closeBtn = actionsEl.createEl("button", {
            cls: "mobile-link-banner-close clickable-icon",
            attr: { "aria-label": "Kapat" }
        });
        setIcon(closeBtn, "x");
        closeBtn.addEventListener("click", () => {
            this.hideBanner();
        });
    }

    async onOpen() {
        const root = this.contentEl;
        root.empty();
        root.addClass("mobile-link-browser");

        // Üst çubuk: yenile, native aç, adres
        const bar = root.createDiv({ cls: "mobile-link-browser-bar" });

        const reloadBtn = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Yenile" } });
        setIcon(reloadBtn, "refresh-cw");
        reloadBtn.addEventListener("click", () => {
            this.renderedUrl = null;
            this.pageTitle = "";
            this.hideBanner();
            this.render();
        });

        const nativeBtn = bar.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": "Native tarayıcıda aç" }
        });
        setIcon(nativeBtn, "external-link");
        nativeBtn.addEventListener("click", () => {
            if (this.url) this.plugin.openNative(this.url);
        });

        // Ekranı ikiye bölerek (Split) açma butonu
        const splitBtn = bar.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": "Yan yana bölerek aç (Split)" }
        });
        setIcon(splitBtn, "columns");
        splitBtn.addEventListener("click", () => {
            if (this.url) this.plugin.openInTab(this.url, "split");
        });

        // Adres / arama çubuğu
        this.urlInput = bar.createEl("input", {
            cls: "mobile-link-browser-url",
            attr: {
                type: "text",
                placeholder: "Ara veya adres yaz",
                enterkeyhint: "go",
                autocapitalize: "off",
                autocorrect: "off",
                spellcheck: "false"
            }
        });
        this.urlInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                const text = this.urlInput.value;
                this.urlInput.blur();
                this.plugin.navigate(this, text);
            }
        });

        this.hostEl = root.createDiv({ cls: "mobile-link-browser-host" });

        this.render();
    }

    // Sayfa başlığını arka planda çeker ve sekme başlığını günceller
    async loadTitle(url) {
        if (!url) return;
        try {
            const title = await fetchPageTitle(url);
            if (title && this.url === url) {
                this.pageTitle = title;
                try {
                    this.leaf.updateHeader();
                } catch (e) {}
                await this.plugin.updateHistoryTitle(url, title);
            }
        } catch (e) {
            // Hata olursa sessizce hostname'e dön
        }
    }

    render() {
        if (!this.hostEl) return; // onOpen henüz çalışmadı, o çağıracak

        if (this.urlInput && document.activeElement !== this.urlInput) {
            this.urlInput.value = this.url || "";
        }

        // Aynı URL zaten yüklendiyse tekrar yükleme
        if (!this.url || this.renderedUrl === this.url) return;

        // Yeni sayfa yükleniyor, eski bandı ve zamanlayıcıyı temizle
        this.hideBanner();

        this.hostEl.empty();
        this.hostEl.createEl("iframe", {
            cls: "mobile-link-browser-frame",
            attr: {
                src: this.url,
                allow: "fullscreen; autoplay; clipboard-write",
                referrerpolicy: "no-referrer-when-downgrade"
            }
        });
        this.renderedUrl = this.url;

        // Sayfa başlığını arka planda yükle
        this.pageTitle = titleCache.get(this.url) || "";
        this.loadTitle(this.url);

        // İframe yüklendikten 6 saniye sonra yardımcı bandı göster
        this.clearBannerTimer();
        this.bannerTimer = setTimeout(() => {
            this.showBanner();
        }, 6000);
    }

    async onClose() {
        this.hideBanner();
        this.hostEl = null;
        this.urlInput = null;
        this.contentEl.empty();
    }
}

// Ayarlar Sekmesi (Obsidian Ayarlar menüsü altında görünür)
class MobileLinkOpenerSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h2", { text: "Mobile Link Opener Ayarları" });

        // 1) Link yakalama açma/kapama düğmesi
        new Setting(containerEl)
            .setName("Linkleri bu eklenti yakalasın")
            .setDesc("Açık olduğunda notlardaki harici web bağlantılarına tıklandığında bu eklenti devreye girer.")
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.settings.interceptLinks)
                    .onChange(async (value) => {
                        this.plugin.settings.interceptLinks = value;
                        await this.plugin.saveSettings();
                    });
            });

        // 2) Arama motoru seçimi
        new Setting(containerEl)
            .setName("Arama motoru")
            .setDesc("Adres çubuğuna adres yerine arama terimi girildiğinde kullanılacak motor (Google gömülemediği için listede yer almaz).")
            .addDropdown((dropdown) => {
                dropdown
                    .addOption("duckduckgo", "DuckDuckGo (Varsayılan)")
                    .addOption("bing", "Bing")
                    .addOption("brave", "Brave Search")
                    .addOption("custom", "Özel Arama Şablonu")
                    .setValue(this.plugin.settings.searchEngine)
                    .onChange(async (value) => {
                        this.plugin.settings.searchEngine = value;
                        await this.plugin.saveSettings();
                        this.display(); // Özel arama kutusunu göstermek/gizlemek için sekme görünümünü tazele
                    });
            });

        // 2b) Özel arama motoru URL şablonu (Sadece 'custom' seçildiğinde görünür)
        if (this.plugin.settings.searchEngine === "custom") {
            new Setting(containerEl)
                .setName("Özel arama motoru URL şablonu")
                .setDesc("Arama sorgusunun ekleneceği yere {query} yazın (Ör: https://duckduckgo.com/?q={query})")
                .addText((text) => {
                    text
                        .setPlaceholder("https://duckduckgo.com/?q={query}")
                        .setValue(this.plugin.settings.customSearchUrl || "")
                        .onChange(async (value) => {
                            this.plugin.settings.customSearchUrl = value.trim();
                            await this.plugin.saveSettings();
                        });
                });
        }

        // 3) Her zaman native açılacak siteler listesi
        new Setting(containerEl)
            .setName("Her zaman native açılacak siteler")
            .setDesc("Bu siteler iframe yerine doğrudan iOS native tarayıcısında açılır. Her satıra bir alan adı yazın (Ör: google.com).")
            .addTextArea((textarea) => {
                textarea
                    .setPlaceholder("google.com\nyoutube.com\nyoutu.be\nmega.nz")
                    .setValue(this.plugin.settings.alwaysNativeDomains)
                    .onChange(async (value) => {
                        this.plugin.settings.alwaysNativeDomains = value;
                        await this.plugin.saveSettings();
                    });
                textarea.inputEl.rows = 5;
                textarea.inputEl.cols = 28;
            });

        // 4) Native ekran stili (fullscreen, system, popover)
        new Setting(containerEl)
            .setName("Native ekran stili")
            .setDesc("Gömülemeyen siteler native açıldığında ekran görünümü. 'Tam Ekran Dahili Tarayıcı' ekranın ortasında sıkışmadan tam ekran açılır. 'Sistem Safari Uygulaması' ise iPadOS Slide-Over veya Split-View ile serbestçe taşınabilir ve boyutlandırılabilir.")
            .addDropdown((dropdown) => {
                dropdown
                    .addOption("fullscreen", "Tam Ekran Dahili Tarayıcı (Önerilen)")
                    .addOption("system", "Sistem Safari Uygulaması (iPad Slide-Over / Split-View için)")
                    .addOption("popover", "Açılır Pencere (Popover - Ortada sabit)")
                    .setValue(this.plugin.settings.nativePresentationStyle || "fullscreen")
                    .onChange(async (value) => {
                        this.plugin.settings.nativePresentationStyle = value;
                        await this.plugin.saveSettings();
                    });
            });

        // 5) Web sekmesi açılış konumu (Sekme, Split)
        new Setting(containerEl)
            .setName("Web sekmesi açılış konumu")
            .setDesc("Gömülebilir web sayfalarının Obsidian içinde nerede açılacağını belirler. Yeni sekme açıldıktan sonra üst çubuktaki 'Split' simgesiyle de istediğiniz an ekranı ikiye bölebilirsiniz.")
            .addDropdown((dropdown) => {
                dropdown
                    .addOption("tab", "Yeni Sekme Olarak (Varsayılan - Tam Ekran)")
                    .addOption("split", "Yan Yana Bölerek (Split View - Parmağınızla Boyutlandırılabilir)")
                    .setValue(this.plugin.settings.openLocation || "tab")
                    .onChange(async (value) => {
                        this.plugin.settings.openLocation = value;
                        await this.plugin.saveSettings();
                    });
            });
    }
}

// Geçmiş için göreli veya okunabilir tarih/zaman formatı
function formatTimeAgo(timestamp) {
    if (!timestamp) return "";
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / (60 * 1000));
    const hours = Math.floor(diff / (60 * 60 * 1000));
    const days = Math.floor(diff / (24 * 60 * 60 * 1000));

    if (minutes < 1) return "Az önce";
    if (minutes < 60) return `${minutes} dk önce`;
    if (hours < 24) return `${hours} saat önce`;
    if (days < 7) return `${days} gün önce`;

    const d = new Date(timestamp);
    return `${d.toLocaleDateString("tr-TR")} ${d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}`;
}

// Son açılan siteler arama ve seçim modalı (SuggestModal)
class RecentHistoryModal extends SuggestModal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.setPlaceholder("Son açılan sitelerde ara...");
    }

    getSuggestions(query) {
        const history = this.plugin.settings.recentHistory || [];
        const q = (query || "").trim().toLowerCase();
        if (!q) return history;
        return history.filter((item) => {
            const matchUrl = item.url && item.url.toLowerCase().includes(q);
            const matchTitle = item.title && item.title.toLowerCase().includes(q);
            return matchUrl || matchTitle;
        });
    }

    renderSuggestion(item, el) {
        el.addClass("mobile-link-history-item");
        const titleEl = el.createDiv({ cls: "mobile-link-history-title" });
        titleEl.setText(item.title || item.url);

        const metaEl = el.createDiv({ cls: "mobile-link-history-meta" });
        let host = "";
        try {
            host = new URL(item.url).hostname;
        } catch (e) {
            host = item.url;
        }
        metaEl.createSpan({ cls: "mobile-link-history-host", text: host });
        if (item.time) {
            metaEl.createSpan({ cls: "mobile-link-history-time", text: " • " + formatTimeAgo(item.time) });
        }
    }

    async onChooseSuggestion(item, evt) {
        if (item && item.url) {
            await this.plugin.openUrl(item.url);
        }
    }
}

module.exports = class MobileLinkOpener extends Plugin {
    async onload() {
        // Ayarları yükle
        await this.loadSettings();
        this.addSettingTab(new MobileLinkOpenerSettingTab(this.app, this));

        this.registerView(VIEW_TYPE, (leaf) => new BrowserView(leaf, this));

        // Link yakalama sistemini kur (hem DOM Click hem window.open hook'u)
        this.setupLinkInterception();

        this.addCommand({
            id: "open-recent-history",
            name: "Son açılan siteler",
            callback: () => {
                new RecentHistoryModal(this.app, this).open();
            }
        });

        this.addCommand({
            id: "new-web-tab",
            name: "Yeni web sekmesi aç",
            callback: () => this.openInTab("", "tab")
        });

        this.addCommand({
            id: "new-web-split",
            name: "Yeni web sekmesi aç (Yan yana bölerek - Split)",
            callback: () => this.openInTab("", "split")
        });

        this.addCommand({
            id: "test-native-browser",
            name: "Test: native tarayıcı (Google)",
            callback: () => this.openNative("https://www.google.com")
        });

        this.addCommand({
            id: "test-tab-browser",
            name: "Test: Obsidian sekmesinde aç (example.com)",
            callback: () => this.openInTab("https://example.com")
        });
    }

    async loadSettings() {
        try {
            this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        } catch (e) {
            console.error("[Mobile Link Opener] Ayarlar yüklenirken hata:", e);
            this.settings = Object.assign({}, DEFAULT_SETTINGS);
        }
    }

    async saveSettings() {
        try {
            await this.saveData(this.settings);
        } catch (e) {
            console.error("[Mobile Link Opener] Ayarlar kaydedilirken hata:", e);
            new Notice("Ayarlar kaydedilirken bir hata oluştu.");
        }
    }

    // "Bu siteyi hep native aç" tıklandığında domaini ayarlara ekler ve kaydeder
    async addAlwaysNativeDomain(domain) {
        if (!domain) return;
        try {
            const cleanDomain = domain.trim().toLowerCase();
            const currentList = (this.settings.alwaysNativeDomains || "")
                .split("\n")
                .map((s) => s.trim().toLowerCase())
                .filter((s) => s.length > 0);

            if (!currentList.includes(cleanDomain)) {
                currentList.push(cleanDomain);
                this.settings.alwaysNativeDomains = currentList.join("\n");
                await this.saveSettings();
            }
        } catch (e) {
            console.error("[Mobile Link Opener] Domain listeye eklenemedi:", e);
        }
    }

    // Açılan URL'yi son 50 geçmiş kaydına ekler (tekrarları birleştirir)
    async addToHistory(url, title = "") {
        if (!url || typeof url !== "string") return;
        try {
            if (!this.settings.recentHistory) {
                this.settings.recentHistory = [];
            }

            const cleanUrl = url.trim();
            // Tekrarları birleştir: aynı URL varsa listeden çıkar
            this.settings.recentHistory = this.settings.recentHistory.filter(
                (item) => item && item.url !== cleanUrl
            );

            // En başa yeni tarihle ekle
            this.settings.recentHistory.unshift({
                url: cleanUrl,
                time: Date.now(),
                title: title || ""
            });

            // En fazla 50 kayıt sakla
            if (this.settings.recentHistory.length > 50) {
                this.settings.recentHistory = this.settings.recentHistory.slice(0, 50);
            }

            await this.saveSettings();
        } catch (e) {
            console.error("[Mobile Link Opener] Geçmişe eklenirken hata:", e);
        }
    }

    // Geçmişteki URL kaydının başlığını günceller
    async updateHistoryTitle(url, title) {
        if (!url || !title || !this.settings?.recentHistory) return;
        try {
            let updated = false;
            for (const item of this.settings.recentHistory) {
                if (item && item.url === url && !item.title) {
                    item.title = title;
                    updated = true;
                }
            }
            if (updated) {
                await this.saveSettings();
            }
        } catch (e) {
            console.error("[Mobile Link Opener] Geçmiş başlığı güncellenirken hata:", e);
        }
    }

    // Hem DOM click hem de window.open seviyesinde harici link yakalama
    setupLinkInterception() {
        // 1) DOM seviyesinde tıklamayı yakala (capture: true)
        this.registerDomEvent(document, "click", (e) => this.handleLinkClick(e), true);

        // 2) window.open Hook'u
        // Obsidian mobilde (iPad/iPhone) Live Preview veya dahili bileşenler harici linklere dokunulduğunda
        // doğrudan window.open() çağırarak Safari'yi açar. Bu hook ile Safari'ye gitmesini engelleyip
        // eklenti içinden açılmasını sağlıyoruz.
        const originalOpen = window.open;
        this.originalWindowOpen = originalOpen;
        const self = this;

        window.open = function (url, target, features) {
            // Eklenti link yakalama kapalıysa veya native sistem tarayıcısı açılmak isteniyorsa orijinal davranışı koru
            if (!self.settings?.interceptLinks || self.bypassIntercept) {
                return originalOpen.call(window, url, target, features);
            }

            // Gelen istek bir http/https web linki ise
            if (typeof url === "string" && /^https?:\/\//i.test(url.trim())) {
                // Safari'nin açılmasını durdur, Obsidian içinde aç
                self.openUrl(url.trim());
                return null;
            }

            return originalOpen.call(window, url, target, features);
        };
    }

    async handleLinkClick(event) {
        // Eğer kullanıcı ayarlarından link yakalama kapatılmışsa dokunma
        if (!this.settings?.interceptLinks) return;

        const target = event.target;
        if (!target) return;

        // Kendi web tarayıcı arayüzümüz içindeki tıklamalara dokunma
        if (target.closest && target.closest(".mobile-link-browser")) return;

        // Editör veya Canlı Önizleme (Live Preview) içinde link metnini DÜZENLERKEN
        // araya girme, kullanıcı rahatça imleç koyabilsin ve düzenleyebilsin.
        // Kullanıcı linki açmayı amaçladığında Obsidian kendisi window.open() çağırır ve
        // bizim window.open kancamız Safari'ye gitmeden yakalar.
        if (target.closest && target.closest(".cm-content, .cm-editor")) {
            return;
        }

        // Okuma görünümünde (Reading view) A etiketi tıklandığında:
        let href = null;
        const anchor = (target.closest ? target.closest("a") : null) ||
                       (event.composedPath ? event.composedPath().find((el) => el?.tagName === "A") : null);
        if (anchor) {
            href = anchor.getAttribute("href") || anchor.href;
        }

        if (!href) return;

        let url;
        try {
            url = new URL(href.trim(), window.location.href);
        } catch (e) {
            if (/^https?:\/\//i.test(href.trim())) {
                url = { href: href.trim(), protocol: href.trim().split(":")[0] + ":" };
            } else {
                return;
            }
        }

        if (url.protocol !== "http:" && url.protocol !== "https:") return;

        // Sadece Obsidian not görünümü içindeki linklerle ilgilen
        const isInsideNote = !!(target.closest && target.closest(
            ".markdown-preview-view, .markdown-rendered, .markdown-reading-view, .view-content, .workspace-leaf-content"
        ));
        if (!isInsideNote) return;

        // Bunlar async işlemden ÖNCE çağrılmalı (Safari'nin açılmasını engeller)
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        try {
            await this.openUrl(url.href);
        } catch (e) {
            console.error("[Mobile Link Opener] Link açma hatası:", e);
            new Notice("Bağlantı açılırken bir hata oluştu.");
        }
    }

    async openUrl(url) {
        try {
            if (!url) return;
            // Açılan URL'yi son gezilen siteler geçmişine ekle
            await this.addToHistory(url);

            const hostname = new URL(url).hostname.toLowerCase();

            // 1) Bilinen / kullanıcı tarafından belirlenen siteler: direkt native (sadece telefonda/iPad'de)
            if (isNativePlatform() && isAlwaysNativeHost(hostname, this.settings)) {
                return await this.openNative(url);
            }

            // 2) Site gömülmeye izin veriyorsa Obsidian sekmesinde aç
            let embeddable = false;
            try {
                embeddable = await canEmbed(url);
            } catch (e) {
                embeddable = false;
            }

            if (embeddable) {
                return await this.openInTab(url);
            }

            // 3) İzin vermiyorsa native ekrana düş
            new Notice("Bu site Obsidian sekmesinde gösterilemiyor, native tarayıcıda açılıyor.");
            return await this.openNative(url);
        } catch (e) {
            console.error("[Mobile Link Opener] openUrl hatası:", e);
            new Notice("Bağlantı açılırken bir hata oluştu.");
        }
    }

    // Mevcut sekmede adres çubuğundan gezinme
    async navigate(view, text) {
        try {
            const url = normalizeInput(text, this.settings);
            if (!url) return;

            // Adres çubuğundan gidilen adresi geçmişe ekle
            await this.addToHistory(url);

            const hostname = new URL(url).hostname.toLowerCase();
            const forceNative = isNativePlatform() && isAlwaysNativeHost(hostname, this.settings);

            let embeddable = false;
            if (!forceNative) {
                try {
                    embeddable = await canEmbed(url);
                } catch (e) {
                    embeddable = false;
                }
            }

            if (forceNative || !embeddable) {
                new Notice("Bu site Obsidian sekmesinde gösterilemiyor, native tarayıcıda açılıyor.");
                // BUG FIX: Sekmede açık olan gerçek URL'ye geri döndür
                if (view.urlInput) {
                    view.urlInput.value = view.url || "";
                }
                return await this.openNative(url);
            }

            view.url = url;
            view.render();
            try {
                view.leaf.updateHeader();
            } catch (e) {}
        } catch (e) {
            console.error("[Mobile Link Opener] navigate hatası:", e);
            new Notice("Sayfaya giderken bir hata oluştu.");
        }
    }

    async openInTab(url, preferredLocation) {
        try {
            let loc = preferredLocation || this.settings?.openLocation || "tab";

            // Telefonlarda (iPhone / Android telefon) dikey bölme ekranı çok sıkıştıracağı için tam ekran sekme aç
            if (isPhoneDevice() && !preferredLocation) {
                loc = "tab";
            }

            let leaf = null;
            if (loc === "split" && !isPhoneDevice()) {
                // Ekranı dikey olarak böl (iPad / Tabletlerde; parmakla boyutlandırılabilir)
                leaf = this.app.workspace.getLeaf("split", "vertical");
            } else {
                // Standart yeni sekme (tam ekran sekme - varsayılan ve telefonlar)
                leaf = this.app.workspace.getLeaf("tab");
            }

            if (!leaf) {
                leaf = this.app.workspace.getLeaf("tab");
            }

            await leaf.setViewState({
                type: VIEW_TYPE,
                active: true,
                state: { url }
            });
            this.app.workspace.revealLeaf(leaf);
        } catch (e) {
            console.error("[Mobile Link Opener] Sekme açılırken hata:", e);
            new Notice("Web sekmesi açılırken bir hata oluştu.");
        }
    }

    async openNative(url) {
        const style = this.settings?.nativePresentationStyle || "fullscreen";

        // 1) Eğer kullanıcı sistem Safari uygulamasını seçtiyse doğrudan Safari'de aç (iPad Slide-Over / Split-View için serbestçe taşınabilir)
        if (style === "system") {
            try {
                this.bypassIntercept = true;
                window.open(url, "_blank");
                return;
            } catch (e) {
                console.error("[Mobile Link Opener] Sistem tarayıcısı açılamadı:", e);
                new Notice("Tarayıcı açılamadı.");
                return;
            } finally {
                this.bypassIntercept = false;
            }
        }

        const browser = window.Capacitor?.Plugins?.Browser;

        if (browser && isNativePlatform()) {
            try {
                const presentationStyle = style === "popover" ? "popover" : "fullscreen";
                await browser.open({ url, presentationStyle });
                return;
            } catch (e) {
                console.error("[Mobile Link Opener] Native açılamadı:", e);
                new Notice("Dahili tarayıcı açılamadı, sistem tarayıcısı deneniyor.");
            }
        }

        // Masaüstü veya hata durumu: sistem tarayıcısı
        try {
            this.bypassIntercept = true;
            window.open(url, "_blank");
        } catch (e) {
            console.error("[Mobile Link Opener] Sistem tarayıcısı açılamadı:", e);
            new Notice("Tarayıcı açılamadı.");
        } finally {
            this.bypassIntercept = false;
        }
    }

    onunload() {
        if (this.originalWindowOpen) {
            window.open = this.originalWindowOpen;
            this.originalWindowOpen = null;
        }
        this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    }
};