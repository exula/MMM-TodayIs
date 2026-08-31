/* global Module */
Module.register("MMM-TodayIs", {
  defaults: {
    position: "middle_center",
    countryCode: "US",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York",
    updateHour: 5,
    updateMinute: 30,
    refreshCheckInterval: 60 * 1000,
    width: 900,
    height: 520,
    cacheDays: 14,
    prefetchTomorrow: true,
    maxEvents: 4,
    rotationInterval: 15 * 60 * 1000,
    locale: "en-US",
    showSource: true,
    theme: "auto",
    textScale: 1.15,
    ai: { enabled: true, model: "gpt-5.6-luna", webSearch: true },
    sources: { publicHolidays: true, wikipedia: true, nationalDaysPage: true, funHolidays: true, localList: true, images: true },
    fallback: { enabled: true, useEmoji: true },
    content: { excludePolitics: true, excludeTragedy: true, excludeDeaths: true, includeBirthdays: false, familyFriendly: true, preferredCategories: ["food", "animal", "science", "nature", "music", "books", "celebration"] },
    labels: { todayIs: "TODAY IS", onThisDay: "ON THIS DAY", loading: "Finding something interesting about today…", error: "Unable to load today's placard." },
    transitionDuration: 1000,
    debug: false
  },

  start() {
    this.placard = null;
    this.day = null;
    this.placards = [];
    this.currentIndex = 0;
    this.paused = false;
    this.wrapper = null;
    this.lastRefreshKey = null;
    this.sendSocketNotification("CONFIG", this.config);
    this.checkTimer = setInterval(() => this.checkRefresh(), this.config.refreshCheckInterval);
  },

  stop() {
    if (this.checkTimer) clearInterval(this.checkTimer);
    if (this.rotationTimer) clearInterval(this.rotationTimer);
  },

  getStyles() {
    return ["MMM-TodayIs.css"];
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "today-is-wrapper";
    wrapper.setAttribute("aria-live", "polite");
    wrapper.setAttribute("aria-atomic", "true");
    wrapper.style.width = `${this.config.width}px`;
    wrapper.style.height = `${this.config.height}px`;
    this.wrapper = wrapper;

    const loading = document.createElement("div");
    loading.className = "today-is-loading";
    loading.textContent = this.config.labels?.loading || "Finding something interesting about today…";
    wrapper.appendChild(loading);
    return wrapper;
  },

  notificationReceived(notification) {
    if (notification === "ALL_MODULES_STARTED") {
      this.sendSocketNotification("REQUEST_TODAY");
    } else if (notification === "TODAYIS_REFRESH") {
      this.sendSocketNotification("FORCE_REFRESH");
    } else if (notification === "TODAYIS_NEXT") {
      this.showRelative(1);
    } else if (notification === "TODAYIS_PREVIOUS") {
      this.showRelative(-1);
    } else if (notification === "TODAYIS_PAUSE") {
      this.paused = true;
    } else if (notification === "TODAYIS_RESUME") {
      this.paused = false;
    }
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "DAY") {
      this.renderDay(payload);
    } else if (notification === "PLACARD") {
      this.renderPlacard(payload);
    } else if (notification === "ERROR") {
      this.renderError(payload);
    }
  },

  renderDay(day) {
    if (!day || !Array.isArray(day.placards) || !day.placards.length) return;
    this.day = day;
    this.placards = day.placards;
    this.currentIndex = 0;
    this.renderPlacard(this.placards[0]);
    this.renderDiagnostics(day.diagnostics || []);
    this.startRotation();
    this.sendNotification("TODAYIS_UPDATED", {
      date: day.date,
      count: day.placards.length,
      diagnostics: day.diagnostics || []
    });
  },

  startRotation() {
    if (this.rotationTimer) clearInterval(this.rotationTimer);
    const interval = Number(this.config.rotationInterval);
    if (this.placards.length < 2 || !Number.isFinite(interval) || interval < 10000) return;
    this.rotationTimer = setInterval(() => {
      if (!this.paused) this.showRelative(1);
    }, interval);
  },

  showRelative(offset) {
    if (!this.placards.length) return;
    this.currentIndex = (this.currentIndex + offset + this.placards.length) % this.placards.length;
    this.renderPlacard(this.placards[this.currentIndex]);
  },

  renderDiagnostics(diagnostics) {
    if (!this.wrapper) return;
    const existing = this.wrapper.querySelector(".today-is-debug");
    if (existing) existing.remove();
    if (!this.config.debug) return;
    const panel = document.createElement("div");
    panel.className = "today-is-debug";
    panel.textContent = diagnostics.map(item => `${item.source}: ${item.status}${Number.isFinite(item.count) ? ` (${item.count})` : ""}`).join(" · ");
    this.wrapper.appendChild(panel);
  },

  checkRefresh() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: this.config.timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(now).reduce((o, p) => (o[p.type] = p.value, o), {});
    const key = `${parts.year}-${parts.month}-${parts.day}`;
    const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
    const updateMinutes = Number(this.config.updateHour) * 60 + Number(this.config.updateMinute);
    if (currentMinutes >= updateMinutes && this.lastRefreshKey !== key) {
      this.lastRefreshKey = key;
      this.sendSocketNotification("REQUEST_TODAY");
    }
  },

  renderPlacard(data) {
    if (!this.wrapper || !data) return;
    const today = dateKeyInTimezone(new Date(), this.config.timezone);
    if (data.date !== today) {
      if (this.config.debug) console.warn(`[MMM-TodayIs] Ignoring placard for ${data.date}; today is ${today}`);
      return;
    }
    this.placard = data;
    this.lastRefreshKey = data.date;
    const old = this.wrapper.querySelector(".today-is");
    if (old) old.classList.add("today-is-out");

    const card = document.createElement("div");
    const titleLength = String(data.title || "").length;
    const titleSize = titleLength > 72 ? "long" : titleLength > 42 ? "medium" : "short";
    const configuredTheme = this.config.theme && this.config.theme !== "auto" ? this.config.theme : data.style;
    card.className = `today-is style-${safeClass(configuredTheme || "modern")} title-${titleSize}${data.imageUrl ? "" : " no-image"}`;
    card.style.setProperty("--accent", data.accentColor || "#f4b942");
    card.style.setProperty("--text-scale", String(Math.min(1.8, Math.max(0.8, Number(this.config.textScale) || 1.15))));
    card.style.setProperty("--transition-duration", `${Number(this.config.transitionDuration) || 1000}ms`);
    card.setAttribute("role", "article");
    card.setAttribute("aria-label", `${data.eyebrow || "Today is"}: ${data.title || "Something interesting"}`);
    if (data.imageUrl) card.style.setProperty("--background-image", `url("${escapeCssUrl(data.imageUrl)}")`);

    const veil = document.createElement("div");
    veil.className = "today-is-veil";
    card.appendChild(veil);

    const content = document.createElement("div");
    content.className = "today-is-content";

    const eyebrow = document.createElement("div");
    eyebrow.className = "today-is-eyebrow";
    eyebrow.textContent = data.eyebrow || this.config.labels?.todayIs || "TODAY IS";
    content.appendChild(eyebrow);

    if (data.emoji) {
      const emoji = document.createElement("div");
      emoji.className = "today-is-emoji";
      emoji.textContent = data.emoji;
      content.appendChild(emoji);
    }

    const title = document.createElement("div");
    title.className = "today-is-title";
    title.textContent = data.title || "Something Interesting About Today";
    content.appendChild(title);

    const caption = document.createElement("div");
    caption.className = "today-is-caption";
    caption.textContent = data.caption || "A little something worth knowing.";
    content.appendChild(caption);

    const date = document.createElement("div");
    date.className = "today-is-date";
    date.textContent = formatDate(data.date, this.config.locale);
    content.appendChild(date);

    if (this.config.showSource && data.source) {
      const source = document.createElement(data.sourceUrl ? "a" : "div");
      source.className = "today-is-source";
      source.textContent = data.source;
      if (data.sourceUrl) {
        source.href = data.sourceUrl;
        source.target = "_blank";
        source.rel = "noopener noreferrer";
      }
      content.appendChild(source);
    }

    if (this.placards.length > 1) {
      const position = document.createElement("div");
      position.className = "today-is-position";
      position.textContent = `${this.currentIndex + 1} / ${this.placards.length}`;
      content.appendChild(position);
    }

    if (data.imageAttribution) {
      const attribution = document.createElement(data.imagePageUrl ? "a" : "div");
      attribution.className = "today-is-attribution";
      attribution.textContent = data.imageAttribution;
      if (data.imagePageUrl) {
        attribution.href = data.imagePageUrl;
        attribution.target = "_blank";
        attribution.rel = "noopener noreferrer";
      }
      content.appendChild(attribution);
    }

    card.appendChild(content);
    this.wrapper.appendChild(card);
    requestAnimationFrame(() => card.classList.add("today-is-in"));

    const cards = this.wrapper.querySelectorAll(".today-is");
    if (cards.length > 2) cards[0].remove();
    setTimeout(() => {
      for (const previous of this.wrapper.querySelectorAll(".today-is-out")) previous.remove();
    }, Number(this.config.transitionDuration) || 1000);
  },

  renderError(message) {
    if (!this.wrapper) return;
    const loading = this.wrapper.querySelector(".today-is-loading");
    if (loading) loading.textContent = message || this.config.labels?.error || "Unable to load today's placard.";
    this.sendNotification("TODAYIS_ERROR", { message: loading?.textContent || message });
  }
});

function safeClass(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}
function escapeCssUrl(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "");
}
function formatDate(value, locale) {
  const date = new Date(`${value}T12:00:00Z`);
  return new Intl.DateTimeFormat(locale || "en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(date);
}
function dateKeyInTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date).reduce((out, part) => (out[part.type] = part.value, out), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
