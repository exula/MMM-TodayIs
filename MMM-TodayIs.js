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
    ai: { enabled: true, model: "gpt-5.6-luna", webSearch: true },
    sources: { publicHolidays: true, wikipedia: true, nationalDaysPage: true, funHolidays: true, localList: true, images: true },
    fallback: { enabled: true, useEmoji: true },
    transitionDuration: 1000,
    debug: false
  },

  start() {
    this.placard = null;
    this.wrapper = null;
    this.lastRefreshKey = null;
    this.sendSocketNotification("CONFIG", this.config);
    this.checkTimer = setInterval(() => this.checkRefresh(), this.config.refreshCheckInterval);
  },

  stop() {
    if (this.checkTimer) clearInterval(this.checkTimer);
  },

  getStyles() {
    return ["MMM-TodayIs.css"];
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "today-is-wrapper";
    wrapper.style.width = `${this.config.width}px`;
    wrapper.style.height = `${this.config.height}px`;
    this.wrapper = wrapper;

    const loading = document.createElement("div");
    loading.className = "today-is-loading";
    loading.textContent = "Finding something interesting about today…";
    wrapper.appendChild(loading);
    return wrapper;
  },

  notificationReceived(notification) {
    if (notification === "ALL_MODULES_STARTED") {
      this.sendSocketNotification("REQUEST_TODAY");
    }
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "PLACARD") {
      this.renderPlacard(payload);
    } else if (notification === "ERROR") {
      this.renderError(payload);
    }
  },

  checkRefresh() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: this.config.timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(now).reduce((o, p) => (o[p.type] = p.value, o), {});
    const key = `${parts.year}-${parts.month}-${parts.day}`;
    if (parts.hour === String(this.config.updateHour).padStart(2, "0") &&
        parts.minute === String(this.config.updateMinute).padStart(2, "0") &&
        this.lastRefreshKey !== key) {
      this.lastRefreshKey = key;
      this.sendSocketNotification("REQUEST_TODAY");
    }
  },

  renderPlacard(data) {
    if (!this.wrapper || !data) return;
    this.placard = data;
    const old = this.wrapper.querySelector(".today-is");
    if (old) old.classList.add("today-is-out");

    const card = document.createElement("div");
    card.className = `today-is style-${safeClass(data.style || "modern")}`;
    card.style.setProperty("--accent", data.accentColor || "#f4b942");
    if (data.imageUrl) card.style.setProperty("--background-image", `url("${escapeCssUrl(data.imageUrl)}")`);

    const veil = document.createElement("div");
    veil.className = "today-is-veil";
    card.appendChild(veil);

    const content = document.createElement("div");
    content.className = "today-is-content";

    const eyebrow = document.createElement("div");
    eyebrow.className = "today-is-eyebrow";
    eyebrow.textContent = data.eyebrow || "TODAY";
    content.appendChild(eyebrow);

    const emoji = document.createElement("div");
    emoji.className = "today-is-emoji";
    emoji.textContent = data.emoji || "✨";
    content.appendChild(emoji);

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
    date.textContent = formatDate(data.date, this.config.timezone);
    content.appendChild(date);

    if (data.imageAttribution) {
      const attribution = document.createElement("div");
      attribution.className = "today-is-attribution";
      attribution.textContent = data.imageAttribution;
      content.appendChild(attribution);
    }

    card.appendChild(content);
    this.wrapper.appendChild(card);
    requestAnimationFrame(() => card.classList.add("today-is-in"));

    const cards = this.wrapper.querySelectorAll(".today-is");
    if (cards.length > 2) cards[0].remove();
  },

  renderError(message) {
    if (!this.wrapper) return;
    const loading = this.wrapper.querySelector(".today-is-loading");
    if (loading) loading.textContent = message || "Unable to load today's placard.";
  }
});

function safeClass(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}
function escapeCssUrl(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "");
}
function formatDate(value, timezone) {
  const date = new Date(`${value}T12:00:00`);
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "long", day: "numeric", year: "numeric" }).format(date);
}
