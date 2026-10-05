const { Plugin, ItemView, Notice, requestUrl, setIcon } = require("obsidian");

const VIEW_TYPE = "mobile-link-browser";

// Native ekran (Capacitor Browser) nasıl açılsın: "fullscreen" veya "popover"
const NATIVE_PRESENTATION_STYLE = "fullscreen";

// Bu siteler HER ZAMAN native ekranda açılır (iframe denenmez)
const ALWAYS_NATIVE_DOMAINS = ["google.com", "youtube.com", "youtu.be", "mega.nz"];

// Adres cubuguna adres yerine kelime yazilirsa bu arama motoru kullanilir
const SEARCH_URL = "https://duckduckgo.com/?q=";

// Yazilan metni tam bir url'ye cevirir: adres ise https:// ekler, degilse arama yapar
function normalizeInput(text) {
    const t = (text || "").trim();
    if (!t) return null;
    if (/^https?:\/\//i.test(t)) return t;
    if (!/\s/.test(t) && /^[^\s]+\.[a-z]{2,}(\/.*)?$/i.test(t)) return "https://" + t;
    return SEARCH_URL + encodeURIComponent(t);
}

function hostMatches(hostname, domains) {
    return domains.some((d) => hostname === d || hostname.endsWith("." + d));
}

function isNativePlatform() {
    const cap = window.Capacitor;
    return !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
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

class BrowserView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.url = "";
        this.renderedUrl = null;
        this.hostEl = null;
        this.urlInput = null;
    }

    getViewType() {
        return VIEW_TYPE;
    }

    getIcon() {
        return "globe";
    }

    getDisplayText() {
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
        this.url = (state && state.url) || "";
        this.render();
        try {
            this.leaf.updateHeader();
        } catch (e) {}
        await super.setState(state, result);
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
            this.render();
        });

        const nativeBtn = bar.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": "Native tarayicida ac" }
        });
        setIcon(nativeBtn, "external-link");
        nativeBtn.addEventListener("click", () => {
            if (this.url) this.plugin.openNative(this.url);
        });

        // Adres / arama cubugu
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

    render() {
        if (!this.hostEl) return; // onOpen henuz calismadi, o cagiracak

        if (this.urlInput && document.activeElement !== this.urlInput) {
            this.urlInput.value = this.url || "";
        }

        // Ayni url zaten yuklenmisse tekrar yukleme (siyah/beyaz ekran sorununu azaltir)
        if (!this.url || this.renderedUrl === this.url) return;

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
    }

    async onClose() {
        this.hostEl = null;
        this.urlInput = null;
        this.contentEl.empty();
    }
}

module.exports = class MobileLinkOpener extends Plugin {
    async onload() {
        this.registerView(VIEW_TYPE, (leaf) => new BrowserView(leaf, this));

        // Linke tiklamayi yakala (capture = true: Obsidian'dan once biz gorelim)
        this.registerDomEvent(document, "click", (e) => this.handleLinkClick(e), true);

        this.addCommand({
            id: "new-web-tab",
            name: "Yeni web sekmesi ac",
            callback: () => this.openInTab("")
        });

        this.addCommand({
            id: "test-native-browser",
            name: "Test: native tarayici (Google)",
            callback: () => this.openNative("https://www.google.com")
        });

        this.addCommand({
            id: "test-tab-browser",
            name: "Test: Obsidian sekmesinde ac (example.com)",
            callback: () => this.openInTab("https://example.com")
        });
    }

    async handleLinkClick(event) {
        const anchor = event.composedPath?.().find((el) => el?.tagName === "A");
        if (!anchor) return;

        const href = anchor.getAttribute("href");
        if (!href) return;

        let url;
        try {
            url = new URL(href, window.location.href);
        } catch (e) {
            return;
        }

        if (url.protocol !== "http:" && url.protocol !== "https:") return;

        // Sadece not icindeki (okuma / duzenleme gorunumu) linklerle ilgilen
        if (!anchor.closest(".markdown-preview-view, .markdown-source-view")) return;

        // Bunlar async islemden ONCE cagrilmali
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
            const hostname = new URL(url).hostname.toLowerCase();

            // 1) Bilinen sorunlu siteler: direkt native (sadece telefonda/iPad'de)
            if (isNativePlatform() && hostMatches(hostname, ALWAYS_NATIVE_DOMAINS)) {
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

    // Mevcut sekmede adres cubugundan gezinme
    async navigate(view, text) {
        try {
            const url = normalizeInput(text);
            if (!url) return;

            const hostname = new URL(url).hostname.toLowerCase();
            const forceNative = isNativePlatform() && hostMatches(hostname, ALWAYS_NATIVE_DOMAINS);

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

    async openInTab(url) {
        try {
            const leaf = this.app.workspace.getLeaf("tab");
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
        const browser = window.Capacitor?.Plugins?.Browser;

        if (browser && isNativePlatform()) {
            try {
                await browser.open({ url, presentationStyle: NATIVE_PRESENTATION_STYLE });
                return;
            } catch (e) {
                console.error("[Mobile Link Opener] Native açılamadı:", e);
                new Notice("Dahili tarayıcı açılamadı, sistem tarayıcısı deneniyor.");
            }
        }

        // Masaüstü veya hata durumu: sistem tarayıcısı
        try {
            window.open(url, "_blank");
        } catch (e) {
            console.error("[Mobile Link Opener] Sistem tarayıcısı açılamadı:", e);
            new Notice("Tarayıcı açılamadı.");
        }
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    }
};